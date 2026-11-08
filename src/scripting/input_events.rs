//! Raw input events as values (Godot `InputEvent`), next to the action-based `_input`.
//!
//! A script defining `_input_event(ev)` gets every event, in reverse tree order, until one calls
//! `set_input_as_handled()`. Then, unless the GUI consumed it (a focused line edit takes the
//! keyboard, a hovered button / widget takes the pointer, see [`UiCapture`]), `_unhandled_input_event(ev)`.
//!
//! `ev` is a dictionary (`ev.type` or `ev["type"]`):
//!
//! | `type` | other fields |
//! |---|---|
//! | `"key"` | `keycode` (Bevy `KeyCode` name: `"KeyW"`, `"Space"`, `"ArrowLeft"`), `pressed`, `echo` (key repeat) |
//! | `"mouse_button"` | `button` (`"Left"`, `"Right"`, `"Middle"`, `"Back"`, `"Forward"`), `pressed`, `position` `Vec2` in window pixels |
//! | `"mouse_motion"` | `position` `Vec2`, `relative` `Vec2` |
//! | `"mouse_wheel"` | `delta` `Vec2` (notches for a wheel, pixels for a trackpad; `dy > 0` is up) |
//!
//! Also: `get_mouse_delta()` (motion summed over the last frame), `set_mouse_mode("visible" |
//! "hidden" | "captured")`, `get_mouse_mode()`, `is_mouse_button_pressed("Left")`.

use bevy::ecs::message::MessageCursor;
use bevy::input::ButtonState;
use bevy::input::keyboard::KeyboardInput;
use bevy::input::mouse::{MouseButtonInput, MouseMotion, MouseWheel};
use bevy::prelude::*;
use bevy::window::{CursorGrabMode, CursorOptions, PrimaryWindow};
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{s, world};
use super::ui_widgets::UiCapture;
use super::{ScriptCtx, ScriptSet, call_rv, give_back, take_list};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MouseMode {
    #[default]
    Visible,
    Hidden,
    Captured,
}

/// Mouse state for scripts.
#[derive(Resource, Default, Debug)]
pub struct ScriptMouse {
    pub mode: MouseMode,
    /// Relative motion summed over the last frame.
    pub delta: Vec2,
}

#[derive(Default)]
struct Cursors {
    key: MessageCursor<KeyboardInput>,
    button: MessageCursor<MouseButtonInput>,
    motion: MessageCursor<MouseMotion>,
    wheel: MessageCursor<MouseWheel>,
}

pub(super) fn plugin(app: &mut App) {
    app.init_resource::<ScriptMouse>().init_resource::<UiCapture>();
    macro_rules! msg {
        ($t:ty) => {
            if !app.world().contains_resource::<Messages<$t>>() {
                app.add_message::<$t>();
            }
        };
    }
    msg!(KeyboardInput);
    msg!(MouseButtonInput);
    msg!(MouseMotion);
    msg!(MouseWheel);
    app.add_systems(Update, deliver.after(super::input).in_set(ScriptSet::Events));
}

fn rv2(x: f32, y: f32) -> RV {
    RV::Vec2([x as f64, y as f64])
}

/// An event dictionary: `type` plus the fields of that type.
fn ev(ty: &str, fields: Vec<(&str, RV)>) -> RV {
    let mut pairs = vec![(RV::Str("type".into()), RV::Str(ty.into()))];
    pairs.extend(fields.into_iter().map(|(k, v)| (RV::Str(k.into()), v)));
    RV::dict(pairs)
}

fn cursor(world: &mut World) -> Vec2 {
    let mut q = world.query_filtered::<&Window, With<PrimaryWindow>>();
    q.iter(world).next().and_then(|w| w.cursor_position()).unwrap_or(Vec2::ZERO)
}

/// Which GUI resource consumes this kind of event.
#[derive(Clone, Copy)]
enum Kind {
    Key,
    Pointer,
}

fn deliver(world: &mut World, mut cur: Local<Cursors>) {
    let mut events: Vec<(Kind, RV)> = vec![];
    let pos = cursor(world);
    let mut delta = Vec2::ZERO;
    {
        if let Some(m) = world.get_resource::<Messages<KeyboardInput>>() {
            for k in cur.key.read(m) {
                let e = ev(
                    "key",
                    vec![("keycode", RV::Str(format!("{:?}", k.key_code))), ("pressed", RV::Bool(k.state == ButtonState::Pressed)), ("echo", RV::Bool(k.repeat))],
                );
                events.push((Kind::Key, e));
            }
        }
        if let Some(m) = world.get_resource::<Messages<MouseButtonInput>>() {
            for b in cur.button.read(m) {
                let e = ev(
                    "mouse_button",
                    vec![("button", RV::Str(format!("{:?}", b.button))), ("pressed", RV::Bool(b.state == ButtonState::Pressed)), ("position", rv2(pos.x, pos.y))],
                );
                events.push((Kind::Pointer, e));
            }
        }
        if let Some(m) = world.get_resource::<Messages<MouseMotion>>() {
            for mo in cur.motion.read(m) {
                delta += mo.delta;
                events.push((Kind::Pointer, ev("mouse_motion", vec![("position", rv2(pos.x, pos.y)), ("relative", rv2(mo.delta.x, mo.delta.y))])));
            }
        }
        if let Some(m) = world.get_resource::<Messages<MouseWheel>>() {
            for wh in cur.wheel.read(m) {
                events.push((Kind::Pointer, ev("mouse_wheel", vec![("delta", rv2(wh.x, wh.y))])));
            }
        }
    }
    world.resource_mut::<ScriptMouse>().delta = delta;
    if events.is_empty() {
        return;
    }
    let inputs = take_list(world, |h| h.input_event, |_| true);
    let unhandled: Vec<Entity> = {
        let l = take_list(world, |h| h.unhandled_event, |_| true);
        let v = l.clone();
        give_back(world, l);
        v
    };
    let cap = *world.resource::<UiCapture>();
    for (kind, ev) in events {
        world.resource_mut::<ScriptCtx>().handled = false;
        for &e in inputs.iter().rev() {
            let _ = call_rv(world, e, "_input_event", vec![ev.clone()]);
            if world.resource::<ScriptCtx>().handled {
                break;
            }
        }
        let consumed = match kind {
            Kind::Key => cap.keyboard,
            Kind::Pointer => cap.pointer,
        };
        if world.resource::<ScriptCtx>().handled || consumed {
            continue;
        }
        for &e in unhandled.iter().rev() {
            let _ = call_rv(world, e, "_unhandled_input_event", vec![ev.clone()]);
            if world.resource::<ScriptCtx>().handled {
                break;
            }
        }
    }
    give_back(world, inputs);
}

fn apply_mode(world: &mut World, mode: MouseMode) {
    world.resource_mut::<ScriptMouse>().mode = mode;
    let mut q = world.query_filtered::<&mut CursorOptions, With<PrimaryWindow>>();
    for mut c in q.iter_mut(world) {
        c.visible = mode == MouseMode::Visible;
        c.grab_mode = if mode == MouseMode::Captured { CursorGrabMode::Locked } else { CursorGrabMode::None };
    }
}

fn button_of(name: &str) -> Result<MouseButton, String> {
    Ok(match name {
        "Left" => MouseButton::Left,
        "Right" => MouseButton::Right,
        "Middle" => MouseButton::Middle,
        "Back" => MouseButton::Back,
        "Forward" => MouseButton::Forward,
        other => return Err(format!("unknown mouse button `{other}` (Left, Right, Middle, Back, Forward)")),
    })
}

pub(super) fn register(e: &mut Engine) {
    e.register("get_mouse_delta", |c, _| {
        let d = world(c)?.resource::<ScriptMouse>().delta;
        Ok(rv2(d.x, d.y))
    });
    e.register("set_mouse_mode", |c, a| {
        let w = world(c)?;
        let mode = match s(a.first().ok_or("usage: set_mouse_mode(\"visible\" | \"hidden\" | \"captured\")")?, "mode")? {
            "visible" => MouseMode::Visible,
            "hidden" => MouseMode::Hidden,
            "captured" => MouseMode::Captured,
            other => return Err(format!("unknown mouse mode `{other}` (visible, hidden, captured)")),
        };
        apply_mode(w, mode);
        Ok(RV::Void)
    });
    e.register("get_mouse_mode", |c, _| {
        Ok(RV::Str(
            match world(c)?.resource::<ScriptMouse>().mode {
                MouseMode::Visible => "visible",
                MouseMode::Hidden => "hidden",
                MouseMode::Captured => "captured",
            }
            .into(),
        ))
    });
    e.register("is_mouse_button_pressed", |c, a| {
        let b = button_of(s(a.first().ok_or("usage: is_mouse_button_pressed(\"Left\")")?, "button")?)?;
        Ok(RV::Bool(world(c)?.get_resource::<ButtonInput<MouseButton>>().is_some_and(|m| m.pressed(b))))
    });
}
