//! Recast-style tile baking, written for this engine:
//!
//! 1. **Rasterize** the tile's triangles (plus a border of `agent_radius + 3` cells) into a
//!    voxel heightfield of `cell_size` × `cell_height` spans; triangles flatter than
//!    `max_slope_deg` mark their span tops walkable.
//! 2. **Filter**: low-hanging obstacles within `agent_climb` become walkable (stairs, curbs),
//!    ledges with a drop deeper than `agent_climb` and spans with less than `agent_height`
//!    clearance become unwalkable.
//! 3. **Compact** to open spans with 4-neighbour connections (climb + clearance tested).
//! 4. **Erode** by `agent_radius` with a chamfer distance field.
//! 5. **Regions → polys**: greedy partition of the core cells into maximal rectangles whose
//!    cells are connected and whose heights fit a bilinear surface within `flatness`; links
//!    between rectangles are the shared runs along their sides.
//!
//! Everything here is pure (no ECS) and allocation-reusing through [`BakeScratch`], so tiles bake
//! on any thread.

use std::time::Instant;

use bevy::math::{Vec2, Vec3};

use super::NavMeshSettings;
use super::geometry::NavGeometry;
use super::mesh::{Link, NavMesh, NavTile, Poly, PolyRef};

const NONE: u32 = u32::MAX;
const NOT_CONNECTED: u16 = u16::MAX;
const DX: [i32; 4] = [-1, 0, 1, 0];
const DZ: [i32; 4] = [0, 1, 0, -1];

#[derive(Clone, Copy)]
struct Span {
    min: u16,
    max: u16,
    walkable: bool,
    next: u32,
}

#[derive(Clone, Copy, Default)]
struct CSpan {
    y: u16,
    h: u16,
    con: [u16; 4],
}

/// Reusable buffers for baking tiles (one per thread).
#[derive(Default)]
pub struct BakeScratch {
    spans: Vec<Span>,
    heads: Vec<u32>,
    cells: Vec<(u32, u8)>,
    cspans: Vec<CSpan>,
    walk: Vec<bool>,
    dist: Vec<u8>,
    rect_of: Vec<u32>,
    poly_buf: Vec<[f32; 3]>,
    tmp_a: Vec<[f32; 3]>,
    tmp_b: Vec<[f32; 3]>,
    tmp_c: Vec<[f32; 3]>,
    tmp_d: Vec<[f32; 3]>,
    tmp_e: Vec<[f32; 3]>,
    row: Vec<u32>,
    rects: Vec<Rect>,
}

#[derive(Clone, Copy)]
struct Rect {
    x0: i32,
    z0: i32,
    x1: i32,
    z1: i32,
    /// Compact span index of the four corner cells.
    corners: [u32; 4],
}

/// Per-tile timing and counts from one bake.
#[derive(Clone, Copy, Debug, Default)]
pub struct TileBakeStats {
    pub triangles: u32,
    pub spans: u32,
    pub walkable_cells: u32,
    pub polys: u32,
    pub micros: u32,
}

/// Grid geometry of one tile.
struct TileGrid {
    /// Global cell coordinate of the bordered grid's (0, 0).
    gx: i32,
    gz: i32,
    w: i32,
    border: i32,
    tile: i32,
    cs: f32,
    ch: f32,
    origin_y: f32,
}

impl TileGrid {
    fn new(s: &NavMeshSettings, coord: (i32, i32), origin_y: f32) -> Self {
        let tile = s.tile_size as i32;
        let border = (s.agent_radius / s.cell_size).ceil() as i32 + 3;
        TileGrid {
            gx: coord.0 * tile - border,
            gz: coord.1 * tile - border,
            w: tile + 2 * border,
            border,
            tile,
            cs: s.cell_size,
            ch: s.cell_height,
            origin_y,
        }
    }
    #[inline]
    fn idx(&self, x: i32, z: i32) -> usize {
        (x + z * self.w) as usize
    }
    fn world_min(&self) -> Vec2 {
        Vec2::new(self.gx as f32 * self.cs, self.gz as f32 * self.cs)
    }
}

/// World XZ bounds (min, max) of a tile including its rasterization border.
pub fn tile_bounds_with_border(s: &NavMeshSettings, coord: (i32, i32)) -> (Vec2, Vec2) {
    let g = TileGrid::new(s, coord, 0.0);
    let lo = g.world_min();
    (lo, lo + Vec2::splat(g.w as f32 * g.cs))
}

/// Bakes one tile from `tris` (indices into `geom`). `None` if nothing is walkable.
pub fn bake_tile(
    s: &NavMeshSettings,
    origin_y: f32,
    coord: (i32, i32),
    geom: &NavGeometry,
    tris: &[u32],
    scratch: &mut BakeScratch,
) -> (Option<NavTile>, TileBakeStats) {
    let t0 = Instant::now();
    let g = TileGrid::new(s, coord, origin_y);
    let mut stats = TileBakeStats { triangles: tris.len() as u32, ..Default::default() };
    let n = (g.w * g.w) as usize;
    let climb = (s.agent_climb / s.cell_height).floor() as i32;
    let height = (s.agent_height / s.cell_height).ceil() as i32;
    let walkable_y = s.max_slope_deg.to_radians().cos();

    // 1. Rasterize.
    scratch.spans.clear();
    scratch.heads.clear();
    scratch.heads.resize(n, NONE);
    for &ti in tris {
        let [a, b, c] = geom.tris[ti as usize];
        let nrm = (b - a).cross(c - a);
        let len = nrm.length();
        if len <= 1e-12 {
            continue;
        }
        // Walkable when the up-facing normal is within the slope limit (either winding).
        let walkable = (nrm.y / len).abs() >= walkable_y;
        rasterize_tri(&g, [a, b, c], walkable, climb, scratch);
    }
    stats.spans = scratch.spans.len() as u32;

    // 2. Filters.
    let max_h = u16::MAX as i32;
    if s.filter_low_hanging {
        for i in 0..n {
            let mut prev_walk = false;
            let mut prev_max = 0i32;
            let mut si = scratch.heads[i];
            while si != NONE {
                let sp = scratch.spans[si as usize];
                let was = sp.walkable;
                if !sp.walkable && prev_walk && (sp.max as i32 - prev_max) <= climb {
                    scratch.spans[si as usize].walkable = true;
                }
                prev_walk = was;
                prev_max = sp.max as i32;
                si = sp.next;
            }
        }
    }
    if s.filter_ledges {
        let mut to_clear: Vec<u32> = Vec::new();
        for z in 0..g.w {
            for x in 0..g.w {
                let mut si = scratch.heads[g.idx(x, z)];
                while si != NONE {
                    let sp = scratch.spans[si as usize];
                    if sp.walkable {
                        let floor = sp.max as i32;
                        let ceil = if sp.next != NONE { scratch.spans[sp.next as usize].min as i32 } else { max_h };
                        let mut lowest = max_h;
                        let mut acc_min = floor;
                        let mut acc_max = floor;
                        for d in 0..4 {
                            let (nx, nz) = (x + DX[d], z + DZ[d]);
                            if nx < 0 || nz < 0 || nx >= g.w || nz >= g.w {
                                lowest = -climb - 1;
                                break;
                            }
                            let mut ns = scratch.heads[g.idx(nx, nz)];
                            // Gap below the first neighbour span.
                            let nceil0 = if ns != NONE { scratch.spans[ns as usize].min as i32 } else { max_h };
                            if ceil.min(nceil0) - floor.max(-climb) > height {
                                lowest = lowest.min(-climb - floor);
                            }
                            while ns != NONE {
                                let nsp = scratch.spans[ns as usize];
                                let nfloor = nsp.max as i32;
                                let nceil = if nsp.next != NONE { scratch.spans[nsp.next as usize].min as i32 } else { max_h };
                                if ceil.min(nceil) - floor.max(nfloor) > height {
                                    lowest = lowest.min(nfloor - floor);
                                    if (nfloor - floor).abs() <= climb {
                                        acc_min = acc_min.min(nfloor);
                                        acc_max = acc_max.max(nfloor);
                                    }
                                }
                                ns = nsp.next;
                            }
                        }
                        if lowest < -climb || acc_max - acc_min > climb {
                            to_clear.push(si);
                        }
                    }
                    si = sp.next;
                }
            }
        }
        for si in to_clear {
            scratch.spans[si as usize].walkable = false;
        }
    }
    // Low clearance.
    for i in 0..n {
        let mut si = scratch.heads[i];
        while si != NONE {
            let sp = scratch.spans[si as usize];
            let ceil = if sp.next != NONE { scratch.spans[sp.next as usize].min as i32 } else { max_h };
            if ceil - (sp.max as i32) < height {
                scratch.spans[si as usize].walkable = false;
            }
            si = sp.next;
        }
    }

    // 3. Compact heightfield.
    scratch.cells.clear();
    scratch.cspans.clear();
    for i in 0..n {
        let first = scratch.cspans.len() as u32;
        let mut count = 0u8;
        let mut si = scratch.heads[i];
        while si != NONE {
            let sp = scratch.spans[si as usize];
            if sp.walkable && count < u8::MAX {
                let ceil = if sp.next != NONE { scratch.spans[sp.next as usize].min as i32 } else { max_h };
                scratch.cspans.push(CSpan {
                    y: sp.max,
                    h: (ceil - sp.max as i32).clamp(0, u16::MAX as i32) as u16,
                    con: [NOT_CONNECTED; 4],
                });
                count += 1;
            }
            si = sp.next;
        }
        scratch.cells.push((first, count));
    }
    for z in 0..g.w {
        for x in 0..g.w {
            let (first, count) = scratch.cells[g.idx(x, z)];
            for k in first..first + count as u32 {
                let cs = scratch.cspans[k as usize];
                for d in 0..4 {
                    let (nx, nz) = (x + DX[d], z + DZ[d]);
                    if nx < 0 || nz < 0 || nx >= g.w || nz >= g.w {
                        continue;
                    }
                    let (nf, nc) = scratch.cells[g.idx(nx, nz)];
                    for nk in 0..nc as u32 {
                        let ns = scratch.cspans[(nf + nk) as usize];
                        let bot = cs.y.max(ns.y) as i32;
                        let top = (cs.y as i32 + cs.h as i32).min(ns.y as i32 + ns.h as i32);
                        if top - bot >= height && (ns.y as i32 - cs.y as i32).abs() <= climb {
                            scratch.cspans[k as usize].con[d] = nk as u16;
                            break;
                        }
                    }
                }
            }
        }
    }

    // 4. Erode by agent radius (chamfer distance, 2 per cell orthogonal, 3 diagonal).
    let ns = scratch.cspans.len();
    scratch.dist.clear();
    scratch.dist.resize(ns, 255);
    scratch.walk.clear();
    scratch.walk.resize(ns, true);
    for z in 0..g.w {
        for x in 0..g.w {
            let (first, count) = scratch.cells[g.idx(x, z)];
            for k in first..first + count as u32 {
                if scratch.cspans[k as usize].con.contains(&NOT_CONNECTED) {
                    scratch.dist[k as usize] = 0;
                }
            }
        }
    }
    let nb = |cells: &[(u32, u8)], cspans: &[CSpan], x: i32, z: i32, k: u32, d: usize| -> Option<(i32, i32, u32)> {
        let c = cspans[k as usize].con[d];
        if c == NOT_CONNECTED {
            return None;
        }
        let (nx, nz) = (x + DX[d], z + DZ[d]);
        Some((nx, nz, cells[(nx + nz * g.w) as usize].0 + c as u32))
    };
    // Pass 1: (-1,0), (-1,-1), (0,-1), (1,-1)
    for z in 0..g.w {
        for x in 0..g.w {
            let (first, count) = scratch.cells[g.idx(x, z)];
            for k in first..first + count as u32 {
                let mut d = scratch.dist[k as usize] as i32;
                if let Some((ax, az, a)) = nb(&scratch.cells, &scratch.cspans, x, z, k, 0) {
                    d = d.min(scratch.dist[a as usize] as i32 + 2);
                    if let Some((_, _, aa)) = nb(&scratch.cells, &scratch.cspans, ax, az, a, 3) {
                        d = d.min(scratch.dist[aa as usize] as i32 + 3);
                    }
                }
                if let Some((ax, az, a)) = nb(&scratch.cells, &scratch.cspans, x, z, k, 3) {
                    d = d.min(scratch.dist[a as usize] as i32 + 2);
                    if let Some((_, _, aa)) = nb(&scratch.cells, &scratch.cspans, ax, az, a, 2) {
                        d = d.min(scratch.dist[aa as usize] as i32 + 3);
                    }
                }
                scratch.dist[k as usize] = d.min(255) as u8;
            }
        }
    }
    // Pass 2: (1,0), (1,1), (0,1), (-1,1)
    for z in (0..g.w).rev() {
        for x in (0..g.w).rev() {
            let (first, count) = scratch.cells[g.idx(x, z)];
            for k in first..first + count as u32 {
                let mut d = scratch.dist[k as usize] as i32;
                if let Some((ax, az, a)) = nb(&scratch.cells, &scratch.cspans, x, z, k, 2) {
                    d = d.min(scratch.dist[a as usize] as i32 + 2);
                    if let Some((_, _, aa)) = nb(&scratch.cells, &scratch.cspans, ax, az, a, 1) {
                        d = d.min(scratch.dist[aa as usize] as i32 + 3);
                    }
                }
                if let Some((ax, az, a)) = nb(&scratch.cells, &scratch.cspans, x, z, k, 1) {
                    d = d.min(scratch.dist[a as usize] as i32 + 2);
                    if let Some((_, _, aa)) = nb(&scratch.cells, &scratch.cspans, ax, az, a, 0) {
                        d = d.min(scratch.dist[aa as usize] as i32 + 3);
                    }
                }
                scratch.dist[k as usize] = d.min(255) as u8;
            }
        }
    }
    let r2 = ((s.agent_radius / s.cell_size).ceil() as i32 * 2).min(255);
    for k in 0..ns {
        if (scratch.dist[k] as i32) < r2 {
            scratch.walk[k] = false;
        }
    }

    // 5. Rectangle partition of the core cells.
    let (c0, c1) = (g.border, g.border + g.tile);
    scratch.rect_of.clear();
    scratch.rect_of.resize(ns, NONE);
    scratch.rects.clear();
    let flat = (s.flatness / s.cell_height).max(0.5);
    let max_rect = if s.max_poly_cells == 0 { i32::MAX } else { s.max_poly_cells as i32 };
    for z in c0..c1 {
        for x in c0..c1 {
            let (first, count) = scratch.cells[g.idx(x, z)];
            for k in first..first + count as u32 {
                if !scratch.walk[k as usize] || scratch.rect_of[k as usize] != NONE {
                    continue;
                }
                let rect_id = scratch.rects.len() as u32;
                // Grow along +x.
                scratch.row.clear();
                scratch.row.push(k);
                let mut x1 = x;
                while x1 + 1 < c1 && x1 + 1 - x < max_rect {
                    let last = *scratch.row.last().unwrap();
                    let Some((_, _, nk)) = nb(&scratch.cells, &scratch.cspans, x1, z, last, 2) else { break };
                    if !scratch.walk[nk as usize] || scratch.rect_of[nk as usize] != NONE {
                        break;
                    }
                    // Linear along the row.
                    if scratch.row.len() >= 2 {
                        let y0 = scratch.cspans[scratch.row[0] as usize].y as f32;
                        let y1 = scratch.cspans[last as usize].y as f32;
                        let yn = scratch.cspans[nk as usize].y as f32;
                        let n1 = (scratch.row.len() - 1) as f32;
                        // Predicted next from the row so far.
                        let pred = y1 + (y1 - y0) / n1;
                        if (yn - pred).abs() > flat {
                            break;
                        }
                    }
                    scratch.row.push(nk);
                    x1 += 1;
                }
                for &rk in &scratch.row {
                    scratch.rect_of[rk as usize] = rect_id;
                }
                let first_row: Vec<u32> = scratch.row.clone();
                let mut prev_row = first_row.clone();
                let mut z1 = z;
                // Grow along +z, a full row at a time.
                'grow: while z1 + 1 < c1 && z1 + 1 - z < max_rect {
                    let mut new_row: Vec<u32> = Vec::with_capacity(prev_row.len());
                    for (i, &pk) in prev_row.iter().enumerate() {
                        let px = x + i as i32;
                        let Some((_, _, nk)) = nb(&scratch.cells, &scratch.cspans, px, z1, pk, 1) else { break 'grow };
                        if !scratch.walk[nk as usize] || scratch.rect_of[nk as usize] != NONE {
                            break 'grow;
                        }
                        if i > 0 {
                            // Horizontally connected to the previous cell of the new row.
                            let prev_new = new_row[i - 1];
                            match nb(&scratch.cells, &scratch.cspans, px - 1, z1 + 1, prev_new, 2) {
                                Some((_, _, hk)) if hk == nk => {}
                                _ => break 'grow,
                            }
                        }
                        new_row.push(nk);
                    }
                    // Planarity: the new row continues the column slopes of the rect so far.
                    let rows = (z1 - z) as f32;
                    for i in 0..new_row.len() {
                        let yn = scratch.cspans[new_row[i] as usize].y as f32;
                        let yp = scratch.cspans[prev_row[i] as usize].y as f32;
                        let pred = if rows >= 1.0 {
                            let y0 = scratch.cspans[first_row[i] as usize].y as f32;
                            yp + (yp - y0) / rows
                        } else {
                            // Second row: continue the slope of the first column.
                            let y00 = scratch.cspans[first_row[0] as usize].y as f32;
                            let yn0 = scratch.cspans[new_row[0] as usize].y as f32;
                            yp + (yn0 - y00)
                        };
                        if (yn - pred).abs() > flat {
                            break 'grow;
                        }
                    }
                    for &nk in &new_row {
                        scratch.rect_of[nk as usize] = rect_id;
                    }
                    prev_row = new_row;
                    z1 += 1;
                }
                scratch.rects.push(Rect {
                    x0: x,
                    z0: z,
                    x1,
                    z1,
                    corners: [first_row[0], *first_row.last().unwrap(), prev_row[0], *prev_row.last().unwrap()],
                });
            }
        }
    }
    // Count all walkable core cells for stats.
    stats.walkable_cells = scratch.rect_of.iter().filter(|&&r| r != NONE).count() as u32;
    if scratch.rects.is_empty() {
        stats.micros = t0.elapsed().as_micros() as u32;
        return (None, stats);
    }

    // Polys with corner heights extrapolated from the corner cells' centres to the edges.
    let wmin = g.world_min();
    let yw = |k: u32| g.origin_y + scratch.cspans[k as usize].y as f32 * g.ch;
    let mut polys: Vec<Poly> = Vec::with_capacity(scratch.rects.len());
    for r in &scratch.rects {
        let [k00, k10, k01, k11] = r.corners;
        let (h00, h10, h01, h11) = (yw(k00), yw(k10), yw(k01), yw(k11));
        let nx = (r.x1 - r.x0) as f32;
        let nz = (r.z1 - r.z0) as f32;
        let bil = |u: f32, v: f32| {
            let (u, v) = (if nx > 0.0 { u / nx } else { 0.0 }, if nz > 0.0 { v / nz } else { 0.0 });
            let a = h00 + (h10 - h00) * u;
            let b = h01 + (h11 - h01) * u;
            a + (b - a) * v
        };
        let (ua, ub) = (if nx > 0.0 { -0.5 } else { 0.0 }, if nx > 0.0 { nx + 0.5 } else { 0.0 });
        let (va, vb) = (if nz > 0.0 { -0.5 } else { 0.0 }, if nz > 0.0 { nz + 0.5 } else { 0.0 });
        let mut border = 0u8;
        if r.x0 == c0 {
            border |= 1;
        }
        if r.x1 == c1 - 1 {
            border |= 2;
        }
        if r.z0 == c0 {
            border |= 4;
        }
        if r.z1 == c1 - 1 {
            border |= 8;
        }
        polys.push(Poly {
            min: wmin + Vec2::new(r.x0 as f32, r.z0 as f32) * g.cs,
            max: wmin + Vec2::new((r.x1 + 1) as f32, (r.z1 + 1) as f32) * g.cs,
            h: [bil(ua, va), bil(ub, va), bil(ua, vb), bil(ub, vb)],
            first_link: 0,
            link_count: 0,
            border,
        });
    }

    // Internal links: runs of side cells whose neighbour across belongs to another rect.
    let mut links: Vec<Link> = Vec::new();
    for (ri, r) in scratch.rects.iter().enumerate() {
        let first = links.len() as u32;
        // (dir, cells along the side as (x, z))
        for d in 0..4usize {
            let along: Vec<(i32, i32)> = match d {
                0 => (r.z0..=r.z1).map(|z| (r.x0, z)).collect(),
                2 => (r.z0..=r.z1).map(|z| (r.x1, z)).collect(),
                3 => (r.x0..=r.x1).map(|x| (x, r.z0)).collect(),
                _ => (r.x0..=r.x1).map(|x| (x, r.z1)).collect(),
            };
            let mut run: Option<(u32, usize, usize)> = None; // (neighbour rect, start, end) indices into `along`
            let flush = |run: Option<(u32, usize, usize)>, links: &mut Vec<Link>| {
                let Some((nr, a, b)) = run else { return };
                let (xa, za) = along[a];
                let (xb, zb) = along[b];
                let p = &polys[ri];
                let (pa, pb) = match d {
                    0 => (Vec2::new(p.min.x, wmin.y + za as f32 * g.cs), Vec2::new(p.min.x, wmin.y + (zb + 1) as f32 * g.cs)),
                    2 => (Vec2::new(p.max.x, wmin.y + za as f32 * g.cs), Vec2::new(p.max.x, wmin.y + (zb + 1) as f32 * g.cs)),
                    3 => (Vec2::new(wmin.x + xa as f32 * g.cs, p.min.y), Vec2::new(wmin.x + (xb + 1) as f32 * g.cs, p.min.y)),
                    _ => (Vec2::new(wmin.x + xa as f32 * g.cs, p.max.y), Vec2::new(wmin.x + (xb + 1) as f32 * g.cs, p.max.y)),
                };
                let q = &polys[nr as usize];
                let ya = p.height_at(pa.x, pa.y).max(q.height_at(pa.x, pa.y));
                let yb = p.height_at(pb.x, pb.y).max(q.height_at(pb.x, pb.y));
                links.push(Link {
                    to: PolyRef { slot: 0, poly: nr as u16, salt: 0 },
                    a: Vec3::new(pa.x, ya, pa.y),
                    b: Vec3::new(pb.x, yb, pb.y),
                    offmesh: None,
                });
            };
            for (i, &(cx, cz)) in along.iter().enumerate() {
                let k = span_of(&scratch.cells, &scratch.rect_of, &g, cx, cz, ri as u32);
                let other = k.and_then(|k| nb(&scratch.cells, &scratch.cspans, cx, cz, k, d)).and_then(|(nx, nz, nk)| {
                    let inside = nx >= c0 && nx < c1 && nz >= c0 && nz < c1;
                    let o = scratch.rect_of[nk as usize];
                    (inside && o != NONE && o != ri as u32).then_some(o)
                });
                match (run, other) {
                    (Some((nr, a, _)), Some(o)) if nr == o => run = Some((nr, a, i)),
                    (_, Some(o)) => {
                        flush(run, &mut links);
                        run = Some((o, i, i));
                    }
                    (_, None) => {
                        flush(run, &mut links);
                        run = None;
                    }
                }
            }
            flush(run, &mut links);
        }
        polys[ri].first_link = first;
        polys[ri].link_count = (links.len() as u32 - first) as u16;
    }
    stats.polys = polys.len() as u32;
    stats.micros = t0.elapsed().as_micros() as u32;
    (Some(NavTile { coord, polys, links, ..Default::default() }), stats)
}

/// The compact span of cell `(x, z)` that belongs to rect `r`.
fn span_of(cells: &[(u32, u8)], rect_of: &[u32], g: &TileGrid, x: i32, z: i32, r: u32) -> Option<u32> {
    let (first, count) = cells[g.idx(x, z)];
    (first..first + count as u32).find(|&k| rect_of[k as usize] == r)
}

/// Clips polygon `src` by the axis plane `axis = at`: the part with `v[axis] <= at` goes to
/// `below`, the rest to `above` (Sutherland–Hodgman, both halves at once).
fn divide_poly(src: &[[f32; 3]], below: &mut Vec<[f32; 3]>, above: &mut Vec<[f32; 3]>, at: f32, axis: usize) {
    below.clear();
    above.clear();
    let n = src.len();
    if n == 0 {
        return;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (src[j], src[i]);
        let da = at - a[axis];
        let db = at - b[axis];
        if (da >= 0.0) != (db >= 0.0) {
            let s = da / (da - db);
            let p = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
            below.push(p);
            above.push(p);
        }
        if db >= 0.0 {
            below.push(b);
        }
        if db <= 0.0 {
            above.push(b);
        }
        j = i;
    }
}

fn rasterize_tri(g: &TileGrid, t: [Vec3; 3], walkable: bool, climb: i32, sc: &mut BakeScratch) {
    let wmin = g.world_min();
    let size = g.w as f32 * g.cs;
    let tmin = t[0].min(t[1]).min(t[2]);
    let tmax = t[0].max(t[1]).max(t[2]);
    if tmax.x < wmin.x || tmin.x > wmin.x + size || tmax.z < wmin.y || tmin.z > wmin.y + size {
        return;
    }
    let ics = 1.0 / g.cs;
    let ich = 1.0 / g.ch;
    let z0 = (((tmin.z - wmin.y) * ics).floor() as i32).clamp(0, g.w - 1);
    let z1 = (((tmax.z - wmin.y) * ics).floor() as i32).clamp(0, g.w - 1);
    let mut buf = std::mem::take(&mut sc.poly_buf);
    let mut row = std::mem::take(&mut sc.tmp_a);
    let mut rest = std::mem::take(&mut sc.tmp_b);
    let mut cell = std::mem::take(&mut sc.tmp_c);
    let mut cell_rest = std::mem::take(&mut sc.tmp_d);
    let mut r = std::mem::take(&mut sc.tmp_e);
    buf.clear();
    buf.extend(t.iter().map(|v| [v.x, v.y, v.z]));
    for z in z0..=z1 {
        let cz = wmin.y + (z + 1) as f32 * g.cs;
        divide_poly(&buf, &mut row, &mut rest, cz, 2);
        std::mem::swap(&mut buf, &mut rest);
        if row.len() < 3 {
            continue;
        }
        let mut minx = row[0][0];
        let mut maxx = row[0][0];
        for v in &row[1..] {
            minx = minx.min(v[0]);
            maxx = maxx.max(v[0]);
        }
        let x0 = (((minx - wmin.x) * ics).floor() as i32).max(0);
        let x1 = (((maxx - wmin.x) * ics).floor() as i32).min(g.w - 1);
        if x1 < x0 {
            continue;
        }
        r.clear();
        r.extend_from_slice(&row);
        for x in x0..=x1 {
            let cx = wmin.x + (x + 1) as f32 * g.cs;
            divide_poly(&r, &mut cell, &mut cell_rest, cx, 0);
            std::mem::swap(&mut r, &mut cell_rest);
            if cell.len() < 3 {
                continue;
            }
            let mut ymin = cell[0][1];
            let mut ymax = cell[0][1];
            for v in &cell[1..] {
                ymin = ymin.min(v[1]);
                ymax = ymax.max(v[1]);
            }
            let ymin = ymin - g.origin_y;
            let ymax = ymax - g.origin_y;
            if ymax < 0.0 {
                continue;
            }
            let smin = ((ymin * ich).floor() as i32).clamp(0, u16::MAX as i32 - 1);
            let smax = ((ymax * ich).ceil() as i32).clamp(smin + 1, u16::MAX as i32 - 1);
            add_span(sc, g.idx(x, z), smin as u16, smax as u16, walkable, climb);
        }
    }
    sc.poly_buf = buf;
    sc.tmp_a = row;
    sc.tmp_b = rest;
    sc.tmp_c = cell;
    sc.tmp_d = cell_rest;
    sc.tmp_e = r;
}

fn add_span(sc: &mut BakeScratch, col: usize, mut min: u16, mut max: u16, mut walkable: bool, merge: i32) {
    let mut prev = NONE;
    let mut cur = sc.heads[col];
    while cur != NONE {
        let c = sc.spans[cur as usize];
        if c.min > max {
            break;
        }
        if c.max < min {
            prev = cur;
            cur = c.next;
            continue;
        }
        if c.min < min {
            min = c.min;
        }
        if c.max > max {
            max = c.max;
        }
        if (max as i32 - c.max as i32).abs() <= merge {
            walkable |= c.walkable;
        }
        let next = c.next;
        if prev == NONE {
            sc.heads[col] = next;
        } else {
            sc.spans[prev as usize].next = next;
        }
        cur = next;
    }
    let idx = sc.spans.len() as u32;
    let next = if prev == NONE { sc.heads[col] } else { sc.spans[prev as usize].next };
    sc.spans.push(Span { min, max, walkable, next });
    if prev == NONE {
        sc.heads[col] = idx;
    } else {
        sc.spans[prev as usize].next = idx;
    }
}

/// Result of baking a set of tiles.
#[derive(Default, Debug)]
pub struct BakeOutput {
    pub tiles: Vec<NavTile>,
    /// Tiles that came out empty (remove them from the mesh).
    pub empty: Vec<(i32, i32)>,
    pub stats: BakeStats,
}

/// Totals over a bake.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct BakeStats {
    pub tiles: u32,
    pub triangles: u32,
    pub polys: u32,
    pub walkable_cells: u32,
    /// Sum of per-tile bake time (CPU µs over all threads).
    pub cpu_us: u64,
    /// Wall time of the bake job (µs).
    pub wall_us: u64,
}

/// Bakes `coords` from `geom` on the calling thread.
pub fn bake_tiles(s: &NavMeshSettings, origin_y: f32, geom: &NavGeometry, coords: &[(i32, i32)]) -> BakeOutput {
    let t0 = Instant::now();
    let mut out = BakeOutput::default();
    let mut scratch = BakeScratch::default();
    let mut tris = Vec::new();
    for &c in coords {
        geom.tris_for_tile(s, c, &mut tris);
        let (tile, st) = bake_tile(s, origin_y, c, geom, &tris, &mut scratch);
        out.stats.tiles += 1;
        out.stats.triangles += st.triangles;
        out.stats.polys += st.polys;
        out.stats.walkable_cells += st.walkable_cells;
        out.stats.cpu_us += st.micros as u64;
        match tile {
            Some(t) => out.tiles.push(t),
            None => out.empty.push(c),
        }
    }
    out.stats.wall_us = t0.elapsed().as_micros() as u64;
    out
}

/// Bakes a whole mesh from `geom` on the calling thread (every tile the geometry touches).
pub fn bake_mesh(s: &NavMeshSettings, geom: &mut NavGeometry) -> (NavMesh, BakeStats) {
    geom.build_index(s);
    let origin_y = geom.origin_y();
    let coords = geom.tile_coords(s);
    let out = bake_tiles(s, origin_y, geom, &coords);
    let mut mesh = NavMesh::new(s.clone(), origin_y);
    let stats = out.stats;
    mesh.insert_tiles(out.tiles, &[]);
    (mesh, stats)
}
