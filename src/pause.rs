//! Pause: freezes `Time<Virtual>` (and avian `Time<Physics>` with `physics`) without leaving
//! `AppState::InGame`. Owner: core stream (port `PauseCtl` from Shroud ui/screens.rs).
//! Games gate their gameplay system sets with [`not_paused`].
//!
//! [`PausePlugin`] (added by `EnginePlugin`):
//! - leaving `InGame` always unpauses;
//! - window focus loss in `InGame` (not paused, [`PauseAllowed`], not
//!   [`crate::cli::test_driven`]) pauses and sends `ScreenRequest::Push("pause")` so the ui
//!   stream's pause screen opens. Esc handling lives in the ui stream's pause screen.

use bevy::prelude::*;
#[cfg(feature = "physics")]
use avian3d::prelude::PhysicsTime;

use crate::flow::{AppState, PauseAllowed, has_visuals};
use crate::ui::screens::ScreenRequest;

#[derive(Resource, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Paused(pub bool);

pub fn not_paused(p: Res<Paused>) -> bool {
    !p.0
}

/// Pause plumbing shared by Esc, menu buttons, focus loss and the control port.
#[derive(bevy::ecs::system::SystemParam)]
pub struct PauseCtl<'w> {
    paused: ResMut<'w, Paused>,
    virt: ResMut<'w, Time<Virtual>>,
    #[cfg(feature = "physics")]
    physics: Option<ResMut<'w, Time<avian3d::prelude::Physics>>>,
}

impl PauseCtl<'_> {
    pub fn is_paused(&self) -> bool {
        self.paused.0
    }
    pub fn set(&mut self, on: bool) {
        if self.paused.0 == on {
            return;
        }
        self.paused.0 = on;
        if on {
            self.virt.pause();
        } else {
            self.virt.unpause();
        }
        #[cfg(feature = "physics")]
        if let Some(p) = self.physics.as_mut() {
            if on {
                p.pause();
            } else {
                p.unpause();
            }
        }
    }
}

pub struct PausePlugin;

impl Plugin for PausePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Paused>()
            .add_message::<ScreenRequest>()
            .add_systems(OnExit(AppState::InGame), unpause)
            .add_systems(PreUpdate, pause_on_focus_loss.run_if(has_visuals));
    }
}

fn unpause(mut pause: PauseCtl) {
    pause.set(false);
}

fn pause_on_focus_loss(
    mut events: MessageReader<bevy::window::WindowFocused>,
    state: Res<State<AppState>>,
    allowed: Res<PauseAllowed>,
    mut pause: PauseCtl,
    mut screens: MessageWriter<ScreenRequest>,
) {
    let lost = events.read().fold(None, |_, e| Some(!e.focused)).unwrap_or(false);
    if lost && *state.get() == AppState::InGame && allowed.0 && !pause.is_paused() && !crate::cli::test_driven() {
        pause.set(true);
        screens.write(ScreenRequest::Push("pause"));
    }
}
