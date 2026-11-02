//! Terrain brushes as pure functions: given the heights (or splat texels) and a brush, they
//! compute the new values for a rectangle. They never touch the world; `TerrainEdit`
//! (`edit.rs`) applies the result and rebuilds what changed.
//!
//! `strength` means **metres per dab at the centre** for Raise / Lower / Noise and a **0..1
//! blend per dab** for Smooth / Flatten / Ramp / Paint. Dabs along a stroke should be spaced
//! about a quarter radius apart (`terrain.stroke` resamples to that).

use bevy::math::Vec2;
use bevy::reflect::Reflect;
use serde::{Deserialize, Serialize};

use super::heightfield::Heightfield;
use super::noise::Fbm;

/// Heights are kept inside this many metres of zero (a runaway stroke cannot reach f32 limits).
pub const HEIGHT_LIMIT: f32 = 20_000.0;

/// What a brush does.
#[derive(Reflect, Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum BrushKind {
    #[default]
    Raise,
    Lower,
    Smooth,
    /// Pull heights toward `target` (or the height under the first dab with `pick_target`).
    Flatten,
    /// Grade the strip between the first and last point of a stroke (`ramp_end` for one dab).
    Ramp,
    Noise,
    /// Paint splat layer `layer` (renormalises the other weights).
    Paint,
}

/// How the effect fades from the centre (1) to the radius (0).
#[derive(Reflect, Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Falloff {
    #[default]
    Smooth,
    Linear,
    /// Full strength to the edge.
    Constant,
}

impl Falloff {
    /// Weight at normalised distance `d` (0 = centre, 1 = radius).
    #[inline]
    pub fn weight(self, d: f32) -> f32 {
        if d >= 1.0 {
            return 0.0;
        }
        let t = 1.0 - d.max(0.0);
        match self {
            Falloff::Smooth => t * t * (3.0 - 2.0 * t),
            Falloff::Linear => t,
            Falloff::Constant => 1.0,
        }
    }
}

/// Kernel of the Smooth brush (3×3).
#[derive(Reflect, Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum SmoothKernel {
    Box,
    #[default]
    Gaussian,
}

/// One brush. Shown in the editor's property grid (Reflect) and read from JSON by the
/// `terrain.*` commands (missing fields take these defaults).
#[derive(Reflect, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BrushSettings {
    pub kind: BrushKind,
    /// Metres.
    pub radius: f32,
    /// See the module docs.
    pub strength: f32,
    pub falloff: Falloff,
    /// Flatten: the height to reach. Ramp: the height at the far end.
    pub target: f32,
    /// Flatten: use the terrain height under the first dab. Ramp: keep the terrain height at
    /// the far end (a straight grade between the two existing heights).
    pub pick_target: bool,
    /// Paint: splat layer (0..=3).
    pub layer: u8,
    pub smooth_kernel: SmoothKernel,
    /// Noise: size of the features in metres.
    pub noise_scale: f32,
    pub noise_seed: u32,
    /// Ramp, single dab: absolute XZ of the far end.
    pub ramp_end: [f32; 2],
}

impl Default for BrushSettings {
    fn default() -> Self {
        BrushSettings {
            kind: BrushKind::Raise,
            radius: 20.0,
            strength: 0.5,
            falloff: Falloff::Smooth,
            target: 0.0,
            pick_target: false,
            layer: 0,
            smooth_kernel: SmoothKernel::Gaussian,
            noise_scale: 30.0,
            noise_seed: 1,
            ramp_end: [0.0; 2],
        }
    }
}

/// A rectangle of samples (or splat texels): `[x0, x0+w) × [z0, z0+h)`.
#[derive(Reflect, Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SampleRect {
    pub x0: u32,
    pub z0: u32,
    pub w: u32,
    pub h: u32,
}

impl SampleRect {
    pub fn new(x0: u32, z0: u32, w: u32, h: u32) -> Self {
        SampleRect { x0, z0, w, h }
    }
    pub fn len(&self) -> usize {
        self.w as usize * self.h as usize
    }
    pub fn is_empty(&self) -> bool {
        self.w == 0 || self.h == 0
    }
    pub fn x1(&self) -> u32 {
        self.x0 + self.w
    }
    pub fn z1(&self) -> u32 {
        self.z0 + self.h
    }
    pub fn union(&self, o: &SampleRect) -> SampleRect {
        if self.is_empty() {
            return *o;
        }
        if o.is_empty() {
            return *self;
        }
        let (x0, z0) = (self.x0.min(o.x0), self.z0.min(o.z0));
        SampleRect { x0, z0, w: self.x1().max(o.x1()) - x0, h: self.z1().max(o.z1()) - z0 }
    }
    pub fn contains_rect(&self, o: &SampleRect) -> bool {
        o.x0 >= self.x0 && o.z0 >= self.z0 && o.x1() <= self.x1() && o.z1() <= self.z1()
    }
}

/// Samples within `radius` of `center` (absolute XZ), clipped to the grid. `None` if none.
pub fn dab_rect(hf: &Heightfield, center: Vec2, radius: f32) -> Option<SampleRect> {
    grid_rect(hf.origin(), hf.spacing(), 0.0, hf.nx(), hf.nz(), center - Vec2::splat(radius), center + Vec2::splat(radius))
}

/// Cells `[lo, hi]` (absolute XZ box) of a grid whose cell `i` sits at `origin + (i + offset) * step`.
fn grid_rect(origin: Vec2, step: f32, offset: f32, nx: u32, nz: u32, lo: Vec2, hi: Vec2) -> Option<SampleRect> {
    if !(lo.is_finite() && hi.is_finite()) || step <= 0.0 {
        return None;
    }
    let a = ((lo - origin) / step - Vec2::splat(offset)).ceil();
    let b = ((hi - origin) / step - Vec2::splat(offset)).floor();
    let (x0, z0) = (a.x.max(0.0), a.y.max(0.0));
    let (x1, z1) = (b.x.min(nx as f32 - 1.0), b.y.min(nz as f32 - 1.0));
    if x1 < x0 || z1 < z0 {
        return None;
    }
    Some(SampleRect { x0: x0 as u32, z0: z0 as u32, w: (x1 - x0) as u32 + 1, h: (z1 - z0) as u32 + 1 })
}

/// New heights for a single dab at `center` (absolute XZ): writes `rect.w * rect.h` values into
/// `out` (row-major) and returns the rectangle. Samples outside the radius keep their height.
/// `target` is the Flatten height (resolve `pick_target` before calling). Raise / Lower / Smooth /
/// Flatten / Noise only; Ramp has [`ramp_heights`], Paint has [`paint_texels`].
pub fn dab_heights(hf: &Heightfield, center: Vec2, s: &BrushSettings, target: f32, out: &mut Vec<f32>) -> Option<SampleRect> {
    let r = s.radius.max(0.0);
    let rect = dab_rect(hf, center, r)?;
    out.clear();
    out.reserve(rect.len());
    let inv_r = if r > 0.0 { 1.0 / r } else { 0.0 };
    let noise = (s.kind == BrushKind::Noise).then(|| Fbm { seed: s.noise_seed as u64 ^ 0x007e_44a1, frequency: 1.0 / s.noise_scale.max(0.01), octaves: 3, ..Fbm::default() });
    let strength = s.strength;
    for iz in rect.z0..rect.z1() {
        for ix in rect.x0..rect.x1() {
            let p = hf.sample_pos(ix, iz);
            let h = hf.get(ix as i64, iz as i64);
            let w = s.falloff.weight(p.distance(center) * inv_r);
            let v = if w <= 0.0 {
                h
            } else {
                match s.kind {
                    BrushKind::Raise => h + strength * w,
                    BrushKind::Lower => h - strength * w,
                    BrushKind::Flatten => h + (target - h) * (strength * w).clamp(0.0, 1.0),
                    BrushKind::Smooth => {
                        let b = blur3(hf, ix as i64, iz as i64, s.smooth_kernel);
                        h + (b - h) * (strength * w).clamp(0.0, 1.0)
                    }
                    BrushKind::Noise => h + strength * w * noise.as_ref().map_or(0.0, |n| n.sample(p)),
                    BrushKind::Ramp | BrushKind::Paint => h,
                }
            };
            out.push(if v.is_finite() { v.clamp(-HEIGHT_LIMIT, HEIGHT_LIMIT) } else { h });
        }
    }
    Some(rect)
}

#[inline]
fn blur3(hf: &Heightfield, ix: i64, iz: i64, k: SmoothKernel) -> f32 {
    let mut sum = 0.0;
    let mut wsum = 0.0;
    for dz in -1..=1i64 {
        for dx in -1..=1i64 {
            let w = match k {
                SmoothKernel::Box => 1.0,
                SmoothKernel::Gaussian => (2 - dx.abs()) as f32 * (2 - dz.abs()) as f32,
            };
            sum += hf.get(ix + dx, iz + dz) * w;
            wsum += w;
        }
    }
    sum / wsum
}

/// New heights for a ramp from `a` (height `ha`) to `b` (height `hb`): samples within `radius`
/// of the segment move toward the linear grade between the ends, weighted by falloff and
/// `strength` (use 1 for a hard grade). Same output convention as [`dab_heights`].
pub fn ramp_heights(hf: &Heightfield, a: Vec2, ha: f32, b: Vec2, hb: f32, s: &BrushSettings, out: &mut Vec<f32>) -> Option<SampleRect> {
    let r = s.radius.max(0.0);
    let rect = grid_rect(hf.origin(), hf.spacing(), 0.0, hf.nx(), hf.nz(), a.min(b) - Vec2::splat(r), a.max(b) + Vec2::splat(r))?;
    out.clear();
    out.reserve(rect.len());
    let ab = b - a;
    let len2 = ab.length_squared();
    let inv_r = if r > 0.0 { 1.0 / r } else { 0.0 };
    for iz in rect.z0..rect.z1() {
        for ix in rect.x0..rect.x1() {
            let p = hf.sample_pos(ix, iz);
            let h = hf.get(ix as i64, iz as i64);
            let t = if len2 > 1e-8 { ((p - a).dot(ab) / len2).clamp(0.0, 1.0) } else { 0.0 };
            let w = s.falloff.weight(p.distance(a + ab * t) * inv_r) * s.strength;
            let want = ha + (hb - ha) * t;
            let v = h + (want - h) * w.clamp(0.0, 1.0);
            out.push(if v.is_finite() { v.clamp(-HEIGHT_LIMIT, HEIGHT_LIMIT) } else { h });
        }
    }
    Some(rect)
}

/// Texels of an `res × res` splat map (covering `origin .. origin + size`) within `radius` of
/// `center`. Texel `i` is centred at `origin + (i + 0.5) / res * size`.
pub fn splat_rect(res: u32, origin: Vec2, size: Vec2, center: Vec2, radius: f32) -> Option<SampleRect> {
    if res == 0 || size.x <= 0.0 || size.y <= 0.0 {
        return None;
    }
    let (lo, hi) = (center - Vec2::splat(radius), center + Vec2::splat(radius));
    let a = ((lo - origin) / size * res as f32 - Vec2::splat(0.5)).ceil();
    let b = ((hi - origin) / size * res as f32 - Vec2::splat(0.5)).floor();
    if !(a.is_finite() && b.is_finite()) {
        return None;
    }
    let (x0, z0) = (a.x.max(0.0), a.y.max(0.0));
    let (x1, z1) = (b.x.min(res as f32 - 1.0), b.y.min(res as f32 - 1.0));
    if x1 < x0 || z1 < z0 {
        return None;
    }
    Some(SampleRect { x0: x0 as u32, z0: z0 as u32, w: (x1 - x0) as u32 + 1, h: (z1 - z0) as u32 + 1 })
}

/// Paints layer `s.layer` into `texels` (RGBA8, `res × res`, in place) inside `rect`. Each
/// texel moves toward the layer by `strength · falloff`; the other weights shrink so the four
/// still sum to 255.
pub fn paint_texels(texels: &mut [u8], res: u32, rect: SampleRect, origin: Vec2, size: Vec2, center: Vec2, s: &BrushSettings) {
    let layer = (s.layer as usize).min(3);
    let r = s.radius.max(0.0);
    let inv_r = if r > 0.0 { 1.0 / r } else { 0.0 };
    for tz in rect.z0..rect.z1() {
        for tx in rect.x0..rect.x1() {
            let i = (tz as usize * res as usize + tx as usize) * 4;
            let Some(px) = texels.get_mut(i..i + 4) else { continue };
            let p = origin + (Vec2::new(tx as f32, tz as f32) + Vec2::splat(0.5)) / res as f32 * size;
            let a = (s.falloff.weight(p.distance(center) * inv_r) * s.strength).clamp(0.0, 1.0);
            if a <= 0.0 {
                continue;
            }
            let mut w = [0.0f32; 4];
            for (k, v) in w.iter_mut().enumerate() {
                *v = px[k] as f32 / 255.0 * (1.0 - a) + if k == layer { a } else { 0.0 };
            }
            let sum: f32 = w.iter().sum();
            let mut q = w.map(|v| (v / sum * 255.0).round() as i32);
            // Rounding can leave the total off by a few; put the difference on the largest weight.
            let diff = 255 - q.iter().sum::<i32>();
            let big = (0..4).max_by_key(|k| q[*k]).unwrap_or(0);
            q[big] = (q[big] + diff).clamp(0, 255);
            for k in 0..4 {
                px[k] = q[k] as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat() -> Heightfield {
        Heightfield::flat(101, 101, 2.0, Vec2::ZERO, 10.0)
    }

    fn apply(hf: &mut Heightfield, rect: SampleRect, v: &[f32]) {
        hf.patch(rect.x0, rect.z0, rect.w, rect.h, v);
    }

    #[test]
    fn falloff_shapes() {
        for f in [Falloff::Smooth, Falloff::Linear, Falloff::Constant] {
            assert_eq!(f.weight(1.0), 0.0);
            assert_eq!(f.weight(2.0), 0.0);
            assert!((f.weight(0.0) - 1.0).abs() < 1e-6);
        }
        assert_eq!(Falloff::Linear.weight(0.25), 0.75);
        assert_eq!(Falloff::Constant.weight(0.99), 1.0);
        assert!((Falloff::Smooth.weight(0.5) - 0.5).abs() < 1e-6);
        assert!(Falloff::Smooth.weight(0.9) < Falloff::Linear.weight(0.9));
    }

    #[test]
    fn raise_lower_peak_at_centre_and_stay_inside_radius() {
        let mut hf = flat();
        let s = BrushSettings { kind: BrushKind::Raise, radius: 20.0, strength: 3.0, ..default_s() };
        let mut out = Vec::new();
        let c = Vec2::new(100.0, 100.0);
        let rect = dab_heights(&hf, c, &s, 0.0, &mut out).unwrap();
        assert_eq!(out.len(), rect.len());
        apply(&mut hf, rect, &out);
        assert!((hf.get(50, 50) - 13.0).abs() < 1e-5);
        assert!(hf.get(50, 50) > hf.get(55, 50) && hf.get(55, 50) > hf.get(59, 50));
        assert_eq!(hf.get(60, 50), 10.0, "radius edge untouched");
        assert_eq!(hf.get(10, 10), 10.0);
        assert!(hf.get(50, 50) <= hf.max_height());
        let s = BrushSettings { kind: BrushKind::Lower, ..s };
        let rect = dab_heights(&hf, c, &s, 0.0, &mut out).unwrap();
        apply(&mut hf, rect, &out);
        assert!((hf.get(50, 50) - 10.0).abs() < 1e-5, "raise then lower cancels at the centre");
    }

    fn default_s() -> BrushSettings {
        BrushSettings::default()
    }

    #[test]
    fn rect_is_clipped_to_the_grid_and_empty_off_grid() {
        let hf = flat();
        let r = dab_rect(&hf, Vec2::new(0.0, 0.0), 10.0).unwrap();
        assert_eq!((r.x0, r.z0, r.w, r.h), (0, 0, 6, 6));
        assert!(dab_rect(&hf, Vec2::new(-100.0, 0.0), 10.0).is_none());
        assert!(dab_rect(&hf, Vec2::new(f32::NAN, 0.0), 10.0).is_none());
        let r = dab_rect(&hf, Vec2::new(200.0, 200.0), 1000.0).unwrap();
        assert_eq!((r.w, r.h), (101, 101));
    }

    #[test]
    fn flatten_converges_to_target() {
        let mut hf = Heightfield::from_fn(101, 101, 2.0, Vec2::ZERO, |x, z| 10.0 + (x * 0.3).sin() * 5.0 + z * 0.05);
        let s = BrushSettings { kind: BrushKind::Flatten, radius: 30.0, strength: 1.0, falloff: Falloff::Constant, ..default_s() };
        let mut out = Vec::new();
        let rect = dab_heights(&hf, Vec2::new(100.0, 100.0), &s, 25.0, &mut out).unwrap();
        apply(&mut hf, rect, &out);
        assert_eq!(hf.get(50, 50), 25.0);
        assert_eq!(hf.get(60, 50), 25.0, "constant falloff flattens right to the radius");
        assert_ne!(hf.get(90, 50), 25.0);
    }

    #[test]
    fn smooth_reduces_roughness_and_keeps_the_mean() {
        let mut hf = Heightfield::from_fn(101, 101, 2.0, Vec2::ZERO, |x, z| 10.0 + if ((x / 2.0) as i32 + (z / 2.0) as i32) % 2 == 0 { 3.0 } else { -3.0 });
        let rough = |hf: &Heightfield| (40..60).flat_map(|z| (40..60).map(move |x| (x, z))).map(|(x, z)| (hf.get(x, z) - hf.get(x + 1, z)).abs()).sum::<f32>();
        let before = rough(&hf);
        let mut out = Vec::new();
        for k in [SmoothKernel::Box, SmoothKernel::Gaussian] {
            let mut h2 = hf.clone();
            let s = BrushSettings { kind: BrushKind::Smooth, radius: 40.0, strength: 1.0, smooth_kernel: k, falloff: Falloff::Constant, ..default_s() };
            let rect = dab_heights(&h2, Vec2::new(100.0, 100.0), &s, 0.0, &mut out).unwrap();
            apply(&mut h2, rect, &out);
            assert!(rough(&h2) < before * 0.5, "{k:?}: {} vs {before}", rough(&h2));
        }
        // Weak smoothing moves less than strong.
        let weak = BrushSettings { kind: BrushKind::Smooth, radius: 40.0, strength: 0.2, ..default_s() };
        let rect = dab_heights(&hf, Vec2::new(100.0, 100.0), &weak, 0.0, &mut out).unwrap();
        apply(&mut hf, rect, &out);
        assert!(rough(&hf) < before && rough(&hf) > before * 0.5);
    }

    #[test]
    fn noise_is_deterministic_and_zero_mean_ish() {
        let hf = flat();
        let s = BrushSettings { kind: BrushKind::Noise, radius: 60.0, strength: 4.0, noise_scale: 15.0, ..default_s() };
        let (mut a, mut b) = (Vec::new(), Vec::new());
        dab_heights(&hf, Vec2::new(100.0, 100.0), &s, 0.0, &mut a).unwrap();
        dab_heights(&hf, Vec2::new(100.0, 100.0), &s, 0.0, &mut b).unwrap();
        assert_eq!(a, b);
        let other = BrushSettings { noise_seed: 9, ..s };
        dab_heights(&hf, Vec2::new(100.0, 100.0), &other, 0.0, &mut b).unwrap();
        assert_ne!(a, b);
        assert!(a.iter().any(|v| *v > 10.1) && a.iter().any(|v| *v < 9.9));
        assert!(a.iter().all(|v| (*v - 10.0).abs() <= 4.5));
    }

    #[test]
    fn ramp_grades_between_two_points() {
        let mut hf = Heightfield::from_fn(101, 101, 2.0, Vec2::ZERO, |x, z| 10.0 + (x * 0.4).sin() * 4.0 + (z * 0.3).cos() * 3.0);
        let s = BrushSettings { kind: BrushKind::Ramp, radius: 8.0, strength: 1.0, falloff: Falloff::Constant, ..default_s() };
        let (a, b) = (Vec2::new(40.0, 100.0), Vec2::new(160.0, 100.0));
        let mut out = Vec::new();
        let rect = ramp_heights(&hf, a, 5.0, b, 35.0, &s, &mut out).unwrap();
        apply(&mut hf, rect, &out);
        // Along the centre line: linear from 5 to 35.
        for ix in 20..=80 {
            let t = (ix as f32 * 2.0 - 40.0) / 120.0;
            assert!((hf.get(ix, 50) - (5.0 + 30.0 * t)).abs() < 1e-3, "ix {ix}");
        }
        assert_eq!(hf.get(50, 70), Heightfield::from_fn(101, 101, 2.0, Vec2::ZERO, |x, z| 10.0 + (x * 0.4).sin() * 4.0 + (z * 0.3).cos() * 3.0).get(50, 70), "outside the strip untouched");
        // Degenerate (a == b) flattens to ha without NaN.
        let rect = ramp_heights(&hf, a, 7.0, a, 99.0, &s, &mut out).unwrap();
        assert!(out.iter().all(|v| v.is_finite()) && rect.len() == out.len());
    }

    #[test]
    fn non_finite_and_huge_values_are_contained() {
        let hf = flat();
        let s = BrushSettings { strength: f32::INFINITY, radius: 10.0, ..default_s() };
        let mut out = Vec::new();
        dab_heights(&hf, Vec2::new(100.0, 100.0), &s, 0.0, &mut out).unwrap();
        assert!(out.iter().all(|v| v.is_finite() && v.abs() <= HEIGHT_LIMIT));
        let s = BrushSettings { kind: BrushKind::Flatten, strength: f32::NAN, ..s };
        dab_heights(&hf, Vec2::new(100.0, 100.0), &s, f32::NAN, &mut out).unwrap();
        assert!(out.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn paint_renormalises_and_only_touches_the_radius() {
        let res = 64u32;
        let (origin, size) = (Vec2::ZERO, Vec2::splat(128.0));
        let mut tex: Vec<u8> = (0..res * res).flat_map(|_| [255u8, 0, 0, 0]).collect();
        let s = BrushSettings { kind: BrushKind::Paint, layer: 2, radius: 20.0, strength: 0.6, falloff: Falloff::Linear, ..default_s() };
        let c = Vec2::new(64.0, 64.0);
        let rect = splat_rect(res, origin, size, c, s.radius).unwrap();
        paint_texels(&mut tex, res, rect, origin, size, c, &s);
        fn px(tex: &[u8], x: usize, z: usize) -> &[u8] {
            &tex[(z * 64 + x) * 4..(z * 64 + x) * 4 + 4]
        }
        assert!(px(&tex, 32, 32)[2] > 130 && px(&tex, 32, 32)[0] < 125, "{:?}", px(&tex, 32, 32));
        assert_eq!(px(&tex, 5, 5), &[255, 0, 0, 0]);
        assert!(tex.chunks(4).all(|t| t.iter().map(|v| *v as u32).sum::<u32>() == 255));
        // Painting again saturates toward the layer.
        for _ in 0..12 {
            paint_texels(&mut tex, res, rect, origin, size, c, &BrushSettings { falloff: Falloff::Constant, strength: 0.5, ..s.clone() });
        }
        assert!(px(&tex, 32, 32)[2] >= 254);
        assert!(tex.chunks(4).all(|t| t.iter().map(|v| *v as u32).sum::<u32>() == 255));
        assert!(splat_rect(res, origin, size, Vec2::new(-500.0, 0.0), 10.0).is_none());
        assert!(splat_rect(0, origin, size, c, 10.0).is_none());
    }

    #[test]
    fn rect_union_and_contains() {
        let a = SampleRect::new(2, 3, 4, 5);
        let b = SampleRect::new(10, 1, 2, 2);
        let u = a.union(&b);
        assert_eq!(u, SampleRect::new(2, 1, 10, 7));
        assert!(u.contains_rect(&a) && u.contains_rect(&b) && !a.contains_rect(&b));
        assert_eq!(SampleRect::default().union(&a), a);
    }
}
