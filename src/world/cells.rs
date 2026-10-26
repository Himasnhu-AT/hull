//! World cells: the unit of gameplay streaming. A cell is a square of the terrain grid that,
//! when loaded, owns a root entity ([`WorldCell`]) with its terrain chunk colliders, prefabs,
//! scatter colliders and whatever the game's hooks spawn ([`WorldCells::on_load`]).
//!
//! [`super::StreamMode::Resident`] (default) loads every cell at spawn and never unloads.
//! [`super::StreamMode::Streamed`] loads cells whose rectangle is within `load_radius` of any
//! [`StreamSource`] (the main camera always counts), nearest first, `loads_per_frame` per frame,
//! and unloads them beyond `unload_radius` (despawning the cell root and everything under it).
//! A coarse heightfield collider ([`Heightfield::coarse_below`]) under the whole map stays
//! loaded, so bodies outside loaded cells land on (approximately) the ground instead of falling
//! forever.
//!
//! Gameplay contract in streamed mode:
//! - Spawn per-cell gameplay data from a hook or on [`CellLoaded`]; parent it to the cell root
//!   to have it unloaded with the cell. Persist state you need across unloads yourself (keyed by
//!   [`CellId`]); [`CellUnloaded`] is sent after the root is despawned.
//! - Dynamic bodies and AI that must keep simulating get a [`StreamSource`] (with a small
//!   radius) so the ground around them stays loaded; others get [`StreamFreeze`], which disables
//!   their rigid body while their cell is unloaded.
//! - Before placing something far away (teleports, spawns), check
//!   [`WorldCells::ready_around`]; or wait for [`CellLoaded`].

use std::sync::Arc;

use bevy::prelude::*;

#[cfg(feature = "physics")]
use super::heightfield::Heightfield;
use super::hlod::HlodState;
use super::prefab::{RenderAssets, spawn_prefab};
use super::scatter::Scatter;
use super::terrain::Terrain;
#[cfg(feature = "physics")]
use super::terrain::TerrainCollider;
use super::{StreamMode, WorldAssets, WorldCpu, WorldOrigin, WorldRoot, WorldSettings, WorldStats, WorldSystems};
use crate::gfx::MainCamera;
use crate::render_budget::{KeepDetail, Scenery};

/// Cell coordinates (`floor((abs - grid origin) / cell size)`).
pub type CellId = IVec2;

/// Root of a loaded cell.
#[derive(Component, Clone, Copy, Debug)]
pub struct WorldCell {
    pub id: CellId,
}

/// Keeps cells around this entity loaded (streamed mode). `radius` overrides the settings'
/// `load_radius` for this source (e.g. 64 m for an AI agent).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct StreamSource {
    pub radius: Option<f32>,
}

/// Disable this dynamic body's physics (avian `RigidBodyDisabled`) while its cell is unloaded.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct StreamFreeze;

/// Marker: a [`StreamFreeze`] entity currently frozen by the world.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Frozen;

/// The always-loaded coarse collider (streamed mode).
#[derive(Component, Clone, Copy, Debug)]
pub struct CoarseCollider;

#[derive(Message, Clone, Copy, Debug)]
pub struct CellLoaded {
    pub cell: CellId,
    pub root: Entity,
}

#[derive(Message, Clone, Copy, Debug)]
pub struct CellUnloaded {
    pub cell: CellId,
}

/// What a cell hook gets.
pub struct CellCtx {
    pub cell: CellId,
    pub root: Entity,
    /// Absolute min corner and side.
    pub min: Vec2,
    pub size: f32,
    /// Render assets exist (false headless).
    pub visuals: bool,
}

/// Runs when a cell loads: spawn gameplay content under `ctx.root`.
pub type CellHook = Arc<dyn Fn(&mut Commands, &CellCtx) + Send + Sync>;

/// A placed prefab (absolute transform).
#[derive(Clone, Debug)]
pub struct Placed {
    pub prefab: Arc<str>,
    pub transform: Transform,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellState {
    Unloaded,
    Loaded(Entity),
}

/// The cell grid and what is loaded.
#[derive(Resource)]
pub struct WorldCells {
    size: f32,
    origin: Vec2,
    dims: IVec2,
    states: Vec<CellState>,
    placed: Vec<Vec<Placed>>,
    /// Colliders spawned per cell (terrain chunks, scatter) while loaded.
    colliders: Vec<(u32, u32)>,
    hooks: Vec<CellHook>,
    queue: Vec<(f32, u32)>,
    pub(crate) loads_total: u64,
    pub(crate) unloads_total: u64,
}

impl WorldCells {
    /// A grid of `size`-metre cells covering `[min, max]` (absolute).
    pub fn new(min: Vec2, max: Vec2, size: f32) -> Self {
        let size = size.max(1.0);
        let dims = ((max - min) / size).ceil().as_ivec2().max(IVec2::ONE);
        let n = (dims.x * dims.y) as usize;
        WorldCells { size, origin: min, dims, states: vec![CellState::Unloaded; n], placed: vec![Vec::new(); n], colliders: vec![(0, 0); n], hooks: Vec::new(), queue: Vec::new(), loads_total: 0, unloads_total: 0 }
    }
    pub fn cell_size(&self) -> f32 {
        self.size
    }
    pub fn dims(&self) -> IVec2 {
        self.dims
    }
    pub fn len(&self) -> usize {
        self.states.len()
    }
    pub fn is_empty(&self) -> bool {
        self.states.is_empty()
    }
    fn index(&self, c: CellId) -> Option<usize> {
        (c.x >= 0 && c.y >= 0 && c.x < self.dims.x && c.y < self.dims.y).then(|| (c.y * self.dims.x + c.x) as usize)
    }
    fn id(&self, i: usize) -> CellId {
        IVec2::new(i as i32 % self.dims.x, i as i32 / self.dims.x)
    }
    /// Cell containing absolute `(x, z)` (may be outside the grid).
    pub fn cell_at(&self, p: Vec2) -> CellId {
        ((p - self.origin) / self.size).floor().as_ivec2()
    }
    /// Absolute min corner of a cell.
    pub fn cell_min(&self, c: CellId) -> Vec2 {
        self.origin + c.as_vec2() * self.size
    }
    /// XZ distance from `p` to the cell's rectangle (0 inside).
    pub fn distance(&self, c: CellId, p: Vec2) -> f32 {
        let lo = self.cell_min(c);
        (p.clamp(lo, lo + Vec2::splat(self.size)) - p).length()
    }
    pub fn state(&self, c: CellId) -> CellState {
        self.index(c).map_or(CellState::Unloaded, |i| self.states[i])
    }
    pub fn is_loaded(&self, c: CellId) -> bool {
        matches!(self.state(c), CellState::Loaded(_))
    }
    /// The cell under absolute `p` is loaded (outside the grid: `true`, nothing to load).
    pub fn is_loaded_at(&self, p: Vec2) -> bool {
        let c = self.cell_at(p);
        self.index(c).is_none() || self.is_loaded(c)
    }
    /// Every cell touching the circle (absolute centre, radius) is loaded.
    pub fn ready_around(&self, p: Vec2, radius: f32) -> bool {
        let lo = self.cell_at(p - Vec2::splat(radius));
        let hi = self.cell_at(p + Vec2::splat(radius));
        (lo.y..=hi.y).all(|z| (lo.x..=hi.x).all(|x| {
            let c = IVec2::new(x, z);
            self.index(c).is_none() || self.distance(c, p) > radius || self.is_loaded(c)
        }))
    }
    pub fn loaded(&self) -> impl Iterator<Item = (CellId, Entity)> + '_ {
        self.states.iter().enumerate().filter_map(|(i, s)| match s {
            CellState::Loaded(e) => Some((self.id(i), *e)),
            CellState::Unloaded => None,
        })
    }
    pub fn loaded_count(&self) -> usize {
        self.states.iter().filter(|s| matches!(s, CellState::Loaded(_))).count()
    }
    /// Prefabs placed in a cell.
    pub fn placed(&self, c: CellId) -> &[Placed] {
        self.index(c).map_or(&[], |i| &self.placed[i])
    }
    /// Adds a prefab placement (absolute transform) to its cell; it spawns the next time the
    /// cell loads (call before spawn for resident worlds, or reload the cell).
    pub fn place(&mut self, prefab: &str, transform: Transform) {
        let c = self.cell_at(transform.translation.xz());
        if let Some(i) = self.index(c) {
            self.placed[i].push(Placed { prefab: prefab.into(), transform });
        }
    }
    /// Registers a hook run for every cell that loads from now on.
    pub fn on_load(&mut self, f: impl Fn(&mut Commands, &CellCtx) + Send + Sync + 'static) {
        self.hooks.push(Arc::new(f));
    }
    /// Cells waiting to load.
    pub fn queued(&self) -> usize {
        self.queue.len()
    }
}

pub(super) struct CellsPlugin;

impl Plugin for CellsPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostUpdate, (update_cells, freeze_outside, coarse_collider).chain().in_set(WorldSystems::Cells));
    }
}

#[derive(bevy::ecs::system::SystemParam)]
pub(crate) struct CellLoader<'w, 's> {
    commands: Commands<'w, 's>,
    cells: Option<ResMut<'w, WorldCells>>,
    terrain: Option<Res<'w, Terrain>>,
    scatter: Option<Res<'w, Scatter>>,
    hlod: Res<'w, HlodState>,
    assets: ResMut<'w, WorldAssets>,
    meshes: Option<ResMut<'w, Assets<Mesh>>>,
    mats: Option<ResMut<'w, Assets<StandardMaterial>>>,
    loaded: MessageWriter<'w, CellLoaded>,
    unloaded: MessageWriter<'w, CellUnloaded>,
    settings: Res<'w, WorldSettings>,
}

fn update_cells(
    mut ld: CellLoader,
    origin: Res<WorldOrigin>,
    cams: Query<&GlobalTransform, With<MainCamera>>,
    sources: Query<(&GlobalTransform, &StreamSource)>,
    roots: Query<Entity, With<WorldRoot>>,
    mut stats: ResMut<WorldStats>,
    mut eyes: Local<Vec<(Vec2, f32)>>,
    cpu: Res<WorldCpu>,
) {
    let _t = cpu.time();
    let Some(root) = roots.iter().next() else { return };
    let Some(mut cells) = ld.cells.take() else { return };
    let s = ld.settings.streaming.clone();
    eyes.clear();
    if let Some(c) = super::camera_abs(&cams, &origin) {
        eyes.push((c.xz(), s.load_radius));
    }
    for (g, src) in &sources {
        eyes.push((origin.to_abs(g.translation()).xz(), src.radius.unwrap_or(s.load_radius)));
    }
    let resident = s.mode == StreamMode::Resident;
    let extra = (s.unload_radius - s.load_radius).max(0.0);
    stats.cells_loaded_frame = 0;
    stats.cells_unloaded_frame = 0;
    cells.queue.clear();
    for i in 0..cells.states.len() {
        let id = cells.id(i);
        let (want, keep, d) = if resident {
            (true, true, 0.0)
        } else {
            let mut best = f32::MAX;
            let (mut want, mut keep) = (false, false);
            for &(p, r) in eyes.iter() {
                let d = cells.distance(id, p);
                best = best.min(d);
                want |= d <= r;
                keep |= d <= r + extra;
            }
            (want, keep, best)
        };
        match cells.states[i] {
            CellState::Loaded(e) if !keep => {
                ld.commands.entity(e).try_despawn();
                cells.states[i] = CellState::Unloaded;
                cells.unloads_total += 1;
                stats.cells_unloaded_frame += 1;
                ld.unloaded.write(CellUnloaded { cell: id });
            }
            CellState::Unloaded if want => cells.queue.push((d, i as u32)),
            _ => {}
        }
    }
    cells.queue.sort_by(|a, b| a.0.total_cmp(&b.0));
    let budget = if resident { usize::MAX } else { s.loads_per_frame.max(1) };
    let n = budget.min(cells.queue.len());
    let todo: Vec<u32> = cells.queue.drain(..n).map(|q| q.1).collect();
    for i in todo {
        let id = cells.id(i as usize);
        let e = load_cell(&mut ld, &mut cells, id, root);
        cells.states[i as usize] = CellState::Loaded(e);
        cells.loads_total += 1;
        stats.cells_loaded_frame += 1;
    }
    stats.cells_total = cells.len() as u32;
    stats.cells_loaded = cells.loaded_count() as u32;
    stats.cells_queued = cells.queue.len() as u32;
    stats.prefabs_live = cells.loaded().map(|(id, _)| cells.placed(id).len() as u32).sum();
    let (mut tc, mut sc) = (0, 0);
    for (i, s) in cells.states.iter().enumerate() {
        if matches!(s, CellState::Loaded(_)) {
            tc += cells.colliders[i].0;
            sc += cells.colliders[i].1;
        }
    }
    stats.terrain_colliders = tc;
    stats.scatter_colliders = sc;
}

/// Spawns a cell's root and content. Returns the root.
fn load_cell(ld: &mut CellLoader, cells: &mut WorldCells, id: CellId, world_root: Entity) -> Entity {
    let min = cells.cell_min(id);
    let size = cells.size;
    let hidden = ld.hlod.is_far(id);
    let root = ld
        .commands
        .spawn((
            Name::new(format!("cell {} {}", id.x, id.y)),
            WorldCell { id },
            Transform::from_xyz(min.x, 0.0, min.y),
            if hidden { Visibility::Hidden } else { Visibility::Inherited },
            Scenery,
            KeepDetail,
            ChildOf(world_root),
        ))
        .id();
    let corner = Vec3::new(min.x, 0.0, min.y);
    #[cfg(not(feature = "physics"))]
    let _ = (&ld.terrain, &ld.scatter);
    #[allow(unused_mut)]
    let mut counts = (0u32, 0u32);
    // Terrain chunk colliders whose centre is in this cell.
    #[cfg(feature = "physics")]
    if ld.settings.terrain.colliders
        && let Some(t) = ld.terrain.as_deref()
    {
        let n = t.chunks();
        let cs = t.chunk_size();
        let o = t.heightfield().origin();
        let c0 = ((min - o) / cs).floor().as_ivec2().max(IVec2::ZERO);
        let c1 = ((min + Vec2::splat(size) - o) / cs).ceil().as_ivec2().min(n.as_ivec2());
        for cz in c0.y..c1.y {
            for cx in c0.x..c1.x {
                let c = UVec2::new(cx as u32, cz as u32);
                let center = t.chunk_origin(c) + Vec2::splat(cs * 0.5);
                if cells.cell_at(center) != id {
                    continue;
                }
                let (col, at) = super::terrain::chunk_collider(t, c);
                counts.0 += 1;
                ld.commands.spawn((Name::new("terrain collider"), TerrainCollider { coord: c }, avian3d::prelude::RigidBody::Static, col, Transform::from_translation(at - corner), ChildOf(root)));
            }
        }
    }
    // Prefabs.
    let mut render = match (ld.meshes.as_deref_mut(), ld.mats.as_deref_mut()) {
        (Some(meshes), Some(mats)) => Some(RenderAssets { meshes, mats }),
        _ => None,
    };
    if let Some(i) = cells.index(id) {
        for p in &cells.placed[i] {
            let mut tf = p.transform;
            tf.translation -= corner;
            spawn_prefab(&mut ld.commands, &mut ld.assets, render.as_mut(), &p.prefab, tf, p.transform.translation, root, id);
        }
    }
    // Scatter colliders.
    #[cfg(feature = "physics")]
    if let Some(sc) = ld.scatter.as_deref() {
        for (ri, r) in sc.rules().enumerate() {
            let Some(c) = r.collider else { continue };
            for inst in sc.place(ri, min, min + Vec2::splat(size)) {
                let h = c.height * inst.scale;
                counts.1 += 1;
                ld.commands.spawn((
                    avian3d::prelude::RigidBody::Static,
                    avian3d::prelude::Collider::cylinder(c.radius * inst.scale, h),
                    Transform::from_translation(inst.pos - corner + Vec3::Y * h * 0.5),
                    ChildOf(root),
                ));
            }
        }
    }
    if let Some(i) = cells.index(id) {
        cells.colliders[i] = counts;
    }
    let ctx = CellCtx { cell: id, root, min, size, visuals: render.is_some() };
    for h in cells.hooks.clone() {
        h(&mut ld.commands, &ctx);
    }
    ld.loaded.write(CellLoaded { cell: id, root });
    root
}

/// Freezes [`StreamFreeze`] bodies outside loaded cells.
fn freeze_outside(
    mut commands: Commands,
    cells: Option<Res<WorldCells>>,
    origin: Res<WorldOrigin>,
    q: Query<(Entity, &GlobalTransform, Has<Frozen>), With<StreamFreeze>>,
    mut stats: ResMut<WorldStats>,
) {
    let Some(cells) = cells else { return };
    let mut frozen = 0;
    for (e, g, is_frozen) in &q {
        let ok = cells.is_loaded_at(origin.to_abs(g.translation()).xz());
        if ok && is_frozen {
            commands.entity(e).remove::<Frozen>();
            #[cfg(feature = "physics")]
            commands.entity(e).remove::<avian3d::prelude::RigidBodyDisabled>();
        } else if !ok && !is_frozen {
            commands.entity(e).insert(Frozen);
            #[cfg(feature = "physics")]
            commands.entity(e).insert(avian3d::prelude::RigidBodyDisabled);
        }
        frozen += (!ok) as u32;
    }
    stats.frozen_bodies = frozen;
}

/// Keeps the coarse fallback collider present exactly in streamed mode.
fn coarse_collider(
    mut commands: Commands,
    settings: Res<WorldSettings>,
    terrain: Option<Res<Terrain>>,
    roots: Query<Entity, With<WorldRoot>>,
    existing: Query<Entity, With<CoarseCollider>>,
    mut stats: ResMut<WorldStats>,
) {
    let want = settings.streaming.mode == StreamMode::Streamed && settings.terrain.colliders && cfg!(feature = "physics");
    let have = existing.iter().next();
    match (want, have, terrain, roots.iter().next()) {
        (true, None, Some(t), Some(root)) => {
            #[cfg(feature = "physics")]
            {
                let coarse: Heightfield = t.heightfield().coarse_below(settings.streaming.coarse_step, settings.streaming.coarse_margin);
                let (col, at) = super::terrain::region_collider(&coarse, 0, 0, coarse.nx() as i64 - 1, coarse.nz() as i64 - 1);
                commands.spawn((Name::new("coarse terrain collider"), CoarseCollider, avian3d::prelude::RigidBody::Static, col, Transform::from_translation(at), ChildOf(root)));
            }
            let _ = (t, root);
        }
        (false, Some(e), _, _) => {
            commands.entity(e).try_despawn();
        }
        _ => {}
    }
    let _ = &mut stats;
}

/// Unloads and reloads every loaded cell (after editing placements or hooks).
pub fn reload_cells(world: &mut World) {
    let Some(mut cells) = world.get_resource_mut::<WorldCells>() else { return };
    let mut gone = Vec::new();
    for s in cells.states.iter_mut() {
        if let CellState::Loaded(e) = *s {
            gone.push(e);
            *s = CellState::Unloaded;
        }
    }
    for e in gone {
        if let Ok(ec) = world.get_entity_mut(e) {
            ec.despawn();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_math() {
        let c = WorldCells::new(Vec2::splat(-512.0), Vec2::splat(512.0), 256.0);
        assert_eq!(c.dims(), IVec2::splat(4));
        assert_eq!(c.cell_at(Vec2::new(-512.0, 511.0)), IVec2::new(0, 3));
        assert_eq!(c.cell_min(IVec2::new(1, 2)), Vec2::new(-256.0, 0.0));
        assert_eq!(c.distance(IVec2::new(2, 2), Vec2::new(10.0, 10.0)), 0.0);
        assert!((c.distance(IVec2::new(3, 2), Vec2::new(10.0, 10.0)) - 246.0).abs() < 1e-4);
        assert!(c.is_loaded_at(Vec2::splat(5000.0)), "outside the grid: nothing to wait for");
        assert!(!c.is_loaded_at(Vec2::ZERO));
        assert!(!c.ready_around(Vec2::ZERO, 10.0));
    }
}
