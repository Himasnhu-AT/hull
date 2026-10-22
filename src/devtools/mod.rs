//! Devtools (feature `devtools`), ported from Shroud's `ops/`: the control port + MCP
//! ([`control`]), `--offscreen` capture ([`offscreen`]), the perf monitor + overlay
//! ([`perf`], toggled with F3), the session log ([`session_log`]) and the game-agnostic
//! commands ([`commands`]).
//!
//! Engine commands: `engine.state`, `engine.start` (→ InGame), `engine.menu`, `engine.pause`,
//! `engine.resume`, `engine.quit`, `time.scale`, `time.step`, `screenshot`, `perf.stats`,
//! `perf.overlay`, `perf.report`, `ui.screen {screen, tab}`, `ui.nav {input}`,
//! `ui.setting {key, value}`, `settings.get`, `input.key {key, action}`,
//! `input.mouse {dx, dy, button, action}`.
//! Games add theirs with [`AddControlCommand::add_control_command`], add overlay rows with
//! [`DebugLines`] and time their system sets with [`PerfAppExt::perf_span`].
//!
//! Flags: `--control <port>` (0 = any free port; prints `control: port=<n> key=<file>`),
//! `--mcp` (MCP on stdio), `--offscreen`, `--perf` (overlay on at start), `--gpu-passes`.
//! Env (`<ID>` = `GameInfo.id` uppercased): `<ID>_PERF=off`, `<ID>_PERF_TOP=<n>`.

pub mod commands;
pub mod control;
pub mod metrics;
pub mod offscreen;
pub mod perf;
mod perf_overlay;
mod perf_stats;
mod perf_sys;
pub mod session_log;

use bevy::prelude::*;

pub use control::{AddControlCommand, ControlAppExt, ControlRegistry, PendingReplies, ReplyId, params};
pub use metrics::Metrics;
pub use perf::{DebugLines, PerfAppExt, PerfOverlay, PerfOverlayKey};
pub use session_log::SessionLog;

pub struct DevtoolsPlugin;

impl Plugin for DevtoolsPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins((
            control::ControlPlugin,
            offscreen::OffscreenPlugin,
            perf::PerfPlugin,
            metrics::MetricsPlugin,
            perf_overlay::PerfOverlayPlugin,
        ));
        commands::register(app);
    }
}
