//! Terrain: a [`Heightfield`] cut into square chunks, drawn with geomipmapping (each chunk picks
//! a level by screen-space error, meshes built in background tasks), crack-free through skirts
//! whose depth is computed from the actual edge errors, and (feature `physics`) one avian
//! heightfield collider per chunk that matches the full-detail mesh exactly.
//!
//! LOD `n` draws every `2^n`-th sample. A chunk switches to the coarsest LOD whose worst height
//! error, projected at the chunk's distance, stays under [`TerrainSettings::pixel_error`]
//! (and never below `lod_distance · 2^(n-1)` metres), with hysteresis when coarsening.
//!
//! Seams: neighbours may be at different LODs, which leaves T-junction gaps along shared edges.
//! Each chunk hangs a vertical skirt below its border, deep enough to cover the largest
//! possible mismatch (`edge error at my LOD + worst edge error at any LOD`, per edge), so no
//! gap is ever visible; vertex normals come from the full-res heightfield, so lighting is
//! continuous across seams.

use std::sync::Arc;

use bevy::asset::RenderAssetUsages;
use bevy::camera::primitives::Aabb;
use bevy::camera::visibility::NoAutoAabb;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;
use bevy::tasks::{AsyncComputeTaskPool, Task, futures::check_ready};

use super::heightfield::Heightfield;
use super::{TerrainSettings, WorldCpu, WorldOrigin, WorldRoot, WorldSettings, WorldStats, WorldSystems};
use crate::gfx::MainCamera;
use crate::render_budget::{KeepDetail, Scenery};

/// Most LOD levels a chunk can have (chunk quads ≤ 2^(MAX_LODS-1)).
pub const MAX_LODS: usize = 8;

/// Per-chunk data computed once: bounds, LOD errors and skirt depths.
#[derive(Clone, Debug, Default)]
pub struct ChunkInfo {
    pub min_h: f32,
    pub max_h: f32,
    /// Worst |full-res height − LOD surface| over the chunk, per LOD.
    pub err: [f32; MAX_LODS],
    /// Skirt depth per LOD (covers any neighbour LOD).
    pub skirt: [f32; MAX_LODS],
}

/// The world's terrain: heights, chunk layout, per-chunk LOD data and queries.
#[derive(Resource, Clone)]
pub struct Terrain {
    hf: Arc<Heightfield>,
    chunk_quads: u32,
    chunks_x: u32,
    chunks_z: u32,
    lods: u8,
    info: Arc<Vec<ChunkInfo>>,
}

impl Terrain {
    /// Chunks `chunk_quads` samples wide (a power of two, 8..=128). The heightfield is padded
    /// (edge samples repeated) up to a multiple of the chunk size.
    pub fn new(hf: Heightfield, chunk_quads: u32) -> Self {
        let q = chunk_quads.clamp(8, 1 << (MAX_LODS - 1)).next_power_of_two();
        let hf = pad(hf, q);
        let chunks_x = (hf.nx() - 1) / q;
        let chunks_z = (hf.nz() - 1) / q;
        let lods = (q.trailing_zeros() as u8 + 1).min(MAX_LODS as u8);
        let info = chunk_infos(&hf, q, chunks_x, chunks_z, lods);
        Terrain { hf: Arc::new(hf), chunk_quads: q, chunks_x, chunks_z, lods, info: Arc::new(info) }
    }

    pub fn heightfield(&self) -> &Heightfield {
        &self.hf
    }
    pub(crate) fn heightfield_arc(&self) -> Arc<Heightfield> {
        self.hf.clone()
    }
    /// Quads per chunk side.
    pub fn chunk_quads(&self) -> u32 {
        self.chunk_quads
    }
    /// Chunk side in metres.
    pub fn chunk_size(&self) -> f32 {
        self.chunk_quads as f32 * self.hf.spacing()
    }
    pub fn chunks(&self) -> UVec2 {
        UVec2::new(self.chunks_x, self.chunks_z)
    }
    pub fn chunk_count(&self) -> usize {
        (self.chunks_x * self.chunks_z) as usize
    }
    /// LOD levels per chunk.
    pub fn lod_count(&self) -> u8 {
        self.lods
    }
    pub fn chunk_info(&self, c: UVec2) -> &ChunkInfo {
        &self.info[(c.y * self.chunks_x + c.x) as usize]
    }
    /// Absolute XZ of a chunk's min corner.
    pub fn chunk_origin(&self, c: UVec2) -> Vec2 {
        self.hf.origin() + c.as_vec2() * self.chunk_size()
    }
    /// Chunk containing absolute `(x, z)` (clamped).
    pub fn chunk_at(&self, x: f32, z: f32) -> UVec2 {
        let l = (Vec2::new(x, z) - self.hf.origin()) / self.chunk_size();
        UVec2::new((l.x.max(0.0) as u32).min(self.chunks_x - 1), (l.y.max(0.0) as u32).min(self.chunks_z - 1))
    }
    /// Absolute min/max corners of the terrain.
    pub fn bounds(&self) -> (Vec2, Vec2) {
        (self.hf.origin(), self.hf.origin() + self.hf.size())
    }

    // Queries (absolute coordinates) — see [`Heightfield`].
    pub fn height_at(&self, x: f32, z: f32) -> f32 {
        self.hf.height_at(x, z)
    }
    pub fn normal_at(&self, x: f32, z: f32) -> Vec3 {
        self.hf.smooth_normal_at(x, z)
    }
    pub fn slope_deg(&self, x: f32, z: f32) -> f32 {
        self.hf.slope_deg(x, z)
    }
    pub fn raycast(&self, origin: Vec3, dir: Vec3, max_dist: f32) -> Option<Vec3> {
        self.hf.raycast(origin, dir, max_dist)
    }
    /// `p` (absolute) put on the ground, plus `up` metres.
    pub fn on_ground(&self, p: Vec2, up: f32) -> Vec3 {
        Vec3::new(p.x, self.height_at(p.x, p.y) + up, p.y)
    }
}

/// Repeats the last row/column until `(n - 1)` is a multiple of `q` on both axes.
fn pad(hf: Heightfield, q: u32) -> Heightfield {
    let want = |n: u32| (n - 1).div_ceil(q) * q + 1;
    let (nx, nz) = (want(hf.nx()), want(hf.nz()));
    if (nx, nz) == (hf.nx(), hf.nz()) {
        return hf;
    }
    let mut h = Vec::with_capacity((nx * nz) as usize);
    for iz in 0..nz {
        for ix in 0..nx {
            h.push(hf.get(ix as i64, iz as i64));
        }
    }
    Heightfield::from_heights(nx, nz, hf.spacing(), hf.origin(), h)
}

/// Max |fine − linear interpolation at stride `step`| over samples `samples[0..]`.
fn polyline_err(samples: &[f32], step: usize) -> f32 {
    let mut e: f32 = 0.0;
    for seg in 0..(samples.len() - 1) / step {
        let (a, b) = (samples[seg * step], samples[(seg + 1) * step]);
        for k in 1..step {
            let t = k as f32 / step as f32;
            e = e.max((samples[seg * step + k] - (a + (b - a) * t)).abs());
        }
    }
    e
}

fn chunk_infos(hf: &Heightfield, q: u32, cx_n: u32, cz_n: u32, lods: u8) -> Vec<ChunkInfo> {
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let total = (cx_n * cz_n) as usize;
    let mut out = vec![ChunkInfo::default(); total];
    let per = total.div_ceil(threads).max(1);
    std::thread::scope(|s| {
        for (bi, block) in out.chunks_mut(per).enumerate() {
            s.spawn(move || {
                for (k, info) in block.iter_mut().enumerate() {
                    let idx = bi * per + k;
                    let c = UVec2::new(idx as u32 % cx_n, idx as u32 / cx_n);
                    *info = chunk_info(hf, q, c, lods);
                }
            });
        }
    });
    out
}

fn chunk_info(hf: &Heightfield, q: u32, c: UVec2, lods: u8) -> ChunkInfo {
    let (x0, z0) = ((c.x * q) as i64, (c.y * q) as i64);
    let n = q as i64;
    let mut info = ChunkInfo { min_h: f32::MAX, max_h: f32::MIN, ..default() };
    for iz in z0..=z0 + n {
        for ix in x0..=x0 + n {
            let h = hf.get(ix, iz);
            info.min_h = info.min_h.min(h);
            info.max_h = info.max_h.max(h);
        }
    }
    // Surface error per LOD (exact: the fine surface is piecewise linear between samples).
    for l in 1..lods as usize {
        let step = 1u32 << l;
        let mut e: f32 = 0.0;
        for iz in z0..=z0 + n {
            for ix in x0..=x0 + n {
                let p = hf.sample_pos(ix as u32, iz as u32);
                e = e.max((hf.get(ix, iz) - hf.height_at_step(p.x, p.y, step)).abs());
            }
        }
        info.err[l] = e;
    }
    // Edge errors per edge and LOD → skirt depths.
    let edges: [Vec<f32>; 4] = [
        (0..=n).map(|i| hf.get(x0 + i, z0)).collect(),
        (0..=n).map(|i| hf.get(x0 + i, z0 + n)).collect(),
        (0..=n).map(|i| hf.get(x0, z0 + i)).collect(),
        (0..=n).map(|i| hf.get(x0 + n, z0 + i)).collect(),
    ];
    let mut edge_err = [[0.0f32; MAX_LODS]; 4];
    for (errs, samples) in edge_err.iter_mut().zip(edges.iter()) {
        for (l, err) in errs.iter_mut().enumerate().take(lods as usize).skip(1) {
            *err = polyline_err(samples, 1 << l);
        }
    }
    let margin = 0.1 + hf.spacing() * 0.05;
    for l in 0..lods as usize {
        let mut d: f32 = 0.0;
        for ee in &edge_err {
            let worst = ee.iter().copied().fold(0.0, f32::max);
            d = d.max(ee[l] + worst);
        }
        info.skirt[l] = d + margin;
    }
    info
}

/// Builds a chunk's mesh at `lod` with skirts `skirt` metres deep. Positions are relative to the
/// chunk's min corner (absolute XZ at `terrain.chunk_origin(c)`, absolute heights).
pub fn build_chunk_mesh(hf: &Heightfield, chunk_quads: u32, c: UVec2, lod: u8, skirt: f32) -> Mesh {
    let step = 1u32 << lod;
    let m = (chunk_quads / step) as usize; // quads per side at this LOD
    let side = m + 1;
    let (x0, z0) = (c.x * chunk_quads, c.y * chunk_quads);
    let s = hf.spacing();
    let mut pos: Vec<[f32; 3]> = Vec::with_capacity(side * side + 4 * side);
    let mut nrm: Vec<[f32; 3]> = Vec::with_capacity(side * side + 4 * side);
    for j in 0..side {
        for i in 0..side {
            let (ix, iz) = (x0 + i as u32 * step, z0 + j as u32 * step);
            let h = hf.get(ix as i64, iz as i64);
            pos.push([(i as u32 * step) as f32 * s, h, (j as u32 * step) as f32 * s]);
            nrm.push(hf.sample_normal(ix as i64, iz as i64).to_array());
        }
    }
    let mut idx: Vec<u32> = Vec::with_capacity(m * m * 6 + 4 * m * 6);
    for j in 0..m {
        for i in 0..m {
            let a = (j * side + i) as u32;
            let b = a + 1;
            let c2 = a + side as u32;
            let d = c2 + 1;
            idx.extend_from_slice(&[a, c2, b, c2, d, b]);
        }
    }
    if skirt > 0.0 {
        // (border vertex indices in order, outward direction)
        let edges: [(Vec<u32>, Vec3); 4] = [
            ((0..side).map(|i| i as u32).collect(), Vec3::NEG_Z),
            ((0..side).map(|i| ((side - 1) * side + i) as u32).collect(), Vec3::Z),
            ((0..side).map(|j| (j * side) as u32).collect(), Vec3::NEG_X),
            ((0..side).map(|j| (j * side + side - 1) as u32).collect(), Vec3::X),
        ];
        for (border, out) in edges {
            let base = pos.len() as u32;
            for &v in &border {
                let p = pos[v as usize];
                pos.push([p[0], p[1] - skirt, p[2]]);
                nrm.push(nrm[v as usize]);
            }
            for k in 0..border.len() - 1 {
                let (t0, t1) = (border[k], border[k + 1]);
                let (b0, b1) = (base + k as u32, base + k as u32 + 1);
                // Orient so the face points outward.
                let p = |i: u32| Vec3::from(pos[i as usize]);
                let n = (p(t1) - p(t0)).cross(p(b0) - p(t0));
                if n.dot(out) >= 0.0 {
                    idx.extend_from_slice(&[t0, t1, b0, t1, b1, b0]);
                } else {
                    idx.extend_from_slice(&[t0, b0, t1, t1, b0, b1]);
                }
            }
        }
    }
    let indices = if pos.len() <= u16::MAX as usize { Indices::U16(idx.iter().map(|&i| i as u16).collect()) } else { Indices::U32(idx) };
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::RENDER_WORLD)
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, nrm)
        .with_inserted_indices(indices)
}

/// Triangles of a chunk mesh at `lod` (surface + skirts).
pub fn chunk_triangles(chunk_quads: u32, lod: u8) -> u64 {
    let m = (chunk_quads >> lod) as u64;
    m * m * 2 + 4 * m * 2
}

/// Rough GPU bytes of a chunk mesh at `lod` (24 B/vertex + indices).
fn chunk_bytes(chunk_quads: u32, lod: u8) -> u64 {
    let side = ((chunk_quads >> lod) + 1) as u64;
    let verts = side * side + 4 * side;
    verts * 24 + chunk_triangles(chunk_quads, lod) * 3 * if verts <= u16::MAX as u64 { 2 } else { 4 }
}

/// LOD for a chunk at distance `d` (metres), given the current one (hysteresis when coarsening).
pub fn pick_lod(info: &ChunkInfo, lods: u8, d: f32, cur: Option<u8>, s: &TerrainSettings, chunk_size: f32) -> u8 {
    let max = lods.saturating_sub(1).min(s.max_lod);
    let lod_d = if s.lod_distance > 0.0 { s.lod_distance } else { chunk_size };
    let pick = |d: f32| -> u8 {
        let allowed_err = d.max(1.0) * s.pixel_error.max(0.01) / s.screen_scale.max(1.0);
        let dist_cap = if d <= lod_d { 0 } else { ((d / lod_d).log2().floor() as i32 + 1).clamp(0, max as i32) as u8 };
        let mut l = 0;
        while l < dist_cap && info.err[l as usize + 1] <= allowed_err {
            l += 1;
        }
        l
    };
    let fine = pick(d);
    match cur {
        None => fine,
        Some(c) if fine < c => fine,
        Some(c) => pick(d / (1.0 + s.hysteresis)).max(c).min(fine),
    }
}

/// XYZ distance from `eye` to a chunk's box (0 inside).
fn chunk_distance(t: &Terrain, c: UVec2, eye: Vec3) -> f32 {
    let o = t.chunk_origin(c);
    let i = t.chunk_info(c);
    let min = Vec3::new(o.x, i.min_h, o.y);
    let max = Vec3::new(o.x + t.chunk_size(), i.max_h, o.y + t.chunk_size());
    (eye.clamp(min, max) - eye).length()
}

/// A terrain chunk's visual entity.
#[derive(Component, Clone, Copy, Debug)]
pub struct TerrainChunk {
    pub coord: UVec2,
    pub lod: u8,
}

/// A terrain chunk's heightfield collider (resident mode, or under a loaded cell).
#[derive(Component, Clone, Copy, Debug)]
pub struct TerrainCollider {
    pub coord: UVec2,
}

/// Material the chunks are drawn with (inserted by the spawner when rendering is available).
#[derive(Resource, Clone)]
pub enum TerrainLook {
    Splat(Handle<super::TerrainMaterial>),
    Standard(Handle<StandardMaterial>),
}

#[derive(Default)]
pub(crate) struct ChunkRt {
    entity: Option<Entity>,
    lod: Option<u8>,
    task: Option<(u8, Task<Mesh>)>,
    hidden: bool,
}

/// Runtime chunk state.
#[derive(Resource, Default)]
pub(crate) struct TerrainChunks {
    rt: Vec<ChunkRt>,
    todo: Vec<(f32, u32, u8)>,
}

pub(super) struct TerrainPlugin;

impl Plugin for TerrainPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<TerrainChunks>().add_systems(PostUpdate, terrain_lod.in_set(WorldSystems::Terrain));
    }
}

fn terrain_lod(
    mut commands: Commands,
    terrain: Option<Res<Terrain>>,
    look: Option<Res<TerrainLook>>,
    settings: Res<WorldSettings>,
    origin: Res<WorldOrigin>,
    cams: Query<&GlobalTransform, With<MainCamera>>,
    roots: Query<Entity, With<WorldRoot>>,
    mut chunks: ResMut<TerrainChunks>,
    mut meshes: Option<ResMut<Assets<Mesh>>>,
    mut vis: Query<&mut Visibility, With<TerrainChunk>>,
    mut stats: ResMut<WorldStats>,
    cpu: Res<WorldCpu>,
) {
    let _t = cpu.time();
    let (Some(t), Some(look), Some(meshes)) = (terrain, look, meshes.as_mut()) else { return };
    let Some(root) = roots.iter().next() else { return };
    let Some(eye) = super::camera_abs(&cams, &origin) else { return };
    let s = &settings.terrain;
    let chunks = &mut *chunks;
    if chunks.rt.len() != t.chunk_count() {
        chunks.rt = (0..t.chunk_count()).map(|_| ChunkRt::default()).collect();
    }
    // Finished builds → swap meshes.
    let mut in_flight = 0;
    let mut lods = [0u32; 8];
    let (mut tris, mut bytes, mut drawn) = (0u64, 0u64, 0u32);
    chunks.todo.clear();
    for (i, rt) in chunks.rt.iter_mut().enumerate() {
        let c = UVec2::new(i as u32 % t.chunks().x, i as u32 / t.chunks().x);
        if let Some((lod, task)) = rt.task.as_mut()
            && let Some(mesh) = check_ready(task)
        {
            let lod = *lod;
            rt.task = None;
            let info = t.chunk_info(c);
            let aabb = Aabb::from_min_max(Vec3::new(0.0, info.min_h - info.skirt[lod as usize], 0.0), Vec3::new(t.chunk_size(), info.max_h, t.chunk_size()));
            let h = meshes.add(mesh);
            match rt.entity {
                Some(e) => {
                    commands.entity(e).insert((Mesh3d(h), TerrainChunk { coord: c, lod }, aabb));
                }
                None => {
                    let o = t.chunk_origin(c);
                    let mut ec = commands.spawn((
                        Name::new(format!("terrain {} {}", c.x, c.y)),
                        TerrainChunk { coord: c, lod },
                        Mesh3d(h),
                        aabb,
                        NoAutoAabb,
                        Transform::from_xyz(o.x, 0.0, o.y),
                        Visibility::default(),
                        Scenery,
                        KeepDetail,
                        ChildOf(root),
                    ));
                    match &*look {
                        TerrainLook::Splat(m) => ec.insert(MeshMaterial3d(m.clone())),
                        TerrainLook::Standard(m) => ec.insert(MeshMaterial3d(m.clone())),
                    };
                    rt.entity = Some(ec.id());
                }
            }
            rt.lod = Some(lod);
        }
        if rt.task.is_some() {
            in_flight += 1;
        }
        let d = chunk_distance(&t, c, eye);
        let hide = d > s.view_distance;
        if hide != rt.hidden
            && let Some(e) = rt.entity
            && let Ok(mut v) = vis.get_mut(e)
        {
            *v = if hide { Visibility::Hidden } else { Visibility::Inherited };
            rt.hidden = hide;
        }
        if let Some(l) = rt.lod {
            lods[l as usize] += 1;
            bytes += chunk_bytes(t.chunk_quads(), l);
            if !rt.hidden {
                drawn += 1;
                tris += chunk_triangles(t.chunk_quads(), l);
            }
        }
        if hide && rt.lod.is_some() {
            continue;
        }
        let want = pick_lod(t.chunk_info(c), t.lod_count(), d, rt.lod, s, t.chunk_size());
        if rt.task.is_none() && rt.lod != Some(want) {
            chunks.todo.push((d, i as u32, want));
        }
    }
    // Nearest first, a budget of background builds.
    chunks.todo.sort_by(|a, b| a.0.total_cmp(&b.0));
    let pool = AsyncComputeTaskPool::get();
    for &(_, i, lod) in chunks.todo.iter() {
        if in_flight >= s.max_builds_in_flight {
            break;
        }
        let c = UVec2::new(i % t.chunks().x, i / t.chunks().x);
        let hf = t.heightfield_arc();
        let (q, skirt) = (t.chunk_quads(), t.chunk_info(c).skirt[lod as usize]);
        chunks.rt[i as usize].task = Some((lod, pool.spawn(async move { build_chunk_mesh(&hf, q, c, lod, skirt) })));
        in_flight += 1;
    }
    stats.terrain_chunks = t.chunk_count() as u32;
    stats.terrain_chunks_drawn = drawn;
    stats.terrain_lods = lods;
    stats.terrain_triangles = tris;
    stats.terrain_builds_in_flight = in_flight as u32;
    stats.terrain_mesh_bytes = bytes;
    stats.heightfield_bytes = t.heightfield().memory_bytes() as u64;
}

/// Heightfield collider for chunk `c`: `(collider, absolute centre of the chunk at y = 0)`.
#[cfg(feature = "physics")]
pub fn chunk_collider(t: &Terrain, c: UVec2) -> (avian3d::prelude::Collider, Vec3) {
    let q = t.chunk_quads();
    let (x0, z0) = ((c.x * q) as i64, (c.y * q) as i64);
    region_collider(t.heightfield(), x0, z0, q as i64, q as i64)
}

/// Heightfield collider for samples `[x0, x0+w] × [z0, z0+h]` of `hf`.
#[cfg(feature = "physics")]
pub fn region_collider(hf: &Heightfield, x0: i64, z0: i64, w: i64, h: i64) -> (avian3d::prelude::Collider, Vec3) {
    use avian3d::parry::shape::SharedShape;
    use avian3d::parry::utils::Array2;
    let (nrows, ncols) = ((h + 1) as usize, (w + 1) as usize);
    // parry: row = z, column = x, column-major storage.
    let mut data = Vec::with_capacity(nrows * ncols);
    for ix in 0..ncols as i64 {
        for iz in 0..nrows as i64 {
            data.push(hf.get(x0 + ix, z0 + iz));
        }
    }
    let s = hf.spacing();
    let size = Vec3::new(w as f32 * s, 1.0, h as f32 * s);
    let shape = SharedShape::heightfield(Array2::new(nrows, ncols, data), size);
    let o = hf.origin() + Vec2::new(x0 as f32, z0 as f32) * s;
    (shape.into(), Vec3::new(o.x + size.x * 0.5, 0.0, o.y + size.z * 0.5))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::mesh::VertexAttributeValues;

    fn rough() -> Heightfield {
        Heightfield::from_fn(65, 65, 2.0, Vec2::ZERO, |x, z| (x * 0.21).sin() * 6.0 + (z * 0.13).cos() * 9.0 + ((x + z) * 0.7).sin() * 1.5)
    }

    fn positions(m: &Mesh) -> &Vec<[f32; 3]> {
        match m.attribute(Mesh::ATTRIBUTE_POSITION) {
            Some(VertexAttributeValues::Float32x3(p)) => p,
            _ => panic!(),
        }
    }

    #[test]
    fn pads_and_lays_out_chunks() {
        let hf = Heightfield::flat(100, 40, 1.0, Vec2::new(-50.0, 0.0), 1.0);
        let t = Terrain::new(hf, 32);
        assert_eq!(t.chunks(), UVec2::new(4, 2));
        assert_eq!(t.heightfield().nx(), 129);
        assert_eq!(t.lod_count(), 6);
        assert_eq!(t.chunk_at(-49.0, 39.0), UVec2::new(0, 1));
        assert_eq!(t.chunk_origin(UVec2::new(1, 1)), Vec2::new(-18.0, 32.0));
    }

    #[test]
    fn errors_grow_and_flat_chunks_are_exact() {
        let t = Terrain::new(rough(), 32);
        let i = t.chunk_info(UVec2::ZERO);
        assert_eq!(i.err[0], 0.0);
        assert!(i.err[5] > i.err[1] && i.err[1] > 0.0);
        let flat = Terrain::new(Heightfield::flat(65, 65, 1.0, Vec2::ZERO, 3.0), 32);
        assert!(flat.chunk_info(UVec2::ONE).err.iter().all(|e| *e == 0.0));
        // A flat chunk is coarsest right away; a rough one stays detailed up close.
        let s = TerrainSettings::default();
        assert_eq!(pick_lod(flat.chunk_info(UVec2::ZERO), 6, 1000.0, None, &s, 32.0), 5);
        assert_eq!(pick_lod(i, 6, 1.0, None, &s, 64.0), 0);
        assert!(pick_lod(i, 6, 5000.0, None, &s, 64.0) >= 1);
        assert!(pick_lod(i, 6, 5000.0, None, &s, 64.0) >= pick_lod(i, 6, 500.0, None, &s, 64.0));
    }

    #[test]
    fn lod_hysteresis() {
        let t = Terrain::new(rough(), 32);
        let i = t.chunk_info(UVec2::ZERO);
        let s = TerrainSettings { pixel_error: 1000.0, ..default() }; // distance-limited only
        // lod_distance = 64: LOD 1 from 64 m, LOD 2 from 128 m.
        assert_eq!(pick_lod(i, 6, 130.0, None, &s, 64.0), 2);
        // Coming from LOD 1 at 130 m: 130/1.15 < 128 → stays at 1.
        assert_eq!(pick_lod(i, 6, 130.0, Some(1), &s, 64.0), 1);
        assert_eq!(pick_lod(i, 6, 150.0, Some(1), &s, 64.0), 2);
        // Refines immediately.
        assert_eq!(pick_lod(i, 6, 70.0, Some(2), &s, 64.0), 1);
    }

    #[test]
    fn mesh_counts_and_same_lod_seams_match() {
        let t = Terrain::new(rough(), 32);
        let hf = t.heightfield();
        for lod in 0..t.lod_count() {
            let m = build_chunk_mesh(hf, 32, UVec2::ZERO, lod, 1.0);
            let side = (32 >> lod) as usize + 1;
            assert_eq!(m.count_vertices(), side * side + 4 * side);
            assert_eq!(m.indices().unwrap().len() as u64, chunk_triangles(32, lod) * 3);
        }
        // Shared edge x = 32 quads between chunk (0,0) and (1,0) at the same LOD: identical
        // world positions and normals.
        let a = build_chunk_mesh(hf, 32, UVec2::new(0, 0), 1, 0.0);
        let b = build_chunk_mesh(hf, 32, UVec2::new(1, 0), 1, 0.0);
        let (pa, pb) = (positions(&a), positions(&b));
        let side = 17;
        let off = t.chunk_size();
        for j in 0..side {
            let va = pa[j * side + side - 1];
            let vb = pb[j * side];
            assert_eq!(va[0], vb[0] + off);
            assert_eq!(va[1], vb[1]);
            assert_eq!(va[2], vb[2]);
        }
    }

    /// Crack-free: along every shared edge, for every pair of neighbour LODs, the height gap
    /// between the two edge polylines is covered by the higher side's skirt.
    #[test]
    fn skirts_cover_every_lod_mismatch() {
        let t = Terrain::new(rough(), 16);
        let hf = t.heightfield();
        let s = hf.spacing();
        let n = t.chunks();
        for cz in 0..n.y {
            for cx in 0..n.x - 1 {
                let (a, b) = (UVec2::new(cx, cz), UVec2::new(cx + 1, cz));
                let x = t.chunk_origin(b).x;
                for la in 0..t.lod_count() {
                    for lb in 0..t.lod_count() {
                        let z0 = t.chunk_origin(a).y;
                        for k in 0..=64 {
                            let z = z0 + t.chunk_size() * k as f32 / 64.0;
                            let ha = hf.height_at_step(x - 1e-3 * s, z, 1 << la);
                            let hb = hf.height_at_step(x + 1e-3 * s, z, 1 << lb);
                            let gap = (ha - hb).abs();
                            let cover = if ha > hb { t.chunk_info(a).skirt[la as usize] } else { t.chunk_info(b).skirt[lb as usize] };
                            assert!(gap <= cover + 1e-3, "chunk {a} lod {la} vs {b} lod {lb} at z {z}: gap {gap} > skirt {cover}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn skirts_face_outward() {
        let hf = rough();
        let m = build_chunk_mesh(&hf, 32, UVec2::ZERO, 2, 2.0);
        let p = positions(&m);
        let Some(Indices::U16(ix)) = m.indices() else { panic!("u16 indices") };
        let side = 9;
        let surface_tris = 8 * 8 * 2;
        let center = Vec3::new(32.0, 0.0, 32.0);
        for tri in ix.chunks(3).skip(surface_tris) {
            let [a, b, c] = [tri[0], tri[1], tri[2]].map(|i| Vec3::from(p[i as usize]));
            let n = (b - a).cross(c - a);
            let mid = (a + b + c) / 3.0;
            let out = (mid - center).with_y(0.0);
            assert!(n.dot(out) > 0.0, "skirt triangle faces inward");
            assert!(tri.iter().any(|&i| i as usize >= side * side));
        }
        // Surface triangles face up.
        for tri in ix.chunks(3).take(surface_tris) {
            let [a, b, c] = [tri[0], tri[1], tri[2]].map(|i| Vec3::from(p[i as usize]));
            assert!((b - a).cross(c - a).y > 0.0);
        }
    }
}
