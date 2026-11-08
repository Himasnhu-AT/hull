//! Host functions for node scripts, named like Godot's API. Entities are ints
//! (`Entity::to_bits`), vectors are `[x, y, z]` arrays. Functions acting on a node take it as an
//! optional first argument: `set_visible(false)` is `self`, `set_visible(e, false)` is `e`.
//!
//! The full catalogue is in `docs/SCRIPTING.md`; keep both in sync.

use bevy::prelude::*;
use logic_core::Value;
use ruspy::embed::{Ctx, Engine};
use ruspy::value::Value as RV;

use super::{DeclaredSignals, ScriptCtx, ScriptQueue, tree};
use crate::logic::LogicDiagnostics;
use crate::logic::access;
use crate::logic::script::{rv_of, value_of_rv};

// ---------------------------------------------------------------- argument helpers

pub(crate) fn world<'a>(c: &'a mut Ctx) -> Result<&'a mut World, String> {
    c.state::<World>().ok_or_else(|| "no world".to_string())
}

/// The entity whose script is running.
pub(crate) fn me(w: &World) -> Result<Entity, String> {
    w.resource::<ScriptCtx>().stack.last().copied().ok_or_else(|| "no script is running".to_string())
}

pub(crate) fn ent(v: &RV) -> Result<Entity, String> {
    match v {
        RV::Int(i) => {
            let e = Entity::try_from_bits(*i as u64).ok_or_else(|| format!("bad entity {i}"))?;
            Ok(e)
        }
        RV::Null => Err("entity is null (node not found?)".into()),
        other => Err(format!("expected an entity (int), got {}", other.type_name())),
    }
}

pub(crate) fn live(w: &World, e: Entity) -> Result<Entity, String> {
    if w.get_entity(e).is_ok() { Ok(e) } else { Err(format!("entity {e} no longer exists")) }
}

/// `(target, rest)`: `rest` has `n` args; one more in front is the target entity, else `self`.
pub(crate) fn split<'a>(w: &World, a: &'a [RV], n: usize, usage: &str) -> Result<(Entity, &'a [RV]), String> {
    if a.len() == n {
        Ok((me(w)?, a))
    } else if a.len() == n + 1 {
        Ok((live(w, ent(&a[0])?)?, &a[1..]))
    } else {
        Err(format!("usage: {usage}"))
    }
}

pub(crate) fn s<'a>(v: &'a RV, what: &str) -> Result<&'a str, String> {
    match v {
        RV::Str(s) => Ok(s),
        other => Err(format!("{what} must be a str, got {}", other.type_name())),
    }
}

pub(crate) fn f(v: &RV, what: &str) -> Result<f32, String> {
    match v {
        RV::Int(i) => Ok(*i as f32),
        RV::Float(x) => Ok(*x as f32),
        other => Err(format!("{what} must be a number, got {}", other.type_name())),
    }
}

pub(crate) fn b(v: &RV, what: &str) -> Result<bool, String> {
    match v {
        RV::Bool(b) => Ok(*b),
        other => Err(format!("{what} must be a bool, got {}", other.type_name())),
    }
}

pub(crate) fn v3(v: &RV, what: &str) -> Result<Vec3, String> {
    if let RV::Array(a) = v {
        let a = a.borrow();
        if a.len() == 3 {
            return Ok(Vec3::new(f(&a[0], what)?, f(&a[1], what)?, f(&a[2], what)?));
        }
    }
    Err(format!("{what} must be [x, y, z], got {}", v.type_name()))
}

pub(crate) fn rv3(v: Vec3) -> RV {
    RV::array(vec![RV::Float(v.x as f64), RV::Float(v.y as f64), RV::Float(v.z as f64)])
}

pub(crate) fn rent(e: Entity) -> RV {
    RV::Int(e.to_bits() as i64)
}

pub(crate) fn ropt(e: Option<Entity>) -> RV {
    e.map_or(RV::Null, rent)
}

pub(crate) fn vals(a: &[RV]) -> Result<Vec<Value>, String> {
    a.iter().map(value_of_rv).collect()
}

// ---------------------------------------------------------------- registration

pub(super) fn register(e: &mut Engine) {
    core(e);
}

fn core(e: &mut Engine) {
    e.register("self", |c, _| Ok(rent(me(world(c)?)?)));
    for name in ["log", "print"] {
        e.register(name, |c, a| {
            let w = world(c)?;
            let text = a.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(" ");
            info!("[script] {text}");
            if let Some(mut d) = w.get_resource_mut::<LogicDiagnostics>() {
                d.log(text);
            }
            Ok(RV::Void)
        });
    }
    e.register("get", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "get([node,] \"Component.field\")")?;
        Ok(rv_of(&access::get_path(w, t, s(&r[0], "path")?)?))
    });
    e.register("set", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 2, "set([node,] \"Component.field\", value)")?;
        access::set_path(w, t, s(&r[0], "path")?, &value_of_rv(&r[1])?)?;
        Ok(RV::Void)
    });
    // ---- tree
    e.register("get_node", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "get_node([node,] path)")?;
        Ok(rent(tree::get_node(w, t, s(&r[0], "path")?)?))
    });
    e.register("get_node_or_null", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "get_node_or_null([node,] path)")?;
        Ok(ropt(tree::resolve_path(w, t, s(&r[0], "path")?)))
    });
    e.register("find", |c, a| {
        let w = world(c)?;
        Ok(ropt(tree::find_named(w, s(a.first().ok_or("find(name)")?, "name")?)))
    });
    e.register("get_parent", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_parent([node])")?;
        Ok(ropt(w.get::<ChildOf>(t).map(|p| p.parent())))
    });
    e.register("get_children", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_children([node])")?;
        let v = w.get::<Children>(t).map(|ch| ch.iter().map(rent).collect()).unwrap_or_default();
        Ok(RV::array(v))
    });
    e.register("get_name", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_name([node])")?;
        Ok(tree::name_of(w, t).map_or(RV::Null, |n| RV::Str(n.into())))
    });
    e.register("get_path", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_path([node])")?;
        Ok(RV::Str(tree::path_of(w, t)))
    });
    e.register("is_valid", |c, a| {
        let w = world(c)?;
        Ok(RV::Bool(matches!(a.first(), Some(RV::Int(_))) && ent(&a[0]).is_ok_and(|e| w.get_entity(e).is_ok())))
    });
    e.register("queue_free", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "queue_free([node])")?;
        w.resource_mut::<ScriptQueue>().free.push(t);
        Ok(RV::Void)
    });
    // ---- signals and calls
    e.register("signal", |c, a| {
        let w = world(c)?;
        let name = s(a.first().ok_or("signal(name)")?, "name")?.to_string();
        w.get_resource_or_insert_with(DeclaredSignals::default).0.push(name);
        Ok(RV::Void)
    });
    e.register("emit_signal", |c, a| {
        let w = world(c)?;
        let name = s(a.first().ok_or("emit_signal(name, args...)")?, "name")?.to_string();
        let args = vals(&a[1..])?;
        let src = me(w)?;
        Ok(RV::Int(super::emit_signal(w, src, &name, &args) as i64))
    });
    // connect(signal, target, method) on self, or connect(source, signal, target, method).
    // `target` is an entity or a node path from the source.
    e.register("connect", |c, a| {
        let w = world(c)?;
        let (src, r) = split(w, a, 3, "connect([source,] signal, target, method)")?;
        let target = match &r[1] {
            RV::Str(p) => p.clone(),
            other => format!("#{}", ent(other)?.to_bits()),
        };
        super::connect(w, src, s(&r[0], "signal")?, &target, s(&r[2], "method")?, false, false);
        Ok(RV::Void)
    });
    e.register("disconnect", |c, a| {
        let w = world(c)?;
        let (src, r) = split(w, a, 3, "disconnect([source,] signal, target, method)")?;
        let target = match &r[1] {
            RV::Str(p) => p.clone(),
            other => format!("#{}", ent(other)?.to_bits()),
        };
        let (sig, m) = (s(&r[0], "signal")?.to_string(), s(&r[2], "method")?.to_string());
        if let Some(mut cs) = w.get_mut::<super::Connections>(src) {
            cs.0.retain(|x| !(x.signal == sig && x.target == target && x.method == m));
        }
        Ok(RV::Void)
    });
    // call(node, method, args...): synchronous call into another entity's script.
    e.register("call", |c, a| {
        let w = world(c)?;
        if a.len() < 2 {
            return Err("usage: call(node, method, args...)".into());
        }
        let t = live(w, ent(&a[0])?)?;
        let m = s(&a[1], "method")?.to_string();
        super::call_rv(w, t, &m, a[2..].to_vec())
    });
    e.register("has_method", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "has_method([node,] method)")?;
        Ok(RV::Bool(super::has_method(w, t, s(&r[0], "method")?)))
    });
    // call_deferred([node,] method, args...): at the end of the frame.
    e.register("call_deferred", |c, a| {
        let w = world(c)?;
        let (t, rest) = match a.first() {
            Some(RV::Int(_)) => (live(w, ent(&a[0])?)?, &a[1..]),
            _ => (me(w)?, a),
        };
        let m = s(rest.first().ok_or("usage: call_deferred([node,] method, args...)")?, "method")?.to_string();
        let args = vals(&rest[1..])?;
        w.resource_mut::<ScriptQueue>().calls.push((t, m, args));
        Ok(RV::Void)
    });
    // get_var(node, name) / set_var(node, name, v): another script's member.
    e.register("get_var", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "get_var([node,] name)")?;
        super::get_member_rv(w, t, s(&r[0], "name")?)
    });
    e.register("set_var", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 2, "set_var([node,] name, value)")?;
        super::set_member_rv(w, t, s(&r[0], "name")?, r[1].clone())?;
        Ok(RV::Void)
    });
}
