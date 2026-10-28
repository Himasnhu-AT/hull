//! Point sets, input shapes and the hashing every random choice goes through.

use std::collections::BTreeMap;

use glam::{Quat, Vec2, Vec3};
use serde::{Deserialize, Serialize};

/// SplitMix64 finaliser: a good 64-bit mix.
#[inline]
pub fn mix64(mut x: u64) -> u64 {
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

/// `[0, 1)` from a hash.
#[inline]
pub fn unit(h: u64) -> f32 {
    (h >> 40) as f32 / (1u64 << 24) as f32
}

/// FNV-1a of a string: tag ids and default node seeds.
pub fn str_hash(s: &str) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for b in s.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// A tag's id as stored in [`PointSet::tag`].
pub fn tag_id(tag: &str) -> u32 {
    if tag.is_empty() { 0 } else { (str_hash(tag) as u32).max(1) }
}

/// Seed of a point at a world position: depends only on the graph seed, the node and the
/// position (quantised to 1 mm), never on cell size or evaluation order.
pub fn seed_at(graph: u64, node: u64, pos: Vec3) -> u64 {
    let q = |v: f32| (v * 1000.0).round() as i64 as u64;
    mix64(graph ^ mix64(node ^ mix64(q(pos.x) ^ mix64(q(pos.y) ^ mix64(q(pos.z))))))
}

/// Points as columns (structure of arrays).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PointSet {
    pub pos: Vec<Vec3>,
    pub rot: Vec<Quat>,
    pub scale: Vec<Vec3>,
    /// Half size of the point's bounds (in its local frame).
    pub extent: Vec<Vec3>,
    /// 0..1: how strongly the point exists (filters and noise read and write it).
    pub density: Vec<f32>,
    pub seed: Vec<u64>,
    /// [`tag_id`] of the shape the point came from (0 = none).
    pub tag: Vec<u32>,
    /// Extra float columns by name.
    pub attrs: BTreeMap<String, Vec<f32>>,
}

/// One point, for building sets.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub pos: Vec3,
    pub rot: Quat,
    pub scale: Vec3,
    pub extent: Vec3,
    pub density: f32,
    pub seed: u64,
    pub tag: u32,
}

impl Default for Point {
    fn default() -> Self {
        Point { pos: Vec3::ZERO, rot: Quat::IDENTITY, scale: Vec3::ONE, extent: Vec3::splat(0.5), density: 1.0, seed: 0, tag: 0 }
    }
}

impl PointSet {
    pub fn len(&self) -> usize {
        self.pos.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pos.is_empty()
    }

    pub fn get(&self, i: usize) -> Point {
        Point {
            pos: self.pos[i],
            rot: self.rot[i],
            scale: self.scale[i],
            extent: self.extent[i],
            density: self.density[i],
            seed: self.seed[i],
            tag: self.tag[i],
        }
    }

    /// Adds a point (attribute columns get 0).
    pub fn push(&mut self, p: Point) {
        self.pos.push(p.pos);
        self.rot.push(p.rot);
        self.scale.push(p.scale);
        self.extent.push(p.extent);
        self.density.push(p.density);
        self.seed.push(p.seed);
        self.tag.push(p.tag);
        for c in self.attrs.values_mut() {
            c.push(0.0);
        }
    }

    /// Keeps the points where `keep(i)` is true (attribute columns too).
    pub fn retain(&self, mut keep: impl FnMut(usize) -> bool) -> PointSet {
        let idx: Vec<usize> = (0..self.len()).filter(|&i| keep(i)).collect();
        self.select(&idx)
    }

    /// The points at `idx`, in that order.
    pub fn select(&self, idx: &[usize]) -> PointSet {
        PointSet {
            pos: idx.iter().map(|&i| self.pos[i]).collect(),
            rot: idx.iter().map(|&i| self.rot[i]).collect(),
            scale: idx.iter().map(|&i| self.scale[i]).collect(),
            extent: idx.iter().map(|&i| self.extent[i]).collect(),
            density: idx.iter().map(|&i| self.density[i]).collect(),
            seed: idx.iter().map(|&i| self.seed[i]).collect(),
            tag: idx.iter().map(|&i| self.tag[i]).collect(),
            attrs: self.attrs.iter().map(|(k, c)| (k.clone(), idx.iter().map(|&i| c[i]).collect())).collect(),
        }
    }

    /// Appends another set (attribute columns are unioned; missing values are 0).
    pub fn extend(&mut self, o: &PointSet) {
        let n = self.len();
        for k in o.attrs.keys() {
            self.attrs.entry(k.clone()).or_insert_with(|| vec![0.0; n]);
        }
        self.pos.extend_from_slice(&o.pos);
        self.rot.extend_from_slice(&o.rot);
        self.scale.extend_from_slice(&o.scale);
        self.extent.extend_from_slice(&o.extent);
        self.density.extend_from_slice(&o.density);
        self.seed.extend_from_slice(&o.seed);
        self.tag.extend_from_slice(&o.tag);
        for (k, c) in self.attrs.iter_mut() {
            match o.attrs.get(k) {
                Some(v) => c.extend_from_slice(v),
                None => c.resize(n + o.len(), 0.0),
            }
        }
    }

    /// Sorted by position (x, then z, then y): a canonical order for comparing sets.
    pub fn canonical(&self) -> PointSet {
        let mut idx: Vec<usize> = (0..self.len()).collect();
        idx.sort_by(|&a, &b| {
            let (p, q) = (self.pos[a], self.pos[b]);
            p.x.total_cmp(&q.x).then(p.z.total_cmp(&q.z)).then(p.y.total_cmp(&q.y)).then(self.seed[a].cmp(&self.seed[b]))
        });
        self.select(&idx)
    }
}

/// An oriented box on the ground (XZ), at height `y`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    /// Centre in XZ.
    pub center: Vec2,
    /// Half size along its own X / Z.
    pub half: Vec2,
    /// Rotation about Y (radians).
    #[serde(default)]
    pub yaw: f32,
    /// Height of its floor.
    #[serde(default)]
    pub y: f32,
    #[serde(default)]
    pub tag: String,
}

impl Rect {
    pub fn new(center: Vec2, half: Vec2) -> Rect {
        Rect { center, half, yaw: 0.0, y: 0.0, tag: String::new() }
    }

    pub fn tagged(mut self, tag: &str) -> Rect {
        self.tag = tag.into();
        self
    }

    /// `p` (XZ) in its local frame.
    pub fn local(&self, p: Vec2) -> Vec2 {
        let (s, c) = self.yaw.sin_cos();
        let d = p - self.center;
        Vec2::new(d.x * c - d.y * s, d.x * s + d.y * c)
    }

    pub fn contains(&self, p: Vec2, pad: f32) -> bool {
        let l = self.local(p);
        l.x.abs() <= self.half.x + pad && l.y.abs() <= self.half.y + pad
    }

    /// Axis-aligned bounds (XZ).
    pub fn aabb(&self) -> Area {
        let (s, c) = self.yaw.sin_cos();
        let e = Vec2::new(self.half.x * c.abs() + self.half.y * s.abs(), self.half.x * s.abs() + self.half.y * c.abs());
        Area { min: self.center - e, max: self.center + e }
    }

    /// The four corners, counter-clockwise seen from above (+Y).
    pub fn corners(&self) -> [Vec2; 4] {
        let (s, c) = self.yaw.sin_cos();
        let w = |l: Vec2| self.center + Vec2::new(l.x * c + l.y * s, -l.x * s + l.y * c);
        let h = self.half;
        [w(Vec2::new(-h.x, -h.y)), w(Vec2::new(-h.x, h.y)), w(Vec2::new(h.x, h.y)), w(Vec2::new(h.x, -h.y))]
    }
}

/// A line through 3D points (streets, fences, façades).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Polyline {
    pub points: Vec<Vec3>,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub tag: String,
}

/// The ground points get projected onto.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Surface {
    /// A flat ground at this height.
    Plane(f32),
    /// Heights on a grid: `heights[z * width + x]`, sample `(x, z)` at `origin + (x, z) * cell`.
    Heightfield { origin: Vec2, cell: f32, width: usize, heights: Vec<f32> },
}

impl Surface {
    /// Height at `p` (XZ); bilinear on heightfields, clamped at the edges.
    pub fn height(&self, p: Vec2) -> f32 {
        match self {
            Surface::Plane(y) => *y,
            Surface::Heightfield { origin, cell, width, heights } => {
                let w = (*width).max(1);
                let h = (heights.len() / w).max(1);
                let g = (p - *origin) / cell.max(1e-6);
                let gx = g.x.clamp(0.0, (w - 1) as f32);
                let gz = g.y.clamp(0.0, (h - 1) as f32);
                let (x0, z0) = (gx.floor() as usize, gz.floor() as usize);
                let (x1, z1) = ((x0 + 1).min(w - 1), (z0 + 1).min(h - 1));
                let (fx, fz) = (gx - x0 as f32, gz - z0 as f32);
                let at = |x: usize, z: usize| heights.get(z * w + x).copied().unwrap_or(0.0);
                let a = at(x0, z0) + (at(x1, z0) - at(x0, z0)) * fx;
                let b = at(x0, z1) + (at(x1, z1) - at(x0, z1)) * fx;
                a + (b - a) * fz
            }
        }
    }

    /// Normal at `p` (finite differences).
    pub fn normal(&self, p: Vec2) -> Vec3 {
        let e = match self {
            Surface::Plane(_) => return Vec3::Y,
            Surface::Heightfield { cell, .. } => cell.max(0.01) * 0.5,
        };
        let dx = self.height(p + Vec2::X * e) - self.height(p - Vec2::X * e);
        let dz = self.height(p + Vec2::Y * e) - self.height(p - Vec2::Y * e);
        Vec3::new(-dx, 2.0 * e, -dz).normalize_or(Vec3::Y)
    }
}

/// A named input: shapes and/or points.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Shapes {
    #[serde(default)]
    pub rects: Vec<Rect>,
    #[serde(default)]
    pub lines: Vec<Polyline>,
    #[serde(default)]
    pub points: PointSet,
}

/// Everything a graph reads: named shape sets and the ground.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Inputs {
    #[serde(default)]
    pub sets: BTreeMap<String, Shapes>,
    #[serde(default)]
    pub surface: Option<Surface>,
}

impl Inputs {
    pub fn rects(mut self, name: &str, rects: Vec<Rect>) -> Inputs {
        self.sets.entry(name.into()).or_default().rects.extend(rects);
        self
    }

    pub fn lines(mut self, name: &str, lines: Vec<Polyline>) -> Inputs {
        self.sets.entry(name.into()).or_default().lines.extend(lines);
        self
    }

    pub fn points(mut self, name: &str, points: PointSet) -> Inputs {
        self.sets.entry(name.into()).or_default().points.extend(&points);
        self
    }

    pub fn surface(mut self, s: Surface) -> Inputs {
        self.surface = Some(s);
        self
    }

    /// A hash of what lies within `area` (shapes overlapping it, points inside it, the
    /// surface): cells whose inputs didn't change keep their cached output. Hashes the whole
    /// surface each call: per-cell callers should use [`Inputs::surface_hash`] once and
    /// [`Inputs::shapes_hash_in`] per cell.
    pub fn hash_in(&self, area: Area) -> u64 {
        mix_hash(self.shapes_hash_in(area), self.surface_hash())
    }

    /// The surface's hash (a heightfield is hashed in full: compute it once per input set).
    pub fn surface_hash(&self) -> u64 {
        let mut h = Fnv::default();
        match &self.surface {
            None => h.u(0),
            Some(Surface::Plane(y)) => h.f(&[*y]),
            Some(Surface::Heightfield { origin, cell, width, heights }) => {
                h.f(&[origin.x, origin.y, *cell]);
                h.u(*width as u64);
                for v in heights {
                    h.f(&[*v]);
                }
            }
        }
        h.0
    }

    /// A hash of the shapes and points within `area` (not the surface).
    pub fn shapes_hash_in(&self, area: Area) -> u64 {
        let mut h = Fnv::default();
        for (name, s) in &self.sets {
            h.str(name);
            for r in &s.rects {
                if r.aabb().overlaps(area) {
                    h.f(&[r.center.x, r.center.y, r.half.x, r.half.y, r.yaw, r.y]);
                    h.str(&r.tag);
                }
            }
            for l in &s.lines {
                let mut b = Area::EMPTY;
                for p in &l.points {
                    b = b.include(Vec2::new(p.x, p.z));
                }
                if b.overlaps(area) {
                    for p in &l.points {
                        h.f(&[p.x, p.y, p.z]);
                    }
                    h.u(l.closed as u64);
                    h.str(&l.tag);
                }
            }
            for i in 0..s.points.len() {
                let p = s.points.pos[i];
                if area.contains(Vec2::new(p.x, p.z)) {
                    h.f(&[p.x, p.y, p.z, s.points.density[i]]);
                    h.u(s.points.seed[i]);
                }
            }
        }
        h.u(1);
        h.0
    }
}

fn mix_hash(a: u64, b: u64) -> u64 {
    crate::mix64(a ^ b.rotate_left(29))
}

/// An XZ box (min inclusive, max exclusive): a cell or the area being evaluated.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Area {
    pub min: Vec2,
    pub max: Vec2,
}

impl Area {
    pub const EMPTY: Area = Area { min: Vec2::splat(f32::INFINITY), max: Vec2::splat(f32::NEG_INFINITY) };
    pub const ALL: Area = Area { min: Vec2::splat(f32::NEG_INFINITY), max: Vec2::splat(f32::INFINITY) };

    pub fn new(min: Vec2, max: Vec2) -> Area {
        Area { min, max }
    }

    /// The cell `(x, z)` of a grid of `size`.
    pub fn cell(x: i32, z: i32, size: f32) -> Area {
        let min = Vec2::new(x as f32, z as f32) * size;
        Area { min, max: min + Vec2::splat(size) }
    }

    pub fn contains(&self, p: Vec2) -> bool {
        p.x >= self.min.x && p.x < self.max.x && p.y >= self.min.y && p.y < self.max.y
    }

    pub fn overlaps(&self, o: Area) -> bool {
        self.min.x <= o.max.x && o.min.x <= self.max.x && self.min.y <= o.max.y && o.min.y <= self.max.y
    }

    pub fn expand(&self, by: f32) -> Area {
        Area { min: self.min - Vec2::splat(by), max: self.max + Vec2::splat(by) }
    }

    pub fn intersect(&self, o: Area) -> Area {
        Area { min: self.min.max(o.min), max: self.max.min(o.max) }
    }

    pub fn include(&self, p: Vec2) -> Area {
        Area { min: self.min.min(p), max: self.max.max(p) }
    }

    pub fn is_finite(&self) -> bool {
        self.min.is_finite() && self.max.is_finite()
    }
}

#[derive(Default)]
struct Fnv(u64);

impl Fnv {
    fn u(&mut self, v: u64) {
        if self.0 == 0 {
            self.0 = 0xcbf2_9ce4_8422_2325;
        }
        for b in v.to_le_bytes() {
            self.0 = (self.0 ^ b as u64).wrapping_mul(0x0100_0000_01b3);
        }
    }

    fn f(&mut self, v: &[f32]) {
        for x in v {
            self.u(x.to_bits() as u64);
        }
    }

    fn str(&mut self, s: &str) {
        self.u(str_hash(s));
    }
}
