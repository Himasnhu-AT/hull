//! Top-level flow. Owner: core stream.
//!
//! `AppState::MainMenu` shows the main menu (ui stream); `AppState::InGame` is where the game
//! lives — games define their own `#[derive(SubStates)] #[source(AppState = AppState::InGame)]`
//! states for rounds, results screens, etc. Headless runs and `--play` go straight to InGame.
//! Pause (Esc) is only available in `InGame` and only while [`PauseAllowed`] is true.
//!
//! [`FlowPlugin`] (added by `EnginePlugin`): `Boot` → `MainMenu` (or `InGame` when
//! [`SkipMenu`]) on the first `Update`; `--quit-after <s>` exits after that much real time.

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

/// Boot goes straight to `InGame` (headless runs and `--play`). Set by `EnginePlugin`.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct SkipMenu(pub bool);

/// Run condition: rendering/UI/input exist.
pub fn has_visuals(h: Res<Headless>) -> bool {
    !h.0
}

/// Run condition: in the game (not menus).
pub fn in_game(s: Option<Res<State<AppState>>>) -> bool {
    s.is_some_and(|s| *s.get() == AppState::InGame)
}

pub struct FlowPlugin;

impl Plugin for FlowPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PauseAllowed>()
            .init_resource::<SkipMenu>()
            .add_systems(Update, leave_boot.run_if(in_state(AppState::Boot)))
            .add_systems(Last, quit_after);
    }
}

fn leave_boot(skip: Res<SkipMenu>, mut next: ResMut<NextState<AppState>>) {
    next.set(if skip.0 { AppState::InGame } else { AppState::MainMenu });
}

/// `--quit-after <seconds>`: exit after that much real time (soak/smoke runs).
pub(crate) fn quit_after(time: Res<Time<Real>>, mut exit: MessageWriter<AppExit>, mut limit: Local<Option<Option<f32>>>) {
    let limit = *limit.get_or_insert_with(|| crate::cli::arg_value("quit-after").and_then(|s| s.parse().ok()));
    if limit.is_some_and(|l| time.elapsed_secs() > l) {
        info!("quit-after reached");
        exit.write(AppExit::Success);
    }
}
