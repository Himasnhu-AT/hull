//! Control-port commands for animation (feature `devtools`).
//!
//! | Command | Params | Result |
//! |---|---|---|
//! | `anim.list` | — | every animator: entity, name, graph, current states, LOD, stats |
//! | `anim.state` | `{entity?}` | params, per layer weight / current state / playing states / clip slots, root motion |
//! | `anim.param` | `{entity?, name?, value?}` | sets a parameter (bool/number; triggers: `true`); no name lists them |
//! | `anim.play` | `{entity?, state, layer?, fade?}` | crossfades a layer to a state, ignoring conditions |
//! | `anim.bones` | `{entity?, name?}` | bone local / world transforms (one bone with `name`) |
//! | `anim.config` | `{lod?, notify_all?}` | toggles LOD / notify mode; returns the config + stats |
//!
//! `entity` is the bits number from `anim.list`, an entity string like `"12v0"`, or a `Name`;
//! omitted, the only animator (error if several).

use bevy::prelude::*;
use serde_json::{Value, json};

use super::def::{LayerMode, ParamValue};
use super::machine::{Animator, NotifyMode};
use super::root_motion::RootMotionDelta;
use super::skeleton::Skeleton;
use super::{AnimConfig, AnimStats};
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    use crate::devtools::PerfAppExt;
    app.perf_span(PostUpdate, super::AnimSystems::Advance, "anim.advance")
        .perf_span(PostUpdate, bevy::app::AnimationSystems, "anim.eval")
        .perf_span(PostUpdate, super::AnimSystems::Procedural, "anim.post");
    let ent = ("entity", "string", "animator: id bits, \"12v0\" or Name (default: the only one)");
    app.add_control_command("anim.list", "List animators with their current states", params(&[]), list)
        .add_control_command("anim.state", "One animator's params, layers, weights, root motion", params(&[ent]), state)
        .add_control_command(
            "anim.param",
            "Set an animator parameter (no name: list)",
            params(&[ent, ("name", "string", "parameter"), ("value", "number", "number or bool; triggers: true")]),
            param,
        )
        .add_control_command(
            "anim.play",
            "Crossfade a layer to a state now",
            params(&[ent, ("state", "string", "state name"), ("layer", "string", "layer name or index (default 0)"), ("fade", "number", "seconds (default 0.2)")]),
            play,
        )
        .add_control_command("anim.bones", "Bone transforms of an animator", params(&[ent, ("name", "string", "one bone")]), bones)
        .add_control_command(
            "anim.config",
            "Animation LOD / notify settings",
            params(&[("lod", "boolean", "update-rate LOD on/off"), ("notify_all", "number", "fire notifies of every clip above this weight (negative: dominant only)")]),
            config,
        )
        .add_systems(Last, record_metrics);
}

fn record_metrics(stats: Res<AnimStats>, metrics: Option<ResMut<crate::devtools::Metrics>>) {
    if stats.animators == 0 {
        return;
    }
    if let Some(mut m) = metrics {
        m.record("anim.animators", stats.animators as f64);
        m.record("anim.posed", stats.posed as f64);
        m.record("anim.advance_us", stats.advance_us as f64);
        m.record("anim.post_us", stats.post_us as f64);
    }
}

fn find(world: &mut World, p: &Value) -> Result<Entity, String> {
    let mut q = world.query_filtered::<(Entity, Option<&Name>), With<Animator>>();
    let all: Vec<(Entity, Option<String>)> = q.iter(world).map(|(e, n)| (e, n.map(|n| n.as_str().to_string()))).collect();
    match p.get("entity") {
        None | Some(Value::Null) => match all.as_slice() {
            [(e, _)] => Ok(*e),
            [] => Err("no animators".into()),
            _ => Err(format!("{} animators: pass `entity` (see anim.list)", all.len())),
        },
        Some(Value::Number(n)) => {
            let bits = n.as_u64().ok_or("entity must be a positive integer")?;
            all.iter().find(|(e, _)| e.to_bits() == bits).map(|(e, _)| *e).ok_or_else(|| format!("no animator with id {bits}"))
        }
        Some(Value::String(s)) => all
            .iter()
            .find(|(e, n)| format!("{e}") == *s || n.as_deref() == Some(s.as_str()) || e.to_bits().to_string() == *s)
            .map(|(e, _)| *e)
            .ok_or_else(|| format!("no animator `{s}`")),
        Some(v) => Err(format!("bad entity {v}")),
    }
}

fn pv(v: ParamValue) -> Value {
    match v {
        ParamValue::Float(f) => json!(f),
        ParamValue::Bool(b) | ParamValue::Trigger(b) => json!(b),
    }
}

fn v3(v: Vec3) -> Value {
    json!([v.x, v.y, v.z])
}

fn summary(e: Entity, name: Option<&Name>, a: &Animator) -> Value {
    let layers: Vec<Value> = (0..a.layer_count())
        .map(|l| json!({"name": a.def().layers[l].name, "state": a.current_state(l), "in_transition": a.in_transition(l)}))
        .collect();
    json!({
        "id": e.to_bits(),
        "entity": format!("{e}"),
        "name": name.map(|n| n.as_str()),
        "graph": a.def().name,
        "bound": a.is_bound(),
        "lod_interval": a.lod_interval(),
        "posed": a.posed_this_frame(),
        "layers": layers,
    })
}

fn list(world: &mut World, _: Value) -> Result<Value, String> {
    let mut q = world.query::<(Entity, Option<&Name>, &Animator)>();
    let list: Vec<Value> = q.iter(world).map(|(e, n, a)| summary(e, n, a)).collect();
    let s = world.resource::<AnimStats>();
    Ok(json!({
        "animators": list,
        "stats": {"count": s.animators, "bound": s.bound, "posed": s.posed, "advance_us": s.advance_us, "post_us": s.post_us, "notifies_total": s.notifies_total},
    }))
}

fn state(world: &mut World, p: Value) -> Result<Value, String> {
    let e = find(world, &p)?;
    let a = world.get::<Animator>(e).ok_or("no animator")?;
    let params: serde_json::Map<String, Value> = a.params().map(|(n, v)| (n.to_string(), pv(v))).collect();
    let def = a.def();
    let layers: Vec<Value> = (0..a.layer_count())
        .map(|l| {
            let ld = &def.layers[l];
            let rt = a.layer(l);
            let (w, t) = a.slot_weights(l);
            let mut clips = Vec::new();
            for st in &ld.states {
                for k in 0..st.motion.clip_count() {
                    let s = st.slot0 as usize + k;
                    if w.get(s).copied().unwrap_or(0.0) > 0.0 {
                        clips.push(json!({"state": st.name, "index": k, "weight": w[s], "time": t[s]}));
                    }
                }
            }
            json!({
                "name": ld.name,
                "mode": if ld.mode == LayerMode::Additive { "additive" } else { "override" },
                "weight": rt.weight,
                "state": a.current_state(l),
                "time": a.state_time(l),
                "in_transition": a.in_transition(l),
                "transitions": rt.transitions,
                "playing": a.playing(l).map(|(n, w, t)| json!({"state": n, "weight": w, "time": t})).collect::<Vec<_>>(),
                "clips": clips,
            })
        })
        .collect();
    let out = a.last_step();
    let notifies: Vec<Value> = out.notifies.iter().map(|n| json!({"name": &*n.name, "layer": n.layer, "clip_time": n.clip_time})).collect();
    let mut v = json!({
        "id": e.to_bits(),
        "entity": format!("{e}"),
        "graph": def.name,
        "bound": a.is_bound(),
        "speed": a.speed,
        "paused": a.paused,
        "lod_interval": a.lod_interval(),
        "posed": a.posed_this_frame(),
        "params": params,
        "layers": layers,
        "notifies_this_frame": notifies,
        "root_step": {"delta": v3(out.root_delta), "yaw": out.root_yaw, "pose_offset": v3(out.pose_offset)},
    });
    if let Some(d) = world.get::<RootMotionDelta>(e) {
        v["root_motion"] = json!({"pending": v3(d.translation), "yaw": d.yaw, "velocity": v3(d.velocity())});
    }
    if let Some(t) = world.get::<Transform>(e) {
        v["translation"] = v3(t.translation);
    }
    Ok(v)
}

fn param(world: &mut World, p: Value) -> Result<Value, String> {
    let e = find(world, &p)?;
    let mut a = world.get_mut::<Animator>(e).ok_or("no animator")?;
    let Some(name) = p.get("name").and_then(Value::as_str) else {
        let all: serde_json::Map<String, Value> = a.params().map(|(n, v)| (n.to_string(), json!({"kind": v.kind(), "value": pv(v)}))).collect();
        return Ok(json!({"params": all}));
    };
    let value = match p.get("value") {
        Some(Value::Bool(b)) => ParamValue::Bool(*b),
        Some(Value::Number(n)) => ParamValue::Float(n.as_f64().unwrap_or(0.0) as f32),
        None | Some(Value::Null) => ParamValue::Bool(true),
        Some(v) => return Err(format!("value must be a number or bool, got {v}")),
    };
    if !a.set(name, value) {
        let known: Vec<String> = a.params().map(|(n, _)| n.to_string()).collect();
        return Err(format!("unknown parameter `{name}` (known: {})", known.join(", ")));
    }
    Ok(json!({"name": name, "value": pv(a.param(name).expect("set"))}))
}

fn play(world: &mut World, p: Value) -> Result<Value, String> {
    let e = find(world, &p)?;
    let mut a = world.get_mut::<Animator>(e).ok_or("no animator")?;
    let st = p.get("state").and_then(Value::as_str).ok_or("missing `state`")?;
    let layer = match p.get("layer") {
        Some(Value::String(s)) => a.def().layer_id(s).ok_or_else(|| format!("unknown layer `{s}`"))?,
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0) as usize,
        _ => 0,
    };
    let fade = p.get("fade").and_then(Value::as_f64).unwrap_or(0.2) as f32;
    if !a.play(layer, st, fade) {
        return Err(format!("no state `{st}` in layer {layer}"));
    }
    Ok(json!({"layer": layer, "state": st}))
}

fn bones(world: &mut World, p: Value) -> Result<Value, String> {
    let e = find(world, &p)?;
    let skel = world.get::<Skeleton>(e).ok_or("skeleton not built yet")?.clone();
    let one = p.get("name").and_then(Value::as_str);
    let idx: Vec<usize> = match one {
        Some(n) => vec![skel.find(n).ok_or_else(|| format!("no bone `{n}` (bones: {})", skel.names().collect::<Vec<_>>().join(", ")))?],
        None => (0..skel.bones.len()).collect(),
    };
    let out: Vec<Value> = idx
        .into_iter()
        .map(|i| {
            let b = &skel.bones[i];
            let tf = world.get::<Transform>(b.entity).copied().unwrap_or_default();
            let g = world.get::<GlobalTransform>(b.entity).map(|g| g.translation()).unwrap_or_default();
            let (x, y, z) = tf.rotation.to_euler(EulerRot::YXZ);
            json!({
                "name": b.name,
                "parent": b.parent.map(|p| skel.bones[p as usize].name.clone()),
                "translation": v3(tf.translation),
                "rotation_ypr_deg": [x.to_degrees(), y.to_degrees(), z.to_degrees()],
                "world": v3(g),
            })
        })
        .collect();
    Ok(json!({"bones": out}))
}

fn config(world: &mut World, p: Value) -> Result<Value, String> {
    let mut cfg = world.resource_mut::<AnimConfig>();
    if let Some(b) = p.get("lod").and_then(Value::as_bool) {
        cfg.lod.enabled = b;
    }
    if let Some(w) = p.get("notify_all").and_then(Value::as_f64) {
        cfg.notify_mode = if w < 0.0 { NotifyMode::Dominant } else { NotifyMode::All { min_weight: w as f32 } };
    }
    let c = cfg.clone();
    let s = world.resource::<AnimStats>();
    Ok(json!({
        "lod": {"enabled": c.lod.enabled, "distances": c.lod.distances, "intervals": c.lod.intervals, "offscreen_interval": c.lod.offscreen_interval},
        "notify_mode": format!("{:?}", c.notify_mode),
        "max_dt": c.max_dt,
        "stats": {"count": s.animators, "bound": s.bound, "posed": s.posed, "advance_us": s.advance_us, "post_us": s.post_us},
    }))
}
