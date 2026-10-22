//! Scenery streaming: only scenery near the camera exists (or is shown).
//!
//! The world is cut into square XZ cells ([`SceneryStream::cell_size`], sized from the scene's
//! extent unless the game sets it). A cell is *resident*
//! while its nearest point is within `view + buffer` of the [`MainCamera`]; it stops being
//! resident only past `view + buffer + hysteresis`, so standing on a boundary never thrashes.
//! No view-direction bias: an FPS turns 180° in a tenth of a second, and frustum culling already
//! skips what is behind the camera at no cost.
//!
//! Two ways in:
//! - **Respawn mode** (big maps; saves entities, memory and per-frame work): register scenery as
//!   data with [`SceneryStream::add`] — a position and a closure that spawns the visual and
//!   returns its root. Resident cells spawn their items, nearest cell first, at most
//!   [`SceneryStream::spawns_per_frame`] per frame; cells that leave despawn theirs.
//! - **Hide mode** (small maps; spawn-then-hide): with
//!   [`RenderBudget::stream_spawned_scenery`], every spawned `Scenery` root is put in a cell and
//!   set `Visibility::Hidden` while its cell is not resident (the game's own visibility is
//!   restored on return).
//!
//! **COLLIDERS ARE NEVER STREAMED.** Respawn-mode closures must spawn visuals only: spawn the
//! collider once, separately, so physics, AI raycasts and navigation always see the whole map
//! (a collider found on a streamed visual logs a warning). Hide mode only flips `Visibility`,
//! which physics ignores, so a scenery root with a collider is safe there.
//!
//! [`RenderBudget::stream_spawned_scenery`]: super::RenderBudget::stream_spawned_scenery

use std::sync::Arc;

use bevy::ecs::system::SystemParam;
use bevy::platform::collections::HashMap;
use bevy::prelude::*;

use super::{EffectiveRanges, RenderBudget, RenderBudgetSystems, RenderStats, Scenery};
use crate::gfx::MainCamera;

/// Spawns one streamed scenery visual and returns its root.
pub type SpawnFn = Arc<dyn Fn(&mut Commands) -> Entity + Send + Sync>;

/// One piece of scenery registered as data.
#[derive(Clone)]
pub struct StreamItem {
    pub at: Vec3,
    pub spawn: SpawnFn,
}

/// Root of a visual spawned by respawn-mode streaming (the engine adds it with `Scenery`).
#[derive(Component, Clone, Copy, Debug)]
pub struct StreamedVisual;

/// Hide-mode membership (the root is tracked by the stream).
#[derive(Component, Clone, Copy, Debug)]
pub struct StreamCell;

/// A hide-mode root: where it is, the game's own visibility, whether we hid it.
struct Root {
    e: Entity,
    at: Vec3,
    saved: Visibility,
    hidden: bool,
}

#[derive(Default)]
struct Cell {
    /// Respawn mode: indices into `items` / `live`.
    items: Vec<u32>,
    /// Respawn mode: how many of `items` are spawned.
    spawned: usize,
    /// Hide mode: indices into `roots`.
    roots: Vec<u32>,
    resident: bool,
    /// Hide mode: roots need a visibility pass.
    dirty: bool,
}

/// The streaming grid.
#[derive(Resource)]
pub struct SceneryStream {
    /// Cell side in metres; `None` (default) = sized from the scene's extent (~1/12 of its
    /// larger side, 8..64 m), re-sized as scenery is added.
    pub cell_size: Option<f32>,
    /// Respawn-mode spawns per frame (despawns are not limited).
    pub spawns_per_frame: usize,
    items: Vec<StreamItem>,
    live: Vec<Option<Entity>>,
    roots: Vec<Root>,
    cells: HashMap<IVec2, Cell>,
    /// Size the cells were built with, and the XZ bounds of everything registered.
    built: f32,
    bounds: Option<(Vec2, Vec2)>,
}

impl Default for SceneryStream {
    fn default() -> Self {
        SceneryStream {
            cell_size: None,
            spawns_per_frame: 64,
            items: Vec::new(),
            live: Vec::new(),
            roots: Vec::new(),
            cells: HashMap::default(),
            built: 0.0,
            bounds: None,
        }
    }
}

/// Automatic cell side for a scene `extent` metres across.
pub fn auto_cell_size(extent: f32) -> f32 {
    (extent / 12.0).clamp(8.0, 64.0)
}

impl SceneryStream {
    /// Registers a piece of scenery at `at`; `spawn` creates its visual (no colliders!) and
    /// returns the root. Called again every time the piece streams back in.
    pub fn add(&mut self, at: Vec3, spawn: impl Fn(&mut Commands) -> Entity + Send + Sync + 'static) {
        self.items.push(StreamItem { at, spawn: Arc::new(spawn) });
        self.live.push(None);
        if !self.grow(at) {
            let idx = self.items.len() as u32 - 1;
            self.cells.entry(cell_of(at, self.built)).or_default().items.push(idx);
        }
    }

    /// Despawns every streamed visual and forgets every item (e.g. on map change).
    pub fn clear(&mut self, commands: &mut Commands) {
        for e in self.live.drain(..).flatten() {
            if let Ok(mut ec) = commands.get_entity(e) {
                ec.despawn();
            }
        }
        self.items.clear();
        self.rebuild();
    }

    /// Registered items.
    pub fn len(&self) -> usize {
        self.items.len()
    }
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
    /// Current cell side (metres).
    pub fn current_cell_size(&self) -> f32 {
        self.built
    }
    /// (resident cells, cells with anything in them).
    pub fn cell_counts(&self) -> (u32, u32) {
        (self.cells.values().filter(|c| c.resident).count() as u32, self.cells.len() as u32)
    }
    /// Respawn-mode visuals currently spawned.
    pub fn live(&self) -> usize {
        self.live.iter().flatten().count()
    }

    fn wanted_size(&self) -> f32 {
        match (self.cell_size, self.bounds) {
            (Some(s), _) => s.max(1.0),
            (None, Some((lo, hi))) => auto_cell_size((hi - lo).max_element()),
            (None, None) => 24.0,
        }
    }

    /// Extends the bounds; rebuilds the grid (→ `true`, everything bucketed) when the wanted
    /// cell size moved by > 25 %.
    fn grow(&mut self, at: Vec3) -> bool {
        let p = at.xz();
        self.bounds = Some(match self.bounds {
            Some((lo, hi)) => (lo.min(p), hi.max(p)),
            None => (p, p),
        });
        let want = self.wanted_size();
        if self.built <= 0.0 || (want - self.built).abs() > 0.25 * self.built {
            self.built = want;
            self.rebuild();
            return true;
        }
        false
    }

    /// Re-buckets every item and root with the current cell size.
    fn rebuild(&mut self) {
        self.cells.clear();
        let size = self.built.max(1.0);
        for (i, item) in self.items.iter().enumerate() {
            let cell = self.cells.entry(cell_of(item.at, size)).or_default();
            cell.items.push(i as u32);
        }
        for (i, r) in self.roots.iter().enumerate() {
            let cell = self.cells.entry(cell_of(r.at, size)).or_default();
            cell.roots.push(i as u32);
            cell.dirty = true;
        }
        // Spawned items stay spawned; their cells start resident so nothing blinks.
        for cell in self.cells.values_mut() {
            cell.items.sort_by_key(|i| self.live[*i as usize].is_none());
            cell.spawned = cell.items.iter().filter(|i| self.live[**i as usize].is_some()).count();
            cell.resident = cell.spawned > 0;
        }
    }
}

/// Cell containing `p` (XZ).
pub fn cell_of(p: Vec3, size: f32) -> IVec2 {
    IVec2::new((p.x / size).floor() as i32, (p.z / size).floor() as i32)
}

/// Distance in XZ from `eye` to the nearest point of `cell` (0 inside it).
pub fn cell_distance(eye: Vec2, cell: IVec2, size: f32) -> f32 {
    let min = cell.as_vec2() * size;
    let max = min + Vec2::splat(size);
    (eye.clamp(min, max) - eye).length()
}

/// Hysteresis: a cell becomes resident within `load`, stops being resident beyond `unload`.
pub fn next_resident(was: bool, dist: f32, load: f32, unload: f32) -> bool {
    if was { dist <= unload } else { dist <= load }
}

pub(super) struct StreamPlugin;

impl Plugin for StreamPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<SceneryStream>()
            .add_systems(PostUpdate, stream_respawn.in_set(RenderBudgetSystems::Stream))
            .add_systems(PostUpdate, stream_hide.in_set(RenderBudgetSystems::Detail));
        #[cfg(feature = "physics")]
        app.add_systems(PostUpdate, warn_streamed_colliders);
    }
}

#[derive(SystemParam)]
struct Eye<'w, 's> {
    cams: Query<'w, 's, &'static GlobalTransform, With<MainCamera>>,
}

impl Eye<'_, '_> {
    fn xz(&self) -> Option<Vec2> {
        self.cams.iter().next().map(|g| g.translation().xz())
    }
}

/// Residency for every cell, then respawn-mode despawns and budgeted spawns.
fn stream_respawn(
    mut commands: Commands,
    mut stream: ResMut<SceneryStream>,
    budget: Res<RenderBudget>,
    eff: Res<EffectiveRanges>,
    eye: Eye,
    mut stats: ResMut<RenderStats>,
    mut todo: Local<Vec<(f32, IVec2)>>,
    cpu: Res<super::BudgetCpu>,
) {
    let _cpu = cpu.time();
    stats.streamed_in = 0;
    stats.streamed_out = 0;
    let Some(eye) = eye.xz() else { return };
    let stream = &mut *stream;
    let size = stream.built.max(1.0);
    let load = eff.0.view + eff.0.buffer;
    let unload = load + eff.0.hysteresis;
    todo.clear();
    for (key, cell) in stream.cells.iter_mut() {
        let d = cell_distance(eye, *key, size);
        let resident = !budget.streaming || next_resident(cell.resident, d, load, unload);
        if resident != cell.resident {
            cell.resident = resident;
            cell.dirty = true;
        }
        if !resident {
            for &i in &cell.items[..cell.spawned] {
                if let Some(e) = stream.live[i as usize].take() {
                    if let Ok(mut ec) = commands.get_entity(e) {
                        ec.despawn();
                    }
                    stats.streamed_out += 1;
                }
            }
            cell.spawned = 0;
        } else if cell.spawned < cell.items.len() {
            todo.push((d, *key));
        }
    }
    // Nearest cells first, a budget per frame.
    todo.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut left = stream.spawns_per_frame;
    for &(_, key) in todo.iter() {
        if left == 0 {
            break;
        }
        let Some(cell) = stream.cells.get_mut(&key) else { continue };
        while cell.spawned < cell.items.len() && left > 0 {
            let i = cell.items[cell.spawned] as usize;
            let e = (stream.items[i].spawn)(&mut commands);
            commands.entity(e).insert((Scenery, StreamedVisual));
            stream.live[i] = Some(e);
            cell.spawned += 1;
            left -= 1;
            stats.streamed_in += 1;
        }
    }
    stats.stream_live = stream.live.iter().flatten().count() as u32;
    (stats.cells_loaded, stats.cells_total) = stream.cell_counts();
}

/// Hide mode: registers new `Scenery` roots and shows/hides them with their cell.
fn stream_hide(
    mut stream: ResMut<SceneryStream>,
    budget: Res<RenderBudget>,
    eff: Res<EffectiveRanges>,
    eye: Eye,
    mut commands: Commands,
    new: Query<(Entity, &GlobalTransform), (With<Scenery>, Without<StreamedVisual>, Without<StreamCell>)>,
    mut vis: Query<&mut Visibility, With<Scenery>>,
    mut removed: RemovedComponents<StreamCell>,
    mut stats: ResMut<RenderStats>,
    cpu: Res<super::BudgetCpu>,
) {
    let _cpu = cpu.time();
    let on = budget.stream_spawned_scenery;
    let stream = &mut *stream;
    // Forgotten roots stay in the list (indices are stable) but are never touched again.
    for e in removed.read() {
        if let Some(r) = stream.roots.iter_mut().find(|r| r.e == e) {
            r.e = Entity::PLACEHOLDER;
        }
    }
    if on {
        for (e, gt) in &new {
            commands.entity(e).insert(StreamCell);
            let at = gt.translation();
            let saved = vis.get(e).copied().unwrap_or_default();
            stream.roots.push(Root { e, at, saved, hidden: false });
            let idx = stream.roots.len() as u32 - 1;
            if !stream.grow(at) {
                let cell = stream.cells.entry(cell_of(at, stream.built)).or_default();
                cell.roots.push(idx);
                cell.dirty = true;
            }
        }
    }
    let Some(eye) = eye.xz() else { return };
    let load = eff.0.view + eff.0.buffer;
    let unload = load + eff.0.hysteresis;
    let size = stream.built.max(1.0);
    let mut hidden = 0;
    let off_changed = !on && stream.roots.iter().any(|r| r.hidden);
    for (key, cell) in stream.cells.iter_mut() {
        if cell.roots.is_empty() {
            continue;
        }
        // Cells only holding hide-mode roots get residency here (respawn computes the rest).
        if cell.items.is_empty() {
            let d = cell_distance(eye, *key, size);
            let resident = !budget.streaming || next_resident(cell.resident, d, load, unload);
            if resident != cell.resident {
                cell.resident = resident;
                cell.dirty = true;
            }
        }
        if cell.dirty || off_changed {
            cell.dirty = false;
            let hide = on && !cell.resident;
            for &i in &cell.roots {
                let r = &mut stream.roots[i as usize];
                if r.hidden == hide || r.e == Entity::PLACEHOLDER {
                    continue;
                }
                let Ok(mut v) = vis.get_mut(r.e) else { continue };
                if hide {
                    r.saved = *v;
                    *v = Visibility::Hidden;
                    stats.streamed_out += 1;
                } else {
                    *v = r.saved;
                    stats.streamed_in += 1;
                }
                r.hidden = hide;
            }
        }
        hidden += cell.roots.iter().filter(|i| stream.roots[**i as usize].hidden).count() as u32;
    }
    stats.stream_hidden = hidden;
    (stats.cells_loaded, stats.cells_total) = stream.cell_counts();
}

#[cfg(feature = "physics")]
fn warn_streamed_colliders(
    q: Query<(Entity, Option<&ChildOf>), Added<avian3d::prelude::Collider>>,
    streamed: Query<(), With<StreamedVisual>>,
) {
    for (e, parent) in &q {
        if streamed.contains(e) || parent.is_some_and(|p| streamed.contains(p.parent())) {
            warn_once!("render_budget: a streamed scenery visual has a Collider; colliders must be spawned once, outside SceneryStream::add (physics must see the whole map)");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells_and_distances() {
        assert_eq!(cell_of(Vec3::new(-0.5, 9.0, 25.0), 24.0), IVec2::new(-1, 1));
        assert_eq!(cell_distance(Vec2::new(5.0, 5.0), IVec2::ZERO, 10.0), 0.0);
        assert!((cell_distance(Vec2::new(-3.0, 5.0), IVec2::ZERO, 10.0) - 3.0).abs() < 1e-6);
        assert!((cell_distance(Vec2::new(13.0, 14.0), IVec2::ZERO, 10.0) - 5.0).abs() < 1e-6);
    }

    #[test]
    fn cells_size_themselves_from_the_scene() {
        let mut s = SceneryStream::default();
        for x in [0.0, 30.0, 60.0] {
            s.add(Vec3::new(x, 0.0, 0.0), |c: &mut Commands| c.spawn_empty().id());
        }
        assert_eq!(s.current_cell_size(), 8.0, "a 60 m arena gets the smallest cells");
        s.add(Vec3::new(1200.0, 0.0, 0.0), |c: &mut Commands| c.spawn_empty().id());
        assert!((s.current_cell_size() - 64.0).abs() < 1e-3, "a 1.2 km map: big cells");
        assert_eq!(s.cell_counts().1, 2, "rebuilt: 0..60 share a cell, 1200 has its own");
        let mut fixed = SceneryStream { cell_size: Some(10.0), ..default() };
        fixed.add(Vec3::new(1200.0, 0.0, 0.0), |c: &mut Commands| c.spawn_empty().id());
        assert_eq!(fixed.current_cell_size(), 10.0);
    }

    #[test]
    fn hysteresis_band_keeps_state() {
        let (load, unload) = (100.0, 110.0);
        // Outside the load radius but inside the band: whatever it was, it stays.
        assert!(next_resident(true, 105.0, load, unload));
        assert!(!next_resident(false, 105.0, load, unload));
        assert!(next_resident(false, 99.0, load, unload));
        assert!(!next_resident(true, 111.0, load, unload));
        // Walking back and forth across the load edge by less than the band never toggles.
        let mut r = false;
        let mut flips = 0;
        for i in 0..200 {
            let d = 100.0 + 4.0 * ((i as f32) * 0.3).sin();
            let n = next_resident(r, d, load, unload);
            flips += (n != r) as u32;
            r = n;
        }
        assert_eq!(flips, 1, "only the first entry into range flips");
    }

    fn app_with_stream() -> App {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, TransformPlugin))
            .init_resource::<RenderStats>()
            .init_resource::<RenderBudget>()
            .init_resource::<super::super::BudgetCpu>()
            .insert_resource(EffectiveRanges(super::super::SceneryRanges { view: 50.0, buffer: 10.0, hysteresis: 10.0, ..default() }))
            .configure_sets(PostUpdate, RenderBudgetSystems::Stream.before(bevy::transform::TransformSystems::Propagate))
            .configure_sets(PostUpdate, RenderBudgetSystems::Detail.after(bevy::transform::TransformSystems::Propagate))
            .add_plugins(StreamPlugin);
        app
    }

    #[derive(Component)]
    struct Piece;

    #[test]
    fn respawn_mode_streams_with_budget_and_hysteresis() {
        let mut app = app_with_stream();
        {
            let mut s = app.world_mut().resource_mut::<SceneryStream>();
            s.cell_size = Some(10.0);
            s.spawns_per_frame = 4;
            // 10 pieces near the origin, 10 at x = 200 (far).
            for i in 0..10 {
                s.add(Vec3::new(i as f32, 0.0, 0.0), move |c: &mut Commands| c.spawn((Piece, Transform::from_xyz(i as f32, 0.0, 0.0))).id());
                s.add(Vec3::new(200.0 + i as f32, 0.0, 0.0), move |c: &mut Commands| c.spawn((Piece, Transform::from_xyz(200.0, 0.0, 0.0))).id());
            }
        }
        let cam = app.world_mut().spawn((MainCamera, Transform::default())).id();
        let pieces = |app: &mut App| app.world_mut().query_filtered::<(), With<Piece>>().iter(app.world()).count();
        app.update();
        app.update();
        // Budget: 4 per frame (the first frame has no propagated camera yet, so also 4 or 0).
        assert!(pieces(&mut app) <= 8);
        for _ in 0..5 {
            app.update();
        }
        assert_eq!(pieces(&mut app), 10, "only the near cells");
        let stats = app.world().resource::<RenderStats>().clone();
        assert_eq!(stats.stream_live, 10);
        assert!(stats.cells_total >= 2 && stats.cells_loaded >= 1);

        // Move the camera to x = 200: the near pieces go, the far ones come.
        app.world_mut().get_mut::<Transform>(cam).unwrap().translation.x = 205.0;
        for _ in 0..6 {
            app.update();
        }
        assert_eq!(pieces(&mut app), 10);
        let xs: Vec<f32> = app.world_mut().query_filtered::<&Transform, With<Piece>>().iter(app.world()).map(|t| t.translation.x).collect();
        assert!(xs.iter().all(|x| *x >= 200.0));

        // Streaming off: everything spawns.
        app.world_mut().resource_mut::<RenderBudget>().streaming = false;
        for _ in 0..5 {
            app.update();
        }
        assert_eq!(pieces(&mut app), 20);
    }

    #[test]
    fn hide_mode_hides_far_cells_and_restores_visibility() {
        let mut app = app_with_stream();
        app.world_mut().resource_mut::<RenderBudget>().stream_spawned_scenery = true;
        app.world_mut().resource_mut::<SceneryStream>().cell_size = Some(10.0);
        app.world_mut().spawn((MainCamera, Transform::default()));
        let near = app.world_mut().spawn((Scenery, Transform::from_xyz(3.0, 0.0, 0.0), Visibility::Visible)).id();
        let far = app.world_mut().spawn((Scenery, Transform::from_xyz(300.0, 0.0, 0.0), Visibility::Visible)).id();
        for _ in 0..3 {
            app.update();
        }
        assert_eq!(*app.world().get::<Visibility>(near).unwrap(), Visibility::Visible);
        assert_eq!(*app.world().get::<Visibility>(far).unwrap(), Visibility::Hidden);
        assert_eq!(app.world().resource::<RenderStats>().stream_hidden, 1);
        // Turning hide mode off restores the game's visibility.
        app.world_mut().resource_mut::<RenderBudget>().stream_spawned_scenery = false;
        app.update();
        assert_eq!(*app.world().get::<Visibility>(far).unwrap(), Visibility::Visible);
    }
}
