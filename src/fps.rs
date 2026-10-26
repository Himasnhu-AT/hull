//! First-person controller (feature `fps`). Owner: core stream (generic parts of Shroud
//! `player.rs`: kinematic capsule with collide-and-slide against avian colliders, walk /
//! sprint / crouch / jump, mouse look from [`crate::input::LookInput`], gated by `not_paused`).
//!
//! ```ignore
//! app.add_plugins(engine::fps::FpsPlugin);
//! commands.spawn(FpsController::default().bundle(Vec3::new(0.0, 0.9, 0.0)))
//!     .with_child((MainCamera, Camera3d::default(), Transform::default()));
//! ```
//! - The camera is the controller's child tagged `MainCamera` (headless: just `MainCamera` +
//!   `Transform`); the controller moves it to eye height and applies pitch + [`FpsViewKick`].
//! - Each frame, [`FpsSet::Input`] writes keyboard + [`crate::input::LookInput`] into
//!   [`FpsInput`] (skipped for entities with [`ExternalInput`] — bots, tests, replays), then
//!   [`FpsSet::Move`] applies it. Both run only in `AppState::InGame`; Move only when not paused.
//! - Read [`FpsMotor`] (velocity, grounded, crouched) and [`FpsLook`] for footsteps, HUD, aim.
//!   Health, weapons, spawning/respawn are the game's business.

use avian3d::prelude::*;
use bevy::prelude::*;

use crate::flow::{AppState, has_visuals};
use crate::gfx::MainCamera;
use crate::input::{Bindings, LookInput};
use crate::pause::not_paused;

#[derive(Component, Reflect, Clone, Debug)]
#[reflect(Component)]
pub struct FpsController {
    pub walk_speed: f32,
    pub sprint_speed: f32,
    pub crouch_speed: f32,
    pub height: f32,
    pub crouch_height: f32,
    pub radius: f32,
    pub jump_speed: f32,
    /// Eye height above the feet, standing / crouched.
    pub eye_height: f32,
    pub crouch_eye_height: f32,
    pub gravity: f32,
    /// Horizontal acceleration (m/s²) on the ground / in the air.
    pub ground_accel: f32,
    pub air_accel: f32,
    /// Pitch limit (radians) up and down.
    pub max_pitch: f32,
}

impl Default for FpsController {
    fn default() -> Self {
        FpsController {
            walk_speed: 5.0,
            sprint_speed: 7.5,
            crouch_speed: 2.5,
            height: 1.8,
            crouch_height: 1.1,
            radius: 0.35,
            jump_speed: 5.0,
            eye_height: 1.65,
            crouch_eye_height: 0.95,
            gravity: 18.0,
            ground_accel: 60.0,
            air_accel: 12.0,
            max_pitch: 1.54,
        }
    }
}

impl FpsController {
    fn body_height(&self, crouched: bool) -> f32 {
        if crouched { self.crouch_height } else { self.height }
    }
    /// Camera offset above the capsule centre.
    pub fn eye_offset(&self, crouched: bool) -> f32 {
        if crouched { self.crouch_eye_height - self.crouch_height * 0.5 } else { self.eye_height - self.height * 0.5 }
    }
    pub fn collider(&self, crouched: bool) -> Collider {
        Collider::capsule(self.radius, (self.body_height(crouched) - 2.0 * self.radius).max(0.01))
    }
    /// Everything a controller entity needs; `center` is the capsule centre (feet + height/2).
    pub fn bundle(self, center: Vec3) -> impl Bundle {
        let motor = FpsMotor { eye_offset: self.eye_offset(false), ..default() };
        (
            Name::new("FpsController"),
            RigidBody::Kinematic,
            self.collider(false),
            motor,
            FpsLook::default(),
            FpsInput::default(),
            FpsViewKick::default(),
            Transform::from_translation(center),
            Visibility::default(),
            self,
        )
    }
}

/// What the controller should do this frame (written by [`FpsSet::Input`] or the game).
#[derive(Component, Clone, Debug, Default, PartialEq)]
pub struct FpsInput {
    /// x = strafe right, y = forward; length ≤ 1.
    pub move_axis: Vec2,
    /// Radians to turn this frame: x = yaw right, y = pitch up. Consumed by movement.
    pub look: Vec2,
    pub sprint: bool,
    pub jump: bool,
    pub crouch: bool,
}

/// Keyboard/mouse don't write this controller's [`FpsInput`] (AI, tests, replays do).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct ExternalInput;

/// Look angles in radians. `yaw = 0` faces −Z.
#[derive(Component, Reflect, Clone, Copy, Debug, Default)]
#[reflect(Component)]
pub struct FpsLook {
    pub yaw: f32,
    pub pitch: f32,
}

/// Extra view rotation on top of [`FpsLook`] (recoil, flinch); games animate it.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct FpsViewKick {
    pub pitch: f32,
    pub yaw: f32,
}

#[derive(Component, Reflect, Clone, Copy, Debug, Default)]
#[reflect(Component)]
pub struct FpsMotor {
    pub velocity: Vec3,
    pub grounded: bool,
    pub crouched: bool,
    /// Current camera height above the capsule centre (eased on crouch).
    pub eye_offset: f32,
}

/// Keys read by [`FpsSet::Input`]. With feature `actions` the controller reads the "move",
/// "sprint", "jump", "crouch" actions instead; a game that changes `FpsKeys` before startup
/// gets those keys as the actions' keyboard defaults.
#[derive(Resource, Clone, Debug)]
pub struct FpsKeys {
    pub forward: KeyCode,
    pub back: KeyCode,
    pub left: KeyCode,
    pub right: KeyCode,
    pub sprint: Vec<KeyCode>,
    pub jump: Vec<KeyCode>,
    pub crouch: Vec<KeyCode>,
}

impl Default for FpsKeys {
    fn default() -> Self {
        FpsKeys {
            forward: KeyCode::KeyW,
            back: KeyCode::KeyS,
            left: KeyCode::KeyA,
            right: KeyCode::KeyD,
            sprint: vec![KeyCode::ShiftLeft, KeyCode::ShiftRight],
            jump: vec![KeyCode::Space],
            crouch: vec![KeyCode::ControlLeft, KeyCode::ControlRight, KeyCode::KeyC],
        }
    }
}

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub enum FpsSet {
    /// Devices → [`FpsInput`].
    Input,
    /// [`FpsInput`] → look, crouch, jump, collide-and-slide. Order weapon fire after this.
    Move,
}

pub struct FpsPlugin;

impl Plugin for FpsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<FpsKeys>()
            .init_resource::<Bindings>()
            .configure_sets(Update, (FpsSet::Input, FpsSet::Move).chain().run_if(in_state(AppState::InGame)))
            .add_systems(
                Update,
                (
                    keyboard_to_input.in_set(FpsSet::Input).run_if(has_visuals),
                    move_controllers.in_set(FpsSet::Move).run_if(not_paused),
                ),
            );
        #[cfg(feature = "actions")]
        {
            use crate::actions::AddAction;
            for def in crate::actions::fps_actions() {
                app.add_action(def);
            }
            app.add_systems(Startup, fps_keys_to_actions);
        }
        let mut b = app.world_mut().resource_mut::<Bindings>();
        b.set("Move", "W A S D");
        b.set("Look", "Mouse");
        b.set("Sprint", "Shift");
        b.set("Jump", "Space");
        b.set("Crouch", "Ctrl / C");
    }
}

/// With `actions`: the rebindable "move", "sprint", "jump", "crouch" actions (keyboard +
/// gamepad; sprint/crouch follow the accessibility hold/toggle option) + [`LookInput`].
#[cfg(feature = "actions")]
fn keyboard_to_input(actions: Option<Res<crate::actions::ActionState>>, look: Res<LookInput>, mut q: Query<&mut FpsInput, Without<ExternalInput>>) {
    let Some(actions) = actions else { return };
    let mv = actions.axis2d("move").clamp_length_max(1.0);
    let (sprint, jump, crouch) = (actions.pressed("sprint"), actions.pressed("jump"), actions.pressed("crouch"));
    for mut input in &mut q {
        *input = FpsInput { move_axis: mv, look: input.look + Vec2::new(look.yaw, look.pitch), sprint, jump, crouch };
    }
}

/// `FpsKeys` changed by the game (before startup) → the keyboard bindings of the FPS actions,
/// as their defaults (so "reset" goes back to the game's keys, and saved overrides still win).
#[cfg(feature = "actions")]
fn fps_keys_to_actions(keys: Res<FpsKeys>, mut map: ResMut<crate::actions::ActionMap>) {
    use crate::actions::{Binding, Device};
    let d = FpsKeys::default();
    if keys.forward == d.forward && keys.back == d.back && keys.left == d.left && keys.right == d.right && keys.sprint == d.sprint && keys.jump == d.jump && keys.crouch == d.crouch {
        return;
    }
    let mut set = |name: &str, kbm: Vec<Binding>| {
        if let Some(a) = map.get_mut(name) {
            let pad: Vec<Binding> = a.defaults.iter().filter(|b| b.device() == Device::Gamepad).cloned().collect();
            a.defaults = kbm.into_iter().chain(pad).collect();
            a.def.bindings = a.defaults.clone();
        }
    };
    set("move", vec![Binding::keys4(keys.forward, keys.back, keys.left, keys.right)]);
    set("sprint", keys.sprint.iter().map(|k| Binding::key(*k)).collect());
    set("jump", keys.jump.iter().map(|k| Binding::key(*k)).collect());
    set("crouch", keys.crouch.iter().map(|k| Binding::key(*k)).collect());
}

#[cfg(not(feature = "actions"))]
fn keyboard_to_input(keys: Res<ButtonInput<KeyCode>>, map: Res<FpsKeys>, look: Res<LookInput>, mut q: Query<&mut FpsInput, Without<ExternalInput>>) {
    let axis = |neg: KeyCode, pos: KeyCode| (keys.pressed(pos) as i32 - keys.pressed(neg) as i32) as f32;
    let mv = Vec2::new(axis(map.left, map.right), axis(map.back, map.forward)).clamp_length_max(1.0);
    for mut input in &mut q {
        *input = FpsInput {
            move_axis: mv,
            look: input.look + Vec2::new(look.yaw, look.pitch),
            sprint: keys.any_pressed(map.sprint.iter().copied()),
            jump: keys.any_pressed(map.jump.iter().copied()),
            crouch: keys.any_pressed(map.crouch.iter().copied()),
        };
    }
}

/// Result of [`collide_and_slide`].
pub struct SlideResult {
    pub position: Vec3,
    pub hit_ground: bool,
    pub hit_ceiling: bool,
    pub hit_wall: bool,
}

const SKIN: f32 = 0.02;

/// Moves `shape` from `pos` by `disp`, sliding along anything it touches. The whole
/// displacement is swept, so nothing tunnels regardless of speed.
pub fn collide_and_slide(spatial: &SpatialQuery, shape: &Collider, pos: Vec3, disp: Vec3, filter: &SpatialQueryFilter) -> SlideResult {
    let mut out = SlideResult { position: pos, hit_ground: false, hit_ceiling: false, hit_wall: false };
    let mut remaining = disp;
    let original_dir = disp.normalize_or_zero();
    for _ in 0..4 {
        let len = remaining.length();
        let Ok(dir) = Dir3::new(remaining) else { break };
        if len < 1e-5 {
            break;
        }
        let config = ShapeCastConfig { max_distance: len + SKIN, target_distance: 0.0, compute_contact_on_penetration: true, ignore_origin_penetration: false };
        let Some(hit) = spatial.cast_shape(shape, out.position, Quat::IDENTITY, dir, &config, filter) else {
            out.position += remaining;
            break;
        };
        let n = hit.normal1.normalize_or_zero();
        let travel = (hit.distance - SKIN).clamp(0.0, len);
        out.position += *dir * travel;
        if n == Vec3::ZERO {
            break;
        }
        if n.y > 0.7 {
            out.hit_ground = true;
        } else if n.y < -0.7 {
            out.hit_ceiling = true;
        } else {
            out.hit_wall = true;
        }
        if hit.distance <= 0.0 {
            // Starting in contact/penetration: nudge out along the normal.
            out.position += n * SKIN;
        }
        remaining = *dir * (len - travel);
        let into = remaining.dot(n);
        if into < 0.0 {
            remaining -= n * into;
        }
        // Never slide back against the requested direction (prevents jitter in corners).
        if remaining.dot(original_dir) < 0.0 {
            break;
        }
    }
    out
}

fn move_controllers(
    mut commands: Commands,
    time: Res<Time>,
    spatial: SpatialQuery,
    mut controllers: Query<
        (Entity, &FpsController, &mut Transform, &mut FpsLook, &mut FpsMotor, &mut FpsInput, Option<&FpsViewKick>, Option<&Children>),
        Without<MainCamera>,
    >,
    mut cams: Query<&mut Transform, With<MainCamera>>,
) {
    let dt = time.delta_secs().min(0.05);
    for (entity, ctl, mut tf, mut look, mut motor, mut input, kick, children) in &mut controllers {
        // Collider is read by SpatialQuery, so it is replaced via commands.
        let mut collider = ctl.collider(motor.crouched);
        let filter = SpatialQueryFilter::from_excluded_entities([entity]);

        // Look.
        look.yaw -= input.look.x;
        look.pitch = (look.pitch + input.look.y).clamp(-ctl.max_pitch, ctl.max_pitch);
        input.look = Vec2::ZERO;
        tf.rotation = Quat::from_rotation_y(look.yaw);

        // Crouch (feet stay planted; standing up needs headroom).
        if input.crouch != motor.crouched {
            let dh = ctl.height - ctl.crouch_height;
            let can_change = input.crouch || {
                let config = ShapeCastConfig::from_max_distance(dh);
                spatial.cast_shape(&collider, tf.translation, Quat::IDENTITY, Dir3::Y, &config, &filter).is_none()
            };
            if can_change {
                let shift = if input.crouch { -dh * 0.5 } else { dh * 0.5 };
                if motor.grounded {
                    tf.translation.y += shift;
                    // Keep the eye where it was; it then eases to the new height.
                    motor.eye_offset -= shift;
                }
                motor.crouched = input.crouch;
                collider = ctl.collider(motor.crouched);
                commands.entity(entity).insert(collider.clone());
            }
        }

        // Horizontal velocity.
        let speed = if motor.crouched {
            ctl.crouch_speed
        } else if input.sprint && input.move_axis.y > 0.1 {
            ctl.sprint_speed
        } else {
            ctl.walk_speed
        };
        let fwd = tf.rotation * Vec3::NEG_Z;
        let right = tf.rotation * Vec3::X;
        let axis = input.move_axis.clamp_length_max(1.0);
        let wish = (right * axis.x + fwd * axis.y) * speed;
        let accel = if motor.grounded { ctl.ground_accel } else { ctl.air_accel };
        let horiz = Vec3::new(motor.velocity.x, 0.0, motor.velocity.z);
        let step = (wish - horiz).clamp_length_max(accel * dt);
        motor.velocity.x += step.x;
        motor.velocity.z += step.z;

        // Vertical velocity.
        if motor.grounded && input.jump && !motor.crouched {
            motor.velocity.y = ctl.jump_speed;
            motor.grounded = false;
        }
        motor.velocity.y -= ctl.gravity * dt;

        // Sweep horizontally, then vertically.
        let h = collide_and_slide(&spatial, &collider, tf.translation, Vec3::new(motor.velocity.x, 0.0, motor.velocity.z) * dt, &filter);
        if h.hit_wall && dt > 0.0 {
            let moved = (h.position - tf.translation) / dt;
            motor.velocity.x = moved.x;
            motor.velocity.z = moved.z;
        }
        let v = collide_and_slide(&spatial, &collider, h.position, Vec3::Y * motor.velocity.y * dt, &filter);
        motor.grounded = v.hit_ground && motor.velocity.y <= 0.0;
        if motor.grounded || (v.hit_ceiling && motor.velocity.y > 0.0) {
            motor.velocity.y = 0.0;
        }
        tf.translation = v.position;

        // Camera: ease eye height, apply pitch + kick.
        let target = ctl.eye_offset(motor.crouched);
        motor.eye_offset += (target - motor.eye_offset) * (1.0 - (-14.0 * dt).exp());
        let kick = kick.copied().unwrap_or_default();
        for child in children.into_iter().flatten() {
            if let Ok(mut cam) = cams.get_mut(*child) {
                cam.translation = Vec3::new(0.0, motor.eye_offset, 0.0);
                cam.rotation = Quat::from_rotation_y(kick.yaw) * Quat::from_rotation_x(look.pitch + kick.pitch);
            }
        }
    }
}
