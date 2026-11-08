//! Control commands: `camera.rig` (state / switch mode / cut).

use bevy::prelude::*;
use serde_json::{Value, json};

use super::{CameraRig, Chase, Free, Mounted, Orbit, RigMode, SpeedFeel};
use crate::devtools::{AddControlCommand, params};

fn mode_name(m: &RigMode) -> &'static str {
    match m {
        RigMode::Chase(_) => "chase",
        RigMode::Mounted(_) => "mounted",
        RigMode::Orbit(_) => "orbit",
        RigMode::Free(_) => "free",
    }
}

pub(super) fn register(app: &mut App) {
    app.add_control_command(
        "camera.rig",
        "Camera rig state; `mode` switches (chase | mounted | orbit | free), `active` hands the camera back, `cut` resets",
        params(&[("mode", "string", "chase | mounted | orbit | free"), ("active", "boolean", "rig drives the camera"), ("cut", "boolean", "teleport to the wanted pose")]),
        |w, p| {
            let mut q = w.query::<(Entity, &mut CameraRig, &Transform)>();
            let mut out = vec![];
            for (e, mut rig, tf) in q.iter_mut(w) {
                match p.get("mode").and_then(Value::as_str) {
                    Some("chase") => rig.set_mode(RigMode::Chase(Chase::default())),
                    Some("mounted") => rig.set_mode(RigMode::Mounted(Mounted::default())),
                    Some("orbit") => rig.set_mode(RigMode::Orbit(Orbit::default())),
                    Some("free") => rig.set_mode(RigMode::Free(Free::default())),
                    Some(m) => return Err(format!("unknown mode {m}")),
                    None => {}
                }
                if let Some(a) = p.get("active").and_then(Value::as_bool) {
                    rig.active = a;
                }
                if p.get("cut").and_then(Value::as_bool) == Some(true) {
                    rig.cut();
                }
                out.push(json!({"entity": e.to_bits(), "mode": mode_name(&rig.mode), "active": rig.active, "target": rig.target.map(|t| t.to_bits()),
                    "speed": rig.target_speed(), "position": tf.translation.to_array()}));
            }
            Ok(json!({"rigs": out, "speed_feel": w.resource::<SpeedFeel>().0}))
        },
    );
}
