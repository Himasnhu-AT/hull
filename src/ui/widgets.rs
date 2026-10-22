//! Widgets + focus/navigation. Owner: ui stream.
//! Keyboard: arrows/WASD move focus, Enter/Space activate, A/D or ←/→ adjust, Q/E/Tab switch
//! tabs, Esc/Backspace back. Mouse: hover focuses, click activates, drag sliders.

use bevy::prelude::*;

/// Navigation input (also injectable by the control port: `ui.nav {input}`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavInput {
    Up,
    Down,
    Left,
    Right,
    Accept,
    Back,
    NextTab,
    PrevTab,
}

/// Queue of nav inputs processed this frame (keyboard + injected).
#[derive(Resource, Clone, Debug, Default)]
pub struct NavQueue(pub Vec<NavInput>);
