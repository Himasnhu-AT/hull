//! Tiny deterministic RNG (SplitMix64). Same seed → same particles on every run, no crate.

use bevy::math::{Quat, Vec3, Vec3A};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed ^ 0x6A09_E667_F3BC_C908)
    }

    /// Derives an independent stream (per emitter, per instance …).
    pub fn fork(seed: u64, stream: u64) -> Self {
        let mut r = Rng::new(seed.wrapping_add(stream.wrapping_mul(0x9E37_79B9_7F4A_7C15)));
        r.next_u64();
        r
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        (self.next_u64() >> 32) as u32
    }

    /// Uniform in `[0, 1)`.
    #[inline]
    pub fn f01(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }

    /// Uniform in `[a, b)` (`a == b` → `a`).
    #[inline]
    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f01()
    }

    /// Uniform on the unit sphere.
    #[inline]
    pub fn unit(&mut self) -> Vec3A {
        let z = self.range(-1.0, 1.0);
        let a = self.f01() * core::f32::consts::TAU;
        let r = (1.0 - z * z).max(0.0).sqrt();
        Vec3A::new(r * a.cos(), z, r * a.sin())
    }

    /// Uniform inside the unit ball.
    #[inline]
    pub fn in_ball(&mut self) -> Vec3A {
        self.unit() * self.f01().cbrt()
    }

    /// Uniform in the cube `[-1, 1]^3`.
    #[inline]
    pub fn in_cube(&mut self) -> Vec3A {
        Vec3A::new(self.range(-1.0, 1.0), self.range(-1.0, 1.0), self.range(-1.0, 1.0))
    }

    /// A direction within `angle` radians of +Y (uniform over the spherical cap).
    #[inline]
    pub fn in_cap(&mut self, angle: f32) -> Vec3A {
        let cos_max = angle.clamp(0.0, core::f32::consts::PI).cos();
        let z = self.range(cos_max, 1.0);
        let a = self.f01() * core::f32::consts::TAU;
        let r = (1.0 - z * z).max(0.0).sqrt();
        Vec3A::new(r * a.cos(), z, r * a.sin())
    }

    /// A direction within `angle` radians of `axis`.
    #[inline]
    pub fn in_cone(&mut self, axis: Vec3, angle: f32) -> Vec3A {
        let axis = axis.try_normalize().unwrap_or(Vec3::Y);
        Quat::from_rotation_arc(Vec3::Y, axis) * self.in_cap(angle)
    }
}

/// Cheap integer hash (per-particle variation derived from a stored seed).
#[inline]
pub fn hash32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7FEB_352D);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846C_A68B);
    x ^ (x >> 16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_in_range() {
        let (mut a, mut b) = (Rng::new(7), Rng::new(7));
        for _ in 0..1000 {
            let (x, y) = (a.f01(), b.f01());
            assert_eq!(x, y);
            assert!((0.0..1.0).contains(&x));
        }
        assert_ne!(Rng::fork(7, 1).next_u64(), Rng::fork(7, 2).next_u64());
        let mut r = Rng::new(3);
        for _ in 0..1000 {
            assert!((r.unit().length() - 1.0).abs() < 1e-4);
            assert!(r.in_ball().length() <= 1.0001);
            let d = r.in_cone(Vec3::X, 0.3);
            assert!(d.dot(Vec3A::X) >= 0.3f32.cos() - 1e-4);
        }
    }
}
