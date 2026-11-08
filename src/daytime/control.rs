//! Control commands: `day.get`, `day.set`, `day.clouds`.

use bevy::prelude::*;
use serde_json::{Value, json};

use super::{CloudDome, CloudState, DayClock, DayConfig, DayLookState, DaySky, DayWeather, refresh_env_soon};
use crate::devtools::{AddControlCommand, params};

fn state(world: &World) -> Value {
    let (Some(c), Some(sky)) = (world.get_resource::<DayClock>(), world.get_resource::<DaySky>()) else { return Value::Null };
    let w = world.resource::<DayWeather>();
    let m = &sky.moon;
    json!({
        "hours": c.hours, "day": c.day, "rate": c.rate, "running": c.running, "latitude": c.latitude,
        "sun": {"azimuth": sky.sun_azimuth, "elevation": sky.sun_elevation},
        "moon": {"azimuth": m.azimuth, "elevation": m.elevation, "illumination": m.illumination, "age": m.age},
        "light": {"azimuth": sky.light.azimuth, "elevation": sky.light.elevation, "lux": sky.light.lux, "moon": sky.light.moon > 0.0},
        "daylight": sky.daylight, "stars": sky.stars,
        "weather": {"overcast": w.overcast, "cover": w.cover},
        "look_writes": world.get_resource::<DayLookState>().map_or(0, |s| s.writes),
        "cloud_cover": world.get_resource::<CloudState>().map_or(0.0, |s| s.cover),
        "cloud_sun_factor": world.get_resource::<CloudState>().map_or(1.0, |s| s.sun_factor),
    })
}

fn set(world: &mut World, p: Value) -> Result<Value, String> {
    let f = |k: &str| p.get(k).and_then(Value::as_f64).map(|v| v as f32);
    let mut c = world.get_resource_mut::<DayClock>().ok_or("no DayClock: insert one to enable the day")?;
    let jumped = f("time").is_some() || f("day").is_some();
    if let Some(h) = f("time") {
        c.hours = h.rem_euclid(24.0);
    }
    if let Some(d) = f("day") {
        c.day = d.rem_euclid(365.0);
    }
    if let Some(r) = f("rate") {
        c.rate = r;
        c.running = r > 0.0;
    }
    if let Some(l) = f("latitude") {
        c.latitude = l.clamp(-90.0, 90.0);
    }
    if let Some(b) = p.get("running").and_then(Value::as_bool) {
        c.running = b;
    }
    if f("overcast").is_some() || p.get("cover").is_some() {
        let mut w = world.resource_mut::<DayWeather>();
        if let Some(o) = f("overcast") {
            w.overcast = o.clamp(0.0, 1.0);
        }
        if let Some(v) = p.get("cover") {
            w.cover = v.as_f64().map(|x| (x as f32).clamp(0.0, 1.0));
        }
    }
    if jumped {
        refresh_env_soon(world);
    }
    // The sky is recomputed on the next frame; compute it now so the reply is current.
    let sky = DaySky::compute(world.resource::<DayClock>(), world.resource::<DayConfig>());
    world.insert_resource(sky);
    Ok(state(world))
}

pub(super) fn register(app: &mut App) {
    app.add_control_command("day.get", "The day clock, sun, moon, light, weather and cloud state", params(&[]), |w, _| Ok(state(w)))
        .add_control_command(
            "day.set",
            "Set the clock / weather (any subset)",
            params(&[
                ("time", "number", "clock hour 0..24"),
                ("day", "number", "day of the year 0..365"),
                ("rate", "number", "game seconds per real second (0 freezes)"),
                ("running", "boolean", "run or freeze the clock"),
                ("latitude", "number", "degrees north"),
                ("overcast", "number", "0 clear .. 1 overcast"),
                ("cover", "number", "cloud coverage override 0..1 (null: keyed)"),
            ]),
            set,
        )
        .add_control_command("day.clouds", "Show or hide the cloud dome and its shadows; no params: state", params(&[("on", "boolean", "clouds on")]), |w, p| {
            let on = p.get("on").and_then(Value::as_bool);
            if let Some(on) = on {
                w.resource_mut::<DayConfig>().clouds.enabled = on;
                let mut q = w.query_filtered::<&mut Visibility, With<CloudDome>>();
                for mut v in q.iter_mut(w) {
                    *v = if on { Visibility::Inherited } else { Visibility::Hidden };
                }
            }
            let mut q = w.query_filtered::<(), With<CloudDome>>();
            let domes = q.iter(w).count();
            Ok(json!({"domes": domes, "enabled": w.resource::<DayConfig>().clouds.enabled}))
        });
}
