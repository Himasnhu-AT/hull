//! Procedural sky cubemaps (code-first environment maps: no HDRI files needed).
//!
//! [`fill_sky_cubemap`] writes a gradient sky (zenith / horizon / ground, a sun halo and an
//! optional star field) into an `Rgba16Float` cube image; the look uses it as `Skybox` and as
//! the source of a `GeneratedEnvironmentMapLight` (filtered on the GPU). Values are relative
//! (≈ 0..1), scaled by `SkyLook::brightness` through the skybox brightness / env intensity.

use bevy::asset::RenderAssetUsages;
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat, TextureViewDescriptor, TextureViewDimension};

/// Inputs of a gradient sky, linear RGB.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SkyGradient {
    pub zenith: Vec3,
    pub horizon: Vec3,
    pub ground: Vec3,
    /// Unit vector towards the sun.
    pub to_sun: Vec3,
    pub sun_color: Vec3,
    pub sun_glow: f32,
    pub stars: f32,
}

/// An empty `size`² × 6 `Rgba16Float` cube image (size must be a power of two).
pub fn new_cubemap(size: u32) -> Image {
    let size = size.max(4).next_power_of_two();
    let mut img = Image::new_fill(
        Extent3d { width: size, height: size, depth_or_array_layers: 6 },
        TextureDimension::D2,
        &[0; 8],
        TextureFormat::Rgba16Float,
        RenderAssetUsages::default(),
    );
    img.texture_view_descriptor = Some(TextureViewDescriptor { dimension: Some(TextureViewDimension::Cube), ..default() });
    img
}

/// World-space direction of cube texel (`face`, `x`, `y`) of a `size` cube (Bevy samples cubes
/// with z negated: they are left-handed).
pub fn cube_texel_dir(face: usize, x: u32, y: u32, size: u32) -> Vec3 {
    let u = 2.0 * (x as f32 + 0.5) / size as f32 - 1.0;
    let v = 2.0 * (y as f32 + 0.5) / size as f32 - 1.0;
    let c = match face {
        0 => Vec3::new(1.0, -v, -u),
        1 => Vec3::new(-1.0, -v, u),
        2 => Vec3::new(u, 1.0, v),
        3 => Vec3::new(u, -1.0, -v),
        4 => Vec3::new(u, -v, 1.0),
        _ => Vec3::new(-u, -v, -1.0),
    };
    Vec3::new(c.x, c.y, -c.z).normalize()
}

/// Sky radiance (relative) in world direction `d`.
pub fn sky_radiance(g: &SkyGradient, d: Vec3) -> Vec3 {
    let y = d.y;
    let base = if y >= 0.0 {
        // Thin bright band at the horizon, deepening towards the zenith.
        g.horizon.lerp(g.zenith, y.powf(0.45))
    } else {
        g.horizon.lerp(g.ground, (-y * 6.0).min(1.0).powf(0.6))
    };
    let mut c = base;
    if g.sun_glow > 0.0 {
        let cos = d.dot(g.to_sun).max(0.0);
        // Wide halo + corona (the disk itself is the light's job); dimmed below the horizon.
        let halo = cos.powi(8) * 0.25 + cos.powi(64) * 0.8 + cos.powi(512) * 1.5;
        let horizon_fade = (y * 4.0 + 1.0).clamp(0.0, 1.0);
        c += g.sun_color * (halo * g.sun_glow * horizon_fade);
    }
    c
}

/// Star brightness for one texel (deterministic hash, ~0.6 % of upper-hemisphere texels).
fn star(face: usize, x: u32, y: u32, d: Vec3) -> f32 {
    if d.y < 0.05 {
        return 0.0;
    }
    let mut h = (face as u32).wrapping_mul(0x9E37_79B9) ^ x.wrapping_mul(0x85EB_CA6B) ^ y.wrapping_mul(0xC2B2_AE35);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    let r = (h & 0xFFFF) as f32 / 65535.0;
    if r > 0.004 {
        return 0.0;
    }
    let mag = ((h >> 16) & 0xFF) as f32 / 255.0;
    // Mostly faint, a few bright ones.
    (0.15 + 3.0 * mag.powi(4)) * (d.y * 3.0).min(1.0)
}

/// Fills `img` (from [`new_cubemap`]) with the gradient sky. No allocation when the image
/// already has its pixel buffer.
pub fn fill_sky_cubemap(img: &mut Image, g: &SkyGradient) {
    let size = img.texture_descriptor.size.width;
    if let Some(data) = img.data.as_mut() {
        fill_sky_data(data, size, g);
    }
}

/// [`fill_sky_cubemap`] on raw `Rgba16Float` cube bytes (`size`² × 6 × 8; ignored otherwise).
pub fn fill_sky_data(data: &mut [u8], size: u32, g: &SkyGradient) {
    let texels = (size * size) as usize;
    if data.len() != texels * 6 * 8 {
        return;
    }
    let star_color = Vec3::new(0.8, 0.85, 1.0) * g.stars;
    for face in 0..6 {
        for y in 0..size {
            for x in 0..size {
                let d = cube_texel_dir(face, x, y, size);
                let mut c = sky_radiance(g, d);
                if g.stars > 0.0 {
                    c += star_color * star(face, x, y, d);
                }
                let i = (face * texels + (y * size + x) as usize) * 8;
                for (k, v) in [c.x, c.y, c.z, 1.0].into_iter().enumerate() {
                    data[i + k * 2..i + k * 2 + 2].copy_from_slice(&f16_bits(v).to_le_bytes());
                }
            }
        }
    }
}

/// f32 → IEEE half bits (round to nearest, clamps to ±65504, NaN → max).
pub fn f16_bits(x: f32) -> u16 {
    let sign = ((x.to_bits() >> 16) & 0x8000) as u16;
    let a = x.abs();
    if a.is_nan() || a >= 65504.0 {
        return sign | 0x7BFF;
    }
    if a < 6.103_515_6e-5 {
        return sign | (a / 5.960_464_5e-8).round() as u16;
    }
    let b = a.to_bits();
    let e = ((b >> 23) & 0xFF) as i32 - 127 + 15;
    let m = b & 0x7F_FFFF;
    let mut h = ((e as u32) << 10) | (m >> 13);
    if m & 0x1000 != 0 {
        h += 1;
    }
    sign | h as u16
}

/// IEEE half bits → f32 (tests, readbacks).
pub fn f16_to_f32(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let e = ((h >> 10) & 0x1F) as i32;
    let m = (h & 0x3FF) as f32;
    sign * match e {
        0 => m * 5.960_464_5e-8,
        31 => f32::INFINITY,
        _ => (1.0 + m / 1024.0) * 2f32.powi(e - 15),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_round_trip() {
        for v in [0.0, 1.0, 0.5, 0.18, 3.75, 1000.0, 1e-5, 65000.0] {
            let r = f16_to_f32(f16_bits(v));
            assert!((r - v).abs() <= v.abs() * 1e-3 + 1e-7, "{v} -> {r}");
        }
        assert_eq!(f16_bits(1.0), 0x3C00);
        assert_eq!(f16_bits(-2.0), 0xC000);
    }

    #[test]
    fn cube_faces_point_the_right_way() {
        // Face centres: +X, -X, +Y, -Y, then +Z / -Z swapped by the left-handed z flip.
        let n = 8;
        let c = |f| cube_texel_dir(f, n / 2, n / 2, n);
        assert!(c(0).x > 0.9 && c(1).x < -0.9 && c(2).y > 0.9 && c(3).y < -0.9);
        assert!(c(4).z < -0.9 && c(5).z > 0.9);
    }

    #[test]
    fn gradient_is_bright_up_dark_down_and_glows_at_sun() {
        let g = SkyGradient {
            zenith: Vec3::new(0.2, 0.4, 0.9),
            horizon: Vec3::splat(0.8),
            ground: Vec3::splat(0.1),
            to_sun: Vec3::new(0.0, 0.5, -0.866).normalize(),
            sun_color: Vec3::ONE,
            sun_glow: 1.0,
            stars: 0.0,
        };
        let up = sky_radiance(&g, Vec3::Y);
        let down = sky_radiance(&g, Vec3::NEG_Y);
        assert!(up.z > up.x && down.length() < 0.2);
        assert!(sky_radiance(&g, g.to_sun).x > 2.0);
        let mut img = new_cubemap(16);
        fill_sky_cubemap(&mut img, &g);
        let data = img.data.as_ref().unwrap();
        // +Y face centre ≈ zenith blue.
        let i = (2 * 16 * 16 + 8 * 16 + 8) * 8;
        let b = f16_to_f32(u16::from_le_bytes([data[i + 4], data[i + 5]]));
        assert!(b > 0.5, "zenith blue {b}");
    }
}
