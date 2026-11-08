//! `vehicle.*` control commands (feature `devtools`).

use bevy::prelude::*;
use serde_json::{Value, json};

use super::{Vehicle, VehicleInput, VehicleSpec, VehicleTelemetry};
use crate::devtools::{AddControlCommand, params};

pub(crate) fn register(app: &mut App) {
    app.add_control_command("vehicle.list", "Vehicles: entity, name, speed, rpm, gear", params(&[]), list)
        .add_control_command("vehicle.state", "Full telemetry of one vehicle", params(&[("entity", "string", "entity id or name")]), state)
        .add_control_command(
            "vehicle.input",
            "Set driver input: throttle, steer, brake, handbrake, park, transfer (index), diff_lock (axle, bool), shift",
            params(&[("entity", "string", "entity id or name"), ("throttle", "number", ""), ("steer", "number", ""), ("brake", "number", ""), ("handbrake", "boolean", ""), ("transfer", "integer", "")]),
            input,
        )
        .add_control_command("vehicle.spawn", "Spawn the default truck at [x, y, z]", params(&[("pos", "array", "[x, y, z]")]), spawn);
}

fn find(world: &mut World, v: &Value) -> Result<Entity, String> {
    let mut q = world.query_filtered::<(Entity, Option<&Name>), With<Vehicle>>();
    let rows: Vec<(Entity, Option<String>)> = q.iter(world).map(|(e, n)| (e, n.map(|n| n.to_string()))).collect();
    match v {
        Value::String(s) => rows.iter().find(|(e, n)| e.to_bits().to_string() == *s || n.as_deref() == Some(s)).map(|r| r.0),
        Value::Number(n) => rows.iter().find(|(e, _)| Some(e.to_bits()) == n.as_u64()).map(|r| r.0),
        _ => rows.first().map(|r| r.0),
    }
    .ok_or_else(|| "no such vehicle".to_string())
}

fn list(world: &mut World, _: Value) -> Result<Value, String> {
    let mut q = world.query::<(Entity, Option<&Name>, &VehicleTelemetry)>();
    Ok(Value::Array(q.iter(world).map(|(e, n, t)| json!({"entity": e.to_bits(), "name": n.map(|n| n.to_string()), "speed": t.speed, "rpm": t.rpm, "gear": t.gear})).collect()))
}

fn state(world: &mut World, p: Value) -> Result<Value, String> {
    let e = find(world, &p["entity"])?;
    let t = world.get::<VehicleTelemetry>(e).ok_or("no telemetry")?;
    let tf = world.get::<Transform>(e).copied().unwrap_or_default();
    Ok(json!({
        "pos": tf.translation.to_array(), "speed": t.speed, "rpm": t.rpm, "gear": t.gear, "throttle": t.throttle, "engine_load": t.engine_load,
        "transfer": t.transfer, "grounded_wheels": t.grounded_wheels, "bottomed": t.bottomed, "max_slip": t.max_slip,
        "wheels": t.wheels.iter().map(|w| json!({"grounded": w.grounded, "compression": w.compression, "load": w.load, "slip_ratio": w.slip_ratio, "slip_angle": w.slip_angle, "spin": w.spin, "surface": w.surface.0, "drive_torque": w.drive_torque})).collect::<Vec<_>>(),
    }))
}

fn input(world: &mut World, p: Value) -> Result<Value, String> {
    let e = find(world, &p["entity"])?;
    let mut i = world.get_mut::<VehicleInput>(e).ok_or("no input")?;
    if let Some(x) = p["throttle"].as_f64() {
        i.throttle = x as f32;
    }
    if let Some(x) = p["steer"].as_f64() {
        i.steer = x as f32;
    }
    if let Some(x) = p["brake"].as_f64() {
        i.brake = x as f32;
    }
    if let Some(x) = p["handbrake"].as_bool() {
        i.handbrake = x;
    }
    if let Some(x) = p["park"].as_bool() {
        i.park = x;
    }
    if let Some(x) = p["transfer"].as_u64() {
        i.transfer = x as usize;
    }
    if let Some(a) = p["diff_lock"].as_array()
        && let [axle, on] = &a[..]
        && let (Some(axle), Some(on)) = (axle.as_u64(), on.as_bool())
        && (axle as usize) < i.diff_lock.len()
    {
        i.diff_lock[axle as usize] = on;
    }
    if let Some(x) = p["shift"].as_i64() {
        i.shift = x.clamp(-1, 1) as i8;
    }
    Ok(json!({"ok": true}))
}

fn spawn(world: &mut World, p: Value) -> Result<Value, String> {
    let pos = p["pos"].as_array().map(|a| Vec3::new(a[0].as_f64().unwrap_or(0.0) as f32, a[1].as_f64().unwrap_or(1.0) as f32, a[2].as_f64().unwrap_or(0.0) as f32)).unwrap_or(Vec3::Y);
    let e = world.spawn(VehicleSpec::truck().bundle(Transform::from_translation(pos))).id();
    Ok(json!({"entity": e.to_bits()}))
}
