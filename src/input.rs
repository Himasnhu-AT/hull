//! Mouse look + cursor capture + a display list of key bindings. Owner: core stream.
//!
//! - Cursor is captured (locked + hidden) in `AppState::InGame` while not paused and not
//!   [`crate::cli::test_driven`]; released in menus / pause. If it gets lost while it should be
//!   captured (focus loss, Cmd-Tab), a left click re-captures it.
//! - [`LookInput`] each frame: mouse delta × `CoreSettings.sensitivity` (× invert Y), zero when
//!   not captured. Games read it for camera look (radians per frame, already scaled).
//!   Test-driven runs never capture the cursor, so there motion counts whenever the game is in
//!   `InGame` and not paused (the control port injects `MouseMotion`).
//! - [`Bindings`]: action name → keys, shown read-only in the Controls tab (games add theirs).
//!   The engine adds "Pause / back" = "Esc".

use bevy::input::mouse::AccumulatedMouseMotion;
use bevy::prelude::*;
use bevy::window::{CursorGrabMode, CursorOptions, PrimaryWindow};

use crate::flow::{AppState, has_visuals};
use crate::pause::Paused;
use crate::settings::CoreSettings;

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

impl Bindings {
    /// Add or replace the keys shown for `action`.
    pub fn set(&mut self, action: &'static str, keys: &'static str) {
        match self.0.iter_mut().find(|(a, _)| *a == action) {
            Some(b) => b.1 = keys,
            None => self.0.push((action, keys)),
        }
    }
}

/// Radians per mouse count at sensitivity 1.0.
pub const BASE_MOUSE_SENSITIVITY: f32 = 0.0022;

/// Input stages, in `PreUpdate` after Bevy's input handling. Games reading [`LookInput`] in
/// `Update` need no ordering.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct InputSet;

pub struct InputPlugin;

impl Plugin for InputPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<CursorCaptured>()
            .init_resource::<LookInput>()
            .init_resource::<Bindings>()
            .add_systems(
                PreUpdate,
                (cursor_policy, look_input)
                    .chain()
                    .in_set(InputSet)
                    .after(bevy::input::InputSystems)
                    .run_if(has_visuals),
            );
        app.world_mut().resource_mut::<Bindings>().set("Pause / back", "Esc");
    }
}

fn set_cursor(c: &mut CursorOptions, locked: bool) {
    c.visible = !locked;
    c.grab_mode = if locked { CursorGrabMode::Locked } else { CursorGrabMode::None };
}

fn cursor_policy(
    state: Option<Res<State<AppState>>>,
    paused: Res<Paused>,
    mouse: Option<Res<ButtonInput<MouseButton>>>,
    mut cursors: Query<&mut CursorOptions, With<PrimaryWindow>>,
    mut captured: ResMut<CursorCaptured>,
    mut was_wanted: Local<bool>,
) {
    let want = state.is_some_and(|s| *s.get() == AppState::InGame) && !paused.0 && !crate::cli::test_driven();
    let became_wanted = want && !*was_wanted;
    *was_wanted = want;
    let clicked = mouse.is_some_and(|m| m.just_pressed(MouseButton::Left));
    let mut any = false;
    for mut c in &mut cursors {
        let locked = c.grab_mode != CursorGrabMode::None;
        if !want && locked {
            set_cursor(&mut c, false);
        } else if want && !locked && (became_wanted || clicked) {
            set_cursor(&mut c, true);
        }
        any |= c.grab_mode != CursorGrabMode::None;
    }
    if captured.0 != any {
        captured.0 = any;
    }
}

fn look_input(
    motion: Option<Res<AccumulatedMouseMotion>>,
    captured: Res<CursorCaptured>,
    state: Option<Res<State<AppState>>>,
    paused: Res<Paused>,
    settings: Res<CoreSettings>,
    mut look: ResMut<LookInput>,
) {
    let active = captured.0
        || (crate::cli::test_driven() && !paused.0 && state.is_some_and(|s| *s.get() == AppState::InGame));
    let delta = motion.map(|m| m.delta).unwrap_or_default();
    *look = if active { look_from_motion(delta, &settings) } else { LookInput::default() };
}

/// Mouse counts → radians: x right = yaw right, y down = pitch down (unless inverted).
pub fn look_from_motion(delta: Vec2, settings: &CoreSettings) -> LookInput {
    let k = BASE_MOUSE_SENSITIVITY * settings.sensitivity;
    let invert = if settings.invert_y { -1.0 } else { 1.0 };
    LookInput { yaw: delta.x * k, pitch: -delta.y * invert * k }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn look_scaling_and_invert() {
        let mut s = CoreSettings { sensitivity: 2.0, ..default() };
        let l = look_from_motion(Vec2::new(10.0, 5.0), &s);
        assert!((l.yaw - 10.0 * BASE_MOUSE_SENSITIVITY * 2.0).abs() < 1e-6);
        assert!(l.pitch < 0.0, "mouse down looks down");
        s.invert_y = true;
        assert!(look_from_motion(Vec2::new(0.0, 5.0), &s).pitch > 0.0);
    }
}
