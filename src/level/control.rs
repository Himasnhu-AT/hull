//! `level.*` control commands (feature `devtools`).
//!
//! | Command | Params | Result |
//! |---|---|---|
//! | `level.info` | — | [`super::LevelInfo`]: path, entities, version, dirty, world, look |
//! | `level.save` | `{path?}` (default: the open level) | `{path, entities, skipped}` |
//! | `level.load` | `{path}` | `{path, entities}` |

use bevy::prelude::*;
use serde_json::{Value, json};

use super::{LevelState, level_info, load_level, save_level};
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    app.add_control_command("level.info", "Open level: path, entity count, version, dirty", params(&[]), info)
        .add_control_command("level.save", "Save the level (atomic, keeps .bak)", params(&[("path", "string", "file (default: the open level)")]), save)
        .add_control_command("level.load", "Load a level file, replacing the current one", params(&[("path", "string", "level file")]), load);
}

fn info(world: &mut World, _: Value) -> Result<Value, String> {
    serde_json::to_value(level_info(world)).map_err(|e| e.to_string())
}

fn save(world: &mut World, p: Value) -> Result<Value, String> {
    let path = match p.get("path").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => world
            .resource::<LevelState>()
            .path
            .as_ref()
            .map(|p| p.display().to_string())
            .ok_or("no level is open: pass `path`")?,
    };
    let r = save_level(world, &path).map_err(|e| e.to_string())?;
    Ok(json!({"path": path, "entities": r.entities, "skipped": r.skipped}))
}

fn load(world: &mut World, p: Value) -> Result<Value, String> {
    let path = p.get("path").and_then(Value::as_str).ok_or("`path` is required")?;
    let n = load_level(world, path).map_err(|e| e.to_string())?;
    Ok(json!({"path": path, "entities": n}))
}
