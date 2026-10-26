//! Over-life curves and colour gradients as plain data, baked into small lookup tables when an
//! effect is registered, so the per-particle cost is one table read.

use bevy::color::LinearRgba;
use serde::{Deserialize, Serialize};

/// Lookup-table resolution for baked curves/gradients.
pub const LUT: usize = 64;

/// Piecewise-linear scalar curve over `t ∈ [0, 1]`: `(t, value)` keys, sorted by `t`.
/// Outside the keys the end values hold. No keys = `1.0`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Curve(pub Vec<(f32, f32)>);

impl Default for Curve {
    fn default() -> Self {
        Curve::constant(1.0)
    }
}

impl Curve {
    pub fn constant(v: f32) -> Self {
        Curve(vec![(0.0, v)])
    }
    pub fn linear(from: f32, to: f32) -> Self {
        Curve(vec![(0.0, from), (1.0, to)])
    }
    pub fn keys(keys: &[(f32, f32)]) -> Self {
        let mut k = keys.to_vec();
        k.sort_by(|a, b| a.0.total_cmp(&b.0));
        Curve(k)
    }

    pub fn sample(&self, t: f32) -> f32 {
        sample_keys(&self.0, t, 1.0, |a, b, f| a + (b - a) * f)
    }

    pub fn bake(&self) -> [f32; LUT] {
        core::array::from_fn(|i| self.sample(i as f32 / (LUT - 1) as f32))
    }
}

/// Piecewise-linear colour gradient over `t ∈ [0, 1]` in **linear** RGBA (alpha = opacity).
/// No keys = white.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Gradient(pub Vec<(f32, [f32; 4])>);

impl Default for Gradient {
    fn default() -> Self {
        Gradient::constant([1.0; 4])
    }
}

impl Gradient {
    pub fn constant(c: [f32; 4]) -> Self {
        Gradient(vec![(0.0, c)])
    }
    pub fn linear(from: [f32; 4], to: [f32; 4]) -> Self {
        Gradient(vec![(0.0, from), (1.0, to)])
    }
    pub fn keys(keys: &[(f32, [f32; 4])]) -> Self {
        let mut k = keys.to_vec();
        k.sort_by(|a, b| a.0.total_cmp(&b.0));
        Gradient(k)
    }
    /// Keys from sRGB colours (what colour pickers show) + alpha.
    pub fn srgb(keys: &[(f32, [f32; 3], f32)]) -> Self {
        Gradient::keys(
            &keys
                .iter()
                .map(|(t, c, a)| {
                    let l = LinearRgba::from(bevy::color::Srgba::new(c[0], c[1], c[2], *a));
                    (*t, [l.red, l.green, l.blue, l.alpha])
                })
                .collect::<Vec<_>>(),
        )
    }

    pub fn sample(&self, t: f32) -> [f32; 4] {
        sample_keys(&self.0, t, [1.0; 4], |a, b, f| core::array::from_fn(|i| a[i] + (b[i] - a[i]) * f))
    }

    pub fn bake(&self) -> [[f32; 4]; LUT] {
        core::array::from_fn(|i| self.sample(i as f32 / (LUT - 1) as f32))
    }
}

fn sample_keys<T: Copy>(keys: &[(f32, T)], t: f32, empty: T, lerp: impl Fn(T, T, f32) -> T) -> T {
    let Some(first) = keys.first() else { return empty };
    if t <= first.0 {
        return first.1;
    }
    for w in keys.windows(2) {
        let (a, b) = (w[0], w[1]);
        if t <= b.0 {
            let span = b.0 - a.0;
            let f = if span > 0.0 { (t - a.0) / span } else { 1.0 };
            return lerp(a.1, b.1, f);
        }
    }
    keys[keys.len() - 1].1
}

/// LUT index for a normalized age.
#[inline]
pub fn lut_index(t: f32) -> usize {
    ((t * (LUT - 1) as f32 + 0.5) as usize).min(LUT - 1)
}

/// Linear `[0,1]` → sRGB byte, through a 4096-entry table (no `powf` per particle).
pub struct SrgbEncoder(Box<[u8; 4096]>);

impl Default for SrgbEncoder {
    fn default() -> Self {
        let mut t = Box::new([0u8; 4096]);
        for (i, v) in t.iter_mut().enumerate() {
            let l = i as f32 / 4095.0;
            let s = if l <= 0.003_130_8 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 };
            *v = (s * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
        }
        SrgbEncoder(t)
    }
}

impl SrgbEncoder {
    #[inline]
    pub fn encode(&self, l: f32) -> u8 {
        self.0[((l.clamp(0.0, 1.0) * 4095.0) as usize).min(4095)]
    }
    #[inline]
    pub fn rgba(&self, c: [f32; 4]) -> [u8; 4] {
        [self.encode(c[0]), self.encode(c[1]), self.encode(c[2]), (c[3].clamp(0.0, 1.0) * 255.0 + 0.5) as u8]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curves_interpolate_and_clamp() {
        let c = Curve::keys(&[(0.0, 0.0), (0.5, 2.0), (1.0, 1.0)]);
        assert_eq!(c.sample(-1.0), 0.0);
        assert_eq!(c.sample(0.25), 1.0);
        assert_eq!(c.sample(0.75), 1.5);
        assert_eq!(c.sample(2.0), 1.0);
        let lut = c.bake();
        assert_eq!(lut[0], 0.0);
        assert_eq!(lut[LUT - 1], 1.0);
        assert_eq!(Curve(vec![]).sample(0.3), 1.0);
        let g = Gradient::linear([0.0; 4], [1.0; 4]);
        assert_eq!(g.sample(0.5), [0.5; 4]);
        let e = SrgbEncoder::default();
        assert_eq!(e.encode(0.0), 0);
        assert_eq!(e.encode(1.0), 255);
        assert!((e.encode(0.214) as i32 - 128).abs() <= 1, "{}", e.encode(0.214));
    }
}
