//! Heightfield data: a regular grid of heights over XZ, queries that match the rendered mesh
//! and the physics collider exactly, and loaders (code / noise / 16-bit PNG / raw 16-bit).
//!
//! Coordinates are **absolute world metres** (see [`super::WorldOrigin`] for the floating
//! origin). Sample `(ix, iz)` sits at `origin + (ix, iz) * spacing`.
//!
//! Triangulation (shared by [`Heightfield::height_at`], the terrain mesh and parry's
//! heightfield collider): every grid cell `A=(x0,z0) B=(x1,z0) C=(x0,z1) D=(x1,z1)` is split
//! along the `C–B` diagonal into `A C B` and `C D B`.

use bevy::math::{Vec2, Vec3};
use serde::{Deserialize, Serialize};

use super::noise::Fbm;

/// Heights on a regular XZ grid.
#[derive(Clone, Debug)]
pub struct Heightfield {
    /// Samples along X / Z (at least 2 each).
    nx: u32,
    nz: u32,
    /// Metres between samples.
    spacing: f32,
    /// Absolute XZ of sample (0, 0).
    origin: Vec2,
    /// Row-major: `heights[iz * nx + ix]`.
    heights: Vec<f32>,
    min: f32,
    max: f32,
}

/// Errors from heightmap loaders.
#[derive(Debug, Clone, PartialEq)]
pub enum HeightmapError {
    Io(String),
    Format(String),
}

impl std::fmt::Display for HeightmapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HeightmapError::Io(e) => write!(f, "heightmap io: {e}"),
            HeightmapError::Format(e) => write!(f, "heightmap format: {e}"),
        }
    }
}

impl std::error::Error for HeightmapError {}

/// Noise terrain: `base + amplitude * fbm(x, z)` shaped by `exponent` (>1 = flat valleys,
/// sharp peaks), optionally ramped down to `base` near the borders.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NoiseTerrain {
    pub fbm: Fbm,
    /// Metres from the lowest valley to the highest peak (about).
    pub amplitude: f32,
    pub base: f32,
    pub exponent: f32,
    /// Metres from the border over which heights fade to `base` (0 = off).
    pub border_falloff: f32,
}

impl Default for NoiseTerrain {
    fn default() -> Self {
        NoiseTerrain {
            fbm: Fbm { frequency: 0.0012, octaves: 6, ridged: 0.35, warp: 80.0, ..Fbm::default() },
            amplitude: 220.0,
            base: 0.0,
            exponent: 1.6,
            border_falloff: 0.0,
        }
    }
}

/// Runs `f(row, row_slice)` over every row of a `nx × nz` buffer on all cores.
pub(crate) fn par_rows<T: Send + Default + Clone>(nx: usize, nz: usize, f: impl Fn(usize, &mut [T]) + Sync) -> Vec<T> {
    let mut out = vec![T::default(); nx * nz];
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(nz.max(1));
    let rows_per = nz.div_ceil(threads.max(1)).max(1);
    std::thread::scope(|s| {
        for (ci, block) in out.chunks_mut(rows_per * nx).enumerate() {
            let f = &f;
            s.spawn(move || {
                for (r, row) in block.chunks_mut(nx).enumerate() {
                    f(ci * rows_per + r, row);
                }
            });
        }
    });
    out
}

impl Heightfield {
    /// From raw row-major heights (`heights.len() == nx * nz`).
    pub fn from_heights(nx: u32, nz: u32, spacing: f32, origin: Vec2, heights: Vec<f32>) -> Self {
        assert!(nx >= 2 && nz >= 2, "a heightfield needs at least 2×2 samples");
        assert_eq!(heights.len(), (nx * nz) as usize, "heights must be nx * nz");
        assert!(spacing > 0.0);
        let (min, max) = heights.iter().fold((f32::MAX, f32::MIN), |(lo, hi), h| (lo.min(*h), hi.max(*h)));
        Heightfield { nx, nz, spacing, origin, heights, min, max }
    }

    /// Flat at `height`.
    pub fn flat(nx: u32, nz: u32, spacing: f32, origin: Vec2, height: f32) -> Self {
        Self::from_heights(nx, nz, spacing, origin, vec![height; (nx * nz) as usize])
    }

    /// `f(absolute x, absolute z) -> height` at every sample, on all cores.
    pub fn from_fn(nx: u32, nz: u32, spacing: f32, origin: Vec2, f: impl Fn(f32, f32) -> f32 + Sync) -> Self {
        let heights = par_rows(nx as usize, nz as usize, |iz, row: &mut [f32]| {
            let z = origin.y + iz as f32 * spacing;
            for (ix, h) in row.iter_mut().enumerate() {
                *h = f(origin.x + ix as f32 * spacing, z);
            }
        });
        Self::from_heights(nx, nz, spacing, origin, heights)
    }

    /// Noise terrain covering `nx × nz` samples.
    pub fn from_noise(nx: u32, nz: u32, spacing: f32, origin: Vec2, n: &NoiseTerrain) -> Self {
        let size = Vec2::new((nx - 1) as f32, (nz - 1) as f32) * spacing;
        Self::from_fn(nx, nz, spacing, origin, |x, z| {
            let v = n.fbm.sample01(Vec2::new(x, z));
            let mut h = v.powf(n.exponent.max(0.01)) * n.amplitude;
            if n.border_falloff > 0.0 {
                let local = Vec2::new(x, z) - origin;
                let d = local.min(size - local).min_element().max(0.0);
                let t = (d / n.border_falloff).min(1.0);
                h *= t * t * (3.0 - 2.0 * t);
            }
            n.base + h
        })
    }

    /// A 16-bit (or 8-bit) greyscale PNG: black = `min_height`, white = `max_height`. Image X is
    /// world X, image rows go along +Z.
    pub fn from_png(bytes: &[u8], spacing: f32, origin: Vec2, min_height: f32, max_height: f32) -> Result<Self, HeightmapError> {
        let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
        dec.set_transformations(png::Transformations::EXPAND);
        let mut reader = dec.read_info().map_err(|e| HeightmapError::Format(e.to_string()))?;
        let mut buf = vec![0; reader.output_buffer_size().ok_or_else(|| HeightmapError::Format("image too large".into()))?];
        let info = reader.next_frame(&mut buf).map_err(|e| HeightmapError::Format(e.to_string()))?;
        let (w, h) = (info.width, info.height);
        let channels = info.color_type.samples();
        let wide = info.bit_depth == png::BitDepth::Sixteen;
        let bytes_per = if wide { 2 } else { 1 };
        let range = max_height - min_height;
        let mut heights = Vec::with_capacity((w * h) as usize);
        for row in 0..h as usize {
            let line = &buf[row * info.line_size..];
            for col in 0..w as usize {
                let o = col * channels * bytes_per;
                let v = if wide { u16::from_be_bytes([line[o], line[o + 1]]) as f32 / 65535.0 } else { line[o] as f32 / 255.0 };
                heights.push(min_height + v * range);
            }
        }
        if w < 2 || h < 2 {
            return Err(HeightmapError::Format("heightmap must be at least 2×2".into()));
        }
        Ok(Self::from_heights(w, h, spacing, origin, heights))
    }

    /// Raw little-endian u16 samples (`w * h * 2` bytes, row-major, e.g. World Machine /
    /// Gaea `.r16` exports): 0 = `min_height`, 65535 = `max_height`.
    pub fn from_raw16(bytes: &[u8], w: u32, h: u32, spacing: f32, origin: Vec2, min_height: f32, max_height: f32) -> Result<Self, HeightmapError> {
        if bytes.len() != (w * h * 2) as usize || w < 2 || h < 2 {
            return Err(HeightmapError::Format(format!("raw16: expected {} bytes for {w}×{h}, got {}", w * h * 2, bytes.len())));
        }
        let range = max_height - min_height;
        let heights = bytes.chunks_exact(2).map(|b| min_height + u16::from_le_bytes([b[0], b[1]]) as f32 / 65535.0 * range).collect();
        Ok(Self::from_heights(w, h, spacing, origin, heights))
    }

    /// Encodes as a 16-bit greyscale PNG (min..max mapped to 0..65535); round-trips through
    /// [`Heightfield::from_png`] within `(max - min) / 65535`.
    pub fn to_png16(&self) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, self.nx, self.nz);
            enc.set_color(png::ColorType::Grayscale);
            enc.set_depth(png::BitDepth::Sixteen);
            let mut w = enc.write_header().expect("png header");
            let range = (self.max - self.min).max(1e-6);
            let data: Vec<u8> = self.heights.iter().flat_map(|h| (((h - self.min) / range * 65535.0).round() as u16).to_be_bytes()).collect();
            w.write_image_data(&data).expect("png data");
        }
        out
    }

    pub fn nx(&self) -> u32 {
        self.nx
    }
    pub fn nz(&self) -> u32 {
        self.nz
    }
    pub fn spacing(&self) -> f32 {
        self.spacing
    }
    /// Absolute XZ of sample (0, 0) (the min corner).
    pub fn origin(&self) -> Vec2 {
        self.origin
    }
    /// Size in metres (X, Z).
    pub fn size(&self) -> Vec2 {
        Vec2::new((self.nx - 1) as f32, (self.nz - 1) as f32) * self.spacing
    }
    /// Lowest / highest sample.
    pub fn min_height(&self) -> f32 {
        self.min
    }
    pub fn max_height(&self) -> f32 {
        self.max
    }
    pub fn heights(&self) -> &[f32] {
        &self.heights
    }
    /// Bytes of height data.
    pub fn memory_bytes(&self) -> usize {
        self.heights.len() * 4
    }
    /// `(x, z)` (absolute) is inside the grid.
    pub fn contains(&self, x: f32, z: f32) -> bool {
        let l = Vec2::new(x, z) - self.origin;
        let s = self.size();
        l.x >= 0.0 && l.y >= 0.0 && l.x <= s.x && l.y <= s.y
    }

    /// Sample height (indices clamped to the grid).
    #[inline]
    pub fn get(&self, ix: i64, iz: i64) -> f32 {
        let x = ix.clamp(0, self.nx as i64 - 1) as usize;
        let z = iz.clamp(0, self.nz as i64 - 1) as usize;
        self.heights[z * self.nx as usize + x]
    }

    /// Changes one sample (keeps min/max conservative; call [`Heightfield::recompute_bounds`]
    /// after a batch of edits). Meshes and colliders built earlier are not updated.
    pub fn set(&mut self, ix: u32, iz: u32, h: f32) {
        self.heights[(iz * self.nx + ix) as usize] = h;
        self.min = self.min.min(h);
        self.max = self.max.max(h);
    }

    pub fn recompute_bounds(&mut self) {
        (self.min, self.max) = self.heights.iter().fold((f32::MAX, f32::MIN), |(lo, hi), h| (lo.min(*h), hi.max(*h)));
    }

    /// Absolute XZ of a sample.
    pub fn sample_pos(&self, ix: u32, iz: u32) -> Vec2 {
        self.origin + Vec2::new(ix as f32, iz as f32) * self.spacing
    }

    /// Height at absolute `(x, z)`, interpolated on the same triangles as the mesh and the
    /// collider (so a character standing on the collider stands on this height). Outside the
    /// grid: clamped to the border.
    pub fn height_at(&self, x: f32, z: f32) -> f32 {
        let (ix, iz, fx, fz) = self.cell(x, z);
        let a = self.get(ix, iz);
        let b = self.get(ix + 1, iz);
        let c = self.get(ix, iz + 1);
        let d = self.get(ix + 1, iz + 1);
        tri_height(a, b, c, d, fx, fz)
    }

    /// Height on a coarser triangulation: the grid of every `step`-th sample (what a terrain
    /// chunk at LOD `log2(step)` draws). `step` must be a power of two.
    pub fn height_at_step(&self, x: f32, z: f32, step: u32) -> f32 {
        let s = step.max(1) as i64;
        let l = (Vec2::new(x, z) - self.origin) / (self.spacing * s as f32);
        let maxx = ((self.nx as i64 - 1) / s - 1).max(0);
        let maxz = ((self.nz as i64 - 1) / s - 1).max(0);
        let cx = (l.x.floor() as i64).clamp(0, maxx);
        let cz = (l.y.floor() as i64).clamp(0, maxz);
        let fx = (l.x - cx as f32).clamp(0.0, 1.0);
        let fz = (l.y - cz as f32).clamp(0.0, 1.0);
        let a = self.get(cx * s, cz * s);
        let b = self.get((cx + 1) * s, cz * s);
        let c = self.get(cx * s, (cz + 1) * s);
        let d = self.get((cx + 1) * s, (cz + 1) * s);
        tri_height(a, b, c, d, fx, fz)
    }

    /// Unit normal of the triangle under absolute `(x, z)` (what the collider reports).
    pub fn normal_at(&self, x: f32, z: f32) -> Vec3 {
        let (ix, iz, fx, fz) = self.cell(x, z);
        let s = self.spacing;
        let a = self.get(ix, iz);
        let b = self.get(ix + 1, iz);
        let c = self.get(ix, iz + 1);
        let d = self.get(ix + 1, iz + 1);
        let (dx, dz) = if fx + fz <= 1.0 { (b - a, c - a) } else { (d - c, d - b) };
        Vec3::new(-dx / s, 1.0, -dz / s).normalize()
    }

    /// Smooth normal at absolute `(x, z)` (bilinear blend of sample normals), for slopes,
    /// splat rules and aligning scatter.
    pub fn smooth_normal_at(&self, x: f32, z: f32) -> Vec3 {
        let (ix, iz, fx, fz) = self.cell(x, z);
        let n00 = self.sample_normal(ix, iz);
        let n10 = self.sample_normal(ix + 1, iz);
        let n01 = self.sample_normal(ix, iz + 1);
        let n11 = self.sample_normal(ix + 1, iz + 1);
        let a = n00.lerp(n10, fx);
        let b = n01.lerp(n11, fx);
        a.lerp(b, fz).normalize_or(Vec3::Y)
    }

    /// Vertex normal of a sample (central differences; the terrain mesh uses these, so
    /// neighbouring chunks agree at their seams).
    #[inline]
    pub fn sample_normal(&self, ix: i64, iz: i64) -> Vec3 {
        let hx = self.get(ix + 1, iz) - self.get(ix - 1, iz);
        let hz = self.get(ix, iz + 1) - self.get(ix, iz - 1);
        Vec3::new(-hx, 2.0 * self.spacing, -hz).normalize()
    }

    /// Slope at absolute `(x, z)` in degrees (0 = flat).
    pub fn slope_deg(&self, x: f32, z: f32) -> f32 {
        self.smooth_normal_at(x, z).y.clamp(-1.0, 1.0).acos().to_degrees()
    }

    /// First hit of a ray (absolute coordinates) with the terrain surface, up to `max_dist`.
    /// Marches at half the sample spacing, then bisects. `None` if it never goes below.
    pub fn raycast(&self, origin: Vec3, dir: Vec3, max_dist: f32) -> Option<Vec3> {
        let dir = dir.try_normalize()?;
        let step = self.spacing * 0.5;
        let above = |p: Vec3| p.y - self.height_at(p.x, p.z);
        let mut t0 = 0.0;
        if above(origin) < 0.0 {
            return Some(origin);
        }
        let mut t = step;
        while t <= max_dist + step {
            let tt = t.min(max_dist);
            if above(origin + dir * tt) < 0.0 {
                let (mut lo, mut hi) = (t0, tt);
                for _ in 0..24 {
                    let mid = 0.5 * (lo + hi);
                    if above(origin + dir * mid) < 0.0 {
                        hi = mid;
                    } else {
                        lo = mid;
                    }
                }
                let p = origin + dir * hi;
                return Some(Vec3::new(p.x, self.height_at(p.x, p.z), p.z));
            }
            t0 = tt;
            if tt >= max_dist {
                break;
            }
            t += step;
        }
        None
    }

    /// A coarse heightfield every `step` samples whose surface is never above this one: each
    /// coarse sample is the minimum of the fine samples in the coarse cells around it, minus
    /// `margin`. Used as the always-loaded fallback collider in streaming mode.
    pub fn coarse_below(&self, step: u32, margin: f32) -> Heightfield {
        let s = step.max(1) as i64;
        let cnx = ((self.nx as i64 - 1) + s - 1) / s + 1;
        let cnz = ((self.nz as i64 - 1) + s - 1) / s + 1;
        let heights = par_rows(cnx as usize, cnz as usize, |cz, row: &mut [f32]| {
            let cz = cz as i64;
            for (cx, out) in row.iter_mut().enumerate() {
                let cx = cx as i64;
                let mut m = f32::MAX;
                for iz in ((cz - 1) * s).max(0)..=((cz + 1) * s).min(self.nz as i64 - 1) {
                    for ix in ((cx - 1) * s).max(0)..=((cx + 1) * s).min(self.nx as i64 - 1) {
                        m = m.min(self.get(ix, iz));
                    }
                }
                *out = m - margin;
            }
        });
        Heightfield::from_heights(cnx as u32, cnz as u32, self.spacing * s as f32, self.origin, heights)
    }

    /// Cell under absolute `(x, z)` and the fraction inside it (clamped to the grid).
    #[inline]
    fn cell(&self, x: f32, z: f32) -> (i64, i64, f32, f32) {
        let l = (Vec2::new(x, z) - self.origin) / self.spacing;
        let ix = (l.x.floor() as i64).clamp(0, self.nx as i64 - 2);
        let iz = (l.y.floor() as i64).clamp(0, self.nz as i64 - 2);
        ((ix), (iz), (l.x - ix as f32).clamp(0.0, 1.0), (l.y - iz as f32).clamp(0.0, 1.0))
    }
}

/// Height inside one grid cell `A=(0,0) B=(1,0) C=(0,1) D=(1,1)` split along `C–B`.
#[inline]
pub fn tri_height(a: f32, b: f32, c: f32, d: f32, fx: f32, fz: f32) -> f32 {
    if fx + fz <= 1.0 { a + fx * (b - a) + fz * (c - a) } else { d + (1.0 - fx) * (c - d) + (1.0 - fz) * (b - d) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bumpy() -> Heightfield {
        Heightfield::from_fn(33, 17, 2.0, Vec2::new(-32.0, -16.0), |x, z| (x * 0.3).sin() * 4.0 + (z * 0.2).cos() * 3.0 + x * 0.1)
    }

    #[test]
    fn samples_and_interpolation() {
        let hf = bumpy();
        assert_eq!(hf.size(), Vec2::new(64.0, 32.0));
        // Exactly on samples.
        for (ix, iz) in [(0, 0), (5, 7), (32, 16), (13, 2)] {
            let p = hf.sample_pos(ix, iz);
            assert!((hf.height_at(p.x, p.y) - hf.get(ix as i64, iz as i64)).abs() < 1e-4);
        }
        // Midpoint of the C–B diagonal = average of B and C.
        let p = hf.sample_pos(4, 4) + Vec2::splat(1.0);
        let want = 0.5 * (hf.get(5, 4) + hf.get(4, 5));
        assert!((hf.height_at(p.x, p.y) - want).abs() < 1e-4);
        // Clamped outside.
        assert_eq!(hf.height_at(-1000.0, -1000.0), hf.get(0, 0));
        assert!(hf.contains(0.0, 0.0) && !hf.contains(40.0, 0.0));
        // Step-1 coarse queries equal the fine ones.
        assert!((hf.height_at_step(3.3, 1.7, 1) - hf.height_at(3.3, 1.7)).abs() < 1e-4);
    }

    #[test]
    fn normals_and_slope() {
        let ramp = Heightfield::from_fn(9, 9, 1.0, Vec2::ZERO, |x, _| x); // 45° along +X
        let n = ramp.normal_at(3.2, 4.1);
        assert!((n - Vec3::new(-1.0, 1.0, 0.0).normalize()).length() < 1e-4, "{n}");
        assert!((ramp.slope_deg(4.0, 4.0) - 45.0).abs() < 0.1);
        let flat = Heightfield::flat(4, 4, 1.0, Vec2::ZERO, 2.0);
        assert_eq!(flat.normal_at(1.5, 1.5), Vec3::Y);
    }

    #[test]
    fn raycast_hits_surface() {
        let hf = bumpy();
        let hit = hf.raycast(Vec3::new(0.0, 50.0, 0.0), Vec3::new(0.3, -1.0, 0.1), 200.0).expect("hit");
        assert!((hit.y - hf.height_at(hit.x, hit.z)).abs() < 1e-3);
        assert!(hf.raycast(Vec3::new(0.0, 50.0, 0.0), Vec3::Y, 100.0).is_none());
    }

    #[test]
    fn coarse_is_never_above() {
        let hf = bumpy();
        let c = hf.coarse_below(4, 0.05);
        for i in 0..2000 {
            let x = -32.0 + (i as f32 * 0.6173) % 64.0;
            let z = -16.0 + (i as f32 * 0.3711) % 32.0;
            assert!(c.height_at(x, z) <= hf.height_at(x, z) - 0.049, "at {x},{z}");
        }
    }

    #[test]
    fn png16_and_raw16_round_trip() {
        let hf = bumpy();
        let png = hf.to_png16();
        let back = Heightfield::from_png(&png, 2.0, hf.origin(), hf.min_height(), hf.max_height()).unwrap();
        assert_eq!((back.nx(), back.nz()), (33, 17));
        let tol = (hf.max_height() - hf.min_height()) / 65535.0 + 1e-4;
        assert!(hf.heights().iter().zip(back.heights()).all(|(a, b)| (a - b).abs() <= tol));
        let raw: Vec<u8> = [0u16, 65535, 32768, 1].iter().flat_map(|v| v.to_le_bytes()).collect();
        let r = Heightfield::from_raw16(&raw, 2, 2, 1.0, Vec2::ZERO, 0.0, 100.0).unwrap();
        assert_eq!(r.get(1, 0), 100.0);
        assert!(Heightfield::from_raw16(&raw, 3, 2, 1.0, Vec2::ZERO, 0.0, 1.0).is_err());
    }
}
