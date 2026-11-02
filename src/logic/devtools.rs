//! Control commands: `logic.list`, `logic.fire`, `logic.diagnostics`, `logic.reload`.

use bevy::prelude::*;
use serde_json::{Value as Json, json};

use super::*;
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    app.add_control_command("logic.list", "Entities with a Logic graph: graph, load state, event nodes", params(&[]), list)
        .add_control_command(
            "logic.fire",
            "Run an event on an entity's graph now",
            params(&[
                ("entity", "string", "entity id (\"12v0\" or bits)"),
                ("event", "string", "start | tick | overlap_enter | overlap_exit | action:<name> | message:<name> | timer:<node id>"),
                ("other", "string", "other entity for overlap events"),
                ("value", "any", "value for action/message events"),
                ("dt", "number", "dt for tick (default 1/60)"),
            ]),
            fire,
        )
        .add_control_command("logic.diagnostics", "Graph and script errors (file, line, col, node) and script log()", params(&[("clear", "boolean", "forget the errors after reading")]), diagnostics)
        .add_control_command("logic.reload", "Reload every logic graph and script from disk", params(&[]), reload);
}

fn list(world: &mut World, _: Json) -> Result<Json, String> {
    let mut q = world.query::<(Entity, &Logic, Option<&LogicState>, Option<&Name>)>();
    let items: Vec<Json> = q
        .iter(world)
        .map(|(e, l, st, name)| {
            let g = st.and_then(|s| s.graph.as_ref());
            json!({
                "entity": e.to_string(),
                "bits": e.to_bits(),
                "name": name.map(|n| n.as_str()),
                "graph": l.graph,
                "loaded": g.is_some(),
                "nodes": g.map(|g| g.nodes.len()),
                "events": g.map(|g| g.events.iter().map(|(t, n)| json!({"trigger": format!("{t:?}"), "node": g.nodes[*n as usize].id})).collect::<Vec<_>>()),
                "started": st.is_some_and(|s| s.started),
            })
        })
        .collect();
    let stats = world.resource::<LogicStats>().clone();
    Ok(json!({
        "entities": items,
        "stats": {"events": stats.events, "total_us": stats.total_us, "last_us": stats.last_us, "max_us": stats.max_us,
                  "script_calls": stats.script_calls, "script_us": stats.script_us},
    }))
}

fn fire(world: &mut World, p: Json) -> Result<Json, String> {
    let entity = parse_entity(p.get("entity").ok_or("`entity` is required")?)?;
    let ev = p.get("event").and_then(Json::as_str).ok_or("`event` is required")?;
    let other = || -> Result<Entity, String> {
        parse_entity(p.get("other").ok_or("`other` is required for overlap events")?)
    };
    let value = p.get("value").map(Value::from_json).unwrap_or(Value::Null);
    let (head, arg) = ev.split_once(':').unwrap_or((ev, ""));
    let kind = match head {
        "start" => EventKind::Start,
        "tick" => EventKind::Tick(p.get("dt").and_then(Json::as_f64).unwrap_or(1.0 / 60.0) as f32),
        "overlap_enter" => EventKind::OverlapEnter(other()?),
        "overlap_exit" => EventKind::OverlapExit(other()?),
        "action" => EventKind::Action(arg.to_string(), value.coerce(logic_core::Ty::Number).ok().and_then(|v| if let Value::Num(n) = v { Some(n as f32) } else { None }).unwrap_or(1.0)),
        "message" => EventKind::Message(arg.to_string(), value),
        "timer" => {
            let id: u32 = arg.parse().map_err(|_| "timer:<node id>")?;
            let st = world.get::<LogicState>(entity).and_then(|s| s.graph.clone()).ok_or("graph isn't loaded")?;
            EventKind::Timer(st.index_of(id).ok_or("no such node")?)
        }
        other => return Err(format!("unknown event `{other}`")),
    };
    if world.get::<LogicState>(entity).and_then(|s| s.graph.as_ref()).is_none() {
        return Err("entity has no loaded logic graph".into());
    }
    let before = world.resource::<LogicDiagnostics>().items.len();
    let ran = run_fire(world, Fire { entity, kind });
    // Messages the run emitted are delivered like any other.
    let out = std::mem::take(&mut world.resource_mut::<LogicOutbox>().0);
    for (name, value) in out {
        world.write_message(LogicMessage { name, value });
    }
    let d = world.resource::<LogicDiagnostics>();
    Ok(json!({"ran": ran, "new_errors": d.items.iter().skip(before).map(|x| x.to_string()).collect::<Vec<_>>()}))
}

fn diagnostics(world: &mut World, p: Json) -> Result<Json, String> {
    let clear = p.get("clear").and_then(Json::as_bool).unwrap_or(false);
    let mut d = world.resource_mut::<LogicDiagnostics>();
    let items: Vec<Json> = d
        .items
        .iter()
        .map(|x| {
            json!({
                "severity": if x.severity == super::Severity::Error { "error" } else { "warning" },
                "file": x.file, "line": x.line, "col": x.col, "node": x.node, "message": x.message, "count": x.count,
                "text": x.to_string(),
            })
        })
        .collect();
    let log: Vec<&String> = d.log.iter().collect();
    let out = json!({"errors": items, "log": log});
    if clear {
        d.items.clear();
        d.log.clear();
    }
    Ok(out)
}

fn reload(world: &mut World, _: Json) -> Result<Json, String> {
    let server = world.resource::<AssetServer>().clone();
    let paths: Vec<Arc<str>> = world.resource::<LogicGraphs>().slots.keys().cloned().collect();
    for p in &paths {
        server.reload(p.to_string());
    }
    let scripts = script::reload_all(world);
    Ok(json!({"graphs": paths.len(), "scripts": scripts}))
}

/// An entity id: `to_bits()` as number or string, or `"<index>v<generation>"`.
fn parse_entity(v: &Json) -> Result<Entity, String> {
    let bits = match v {
        Json::Number(n) => n.as_u64(),
        Json::String(s) => s.parse::<u64>().ok().or_else(|| {
            let (i, g) = s.split_once('v')?;
            let base = Entity::from_raw_u32(i.parse().ok()?)?;
            let g: u32 = g.parse().ok()?;
            Some(Entity::from_index_and_generation(base.index(), bevy::ecs::entity::EntityGeneration::FIRST.after_versions(g)).to_bits())
        }),
        _ => None,
    };
    bits.and_then(Entity::try_from_bits).ok_or_else(|| "entity must be bits or \"12v0\"".to_string())
}
