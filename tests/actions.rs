//! Actions, accessibility and localization on the real headless engine app (`App::update()`,
//! no window): injected keyboard and virtual-gamepad input → action values and contexts,
//! press-to-bind, persistence, rumble, control commands, language switching.
#![cfg(all(feature = "actions", feature = "l10n", feature = "devtools"))]

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use bevy::input::ButtonState;
use bevy::input::gamepad::{GamepadAxis, GamepadButton, GamepadRumbleRequest};
use bevy::input::keyboard::{Key, KeyboardInput};
use engine::actions::rebind::RebindResult;
use engine::actions::{Device, InputSettings, RebindCapture, start_rebind, virtual_pad};
use engine::l10n::{AddLocaleTable, PSEUDO};
use engine::prelude::*;

/// The localization view `tr()` reads is process-global: tests that build apps run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

const STEP: Duration = Duration::from_nanos(16_666_667);

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("engine-actions-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

struct TestGame;
impl Plugin for TestGame {
    fn build(&self, app: &mut App) {
        app.add_action(ActionDef::button("jump").label("Jump").group("Movement").bind(Binding::key(KeyCode::Space)).bind(Binding::pad(GamepadButton::South)))
            .add_action(
                ActionDef::axis2d("move")
                    .label("Move")
                    .group("Movement")
                    .bind(Binding::wasd())
                    .bind(Binding::stick(Stick::Left).deadzone(0.2)),
            )
            .add_action(ActionDef::button("sprint").label("Sprint").toggleable().bind(Binding::key(KeyCode::ShiftLeft)))
            .add_action(ActionDef::button("honk").context("vehicle").bind(Binding::key(KeyCode::Space)))
            .add_input_context("vehicle", 10, false);
    }
}

fn build(dir: &Path) -> App {
    let mut app = engine::app_with(GameInfo::new("engine-actions-test", "Actions"), EngineOptions::headless_test(dir));
    app.add_plugins(TestGame).insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(STEP));
    app.finish();
    app.cleanup();
    run(&mut app, 3);
    app
}

fn run(app: &mut App, n: usize) {
    for _ in 0..n {
        app.update();
    }
}

fn key(app: &mut App, code: KeyCode, down: bool) {
    let state = if down { ButtonState::Pressed } else { ButtonState::Released };
    app.world_mut().write_message(KeyboardInput {
        key_code: code,
        logical_key: Key::Unidentified(bevy::input::keyboard::NativeKey::Unidentified),
        state,
        text: None,
        repeat: false,
        window: Entity::PLACEHOLDER,
    });
}

fn actions(app: &App) -> &ActionState {
    app.world().resource::<ActionState>()
}

fn command(app: &mut App, id: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let reg = app.world().resource::<engine::devtools::ControlRegistry>().clone();
    let cmd = reg.get(id).unwrap_or_else(|| panic!("command {id} registered"));
    match cmd.handler {
        engine::devtools::control::Handler::Instant(f) => f(app.world_mut(), params),
        _ => panic!("{id} is deferred"),
    }
}

#[test]
fn keyboard_and_gamepad_drive_actions_and_contexts() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_dir("kb");
    let mut app = build(&dir);
    assert!(app.world().resource::<InputContexts>().is_live("gameplay"), "headless test boots InGame");

    // Keyboard.
    key(&mut app, KeyCode::Space, true);
    key(&mut app, KeyCode::KeyW, true);
    app.update();
    assert!(actions(&app).just_pressed("jump"));
    assert_eq!(actions(&app).axis2d("move"), Vec2::Y);
    app.update();
    assert!(actions(&app).pressed("jump") && !actions(&app).just_pressed("jump"));
    key(&mut app, KeyCode::Space, false);
    key(&mut app, KeyCode::KeyW, false);
    app.update();
    assert!(actions(&app).just_released("jump"));
    assert_eq!(actions(&app).axis2d("move"), Vec2::ZERO);

    // Virtual gamepad through Bevy's raw gamepad events.
    virtual_pad::button(app.world_mut(), GamepadButton::South, 1.0).unwrap();
    virtual_pad::axis(app.world_mut(), GamepadAxis::LeftStickY, 0.8).unwrap();
    app.update();
    assert!(actions(&app).just_pressed("jump"), "pad South → jump");
    let mv = actions(&app).axis2d("move");
    assert!(mv.y > 0.6 && mv.y <= 1.0, "stick past the deadzone: {mv}");
    assert_eq!(actions(&app).last_device, Device::Gamepad);
    virtual_pad::button(app.world_mut(), GamepadButton::South, 0.0).unwrap();
    virtual_pad::axis(app.world_mut(), GamepadAxis::LeftStickY, 0.1).unwrap();
    app.update();
    assert_eq!(actions(&app).axis2d("move"), Vec2::ZERO, "inside the deadzone");

    // A vehicle context over gameplay takes Space (consumed from gameplay).
    app.world_mut().resource_mut::<InputContexts>().push("vehicle");
    key(&mut app, KeyCode::Space, true);
    app.update();
    assert!(actions(&app).pressed("honk") && !actions(&app).pressed("jump"));
    key(&mut app, KeyCode::Space, false);
    app.world_mut().resource_mut::<InputContexts>().pop("vehicle");
    app.update();

    // Pause turns gameplay off.
    app.world_mut().run_system_cached(|mut p: PauseCtl| p.set(true)).unwrap();
    key(&mut app, KeyCode::KeyW, true);
    run(&mut app, 2);
    assert!(!app.world().resource::<InputContexts>().is_live("gameplay"));
    assert_eq!(actions(&app).axis2d("move"), Vec2::ZERO);
    app.world_mut().run_system_cached(|mut p: PauseCtl| p.set(false)).unwrap();
    run(&mut app, 2);
    assert_eq!(actions(&app).axis2d("move"), Vec2::Y, "axes resume while held");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn rebind_persists_and_press_to_bind() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_dir("rebind");
    let mut app = build(&dir);

    // Press-to-bind: wait, press F → jump's keyboard binding is F.
    start_rebind(app.world_mut(), "jump", Device::KeyboardMouse).unwrap();
    run(&mut app, 2);
    assert!(app.world().resource::<InputContexts>().is_live("rebind"));
    key(&mut app, KeyCode::KeyF, true);
    run(&mut app, 2);
    let cap = app.world().resource::<RebindCapture>();
    assert!(!cap.is_capturing());
    assert_eq!(cap.last, Some(RebindResult::Bound { action: "jump", binding: "key:KeyF".into(), conflicts: vec![] }));
    // The F still held must not fire jump right away.
    assert!(!actions(&app).just_pressed("jump"));
    key(&mut app, KeyCode::KeyF, false);
    app.update();
    key(&mut app, KeyCode::KeyF, true);
    app.update();
    assert!(actions(&app).just_pressed("jump"), "F jumps now");
    key(&mut app, KeyCode::KeyF, false);

    // Gamepad binding through the control command; conflicts are reported.
    let r = command(&mut app, "actions.bind", serde_json::json!({"action": "jump", "binding": "key:ShiftLeft"})).unwrap();
    assert_eq!(r["conflicts"], serde_json::json!(["sprint"]));
    command(&mut app, "actions.bind", serde_json::json!({"action": "jump", "binding": "pad:North"})).unwrap();
    let r = command(&mut app, "actions.list", serde_json::json!({})).unwrap();
    let jump = r["actions"].as_array().unwrap().iter().find(|a| a["name"] == "jump").unwrap().clone();
    assert_eq!(jump["bindings"], serde_json::json!(["key:ShiftLeft", "pad:North"]));

    // Saved (debounced) to settings.json "input", loaded by the next run.
    run(&mut app, 50);
    let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["input"]["bindings"]["jump"], serde_json::json!(["key:ShiftLeft", "pad:North"]));
    drop(app);
    let mut app = build(&dir);
    run(&mut app, 1);
    let jump = app.world().resource::<ActionMap>().get("jump").unwrap().def.bindings.clone();
    assert_eq!(jump, vec![Binding::key(KeyCode::ShiftLeft), Binding::pad(GamepadButton::North)]);
    // Reset → defaults, and the override disappears.
    command(&mut app, "actions.bind", serde_json::json!({"action": "jump", "reset": true})).unwrap();
    run(&mut app, 2);
    assert!(!app.world().resource::<InputSettings>().bindings.contains_key("jump"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn accessibility_toggle_rumble_and_commands() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_dir("a11y");
    let mut app = build(&dir);

    // Hold → toggle (the settings row) for toggleable actions.
    engine::ui::widgets::set_field(app.world_mut(), "toggle_actions", 1.0).unwrap();
    app.update();
    key(&mut app, KeyCode::ShiftLeft, true);
    app.update();
    key(&mut app, KeyCode::ShiftLeft, false);
    run(&mut app, 3);
    assert!(actions(&app).pressed("sprint"), "toggled on, stays on after release");
    key(&mut app, KeyCode::ShiftLeft, true);
    app.update();
    assert!(!actions(&app).pressed("sprint"), "second press turns it off");
    key(&mut app, KeyCode::ShiftLeft, false);

    // Reduce motion is readable by game systems.
    engine::ui::widgets::set_field(app.world_mut(), "reduce_motion", 1.0).unwrap();
    assert_eq!(app.world().resource::<Accessibility>().shake_scale(), 0.0);

    // Rumble: forwarded to the pad, scaled by the setting; 0 = off.
    let pad = virtual_pad::connect(app.world_mut());
    run(&mut app, 1);
    engine::ui::widgets::set_field(app.world_mut(), "rumble", 0.5).unwrap();
    app.world_mut().write_message(Rumble::new(1.0, 0.4, 0.2));
    app.update();
    let reqs: Vec<GamepadRumbleRequest> = app.world_mut().resource_mut::<Messages<GamepadRumbleRequest>>().drain().collect();
    assert_eq!(reqs.len(), 1);
    match &reqs[0] {
        GamepadRumbleRequest::Add { intensity, gamepad, .. } => {
            assert_eq!(*gamepad, pad);
            assert!((intensity.strong_motor - 0.5).abs() < 1e-5 && (intensity.weak_motor - 0.2).abs() < 1e-5);
        }
        _ => panic!("expected a rumble Add"),
    }
    engine::ui::widgets::set_field(app.world_mut(), "rumble", 0.0).unwrap();
    command(&mut app, "actions.rumble", serde_json::json!({})).unwrap();
    app.update();
    assert_eq!(app.world_mut().resource_mut::<Messages<GamepadRumbleRequest>>().drain().count(), 0);

    // input.gamepad + actions.state over the command layer.
    command(&mut app, "input.gamepad", serde_json::json!({"button": "a", "action": "down"})).unwrap();
    app.update();
    let s = command(&mut app, "actions.state", serde_json::json!({"action": "jump"})).unwrap();
    assert_eq!(s["actions"]["jump"]["active"], true);
    assert_eq!(s["last_device"], "pad");
    command(&mut app, "input.gamepad", serde_json::json!({"button": "a", "action": "up"})).unwrap();
    command(&mut app, "input.gamepad", serde_json::json!({"axis": "lx", "value": -1.0})).unwrap();
    app.update();
    let s = command(&mut app, "actions.state", serde_json::json!({"active": true})).unwrap();
    assert!(s["actions"]["move"]["value"][0].as_f64().unwrap() < -0.9, "{s}");
    assert!(s["actions"].get("jump").is_none(), "only active actions");
    let c = command(&mut app, "actions.context", serde_json::json!({"name": "vehicle", "on": true})).unwrap();
    assert!(c["contexts"].as_array().unwrap().iter().any(|x| x["name"] == "vehicle" && x["live"] == true));
    assert!(command(&mut app, "actions.bind", serde_json::json!({"action": "nope", "binding": "key:KeyF"})).is_err());
    assert!(command(&mut app, "actions.bind", serde_json::json!({"action": "jump", "binding": "key:Bogus"})).is_err());

    // Saved under "accessibility".
    run(&mut app, 50);
    let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["accessibility"]["toggle"], true);
    assert_eq!(saved["accessibility"]["reduce_motion"], true);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn localization_switch_fallback_pseudo_and_persist() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_dir("l10n");
    let mut app = build(&dir);
    app.add_locale_table("en", "hud-score = Score: { $n }\nhud-lives = { $n ->\n    [one] One life\n   *[other] { $n } lives\n}\nonly-en = Only in English\n");
    app.add_locale_table("de", "hud-score = Punkte: { $n }\nhud-lives = { $n ->\n    [one] Ein Leben\n   *[other] { $n } Leben\n}\n");
    app.world_mut().resource_mut::<Locale>().set("en").unwrap();
    app.update();
    assert_eq!(tr("menu-play"), "Play");
    assert_eq!(tr_args("hud-lives", &[("n", 1)]), "One life");
    assert_eq!(tr_args("hud-lives", &[("n", 3)]), "3 lives");

    // A Tr text follows the language.
    let e = app.world_mut().spawn((Text::default(), Tr::new("hud-score").arg("n", 12))).id();
    app.update();
    assert_eq!(app.world().get::<Text>(e).unwrap().0, "Score: 12");

    // Hot switch through the control command.
    command(&mut app, "l10n.set", serde_json::json!({"lang": "de"})).unwrap();
    app.update();
    assert_eq!(app.world().get::<Text>(e).unwrap().0, "Punkte: 12");
    assert_eq!(tr("menu-play"), "Spielen");
    assert_eq!(engine::ui::tl("Settings"), "Einstellungen", "engine literals translate");
    assert_eq!(engine::ui::tl("Score 999"), "Score 999", "unknown text is left alone");
    assert_eq!(tr_args("hud-lives", &[("n", 1)]), "Ein Leben");
    assert_eq!(tr("only-en"), "Only in English", "fallback language");
    assert_eq!(tr("no-such-key"), "no-such-key");
    let m = command(&mut app, "l10n.missing", serde_json::json!({})).unwrap();
    let runtime: Vec<String> = serde_json::from_value(m["runtime"].clone()).unwrap();
    assert!(runtime.contains(&"de:only-en".to_string()) && runtime.contains(&"de:no-such-key".to_string()), "{runtime:?}");
    assert!(m["untranslated"]["de"].as_array().unwrap().iter().any(|k| k == "only-en"));
    let t = command(&mut app, "l10n.tr", serde_json::json!({"key": "hud-lives", "args": {"n": 5}})).unwrap();
    assert_eq!(t["text"], "5 Leben");

    // Pseudo: accented, longer, bracketed; arguments intact.
    app.world_mut().resource_mut::<Locale>().set(PSEUDO).unwrap();
    app.update();
    let s = app.world().get::<Text>(e).unwrap().0.clone();
    assert!(s.starts_with('[') && s.contains("12") && s.chars().count() > "Score: 12".len(), "{s}");
    assert!(command(&mut app, "l10n.set", serde_json::json!({"lang": "klingon"})).is_err());

    // The language row and persistence.
    engine::ui::widgets::set_field(app.world_mut(), "language", 1.0).unwrap();
    app.update();
    let langs = command(&mut app, "l10n.list", serde_json::json!({})).unwrap();
    let second = langs["languages"][1]["code"].as_str().unwrap().to_string();
    assert_eq!(app.world().resource::<Locale>().lang(), second);
    command(&mut app, "l10n.set", serde_json::json!({"lang": "fr"})).unwrap();
    run(&mut app, 50);
    let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["locale"]["lang"], "fr");
    drop(app);
    let app = build(&dir);
    assert_eq!(app.world().resource::<Locale>().lang(), "fr");
    assert_eq!(tr("menu-resume"), "Reprendre");
    let _ = std::fs::remove_dir_all(dir);
}
