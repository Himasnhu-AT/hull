//! Input actions from script (Godot's `InputMap`) and input contexts, plus the latch that makes
//! `is_action_just_pressed` / `_released` inside `_physics_process` fire exactly once.
//!
//! `add_action(name [, context])`, `has_action(name)`, `action_add_key(name, "KeyP")`,
//! `action_add_button(name, "South")` (gamepad), `action_add_mouse(name, "Left")`,
//! `push_input_context(name)`, `pop_input_context([name])`. Actions get the `"gameplay"` context
//! unless one is given; a new context is created on first use and is inactive until pushed.
//! Names are interned (leaked once per distinct name) because the action table wants `'static`.

use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{s, world};

/// Action edges seen since the last physics step, so a fixed step sees each edge exactly once even
/// when the frame ran zero or several fixed steps. `active` is true while `_physics_process` runs.
#[derive(Resource, Default)]
pub struct PhysicsEdges {
    pub pressed: Vec<String>,
    pub released: Vec<String>,
    pub active: bool,
}

/// Runs before the fixed loop of every frame (the action state was updated in `PreUpdate`).
#[cfg(feature = "actions")]
pub(super) fn latch_edges(map: Option<Res<crate::actions::ActionMap>>, state: Option<Res<crate::actions::ActionState>>, mut edges: ResMut<PhysicsEdges>) {
    let (Some(map), Some(state)) = (map, state) else { return };
    for (name, d) in state.iter(&map) {
        if d.just_pressed && !edges.pressed.iter().any(|n| n == name) {
            edges.pressed.push(name.to_string());
        }
        if d.just_released && !edges.released.iter().any(|n| n == name) {
            edges.released.push(name.to_string());
        }
    }
}

#[cfg(feature = "actions")]
mod imp {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};

    use super::*;
    use crate::actions::binding::{parse_key, parse_pad_button};
    use crate::actions::{ActionDef, ActionMap, Binding, InputContexts};

    fn intern(name: &str) -> &'static str {
        static NAMES: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
        let mut set = NAMES.get_or_init(Default::default).lock().unwrap();
        if let Some(n) = set.get(name) {
            return n;
        }
        let n: &'static str = Box::leak(name.to_string().into_boxed_str());
        set.insert(n);
        n
    }

    fn bind(w: &mut World, name: &str, b: Binding) -> Result<(), String> {
        let mut map = w.get_resource_mut::<ActionMap>().ok_or("no input actions in this app")?;
        let a = map.get_mut(name).ok_or_else(|| format!("unknown action `{name}` (add_action first)"))?;
        a.def.bindings.push(b.clone());
        a.defaults.push(b);
        Ok(())
    }

    pub fn register(e: &mut Engine) {
        e.register("add_action", |c, a| {
            let name = s(a.first().ok_or("usage: add_action(name [, context])")?, "name")?;
            let w = world(c)?;
            let mut def = ActionDef::button(intern(name));
            if let Some(ctx) = a.get(1) {
                def = def.context(intern(s(ctx, "context")?));
            }
            let ctx = def.context;
            w.get_resource_or_init::<InputContexts>();
            let mut contexts = w.resource_mut::<InputContexts>();
            if contexts.index(ctx).is_none() {
                contexts.define(ctx, 10, false);
            }
            let mut map = w.get_resource_or_init::<ActionMap>();
            if map.get(name).is_none() {
                map.add(def);
            }
            Ok(RV::Void)
        });
        e.register("has_action", |c, a| {
            let name = s(a.first().ok_or("usage: has_action(name)")?, "name")?;
            Ok(RV::Bool(world(c)?.get_resource::<ActionMap>().is_some_and(|m| m.get(name).is_some())))
        });
        e.register("action_add_key", |c, a| {
            if a.len() != 2 {
                return Err("usage: action_add_key(name, \"KeyP\")".into());
            }
            let k = s(&a[1], "key")?;
            let key = parse_key(k).ok_or_else(|| format!("unknown key `{k}` (KeyW, Space, ArrowLeft ...)"))?;
            bind(world(c)?, s(&a[0], "name")?, Binding::key(key))?;
            Ok(RV::Void)
        });
        e.register("action_add_button", |c, a| {
            if a.len() != 2 {
                return Err("usage: action_add_button(name, \"South\")".into());
            }
            let b = s(&a[1], "button")?;
            let btn = parse_pad_button(b).ok_or_else(|| format!("unknown gamepad button `{b}` (South, East, DPadUp, LeftTrigger ...)"))?;
            bind(world(c)?, s(&a[0], "name")?, Binding::pad(btn))?;
            Ok(RV::Void)
        });
        e.register("action_add_mouse", |c, a| {
            if a.len() != 2 {
                return Err("usage: action_add_mouse(name, \"Left\")".into());
            }
            let b = match s(&a[1], "button")? {
                "Left" => MouseButton::Left,
                "Right" => MouseButton::Right,
                "Middle" => MouseButton::Middle,
                "Back" => MouseButton::Back,
                "Forward" => MouseButton::Forward,
                other => return Err(format!("unknown mouse button `{other}` (Left, Right, Middle, Back, Forward)")),
            };
            bind(world(c)?, s(&a[0], "name")?, Binding::mouse(b))?;
            Ok(RV::Void)
        });
        e.register("push_input_context", |c, a| {
            let name = intern(s(a.first().ok_or("usage: push_input_context(name)")?, "name")?);
            let w = world(c)?;
            w.get_resource_or_init::<InputContexts>().push(name);
            w.get_resource_or_init::<ScriptContextStack>().0.push(name);
            Ok(RV::Void)
        });
        e.register("pop_input_context", |c, a| {
            let w = world(c)?;
            let name = match a.first() {
                Some(n) => intern(s(n, "name")?),
                None => w.get_resource_or_init::<ScriptContextStack>().0.pop().ok_or("pop_input_context: nothing was pushed")?,
            };
            if !a.is_empty() {
                w.get_resource_or_init::<ScriptContextStack>().0.retain(|n| *n != name);
            }
            w.get_resource_or_init::<InputContexts>().pop(name);
            Ok(RV::Void)
        });
    }

    /// Contexts pushed from script, so `pop_input_context()` pops the latest.
    #[derive(Resource, Default)]
    struct ScriptContextStack(Vec<&'static str>);
}

#[cfg(feature = "actions")]
pub(super) use imp::register;

#[cfg(not(feature = "actions"))]
pub(super) fn register(e: &mut Engine) {
    for name in ["add_action", "has_action", "action_add_key", "action_add_button", "action_add_mouse", "push_input_context", "pop_input_context"] {
        e.register(name, |_, _| Err("input actions need the `actions` feature".into()));
    }
}

