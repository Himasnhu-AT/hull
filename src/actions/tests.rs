//! Evaluation tests on hand-built device state (no app).

use bevy::input::gamepad::{Gamepad, GamepadButton, GamepadInput};
use bevy::prelude::*;

use super::state::{Devices, Pads};
use super::*;
use super::binding::Button;

struct Rig {
    map: ActionMap,
    ctx: InputContexts,
    state: ActionState,
    keys: ButtonInput<KeyCode>,
    pad: Gamepad,
    first: bool,
}

impl Rig {
    fn new(defs: Vec<ActionDef>) -> Self {
        let mut map = ActionMap::default();
        let mut ctx = InputContexts::default();
        for d in defs {
            if ctx.index(d.context).is_none() {
                ctx.define(d.context, 0, false);
            }
            map.add(d);
        }
        ctx.set_active("gameplay", true);
        Rig { map, ctx, state: ActionState::default(), keys: ButtonInput::default(), pad: Gamepad::default(), first: true }
    }
    fn step(&mut self, dt: f32) {
        let pads = [(Entity::PLACEHOLDER, &self.pad)];
        let dev = Devices { keys: Some(&self.keys), mouse: None, motion: Vec2::ZERO, wheel: Vec2::ZERO, pads: Pads::Slice(&pads) };
        self.state.evaluate(&self.map, &self.ctx, &dev, dt, std::mem::take(&mut self.first));
        self.keys.clear();
        self.pad.digital_mut().clear();
    }
    fn press(&mut self, k: KeyCode) {
        self.keys.press(k);
    }
    fn release(&mut self, k: KeyCode) {
        self.keys.release(k);
    }
}

#[test]
fn buttons_axes_and_edges() {
    let mut r = Rig::new(vec![
        ActionDef::button("jump").bind(Binding::key(KeyCode::Space)).bind(Binding::pad(GamepadButton::South)),
        ActionDef::axis2d("move").bind(Binding::wasd()).bind(Binding::stick(Stick::Left).deadzone(0.2)),
    ]);
    r.step(0.016);
    assert!(!r.state.pressed("jump"));
    r.press(KeyCode::Space);
    r.press(KeyCode::KeyW);
    r.press(KeyCode::KeyD);
    r.step(0.016);
    assert!(r.state.just_pressed("jump") && r.state.pressed("jump"));
    let mv = r.state.axis2d("move");
    assert!((mv.length() - 1.0).abs() < 1e-5 && mv.x > 0.0 && mv.y > 0.0, "{mv}");
    r.step(0.016);
    assert!(r.state.pressed("jump") && !r.state.just_pressed("jump"));
    r.release(KeyCode::Space);
    r.step(0.016);
    assert!(r.state.just_released("jump") && !r.state.pressed("jump"));

    // Gamepad: stick beats keys when stronger, deadzone applied.
    r.release(KeyCode::KeyW);
    r.release(KeyCode::KeyD);
    r.pad.analog_mut().set(GamepadInput::Axis(GamepadAxis::LeftStickX), 0.1);
    r.step(0.016);
    assert_eq!(r.state.axis2d("move"), Vec2::ZERO, "inside the deadzone");
    r.pad.analog_mut().set(GamepadInput::Axis(GamepadAxis::LeftStickX), -0.6);
    r.step(0.016);
    let mv = r.state.axis2d("move");
    assert!((mv.x + 0.5).abs() < 1e-4, "{mv}");
    assert_eq!(r.state.get("move").unwrap().device, Device::Gamepad);
    r.pad.digital_mut().press(GamepadButton::South);
    r.step(0.016);
    assert!(r.state.just_pressed("jump"));
}

#[test]
fn triggers() {
    let k = KeyCode::KeyF;
    let mut r = Rig::new(vec![
        ActionDef::button("hold").bind(Binding::key(k)).trigger(Trigger::Hold { secs: 0.5 }),
        ActionDef::button("tap").bind(Binding::key(k)).trigger(Trigger::Tap { max_secs: 0.2 }).passthrough(),
        ActionDef::button("pressed").bind(Binding::key(k)).trigger(Trigger::Pressed).passthrough(),
        ActionDef::button("released").bind(Binding::key(k)).trigger(Trigger::Released).passthrough(),
        ActionDef::button("double").bind(Binding::key(k)).trigger(Trigger::DoubleTap { window: 0.35 }).passthrough(),
        ActionDef::button("toggle").bind(Binding::key(k)).trigger(Trigger::Toggle).passthrough(),
    ]);
    r.step(0.1);
    r.press(k);
    r.step(0.1);
    assert!(r.state.pressed("pressed") && r.state.pressed("toggle") && !r.state.pressed("hold"));
    r.step(0.1);
    assert!(!r.state.pressed("pressed"), "pressed lasts one frame");
    r.release(k);
    r.step(0.1);
    assert!(r.state.pressed("tap") && r.state.pressed("released"), "short press = tap");
    assert!(r.state.pressed("toggle"), "toggle stays on");
    // Second press within the window: double tap; toggle goes off.
    r.press(k);
    r.step(0.1);
    assert!(r.state.pressed("double") && !r.state.pressed("toggle"));
    // Long hold: hold fires after 0.5 s, no tap on release.
    for _ in 0..6 {
        r.step(0.1);
    }
    assert!(r.state.pressed("hold"));
    r.release(k);
    r.step(0.1);
    assert!(!r.state.pressed("tap") && !r.state.pressed("hold"));
}

#[test]
fn contexts_priority_consume_and_exclusive() {
    let mut r = Rig::new(vec![
        ActionDef::axis2d("move").bind(Binding::wasd()),
        ActionDef::axis2d("steer").context("vehicle").bind(Binding::wasd()),
        ActionDef::button("accept").context("menu").bind(Binding::key(KeyCode::Enter)),
        ActionDef::button("jump").bind(Binding::key(KeyCode::Enter)),
    ]);
    r.ctx.define("vehicle", 10, false);
    r.press(KeyCode::KeyW);
    r.step(0.016);
    assert_eq!(r.state.axis2d("move"), Vec2::Y);
    // Vehicle over gameplay consumes WASD.
    r.ctx.push("vehicle");
    r.step(0.016);
    assert_eq!(r.state.axis2d("steer"), Vec2::Y);
    assert_eq!(r.state.axis2d("move"), Vec2::ZERO, "consumed by the vehicle context");
    r.ctx.pop("vehicle");
    // Axes resume at once when their context comes back.
    r.step(0.016);
    assert_eq!(r.state.axis2d("move"), Vec2::Y);
    // Enter held in gameplay (jump), then the exclusive menu opens: hides gameplay entirely,
    // and the held Enter must not count as a fresh "accept".
    r.press(KeyCode::Enter);
    r.step(0.016);
    assert!(r.state.just_pressed("jump"));
    r.ctx.set_active("menu", true);
    r.step(0.016);
    assert!(!r.state.pressed("accept"), "button held across the switch waits for a release");
    assert!(!r.state.pressed("jump") && r.state.axis2d("move") == Vec2::ZERO);
    assert!(!r.ctx.is_live("gameplay") && r.ctx.is_live("menu"));
    r.release(KeyCode::Enter);
    r.step(0.016);
    r.press(KeyCode::Enter);
    r.step(0.016);
    assert!(r.state.just_pressed("accept"));
}

#[test]
fn chords_shadow_plain_bindings_and_requires() {
    let mut r = Rig::new(vec![
        ActionDef::button("next").bind(Binding::key(KeyCode::Tab)),
        ActionDef::button("prev").bind(Binding::key(KeyCode::Tab).with(Button::Key(KeyCode::ShiftLeft))),
        ActionDef::button("aim").bind(Binding::mouse(MouseButton::Right)),
        ActionDef::button("fire").bind(Binding::key(KeyCode::KeyF)).requires("aim"),
    ]);
    r.press(KeyCode::Tab);
    r.step(0.016);
    assert!(r.state.pressed("next") && !r.state.pressed("prev"));
    r.release(KeyCode::Tab);
    r.step(0.016);
    r.press(KeyCode::ShiftLeft);
    r.press(KeyCode::Tab);
    r.step(0.016);
    assert!(r.state.pressed("prev") && !r.state.pressed("next"), "Shift+Tab shadows Tab");
    r.press(KeyCode::KeyF);
    r.step(0.016);
    assert!(!r.state.pressed("fire"), "fire requires aim");
}

#[test]
fn rebind_conflicts_reset_and_persist() {
    let mut map = ActionMap::default();
    map.add(ActionDef::button("jump").bind(Binding::key(KeyCode::Space)).bind(Binding::pad(GamepadButton::South)));
    map.add(ActionDef::button("crouch").bind(Binding::key(KeyCode::KeyC)));
    let b = Binding::key(KeyCode::KeyC);
    assert_eq!(map.conflicts("jump", &b), vec!["crouch"]);
    map.rebind("jump", b).unwrap();
    assert_eq!(map.get("jump").unwrap().def.bindings, vec![Binding::key(KeyCode::KeyC), Binding::pad(GamepadButton::South)]);
    map.rebind("jump", Binding::pad(GamepadButton::North)).unwrap();
    assert_eq!(map.prompt("jump", Device::Gamepad), "Y");
    let saved = InputSettings::from_map(&map);
    assert_eq!(saved.bindings["jump"], vec!["key:KeyC".to_string(), "pad:North".into()]);
    assert!(!saved.bindings.contains_key("crouch"), "unchanged actions are not saved");

    let mut fresh = ActionMap::default();
    fresh.add(ActionDef::button("jump").bind(Binding::key(KeyCode::Space)));
    saved.apply(&mut fresh);
    assert_eq!(fresh.get("jump").unwrap().def.bindings[1], Binding::pad(GamepadButton::North));
    fresh.reset("jump").unwrap();
    assert_eq!(fresh.get("jump").unwrap().def.bindings, vec![Binding::key(KeyCode::Space)]);
}

#[test]
fn toggle_mode_from_accessibility() {
    let mut r = Rig::new(vec![ActionDef::button("sprint").toggleable().bind(Binding::key(KeyCode::ShiftLeft))]);
    r.map.get_mut("sprint").unwrap().toggle_mode = true;
    r.press(KeyCode::ShiftLeft);
    r.step(0.016);
    r.release(KeyCode::ShiftLeft);
    r.step(0.016);
    assert!(r.state.pressed("sprint"), "toggle keeps it on after release");
    let a = Accessibility { toggle: true, ..default() };
    assert!(a.toggles("sprint"));
    let a = Accessibility { reduce_motion: true, ..default() };
    assert_eq!(a.shake_scale(), 0.0);
}


/// `cargo test --lib actions::tests::eval_cost -- --ignored --nocapture`: per-frame cost of
/// evaluating many actions (numbers in docs/ACTIONS.md).
#[test]
#[ignore]
fn eval_cost() {
    for n in [16usize, 64, 256] {
        let keys = [KeyCode::KeyA, KeyCode::KeyB, KeyCode::KeyC, KeyCode::KeyD, KeyCode::KeyE, KeyCode::KeyF];
        let defs = (0..n)
            .map(|i| {
                let name: &'static str = Box::leak(format!("a{i}").into_boxed_str());
                let d = if i % 4 == 0 {
                    ActionDef::axis2d(name).bind(Binding::wasd()).bind(Binding::stick(Stick::Left).deadzone(0.2))
                } else {
                    ActionDef::button(name).bind(Binding::key(keys[i % keys.len()])).bind(Binding::pad(GamepadButton::South))
                };
                if i % 3 == 0 { d.context("menu") } else { d }
            })
            .collect();
        let mut r = Rig::new(defs);
        r.press(KeyCode::KeyW);
        r.press(KeyCode::KeyA);
        r.step(0.016);
        let frames = 20_000;
        let t = std::time::Instant::now();
        for _ in 0..frames {
            r.step(0.016);
        }
        let us = t.elapsed().as_secs_f64() * 1e6 / frames as f64;
        eprintln!("{n} actions: {us:.2} us/frame");
    }
}
