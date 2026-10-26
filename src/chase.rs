//! Third-person chase camera: put [`ChaseCamera`] on the [`MainCamera`](crate::gfx::MainCamera)
//! and point it at a root entity (a vehicle, a character). It trails behind the target's
//! heading, looks slightly ahead, orbits with the mouse ([`LookInput`]) and drifts back behind
//! the target when the mouse rests. With `physics` it never ends up behind a collider: a ray
//! from the target to the wanted camera spot pulls it in front of walls and terrain.
//!
//! ```ignore
//! commands.spawn((MainCamera, Camera3d::default(), ChaseCamera::new(bike)));
//! ```
//! Runs in `PostUpdate` before transform propagation and reads the target's `Transform`, so a
//! physics body with transform interpolation is followed smoothly. `active: false` hands the
//! camera back to the game (menus, cutscenes); set `snap = true` after teleporting the target.

use bevy::prelude::*;
use bevy::transform::TransformSystems;

use crate::input::LookInput;
use crate::pause::Paused;

/// Follows `target` from behind. Distances in metres, rates in 1/s (higher = stiffer).
#[derive(Component, Reflect, Clone, Debug)]
#[reflect(Component)]
pub struct ChaseCamera {
    pub target: Entity,
    pub active: bool,
    /// Distance behind the target (horizontal).
    pub distance: f32,
    /// Camera height above the target's origin.
    pub height: f32,
    /// Aim point height above the target's origin.
    pub look_height: f32,
    /// Aim this far ahead of the target along its heading.
    pub look_ahead: f32,
    /// Position smoothing.
    pub follow: f32,
    /// Heading smoothing (how fast the camera swings behind a turning target).
    pub turn: f32,
    /// Keep at least this far in front of colliders between target and camera (`physics`).
    pub clearance: f32,
    /// Seconds without mouse input before the orbit drifts back behind the target.
    pub recenter_after: f32,
    /// Teleport to the wanted pose this frame (no smoothing).
    pub snap: bool,
    /// Mouse orbit around the target (radians), added to the trailing heading.
    pub orbit_yaw: f32,
    pub orbit_pitch: f32,
    heading: Option<f32>,
    idle: f32,
}

impl ChaseCamera {
    pub fn new(target: Entity) -> Self {
        ChaseCamera {
            target,
            active: true,
            distance: 8.0,
            height: 3.0,
            look_height: 1.2,
            look_ahead: 4.0,
            follow: 10.0,
            turn: 4.0,
            clearance: 0.4,
            recenter_after: 1.5,
            snap: true,
            orbit_yaw: 0.0,
            orbit_pitch: 0.0,
            heading: None,
            idle: 0.0,
        }
    }
}

pub struct ChasePlugin;

impl Plugin for ChasePlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostUpdate, chase.before(TransformSystems::Propagate));
    }
}

/// Yaw (radians, 0 = looking down -Z) of a rotation's forward vector on the XZ plane.
pub fn heading_of(rot: Quat) -> Option<f32> {
    let f = rot * Vec3::NEG_Z;
    let flat = Vec2::new(f.x, f.z);
    (flat.length_squared() > 1e-6).then(|| (-flat.x).atan2(-flat.y))
}

/// Shortest signed angle from `a` to `b`.
pub fn angle_delta(a: f32, b: f32) -> f32 {
    (b - a + std::f32::consts::PI).rem_euclid(std::f32::consts::TAU) - std::f32::consts::PI
}

/// Where the camera wants to be and what it looks at, for a target at `pos` facing `yaw`.
pub fn chase_pose(c: &ChaseCamera, pos: Vec3, yaw: f32) -> (Vec3, Vec3) {
    let y = yaw + c.orbit_yaw;
    let back = Vec3::new(y.sin(), 0.0, y.cos());
    let fwd = Vec3::new(-yaw.sin(), 0.0, -yaw.cos());
    let pitch = c.orbit_pitch.clamp(-0.5, 1.0);
    let eye = pos + back * c.distance * pitch.cos() + Vec3::Y * (c.height + c.distance * pitch.sin());
    let aim = pos + Vec3::Y * c.look_height + fwd * c.look_ahead;
    (eye, aim)
}

fn chase(
    time: Res<Time>,
    paused: Res<Paused>,
    look: Res<LookInput>,
    targets: Query<&Transform, Without<ChaseCamera>>,
    mut cams: Query<(&mut ChaseCamera, &mut Transform)>,
    #[cfg(feature = "physics")] spatial: avian3d::prelude::SpatialQuery,
) {
    let dt = time.delta_secs();
    for (mut c, mut tf) in &mut cams {
        if !c.active {
            continue;
        }
        let Ok(target) = targets.get(c.target) else { continue };
        let Some(want_heading) = heading_of(target.rotation) else { continue };
        let snap = std::mem::take(&mut c.snap);

        // Mouse orbit; drift back once the mouse rests.
        if !paused.0 && (look.yaw != 0.0 || look.pitch != 0.0) {
            c.orbit_yaw -= look.yaw;
            c.orbit_pitch = (c.orbit_pitch - look.pitch).clamp(-0.5, 1.0);
            c.idle = 0.0;
        } else {
            c.idle += dt;
            if c.idle > c.recenter_after {
                let k = 1.0 - (-2.5 * dt).exp();
                c.orbit_yaw = angle_delta(0.0, c.orbit_yaw) * (1.0 - k);
                c.orbit_pitch *= 1.0 - k;
            }
        }

        let heading = match c.heading {
            Some(h) if !snap => h + angle_delta(h, want_heading) * (1.0 - (-c.turn * dt).exp()),
            _ => want_heading,
        };
        c.heading = Some(heading);
        let (eye, aim) = chase_pose(&c, target.translation, heading);

        // Pull in front of any collider between the target and the camera.
        #[cfg(feature = "physics")]
        let eye = {
            use avian3d::prelude::SpatialQueryFilter;
            let from = target.translation + Vec3::Y * c.look_height;
            let filter = SpatialQueryFilter::from_excluded_entities([c.target]);
            match Dir3::new_and_length(eye - from) {
                Ok((dir, len)) => match spatial.cast_ray(from, dir, len + c.clearance, true, &filter) {
                    Some(hit) => from + dir * (hit.distance - c.clearance).max(0.5),
                    None => eye,
                },
                Err(_) => eye,
            }
        };

        let pos = if snap { eye } else { tf.translation.lerp(eye, 1.0 - (-c.follow * dt).exp()) };
        *tf = Transform::from_translation(pos).looking_at(aim, Vec3::Y);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pose_is_behind_and_above() {
        let c = ChaseCamera::new(Entity::PLACEHOLDER);
        // Facing -Z (yaw 0): camera sits at +Z, above, looking ahead at -Z.
        let (eye, aim) = chase_pose(&c, Vec3::ZERO, 0.0);
        assert!(eye.z > 7.0 && eye.y > 2.0);
        assert!(aim.z < 0.0);
        // Facing -X (yaw +90°): camera at +X.
        let (eye, _) = chase_pose(&c, Vec3::ZERO, std::f32::consts::FRAC_PI_2);
        assert!(eye.x > 7.0 && eye.z.abs() < 1e-3);
    }

    #[test]
    fn headings_round_trip() {
        for yaw in [-2.0f32, -0.3, 0.0, 1.0, 3.0] {
            let h = heading_of(Quat::from_rotation_y(yaw)).unwrap();
            assert!(angle_delta(h, yaw).abs() < 1e-4, "{yaw} -> {h}");
        }
        assert!((angle_delta(3.0, -3.0) - (std::f32::consts::TAU - 6.0)).abs() < 1e-5);
    }
}
