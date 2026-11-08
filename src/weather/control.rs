//! Control commands: `weather.state`, `weather.list`, `weather.set`, `weather.release`, `weather.time`.

use bevy::prelude::*;
use serde_json::{Value as Json, json};

use super::*;
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    app.add_control_command("weather.state", "Current weather: params, kind, blend, wind, wetness, forced override", params(&[]), state)
        .add_control_command("weather.list", "The weather library (defs with params, durations, transitions)", params(&[]), list)
        .add_control_command(
            "weather.set",
            "Force a weather by name (held until weather.release)",
            params(&[("name", "string", "def name, e.g. rain"), ("blend", "number", "blend seconds (default 5)")]),
            set,
        )
        .add_control_command("weather.release", "Return to the schedule", params(&[("blend", "number", "blend seconds (default 5)")]), release)
        .add_control_command(
            "weather.time",
            "Set the weather clock / speed / seed / pause",
            params(&[("time", "number", "seconds"), ("speed", "number", "clock multiplier"), ("seed", "number", "schedule seed"), ("paused", "boolean", "freeze the clock")]),
            time,
        );
}

fn state(world: &mut World, _: Json) -> Result<Json, String> {
    let w = world.resource::<Weather>();
    let lib = world.resource::<WeatherLibrary>();
    let wind = world.resource::<Wind>();
    Ok(json!({
        "seed": w.seed, "time": w.time, "speed": w.speed, "paused": w.paused,
        "name": w.name(lib), "kind": w.kind(), "blend": w.blend,
        "current": lib.defs.get(w.current).map(|d| d.name.clone()), "next": lib.defs.get(w.next).map(|d| d.name.clone()),
        "forced": w.forced_name(), "is_forced": w.is_forced(),
        "params": w.params,
        "wind": {"dir": [wind.dir.x, wind.dir.z], "speed": wind.speed},
        "wetness": world.resource::<Wetness>().0,
        "snow": w.params.is_snow(),
    }))
}

fn list(world: &mut World, _: Json) -> Result<Json, String> {
    serde_json::to_value(world.resource::<WeatherLibrary>()).map_err(|e| e.to_string())
}

fn set(world: &mut World, p: Json) -> Result<Json, String> {
    let name = p.get("name").and_then(Json::as_str).ok_or("`name` is required")?;
    let blend = p.get("blend").and_then(Json::as_f64).unwrap_or(5.0) as f32;
    let lib = world.resource::<WeatherLibrary>().clone();
    if !world.resource_mut::<Weather>().force(&lib, name, blend) {
        return Err(format!("unknown weather `{name}` (have: {})", lib.defs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>().join(", ")));
    }
    Ok(json!({"forced": name, "blend": blend}))
}

fn release(world: &mut World, p: Json) -> Result<Json, String> {
    let blend = p.get("blend").and_then(Json::as_f64).unwrap_or(5.0) as f32;
    world.resource_mut::<Weather>().release(blend);
    Ok(json!({"released": true}))
}

fn time(world: &mut World, p: Json) -> Result<Json, String> {
    let mut w = world.resource_mut::<Weather>();
    if let Some(t) = p.get("time").and_then(Json::as_f64) {
        w.set_time(t);
    }
    if let Some(s) = p.get("speed").and_then(Json::as_f64) {
        w.speed = s as f32;
    }
    if let Some(s) = p.get("seed").and_then(Json::as_u64) {
        w.seed = s;
        w.sched_reset();
    }
    if let Some(b) = p.get("paused").and_then(Json::as_bool) {
        w.paused = b;
    }
    Ok(json!({"seed": w.seed, "time": w.time, "speed": w.speed, "paused": w.paused}))
}
