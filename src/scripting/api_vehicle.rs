//! Vehicle host functions (feature `vehicle`). `[n,]` is the optional leading node (`self`).
//!
//! | Function | Does |
//! |---|---|
//! | `vehicle_drive([n,] throttle, steer, brake)` | driver pedals and wheel in one call (-1..1, -1..1, 0..1) |
//! | `vehicle_handbrake([n,] bool)`, `vehicle_park([n,] bool)` | handbrake / parking brake |
//! | `vehicle_set_mode([n,] name_or_index)` | transfer case position (`"2H"`, `"4H"`, `"4L"` for the stock truck) |
//! | `vehicle_diff_lock([n,] axle, bool)`, `vehicle_shift([n,] +1 or -1)`, `vehicle_set_pressure([n,] kpa)` | diff lock, manual shift, tyre pressure |
//! | `vehicle_get([n,] key)` | telemetry number: `speed rpm gear throttle load slip grounded mode bottomed pressure` |
//! | `vehicle_wheel([n,] i, key)` | per wheel: `compression load slip_ratio slip_angle spin grounded surface` |
//! | `winch_attach([n,] local, target [, length, max_force])` | rope from a point on the node to a world point `[x,y,z]` or another node; returns the rope |
//! | `tow_strap([n,] local, other, other_local, length)` | elastic strap between two nodes; returns the rope |
//! | `rope_reel(rope, x)`, `rope_tension(rope)`, `rope_length(rope)`, `rope_release(rope)` | motor (+1 in, -1 out, 0 hold), pull in N, length, remove |

use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{b, ent, f, live, rent, s, split, v3, world};
use crate::vehicle::{Rope, RopeEnd, Vehicle, VehicleInput, VehicleTelemetry};

fn input<'w>(w: &'w mut World, t: Entity) -> Result<Mut<'w, VehicleInput>, String> {
    w.get_mut::<VehicleInput>(t).ok_or_else(|| format!("entity {t} is not a vehicle"))
}

fn rope<'w>(w: &'w mut World, v: &RV) -> Result<Mut<'w, Rope>, String> {
    let e = live(w, ent(v)?)?;
    w.get_mut::<Rope>(e).ok_or_else(|| format!("entity {e} is not a rope"))
}

pub(super) fn register(e: &mut Engine) {
    e.register("vehicle_drive", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 3, "vehicle_drive([n,] throttle, steer, brake)")?;
        let (th, st, br) = (f(&r[0], "throttle")?, f(&r[1], "steer")?, f(&r[2], "brake")?);
        let mut i = input(w, t)?;
        i.throttle = th.clamp(-1.0, 1.0);
        i.steer = st.clamp(-1.0, 1.0);
        i.brake = br.clamp(0.0, 1.0);
        Ok(RV::Void)
    });
    e.register("vehicle_handbrake", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "vehicle_handbrake([n,] bool)")?;
        input(w, t)?.handbrake = b(&r[0], "on")?;
        Ok(RV::Void)
    });
    e.register("vehicle_park", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "vehicle_park([n,] bool)")?;
        input(w, t)?.park = b(&r[0], "on")?;
        Ok(RV::Void)
    });
    e.register("vehicle_set_mode", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "vehicle_set_mode([n,] name_or_index)")?;
        let idx = match &r[0] {
            RV::Str(name) => w
                .get::<Vehicle>(t)
                .and_then(|v| v.spec.transfer.iter().position(|m| m.name == *name))
                .ok_or_else(|| format!("no transfer mode `{name}`"))?,
            other => f(other, "mode")? as usize,
        };
        input(w, t)?.transfer = idx;
        Ok(RV::Void)
    });
    e.register("vehicle_diff_lock", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 2, "vehicle_diff_lock([n,] axle, bool)")?;
        let (axle, on) = (f(&r[0], "axle")? as usize, b(&r[1], "on")?);
        let mut i = input(w, t)?;
        *i.diff_lock.get_mut(axle).ok_or("axle out of range")? = on;
        Ok(RV::Void)
    });
    e.register("vehicle_shift", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "vehicle_shift([n,] +1 or -1)")?;
        input(w, t)?.shift = f(&r[0], "dir")?.signum() as i8;
        Ok(RV::Void)
    });
    e.register("vehicle_set_pressure", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "vehicle_set_pressure([n,] kpa)")?;
        let kpa = f(&r[0], "kpa")?;
        w.get_mut::<Vehicle>(t).ok_or("not a vehicle")?.pressure = kpa;
        Ok(RV::Void)
    });
    e.register("vehicle_get", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "vehicle_get([n,] key)")?;
        let key = s(&r[0], "key")?;
        let tel = w.get::<VehicleTelemetry>(t).ok_or("not a vehicle")?;
        let v = match key {
            "speed" => tel.speed,
            "rpm" => tel.rpm,
            "gear" => tel.gear as f32,
            "throttle" => tel.throttle,
            "load" => tel.engine_load,
            "slip" => tel.max_slip,
            "grounded" => tel.grounded_wheels as f32,
            "mode" => tel.transfer as f32,
            "bottomed" => tel.bottomed as i32 as f32,
            "pressure" => w.get::<Vehicle>(t).map_or(0.0, |v| v.pressure),
            other => return Err(format!("unknown telemetry key `{other}`")),
        };
        Ok(RV::Float(v as f64))
    });
    e.register("vehicle_wheel", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 2, "vehicle_wheel([n,] i, key)")?;
        let i = f(&r[0], "i")? as usize;
        let tel = w.get::<VehicleTelemetry>(t).ok_or("not a vehicle")?;
        let wh = tel.wheels.get(i).ok_or("wheel out of range")?;
        let v = match s(&r[1], "key")? {
            "compression" => wh.compression,
            "load" => wh.load,
            "slip_ratio" => wh.slip_ratio,
            "slip_angle" => wh.slip_angle,
            "spin" => wh.spin,
            "grounded" => wh.grounded as i32 as f32,
            "surface" => wh.surface.0 as f32,
            other => return Err(format!("unknown wheel key `{other}`")),
        };
        Ok(RV::Float(v as f64))
    });
    e.register("winch_attach", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 2, "winch_attach([n,] local, target)")?;
        let local = v3(&r[0], "local")?;
        let to = match &r[1] {
            RV::Array(_) => RopeEnd::World(v3(&r[1], "target")?),
            other => {
                let n = live(w, ent(other)?)?;
                RopeEnd::Body { entity: n, local: Vec3::ZERO }
            }
        };
        let from = RopeEnd::Body { entity: t, local };
        let (pa, pb) = (end_point(w, from), end_point(w, to));
        let len = pa.distance(pb).max(0.6);
        Ok(rent(w.spawn((Name::new("Winch"), Rope::winch(from, to, len))).id()))
    });
    e.register("tow_strap", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 4, "tow_strap([n,] local, other, other_local, length)")?;
        let ends = (RopeEnd::Body { entity: t, local: v3(&r[0], "local")? }, RopeEnd::Body { entity: live(w, ent(&r[1])?)?, local: v3(&r[2], "other_local")? });
        let len = f(&r[3], "length")?;
        Ok(rent(w.spawn((Name::new("Tow strap"), Rope::strap(ends.0, ends.1, len))).id()))
    });
    e.register("rope_reel", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: rope_reel(rope, x)".into());
        }
        let x = f(&a[1], "x")?;
        rope(w, &a[0])?.reel = x.clamp(-1.0, 1.0);
        Ok(RV::Void)
    });
    e.register("rope_tension", |c, a| {
        let w = world(c)?;
        let t = rope(w, a.first().ok_or("usage: rope_tension(rope)")?)?.tension;
        Ok(RV::Float(t as f64))
    });
    e.register("rope_length", |c, a| {
        let w = world(c)?;
        let l = rope(w, a.first().ok_or("usage: rope_length(rope)")?)?.length;
        Ok(RV::Float(l as f64))
    });
    e.register("rope_release", |c, a| {
        let w = world(c)?;
        let e = live(w, ent(a.first().ok_or("usage: rope_release(rope)")?)?)?;
        w.entity_mut(e).despawn();
        Ok(RV::Void)
    });
}

fn end_point(w: &World, end: RopeEnd) -> Vec3 {
    match end {
        RopeEnd::World(p) => p,
        RopeEnd::Body { entity, local } => w.get::<Transform>(entity).map_or(local, |t| t.transform_point(local)),
    }
}
