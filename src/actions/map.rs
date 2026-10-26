//! Action definitions ([`ActionDef`], [`ActionMap`]) and input contexts ([`InputContexts`]).

use bevy::platform::collections::HashMap;
use bevy::prelude::*;

use super::binding::{Binding, Device, Modifier};

/// What an action's value means.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ActionKind {
    /// On/off (value.x 0..1).
    #[default]
    Button,
    /// One axis (value.x -1..1, or unbounded for mouse/wheel).
    Axis1d,
    /// Two axes (value x/y).
    Axis2d,
}

impl ActionKind {
    pub fn name(self) -> &'static str {
        match self {
            ActionKind::Button => "button",
            ActionKind::Axis1d => "axis1d",
            ActionKind::Axis2d => "axis2d",
        }
    }
}

/// When an action counts as active, from its (combined, modified) input.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum Trigger {
    /// Active while the input is actuated (the default).
    #[default]
    Down,
    /// Active for one frame when the input goes down.
    Pressed,
    /// Active for one frame when the input goes up.
    Released,
    /// Active (every frame) once held for `secs`.
    Hold { secs: f32 },
    /// Active for one frame on release if it was held at most `max_secs`.
    Tap { max_secs: f32 },
    /// Active for one frame on the second press within `window` seconds.
    DoubleTap { window: f32 },
    /// Each press flips it on/off (also what the accessibility "toggle" option switches
    /// `toggleable` actions to).
    Toggle,
}

/// One named action. Build with [`ActionDef::new`] and the builder methods, then
/// `app.add_action(def)`.
#[derive(Clone, Debug)]
pub struct ActionDef {
    /// Stable id: control port, settings.json, `ActionState::pressed("jump")`.
    pub name: &'static str,
    /// Shown on the rebinding screen ("" = the name).
    pub label: &'static str,
    pub kind: ActionKind,
    /// Context the action lives in (e.g. "gameplay", "menu", "vehicle").
    pub context: &'static str,
    pub bindings: Vec<Binding>,
    /// Applied after the binding's own modifiers.
    pub modifiers: Vec<Modifier>,
    pub trigger: Trigger,
    /// Only active while this other action is active (a chorded action, e.g. "aim" + "fire").
    pub requires: Option<&'static str>,
    /// Magnitude at which the input counts as actuated (default 0.5 for buttons, tiny for axes).
    pub actuation: f32,
    /// Shown on the rebinding screen.
    pub rebindable: bool,
    /// The accessibility "toggle instead of hold" option applies to it (sprint, crouch, aim).
    pub toggleable: bool,
    /// While active, its inputs are hidden from lower-priority contexts (Unreal's "consume").
    pub consume: bool,
    /// Group heading on the rebinding screen ("Movement", "Combat").
    pub group: &'static str,
}

impl ActionDef {
    pub fn new(name: &'static str, kind: ActionKind) -> Self {
        ActionDef {
            name,
            label: "",
            kind,
            context: "gameplay",
            bindings: Vec::new(),
            modifiers: Vec::new(),
            trigger: Trigger::Down,
            requires: None,
            actuation: if kind == ActionKind::Button { 0.5 } else { 1e-4 },
            rebindable: true,
            toggleable: false,
            consume: true,
            group: "",
        }
    }
    pub fn button(name: &'static str) -> Self {
        Self::new(name, ActionKind::Button)
    }
    pub fn axis1d(name: &'static str) -> Self {
        Self::new(name, ActionKind::Axis1d)
    }
    pub fn axis2d(name: &'static str) -> Self {
        Self::new(name, ActionKind::Axis2d)
    }
    pub fn label(mut self, l: &'static str) -> Self {
        self.label = l;
        self
    }
    pub fn context(mut self, c: &'static str) -> Self {
        self.context = c;
        self
    }
    pub fn bind(mut self, b: Binding) -> Self {
        self.bindings.push(b);
        self
    }
    pub fn modifier(mut self, m: Modifier) -> Self {
        self.modifiers.push(m);
        self
    }
    pub fn trigger(mut self, t: Trigger) -> Self {
        self.trigger = t;
        self
    }
    pub fn requires(mut self, other: &'static str) -> Self {
        self.requires = Some(other);
        self
    }
    pub fn actuation(mut self, a: f32) -> Self {
        self.actuation = a;
        self
    }
    pub fn fixed(mut self) -> Self {
        self.rebindable = false;
        self
    }
    pub fn toggleable(mut self) -> Self {
        self.toggleable = true;
        self
    }
    pub fn passthrough(mut self) -> Self {
        self.consume = false;
        self
    }
    pub fn group(mut self, g: &'static str) -> Self {
        self.group = g;
        self
    }
    pub fn display_label(&self) -> &'static str {
        if self.label.is_empty() { self.name } else { self.label }
    }
}

/// A registered action: the def plus its default bindings (for "reset") and runtime options.
#[derive(Clone, Debug)]
pub struct Action {
    pub def: ActionDef,
    pub defaults: Vec<Binding>,
    /// Accessibility: hold → toggle (only for `toggleable` actions).
    pub toggle_mode: bool,
    /// User multiplier on the value (axes), persisted with the bindings.
    pub sensitivity: f32,
}

impl Action {
    pub fn trigger(&self) -> Trigger {
        if self.toggle_mode && self.def.toggleable { Trigger::Toggle } else { self.def.trigger }
    }
}

/// Every action, in registration order. Index = [`ActionId`].
#[derive(Resource, Clone, Debug, Default)]
pub struct ActionMap {
    pub(crate) actions: Vec<Action>,
    pub(crate) by_name: HashMap<&'static str, usize>,
}

/// Index of an action (stable once registered); faster than looking up by name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ActionId(pub usize);

impl ActionMap {
    /// Add or replace (same name) an action. Its context must exist in [`InputContexts`] by the
    /// first update (unknown contexts are created with priority 0).
    pub fn add(&mut self, def: ActionDef) -> ActionId {
        let action = Action { defaults: def.bindings.clone(), def, toggle_mode: false, sensitivity: 1.0 };
        match self.by_name.get(action.def.name) {
            Some(&i) => {
                self.actions[i] = action;
                ActionId(i)
            }
            None => {
                let i = self.actions.len();
                self.by_name.insert(action.def.name, i);
                self.actions.push(action);
                ActionId(i)
            }
        }
    }
    pub fn id(&self, name: &str) -> Option<ActionId> {
        self.by_name.get(name).map(|i| ActionId(*i))
    }
    pub fn get(&self, name: &str) -> Option<&Action> {
        self.by_name.get(name).map(|i| &self.actions[*i])
    }
    pub fn get_mut(&mut self, name: &str) -> Option<&mut Action> {
        let i = *self.by_name.get(name)?;
        Some(&mut self.actions[i])
    }
    pub fn iter(&self) -> impl Iterator<Item = &Action> {
        self.actions.iter()
    }
    pub fn len(&self) -> usize {
        self.actions.len()
    }
    pub fn is_empty(&self) -> bool {
        self.actions.is_empty()
    }

    /// Replace all bindings of `action`.
    pub fn set_bindings(&mut self, action: &str, bindings: Vec<Binding>) -> Result<(), String> {
        let a = self.get_mut(action).ok_or_else(|| format!("unknown action `{action}`"))?;
        a.def.bindings = bindings;
        Ok(())
    }

    /// Replace the first binding of `binding`'s device family (keyboard/mouse or gamepad) —
    /// what the rebinding screen does — or append one if the action has none for that device.
    pub fn rebind(&mut self, action: &str, binding: Binding) -> Result<(), String> {
        let a = self.get_mut(action).ok_or_else(|| format!("unknown action `{action}`"))?;
        let dev = binding.device();
        match a.def.bindings.iter_mut().find(|b| b.device() == dev) {
            Some(slot) => *slot = binding,
            None => a.def.bindings.push(binding),
        }
        Ok(())
    }

    /// Remove every binding of one device family (e.g. "unbind on gamepad").
    pub fn clear_device(&mut self, action: &str, dev: Device) -> Result<(), String> {
        let a = self.get_mut(action).ok_or_else(|| format!("unknown action `{action}`"))?;
        a.def.bindings.retain(|b| b.device() != dev);
        Ok(())
    }

    /// Back to the bindings the action was defined with.
    pub fn reset(&mut self, action: &str) -> Result<(), String> {
        let a = self.get_mut(action).ok_or_else(|| format!("unknown action `{action}`"))?;
        a.def.bindings = a.defaults.clone();
        a.sensitivity = 1.0;
        Ok(())
    }

    pub fn reset_all(&mut self) {
        for a in &mut self.actions {
            a.def.bindings = a.defaults.clone();
            a.sensitivity = 1.0;
        }
    }

    /// Other actions in the same context (or a context that is never exclusive of it — the
    /// engine treats same-context as the conflict domain) that a binding would collide with.
    pub fn conflicts(&self, action: &str, binding: &Binding) -> Vec<&'static str> {
        let Some(me) = self.get(action) else { return Vec::new() };
        self.actions
            .iter()
            .filter(|a| a.def.name != action && a.def.context == me.def.context)
            .filter(|a| a.def.bindings.iter().any(|b| b.overlaps(binding)))
            .map(|a| a.def.name)
            .collect()
    }

    /// First binding of a device family, for prompts ("Jump: Space" / "Jump: A").
    pub fn binding_for(&self, action: &str, dev: Device) -> Option<&Binding> {
        self.get(action)?.def.bindings.iter().find(|b| b.device() == dev)
    }

    /// Prompt label for an action on a device ("Space", "A"), or "—" when unbound.
    pub fn prompt(&self, action: &str, dev: Device) -> String {
        self.binding_for(action, dev).map_or_else(|| "\u{2014}".to_string(), Binding::label)
    }
}

/// One input context. Higher `priority` is evaluated first; an `exclusive` active context
/// hides every lower one entirely; otherwise lower contexts still run but can't use inputs a
/// higher one consumed this frame.
#[derive(Clone, Debug)]
pub struct InputContext {
    pub name: &'static str,
    pub priority: i32,
    pub exclusive: bool,
    pub active: bool,
    /// Managed by the engine (menu/gameplay follow the UI and `AppState`); set `auto = false`
    /// to drive it yourself.
    pub auto: bool,
}

/// The context stack. Engine contexts: "global" (1000, always on), "rebind" (2000, exclusive,
/// on while the rebinding screen waits for a press), "menu" (100, exclusive, on while any
/// screen is open), "gameplay" (0, on in `AppState::InGame` while no screen is open). Games
/// add their own (`"vehicle"` at 10 over gameplay) and push/pop them.
#[derive(Resource, Clone, Debug)]
pub struct InputContexts {
    pub(crate) list: Vec<InputContext>,
    pub(crate) generation: u32,
}

impl Default for InputContexts {
    fn default() -> Self {
        let mut c = InputContexts { list: Vec::new(), generation: 0 };
        c.define("global", 1000, false).set_active("global", true);
        c.define("rebind", 2000, true);
        c.define("menu", 100, true);
        c.define("gameplay", 0, false);
        for n in ["menu", "gameplay"] {
            if let Some(x) = c.list.iter_mut().find(|x| x.name == n) {
                x.auto = true;
            }
        }
        c
    }
}

impl InputContexts {
    /// Add (or redefine) a context, inactive.
    pub fn define(&mut self, name: &'static str, priority: i32, exclusive: bool) -> &mut Self {
        match self.list.iter_mut().find(|c| c.name == name) {
            Some(c) => {
                c.priority = priority;
                c.exclusive = exclusive;
            }
            None => self.list.push(InputContext { name, priority, exclusive, active: false, auto: false }),
        }
        self.list.sort_by_key(|c| std::cmp::Reverse(c.priority));
        self.generation += 1;
        self
    }
    /// Activate a context (e.g. entering a vehicle). Unknown names are created at priority 10.
    pub fn push(&mut self, name: &'static str) -> &mut Self {
        if !self.list.iter().any(|c| c.name == name) {
            self.define(name, 10, false);
        }
        self.set_active(name, true)
    }
    pub fn pop(&mut self, name: &str) -> &mut Self {
        self.set_active(name, false)
    }
    pub fn set_active(&mut self, name: &str, on: bool) -> &mut Self {
        if let Some(c) = self.list.iter_mut().find(|c| c.name == name)
            && c.active != on
        {
            c.active = on;
        }
        self
    }
    /// Stop the engine from driving a context ("menu"/"gameplay").
    pub fn set_auto(&mut self, name: &str, auto: bool) -> &mut Self {
        if let Some(c) = self.list.iter_mut().find(|c| c.name == name) {
            c.auto = auto;
        }
        self
    }
    pub fn is_active(&self, name: &str) -> bool {
        self.list.iter().any(|c| c.name == name && c.active)
    }
    /// Whether actions in `name` are evaluated now (active and not under an exclusive context).
    pub fn is_live(&self, name: &str) -> bool {
        for c in &self.list {
            if c.name == name {
                return c.active;
            }
            if c.active && c.exclusive {
                return false;
            }
        }
        false
    }
    pub fn iter(&self) -> impl Iterator<Item = &InputContext> {
        self.list.iter()
    }
    pub(crate) fn index(&self, name: &str) -> Option<usize> {
        self.list.iter().position(|c| c.name == name)
    }
}
