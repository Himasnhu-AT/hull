//! Bootstrap: [`app`] builds a Bevy `App` with the right plugin set for a windowed or
//! `--headless` run, plus [`EnginePlugin`]. Owner: core stream.
//!
//! - `--headless`: MinimalPlugins at 60 Hz + Log, Transform, Diagnostics, Asset, Mesh, Scene,
//!   WorldSerialization, States, Input plugins (no window/renderer/UI/audio).
//! - windowed: DefaultPlugins with the asset root from [`crate::paths::assets_dir`], title from
//!   [`GameInfo`], `--offscreen` → hidden window, `--control` → always-on-top window.
//! - `physics` feature: avian3d `PhysicsPlugins::default()`.
//!
//! Settings: `EnginePlugin` always loads/saves [`crate::settings::CoreSettings`]. A game with
//! its own settings adds `SettingsPlugin::<MySettings>::default()` after `app()`:
//! ```ignore
//! engine::app(GameInfo::new("orbs", "Orbs"))
//!     .add_plugins((engine::settings::SettingsPlugin::<OrbsSettings>::default(), OrbsPlugin))
//!     .run();
//! ```
//! Tests and tools that must not depend on the command line use [`app_with`] +
//! [`EngineOptions`] (e.g. `EngineOptions::headless_test(dir)`).

use std::path::PathBuf;
use std::time::Duration;

use bevy::app::ScheduleRunnerPlugin;
use bevy::prelude::*;

use crate::cli::{GameSeed, dev_flag};
use crate::flow::{AppState, Headless, SkipMenu};
use crate::paths::{AssetsDir, DataDir};

/// Who the game is. `id` names the data folder (`~/Library/Application Support/<id>`) and the
/// env overrides (`<ID>_DATA_DIR`, `<ID>_ASSETS`), uppercased.
#[derive(Resource, Clone, Debug)]
pub struct GameInfo {
    pub id: &'static str,
    pub title: &'static str,
    pub tagline: &'static str,
    pub version: &'static str,
    /// Fallback assets folder when not run from the workspace root or a bundle
    /// (games pass `concat!(env!("CARGO_MANIFEST_DIR"), "/assets")` or similar).
    pub assets_fallback: Option<&'static str>,
}

impl GameInfo {
    pub fn new(id: &'static str, title: &'static str) -> Self {
        GameInfo { id, title, tagline: "", version: env!("CARGO_PKG_VERSION"), assets_fallback: None }
    }
    pub fn tagline(mut self, t: &'static str) -> Self {
        self.tagline = t;
        self
    }
    pub fn version(mut self, v: &'static str) -> Self {
        self.version = v;
        self
    }
    pub fn assets_fallback(mut self, p: &'static str) -> Self {
        self.assets_fallback = Some(p);
        self
    }
}

/// How the engine boots. [`EngineOptions::from_args`] reads the command line (what [`app`]
/// uses); tests build one directly.
#[derive(Clone, Debug)]
pub struct EngineOptions {
    /// No window, renderer, input, UI or audio.
    pub headless: bool,
    /// Boot straight into `AppState::InGame` (default: headless or `--play`).
    pub skip_menu: bool,
    /// Override the data folder (default: [`crate::paths::data_dir`]).
    pub data_dir: Option<PathBuf>,
    /// Override the assets folder (default: [`crate::paths::assets_dir`]).
    pub assets_dir: Option<PathBuf>,
    /// Add the UI kit + engine screens (only ever added when not headless).
    pub ui: bool,
    /// Add `DevtoolsPlugin` (feature `devtools`).
    pub devtools: bool,
    /// Add `TracePlugin` (feature `trace`).
    pub trace: bool,
}

impl EngineOptions {
    pub fn from_args() -> Self {
        let headless = dev_flag("headless");
        EngineOptions {
            headless,
            skip_menu: headless || dev_flag("play"),
            data_dir: None,
            assets_dir: None,
            ui: true,
            devtools: true,
            trace: true,
        }
    }

    /// Headless, straight into the game, data in `data_dir`, no devtools/trace: for
    /// `App::update()`-driven integration tests.
    pub fn headless_test(data_dir: impl Into<PathBuf>) -> Self {
        EngineOptions {
            headless: true,
            skip_menu: true,
            data_dir: Some(data_dir.into()),
            assets_dir: None,
            ui: false,
            devtools: false,
            trace: false,
        }
    }
}

/// Build the app from the command line: base plugins for this run mode + [`EnginePlugin`].
/// Add your game and `.run()`.
pub fn app(info: GameInfo) -> App {
    app_with(info, EngineOptions::from_args())
}

/// [`app`] with explicit options.
pub fn app_with(info: GameInfo, mut options: EngineOptions) -> App {
    let assets = options.assets_dir.clone().unwrap_or_else(|| crate::paths::assets_dir(&info));
    options.assets_dir = Some(assets.clone());
    let asset_plugin = AssetPlugin { file_path: assets.to_string_lossy().into_owned(), ..default() };

    let mut app = App::new();
    if options.headless {
        app.add_plugins((
            MinimalPlugins.set(ScheduleRunnerPlugin::run_loop(Duration::from_secs_f64(1.0 / 60.0))),
            bevy::log::LogPlugin::default(),
            TransformPlugin,
            bevy::diagnostic::DiagnosticsPlugin,
            asset_plugin,
            bevy::mesh::MeshPlugin,
            bevy::world_serialization::WorldSerializationPlugin,
            bevy::scene::ScenePlugin,
            bevy::state::app::StatesPlugin,
            // Keyboard/mouse resources exist headless so the control port can inject input.
            bevy::input::InputPlugin,
        ));
    } else {
        app.add_plugins(
            DefaultPlugins
                .set(WindowPlugin {
                    primary_window: Some(Window {
                        title: info.title.into(),
                        // `--offscreen` (tests): hidden window, camera renders to an image.
                        visible: !dev_flag("offscreen"),
                        // Control-port runs: stay on top so macOS keeps drawing the window
                        // (an occluded window renders black screenshots).
                        window_level: if dev_flag("control") {
                            bevy::window::WindowLevel::AlwaysOnTop
                        } else {
                            bevy::window::WindowLevel::Normal
                        },
                        ..default()
                    }),
                    ..default()
                })
                .set(asset_plugin),
        );
    }
    #[cfg(feature = "physics")]
    app.add_plugins(avian3d::prelude::PhysicsPlugins::default());
    app.add_plugins(EnginePlugin { info, options });
    app
}

/// Everything the engine adds on top of Bevy's base plugins: flow states, settings, pause,
/// input, audio, gfx, UI kit + screens, devtools/trace when enabled. Needs Bevy's base plugins
/// (incl. `StatesPlugin`) first; [`app`] does all of this.
pub struct EnginePlugin {
    pub info: GameInfo,
    pub options: EngineOptions,
}

impl EnginePlugin {
    /// Options from the command line.
    pub fn new(info: GameInfo) -> Self {
        EnginePlugin { info, options: EngineOptions::from_args() }
    }
}

impl Plugin for EnginePlugin {
    fn build(&self, app: &mut App) {
        let o = &self.options;
        let data = o.data_dir.clone().unwrap_or_else(|| crate::paths::data_dir(&self.info));
        if let Err(e) = std::fs::create_dir_all(&data) {
            warn!("data dir {}: {e}", data.display());
        }
        let assets = o.assets_dir.clone().unwrap_or_else(|| crate::paths::assets_dir(&self.info));
        app.insert_resource(self.info.clone())
            .insert_resource(Headless(o.headless))
            .insert_resource(SkipMenu(o.skip_menu))
            .insert_resource(DataDir(data))
            .insert_resource(AssetsDir(assets))
            .insert_resource(GameSeed::from_args())
            .init_state::<AppState>()
            .add_message::<crate::ui::screens::ScreenRequest>()
            .add_message::<crate::ui::screens::RebuildScreen>()
            .add_message::<crate::ui::menus::MenuEvent>()
            // Registered even headless (no UI kit) so game systems can post toasts anywhere.
            .add_message::<crate::ui::toast::Toast>()
            .add_plugins((
                crate::flow::FlowPlugin,
                crate::pause::PausePlugin,
                crate::settings::CoreSettingsPlugin,
                crate::input::InputPlugin,
                crate::audio::EngineAudioPlugin,
                crate::gfx::GfxPlugin,
                crate::render_budget::RenderBudgetPlugin,
                crate::chase::ChasePlugin,
            ));
        #[cfg(feature = "ai")]
        app.add_plugins(crate::ai::AiPlugin);
        if !o.headless {
            // Avoids a pipelined-rendering deadlock on exit (see `exit.rs`).
            app.add_plugins(crate::exit::CleanExitPlugin);
        }
        if o.ui && !o.headless {
            app.add_plugins(crate::ui::UiKitPlugin);
        }
        #[cfg(feature = "devtools")]
        if o.devtools {
            app.add_plugins(crate::devtools::DevtoolsPlugin);
        }
        // Last: its panic hook must wrap Bevy's.
        #[cfg(feature = "trace")]
        if o.trace {
            app.add_plugins(crate::trace::TracePlugin);
        }
    }
}
