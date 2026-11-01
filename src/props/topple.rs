//! Toppling: a knocked prop snaps at its base and falls away from the hitter.
//!
//! The prop is a rigid rod pivoting at its base (`θ'' = 3g/(2h)·sin θ`). The hit gives it an
//! angular velocity (capped, so tall things don't spin like propellers) and slides the base along
//! with a fraction of the hit that ground friction eats. It lands when the tip (plus `radius` of
//! thickness) reaches the ground, bounces once, rests, then follows [`Fallen`].
//! [`ToppleState`] is the pure math; the systems only feed it time and ground.

use bevy::prelude::*;

use super::{MAX_DT, PropGround, Rand};

/// A prop that can be knocked over. The entity's `Transform` origin is the prop's base (the
/// pivot it falls about); `height` is base to tip, `radius` its thickness.
#[derive(Component, Clone, Debug)]
pub struct Breakable {
    pub height: f32,
    pub radius: f32,
    pub fallen: Fallen,
}

impl Breakable {
    /// Sinks into the ground 6 s after it lands.
    pub fn new(height: f32, radius: f32) -> Self {
        Breakable { height, radius, fallen: Fallen::Sink { after: 6.0 } }
    }
}

/// What a toppled prop does once it lies still.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Fallen {
    /// Stays where it fell (stops being simulated).
    Stay,
    /// Waits `after` seconds, sinks into the ground over ~1.5 s, then is despawned (with children).
    Sink { after: f32 },
    /// Despawned (with children) `after` seconds after it lies still.
    Despawn { after: f32 },
}

/// Knock a [`Breakable`] over: `velocity` is the hitter's velocity at the contact (world, m/s),
/// `point` the contact point. Ignored for entities without `Breakable` or already toppling.
#[derive(Message, Clone, Copy, Debug)]
pub struct Knock {
    pub entity: Entity,
    pub velocity: Vec3,
    pub point: Vec3,
}

/// A knocked prop started falling (sound / particle hook). `base` is where it snapped,
/// `velocity` the hit.
#[derive(Message, Clone, Copy, Debug)]
pub struct Toppled {
    pub entity: Entity,
    pub base: Vec3,
    pub velocity: Vec3,
}

/// A falling prop hit the ground (first contact only): `point` is its tip, `speed` the tip's
/// speed (m/s).
#[derive(Message, Clone, Copy, Debug)]
pub struct Landed {
    pub entity: Entity,
    pub point: Vec3,
    pub speed: f32,
}

/// On an entity that is falling or lying after a [`Knock`] (inserted by the engine).
#[derive(Component, Clone, Debug)]
pub struct Toppling {
    pub state: ToppleState,
    pub fallen: Fallen,
    /// Seconds spent lying still.
    pub still: f32,
    /// Metres sunk so far (`Fallen::Sink`).
    pub sunk: f32,
}

const G: f32 = 9.81;
/// Ground friction for the sliding base (deceleration = `MU·g`).
const MU: f32 = 0.5;
/// Tip speed kept by the one bounce.
const BOUNCE: f32 = 0.2;
const SUBSTEP: f32 = 1.0 / 120.0;
const MAX_ANGLE: f32 = 0.95 * core::f32::consts::PI;

/// Pure fall state of one prop (no ECS): build with [`ToppleState::new`], advance with
/// [`ToppleState::step`], read the pose with [`ToppleState::pose`].
#[derive(Clone, Debug)]
pub struct ToppleState {
    /// The pivot (world); slides along the ground.
    pub base: Vec3,
    /// Horizontal unit direction the prop falls towards.
    pub dir: Vec3,
    /// Tilt from vertical (rad).
    pub angle: f32,
    /// Tilt rate (rad/s).
    pub omega: f32,
    /// Horizontal velocity of the base (m/s).
    pub slide: Vec3,
    pub height: f32,
    pub radius: f32,
    /// Roll about the prop's own axis by the time it lies flat (rad; looks less scripted).
    pub twist: f32,
    /// The prop's rotation before it fell.
    pub rest_rotation: Quat,
    /// Height of the base above the ground when it was knocked (kept while sliding).
    lift: Option<f32>,
    /// Base height when knocked (the flat ground without a [`PropGround`]).
    floor: f32,
    bounced: bool,
    resting: bool,
}

impl ToppleState {
    /// `base` and `rotation`: the prop's pose when hit. `velocity` / `point`: the hit (world).
    /// `seed` picks the small random twist (use the entity bits for per-entity determinism).
    pub fn new(base: Vec3, rotation: Quat, height: f32, radius: f32, velocity: Vec3, point: Vec3, seed: u64) -> Self {
        let height = height.max(0.05);
        let flat = Vec3::new(velocity.x, 0.0, velocity.z);
        let away = Vec3::new(base.x - point.x, 0.0, base.z - point.z);
        let dir = flat.try_normalize().or_else(|| away.try_normalize()).unwrap_or(Vec3::X);
        let mut rng = Rand::new(seed);
        let dir = Quat::from_rotation_y(rng.signed() * 0.12) * dir;
        let speed = flat.length();
        let max_omega = 9.0 / height.max(0.5).sqrt();
        let omega = (speed / (0.6 * height)).clamp(0.6, max_omega);
        let slide = flat * (0.35 / height).clamp(0.03, 0.4);
        ToppleState {
            base,
            dir,
            angle: 0.02,
            omega,
            slide,
            height,
            radius: radius.max(0.0),
            twist: rng.signed() * 0.6,
            rest_rotation: rotation,
            lift: None,
            floor: base.y,
            bounced: false,
            resting: false,
        }
    }

    /// Base height when knocked: the ground to use when there is no [`PropGround`].
    pub fn floor(&self) -> f32 {
        self.floor
    }

    /// Lying on the ground with the base no longer sliding.
    pub fn at_rest(&self) -> bool {
        self.resting && self.slide == Vec3::ZERO
    }

    /// The tip (centre of the far end, world).
    pub fn tip(&self) -> Vec3 {
        self.tip_at(self.angle)
    }

    fn tip_at(&self, angle: f32) -> Vec3 {
        self.base + (self.dir * angle.sin() + Vec3::Y * angle.cos()) * self.height
    }

    /// Clearance of the tip above `ground + radius` at `angle` (negative = in the ground).
    fn clearance(&self, angle: f32, ground: &impl Fn(f32, f32) -> f32) -> f32 {
        let t = self.tip_at(angle);
        t.y - ground(t.x, t.z) - self.radius
    }

    /// Translation and rotation for the prop's `Transform` (scale untouched).
    pub fn pose(&self) -> (Vec3, Quat) {
        let axis = Vec3::Y.cross(self.dir).try_normalize().unwrap_or(Vec3::Z);
        let roll = self.twist * (self.angle / core::f32::consts::FRAC_PI_2).min(1.2);
        (self.base, Quat::from_axis_angle(axis, self.angle) * Quat::from_rotation_y(roll) * self.rest_rotation)
    }

    /// Advances by `dt` (clamped to 0.1 s, sub-stepped). Returns the tip speed on the first
    /// ground contact (for a [`Landed`] message).
    pub fn step(&mut self, dt: f32, ground: impl Fn(f32, f32) -> f32) -> Option<f32> {
        let dt = if dt.is_finite() { dt.clamp(0.0, MAX_DT) } else { 0.0 };
        let lift = *self.lift.get_or_insert_with(|| self.base.y - ground(self.base.x, self.base.z));
        let n = (dt / SUBSTEP).ceil().max(1.0);
        let h = dt / n;
        let mut landed = None;
        for _ in 0..n as u32 {
            if h <= 0.0 {
                break;
            }
            // Base slides with friction and follows the ground.
            let v = self.slide.length();
            if v > 0.0 {
                let nv = (v - MU * G * h).max(0.0);
                self.base += self.slide * h;
                self.slide = if nv > 0.0 { self.slide * (nv / v) } else { Vec3::ZERO };
            }
            self.base.y = ground(self.base.x, self.base.z) + lift;

            if self.resting {
                let c = self.clearance(self.angle, &ground);
                if c < 0.0 {
                    // Slid onto rising ground: lift the tip back onto it.
                    self.angle = self.solve(0.0, self.angle, &ground);
                } else if c > 0.02 && self.angle < MAX_ANGLE {
                    // Slid off an edge: fall again (no second bounce).
                    self.resting = false;
                }
                if self.resting {
                    continue;
                }
            }

            let prev = self.angle;
            self.omega += 1.5 * G / self.height * self.angle.sin() * h;
            self.angle = (self.angle + self.omega * h).clamp(0.0, MAX_ANGLE);
            if self.clearance(self.angle, &ground) <= 0.0 {
                let speed = self.omega.abs() * self.height;
                self.angle = if self.clearance(prev, &ground) > 0.0 { self.solve(prev, self.angle, &ground) } else { self.solve(0.0, self.angle, &ground) };
                if landed.is_none() && !self.bounced {
                    landed = Some(speed);
                }
                if !self.bounced && self.omega.abs() > 1.0 {
                    self.bounced = true;
                    self.omega = -self.omega * BOUNCE;
                } else {
                    self.bounced = true;
                    self.omega = 0.0;
                    self.resting = true;
                }
            } else if self.angle >= MAX_ANGLE {
                self.omega = 0.0;
                self.resting = true;
            }
        }
        landed
    }

    /// Bisection for the angle in `[clear, buried]` where the tip just touches (stays clear).
    fn solve(&self, mut clear: f32, mut buried: f32, ground: &impl Fn(f32, f32) -> f32) -> f32 {
        if self.clearance(clear, ground) <= 0.0 {
            return clear;
        }
        for _ in 0..20 {
            let mid = 0.5 * (clear + buried);
            if self.clearance(mid, ground) > 0.0 {
                clear = mid;
            } else {
                buried = mid;
            }
        }
        clear
    }
}

/// Knocks → [`Toppling`] (detached from any parent, re-tagged as an actor) + [`Toppled`].
pub(crate) fn start_topples(
    mut commands: Commands,
    mut knocks: MessageReader<Knock>,
    mut out: MessageWriter<Toppled>,
    props: Query<(&Breakable, &GlobalTransform, Has<ChildOf>), Without<Toppling>>,
    mut started: Local<Vec<Entity>>,
) {
    started.clear();
    for k in knocks.read() {
        if started.contains(&k.entity) {
            continue;
        }
        let Ok((b, gt, child)) = props.get(k.entity) else { continue };
        started.push(k.entity);
        let (scale, rotation, base) = gt.to_scale_rotation_translation();
        let state = ToppleState::new(base, rotation, b.height, b.radius, k.velocity, k.point, k.entity.to_bits());
        let mut ec = commands.entity(k.entity);
        if child {
            ec.remove::<ChildOf>().insert(Transform { translation: base, rotation, scale });
        }
        ec.insert(Toppling { state, fallen: b.fallen, still: 0.0, sunk: 0.0 });
        let e = k.entity;
        commands.queue(move |world: &mut World| crate::render_budget::detail::into_actor(world, e));
        out.write(Toppled { entity: k.entity, base, velocity: k.velocity });
    }
}

/// Seconds a sinking prop takes to go under.
const SINK_TIME: f32 = 1.5;

pub(crate) fn step_topples(
    mut commands: Commands,
    time: Res<Time>,
    ground: Option<Res<PropGround>>,
    mut q: Query<(Entity, &mut Transform, &mut Toppling)>,
    mut landed: MessageWriter<Landed>,
) {
    let dt = time.delta_secs().min(MAX_DT);
    if dt <= 0.0 {
        return;
    }
    for (e, mut tf, mut t) in &mut q {
        let t = &mut *t;
        let floor = t.state.floor();
        let hit = match ground.as_deref() {
            Some(g) => t.state.step(dt, |x, z| g.height(x, z)),
            None => t.state.step(dt, |_, _| floor),
        };
        if let Some(speed) = hit {
            landed.write(Landed { entity: e, point: t.state.tip(), speed });
        }
        if t.state.at_rest() {
            t.still += dt;
        }
        match t.fallen {
            Fallen::Stay if t.state.at_rest() => {
                commands.entity(e).remove::<Toppling>();
            }
            Fallen::Despawn { after } if t.still > after => {
                commands.entity(e).despawn();
                continue;
            }
            Fallen::Sink { after } if t.still > after => {
                let depth = (2.0 * t.state.radius + 0.3).max(0.12 * t.state.height);
                t.sunk += depth / SINK_TIME * dt;
                if t.sunk >= depth {
                    commands.entity(e).despawn();
                    continue;
                }
            }
            _ => {}
        }
        let (pos, rot) = t.state.pose();
        tf.translation = pos - Vec3::Y * t.sunk;
        tf.rotation = rot;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(s: &mut ToppleState, secs: f32, dt: f32, ground: impl Fn(f32, f32) -> f32 + Copy) -> Vec<f32> {
        let mut hits = Vec::new();
        let mut t = 0.0;
        while t < secs {
            if let Some(v) = s.step(dt, ground) {
                hits.push(v);
            }
            // Never in the ground: base on it, tip at least `radius` above it.
            assert!(s.base.y >= ground(s.base.x, s.base.z) - 1e-4);
            assert!(s.clearance(s.angle, &ground) >= -1e-3, "tip in the ground: {}", s.clearance(s.angle, &ground));
            assert!(s.angle.is_finite() && s.omega.is_finite() && s.base.is_finite());
            t += dt;
        }
        hits
    }

    const FLAT: fn(f32, f32) -> f32 = |_, _| 0.0;

    #[test]
    fn falls_away_from_the_hitter_and_lands_flat() {
        // Hit moving +Z at 60 km/h.
        let mut s = ToppleState::new(Vec3::ZERO, Quat::IDENTITY, 1.0, 0.05, Vec3::new(0.0, 0.0, 16.7), Vec3::new(0.0, 0.5, -0.1), 7);
        let hits = run(&mut s, 4.0, 1.0 / 60.0, FLAT);
        assert_eq!(hits.len(), 1, "one Landed");
        assert!(s.at_rest());
        assert!(s.dir.z > 0.95, "falls along the hit: {:?}", s.dir);
        let tip = s.tip();
        assert!(tip.z > s.base.z + 0.9, "tip beyond the base along +Z: {tip:?}");
        // Lies (almost) flat: cos θ = radius / height.
        assert!((s.angle - (0.05f32).acos()).abs() < 0.01, "angle {}", s.angle.to_degrees());
        // A 1 m post is flung a few metres.
        assert!(s.base.z > 1.5 && s.base.z < 6.0, "slid {}", s.base.z);
    }

    #[test]
    fn tall_sapling_mostly_tips_over() {
        let mut s = ToppleState::new(Vec3::ZERO, Quat::IDENTITY, 4.0, 0.08, Vec3::new(16.7, 0.0, 0.0), Vec3::new(-0.1, 0.5, 0.0), 3);
        assert!(s.omega <= 4.6, "capped spin {}", s.omega);
        run(&mut s, 6.0, 1.0 / 60.0, FLAT);
        assert!(s.at_rest());
        assert!(s.base.x < 0.6, "barely slides: {}", s.base.x);
        assert!(s.tip().x > 3.5);
    }

    #[test]
    fn lands_on_a_slope() {
        // Ground rises 20° in the fall direction (+X): rests at ≈ 70°.
        let slope = 20f32.to_radians();
        let ground = move |x: f32, _z: f32| x * slope.tan();
        let mut s = ToppleState::new(Vec3::ZERO, Quat::IDENTITY, 2.0, 0.0, Vec3::new(1.0, 0.0, 0.0), Vec3::new(-0.1, 0.5, 0.0), 1);
        s.dir = Vec3::X;
        run(&mut s, 5.0, 1.0 / 60.0, ground);
        assert!(s.at_rest());
        let want = 90f32.to_radians() - slope;
        assert!((s.angle - want).abs() < 0.03, "angle {} want {}", s.angle.to_degrees(), want.to_degrees());
    }

    #[test]
    fn finite_on_dt_spikes_and_zero_dt() {
        let mut s = ToppleState::new(Vec3::new(5.0, 2.0, 5.0), Quat::from_rotation_y(1.0), 3.0, 0.1, Vec3::new(10.0, 0.0, 3.0), Vec3::new(4.0, 2.5, 5.0), 9);
        let ground = |x: f32, z: f32| 2.0 + 0.3 * (x * 0.7).sin() + 0.2 * (z * 1.3).cos() - 0.3 * (5.0f32 * 0.7).sin() - 0.2 * (5.0f32 * 1.3).cos();
        for dt in [0.0, 5.0, f32::NAN, f32::INFINITY, 1.0 / 30.0, 0.5] {
            s.step(dt, ground);
        }
        run(&mut s, 5.0, 0.25, ground);
        assert!(s.at_rest());
        let (p, r) = s.pose();
        assert!(p.is_finite() && r.is_finite());
    }

    #[test]
    fn deterministic_per_seed() {
        let a = ToppleState::new(Vec3::ZERO, Quat::IDENTITY, 1.0, 0.05, Vec3::X * 5.0, Vec3::NEG_X, 42);
        let b = ToppleState::new(Vec3::ZERO, Quat::IDENTITY, 1.0, 0.05, Vec3::X * 5.0, Vec3::NEG_X, 42);
        assert_eq!(a.dir, b.dir);
        assert_eq!(a.twist, b.twist);
    }

    #[test]
    fn knock_topples_lands_then_despawns() {
        use crate::render_budget::{Actor, Scenery};
        let mut app = super::super::test_app::app();
        let post = app.world_mut().spawn((Breakable { fallen: Fallen::Despawn { after: 0.5 }, ..Breakable::new(1.0, 0.05) }, Scenery, Transform::from_xyz(3.0, 0.0, 0.0))).id();
        let other = app.world_mut().spawn(Transform::default()).id();
        app.update();
        app.world_mut().write_message(Knock { entity: post, velocity: Vec3::new(0.0, 0.0, 10.0), point: Vec3::new(3.0, 0.4, -0.1) });
        app.world_mut().write_message(Knock { entity: post, velocity: Vec3::new(0.0, 0.0, 10.0), point: Vec3::new(3.0, 0.4, -0.1) });
        app.world_mut().write_message(Knock { entity: other, velocity: Vec3::X, point: Vec3::ZERO });
        app.update();
        assert!(app.world().get::<Toppling>(post).is_some());
        assert!(app.world().get::<Toppling>(other).is_none(), "not Breakable");
        assert!(app.world().get::<Actor>(post).is_some() && app.world().get::<Scenery>(post).is_none(), "re-tagged as an actor");
        let toppled = app.world().resource::<Messages<Toppled>>().iter_current_update_messages().count();
        assert_eq!(toppled, 1, "one Toppled for two knocks");
        let mut landed = 0;
        let mut was_down = false;
        for _ in 0..240 {
            app.update();
            landed += app.world().resource::<Messages<Landed>>().iter_current_update_messages().count();
            if let Some(tf) = app.world().get::<Transform>(post) {
                was_down |= (tf.rotation * Vec3::Y).y < 0.2;
                assert!(tf.translation.z >= 0.0, "falls away from the hitter");
            }
        }
        assert_eq!(landed, 1);
        assert!(was_down, "fell over");
        assert!(app.world().get_entity(post).is_err(), "despawned after landing");
    }

    #[test]
    fn knocked_scenery_loses_its_static_detail() {
        use crate::render_budget::detail::{BudgetClass, DetailTier};
        use bevy::camera::visibility::VisibilityRange;
        let mut app = super::super::test_app::app();
        let post = app.world_mut().spawn((Breakable::new(1.0, 0.05), crate::render_budget::Scenery, Transform::default())).id();
        let mesh = app.world_mut().spawn((BudgetClass::Scenery, DetailTier::Near, VisibilityRange::abrupt(0.0, 50.0), Transform::default(), ChildOf(post))).id();
        let twin = app.world_mut().spawn((BudgetClass::Scenery, DetailTier::Far, Transform::default(), ChildOf(mesh))).id();
        app.update();
        app.world_mut().write_message(Knock { entity: post, velocity: Vec3::X, point: Vec3::NEG_X });
        app.update();
        let m = app.world().entity(mesh);
        assert!(!m.contains::<BudgetClass>() && !m.contains::<DetailTier>() && !m.contains::<VisibilityRange>(), "re-classified as part of an actor");
        assert!(app.world().get_entity(twin).is_err(), "far twin gone");
    }

    #[test]
    fn sink_goes_under_then_despawns() {
        let mut app = super::super::test_app::app();
        let post = app.world_mut().spawn((Breakable { fallen: Fallen::Sink { after: 0.2 }, ..Breakable::new(1.0, 0.05) }, Transform::default())).id();
        app.update();
        app.world_mut().write_message(Knock { entity: post, velocity: Vec3::new(8.0, 0.0, 0.0), point: Vec3::new(-0.1, 0.4, 0.0) });
        let mut lowest = 0.0f32;
        for _ in 0..300 {
            app.update();
            if let Some(tf) = app.world().get::<Transform>(post) {
                lowest = lowest.min(tf.translation.y);
            }
        }
        assert!(lowest < -0.3, "sank: {lowest}");
        assert!(app.world().get_entity(post).is_err());
    }
}
