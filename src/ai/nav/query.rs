//! Queries over a [`NavMesh`]: A* over polys + funnel string pulling ([`NavQuery::find_path`]),
//! [`raycast`], [`move_along_surface`] (agents' wall sliding), random points.
//!
//! [`NavQuery`] owns the search buffers; keep one around (the plugin keeps one per frame budget)
//! and queries allocate nothing after warm-up except the returned path.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use bevy::math::{Vec2, Vec3};
use bevy::platform::collections::HashMap;

use super::mesh::{Link, NavMesh, PolyRef};

/// A corner of a path. `offmesh = Some(i)`: this point starts off-mesh link `i`; the next point is
/// its other end.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct PathPoint {
    pub pos: Vec3,
    pub offmesh: Option<u32>,
}

/// A path: straight-line corners from start to end, plus the poly corridor.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavPath {
    pub points: Vec<PathPoint>,
    pub polys: Vec<PolyRef>,
    /// `false`: the end wasn't reachable (or the node budget ran out); the path goes to the
    /// reachable point closest to it.
    pub complete: bool,
}

impl NavPath {
    pub fn length(&self) -> f32 {
        self.points.windows(2).map(|w| w[0].pos.distance(w[1].pos)).sum()
    }
    pub fn end(&self) -> Option<Vec3> {
        self.points.last().map(|p| p.pos)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum PathError {
    /// No navmesh poly near the start.
    NoStart,
    /// No navmesh poly near the end.
    NoEnd,
}

impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            PathError::NoStart => "start is not on the navmesh",
            PathError::NoEnd => "end is not on the navmesh",
        })
    }
}

#[derive(Clone, Copy)]
struct Node {
    poly: PolyRef,
    parent: u32,
    g: f32,
    f: f32,
    pos: Vec3,
    via: Option<Link>,
    closed: bool,
}

#[derive(Clone, Copy, PartialEq)]
struct HeapItem(f32, u32);
impl Eq for HeapItem {}
impl PartialOrd for HeapItem {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for HeapItem {
    fn cmp(&self, o: &Self) -> Ordering {
        // Min-heap on f.
        o.0.total_cmp(&self.0).then(o.1.cmp(&self.1))
    }
}

/// Reusable path-finding buffers.
#[derive(Default)]
pub struct NavQuery {
    nodes: Vec<Node>,
    map: HashMap<PolyRef, u32>,
    heap: BinaryHeap<HeapItem>,
    corridor: Vec<PolyRef>,
    corridor_links: Vec<Link>,
    portals: Vec<(Vec3, Vec3)>,
    /// Nodes expanded by the last search.
    pub last_nodes: usize,
}

const NO_PARENT: u32 = u32::MAX;

impl NavQuery {
    pub fn new() -> Self {
        Self::default()
    }

    /// A path from `start` to `end`. Both snap to the nearest poly within `extents`.
    /// `max_nodes` bounds the search (partial path to the closest node when exceeded).
    pub fn find_path(&mut self, mesh: &NavMesh, start: Vec3, end: Vec3, extents: Vec3, max_nodes: usize) -> Result<NavPath, PathError> {
        let (sr, sp) = mesh.nearest_poly(start, extents).ok_or(PathError::NoStart)?;
        let (er, ep) = mesh.nearest_poly(end, extents).ok_or(PathError::NoEnd)?;
        Ok(self.find_path_refs(mesh, sr, sp, er, ep, max_nodes))
    }

    /// [`Self::find_path`] from already-snapped refs and points.
    pub fn find_path_refs(&mut self, mesh: &NavMesh, sr: PolyRef, sp: Vec3, er: PolyRef, ep: Vec3, max_nodes: usize) -> NavPath {
        let (complete, last) = self.search(mesh, sr, sp, er, ep, max_nodes.max(1));
        let end = if complete { ep } else { self.nodes[last as usize].pos };
        let end = if complete {
            end
        } else {
            mesh.poly(self.nodes[last as usize].poly).map(|p| p.closest_point(ep)).unwrap_or(end)
        };
        // Corridor from the end node back.
        self.corridor.clear();
        self.corridor_links.clear();
        let mut i = last;
        while i != NO_PARENT {
            let n = self.nodes[i as usize];
            self.corridor.push(n.poly);
            if let Some(l) = n.via {
                self.corridor_links.push(l);
            }
            i = n.parent;
        }
        self.corridor.reverse();
        self.corridor_links.reverse();
        let mut path = NavPath { points: Vec::new(), polys: self.corridor.clone(), complete };
        self.string_pull(mesh, sp, end, &mut path.points);
        path
    }

    fn search(&mut self, mesh: &NavMesh, sr: PolyRef, sp: Vec3, er: PolyRef, ep: Vec3, max_nodes: usize) -> (bool, u32) {
        self.nodes.clear();
        self.map.clear();
        self.heap.clear();
        let h0 = sp.distance(ep);
        self.nodes.push(Node { poly: sr, parent: NO_PARENT, g: 0.0, f: h0, pos: sp, via: None, closed: false });
        self.map.insert(sr, 0);
        self.heap.push(HeapItem(h0, 0));
        let mut best = 0u32;
        let mut best_h = h0;
        let mut expanded = 0;
        while let Some(HeapItem(f, ni)) = self.heap.pop() {
            let node = self.nodes[ni as usize];
            if node.closed || f > node.f {
                continue;
            }
            self.nodes[ni as usize].closed = true;
            expanded += 1;
            if node.poly == er {
                self.last_nodes = expanded;
                return (true, ni);
            }
            if expanded >= max_nodes {
                break;
            }
            let nodes = &mut self.nodes;
            let map = &mut self.map;
            let heap = &mut self.heap;
            mesh.for_each_link(node.poly, |l| {
                let (pos, cost) = match l.offmesh {
                    None => {
                        // Portal midpoint (Detour-style); into the goal poly, the portal point
                        // nearest the goal.
                        let e = if l.to == er { closest_on_segment(l.a, l.b, ep) } else { (l.a + l.b) * 0.5 };
                        (e, node.pos.distance(e))
                    }
                    Some(li) => {
                        let link = &mesh.offmesh_links()[li as usize];
                        (l.b, node.pos.distance(l.a) + l.a.distance(l.b) * link.cost.max(0.01))
                    }
                };
                let g = node.g + cost;
                let h = pos.distance(ep);
                match map.get(&l.to) {
                    Some(&j) => {
                        let n = &mut nodes[j as usize];
                        if !n.closed && g < n.g {
                            n.g = g;
                            n.f = g + h;
                            n.parent = ni;
                            n.pos = pos;
                            n.via = Some(*l);
                            heap.push(HeapItem(g + h, j));
                        }
                    }
                    None => {
                        let j = nodes.len() as u32;
                        nodes.push(Node { poly: l.to, parent: ni, g, f: g + h, pos, via: Some(*l), closed: false });
                        map.insert(l.to, j);
                        heap.push(HeapItem(g + h, j));
                    }
                }
            });
            let h = node.pos.distance(ep);
            if h < best_h {
                best_h = h;
                best = ni;
            }
        }
        // Also consider open nodes for the closest partial end.
        for (i, n) in self.nodes.iter().enumerate() {
            let h = n.pos.distance(ep);
            if n.closed && h < best_h {
                best_h = h;
                best = i as u32;
            }
        }
        self.last_nodes = expanded;
        (false, best)
    }

    /// Funnel ("simple stupid funnel") over the corridor's portals, split at off-mesh links.
    fn string_pull(&mut self, mesh: &NavMesh, start: Vec3, end: Vec3, out: &mut Vec<PathPoint>) {
        out.clear();
        out.push(PathPoint { pos: start, offmesh: None });
        let mut seg_start = start;
        self.portals.clear();
        self.portals.push((start, start));
        for (i, l) in self.corridor_links.iter().enumerate() {
            match l.offmesh {
                None => {
                    let from = self.corridor[i];
                    let c = mesh.poly(from).map(|p| p.center()).unwrap_or(seg_start);
                    let m = (l.a + l.b) * 0.5;
                    let (left, right) = if area2(c, m, l.a) < 0.0 { (l.a, l.b) } else { (l.b, l.a) };
                    self.portals.push((left, right));
                }
                Some(li) => {
                    self.portals.push((l.a, l.a));
                    funnel(&self.portals, out);
                    push_point(out, PathPoint { pos: l.a, offmesh: Some(li) });
                    push_point(out, PathPoint { pos: l.b, offmesh: None });
                    seg_start = l.b;
                    self.portals.clear();
                    self.portals.push((seg_start, seg_start));
                }
            }
        }
        self.portals.push((end, end));
        funnel(&self.portals, out);
        // Drop corners that are collinear in XZ (funnels through exact poly corners).
        let mut i = 1;
        while i + 1 < out.len() {
            let (a, b, c) = (out[i - 1], out[i], out[i + 1]);
            let ab = Vec2::new(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
            let bc = Vec2::new(c.pos.x - b.pos.x, c.pos.z - b.pos.z);
            let cross = ab.perp_dot(bc).abs();
            if a.offmesh.is_none() && b.offmesh.is_none() && cross <= 1e-4 * ab.length() * bc.length() + 1e-9 && ab.dot(bc) >= 0.0 {
                out.remove(i);
            } else {
                i += 1;
            }
        }
    }
}

#[inline]
fn area2(a: Vec3, b: Vec3, c: Vec3) -> f32 {
    (c.x - a.x) * (b.z - a.z) - (b.x - a.x) * (c.z - a.z)
}

#[inline]
fn veq(a: Vec3, b: Vec3) -> bool {
    (a.x - b.x).powi(2) + (a.z - b.z).powi(2) < 1e-8
}

fn push_point(out: &mut Vec<PathPoint>, p: PathPoint) {
    if let Some(last) = out.last_mut()
        && veq(last.pos, p.pos)
        && (last.pos.y - p.pos.y).abs() < 0.05
    {
        if p.offmesh.is_some() {
            last.offmesh = p.offmesh;
        }
        return;
    }
    out.push(p);
}

/// Appends the funnel's corners after `portals[0].0` (assumed already in `out`), ending with
/// the last portal's point.
fn funnel(portals: &[(Vec3, Vec3)], out: &mut Vec<PathPoint>) {
    let n = portals.len();
    if n < 2 {
        return;
    }
    let mut apex = portals[0].0;
    let mut left = apex;
    let mut right = apex;
    let (mut left_i, mut right_i) = (0usize, 0usize);
    let mut i = 1;
    let mut guard = 0;
    while i < n {
        guard += 1;
        if guard > n * 4 + 16 {
            break;
        }
        let (pl, pr) = portals[i];
        if area2(apex, right, pr) <= 0.0 {
            if veq(apex, right) || area2(apex, left, pr) > 0.0 {
                right = pr;
                right_i = i;
            } else {
                apex = left;
                let apex_i = left_i;
                push_point(out, PathPoint { pos: apex, offmesh: None });
                left = apex;
                right = apex;
                right_i = apex_i;
                i = apex_i + 1;
                continue;
            }
        }
        if area2(apex, left, pl) >= 0.0 {
            if veq(apex, left) || area2(apex, right, pl) < 0.0 {
                left = pl;
                left_i = i;
            } else {
                apex = right;
                let apex_i = right_i;
                push_point(out, PathPoint { pos: apex, offmesh: None });
                left = apex;
                right = apex;
                left_i = apex_i;
                i = apex_i + 1;
                continue;
            }
        }
        i += 1;
    }
    push_point(out, PathPoint { pos: portals[n - 1].0, offmesh: None });
}

fn closest_on_segment(a: Vec3, b: Vec3, p: Vec3) -> Vec3 {
    let ab = b - a;
    let l2 = ab.length_squared();
    if l2 < 1e-12 {
        return a;
    }
    a + ab * ((p - a).dot(ab) / l2).clamp(0.0, 1.0)
}

fn dist_point_segment_2d(p: Vec2, a: Vec2, b: Vec2) -> f32 {
    let ab = b - a;
    let l2 = ab.length_squared();
    let t = if l2 < 1e-12 { 0.0 } else { ((p - a).dot(ab) / l2).clamp(0.0, 1.0) };
    p.distance(a + ab * t)
}

/// Result of [`raycast`].
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct NavRayHit {
    /// Fraction of the segment travelled (1 = reached the end).
    pub t: f32,
    pub hit: bool,
    /// Wall normal (XZ) when `hit`.
    pub normal: Vec3,
    pub point: Vec3,
    #[serde(skip)]
    pub poly: PolyRef,
}

/// Walks the mesh surface from `start` (on `start_ref`) towards `end` in XZ; stops at the first
/// boundary edge.
pub fn raycast(mesh: &NavMesh, start_ref: PolyRef, start: Vec3, end: Vec3) -> NavRayHit {
    let d = Vec2::new(end.x - start.x, end.z - start.z);
    let eps = mesh.settings.cell_size * 0.05;
    let mut cur = start_ref;
    let mut prev: Option<PolyRef> = None;
    let point_at = |cur: PolyRef, t: f32| {
        let x = start.x + d.x * t;
        let z = start.z + d.y * t;
        let y = mesh.poly(cur).map(|p| p.height_at(x, z)).unwrap_or(start.y);
        Vec3::new(x, y, z)
    };
    for _ in 0..4096 {
        let Some(p) = mesh.poly(cur) else { break };
        let tx = if d.x > 0.0 {
            (p.max.x - start.x) / d.x
        } else if d.x < 0.0 {
            (p.min.x - start.x) / d.x
        } else {
            f32::INFINITY
        };
        let tz = if d.y > 0.0 {
            (p.max.y - start.z) / d.y
        } else if d.y < 0.0 {
            (p.min.y - start.z) / d.y
        } else {
            f32::INFINITY
        };
        let t_exit = tx.min(tz);
        if t_exit >= 1.0 {
            return NavRayHit { t: 1.0, hit: false, normal: Vec3::ZERO, point: point_at(cur, 1.0), poly: cur };
        }
        let q = Vec2::new(start.x + d.x * t_exit, start.z + d.y * t_exit);
        let mut next: Option<PolyRef> = None;
        let try_x = tx <= tz + eps;
        let try_z = tz <= tx + eps;
        mesh.for_each_link(cur, |l| {
            if next.is_some() || l.offmesh.is_some() || Some(l.to) == prev {
                return;
            }
            let on_x = try_x && {
                let sx = if d.x > 0.0 { p.max.x } else { p.min.x };
                (l.a.x - sx).abs() < eps && (l.b.x - sx).abs() < eps && q.y >= l.a.z.min(l.b.z) - eps && q.y <= l.a.z.max(l.b.z) + eps
            };
            let on_z = try_z && {
                let sz = if d.y > 0.0 { p.max.y } else { p.min.y };
                (l.a.z - sz).abs() < eps && (l.b.z - sz).abs() < eps && q.x >= l.a.x.min(l.b.x) - eps && q.x <= l.a.x.max(l.b.x) + eps
            };
            if on_x || on_z {
                next = Some(l.to);
            }
        });
        match next {
            Some(n) => {
                prev = Some(cur);
                cur = n;
            }
            None => {
                let normal = if tx <= tz { Vec3::new(-d.x.signum(), 0.0, 0.0) } else { Vec3::new(0.0, 0.0, -d.y.signum()) };
                return NavRayHit { t: t_exit.max(0.0), hit: true, normal, point: point_at(cur, t_exit.max(0.0)), poly: cur };
            }
        }
    }
    NavRayHit { t: 0.0, hit: true, normal: Vec3::ZERO, point: start, poly: cur }
}

/// Moves from `start` (on `start_ref`) towards `end` along the surface, sliding along walls.
/// Returns the poly reached and the position (with the surface height). Visits ≤ 32 polys.
pub fn move_along_surface(mesh: &NavMesh, start_ref: PolyRef, start: Vec3, end: Vec3) -> (PolyRef, Vec3) {
    const MAX: usize = 32;
    let mut stack: [PolyRef; MAX] = [start_ref; MAX];
    let mut visited: [PolyRef; MAX] = [start_ref; MAX];
    let (mut sn, mut vn) = (1usize, 1usize);
    let s2 = Vec2::new(start.x, start.z);
    let e2 = Vec2::new(end.x, end.z);
    let mid = (s2 + e2) * 0.5;
    let radius = s2.distance(e2) * 0.5 + 0.001;
    let mut best = start_ref;
    let mut best_pos = start;
    let mut best_d = f32::MAX;
    while sn > 0 {
        sn -= 1;
        let r = stack[sn];
        let Some(p) = mesh.poly(r) else { continue };
        if p.contains_xz(end.x, end.z) {
            // Several layers could contain it: prefer the one nearest in height.
            let y = p.height_at(end.x, end.z);
            let d = (y - end.y).abs() * 0.01;
            if d < best_d {
                best_d = d;
                best = r;
                best_pos = Vec3::new(end.x, y, end.z);
            }
            continue;
        }
        let c = p.closest_point(end);
        let d = Vec2::new(c.x, c.z).distance_squared(e2);
        if d < best_d {
            best_d = d;
            best = r;
            best_pos = c;
        }
        mesh.for_each_link(r, |l| {
            if l.offmesh.is_some() || vn >= MAX || sn >= MAX {
                return;
            }
            if visited[..vn].contains(&l.to) {
                return;
            }
            if dist_point_segment_2d(mid, Vec2::new(l.a.x, l.a.z), Vec2::new(l.b.x, l.b.z)) > radius {
                return;
            }
            visited[vn] = l.to;
            vn += 1;
            stack[sn] = l.to;
            sn += 1;
        });
    }
    (best, best_pos)
}

/// A uniformly random point on the mesh (polys weighted by area).
pub fn random_point(mesh: &NavMesh, rng: &mut impl rand::Rng) -> Option<(PolyRef, Vec3)> {
    let mut chosen = None;
    let mut total = 0.0f32;
    for (r, p) in mesh.polys() {
        let a = p.area();
        total += a;
        if rng.random::<f32>() * total <= a {
            chosen = Some((r, p));
        }
    }
    let (r, p) = chosen?;
    let x = p.min.x + (p.max.x - p.min.x) * rng.random::<f32>();
    let z = p.min.y + (p.max.y - p.min.y) * rng.random::<f32>();
    Some((r, Vec3::new(x, p.height_at(x, z), z)))
}

/// A random point reachable from `start_ref` within `radius` of `center` (flood over ≤ 256
/// polys, weighted by area).
pub fn random_point_around(mesh: &NavMesh, start_ref: PolyRef, center: Vec3, radius: f32, rng: &mut impl rand::Rng) -> Option<(PolyRef, Vec3)> {
    let mut open: Vec<PolyRef> = vec![start_ref];
    let mut seen: Vec<PolyRef> = vec![start_ref];
    let c2 = Vec2::new(center.x, center.z);
    let mut chosen = None;
    let mut total = 0.0f32;
    while let Some(r) = open.pop() {
        let Some(p) = mesh.poly(r) else { continue };
        let a = p.area();
        total += a;
        if rng.random::<f32>() * total <= a {
            chosen = Some(r);
        }
        if seen.len() >= 256 {
            continue;
        }
        mesh.for_each_link(r, |l| {
            if l.offmesh.is_some() || seen.contains(&l.to) {
                return;
            }
            if let Some(q) = mesh.poly(l.to) {
                let cp = Vec2::new(c2.x.clamp(q.min.x, q.max.x), c2.y.clamp(q.min.y, q.max.y));
                if cp.distance(c2) <= radius {
                    seen.push(l.to);
                    open.push(l.to);
                }
            }
        });
    }
    let r = chosen?;
    let p = mesh.poly(r)?;
    for _ in 0..8 {
        let x = p.min.x + (p.max.x - p.min.x) * rng.random::<f32>();
        let z = p.min.y + (p.max.y - p.min.y) * rng.random::<f32>();
        if Vec2::new(x, z).distance(c2) <= radius {
            return Some((r, Vec3::new(x, p.height_at(x, z), z)));
        }
    }
    Some((r, p.closest_point(center)))
}
