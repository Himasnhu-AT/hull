//! dda.ts: walks the cells of a 2D grid (x and z) that a segment passes through, in order (Amanatides and Woo).
//! Same arithmetic as the TypeScript, in f64 throughout: cell indices stay f64 because the TypeScript keeps them as
//! numbers (floor of a quotient that may be huge or not a number), and are only turned into indices by the caller.
use crate::math::floor;

pub struct Dda {
    pub ix: f64,
    pub iz: f64,
    pub t_entry: f64,
    pub step_x: f64,
    pub step_z: f64,
    pub t_max_x: f64,
    pub t_max_z: f64,
    pub t_dx: f64,
    pub t_dz: f64,
    pub t_end: f64,
}

impl Dda {
    pub const fn new() -> Self {
        Dda { ix: 0.0, iz: 0.0, t_entry: 0.0, step_x: 0.0, step_z: 0.0, t_max_x: f64::INFINITY, t_max_z: f64::INFINITY, t_dx: 0.0, t_dz: 0.0, t_end: 0.0 }
    }

    /// Starts a walk of (ox, oz) + t * (dx, dz) for t in [0, t_end], over square cells of side `size`.
    pub fn init(&mut self, ox: f64, oz: f64, dx: f64, dz: f64, t_end: f64, size: f64) {
        self.ix = floor(ox / size);
        self.iz = floor(oz / size);
        self.t_entry = 0.0;
        self.t_end = t_end;
        if dx > 0.0 {
            self.step_x = 1.0;
            self.t_max_x = ((self.ix + 1.0) * size - ox) / dx;
            self.t_dx = size / dx;
        } else if dx < 0.0 {
            self.step_x = -1.0;
            self.t_max_x = (self.ix * size - ox) / dx;
            self.t_dx = -size / dx;
        } else {
            self.step_x = 0.0;
            self.t_max_x = f64::INFINITY;
            self.t_dx = f64::INFINITY;
        }
        if dz > 0.0 {
            self.step_z = 1.0;
            self.t_max_z = ((self.iz + 1.0) * size - oz) / dz;
            self.t_dz = size / dz;
        } else if dz < 0.0 {
            self.step_z = -1.0;
            self.t_max_z = (self.iz * size - oz) / dz;
            self.t_dz = -size / dz;
        } else {
            self.step_z = 0.0;
            self.t_max_z = f64::INFINITY;
            self.t_dz = f64::INFINITY;
        }
    }

    /// Parameter at which the walk leaves the current cell.
    pub fn t_exit(&self) -> f64 {
        if self.t_max_x < self.t_max_z { self.t_max_x } else { self.t_max_z }
    }

    /// Moves to the next cell. False when the segment ends first.
    pub fn advance(&mut self) -> bool {
        if self.t_max_x < self.t_max_z {
            if self.t_max_x > self.t_end {
                return false;
            }
            self.t_entry = self.t_max_x;
            self.ix += self.step_x;
            self.t_max_x += self.t_dx;
        } else {
            if self.t_max_z > self.t_end || self.t_max_z == f64::INFINITY {
                return false;
            }
            self.t_entry = self.t_max_z;
            self.iz += self.step_z;
            self.t_max_z += self.t_dz;
        }
        true
    }
}
