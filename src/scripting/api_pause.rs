//! Pause and processing host functions (Godot `get_tree().paused`, `process_mode`,
//! `set_process`). `[n,]` is the optional leading node (`self` when omitted).
//!
//! | Function | Does |
//! |---|---|
//! | `get_tree_paused()`, `set_tree_paused(bool)` | the game's pause (`Paused`, virtual and physics time) |
//! | `set_process_mode([n,] mode)`, `get_process_mode([n])` | `"inherit"`, `"pausable"`, `"when_paused"`, `"always"`, `"disabled"` (or Godot's ints 0..4) |
//! | `set_process([n,] bool)`, `set_physics_process([n,] bool)` | turn `_process` / `_physics_process` on or off for one instance |
//! | `is_processing([n])`, `is_physics_processing([n])` | the toggles (default on) |

use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{b, split, world};
use super::{ProcessMode, Script, ScriptProcessing};

/// Pause through [`crate::pause::PauseCtl`] (keeps physics time in step), else virtual time alone.
fn set_tree_paused(w: &mut World, on: bool) {
    if w.contains_resource::<crate::pause::Paused>() {
        let mut st = bevy::ecs::system::SystemState::<crate::pause::PauseCtl>::new(w);
        if let Ok(mut ctl) = st.get_mut(w) {
            ctl.set(on);
        }
    } else if on {
        w.resource_mut::<Time<Virtual>>().pause();
    } else {
        w.resource_mut::<Time<Virtual>>().unpause();
    }
}

fn set_processing(w: &mut World, t: Entity, physics: bool, on: bool) {
    let mut em = w.entity_mut(t);
    let mut p = em.get::<ScriptProcessing>().copied().unwrap_or_default();
    if physics {
        p.physics = on;
    } else {
        p.process = on;
    }
    em.insert(p);
}

pub(super) fn register(e: &mut Engine) {
    e.register("get_tree_paused", |c, _| Ok(RV::Bool(super::tree_paused(world(c)?))));
    e.register("set_tree_paused", |c, a| {
        let w = world(c)?;
        set_tree_paused(w, b(a.first().ok_or("usage: set_tree_paused(bool)")?, "paused")?);
        Ok(RV::Void)
    });
    e.register("set_process_mode", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_process_mode([node,] mode)")?;
        let mode = match &r[0] {
            RV::Str(n) => ProcessMode::from_name(n).ok_or_else(|| format!("unknown process mode `{n}` (inherit, pausable, when_paused, always, disabled)"))?,
            RV::Int(i) => ProcessMode::from_index(*i).ok_or_else(|| format!("process mode {i} out of range 0..4"))?,
            RV::Float(x) if x.fract() == 0.0 => ProcessMode::from_index(*x as i64).ok_or_else(|| format!("process mode {x} out of range 0..4"))?,
            other => return Err(format!("mode must be a str or int, got {}", other.type_name())),
        };
        if let Some(mut sc) = w.get_mut::<Script>(t) {
            sc.process_mode = mode;
        } else {
            w.entity_mut(t).insert(super::NodeProcessMode(mode));
        }
        Ok(RV::Void)
    });
    // The mode as set on the node (`inherit` is not resolved).
    e.register("get_process_mode", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_process_mode([node])")?;
        let m = w.get::<Script>(t).map(|s| s.process_mode).or_else(|| w.get::<super::NodeProcessMode>(t).map(|m| m.0)).unwrap_or(ProcessMode::Inherit);
        Ok(RV::Str(m.name().into()))
    });
    e.register("set_process", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_process([node,] bool)")?;
        set_processing(w, t, false, b(&r[0], "enable")?);
        Ok(RV::Void)
    });
    e.register("set_physics_process", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_physics_process([node,] bool)")?;
        set_processing(w, t, true, b(&r[0], "enable")?);
        Ok(RV::Void)
    });
    e.register("is_processing", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "is_processing([node])")?;
        Ok(RV::Bool(w.get::<ScriptProcessing>(t).is_none_or(|p| p.process)))
    });
    e.register("is_physics_processing", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "is_physics_processing([node])")?;
        Ok(RV::Bool(w.get::<ScriptProcessing>(t).is_none_or(|p| p.physics)))
    });
}
