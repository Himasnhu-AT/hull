//! Control-port commands (feature `devtools`): `look.get`, `look.set`, `look.feature`,
//! `look.time`, `look.probe`.

use bevy::prelude::*;
use serde_json::{Value, json};

use super::apply::{LookState, Tier};
use super::desc::Look;
use super::features::{FEATURES, look_wants, set_feature, tier_slot};
use super::probe::{ProbeTargets, ReflectionProbe};
use super::timeline::{LookTimeline, LookTransition};
use crate::devtools::{AddControlCommand, params};
use crate::gfx::{MainCamera, QualityPreset};
use crate::settings::CoreSettings;

pub(super) fn register(app: &mut App) {
    app.add_control_command("look.get", "Current look (all fields), tier, features and camera components", params(&[]), look_get)
        .add_control_command(
            "look.set",
            "Set the look: a preset and/or field overrides, optionally blended",
            params(&[
                ("preset", "string", "clear_day | overcast | dusk | night | indoor"),
                ("fields", "object", "partial Look JSON merged in, e.g. {\"fog\":{\"visibility\":300}}"),
                ("blend", "number", "seconds to blend from the current look (default 0)"),
            ]),
            look_set,
        )
        .add_control_command(
            "look.feature",
            "Toggle a rendering feature at the current quality tier (no params: list)",
            params(&[("name", "string", "feature, see look.get features"), ("on", "boolean", "on/off")]),
            look_feature,
        )
        .add_control_command(
            "look.time",
            "Day-cycle timeline: start/stop/seek (time 0..24)",
            params(&[
                ("time", "number", "clock time (starts a day cycle if none)"),
                ("speed", "number", "clock units per second (0 = frozen)"),
                ("stop", "boolean", "remove the timeline (keeps the current look)"),
            ]),
            look_time,
        )
        .add_control_command(
            "look.probe",
            "Reflection probes: list, re-capture (bake), set refresh",
            params(&[
                ("bake", "boolean", "re-capture every probe now"),
                ("refresh", "integer", "frames between face updates for all probes (0 = bake + freeze, -1 = tier default)"),
            ]),
            look_probe,
        );
}

fn tier_index(world: &World) -> usize {
    world.resource::<CoreSettings>().quality.index()
}

fn features_json(world: &World) -> Value {
    let preset = world.resource::<QualityPreset>();
    let i = tier_index(world);
    let look = world.get_resource::<Look>();
    let mut p = preset.clone();
    let mut out = serde_json::Map::new();
    for name in FEATURES {
        let tier = tier_slot(&mut p, name).map(|s| s[i]);
        let wants = look.and_then(|l| look_wants(l, name));
        let active = tier.unwrap_or(true) && wants.unwrap_or(look.is_none() || tier.is_some());
        out.insert(name.into(), json!({"tier": tier, "look": wants, "active": active}));
    }
    Value::Object(out)
}

/// Rendering components on the main camera (by name), for checking what's active.
fn camera_components(world: &mut World) -> Value {
    use bevy::anti_alias::{fxaa::Fxaa, taa::TemporalAntiAliasing};
    use bevy::camera::Hdr;
    use bevy::core_pipeline::prepass::{DeferredPrepass, DepthPrepass, MotionVectorPrepass, NormalPrepass};
    use bevy::light::{AtmosphereEnvironmentMapLight, EnvironmentMapLight, GeneratedEnvironmentMapLight, ShadowFilteringMethod, Skybox, VolumetricFog};
    use bevy::pbr::{AtmosphereSettings, ContactShadows, DistanceFog, ScreenSpaceAmbientOcclusion, ScreenSpaceReflections};
    use bevy::post_process::{auto_exposure::AutoExposure, bloom::Bloom, dof::DepthOfField, effect_stack::*, motion_blur::MotionBlur};
    let mut q = world.query_filtered::<Entity, With<MainCamera>>();
    let Some(e) = q.iter(world).next() else { return Value::Null };
    let em = world.entity(e);
    let mut out = Vec::new();
    macro_rules! check {
        ($($t:ty),* $(,)?) => {$(
            if em.contains::<$t>() {
                out.push(stringify!($t));
            }
        )*};
    }
    check!(
        Hdr, Fxaa, TemporalAntiAliasing, ScreenSpaceAmbientOcclusion, Bloom, ContactShadows, ScreenSpaceReflections,
        ShadowFilteringMethod, DistanceFog, VolumetricFog, AtmosphereSettings, Skybox, AtmosphereEnvironmentMapLight,
        GeneratedEnvironmentMapLight, EnvironmentMapLight, AutoExposure, DepthOfField, MotionBlur, ChromaticAberration, Vignette,
        LensDistortion, crate::look::FilmGrain, DepthPrepass, NormalPrepass, MotionVectorPrepass, DeferredPrepass,
    );
    json!(out)
}

fn look_get(world: &mut World, _: Value) -> Result<Value, String> {
    let tier = Tier::of(world.resource::<QualityPreset>(), world.resource::<CoreSettings>().quality);
    let st = world.resource::<LookState>();
    let state = json!({"applies": st.applies, "last_apply_us": st.last_apply_us, "env": crate::look::apply::env_state_json(st)});
    Ok(json!({
        "look": world.get_resource::<Look>().map(|l| serde_json::to_value(l).unwrap_or(Value::Null)),
        "presets": Look::PRESETS,
        "quality": format!("{:?}", tier.quality),
        "tier": format!("{tier:?}"),
        "features": features_json(world),
        "transition": world.get_resource::<LookTransition>().map(|t| json!({"to": t.to.name, "t": t.t()})),
        "timeline": world.get_resource::<LookTimeline>().map(|t| json!({"time": t.time, "speed": t.speed, "keys": t.keys.len()})),
        "state": state,
        "camera": camera_components(world),
    }))
}

fn look_set(world: &mut World, p: Value) -> Result<Value, String> {
    let current = world.get_resource::<Look>().cloned();
    let mut target = match p.get("preset").and_then(Value::as_str) {
        Some(name) => Look::preset(name).ok_or_else(|| format!("unknown preset `{name}` (have {:?})", Look::PRESETS))?,
        None => current.clone().unwrap_or_default(),
    };
    if let Some(fields) = p.get("fields") {
        target = target.patched(fields)?;
    }
    let blend = p.get("blend").and_then(Value::as_f64).unwrap_or(0.0) as f32;
    world.remove_resource::<LookTimeline>();
    let name = target.name.to_string();
    match current {
        Some(from) if blend > 0.0 => {
            world.insert_resource(LookTransition::new(from, target, blend));
        }
        _ => {
            world.remove_resource::<LookTransition>();
            world.insert_resource(target);
        }
    }
    Ok(json!({"look": name, "blend": blend}))
}

fn look_feature(world: &mut World, p: Value) -> Result<Value, String> {
    let Some(name) = p.get("name").and_then(Value::as_str) else {
        return Ok(json!({"features": features_json(world)}));
    };
    let on = p.get("on").and_then(Value::as_bool).ok_or("`on` (boolean) is required")?;
    let i = tier_index(world);
    let mut preset = world.resource::<QualityPreset>().clone();
    let mut look = world.get_resource::<Look>().cloned().unwrap_or_default();
    if !set_feature(&mut preset, i, &mut look, name, on) {
        return Err(format!("unknown feature `{name}` (have {FEATURES:?})"));
    }
    world.insert_resource(preset);
    world.remove_resource::<LookTransition>();
    world.remove_resource::<LookTimeline>();
    world.insert_resource(look);
    Ok(json!({"feature": name, "on": on, "features": features_json(world)}))
}

fn look_time(world: &mut World, p: Value) -> Result<Value, String> {
    if p.get("stop").and_then(Value::as_bool) == Some(true) {
        world.remove_resource::<LookTimeline>();
        return Ok(json!({"timeline": null}));
    }
    if !world.contains_resource::<LookTimeline>() {
        world.insert_resource(LookTimeline::day_cycle(0.0));
    }
    world.remove_resource::<LookTransition>();
    let mut tl = world.resource_mut::<LookTimeline>();
    if let Some(t) = p.get("time").and_then(Value::as_f64) {
        tl.time = t as f32;
    }
    if let Some(s) = p.get("speed").and_then(Value::as_f64) {
        tl.speed = s as f32;
    }
    tl.set_changed();
    Ok(json!({"time": tl.time, "speed": tl.speed, "period": tl.period}))
}

fn look_probe(world: &mut World, p: Value) -> Result<Value, String> {
    let bake = p.get("bake").and_then(Value::as_bool).unwrap_or(false);
    let refresh = p.get("refresh").and_then(Value::as_i64);
    let mut q = world.query::<(Entity, &mut ReflectionProbe, &GlobalTransform, Option<&ProbeTargets>)>();
    let mut out = Vec::new();
    for (e, mut probe, tf, targets) in q.iter_mut(world) {
        if let Some(r) = refresh {
            probe.refresh = (r >= 0).then_some(r as u32);
            probe.rebake();
        }
        if bake {
            probe.rebake();
        }
        let (copies, filtered) = targets.map(ReflectionProbe::gpu_counters).unwrap_or_default();
        out.push(json!({
            "entity": e.to_bits(),
            "pos": tf.translation().to_array(),
            "resolution": probe.resolution,
            "captures": probe.captures(),
            "gpu_copies": copies,
            "filtered_frames": filtered,
            "frozen": probe.is_frozen(),
            "refresh": probe.refresh,
            "diffuse_updates": probe.diffuse_updates(),
        }));
    }
    Ok(json!({"probes": out, "bake": bake}))
}
