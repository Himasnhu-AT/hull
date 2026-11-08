//! Control commands: `foliage.get`, `foliage.config`.

use bevy::prelude::*;
use serde_json::{Value, json};

use super::{Foliage, FoliageConfig, FoliageStats};
use crate::devtools::{AddControlCommand, params};

fn state(w: &World) -> Value {
    let (c, s) = (w.resource::<FoliageConfig>(), w.resource::<FoliageStats>());
    json!({
        "enabled": c.enabled, "impostors": c.impostors, "near": c.near, "fade": c.fade, "far": c.far, "chunk": c.chunk, "thin": c.thin,
        "species": w.get_resource::<Foliage>().map_or(0, |f| f.species.len()),
        "instances": w.get_resource::<Foliage>().map_or(0, |f| f.instances.len()),
        "chunks": s.chunks, "near_chunks": s.near_chunks, "near_entities": s.near_entities, "impostor_chunks": s.impostor_chunks, "impostor_quads": s.impostor_quads,
    })
}

pub(super) fn register(app: &mut App) {
    app.add_control_command("foliage.get", "Foliage config and what is resident (near entities, impostor chunks and quads)", params(&[]), |w, _| Ok(state(w)))
        .add_control_command(
            "foliage.config",
            "Change the LOD ranges (any subset); changing a range rebuilds the impostor materials",
            params(&[
                ("enabled", "boolean", "draw foliage"),
                ("impostors", "boolean", "draw impostors (off: near models only)"),
                ("near", "number", "near models fully drawn up to (m)"),
                ("fade", "number", "crossfade length (m)"),
                ("far", "number", "impostors out by (m)"),
                ("thin", "integer", "impostor for every n-th instance"),
            ]),
            |w, p| {
                let mut c = w.resource_mut::<FoliageConfig>();
                let f = |k: &str| p.get(k).and_then(Value::as_f64).map(|v| v as f32);
                if let Some(v) = p.get("enabled").and_then(Value::as_bool) {
                    c.enabled = v;
                }
                if let Some(v) = p.get("impostors").and_then(Value::as_bool) {
                    c.impostors = v;
                }
                if let Some(v) = f("near") {
                    c.near = v.max(1.0);
                }
                if let Some(v) = f("fade") {
                    c.fade = v.max(1.0);
                }
                if let Some(v) = f("far") {
                    c.far = v.max(c.near + c.fade);
                }
                if let Some(v) = p.get("thin").and_then(Value::as_u64) {
                    c.thin = v.max(1) as u32;
                }
                Ok(state(w))
            },
        );
}
