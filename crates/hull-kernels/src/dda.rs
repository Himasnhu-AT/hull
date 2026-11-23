//! dda.ts: walks the cells of a 2D grid (x and z) that a segment passes through, in order (Amanatides and Woo).
//! STUB: ported by the narrow-phase worker.
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
    pub fn init(&mut self, _ox: f64, _oz: f64, _dx: f64, _dz: f64, _t_end: f64, _size: f64) {}
    pub fn t_exit(&self) -> f64 { if self.t_max_x < self.t_max_z { self.t_max_x } else { self.t_max_z } }
    pub fn advance(&mut self) -> bool { false }
}
