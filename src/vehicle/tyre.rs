//! Tyre force model. [`TyreModel`] is the extension point: implement it for a brush model, a
//! lookup table or an arcade clamp and put it in `VehicleSpec::tyre_model`. The default,
//! [`SlipCircleTyre`], normalises the longitudinal and lateral slip by their peak slips and runs
//! the combined slip through one friction curve, so a locked or spinning wheel gives up side grip.

use bevy::prelude::*;

/// What the tyre knows about this instant (all in the wheel's ground-plane frame).
#[derive(Clone, Copy, Debug, Default)]
pub struct TyreInput {
    /// Vertical load, N.
    pub load: f32,
    /// Speed of the contact patch along the wheel's heading, m/s (+ forward).
    pub v_long: f32,
    /// Sideways speed of the patch, m/s (+ to the right of the wheel).
    pub v_lat: f32,
    /// Tyre surface speed minus ground speed along the heading (`omega * r - v_long`), m/s.
    pub slip_speed: f32,
    /// Friction multiplier from surface, wetness and pressure (1 = reference surface).
    pub grip: f32,
    pub spec: super::spec::TyreSpec,
}

/// Longitudinal (+ forward) and lateral (+ right) force on the vehicle, newtons.
pub trait TyreModel: Send + Sync + 'static {
    fn forces(&self, i: &TyreInput) -> Vec2;
}

/// See the module doc. `sliding` is the fraction of peak force kept when fully sliding.
#[derive(Clone, Copy, Debug)]
pub struct SlipCircleTyre {
    pub sliding: f32,
    /// Speed below which slip is measured against this value instead (no jitter at a standstill), m/s.
    pub low_speed: f32,
}

impl Default for SlipCircleTyre {
    fn default() -> Self {
        SlipCircleTyre { sliding: 0.82, low_speed: 1.2 }
    }
}

impl SlipCircleTyre {
    /// Friction curve: rises to 1 at `s = 1`, then falls towards `sliding`.
    pub fn curve(&self, s: f32) -> f32 {
        if s <= 1.0 { s * (2.0 - s) } else { self.sliding + (1.0 - self.sliding) / s }
    }
}

/// Peak force a tyre can give at this load and grip (what the differentials treat as the cap).
pub fn peak_force(i: &TyreInput) -> f32 {
    if i.load <= 0.0 {
        return 0.0;
    }
    let t = &i.spec;
    let load_k = (i.load / t.nominal_load).max(0.05).powf(-t.load_sens);
    t.mu * i.grip * i.load * load_k
}

impl TyreModel for SlipCircleTyre {
    fn forces(&self, i: &TyreInput) -> Vec2 {
        if i.load <= 0.0 {
            return Vec2::ZERO;
        }
        let t = &i.spec;
        let ref_speed = i.v_long.abs().max(self.low_speed);
        let kappa = i.slip_speed / ref_speed;
        let alpha = i.v_lat.atan2(ref_speed);
        let (sx, sy) = (kappa / t.peak_slip, alpha / t.peak_angle);
        let s = (sx * sx + sy * sy).sqrt();
        if s < 1e-5 {
            return Vec2::ZERO;
        }
        // Load sensitivity: grip per newton falls as the load rises past nominal.
        let f = peak_force(i) * self.curve(s);
        Vec2::new(f * sx / s, -f * sy / s)
    }
}
