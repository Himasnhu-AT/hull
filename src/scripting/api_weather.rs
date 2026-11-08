//! Weather host functions (feature `weather`).
//!
//! | Function | Does |
//! |---|---|
//! | `weather_get()` | dict: `name kind forced blend cloud precip fog wind_speed gustiness temperature_c snow` |
//! | `weather_force(name, blend_secs)` | blend to a named weather and hold it; `false` for an unknown name |
//! | `weather_release(blend_secs)` | go back to the seeded schedule |
//! | `weather_set_time(secs)` | jump the weather clock (the schedule follows) |
//! | `weather_wetness([pos])` | ground wetness 0..1, at a world position `[x,y,z]` or in the open |
//! | `weather_wind()` | air velocity in m/s as a vec3 |

use bevy::ecs::system::SystemState;
use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{f, rv3, s, v3, world};
use crate::logic::script::rv_of_json;
use crate::weather::{SurfaceQuery, Weather, WeatherLibrary, Wetness, Wind};

fn res<'w, R: Resource<Mutability = bevy::ecs::component::Mutable>>(w: &'w mut World) -> Result<Mut<'w, R>, String> {
    w.get_resource_mut::<R>().ok_or_else(|| "the weather module is not set up in this app".to_string())
}

pub(super) fn register(e: &mut Engine) {
    e.register("weather_get", |c, a| {
        let w = world(c)?;
        if !a.is_empty() {
            return Err("usage: weather_get()".into());
        }
        let lib = w.get_resource::<WeatherLibrary>().ok_or("the weather module is not set up in this app")?;
        let we = w.get_resource::<Weather>().ok_or("the weather module is not set up in this app")?;
        let p = we.params;
        let kind = format!("{:?}", we.kind()).to_lowercase();
        Ok(rv_of_json(&serde_json::json!({
            "name": we.name(lib), "kind": kind, "forced": we.is_forced(), "blend": we.blend,
            "cloud": p.cloud, "precip": p.precip, "fog": p.fog, "wind_speed": p.wind_speed,
            "gustiness": p.gustiness, "temperature_c": p.temperature_c, "snow": p.is_snow(),
        })))
    });
    e.register("weather_force", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: weather_force(name, blend_secs)".into());
        }
        let (name, secs) = (s(&a[0], "name")?.to_string(), f(&a[1], "blend_secs")?);
        let lib = res::<WeatherLibrary>(w)?.clone();
        Ok(RV::Bool(res::<Weather>(w)?.force(&lib, &name, secs)))
    });
    e.register("weather_release", |c, a| {
        let w = world(c)?;
        if a.len() != 1 {
            return Err("usage: weather_release(blend_secs)".into());
        }
        let secs = f(&a[0], "blend_secs")?;
        res::<Weather>(w)?.release(secs);
        Ok(RV::Void)
    });
    e.register("weather_set_time", |c, a| {
        let w = world(c)?;
        if a.len() != 1 {
            return Err("usage: weather_set_time(secs)".into());
        }
        let t = f(&a[0], "secs")?;
        res::<Weather>(w)?.set_time(t as f64);
        Ok(RV::Void)
    });
    e.register("weather_wetness", |c, a| {
        let w = world(c)?;
        match a {
            [] => Ok(RV::Float(res::<Wetness>(w)?.0 as f64)),
            [p] => {
                let p = v3(p, "pos")?;
                res::<Wetness>(w)?;
                let mut st = SystemState::<SurfaceQuery>::new(w);
                let q = st.get(w).map_err(|e| e.to_string())?;
                Ok(RV::Float(q.wetness_at(p) as f64))
            }
            _ => Err("usage: weather_wetness([pos])".into()),
        }
    });
    e.register("weather_wind", |c, a| {
        let w = world(c)?;
        if !a.is_empty() {
            return Err("usage: weather_wind()".into());
        }
        Ok(rv3(res::<Wind>(w)?.vector()))
    });
}
