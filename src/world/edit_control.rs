//! `terrain.*` control commands (feature `devtools`): drive terrain editing from the editor
//! adapter, scripts and tests.
//!
//! | Command | Params | Result |
//! |---|---|---|
//! | `terrain.info` | — | sizes, bounds, height range, splat, undo store, edit counters |
//! | `terrain.brush` | `{x, z, settings?, record?}` | one dab → `{rect_world, blobs?}` (`record`: wrap it in its own undo step) |
//! | `terrain.stroke` | `{points: [[x, z], …], settings?}` | one undoable stroke → `{rect, layer, before, after}` blob ids |
//! | `terrain.stroke_begin` / `terrain.stroke_end` | — | live editing: `terrain.brush` calls in between are one undo step; end returns the blobs |
//! | `terrain.apply_blob` | `{id}` | writes a stored blob back (undo = `before`, redo = `after`) |
//! | `terrain.save` | `{dir}` | writes `terrain.ron`, `terrain.r16`, `terrain_splat.rgba8` |
//!
//! `settings` is a [`BrushSettings`] as JSON; missing fields take their defaults.

use bevy::prelude::*;
use serde_json::{Value, json};

use super::brush::BrushSettings;
use super::edit::{BlobId, StrokeBlobs, TerrainEdit, TerrainLayer, TerrainPatchStore, TerrainSplat, edit_stats};
use super::terrain::Terrain;
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    let at = &[("x", "number", "absolute x (m)"), ("z", "number", "absolute z (m)"), ("settings", "object", "BrushSettings (kind, radius, strength, falloff, target, pick_target, layer, ...)")];
    app.add_control_command("terrain.info", "Terrain size, bounds, splat, undo store and edit counters", params(&[]), info)
        .add_control_command("terrain.brush", "One brush dab at an absolute XZ", params(&[at[0], at[1], at[2], ("record", "boolean", "return before/after blob ids")]), brush)
        .add_control_command("terrain.stroke", "A brush stroke along points: one undo step", params(&[("points", "array", "[[x, z], ...] absolute metres"), at[2]]), stroke)
        .add_control_command("terrain.stroke_begin", "Start a stroke: following terrain.brush calls join it", params(&[]), |w, _| {
            TerrainEdit::begin_stroke(w);
            Ok(json!({"open": true}))
        })
        .add_control_command("terrain.stroke_end", "End the open stroke and return its undo blobs", params(&[]), |w, _| Ok(blobs_json(TerrainEdit::end_stroke(w))))
        .add_control_command("terrain.apply_blob", "Write an undo blob back into the terrain", params(&[("id", "number", "blob id")]), apply_blob)
        .add_control_command("terrain.save", "Write terrain.ron / terrain.r16 / terrain_splat.rgba8 into a directory", params(&[("dir", "string", "directory (relative = under assets)")]), save);
}

fn settings(p: &Value) -> Result<BrushSettings, String> {
    match p.get("settings") {
        None | Some(Value::Null) => Ok(BrushSettings::default()),
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| format!("settings: {e}")),
    }
}

fn num(p: &Value, k: &str) -> Result<f32, String> {
    p.get(k).and_then(Value::as_f64).map(|v| v as f32).ok_or_else(|| format!("`{k}` (number) is required"))
}

fn rect_json(r: Rect) -> Value {
    json!([[r.min.x, r.min.y], [r.max.x, r.max.y]])
}

fn blobs_json(b: Option<StrokeBlobs>) -> Value {
    match b {
        Some(b) => json!({"layer": format!("{:?}", b.layer), "rect": {"x0": b.rect.x0, "z0": b.rect.z0, "w": b.rect.w, "h": b.rect.h}, "before": b.before.0, "after": b.after.0}),
        None => json!({"layer": null, "before": null, "after": null}),
    }
}

fn info(world: &mut World, _: Value) -> Result<Value, String> {
    let t = world.get_resource::<Terrain>().ok_or("no terrain spawned")?;
    let hf = t.heightfield();
    let (lo, hi) = t.bounds();
    let store = world.resource::<TerrainPatchStore>();
    Ok(json!({
        "source_samples": t.source_samples().to_array(),
        "samples": [hf.nx(), hf.nz()],
        "spacing": hf.spacing(),
        "origin": hf.origin().to_array(),
        "bounds": [[lo.x, lo.y], [hi.x, hi.y]],
        "height_range": [hf.min_height(), hf.max_height()],
        "chunk_quads": t.chunk_quads(),
        "chunks": t.chunks().to_array(),
        "splat_resolution": world.get_resource::<TerrainSplat>().map(|s| s.res),
        "undo": {"blobs": store.len(), "bytes": store.bytes(), "cap_bytes": store.max_bytes},
        "stroke_open": TerrainEdit::stroke_open(world),
        "stats": serde_json::to_value(edit_stats(world)).unwrap_or_default(),
    }))
}

fn brush(world: &mut World, p: Value) -> Result<Value, String> {
    let (x, z, s) = (num(&p, "x")?, num(&p, "z")?, settings(&p)?);
    let record = p.get("record").and_then(Value::as_bool).unwrap_or(false) && !TerrainEdit::stroke_open(world);
    if record {
        TerrainEdit::begin_stroke(world);
    }
    let r = TerrainEdit::dab(world, &s, Vec2::new(x, z));
    let blobs = if record { TerrainEdit::end_stroke(world) } else { None };
    let r = r.map_err(|e| e.to_string())?;
    let mut v = json!({"rect_world": r.map(rect_json)});
    if record {
        v["blobs"] = blobs_json(blobs);
    }
    Ok(v)
}

fn stroke(world: &mut World, p: Value) -> Result<Value, String> {
    let s = settings(&p)?;
    let pts = p.get("points").and_then(Value::as_array).ok_or("`points` ([[x, z], …]) is required")?;
    let points: Vec<Vec2> = pts
        .iter()
        .map(|v| match (v.get(0).and_then(Value::as_f64), v.get(1).and_then(Value::as_f64)) {
            (Some(x), Some(z)) => Ok(Vec2::new(x as f32, z as f32)),
            _ => Err("each point is [x, z]".to_string()),
        })
        .collect::<Result<_, _>>()?;
    let b = TerrainEdit::stroke(world, &s, &points).map_err(|e| e.to_string())?;
    Ok(blobs_json(b))
}

fn apply_blob(world: &mut World, p: Value) -> Result<Value, String> {
    let id = p.get("id").and_then(Value::as_u64).ok_or("`id` (number) is required")?;
    let (layer, rect, rw) = TerrainEdit::apply_blob(world, BlobId(id)).map_err(|e| e.to_string())?;
    let layer = match layer {
        TerrainLayer::Height => "Height",
        TerrainLayer::Splat => "Splat",
    };
    Ok(json!({"layer": layer, "rect": {"x0": rect.x0, "z0": rect.z0, "w": rect.w, "h": rect.h}, "rect_world": rect_json(rw)}))
}

fn save(world: &mut World, p: Value) -> Result<Value, String> {
    let dir = p.get("dir").and_then(Value::as_str).ok_or("`dir` (string) is required")?;
    let path = super::edit::resolve_dir(world, std::path::Path::new(dir));
    TerrainEdit::save(world, std::path::Path::new(dir)).map_err(|e| e.to_string())?;
    Ok(json!({"dir": path.display().to_string()}))
}
