//! Curve evaluation. A position on the curve is a parameter `s`: segment index + fraction.

use bevy::prelude::*;

use super::{Spline, SplineMode, SplineSample};

/// Centripetal Catmull-Rom (Barry-Goldman) between `p1` and `p2`, `u` in 0..1.
pub(crate) fn catmull(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: f32) -> Vec3 {
    #[inline]
    fn dt(a: Vec3, b: Vec3) -> f32 {
        // |a-b|^0.5 with a floor so coincident points never divide by zero.
        (a - b).length_squared().sqrt().sqrt().max(1e-3)
    }
    let t0 = 0.0;
    let t1 = t0 + dt(p0, p1);
    let t2 = t1 + dt(p1, p2);
    let t3 = t2 + dt(p2, p3);
    let t = t1 + (t2 - t1) * u;
    let a1 = p0 * ((t1 - t) / (t1 - t0)) + p1 * ((t - t0) / (t1 - t0));
    let a2 = p1 * ((t2 - t) / (t2 - t1)) + p2 * ((t - t1) / (t2 - t1));
    let a3 = p2 * ((t3 - t) / (t3 - t2)) + p3 * ((t - t2) / (t3 - t2));
    let b1 = a1 * ((t2 - t) / (t2 - t0)) + a2 * ((t - t0) / (t2 - t0));
    let b2 = a2 * ((t3 - t) / (t3 - t1)) + a3 * ((t - t1) / (t3 - t1));
    b1 * ((t2 - t) / (t2 - t1)) + b2 * ((t - t1) / (t2 - t1))
}

/// Rotates `(right, up)` around `dir` by `bank` radians (positive lowers the right edge).
fn frame(dir: Vec3, bank: f32) -> (Vec3, Vec3) {
    let mut right = dir.cross(Vec3::Y);
    if right.length_squared() < 1e-8 {
        right = Vec3::X;
    }
    let right = right.normalize();
    let up = right.cross(dir).normalize_or(Vec3::Y);
    let (s, c) = bank.sin_cos();
    (right * c - up * s, up * c + right * s)
}

impl Spline {
    /// Segment `seg` and local `u` for curve parameter `s` (clamped into range).
    fn locate(&self, s: f32) -> Option<(usize, f32)> {
        let segs = self.segment_count();
        if segs == 0 {
            return None;
        }
        let s = if s.is_finite() { s.clamp(0.0, segs as f32) } else { 0.0 };
        let seg = (s.floor() as usize).min(segs - 1);
        Some((seg, s - seg as f32))
    }

    fn four(&self, seg: usize) -> [Vec3; 4] {
        let p = &self.points;
        let n = p.len();
        if self.is_loop() {
            [p[(seg + n - 1) % n].pos, p[seg].pos, p[(seg + 1) % n].pos, p[(seg + 2) % n].pos]
        } else {
            let (a, b) = (p[seg].pos, p[seg + 1].pos);
            let before = if seg == 0 { 2.0 * a - b } else { p[seg - 1].pos };
            let after = if seg + 2 < n { p[seg + 2].pos } else { 2.0 * b - a };
            [before, a, b, after]
        }
    }

    /// Position at curve parameter `s` (segment index + fraction), clamped to the curve.
    pub fn pos_at(&self, s: f32) -> Vec3 {
        let Some((seg, u)) = self.locate(s) else { return self.points.first().map(|p| p.pos).unwrap_or(Vec3::ZERO) };
        let [p0, p1, p2, p3] = self.four(seg);
        match self.mode {
            SplineMode::Catmull => catmull(p0, p1, p2, p3, u),
            SplineMode::Linear => p1.lerp(p2, u),
        }
    }

    /// Full sample at curve parameter `s`.
    pub fn sample_s(&self, s: f32) -> Option<SplineSample> {
        let Some((seg, u)) = self.locate(s) else {
            let p = self.points.first()?;
            let (right, up) = frame(Vec3::NEG_Z, p.bank);
            return Some(SplineSample { pos: p.pos, dir: Vec3::NEG_Z, right, up, width: p.width, bank: p.bank, tags: p.tags, t: 0.0 });
        };
        let n = self.points.len();
        let (a, b) = (&self.points[seg], &self.points[(seg + 1) % n]);
        let s = seg as f32 + u;
        let pos = self.pos_at(s);
        let segs = self.segment_count() as f32;
        // Direction: central difference along the curve (one-sided at open ends).
        let h = 0.02;
        let (lo, hi) = if self.is_loop() { (s - h, s + h) } else { ((s - h).max(0.0), (s + h).min(segs)) };
        let wrap = |x: f32| if self.is_loop() { x.rem_euclid(segs) } else { x };
        let mut dir = self.pos_at(wrap(hi)) - self.pos_at(wrap(lo));
        if dir.length_squared() < 1e-12 {
            dir = self.points[(seg + 1) % n].pos - self.points[seg].pos;
        }
        let dir = dir.normalize_or(Vec3::NEG_Z);
        let bank = a.bank + (b.bank - a.bank) * u;
        let (right, up) = frame(dir, bank);
        Some(SplineSample { pos, dir, right, up, width: a.width + (b.width - a.width) * u, bank, tags: a.tags, t: s })
    }
}
