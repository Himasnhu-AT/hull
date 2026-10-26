//! `world.*` control commands (feature `devtools`).
//!
//! | Command | Params | Result |
//! |---|---|---|
//! | `world.stats` | — | [`super::WorldStats`] + settings summary |
//! | `world.cells` | `{all?}` | `{cell_size, dims, loaded: [[x,z],…], queued, mode}` (`all`: every cell with its state and prefab count) |
//! | `world.height` | `{x, z}` (absolute) | `{height, normal, slope_deg, cell, loaded, chunk, lod}` |
//! | `world.teleport` | `{x, z, y?, up?}` | moves the main camera (or the `StreamSource` with no radius) there; `{at, cell, ready}` |
//! | `world.settings` | `{mode?, pixel_error?, load_radius?, unload_radius?, scatter?, scatter_scale?, hlod?, hlod_distance?, origin?}` | the current settings |

use bevy::prelude::*;
use serde_json::{Value, json};

use super::cells::{CellState, StreamSource, WorldCells};
use super::terrain::{Terrain, TerrainChunk};
use super::{StreamMode, WorldOrigin, WorldSettings, WorldStats};
use crate::devtools::{AddControlCommand, params};
use crate::gfx::MainCamera;

pub(super) fn register(app: &mut App) {
    app.add_control_command("world.stats", "Large-world counters: terrain LODs, cells, scatter, HLOD, origin", params(&[]), stats)
        .add_control_command("world.cells", "Streaming cells and which are loaded", params(&[("all", "boolean", "every cell with state and prefab count")]), cells)
        .add_control_command(
            "world.height",
            "Terrain height, normal and cell at an absolute XZ",
            params(&[("x", "number", "absolute x (m)"), ("z", "number", "absolute z (m)")]),
            height,
        )
        .add_control_command(
            "world.teleport",
            "Move the camera / player to an absolute XZ on the ground",
            params(&[("x", "number", "absolute x"), ("z", "number", "absolute z"), ("y", "number", "absolute y (default: ground + up)"), ("up", "number", "metres above ground (default 2)")]),
            teleport,
        )
        .add_control_command(
            "world.settings",
            "Read / change world settings",
            params(&[
                ("mode", "string", "resident|streamed"),
                ("pixel_error", "number", "terrain LOD error in pixels"),
                ("load_radius", "number", "cell load radius (m)"),
                ("unload_radius", "number", "cell unload radius (m)"),
                ("scatter", "boolean", "scatter on/off"),
                ("scatter_scale", "number", "scatter distance multiplier"),
                ("hlod", "boolean", "HLOD on/off"),
                ("hlod_distance", "number", "HLOD switch distance (m)"),
                ("origin", "boolean", "floating origin on/off"),
            ]),
            settings,
        );
}

fn num(p: &Value, k: &str) -> Option<f32> {
    p.get(k).and_then(Value::as_f64).map(|v| v as f32)
}

fn stats(world: &mut World, _: Value) -> Result<Value, String> {
    let s = world.resource::<WorldStats>();
    let mut v = serde_json::to_value(s).map_err(|e| e.to_string())?;
    let st = world.resource::<WorldSettings>();
    v["mode"] = json!(format!("{:?}", st.streaming.mode));
    if let Some(t) = world.get_resource::<Terrain>() {
        let (lo, hi) = t.bounds();
        v["terrain_bounds"] = json!([[lo.x, lo.y], [hi.x, hi.y]]);
        v["terrain_heights"] = json!([t.heightfield().min_height(), t.heightfield().max_height()]);
        v["chunk_size"] = json!(t.chunk_size());
    }
    Ok(v)
}

fn cells(world: &mut World, p: Value) -> Result<Value, String> {
    let c = world.get_resource::<WorldCells>().ok_or("no world spawned")?;
    let loaded: Vec<[i32; 2]> = c.loaded().map(|(id, _)| [id.x, id.y]).collect();
    let mut v = json!({
        "cell_size": c.cell_size(),
        "dims": [c.dims().x, c.dims().y],
        "loaded": loaded,
        "queued": c.queued(),
        "mode": format!("{:?}", world.resource::<WorldSettings>().streaming.mode),
    });
    if p.get("all").and_then(Value::as_bool) == Some(true) {
        let mut all = Vec::new();
        for z in 0..c.dims().y {
            for x in 0..c.dims().x {
                let id = IVec2::new(x, z);
                all.push(json!({"cell": [x, z], "loaded": matches!(c.state(id), CellState::Loaded(_)), "prefabs": c.placed(id).len()}));
            }
        }
        v["cells"] = json!(all);
    }
    Ok(v)
}

fn height(world: &mut World, p: Value) -> Result<Value, String> {
    let (x, z) = (num(&p, "x").ok_or("`x` is required")?, num(&p, "z").ok_or("`z` is required")?);
    let t = world.get_resource::<Terrain>().ok_or("no world spawned")?;
    let n = t.normal_at(x, z);
    let chunk = t.chunk_at(x, z);
    let mut v = json!({
        "height": t.height_at(x, z),
        "normal": [n.x, n.y, n.z],
        "slope_deg": t.slope_deg(x, z),
        "inside": t.heightfield().contains(x, z),
        "chunk": [chunk.x, chunk.y],
    });
    if let Some(c) = world.get_resource::<WorldCells>() {
        let id = c.cell_at(Vec2::new(x, z));
        v["cell"] = json!([id.x, id.y]);
        v["loaded"] = json!(c.is_loaded(id));
    }
    let lod = world.query::<&TerrainChunk>().iter(world).find(|c| c.coord == chunk).map(|c| c.lod);
    v["lod"] = json!(lod);
    Ok(v)
}

fn teleport(world: &mut World, p: Value) -> Result<Value, String> {
    let (x, z) = (num(&p, "x").ok_or("`x` is required")?, num(&p, "z").ok_or("`z` is required")?);
    let up = num(&p, "up").unwrap_or(2.0);
    let ground = world.get_resource::<Terrain>().ok_or("no world spawned")?.height_at(x, z);
    let y = num(&p, "y").unwrap_or(ground + up);
    let origin = *world.resource::<WorldOrigin>();
    let local = origin.to_local(Vec3::new(x, y, z));
    // The player-like stream source (no radius override) wins, else the main camera's root.
    let mut target = world.query_filtered::<(Entity, &StreamSource), Without<MainCamera>>().iter(world).find(|(_, s)| s.radius.is_none()).map(|(e, _)| e);
    if target.is_none() {
        let cam = world.query_filtered::<Entity, With<MainCamera>>().iter(world).next().ok_or("no main camera")?;
        let mut e = cam;
        while let Some(parent) = world.get::<ChildOf>(e) {
            e = parent.parent();
        }
        target = Some(e);
    }
    let e = target.ok_or("nothing to move")?;
    let mut tf = world.get_mut::<Transform>(e).ok_or("target has no Transform")?;
    tf.translation = local;
    #[cfg(feature = "physics")]
    if let Some(mut v) = world.get_mut::<avian3d::prelude::LinearVelocity>(e) {
        v.0 = Vec3::ZERO;
    }
    let (cell, ready) = world.get_resource::<WorldCells>().map_or((IVec2::ZERO, true), |c| (c.cell_at(Vec2::new(x, z)), c.ready_around(Vec2::new(x, z), 32.0)));
    Ok(json!({"at": [x, y, z], "ground": ground, "cell": [cell.x, cell.y], "ready": ready}))
}

fn settings(world: &mut World, p: Value) -> Result<Value, String> {
    let mut s = world.resource_mut::<WorldSettings>();
    if let Some(m) = p.get("mode").and_then(Value::as_str) {
        s.streaming.mode = match m {
            "resident" => StreamMode::Resident,
            "streamed" => StreamMode::Streamed,
            _ => return Err(format!("unknown mode {m}")),
        };
    }
    if let Some(v) = num(&p, "pixel_error") {
        s.terrain.pixel_error = v.max(0.05);
    }
    if let Some(v) = num(&p, "load_radius") {
        s.streaming.load_radius = v.max(0.0);
    }
    if let Some(v) = num(&p, "unload_radius") {
        s.streaming.unload_radius = v.max(s.streaming.load_radius);
    }
    if let Some(v) = p.get("scatter").and_then(Value::as_bool) {
        s.scatter.enabled = v;
    }
    if let Some(v) = num(&p, "scatter_scale") {
        s.scatter.distance_scale = v.max(0.0);
    }
    if let Some(v) = p.get("hlod").and_then(Value::as_bool) {
        s.hlod.enabled = v;
    }
    if let Some(v) = num(&p, "hlod_distance") {
        s.hlod.distance = v.max(0.0);
    }
    if let Some(v) = p.get("origin").and_then(Value::as_bool) {
        s.origin.enabled = v;
    }
    Ok(json!({
        "mode": format!("{:?}", s.streaming.mode),
        "pixel_error": s.terrain.pixel_error,
        "load_radius": s.streaming.load_radius,
        "unload_radius": s.streaming.unload_radius,
        "scatter": s.scatter.enabled,
        "scatter_scale": s.scatter.distance_scale,
        "hlod": s.hlod.enabled,
        "hlod_distance": s.hlod.distance,
        "origin": s.origin.enabled,
    }))
}
