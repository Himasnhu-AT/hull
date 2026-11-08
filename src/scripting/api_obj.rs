//! GDScript-style access on node handles: `node.position`, `node.position = v`,
//! `node.hp -= 1`, `node.get_node("Kid")`, `node.hit(3)`.
//!
//! Property read/write goes through a small table ([`PROPS`]) of getter/setter host functions,
//! then falls back to the node's script member (`get_var`/`set_var`). A method call runs the
//! node's script function if it has one, else the host function of that name with the node
//! prepended (`node.queue_free()` is `queue_free(node)`).
//!
//! `self.x` / `self.f()` on the running instance never reach these hooks for the script's own
//! members and functions: ruspy resolves them against the instance's globals (see
//! `Engine::set_self_handle`), so the borrowed instance is not touched.

use bevy::prelude::*;
use ruspy::embed::{Ctx, Engine};
use ruspy::value::Value as RV;

use super::api::{ent, live, world};

/// `(property, getter host function, setter host function)`; `None` = read-only.
pub(crate) const PROPS: &[(&str, &str, Option<&str>)] = &[
    ("position", "get_position", Some("set_position")),
    ("global_position", "get_global_position", None),
    ("rotation", "get_rotation", Some("set_rotation")),
    ("scale", "get_scale", Some("set_scale")),
    ("visible", "is_visible", Some("set_visible")),
    ("name", "get_name", Some("set_name")),
    ("text", "get_text", Some("set_text")),
    ("parent", "get_parent", None),
    ("children", "get_children", None),
    ("path", "get_path", None),
];

fn target(c: &mut Ctx, id: u64) -> Result<Entity, String> {
    let w = world(c)?;
    live(w, ent(&RV::Object(id))?)
}

fn get(c: &mut Ctx, id: u64, name: &str) -> Result<RV, String> {
    let e = target(c, id)?;
    if let Some((_, getter, _)) = PROPS.iter().find(|p| p.0 == name) {
        return c.call_host(getter, &[RV::Object(id)]);
    }
    let w = world(c)?;
    super::get_member_rv(w, e, name).map_err(|m| format!("{m} (not a built-in property: {})", prop_names()))
}

fn set(c: &mut Ctx, id: u64, name: &str, v: RV) -> Result<(), String> {
    let e = target(c, id)?;
    if let Some((_, _, setter)) = PROPS.iter().find(|p| p.0 == name) {
        let setter = setter.ok_or_else(|| format!("property `{name}` is read-only"))?;
        c.call_host(setter, &[RV::Object(id), v])?;
        return Ok(());
    }
    let w = world(c)?;
    super::set_member_rv(w, e, name, v).map_err(|m| format!("{m} (not a built-in property: {})", prop_names()))
}

fn call(c: &mut Ctx, id: u64, name: &str, args: &[RV]) -> Result<RV, String> {
    let e = target(c, id)?;
    let w = world(c)?;
    if super::has_method(w, e, name) {
        return super::call_rv(w, e, name, args.to_vec());
    }
    if c.has_host(name) {
        let mut a = Vec::with_capacity(args.len() + 1);
        a.push(RV::Object(id));
        a.extend_from_slice(args);
        return c.call_host(name, &a);
    }
    Err(format!("node has no method `{name}` (no script function, no host function)"))
}

fn prop_names() -> String {
    PROPS.iter().map(|p| p.0).collect::<Vec<_>>().join(", ")
}

pub(super) fn register(e: &mut Engine) {
    e.register_object_get(get);
    e.register_object_set(set);
    e.register_object_call(call);
}
