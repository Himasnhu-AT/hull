//! The editor's viewport camera: it drives the game's `MainCamera` (or spawns one).
//!
//! No mouse button has to be held to fly: it works on a trackpad.
//!
//! | Input (pointer over the viewport, no text field focused) | Does |
//! |---|---|
//! | W A S D | move (Shift = 3x); Q / E down / up; arrow keys turn |
//! | left drag on empty space (past 4 px) | look around; a click without dragging selects |
//! | right drag | look around too; scroll while looking = fly speed |
//! | scroll (two fingers) or pinch | dolly forward / back |
//! | Alt + left drag | orbit around the selection (else a point ahead) |
//! | middle drag, or Space + left drag | pan |
//! | F (or Focus in the toolbar) | frame the selection |
//!
//! A drag that starts on a gizmo handle belongs to the gizmo. Movement eases in and out and does
//! not depend on the frame rate. The pose is applied in `PostUpdate` before transform
//! propagation, so a game system that also moves its camera is overridden while editing.
//! The input rules are the pure [`Mouse`] state machine (tested below).

use bevy::input::gestures::PinchGesture;
use bevy::input::mouse::{AccumulatedMouseMotion, AccumulatedMouseScroll, MouseScrollUnit};
use bevy::prelude::*;

use super::picking;
use super::{EditorMode, EditorOnly, EditorState};
use crate::gfx::MainCamera;

#[derive(Resource)]
pub struct EditorCamera {
    pub entity: Option<Entity>,
    pub pos: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    /// Fly speed in metres per second.
    pub speed: f32,
    /// Orbit centre.
    pub pivot: Vec3,
    /// Current velocity (m/s), eased toward the wanted one.
    pub vel: Vec3,
    pub mode: Drag,
    machine: Mouse,
    /// Scripted movement (`editor.camera_drive`): camera-local direction and seconds left.
    pub script: Option<(Vec3, f32)>,
}

/// What the pointer is doing to the camera.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Drag {
    #[default]
    None,
    /// Left button down on empty space: a click or the start of a look, not decided yet.
    Pending,
    Look,
    Orbit,
    Pan,
}

/// Which button drives the current drag.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Src {
    #[default]
    Left,
    Right,
    Middle,
}

/// Pixels the pointer must travel with the left button down before it is a look, not a click.
pub const DRAG_PX: f32 = 4.0;

/// One frame of pointer input, already reduced to what the rules need.
#[derive(Clone, Copy, Debug, Default)]
pub struct Inp {
    /// The pointer is over the viewport image with no egui widget above it.
    pub over: bool,
    /// A text field has the keyboard.
    pub typing: bool,
    /// The pointer is on a gizmo handle (or the gizmo is dragging).
    pub gizmo: bool,
    pub lmb: Btn,
    pub rmb: Btn,
    pub mmb: Btn,
    pub alt: bool,
    pub space: bool,
    /// Pointer motion this frame, in pixels.
    pub delta: Vec2,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Btn {
    pub pressed: bool,
    pub down: bool,
}

/// The camera's mouse state machine.
#[derive(Clone, Copy, Debug, Default)]
pub struct Mouse {
    pub drag: Drag,
    src: Src,
    travelled: f32,
}

impl Mouse {
    /// Advances one frame. Returns true when the left button was released without dragging (a
    /// click: the caller selects).
    pub fn step(&mut self, i: &Inp) -> bool {
        let down = |s: Src| match s {
            Src::Left => i.lmb.down,
            Src::Right => i.rmb.down,
            Src::Middle => i.mmb.down,
        };
        if self.drag == Drag::None && i.over && !i.typing {
            if i.rmb.pressed {
                *self = Mouse { drag: Drag::Look, src: Src::Right, travelled: 0.0 };
            } else if i.mmb.pressed {
                *self = Mouse { drag: Drag::Pan, src: Src::Middle, travelled: 0.0 };
            } else if i.lmb.pressed && !i.gizmo {
                let drag = if i.alt {
                    Drag::Orbit
                } else if i.space {
                    Drag::Pan
                } else {
                    Drag::Pending
                };
                *self = Mouse { drag, src: Src::Left, travelled: 0.0 };
            }
            return false;
        }
        if self.drag == Drag::None {
            return false;
        }
        if self.drag == Drag::Pending && down(self.src) {
            self.travelled += i.delta.length();
            if self.travelled > DRAG_PX {
                self.drag = Drag::Look;
            }
            return false;
        }
        if !down(self.src) {
            let click = self.drag == Drag::Pending;
            *self = Mouse::default();
            return click;
        }
        false
    }

    /// The camera is being turned, orbited or panned by the pointer.
    pub fn busy(&self) -> bool {
        matches!(self.drag, Drag::Look | Drag::Orbit | Drag::Pan)
    }
}

/// Whether W A S D / Q E / arrows move the camera: pointer over the viewport (or a drag in
/// progress), no text field focused, no Cmd / Ctrl held (those are shortcuts).
pub fn keys_move(over: bool, dragging: bool, typing: bool, command: bool) -> bool {
    (over || dragging) && !typing && !command
}

impl Default for EditorCamera {
    fn default() -> Self {
        EditorCamera { entity: None, pos: Vec3::new(8.0, 6.0, 10.0), yaw: 0.0, pitch: 0.0, speed: 8.0, pivot: Vec3::ZERO, vel: Vec3::ZERO, mode: Drag::None, machine: Mouse::default(), script: None }
    }
}

impl EditorCamera {
    pub fn rotation(&self) -> Quat {
        Quat::from_euler(EulerRot::YXZ, self.yaw, self.pitch, 0.0)
    }
    pub fn forward(&self) -> Vec3 {
        self.rotation() * Vec3::NEG_Z
    }
    /// Look from `from` at `to`.
    pub fn look_at(&mut self, from: Vec3, to: Vec3) {
        self.pos = from;
        let d = (to - from).normalize_or_zero();
        if d != Vec3::ZERO {
            self.yaw = (-d.x).atan2(-d.z);
            self.pitch = d.y.clamp(-1.0, 1.0).asin();
        }
    }
    fn clamp_pitch(&mut self) {
        self.pitch = self.pitch.clamp(-1.55, 1.55);
    }
}

/// Finds (or makes) the camera the editor drives; takes its starting pose from it.
pub fn adopt_camera(mut commands: Commands, mut cam: ResMut<EditorCamera>, cams: Query<(Entity, &Transform, Has<MainCamera>), (With<Camera3d>, Without<EditorOnly>)>, alive: Query<(), With<Camera3d>>, mut frames: Local<u32>) {
    if let Some(e) = cam.entity
        && alive.contains(e)
    {
        return;
    }
    *frames += 1;
    let found = cams.iter().find(|(_, _, main)| *main).or_else(|| cams.iter().next());
    match found {
        Some((e, t, _)) => {
            cam.entity = Some(e);
            let (yaw, pitch, _) = t.rotation.to_euler(EulerRot::YXZ);
            cam.pos = t.translation;
            cam.yaw = yaw;
            cam.pitch = pitch;
            cam.pivot = t.translation + t.forward() * 8.0;
        }
        // Give the game a few frames to spawn its own camera first.
        None if *frames > 10 => {
            let from = cam.pos;
            cam.look_at(from, Vec3::new(0.0, 1.0, 0.0));
            let t = Transform::from_translation(cam.pos).with_rotation(cam.rotation());
            let e = commands.spawn((EditorOnly, Name::new("Editor camera"), MainCamera, Camera3d::default(), t)).id();
            cam.entity = Some(e);
        }
        None => {}
    }
}

/// Mouse and keys to the camera pose.
#[allow(clippy::too_many_arguments)]
pub fn control(
    mut cam: ResMut<EditorCamera>,
    mut st: ResMut<EditorState>,
    gizmo: Res<super::gizmo::GizmoState>,
    mouse: Res<ButtonInput<MouseButton>>,
    keys: Res<ButtonInput<KeyCode>>,
    motion: Res<AccumulatedMouseMotion>,
    scroll: Res<AccumulatedMouseScroll>,
    mut pinch: MessageReader<PinchGesture>,
    time: Res<Time<Real>>,
    gts: Query<&GlobalTransform>,
    mode: Option<Res<EditorMode>>,
) {
    let pinch: f32 = pinch.read().map(|p| p.0).sum();
    if mode.is_none() {
        return;
    }
    let dt = time.delta_secs().min(0.1);
    let btn = |b: MouseButton| Btn { pressed: mouse.just_pressed(b), down: mouse.pressed(b) };
    let command = keys.any_pressed([KeyCode::SuperLeft, KeyCode::SuperRight, KeyCode::ControlLeft, KeyCode::ControlRight]);
    let inp = Inp {
        over: st.ui.pointer_over_viewport && !st.ui.wants_pointer && !st.tool_busy,
        typing: st.ui.wants_keyboard,
        gizmo: gizmo.engaged() || st.gizmo_busy,
        lmb: btn(MouseButton::Left),
        rmb: btn(MouseButton::Right),
        mmb: btn(MouseButton::Middle),
        alt: keys.any_pressed([KeyCode::AltLeft, KeyCode::AltRight]),
        space: keys.pressed(KeyCode::Space),
        delta: motion.delta,
    };
    // A tool owns the left button; the camera keeps the others.
    let before = cam.mode;
    let mut m = Mouse { drag: cam.mode, ..cam.machine };
    let tool_owns_lmb = st.tool_active;
    let mut inp2 = inp;
    if tool_owns_lmb && !inp.alt && !inp.space {
        inp2.lmb = Btn::default();
    }
    let _clicked = m.step(&inp2);
    if before == Drag::None && m.drag == Drag::Orbit
        && let Some(c) = picking::selection_centre(&st, &gts)
    {
        cam.pivot = c;
    }
    cam.mode = m.drag;
    cam.machine = m;
    st.cam_busy = m.busy();
    let looking = m.drag == Drag::Look;
    let d = motion.delta;
    let wheel = match scroll.unit {
        MouseScrollUnit::Line => scroll.delta.y,
        MouseScrollUnit::Pixel => scroll.delta.y / 40.0,
    };
    match m.drag {
        Drag::Look => {
            cam.yaw -= d.x * 0.003;
            cam.pitch -= d.y * 0.003;
        }
        Drag::Orbit => {
            let dist = (cam.pos - cam.pivot).length().max(0.5);
            cam.yaw -= d.x * 0.005;
            cam.pitch -= d.y * 0.005;
            cam.clamp_pitch();
            cam.pos = cam.pivot - cam.forward() * dist;
        }
        Drag::Pan => {
            let rot = cam.rotation();
            let dist = (cam.pos - cam.pivot).length().max(1.0);
            let delta = rot * Vec3::new(-d.x, d.y, 0.0) * dist * 0.0015;
            cam.pos += delta;
            cam.pivot += delta;
        }
        Drag::Pending | Drag::None => {}
    }
    // Keys.
    let move_ok = keys_move(inp.over, m.drag != Drag::None, inp.typing, command);
    let mut wish = Vec3::ZERO;
    if move_ok {
        let rot = cam.rotation();
        for (k, v) in [(KeyCode::KeyW, Vec3::NEG_Z), (KeyCode::KeyS, Vec3::Z), (KeyCode::KeyA, Vec3::NEG_X), (KeyCode::KeyD, Vec3::X)] {
            if keys.pressed(k) {
                wish += rot * v;
            }
        }
        if keys.pressed(KeyCode::KeyE) {
            wish += Vec3::Y;
        }
        if keys.pressed(KeyCode::KeyQ) {
            wish -= Vec3::Y;
        }
        let turn = 1.8 * dt;
        if keys.pressed(KeyCode::ArrowLeft) {
            cam.yaw += turn;
        }
        if keys.pressed(KeyCode::ArrowRight) {
            cam.yaw -= turn;
        }
        if keys.pressed(KeyCode::ArrowUp) {
            cam.pitch += turn;
        }
        if keys.pressed(KeyCode::ArrowDown) {
            cam.pitch -= turn;
        }
    }
    if let Some((dir, left)) = cam.script {
        wish += cam.rotation() * dir;
        let left = left - dt;
        cam.script = (left > 0.0).then_some((dir, left));
    }
    cam.clamp_pitch();
    let boost = if keys.any_pressed([KeyCode::ShiftLeft, KeyCode::ShiftRight]) { 3.0 } else { 1.0 };
    let target = wish.normalize_or_zero() * cam.speed * boost;
    cam.vel = ease(cam.vel, target, dt);
    let step = cam.vel * dt;
    cam.pos += step;
    // Scroll: speed while looking, else dolly; pinch dollies.
    let dist = (cam.pos - cam.pivot).length().max(1.0);
    if inp.over || m.drag != Drag::None {
        if looking && wheel != 0.0 {
            cam.speed = (cam.speed * 1.2f32.powf(wheel)).clamp(0.2, 400.0);
        } else if wheel != 0.0 || pinch != 0.0 {
            let f = cam.forward();
            cam.pos += f * (wheel * dist * 0.12 + pinch * dist * 3.0);
        }
    }
    if m.drag != Drag::Orbit && (step != Vec3::ZERO || m.drag == Drag::Look) {
        cam.pivot = cam.pos + cam.forward() * dist.max(2.0);
    }
}

/// Moves `v` toward `target` with a time constant, independent of the frame rate.
pub fn ease(v: Vec3, target: Vec3, dt: f32) -> Vec3 {
    v + (target - v) * (1.0 - (-12.0 * dt).exp())
}

/// Writes the pose to the camera entity.
pub fn apply(cam: Res<EditorCamera>, mut q: Query<&mut Transform>, mode: Option<Res<EditorMode>>) {
    if mode.is_none() {
        return;
    }
    let Some(e) = cam.entity else { return };
    if let Ok(mut t) = q.get_mut(e) {
        let want = Transform::from_translation(cam.pos).with_rotation(cam.rotation());
        if t.translation != want.translation || t.rotation != want.rotation {
            t.translation = want.translation;
            t.rotation = want.rotation;
        }
    }
}

/// Frames the selection (or the whole level when nothing is selected).
pub fn focus_selection(world: &mut World) {
    let sel = world.resource::<EditorState>().selection.clone();
    let bounds = picking::bounds_of(world, &sel);
    let Some((min, max)) = bounds else { return };
    let centre = (min + max) * 0.5;
    let radius = ((max - min).length() * 0.5).max(0.5);
    let mut cam = world.resource_mut::<EditorCamera>();
    let dir = cam.forward();
    // Distance so the bounding sphere fits a ~60 degree view.
    let dist = radius / (30.0f32.to_radians()).sin();
    cam.pos = centre - dir * dist.max(1.5);
    cam.pivot = centre;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn over() -> Inp {
        Inp { over: true, ..default() }
    }
    fn press_l(mut i: Inp) -> Inp {
        i.lmb = Btn { pressed: true, down: true };
        i
    }
    fn hold_l(mut i: Inp, delta: Vec2) -> Inp {
        i.lmb = Btn { pressed: false, down: true };
        i.delta = delta;
        i
    }

    #[test]
    fn a_click_without_travel_selects() {
        let mut m = Mouse::default();
        assert!(!m.step(&press_l(over())));
        assert_eq!(m.drag, Drag::Pending);
        assert!(!m.step(&hold_l(over(), Vec2::new(1.0, 1.0))));
        assert!(m.step(&over()), "released: a click");
        assert_eq!(m.drag, Drag::None);
    }

    #[test]
    fn travel_past_the_threshold_turns_into_a_look_and_no_click() {
        let mut m = Mouse::default();
        m.step(&press_l(over()));
        m.step(&hold_l(over(), Vec2::new(3.0, 0.0)));
        assert_eq!(m.drag, Drag::Pending, "3 px is still a click");
        m.step(&hold_l(over(), Vec2::new(3.0, 0.0)));
        assert_eq!(m.drag, Drag::Look);
        assert!(m.busy());
        assert!(!m.step(&over()), "ending a look is not a click");
        assert!(!m.busy());
    }

    #[test]
    fn a_gizmo_handle_keeps_the_press() {
        let mut m = Mouse::default();
        m.step(&press_l(Inp { gizmo: true, ..over() }));
        assert_eq!(m.drag, Drag::None);
    }

    #[test]
    fn modifiers_and_other_buttons_pick_the_drag() {
        let mut m = Mouse::default();
        m.step(&press_l(Inp { alt: true, ..over() }));
        assert_eq!(m.drag, Drag::Orbit);
        let mut m = Mouse::default();
        m.step(&press_l(Inp { space: true, ..over() }));
        assert_eq!(m.drag, Drag::Pan);
        let mut m = Mouse::default();
        m.step(&Inp { rmb: Btn { pressed: true, down: true }, ..over() });
        assert_eq!(m.drag, Drag::Look);
        // Right button released ends it even when the left is down.
        m.step(&Inp { lmb: Btn { pressed: false, down: true }, ..over() });
        assert_eq!(m.drag, Drag::None);
        let mut m = Mouse::default();
        m.step(&Inp { mmb: Btn { pressed: true, down: true }, ..over() });
        assert_eq!(m.drag, Drag::Pan);
    }

    #[test]
    fn nothing_starts_off_the_viewport_or_while_typing() {
        let mut m = Mouse::default();
        m.step(&press_l(Inp { over: false, ..default() }));
        assert_eq!(m.drag, Drag::None);
        m.step(&press_l(Inp { typing: true, ..over() }));
        assert_eq!(m.drag, Drag::None);
        // A drag that began over the viewport continues when the pointer leaves it.
        m.step(&press_l(over()));
        m.step(&hold_l(Inp { over: false, ..default() }, Vec2::new(9.0, 0.0)));
        assert_eq!(m.drag, Drag::Look);
    }

    #[test]
    fn wasd_needs_the_pointer_and_no_text_focus_or_command_key() {
        assert!(keys_move(true, false, false, false));
        assert!(keys_move(false, true, false, false), "a drag started over the viewport keeps flying");
        assert!(!keys_move(false, false, false, false));
        assert!(!keys_move(true, false, true, false), "typing in a field");
        assert!(!keys_move(true, false, false, true), "Cmd+S is not a move");
    }

    #[test]
    fn easing_reaches_the_target_and_ignores_the_frame_rate() {
        let t = Vec3::X * 8.0;
        let run = |dt: f32| {
            let mut v = Vec3::ZERO;
            for _ in 0..((0.5 / dt) as usize) {
                v = ease(v, t, dt);
            }
            v.x
        };
        let (a, b) = (run(1.0 / 30.0), run(1.0 / 144.0));
        assert!((a - b).abs() < 0.05, "{a} vs {b}");
        assert!(a > 7.9, "{a}");
    }
}
