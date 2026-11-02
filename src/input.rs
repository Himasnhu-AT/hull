//! Mouse look + cursor capture + a display list of key bindings. Owner: core stream.
//!
//! - Cursor is captured (locked + hidden) in `AppState::InGame` while not paused, no UI screen
//!   is open (results, pause, settings: anything on the [`crate::ui::screens::Screens`] stack),
//!   not [`crate::cli::test_driven`] and [`CaptureCursor`] is true; released otherwise. If it gets
//!   lost while it should be captured (focus loss, Cmd-Tab), a left click re-captures it.
//! - [`LookInput`] each frame: mouse delta × `CoreSettings.sensitivity` (× invert Y), zero when
//!   not captured. With feature `actions` it comes from the rebindable "look" action (mouse +
//!   gamepad right stick), see `crate::actions`. Games read it for camera look (radians per frame, already scaled).
//!   Test-driven runs never capture the cursor, so there motion counts whenever the game is in
//!   `InGame` and not paused (the control port injects `MouseMotion`).
//! - [`Bindings`]: action name → keys, shown read-only in the Controls tab (games add theirs).
//!   The engine adds "Pause / back" = "Esc".

#[cfg(not(feature = "actions"))]
use bevy::input::mouse::AccumulatedMouseMotion;
use bevy::prelude::*;
use bevy::window::{CursorGrabMode, CursorOptions, PrimaryWindow};

use crate::flow::{AppState, has_visuals};
use crate::pause::Paused;
use crate::settings::CoreSettings;

#[derive(Resource, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CursorCaptured(pub bool);

/// Games set this false for in-game screens that need a free pointer (results, shops, a
/// between-rounds summary). Default true: the cursor is captured whenever the game is live.
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq)]
pub struct CaptureCursor(pub bool);

impl Default for CaptureCursor {
    fn default() -> Self {
        CaptureCursor(true)
    }
}

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
            .init_resource::<CaptureCursor>()
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

/// Should the cursor be captured? Only while playing: in game, not paused, no screen open (an
/// in-game screen such as results needs the pointer even though the game isn't paused), the
/// game allows it, and not a test-driven run.
/// Injects a mouse button event (control port, replay). Bevy 0.20 picking reads only
/// `WindowEvent`s, so a bare `MouseButtonInput` moves `ButtonInput<MouseButton>` but never clicks
/// UI: write both. `None` when the app has no mouse input.
pub fn write_mouse_button(world: &mut World, ev: bevy::input::mouse::MouseButtonInput) -> Option<()> {
    if world.contains_resource::<Messages<bevy::window::WindowEvent>>() {
        world.write_message(bevy::window::WindowEvent::MouseButtonInput(ev));
    }
    world.write_message(ev).map(|_| ())
}

pub fn wants_capture(state: Option<AppState>, paused: bool, allowed: bool, screen_open: bool, test_driven: bool) -> bool {
    state == Some(AppState::InGame) && !paused && allowed && !screen_open && !test_driven
}

fn set_cursor(c: &mut CursorOptions, locked: bool) {
    c.visible = !locked;
    c.grab_mode = if locked { CursorGrabMode::Locked } else { CursorGrabMode::None };
}

fn cursor_policy(
    state: Option<Res<State<AppState>>>,
    paused: Res<Paused>,
    allowed: Res<CaptureCursor>,
    screens: Option<Res<crate::ui::screens::Screens>>,
    mouse: Option<Res<ButtonInput<MouseButton>>>,
    mut cursors: Query<(&Window, &mut CursorOptions), With<PrimaryWindow>>,
    mut captured: ResMut<CursorCaptured>,
    mut was_wanted: Local<bool>,
) {
    let want = wants_capture(state.as_deref().map(|s| *s.get()), paused.0, allowed.0, screens.is_some_and(|s| !s.stack.is_empty()), crate::cli::test_driven());
    let became_wanted = want && !*was_wanted;
    *was_wanted = want;
    let clicked = mouse.is_some_and(|m| m.just_pressed(MouseButton::Left));
    let mut any = false;
    for (window, mut c) in &mut cursors {
        let locked = c.grab_mode != CursorGrabMode::None;
        // Mouse buttons are global: a click in another window (the metrics window) must not
        // grab the game's cursor, so a click only counts while the game window has focus.
        let clicked = clicked && window.focused;
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

#[cfg(not(feature = "actions"))]
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

/// With `actions`: the "look" action (mouse motion + right stick, rebindable) × sensitivity /
/// invert. Mouse look still needs the captured cursor (or a test-driven run); the stick works
/// whenever the gameplay context is live.
#[cfg(feature = "actions")]
fn look_input(
    actions: Option<Res<crate::actions::ActionState>>,
    captured: Res<CursorCaptured>,
    state: Option<Res<State<AppState>>>,
    paused: Res<Paused>,
    settings: Res<CoreSettings>,
    mut look: ResMut<LookInput>,
) {
    let mouse_ok = captured.0
        || (crate::cli::test_driven() && !paused.0 && state.is_some_and(|s| *s.get() == AppState::InGame));
    let d = actions.as_ref().and_then(|a| a.get("look").copied()).unwrap_or_default();
    let ok = d.active && (mouse_ok || d.device == crate::actions::Device::Gamepad);
    *look = if ok { look_from_action(d.value, &settings) } else { LookInput::default() };
}

/// "look" action value (radians at sensitivity 1, y up) → [`LookInput`].
pub fn look_from_action(v: Vec2, settings: &CoreSettings) -> LookInput {
    let invert = if settings.invert_y { -1.0 } else { 1.0 };
    LookInput { yaw: v.x * settings.sensitivity, pitch: v.y * settings.sensitivity * invert }
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
    fn capture_only_while_playing() {
        let ig = Some(AppState::InGame);
        assert!(wants_capture(ig, false, true, false, false));
        assert!(!wants_capture(ig, false, true, true, false), "results / any screen: free pointer");
        assert!(!wants_capture(ig, true, true, true, false), "paused");
        assert!(!wants_capture(ig, false, false, false, false), "the game said no (CaptureCursor)");
        assert!(!wants_capture(Some(AppState::MainMenu), false, true, false, false));
        assert!(!wants_capture(ig, false, true, false, true), "test-driven runs never capture");
    }

    /// The real system on a window: captured while driving, released when a screen (results)
    /// opens without pausing, captured again when it closes.
    #[test]
    fn results_screen_releases_the_cursor() {
        use bevy::state::app::StatesPlugin;
        use bevy::window::{CursorGrabMode, CursorOptions, PrimaryWindow};
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, StatesPlugin))
            .init_state::<AppState>()
            .init_resource::<Paused>()
            .init_resource::<CaptureCursor>()
            .init_resource::<CursorCaptured>()
            .init_resource::<crate::ui::screens::Screens>()
            .add_systems(Update, cursor_policy);
        let w = app.world_mut().spawn((Window::default(), CursorOptions::default(), PrimaryWindow)).id();
        let grab = |app: &App| app.world().get::<CursorOptions>(w).unwrap().grab_mode;
        app.world_mut().resource_mut::<NextState<AppState>>().set(AppState::InGame);
        app.update();
        app.update();
        assert_ne!(grab(&app), CursorGrabMode::None, "driving: captured");
        app.world_mut().resource_mut::<crate::ui::screens::Screens>().stack.push("results");
        app.update();
        assert_eq!(grab(&app), CursorGrabMode::None, "results: released");
        assert!(app.world().get::<CursorOptions>(w).unwrap().visible, "and shown");
        app.world_mut().resource_mut::<crate::ui::screens::Screens>().stack.clear();
        app.update();
        assert_ne!(grab(&app), CursorGrabMode::None, "back to driving: captured again");
        app.world_mut().resource_mut::<CaptureCursor>().0 = false;
        app.update();
        assert_eq!(grab(&app), CursorGrabMode::None, "CaptureCursor(false): released");
    }

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
