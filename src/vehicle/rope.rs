//! Ropes: winch cables and tow straps. A [`Rope`] is its own entity joining two ends (a world
//! point or a point on any rigid body). It is a one-sided spring-damper that only pulls once taut,
//! with a force cap (a winch stalls at its line pull; a strap past `break_force` snaps) and an
//! optional motor that reels the length in or out.

use avian3d::prelude::*;
use bevy::prelude::*;

use super::VehicleEvent;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RopeEnd {
    World(Vec3),
    /// A point on a rigid body, in that body's local space.
    Body { entity: Entity, local: Vec3 },
}

#[derive(Component, Clone, Debug)]
pub struct Rope {
    pub a: RopeEnd,
    pub b: RopeEnd,
    /// Current slack-free length, metres.
    pub length: f32,
    pub min_length: f32,
    pub max_length: f32,
    /// N per metre of stretch (steel cable stiff, nylon strap soft).
    pub stiffness: f32,
    /// N·s/m along the rope while stretched.
    pub damping: f32,
    /// Pull limit: a winch cannot exceed its line pull, the rope just stalls the motor.
    pub max_force: f32,
    /// A strap or cable that exceeds this breaks (`RopeSnapped`, entity despawned). `None` = never.
    pub break_force: Option<f32>,
    /// Motor input: +1 reels in, -1 pays out, 0 holds.
    pub reel: f32,
    /// Motor line speed at full input, m/s.
    pub reel_speed: f32,
    /// Output: the force the rope pulls with now.
    pub tension: f32,
    pub strained: bool,
}

impl Rope {
    pub fn new(a: RopeEnd, b: RopeEnd, length: f32) -> Self {
        Rope {
            a,
            b,
            length,
            min_length: 0.5,
            max_length: length.max(30.0),
            stiffness: 150_000.0,
            damping: 18_000.0,
            max_force: 45_000.0,
            break_force: None,
            reel: 0.0,
            reel_speed: 0.12,
            tension: 0.0,
            strained: false,
        }
    }
    /// A winch cable: strong, stiff, motorised.
    pub fn winch(a: RopeEnd, b: RopeEnd, length: f32) -> Self {
        Rope::new(a, b, length)
    }
    /// An elastic tow strap: soft, no motor, breaks at 2x the pull a recovery needs.
    pub fn strap(a: RopeEnd, b: RopeEnd, length: f32) -> Self {
        Rope { stiffness: 20_000.0, damping: 2_500.0, max_force: 70_000.0, break_force: Some(90_000.0), reel_speed: 0.0, ..Rope::new(a, b, length) }
    }
}

type Bodies<'w, 's> = Query<'w, 's, (&'static Transform, Forces)>;

fn end_state(bodies: &mut Bodies, end: RopeEnd) -> Option<(Vec3, Vec3)> {
    match end {
        RopeEnd::World(p) => Some((p, Vec3::ZERO)),
        RopeEnd::Body { entity, local } => {
            let (tf, forces) = bodies.get_mut(entity).ok()?;
            let p = tf.transform_point(local);
            Some((p, forces.velocity_at_point(p)))
        }
    }
}

fn apply(bodies: &mut Bodies, end: RopeEnd, force: Vec3) {
    if let RopeEnd::Body { entity, local } = end
        && let Ok((tf, mut forces)) = bodies.get_mut(entity)
    {
        forces.apply_force_at_point(force, tf.transform_point(local));
    }
}

pub(super) fn rope_step(mut commands: Commands, time: Res<Time>, mut ropes: Query<(Entity, &mut Rope)>, mut bodies: Bodies, mut events: MessageWriter<VehicleEvent>) {
    let dt = time.delta_secs();
    for (e, mut r) in &mut ropes {
        let (Some((pa, va)), Some((pb, vb))) = (end_state(&mut bodies, r.a), end_state(&mut bodies, r.b)) else {
            r.tension = 0.0;
            continue;
        };
        let d = pb - pa;
        let dist = d.length();
        let dir = if dist > 1e-4 { d / dist } else { Vec3::ZERO };
        let stretch = dist - r.length;
        let mut t = 0.0;
        if stretch > 0.0 {
            t = (r.stiffness * stretch + r.damping * (vb - va).dot(dir)).clamp(0.0, r.max_force);
        }
        // Motor: reel in only while the winch can still pull; pay out any time.
        if r.reel > 0.0 && t < r.max_force * 0.98 {
            r.length -= r.reel * r.reel_speed * dt;
        } else if r.reel < 0.0 {
            r.length -= r.reel * r.reel_speed * dt;
        }
        r.length = r.length.clamp(r.min_length, r.max_length);
        if let Some(b) = r.break_force
            && r.stiffness * stretch.max(0.0) > b
        {
            events.write(VehicleEvent::RopeSnapped { rope: e });
            commands.entity(e).despawn();
            continue;
        }
        r.tension = t;
        let strained = t > r.max_force * 0.75;
        if strained && !r.strained {
            events.write(VehicleEvent::RopeStrain { rope: e, fraction: t / r.max_force });
        }
        r.strained = strained;
        if t > 0.0 {
            apply(&mut bodies, r.a, dir * t);
            apply(&mut bodies, r.b, -dir * t);
        }
    }
}
