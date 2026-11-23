//! narrow.ts in Rust. STUB: the narrow-phase worker ports it. The signatures below are the contract.
use crate::shapes as s;

/// The best hit of the sweep in progress (narrow.ts `B`). `shape` is a shape id, -1 for none.
pub struct Best {
    pub t: f64,
    pub nx: f64,
    pub ny: f64,
    pub nz: f64,
    pub shape: i32,
    pub inside: bool,
    pub depth: f64,
}

/// The closest-point result (narrow.ts `C`).
pub struct Closest {
    pub dist: f64,
    pub nx: f64,
    pub ny: f64,
    pub nz: f64,
}

pub static mut B: Best = Best { t: 0.0, nx: 0.0, ny: 0.0, nz: 0.0, shape: -1, inside: false, depth: 0.0 };
pub static mut C: Closest = Closest { dist: 0.0, nx: 0.0, ny: 1.0, nz: 0.0 };

pub fn begin_sweep(max_t: f64) {
    unsafe {
        B.t = max_t;
        B.shape = -1;
        B.inside = false;
        B.depth = 0.0;
    }
}

/// Ray against an axis-aligned box, only the parameter range [0, tmax].
pub fn ray_aabb(_ox: f64, _oy: f64, _oz: f64, _dx: f64, _dy: f64, _dz: f64, _x0: f64, _y0: f64, _z0: f64, _x1: f64, _y1: f64, _z1: f64, _tmax: f64) -> bool {
    let _ = s::K_SPHERE;
    false
}

/// Sweeps a sphere of radius r from o along unit d against shape `id`; offers its hit to `B`.
pub fn sweep_shape(_id: usize, _ox: f64, _oy: f64, _oz: f64, _dx: f64, _dy: f64, _dz: f64, _r: f64) {}

/// Distance from a point to shape `id` (negative inside), with the direction away in `C`.
pub fn closest_on(_id: usize, _px: f64, _py: f64, _pz: f64) -> f64 {
    0.0
}
