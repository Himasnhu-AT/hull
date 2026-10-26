//! Blend-space weights (allocation free; write into a caller's slice).
//!
//! - 1D: linear between the two samples around the value, clamped at the ends.
//! - 2D cartesian: gradient-band interpolation (Johansen 2009, what Unity calls "freeform
//!   cartesian"): every sample's influence falls off linearly towards each other sample.
//! - 2D directional: gradient bands in a polar space (magnitude + 2 × angle), so samples on a
//!   ring blend by direction, and an idle at the origin by speed.
//!
//! Weights are ≥ 0 and sum to 1 (unless there are no samples).

use bevy::math::Vec2;

use super::def::Blend2dMode;

/// `points` sorted ascending.
pub fn weights_1d(points: &[f32], v: f32, out: &mut [f32]) {
    out.fill(0.0);
    let n = points.len();
    if n == 0 {
        return;
    }
    if n == 1 || v <= points[0] {
        out[0] = 1.0;
        return;
    }
    if v >= points[n - 1] {
        out[n - 1] = 1.0;
        return;
    }
    for i in 0..n - 1 {
        let (a, b) = (points[i], points[i + 1]);
        if v >= a && v <= b {
            let span = b - a;
            let t = if span > 1e-6 { (v - a) / span } else { 0.0 };
            out[i] = 1.0 - t;
            out[i + 1] = t;
            return;
        }
    }
}

pub fn weights_2d(points: &[Vec2], p: Vec2, mode: Blend2dMode, out: &mut [f32]) {
    out.fill(0.0);
    let n = points.len();
    if n == 0 {
        return;
    }
    if n == 1 {
        out[0] = 1.0;
        return;
    }
    let mut total = 0.0;
    for i in 0..n {
        let pi = points[i];
        let mut w = f32::MAX;
        for (j, &pj) in points.iter().enumerate() {
            if i == j {
                continue;
            }
            let h = match mode {
                Blend2dMode::Cartesian => {
                    let ij = pj - pi;
                    let len2 = ij.length_squared();
                    if len2 < 1e-12 {
                        continue;
                    }
                    1.0 - (p - pi).dot(ij) / len2
                }
                Blend2dMode::Directional => {
                    let (vij, vip) = polar_pair(pi, pj, p);
                    let len2 = vij.length_squared();
                    if len2 < 1e-12 {
                        continue;
                    }
                    1.0 - vip.dot(vij) / len2
                }
            };
            w = w.min(h);
        }
        let w = if w == f32::MAX { 0.0 } else { w.max(0.0) };
        out[i] = w;
        total += w;
    }
    if total > 1e-9 {
        for w in out.iter_mut().take(n) {
            *w /= total;
        }
    } else {
        // Degenerate layout: nearest sample wins.
        let mut best = 0;
        for i in 1..n {
            if points[i].distance_squared(p) < points[best].distance_squared(p) {
                best = i;
            }
        }
        out[best] = 1.0;
    }
}

/// Johansen's polar gradient-band vectors for the pair (i, j) and the query p.
fn polar_pair(pi: Vec2, pj: Vec2, p: Vec2) -> (Vec2, Vec2) {
    const ANGLE_WEIGHT: f32 = 2.0;
    let (li, lj, lp) = (pi.length(), pj.length(), p.length());
    let mean = ((li + lj) * 0.5).max(1e-6);
    let signed = |a: Vec2, b: Vec2| -> f32 {
        if a.length_squared() < 1e-10 || b.length_squared() < 1e-10 {
            0.0
        } else {
            a.perp_dot(b).atan2(a.dot(b))
        }
    };
    // A sample at the origin has no direction: only magnitude counts for its pairs.
    let a_ij = signed(pi, pj);
    let a_ip = signed(pi, p);
    (Vec2::new((lj - li) / mean, a_ij * ANGLE_WEIGHT), Vec2::new((lp - li) / mean, a_ip * ANGLE_WEIGHT))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sum(w: &[f32]) -> f32 {
        w.iter().sum()
    }

    #[test]
    fn one_d_interpolates_and_clamps() {
        let pts = [0.0, 1.5, 4.0];
        let mut w = [0.0; 3];
        weights_1d(&pts, 0.75, &mut w);
        assert_eq!(w, [0.5, 0.5, 0.0]);
        weights_1d(&pts, 9.0, &mut w);
        assert_eq!(w, [0.0, 0.0, 1.0]);
        weights_1d(&pts, -1.0, &mut w);
        assert_eq!(w, [1.0, 0.0, 0.0]);
        weights_1d(&pts, 2.75, &mut w);
        assert!((w[1] - 0.5).abs() < 1e-6 && (w[2] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn two_d_hits_samples_exactly_and_sums_to_one() {
        let pts = [Vec2::ZERO, Vec2::new(0.0, 1.5), Vec2::new(0.0, -1.3), Vec2::new(1.4, 0.0), Vec2::new(-1.4, 0.0), Vec2::new(0.0, 4.0)];
        for mode in [Blend2dMode::Cartesian, Blend2dMode::Directional] {
            let mut w = [0.0; 6];
            for (i, &p) in pts.iter().enumerate() {
                weights_2d(&pts, p, mode, &mut w);
                assert!((w[i] - 1.0).abs() < 1e-4, "{mode:?} sample {i}: {w:?}");
            }
            for p in [Vec2::new(0.3, 0.7), Vec2::new(-1.0, 2.0), Vec2::new(0.7, -0.6), Vec2::new(5.0, 5.0)] {
                weights_2d(&pts, p, mode, &mut w);
                assert!((sum(&w) - 1.0).abs() < 1e-4, "{mode:?} {p}: {w:?}");
                assert!(w.iter().all(|&x| x >= 0.0));
            }
            // Halfway between idle and walk forward: those two dominate.
            weights_2d(&pts, Vec2::new(0.0, 0.75), mode, &mut w);
            assert!(w[0] > 0.3 && w[1] > 0.3, "{mode:?}: {w:?}");
        }
    }
}
