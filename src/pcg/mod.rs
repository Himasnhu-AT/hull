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

use std::sync::Arc;

use bevy::asset::{AssetLoader, LoadContext, io::Reader};
use bevy::mesh::{Indices, PrimitiveTopology, VertexAttributeValues};
use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use bevy::tasks::{AsyncComputeTaskPool, Task, futures_lite::future};

pub use pcg_core;
use pcg_core::{Area, Graph, Inputs, Output, SpawnKind, keep_for_tier, mix64};

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
}

/// Per volume: its cells.
#[derive(Component, Default)]
pub struct PcgCells {
    cells: HashMap<IVec2, Cell>,
    graph_hash: u64,
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
            .add_systems(Update, (schedule_cells, collect_cells, spawn_cells).chain());
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

/// Starts evaluations for cells whose key (graph + nearby inputs) changed, nearest first.
fn schedule_cells(
    mut commands: Commands,
    mut volumes: Query<(Entity, &PcgVolume, Option<&mut PcgCells>)>,
    assets: Res<Assets<PcgGraphAsset>>,
    settings: Res<PcgSettings>,
    cam: Query<&GlobalTransform, With<MainCamera>>,
    mut todo: Local<Vec<(f32, Entity, IVec2)>>,
) {
    let eye = cam.iter().next().map(|g| Vec2::new(g.translation().x, g.translation().z)).unwrap_or(Vec2::ZERO);
    let mut running = 0;
    todo.clear();
    for (e, v, cells) in &mut volumes {
        let Some(mut cells) = cells else {
            commands.entity(e).insert(PcgCells::default());
            continue;
        };
        let Some(g) = graph_of(v, &assets) else { continue };
        let ghash = g.hash();
        let halo = g.halo(&v.inputs);
        cells.graph_hash = ghash;
        let size = v.cell.max(1.0);
        let wanted: Vec<IVec2> = cells_of(v.area, size).collect();
        // Cells no longer in the area: drop them.
        cells.cells.retain(|k, c| {
            let keep = wanted.contains(k);
            if !keep && let Some(r) = c.root.take() {
                commands.entity(r).try_despawn();
            }
            keep
        });
        for k in wanted {
            let area = Area::cell(k.x, k.y, size).intersect(v.area);
            let key = mix64(ghash ^ v.inputs.hash_in(area.expand(halo)));
            let c = cells.cells.entry(k).or_insert(Cell { key: 0, output: None, task: None, root: None, spawned_with: None });
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
        let Ok((_, v, Some(mut cells))) = volumes.get_mut(e) else { continue };
        let Some(g) = graph_of(v, &assets) else { continue };
        let size = v.cell.max(1.0);
        let area = Area::cell(k.x, k.y, size).intersect(v.area);
        let halo = g.halo(&v.inputs);
        let key = mix64(cells.graph_hash ^ v.inputs.hash_in(area.expand(halo)));
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
    mut volumes: Query<(Entity, &mut PcgCells)>,
    catalog: Res<PcgCatalog>,
    scal: Res<PcgScalability>,
    settings: Res<PcgSettings>,
    quality: Option<Res<crate::settings::CoreSettings>>,
    governor: Option<Res<crate::render_budget::GovernorState>>,
    mut meshes: Option<ResMut<Assets<Mesh>>>,
    mut emitted: MessageWriter<PcgEmitted>,
    mut stats: ResMut<PcgStats>,
) {
    let thin = thinning(&scal, &settings, quality.as_deref(), governor.as_deref());
    let mut budget = settings.cells_per_frame.max(1);
    let (mut cells_n, mut pending) = (0u32, 0u32);
    for (volume, mut cells) in &mut volumes {
        for (k, c) in cells.cells.iter_mut() {
            cells_n += 1;
            let Some(out) = c.output.clone() else {
                pending += 1;
                continue;
            };
            if c.spawned_with == Some(thin) {
                continue;
            }
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
                commands.entity(r).try_despawn();
            }
            let first = c.spawned_with.is_none();
            if !first {
                // Respawned from the cached output (thinning changed): no evaluation.
                stats.cache_hits += 1;
            }
            c.root = Some(spawn_output(&mut commands, volume, *k, &out, &catalog, &settings, thin, meshes.as_deref_mut(), &mut stats));
            c.spawned_with = Some(thin);
            if first {
                for (port, points) in &out.emits {
                    emitted.write(PcgEmitted { volume, cell: *k, port: port.clone(), points: points.clone() });
                }
            }
        }
    }
    stats.volumes = volumes.iter().len() as u32;
    stats.entities = volumes.iter().map(|(_, c)| c.cells.values().filter(|c| c.root.is_some()).count() as u32).sum();
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
        for k in 0..p.len() {
            if keep_for_tier(p.seed[k], s.def.tier, normal, fine) {
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
                    let merged = meshes.as_deref_mut().and_then(|ms| {
                        let src = ms.get(&m.mesh)?;
                        (idx.len() >= settings.merge_min_count && src.count_vertices() <= settings.merge_max_vertices)
                            .then(|| merge(src, idx.iter().map(|&k| tf(k))))
                            .flatten()
                            .map(|mesh| ms.add(mesh))
                    });
                    match merged {
                        Some(h) => {
                            let mut e = commands.spawn((Name::new(format!("pcg {name}")), Mesh3d(h), MeshMaterial3d(m.material.clone()), Transform::default(), Scenery));
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
    use bevy::prelude::*;
    use serde_json::{Value, json};

    use super::*;
    use crate::devtools::{AddControlCommand, params};

    pub(super) fn register(app: &mut App) {
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
            "cache_hits": s.cache_hits, "cell_roots": s.entities, "points_spawned": s.points_spawned,
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
    fn graph_assets_parse() {
        let g = graph();
        let ron = g.to_ron();
        assert_eq!(*Graph::from_ron(&ron).unwrap().nodes, *g.nodes);
    }
}
