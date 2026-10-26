//! Reflection ⇄ JSON: look types up by name, read components / resources as JSON, patch them
//! from JSON (RFC 7386 merge patch over the current value, so partial edits work). Used by the
//! inspector commands and by [`super::testing::Scenario`] snapshots.

use bevy::ecs::component::ComponentId;
use bevy::ecs::reflect::ReflectComponent;
use bevy::ecs::world::EntityRef;
use bevy::prelude::*;
use bevy::reflect::serde::{TypedReflectDeserializer, TypedReflectSerializer};
use bevy::reflect::{PartialReflect, TypeRegistration, TypeRegistry};
use serde::de::DeserializeSeed;
use serde_json::Value;

/// Finds a registered type by full path (`bevy_transform::components::transform::Transform`),
/// short path (`Transform`) or, failing both, a unique case-insensitive short-path match.
pub fn find_type<'a>(reg: &'a TypeRegistry, name: &str) -> Result<&'a TypeRegistration, String> {
    if let Some(r) = reg.get_with_type_path(name) {
        return Ok(r);
    }
    if let Some(r) = reg.get_with_short_type_path(name) {
        return Ok(r);
    }
    let lower = name.to_ascii_lowercase();
    let hits: Vec<&TypeRegistration> = reg
        .iter()
        .filter(|r| {
            let t = r.type_info().type_path_table();
            t.short_path().eq_ignore_ascii_case(&lower) || t.path().eq_ignore_ascii_case(&lower)
        })
        .collect();
    match hits.as_slice() {
        [one] => Ok(one),
        [] => Err(format!("no registered type `{name}` (see ecs.types; derive Reflect + #[reflect(Component)] and register it)")),
        many => Err(format!(
            "`{name}` is ambiguous: {}",
            many.iter().map(|r| r.type_info().type_path()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// Short display name of a registration (`Transform`).
pub fn short_name(r: &TypeRegistration) -> &'static str {
    r.type_info().type_path_table().short_path()
}

/// `value` as JSON through its reflected serializer.
pub fn to_json(value: &dyn PartialReflect, reg: &TypeRegistry) -> Result<Value, String> {
    serde_json::to_value(TypedReflectSerializer::new(value, reg)).map_err(|e| e.to_string())
}

/// A reflected value of the registration's type from JSON (a dynamic value for structs).
pub fn from_json(r: &TypeRegistration, json: &Value, reg: &TypeRegistry) -> Result<Box<dyn PartialReflect>, String> {
    TypedReflectDeserializer::new(r, reg)
        .deserialize(json)
        .map_err(|e| format!("{}: {e}", short_name(r)))
}

/// RFC 7386 JSON merge patch: objects merge key by key, `null` deletes, anything else replaces.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(t), Value::Object(p)) => {
            for (k, v) in p {
                if v.is_null() {
                    t.remove(k);
                } else {
                    merge_patch(t.entry(k.clone()).or_insert(Value::Null), v);
                }
            }
        }
        (t, p) => *t = p.clone(),
    }
}

/// The `ReflectComponent` and `ComponentId` of a registered component (or resource) type.
pub fn component_of(world: &World, r: &TypeRegistration) -> Result<(ReflectComponent, ComponentId), String> {
    let rc = r
        .data::<ReflectComponent>()
        .ok_or_else(|| format!("`{}` is not reflected as a component (#[reflect(Component)])", short_name(r)))?
        .clone();
    let id = world
        .components()
        .get_id(r.type_id())
        .ok_or_else(|| format!("`{}` was never added to this world", short_name(r)))?;
    Ok((rc, id))
}

/// One component of an entity as JSON (`None` if the entity doesn't have it).
pub fn component_json(entity: EntityRef, rc: &ReflectComponent, reg: &TypeRegistry) -> Option<Result<Value, String>> {
    rc.reflect(entity).map(|v| to_json(v.as_partial_reflect(), reg))
}

/// Every reflected component of an entity as `{ShortName: value}`, plus the names of the
/// components that aren't reflected (or don't serialize) in `opaque`.
pub fn entity_json(world: &World, entity: Entity, reg: &TypeRegistry) -> Result<(serde_json::Map<String, Value>, Vec<String>), String> {
    let e = world.get_entity(entity).map_err(|_| format!("no entity {entity}"))?;
    let mut comps = serde_json::Map::new();
    let mut opaque = Vec::new();
    for &cid in e.archetype().components() {
        let Some(info) = world.components().get_info(cid) else { continue };
        let reflected = info
            .type_id()
            .and_then(|t| reg.get(t))
            .and_then(|r| r.data::<ReflectComponent>().map(|rc| (r, rc)));
        match reflected {
            Some((r, rc)) => match component_json(e, rc, reg) {
                Some(Ok(v)) => {
                    comps.insert(short_name(r).to_string(), v);
                }
                _ => opaque.push(short_name(r).to_string()),
            },
            None => opaque.push(info.name().to_string()),
        }
    }
    Ok((comps, opaque))
}

/// Sets component `r` on `entity` from JSON. `merge`: patch the current value (partial JSON is
/// fine); otherwise `json` must be a complete value. Inserts the component if it is missing.
pub fn set_component(world: &mut World, entity: Entity, r: &TypeRegistration, json: &Value, merge: bool, reg: &TypeRegistry) -> Result<Value, String> {
    let (rc, cid) = match component_of(world, r) {
        Ok(x) => x,
        // Never added to this world yet: register it now (insert path below).
        Err(_) => {
            let rc = r
                .data::<ReflectComponent>()
                .ok_or_else(|| format!("`{}` is not reflected as a component", short_name(r)))?
                .clone();
            let id = rc.register_component(world);
            (rc, id)
        }
    };
    let e = world.get_entity(entity).map_err(|_| format!("no entity {entity}"))?;
    let current = component_json(e, &rc, reg).transpose()?;
    let full = match (merge, current) {
        (true, Some(mut cur)) => {
            merge_patch(&mut cur, json);
            cur
        }
        _ => json.clone(),
    };
    let value = from_json(r, &full, reg)?;
    let mutable = world.components().get_info(cid).is_none_or(|i| i.mutable());
    let mut em = world.entity_mut(entity);
    let has = em.contains_id(cid);
    if has && mutable {
        let mut target = rc.reflect_mut(&mut em).ok_or("component vanished")?;
        target.try_apply(value.as_ref()).map_err(|e| e.to_string())?;
    } else {
        rc.insert(&mut em, value.as_ref(), reg);
    }
    let e = world.entity(entity);
    component_json(e, &rc, reg).unwrap_or(Ok(Value::Null))
}

/// The entity holding resource `r`, with its `ReflectComponent`.
pub fn resource_entity(world: &World, r: &TypeRegistration) -> Result<(Entity, ReflectComponent), String> {
    let (rc, cid) = component_of(world, r)?;
    let e = world
        .resource_entities()
        .get(cid)
        .ok_or_else(|| format!("resource `{}` is not in the world", short_name(r)))?;
    Ok((e, rc))
}

/// Resource `T` as JSON through reflection (for snapshots).
pub fn resource_to_json<T: Resource + Reflect>(world: &World) -> Result<Value, String> {
    let res = world
        .get_resource::<T>()
        .ok_or_else(|| format!("no resource {}", std::any::type_name::<T>()))?;
    let reg = world.resource::<AppTypeRegistry>().read();
    to_json(res.as_partial_reflect(), &reg)
}

/// Parses an entity id: `to_bits()` as a number or string, or `"<index>v<generation>"`
/// (what `Display` prints, e.g. `12v0`).
pub fn parse_entity(v: &Value) -> Result<Entity, String> {
    if let Some(bits) = v.as_u64() {
        return Entity::try_from_bits(bits).ok_or_else(|| format!("bad entity bits {bits}"));
    }
    let s = v.as_str().ok_or("`id` must be an entity: bits (number) or \"12v0\"")?;
    if let Ok(bits) = s.parse::<u64>() {
        return Entity::try_from_bits(bits).ok_or_else(|| format!("bad entity bits {bits}"));
    }
    let (i, g) = s.split_once('v').ok_or_else(|| format!("bad entity `{s}` (want \"12v0\" or bits)"))?;
    let index: u32 = i.parse().map_err(|_| format!("bad entity index in `{s}`"))?;
    let generation: u32 = g.parse().map_err(|_| format!("bad entity generation in `{s}`"))?;
    let base = Entity::from_raw_u32(index).ok_or_else(|| format!("bad entity index in `{s}`"))?;
    Ok(Entity::from_index_and_generation(
        base.index(),
        bevy::ecs::entity::EntityGeneration::FIRST.after_versions(generation),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merge_patch_rfc7386() {
        let mut v = json!({"a": 1, "b": {"c": 2, "d": 3}, "e": [1, 2]});
        merge_patch(&mut v, &json!({"b": {"c": 9, "d": null}, "e": [3], "f": true}));
        assert_eq!(v, json!({"a": 1, "b": {"c": 9}, "e": [3], "f": true}));
    }

    #[test]
    fn entity_ids_round_trip() {
        let mut w = World::new();
        let e = w.spawn_empty().id();
        assert_eq!(parse_entity(&json!(e.to_bits())).unwrap(), e);
        assert_eq!(parse_entity(&json!(e.to_string())).unwrap(), e);
        assert_eq!(parse_entity(&json!(e.to_bits().to_string())).unwrap(), e);
        assert!(parse_entity(&json!("x")).is_err());
    }

    #[test]
    fn transform_patch_and_lookup() {
        let mut w = World::new();
        w.init_resource::<AppTypeRegistry>();
        w.resource::<AppTypeRegistry>().write().register::<Transform>();
        let e = w.spawn(Transform::from_xyz(1.0, 2.0, 3.0)).id();
        let reg = w.resource::<AppTypeRegistry>().clone();
        let reg = reg.read();
        let r = find_type(&reg, "transform").unwrap();
        let v = set_component(&mut w, e, r, &json!({"translation": [5.0, 6.0, 7.0]}), true, &reg).unwrap();
        assert_eq!(v["translation"], json!([5.0, 6.0, 7.0]));
        assert_eq!(v["scale"], json!([1.0, 1.0, 1.0]));
        assert_eq!(w.entity(e).get::<Transform>().unwrap().translation, Vec3::new(5.0, 6.0, 7.0));
        let (comps, _) = entity_json(&w, e, &reg).unwrap();
        assert!(comps.contains_key("Transform"));
    }
}
