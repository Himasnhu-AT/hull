//! Vehicle data: everything a game tunes is a plain struct here (no code), so a spec can be
//! built, cloned, tweaked and swapped at run time. [`VehicleSpec::truck`] is a ~2 t body-on-frame
//! pickup tuned for low-speed off-road; the other constructors in the docs show how little a new
//! vehicle needs.

use std::sync::Arc;

use bevy::prelude::*;

use super::tyre::{SlipCircleTyre, TyreModel};

/// Everything that describes one vehicle. Cheap to clone (the tyre model is shared).
#[derive(Clone)]
pub struct VehicleSpec {
    pub mass: f32,
    /// Chassis collider size (full extents, metres) centred on the body origin.
    pub body: Vec3,
    /// Centre of mass relative to the body origin (negative `y` is low).
    pub com: Vec3,
    pub wheels: Vec<WheelSpec>,
    /// One entry per axle index used by `WheelSpec::axle`.
    pub axles: Vec<AxleSpec>,
    pub engine: EngineSpec,
    pub gearbox: GearboxSpec,
    /// Transfer case modes (data, selected by index through `VehicleInput::transfer`).
    pub transfer: Vec<TransferMode>,
    pub steer: SteerSpec,
    pub brakes: BrakeSpec,
    pub tyre: TyreSpec,
    /// Pluggable tyre force model (see [`TyreModel`]).
    pub tyre_model: Arc<dyn TyreModel>,
    /// `0.5 * rho * Cd * A` in kg/m: drag force is `aero_drag * v * |v|`.
    pub aero_drag: f32,
}

/// How a wheel finds the ground.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Probe {
    /// One ray along the suspension axis (cheapest; steps on sharp edges).
    Ray,
    /// A sphere the size of the wheel swept along the axis: rolls over edges and logs smoothly.
    Sphere,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpringSpec {
    /// Spring rate, N/m.
    pub rate: f32,
    /// Damping when compressing / extending, N·s/m (rebound is usually stiffer).
    pub bump: f32,
    pub rebound: f32,
    /// Wheel-centre distance below the mount at full droop / at full bump (metres).
    pub max_len: f32,
    pub min_len: f32,
    /// Extra pre-compression (metres) so the spring carries weight with a long droop travel.
    pub preload: f32,
    /// Stiffness of the bump stop below `min_len`, N/m.
    pub bump_stop: f32,
}

impl Default for SpringSpec {
    fn default() -> Self {
        SpringSpec { rate: 42_000.0, bump: 3_200.0, rebound: 4_800.0, max_len: 0.62, min_len: 0.2, preload: 0.0, bump_stop: 400_000.0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WheelSpec {
    /// Suspension mount, chassis-local (the top of the travel).
    pub pos: Vec3,
    pub radius: f32,
    /// Wheel plus tyre rotational inertia, kg·m².
    pub inertia: f32,
    /// Fraction of the steering lock this wheel takes (front 1.0, rear 0.0, 4-wheel steer -0.3).
    pub steer: f32,
    pub axle: usize,
    pub spring: SpringSpec,
    pub probe: Probe,
}

/// How the two wheels of an axle share drive torque.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Diff {
    /// Equal torque: the wheel with less grip limits both (a spinning wheel on ice stalls the axle).
    Open,
    /// Both wheels turn together: each wheel carries what its own grip allows.
    Locked,
    /// Partial lock: `0` is open, `1` is locked.
    LimitedSlip(f32),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AxleSpec {
    pub diff: Diff,
    /// The driver may lock this axle's diff (`VehicleInput::diff_lock`).
    pub lockable: bool,
    /// Anti-roll coupling between the two wheels, N/m of left-right compression difference.
    /// Articulation: 0 is fully independent (wheels follow bumps), a high value approximates a
    /// solid axle (the two sides move together, a wheel lifts as the other drops).
    pub roll_coupling: f32,
}

impl Default for AxleSpec {
    fn default() -> Self {
        AxleSpec { diff: Diff::Open, lockable: true, roll_coupling: 0.0 }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EngineSpec {
    /// `(rpm, Nm)` points, ascending rpm, linearly interpolated.
    pub torque: Vec<(f32, f32)>,
    pub idle_rpm: f32,
    pub redline_rpm: f32,
    /// Drag torque at redline with the throttle closed (Nm); scales with rpm.
    pub engine_brake: f32,
    /// Fraction of engine torque that reaches the gearbox output.
    pub efficiency: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GearboxSpec {
    /// Forward ratios, first gear first.
    pub ratios: Vec<f32>,
    pub reverse: f32,
    pub final_drive: f32,
    pub auto: bool,
    pub shift_up_rpm: f32,
    pub shift_down_rpm: f32,
    /// Seconds between automatic shifts.
    pub shift_time: f32,
}

/// One position of the transfer case.
#[derive(Clone, Debug, PartialEq)]
pub struct TransferMode {
    pub name: String,
    /// Share of drive torque to the front / rear axle group (axle 0 is the front).
    pub front: f32,
    pub rear: f32,
    /// Extra reduction (1.0 = direct, 2.5 = low range).
    pub range: f32,
    /// Torque an axle cannot use (it has no grip) goes to the other one.
    pub centre_lock: bool,
}

impl TransferMode {
    pub fn new(name: &str, front: f32, rear: f32, range: f32, centre_lock: bool) -> Self {
        TransferMode { name: name.into(), front, rear, range, centre_lock }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SteerSpec {
    /// Lock at standstill, radians.
    pub max_angle: f32,
    /// Lock shrinks as `1 / (1 + speed * speed_reduction)`.
    pub speed_reduction: f32,
    /// Steering wheel speed, rad/s of road-wheel angle.
    pub rate: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BrakeSpec {
    /// Total service brake torque at the wheels at full pedal, Nm.
    pub torque: f32,
    pub front_bias: f32,
    pub handbrake_torque: f32,
    /// Axles the handbrake acts on.
    pub handbrake_axles: [bool; 4],
    /// Hold the vehicle (parking brake on all wheels) below this speed when no pedal is down; 0 = off.
    pub auto_hold_speed: f32,
}

/// Tyre parameters shared by all wheels (the model decides what they mean).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TyreSpec {
    /// Peak friction coefficient on a surface with grip 1.
    pub mu: f32,
    /// Slip ratio / slip angle (rad) at peak force.
    pub peak_slip: f32,
    pub peak_angle: f32,
    /// Grip lost per doubling of load above nominal (load sensitivity, 0..0.5).
    pub load_sens: f32,
    pub nominal_load: f32,
    /// Rolling resistance coefficient on a surface with `rolling = 1`.
    pub rolling: f32,
    /// Nominal pressure (kPa); `Vehicle::pressure` is compared against it.
    pub pressure: f32,
}

impl Default for TyreSpec {
    fn default() -> Self {
        TyreSpec { mu: 1.05, peak_slip: 0.14, peak_angle: 0.20, load_sens: 0.12, nominal_load: 5_000.0, rolling: 1.0, pressure: 220.0 }
    }
}

impl VehicleSpec {
    /// A ~2 t 4x4 pickup: 3.0 m wheelbase, long-travel independent suspension, 4.0 l engine with a
    /// 5-speed automatic and a transfer case with 2H / 4H / 4L.
    pub fn truck() -> Self {
        let spring = SpringSpec::default();
        let wheel = |x: f32, z: f32, steer: f32, axle: usize| WheelSpec {
            pos: Vec3::new(x, -0.05, z),
            radius: 0.38,
            inertia: 2.6,
            steer,
            axle,
            spring,
            probe: Probe::Sphere,
        };
        VehicleSpec {
            mass: 2_000.0,
            body: Vec3::new(1.8, 0.9, 4.6),
            com: Vec3::new(0.0, -0.45, -0.1),
            wheels: vec![wheel(-1.0, -1.5, 1.0, 0), wheel(1.0, -1.5, 1.0, 0), wheel(-1.0, 1.5, 0.0, 1), wheel(1.0, 1.5, 0.0, 1)],
            axles: vec![AxleSpec::default(), AxleSpec { roll_coupling: 6_000.0, ..default() }],
            engine: EngineSpec {
                torque: vec![(800.0, 220.0), (1500.0, 320.0), (2500.0, 380.0), (3500.0, 360.0), (4500.0, 300.0), (5500.0, 220.0)],
                idle_rpm: 800.0,
                redline_rpm: 5_500.0,
                engine_brake: 90.0,
                efficiency: 0.88,
            },
            gearbox: GearboxSpec { ratios: vec![3.8, 2.2, 1.45, 1.0, 0.75], reverse: 3.4, final_drive: 3.9, auto: true, shift_up_rpm: 4_300.0, shift_down_rpm: 1_500.0, shift_time: 0.5 },
            transfer: vec![
                TransferMode::new("2H", 0.0, 1.0, 1.0, false),
                TransferMode::new("4H", 0.5, 0.5, 1.0, true),
                TransferMode::new("4L", 0.5, 0.5, 2.7, true),
            ],
            steer: SteerSpec { max_angle: 0.6, speed_reduction: 0.05, rate: 2.0 },
            brakes: BrakeSpec { torque: 9_000.0, front_bias: 0.65, handbrake_torque: 5_000.0, handbrake_axles: [false, true, false, false], auto_hold_speed: 0.4 },
            tyre: TyreSpec::default(),
            tyre_model: Arc::new(SlipCircleTyre::default()),
            aero_drag: 0.55,
        }
    }
}
