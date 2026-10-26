//! Press-to-bind: [`start_rebind`] waits for the next input on a device family and rebinds the
//! action's first binding of that family ([`ActionMap::rebind`]). Esc cancels (keyboard and
//! gamepad), as does a 6 s timeout. While waiting, the exclusive "rebind" context is on, so
//! nothing else reacts to the press.
//!
//! - Buttons: the next key / mouse button / pad button; keys pressed while Ctrl/Shift/Alt are
//!   held become chords ("Ctrl + S"); a modifier key alone binds on release.
//! - 2D actions on keyboard: four presses (up, down, left, right), or move the mouse
//!   (→ mouse motion). On a pad: deflect a stick, or press the d-pad.
//! - 1D actions: two presses (negative, positive) / the mouse wheel; a pad axis or trigger.
//!
//! The binding keeps the modifiers (deadzone, scale…) of the binding it replaces when both
//! read the same kind of input (stick → stick).

use bevy::input::gamepad::{Gamepad, GamepadAxis, GamepadButton};
use bevy::input::mouse::{AccumulatedMouseMotion, AccumulatedMouseScroll};
use bevy::prelude::*;

use super::binding::{Binding, Button, Device, Input, Stick};
use super::map::{ActionKind, ActionMap};

/// Pending press-to-bind.
#[derive(Resource, Default, Debug, Clone)]
pub struct RebindCapture {
    pub action: Option<&'static str>,
    pub device: Device,
    /// Keys collected so far for multi-key composites.
    pub keys: Vec<KeyCode>,
    /// Frames since start (inputs of the starting frame are ignored).
    frames: u32,
    secs: f32,
    /// The last finished rebind: (action, binding label, conflicting actions), or a cancel.
    pub last: Option<RebindResult>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RebindResult {
    Bound { action: &'static str, binding: String, conflicts: Vec<&'static str> },
    Cancelled { action: &'static str },
}

impl RebindCapture {
    pub fn is_capturing(&self) -> bool {
        self.action.is_some()
    }
    /// What to show while waiting ("Press a key for UP").
    pub fn prompt(&self, kind: ActionKind) -> &'static str {
        let dirs4 = ["Press a key for up", "Press a key for down", "Press a key for left", "Press a key for right"];
        let dirs2 = ["Press a key for negative", "Press a key for positive"];
        match (self.device, kind) {
            (Device::KeyboardMouse, ActionKind::Axis2d) => dirs4.get(self.keys.len()).copied().unwrap_or(""),
            (Device::KeyboardMouse, ActionKind::Axis1d) => dirs2.get(self.keys.len()).copied().unwrap_or(""),
            (Device::KeyboardMouse, ActionKind::Button) => "Press a key or mouse button",
            (Device::Gamepad, ActionKind::Button) => "Press a gamepad button",
            (Device::Gamepad, _) => "Move a stick or press the d-pad",
        }
    }
}

/// Wait for the next input on `device` and bind it to `action`.
pub fn start_rebind(world: &mut World, action: &str, device: Device) -> Result<(), String> {
    let name = {
        let map = world.get_resource::<ActionMap>().ok_or("no ActionMap")?;
        let a = map.get(action).ok_or_else(|| format!("unknown action `{action}`"))?;
        if !a.def.rebindable {
            return Err(format!("`{action}` is not rebindable"));
        }
        a.def.name
    };
    let mut c = world.get_resource_or_init::<RebindCapture>();
    *c = RebindCapture { action: Some(name), device, last: c.last.clone(), ..Default::default() };
    Ok(())
}

pub fn cancel_rebind(world: &mut World) {
    let mut c = world.get_resource_or_init::<RebindCapture>();
    if let Some(a) = c.action.take() {
        c.last = Some(RebindResult::Cancelled { action: a });
    }
}

const MODIFIER_KEYS: [KeyCode; 8] = [
    KeyCode::ShiftLeft,
    KeyCode::ShiftRight,
    KeyCode::ControlLeft,
    KeyCode::ControlRight,
    KeyCode::AltLeft,
    KeyCode::AltRight,
    KeyCode::SuperLeft,
    KeyCode::SuperRight,
];

/// Same kind of input (so modifiers carry over).
fn same_kind(a: &Input, b: &Input) -> bool {
    std::mem::discriminant(a) == std::mem::discriminant(b)
}

pub(crate) fn capture_rebind(
    keys: Option<Res<ButtonInput<KeyCode>>>,
    mouse: Option<Res<ButtonInput<MouseButton>>>,
    motion: Option<Res<AccumulatedMouseMotion>>,
    wheel: Option<Res<AccumulatedMouseScroll>>,
    pads: Query<&Gamepad>,
    time: Res<Time<Real>>,
    mut capture: ResMut<RebindCapture>,
    mut map: ResMut<ActionMap>,
    mut toasts: MessageWriter<crate::ui::toast::Toast>,
    mut state: ResMut<super::state::ActionState>,
) {
    let Some(action) = capture.action else { return };
    // Counters don't count as a change (the controls screen rebuilds on real changes only).
    let c = capture.bypass_change_detection();
    c.frames += 1;
    c.secs += time.delta_secs();
    if c.frames <= 1 {
        return;
    }
    let Some(kind) = map.get(action).map(|a| a.def.kind) else {
        capture.action = None;
        return;
    };
    let esc = keys.as_ref().is_some_and(|k| k.just_pressed(KeyCode::Escape));
    if esc || capture.secs > 6.0 {
        capture.action = None;
        capture.last = Some(RebindResult::Cancelled { action });
        return;
    }
    let mut found: Option<Input> = None;
    let mut chord: Vec<Button> = Vec::new();
    match capture.device {
        Device::KeyboardMouse => {
            let k = keys.as_deref();
            let pressed = k.and_then(|k| k.get_just_pressed().find(|c| !MODIFIER_KEYS.contains(c)).copied());
            let mod_released = k.and_then(|k| k.get_just_released().find(|c| MODIFIER_KEYS.contains(c)).copied());
            let held_mods: Vec<Button> = k.map_or(Vec::new(), |k| MODIFIER_KEYS.iter().filter(|m| k.pressed(**m)).map(|m| Button::Key(*m)).collect());
            let click = mouse.as_deref().and_then(|m| m.get_just_pressed().next().copied());
            match kind {
                ActionKind::Button => {
                    if let Some(code) = pressed {
                        found = Some(Input::Button(Button::Key(code)));
                        chord = held_mods;
                    } else if let Some(m) = click {
                        found = Some(Input::Button(Button::Mouse(m)));
                    } else if let Some(m) = mod_released {
                        found = Some(Input::Button(Button::Key(m)));
                    }
                }
                ActionKind::Axis2d | ActionKind::Axis1d => {
                    let need = if kind == ActionKind::Axis2d { 4 } else { 2 };
                    if let Some(code) = pressed.or(mod_released) {
                        capture.keys.push(code);
                    } else if capture.keys.is_empty() {
                        let m = motion.map_or(Vec2::ZERO, |m| m.delta);
                        let w = wheel.map_or(Vec2::ZERO, |w| w.delta);
                        if kind == ActionKind::Axis2d && m.length() > 40.0 {
                            found = Some(Input::MouseMotion);
                        } else if w != Vec2::ZERO {
                            found = Some(Input::MouseWheel);
                        }
                    }
                    if capture.keys.len() == need {
                        let ks = &capture.keys;
                        found = Some(if need == 4 {
                            Input::Keys4 { up: ks[0], down: ks[1], left: ks[2], right: ks[3] }
                        } else {
                            Input::KeyAxis { neg: ks[0], pos: ks[1] }
                        });
                    }
                }
            }
        }
        Device::Gamepad => {
            for g in &pads {
                let pressed = g.get_just_pressed().copied().find(|b| *b != GamepadButton::Select);
                let dpad = pressed.filter(|b| matches!(b, GamepadButton::DPadUp | GamepadButton::DPadDown | GamepadButton::DPadLeft | GamepadButton::DPadRight));
                found = match kind {
                    ActionKind::Button => pressed.map(|b| Input::Button(Button::Pad(b))),
                    ActionKind::Axis2d => {
                        if g.left_stick().length() > 0.6 {
                            Some(Input::Stick(Stick::Left))
                        } else if g.right_stick().length() > 0.6 {
                            Some(Input::Stick(Stick::Right))
                        } else {
                            dpad.map(|_| Input::DPad)
                        }
                    }
                    ActionKind::Axis1d => GamepadAxis::all()
                        .into_iter()
                        .find(|a| g.get(*a).is_some_and(|v| v.abs() > 0.6))
                        .map(Input::PadAxis)
                        .or_else(|| pressed.map(|b| Input::Button(Button::Pad(b)))),
                };
                if found.is_some() {
                    break;
                }
            }
        }
    }
    let Some(input) = found else { return };
    let dev = capture.device;
    let old = map.binding_for(action, dev).cloned();
    let modifiers = old.filter(|o| same_kind(&o.input, &input)).map(|o| o.modifiers).unwrap_or_default();
    let binding = Binding { input, chord, modifiers };
    let conflicts = map.conflicts(action, &binding);
    let label = binding.label();
    let _ = map.rebind(action, binding);
    // The key that was just bound is still down: don't fire the action on it.
    state.wait_for_release(action);
    let shown = map.get(action).map_or(action, |a| a.def.display_label());
    let msg = if conflicts.is_empty() {
        format!("{shown}: {label}")
    } else {
        format!("{shown}: {label} (also {})", conflicts.join(", "))
    };
    toasts.write(crate::ui::toast::Toast::new(msg));
    capture.action = None;
    capture.keys.clear();
    capture.last = Some(RebindResult::Bound { action, binding: map.binding_for(action, dev).map(|b| b.to_string()).unwrap_or_default(), conflicts });
}
