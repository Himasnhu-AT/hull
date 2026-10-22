//! Runs `examples/minimal.rs` headless via `App::update()` (no process, no window).

#[path = "../examples/minimal.rs"]
#[allow(dead_code)]
mod minimal;

use std::path::{Path, PathBuf};
use std::time::Duration;

use engine::prelude::*;
use engine::settings::SettingsStore;

/// Fixed 60 Hz steps, independent of wall-clock speed.
const STEP: Duration = Duration::from_nanos(16_666_667);

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("engine-headless-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn build(dir: &Path) -> App {
    let mut app = engine::app_with(minimal::info(), EngineOptions::headless_test(dir));
    app.add_plugins(minimal::MinimalGame)
        .insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(STEP));
    app.finish();
    app.cleanup();
    app
}

fn run(app: &mut App, frames: usize) {
    for _ in 0..frames {
        app.update();
    }
}

fn saved_core(dir: &Path) -> serde_json::Value {
    let text = std::fs::read_to_string(dir.join("settings.json")).expect("settings.json written");
    serde_json::from_str::<serde_json::Value>(&text).unwrap()["core"].clone()
}

#[test]
fn minimal_runs_headless_into_game() {
    let dir = temp_dir("flow");
    let mut app = build(&dir);
    run(&mut app, 120);
    assert_eq!(*app.world().resource::<State<AppState>>().get(), AppState::InGame);
    assert!(app.world().resource::<Headless>().0);
    assert!(app.world().resource::<Volumes>().muted, "headless is silent");
    assert_eq!(app.world().resource::<DataDir>().0, dir);

    // Pause freezes virtual time; leaving InGame unpauses.
    let t0 = app.world().resource::<Time<Virtual>>().elapsed();
    app.world_mut().run_system_cached(|mut p: PauseCtl| p.set(true)).unwrap();
    run(&mut app, 10);
    assert_eq!(app.world().resource::<Time<Virtual>>().elapsed(), t0);
    app.world_mut().resource_mut::<NextState<AppState>>().set(AppState::MainMenu);
    run(&mut app, 2);
    assert!(!app.world().resource::<Paused>().0);

    #[cfg(feature = "fps")]
    {
        // Back in game, the controller fell onto the ground and stands there.
        app.world_mut().resource_mut::<NextState<AppState>>().set(AppState::InGame);
        run(&mut app, 120);
        let mut q = app.world_mut().query::<(&FpsMotor, &Transform, &FpsController)>();
        let (motor, tf, ctl) = q.single(app.world()).expect("one controller");
        assert!(motor.grounded, "controller grounded: {motor:?} at {:?}", tf.translation);
        assert!((tf.translation.y - ctl.height * 0.5).abs() < 0.1, "stands on the ground: y = {}", tf.translation.y);
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn settings_save_debounced_and_on_exit_then_reload() {
    let dir = temp_dir("settings");
    let mut app = build(&dir);
    run(&mut app, 5);
    assert!(!dir.join("settings.json").exists(), "nothing changed, nothing written");

    // Debounced save ~0.6 s (36 frames) after a change.
    app.world_mut().resource_mut::<CoreSettings>().sensitivity = 2.5;
    run(&mut app, 10);
    assert!(!dir.join("settings.json").exists(), "not yet: debounce");
    run(&mut app, 40);
    assert_eq!(saved_core(&dir)["sensitivity"], 2.5);

    // A change right before exit is flushed by AppExit.
    app.world_mut().resource_mut::<CoreSettings>().fov_deg = 101.0;
    app.update();
    app.world_mut().write_message(AppExit::Success);
    app.update();
    assert_eq!(saved_core(&dir)["fov_deg"], 101.0);
    assert!(!app.world().resource::<SettingsStore>().is_dirty());
    drop(app);

    // A new run loads them.
    let mut app = build(&dir);
    run(&mut app, 2);
    let s = app.world().resource::<CoreSettings>();
    assert_eq!((s.sensitivity, s.fov_deg), (2.5, 101.0));
    let _ = std::fs::remove_dir_all(dir);
}
