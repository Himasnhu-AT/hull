//! Top-level flow. Owner: core stream.
//!
//! `AppState::MainMenu` shows the main menu (ui stream); `AppState::InGame` is where the game
//! lives — games define their own `#[derive(SubStates)] #[source(AppState = AppState::InGame)]`
//! states for rounds, results screens, etc. Headless runs and `--play` go straight to InGame.
//! Pause (Esc) is only available in `InGame` and only while [`PauseAllowed`] is true.

use bevy::prelude::*;

#[derive(States, Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum AppState {
    /// Loading fonts/settings; moves on after the first frame.
    #[default]
    Boot,
    MainMenu,
    InGame,
}

/// `true` with `--headless` (no window, renderer, input or UI).
#[derive(Resource, Clone, Copy, Debug)]
pub struct Headless(pub bool);

/// Games set this false during screens where Esc must not pause (e.g. a results screen with
/// its own Esc handling). Default true.
#[derive(Resource, Clone, Copy, Debug)]
pub struct PauseAllowed(pub bool);

impl Default for PauseAllowed {
    fn default() -> Self {
        PauseAllowed(true)
    }
}

/// Run condition: rendering/UI/input exist.
pub fn has_visuals(h: Res<Headless>) -> bool {
    !h.0
}

/// Run condition: in the game (not menus).
pub fn in_game(s: Option<Res<State<AppState>>>) -> bool {
    s.is_some_and(|s| *s.get() == AppState::InGame)
}
