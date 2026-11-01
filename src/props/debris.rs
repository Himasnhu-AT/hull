//! Debris: small mesh pieces flung from a break (chips, splinters, shards). Gravity, tumble,
//! bounce and slide on the ground, shrink out over the last 20 % of their life, then despawn.
//! No physics engine; pieces don't collide with each other or with walls.

use bevy::prelude::*;

use super::{MAX_DT, PropGround, Rand};
use crate::render_budget::Actor;

/// What [`spawn_debris`] spawns. Share `mesh` and `material` between calls.
#[derive(Clone, Debug)]
pub struct DebrisSpec {
    pub mesh: Handle<Mesh>,
    pub material: Handle<StandardMaterial>,
    pub count: u32,
    /// Piece scale range (the mesh is scaled uniformly).
    pub size: (f32, f32),
    /// Spray speed range (m/s), on top of the push.
    pub speed: (f32, f32),
    /// Lifetime range (s).
    pub life: (f32, f32),
}

/// One flying piece (inserted by [`spawn_debris`]).
#[derive(Component, Clone, Debug)]
pub struct Debris {
    pub vel: Vec3,
    /// Tumble (world axis × rad/s).
    pub spin: Vec3,
    pub age: f32,
    pub life: f32,
    /// Scale at spawn.
    pub size: f32,
    /// Ground height without a [`PropGround`] (the spawn height).
    pub floor: f32,
}

/// Spawns `spec.count` pieces at `at`. `push` is the hitter's velocity: each piece gets 20–60 %
/// of it plus a random upward spray. Same `seed`, same pieces. Pieces are tagged [`Actor`].
/// Without a [`PropGround`] they land at `at.y`, so pass a point on the ground then.
pub fn spawn_debris(commands: &mut Commands, spec: &DebrisSpec, at: Vec3, push: Vec3, seed: u64) {
    let mut rng = Rand::new(seed);
    for _ in 0..spec.count {
        let dir = Vec3::new(rng.signed(), 0.3 + 0.7 * rng.f(), rng.signed()).normalize_or(Vec3::Y);
        let vel = push * rng.range((0.2, 0.6)) + dir * rng.range(spec.speed);
        let spin = Vec3::new(rng.signed(), rng.signed(), rng.signed()).normalize_or(Vec3::X) * rng.range((4.0, 14.0));
        let size = rng.range(spec.size).max(1e-3);
        let rot = Quat::from_euler(EulerRot::XYZ, rng.f() * core::f32::consts::TAU, rng.f() * core::f32::consts::TAU, rng.f() * core::f32::consts::TAU);
        let offset = Vec3::new(rng.signed(), rng.f(), rng.signed()) * (2.0 * size);
        commands.spawn((
            Debris { vel, spin, age: 0.0, life: rng.range(spec.life).max(0.05), size, floor: at.y },
            Actor,
            Mesh3d(spec.mesh.clone()),
            MeshMaterial3d(spec.material.clone()),
            Transform { translation: at + offset, rotation: rot, scale: Vec3::splat(size) },
        ));
    }
}

const G: f32 = 9.81;
const RESTITUTION: f32 = 0.3;

/// One piece's step (pure): returns false once its life is over.
pub(crate) fn step_piece(d: &mut Debris, tf: &mut Transform, dt: f32, ground: f32) -> bool {
    d.age += dt;
    if d.age >= d.life {
        return false;
    }
    d.vel.y -= G * dt;
    d.vel *= 1.0 / (1.0 + 0.3 * dt);
    tf.translation += d.vel * dt;
    let half = 0.5 * d.size;
    if tf.translation.y < ground + half {
        tf.translation.y = ground + half;
        if d.vel.y < -1.0 {
            d.vel.y = -d.vel.y * RESTITUTION;
            d.spin *= 0.7;
        } else {
            d.vel.y = d.vel.y.max(0.0);
        }
        // Sliding friction.
        let k = (-6.0 * dt).exp();
        d.vel.x *= k;
        d.vel.z *= k;
        d.spin *= k;
    }
    tf.rotation = (Quat::from_scaled_axis(d.spin * dt) * tf.rotation).normalize();
    let t = d.age / d.life;
    let s = if t > 0.8 { 1.0 - (t - 0.8) / 0.2 } else { 1.0 };
    tf.scale = Vec3::splat(d.size * s.max(0.0));
    true
}

pub(crate) fn step_debris(mut commands: Commands, time: Res<Time>, ground: Option<Res<PropGround>>, mut q: Query<(Entity, &mut Transform, &mut Debris)>) {
    let dt = time.delta_secs().min(MAX_DT);
    if dt <= 0.0 {
        return;
    }
    for (e, mut tf, mut d) in &mut q {
        let g = ground.as_deref().map_or(d.floor, |g| g.height(tf.translation.x, tf.translation.z));
        if !step_piece(&mut d, &mut tf, dt, g) {
            commands.entity(e).despawn();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pieces_fly_land_shrink_and_die() {
        let mut d = Debris { vel: Vec3::new(4.0, 3.0, 0.0), spin: Vec3::new(0.0, 0.0, 10.0), age: 0.0, life: 3.0, size: 0.1, floor: 0.0 };
        let mut tf = Transform::from_xyz(0.0, 0.5, 0.0).with_scale(Vec3::splat(0.1));
        let mut t = 0.0;
        let mut max_y: f32 = 0.0;
        while step_piece(&mut d, &mut tf, 1.0 / 60.0, 0.0) {
            assert!(tf.translation.y >= 0.05 - 1e-5 && tf.translation.is_finite());
            max_y = max_y.max(tf.translation.y);
            t += 1.0 / 60.0;
            if t > 2.0 && t < 2.3 {
                assert!(d.vel.length() < 0.5, "settled: {:?}", d.vel);
                assert_eq!(tf.scale.x, 0.1);
            }
        }
        assert!(max_y > 0.8, "flew up");
        assert!(tf.translation.x > 1.0 && tf.translation.x < 6.0, "slid {}", tf.translation.x);
        assert!(tf.scale.x < 0.01, "shrunk out");
    }

    #[test]
    fn spawn_is_deterministic_and_tagged() {
        let mut app = super::super::test_app::app();
        let spec = DebrisSpec { mesh: Handle::default(), material: Handle::default(), count: 6, size: (0.05, 0.1), speed: (1.0, 3.0), life: (0.5, 1.0) };
        let mut cmds = app.world_mut().commands();
        spawn_debris(&mut cmds, &spec, Vec3::new(1.0, 0.0, 2.0), Vec3::new(10.0, 0.0, 0.0), 5);
        app.world_mut().flush();
        let n = app.world_mut().query_filtered::<(), (With<Debris>, With<Actor>)>().iter(app.world()).count();
        assert_eq!(n, 6);
        let mut a: Vec<f32> = app.world_mut().query::<&Debris>().iter(app.world()).map(|d| d.vel.x).collect();
        a.sort_by(f32::total_cmp);
        assert!(a.iter().all(|v| *v > 0.0), "pushed along +X");
        for _ in 0..90 {
            app.update();
        }
        assert_eq!(app.world_mut().query::<&Debris>().iter(app.world()).count(), 0, "all gone after their life");
    }
}
