//! Bootstrap: [`app`] builds a Bevy `App` with the right plugin set for a windowed or
//! `--headless` run, plus [`EnginePlugin`].
//!
//! Owner: core stream. Behaviour to keep from Shroud (`crates/game/src/main.rs`):
//! - `--headless`: MinimalPlugins at 60 Hz + Log, Transform, Diagnostics, Asset, Mesh, Scene,
//!   WorldSerialization, States plugins (no window/renderer/input/UI).
//! - windowed: DefaultPlugins with the asset root from [`crate::paths::assets_dir`], title from
//!   [`GameInfo`], `--offscreen` → hidden window, `--control` → always-on-top window.
//! - `physics` feature: avian3d `PhysicsPlugins::default()`.

use bevy::prelude::*;

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

/// Build the app: base plugins for this run mode + [`EnginePlugin`]. Add your game and `.run()`.
pub fn app(info: GameInfo) -> App {
    let app = App::new();
    let _ = &info;
    todo!("core stream: base plugins (headless/windowed), physics, EnginePlugin");
    #[allow(unreachable_code)]
    app
}

/// Everything the engine adds on top of Bevy's base plugins: flow states, settings, pause,
/// input, audio, gfx, UI kit + screens, devtools/trace when enabled.
pub struct EnginePlugin {
    pub info: GameInfo,
}

impl Plugin for EnginePlugin {
    fn build(&self, app: &mut App) {
        let _ = app;
        todo!("core stream: insert GameInfo/Headless/paths, add engine plugins")
    }
}
