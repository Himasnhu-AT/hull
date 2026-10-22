//! Crash / hang / frame-time reporting through ashlar-trace (feature `trace`).
//! Owner: devtools stream (port Shroud `ops/trace.rs`, game-agnostic: games emit their own
//! named events via [`trace_event`]). No-op unless `<ID>_TRACE_ENDPOINT`/`_KEY` are set.
//! Must be added after DefaultPlugins so its panic hook wraps Bevy's.

use bevy::prelude::*;

pub struct TracePlugin;

impl Plugin for TracePlugin {
    fn build(&self, app: &mut App) {
        let _ = app;
        todo!("devtools stream")
    }
}
