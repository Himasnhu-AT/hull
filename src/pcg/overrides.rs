//! Hand edits on top of procedural dressing (`PcgOverrides`): delete or move single generated
//! points, add hand-placed items, thin or clear areas. Docs: `docs/PCG.md` ("Overrides").
//!
//! - **Identity**: a generated point is named by [`PointKey`] = (spawn / emit node id, point
//!   seed). The seed hashes the graph seed, the node and the point's world position
//!   (`pcg_core::seed_at`), so the key is the same after re-evaluation, after a streaming drop
//!   and re-entry, at any cell size and in any evaluation order.
//! - **Apply**: [`OverrideIndex`] (built once from a [`PcgOverrides`]) removes / moves points,
//!   thins by area density with the seed (deterministic, nested like `keep_for_tier`) and appends
//!   hand-placed items. It is pure data in, data out: games that evaluate the same graph
//!   themselves (colliders, navigation) call it on their own point sets and get exactly what the
//!   volume spawned.
//! - **Cost**: nothing without a [`PcgOverrides`] component; with one, a cell no override
//!   touches is not copied, and a touched cell costs one hash lookup per point.

use bevy::camera::primitives::MeshAabb;
use bevy::platform::collections::{HashMap, HashSet};
use bevy::prelude::*;
use pcg_core::{Area, Output, Point, PointSet, Spawned, SpawnKind, keep_for_tier, mix64, str_hash, unit};

use super::{PcgCatalog, PcgCells, PcgVolume};

/// Name of the float column marking hand-placed points (1 = placed by hand). Thinning never
/// removes them.
pub const HAND_ATTR: &str = "hand";

const AREA_SALT: u64 = 0x0a7e_a0a7_ea0a_7ea0;

/// A generated point's identity: the `Spawn` / `Emit` node that made it and its seed. Stable
/// across evaluations and independent of cell size.
#[derive(Reflect, Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct PointKey {
    pub node: String,
    pub seed: u64,
}

/// A deleted generated point. `at` is where it was (world), only used to find the cells to
/// respawn.
#[derive(Reflect, Clone, Debug, Default, PartialEq)]
pub struct RemovedPoint {
    pub key: PointKey,
    pub at: Vec3,
}

/// A generated point placed somewhere else by hand. It stays in the cell it was generated in.
#[derive(Reflect, Clone, Debug, PartialEq)]
pub struct MovedPoint {
    pub key: PointKey,
    pub at: Vec3,
    /// Catalog item (Emit points: the port name), so the move is self-contained: the cell
    /// holding the destination draws it even though it was generated elsewhere.
    pub item: String,
    pub to: Transform,
}

/// A hand-placed item: drawn like a point of Spawn node `node`'s item `item`.
#[derive(Reflect, Clone, Debug, PartialEq)]
pub struct AddedItem {
    pub item: String,
    pub transform: Transform,
    pub node: String,
}

impl AddedItem {
    /// Its [`PointKey`] seed (from the item and position).
    pub fn seed(&self) -> u64 {
        let q = |v: f32| (v * 1000.0).round() as i64 as u64;
        let p = self.transform.translation;
        mix64(str_hash(&self.item) ^ mix64(str_hash(&self.node) ^ mix64(q(p.x) ^ mix64(q(p.y) ^ mix64(q(p.z))))))
    }

    pub fn key(&self) -> PointKey {
        PointKey { node: self.node.clone(), seed: self.seed() }
    }
}

/// A polygon (XZ, world) keeping `density` of the generated points inside it: 1 = all, 0 =
/// none (a no-tree zone). `nodes`: only those spawn / emit nodes (`None` = all).
#[derive(Reflect, Clone, Debug, PartialEq)]
pub struct OverrideArea {
    pub polygon: Vec<Vec2>,
    pub density: f32,
    pub nodes: Option<Vec<String>>,
}

/// The hand edits of one [`PcgVolume`](super::PcgVolume) (same entity). Saved in levels.
/// Change it and only the cells the change touches respawn, from the cached evaluation.
#[derive(Component, Reflect, Clone, Debug, Default, PartialEq)]
#[reflect(Component, Default)]
pub struct PcgOverrides {
    pub removed: Vec<RemovedPoint>,
    pub moved: Vec<MovedPoint>,
    pub added: Vec<AddedItem>,
    pub areas: Vec<OverrideArea>,
}

impl PcgOverrides {
    pub fn is_empty(&self) -> bool {
        self.removed.is_empty() && self.moved.is_empty() && self.added.is_empty() && self.areas.is_empty()
    }

    /// Builds the lookup structure for `cell`-sized cells. Do this once per change.
    pub fn index(&self, cell: f32) -> OverrideIndex {
        OverrideIndex::new(self, cell)
    }

    /// Convenience for one-off use: builds an index and applies it to `pts` of `node` inside
    /// `area`. Games applying per tile keep the [`OverrideIndex`] instead.
    pub fn apply(&self, node: &str, area: Area, pts: &mut PointSet) {
        self.index(32.0).apply_points(node, area, pts);
    }

    /// Deletes a generated point (or a hand-placed one: its key matches an `added` entry).
    /// Returns false if nothing changed.
    pub fn remove_point(&mut self, key: &PointKey, at: Vec3) -> bool {
        if let Some(i) = self.added.iter().position(|a| a.key() == *key) {
            self.added.remove(i);
            return true;
        }
        self.moved.retain(|m| m.key != *key);
        if self.removed.iter().any(|r| r.key == *key) {
            return false;
        }
        self.removed.push(RemovedPoint { key: key.clone(), at });
        true
    }

    /// Moves a generated point (or a hand-placed one) to `to`. Returns its key afterwards (a
    /// hand-placed item's key follows its position).
    pub fn move_point(&mut self, key: &PointKey, at: Vec3, item: &str, to: Transform) -> PointKey {
        if let Some(a) = self.added.iter_mut().find(|a| a.key() == *key) {
            a.transform = to;
            return a.key();
        }
        self.removed.retain(|r| r.key != *key);
        match self.moved.iter_mut().find(|m| m.key == *key) {
            Some(m) => m.to = to,
            None => self.moved.push(MovedPoint { key: key.clone(), at, item: item.into(), to }),
        }
        key.clone()
    }

    /// Puts a hand-placed item. Returns its key.
    pub fn add_item(&mut self, item: &str, node: &str, transform: Transform) -> PointKey {
        let a = AddedItem { item: item.into(), node: node.into(), transform };
        let key = a.key();
        if !self.added.iter().any(|b| b.key() == key) {
            self.added.push(a);
        }
        key
    }
}

struct NodeEdits {
    removed: HashSet<u64>,
    moved: HashMap<u64, Transform>,
    /// Moves in entry order: (seed, item, destination).
    moved_list: Vec<(u64, String, Transform)>,
    added: Vec<AddedItem>,
}

struct IndexedArea {
    bbox: Area,
    polygon: Vec<Vec2>,
    density: f32,
    nodes: Option<Vec<String>>,
}

/// Lookup structure over a [`PcgOverrides`]: per node, removed seeds and moved transforms in
/// hash maps; added items; area polygons with bounding boxes; and a hash per cell of everything
/// that touches it (to respawn only changed cells).
pub struct OverrideIndex {
    cell: f32,
    nodes: HashMap<String, NodeEdits>,
    areas: Vec<IndexedArea>,
    cells: HashMap<IVec2, u64>,
}

fn h32(v: f32) -> u64 {
    v.to_bits() as u64
}

fn h_vec3(v: Vec3) -> u64 {
    mix64(h32(v.x) ^ mix64(h32(v.y) ^ mix64(h32(v.z))))
}

fn h_tf(t: &Transform) -> u64 {
    let r = t.rotation;
    mix64(h_vec3(t.translation) ^ mix64(h_vec3(t.scale) ^ mix64(h32(r.x) ^ mix64(h32(r.y) ^ mix64(h32(r.z) ^ mix64(h32(r.w)))))))
}

fn polygon_contains(poly: &[Vec2], p: Vec2) -> bool {
    let mut inside = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
        j = i;
    }
    inside
}

impl OverrideIndex {
    pub fn new(ov: &PcgOverrides, cell: f32) -> OverrideIndex {
        let cell = if cell.is_finite() { cell.max(1.0) } else { 32.0 };
        let mut ix = OverrideIndex { cell, nodes: HashMap::default(), areas: Vec::new(), cells: HashMap::default() };
        for r in &ov.removed {
            ix.node(&r.key.node).removed.insert(r.key.seed);
            ix.bump(r.at, mix64(r.key.seed ^ 0x1111) ^ str_hash(&r.key.node));
        }
        for m in &ov.moved {
            let n = ix.node(&m.key.node);
            n.moved.insert(m.key.seed, m.to);
            n.moved_list.push((m.key.seed, m.item.clone(), m.to));
            // Both the cell it leaves and the one it lands in.
            let h = mix64(m.key.seed ^ 0x2222 ^ h_tf(&m.to) ^ str_hash(&m.item)) ^ str_hash(&m.key.node);
            ix.bump(m.at, h);
            ix.bump(m.to.translation, h.rotate_left(7));
        }
        for a in &ov.added {
            ix.node(&a.node).added.push(a.clone());
            ix.bump(a.transform.translation, mix64(a.seed() ^ h_tf(&a.transform)) ^ 0x3333);
        }
        for a in &ov.areas {
            let finite = a.polygon.iter().all(|p| p.is_finite());
            if a.polygon.len() < 3 || !finite || !a.density.is_finite() {
                continue;
            }
            let bbox = a.polygon.iter().fold(Area::EMPTY, |b, &p| b.include(p));
            let mut h = mix64(h32(a.density) ^ 0x4444);
            for p in &a.polygon {
                h = mix64(h ^ h32(p.x) ^ mix64(h32(p.y)));
            }
            for n in a.nodes.iter().flatten() {
                h = mix64(h ^ str_hash(n));
            }
            let (x0, x1) = ((bbox.min.x / cell).floor() as i32, (bbox.max.x / cell).floor() as i32);
            let (z0, z1) = ((bbox.min.y / cell).floor() as i32, (bbox.max.y / cell).floor() as i32);
            // Guard against absurd polygons (a million cells is already 32 km of 32 m cells).
            if (x1 - x0 + 1) as i64 * (z1 - z0 + 1) as i64 <= 1_000_000 {
                for z in z0..=z1 {
                    for x in x0..=x1 {
                        let e = ix.cells.entry(IVec2::new(x, z)).or_insert(0);
                        *e = e.wrapping_add(h | 1);
                    }
                }
            }
            ix.areas.push(IndexedArea { bbox, polygon: a.polygon.clone(), density: a.density, nodes: a.nodes.clone() });
        }
        ix
    }

    fn node(&mut self, n: &str) -> &mut NodeEdits {
        self.nodes.entry(n.to_string()).or_insert_with(|| NodeEdits { removed: HashSet::default(), moved: HashMap::default(), moved_list: Vec::new(), added: Vec::new() })
    }

    fn bump(&mut self, p: Vec3, h: u64) {
        let c = IVec2::new((p.x / self.cell).floor() as i32, (p.z / self.cell).floor() as i32);
        let e = self.cells.entry(c).or_insert(0);
        *e = e.wrapping_add(h | 1);
    }

    /// The cell size this index was built for.
    pub fn cell_size(&self) -> f32 {
        self.cell
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty() && self.areas.is_empty()
    }

    /// Hash of every override touching `cell` (0 = none). Equal hashes: same edits.
    pub fn cell_hash(&self, cell: IVec2) -> u64 {
        self.cells.get(&cell).copied().unwrap_or(0)
    }

    /// Cells any override touches.
    pub fn touched_cells(&self) -> impl Iterator<Item = IVec2> + '_ {
        self.cells.keys().copied()
    }

    /// The core: edits `pts` (and the parallel per-point `items` of a Spawn node, with
    /// `names` its item names). `area` is the region this set covers; hand-placed items inside
    /// it are appended.
    fn apply_core(&self, node: &str, area: Area, pts: &mut PointSet, mut items: Option<(&mut Vec<u16>, &mut Vec<(String, f32)>)>) {
        let edits = self.nodes.get(node);
        let has_area = self.areas.iter().any(|a| a.nodes.as_ref().is_none_or(|n| n.iter().any(|x| x == node)) && area.overlaps(a.bbox));
        if edits.is_none() && !has_area {
            return;
        }
        let mut moved_seen: HashSet<u64> = HashSet::default();
        let point_edits = edits.is_some_and(|e| !e.removed.is_empty() || !e.moved.is_empty());
        if point_edits || has_area {
            let relevant: Vec<&IndexedArea> = self.areas.iter().filter(|a| a.nodes.as_ref().is_none_or(|n| n.iter().any(|x| x == node)) && area.overlaps(a.bbox)).collect();
            let mut keep: Vec<usize> = Vec::with_capacity(pts.len());
            let mut dropped = false;
            let mut seen: HashSet<u64> = HashSet::default();
            for k in 0..pts.len() {
                let seed = pts.seed[k];
                if let Some(e) = edits {
                    if e.removed.contains(&seed) {
                        dropped = true;
                        continue;
                    }
                    if let Some(t) = e.moved.get(&seed) {
                        seen.insert(seed);
                        // Destination in another area: that area's evaluation owns it.
                        if !area.contains(Vec2::new(t.translation.x, t.translation.z)) {
                            dropped = true;
                            continue;
                        }
                        pts.pos[k] = t.translation;
                        pts.rot[k] = t.rotation;
                        pts.scale[k] = t.scale;
                        keep.push(k);
                        continue;
                    }
                }
                if !relevant.is_empty() {
                    let p = Vec2::new(pts.pos[k].x, pts.pos[k].z);
                    let mut d = 1.0f32;
                    for a in &relevant {
                        if a.bbox.contains(p) && polygon_contains(&a.polygon, p) {
                            d = d.min(a.density);
                        }
                    }
                    if d < 1.0 && unit(mix64(seed ^ AREA_SALT)) >= d {
                        dropped = true;
                        continue;
                    }
                }
                keep.push(k);
            }
            if dropped {
                *pts = pts.select(&keep);
                if let Some((it, _)) = items.as_mut() {
                    **it = keep.iter().map(|&k| it[k]).collect();
                }
            }
            if let Some(e) = edits.filter(|e| !e.moved.is_empty()) {
                // Moved points are hand edits: thinning never touches them.
                let moved_here: Vec<usize> = (0..pts.len()).filter(|&k| e.moved.contains_key(&pts.seed[k])).collect();
                if !moved_here.is_empty() {
                    let len = pts.pos.len();
                    let h = pts.attrs.entry(HAND_ATTR.to_string()).or_default();
                    h.resize(len, 0.0);
                    for k in moved_here {
                        h[k] = 1.0;
                    }
                }
            }
            moved_seen = seen;
        }
        let Some(e) = edits else { return };
        // Moves generated elsewhere that land here.
        for (seed, item, t) in &e.moved_list {
            if moved_seen.contains(seed) || e.removed.contains(seed) || !area.contains(Vec2::new(t.translation.x, t.translation.z)) {
                continue;
            }
            let len = pts.pos.len();
            pts.attrs.entry(HAND_ATTR.to_string()).or_default().resize(len, 0.0);
            pts.push(Point { pos: t.translation, rot: t.rotation, scale: t.scale, extent: Vec3::splat(0.5), density: 1.0, seed: *seed, tag: 0 });
            if let Some(h) = pts.attrs.get_mut(HAND_ATTR) {
                *h.last_mut().expect("just pushed") = 1.0;
            }
            if let Some((it, names)) = items.as_mut() {
                let idx = match names.iter().position(|(nm, _)| nm == item) {
                    Some(i) => i,
                    None => {
                        names.push((item.clone(), 0.0));
                        names.len() - 1
                    }
                };
                it.push(idx.min(u16::MAX as usize) as u16);
            }
        }
        for a in e.added.iter().filter(|a| area.contains(Vec2::new(a.transform.translation.x, a.transform.translation.z))) {
            let seed = a.seed();
            if e.removed.contains(&seed) {
                continue;
            }
            let len = pts.pos.len();
            pts.attrs.entry(HAND_ATTR.to_string()).or_default().resize(len, 0.0);
            let t = e.moved.get(&seed).copied().unwrap_or(a.transform);
            pts.push(Point { pos: t.translation, rot: t.rotation, scale: t.scale, extent: Vec3::splat(0.5), density: 1.0, seed, tag: 0 });
            if let Some(h) = pts.attrs.get_mut(HAND_ATTR) {
                *h.last_mut().expect("just pushed") = 1.0;
            }
            if let Some((it, names)) = items.as_mut() {
                let idx = match names.iter().position(|(nm, _)| *nm == a.item) {
                    Some(i) => i,
                    None => {
                        names.push((a.item.clone(), 0.0));
                        names.len() - 1
                    }
                };
                it.push(idx.min(u16::MAX as usize) as u16);
            }
        }
    }

    /// Applies the edits for Emit / Spawn node `node` to a point set covering `area`
    /// (removes, moves, thins, appends hand-placed points inside `area`, flagged in the
    /// [`HAND_ATTR`] column). `area` half-open: tiles partition the plane without doubles.
    pub fn apply_points(&self, node: &str, area: Area, pts: &mut PointSet) {
        self.apply_core(node, area, pts, None);
    }

    /// Same for a `Spawn` node's output (keeps the per-point item index in step; a hand-placed
    /// item missing from the node's item list is appended with weight 0).
    pub fn apply_spawned(&self, area: Area, s: &mut Spawned) {
        let Spawned { node, def, points, item } = s;
        self.apply_core(node, area, points, Some((item, &mut def.items)));
    }

    /// A copy of `out` for `cell` (an [`Area`] of the cell, unclipped) with every spawn and emit
    /// edited.
    pub fn apply_output(&self, area: Area, out: &Output) -> Output {
        let mut o = out.clone();
        for s in &mut o.spawns {
            self.apply_spawned(area, s);
        }
        for (port, pts) in &mut o.emits {
            self.apply_points(port, area, pts);
        }
        o
    }
}

/// What [`pcg_pick`] found.
#[derive(Clone, Debug)]
pub struct PcgPick {
    pub volume: Entity,
    pub key: PointKey,
    /// Catalog item name (for Emit points: the port name).
    pub item: String,
    /// The point as drawn (overrides applied).
    pub transform: Transform,
    pub distance: f32,
    pub cell: IVec2,
    /// An `Emit` port point (drawn by game code) rather than a spawned item.
    pub emitted: bool,
}

/// Ray vs sphere: distance to the first hit.
fn ray_sphere(o: Vec3, d: Vec3, c: Vec3, r: f32) -> Option<f32> {
    let oc = c - o;
    let t = oc.dot(d);
    let miss2 = oc.length_squared() - t * t;
    if miss2 > r * r {
        return None;
    }
    let t0 = t - (r * r - miss2).sqrt();
    let t1 = t + (r * r - miss2).sqrt();
    if t1 < 0.0 { None } else { Some(t0.max(0.0)) }
}

/// The nearest generated instance (spawned mesh item, or emitted point) along a ray, in the
/// loaded cells of every volume. Works on merged meshes (tests the point set, with a bounding
/// sphere per item from the catalog mesh's AABB × the point's scale). Thinned-out points and
/// removed ones are not pickable; hand-placed ones are.
pub fn pcg_pick(world: &World, origin: Vec3, dir: Vec3) -> Option<PcgPick> {
    let dir = dir.try_normalize()?;
    let catalog = world.get_resource::<PcgCatalog>()?;
    let meshes = world.get_resource::<Assets<Mesh>>();
    let mut best: Option<PcgPick> = None;
    for (volume, v, cells) in world.try_query::<(Entity, &PcgVolume, &PcgCells)>()?.iter(world) {
        let size = v.cell.max(1.0);
        for (&k, c) in &cells.cells {
            if c.root.is_none() {
                continue;
            }
            let Some(out) = c.shown.as_ref().or(c.output.as_ref()) else { continue };
            // Cell column test: the ray against the cell's box (generous height).
            let a = Area::cell(k.x, k.y, size);
            let (lo, hi) = (Vec3::new(a.min.x - 8.0, -1e4, a.min.y - 8.0), Vec3::new(a.max.x + 8.0, 1e4, a.max.y + 8.0));
            let inv = dir.recip();
            let (t1, t2) = ((lo - origin) * inv, (hi - origin) * inv);
            let (tn, tf) = (t1.min(t2).max_element(), t1.max(t2).min_element());
            if tf < tn.max(0.0) {
                continue;
            }
            let thin = c.spawned_with.unwrap_or((1.0, 1.0));
            let try_point = |best: &mut Option<PcgPick>, node: &str, item: &str, p: &PointSet, i: usize, center: Vec3, radius: f32, emitted: bool| {
                let Some(t) = ray_sphere(origin, dir, center, radius) else { return };
                if best.as_ref().is_some_and(|b| b.distance <= t) {
                    return;
                }
                *best = Some(PcgPick {
                    volume,
                    key: PointKey { node: node.to_string(), seed: p.seed[i] },
                    item: item.to_string(),
                    transform: Transform { translation: p.pos[i], rotation: p.rot[i], scale: p.scale[i] },
                    distance: t,
                    cell: k,
                    emitted,
                });
            };
            for s in &out.spawns {
                if s.def.kind != SpawnKind::Mesh {
                    continue;
                }
                let hand = s.points.attrs.get(HAND_ATTR);
                // Per item: local bounding sphere (centre offset, radius) from the mesh AABB.
                let bounds: Vec<(Vec3, f32)> = s
                    .def
                    .items
                    .iter()
                    .map(|(name, _)| {
                        catalog
                            .meshes
                            .get(name)
                            .and_then(|m| meshes?.get(&m.mesh))
                            .and_then(|m| m.get_aabb())
                            .map(|b| (Vec3::from(b.center), Vec3::from(b.half_extents).length()))
                            .unwrap_or((Vec3::ZERO, 0.5))
                    })
                    .collect();
                for i in 0..s.points.len() {
                    let p = &s.points;
                    let is_hand = hand.is_some_and(|h| h[i] > 0.5);
                    if !is_hand && !keep_for_tier(p.seed[i], s.def.tier, thin.0, thin.1) {
                        continue;
                    }
                    let item = s.item[i] as usize;
                    let Some((off, r)) = bounds.get(item) else { continue };
                    let sc = p.scale[i];
                    let center = p.pos[i] + p.rot[i] * (*off * sc);
                    try_point(&mut best, &s.node, &s.def.items[item].0, p, i, center, r * sc.max_element().max(0.01), false);
                }
            }
            for (port, p) in &out.emits {
                for i in 0..p.len() {
                    let r = (p.extent[i] * p.scale[i]).length().max(0.25);
                    try_point(&mut best, port, port, p, i, p.pos[i] + Vec3::Y * p.extent[i].y, r, true);
                }
            }
        }
    }
    best
}

/// Finds the loaded point with `key` in `volume`'s cells: where it is now and its item.
pub fn find_point(world: &World, volume: Entity, key: &PointKey) -> Option<PcgPick> {
    let cells = world.get::<PcgCells>(volume)?;
    for (&k, c) in &cells.cells {
        let Some(out) = c.shown.as_ref().or(c.output.as_ref()) else { continue };
        for s in out.spawns.iter().filter(|s| s.node == key.node) {
            if let Some(i) = s.points.seed.iter().position(|&x| x == key.seed) {
                let p = &s.points;
                return Some(PcgPick {
                    volume,
                    key: key.clone(),
                    item: s.def.items[s.item[i] as usize].0.clone(),
                    transform: Transform { translation: p.pos[i], rotation: p.rot[i], scale: p.scale[i] },
                    distance: 0.0,
                    cell: k,
                    emitted: false,
                });
            }
        }
        if let Some(p) = out.emits.get(&key.node)
            && let Some(i) = p.seed.iter().position(|&x| x == key.seed)
        {
            return Some(PcgPick {
                volume,
                key: key.clone(),
                item: key.node.clone(),
                transform: Transform { translation: p.pos[i], rotation: p.rot[i], scale: p.scale[i] },
                distance: 0.0,
                cell: k,
                emitted: true,
            });
        }
    }
    None
}

#[cfg(feature = "devtools")]
pub(super) mod control {
    use serde_json::{Value, json};

    use super::*;
    use crate::devtools::{AddControlCommand, params};

    pub(in crate::pcg) fn register(app: &mut App) {
        let vol = ("volume", "number", "PcgVolume entity id (default: the first volume)");
        let key = ("key", "object", "{node, seed} of a generated point (seed as string or number), from pcg.pick / pcg.inspect");
        app.add_control_command("pcg.overrides.get", "A volume's PcgOverrides (removed, moved, added, areas)", params(&[vol]), get)
            .add_control_command("pcg.overrides.remove", "Delete a generated or hand-placed point", params(&[vol, key]), remove)
            .add_control_command("pcg.overrides.move", "Move a point: transform {translation, rotation (quat xyzw), scale}", params(&[vol, key, ("transform", "object", "Transform (reflect JSON)")]), mv)
            .add_control_command(
                "pcg.overrides.add",
                "Hand-place an item",
                params(&[vol, ("item", "string", "catalog item name"), ("transform", "object", "Transform"), ("node", "string", "Spawn node the item belongs to (default: first mesh node)")]),
                add,
            )
            .add_control_command(
                "pcg.overrides.area",
                "Thin or clear a polygon (XZ): density 0 clears, 1 restores nothing (use clear_areas)",
                params(&[vol, ("polygon", "array", "[[x,z],..]"), ("density", "number", "0..1 kept (default 0)"), ("nodes", "array", "node names (default all)")]),
                area,
            )
            .add_control_command("pcg.overrides.clear", "Remove every override of a volume", params(&[vol]), clear)
            .add_control_command("pcg.pick", "Nearest generated instance along a ray (loaded cells)", params(&[("origin", "array", "[x,y,z]"), ("dir", "array", "[x,y,z]")]), pick);
    }

    fn volume(world: &mut World, p: &Value) -> Result<Entity, String> {
        match p.get("volume") {
            Some(v) => {
                let e = parse_entity(v)?;
                world.get::<PcgVolume>(e).map(|_| e).ok_or_else(|| format!("{e} is not a PcgVolume"))
            }
            None => world.query_filtered::<Entity, With<PcgVolume>>().iter(world).next().ok_or_else(|| "no PcgVolume".to_string()),
        }
    }

    fn parse_entity(v: &Value) -> Result<Entity, String> {
        #[cfg(feature = "devkit")]
        return crate::devkit::reflect_json::parse_entity(v);
        #[cfg(not(feature = "devkit"))]
        {
            let bits = v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).ok_or("`volume` must be entity bits")?;
            Entity::try_from_bits(bits).ok_or_else(|| format!("bad entity bits {bits}"))
        }
    }

    fn vec3(v: &Value, what: &str) -> Result<Vec3, String> {
        let a = v.as_array().filter(|a| a.len() == 3).ok_or_else(|| format!("`{what}` must be [x, y, z]"))?;
        let f = |i: usize| a[i].as_f64().map(|x| x as f32).ok_or_else(|| format!("`{what}` must be numbers"));
        Ok(Vec3::new(f(0)?, f(1)?, f(2)?))
    }

    fn transform(v: Option<&Value>) -> Result<Transform, String> {
        let v = v.ok_or("`transform` is required")?;
        let mut t = Transform::default();
        if let Some(x) = v.get("translation") {
            t.translation = vec3(x, "translation")?;
        }
        if let Some(x) = v.get("scale") {
            t.scale = vec3(x, "scale")?;
        }
        if let Some(x) = v.get("rotation") {
            let a = x.as_array().filter(|a| a.len() == 4).ok_or("`rotation` must be a quaternion [x, y, z, w]")?;
            let f = |i: usize| a[i].as_f64().map(|x| x as f32).ok_or("`rotation` must be numbers");
            t.rotation = Quat::from_xyzw(f(0)?, f(1)?, f(2)?, f(3)?).normalize();
        }
        if !t.translation.is_finite() || !t.scale.is_finite() || !t.rotation.is_finite() {
            return Err("transform must be finite".into());
        }
        Ok(t)
    }

    fn key_of(p: &Value) -> Result<PointKey, String> {
        let k = p.get("key").ok_or("`key` is required")?;
        let node = k.get("node").and_then(Value::as_str).ok_or("`key.node` must be a string")?.to_string();
        let seed = k.get("seed").and_then(|s| s.as_u64().or_else(|| s.as_str().and_then(|s| s.parse().ok()))).ok_or("`key.seed` must be an integer (or a numeric string)")?;
        Ok(PointKey { node, seed })
    }

    fn key_json(k: &PointKey) -> Value {
        json!({"node": k.node, "seed": k.seed.to_string()})
    }

    fn tf_json(t: &Transform) -> Value {
        json!({"translation": t.translation.to_array(), "rotation": t.rotation.to_array(), "scale": t.scale.to_array()})
    }

    fn edit(world: &mut World, e: Entity, f: impl FnOnce(&mut PcgOverrides) -> Value) -> Value {
        if world.get::<PcgOverrides>(e).is_none() {
            world.entity_mut(e).insert(PcgOverrides::default());
        }
        let mut ov = world.get_mut::<PcgOverrides>(e).expect("inserted");
        f(&mut ov)
    }

    fn summary(ov: &PcgOverrides) -> Value {
        json!({"removed": ov.removed.len(), "moved": ov.moved.len(), "added": ov.added.len(), "areas": ov.areas.len()})
    }

    fn get(world: &mut World, p: Value) -> Result<Value, String> {
        let e = volume(world, &p)?;
        let ov = world.get::<PcgOverrides>(e).cloned().unwrap_or_default();
        Ok(json!({
            "volume": e.to_bits(),
            "counts": summary(&ov),
            "removed": ov.removed.iter().map(|r| json!({"key": key_json(&r.key), "at": r.at.to_array()})).collect::<Vec<_>>(),
            "moved": ov.moved.iter().map(|m| json!({"key": key_json(&m.key), "at": m.at.to_array(), "item": m.item, "to": tf_json(&m.to)})).collect::<Vec<_>>(),
            "added": ov.added.iter().map(|a| json!({"key": key_json(&a.key()), "item": a.item, "node": a.node, "transform": tf_json(&a.transform)})).collect::<Vec<_>>(),
            "areas": ov.areas.iter().map(|a| json!({"polygon": a.polygon.iter().map(|p| p.to_array()).collect::<Vec<_>>(), "density": a.density, "nodes": a.nodes})).collect::<Vec<_>>(),
        }))
    }

    fn remove(world: &mut World, p: Value) -> Result<Value, String> {
        let e = volume(world, &p)?;
        let key = key_of(&p)?;
        let at = find_point(world, e, &key).map(|f| f.transform.translation);
        let hand = world.get::<PcgOverrides>(e).is_some_and(|o| o.added.iter().any(|a| a.key() == key));
        let at = at.or(if hand { Some(Vec3::ZERO) } else { None }).or_else(|| p.get("at").and_then(|a| vec3(a, "at").ok())).ok_or("no loaded point with that key (pass `at` [x,y,z] to remove an unloaded one)")?;
        Ok(edit(world, e, |o| {
            let changed = o.remove_point(&key, at);
            json!({"changed": changed, "counts": summary(o)})
        }))
    }

    fn mv(world: &mut World, p: Value) -> Result<Value, String> {
        let e = volume(world, &p)?;
        let key = key_of(&p)?;
        let to = transform(p.get("transform"))?;
        let found = find_point(world, e, &key);
        let hand = world.get::<PcgOverrides>(e).is_some_and(|o| o.added.iter().any(|a| a.key() == key));
        let at = found.as_ref().map(|f| f.transform.translation).or(if hand { Some(Vec3::ZERO) } else { None }).or_else(|| p.get("at").and_then(|a| vec3(a, "at").ok())).ok_or("no loaded point with that key (pass `at` [x,y,z] and `item`)")?;
        let item = found.map(|f| f.item).or_else(|| p.get("item").and_then(Value::as_str).map(String::from)).unwrap_or_default();
        Ok(edit(world, e, |o| {
            let k = o.move_point(&key, at, &item, to);
            json!({"key": key_json(&k), "counts": summary(o)})
        }))
    }

    fn add(world: &mut World, p: Value) -> Result<Value, String> {
        let e = volume(world, &p)?;
        let item = p.get("item").and_then(Value::as_str).ok_or("`item` is required")?.to_string();
        let tf = transform(p.get("transform"))?;
        let node = match p.get("node").and_then(Value::as_str) {
            Some(n) => n.to_string(),
            None => first_mesh_node(world, e, &item).ok_or("`node` is required (no evaluated mesh Spawn node found)")?,
        };
        Ok(edit(world, e, |o| {
            let k = o.add_item(&item, &node, tf);
            json!({"key": key_json(&k), "node": node, "counts": summary(o)})
        }))
    }

    /// The Spawn node listing `item`, else the first mesh Spawn node of any loaded cell.
    fn first_mesh_node(world: &World, e: Entity, item: &str) -> Option<String> {
        let cells = world.get::<PcgCells>(e)?;
        let mut fallback = None;
        for c in cells.cells.values() {
            for s in c.output.iter().flat_map(|o| o.spawns.iter()).filter(|s| s.def.kind == SpawnKind::Mesh) {
                if s.def.items.iter().any(|(n, _)| n == item) {
                    return Some(s.node.clone());
                }
                fallback.get_or_insert_with(|| s.node.clone());
            }
        }
        fallback
    }

    fn area(world: &mut World, p: Value) -> Result<Value, String> {
        let e = volume(world, &p)?;
        let poly = p.get("polygon").and_then(Value::as_array).ok_or("`polygon` must be [[x,z],..]")?;
        let mut polygon = Vec::new();
        for pt in poly {
            let a = pt.as_array().filter(|a| a.len() == 2).ok_or("polygon points must be [x, z]")?;
            let (x, z) = (a[0].as_f64().ok_or("numbers only")? as f32, a[1].as_f64().ok_or("numbers only")? as f32);
            if !x.is_finite() || !z.is_finite() {
                return Err("polygon must be finite".into());
            }
            polygon.push(Vec2::new(x, z));
        }
        if polygon.len() < 3 {
            return Err("polygon needs at least 3 points".into());
        }
        let density = p.get("density").and_then(Value::as_f64).unwrap_or(0.0) as f32;
        let nodes = p.get("nodes").and_then(Value::as_array).map(|a| a.iter().filter_map(|n| n.as_str().map(String::from)).collect::<Vec<_>>());
        Ok(edit(world, e, |o| {
            o.areas.push(OverrideArea { polygon, density: density.clamp(0.0, 1.0), nodes });
            json!({"counts": summary(o)})
        }))
    }

    fn clear(world: &mut World, p: Value) -> Result<Value, String> {
        let e = volume(world, &p)?;
        Ok(edit(world, e, |o| {
            *o = PcgOverrides::default();
            json!({"counts": summary(o)})
        }))
    }

    fn pick(world: &mut World, p: Value) -> Result<Value, String> {
        let origin = vec3(p.get("origin").ok_or("`origin` is required")?, "origin")?;
        let dir = vec3(p.get("dir").ok_or("`dir` is required")?, "dir")?;
        Ok(match pcg_pick(world, origin, dir) {
            Some(h) => json!({"hit": true, "volume": h.volume.to_bits(), "key": key_json(&h.key), "item": h.item, "transform": tf_json(&h.transform), "distance": h.distance, "cell": [h.cell.x, h.cell.y], "emitted": h.emitted}),
            None => json!({"hit": false}),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcg_core::{Graph, Inputs, Rect, Tier, evaluate};

    fn graph() -> Graph {
        Graph::build(5).input("lots").poisson(3.0).spawn(&[("rock", 1.0)], Tier::Normal).id("rocks").finish().unwrap()
    }

    fn inputs() -> Inputs {
        Inputs::default().rects("lots", vec![Rect::new(Vec2::ZERO, Vec2::new(40.0, 40.0))])
    }

    fn rocks(area: Area) -> Spawned {
        evaluate(&graph(), &inputs(), Some(area)).unwrap().spawns.into_iter().find(|s| s.node == "rocks").unwrap()
    }

    #[test]
    fn keys_are_stable_across_cell_sizes_and_reruns() {
        let whole: HashSet<u64> = rocks(Area::new(Vec2::splat(-40.0), Vec2::splat(40.0))).points.seed.into_iter().collect();
        let mut union = HashSet::new();
        for z in -2..2 {
            for x in -2..2 {
                union.extend(rocks(Area::cell(x, z, 20.0)).points.seed);
            }
        }
        assert!(whole.len() > 100);
        assert_eq!(whole, union, "same keys at 20 m cells as whole");
        assert_eq!(rocks(Area::cell(0, 0, 32.0)).points.seed, rocks(Area::cell(0, 0, 32.0)).points.seed);
    }

    #[test]
    fn remove_move_add_and_area() {
        let area = Area::cell(0, 0, 32.0);
        let base = rocks(area);
        let n = base.points.len();
        assert!(n > 20);
        let mut ov = PcgOverrides::default();
        let (k0, k1) = (base.points.seed[0], base.points.seed[1]);
        ov.remove_point(&PointKey { node: "rocks".into(), seed: k0 }, base.points.pos[0]);
        let moved_to = Transform::from_xyz(7.0, 0.0, 7.0).with_scale(Vec3::splat(2.0));
        ov.move_point(&PointKey { node: "rocks".into(), seed: k1 }, base.points.pos[1], "rock", moved_to);
        ov.add_item("rock", "rocks", Transform::from_xyz(1.5, 0.0, 2.5));
        // An item outside the cell is not appended here.
        ov.add_item("rock", "rocks", Transform::from_xyz(100.0, 0.0, 2.5));
        let ix = ov.index(32.0);
        let mut s = base.clone();
        ix.apply_spawned(area, &mut s);
        assert_eq!(s.points.len(), n, "one removed, one added");
        assert!(!s.points.seed.contains(&k0));
        let i = s.points.seed.iter().position(|&x| x == k1).unwrap();
        assert_eq!(s.points.pos[i], moved_to.translation);
        assert_eq!(s.points.scale[i], moved_to.scale);
        assert_eq!(s.item.len(), s.points.len());
        assert_eq!(s.points.attrs[HAND_ATTR].iter().filter(|h| **h > 0.5).count(), 2, "the added item and the moved point");
        // Other nodes untouched.
        let mut other = base.points.clone();
        ix.apply_points("other", area, &mut other);
        assert_eq!(other, base.points);

        // A clear area removes everything inside, keeps the rest, hand-placed items survive.
        let mut ov2 = PcgOverrides::default();
        ov2.areas.push(OverrideArea { polygon: vec![Vec2::new(0.0, 0.0), Vec2::new(16.0, 0.0), Vec2::new(16.0, 32.0), Vec2::new(0.0, 32.0)], density: 0.0, nodes: None });
        ov2.add_item("rock", "rocks", Transform::from_xyz(4.0, 0.0, 4.0));
        let mut s2 = base.clone();
        ov2.index(32.0).apply_spawned(area, &mut s2);
        for k in 0..s2.points.len() {
            if s2.points.attrs[HAND_ATTR][k] < 0.5 {
                assert!(s2.points.pos[k].x >= 16.0, "{:?}", s2.points.pos[k]);
            }
        }
        assert!(s2.points.len() < n && s2.points.len() > 1);
        // Half density: nested between none and all, deterministic.
        let thin = |d: f32| {
            let mut o = PcgOverrides::default();
            o.areas.push(OverrideArea { polygon: vec![Vec2::splat(-1.0), Vec2::new(40.0, -1.0), Vec2::splat(40.0), Vec2::new(-1.0, 40.0)], density: d, nodes: Some(vec!["rocks".into()]) });
            let mut s = base.points.clone();
            o.index(32.0).apply_points("rocks", area, &mut s);
            s.seed
        };
        let (a, b) = (thin(0.3), thin(0.6));
        assert!(a.len() < b.len() && b.len() < n);
        assert!(a.iter().all(|x| b.contains(x)));
        assert_eq!(thin(0.6), b);
    }

    #[test]
    fn hashes_only_change_for_touched_cells() {
        let mut ov = PcgOverrides::default();
        ov.areas.push(OverrideArea { polygon: vec![Vec2::new(1.0, 1.0), Vec2::new(20.0, 1.0), Vec2::new(10.0, 20.0)], density: 0.0, nodes: None });
        let a = ov.index(32.0);
        assert_ne!(a.cell_hash(IVec2::new(0, 0)), 0);
        assert_eq!(a.cell_hash(IVec2::new(3, 3)), 0);
        ov.add_item("rock", "rocks", Transform::from_xyz(70.0, 0.0, 5.0));
        let b = ov.index(32.0);
        assert_eq!(a.cell_hash(IVec2::new(0, 0)), b.cell_hash(IVec2::new(0, 0)));
        assert_ne!(b.cell_hash(IVec2::new(2, 0)), 0);
        assert_eq!(a.cell_hash(IVec2::new(2, 0)), 0);
    }

    /// Cost of applying: 1000 hand edits (removed, moved, areas) on a 4000-point cell.
    #[test]
    fn apply_cost_is_small() {
        let mut pts = PointSet::default();
        for k in 0..4000u64 {
            pts.push(Point { pos: Vec3::new((k % 64) as f32 * 0.5, 0.0, (k / 64) as f32 * 0.5), seed: mix64(k), ..Default::default() });
        }
        let mut ov = PcgOverrides::default();
        for k in 0..500u64 {
            ov.remove_point(&PointKey { node: "n".into(), seed: mix64(k * 7) }, Vec3::ZERO);
            ov.move_point(&PointKey { node: "n".into(), seed: mix64(k * 7 + 3) }, Vec3::ZERO, "n", Transform::from_xyz(1.0, 0.0, 1.0));
        }
        ov.areas.push(OverrideArea { polygon: vec![Vec2::ZERO, Vec2::new(20.0, 0.0), Vec2::new(20.0, 20.0), Vec2::new(0.0, 20.0)], density: 0.5, nodes: None });
        let t0 = std::time::Instant::now();
        let ix = ov.index(32.0);
        let build = t0.elapsed();
        let t1 = std::time::Instant::now();
        let mut n = 0;
        for _ in 0..20 {
            let mut p = pts.clone();
            ix.apply_points("n", Area::cell(0, 0, 32.0), &mut p);
            n = p.len();
        }
        let per = t1.elapsed() / 20;
        eprintln!("overrides: index of 1000 edits {build:?}; apply to 4000 points {per:?} (-> {n})");
        assert!(per.as_millis() < 20 && build.as_millis() < 20);
    }

    #[test]
    fn empty_overrides_do_nothing() {
        let area = Area::cell(0, 0, 32.0);
        let base = rocks(area);
        let mut s = base.clone();
        PcgOverrides::default().index(32.0).apply_spawned(area, &mut s);
        assert_eq!(s, base);
        // Garbage polygons are ignored.
        let mut ov = PcgOverrides::default();
        ov.areas.push(OverrideArea { polygon: vec![Vec2::new(f32::NAN, 0.0); 3], density: 0.0, nodes: None });
        ov.areas.push(OverrideArea { polygon: vec![], density: 0.0, nodes: None });
        ov.index(32.0).apply_spawned(area, &mut s);
        assert_eq!(s, base);
    }
}
