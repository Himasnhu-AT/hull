//! Camera rigs (feature `camera_rigs`): one [`CameraRig`] component on a camera, a [`RigMode`]
//! that says how it moves, and optional speed [`Feel`] (FOV kick, shake) on top. The rigs are
//! target-agnostic: they follow any root entity's `Transform` (a vehicle, a character, a
//! drone) and derive its speed from how it moves. Docs: `docs/ENVIRONMENT.md`.
//!
//! - [`Chase`]: a spring arm behind the target (closed-form springs per axis: speeding up
//!   stretches the boom, braking squashes it), heading blended towards the direction of travel
//!   so a slide shows as the target at an angle; pulled in front of colliders (`physics`).
//! - [`Mounted`]: fixed to the target (cockpit, bonnet, helmet) with a lagged view direction and
//!   road buzz.
//! - [`Orbit`]: around a point on the target; mouse / stick, zoom, optional turntable.
//! - [`Free`]: a free-flying photo camera, input-agnostic ([`RigInput`]).
//!
//! ```ignore
//! commands.spawn((MainCamera, Camera3d::default(), CameraRig::chase(car).with_feel(Feel::default())));
//! // Switch view (a cut: the new rig starts fresh, no smear):
//! rig.set_mode(RigMode::Mounted(Mounted { offset: Vec3::new(0.0, 1.2, -0.3), ..default() }));
//! ```
//!
//! Runs in `PostUpdate` before transform propagation (like [`crate::chase`], which stays as the
//! simple one-mode camera). `active: false` hands the camera back to the game. Everything is
//! plain data and pure maths below the system, so tests step it without a window.

pub mod arm;

#[cfg(feature = "devtools")]
mod control;

use bevy::input::mouse::AccumulatedMouseScroll;
use bevy::prelude::*;
use bevy::transform::TransformSystems;

pub use arm::{Arm, ArmTuning, Axis, Spring};

use crate::input::LookInput;
use crate::pause::Paused;

/// How a rig moves the camera.
#[derive(Clone, Debug)]
pub enum RigMode {
    Chase(Chase),
    Mounted(Mounted),
    Orbit(Orbit),
    Free(Free),
}

/// Spring-arm chase. Distances in metres, speeds in m/s.
#[derive(Clone, Debug)]
pub struct Chase {
    /// Rest boom length and height above the target's origin.
    pub boom: f32,
    pub height: f32,
    /// Boom and height change between `speed_range`'s ends (a long, low arm at speed).
    pub speed_boom: f32,
    pub speed_height: f32,
    pub speed_range: (f32, f32),
    /// Aim this far ahead of the target along the arm's heading, at this height.
    pub look_ahead: f32,
    pub look_height: f32,
    /// 0 = the arm points along the target's nose, 1 = along its direction of travel (above ~6 m/s).
    pub travel_heading: f32,
    /// Spring stiffness multiplier (0.5 loose .. 1.5 tight).
    pub stiffness: f32,
    pub tuning: ArmTuning,
    /// Stay this far in front of colliders between target and camera (`physics`).
    pub clearance: f32,
}

impl Default for Chase {
    fn default() -> Self {
        Chase {
            boom: 6.8,
            height: 2.3,
            speed_boom: 0.8,
            speed_height: -0.25,
            speed_range: (16.7, 50.0),
            look_ahead: 4.0,
            look_height: 0.9,
            travel_heading: 0.7,
            stiffness: 1.0,
            tuning: ArmTuning::default(),
            clearance: 0.4,
        }
    }
}

/// Fixed to the target at `offset` (its local space).
#[derive(Clone, Debug)]
pub struct Mounted {
    pub offset: Vec3,
    /// Extra pitch (radians, negative looks down).
    pub pitch: f32,
    /// How fast the view direction follows the body (1/s; 0 = rigid). A low rate keeps
    /// suspension shake out of the eye.
    pub lag: f32,
    /// Road buzz amplitude (m) at full speed feel; needs [`Feel`].
    pub buzz: f32,
}

impl Default for Mounted {
    fn default() -> Self {
        Mounted { offset: Vec3::new(0.0, 1.2, 0.0), pitch: -0.05, lag: 12.0, buzz: 0.004 }
    }
}

/// Orbit around `target + Vec3::Y * height`.
#[derive(Clone, Debug)]
pub struct Orbit {
    pub distance: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub height: f32,
    pub min_distance: f32,
    pub max_distance: f32,
    pub min_pitch: f32,
    pub max_pitch: f32,
    /// Position follow rate (1/s).
    pub follow: f32,
    /// Turntable speed (rad/s); 0 = only input moves it.
    pub spin: f32,
}

impl Default for Orbit {
    fn default() -> Self {
        Orbit { distance: 6.0, yaw: 0.6, pitch: 0.25, height: 1.0, min_distance: 1.5, max_distance: 60.0, min_pitch: -0.3, max_pitch: 1.4, follow: 12.0, spin: 0.0 }
    }
}

/// A free-flying (photo) camera. Starts where the camera is.
#[derive(Clone, Debug)]
pub struct Free {
    /// Metres per second; `fast` multiplies it.
    pub speed: f32,
    pub fast: f32,
    /// Velocity easing (1/s).
    pub accel: f32,
    /// Vertical field of view (degrees) to set; `None` leaves the projection alone.
    pub fov: Option<f32>,
    velocity: Vec3,
    yaw: f32,
    pitch: f32,
    started: bool,
}

impl Default for Free {
    fn default() -> Self {
        Free { speed: 8.0, fast: 4.0, accel: 10.0, fov: None, velocity: Vec3::ZERO, yaw: 0.0, pitch: 0.0, started: false }
    }
}

/// Speed feel modifiers (optional per rig): the view widens and shakes as the target speeds up.
#[derive(Clone, Debug)]
pub struct Feel {
    /// Extra vertical FOV (degrees) at full speed feel; scaled by [`CameraRigSettings::fov`].
    pub fov_kick: f32,
    /// Mounted views widen less (their frame makes it look larger).
    pub inside_scale: f32,
    /// Speed (m/s) where the feel starts and where it is full.
    pub range: (f32, f32),
    /// Chase shake amplitude (m) at full feel; scaled by [`CameraRigSettings::shake`].
    pub shake: f32,
    /// Starts above this feel (0..1).
    pub shake_from: f32,
}

impl Default for Feel {
    fn default() -> Self {
        Feel { fov_kick: 7.0, inside_scale: 0.7, range: (11.1, 50.0), shake: 0.012, shake_from: 0.6 }
    }
}

/// Global comfort scales (accessibility / settings): 0 turns the effect off.
#[derive(Resource, Clone, Copy, Debug, PartialEq)]
pub struct CameraRigSettings {
    pub shake: f32,
    pub fov: f32,
}

impl Default for CameraRigSettings {
    fn default() -> Self {
        CameraRigSettings { shake: 1.0, fov: 1.0 }
    }
}

/// How fast it feels, 0..1 (smoothstep over the active rig's [`Feel::range`]). FOV, shake and
/// anything else (motion blur, wind sound) read this one value, so sight and sound ramp together.
#[derive(Resource, Clone, Copy, Debug, Default, PartialEq)]
pub struct SpeedFeel(pub f32);

/// Movement input for [`Free`] / [`Orbit`], filled from keys + mouse unless `default_input` is
/// off on the rig (then write it yourself: gamepad, scripts).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RigInput {
    /// x right, y up, z forward; each -1..1.
    pub movement: Vec3,
    /// Yaw, pitch delta (radians, positive pitch looks up).
    pub look: Vec2,
    /// Orbit zoom: positive moves away.
    pub zoom: f32,
    pub fast: bool,
}

#[derive(Clone, Debug, Default)]
struct RigState {
    arm: Option<Arm>,
    head: Option<Quat>,
    last_pos: Option<Vec3>,
    vel: Vec3,
    fov: f32,
    smoothed_feel: f32,
    orbit_pos: Option<Vec3>,
    base_fov: Option<f32>,
    /// Frames since a cut (view switch, teleport): motion blur and the like should skip these.
    cut_frames: u8,
}

/// The rig on a camera.
#[derive(Component, Clone, Debug)]
pub struct CameraRig {
    pub target: Option<Entity>,
    pub mode: RigMode,
    pub active: bool,
    pub feel: Option<Feel>,
    pub input: RigInput,
    /// Fill `input` from the keyboard (WASD, Q/E, Shift) and mouse.
    pub default_input: bool,
    /// Treat the next frame as a cut (teleport the camera, reset springs).
    pub snap: bool,
    state: RigState,
}

impl CameraRig {
    fn new(target: Option<Entity>, mode: RigMode) -> Self {
        CameraRig { target, mode, active: true, feel: None, input: RigInput::default(), default_input: true, snap: true, state: RigState::default() }
    }
    pub fn chase(target: Entity) -> Self {
        Self::new(Some(target), RigMode::Chase(Chase::default()))
    }
    pub fn mounted(target: Entity, offset: Vec3) -> Self {
        Self::new(Some(target), RigMode::Mounted(Mounted { offset, ..default() }))
    }
    pub fn orbit(target: Entity) -> Self {
        Self::new(Some(target), RigMode::Orbit(Orbit::default()))
    }
    pub fn free() -> Self {
        Self::new(None, RigMode::Free(Free::default()))
    }
    pub fn with_feel(mut self, feel: Feel) -> Self {
        self.feel = Some(feel);
        self
    }
    /// Switches how the rig moves: a cut, springs and smoothing start fresh.
    pub fn set_mode(&mut self, mode: RigMode) {
        self.mode = mode;
        self.cut();
    }
    /// A cut: the next frame teleports to the wanted pose.
    pub fn cut(&mut self) {
        self.snap = true;
    }
    /// Kicks a chase arm down by about `m` metres at its deepest (a landing).
    pub fn kick(&mut self, m: f32) {
        if let (Some(arm), RigMode::Chase(c)) = (self.state.arm.as_mut(), &self.mode) {
            arm.kick(m, c.stiffness, &c.tuning);
        }
    }
    /// Frames since the last cut (0 = a cut happened this frame); saturates.
    pub fn frames_since_cut(&self) -> u8 {
        self.state.cut_frames
    }
    /// The target's speed (m/s) as the rig last saw it.
    pub fn target_speed(&self) -> f32 {
        self.state.vel.length()
    }
}

pub struct CameraRigsPlugin;

impl Plugin for CameraRigsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<CameraRigSettings>()
            .init_resource::<SpeedFeel>()
            .init_resource::<LookInput>()
            .add_systems(PostUpdate, (read_input, drive_rigs).chain().run_if(any_with_component::<CameraRig>).before(TransformSystems::Propagate));
        #[cfg(feature = "devtools")]
        control::register(app);
    }
}

// ---------------------------------------------------------------- maths

/// Speed feel 0..1 at `speed` m/s over `range`.
pub fn speed_feel(speed: f32, range: (f32, f32)) -> f32 {
    let x = ((speed.abs() - range.0) / (range.1 - range.0).max(1e-3)).clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// Rest boom and height of a chase at `speed` m/s.
pub fn rest_boom(c: &Chase, speed: f32) -> (f32, f32) {
    let s = speed_feel(speed, c.speed_range);
    (c.boom + c.speed_boom * s, c.height + c.speed_height * s)
}

/// Low-frequency noise (-1..1) of three summed sines.
fn noise(t: f32, a: f32, b: f32, c: f32, ph: f32) -> f32 {
    (t * a + ph).sin() * 0.5 + (t * b + 1.3 + ph).sin() * 0.3 + (t * c + 2.1 + ph).sin() * 0.2
}

/// The direction the chase arm should point: along the nose, blended towards the travel
/// direction as the target moves.
pub fn chase_dir(flat_nose: Vec3, vel: Vec3, blend: f32) -> Vec3 {
    let v = Vec3::new(vel.x, 0.0, vel.z);
    let w = blend * ((v.length() - 3.0) / 3.0).clamp(0.0, 1.0);
    // Only forward travel counts (reversing keeps the nose).
    if w <= 0.0 || v.dot(flat_nose) <= 0.0 {
        return flat_nose;
    }
    flat_nose.lerp(v.normalize(), w).normalize_or(flat_nose)
}

// ---------------------------------------------------------------- systems

fn read_input(keys: Res<ButtonInput<KeyCode>>, look: Res<LookInput>, scroll: Option<Res<AccumulatedMouseScroll>>, paused: Option<Res<Paused>>, mut rigs: Query<&mut CameraRig>) {
    if paused.is_some_and(|p| p.0) {
        return;
    }
    let axis = |neg: KeyCode, pos: KeyCode| keys.pressed(pos) as i32 as f32 - keys.pressed(neg) as i32 as f32;
    let movement = Vec3::new(axis(KeyCode::KeyA, KeyCode::KeyD), axis(KeyCode::KeyQ, KeyCode::KeyE), axis(KeyCode::KeyS, KeyCode::KeyW));
    let zoom = -scroll.map_or(0.0, |s| s.delta.y) * 0.1;
    for mut r in &mut rigs {
        if r.default_input && r.active {
            r.input = RigInput { movement, look: Vec2::new(look.yaw, look.pitch), zoom, fast: keys.pressed(KeyCode::ShiftLeft) };
        }
    }
}

fn drive_rigs(
    time: Res<Time>,
    settings: Res<CameraRigSettings>,
    core: Option<Res<crate::settings::CoreSettings>>,
    mut feel_out: ResMut<SpeedFeel>,
    targets: Query<&Transform, Without<CameraRig>>,
    mut cams: Query<(&mut CameraRig, &mut Transform, Option<&mut Projection>)>,
    #[cfg(feature = "physics")] spatial: Option<avian3d::prelude::SpatialQuery>,
) {
    let dt = time.delta_secs();
    let t = time.elapsed_secs_wrapped();
    let mut first = true;
    for (mut rig, mut cam, proj) in &mut cams {
        if !rig.active {
            continue;
        }
        let rig = &mut *rig;
        let target = rig.target.and_then(|e| targets.get(e).ok().copied());
        let mut snap = std::mem::take(&mut rig.snap);
        let st = &mut rig.state;
        // Speed from how the target moves; a big jump is a teleport (a cut).
        if let Some(tt) = target {
            if let Some(last) = st.last_pos {
                if last.distance(tt.translation) > 8.0 {
                    snap = true;
                } else if dt > 1e-5 {
                    let v = (tt.translation - last) / dt;
                    st.vel = st.vel.lerp(v.clamp_length_max(200.0), 1.0 - (-12.0 * dt).exp());
                }
            }
            st.last_pos = Some(tt.translation);
        }
        if snap {
            st.arm = None;
            st.head = None;
            st.orbit_pos = None;
            st.vel = Vec3::ZERO;
            st.cut_frames = 0;
        } else {
            st.cut_frames = st.cut_frames.saturating_add(1);
        }
        let speed = st.vel.length();
        let feel = rig.feel.clone();
        let raw = feel.as_ref().map_or(0.0, |f| speed_feel(speed, f.range));
        let inside = matches!(rig.mode, RigMode::Mounted(_));
        let input = rig.input;
        rig.input.look = Vec2::ZERO;
        rig.input.zoom = 0.0;
        match &mut rig.mode {
            RigMode::Chase(c) => {
                let Some(tt) = target else { continue };
                let fwd = tt.rotation * Vec3::NEG_Z;
                let flat = Vec3::new(fwd.x, 0.0, fwd.z).normalize_or(Vec3::NEG_Z);
                let dir = chase_dir(flat, st.vel, c.travel_heading);
                let (want, nose) = (dir.x.atan2(dir.z), flat.x.atan2(flat.z));
                let (boom, height) = rest_boom(c, speed);
                let rest = arm::rest_pose(tt.translation, want, boom, height, c.look_ahead, c.look_height);
                let arm = st.arm.get_or_insert_with(|| Arm::new(tt.translation, want, rest.0, rest.1));
                let (mut eye, aim) = arm.step(nose, want, rest, &c.tuning, c.stiffness, dt);
                // Shake at speed: low-frequency noise scaled by the feel.
                if let Some(f) = &feel {
                    let amp = f.shake * settings.shake * ((raw - f.shake_from) / (1.0 - f.shake_from).max(1e-3)).clamp(0.0, 1.0);
                    if amp > 0.0 {
                        let h = arm::heading_dir(arm.heading);
                        let right = Vec3::new(-h.z, 0.0, h.x);
                        eye += right * noise(t, 6.3, 7.7, 8.9, 0.0) * amp * 0.6 + Vec3::Y * noise(t, 7.1, 8.3, 6.1, 0.7) * amp;
                    }
                }
                // Pull in front of any collider between the target and the camera.
                #[cfg(feature = "physics")]
                {
                    use avian3d::prelude::SpatialQueryFilter;
                    let from = tt.translation + Vec3::Y * c.look_height;
                    let filter = SpatialQueryFilter::from_excluded_entities(rig.target);
                    if let Some(spatial) = &spatial
                        && let Ok((d, len)) = Dir3::new_and_length(eye - from)
                        && let Some(hit) = spatial.cast_ray(from, d, len + c.clearance, true, &filter)
                    {
                        eye = from + d * (hit.distance - c.clearance).max(0.5);
                    }
                }
                *cam = Transform::from_translation(eye).looking_at(aim, Vec3::Y);
            }
            RigMode::Mounted(m) => {
                let Some(tt) = target else { continue };
                let k = if m.lag <= 0.0 || snap { 1.0 } else { 1.0 - (-dt * m.lag).exp() };
                let look = match st.head {
                    Some(q) if q.dot(tt.rotation).abs() > 0.97 => q.slerp(tt.rotation, k),
                    _ => tt.rotation,
                };
                st.head = Some(look);
                let amp = m.buzz * settings.shake * raw;
                let b = Vec3::new(noise(t, 17.0, 29.3, 41.1, 0.0) * 0.4, noise(t, 13.1, 23.7, 37.9, 0.5), 0.0) * amp;
                cam.translation = tt.translation + tt.rotation * (m.offset + b);
                cam.rotation = look * Quat::from_rotation_x(m.pitch + noise(t, 11.3, 19.1, 33.7, 1.0) * amp * 0.35);
            }
            RigMode::Orbit(o) => {
                let Some(tt) = target else { continue };
                o.yaw -= input.look.x;
                o.pitch = (o.pitch + input.look.y).clamp(o.min_pitch, o.max_pitch);
                o.yaw += o.spin * dt;
                if input.zoom != 0.0 {
                    o.distance = (o.distance * (input.zoom * 0.5).exp()).clamp(o.min_distance, o.max_distance);
                }
                let centre = tt.translation + Vec3::Y * o.height;
                let want = centre + Vec3::new(o.yaw.sin() * o.pitch.cos(), o.pitch.sin(), o.yaw.cos() * o.pitch.cos()) * o.distance;
                let pos = match st.orbit_pos {
                    Some(p) if !snap => p.lerp(want, 1.0 - (-o.follow * dt).exp()),
                    _ => want,
                };
                st.orbit_pos = Some(pos);
                *cam = Transform::from_translation(pos).looking_at(centre, Vec3::Y);
            }
            RigMode::Free(f) => {
                if !f.started || snap {
                    let (yaw, pitch, _) = cam.rotation.to_euler(EulerRot::YXZ);
                    (f.yaw, f.pitch, f.started, f.velocity) = (yaw, pitch, true, Vec3::ZERO);
                }
                f.yaw -= input.look.x;
                f.pitch = (f.pitch + input.look.y).clamp(-1.55, 1.55);
                cam.rotation = Quat::from_euler(EulerRot::YXZ, f.yaw, f.pitch, 0.0);
                let want = (cam.rotation * Vec3::new(input.movement.x, 0.0, -input.movement.z) + Vec3::Y * input.movement.y).clamp_length_max(1.0)
                    * f.speed
                    * if input.fast { f.fast } else { 1.0 };
                f.velocity = f.velocity.lerp(want, 1.0 - (-f.accel * dt).exp());
                cam.translation += f.velocity * dt;
                if let (Some(fov), Some(mut p)) = (f.fov, proj)
                    && let Projection::Perspective(pp) = p.as_mut()
                    && (pp.fov - fov.to_radians()).abs() > 1e-4
                {
                    pp.fov = fov.to_radians();
                }
                continue;
            }
        }
        // Speed widens the view, eased so a hit does not snap it.
        if let Some(f) = &feel {
            st.smoothed_feel += (raw - st.smoothed_feel) * (1.0 - (-dt * 2.0).exp());
            let kick = f.fov_kick * if inside { f.inside_scale } else { 1.0 } * settings.fov * raw;
            st.fov += (kick - st.fov) * (1.0 - (-dt * 2.0).exp());
            if let Some(mut p) = proj
                && let Projection::Perspective(pp) = p.as_mut()
            {
                // The base view: the settings' FOV, else the one the camera had when the rig started.
                let base = core.as_deref().map_or_else(|| *st.base_fov.get_or_insert(pp.fov.to_degrees()), |c| c.fov_deg.clamp(30.0, 150.0));
                let fov = (base + st.fov).to_radians();
                if (pp.fov - fov).abs() > 1e-4 {
                    pp.fov = fov;
                }
            }
            if first {
                feel_out.0 = raw;
                first = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::time::TimeUpdateStrategy;
    use std::time::Duration;

    fn app() -> App {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, TransformPlugin, CameraRigsPlugin));
        app.init_resource::<ButtonInput<KeyCode>>();
        app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(1.0 / 60.0)));
        app.update();
        app
    }

    fn run(app: &mut App, frames: usize, mut each: impl FnMut(&mut World)) {
        for _ in 0..frames {
            each(app.world_mut());
            app.update();
        }
    }

    fn cam_pos(app: &mut App, cam: Entity) -> Vec3 {
        app.world().entity(cam).get::<Transform>().unwrap().translation
    }

    #[test]
    fn speed_feel_ramps_between_the_range_ends() {
        let r = (11.1, 50.0);
        assert_eq!(speed_feel(0.0, r), 0.0);
        assert_eq!(speed_feel(60.0, r), 1.0);
        let mid = speed_feel(30.0, r);
        assert!(mid > 0.3 && mid < 0.8);
        assert_eq!(speed_feel(-60.0, r), 1.0, "reversing feels as fast");
    }

    #[test]
    fn chase_dir_follows_travel_only_when_moving_forward() {
        let nose = Vec3::NEG_Z;
        assert_eq!(chase_dir(nose, Vec3::ZERO, 1.0), nose);
        let sliding = chase_dir(nose, Vec3::new(10.0, 0.0, -10.0), 1.0);
        assert!(sliding.x > 0.3, "{sliding}");
        assert_eq!(chase_dir(nose, Vec3::new(0.0, 0.0, 10.0), 1.0), nose, "reversing keeps the nose");
    }

    #[test]
    fn chase_trails_behind_a_moving_target_and_snaps_on_teleport() {
        let mut app = app();
        let target = app.world_mut().spawn(Transform::from_xyz(0.0, 0.0, 0.0)).id();
        let cam = app.world_mut().spawn((Transform::default(), CameraRig::chase(target))).id();
        // Drive along -Z at 20 m/s.
        run(&mut app, 240, |w| w.entity_mut(target).get_mut::<Transform>().unwrap().translation.z -= 20.0 / 60.0);
        let (tp, cp) = (app.world().entity(target).get::<Transform>().unwrap().translation, cam_pos(&mut app, cam));
        assert!(cp.z > tp.z + 5.0 && cp.z < tp.z + 9.5, "behind by {}", cp.z - tp.z);
        assert!(cp.y > 1.8 && cp.y < 3.0, "height {}", cp.y);
        assert!((cp.x - tp.x).abs() < 0.3);
        let rig = app.world().entity(cam).get::<CameraRig>().unwrap();
        assert!((rig.target_speed() - 20.0).abs() < 1.5, "{}", rig.target_speed());
        // Teleport: a cut, the camera is behind the new spot at once.
        app.world_mut().entity_mut(target).get_mut::<Transform>().unwrap().translation = Vec3::new(500.0, 0.0, 500.0);
        app.update();
        assert!(cam_pos(&mut app, cam).distance(Vec3::new(500.0, 2.3, 507.0)) < 3.0);
        assert_eq!(app.world().entity(cam).get::<CameraRig>().unwrap().frames_since_cut(), 0);
    }

    #[test]
    fn mounted_sits_in_the_targets_frame() {
        let mut app = app();
        let target = app.world_mut().spawn(Transform::from_xyz(5.0, 0.0, 0.0).with_rotation(Quat::from_rotation_y(1.0))).id();
        let cam = app.world_mut().spawn((Transform::default(), CameraRig::mounted(target, Vec3::new(0.0, 1.0, -0.5)))).id();
        run(&mut app, 4, |_| {});
        let want = Vec3::new(5.0, 0.0, 0.0) + Quat::from_rotation_y(1.0) * Vec3::new(0.0, 1.0, -0.5);
        assert!(cam_pos(&mut app, cam).distance(want) < 1e-3);
    }

    #[test]
    fn orbit_keeps_its_distance_and_input_turns_it() {
        let mut app = app();
        let target = app.world_mut().spawn(Transform::from_xyz(0.0, 0.0, -10.0)).id();
        let cam = app.world_mut().spawn((Transform::default(), CameraRig { default_input: false, ..CameraRig::orbit(target) })).id();
        run(&mut app, 4, |_| {});
        let centre = Vec3::new(0.0, 1.0, -10.0);
        assert!((cam_pos(&mut app, cam).distance(centre) - 6.0).abs() < 0.05);
        let before = cam_pos(&mut app, cam);
        run(&mut app, 60, |w| w.entity_mut(cam).get_mut::<CameraRig>().unwrap().input.look = Vec2::new(0.02, 0.0));
        let after = cam_pos(&mut app, cam);
        assert!(before.distance(after) > 1.0);
        assert!((after.distance(centre) - 6.0).abs() < 0.1, "still 6 m away");
    }

    #[test]
    fn free_flies_with_input_and_stops_without() {
        let mut app = app();
        let cam = app.world_mut().spawn((Transform::default(), CameraRig { default_input: false, ..CameraRig::free() })).id();
        run(&mut app, 60, |w| w.entity_mut(cam).get_mut::<CameraRig>().unwrap().input.movement = Vec3::Z);
        let p = cam_pos(&mut app, cam);
        assert!(p.z < -3.0 && p.x.abs() < 1e-3, "forward is -Z: {p}");
        let stop = |w: &mut World| w.entity_mut(cam).get_mut::<CameraRig>().unwrap().input.movement = Vec3::ZERO;
        run(&mut app, 120, stop);
        let q = cam_pos(&mut app, cam);
        run(&mut app, 30, stop);
        assert!(cam_pos(&mut app, cam).distance(q) < 0.05, "settled");
    }

    #[test]
    fn feel_widens_the_view_and_reports_speed_feel() {
        let mut app = app();
        let target = app.world_mut().spawn(Transform::default()).id();
        let cam = app
            .world_mut()
            .spawn((Transform::default(), Projection::Perspective(PerspectiveProjection { fov: 1.0, ..default() }), CameraRig::chase(target).with_feel(Feel::default())))
            .id();
        run(&mut app, 300, |w| w.entity_mut(target).get_mut::<Transform>().unwrap().translation.z -= 60.0 / 60.0);
        let Projection::Perspective(p) = app.world().entity(cam).get::<Projection>().unwrap() else { panic!() };
        assert!(p.fov > 1.0 + 0.05, "fov {}", p.fov);
        assert!(app.world().resource::<SpeedFeel>().0 > 0.9);
        // Comfort setting 0 turns the kick off.
        app.world_mut().resource_mut::<CameraRigSettings>().fov = 0.0;
        run(&mut app, 300, |w| w.entity_mut(target).get_mut::<Transform>().unwrap().translation.z -= 1.0);
        let Projection::Perspective(p) = app.world().entity(cam).get::<Projection>().unwrap() else { panic!() };
        assert!((p.fov - 1.0).abs() < 0.02, "fov {}", p.fov);
    }
}
