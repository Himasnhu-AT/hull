//! Control commands: `spray.get` (points, effects, rules), `spray.set` (surface override for testing).

use bevy::prelude::*;
use serde_json::{Value, json};

use super::{SprayInput, SprayKids, SprayKind, SprayPoint, SprayRules, Surface};
use crate::devtools::{AddControlCommand, params};
use crate::vfx::ParticleEffect;

fn surface(name: &str) -> Option<Surface> {
    Some(match name {
        "hard" => Surface::Hard,
        "gravel" => Surface::Gravel,
        "dirt" => Surface::Dirt,
        "sand" => Surface::Sand,
        "grass" => Surface::Grass,
        "mud" => Surface::Mud,
        "snow" => Surface::Snow,
        "wet" => Surface::Wet,
        _ => return None,
    })
}

pub(super) fn register(app: &mut App) {
    app.add_control_command("spray.get", "Spray points with their input and live effect rate scales, and the rule count", params(&[]), |w, _| {
        let mut q = w.query::<(Entity, &SprayPoint, &SprayInput, Option<&SprayKids>)>();
        let mut effects = w.query::<&ParticleEffect>();
        let pts: Vec<Value> = q
            .iter(w)
            .map(|(e, p, i, kids)| {
                let live: Vec<Value> = kids
                    .map(|k| SprayKind::ALL.iter().filter_map(|kind| k.0[*kind as usize].map(|id| (kind, id))).filter_map(|(kind, id)| effects.get(w, id).ok().map(|f| json!({"kind": kind.effect(), "rate_scale": f.rate_scale}))).collect())
                    .unwrap_or_default();
                json!({"entity": e.to_bits(), "surface": i.surface.map(|s| format!("{s:?}")), "speed": i.speed, "slip": i.slip, "rear": p.rear, "effects": live})
            })
            .collect();
        Ok(json!({"points": pts, "rules": w.resource::<SprayRules>().0.len()}))
    })
    .add_control_command(
        "spray.set",
        "Force every point's input (testing): surface (hard|gravel|dirt|sand|grass|mud|snow|wet|none), speed, slip",
        params(&[("surface", "string", "surface name or none"), ("speed", "number", "m/s"), ("slip", "number", "0..1")]),
        |w, p| {
            let mut n = 0;
            let mut q = w.query::<&mut SprayInput>();
            for mut i in q.iter_mut(w) {
                if let Some(s) = p.get("surface").and_then(Value::as_str) {
                    i.surface = if s == "none" { None } else { Some(surface(s).ok_or("unknown surface")?) };
                }
                if let Some(v) = p.get("speed").and_then(Value::as_f64) {
                    i.speed = v as f32;
                }
                if let Some(v) = p.get("slip").and_then(Value::as_f64) {
                    i.slip = v as f32;
                }
                n += 1;
            }
            Ok(json!({"points": n}))
        },
    );
}
