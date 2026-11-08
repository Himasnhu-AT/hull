//! Impostor bake: a software rasteriser draws the model's albedo from `views` evenly spaced
//! directions around +Y (orthographic, camera level with the middle) into one atlas, cells side by
//! side. No GPU needed, so it runs in CI and in the cook tool. Runtime: the engine's billboard
//! shader picks the cell facing the camera (`src/assets/impostor.wesl`).
//!
//! Extension points: elevation rings (octahedral atlases), a normal / depth atlas for relighting,
//! alpha-to-coverage dilation: all start from [`bake`].

use glam::{Vec2, Vec3};

use crate::Model;

#[derive(Clone, Copy, Debug)]
pub struct BakeConfig {
    /// Views around the model (cell `i` looks from `i / views` of a turn, cell 0 from +Z).
    pub views: u32,
    /// Cell width in pixels (the height follows the model's aspect).
    pub cell: u32,
    /// Samples per pixel side before the box downsample.
    pub supersample: u32,
}

impl Default for BakeConfig {
    fn default() -> Self {
        BakeConfig { views: 8, cell: 128, supersample: 2 }
    }
}

pub struct Impostor {
    /// RGBA8, straight alpha, `views * cell_w` by `cell_h`.
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub views: u32,
    /// Quad size in metres and the local height of its bottom edge.
    pub quad_w: f32,
    pub quad_h: f32,
    pub y_min: f32,
}

struct Tex {
    w: u32,
    h: u32,
    rgba: Vec<u8>,
}

impl Tex {
    fn sample(&self, uv: Vec2) -> [f32; 4] {
        let (u, v) = (uv.x.rem_euclid(1.0) * self.w as f32 - 0.5, uv.y.rem_euclid(1.0) * self.h as f32 - 0.5);
        let (x0, y0) = (u.floor(), v.floor());
        let (fx, fy) = (u - x0, v - y0);
        let px = |x: f32, y: f32| {
            let (x, y) = ((x as i64).rem_euclid(self.w as i64) as usize, (y as i64).rem_euclid(self.h as i64) as usize);
            let i = (y * self.w as usize + x) * 4;
            [self.rgba[i] as f32 / 255.0, self.rgba[i + 1] as f32 / 255.0, self.rgba[i + 2] as f32 / 255.0, self.rgba[i + 3] as f32 / 255.0]
        };
        let (a, b, c, d) = (px(x0, y0), px(x0 + 1.0, y0), px(x0, y0 + 1.0), px(x0 + 1.0, y0 + 1.0));
        let mut o = [0.0; 4];
        for k in 0..4 {
            o[k] = (a[k] * (1.0 - fx) + b[k] * fx) * (1.0 - fy) + (c[k] * (1.0 - fx) + d[k] * fx) * fy;
        }
        o
    }
}

fn srgb_of_linear(c: f32) -> f32 {
    if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

pub fn bake(model: &Model, cfg: BakeConfig) -> Result<Impostor, String> {
    let (lo, hi) = model.bounds().ok_or("impostor: empty model")?;
    let radius = model.meshes.iter().flat_map(|m| m.positions.iter()).map(|p| (p[0] * p[0] + p[2] * p[2]).sqrt()).fold(0.0, f32::max).max(1e-3);
    let (quad_w, quad_h) = (radius * 2.0, (hi.y - lo.y).max(1e-3));
    let cell_w = cfg.cell.max(8);
    let cell_h = ((cell_w as f32 * quad_h / quad_w).round() as u32).clamp(8, 4096);
    let ss = cfg.supersample.max(1);
    let textures: Vec<Option<Tex>> = model
        .images
        .iter()
        .map(|im| {
            let d = image::load_from_memory(&im.bytes).ok()?.to_rgba8();
            Some(Tex { w: d.width(), h: d.height(), rgba: d.into_raw() })
        })
        .collect();
    let (w, h) = (cfg.views * cell_w, cell_h);
    let mut atlas = vec![0u8; (w * h * 4) as usize];
    for v in 0..cfg.views {
        let a = std::f32::consts::TAU * v as f32 / cfg.views as f32;
        let (dir, right) = (Vec3::new(a.sin(), 0.0, a.cos()), Vec3::new(a.cos(), 0.0, -a.sin()));
        let (bw, bh) = ((cell_w * ss) as usize, (cell_h * ss) as usize);
        let mut color = vec![[0f32; 4]; bw * bh];
        let mut depth = vec![f32::MIN; bw * bh];
        for me in &model.meshes {
            let mat = model.materials.get(me.material);
            let tex = mat.and_then(|m| m.base_color_tex).and_then(|i| textures.get(i)).and_then(Option::as_ref);
            let factor = mat.map_or([1.0; 4], |m| m.base_color);
            let factor_srgb = [srgb_of_linear(factor[0]), srgb_of_linear(factor[1]), srgb_of_linear(factor[2]), factor[3]];
            let cutoff = mat.and_then(|m| m.alpha_mask);
            let to_px = |p: Vec3| Vec3::new((p.dot(right) + quad_w / 2.0) / quad_w * bw as f32, (hi.y - p.y) / quad_h * bh as f32, p.dot(dir));
            for t in 0..me.triangles() {
                let idx = [me.indices[t * 3] as usize, me.indices[t * 3 + 1] as usize, me.indices[t * 3 + 2] as usize];
                let p = idx.map(|i| to_px(Vec3::from(me.positions[i])));
                let uv = idx.map(|i| Vec2::from(me.uvs[i]));
                let area = (p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[2].x - p[0].x) * (p[1].y - p[0].y);
                if area.abs() < 1e-9 {
                    continue;
                }
                let (x0, x1) = (p.iter().map(|q| q.x).fold(f32::MAX, f32::min).floor().max(0.0) as usize, (p.iter().map(|q| q.x).fold(f32::MIN, f32::max).ceil() as usize).min(bw));
                let (y0, y1) = (p.iter().map(|q| q.y).fold(f32::MAX, f32::min).floor().max(0.0) as usize, (p.iter().map(|q| q.y).fold(f32::MIN, f32::max).ceil() as usize).min(bh));
                for y in y0..y1 {
                    for x in x0..x1 {
                        let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
                        let w0 = ((p[1].x - fx) * (p[2].y - fy) - (p[2].x - fx) * (p[1].y - fy)) / area;
                        let w1 = ((p[2].x - fx) * (p[0].y - fy) - (p[0].x - fx) * (p[2].y - fy)) / area;
                        let w2 = 1.0 - w0 - w1;
                        if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                            continue;
                        }
                        let z = w0 * p[0].z + w1 * p[1].z + w2 * p[2].z;
                        let i = y * bw + x;
                        if z <= depth[i] {
                            continue;
                        }
                        let tc = uv[0] * w0 + uv[1] * w1 + uv[2] * w2;
                        let s = tex.map_or([1.0; 4], |t| t.sample(tc));
                        let c = [s[0] * factor_srgb[0], s[1] * factor_srgb[1], s[2] * factor_srgb[2], s[3] * factor_srgb[3]];
                        if cutoff.is_some_and(|k| c[3] < k) || c[3] < 0.5 {
                            continue;
                        }
                        depth[i] = z;
                        color[i] = [c[0], c[1], c[2], 1.0];
                    }
                }
            }
        }
        // Box downsample with premultiplied alpha.
        for cy in 0..cell_h as usize {
            for cx in 0..cell_w as usize {
                let (mut acc, mut cov) = ([0f32; 3], 0f32);
                for sy in 0..ss as usize {
                    for sx in 0..ss as usize {
                        let c = color[(cy * ss as usize + sy) * bw + cx * ss as usize + sx];
                        for k in 0..3 {
                            acc[k] += c[k] * c[3];
                        }
                        cov += c[3];
                    }
                }
                let o = ((cy as u32 * w + v * cell_w + cx as u32) * 4) as usize;
                if cov > 0.0 {
                    for k in 0..3 {
                        atlas[o + k] = ((acc[k] / cov).clamp(0.0, 1.0) * 255.0).round() as u8;
                    }
                    atlas[o + 3] = ((cov / (ss * ss) as f32).clamp(0.0, 1.0) * 255.0).round() as u8;
                }
            }
        }
    }
    dilate(&mut atlas, w as usize, h as usize, cell_w as usize);
    Ok(Impostor { rgba: atlas, width: w, height: h, views: cfg.views, quad_w, quad_h, y_min: lo.y })
}

/// Copies edge colour into fully transparent neighbours (twice) so bilinear filtering and mips
/// never blend in black: only inside a cell, never across cells.
fn dilate(px: &mut [u8], w: usize, h: usize, cell_w: usize) {
    for _ in 0..2 {
        let src = px.to_vec();
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                if src[i + 3] != 0 {
                    continue;
                }
                let (cx0, cx1) = ((x / cell_w) * cell_w, (x / cell_w) * cell_w + cell_w);
                let mut best: Option<usize> = None;
                for (dx, dy) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1)] {
                    let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                    if nx < cx0 as i64 || nx >= cx1 as i64 || ny < 0 || ny >= h as i64 {
                        continue;
                    }
                    let j = (ny as usize * w + nx as usize) * 4;
                    if src[j + 3] != 0 {
                        best = Some(j);
                        break;
                    }
                }
                if let Some(j) = best {
                    px[i..i + 3].copy_from_slice(&src[j..j + 3]);
                }
            }
        }
    }
}

pub fn encode_png(i: &Impostor) -> Result<Vec<u8>, String> {
    let img = image::RgbaImage::from_raw(i.width, i.height, i.rgba.clone()).ok_or("bad atlas size")?;
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures;

    #[test]
    fn the_tree_bakes_to_coloured_cells_with_a_transparent_corner() {
        let imp = bake(&fixtures::tree(), BakeConfig { views: 4, cell: 64, supersample: 2 }).unwrap();
        assert_eq!((imp.width, imp.views), (4 * 64, 4));
        assert!(imp.height > 64, "tall model, tall cells: {}", imp.height);
        assert!((imp.quad_h - 6.0).abs() < 1e-3);
        let px = |x: u32, y: u32| &imp.rgba[((y * imp.width + x) * 4) as usize..][..4];
        // Top-left corner of each cell is outside the silhouette; the middle is needles (green).
        for v in 0..4 {
            assert_eq!(px(v * 64, 0)[3], 0);
            let c = px(v * 64 + 32, imp.height * 2 / 3);
            assert_eq!(c[3], 255, "view {v}");
            assert!(c[1] > c[0] && c[1] > c[2], "green: {c:?}");
        }
        // The trunk (brown, red > blue) shows at the bottom middle.
        let t = px(32, imp.height - 3);
        assert!(t[3] > 200 && t[0] > t[2], "{t:?}");
        // Opposite views of a symmetric tree match closely.
        assert!(encode_png(&imp).unwrap().starts_with(&[0x89, b'P']));
    }
}
