//! Procedural particle textures (no image files): white shapes in alpha, generated once at
//! startup (~ms) with mip chains. The smoke texture is a 4×4 flipbook of an evolving noise puff.

use bevy::asset::RenderAssetUsages;
use bevy::image::{ImageSampler, ImageSamplerDescriptor};
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};

use super::def::VfxTexture;
use super::rng::hash32;

/// Handles of the built-in textures.
#[derive(Resource, Clone, Debug)]
pub struct VfxTextures {
    pub dot: Handle<Image>,
    pub spark: Handle<Image>,
    pub smoke: Handle<Image>,
    pub flare: Handle<Image>,
    pub ring: Handle<Image>,
    pub white: Handle<Image>,
}

impl VfxTextures {
    pub fn get(&self, t: VfxTexture) -> Handle<Image> {
        match t {
            VfxTexture::Dot => self.dot.clone(),
            VfxTexture::Spark => self.spark.clone(),
            VfxTexture::Smoke => self.smoke.clone(),
            VfxTexture::Flare => self.flare.clone(),
            VfxTexture::Ring => self.ring.clone(),
            VfxTexture::White => self.white.clone(),
        }
    }

    pub fn generate(images: &mut Assets<Image>) -> Self {
        VfxTextures {
            dot: images.add(image(64, 64, |x, y| {
                let r2 = x * x + y * y;
                let a = (1.0 - r2).max(0.0);
                [1.0, 1.0, 1.0, a * a]
            })),
            spark: images.add(image(64, 64, |x, y| {
                let r = (x * x + y * y).sqrt();
                let a = ((-r * 7.0).exp() + 0.35 * (-r * 2.5).exp()) * (1.0 - r).clamp(0.0, 1.0);
                [1.0, 1.0, 1.0, a.min(1.0)]
            })),
            flare: images.add(image(128, 128, |x, y| {
                let r = (x * x + y * y).sqrt();
                let edge = (1.0 - r).clamp(0.0, 1.0);
                let rays = (-x.abs() * 40.0).exp() + (-y.abs() * 40.0).exp();
                let (u, v) = ((x + y) * core::f32::consts::FRAC_1_SQRT_2, (x - y) * core::f32::consts::FRAC_1_SQRT_2);
                let diag = 0.5 * ((-u.abs() * 60.0).exp() + (-v.abs() * 60.0).exp());
                let a = (-r * 6.0).exp() * 1.2 + (rays + diag) * (-r * 2.2).exp() * 0.8;
                [1.0, 1.0, 1.0, (a * edge).min(1.0)]
            })),
            ring: images.add(image(128, 128, |x, y| {
                let r = (x * x + y * y).sqrt();
                let d = (r - 0.82) / 0.07;
                let a = (-d * d).exp() + 0.12 * (r / 0.82).powi(4) * (r < 0.82) as u8 as f32;
                [1.0, 1.0, 1.0, a.min(1.0)]
            })),
            smoke: images.add(smoke_atlas(4, 128)),
            white: images.add(image(4, 4, |_, _| [1.0; 4])),
        }
    }
}

/// An RGBA8 image from `f(x, y)` with `x, y ∈ [-1, 1]` (pixel centres), plus mips.
fn image(w: u32, h: u32, f: impl Fn(f32, f32) -> [f32; 4]) -> Image {
    let mut data = Vec::with_capacity((w * h * 4) as usize);
    for j in 0..h {
        for i in 0..w {
            let x = (i as f32 + 0.5) / w as f32 * 2.0 - 1.0;
            let y = (j as f32 + 0.5) / h as f32 * 2.0 - 1.0;
            for c in f(x, y) {
                data.push((c.clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
            }
        }
    }
    finish(w, h, data)
}

fn finish(w: u32, h: u32, data: Vec<u8>) -> Image {
    let mut img = Image::new(
        Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        TextureDimension::D2,
        data,
        TextureFormat::Rgba8Unorm,
        RenderAssetUsages::RENDER_WORLD,
    );
    img.sampler = ImageSampler::Descriptor(ImageSamplerDescriptor::linear());
    crate::gfx::build_mips(&mut img);
    img
}

/// 3D value noise in `[0, 1]`.
fn vnoise(x: f32, y: f32, z: f32, seed: u32) -> f32 {
    let (xi, yi, zi) = (x.floor(), y.floor(), z.floor());
    let (fx, fy, fz) = (x - xi, y - yi, z - zi);
    let s = |t: f32| t * t * (3.0 - 2.0 * t);
    let (u, v, w) = (s(fx), s(fy), s(fz));
    let h = |a: i32, b: i32, c: i32| {
        let k = (a as u32).wrapping_mul(0x8DA6_B343) ^ (b as u32).wrapping_mul(0xD816_3841) ^ (c as u32).wrapping_mul(0xCB1A_B31F) ^ seed;
        (hash32(k) >> 8) as f32 / 16_777_216.0
    };
    let (x0, y0, z0) = (xi as i32, yi as i32, zi as i32);
    let l = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let c00 = l(h(x0, y0, z0), h(x0 + 1, y0, z0), u);
    let c10 = l(h(x0, y0 + 1, z0), h(x0 + 1, y0 + 1, z0), u);
    let c01 = l(h(x0, y0, z0 + 1), h(x0 + 1, y0, z0 + 1), u);
    let c11 = l(h(x0, y0 + 1, z0 + 1), h(x0 + 1, y0 + 1, z0 + 1), u);
    l(l(c00, c10, v), l(c01, c11, v), w)
}

fn fbm(x: f32, y: f32, z: f32, seed: u32) -> f32 {
    let (mut a, mut f, mut sum, mut norm) = (0.5, 1.0, 0.0, 0.0);
    for o in 0..4 {
        sum += a * vnoise(x * f, y * f, z * f, seed.wrapping_add(o));
        norm += a;
        a *= 0.5;
        f *= 2.03;
    }
    sum / norm
}

/// `n × n` frames of `cell` px: a puff that billows (noise drifts outward, edges erode).
fn smoke_atlas(n: u32, cell: u32) -> Image {
    let size = n * cell;
    let mut data = vec![0u8; (size * size * 4) as usize];
    let frames = n * n;
    for f in 0..frames {
        let t = f as f32 / frames as f32;
        let (cx, cy) = ((f % n) * cell, (f / n) * cell);
        for j in 0..cell {
            for i in 0..cell {
                let x = (i as f32 + 0.5) / cell as f32 * 2.0 - 1.0;
                let y = (j as f32 + 0.5) / cell as f32 * 2.0 - 1.0;
                let r = (x * x + y * y).sqrt();
                // Domain swirls outward over the sequence.
                let k = 1.0 - 0.35 * t;
                let n1 = fbm(x * 2.2 * k + 5.0, y * 2.2 * k + 3.0, t * 1.6, 17);
                let n2 = fbm(x * 4.5 + 11.0, y * 4.5 - 7.0, t * 2.4 + 3.0, 91);
                let falloff = (1.0 - r * (0.95 + 0.3 * t)).clamp(0.0, 1.0);
                let density = (n1 * 1.25 - 0.18 - 0.25 * t + falloff * 0.9 - 0.45).clamp(0.0, 1.0);
                let a = (density * falloff * 2.2).min(1.0);
                // Self-shadowed look: lighter on top, darker in dense bits.
                let shade = (0.7 + 0.3 * n2 - 0.15 * y.max(0.0) + 0.1 * (-y).max(0.0)).clamp(0.0, 1.0);
                let o = (((cy + j) * size + cx + i) * 4) as usize;
                let b = (shade * 255.0) as u8;
                data[o] = b;
                data[o + 1] = b;
                data[o + 2] = b;
                data[o + 3] = (a * 255.0) as u8;
            }
        }
    }
    finish(size, size, data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn textures_have_mips_and_alpha_shapes() {
        let dot = image(64, 64, |x, y| [1.0, 1.0, 1.0, (1.0 - x * x - y * y).max(0.0)]);
        assert!(dot.texture_descriptor.mip_level_count > 1);
        let d = dot.data.as_ref().unwrap();
        assert_eq!(d[3], 0, "corner transparent");
        let c = ((32 * 64 + 32) * 4 + 3) as usize;
        assert!(d[c] > 250, "centre opaque");
        let s = smoke_atlas(2, 32);
        let sd = s.data.as_ref().unwrap();
        let alpha: u32 = sd[..64 * 64 * 4].chunks(4).map(|p| p[3] as u32).sum();
        assert!(alpha > 0, "smoke has density");
    }
}
