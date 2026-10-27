//! Large worlds (feature `world`): terrain, scatter/foliage, cell streaming of gameplay data and
//! colliders, HLOD, floating origin, and worlds described as data. The code-first answer to
//! Unreal's World Partition / Landscape / Foliage. Docs: `docs/WORLD.md`.
//!
//! ```ignore
//! use engine::prelude::*;
//! use engine::world::*;
//! fn setup(mut commands: Commands) {
//!     let desc = WorldDesc::from_ron(include_str!("../assets/world.ron")).unwrap();
//!     commands.queue(SpawnWorld(desc));
//! }
//! ```
//!
//! Everything static the world spawns lives under one [`WorldRoot`] entity:
//!
//! ```text
//! WorldRoot (Transform = -WorldOrigin offset)
//!  ├─ terrain chunks      visual, LOD'd by screen-space error (never streamed; skirts hide cracks)
//!  ├─ terrain colliders   resident mode: every chunk's heightfield collider
//!  ├─ coarse collider     streamed mode: one low-res collider under the whole map (always there)
//!  ├─ cells               WorldCell roots: chunk colliders (streamed mode), prefabs,
//!  │                      scatter colliders, game hooks — loaded/unloaded as a unit
//!  ├─ scatter clusters    visual only, spawned by camera distance per rule
//!  └─ HLOD proxies        one merged + simplified mesh per (cell, material), shown when far
//! ```
//!
//! Coordinates: every `world` API takes **absolute** metres. With the floating origin off (the
//! default) absolute = Bevy world space. With it on, Bevy space = absolute − [`WorldOrigin`].
//!
//! **Streaming contract** (opt-in, [`StreamMode::Streamed`]): the default
//! [`StreamMode::Resident`] keeps every collider and prefab spawned, like the render budget's
//! "colliders are never streamed" rule. In streamed mode only cells near a [`StreamSource`]
//! (the main camera is always one) are loaded; physics and AI only see loaded cells, plus the
//! coarse fallback collider that keeps anything from falling through the world. Put
//! [`StreamSource`] on the player and on any AI agent that must keep simulating, and
//! [`StreamFreeze`] on dynamic bodies that should sleep (avian `RigidBodyDisabled`) while their
//! cell is unloaded. React to [`CellLoaded`] / [`CellUnloaded`] for gameplay data.

use bevy::prelude::*;
use serde::Serialize;

pub mod cells;
#[cfg(feature = "devtools")]
mod control;
pub mod desc;
pub mod heightfield;
pub mod hlod;
pub mod material;
pub mod noise;
pub mod origin;
pub mod prefab;
pub mod scatter;
pub mod terrain;

pub use cells::{CellId, CellLoaded, CellUnloaded, StreamFreeze, StreamSource, WorldCell, WorldCells};
pub use desc::{SpawnWorld, WorldDesc, WorldError, despawn_world, spawn_world};
pub use heightfield::{Heightfield, NoiseTerrain};
pub use hlod::{merge_meshes, simplify_clustered};
pub use material::{SplatLayer, TerrainExt, TerrainMaterial};
pub use noise::Fbm;
pub use origin::{OriginShifted, WorldOrigin};
pub use prefab::{MaterialDesc, PartDesc, PrefabDef, ShapeDesc, WorldAssets, WorldTags};
pub use scatter::{ScatterMesh, ScatterRule};
pub use terrain::{Terrain, TerrainChunk};

/// Parent of everything the world spawns (see the module docs). Its transform is the floating
/// origin's negated offset.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct WorldRoot;

/// How cells (gameplay data, prefabs, colliders) are kept.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub enum StreamMode {
    /// Everything loaded at spawn and kept (the default; physics/AI see the whole map).
    #[default]
    Resident,
    /// Cells load near [`StreamSource`]s and unload when far; a coarse collider stays.
    Streamed,
}

/// Terrain detail.
#[derive(Clone, Debug, PartialEq)]
pub struct TerrainSettings {
    /// Allowed screen-space height error in pixels (lower = more triangles).
    pub pixel_error: f32,
    /// Pixels per radian of view at distance 1 (≈ viewport height / (2·tan(fov/2)); 1080p at
    /// 60° ≈ 935). Used when no camera projection is known.
    pub screen_scale: f32,
    /// Within this distance chunks are always full detail; LOD n is allowed from
    /// `lod_distance · 2^(n-1)` on (0 = chunk size).
    pub lod_distance: f32,
    /// A chunk only goes coarser once `distance / (1 + hysteresis)` allows it (no flicker).
    pub hysteresis: f32,
    /// Chunk meshes being built in background tasks at once.
    pub max_builds_in_flight: usize,
    /// Coarsest LOD (each level halves the vertex grid; capped by the chunk size).
    pub max_lod: u8,
    /// Chunks farther than this aren't drawn (`f32::INFINITY` = all).
    pub view_distance: f32,
    /// Spawn heightfield colliders (feature `physics`).
    pub colliders: bool,
}

impl Default for TerrainSettings {
    fn default() -> Self {
        TerrainSettings {
            pixel_error: 2.0,
            screen_scale: 935.0,
            lod_distance: 0.0,
            hysteresis: 0.15,
            max_builds_in_flight: 8,
            max_lod: 6,
            view_distance: f32::INFINITY,
            colliders: true,
        }
    }
}

/// Cell streaming (gameplay data + colliders).
#[derive(Clone, Debug, PartialEq)]
pub struct StreamingSettings {
    pub mode: StreamMode,
    /// A cell loads when its nearest point is within this of a [`StreamSource`]...
    pub load_radius: f32,
    /// ...and unloads when it is farther than this from all of them (must be ≥ `load_radius`).
    pub unload_radius: f32,
    /// Cells loaded per frame (nearest first); unloads are not limited.
    pub loads_per_frame: usize,
    /// Fallback collider resolution: one sample every `coarse_step` terrain samples.
    pub coarse_step: u32,
    /// Fallback collider sits this far below the real terrain (it is never above it).
    pub coarse_margin: f32,
}

impl Default for StreamingSettings {
    fn default() -> Self {
        StreamingSettings { mode: StreamMode::Resident, load_radius: 400.0, unload_radius: 480.0, loads_per_frame: 2, coarse_step: 8, coarse_margin: 0.05 }
    }
}

/// Vertices of a merged scatter cluster that cost one item of
/// [`ScatterSettings::max_items_per_frame`].
pub const MERGED_VERTICES_PER_ITEM: usize = 500;

/// Scatter visuals.
#[derive(Clone, Debug, PartialEq)]
pub struct ScatterSettings {
    pub enabled: bool,
    /// Multiplies every rule's distances (on top of the quality preset's detail scale).
    pub distance_scale: f32,
    /// Follow `QualityPreset::detail_scale` (through the render budget's effective ranges).
    pub follow_quality: bool,
    /// Cluster meshes built in background tasks at once.
    pub max_builds_in_flight: usize,
    /// Clusters despawn this far beyond their spawn distance.
    pub hysteresis: f32,
    /// Spawn every cluster up front instead of by distance (baseline / small maps).
    pub resident: bool,
    /// Spawn budget per frame: one per instanced item, one per [`MERGED_VERTICES_PER_ITEM`]
    /// vertices of a merged cluster. Every new mesh entity costs render-world work (extract,
    /// specialize, upload) in the frame it appears; 3000 at once read as 20–60 ms hitches.
    pub max_items_per_frame: usize,
}

impl Default for ScatterSettings {
    fn default() -> Self {
        ScatterSettings { enabled: true, distance_scale: 1.0, follow_quality: true, max_builds_in_flight: 16, hysteresis: 16.0, resident: false, max_items_per_frame: 1000 }
    }
}

/// Hierarchical LOD for prefabs.
#[derive(Clone, Debug, PartialEq)]
pub struct HlodSettings {
    pub enabled: bool,
    /// A cell's prefabs draw within this distance (to the cell's rectangle); beyond it, its
    /// HLOD proxy.
    pub distance: f32,
    /// Proxies beyond this aren't drawn.
    pub view: f32,
    /// Vertex-clustering grid in metres (bigger = fewer vertices).
    pub voxel: f32,
    /// Switch band (metres) so standing on the boundary doesn't flicker.
    pub hysteresis: f32,
}

impl Default for HlodSettings {
    fn default() -> Self {
        HlodSettings { enabled: true, distance: 320.0, view: 4000.0, voxel: 1.0, hysteresis: 24.0 }
    }
}

/// Floating origin.
#[derive(Clone, Debug, PartialEq)]
pub struct OriginSettings {
    pub enabled: bool,
    /// Rebase when the camera is farther than this from the current origin (XZ metres).
    pub threshold: f32,
    /// Rebases snap to multiples of this (keeps offsets exact in f32).
    pub snap: f32,
}

impl Default for OriginSettings {
    fn default() -> Self {
        OriginSettings { enabled: false, threshold: 2048.0, snap: 256.0 }
    }
}

/// All world budgets and switches. Change at runtime; build with `..default()`.
#[derive(Resource, Clone, Debug, Default, PartialEq)]
pub struct WorldSettings {
    pub terrain: TerrainSettings,
    pub streaming: StreamingSettings,
    pub scatter: ScatterSettings,
    pub hlod: HlodSettings,
    pub origin: OriginSettings,
}

/// What the world is doing (filled every frame; `world.stats` returns it).
#[derive(Resource, Clone, Debug, Default, Serialize)]
pub struct WorldStats {
    pub spawned: bool,
    pub terrain_chunks: u32,
    pub terrain_chunks_drawn: u32,
    /// Chunks per LOD (index = LOD).
    pub terrain_lods: [u32; 8],
    pub terrain_triangles: u64,
    pub terrain_builds_in_flight: u32,
    pub terrain_mesh_bytes: u64,
    pub heightfield_bytes: u64,
    pub terrain_colliders: u32,
    pub cells_total: u32,
    pub cells_loaded: u32,
    pub cells_queued: u32,
    pub cells_loaded_frame: u32,
    pub cells_unloaded_frame: u32,
    pub prefabs_live: u32,
    pub frozen_bodies: u32,
    pub scatter_clusters: u32,
    pub scatter_instances: u64,
    pub scatter_vertices: u64,
    pub scatter_builds_in_flight: u32,
    /// Per rule: (name, clusters spawned, instances, vertices).
    pub scatter_rules: Vec<(String, u32, u64, u64)>,
    pub scatter_colliders: u32,
    pub hlod_proxies: u32,
    pub hlod_pending: u32,
    pub hlod_vertices: u64,
    pub hlod_source_vertices: u64,
    pub hlod_cells_far: u32,
    pub origin_offset: [f64; 2],
    pub origin_shifts: u32,
    /// CPU time of the world's own systems last frame (µs).
    pub cpu_us: f32,
}

/// System sets (all in `PostUpdate` before transform propagation, except the origin shift,
/// which runs in `First`).
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub enum WorldSystems {
    /// Cell residency, loads/unloads, freeze.
    Cells,
    /// Terrain LOD and chunk meshes.
    Terrain,
    /// Scatter clusters.
    Scatter,
    /// HLOD builds and near/far switching.
    Hlod,
    /// Stats.
    Stats,
}

/// Accumulated CPU time of the world systems this frame.
#[derive(Resource, Default)]
pub(crate) struct WorldCpu(std::sync::atomic::AtomicU64);

pub(crate) struct WorldTimer<'a>(&'a WorldCpu, std::time::Instant);

impl WorldCpu {
    pub(crate) fn time(&self) -> WorldTimer<'_> {
        WorldTimer(self, std::time::Instant::now())
    }
}

impl Drop for WorldTimer<'_> {
    fn drop(&mut self) {
        self.0.0.fetch_add(self.1.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
    }
}

/// The world plugin (added by `EnginePlugin` with feature `world`). Does nothing until a
/// world is spawned ([`spawn_world`] / [`SpawnWorld`]).
pub struct WorldPlugin;

impl Plugin for WorldPlugin {
    fn build(&self, app: &mut App) {
        use bevy::transform::TransformSystems;
        app.init_resource::<WorldSettings>()
            .init_resource::<WorldStats>()
            .init_resource::<WorldOrigin>()
            .init_resource::<WorldCpu>()
            .init_resource::<WorldAssets>()
            .add_message::<CellLoaded>()
            .add_message::<CellUnloaded>()
            .add_message::<OriginShifted>()
            .configure_sets(
                PostUpdate,
                (WorldSystems::Cells, WorldSystems::Terrain, WorldSystems::Scatter, WorldSystems::Hlod, WorldSystems::Stats)
                    .chain()
                    .before(TransformSystems::Propagate)
                    .before(crate::render_budget::RenderBudgetSystems::Stream),
            )
            .add_plugins((origin::OriginPlugin, cells::CellsPlugin, terrain::TerrainPlugin, scatter::ScatterPlugin, hlod::HlodPlugin, material::TerrainMaterialPlugin))
            .add_systems(PostUpdate, finish_stats.in_set(WorldSystems::Stats));
        #[cfg(feature = "devtools")]
        control::register(app);
    }
}

fn finish_stats(cpu: Res<WorldCpu>, mut stats: ResMut<WorldStats>, origin: Res<WorldOrigin>, metrics: Option<ResMut<MetricsRes>>) {
    stats.cpu_us = cpu.0.swap(0, std::sync::atomic::Ordering::Relaxed) as f32 / 1000.0;
    stats.origin_offset = [origin.offset.x, origin.offset.y];
    stats.origin_shifts = origin.shifts;
    #[cfg(feature = "devtools")]
    if let Some(mut m) = metrics
        && stats.spawned
    {
        m.record("world.cpu_us", stats.cpu_us as f64);
        m.record("world.terrain_triangles", stats.terrain_triangles as f64);
        m.record("world.terrain_chunks_drawn", stats.terrain_chunks_drawn as f64);
        m.record("world.cells_loaded", stats.cells_loaded as f64);
        m.record("world.scatter_instances", stats.scatter_instances as f64);
        m.record("world.scatter_clusters", stats.scatter_clusters as f64);
        m.record("world.hlod_cells_far", stats.hlod_cells_far as f64);
    }
    #[cfg(not(feature = "devtools"))]
    let _ = metrics;
}

#[cfg(feature = "devtools")]
type MetricsRes = crate::devtools::Metrics;
/// Stand-in so `finish_stats` has one signature (never inserted).
#[cfg(not(feature = "devtools"))]
#[derive(Resource)]
struct MetricsRes;

/// Main camera position in absolute coordinates (None without a camera).
pub(crate) fn camera_abs(cams: &Query<&GlobalTransform, With<crate::gfx::MainCamera>>, origin: &WorldOrigin) -> Option<Vec3> {
    cams.iter().next().map(|g| origin.to_abs(g.translation()))
}

/// Whether the renderer's asset types exist (not headless).
pub(crate) fn has_render(world: &World) -> bool {
    world.contains_resource::<Assets<StandardMaterial>>()
}
