//! Mouse look + cursor capture + a display list of key bindings. Owner: core stream.
//!
//! - Cursor is captured (locked + hidden) in `AppState::InGame` while not paused and not
//!   [`crate::cli::test_driven`]; released in menus / pause / on focus loss. A click re-captures.
//! - [`LookInput`] each frame: mouse delta × `CoreSettings.sensitivity` (× invert Y), zero when
//!   not captured. Games read it for camera look (radians per frame, already scaled).
//! - [`Bindings`]: action name → keys, shown read-only in the Controls tab (games add theirs).

use bevy::prelude::*;

#[derive(Resource, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CursorCaptured(pub bool);

/// Look delta this frame in radians (yaw, pitch). Positive pitch = look up.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct LookInput {
    pub yaw: f32,
    pub pitch: f32,
}

/// Human-readable bindings for the Controls tab: ("Move", "W A S D").
#[derive(Resource, Clone, Debug, Default)]
pub struct Bindings(pub Vec<(&'static str, &'static str)>);

pub struct InputPlugin;

impl Plugin for InputPlugin {
    fn build(&self, app: &mut App) {
        let _ = app;
        todo!("core stream")
    }
}
