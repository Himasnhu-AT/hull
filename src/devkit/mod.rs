//! Devkit (feature `devkit`): the AI-friendly dev loop. Everything here is code-first and
//! drivable headless, so an agent can build, test and inspect a game without a GUI.
//!
//! - [`inspect`] (+ `devtools`): reflection inspector over the control port (`ecs.*`).
//! - [`testing`]: [`testing::Scenario`], a fixed-timestep headless app for game tests:
//!   step frames / seconds, scripted input, `wait_until`, snapshots, perf budgets.
//! - [`replay`]: frame-stamped input logs (record live play, replay it deterministically).
//! - [`golden`]: golden-image comparison for offscreen screenshots (perceptual tolerance,
//!   diff image on failure).
//! - [`perf_assert`]: frame-time / entity / allocation budgets, [`perf_assert::CountingAlloc`].
//! - [`bench`]: JSON bench reports comparable across commits (`scripts/bench.py`).
//! - [`profile`]: [`profile_scope!`](crate::profile_scope) CPU scope timers (+ Tracy spans with
//!   the `profile` feature).
//! - [`reload`]: JSON data/settings hot reload by polling file mtimes.
//! - [`save`]: versioned save slots with migrations, backups, autosave, thumbnails.
//! - [`content`]: asset validation (missing refs, oversized / NPOT textures, no mips).
//!
//! [`DevkitPlugin`] is added by `EnginePlugin` and costs nothing per frame until a feature is
//! used (no watched files, no scopes, no recording → every system returns at once).
//! Docs: `docs/DEVKIT.md`.

pub mod bench;
pub mod content;
pub mod golden;
#[cfg(feature = "devtools")]
pub mod inspect;
pub mod perf_assert;
pub mod profile;
pub mod reflect_json;
pub mod reload;
pub mod replay;
pub mod save;
pub mod testing;

use bevy::prelude::*;

pub use bench::BenchReport;
pub use golden::{GoldenOptions, compare_images};
pub use perf_assert::{CountingAlloc, FrameTimes, PerfBudget};
pub use profile::ScopeReport;
pub use reload::{HotReload, HotReloadAppExt, HotReloadConfig, Reloaded, WatchPath};
pub use replay::{InputEvent, InputLog, InputRecorder, InputReplay};
pub use save::{SaveConfig, SaveEvent, SaveMeta, SavePlugin, SaveRequest, SaveStore, Playtime};
pub use testing::{Scenario, ScenarioBuilder};

/// Added by `EnginePlugin`. Registers input record/replay, scope reporting, JSON hot reload and
/// (feature `devtools`) the `ecs.*` / `devkit.*` / `content.*` control commands.
pub struct DevkitPlugin;

impl Plugin for DevkitPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins((replay::ReplayPlugin, profile::ProfilePlugin, reload::ReloadPlugin));
        #[cfg(feature = "devtools")]
        {
            inspect::register(app);
            content::register(app);
        }
    }
}
