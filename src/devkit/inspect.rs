//! Reflection inspector over the control port (features `devkit` + `devtools`).
//!
//! Every reflected type works: `#[derive(Component, Reflect)] #[reflect(Component)]` +
//! `app.register_type::<T>()` (Bevy's own components are registered already). Type names are
//! full paths, short paths (`Transform`) or case-insensitive short paths. Values are the
//! reflect-serde JSON (`Vec3` = `[x, y, z]`, `Quat` = `[x, y, z, w]`). Entity ids are
//! `to_bits()` numbers (`id` in every reply) or `"12v0"` strings.
//!
//! | Command | Params | Result |
//! |---|---|---|
//! | `ecs.query` | `{components?, with?, without?, name?, limit?}` | `{count, entities:[{id, entity, name?, components}]}` |
//! | `ecs.get` | `{id}` | `{id, entity, components, opaque}` |
//! | `ecs.set` | `{id, component, value, replace?}` | `{value}` (merge patch unless `replace`) |
//! | `ecs.remove` | `{id, component}` | `{}` |
//! | `ecs.spawn` | `{components: {Type: value}}` | `{id, entity}` |
//! | `ecs.despawn` | `{id}` | `{}` |
//! | `ecs.res.list` | — | `{resources:[name]}` (reflected ones present) |
//! | `ecs.res.get` | `{name}` | `{value}` |
//! | `ecs.res.set` | `{name, value, replace?}` | `{value}` |
//! | `ecs.types` | `{filter?, kind?: component/resource}` | `{types:[{name, path, component, resource}]}` |
//! | `ecs.systems` | `{schedule?, filter?}` | `{schedules:[{schedule, count, systems}]}` |

use bevy::ecs::query::QueryBuilder;
use bevy::ecs::reflect::{ReflectComponent, ReflectResource};
use bevy::ecs::resource::IsResource;
use bevy::prelude::*;
use serde_json::{Map, Value, json};

use super::reflect_json::{component_json, component_of, entity_json, find_type, from_json, parse_entity, resource_entity, set_component, short_name, to_json};
use crate::devtools::{AddControlCommand, params};

/// Default / max entities `ecs.query` returns.
const QUERY_LIMIT: usize = 100;
const QUERY_MAX: usize = 10_000;

pub(super) fn register(app: &mut App) {
    app.add_control_command(
        "ecs.query",
        "Entities having all `components` (values included) + `with`, minus `without`",
        params(&[
            ("components", "array", "type names whose values to return, e.g. [\"Transform\"]"),
            ("with", "array", "extra required types (values not returned)"),
            ("without", "array", "excluded types"),
            ("name", "string", "only entities whose Name contains this"),
            ("limit", "integer", "max entities (default 100)"),
        ]),
        ecs_query,
    )
    .add_control_command("ecs.get", "Every component of one entity", params(&[("id", "integer", "entity bits or \"12v0\"")]), ecs_get)
    .add_control_command(
        "ecs.set",
        "Set (merge-patch) a component from JSON; inserts it if missing",
        params(&[
            ("id", "integer", "entity"),
            ("component", "string", "type name"),
            ("value", "object", "JSON value (partial unless replace)"),
            ("replace", "boolean", "value is complete; don't merge with the current one"),
        ]),
        ecs_set,
    )
    .add_control_command(
        "ecs.remove",
        "Remove a component",
        params(&[("id", "integer", "entity"), ("component", "string", "type name")]),
        ecs_remove,
    )
    .add_control_command(
        "ecs.spawn",
        "Spawn an entity from reflected components",
        params(&[("components", "object", "{\"Transform\": {...}, \"Name\": \"crate\"}")]),
        ecs_spawn,
    )
    .add_control_command("ecs.despawn", "Despawn an entity (and its children)", params(&[("id", "integer", "entity")]), ecs_despawn)
    .add_control_command("ecs.res.list", "Reflected resources present in the world", params(&[]), res_list)
    .add_control_command("ecs.res.get", "A resource as JSON", params(&[("name", "string", "type name")]), res_get)
    .add_control_command(
        "ecs.res.set",
        "Set (merge-patch) a resource from JSON",
        params(&[
            ("name", "string", "type name"),
            ("value", "object", "JSON value"),
            ("replace", "boolean", "value is complete"),
        ]),
        res_set,
    )
    .add_control_command(
        "ecs.types",
        "Registered reflected component / resource types",
        params(&[("filter", "string", "substring of the type path"), ("kind", "string", "component|resource")]),
        ecs_types,
    )
    .add_control_command(
        "ecs.systems",
        "Systems per schedule (schedules running right now, e.g. PreUpdate, aren't listed)",
        params(&[("schedule", "string", "schedule name, e.g. Update"), ("filter", "string", "substring of the system name")]),
        ecs_systems,
    );
}

fn names(p: &Value, key: &str) -> Result<Vec<String>, String> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(s)) => Ok(vec![s.clone()]),
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| v.as_str().map(String::from).ok_or_else(|| format!("`{key}` must be a list of type names")))
            .collect(),
        _ => Err(format!("`{key}` must be a list of type names")),
    }
}

fn id_param(p: &Value) -> Result<Entity, String> {
    parse_entity(p.get("id").ok_or("`id` is required")?)
}

fn str_param<'a>(p: &'a Value, k: &str) -> Result<&'a str, String> {
    p.get(k).and_then(Value::as_str).ok_or_else(|| format!("`{k}` (string) is required"))
}

fn ecs_query(world: &mut World, p: Value) -> Result<Value, String> {
    let reg = world.resource::<AppTypeRegistry>().clone();
    let reg = reg.read();
    let shown = names(&p, "components")?;
    let with = names(&p, "with")?;
    let without = names(&p, "without")?;
    let limit = p.get("limit").and_then(Value::as_u64).map_or(QUERY_LIMIT, |l| (l as usize).min(QUERY_MAX));
    let name_filter = p.get("name").and_then(Value::as_str);

    let mut shown_rc = Vec::with_capacity(shown.len());
    let mut with_ids = Vec::new();
    for n in shown.iter().chain(&with) {
        let r = find_type(&reg, n)?;
        match component_of(world, r) {
            Ok((rc, id)) => {
                with_ids.push(id);
                if shown_rc.len() < shown.len() {
                    shown_rc.push((short_name(r), rc));
                }
            }
            // Type never added to this world → nothing can match.
            Err(_) => return Ok(json!({"count": 0, "entities": []})),
        }
    }
    let mut without_ids = Vec::new();
    for n in &without {
        if let Ok((_, id)) = component_of(world, find_type(&reg, n)?) {
            without_ids.push(id);
        }
    }
    let is_res = world.register_component::<IsResource>();
    let mut qb = QueryBuilder::<Entity>::new(world);
    qb.without_id(is_res);
    for id in &with_ids {
        qb.with_id(*id);
    }
    for id in &without_ids {
        qb.without_id(*id);
    }
    let mut q = qb.build();
    let mut ents: Vec<Entity> = q.iter(world).collect();
    ents.sort_unstable();

    let mut out = Vec::new();
    let mut count = 0usize;
    for e in ents {
        let er = world.entity(e);
        let name = er.get::<Name>().map(|n| n.as_str().to_string());
        if let Some(f) = name_filter
            && !name.as_deref().is_some_and(|n| n.contains(f))
        {
            continue;
        }
        count += 1;
        if out.len() >= limit {
            continue;
        }
        let mut comps = Map::new();
        for (n, rc) in &shown_rc {
            let v = match component_json(er, rc, &reg) {
                Some(Ok(v)) => v,
                Some(Err(err)) => json!({"error": err}),
                None => Value::Null,
            };
            comps.insert((*n).to_string(), v);
        }
        out.push(json!({"id": e.to_bits(), "entity": e.to_string(), "name": name, "components": comps}));
    }
    Ok(json!({"count": count, "returned": out.len(), "entities": out}))
}

fn ecs_get(world: &mut World, p: Value) -> Result<Value, String> {
    let e = id_param(&p)?;
    let reg = world.resource::<AppTypeRegistry>().clone();
    let reg = reg.read();
    let (comps, opaque) = entity_json(world, e, &reg)?;
    let children: Vec<u64> = world.entity(e).get::<Children>().map(|c| c.iter().map(|e| e.to_bits()).collect()).unwrap_or_default();
    Ok(json!({"id": e.to_bits(), "entity": e.to_string(), "components": comps, "opaque": opaque, "children": children}))
}

fn ecs_set(world: &mut World, p: Value) -> Result<Value, String> {
    let e = id_param(&p)?;
    let reg = world.resource::<AppTypeRegistry>().clone();
    let reg = reg.read();
    let r = find_type(&reg, str_param(&p, "component")?)?;
    let value = p.get("value").ok_or("`value` is required")?;
    let replace = p.get("replace").and_then(Value::as_bool).unwrap_or(false);
    let v = set_component(world, e, r, value, !replace, &reg)?;
    Ok(json!({"value": v}))
}

fn ecs_remove(world: &mut World, p: Value) -> Result<Value, String> {
    let e = id_param(&p)?;
    let reg = world.resource::<AppTypeRegistry>().clone();
    let reg = reg.read();
    let r = find_type(&reg, str_param(&p, "component")?)?;
    let rc = r.data::<ReflectComponent>().ok_or("not a reflected component")?;
    let mut em = world.get_entity_mut(e).map_err(|_| format!("no entity {e}"))?;
    rc.remove(&mut em);
    Ok(json!({}))
}

fn ecs_spawn(world: &mut World, p: Value) -> Result<Value, String> {
    let reg = world.resource::<AppTypeRegistry>().clone();
    let reg = reg.read();
    let comps = match p.get("components") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        _ => return Err("`components` must be an object {Type: value}".into()),
    };
    // Validate everything before spawning so a typo leaves no half-built entity.
    let mut values = Vec::with_capacity(comps.len());
    for (n, v) in &comps {
        let r = find_type(&reg, n)?;
        let rc = r
            .data::<ReflectComponent>()
            .ok_or_else(|| format!("`{n}` is not a reflected component"))?
            .clone();
        values.push((rc, from_json(r, v, &reg)?));
    }
    let mut em = world.spawn_empty();
    for (rc, v) in &values {
        rc.insert(&mut em, v.as_ref(), &reg);
    }
    let e = em.id();
    Ok(json!({"id": e.to_bits(), "entity": e.to_string()}))
}

fn ecs_despawn(world: &mut World, p: Value) -> Result<Value, String> {
    let e = id_param(&p)?;
    if !world.despawn(e) {
        return Err(format!("no entity {e}"));
    }
    Ok(json!({}))
}

fn res_list(world: &mut World, _: Value) -> Result<Value, String> {
    let reg = world.resource::<AppTypeRegistry>().clone();
    let reg = reg.read();
    let mut out: Vec<&str> = reg
        .iter()
        .filter(|r| r.data::<ReflectResource>().is_some())
        .filter(|r| resource_entity(world, r).is_ok())
        .map(|r| r.type_info().type_path())
        .collect();
    out.sort_unstable();
    Ok(json!({"resources": out}))
}

fn res_get(world: &mut World, p: Value) -> Result<Value, String> {
    let reg = world.resource::<AppTypeRegistry>().clone();
    let reg = reg.read();
    let r = find_type(&reg, str_param(&p, "name")?)?;
    let (e, rc) = resource_entity(world, r)?;
    let v = rc
        .reflect(world.entity(e))
        .ok_or("resource missing")
        .and_then(|v| to_json(v.as_partial_reflect(), &reg).map_err(|_| "resource does not serialize"))?;
    Ok(json!({"name": r.type_info().type_path(), "value": v}))
}

fn res_set(world: &mut World, p: Value) -> Result<Value, String> {
    let reg = world.resource::<AppTypeRegistry>().clone();
    let reg = reg.read();
    let r = find_type(&reg, str_param(&p, "name")?)?;
    let value = p.get("value").ok_or("`value` is required")?;
    let replace = p.get("replace").and_then(Value::as_bool).unwrap_or(false);
    let (e, _) = resource_entity(world, r)?;
    let v = set_component(world, e, r, value, !replace, &reg)?;
    Ok(json!({"value": v}))
}

fn ecs_types(world: &mut World, p: Value) -> Result<Value, String> {
    let reg = world.resource::<AppTypeRegistry>().clone();
    let reg = reg.read();
    let filter = p.get("filter").and_then(Value::as_str).map(str::to_ascii_lowercase);
    let kind = p.get("kind").and_then(Value::as_str);
    let mut out: Vec<Value> = reg
        .iter()
        .filter_map(|r| {
            let component = r.data::<ReflectComponent>().is_some();
            let resource = r.data::<ReflectResource>().is_some();
            let keep = match kind {
                Some("component") => component && !resource,
                Some("resource") => resource,
                _ => component || resource,
            };
            let path = r.type_info().type_path();
            if !keep || filter.as_ref().is_some_and(|f| !path.to_ascii_lowercase().contains(f)) {
                return None;
            }
            Some(json!({"name": short_name(r), "path": path, "component": component && !resource, "resource": resource}))
        })
        .collect();
    out.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(json!({"count": out.len(), "types": out}))
}

fn ecs_systems(world: &mut World, p: Value) -> Result<Value, String> {
    let want = p.get("schedule").and_then(Value::as_str);
    let filter = p.get("filter").and_then(Value::as_str);
    let schedules = world.resource::<Schedules>();
    let mut out = Vec::new();
    let mut named = true;
    for (label, schedule) in schedules.iter() {
        let name = format!("{label:?}");
        if want.is_some_and(|w| w != name) {
            continue;
        }
        let systems: Vec<String> = match schedule.systems() {
            Ok(it) => it
                .map(|(_, s)| s.name().to_string())
                .inspect(|n| named &= !n.starts_with("<Enable"))
                .filter(|n| filter.is_none_or(|f| n.contains(f)))
                .collect(),
            Err(_) => Vec::new(),
        };
        out.push(json!({"schedule": name, "count": schedule.systems_len(), "systems": systems}));
    }
    out.sort_by(|a, b| a["schedule"].as_str().cmp(&b["schedule"].as_str()));
    if want.is_some() && out.is_empty() {
        return Err(format!("no schedule `{}` (running schedules are not listed)", want.unwrap_or_default()));
    }
    // Bevy strips system names unless its `debug` feature is on (engine feature `debug_names`).
    let note = (!named).then_some("system names need the engine feature `debug_names` (bevy/debug)");
    Ok(json!({"schedules": out, "names": named, "note": note}))
}
