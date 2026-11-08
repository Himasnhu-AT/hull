//! Wheeled vehicles on avian3d (feature `vehicle`, needs `physics`). A game-agnostic skeleton
//! tuned for low-speed off-road but configurable for anything: a chassis rigid body, per-wheel
//! suspension (ray or sphere probe, spring, damper, travel, bump stop, anti-roll coupling), a
//! pluggable tyre model, surfaces from a map the game provides, a drivetrain (torque curve,
//! gearbox with automatic shifting, transfer case as data incl. low range, open / locked /
//! limited-slip differentials), brakes, ropes (winch, tow strap), telemetry and events.
//! See docs/VEHICLE.md.
//!
//! ```ignore
//! app.add_plugins(engine::vehicle::VehiclePlugin);
//! let truck = commands.spawn(VehicleSpec::truck().bundle(Transform::from_xyz(0.0, 1.0, 0.0))).id();
//! // drive it:
//! input.throttle = 1.0; input.steer = -0.3; input.transfer = 2; // 4L
//! ```

pub mod drivetrain;
pub mod rope;
pub mod spec;
pub mod surface;
pub mod tyre;

#[cfg(feature = "devtools")]
mod devtools;
#[cfg(test)]
mod tests;

use avian3d::prelude::*;
use bevy::prelude::*;

pub use rope::{Rope, RopeEnd};
pub use spec::{AxleSpec, BrakeSpec, Diff, EngineSpec, GearboxSpec, Probe, SpringSpec, SteerSpec, TransferMode, TyreSpec, VehicleSpec, WheelSpec};
pub use surface::{Surface, SurfaceId, SurfaceMap, SurfaceMapRes, SurfaceQuery, SurfaceTag, Surfaces, TagSurfaceMap, Wetness};
pub use tyre::{SlipCircleTyre, TyreInput, TyreModel};

const GRAVITY: f32 = 9.81;
/// Wheel-spin integration substeps per physics tick.
const SUBSTEPS: usize = 4;

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct VehicleSet;

pub struct VehiclePlugin;

impl Plugin for VehiclePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Surfaces>()
            .init_resource::<Wetness>()
            .init_resource::<SurfaceMapRes>()
            .add_message::<VehicleEvent>()
            .register_type::<SurfaceTag>()
            .add_systems(FixedUpdate, (vehicle_step, rope::rope_step).chain().in_set(VehicleSet));
        #[cfg(feature = "devtools")]
        devtools::register(app);
    }
}

/// Sound / camera / HUD hooks. Read them with a `MessageReader<VehicleEvent>`.
#[derive(Message, Clone, Copy, Debug)]
pub enum VehicleEvent {
    /// A wheel touched down after being airborne; `speed` is the closing speed, m/s.
    WheelLanded { vehicle: Entity, wheel: usize, speed: f32 },
    /// The suspension hit its bump stop hard (`speed` = compression speed, m/s).
    BottomedOut { vehicle: Entity, wheel: usize, speed: f32 },
    /// A rope's pull passed 75 % of its limit.
    RopeStrain { rope: Entity, fraction: f32 },
    RopeSnapped { rope: Entity },
}

/// The vehicle: its spec plus the few knobs a game changes at run time.
#[derive(Component, Clone)]
#[require(VehicleInput, VehicleTelemetry, VehicleState)]
pub struct Vehicle {
    pub spec: VehicleSpec,
    /// Tyre pressure, kPa (compare `TyreSpec::pressure`). Low = bigger patch.
    pub pressure: f32,
    /// Extra friction multiplier (damage, upgrades, a handicap).
    pub grip_scale: f32,
}

impl VehicleSpec {
    /// Components for a drivable vehicle at `at`: body, collider, mass properties and the
    /// [`Vehicle`] (which pulls in input, telemetry and state).
    pub fn bundle(self, at: Transform) -> impl Bundle {
        let b = self.body;
        let m = self.mass;
        let inertia = Vec3::new(m / 12.0 * (b.y * b.y + b.z * b.z), m / 12.0 * (b.x * b.x + b.z * b.z), m / 12.0 * (b.x * b.x + b.y * b.y));
        (
            Name::new("Vehicle"),
            RigidBody::Dynamic,
            Collider::cuboid(b.x, b.y, b.z),
            Mass(m),
            AngularInertia::new(inertia),
            CenterOfMass(self.com),
            SleepingDisabled,
            LinearDamping(0.02),
            AngularDamping(0.4),
            at,
            Visibility::default(),
            Vehicle { pressure: self.tyre.pressure, grip_scale: 1.0, spec: self },
        )
    }
}

/// What the driver (player, AI, script) asks for. Written by game code, read each physics tick.
#[derive(Component, Clone, Debug, Default)]
pub struct VehicleInput {
    /// -1..1: positive drives forward, negative brakes while rolling forward and then reverses.
    pub throttle: f32,
    /// -1 left .. 1 right.
    pub steer: f32,
    /// Service brake, 0..1.
    pub brake: f32,
    pub handbrake: bool,
    /// Parking brake on every wheel.
    pub park: bool,
    /// Index into `VehicleSpec::transfer`.
    pub transfer: usize,
    /// Per axle: lock the differential (only axles with `lockable`).
    pub diff_lock: [bool; 4],
    /// Manual gearbox: +1 / -1 shifts once (cleared by the step). Ignored by an automatic.
    pub shift: i8,
}

/// Runtime state (not for game code to write).
#[derive(Component, Default)]
pub struct VehicleState {
    wheels: Vec<WheelState>,
    gear: i32,
    shift_cd: f32,
    steer: f32,
    probe: Option<Collider>,
}

#[derive(Clone, Copy, Default)]
struct WheelState {
    omega: f32,
    len: f32,
    grounded: bool,
    bottomed: bool,
}

/// Read-only numbers for HUD, audio and cameras; written every physics tick.
#[derive(Component, Clone, Debug, Default)]
pub struct VehicleTelemetry {
    /// Signed speed along the vehicle's forward axis, m/s.
    pub speed: f32,
    pub rpm: f32,
    pub gear: i32,
    /// Effective throttle after the gearbox logic, 0..1.
    pub throttle: f32,
    /// Engine torque as a fraction of the curve's peak (0..1+).
    pub engine_load: f32,
    pub transfer: usize,
    pub grounded_wheels: usize,
    pub bottomed: bool,
    /// Largest combined slip over the wheels (≈1 is the grip limit).
    pub max_slip: f32,
    pub wheels: Vec<WheelTelemetry>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct WheelTelemetry {
    pub grounded: bool,
    /// 0 full droop .. 1 bump stop.
    pub compression: f32,
    pub load: f32,
    pub slip_ratio: f32,
    pub slip_angle: f32,
    pub spin: f32,
    pub steer: f32,
    pub surface: SurfaceId,
    pub contact: Vec3,
    pub normal: Vec3,
    pub drive_torque: f32,
}

#[derive(Clone, Copy, Default)]
struct Contact {
    grounded: bool,
    len: f32,
    normal: Vec3,
    point: Vec3,
    collider: Option<Entity>,
    spring: f32,
    bottomed_speed: f32,
}

fn vehicle_step(
    time: Res<Time>,
    spatial: SpatialQuery,
    surfaces: Res<Surfaces>,
    map: Res<SurfaceMapRes>,
    wet: Res<Wetness>,
    tags: Query<&SurfaceTag>,
    mut events: MessageWriter<VehicleEvent>,
    mut q: Query<(Entity, &Vehicle, &mut VehicleInput, &mut VehicleState, &mut VehicleTelemetry, &Transform, Forces)>,
) {
    let dt = time.delta_secs();
    if dt <= 0.0 {
        return;
    }
    for (entity, veh, mut input, mut st, mut tel, tf, mut forces) in &mut q {
        let spec = &veh.spec;
        let nw = spec.wheels.len();
        if st.wheels.len() != nw {
            st.wheels = spec.wheels.iter().map(|w| WheelState { len: w.spring.max_len, ..default() }).collect();
            st.gear = 1;
        }
        let rot = tf.rotation;
        let (up, fwd, right) = (rot * Vec3::Y, rot * Vec3::NEG_Z, rot * Vec3::X);
        let lin = forces.linear_velocity();
        let speed = lin.dot(fwd);
        let wet = wet.0.clamp(0.0, 1.0);

        // ---- steering
        let lock = spec.steer.max_angle / (1.0 + lin.length() * spec.steer.speed_reduction);
        let target = input.steer.clamp(-1.0, 1.0) * lock;
        let d = target - st.steer;
        st.steer += d.clamp(-spec.steer.rate * dt, spec.steer.rate * dt);

        // ---- suspension probes
        let mut contacts = vec![Contact::default(); nw];
        let filter = SpatialQueryFilter::from_excluded_entities([entity]);
        for (i, w) in spec.wheels.iter().enumerate() {
            let mount = tf.transform_point(w.pos);
            let down = -up;
            let Ok(dir) = Dir3::new(down) else { continue };
            let sp = &w.spring;
            let hit = match w.probe {
                Probe::Ray => spatial
                    .cast_ray(mount, dir, sp.max_len + w.radius, true, &filter)
                    .map(|h| (h.distance - w.radius, h.normal, mount + *dir * h.distance, h.entity)),
                Probe::Sphere => {
                    let shape = st.probe.get_or_insert_with(|| Collider::sphere(w.radius)).clone();
                    let cfg = ShapeCastConfig { max_distance: sp.max_len, target_distance: 0.0, compute_contact_on_penetration: true, ignore_origin_penetration: false };
                    spatial.cast_shape(&shape, mount, Quat::IDENTITY, dir, &cfg, &filter).map(|h| (h.distance, h.normal1, h.point1, h.entity))
                }
            };
            let c = &mut contacts[i];
            if let Some((len, n, p, e)) = hit {
                let len = len.max(0.0).min(sp.max_len);
                let n = if n.length_squared() > 0.5 { n.normalize() } else { up };
                // Contact normals that point away from the chassis' side are walls: ignore.
                if n.dot(up) > 0.2 {
                    let prev = if st.wheels[i].grounded { st.wheels[i].len } else { sp.max_len };
                    let vel = (len - prev) / dt; // negative while compressing
                    let damp = if vel < 0.0 { sp.bump } else { sp.rebound };
                    let mut f = sp.rate * (sp.max_len - len + sp.preload) - damp * vel;
                    if len < sp.min_len {
                        f += sp.bump_stop * (sp.min_len - len);
                    }
                    *c = Contact { grounded: true, len, normal: n, point: p, collider: Some(e), spring: f.max(0.0), bottomed_speed: if len <= sp.min_len + 0.01 { -vel } else { 0.0 } };
                }
            }
            if !c.grounded {
                c.len = sp.max_len;
            }
        }
        // Articulation: anti-roll coupling pushes load across an axle.
        for (a, axle) in spec.axles.iter().enumerate() {
            if axle.roll_coupling <= 0.0 {
                continue;
            }
            let ids: Vec<usize> = (0..nw).filter(|&i| spec.wheels[i].axle == a).collect();
            if let [l, r] = ids[..] {
                let xl = spec.wheels[l].spring.max_len - contacts[l].len;
                let xr = spec.wheels[r].spring.max_len - contacts[r].len;
                let arb = axle.roll_coupling * (xl - xr);
                if contacts[l].grounded {
                    contacts[l].spring = (contacts[l].spring + arb).max(0.0);
                }
                if contacts[r].grounded {
                    contacts[r].spring = (contacts[r].spring - arb).max(0.0);
                }
            }
        }

        // ---- surfaces, grip
        let pressure_ratio = (spec.tyre.pressure / veh.pressure.max(20.0)).clamp(0.4, 3.0);
        let mut grip = vec![1.0f32; nw];
        let mut rolling = vec![0.0f32; nw];
        let mut sink = vec![0.0f32; nw];
        let mut surf_id = vec![SurfaceId::default(); nw];
        for i in 0..nw {
            let c = &contacts[i];
            if !c.grounded {
                continue;
            }
            let id = map.0.surface(&SurfaceQuery { point: c.point, normal: c.normal, collider: c.collider.unwrap(), tag: c.collider.and_then(|e| tags.get(e).ok()).map(|t| t.0) });
            let s = surfaces.get(id);
            surf_id[i] = id;
            // Lower pressure: bigger patch (grip up on soft ground, down a touch on hard) and
            // less rolling resistance on soft ground, more on hard.
            let over = pressure_ratio - 1.0;
            let press_grip = 1.0 + over * (0.45 * s.softness - 0.12 * (1.0 - s.softness));
            let press_roll = 1.0 + over * (0.5 * (1.0 - s.softness) - 0.45 * s.softness);
            grip[i] = (s.grip * (1.0 + (s.wet_grip - 1.0) * wet) * press_grip * veh.grip_scale).max(0.02);
            rolling[i] = spec.tyre.rolling * s.rolling * (1.0 + (s.wet_rolling - 1.0) * wet) * press_roll.max(0.3);
            sink[i] = s.drag;
        }

        // ---- gearbox + engine
        let mode = spec.transfer.get(input.transfer).or(spec.transfer.first()).cloned().unwrap_or_else(|| TransferMode::new("2H", 0.0, 1.0, 1.0, false));
        let share_of = |axle: usize| if axle == 0 { mode.front } else { mode.rear / (spec.axles.len().saturating_sub(1)).max(1) as f32 };
        let driven: Vec<usize> = (0..nw).filter(|&i| share_of(spec.wheels[i].axle) > 0.0).collect();
        let omega_driven = if driven.is_empty() { 0.0 } else { driven.iter().map(|&i| st.wheels[i].omega).sum::<f32>() / driven.len() as f32 };
        let range = mode.range.max(0.1);
        st.shift_cd = (st.shift_cd - dt).max(0.0);
        if spec.gearbox.auto {
            let g = &spec.gearbox;
            let new = drivetrain::auto_gear(g, st.gear, speed, input.throttle, st.shift_cd <= 0.0, |gear| drivetrain::rpm_of(omega_driven, drivetrain::gear_ratio(g, gear) * range));
            if new != st.gear {
                st.shift_cd = g.shift_time;
                st.gear = new;
            }
        } else if input.shift != 0 {
            let top = spec.gearbox.ratios.len() as i32;
            st.gear = (st.gear + input.shift as i32).clamp(-1, top);
            input.shift = 0;
        }
        let ratio = drivetrain::gear_ratio(&spec.gearbox, st.gear) * range;
        let rpm = drivetrain::rpm_of(omega_driven, ratio).max(spec.engine.idle_rpm);
        // Pedals: throttle moves the car along the gear's direction; the opposite pedal brakes.
        let dir_sign = if st.gear < 0 { -1.0 } else { 1.0 };
        let along = input.throttle * dir_sign;
        let throttle = along.max(0.0);
        let mut brake = input.brake.clamp(0.0, 1.0);
        if along < -0.05 && speed * dir_sign > 0.5 {
            brake = brake.max(-along);
        }
        let hold = input.park || (spec.brakes.auto_hold_speed > 0.0 && lin.length() < spec.brakes.auto_hold_speed && throttle < 0.02 && brake < 0.01);
        let crank = drivetrain::engine_torque(&spec.engine, rpm, throttle);
        let peak = spec.engine.torque.iter().map(|p| p.1).fold(1.0, f32::max);
        let wheel_torque = if st.gear == 0 || ratio == 0.0 {
            0.0
        } else if crank >= 0.0 {
            crank * ratio * spec.engine.efficiency
        } else {
            // Engine braking opposes wheel motion.
            -omega_driven.signum() * (-crank) * ratio.abs() * spec.engine.efficiency * if omega_driven.abs() > 0.2 { 1.0 } else { 0.0 }
        };

        // ---- per-wheel capability, torque split
        let mut loads = vec![0.0f32; nw];
        let mut caps = vec![0.0f32; nw];
        for i in 0..nw {
            if contacts[i].grounded {
                loads[i] = contacts[i].spring;
                let ti = TyreInput { load: loads[i], grip: grip[i], spec: spec.tyre, ..default() };
                caps[i] = tyre::peak_force(&ti) * spec.wheels[i].radius;
            }
        }
        let mut axle_torque = vec![0.0f32; spec.axles.len()];
        for a in 0..spec.axles.len() {
            axle_torque[a] = wheel_torque * share_of(a);
        }
        let mut drive = vec![0.0f32; nw];
        for pass in 0..2 {
            let mut excess = 0.0;
            let mut takers = 0;
            for a in 0..spec.axles.len() {
                let ids: Vec<usize> = (0..nw).filter(|&i| spec.wheels[i].axle == a).collect();
                let diff = if input.diff_lock.get(a).copied().unwrap_or(false) && spec.axles[a].lockable { Diff::Locked } else { spec.axles[a].diff };
                let (l, r) = match ids[..] {
                    [l, r] => {
                        let (tl, tr) = drivetrain::diff_split(diff, axle_torque[a], caps[l], caps[r]);
                        drive[l] = tl;
                        drive[r] = tr;
                        (tl, tr)
                    }
                    [one] => {
                        drive[one] = axle_torque[a].clamp(-caps[one], caps[one]);
                        (drive[one], 0.0)
                    }
                    _ => (0.0, 0.0),
                };
                if mode.centre_lock && axle_torque[a] != 0.0 {
                    excess += axle_torque[a] - (l + r);
                    takers += 1;
                }
            }
            if pass == 0 && mode.centre_lock && takers > 1 && excess.abs() > 1.0 {
                // Torque an axle could not use goes to the others (locked centre).
                for a in 0..spec.axles.len() {
                    if axle_torque[a] != 0.0 {
                        let ids: Vec<usize> = (0..nw).filter(|&i| spec.wheels[i].axle == a).collect();
                        let used: f32 = ids.iter().map(|&i| drive[i]).sum();
                        let spare = axle_torque[a] - used;
                        // Axles that used all they were given absorb the others' spare torque.
                        if spare.abs() < 1.0 {
                            axle_torque[a] += excess / (takers as f32 - 1.0).max(1.0);
                        } else {
                            axle_torque[a] = used;
                        }
                    }
                }
            } else {
                break;
            }
        }

        // ---- brakes
        let mut brake_t = vec![0.0f32; nw];
        let front_wheels = spec.wheels.iter().filter(|w| w.axle == 0).count().max(1) as f32;
        let rear_wheels = (nw as f32 - front_wheels).max(1.0);
        for (i, w) in spec.wheels.iter().enumerate() {
            let svc = spec.brakes.torque * brake * if w.axle == 0 { spec.brakes.front_bias / front_wheels } else { (1.0 - spec.brakes.front_bias) / rear_wheels };
            let hb = if (input.handbrake && spec.brakes.handbrake_axles.get(w.axle).copied().unwrap_or(false)) || hold { spec.brakes.handbrake_torque } else { 0.0 };
            brake_t[i] = svc.max(hb);
        }

        // ---- tyres, wheel spin, forces on the body
        let h = dt / SUBSTEPS as f32;
        let mut max_slip = 0.0f32;
        let mut bottomed_any = false;
        tel.wheels.resize(nw, WheelTelemetry::default());
        for (i, w) in spec.wheels.iter().enumerate() {
            let c = contacts[i];
            let mount = tf.transform_point(w.pos);
            let mut wt = WheelTelemetry { grounded: c.grounded, steer: st.steer * w.steer, spin: st.wheels[i].omega, drive_torque: drive[i], surface: surf_id[i], ..default() };
            wt.compression = ((w.spring.max_len - c.len) / (w.spring.max_len - w.spring.min_len).max(1e-3)).clamp(0.0, 1.2);
            // events
            if c.grounded && !st.wheels[i].grounded {
                let closing = -((c.len - w.spring.max_len) / dt).min(0.0);
                let vdown = -lin.dot(up);
                if vdown > 1.5 {
                    events.write(VehicleEvent::WheelLanded { vehicle: entity, wheel: i, speed: vdown.max(closing.min(vdown)) });
                }
            }
            let bottomed = c.grounded && c.bottomed_speed > 1.0;
            if bottomed && !st.wheels[i].bottomed {
                events.write(VehicleEvent::BottomedOut { vehicle: entity, wheel: i, speed: c.bottomed_speed });
            }
            bottomed_any |= bottomed;
            if !c.grounded {
                // Airborne: free wheel, only drive and brakes act.
                let mut om = st.wheels[i].omega;
                om += h * SUBSTEPS as f32 / w.inertia * drive[i];
                let db = dt / w.inertia * brake_t[i];
                om = if om.abs() <= db { 0.0 } else { om - om.signum() * db };
                st.wheels[i] = WheelState { omega: om, len: c.len, grounded: false, bottomed: false };
                tel.wheels[i] = wt;
                continue;
            }
            // Wheel frame on the contact plane.
            let yaw = Quat::from_axis_angle(up, -st.steer * w.steer);
            let heading = yaw * fwd;
            let f_dir = (heading - c.normal * heading.dot(c.normal)).normalize_or_zero();
            let r_dir = f_dir.cross(c.normal);
            let vp = forces.velocity_at_point(c.point);
            let (v_long, v_lat) = (vp.dot(f_dir), vp.dot(r_dir));
            let n_load = c.spring;
            let mut omega = st.wheels[i].omega;
            let mut out = Vec2::ZERO;
            let mut input_t = TyreInput { load: n_load, v_long, v_lat, slip_speed: 0.0, grip: grip[i], spec: spec.tyre };
            for _ in 0..SUBSTEPS {
                input_t.slip_speed = omega * w.radius - v_long;
                out = spec.tyre_model.forces(&input_t);
                // Implicit step: linearise the tyre so the spin stays stable at walking pace.
                let probe = TyreInput { slip_speed: input_t.slip_speed + 0.1, ..input_t };
                let slope = ((spec.tyre_model.forces(&probe).x - out.x) / 0.1).max(0.0);
                let net = drive[i] - out.x * w.radius;
                let gain = h / w.inertia;
                omega += gain * net / (1.0 + gain * w.radius * w.radius * slope);
                let db = gain * brake_t[i];
                omega = if omega.abs() <= db { 0.0 } else { omega - omega.signum() * db };
            }
            // Don't let one tick of tyre force reverse the patch's own motion (explicit chassis).
            let m_eff = (n_load / GRAVITY).max(1.0);
            let max_lat = m_eff * v_lat.abs() / dt;
            out.y = out.y.clamp(-max_lat, max_lat);
            let roll_f = rolling[i] * n_load * (v_long / 0.4).tanh();
            let mut fx = out.x - roll_f - sink[i] * v_long;
            // Passive friction may stop the patch but not reverse it within one tick (no stick-slip jitter).
            if fx * v_long < 0.0 && drive[i].abs() < 1.0 {
                let lim = m_eff * v_long.abs() / dt;
                fx = fx.clamp(-lim, lim);
            }
            let world_f = f_dir * fx + r_dir * out.y;
            forces.apply_force_at_point(world_f, c.point);
            // Spring + damper act at the chassis mount, along the chassis' up axis.
            forces.apply_force_at_point(up * n_load, mount);
            let ref_speed = v_long.abs().max(1.2);
            let kappa = input_t.slip_speed / ref_speed;
            let alpha = v_lat.atan2(ref_speed);
            wt.slip_ratio = kappa;
            wt.slip_angle = alpha;
            wt.load = n_load;
            wt.contact = c.point;
            wt.normal = c.normal;
            wt.spin = omega;
            let s = ((kappa / spec.tyre.peak_slip).powi(2) + (alpha / spec.tyre.peak_angle).powi(2)).sqrt();
            max_slip = max_slip.max(s);
            st.wheels[i] = WheelState { omega, len: c.len, grounded: true, bottomed };
            tel.wheels[i] = wt;
        }

        // ---- aero drag at the centre of mass
        let v2 = lin.length();
        if v2 > 0.1 {
            forces.apply_force(-lin * v2 * spec.aero_drag);
        }

        tel.speed = speed;
        tel.rpm = rpm;
        tel.gear = st.gear;
        tel.throttle = throttle;
        tel.engine_load = if throttle > 0.0 { crank.max(0.0) / peak } else { 0.0 };
        tel.transfer = input.transfer.min(spec.transfer.len().saturating_sub(1));
        tel.grounded_wheels = contacts.iter().filter(|c| c.grounded).count();
        tel.bottomed = bottomed_any;
        tel.max_slip = max_slip;
        let _ = right;
    }
}
