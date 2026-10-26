//! The tiled navigation mesh: tiles of axis-aligned walkable rectangles ("polys") with
//! per-corner heights, links between them (inside a tile, across tile borders, and off-mesh
//! links), and the point lookups everything else builds on.
//!
//! Polys are rectangles in XZ because the baker ([`super::bake`]) partitions the voxelized
//! walkable surface into maximal flat-or-planar rectangles. That keeps nearest-point, height and
//! raycast queries branch-light and allocation-free.

use bevy::math::{Vec2, Vec3};
use bevy::platform::collections::HashMap;

use super::NavMeshSettings;

/// A poly in a [`NavMesh`]. `salt` changes whenever its tile is rebuilt, so a stale ref held by
/// an agent is detected with [`NavMesh::is_valid`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PolyRef {
    pub slot: u32,
    pub poly: u16,
    pub salt: u16,
}

/// A walkable rectangle. `h` = surface height at the corners (x0z0, x1z0, x0z1, x1z1).
#[derive(Clone, Debug, PartialEq)]
pub struct Poly {
    pub min: Vec2,
    pub max: Vec2,
    pub h: [f32; 4],
    /// Internal links: `links[first_link .. first_link + link_count]` of the tile.
    pub first_link: u32,
    pub link_count: u16,
    /// Bit per side touching the tile border: 1 = -x, 2 = +x, 4 = -z, 8 = +z.
    pub border: u8,
}

impl Poly {
    /// Height at `(x, z)` (bilinear over the corners; clamped into the rect).
    #[inline]
    pub fn height_at(&self, x: f32, z: f32) -> f32 {
        let sx = (self.max.x - self.min.x).max(1e-6);
        let sz = (self.max.y - self.min.y).max(1e-6);
        let u = ((x - self.min.x) / sx).clamp(0.0, 1.0);
        let v = ((z - self.min.y) / sz).clamp(0.0, 1.0);
        let a = self.h[0] + (self.h[1] - self.h[0]) * u;
        let b = self.h[2] + (self.h[3] - self.h[2]) * u;
        a + (b - a) * v
    }

    /// Closest point on the poly surface to `p`.
    #[inline]
    pub fn closest_point(&self, p: Vec3) -> Vec3 {
        let x = p.x.clamp(self.min.x, self.max.x);
        let z = p.z.clamp(self.min.y, self.max.y);
        Vec3::new(x, self.height_at(x, z), z)
    }

    #[inline]
    pub fn contains_xz(&self, x: f32, z: f32) -> bool {
        x >= self.min.x && x <= self.max.x && z >= self.min.y && z <= self.max.y
    }

    #[inline]
    pub fn center(&self) -> Vec3 {
        let c = (self.min + self.max) * 0.5;
        Vec3::new(c.x, self.height_at(c.x, c.y), c.y)
    }

    #[inline]
    pub fn area(&self) -> f32 {
        (self.max.x - self.min.x) * (self.max.y - self.min.y)
    }

    pub fn y_range(&self) -> (f32, f32) {
        let lo = self.h.iter().copied().fold(f32::MAX, f32::min);
        let hi = self.h.iter().copied().fold(f32::MIN, f32::max);
        (lo, hi)
    }
}

/// A connection from one poly to another. For an edge link `a`/`b` are the shared portal
/// segment's endpoints; for an off-mesh link they are the link's start and end points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Link {
    pub to: PolyRef,
    pub a: Vec3,
    pub b: Vec3,
    /// `None` for an edge, `Some(i)` for off-mesh link `i` in [`NavMesh::offmesh_links`].
    pub offmesh: Option<u32>,
}

/// One baked tile.
#[derive(Clone, Debug, Default)]
pub struct NavTile {
    pub coord: (i32, i32),
    pub polys: Vec<Poly>,
    /// Links inside the tile, ranged by [`Poly::first_link`].
    pub links: Vec<Link>,
    /// Links to neighbour tiles, rebuilt by the mesh when this tile or a neighbour changes;
    /// `ext_index[poly]..ext_index[poly + 1]` ranges into `ext_links`.
    pub(crate) ext_links: Vec<Link>,
    pub(crate) ext_index: Vec<u32>,
    pub(crate) salt: u16,
}

impl NavTile {
    pub fn poly_count(&self) -> usize {
        self.polys.len()
    }
}

/// A code-defined off-mesh connection (jump, ladder, teleporter). Its ends snap to the nearest
/// poly within `radius`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OffMeshLink {
    pub start: Vec3,
    pub end: Vec3,
    pub bidirectional: bool,
    /// Snap radius for the ends.
    pub radius: f32,
    /// Path cost multiplier on the link's length (> 1 makes A* avoid it).
    pub cost: f32,
    /// Game tag (e.g. 0 = jump, 1 = ladder); reported on path points.
    pub tag: u16,
    /// Optional user id (the entity bits of a `NavLink` component, or anything).
    pub user: u64,
}

impl Default for OffMeshLink {
    fn default() -> Self {
        OffMeshLink { start: Vec3::ZERO, end: Vec3::ZERO, bidirectional: true, radius: 0.6, cost: 1.0, tag: 0, user: 0 }
    }
}

#[derive(Clone, Debug, Default)]
struct Slot {
    tile: Option<NavTile>,
    salt: u16,
}

/// A navigation mesh for one agent type. Built by [`super::bake::bake_mesh`] /
/// [`NavMesh::insert_tile`] (the plugin bakes it from colliders in the background).
#[derive(Clone, Debug, Default)]
pub struct NavMesh {
    pub settings: NavMeshSettings,
    /// World Y of voxel layer 0 (heights are quantized from it).
    pub origin_y: f32,
    slots: Vec<Slot>,
    free: Vec<u32>,
    by_coord: HashMap<(i32, i32), u32>,
    offmesh: Vec<OffMeshLink>,
    /// Resolved off-mesh links: `(from, to, link index, traversed end → start)`.
    offmesh_resolved: Vec<(PolyRef, PolyRef, u32, bool)>,
    offmesh_from: HashMap<PolyRef, (u32, u32)>,
    /// Bumped on every change.
    pub version: u64,
}

impl NavMesh {
    pub fn new(settings: NavMeshSettings, origin_y: f32) -> Self {
        NavMesh { settings, origin_y, ..Default::default() }
    }

    /// World size of one tile edge.
    #[inline]
    pub fn tile_world(&self) -> f32 {
        self.settings.tile_size as f32 * self.settings.cell_size
    }

    #[inline]
    pub fn tile_coord_of(&self, x: f32, z: f32) -> (i32, i32) {
        let t = self.tile_world();
        ((x / t).floor() as i32, (z / t).floor() as i32)
    }

    pub fn tile_count(&self) -> usize {
        self.by_coord.len()
    }

    pub fn poly_count(&self) -> usize {
        self.tiles().map(|(_, t)| t.polys.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.by_coord.is_empty()
    }

    /// Every tile with its slot index.
    pub fn tiles(&self) -> impl Iterator<Item = (u32, &NavTile)> {
        self.slots.iter().enumerate().filter_map(|(i, s)| s.tile.as_ref().map(|t| (i as u32, t)))
    }

    pub fn tile_at(&self, coord: (i32, i32)) -> Option<&NavTile> {
        self.by_coord.get(&coord).and_then(|&s| self.slots[s as usize].tile.as_ref())
    }

    pub fn tile_slot(&self, coord: (i32, i32)) -> Option<u32> {
        self.by_coord.get(&coord).copied()
    }

    #[inline]
    pub fn is_valid(&self, r: PolyRef) -> bool {
        self.slots
            .get(r.slot as usize)
            .is_some_and(|s| s.salt == r.salt && s.tile.as_ref().is_some_and(|t| (r.poly as usize) < t.polys.len()))
    }

    #[inline]
    pub fn poly(&self, r: PolyRef) -> Option<&Poly> {
        let s = self.slots.get(r.slot as usize)?;
        if s.salt != r.salt {
            return None;
        }
        s.tile.as_ref()?.polys.get(r.poly as usize)
    }

    /// The poly's tile coordinate.
    pub fn poly_tile(&self, r: PolyRef) -> Option<(i32, i32)> {
        self.slots.get(r.slot as usize)?.tile.as_ref().map(|t| t.coord)
    }

    /// Calls `f` for every link out of `r` (internal, cross-tile, off-mesh). No allocation.
    #[inline]
    pub fn for_each_link(&self, r: PolyRef, mut f: impl FnMut(&Link)) {
        let Some(slot) = self.slots.get(r.slot as usize) else { return };
        if slot.salt != r.salt {
            return;
        }
        let Some(tile) = slot.tile.as_ref() else { return };
        let Some(p) = tile.polys.get(r.poly as usize) else { return };
        for l in &tile.links[p.first_link as usize..(p.first_link as usize + p.link_count as usize)] {
            f(l);
        }
        let i = r.poly as usize;
        if i + 1 < tile.ext_index.len() {
            for l in &tile.ext_links[tile.ext_index[i] as usize..tile.ext_index[i + 1] as usize] {
                f(l);
            }
        }
        if let Some(&(a, b)) = self.offmesh_from.get(&r) {
            for &(from, to, li, reversed) in &self.offmesh_resolved[a as usize..b as usize] {
                debug_assert_eq!(from, r);
                let l = &self.offmesh[li as usize];
                let (s, e) = if reversed { (l.end, l.start) } else { (l.start, l.end) };
                f(&Link { to, a: s, b: e, offmesh: Some(li) });
            }
        }
    }

    /// Replaces (or adds) the tile at `tile.coord`, relinks it with its neighbours and
    /// re-resolves off-mesh links. Returns the slot.
    pub fn insert_tile(&mut self, mut tile: NavTile) -> u32 {
        let coord = tile.coord;
        let slot = match self.by_coord.get(&coord) {
            Some(&s) => s,
            None => {
                let s = self.free.pop().unwrap_or_else(|| {
                    self.slots.push(Slot::default());
                    self.slots.len() as u32 - 1
                });
                self.by_coord.insert(coord, s);
                s
            }
        };
        let s = &mut self.slots[slot as usize];
        s.salt = s.salt.wrapping_add(1).max(1);
        tile.salt = s.salt;
        // Internal links were baked with slot 0 / salt 0 placeholders: patch them.
        for l in &mut tile.links {
            l.to.slot = slot;
            l.to.salt = s.salt;
        }
        s.tile = Some(tile);
        self.relink_around(coord);
        self.resolve_offmesh();
        self.version += 1;
        slot
    }

    /// Removes the tile at `coord` (if any).
    pub fn remove_tile(&mut self, coord: (i32, i32)) -> bool {
        let Some(slot) = self.by_coord.remove(&coord) else { return false };
        let s = &mut self.slots[slot as usize];
        s.tile = None;
        s.salt = s.salt.wrapping_add(1).max(1);
        self.free.push(slot);
        self.relink_around(coord);
        self.resolve_offmesh();
        self.version += 1;
        true
    }

    /// Inserts many tiles, relinking once at the end (faster than [`Self::insert_tile`] in a loop).
    pub fn insert_tiles(&mut self, tiles: impl IntoIterator<Item = NavTile>, removed: &[(i32, i32)]) {
        let mut touched: Vec<(i32, i32)> = Vec::new();
        for &c in removed {
            if let Some(slot) = self.by_coord.remove(&c) {
                let s = &mut self.slots[slot as usize];
                s.tile = None;
                s.salt = s.salt.wrapping_add(1).max(1);
                self.free.push(slot);
                touched.push(c);
            }
        }
        for mut tile in tiles {
            let coord = tile.coord;
            let slot = match self.by_coord.get(&coord) {
                Some(&s) => s,
                None => {
                    let s = self.free.pop().unwrap_or_else(|| {
                        self.slots.push(Slot::default());
                        self.slots.len() as u32 - 1
                    });
                    self.by_coord.insert(coord, s);
                    s
                }
            };
            let s = &mut self.slots[slot as usize];
            s.salt = s.salt.wrapping_add(1).max(1);
            tile.salt = s.salt;
            for l in &mut tile.links {
                l.to.slot = slot;
                l.to.salt = s.salt;
            }
            s.tile = Some(tile);
            touched.push(coord);
        }
        // Relink touched tiles and their neighbours, each once.
        let mut set: Vec<(i32, i32)> = Vec::with_capacity(touched.len() * 5);
        for &(x, z) in &touched {
            set.extend_from_slice(&[(x, z), (x - 1, z), (x + 1, z), (x, z - 1), (x, z + 1)]);
        }
        set.sort_unstable();
        set.dedup();
        for c in set {
            self.relink_tile(c);
        }
        self.resolve_offmesh();
        self.version += 1;
    }

    fn relink_around(&mut self, (x, z): (i32, i32)) {
        for c in [(x, z), (x - 1, z), (x + 1, z), (x, z - 1), (x, z + 1)] {
            self.relink_tile(c);
        }
    }

    /// Rebuilds the cross-tile links of the tile at `coord`.
    fn relink_tile(&mut self, coord: (i32, i32)) {
        let Some(&slot) = self.by_coord.get(&coord) else { return };
        let climb = self.settings.agent_climb;
        let eps = self.settings.cell_size * 0.25;
        let mut ext: Vec<(u16, Link)> = Vec::new();
        {
            let tile = self.slots[slot as usize].tile.as_ref().unwrap();
            // side bit, neighbour coord, neighbour's matching side bit
            let sides = [
                (1u8, (coord.0 - 1, coord.1), 2u8),
                (2u8, (coord.0 + 1, coord.1), 1u8),
                (4u8, (coord.0, coord.1 - 1), 8u8),
                (8u8, (coord.0, coord.1 + 1), 4u8),
            ];
            for (bit, ncoord, nbit) in sides {
                let Some(&nslot) = self.by_coord.get(&ncoord) else { continue };
                let ns = &self.slots[nslot as usize];
                let Some(ntile) = ns.tile.as_ref() else { continue };
                for (pi, p) in tile.polys.iter().enumerate() {
                    if p.border & bit == 0 {
                        continue;
                    }
                    for (qi, q) in ntile.polys.iter().enumerate() {
                        if q.border & nbit == 0 {
                            continue;
                        }
                        // Shared line and overlap along it.
                        let (lo, hi, a, b) = match bit {
                            1 | 2 => {
                                let x = if bit == 1 { p.min.x } else { p.max.x };
                                let qx = if bit == 1 { q.max.x } else { q.min.x };
                                if (x - qx).abs() > eps {
                                    continue;
                                }
                                let lo = p.min.y.max(q.min.y);
                                let hi = p.max.y.min(q.max.y);
                                (lo, hi, Vec2::new(x, lo), Vec2::new(x, hi))
                            }
                            _ => {
                                let zz = if bit == 4 { p.min.y } else { p.max.y };
                                let qz = if bit == 4 { q.max.y } else { q.min.y };
                                if (zz - qz).abs() > eps {
                                    continue;
                                }
                                let lo = p.min.x.max(q.min.x);
                                let hi = p.max.x.min(q.max.x);
                                (lo, hi, Vec2::new(lo, zz), Vec2::new(hi, zz))
                            }
                        };
                        if hi - lo < eps {
                            continue;
                        }
                        let (pa, pb) = (p.height_at(a.x, a.y), p.height_at(b.x, b.y));
                        let (qa, qb) = (q.height_at(a.x, a.y), q.height_at(b.x, b.y));
                        if (pa - qa).abs() > climb || (pb - qb).abs() > climb {
                            continue;
                        }
                        ext.push((
                            pi as u16,
                            Link {
                                to: PolyRef { slot: nslot, poly: qi as u16, salt: ns.salt },
                                a: Vec3::new(a.x, pa.max(qa), a.y),
                                b: Vec3::new(b.x, pb.max(qb), b.y),
                                offmesh: None,
                            },
                        ));
                    }
                }
            }
        }
        ext.sort_by_key(|(p, _)| *p);
        let tile = self.slots[slot as usize].tile.as_mut().unwrap();
        let n = tile.polys.len();
        tile.ext_index.clear();
        tile.ext_index.resize(n + 1, 0);
        for (p, _) in &ext {
            tile.ext_index[*p as usize + 1] += 1;
        }
        for i in 0..n {
            tile.ext_index[i + 1] += tile.ext_index[i];
        }
        tile.ext_links.clear();
        tile.ext_links.extend(ext.into_iter().map(|(_, l)| l));
    }

    // ---- off-mesh links ----

    pub fn offmesh_links(&self) -> &[OffMeshLink] {
        &self.offmesh
    }

    /// Adds an off-mesh link; returns its index.
    pub fn add_offmesh_link(&mut self, link: OffMeshLink) -> u32 {
        self.offmesh.push(link);
        self.resolve_offmesh();
        self.version += 1;
        self.offmesh.len() as u32 - 1
    }

    /// Replaces every off-mesh link.
    pub fn set_offmesh_links(&mut self, links: Vec<OffMeshLink>) {
        self.offmesh = links;
        self.resolve_offmesh();
        self.version += 1;
    }

    /// Off-mesh links whose ends both snapped onto the mesh: `(from, to, link index, reversed)`.
    pub fn resolved_offmesh(&self) -> &[(PolyRef, PolyRef, u32, bool)] {
        &self.offmesh_resolved
    }

    fn resolve_offmesh(&mut self) {
        self.offmesh_resolved.clear();
        self.offmesh_from.clear();
        for (i, l) in self.offmesh.iter().enumerate() {
            let ext = Vec3::new(l.radius, l.radius.max(self.settings.agent_climb * 2.0), l.radius);
            let (Some((a, _)), Some((b, _))) = (self.nearest_poly(l.start, ext), self.nearest_poly(l.end, ext)) else {
                continue;
            };
            self.offmesh_resolved.push((a, b, i as u32, false));
            if l.bidirectional {
                self.offmesh_resolved.push((b, a, i as u32, true));
            }
        }
        self.offmesh_resolved.sort_by_key(|e| e.0);
        let mut i = 0;
        while i < self.offmesh_resolved.len() {
            let f = self.offmesh_resolved[i].0;
            let mut j = i;
            while j < self.offmesh_resolved.len() && self.offmesh_resolved[j].0 == f {
                j += 1;
            }
            self.offmesh_from.insert(f, (i as u32, j as u32));
            i = j;
        }
    }

    // ---- point queries ----

    /// The poly nearest to `p` within the box `p ± extents`, and the closest point on it.
    pub fn nearest_poly(&self, p: Vec3, extents: Vec3) -> Option<(PolyRef, Vec3)> {
        let t = self.tile_world();
        let (x0, z0) = (((p.x - extents.x) / t).floor() as i32, ((p.z - extents.z) / t).floor() as i32);
        let (x1, z1) = (((p.x + extents.x) / t).floor() as i32, ((p.z + extents.z) / t).floor() as i32);
        let mut best: Option<(PolyRef, Vec3, f32)> = None;
        for tz in z0..=z1 {
            for tx in x0..=x1 {
                let Some(&slot) = self.by_coord.get(&(tx, tz)) else { continue };
                let s = &self.slots[slot as usize];
                let Some(tile) = s.tile.as_ref() else { continue };
                for (i, poly) in tile.polys.iter().enumerate() {
                    if poly.max.x < p.x - extents.x
                        || poly.min.x > p.x + extents.x
                        || poly.max.y < p.z - extents.z
                        || poly.min.y > p.z + extents.z
                    {
                        continue;
                    }
                    let c = poly.closest_point(p);
                    let dy = (c.y - p.y).abs();
                    if dy > extents.y {
                        continue;
                    }
                    // Prefer the poly under/around the point: horizontal distance first, then height.
                    let d = (c.x - p.x).powi(2) + (c.z - p.z).powi(2) + dy * dy * 0.25;
                    if best.is_none_or(|b| d < b.2) {
                        best = Some((PolyRef { slot, poly: i as u16, salt: s.salt }, c, d));
                    }
                }
            }
        }
        best.map(|(r, c, _)| (r, c))
    }

    /// Closest point on mesh to `p` (within `extents`).
    pub fn nearest_point(&self, p: Vec3, extents: Vec3) -> Option<Vec3> {
        self.nearest_poly(p, extents).map(|(_, c)| c)
    }

    /// Surface height under `(x, z)` closest to `y_hint`, if the point is on the mesh.
    pub fn height_at(&self, x: f32, z: f32, y_hint: f32, max_dy: f32) -> Option<f32> {
        let (tx, tz) = self.tile_coord_of(x, z);
        let tile = self.tile_at((tx, tz))?;
        let mut best: Option<f32> = None;
        for p in &tile.polys {
            if p.contains_xz(x, z) {
                let h = p.height_at(x, z);
                if (h - y_hint).abs() <= max_dy && best.is_none_or(|b| (h - y_hint).abs() < (b - y_hint).abs()) {
                    best = Some(h);
                }
            }
        }
        best
    }

    /// World AABB (min, max) of all polys.
    pub fn bounds(&self) -> Option<(Vec3, Vec3)> {
        let mut lo = Vec3::splat(f32::MAX);
        let mut hi = Vec3::splat(f32::MIN);
        let mut any = false;
        for (_, t) in self.tiles() {
            for p in &t.polys {
                let (y0, y1) = p.y_range();
                lo = lo.min(Vec3::new(p.min.x, y0, p.min.y));
                hi = hi.max(Vec3::new(p.max.x, y1, p.max.y));
                any = true;
            }
        }
        any.then_some((lo, hi))
    }

    /// Every poly with its ref (for debug drawing and stats).
    pub fn polys(&self) -> impl Iterator<Item = (PolyRef, &Poly)> {
        self.slots.iter().enumerate().flat_map(|(si, s)| {
            s.tile.iter().flat_map(move |t| {
                t.polys.iter().enumerate().map(move |(i, p)| (PolyRef { slot: si as u32, poly: i as u16, salt: s.salt }, p))
            })
        })
    }

    /// Total walkable area (m²).
    pub fn area(&self) -> f32 {
        self.polys().map(|(_, p)| p.area()).sum()
    }
}
