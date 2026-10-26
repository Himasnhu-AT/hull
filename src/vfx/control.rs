//! Control-port commands (`vfx.*`) and `vfx.*` metrics (feature `devtools`).

use bevy::prelude::*;
use serde_json::{Value, json};

use super::{EffectDef, OnFinish, ParticleEffect, VfxBudget, VfxInstance, VfxLibrary, VfxStats};
use crate::devtools::{AddControlCommand, Metrics, params};

pub(super) fn build(app: &mut App) {
    app.add_control_command(
        "vfx.spawn",
        "Play an effect (pooled one-shot, or persistent)",
        params(&[
            ("preset", "string", "effect name (see vfx.list)"),
            ("pos", "array", "[x, y, z] world position (default 0,0,0; or x/y/z params)"),
            ("seed", "integer", "RNG seed for a deterministic replay"),
            ("persistent", "boolean", "spawn a ParticleEffect that is not pooled (looping effects stay until vfx.clear)"),
        ]),
        vfx_spawn,
    )
    .add_control_command("vfx.stats", "Particle counts, budgets, timings and playing effects", params(&[]), vfx_stats)
    .add_control_command("vfx.clear", "Despawn every effect and empty the pool", params(&[]), vfx_clear)
    .add_control_command("vfx.list", "Registered effect names", params(&[]), vfx_list)
    .add_control_command("vfx.get", "An effect's definition as JSON (edit it and send it to vfx.define)", params(&[("preset", "string", "effect name")]), vfx_get)
    .add_control_command(
        "vfx.define",
        "Register or replace an effect from JSON (an EffectDef); playing instances of it restart",
        params(&[("def", "object", "EffectDef: {name, emitters: [...], duration, looping, ...}")]),
        vfx_define,
    )
    .add_control_command(
        "vfx.budget",
        "Read or change VfxBudget",
        params(&[
            ("max_particles", "integer", "global particle cap"),
            ("max_effects", "integer", "playing effects cap"),
            ("collision_rays", "integer", "physics raycasts per frame"),
            ("parallel", "boolean", "simulate effects in parallel"),
            ("pause_with_game", "boolean", "freeze with Paused / virtual time"),
            ("distance_scale", "number", "multiplier on LOD and cull distances"),
        ]),
        vfx_budget,
    )
    .add_systems(Last, record_metrics);
}

fn record_metrics(stats: Res<VfxStats>, metrics: Option<ResMut<Metrics>>) {
    let Some(mut m) = metrics else { return };
    if stats.effects == 0 && stats.particles == 0 {
        return;
    }
    m.record("vfx.particles", stats.particles as f64);
    m.record("vfx.effects", stats.active as f64);
    m.record("vfx.drawn_emitters", stats.drawn_emitters as f64);
    m.record("vfx.sim_us", stats.sim_us as f64);
    m.record("vfx.build_us", stats.build_us as f64);
    m.record("vfx.upload_us", stats.upload_us as f64);
    m.record("vfx.dropped", stats.dropped as f64);
}

fn vec3(p: &Value) -> Vec3 {
    if let Some(a) = p.get("pos").and_then(|v| v.as_array()) {
        let f = |i: usize| a.get(i).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
        return Vec3::new(f(0), f(1), f(2));
    }
    let f = |k: &str| p.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
    Vec3::new(f("x"), f("y"), f("z"))
}

fn vfx_spawn(world: &mut World, p: Value) -> Result<Value, String> {
    let name = p.get("preset").or_else(|| p.get("effect")).and_then(|v| v.as_str()).ok_or("missing `preset`")?.to_string();
    if !world.resource::<VfxLibrary>().contains(&name) {
        return Err(format!("unknown effect `{name}`; known: {}", world.resource::<VfxLibrary>().names().join(", ")));
    }
    let pos = vec3(&p);
    let seed = p.get("seed").and_then(|v| v.as_u64());
    let tf = Transform::from_translation(pos);
    let entity = if p.get("persistent").and_then(|v| v.as_bool()).unwrap_or(false) {
        let mut pe = ParticleEffect::new(name.clone()).on_finish(OnFinish::Despawn);
        pe.seed = seed;
        world.spawn((Name::new(format!("vfx:{name}")), tf, pe)).id()
    } else {
        super::play_world(world, &name, tf, seed).ok_or("refused (max_effects reached?)")?
    };
    Ok(json!({"entity": entity.to_bits(), "effect": name, "pos": [pos.x, pos.y, pos.z]}))
}

fn vfx_stats(world: &mut World, _: Value) -> Result<Value, String> {
    let stats = serde_json::to_value(world.resource::<VfxStats>().clone()).map_err(|e| e.to_string())?;
    let budget = serde_json::to_value(world.resource::<VfxBudget>().clone()).map_err(|e| e.to_string())?;
    let mut list = Vec::new();
    let mut q = world.query::<(Entity, &VfxInstance, &GlobalTransform)>();
    for (e, inst, g) in q.iter(world).take(64) {
        let t = g.translation();
        list.push(json!({
            "entity": e.to_bits(),
            "effect": inst.fx.def.name,
            "alive": inst.state.alive(),
            "emitters": inst.state.emitters.iter().zip(&inst.fx.def.emitters).map(|(s, d)| json!({"name": d.name, "alive": s.p.len(), "spawned": s.spawned, "died": s.died})).collect::<Vec<_>>(),
            "time": inst.state.time,
            "idle": inst.idle,
            "culled": inst.culled,
            "distance": inst.distance,
            "lod": inst.lod,
            "pos": [t.x, t.y, t.z],
        }));
    }
    Ok(json!({"stats": stats, "budget": budget, "effects": list}))
}

fn vfx_clear(world: &mut World, _: Value) -> Result<Value, String> {
    Ok(json!({"despawned": super::clear_all(world)}))
}

fn vfx_list(world: &mut World, _: Value) -> Result<Value, String> {
    let lib = world.resource::<VfxLibrary>();
    let list: Vec<Value> = lib
        .names()
        .into_iter()
        .map(|n| {
            let fx = lib.get(n).unwrap();
            json!({"name": n, "emitters": fx.def.emitters.iter().map(|e| e.name.clone()).collect::<Vec<_>>(), "capacity": fx.capacity, "duration": fx.def.duration, "looping": fx.def.looping})
        })
        .collect();
    Ok(json!({"effects": list}))
}

fn vfx_get(world: &mut World, p: Value) -> Result<Value, String> {
    let name = p.get("preset").or_else(|| p.get("effect")).and_then(|v| v.as_str()).ok_or("missing `preset`")?;
    let lib = world.resource::<VfxLibrary>();
    let fx = lib.get(name).ok_or_else(|| format!("unknown effect `{name}`"))?;
    serde_json::to_value(&fx.def).map_err(|e| e.to_string())
}

fn vfx_define(world: &mut World, p: Value) -> Result<Value, String> {
    let raw = p.get("def").cloned().unwrap_or(p);
    let def: EffectDef = serde_json::from_value(raw).map_err(|e| format!("bad EffectDef: {e}"))?;
    let name = def.name.clone();
    let fx = world.resource_mut::<VfxLibrary>().register(def)?;
    // Playing instances pick up the new definition.
    let mut q = world.query::<(Entity, &ParticleEffect)>();
    let ids: Vec<Entity> = q.iter(world).filter(|(_, pe)| pe.effect == name).map(|(e, _)| e).collect();
    for &e in &ids {
        if let Some(mut pe) = world.get_mut::<ParticleEffect>(e) {
            pe.set_changed();
        }
    }
    Ok(json!({"registered": name, "emitters": fx.emitters.len(), "capacity": fx.capacity, "restarted": ids.len()}))
}

fn vfx_budget(world: &mut World, p: Value) -> Result<Value, String> {
    let mut b = world.resource_mut::<VfxBudget>();
    let u = |k: &str| p.get(k).and_then(|v| v.as_u64()).map(|v| v.min(u32::MAX as u64) as u32);
    if let Some(v) = u("max_particles") {
        b.max_particles = v;
    }
    if let Some(v) = u("max_effects") {
        b.max_effects = v;
    }
    if let Some(v) = u("collision_rays") {
        b.collision_rays = v;
    }
    if let Some(v) = p.get("parallel").and_then(|v| v.as_bool()) {
        b.parallel = v;
    }
    if let Some(v) = p.get("pause_with_game").and_then(|v| v.as_bool()) {
        b.pause_with_game = v;
    }
    if let Some(v) = p.get("distance_scale").and_then(|v| v.as_f64()) {
        b.distance_scale = v as f32;
    }
    serde_json::to_value(b.clone()).map_err(|e| e.to_string())
}
