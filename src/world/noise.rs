//! Deterministic hashing and 2D gradient noise (no dependency, no global state). Same seed +
//! same inputs = same output on every platform, so worlds generated from data are reproducible
//! and testable.

use bevy::math::Vec2;
use serde::{Deserialize, Serialize};

/// SplitMix64 finaliser: a good 64-bit mix.
#[inline]
pub fn mix64(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Hash of a seed and two signed coordinates.
#[inline]
pub fn hash2(seed: u64, x: i32, z: i32) -> u64 {
    mix64(seed ^ mix64(((x as u32 as u64) << 32) | (z as u32 as u64)))
}

/// Small deterministic RNG (SplitMix64) for placement: cheap to create per cell.
#[derive(Clone, Debug)]
pub struct Rng64(u64);

impl Rng64 {
    pub fn new(seed: u64) -> Self {
        Rng64(seed)
    }
    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in `[0, 1)`.
    #[inline]
    pub fn f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 * (1.0 / (1u64 << 24) as f32)
    }
    /// Uniform in `[lo, hi)`.
    #[inline]
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.f32()
    }
}

#[inline]
fn grad(seed: u64, x: i32, z: i32) -> Vec2 {
    // 16 directions on the unit circle.
    let a = (hash2(seed, x, z) & 15) as f32 * (std::f32::consts::TAU / 16.0);
    Vec2::new(a.cos(), a.sin())
}

#[inline]
fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// 2D gradient (Perlin-style) noise in about `[-1, 1]`.
pub fn perlin(seed: u64, p: Vec2) -> f32 {
    let i = p.floor();
    let f = p - i;
    let (ix, iz) = (i.x as i32, i.y as i32);
    let d00 = grad(seed, ix, iz).dot(f);
    let d10 = grad(seed, ix + 1, iz).dot(f - Vec2::X);
    let d01 = grad(seed, ix, iz + 1).dot(f - Vec2::Y);
    let d11 = grad(seed, ix + 1, iz + 1).dot(f - Vec2::ONE);
    let (u, v) = (fade(f.x), fade(f.y));
    let a = d00 + u * (d10 - d00);
    let b = d01 + u * (d11 - d01);
    (a + v * (b - a)) * std::f32::consts::SQRT_2
}

/// Fractal noise settings (what terrain and scatter masks are made of).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Fbm {
    pub seed: u64,
    /// Base frequency in cycles per metre (0.001 = features ~1 km across).
    pub frequency: f32,
    pub octaves: u32,
    pub lacunarity: f32,
    pub gain: f32,
    /// 0 = smooth hills, 1 = sharp ridges (mountain crests).
    pub ridged: f32,
    /// Domain warp strength in metres (0 = off): bends features so they look less gridded.
    pub warp: f32,
}

impl Default for Fbm {
    fn default() -> Self {
        Fbm { seed: 1, frequency: 0.002, octaves: 5, lacunarity: 2.0, gain: 0.5, ridged: 0.0, warp: 0.0 }
    }
}

impl Fbm {
    /// Value in about `[-1, 1]` (ridged parts in `[-1, 1]` too).
    pub fn sample(&self, p: Vec2) -> f32 {
        let mut p = p;
        if self.warp != 0.0 {
            let q = p * (self.frequency * 0.5);
            p += Vec2::new(perlin(self.seed ^ 0xA5A5, q), perlin(self.seed ^ 0x5A5A, q + Vec2::splat(17.3))) * self.warp;
        }
        let mut f = self.frequency;
        let mut amp = 1.0;
        let mut sum = 0.0;
        let mut norm = 0.0;
        for o in 0..self.octaves.max(1) {
            let n = perlin(self.seed.wrapping_add(o as u64 * 1013), p * f);
            let v = if self.ridged > 0.0 {
                let r = 1.0 - 2.0 * n.abs(); // ridges at the zero crossings
                n + (r - n) * self.ridged
            } else {
                n
            };
            sum += v * amp;
            norm += amp;
            amp *= self.gain;
            f *= self.lacunarity;
        }
        sum / norm
    }

    /// `sample` mapped to `[0, 1]`.
    pub fn sample01(&self, p: Vec2) -> f32 {
        (self.sample(p) * 0.5 + 0.5).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_bounded() {
        let f = Fbm { octaves: 6, ridged: 0.5, warp: 30.0, ..default() };
        let mut lo = f32::MAX;
        let mut hi = f32::MIN;
        for i in 0..2000 {
            let p = Vec2::new(i as f32 * 3.7, i as f32 * -1.3);
            let a = f.sample(p);
            assert_eq!(a, f.sample(p));
            lo = lo.min(a);
            hi = hi.max(a);
        }
        assert!(lo >= -1.5 && hi <= 1.5 && hi - lo > 0.3, "{lo}..{hi}");
        let g = Fbm { seed: 2, ..f.clone() };
        assert_ne!(f.sample(Vec2::new(10.5, 3.3)), g.sample(Vec2::new(10.5, 3.3)));
    }

    #[test]
    fn rng_uniform() {
        let mut r = Rng64::new(7);
        let mean = (0..10_000).map(|_| r.f32()).sum::<f32>() / 10_000.0;
        assert!((mean - 0.5).abs() < 0.02);
        assert!((0..1000).all(|_| (0.0..1.0).contains(&r.f32())));
    }

    fn default<T: Default>() -> T {
        T::default()
    }
}
