//! Pause: freezes `Time<Virtual>` (and avian `Time<Physics>` with `physics`) without leaving
//! `AppState::InGame`. Owner: core stream (port `PauseCtl` from Shroud ui/screens.rs).
//! Games gate their gameplay system sets with [`not_paused`].

use bevy::prelude::*;

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
