//! Procedural content generation in the world (feature `pcg`): runs [`pcg_core`] graphs over
//! cells of a [`PcgVolume`] and spawns what they place. See `docs/PCG.md`.
//!
//! - **Graphs**: RON files (`assets/pcg/*.pcg.ron`, loaded as [`PcgGraphAsset`], hot-reloaded with
//!   `hot_reload`) or built in Rust ([`pcg_core::Graph::build`]).
//! - **Catalog** ([`PcgCatalog`]): maps a graph's item names to meshes + materials (+ colliders),
//!   decal materials and light templates.
//! - **Cells**: a volume's area is split into `cell`-sized squares, evaluated on the async
//!   compute pool (at most [`PcgSettings::in_flight`] at once, nearest the camera first) and
//!   cached by (graph, the inputs near the cell): editing one input only regenerates the cells
//!   around it.
//! - **Output**: one root entity per cell (`Scenery`, static body when it has colliders).
//!   Small meshes used many times in a cell are merged per item into one mesh; others are
//!   instanced (shared handles, which Bevy batches). Decals (feature `look`) and lights
//!   (shadows off unless the template casts them). `Emit` ports arrive as [`PcgEmitted`].
//!   At most [`PcgSettings::cells_per_frame`] cells are spawned per frame.
//! - **Scalability**: `Normal` / `Fine` spawns are thinned per graphics quality
//!   ([`PcgScalability`]) and by the governor's [`crate::render_budget::GovernorStep::PcgDensity`],
//!   deterministically (lower quality ⊂ higher); changing it respawns from the cache.
//!   `Essential` (gameplay) never thins.
//! - **Streaming** (optional, [`PcgStreaming`] next to the volume): only cells within `radius`
//!   of the main camera (and `world::StreamSource`s, feature `world`) are evaluated and kept;
//!   cells past `radius + margin` are dropped (entities, cached output, emitted points: a
//!   [`PcgCellDropped`] message) and evaluated again, deterministically, when re-entered.

use std::sync::Arc;

use bevy::asset::{AssetLoader, LoadContext, io::Reader};
use bevy::mesh::{Indices, PrimitiveTopology, VertexAttributeValues};
use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use bevy::tasks::{AsyncComputeTaskPool, Task, futures_lite::future};

pub use pcg_core;
use pcg_core::{Area, Graph, Inputs, Output, SpawnKind, keep_for_tier, mix64};

mod overrides;

pub use overrides::{AddedItem, HAND_ATTR, MovedPoint, OverrideArea, OverrideIndex, PcgOverrides, PcgPick, PointKey, RemovedPoint, find_point, pcg_pick};

use crate::gfx::MainCamera;
use crate::render_budget::Scenery;

/// A graph loaded from a `.pcg.ron` file.
#[derive(Asset, TypePath, Clone, Debug)]
pub struct PcgGraphAsset(pub Arc<Graph>);

/// Where a volume's graph comes from.
#[derive(Clone, Debug)]
pub enum PcgGraphRef {
    Inline(Arc<Graph>),
    Asset(Handle<PcgGraphAsset>),
}

/// Generates over `area` (XZ) in `cell`-sized squares. Change `inputs` or the graph and the
/// affected cells regenerate.
#[derive(Component, Clone, Debug)]
pub struct PcgVolume {
    pub graph: PcgGraphRef,
    pub inputs: Arc<Inputs>,
    pub area: Area,
    /// Cell size (m). 16-64 m: smaller cells start sooner and regenerate less on an edit.
    pub cell: f32,
}

impl PcgVolume {
    pub fn new(graph: Graph, inputs: Inputs, area: Area) -> PcgVolume {
        PcgVolume { graph: PcgGraphRef::Inline(Arc::new(graph)), inputs: Arc::new(inputs), area, cell: 32.0 }
    }
}

/// One mesh item: what to draw (and collide with) for a point. Point scale applies to all.
#[derive(Clone, Debug)]
pub struct PcgMesh {
    pub mesh: Handle<Mesh>,
    pub material: Handle<StandardMaterial>,
    #[cfg(feature = "physics")]
    pub collider: Option<avian3d::prelude::Collider>,
}

/// One light item, placed at the point (+ `offset` in its frame).
#[derive(Clone, Debug)]
pub enum PcgLight {
    Point(PointLight, Vec3),
    Spot(SpotLight, Vec3),
}

/// Streams a [`PcgVolume`]: only cells near the main camera (and `world::StreamSource`
/// entities) are evaluated and kept. Without it every cell of the area is evaluated and kept.
#[derive(Component, Clone, Copy, Debug)]
pub struct PcgStreaming {
    /// A cell loads when its square is within this distance (m, XZ) of a source.
    pub radius: f32,
    /// A loaded cell unloads past `radius + margin` (no load/unload flicker at the edge).
    pub margin: f32,
}

impl Default for PcgStreaming {
    fn default() -> Self {
        PcgStreaming { radius: 512.0, margin: 64.0 }
    }
}

impl PcgStreaming {
    pub fn radius(radius: f32) -> PcgStreaming {
        PcgStreaming { radius, margin: (radius * 0.125).max(16.0) }
    }
}

/// A cell that had spawned was dropped (left a [`PcgStreaming`] radius or the area, or the
/// volume was removed from its cells): its entities are gone; drop anything built from its
/// [`PcgEmitted`] points. If it comes back, its points are emitted again.
#[derive(Message, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PcgCellDropped {
    pub volume: Entity,
    pub cell: IVec2,
}

/// Item names → assets.
#[derive(Resource, Default, Clone)]
pub struct PcgCatalog {
    pub meshes: HashMap<String, PcgMesh>,
    #[cfg(feature = "look")]
    pub decals: HashMap<String, Handle<bevy::pbr::decal::ForwardDecalMaterial<StandardMaterial>>>,
    pub lights: HashMap<String, PcgLight>,
}

impl PcgCatalog {
    pub fn mesh(&mut self, name: &str, mesh: Handle<Mesh>, material: Handle<StandardMaterial>) -> &mut Self {
        self.meshes.insert(
            name.into(),
            PcgMesh {
                mesh,
                material,
                #[cfg(feature = "physics")]
                collider: None,
            },
        );
        self
    }
}

/// Fractions of `Normal` / `Fine` points kept per graphics quality (Low, Medium, High, Ultra).
#[derive(Resource, Clone, Debug)]
pub struct PcgScalability {
    pub normal: [f32; 4],
    pub fine: [f32; 4],
}

impl Default for PcgScalability {
    fn default() -> Self {
        PcgScalability { normal: [0.6, 0.85, 1.0, 1.0], fine: [0.25, 0.5, 0.8, 1.0] }
    }
}

/// Execution limits.
#[derive(Resource, Clone, Debug)]
pub struct PcgSettings {
    /// Cells evaluating at once.
    pub in_flight: usize,
    /// Cells spawned per frame.
    pub cells_per_frame: usize,
    /// Merge a mesh item when it's used at least this often in a cell…
    pub merge_min_count: usize,
    /// …and has at most this many vertices.
    pub merge_max_vertices: usize,
    /// Extra multiplier on every thinned tier (1 = as [`PcgScalability`] says).
    pub density: f32,
}

impl Default for PcgSettings {
    fn default() -> Self {
        PcgSettings { in_flight: 4, cells_per_frame: 2, merge_min_count: 8, merge_max_vertices: 2048, density: 1.0 }
    }
}

/// Points an `Emit` node handed back for one cell.
#[derive(Message, Clone, Debug)]
pub struct PcgEmitted {
    pub volume: Entity,
    pub cell: IVec2,
    pub port: String,
    pub points: pcg_core::PointSet,
}

/// Counters.
#[derive(Resource, Clone, Debug, Default)]
pub struct PcgStats {
    pub volumes: u32,
    pub cells: u32,
    pub cells_pending: u32,
    pub evaluations: u64,
    /// Cells respawned from cached output (quality or density changed) without evaluating.
    pub cache_hits: u64,
    /// Cells respawned because their [`PcgOverrides`] changed (from the cached output).
    pub override_respawns: u64,
    /// Cells dropped by streaming (or leaving the area), total since start.
    pub cells_dropped: u64,
    /// Cell root entities alive now.
    pub entities: u32,
    /// Points spawned / thinned out, totals since start (respawns count again).
    pub points_spawned: u32,
    pub points_thinned: u32,
    /// Last evaluation, µs (on a worker thread).
    pub last_eval_us: f32,
    pub errors: Vec<String>,
}

/// A cell's state.
struct Cell {
    key: u64,
    output: Option<Arc<Output>>,
    task: Option<Task<(u64, Result<Output, pcg_core::PcgError>, f32)>>,
    root: Option<Entity>,
    /// The thinning it was spawned with.
    spawned_with: Option<(f32, f32)>,
    /// [`OverrideIndex::cell_hash`] it was spawned with.
    spawned_ov: u64,
    /// `output` with the volume's [`PcgOverrides`] applied (only cells an override touches).
    shown: Option<Arc<Output>>,
}

/// Per volume: its cells.
#[derive(Component, Default)]
pub struct PcgCells {
    cells: HashMap<IVec2, Cell>,
    graph_hash: u64,
    /// The input set (by pointer) and cell size the keys below were computed for: keys are
    /// only recomputed when the volume's inputs, graph or cells change.
    keyed: Option<(usize, u64, u32)>,
    keys: HashMap<IVec2, u64>,
    /// Index of the volume's [`PcgOverrides`] (None: no overrides) and the cell size it was built for.
    ov: Option<Arc<OverrideIndex>>,
}

/// Marks a cell's root entity.
#[derive(Component, Clone, Copy, Debug)]
pub struct PcgCellRoot {
    pub volume: Entity,
    pub cell: IVec2,
}

pub struct PcgPlugin;

impl Plugin for PcgPlugin {
    fn build(&self, app: &mut App) {
        app.init_asset::<PcgGraphAsset>()
            .register_asset_loader(PcgGraphLoader)
            .init_resource::<PcgCatalog>()
            .init_resource::<PcgScalability>()
            .init_resource::<PcgSettings>()
            .init_resource::<PcgStats>()
            .add_message::<PcgEmitted>()
            .add_message::<PcgCellDropped>()
            .register_type::<PcgOverrides>()
            .init_resource::<RetiredRoots>()
            .add_systems(Update, (schedule_cells, collect_cells, spawn_cells).chain())
            .add_systems(Last, despawn_retired);
        #[cfg(feature = "devtools")]
        devtools::register(app);
    }
}

#[derive(Default, TypePath)]
struct PcgGraphLoader;

impl AssetLoader for PcgGraphLoader {
    type Asset = PcgGraphAsset;
    type Settings = ();
    type Error = std::io::Error;

    async fn load(&self, reader: &mut dyn Reader, _: &(), _: &mut LoadContext<'_>) -> Result<PcgGraphAsset, Self::Error> {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await?;
        let s = std::str::from_utf8(&bytes).map_err(std::io::Error::other)?;
        Graph::from_ron(s).map(|g| PcgGraphAsset(Arc::new(g))).map_err(std::io::Error::other)
    }

    fn extensions(&self) -> &[&str] {
        &["pcg.ron"]
    }
}

fn graph_of(v: &PcgVolume, assets: &Assets<PcgGraphAsset>) -> Option<Arc<Graph>> {
    match &v.graph {
        PcgGraphRef::Inline(g) => Some(g.clone()),
        PcgGraphRef::Asset(h) => assets.get(h).map(|a| a.0.clone()),
    }
}

fn cells_of(area: Area, size: f32) -> impl Iterator<Item = IVec2> {
    let (x0, x1) = ((area.min.x / size).floor() as i32, ((area.max.x / size).ceil() as i32 - 1));
    let (z0, z1) = ((area.min.y / size).floor() as i32, ((area.max.y / size).ceil() as i32 - 1));
    (z0..=z1).flat_map(move |z| (x0..=x1).map(move |x| IVec2::new(x, z)))
}

/// Distance (XZ) from `p` to the square `area` (0 inside).
fn rect_distance(area: Area, p: Vec2) -> f32 {
    (area.min - p).max(p - area.max).max(Vec2::ZERO).length()
}

/// The cells of `area` a streamed volume wants: within `radius` of a source, or within
/// `radius + margin` while already loaded. Only the cells around the sources are visited.
fn streamed_cells(area: Area, size: f32, s: &PcgStreaming, sources: &[Vec2], loaded: &HashMap<IVec2, Cell>, out: &mut Vec<IVec2>) {
    let keep = s.radius.max(0.0) + s.margin.max(0.0);
    for &p in sources {
        let near = Area::new(p - Vec2::splat(keep), p + Vec2::splat(keep)).intersect(area);
        if near.max.x <= near.min.x || near.max.y <= near.min.y {
            continue;
        }
        for k in cells_of(near, size) {
            let cell = Area::cell(k.x, k.y, size).intersect(area);
            let reach = if loaded.contains_key(&k) { keep } else { s.radius };
            if sources.iter().any(|&q| rect_distance(cell, q) <= reach) {
                out.push(k);
            }
        }
    }
    if sources.len() > 1 {
        out.sort_unstable_by_key(|k| (k.y, k.x));
        out.dedup();
    }
}

/// Cell roots replaced or dropped this frame. They are despawned in `Last`, after every
/// `Update` / `PostUpdate` command has applied: a game system that tags fresh PCG output
/// (`commands.entity(e).insert(..)` on `Added` entities) never meets a root despawned under it.
#[derive(Resource, Default)]
struct RetiredRoots(Vec<Entity>);

fn despawn_retired(mut commands: Commands, mut retired: ResMut<RetiredRoots>) {
    for r in retired.0.drain(..) {
        commands.entity(r).try_despawn();
    }
}

/// Starts evaluations for cells whose key (graph + nearby inputs) changed, nearest first.
/// Streamed volumes ([`PcgStreaming`]) also load and drop cells around the sources here.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn schedule_cells(
    mut commands: Commands,
    mut volumes: Query<(Entity, &PcgVolume, Option<&mut PcgCells>, Option<&PcgStreaming>)>,
    assets: Res<Assets<PcgGraphAsset>>,
    settings: Res<PcgSettings>,
    cam: Query<&GlobalTransform, With<MainCamera>>,
    #[cfg(feature = "world")] stream_sources: Query<&GlobalTransform, (With<crate::world::StreamSource>, Without<MainCamera>)>,
    mut dropped: MessageWriter<PcgCellDropped>,
    mut retired: ResMut<RetiredRoots>,
    mut stats: ResMut<PcgStats>,
    mut todo: Local<Vec<(f32, Entity, IVec2)>>,
    mut sources: Local<Vec<Vec2>>,
    mut wanted: Local<Vec<IVec2>>,
) {
    let xz = |g: &GlobalTransform| Vec2::new(g.translation().x, g.translation().z);
    let eye = cam.iter().next().map(xz).unwrap_or(Vec2::ZERO);
    sources.clear();
    sources.extend(cam.iter().map(xz));
    #[cfg(feature = "world")]
    sources.extend(stream_sources.iter().map(xz));
    if sources.is_empty() {
        sources.push(eye);
    }
    let mut running = 0;
    todo.clear();
    for (e, v, cells, streaming) in &mut volumes {
        let Some(mut cells) = cells else {
            commands.entity(e).insert(PcgCells::default());
            continue;
        };
        let Some(g) = graph_of(v, &assets) else { continue };
        let size = v.cell.max(1.0);
        let stamp = (Arc::as_ptr(&v.inputs) as usize, Arc::as_ptr(&g) as usize as u64, size.to_bits());
        if cells.keyed != Some(stamp) {
            // Inputs, graph or cell size changed: recompute every cell's key (the surface hash
            // once, the shapes per cell).
            let ghash = g.hash();
            let halo = g.halo(&v.inputs);
            let surf = v.inputs.surface_hash();
            cells.graph_hash = ghash;
            let keys: HashMap<IVec2, u64> = cells_of(v.area, size)
                .map(|k| {
                    let area = Area::cell(k.x, k.y, size).intersect(v.area);
                    (k, mix64(ghash ^ mix64(v.inputs.shapes_hash_in(area.expand(halo)) ^ surf.rotate_left(29))))
                })
                .collect();
            cells.keys = keys;
            cells.keyed = Some(stamp);
        }
        wanted.clear();
        match streaming {
            Some(s) => streamed_cells(v.area, size, s, &sources, &cells.cells, &mut wanted),
            None => wanted.extend(cells_of(v.area, size)),
        }
        // Cells no longer wanted (out of range or out of the area): drop them, their cached
        // output and any evaluation in flight (dropping the task cancels it).
        if cells.cells.len() + wanted.len() > 0 {
            let want: bevy::platform::collections::HashSet<IVec2> = wanted.iter().copied().collect();
            cells.cells.retain(|k, c| {
                let keep = want.contains(k);
                if !keep {
                    if let Some(r) = c.root.take() {
                        retired.0.push(r);
                    }
                    if c.spawned_with.is_some() {
                        dropped.write(PcgCellDropped { volume: e, cell: *k });
                    }
                    stats.cells_dropped += 1;
                }
                keep
            });
        }
        for &k in wanted.iter() {
            let area = Area::cell(k.x, k.y, size).intersect(v.area);
            let key = cells.keys.get(&k).copied().unwrap_or(0);
            let c = cells.cells.entry(k).or_insert(Cell { key: 0, output: None, task: None, root: None, spawned_with: None, spawned_ov: 0, shown: None });
            if c.task.is_some() {
                running += 1;
                continue;
            }
            if c.key != key {
                let center = (area.min + area.max) * 0.5;
                todo.push((center.distance_squared(eye), e, k));
            }
        }
    }
    todo.sort_by(|a, b| a.0.total_cmp(&b.0));
    let pool = AsyncComputeTaskPool::get();
    for &(_, e, k) in todo.iter() {
        if running >= settings.in_flight {
            break;
        }
        let Ok((_, v, Some(mut cells), _)) = volumes.get_mut(e) else { continue };
        let Some(g) = graph_of(v, &assets) else { continue };
        let size = v.cell.max(1.0);
        let area = Area::cell(k.x, k.y, size).intersect(v.area);
        let key = cells.keys.get(&k).copied().unwrap_or(0);
        let inputs = v.inputs.clone();
        let task = pool.spawn(async move {
            let t0 = std::time::Instant::now();
            let out = pcg_core::evaluate(&g, &inputs, Some(area));
            (key, out, t0.elapsed().as_secs_f32() * 1e6)
        });
        if let Some(c) = cells.cells.get_mut(&k) {
            c.task = Some(task);
            running += 1;
        }
    }
}

/// Picks up finished evaluations.
fn collect_cells(mut volumes: Query<&mut PcgCells>, mut stats: ResMut<PcgStats>) {
    for mut cells in &mut volumes {
        for (k, c) in cells.cells.iter_mut() {
            let Some(task) = c.task.as_mut() else { continue };
            let Some((key, out, us)) = future::block_on(future::poll_once(task)) else { continue };
            c.task = None;
            stats.evaluations += 1;
            stats.last_eval_us = us;
            match out {
                Ok(o) => {
                    c.key = key;
                    c.output = Some(Arc::new(o));
                    c.spawned_with = None;
                }
                Err(e) => {
                    c.key = key;
                    let msg = format!("cell {k}: {e}");
                    warn!("pcg: {msg}");
                    stats.errors.push(msg);
                    if stats.errors.len() > 16 {
                        stats.errors.remove(0);
                    }
                }
            }
        }
    }
}

/// The current thinning fractions (normal, fine).
fn thinning(scal: &PcgScalability, settings: &PcgSettings, quality: Option<&crate::settings::CoreSettings>, governor: Option<&crate::render_budget::GovernorState>) -> (f32, f32) {
    let i = quality.map_or(3, |s| s.quality.index());
    // 0 = the governor hasn't set it yet (no limit).
    let gov = governor.map(|g| g.pcg_density).filter(|d| *d > 0.0).unwrap_or(1.0);
    let k = settings.density * gov;
    (scal.normal[i] * k, scal.fine[i] * k)
}

#[allow(clippy::too_many_arguments)]
fn spawn_cells(
    mut commands: Commands,
    mut volumes: Query<(Entity, &PcgVolume, &mut PcgCells, Option<Ref<PcgOverrides>>)>,
    catalog: Res<PcgCatalog>,
    scal: Res<PcgScalability>,
    settings: Res<PcgSettings>,
    quality: Option<Res<crate::settings::CoreSettings>>,
    governor: Option<Res<crate::render_budget::GovernorState>>,
    mut meshes: Option<ResMut<Assets<Mesh>>>,
    mut emitted: MessageWriter<PcgEmitted>,
    mut dropped: MessageWriter<PcgCellDropped>,
    mut retired: ResMut<RetiredRoots>,
    mut stats: ResMut<PcgStats>,
) {
    let thin = thinning(&scal, &settings, quality.as_deref(), governor.as_deref());
    let mut budget = settings.cells_per_frame.max(1);
    let (mut cells_n, mut pending) = (0u32, 0u32);
    for (volume, v, mut cells, ov) in &mut volumes {
        let size = v.cell.max(1.0);
        // The overrides' lookup is rebuilt when they (or the cell size) change; cells compare
        // their own hash, so only the ones an edit touches respawn.
        match ov {
            Some(o) if o.is_changed() || cells.ov.as_ref().is_none_or(|i| i.cell_size() != size) => {
                cells.ov = (!o.is_empty()).then(|| Arc::new(o.index(size)));
            }
            None if cells.ov.is_some() => cells.ov = None,
            _ => {}
        }
        let index = cells.ov.clone();
        for (k, c) in cells.cells.iter_mut() {
            cells_n += 1;
            let Some(base) = c.output.clone() else {
                pending += 1;
                continue;
            };
            let ov_hash = index.as_ref().map_or(0, |i| i.cell_hash(*k));
            if c.spawned_with == Some(thin) && c.spawned_ov == ov_hash {
                continue;
            }
            // Overrides applied to the cached evaluation (cells they don't touch are used as is).
            let edited = ov_hash != 0;
            let out = match (&index, edited) {
                (Some(i), true) => Arc::new(i.apply_output(Area::cell(k.x, k.y, size), &base)),
                _ => base,
            };
            // Mesh items still loading: merge needs their data; try again later.
            if needs_mesh_data(&out, &catalog, &settings, meshes.as_deref()) {
                pending += 1;
                continue;
            }
            if budget == 0 {
                pending += 1;
                continue;
            }
            budget -= 1;
            if let Some(r) = c.root.take() {
                retired.0.push(r);
            }
            let first = c.spawned_with.is_none();
            let ov_changed = !first && c.spawned_ov != ov_hash;
            if !first {
                // Respawned from the cached output (thinning or overrides changed): no evaluation.
                stats.cache_hits += 1;
            }
            if ov_changed {
                stats.override_respawns += 1;
            }
            c.root = Some(spawn_output(&mut commands, volume, *k, &out, &catalog, &settings, thin, meshes.as_deref_mut(), &mut stats));
            c.spawned_with = Some(thin);
            c.spawned_ov = ov_hash;
            c.shown = edited.then(|| out.clone());
            if first || (ov_changed && !out.emits.is_empty()) {
                if !first {
                    // Whoever built things from the old points drops them, then gets the new ones.
                    dropped.write(PcgCellDropped { volume, cell: *k });
                }
                for (port, points) in &out.emits {
                    emitted.write(PcgEmitted { volume, cell: *k, port: port.clone(), points: points.clone() });
                }
            }
        }
    }
    stats.volumes = volumes.iter().len() as u32;
    stats.entities = volumes.iter().map(|(_, _, c, _)| c.cells.values().filter(|c| c.root.is_some()).count() as u32).sum();
    stats.cells = cells_n;
    stats.cells_pending = pending;
}

fn needs_mesh_data(out: &Output, catalog: &PcgCatalog, settings: &PcgSettings, meshes: Option<&Assets<Mesh>>) -> bool {
    let Some(meshes) = meshes else { return false };
    out.spawns.iter().filter(|s| s.def.kind == SpawnKind::Mesh).any(|s| {
        s.def.items.iter().any(|(name, _)| catalog.meshes.get(name).is_some_and(|m| meshes.get(&m.mesh).is_none() && s.points.len() >= settings.merge_min_count))
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_output(
    commands: &mut Commands,
    volume: Entity,
    cell: IVec2,
    out: &Output,
    catalog: &PcgCatalog,
    settings: &PcgSettings,
    (normal, fine): (f32, f32),
    mut meshes: Option<&mut Assets<Mesh>>,
    stats: &mut PcgStats,
) -> Entity {
    let root = commands.spawn((Name::new(format!("pcg cell {cell}")), PcgCellRoot { volume, cell }, Transform::default(), Visibility::default())).id();
    #[allow(unused_mut)]
    let mut has_colliders = false;
    for s in &out.spawns {
        let p = &s.points;
        // Kept points, grouped by item.
        let mut by_item: Vec<Vec<usize>> = vec![Vec::new(); s.def.items.len()];
        let hand = p.attrs.get(HAND_ATTR);
        for k in 0..p.len() {
            if hand.is_some_and(|h| h[k] > 0.5) || keep_for_tier(p.seed[k], s.def.tier, normal, fine) {
                by_item[s.item[k] as usize].push(k);
            } else {
                stats.points_thinned += 1;
            }
        }
        for (item, idx) in by_item.iter().enumerate() {
            if idx.is_empty() {
                continue;
            }
            let name = &s.def.items[item].0;
            let tf = |k: usize| Transform { translation: p.pos[k], rotation: p.rot[k], scale: p.scale[k] };
            stats.points_spawned += idx.len() as u32;
            match s.def.kind {
                SpawnKind::Mesh => {
                    let Some(m) = catalog.meshes.get(name) else {
                        warn_once!("pcg: no catalog mesh `{name}`");
                        continue;
                    };
                    // Merged meshes are built around their points' centre and placed there, so
                    // distance culling (VisibilityRange measures from the entity's position)
                    // sees where they really are.
                    let center = idx.iter().map(|&k| p.pos[k]).sum::<Vec3>() / idx.len().max(1) as f32;
                    let merged = meshes.as_deref_mut().and_then(|ms| {
                        let src = ms.get(&m.mesh)?;
                        (idx.len() >= settings.merge_min_count && src.count_vertices() <= settings.merge_max_vertices)
                            .then(|| merge(src, idx.iter().map(|&k| Transform { translation: p.pos[k] - center, ..tf(k) })))
                            .flatten()
                            .map(|mesh| ms.add(mesh))
                    });
                    match merged {
                        Some(h) => {
                            let mut e = commands.spawn((Name::new(format!("pcg {name}")), Mesh3d(h), MeshMaterial3d(m.material.clone()), Transform::from_translation(center), Scenery));
                            if !s.def.shadows {
                                e.insert(bevy::light::NotShadowCaster);
                            }
                            let id = e.id();
                            commands.entity(root).add_child(id);
                        }
                        None => {
                            for &k in idx {
                                let mut e = commands.spawn((Mesh3d(m.mesh.clone()), MeshMaterial3d(m.material.clone()), tf(k), Scenery));
                                if !s.def.shadows {
                                    e.insert(bevy::light::NotShadowCaster);
                                }
                                let id = e.id();
                                commands.entity(root).add_child(id);
                            }
                        }
                    }
                    #[cfg(feature = "physics")]
                    if s.def.collider
                        && let Some(c) = &m.collider
                    {
                        has_colliders = true;
                        for &k in idx {
                            let id = commands.spawn((c.clone(), tf(k))).id();
                            commands.entity(root).add_child(id);
                        }
                    }
                }
                SpawnKind::Decal => {
                    #[cfg(feature = "look")]
                    if let Some(mat) = catalog.decals.get(name) {
                        for &k in idx {
                            let id = crate::look::decal::spawn_decal(commands, mat.clone(), tf(k));
                            commands.entity(root).add_child(id);
                        }
                    } else {
                        warn_once!("pcg: no catalog decal `{name}`");
                    }
                    #[cfg(not(feature = "look"))]
                    warn_once!("pcg: decals need the `look` feature");
                }
                SpawnKind::Light => {
                    let Some(l) = catalog.lights.get(name) else {
                        warn_once!("pcg: no catalog light `{name}`");
                        continue;
                    };
                    for &k in idx {
                        let t = tf(k);
                        let id = match l {
                            PcgLight::Point(pl, off) => commands.spawn((*pl, Transform::from_translation(t.translation + t.rotation * *off))).id(),
                            PcgLight::Spot(sl, off) => commands.spawn((*sl, Transform { translation: t.translation + t.rotation * *off, rotation: t.rotation, ..default() })).id(),
                        };
                        commands.entity(root).add_child(id);
                    }
                }
            }
        }
    }
    #[cfg(feature = "physics")]
    if has_colliders {
        commands.entity(root).insert(avian3d::prelude::RigidBody::Static);
    }
    let _ = has_colliders;
    root
}

/// One mesh with a copy of `src` per transform (positions, normals, UVs, tangents; triangle
/// lists only). `None` if `src` can't be merged.
fn merge(src: &Mesh, tfs: impl Iterator<Item = Transform>) -> Option<Mesh> {
    if src.primitive_topology() != PrimitiveTopology::TriangleList {
        return None;
    }
    let Some(VertexAttributeValues::Float32x3(pos)) = src.attribute(Mesh::ATTRIBUTE_POSITION) else { return None };
    let nrm = match src.attribute(Mesh::ATTRIBUTE_NORMAL) {
        Some(VertexAttributeValues::Float32x3(n)) => Some(n),
        _ => None,
    };
    let uv = match src.attribute(Mesh::ATTRIBUTE_UV_0) {
        Some(VertexAttributeValues::Float32x2(u)) => Some(u),
        _ => None,
    };
    let tan = match src.attribute(Mesh::ATTRIBUTE_TANGENT) {
        Some(VertexAttributeValues::Float32x4(t)) => Some(t),
        _ => None,
    };
    let idx: Vec<u32> = match src.indices() {
        Some(i) => i.iter().map(|v| v as u32).collect(),
        None => (0..pos.len() as u32).collect(),
    };
    let (mut p, mut n, mut u, mut t, mut ix) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for tf in tfs {
        let m = tf.to_matrix();
        let nm = Mat3::from_mat4(m).inverse().transpose();
        let base = p.len() as u32;
        p.extend(pos.iter().map(|v| m.transform_point3(Vec3::from(*v)).to_array()));
        if let Some(nrm) = nrm {
            n.extend(nrm.iter().map(|v| (nm * Vec3::from(*v)).normalize_or_zero().to_array()));
        }
        if let Some(uv) = uv {
            u.extend_from_slice(uv);
        }
        if let Some(tan) = tan {
            t.extend(tan.iter().map(|v| {
                let d = (Mat3::from_mat4(m) * Vec3::new(v[0], v[1], v[2])).normalize_or_zero();
                [d.x, d.y, d.z, v[3]]
            }));
        }
        ix.extend(idx.iter().map(|i| i + base));
    }
    let mut mesh = Mesh::new(PrimitiveTopology::TriangleList, bevy::asset::RenderAssetUsages::RENDER_WORLD);
    mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, p);
    if nrm.is_some() {
        mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, n);
    }
    if uv.is_some() {
        mesh.insert_attribute(Mesh::ATTRIBUTE_UV_0, u);
    }
    if tan.is_some() {
        mesh.insert_attribute(Mesh::ATTRIBUTE_TANGENT, t);
    }
    mesh.insert_indices(Indices::U32(ix));
    Some(mesh)
}

/// Throw away cached output and regenerate every cell (devtools `pcg.regen`).
pub fn regenerate(world: &mut World) {
    let mut q = world.query::<&mut PcgCells>();
    for mut c in q.iter_mut(world) {
        for cell in c.cells.values_mut() {
            cell.key = 0;
        }
    }
}

#[cfg(feature = "devtools")]
mod devtools {
    use serde_json::{Value, json};

    use super::*;
    use crate::devtools::{AddControlCommand, params};

    pub(super) fn register(app: &mut App) {
        overrides::control::register(app);
        app.add_control_command("pcg.stats", "PCG volumes, cells, evaluations, cache, spawned points, errors", params(&[]), stats)
            .add_control_command("pcg.regen", "Regenerate every PCG cell", params(&[]), regen)
            .add_control_command(
                "pcg.scale",
                "PCG density multiplier on Normal/Fine spawns (respawns from the cache)",
                params(&[("density", "number", "0..1 (default 1)")]),
                scale,
            )
            .add_control_command(
                "pcg.inspect",
                "Points per node in one cell of a volume",
                params(&[("x", "number", "cell x"), ("z", "number", "cell z"), ("volume", "number", "volume index (default 0)")]),
                inspect,
            );
    }

    fn stats(world: &mut World, _: Value) -> Result<Value, String> {
        let s = world.resource::<PcgStats>().clone();
        Ok(json!({
            "volumes": s.volumes, "cells": s.cells, "cells_pending": s.cells_pending, "evaluations": s.evaluations,
            "cache_hits": s.cache_hits, "cells_dropped": s.cells_dropped, "cell_roots": s.entities, "points_spawned": s.points_spawned,
            "points_thinned": s.points_thinned, "last_eval_us": s.last_eval_us, "errors": s.errors,
            "density": world.resource::<PcgSettings>().density,
        }))
    }

    fn regen(world: &mut World, _: Value) -> Result<Value, String> {
        regenerate(world);
        Ok(json!({"regenerating": true}))
    }

    fn scale(world: &mut World, p: Value) -> Result<Value, String> {
        let d = p.get("density").and_then(Value::as_f64).ok_or("`density` is required")?;
        world.resource_mut::<PcgSettings>().density = (d as f32).clamp(0.0, 1.0);
        Ok(json!({"density": d}))
    }

    fn inspect(world: &mut World, p: Value) -> Result<Value, String> {
        let i = p.get("volume").and_then(Value::as_u64).unwrap_or(0) as usize;
        let cell = IVec2::new(p.get("x").and_then(Value::as_i64).unwrap_or(0) as i32, p.get("z").and_then(Value::as_i64).unwrap_or(0) as i32);
        let mut q = world.query::<&PcgCells>();
        let cells = q.iter(world).nth(i).ok_or("no such volume")?;
        let c = cells.cells.get(&cell).ok_or("no such cell")?;
        let out = c.output.as_ref().ok_or("cell not evaluated yet")?;
        Ok(json!({
            "counts": out.counts.iter().map(|(n, c)| json!([n, c])).collect::<Vec<_>>(),
            "spawns": out.spawns.iter().map(|s| json!({"node": s.node, "points": s.points.len()})).collect::<Vec<_>>(),
            "emits": out.emits.iter().map(|(k, v)| json!({"port": k, "points": v.len()})).collect::<Vec<_>>(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcg_core::{Rect, Side, Tier};

    fn app() -> App {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, bevy::asset::AssetPlugin::default(), bevy::transform::TransformPlugin))
            .init_asset::<Mesh>()
            .init_asset::<StandardMaterial>()
            .add_plugins(PcgPlugin);
        app
    }

    fn run_until_done(app: &mut App) {
        for _ in 0..200 {
            app.update();
            let s = app.world().resource::<PcgStats>();
            if s.cells > 0 && s.cells_pending == 0 {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        panic!("pcg didn't finish: {:?}", app.world().resource::<PcgStats>());
    }

    fn graph() -> Graph {
        Graph::build(5)
            .input("lots")
            .poisson(3.0)
            .spawn(&[("rock", 1.0)], Tier::Fine)
            .id("rocks")
            .from("lots")
            .edges(5.0, 1.0, Side::Out)
            .spawn(&[("post", 1.0)], Tier::Essential)
            .id("posts")
            .finish()
            .unwrap()
    }

    #[test]
    fn volume_spawns_cells_merges_and_thins() {
        let mut app = app();
        let (rock, post, mat) = {
            let w = app.world_mut();
            let rock = w.resource_mut::<Assets<Mesh>>().add(Cuboid::new(0.5, 0.5, 0.5));
            let post = w.resource_mut::<Assets<Mesh>>().add(Cuboid::new(0.1, 1.0, 0.1));
            let mat = w.resource_mut::<Assets<StandardMaterial>>().add(StandardMaterial::default());
            (rock, post, mat)
        };
        app.world_mut().resource_mut::<PcgCatalog>().mesh("rock", rock, mat.clone()).mesh("post", post, mat);
        let inputs = Inputs::default().rects("lots", vec![Rect::new(Vec2::ZERO, Vec2::new(40.0, 40.0))]);
        app.world_mut().spawn(PcgVolume { cell: 32.0, ..PcgVolume::new(graph(), inputs, Area::new(Vec2::splat(-48.0), Vec2::splat(48.0))) });
        run_until_done(&mut app);
        let roots = app.world_mut().query::<&PcgCellRoot>().iter(app.world()).count();
        // World-aligned 32 m cells over -48..48: -2..=1 on each axis.
        assert_eq!(roots, 16, "4 × 4 cells");
        let s = app.world().resource::<PcgStats>().clone();
        assert!(s.points_spawned > 100, "{s:?}");
        // Rocks are merged per cell (one entity per cell), posts are few per cell.
        let scenery = app.world_mut().query_filtered::<(), With<Scenery>>().iter(app.world()).count();
        assert!(scenery < s.points_spawned as usize / 2, "merged: {scenery} entities for {} points", s.points_spawned);
        // Halving the density respawns fewer rocks, same posts (Essential).
        app.world_mut().resource_mut::<PcgSettings>().density = 0.5;
        let before = s.points_spawned;
        app.world_mut().resource_mut::<PcgStats>().points_spawned = 0;
        run_until_done(&mut app);
        for _ in 0..20 {
            app.update();
        }
        let after = app.world().resource::<PcgStats>().points_spawned;
        assert!(after < before && after > 0, "{after} vs {before}");
        assert_eq!(app.world_mut().query::<&PcgCellRoot>().iter(app.world()).count(), 16);
    }

    #[test]
    fn editing_inputs_regenerates_only_nearby_cells() {
        let mut app = app();
        let inputs = Inputs::default().rects("lots", vec![Rect::new(Vec2::new(-30.0, 0.0), Vec2::new(10.0, 10.0)), Rect::new(Vec2::new(30.0, 0.0), Vec2::new(10.0, 10.0))]);
        let v = app.world_mut().spawn(PcgVolume { cell: 32.0, ..PcgVolume::new(graph(), inputs.clone(), Area::new(Vec2::new(-64.0, -32.0), Vec2::new(64.0, 32.0))) }).id();
        run_until_done(&mut app);
        let evals = app.world().resource::<PcgStats>().evaluations;
        let mut edited = inputs;
        edited.sets.get_mut("lots").unwrap().rects[1].half.x = 12.0;
        app.world_mut().get_mut::<PcgVolume>(v).unwrap().inputs = Arc::new(edited);
        for _ in 0..30 {
            app.update();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let more = app.world().resource::<PcgStats>().evaluations - evals;
        assert!(more > 0 && more < 8, "re-evaluated {more} of 8 cells");
    }

    #[test]
    fn streaming_loads_near_the_camera_and_drops_far_cells() {
        let mut app = app();
        // 512 x 64 m strip, 32 m cells: 16 x 2 cells.
        let inputs = Inputs::default().rects("lots", vec![Rect::new(Vec2::ZERO, Vec2::new(256.0, 32.0))]);
        let v = app
            .world_mut()
            .spawn((PcgVolume { cell: 32.0, ..PcgVolume::new(graph(), inputs, Area::new(Vec2::new(-256.0, -32.0), Vec2::new(256.0, 32.0))) }, PcgStreaming { radius: 30.0, margin: 16.0 }))
            .id();
        let cam = app.world_mut().spawn((MainCamera, Transform::from_xyz(-200.0, 2.0, 0.0), GlobalTransform::from_xyz(-200.0, 2.0, 0.0))).id();
        let near = |app: &mut App| {
            let mut c: Vec<IVec2> = app.world_mut().query::<&PcgCellRoot>().iter(app.world()).map(|r| r.cell).collect();
            c.sort_by_key(|k| (k.x, k.y));
            c
        };
        let points = |app: &mut App, cell: IVec2| {
            let q = app.world_mut().query::<&PcgCells>().single(app.world()).unwrap().cells.get(&cell).and_then(|c| c.output.clone());
            q.map(|o| o.spawns.iter().map(|s| s.points.len()).sum::<usize>())
        };
        run_until_done(&mut app);
        let west = near(&mut app);
        // x = -200 ± 30 m reaches cells -8..=-6 (x -256..-160; cell -5 starts 40 m away), both rows.
        assert_eq!(west.len(), 6, "{west:?}");
        assert!(west.iter().all(|k| (-8..=-6).contains(&k.x)), "{west:?}");
        let first = points(&mut app, IVec2::new(-7, 0)).unwrap();
        assert_eq!(app.world().resource::<PcgStats>().cells, 6, "only near cells are kept");

        // Drive east: the west cells drop (message + no cached output), east cells load.
        app.world_mut().entity_mut(cam).insert(GlobalTransform::from_xyz(200.0, 2.0, 0.0));
        run_until_done(&mut app);
        let east = near(&mut app);
        assert!(east.iter().all(|k| (5..=7).contains(&k.x)), "{east:?}");
        assert_eq!(points(&mut app, IVec2::new(-7, 0)), None, "dropped cells free their output");
        let msgs = app.world().resource::<Messages<PcgCellDropped>>();
        let dropped: Vec<_> = msgs.iter_current_update_messages().chain(msgs.get_cursor().read(msgs)).filter(|d| d.volume == v).map(|d| d.cell).collect();
        assert!(dropped.contains(&IVec2::new(-7, 0)), "{dropped:?}");
        assert!(app.world().resource::<PcgStats>().cells_dropped >= 6);

        // Back west: re-evaluated, same points (deterministic).
        app.world_mut().entity_mut(cam).insert(GlobalTransform::from_xyz(-200.0, 2.0, 0.0));
        run_until_done(&mut app);
        assert_eq!(near(&mut app), west);
        assert_eq!(points(&mut app, IVec2::new(-7, 0)), Some(first));
    }

    /// A game system that tags PCG output in `Update` (plain `insert`, no `try_`) while
    /// streaming drops cells must not hit a despawned entity. Commands apply in system order
    /// at the end of `Update` (no auto sync), the order that panicked when drops despawned in
    /// `schedule_cells`.
    #[test]
    fn tagging_output_while_cells_drop_is_safe() {
        #[derive(Component)]
        struct Tagged;
        fn tag(mut commands: Commands, roots: Query<Entity, With<PcgCellRoot>>) {
            for e in &roots {
                commands.entity(e).insert(Tagged);
            }
        }
        let mut app = app();
        app.edit_schedule(Update, |s| {
            s.set_build_settings(bevy::ecs::schedule::ScheduleBuildSettings { auto_insert_apply_deferred: false, ..default() });
        });
        app.add_systems(Update, tag.after(schedule_cells).before(collect_cells));
        let inputs = Inputs::default().rects("lots", vec![Rect::new(Vec2::ZERO, Vec2::new(256.0, 32.0))]);
        app.world_mut().spawn((PcgVolume { cell: 32.0, ..PcgVolume::new(graph(), inputs, Area::new(Vec2::new(-256.0, -32.0), Vec2::new(256.0, 32.0))) }, PcgStreaming { radius: 30.0, margin: 0.0 }));
        let cam = app.world_mut().spawn((MainCamera, GlobalTransform::from_xyz(-240.0, 2.0, 0.0))).id();
        run_until_done(&mut app);
        // Fast drive east: cells drop every few frames.
        for i in 0..240 {
            let x = -240.0 + i as f32 * 2.0;
            app.world_mut().entity_mut(cam).insert(GlobalTransform::from_xyz(x, 2.0, 0.0));
            app.update();
        }
        assert!(app.world().resource::<PcgStats>().cells_dropped > 10);
    }

    fn rock_app() -> (App, Entity) {
        let mut app = app();
        let (rock, mat) = {
            let w = app.world_mut();
            (w.resource_mut::<Assets<Mesh>>().add(Cuboid::new(0.5, 0.5, 0.5)), w.resource_mut::<Assets<StandardMaterial>>().add(StandardMaterial::default()))
        };
        app.world_mut().resource_mut::<PcgCatalog>().mesh("rock", rock, mat);
        let g = Graph::build(5).input("lots").poisson(3.0).spawn(&[("rock", 1.0)], Tier::Essential).id("rocks").from("lots").poisson(6.0).emit("pts").finish().unwrap();
        let inputs = Inputs::default().rects("lots", vec![Rect::new(Vec2::ZERO, Vec2::new(40.0, 40.0))]);
        let v = app.world_mut().spawn(PcgVolume { cell: 32.0, ..PcgVolume::new(g, inputs, Area::new(Vec2::splat(-48.0), Vec2::splat(48.0))) }).id();
        run_until_done(&mut app);
        (app, v)
    }

    fn settle(app: &mut App) {
        for _ in 0..12 {
            app.update();
        }
    }

    fn cell_seeds(app: &App, v: Entity, cell: IVec2, node: &str) -> Vec<u64> {
        let c = app.world().get::<PcgCells>(v).unwrap().cells.get(&cell).unwrap();
        let out = c.shown.as_ref().or(c.output.as_ref()).unwrap();
        out.spawns.iter().filter(|s| s.node == node).flat_map(|s| s.points.seed.clone()).collect()
    }

    fn emitted(app: &mut App) -> Vec<PcgEmitted> {
        let msgs = app.world().resource::<Messages<PcgEmitted>>();
        msgs.iter_current_update_messages().cloned().collect()
    }

    #[test]
    fn overrides_respawn_only_touched_cells_without_evaluating() {
        let (mut app, v) = rock_app();
        let evals = app.world().resource::<PcgStats>().evaluations;
        let seeds = cell_seeds(&app, v, IVec2::new(0, 0), "rocks");
        assert!(seeds.len() > 10);
        let victim = seeds[3];
        let at = {
            let c = app.world().get::<PcgCells>(v).unwrap().cells.get(&IVec2::new(0, 0)).unwrap();
            let s = c.output.as_ref().unwrap().spawns.iter().find(|s| s.node == "rocks").unwrap();
            s.points.pos[3]
        };
        let roots_before: HashMap<IVec2, Entity> = app.world().get::<PcgCells>(v).unwrap().cells.iter().filter_map(|(k, c)| c.root.map(|r| (*k, r))).collect();
        let mut ov = PcgOverrides::default();
        ov.remove_point(&PointKey { node: "rocks".into(), seed: victim }, at);
        app.world_mut().entity_mut(v).insert(ov);
        settle(&mut app);
        let stats = app.world().resource::<PcgStats>().clone();
        assert_eq!(stats.evaluations, evals, "no re-evaluation");
        assert_eq!(stats.override_respawns, 1, "one cell respawned");
        let after = cell_seeds(&app, v, IVec2::new(0, 0), "rocks");
        assert_eq!(after.len(), seeds.len() - 1);
        assert!(!after.contains(&victim));
        let roots_after: HashMap<IVec2, Entity> = app.world().get::<PcgCells>(v).unwrap().cells.iter().filter_map(|(k, c)| c.root.map(|r| (*k, r))).collect();
        for (k, r) in &roots_before {
            assert_eq!(*r != roots_after[k], *k == IVec2::new(0, 0), "cell {k}");
        }
        // The old root was despawned.
        assert!(app.world().get_entity(roots_before[&IVec2::new(0, 0)]).is_err());

        // Dropping the component restores the cell.
        app.world_mut().entity_mut(v).remove::<PcgOverrides>();
        settle(&mut app);
        assert_eq!(cell_seeds(&app, v, IVec2::new(0, 0), "rocks"), seeds);
        assert_eq!(app.world().resource::<PcgStats>().override_respawns, 2);
    }

    #[test]
    fn emitted_points_carry_overrides_and_standalone_apply_matches() {
        let (mut app, v) = rock_app();
        let base_emit: pcg_core::PointSet = app.world().get::<PcgCells>(v).unwrap().cells[&IVec2::new(0, 0)].output.as_ref().unwrap().emits["pts"].clone();
        let seeds = cell_seeds(&app, v, IVec2::new(0, 0), "rocks");
        // Clear the west half of cell (0,0), add one rock by hand, remove one emitted point.
        let mut ov = PcgOverrides::default();
        ov.areas.push(OverrideArea { polygon: vec![Vec2::new(0.0, 0.0), Vec2::new(16.0, 0.0), Vec2::new(16.0, 32.0), Vec2::new(0.0, 32.0)], density: 0.0, nodes: None });
        ov.add_item("rock", "rocks", Transform::from_xyz(20.0, 0.0, 20.0));
        ov.remove_point(&PointKey { node: "pts".into(), seed: base_emit.seed[base_emit.len() - 1] }, base_emit.pos[base_emit.len() - 1]);
        app.world_mut().entity_mut(v).insert(ov.clone());
        settle(&mut app);
        // The standalone application on the original evaluation equals what the volume shows.
        let ix = ov.index(32.0);
        let area = Area::cell(0, 0, 32.0);
        let c = &app.world().get::<PcgCells>(v).unwrap().cells[&IVec2::new(0, 0)];
        let want = ix.apply_output(area, c.output.as_ref().unwrap());
        assert_eq!(&want, c.shown.as_deref().unwrap());
        assert!(want.emits["pts"].len() < base_emit.len());
        assert!(want.emits["pts"].pos.iter().all(|p| p.x >= 16.0 || p.x < 0.0));
        let shown = cell_seeds(&app, v, IVec2::new(0, 0), "rocks");
        assert!(shown.len() < seeds.len());
        // Games apply to their own evaluation (here: same graph over the same cell).
        let mut mine = base_emit.clone();
        ov.index(32.0).apply_points("pts", area, &mut mine);
        assert_eq!(mine, want.emits["pts"]);
    }

    #[test]
    fn emits_are_resent_when_overrides_change() {
        let (mut app, v) = rock_app();
        let at = Vec3::new(5.0, 0.0, 5.0);
        let mut ov = PcgOverrides::default();
        ov.add_item("rock", "pts", Transform::from_translation(at));
        app.world_mut().entity_mut(v).insert(ov);
        let mut saw = false;
        let mut dropped = false;
        for _ in 0..12 {
            app.update();
            saw |= emitted(&mut app).iter().any(|m| m.cell == IVec2::new(0, 0) && m.port == "pts" && m.points.pos.contains(&at));
            let d = app.world().resource::<Messages<PcgCellDropped>>();
            dropped |= d.iter_current_update_messages().any(|m| m.cell == IVec2::new(0, 0));
        }
        assert!(saw && dropped, "re-emitted with the hand-placed point: {saw} {dropped}");
    }

    #[test]
    fn keys_survive_streaming_drop_and_reentry() {
        let mut app = app();
        let inputs = Inputs::default().rects("lots", vec![Rect::new(Vec2::ZERO, Vec2::new(256.0, 32.0))]);
        let v = app
            .world_mut()
            .spawn((PcgVolume { cell: 32.0, ..PcgVolume::new(graph(), inputs, Area::new(Vec2::new(-256.0, -32.0), Vec2::new(256.0, 32.0))) }, PcgStreaming { radius: 30.0, margin: 16.0 }))
            .id();
        let cam = app.world_mut().spawn((MainCamera, GlobalTransform::from_xyz(-200.0, 2.0, 0.0))).id();
        run_until_done(&mut app);
        let first = cell_seeds(&app, v, IVec2::new(-7, 0), "rocks");
        // An override on that cell, then leave and come back: same keys, edit still applied.
        let victim = first[0];
        let mut ov = PcgOverrides::default();
        ov.remove_point(&PointKey { node: "rocks".into(), seed: victim }, Vec3::new(-200.0, 0.0, 0.0));
        app.world_mut().entity_mut(v).insert(ov);
        settle(&mut app);
        let edited = cell_seeds(&app, v, IVec2::new(-7, 0), "rocks");
        assert_eq!(edited.len(), first.len() - 1);
        app.world_mut().entity_mut(cam).insert(GlobalTransform::from_xyz(200.0, 2.0, 0.0));
        run_until_done(&mut app);
        assert!(app.world().get::<PcgCells>(v).unwrap().cells.get(&IVec2::new(-7, 0)).is_none());
        app.world_mut().entity_mut(cam).insert(GlobalTransform::from_xyz(-200.0, 2.0, 0.0));
        run_until_done(&mut app);
        settle(&mut app);
        assert_eq!(cell_seeds(&app, v, IVec2::new(-7, 0), "rocks"), edited, "same points after re-entry, still without the victim");
    }

    #[test]
    fn pick_finds_merged_instances_and_hand_placed_ones() {
        let (mut app, v) = rock_app();
        let (pos, _) = {
            let c = &app.world().get::<PcgCells>(v).unwrap().cells[&IVec2::new(0, 0)];
            let s = c.output.as_ref().unwrap().spawns.iter().find(|s| s.node == "rocks").unwrap();
            (s.points.pos[2], s.points.seed[2])
        };
        let hit = pcg_pick(app.world(), pos + Vec3::new(0.0, 5.0, 0.0), Vec3::NEG_Y).expect("hit");
        assert_eq!(hit.key.node, "rocks");
        assert_eq!(hit.item, "rock");
        // Nearest along the ray: the picked point is within a rock radius of the ray.
        assert!((hit.transform.translation.xz() - pos.xz()).length() < 0.6);
        let mut ov = PcgOverrides::default();
        let key = ov.add_item("rock", "rocks", Transform::from_xyz(-500.0 + 520.0, 0.5, 6.0));
        app.world_mut().entity_mut(v).insert(ov);
        settle(&mut app);
        let h = pcg_pick(app.world(), Vec3::new(20.0, 5.0, 6.0), Vec3::NEG_Y).expect("hand hit");
        assert_eq!(h.key, key);
        assert!(pcg_pick(app.world(), Vec3::new(20.0, 5.0, 6.0), Vec3::Y).is_none());
    }

    #[test]
    fn overrides_round_trip_through_a_level() {
        use crate::level::{LevelEntity, LevelPlugin, StableId, load_level, save_level};
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, bevy::asset::AssetPlugin::default(), bevy::world_serialization::WorldSerializationPlugin))
            .register_type::<Transform>()
            .register_type::<PcgOverrides>()
            .add_plugins(LevelPlugin);
        app.finish();
        app.cleanup();
        let mut ov = PcgOverrides::default();
        ov.remove_point(&PointKey { node: "rocks".into(), seed: u64::MAX - 3 }, Vec3::new(1.0, 2.0, 3.0));
        ov.move_point(&PointKey { node: "rocks".into(), seed: 77 }, Vec3::X, Transform::from_xyz(4.0, 5.0, 6.0).with_scale(Vec3::splat(1.5)));
        ov.add_item("rock", "rocks", Transform::from_xyz(9.0, 0.0, 9.0));
        ov.areas.push(OverrideArea { polygon: vec![Vec2::ZERO, Vec2::X * 10.0, Vec2::splat(10.0)], density: 0.25, nodes: Some(vec!["rocks".into()]) });
        app.world_mut().spawn((LevelEntity { id: StableId(1) }, ov.clone()));
        let path = std::env::temp_dir().join(format!("pcg-ov-{}.level.ron", std::process::id()));
        save_level(app.world_mut(), &path).unwrap();
        crate::level::file::despawn_level(app.world_mut());
        load_level(app.world_mut(), &path).unwrap();
        let back = app.world_mut().query::<&PcgOverrides>().single(app.world()).unwrap().clone();
        assert_eq!(back, ov);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn graph_assets_parse() {
        let g = graph();
        let ron = g.to_ron();
        assert_eq!(*Graph::from_ron(&ron).unwrap().nodes, *g.nodes);
    }
}
