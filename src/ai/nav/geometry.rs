//! Input geometry for baking: a world-space triangle soup, bucketed by tile.

use bevy::math::{Vec2, Vec3};
use bevy::platform::collections::HashMap;

use super::NavMeshSettings;
use super::bake::tile_bounds_with_border;

/// World-space triangles to bake from. Build it from colliders/meshes (the plugin does) or
/// directly in code: `NavGeometry::default().with_box(center, half)`.
#[derive(Clone, Debug, Default)]
pub struct NavGeometry {
    pub tris: Vec<[Vec3; 3]>,
    index: Option<TileIndex>,
}

#[derive(Clone, Debug)]
struct TileIndex {
    key: (u32, u32, u32),
    buckets: HashMap<(i32, i32), Vec<u32>>,
}

fn settings_key(s: &NavMeshSettings) -> (u32, u32, u32) {
    (s.tile_size, s.cell_size.to_bits(), s.agent_radius.to_bits())
}

impl NavGeometry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.tris.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tris.is_empty()
    }

    pub fn push_tri(&mut self, a: Vec3, b: Vec3, c: Vec3) {
        self.tris.push([a, b, c]);
        self.index = None;
    }

    /// Adds indexed triangles.
    pub fn push_indexed(&mut self, verts: &[Vec3], indices: &[[u32; 3]]) {
        for t in indices {
            self.tris.push([verts[t[0] as usize], verts[t[1] as usize], verts[t[2] as usize]]);
        }
        self.index = None;
    }

    /// Adds an axis-aligned box (12 triangles).
    pub fn push_box(&mut self, center: Vec3, half: Vec3) {
        self.push_oriented_box(center, half, bevy::math::Quat::IDENTITY);
    }

    pub fn push_oriented_box(&mut self, center: Vec3, half: Vec3, rot: bevy::math::Quat) {
        let c = |x: f32, y: f32, z: f32| center + rot * Vec3::new(x * half.x, y * half.y, z * half.z);
        let v = [
            c(-1., -1., -1.),
            c(1., -1., -1.),
            c(1., 1., -1.),
            c(-1., 1., -1.),
            c(-1., -1., 1.),
            c(1., -1., 1.),
            c(1., 1., 1.),
            c(-1., 1., 1.),
        ];
        const F: [[u32; 3]; 12] = [
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [3, 7, 6],
            [3, 6, 2],
            [0, 4, 7],
            [0, 7, 3],
            [1, 2, 6],
            [1, 6, 5],
        ];
        self.push_indexed(&v, &F);
    }

    pub fn with_box(mut self, center: Vec3, half: Vec3) -> Self {
        self.push_box(center, half);
        self
    }

    /// Adds a flat quad (two triangles) at height `y` over `[min, max]` in XZ.
    pub fn push_quad(&mut self, min: Vec2, max: Vec2, y: f32) {
        let a = Vec3::new(min.x, y, min.y);
        let b = Vec3::new(max.x, y, min.y);
        let c = Vec3::new(max.x, y, max.y);
        let d = Vec3::new(min.x, y, max.y);
        self.push_tri(a, c, b);
        self.push_tri(a, d, c);
    }

    pub fn extend(&mut self, other: &NavGeometry) {
        self.tris.extend_from_slice(&other.tris);
        self.index = None;
    }

    /// World AABB.
    pub fn bounds(&self) -> Option<(Vec3, Vec3)> {
        let mut lo = Vec3::splat(f32::MAX);
        let mut hi = Vec3::splat(f32::MIN);
        for t in &self.tris {
            for v in t {
                lo = lo.min(*v);
                hi = hi.max(*v);
            }
        }
        (!self.tris.is_empty()).then_some((lo, hi))
    }

    /// Voxel origin height for a full bake: a little below the lowest triangle, so ground-level
    /// holes still register as drops for the ledge filter.
    pub fn origin_y(&self) -> f32 {
        self.bounds().map(|(lo, _)| lo.y - 2.0).unwrap_or(0.0)
    }

    /// Every tile whose bordered bounds contain geometry.
    pub fn tile_coords(&self, s: &NavMeshSettings) -> Vec<(i32, i32)> {
        let Some((lo, hi)) = self.bounds() else { return Vec::new() };
        tiles_in(s, Vec2::new(lo.x, lo.z), Vec2::new(hi.x, hi.z))
    }

    /// Buckets triangles by tile (border included) so [`Self::tris_for_tile`] is O(bucket).
    pub fn build_index(&mut self, s: &NavMeshSettings) {
        let key = settings_key(s);
        if self.index.as_ref().is_some_and(|i| i.key == key) {
            return;
        }
        let tw = s.tile_size as f32 * s.cell_size;
        let border = ((s.agent_radius / s.cell_size).ceil() + 3.0) * s.cell_size;
        let mut buckets: HashMap<(i32, i32), Vec<u32>> = HashMap::default();
        for (i, t) in self.tris.iter().enumerate() {
            let lo = t[0].min(t[1]).min(t[2]);
            let hi = t[0].max(t[1]).max(t[2]);
            let x0 = ((lo.x - border) / tw).floor() as i32;
            let x1 = ((hi.x + border) / tw).floor() as i32;
            let z0 = ((lo.z - border) / tw).floor() as i32;
            let z1 = ((hi.z + border) / tw).floor() as i32;
            for z in z0..=z1 {
                for x in x0..=x1 {
                    buckets.entry((x, z)).or_default().push(i as u32);
                }
            }
        }
        self.index = Some(TileIndex { key, buckets });
    }

    /// Triangle indices overlapping `coord`'s bordered bounds, into `out`.
    pub fn tris_for_tile(&self, s: &NavMeshSettings, coord: (i32, i32), out: &mut Vec<u32>) {
        out.clear();
        if let Some(idx) = self.index.as_ref().filter(|i| i.key == settings_key(s)) {
            if let Some(b) = idx.buckets.get(&coord) {
                out.extend_from_slice(b);
            }
            return;
        }
        let (lo, hi) = tile_bounds_with_border(s, coord);
        for (i, t) in self.tris.iter().enumerate() {
            let tlo = t[0].min(t[1]).min(t[2]);
            let thi = t[0].max(t[1]).max(t[2]);
            if thi.x >= lo.x && tlo.x <= hi.x && thi.z >= lo.y && tlo.z <= hi.y {
                out.push(i as u32);
            }
        }
    }
}

/// Tiles whose bordered bounds overlap the XZ box `[lo, hi]`.
pub fn tiles_in(s: &NavMeshSettings, lo: Vec2, hi: Vec2) -> Vec<(i32, i32)> {
    let tw = s.tile_size as f32 * s.cell_size;
    let border = ((s.agent_radius / s.cell_size).ceil() + 3.0) * s.cell_size;
    let x0 = ((lo.x - border) / tw).floor() as i32;
    let x1 = ((hi.x + border) / tw).floor() as i32;
    let z0 = ((lo.y - border) / tw).floor() as i32;
    let z1 = ((hi.y + border) / tw).floor() as i32;
    let mut v = Vec::with_capacity(((x1 - x0 + 1) * (z1 - z0 + 1)).max(0) as usize);
    for z in z0..=z1 {
        for x in x0..=x1 {
            v.push((x, z));
        }
    }
    v
}
