//! Reading and writing component fields by path (`Transform.translation.y`) through
//! reflection, as logic [`Value`]s.

use bevy::ecs::reflect::ReflectComponent;
use bevy::prelude::*;
use bevy::reflect::serde::{TypedReflectDeserializer, TypedReflectSerializer};
use bevy::reflect::{GetPath, PartialReflect, TypeRegistration, TypeRegistry};
use logic_core::Value;
use serde::de::DeserializeSeed;

fn find_type<'a>(reg: &'a TypeRegistry, name: &str) -> Result<&'a TypeRegistration, String> {
    if let Some(r) = reg.get_with_short_type_path(name) {
        return Ok(r);
    }
    if let Some(r) = reg.get_with_type_path(name) {
        return Ok(r);
    }
    let lower = name.to_ascii_lowercase();
    let hits: Vec<&TypeRegistration> = reg
        .iter()
        .filter(|r| r.type_info().type_path_table().short_path().eq_ignore_ascii_case(&lower))
        .collect();
    match hits.as_slice() {
        [one] => Ok(one),
        [] => Err(format!("no registered component `{name}` (derive Reflect + #[reflect(Component)] and register_type it)")),
        _ => Err(format!("component name `{name}` is ambiguous; use the full type path")),
    }
}

fn split(path: &str) -> (&str, &str) {
    path.split_once('.').unwrap_or((path, ""))
}

/// Reads `Component.field.sub` of `entity`.
pub fn get_path(world: &World, entity: Entity, path: &str) -> Result<Value, String> {
    let (comp, rest) = split(path);
    let registry = world.resource::<AppTypeRegistry>().clone();
    let reg = registry.read();
    let r = find_type(&reg, comp)?;
    let rc = r.data::<ReflectComponent>().ok_or_else(|| format!("`{comp}` is not a reflected component"))?;
    let e = world.get_entity(entity).map_err(|_| format!("entity {entity} doesn't exist"))?;
    let value = rc.reflect(e).ok_or_else(|| format!("entity {entity} has no `{comp}`"))?;
    let leaf: &dyn PartialReflect = if rest.is_empty() {
        value.as_partial_reflect()
    } else {
        value.reflect_path(rest).map_err(|e| format!("`{path}`: {e}"))?
    };
    let json = serde_json::to_value(TypedReflectSerializer::new(leaf, &reg)).map_err(|e| format!("`{path}`: {e}"))?;
    Ok(Value::from_json(&json))
}

/// Writes `Component.field.sub` of `entity`.
pub fn set_path(world: &mut World, entity: Entity, path: &str, value: &Value) -> Result<(), String> {
    let (comp, rest) = split(path);
    let registry = world.resource::<AppTypeRegistry>().clone();
    let reg = registry.read();
    let r = find_type(&reg, comp)?;
    let rc = r.data::<ReflectComponent>().ok_or_else(|| format!("`{comp}` is not a reflected component"))?.clone();
    let mut em = world.get_entity_mut(entity).map_err(|_| format!("entity {entity} doesn't exist"))?;
    let mut target = rc.reflect_mut(&mut em).ok_or_else(|| format!("entity {entity} has no `{comp}`"))?;
    let leaf: &mut dyn PartialReflect = if rest.is_empty() {
        target.as_partial_reflect_mut()
    } else {
        target.reflect_path_mut(rest).map_err(|e| format!("`{path}`: {e}"))?
    };
    let type_id = leaf.get_represented_type_info().map(|i| i.type_id()).ok_or_else(|| format!("`{path}` has no type info"))?;
    let lr = reg.get(type_id).ok_or_else(|| format!("`{path}`: type isn't registered"))?;
    let json = value.to_json();
    let new = match TypedReflectDeserializer::new(lr, &reg).deserialize(&json) {
        Ok(v) => v,
        // Whole numbers arrive as floats; integer fields want integers.
        Err(first) => match integer_json(&json) {
            Some(i) => TypedReflectDeserializer::new(lr, &reg).deserialize(&i).map_err(|_| format!("`{path}`: {first}"))?,
            None => return Err(format!("`{path}`: {first}")),
        },
    };
    leaf.try_apply(new.as_ref()).map_err(|e| format!("`{path}`: {e}"))
}

fn integer_json(j: &serde_json::Value) -> Option<serde_json::Value> {
    let f = j.as_f64()?;
    if f.fract() != 0.0 {
        return None;
    }
    Some(if f >= 0.0 { serde_json::Value::from(f as u64) } else { serde_json::Value::from(f as i64) })
}
