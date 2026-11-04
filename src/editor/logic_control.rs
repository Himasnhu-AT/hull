//! `editor.logic.*` control commands: the Logic editor's backend over the control port, so
//! scripts and agents build and test graphs like the tab does.
//!
//! | Command | Params | Result |
//! |---|---|---|
//! | `editor.logic.list` | none | `[LogicFile]` (graphs and scripts, with their errors) |
//! | `editor.logic.read` | `{path}` | `{ron}` (graph or script text) |
//! | `editor.logic.validate` | `{ron}` | `{errors:[GraphErrorDoc]}` |
//! | `editor.logic.write` | `{path, ron}` (`text` for scripts) | `{errors}`; the file is written even when it has errors, unless the RON does not parse |
//! | `editor.logic.create` | `{name, template?: empty\|basic, open?: true}` | `{path}` |
//! | `editor.logic.open` | `{path}` | `{ok}`: opens the tab |
//! | `editor.logic.attach` | `{path, id\|stable\|name}` | the `SetComponent` op (undoable) |
//! | `editor.logic.users` | `{path}` | entity ids using the graph |
//! | `editor.logic.palette` | none | `LogicPalette` |
//! | `editor.logic.fire` | `{event, id\|stable\|name}` | `LogicTrace {nodes, log}` |

use bevy::prelude::*;
use editor_proto::*;
use serde_json::{Value, json};

use super::backend::WorldBackend;
use super::control::entity_param;
use super::host::EditorUiRes;
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    let ent = [("id", "integer", "entity id (bits)"), ("stable", "integer", "stable id"), ("name", "string", "entity name")];
    let with = |extra: &[(&'static str, &'static str, &'static str)]| {
        let mut v = ent.to_vec();
        v.extend_from_slice(extra);
        v
    };
    app.add_control_command("editor.logic.list", "Logic graphs and ruspy scripts with their errors", params(&[]), list)
        .add_control_command("editor.logic.read", "Text of a .logic.ron or .ruspy file", params(&[("path", "string", "asset path")]), read)
        .add_control_command("editor.logic.validate", "Check graph RON without writing it", params(&[("ron", "string", "graph text")]), validate)
        .add_control_command(
            "editor.logic.write",
            "Write a graph (or script) file; returns its errors",
            params(&[("path", "string", "asset path"), ("ron", "string", "file text")]),
            write,
        )
        .add_control_command(
            "editor.logic.create",
            "Create logic/<name>.logic.ron and open its tab",
            params(&[("name", "string", "graph name"), ("template", "string", "empty | basic"), ("open", "boolean", "open the tab (default true)")]),
            create,
        )
        .add_control_command("editor.logic.open", "Open a graph or script tab", params(&[("path", "string", "asset path")]), open)
        .add_control_command("editor.logic.attach", "Attach a graph to an entity (a Logic component, undoable)", params(&with(&[("path", "string", "graph path")])), attach)
        .add_control_command("editor.logic.users", "Entities using a graph", params(&[("path", "string", "graph path")]), users)
        .add_control_command("editor.logic.palette", "Node catalogue: kinds with pins and docs, commands, script functions", params(&[]), palette)
        .add_control_command(
            "editor.logic.fire",
            "Fire an event on an entity's graph and return the nodes that ran",
            params(&with(&[("event", "string", "start | tick | overlap_enter | action:<name> | message:<name> | timer:<node id>")])),
            fire,
        );
}

fn to_value<T: serde::Serialize>(v: &T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn path_param(p: &Value) -> Result<&str, String> {
    p.get("path").and_then(Value::as_str).ok_or_else(|| "`path` is required".to_string())
}

fn list(world: &mut World, _: Value) -> Result<Value, String> {
    to_value(&WorldBackend::new(world).logic_list())
}

fn read(world: &mut World, p: Value) -> Result<Value, String> {
    Ok(json!({"ron": WorldBackend::new(world).logic_read(path_param(&p)?)?}))
}

fn validate(world: &mut World, p: Value) -> Result<Value, String> {
    let ron = p.get("ron").and_then(Value::as_str).ok_or("`ron` is required")?;
    Ok(json!({"errors": to_value(&WorldBackend::new(world).logic_validate(ron))?}))
}

fn write(world: &mut World, p: Value) -> Result<Value, String> {
    let text = p.get("ron").or_else(|| p.get("text")).and_then(Value::as_str).ok_or("`ron` is required")?;
    let errors = WorldBackend::new(world).logic_write(path_param(&p)?, text)?;
    Ok(json!({"errors": to_value(&errors)?}))
}

fn open_tab(world: &mut World, path: &str) -> Result<(), String> {
    let mut ui = world.get_resource_mut::<EditorUiRes>().ok_or("the editor UI is not up yet")?;
    ui.0.open_logic_tab(path);
    Ok(())
}

fn create(world: &mut World, p: Value) -> Result<Value, String> {
    let name = p.get("name").and_then(Value::as_str).ok_or("`name` is required")?;
    let template = p.get("template").and_then(Value::as_str).unwrap_or("empty");
    let path = WorldBackend::new(world).logic_create(name, template)?;
    if p.get("open").and_then(Value::as_bool).unwrap_or(true) {
        open_tab(world, &path)?;
    }
    Ok(json!({"path": path}))
}

fn open(world: &mut World, p: Value) -> Result<Value, String> {
    open_tab(world, path_param(&p)?)?;
    Ok(json!({"ok": true}))
}

fn attach(world: &mut World, p: Value) -> Result<Value, String> {
    let e = entity_param(world, &p)?;
    let op = WorldBackend::new(world).logic_attach(e.to_bits(), path_param(&p)?)?;
    if let Some(mut ui) = world.get_resource_mut::<EditorUiRes>() {
        ui.0.record_applied("Attach logic", op.clone(), None);
        ui.0.seal_undo();
    }
    to_value(&op)
}

fn users(world: &mut World, p: Value) -> Result<Value, String> {
    Ok(json!({"entities": WorldBackend::new(world).logic_users(path_param(&p)?)}))
}

fn palette(world: &mut World, _: Value) -> Result<Value, String> {
    to_value(&WorldBackend::new(world).logic_palette())
}

fn fire(world: &mut World, p: Value) -> Result<Value, String> {
    let e = entity_param(world, &p)?;
    let event = p.get("event").and_then(Value::as_str).ok_or("`event` is required")?;
    let trace = WorldBackend::new(world).logic_fire(e.to_bits(), event)?;
    // The open graph tab pulses the path, as if its Fire button had been pressed.
    if let Some(mut ui) = world.get_resource_mut::<EditorUiRes>() {
        ui.0.show_logic_trace(trace.clone());
    }
    to_value(&trace)
}
