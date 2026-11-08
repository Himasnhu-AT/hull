//! Control commands: `script.list`, `script.vars`, `script.set_var`, `script.call`,
//! `script.emit`, `script.connections`, `script.reload`, `script.stats`.

use bevy::prelude::*;
use logic_core::Value;
use serde_json::{Value as Json, json};

use super::*;
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    app.add_control_command("script.list", "Entities with a node script: path, name, hooks, ready, signals", params(&[]), list)
        .add_control_command("script.vars", "Member variables of an entity's script", params(&[("entity", "string", "entity id or name")]), vars)
        .add_control_command(
            "script.set_var",
            "Set a member variable of an entity's script",
            params(&[("entity", "string", "entity id or name"), ("name", "string", "member"), ("value", "any", "new value")]),
            set_var,
        )
        .add_control_command(
            "script.call",
            "Call a function of an entity's script now",
            params(&[("entity", "string", "entity id or name"), ("method", "string", "function"), ("args", "array", "arguments")]),
            call_cmd,
        )
        .add_control_command(
            "script.emit",
            "Emit a signal from an entity",
            params(&[("entity", "string", "entity id or name"), ("signal", "string", "signal name"), ("args", "array", "arguments")]),
            emit,
        )
        .add_control_command("script.reload", "Reload every node script from disk (members are kept)", params(&[]), reload)
        .add_control_command("script.stats", "Script call counts and timing", params(&[]), stats);
}

/// `"12v0"`, bits, or a `Name`.
pub(crate) fn entity_param(world: &World, p: &Json) -> Result<Entity, String> {
    let v = p.get("entity").ok_or("missing `entity`")?;
    if let Some(n) = v.as_u64() {
        return Entity::try_from_bits(n).ok_or_else(|| format!("bad entity {n}"));
    }
    let s = v.as_str().ok_or("`entity` must be a string or number")?;
    if let Ok(n) = s.parse::<u64>() {
        return Entity::try_from_bits(n).ok_or_else(|| format!("bad entity {n}"));
    }
    if let Some((i, g)) = s.split_once('v')
        && let (Ok(i), Ok(g)) = (i.parse::<u32>(), g.parse::<u32>())
    {
        for e in world.iter_entities() {
            if e.id().index().index() == i && e.id().generation().to_bits() == g {
                return Ok(e.id());
            }
        }
    }
    tree::find_named(world, s).ok_or_else(|| format!("no entity `{s}`"))
}

fn args_of(p: &Json) -> Vec<Value> {
    p.get("args").and_then(|a| a.as_array()).map(|a| a.iter().map(Value::from_json).collect()).unwrap_or_default()
}

fn list(world: &mut World, _: Json) -> Result<Json, String> {
    let rt = world.non_send::<ScriptRuntime>();
    let mut items: Vec<(u64, Json)> = rt
        .instances
        .iter()
        .filter_map(|(e, i)| {
            let i = i.try_borrow().ok()?;
            Some((
                i.seq,
                json!({
                    "entity": e.to_string(), "bits": e.to_bits(), "name": tree::name_of(world, *e),
                    "script": i.key, "ready": i.ready, "priority": i.priority, "signals": i.signals,
                    "hooks": {"ready": i.hooks.ready, "process": i.hooks.process, "physics_process": i.hooks.physics,
                              "input": i.hooks.input, "unhandled_input": i.hooks.unhandled, "exit_tree": i.hooks.exit},
                }),
            ))
        })
        .collect();
    items.sort_by_key(|(s, _)| *s);
    let failed: Vec<Json> = rt.failed.iter().map(|(e, k)| json!({"entity": e.to_string(), "script": k})).collect();
    Ok(json!({"scripts": items.into_iter().map(|(_, j)| j).collect::<Vec<_>>(), "failed": failed}))
}

fn vars(world: &mut World, p: Json) -> Result<Json, String> {
    let e = entity_param(world, &p)?;
    let m: serde_json::Map<String, Json> = members(world, e).into_iter().map(|(k, v)| (k, v.to_json())).collect();
    Ok(Json::Object(m))
}

fn set_var(world: &mut World, p: Json) -> Result<Json, String> {
    let e = entity_param(world, &p)?;
    let name = p.get("name").and_then(|n| n.as_str()).ok_or("missing `name`")?;
    let v = Value::from_json(p.get("value").unwrap_or(&Json::Null));
    set_member(world, e, name, &v)?;
    Ok(json!({"ok": true}))
}

fn call_cmd(world: &mut World, p: Json) -> Result<Json, String> {
    let e = entity_param(world, &p)?;
    let m = p.get("method").and_then(|n| n.as_str()).ok_or("missing `method`")?;
    let r = call(world, e, m, &args_of(&p))?;
    Ok(json!({"result": r.to_json()}))
}

fn emit(world: &mut World, p: Json) -> Result<Json, String> {
    let e = entity_param(world, &p)?;
    let s = p.get("signal").and_then(|n| n.as_str()).ok_or("missing `signal`")?;
    let n = emit_signal(world, e, s, &args_of(&p));
    Ok(json!({"fired": n}))
}

fn reload(world: &mut World, _: Json) -> Result<Json, String> {
    Ok(json!({"instances": reload_all(world)}))
}

fn stats(world: &mut World, _: Json) -> Result<Json, String> {
    let s = world.resource::<ScriptStats>().clone();
    Ok(json!({"calls": s.calls, "call_us": s.call_us, "last_frame_us": s.last_frame_us, "max_frame_us": s.max_frame_us,
              "instances": s.instances, "signals": s.signals, "reloads": s.reloads}))
}
