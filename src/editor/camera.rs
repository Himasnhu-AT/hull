//! The editor's viewport camera: it drives the game's `MainCamera` (or spawns one).
//!
//! | Input (pointer over the viewport) | Does |
//! |---|---|
//! | hold right mouse + W A S D | fly; Q / E down / up; Shift = 3x faster |
//! | right mouse + scroll | fly speed |
//! | scroll | dolly forward / back |
//! | Alt + left mouse drag | orbit around the pivot (selection centre, else a point ahead) |
//! | middle mouse drag | pan |
//! | F (or Focus in the toolbar) | frame the selection |
//!
//! The pose is applied in `PostUpdate` before transform propagation, so a game system that also
//! moves its camera (a follow camera) is overridden while editing.

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
    mode: Drag,
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum Drag {
    #[default]
    None,
    Fly,
    Orbit,
    Pan,
}

impl Default for EditorCamera {
    fn default() -> Self {
        EditorCamera { entity: None, pos: Vec3::new(8.0, 6.0, 10.0), yaw: 0.0, pitch: 0.0, speed: 8.0, pivot: Vec3::ZERO, mode: Drag::None }
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
pub fn control(
    mut cam: ResMut<EditorCamera>,
    mut st: ResMut<EditorState>,
    mouse: Res<ButtonInput<MouseButton>>,
    keys: Res<ButtonInput<KeyCode>>,
    motion: Res<AccumulatedMouseMotion>,
    scroll: Res<AccumulatedMouseScroll>,
    time: Res<Time<Real>>,
    gts: Query<&GlobalTransform>,
    mode: Option<Res<EditorMode>>,
) {
    if mode.is_none() {
        return;
    }
    let hover = st.ui.pointer_over_viewport && !st.ui.wants_pointer;
    let alt = keys.any_pressed([KeyCode::AltLeft, KeyCode::AltRight]);
    if cam.mode == Drag::None {
        if hover && mouse.just_pressed(MouseButton::Right) {
            cam.mode = Drag::Fly;
        } else if hover && alt && mouse.just_pressed(MouseButton::Left) {
            cam.mode = Drag::Orbit;
            // Orbit around the selection when there is one.
            if let Some(c) = picking::selection_centre(&st, &gts) {
                cam.pivot = c;
            }
        } else if hover && mouse.just_pressed(MouseButton::Middle) {
            cam.mode = Drag::Pan;
        }
    }
    // The gizmo owns the left button when it is dragging; the camera only holds `busy` for its own drags.
    let held = match cam.mode {
        Drag::None => false,
        Drag::Fly => mouse.pressed(MouseButton::Right),
        Drag::Orbit => mouse.pressed(MouseButton::Left),
        Drag::Pan => mouse.pressed(MouseButton::Middle),
    };
    if !held {
        cam.mode = Drag::None;
    }
    let cam_busy = cam.mode != Drag::None;
    st.cam_busy = cam_busy;
    let dt = time.delta_secs().min(0.1);
    let d = motion.delta;
    let wheel = match scroll.unit {
        MouseScrollUnit::Line => scroll.delta.y,
        MouseScrollUnit::Pixel => scroll.delta.y / 40.0,
    };
    match cam.mode {
        Drag::Fly => {
            cam.yaw -= d.x * 0.003;
            cam.pitch -= d.y * 0.003;
            cam.clamp_pitch();
            if wheel != 0.0 {
                cam.speed = (cam.speed * 1.2f32.powf(wheel)).clamp(0.2, 400.0);
            }
            let rot = cam.rotation();
            let mut dir = Vec3::ZERO;
            for (k, v) in [(KeyCode::KeyW, Vec3::NEG_Z), (KeyCode::KeyS, Vec3::Z), (KeyCode::KeyA, Vec3::NEG_X), (KeyCode::KeyD, Vec3::X)] {
                if keys.pressed(k) {
                    dir += rot * v;
                }
            }
            if keys.pressed(KeyCode::KeyE) {
                dir += Vec3::Y;
            }
            if keys.pressed(KeyCode::KeyQ) {
                dir -= Vec3::Y;
            }
            let boost = if keys.any_pressed([KeyCode::ShiftLeft, KeyCode::ShiftRight]) { 3.0 } else { 1.0 };
            let step = dir.normalize_or_zero() * cam.speed * boost * dt;
            cam.pos += step;
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
            let k = dist * 0.0015;
            let delta = rot * Vec3::new(-d.x * k, d.y * k, 0.0);
            cam.pos += delta;
            cam.pivot += delta;
        }
        Drag::None => {
            if hover && wheel != 0.0 {
                let dist = (cam.pos - cam.pivot).length().max(1.0);
                let f = cam.forward();
                cam.pos += f * wheel * dist * 0.12;
            }
        }
    }
    if cam.mode != Drag::Orbit && cam.mode != Drag::None {
        cam.pivot = cam.pos + cam.forward() * (cam.pivot - cam.pos).length().max(2.0);
    }
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
