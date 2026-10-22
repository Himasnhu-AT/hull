//! Devtools (feature `devtools`). Owner: devtools stream (port from Shroud `ops/`:
//! `control.rs` (port + MCP + `add_control_command`), `offscreen.rs`, `perf*.rs` + F3 overlay,
//! `session_log.rs`, and the game-agnostic commands from `commands.rs`).
//!
//! Engine commands: `engine.state`, `engine.start` (→ InGame), `engine.menu`, `engine.pause`,
//! `engine.resume`, `engine.quit`, `time.scale`, `time.step`, `screenshot`, `perf.stats`,
//! `ui.screen {screen, tab}`, `ui.nav {input}`, `ui.setting {key, value}`, `settings.get`,
//! `input.key {key, down|tap}`, `input.mouse {dx, dy, button}`.
//! Games add theirs with [`AddControlCommand::add_control_command`].

use bevy::prelude::*;

pub struct DevtoolsPlugin;

impl Plugin for DevtoolsPlugin {
    fn build(&self, app: &mut App) {
        let _ = app;
        todo!("devtools stream")
    }
}
