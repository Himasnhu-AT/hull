//! Smallest app the devtools drive: a counter that only advances while unpaused, two settings
//! rows, and the engine's devtools + trace plugins. `tests/control.rs` runs it headless with
//! `--control 0`.
//!
//! `base_app` stands in for `engine::app()` until the core stream lands it; swap it for
//! `engine::app(info())` and keep `ProbeGame`.
//!
//! ```text
//! cargo run --example devtools_probe -- --headless --control 0
//! ```

use std::time::Duration;

use bevy::app::ScheduleRunnerPlugin;
use bevy::input::InputPlugin;
use bevy::prelude::*;
use bevy::state::app::StatesPlugin;
use engine::GameInfo;
use engine::devtools::{AddControlCommand, DebugLines, DevtoolsPlugin, params};
use engine::flow::{AppState, Headless};
use engine::pause::{Paused, not_paused};
use engine::paths::DataDir;
use engine::settings::{FieldDef, FieldKind, RegisterSettings, SaveSettings};
use engine::ui::screens::{ScreenRequest, Screens};
use engine::ui::widgets::NavQueue;
use serde_json::{Value, json};

fn info() -> GameInfo {
    GameInfo::new("devtools_probe", "Devtools probe")
}

fn main() {
    base_app(info()).add_plugins(ProbeGame).run();
}

/// Stand-in for `engine::app()`: headless-capable minimal app with the engine resources the
/// devtools read.
fn base_app(info: GameInfo) -> App {
    let mut app = App::new();
    app.add_plugins((
        MinimalPlugins.set(ScheduleRunnerPlugin::run_loop(Duration::from_secs_f64(1.0 / 60.0))),
        StatesPlugin,
        InputPlugin,
    ));
    let data = std::env::var_os("DEVTOOLS_PROBE_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("devtools_probe"));
    let _ = std::fs::create_dir_all(&data);
    app.insert_resource(info)
        .insert_resource(DataDir(data))
        .insert_resource(Headless(true))
        .init_resource::<Paused>()
        .init_resource::<Screens>()
        .init_resource::<NavQueue>()
        .init_state::<AppState>()
        .add_message::<ScreenRequest>()
        .add_message::<SaveSettings>()
        .add_systems(Update, boot.run_if(in_state(AppState::Boot)))
        .add_plugins(DevtoolsPlugin);
    #[cfg(feature = "trace")]
    app.add_plugins(engine::trace::TracePlugin);
    app
}

fn boot(mut next: ResMut<NextState<AppState>>) {
    next.set(if engine::cli::has_flag("play") { AppState::InGame } else { AppState::MainMenu });
}

struct ProbeGame;

#[derive(Resource, Default)]
struct Probe {
    /// Frames run in game while unpaused.
    ticks: u64,
    saves: u32,
    volume: f32,
    fancy: bool,
}

impl Plugin for ProbeGame {
    fn build(&self, app: &mut App) {
        app.init_resource::<Probe>()
            .add_systems(Update, (tick.run_if(in_state(AppState::InGame)).run_if(not_paused), count_saves, lines))
            .register_setting(FieldDef {
                key: "probe.volume",
                tab: "Audio",
                label: "Probe volume",
                hint: "",
                kind: FieldKind::Slider { min: 0.0, max: 1.0, step: 0.05, format: |v| format!("{:.0}%", v * 100.0) },
                get: |w| w.resource::<Probe>().volume,
                set: |w, v| w.resource_mut::<Probe>().volume = v.clamp(0.0, 1.0),
            })
            .register_setting(FieldDef {
                key: "probe.fancy",
                tab: "Video",
                label: "Fancy",
                hint: "",
                kind: FieldKind::Toggle,
                get: |w| w.resource::<Probe>().fancy as u8 as f32,
                set: |w, v| w.resource_mut::<Probe>().fancy = v >= 0.5,
            })
            .add_control_command("probe.state", "Probe counters and pressed keys", params(&[]), probe_state);
    }
}

fn tick(mut p: ResMut<Probe>) {
    p.ticks += 1;
}

fn count_saves(mut saves: MessageReader<SaveSettings>, mut p: ResMut<Probe>) {
    let n = saves.read().count() as u32;
    if n > 0 {
        p.saves += n;
    }
}

fn lines(p: Res<Probe>, mut d: ResMut<DebugLines>) {
    if p.is_changed() {
        d.set("probe", format!("probe ticks {}", p.ticks));
    }
}

fn probe_state(world: &mut World, _: Value) -> Result<Value, String> {
    let keys: Vec<String> = world
        .get_resource::<ButtonInput<KeyCode>>()
        .map(|k| k.get_pressed().map(|k| format!("{k:?}")).collect())
        .unwrap_or_default();
    let p = world.resource::<Probe>();
    Ok(json!({"ticks": p.ticks, "saves": p.saves, "volume": p.volume, "fancy": p.fancy, "keys": keys}))
}
