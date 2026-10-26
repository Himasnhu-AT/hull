//! ECS side of baking: which entities feed the navmesh, dirty-tile tracking when they change,
//! and the background bake jobs whose results are applied when ready.
//!
//! Sources: every avian [`Collider`] on a static body (or no body), except [`Sensor`]s,
//! [`NavIgnore`] entities and nav agents. Kinematic/dynamic colliders and plain `Mesh3d`s join
//! with [`NavSource`]. Moving/adding/removing a source marks the tiles under its old and new
//! bounds dirty; after [`super::super::AiConfig::rebake_delay`] those tiles are rebaked off the
//! main thread (`AsyncComputeTaskPool`) and swapped in.

use std::sync::Arc;
use std::time::Instant;

use avian3d::collision::collider::trimesh_builder::TrimeshBuilder;
use avian3d::prelude::{Collider, RigidBody, Sensor};
use bevy::platform::collections::{HashMap, HashSet};
use bevy::prelude::*;
use bevy::tasks::{AsyncComputeTaskPool, Task, block_on, poll_once};

use super::bake::{BakeOutput, BakeStats, bake_tiles};
use super::geometry::{NavGeometry, tiles_in};
use super::mesh::{NavMesh, OffMeshLink};
use crate::ai::AiConfig;
use crate::ai::agent::NavAgent;

/// Keep this entity's collider/mesh out of the navmesh.
#[derive(Component, Clone, Copy, Debug, Default, Reflect)]
pub struct NavIgnore;

/// Bake this entity even though it's kinematic/dynamic, or bake its `Mesh3d` (no collider).
#[derive(Component, Clone, Copy, Debug, Default, Reflect)]
pub struct NavSource;

/// An off-mesh link defined in code: spawn `NavLink(OffMeshLink { start, end, .. })` (world
/// space). Added to every agent type's mesh; removed with the entity.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct NavLink(pub OffMeshLink);

/// Sent when tiles of a mesh were (re)baked or removed.
#[derive(Message, Clone, Debug)]
pub struct NavMeshChanged {
    pub agent_type: usize,
    pub tiles: Vec<(i32, i32)>,
}

/// The baked meshes, one per [`AiConfig::agent_types`] entry.
#[derive(Resource, Default)]
pub struct NavMeshes {
    pub meshes: Vec<NavMesh>,
    /// Stats of the last finished bake job.
    pub last_bake: BakeStats,
    /// Main-thread time spent gathering geometry for the last job (µs).
    pub last_gather_us: u64,
    /// Finished bake jobs.
    pub generation: u64,
    baking: bool,
    full_requested: bool,
}

impl NavMeshes {
    pub fn get(&self, agent_type: usize) -> Option<&NavMesh> {
        self.meshes.get(agent_type)
    }
    /// The first agent type's mesh.
    pub fn primary(&self) -> &NavMesh {
        &self.meshes[0]
    }
    /// A bake job is running or dirty tiles wait for one.
    pub fn is_baking(&self) -> bool {
        self.baking
    }
    /// At least one bake finished and nothing is pending.
    pub fn is_ready(&self) -> bool {
        self.generation > 0 && !self.baking
    }
    /// Rebakes every tile on the next frame.
    pub fn request_full_rebake(&mut self) {
        self.full_requested = true;
        self.baking = true;
    }
}

struct SourceEntry {
    lo: Vec3,
    hi: Vec3,
    tris: Arc<Vec<[Vec3; 3]>>,
}

/// Triangles of every navmesh source (world space), cached per entity, plus dirty regions.
#[derive(Resource, Default)]
pub struct SourceCache {
    entries: HashMap<Entity, SourceEntry>,
    /// Dirty XZ regions since the last job.
    dirty: Vec<(Vec2, Vec2)>,
    last_change: f64,
    pending_meshes: HashSet<Entity>,
    warned_unsupported: bool,
}

impl SourceCache {
    pub fn source_count(&self) -> usize {
        self.entries.len()
    }
    pub fn triangle_count(&self) -> usize {
        self.entries.values().map(|e| e.tris.len()).sum()
    }
}

type BakeTask = Task<(usize, BakeOutput)>;

#[derive(Resource, Default)]
pub(crate) struct BakeJobs {
    tasks: Vec<BakeTask>,
    results: Vec<(usize, BakeOutput)>,
    started: Option<Instant>,
}

fn aabb(tris: &[[Vec3; 3]]) -> (Vec3, Vec3) {
    let mut lo = Vec3::splat(f32::MAX);
    let mut hi = Vec3::splat(f32::MIN);
    for t in tris {
        for v in t {
            lo = lo.min(*v);
            hi = hi.max(*v);
        }
    }
    (lo, hi)
}

fn collider_tris(c: &Collider, gt: &GlobalTransform) -> Result<Vec<[Vec3; 3]>, String> {
    let tm = TrimeshBuilder::new(c.shape().clone()).build().map_err(|e| e.to_string())?;
    let m = gt.affine();
    Ok(tm
        .indices
        .iter()
        .map(|i| [m.transform_point3(tm.vertices[i[0] as usize]), m.transform_point3(tm.vertices[i[1] as usize]), m.transform_point3(tm.vertices[i[2] as usize])])
        .collect())
}

fn mesh_tris(mesh: &Mesh, gt: &GlobalTransform) -> Option<Vec<[Vec3; 3]>> {
    let pos = mesh.try_attribute(Mesh::ATTRIBUTE_POSITION).ok()?.as_float3()?;
    let m = gt.affine();
    let v = |i: usize| m.transform_point3(Vec3::from(pos[i]));
    let mut out = Vec::new();
    match mesh.try_indices_option().ok().flatten() {
        Some(idx) => {
            let idx: Vec<usize> = idx.iter().collect();
            for t in idx.chunks_exact(3) {
                out.push([v(t[0]), v(t[1]), v(t[2])]);
            }
        }
        None => {
            for i in (0..pos.len() / 3 * 3).step_by(3) {
                out.push([v(i), v(i + 1), v(i + 2)]);
            }
        }
    }
    Some(out)
}

/// Keeps [`SourceCache`] in sync with colliders/meshes and records dirty regions.
pub(crate) fn track_sources(
    colliders: Query<
        (Entity, &Collider, &GlobalTransform, Option<&RigidBody>, Has<NavSource>),
        (Without<NavIgnore>, Without<NavAgent>, Without<Sensor>, Or<(Changed<GlobalTransform>, Changed<Collider>, Added<NavSource>)>),
    >,
    meshes_q: Query<(Entity, &Mesh3d, &GlobalTransform), (With<NavSource>, Without<Collider>, Without<NavIgnore>)>,
    changed_meshes: Query<Entity, (With<NavSource>, Without<Collider>, Or<(Changed<GlobalTransform>, Changed<Mesh3d>, Added<NavSource>)>)>,
    mesh_assets: Option<Res<Assets<Mesh>>>,
    mut removed_colliders: RemovedComponents<Collider>,
    mut removed_sources: RemovedComponents<NavSource>,
    mut added_ignore: Query<Entity, Added<NavIgnore>>,
    mut cache: ResMut<SourceCache>,
    time: Res<Time<Real>>,
) {
    let now = time.elapsed_secs_f64();
    let mut changed = false;
    let cache = &mut *cache;
    for (e, c, gt, rb, forced) in &colliders {
        let include = forced || rb.is_none_or(|r| r.is_static());
        if !include {
            if let Some(old) = cache.entries.remove(&e) {
                cache.dirty.push((old.lo.xz(), old.hi.xz()));
                changed = true;
            }
            continue;
        }
        match collider_tris(c, gt) {
            Ok(tris) => {
                let (lo, hi) = aabb(&tris);
                if let Some(old) = cache.entries.get(&e) {
                    if old.lo == lo && old.hi == hi && old.tris.len() == tris.len() {
                        // Same place: typically avian touching GlobalTransform without moving.
                        if old.tris.as_slice() == tris.as_slice() {
                            continue;
                        }
                    }
                    cache.dirty.push((old.lo.xz(), old.hi.xz()));
                }
                cache.dirty.push((lo.xz(), hi.xz()));
                cache.entries.insert(e, SourceEntry { lo, hi, tris: Arc::new(tris) });
                changed = true;
            }
            Err(err) => {
                if !cache.warned_unsupported {
                    cache.warned_unsupported = true;
                    warn!("ai: collider on {e} not baked into the navmesh: {err}");
                }
            }
        }
    }
    for e in &changed_meshes {
        cache.pending_meshes.insert(e);
    }
    if !cache.pending_meshes.is_empty()
        && let Some(assets) = mesh_assets.as_deref()
    {
        let pending: Vec<Entity> = cache.pending_meshes.iter().copied().collect();
        for e in pending {
            let Ok((_, m, gt)) = meshes_q.get(e) else {
                cache.pending_meshes.remove(&e);
                continue;
            };
            let Some(mesh) = assets.get(&m.0) else { continue };
            cache.pending_meshes.remove(&e);
            let Some(tris) = mesh_tris(mesh, gt) else { continue };
            let (lo, hi) = aabb(&tris);
            if let Some(old) = cache.entries.get(&e) {
                cache.dirty.push((old.lo.xz(), old.hi.xz()));
            }
            cache.dirty.push((lo.xz(), hi.xz()));
            cache.entries.insert(e, SourceEntry { lo, hi, tris: Arc::new(tris) });
            changed = true;
        }
    }
    let gone = removed_colliders.read().chain(removed_sources.read()).chain(added_ignore.iter_mut());
    for e in gone {
        if let Some(old) = cache.entries.remove(&e) {
            cache.dirty.push((old.lo.xz(), old.hi.xz()));
            changed = true;
        }
    }
    if changed {
        cache.last_change = now;
    }
}

/// Starts a bake job when dirty tiles have settled (or applies it in-frame without async).
pub(crate) fn schedule_bakes(
    cfg: Res<AiConfig>,
    mut cache: ResMut<SourceCache>,
    mut navs: ResMut<NavMeshes>,
    mut jobs: ResMut<BakeJobs>,
    time: Res<Time<Real>>,
    mut changed: MessageWriter<NavMeshChanged>,
) {
    if !jobs.tasks.is_empty() || !jobs.results.is_empty() {
        return;
    }
    let full = navs.full_requested;
    let auto = cfg.auto_bake && !cache.dirty.is_empty() && time.elapsed_secs_f64() - cache.last_change >= cfg.rebake_delay as f64;
    if !full && !auto {
        if cache.dirty.is_empty() {
            navs.baking = false;
        } else if cfg.auto_bake {
            navs.baking = true;
        }
        return;
    }
    navs.full_requested = false;
    let t0 = Instant::now();
    let dirty = std::mem::take(&mut cache.dirty);
    // Everything as one geometry (shared by all agent types); tiles chosen per type.
    let mut all_lo = Vec3::splat(f32::MAX);
    let mut all_hi = Vec3::splat(f32::MIN);
    for e in cache.entries.values() {
        all_lo = all_lo.min(e.lo);
        all_hi = all_hi.max(e.hi);
    }
    let mut work: Vec<(usize, f32, Vec<(i32, i32)>)> = Vec::new();
    let mut union_lo = Vec2::splat(f32::MAX);
    let mut union_hi = Vec2::splat(f32::MIN);
    for (ti, s) in cfg.agent_types.iter().enumerate() {
        let mesh = &navs.meshes[ti];
        let rebuild_all = full || mesh.is_empty() || (all_lo.y < mesh.origin_y + 0.5 && !cache.entries.is_empty());
        let mut coords: Vec<(i32, i32)> = Vec::new();
        if rebuild_all {
            if !cache.entries.is_empty() {
                coords.extend(tiles_in(s, all_lo.xz(), all_hi.xz()));
            }
            coords.extend(mesh.tiles().map(|(_, t)| t.coord));
        } else {
            for (lo, hi) in &dirty {
                coords.extend(tiles_in(s, *lo, *hi));
            }
        }
        coords.sort_unstable();
        coords.dedup();
        if coords.is_empty() {
            continue;
        }
        let origin_y = if rebuild_all { all_lo.y.min(f32::MAX / 2.0) - 2.0 } else { mesh.origin_y };
        let origin_y = if cache.entries.is_empty() { mesh.origin_y } else { origin_y };
        let tw = s.tile_size as f32 * s.cell_size;
        for &(x, z) in &coords {
            union_lo = union_lo.min(Vec2::new(x as f32, z as f32) * tw - Vec2::splat(tw));
            union_hi = union_hi.max(Vec2::new((x + 1) as f32, (z + 1) as f32) * tw + Vec2::splat(tw));
        }
        if rebuild_all {
            navs.meshes[ti].origin_y = origin_y;
        }
        work.push((ti, origin_y, coords));
    }
    if work.is_empty() {
        navs.baking = false;
        return;
    }
    let mut geom = NavGeometry::new();
    for e in cache.entries.values() {
        if e.hi.x >= union_lo.x && e.lo.x <= union_hi.x && e.hi.z >= union_lo.y && e.lo.z <= union_hi.y {
            geom.tris.extend_from_slice(&e.tris);
        }
    }
    for (ti, _, _) in &work {
        geom.build_index(&cfg.agent_types[*ti]);
    }
    navs.last_gather_us = t0.elapsed().as_micros() as u64;
    navs.baking = true;
    jobs.started = Some(t0);
    if !cfg.async_bake {
        for (ti, origin_y, coords) in work {
            let out = bake_tiles(&cfg.agent_types[ti], origin_y, &geom, &coords);
            jobs.results.push((ti, out));
        }
        apply_results(&mut jobs, &mut navs, &mut changed);
        return;
    }
    let geom = Arc::new(geom);
    let pool = AsyncComputeTaskPool::get();
    let threads = if cfg.bake_threads == 0 { pool.thread_num().max(1) } else { cfg.bake_threads };
    for (ti, origin_y, coords) in work {
        let chunk = coords.len().div_ceil(threads).max(1);
        for part in coords.chunks(chunk) {
            let part = part.to_vec();
            let geom = geom.clone();
            let s = cfg.agent_types[ti].clone();
            jobs.tasks.push(pool.spawn(async move { (ti, bake_tiles(&s, origin_y, &geom, &part)) }));
        }
    }
}

/// Polls running bake tasks; applies all of a job's tiles at once when every task finished.
pub(crate) fn poll_bakes(mut jobs: ResMut<BakeJobs>, mut navs: ResMut<NavMeshes>, mut changed: MessageWriter<NavMeshChanged>) {
    if jobs.tasks.is_empty() {
        return;
    }
    let jobs_ref = &mut *jobs;
    let mut i = 0;
    while i < jobs_ref.tasks.len() {
        if let Some(r) = block_on(poll_once(&mut jobs_ref.tasks[i])) {
            jobs_ref.results.push(r);
            drop(jobs_ref.tasks.swap_remove(i));
        } else {
            i += 1;
        }
    }
    if jobs_ref.tasks.is_empty() {
        apply_results(jobs_ref, &mut navs, &mut changed);
    }
}

fn apply_results(jobs: &mut BakeJobs, navs: &mut NavMeshes, changed: &mut MessageWriter<NavMeshChanged>) {
    let mut stats = BakeStats::default();
    let mut per_type: HashMap<usize, Vec<(i32, i32)>> = HashMap::default();
    for (ti, out) in jobs.results.drain(..) {
        stats.tiles += out.stats.tiles;
        stats.triangles += out.stats.triangles;
        stats.polys += out.stats.polys;
        stats.walkable_cells += out.stats.walkable_cells;
        stats.cpu_us += out.stats.cpu_us;
        let touched = per_type.entry(ti).or_default();
        touched.extend(out.tiles.iter().map(|t| t.coord));
        touched.extend(out.empty.iter().copied());
        if let Some(mesh) = navs.meshes.get_mut(ti) {
            mesh.insert_tiles(out.tiles, &out.empty);
        }
    }
    stats.wall_us = jobs.started.take().map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
    navs.last_bake = stats;
    navs.generation += 1;
    navs.baking = false;
    for (agent_type, tiles) in per_type {
        changed.write(NavMeshChanged { agent_type, tiles });
    }
}

/// Creates one (empty) mesh per agent type when the config changes; mirrors [`NavLink`]
/// components into every mesh.
pub(crate) fn sync_links(
    cfg: Res<AiConfig>,
    links: Query<(Entity, &NavLink)>,
    changed: Query<(), Changed<NavLink>>,
    mut removed: RemovedComponents<NavLink>,
    mut navs: ResMut<NavMeshes>,
) {
    let mut fresh = false;
    if navs.meshes.len() != cfg.agent_types.len() || navs.meshes.iter().zip(&cfg.agent_types).any(|(m, s)| m.settings != *s) {
        navs.meshes = cfg.agent_types.iter().map(|s| NavMesh::new(s.clone(), 0.0)).collect();
        navs.full_requested = true;
        fresh = true;
    }
    let any_removed = removed.read().count() > 0;
    if changed.is_empty() && !any_removed && !fresh {
        return;
    }
    let list: Vec<OffMeshLink> = links.iter().map(|(e, l)| OffMeshLink { user: e.to_bits(), ..l.0 }).collect();
    for m in &mut navs.meshes {
        m.set_offmesh_links(list.clone());
    }
}
