//! Sway: plants (shrubs, tall grass) bend away when a [`SwayPusher`] goes through them, flatten
//! while pressed, and spring back.
//!
//! Each plant is a 2D spring-damper on its bend (`bend` = tilt in radians as a world XZ vector,
//! pointing where the top leans). The system writes the plant's rotation and scale relative to
//! its rest pose ([`SwayRest`], captured automatically the first frame), so plants can be spawned
//! with any yaw and scale. Idle plants cost one distance check per pusher per frame and their
//! `Transform` is never touched (no change detection, no transform propagation).

use bevy::prelude::*;

use super::MAX_DT;

/// A plant: origin at its base, `radius` its footprint, `height` its top.
#[derive(Component, Clone, Debug)]
pub struct Sway {
    pub radius: f32,
    pub height: f32,
    /// Spring constant (1/s²): `ω = √stiffness`.
    pub stiffness: f32,
    /// Damping (1/s): `2ζω`.
    pub damping: f32,
    /// Largest bend (rad).
    pub max_bend: f32,
    /// Fraction of its height a fully pressed plant loses.
    pub flatten: f32,
    /// Current bend (rad, world XZ: x → +X, y → +Z).
    pub bend: Vec2,
    pub vel: Vec2,
    /// Current flattening (0..1, follows how hard it is pressed).
    pub squash: f32,
    /// The pusher touching it (for [`Brushed`]).
    pub contact: Option<Entity>,
}

impl Sway {
    /// Springs back in about a second, slightly underdamped; bends up to ~63°.
    pub fn new(radius: f32, height: f32) -> Self {
        Sway { radius, height, stiffness: 36.0, damping: 7.0, max_bend: 1.1, flatten: 0.35, bend: Vec2::ZERO, vel: Vec2::ZERO, squash: 0.0, contact: None }
    }

    /// Something to animate (bent, moving, flattened or touched).
    pub fn active(&self) -> bool {
        self.bend != Vec2::ZERO || self.vel != Vec2::ZERO || self.squash != 0.0 || self.contact.is_some()
    }

    /// One spring step (pure). `push`: acceleration from pushers (rad/s², world XZ); `press`:
    /// how hard it is pressed (0..1). Returns false once it has come to rest (state zeroed).
    pub fn step(&mut self, dt: f32, push: Vec2, press: f32) -> bool {
        let dt = if dt.is_finite() { dt.clamp(0.0, MAX_DT) } else { 0.0 };
        let n = (dt * 120.0).ceil().max(1.0);
        let h = dt / n;
        let press = press.clamp(0.0, 1.0);
        for _ in 0..n as u32 {
            let acc = push - self.bend * self.stiffness - self.vel * self.damping;
            self.vel += acc * h;
            self.bend += self.vel * h;
            let b = self.bend.length();
            if b > self.max_bend {
                let d = self.bend / b;
                self.bend = d * self.max_bend;
                self.vel -= d * self.vel.dot(d).max(0.0);
            }
            let rate = if press > self.squash { 12.0 } else { 3.0 };
            self.squash += (press - self.squash) * (1.0 - (-rate * h).exp());
        }
        if !self.bend.is_finite() || !self.vel.is_finite() {
            self.bend = Vec2::ZERO;
            self.vel = Vec2::ZERO;
        }
        if press == 0.0 && self.bend.length_squared() < 1e-6 && self.vel.length_squared() < 1e-6 && self.squash < 1e-3 {
            self.bend = Vec2::ZERO;
            self.vel = Vec2::ZERO;
            self.squash = 0.0;
            return false;
        }
        true
    }

    /// Rotation (world bend about the base) and scale for the current state, on top of `rest`.
    pub fn pose(&self, rest: &Transform) -> Transform {
        let bend = Quat::from_scaled_axis(Vec3::new(self.bend.y, 0.0, -self.bend.x));
        Transform { translation: rest.translation, rotation: bend * rest.rotation, scale: rest.scale * Vec3::new(1.0, 1.0 - self.flatten * self.squash, 1.0) }
    }
}

/// A plant's `Transform` before any bending (inserted automatically). Update it if the game
/// moves a plant. Plants' parents should not be rotated (the bend is applied in world axes).
#[derive(Component, Clone, Copy, Debug)]
pub struct SwayRest(pub Transform);

/// Something that pushes plants: an oriented box, `half_extents` = (half width along local X,
/// half length along local Z), centred on the entity. Its velocity is tracked from its
/// `GlobalTransform` between frames.
#[derive(Component, Clone, Debug)]
#[require(PusherMotion)]
pub struct SwayPusher {
    pub half_extents: Vec2,
}

/// First frame a pusher touches a plant (leaf particles, rustle sound): `speed` is the
/// pusher's speed (m/s), `point` the plant's middle.
#[derive(Message, Clone, Copy, Debug)]
pub struct Brushed {
    pub plant: Entity,
    pub pusher: Entity,
    pub speed: f32,
    pub point: Vec3,
}

#[derive(Component, Clone, Copy, Debug, Default)]
pub(crate) struct PusherMotion {
    last: Option<Vec3>,
}

/// A pusher this frame, in a flat form for the plant loop.
#[derive(Clone, Copy)]
pub(crate) struct PusherNow {
    e: Entity,
    pos: Vec3,
    right: Vec2,
    fwd: Vec2,
    half: Vec2,
    /// Horizontal velocity (m/s).
    vel: Vec2,
    reach: f32,
}

pub(crate) fn capture_rest(mut commands: Commands, q: Query<(Entity, &Transform), (With<Sway>, Without<SwayRest>)>) {
    for (e, tf) in &q {
        commands.entity(e).insert(SwayRest(*tf));
    }
}

/// Fastest believable pusher (m/s): teleports don't flatten the map.
const MAX_SPEED: f32 = 80.0;

pub(crate) fn step_sway(
    time: Res<Time>,
    mut pushers: Query<(Entity, &GlobalTransform, &SwayPusher, Mut<PusherMotion>)>,
    mut plants: Query<(Entity, &GlobalTransform, Ref<SwayRest>, &mut Sway, &mut Transform)>,
    mut brushed: MessageWriter<Brushed>,
    mut now: Local<Vec<PusherNow>>,
) {
    let dt = time.delta_secs().min(MAX_DT);
    if dt <= 0.0 {
        return;
    }
    now.clear();
    for (e, gt, p, mut m) in &mut pushers {
        // Spawned this frame: its GlobalTransform isn't propagated yet.
        if m.is_added() {
            continue;
        }
        let pos = gt.translation();
        let vel = m.last.map_or(Vec3::ZERO, |l| (pos - l) / dt);
        m.last = Some(pos);
        let flat = |v: Vec3| Vec2::new(v.x, v.z).try_normalize();
        let a = gt.affine();
        let right = flat(a.matrix3.x_axis.into()).unwrap_or(Vec2::X);
        let fwd = flat(a.matrix3.z_axis.into()).unwrap_or(Vec2::new(-right.y, right.x));
        let half = p.half_extents.abs();
        now.push(PusherNow { e, pos, right, fwd, half, vel: Vec2::new(vel.x, vel.z).clamp_length_max(MAX_SPEED), reach: half.length() });
    }

    for (e, gt, rest, mut sway, mut tf) in &mut plants {
        if rest.is_added() {
            continue;
        }
        let p = gt.translation();
        let mid_y = p.y + 0.5 * sway.height;
        let mut push = Vec2::ZERO;
        let mut press = 0.0f32;
        let mut first: Option<(Entity, f32)> = None;
        let mut still_touching = false;
        for u in now.iter() {
            let d = Vec2::new(p.x - u.pos.x, p.z - u.pos.z);
            let r = u.reach + sway.radius;
            if d.length_squared() > r * r || (u.pos.y - mid_y).abs() > 0.5 * sway.height + 2.0 {
                continue;
            }
            // Signed distance from the box (pusher frame) to the plant's centre.
            let l = Vec2::new(d.dot(u.right), d.dot(u.fwd));
            let q = l.abs() - u.half;
            let sd = q.max(Vec2::ZERO).length() + q.max_element().min(0.0);
            let depth = sway.radius - sd;
            if depth <= 0.0 {
                continue;
            }
            let out_local = if sd > 0.0 {
                (l - l.clamp(-u.half, u.half)).normalize_or_zero()
            } else if q.x > q.y {
                Vec2::new(l.x.signum(), 0.0)
            } else {
                Vec2::new(0.0, l.y.signum())
            };
            let out = u.right * out_local.x + u.fwd * out_local.y;
            let speed = u.vel.length();
            let along = u.vel.try_normalize().unwrap_or(Vec2::ZERO);
            let dir = (along * 0.8 + out * 0.6).normalize_or(out);
            let k = (depth / sway.radius.max(1e-3)).min(1.0);
            let gain = sway.stiffness * sway.max_bend * 2.0 * (0.3 + speed / 6.0).min(1.5);
            push += dir * gain * k;
            press = press.max(k);
            still_touching |= sway.contact == Some(u.e);
            if first.is_none() {
                first = Some((u.e, speed));
            }
        }
        if !still_touching {
            let new = first.map(|f| f.0);
            if let Some((pusher, speed)) = first {
                brushed.write(Brushed { plant: e, pusher, speed, point: Vec3::new(p.x, mid_y, p.z) });
            }
            if sway.contact != new {
                sway.contact = new;
            }
        }
        if press == 0.0 && !sway.active() {
            continue;
        }
        if sway.step(dt, push, press) {
            *tf = sway.pose(&rest.0);
        } else {
            *tf = rest.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn springs_back_bounded_and_stable() {
        for dt in [1.0 / 120.0, 1.0 / 60.0, 1.0 / 30.0] {
            let mut s = Sway::new(0.5, 1.0);
            // Hard push for 0.5 s: bounded by max_bend.
            for _ in 0..(0.5 / dt) as u32 {
                s.step(dt, Vec2::new(500.0, 0.0), 1.0);
                assert!(s.bend.length() <= s.max_bend + 1e-5);
            }
            assert!(s.bend.x > 1.0, "bent along the push: {:?}", s.bend);
            assert!(s.squash > 0.9);
            // Released: back within ~1.5 s, small overshoot.
            let mut min_x: f32 = 0.0;
            let mut t = 0.0;
            let mut moving = true;
            while moving && t < 3.0 {
                moving = s.step(dt, Vec2::ZERO, 0.0);
                min_x = min_x.min(s.bend.x);
                t += dt;
            }
            assert!(!moving && t < 2.5, "rests after {t} s at dt {dt}");
            assert!(min_x > -0.3, "overshoot {min_x}");
            assert_eq!(s.bend, Vec2::ZERO);
        }
    }

    #[test]
    fn finite_on_spikes() {
        let mut s = Sway { stiffness: 900.0, ..Sway::new(0.5, 1.0) };
        for dt in [5.0, f32::NAN, f32::INFINITY, 0.0, 0.1] {
            s.step(dt, Vec2::new(1000.0, -300.0), 0.7);
            assert!(s.bend.is_finite() && s.bend.length() <= s.max_bend + 1e-5);
        }
        let t = s.pose(&Transform::from_scale(Vec3::splat(2.0)));
        assert!(t.rotation.is_finite() && t.scale.y < 2.0 && t.scale.x == 2.0);
    }

    #[test]
    fn pusher_bends_plant_once_brushed_and_it_recovers() {
        let mut app = super::super::test_app::app();
        let rest = Transform::from_xyz(0.0, 0.0, 0.0).with_rotation(Quat::from_rotation_y(0.7)).with_scale(Vec3::splat(1.5));
        let plant = app.world_mut().spawn((Sway::new(0.5, 1.0), rest)).id();
        let idle = app.world_mut().spawn((Sway::new(0.5, 1.0), Transform::from_xyz(40.0, 0.0, 0.0))).id();
        let car = app.world_mut().spawn((SwayPusher { half_extents: Vec2::new(0.9, 2.0) }, Transform::from_xyz(0.3, 0.5, -6.0))).id();
        app.update();
        app.update();
        let idle_tick = |app: &App| app.world().entity(idle).get_change_ticks::<Transform>().unwrap().changed;
        let idle_before = idle_tick(&app);
        let mut brushed = 0;
        let mut max_bend = Vec2::ZERO;
        let mut min_scale = f32::MAX;
        for _ in 0..90 {
            app.world_mut().get_mut::<Transform>(car).unwrap().translation.z += 10.0 / 60.0;
            app.update();
            brushed += app.world().resource::<Messages<Brushed>>().iter_current_update_messages().filter(|b| b.plant == plant && b.pusher == car).count();
            let s = app.world().get::<Sway>(plant).unwrap();
            if s.bend.length() > max_bend.length() {
                max_bend = s.bend;
            }
            min_scale = min_scale.min(app.world().get::<Transform>(plant).unwrap().scale.y);
        }
        assert_eq!(brushed, 1, "one Brushed per pass");
        assert!(max_bend.length() > 0.5 && max_bend.y > 0.0, "bent along the drive: {max_bend:?}");
        assert!(min_scale < 1.4, "flattened while pressed: {min_scale}");
        // The car is gone (z ≈ 9): the plant springs back to its exact rest pose.
        for _ in 0..120 {
            app.update();
        }
        let s = app.world().get::<Sway>(plant).unwrap();
        assert!(!s.active(), "{s:?}");
        let tf = app.world().get::<Transform>(plant).unwrap();
        assert_eq!(*tf, rest);
        assert_eq!(idle_tick(&app), idle_before, "idle plants' transforms are never written");
    }

    /// `cargo test --lib props::sway -- --ignored --nocapture`: frame cost with 2000 plants.
    #[test]
    #[ignore]
    fn bench_2000_plants() {
        let mut app = super::super::test_app::app();
        for i in 0..2000 {
            let (x, z) = ((i % 40) as f32 * 2.5 - 50.0, (i / 40) as f32 * 2.5 - 60.0);
            app.world_mut().spawn((Sway::new(0.5, 1.0), Transform::from_xyz(x, 0.0, z)));
        }
        let cars: Vec<Entity> = (0..2).map(|i| app.world_mut().spawn((SwayPusher { half_extents: Vec2::new(0.9, 2.1) }, Transform::from_xyz(i as f32 * 5.0, 0.5, -60.0))).id()).collect();
        app.update();
        app.update();
        let frames = 300;
        let t0 = std::time::Instant::now();
        for _ in 0..frames {
            for c in &cars {
                app.world_mut().get_mut::<Transform>(*c).unwrap().translation.z += 25.0 / 60.0;
            }
            app.update();
        }
        let per = t0.elapsed().as_secs_f64() * 1e6 / frames as f64;
        let mut sys = bevy::ecs::system::IntoSystem::into_system(step_sway);
        sys.initialize(app.world_mut());
        let t1 = std::time::Instant::now();
        for _ in 0..frames {
            let _ = sys.run((), app.world_mut());
        }
        println!("2000 plants, 2 pushers: whole update {per:.0} µs, step_sway {:.1} µs", t1.elapsed().as_secs_f64() * 1e6 / frames as f64);
    }
}
