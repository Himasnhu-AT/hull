//! Day-clock host functions (feature `daytime`). They need the [`DayClock`] resource.
//!
//! | Function | Does |
//! |---|---|
//! | `daytime_get_time()` / `daytime_set_time(hours)` | local clock hour `0..24` |
//! | `daytime_get_speed()` / `daytime_set_speed(x)` | game seconds per real second (0 pauses the clock) |
//! | `daytime_sun_elevation()` | sun height above the horizon in degrees (negative = below) |
//! | `daytime_is_night()` | is the sun well below the horizon? |

use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{f, world};
use crate::daytime::DayClock;

fn clock<'w>(w: &'w mut World) -> Result<Mut<'w, DayClock>, String> {
    w.get_resource_mut::<DayClock>().ok_or_else(|| "no DayClock: insert one to turn the day cycle on".to_string())
}

pub(super) fn register(e: &mut Engine) {
    e.register("daytime_get_time", |c, a| {
        if !a.is_empty() {
            return Err("usage: daytime_get_time()".into());
        }
        Ok(RV::Float(clock(world(c)?)?.hours as f64))
    });
    e.register("daytime_set_time", |c, a| {
        if a.len() != 1 {
            return Err("usage: daytime_set_time(hours)".into());
        }
        let h = f(&a[0], "hours")?;
        clock(world(c)?)?.hours = h.rem_euclid(24.0);
        Ok(RV::Void)
    });
    e.register("daytime_get_speed", |c, a| {
        if !a.is_empty() {
            return Err("usage: daytime_get_speed()".into());
        }
        let k = clock(world(c)?)?;
        Ok(RV::Float(if k.running { k.rate as f64 } else { 0.0 }))
    });
    e.register("daytime_set_speed", |c, a| {
        if a.len() != 1 {
            return Err("usage: daytime_set_speed(x)".into());
        }
        let x = f(&a[0], "x")?;
        let mut k = clock(world(c)?)?;
        k.running = x > 0.0;
        if x > 0.0 {
            k.rate = x;
        }
        Ok(RV::Void)
    });
    e.register("daytime_sun_elevation", |c, a| {
        if !a.is_empty() {
            return Err("usage: daytime_sun_elevation()".into());
        }
        Ok(RV::Float(clock(world(c)?)?.sun().1 as f64))
    });
    e.register("daytime_is_night", |c, a| {
        if !a.is_empty() {
            return Err("usage: daytime_is_night()".into());
        }
        Ok(RV::Bool(clock(world(c)?)?.is_night()))
    });
}
