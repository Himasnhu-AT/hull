//! `editor.*` control commands: the [`EditorBackend`](editor_proto::EditorBackend) over the
//! control port, so scripts (`scripts/play.py`) and agents drive the editor like the UI does.
//! Params and results are the `editor-proto` types as JSON.
//!
//! | Command | Params | Result |
//! |---|---|---|
//! | `editor.state` | none | play state, level, selection, tool, snap, camera, undo depth, viewport |
//! | `editor.tree` | `{text?, include_generated?, include_hidden?}` | `[TreeNode]` |
//! | `editor.components` | entity (`id` bits, `stable`, or `name`) | `[ComponentDoc]` |
//! | `editor.component_types` | none | `[[type_path, TypeSchema]]` |
//! | `editor.apply` | `{op, undoable?}` (`Op` JSON; goes on the UI's undo stack unless `undoable:false`) | `{ok}` |
//! | `editor.snapshot` | entity | `EntitySnapshot` |
//! | `editor.select` | `{ids?, stable?, names?}` (lists) | `{selection}` |
//! | `editor.assets` | `{dir?}` | `[AssetEntry]` |
//! | `editor.place` | `{path, position?, parent?}` | the `Spawn` op (recorded for undo) |
//! | `editor.save` / `editor.open` | `{path?}` / `{path}` | `{ok}` |
//! | `editor.play` / `editor.stop` | none | `{state}` |
//! | `editor.diagnostics` | `{since?}` | `{cursor, items}` |
//! | `editor.viewport` | `ViewportCmd` JSON | `{ok}` |
//! | `editor.camera` | `{pos?, look_at?, speed?}` | the camera pose |
//! | `editor.command` | `{id}` (a UI command: `editor.undo`, `editor.redo`, `editor.save`, ...) | `{ok}` |
//! | `editor.ui_layout` | `{tab}` (Outliner, Details, Content, Output, Logic) | `{ok}` |

use bevy::prelude::*;
use editor_proto::*;
use serde_json::{Value, json};

use super::backend::{WorldBackend, by_stable};
use super::camera::EditorCamera;
use super::host::{EditorUiRes, run_command};
use super::EditorState;
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    let ent = [("id", "integer", "entity id (bits)"), ("stable", "integer", "stable id"), ("name", "string", "entity name")];
    app.add_control_command("editor.state", "Editor state: play, level, selection, tool, camera", params(&[]), state)
        .add_control_command(
            "editor.tree",
            "Outliner tree",
            params(&[("text", "string", "name filter"), ("include_generated", "boolean", ""), ("include_hidden", "boolean", "")]),
            tree,
        )
        .add_control_command("editor.components", "Components of an entity (reflect JSON + schema)", params(&ent), components)
        .add_control_command("editor.component_types", "Component types that can be added", params(&[]), component_types)
        .add_control_command(
            "editor.apply",
            "Apply an Op (SetComponent, Spawn, Despawn, Reparent, Rename, Batch); recorded for undo",
            params(&[("op", "object", "editor-proto Op as JSON"), ("undoable", "boolean", "default true")]),
            apply,
        )
        .add_control_command("editor.snapshot", "Entity snapshot (components + children)", params(&ent), snapshot)
        .add_control_command(
            "editor.select",
            "Set the selection",
            params(&[("ids", "array", "entity ids"), ("stable", "array", "stable ids"), ("names", "array", "entity names")]),
            select,
        )
        .add_control_command("editor.assets", "List assets in a folder", params(&[("dir", "string", "folder under the assets root")]), assets)
        .add_control_command(
            "editor.place",
            "Place a model from the assets folder",
            params(&[("path", "string", "asset path"), ("position", "array", "[x,y,z]; omit for the viewport centre"), ("screen", "array", "[u,v] 0..1 of the viewport: place at the ray hit (a drop)")]),
            place,
        )
        .add_control_command(
            "editor.content",
            "Content Browser view: folder, grid or list, type filter, search",
            params(&[("dir", "string", "folder under the assets root"), ("view", "string", "grid | list"), ("kinds", "array", "AssetKind names, e.g. [\"Audio\"]; empty = all"), ("search", "string", "name filter"), ("select", "string", "path of the tile to select")]),
            content,
        )
        .add_control_command("editor.convert", "Make a generated entity a level entity (undoable)", params(&[("id", "integer", "session entity id")]), convert)
        .add_control_command("editor.save", "Save the level", params(&[("path", "string", "default: the open level")]), save)
        .add_control_command("editor.open", "Open a level", params(&[("path", "string", "level file")]), open)
        .add_control_command("editor.play", "Save, build and run the game", params(&[]), play)
        .add_control_command("editor.stop", "Stop the running game", params(&[]), stop)
        .add_control_command("editor.diagnostics", "Output panel lines after a cursor", params(&[("since", "integer", "cursor from the last call")]), diagnostics)
        .add_control_command("editor.viewport", "ViewportCmd: FocusSelection | {SetTool: Move} | {SetSnap: {enabled, step}}", params(&[]), viewport)
        .add_control_command(
            "editor.camera",
            "Set the viewport camera",
            params(&[("pos", "array", "[x,y,z]"), ("look_at", "array", "[x,y,z]"), ("speed", "number", "fly speed")]),
            camera,
        )
        .add_control_command("editor.command", "Run a UI command by id (editor.undo, editor.redo, editor.tool_move, ...)", params(&[("id", "string", "command id")]), command)
        .add_control_command(
            "editor.camera_drive",
            "Move the camera as the keys / mouse would: `wish` [x right, y up, z back] for `seconds`, `yaw` / `pitch` change in radians",
            params(&[("wish", "array", "camera-local direction"), ("seconds", "number", "how long"), ("yaw", "number", "radians"), ("pitch", "number", "radians")]),
            camera_drive,
        )
        .add_control_command("editor.tools", "The world tools with their settings and schemas", params(&[]), tools_list)
        .add_control_command(
            "editor.tool",
            "Activate a tool (`id` spline|sculpt|paint|foliage|place, or omit / null for the gizmo tools) and merge `settings` into its settings",
            params(&[("id", "string", "tool id"), ("settings", "object", "settings to set (missing fields keep their value)")]),
            tool,
        )
        .add_control_command(
            "editor.tool_action",
            "Do what a pointer would with the active tool: sculpt/paint `stroke {points:[[x,z]], shift?}`; spline `select|add|move|delete|set`; foliage `pick|delete|move|area|place`; place `place {at}`",
            params(&[("action", "string", "action name"), ("points", "array", ""), ("at", "array", "[x,z]")]),
            tool_action,
        )
        .add_control_command("editor.tab", "Bring a panel tab to the front", params(&[("tab", "string", "Outliner|Details|Content|Output|Logic")]), tab);
}

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| e.to_string())
}

fn to_value<T: serde::Serialize>(v: &T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// `id` (bits), `stable` or `name`.
pub(super) fn entity_param(world: &mut World, p: &Value) -> Result<Entity, String> {
    if let Some(bits) = p.get("id").and_then(Value::as_u64) {
        return super::backend::resolve(world, StableOrId::Id(bits));
    }
    if let Some(s) = p.get("stable").and_then(Value::as_u64) {
        return by_stable(world, StableId(s)).ok_or_else(|| format!("no entity with stable id {s}"));
    }
    if let Some(n) = p.get("name").and_then(Value::as_str) {
        return named(world, n);
    }
    Err("pass `id`, `stable` or `name`".into())
}

fn named(world: &mut World, n: &str) -> Result<Entity, String> {
    world.query::<(Entity, &Name)>().iter(world).find(|(_, nm)| nm.as_str() == n).map(|(e, _)| e).ok_or_else(|| format!("no entity named `{n}`"))
}

fn state(world: &mut World, _: Value) -> Result<Value, String> {
    let mut be = WorldBackend::new(world);
    let level = be.level();
    let play = be.play_state();
    let sel = be.selection();
    let st = be.world.resource::<EditorState>();
    let (tool, snap, step, vp, ppp) = (st.tool, st.snap, st.snap_step, st.ui.viewport, st.ui.pixels_per_point);
    let cam = be.world.resource::<EditorCamera>();
    let camera = json!({"pos": cam.pos.to_array(), "yaw": cam.yaw, "pitch": cam.pitch, "speed": cam.speed, "forward": cam.forward().to_array()});
    let cam_entity = be.world.resource::<EditorCamera>().entity;
    let view = cam_entity.and_then(|e| be.world.get::<Camera>(e)).map(|c| {
        json!({"target": c.physical_target_size().map(|t| t.to_array()), "active": c.is_active})
    });
    let undo = be.world.get_resource::<EditorUiRes>().map(|u| json!({"can_undo": u.0.can_undo(), "can_redo": u.0.can_redo(), "depth": u.0.undo_depth()}));
    Ok(json!({"play": play, "level": level, "selection": sel, "tool": tool, "snap": snap, "snap_step": step, "viewport": vp, "pixels_per_point": ppp, "camera": camera, "camera_view": view, "undo": undo}))
}

fn tree(world: &mut World, p: Value) -> Result<Value, String> {
    let f = TreeFilter {
        text: p.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
        include_generated: p.get("include_generated").and_then(Value::as_bool).unwrap_or(true),
        include_hidden: p.get("include_hidden").and_then(Value::as_bool).unwrap_or(true),
    };
    to_value(&WorldBackend::new(world).tree(&f))
}

fn components(world: &mut World, p: Value) -> Result<Value, String> {
    let e = entity_param(world, &p)?;
    to_value(&WorldBackend::new(world).components(e.to_bits())?)
}

fn component_types(world: &mut World, _: Value) -> Result<Value, String> {
    to_value(&WorldBackend::new(world).component_types())
}

fn label_of(op: &Op) -> &'static str {
    match op {
        Op::SetComponent { .. } => "Edit",
        Op::Spawn { .. } => "Add",
        Op::Despawn { .. } => "Delete",
        Op::Reparent { .. } => "Reparent",
        Op::Rename { .. } => "Rename",
        Op::TerrainPatch { .. } => "Terrain",
        Op::Batch(_) => "Edit",
    }
}

fn apply(world: &mut World, p: Value) -> Result<Value, String> {
    let op: Op = parse(p.get("op").cloned().ok_or("`op` is required")?)?;
    WorldBackend::new(world).apply(&op)?;
    if p.get("undoable").and_then(Value::as_bool).unwrap_or(true)
        && let Some(mut ui) = world.get_resource_mut::<EditorUiRes>()
    {
        ui.0.record_applied(label_of(&op), op, None);
        ui.0.seal_undo();
    }
    Ok(json!({"ok": true}))
}

fn snapshot(world: &mut World, p: Value) -> Result<Value, String> {
    let e = entity_param(world, &p)?;
    to_value(&WorldBackend::new(world).snapshot(e.to_bits())?)
}

fn select(world: &mut World, p: Value) -> Result<Value, String> {
    let mut ids: Vec<EntityId> = Vec::new();
    if let Some(a) = p.get("ids").and_then(Value::as_array) {
        ids.extend(a.iter().filter_map(Value::as_u64));
    }
    if let Some(a) = p.get("stable").and_then(Value::as_array) {
        for s in a.iter().filter_map(Value::as_u64) {
            ids.push(by_stable(world, StableId(s)).ok_or_else(|| format!("no entity with stable id {s}"))?.to_bits());
        }
    }
    if let Some(a) = p.get("names").and_then(Value::as_array) {
        for n in a.iter().filter_map(Value::as_str) {
            ids.push(named(world, n)?.to_bits());
        }
    }
    let mut be = WorldBackend::new(world);
    be.set_selection(&ids);
    to_value(&json!({"selection": be.selection()}))
}

fn assets(world: &mut World, p: Value) -> Result<Value, String> {
    let dir = p.get("dir").and_then(Value::as_str).unwrap_or("");
    to_value(&WorldBackend::new(world).assets(dir))
}

fn place(world: &mut World, p: Value) -> Result<Value, String> {
    let path = p.get("path").and_then(Value::as_str).ok_or("`path` is required")?.to_string();
    let position = p.get("position").and_then(Value::as_array).map(|a| {
        let f = |i: usize| a.get(i).and_then(Value::as_f64).unwrap_or(0.0) as f32;
        [f(0), f(1), f(2)]
    });
    let parent = p.get("parent").and_then(Value::as_u64).map(StableId);
    let screen = p.get("screen").and_then(Value::as_array).and_then(|a| Some([a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32]));
    let op = WorldBackend::new(world).place_asset(&path, Placement { position: position.unwrap_or([0.0; 3]), parent, screen })?;
    if let Some(mut ui) = world.get_resource_mut::<EditorUiRes>() {
        ui.0.record_applied("Place", op.clone(), None);
        ui.0.seal_undo();
    }
    to_value(&op)
}

fn convert(world: &mut World, p: Value) -> Result<Value, String> {
    let id = p.get("id").and_then(Value::as_u64).ok_or("`id` is required")?;
    let op = WorldBackend::new(world).convert_to_level(id)?;
    if let Some(mut ui) = world.get_resource_mut::<EditorUiRes>() {
        ui.0.record_applied("Convert to level entity", op.clone(), None);
        ui.0.seal_undo();
    }
    to_value(&op)
}

fn save(world: &mut World, p: Value) -> Result<Value, String> {
    WorldBackend::new(world).save_level(p.get("path").and_then(Value::as_str))?;
    Ok(json!({"ok": true, "level": WorldBackend::new(world).level()}))
}

fn open(world: &mut World, p: Value) -> Result<Value, String> {
    let path = p.get("path").and_then(Value::as_str).ok_or("`path` is required")?;
    WorldBackend::new(world).open_level(path)?;
    if let Some(mut ui) = world.get_resource_mut::<EditorUiRes>() {
        ui.0.refresh();
    }
    Ok(json!({"ok": true, "level": WorldBackend::new(world).level()}))
}

fn play(world: &mut World, _: Value) -> Result<Value, String> {
    let mut be = WorldBackend::new(world);
    be.play()?;
    Ok(json!({"state": be.play_state()}))
}

fn stop(world: &mut World, _: Value) -> Result<Value, String> {
    let mut be = WorldBackend::new(world);
    be.stop();
    Ok(json!({"state": be.play_state()}))
}

fn diagnostics(world: &mut World, p: Value) -> Result<Value, String> {
    let since = p.get("since").and_then(Value::as_u64).unwrap_or(0);
    let (cursor, items) = WorldBackend::new(world).diagnostics(since);
    Ok(json!({"cursor": cursor, "items": items}))
}

fn viewport(world: &mut World, p: Value) -> Result<Value, String> {
    let cmd: ViewportCmd = parse(p)?;
    // The toolbar owns the tool: go through its command so the UI and the gizmo agree.
    if let ViewportCmd::SetTool(t) = cmd {
        let id = match t {
            Tool::Select => "editor.tool_select",
            Tool::Move => "editor.tool_move",
            Tool::Rotate => "editor.tool_rotate",
            Tool::Scale => "editor.tool_scale",
        };
        if let Some(c) = editor_ui::Command::from_id(id) {
            run_command(world, c);
        }
        return Ok(json!({"ok": true}));
    }
    WorldBackend::new(world).viewport(cmd);
    Ok(json!({"ok": true}))
}

fn vec3(v: &Value) -> Option<Vec3> {
    let a = v.as_array()?;
    Some(Vec3::new(a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32))
}

fn camera(world: &mut World, p: Value) -> Result<Value, String> {
    let mut cam = world.resource_mut::<EditorCamera>();
    let pos = p.get("pos").and_then(vec3);
    let look = p.get("look_at").and_then(vec3);
    if let Some(pos) = pos {
        cam.pos = pos;
    }
    if let Some(l) = look {
        let from = cam.pos;
        cam.look_at(from, l);
        cam.pivot = l;
    }
    if let Some(s) = p.get("speed").and_then(Value::as_f64) {
        cam.speed = (s as f32).clamp(0.2, 400.0);
    }
    Ok(json!({"pos": cam.pos.to_array(), "yaw": cam.yaw, "pitch": cam.pitch}))
}

fn command(world: &mut World, p: Value) -> Result<Value, String> {
    let id = p.get("id").and_then(Value::as_str).ok_or("`id` is required")?;
    let cmd = editor_ui::Command::from_id(id).ok_or_else(|| format!("unknown UI command `{id}`"))?;
    run_command(world, cmd);
    Ok(json!({"ok": true}))
}

fn tab(world: &mut World, p: Value) -> Result<Value, String> {
    let name = p.get("tab").and_then(Value::as_str).ok_or("`tab` is required")?;
    let mut ui = world.get_resource_mut::<EditorUiRes>().ok_or("the editor UI is not up yet")?;
    ui.0.show_panel(name)?;
    Ok(json!({"ok": true}))
}

fn content(world: &mut World, p: Value) -> Result<Value, String> {
    let dir = p.get("dir").and_then(Value::as_str).unwrap_or("");
    let list = p.get("view").and_then(Value::as_str).map(|v| v == "list");
    let kinds: Vec<AssetKind> = match p.get("kinds") {
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| format!("`kinds`: {e}"))?,
        None => Vec::new(),
    };
    let search = p.get("search").and_then(Value::as_str).unwrap_or("");
    let mut ui = world.get_resource_mut::<EditorUiRes>().ok_or("the editor UI is not up yet")?;
    ui.0.content_show(dir, list, &kinds, search, p.get("select").and_then(Value::as_str));
    Ok(json!({"ok": true}))
}

fn tools_list(world: &mut World, _: Value) -> Result<Value, String> {
    let active = WorldBackend::new(world).active_tool();
    Ok(json!({"active": active, "tools": to_value(&super::tools::docs(world))?}))
}

fn tool(world: &mut World, p: Value) -> Result<Value, String> {
    let id = p.get("id").and_then(Value::as_str).map(str::to_owned);
    if let Some(i) = &id
        && let Some(s) = p.get("settings")
    {
        // Merge into the current settings so a script sets only what it names.
        let ts = world.resource::<super::tools::ToolState>();
        let mut cur = super::tools::settings_of(world, ts, i).map(|(v, _)| v).ok_or_else(|| format!("no tool `{i}`"))?;
        crate::devkit::reflect_json::merge_patch(&mut cur, s);
        super::tools::apply_settings(world, i, cur)?;
    }
    super::tools::activate(world, id.as_deref())?;
    // The toolbar follows the backend; show the Tool tab like a click would.
    if id.is_some()
        && let Some(mut ui) = world.get_resource_mut::<EditorUiRes>()
    {
        let _ = ui.0.show_panel("Tool");
    }
    Ok(json!({"active": id}))
}

fn tool_action(world: &mut World, p: Value) -> Result<Value, String> {
    super::tools::action(world, &p)
}

fn camera_drive(world: &mut World, p: Value) -> Result<Value, String> {
    let mut cam = world.resource_mut::<EditorCamera>();
    if let Some(w) = p.get("wish").and_then(vec3) {
        let secs = p.get("seconds").and_then(Value::as_f64).unwrap_or(0.5) as f32;
        cam.script = Some((w, secs.clamp(0.0, 10.0)));
    }
    cam.yaw += p.get("yaw").and_then(Value::as_f64).unwrap_or(0.0) as f32;
    cam.pitch += p.get("pitch").and_then(Value::as_f64).unwrap_or(0.0) as f32;
    Ok(json!({"pos": cam.pos.to_array(), "yaw": cam.yaw, "pitch": cam.pitch}))
}
