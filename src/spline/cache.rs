//! Arc-length table and nearest-point grid, rebuilt when the `Spline` changes.

use bevy::prelude::*;

use super::{Spline, SplineChanged, SplineSample};

/// Longest gap between table vertices, in metres (each segment gets at least 4 vertices).
const MAX_STEP: f32 = 2.0;
/// Grid cells per axis, at most.
const GRID_MAX: usize = 256;
const GRID_MIN_CELL: f32 = 8.0;

/// Derived from [`Spline`], never saved: a polyline of the curve with cumulative distances, and a
/// grid over it for [`nearest`](Self::nearest). Rebuilt in `PostUpdate` when the spline changes.
/// Query it with the entity's own `Spline`; a stale pair never panics, it just answers from the
/// old table.
#[derive(Component, Clone, Debug, Default)]
pub struct SplineCache {
    /// Curve parameter at each vertex.
    s: Vec<f32>,
    /// Distance along the curve at each vertex.
    d: Vec<f32>,
    pts: Vec<Vec3>,
    grid: Grid,
}

#[derive(Clone, Debug, Default)]
struct Grid {
    min: Vec2,
    cell: f32,
    nx: usize,
    ny: usize,
    /// CSR: `items[start[c]..start[c + 1]]` are the polyline pieces touching cell `c`.
    start: Vec<u32>,
    items: Vec<u32>,
}

impl SplineCache {
    /// Builds the table for `spline`.
    pub fn build(spline: &Spline) -> Self {
        let segs = spline.segment_count();
        let mut c = SplineCache::default();
        if spline.points.is_empty() {
            return c;
        }
        if segs == 0 {
            c.s.push(0.0);
            c.d.push(0.0);
            c.pts.push(spline.points[0].pos);
            return c;
        }
        let n = spline.points.len();
        let mut dist = 0.0;
        for seg in 0..segs {
            let chord = spline.points[seg].pos.distance(spline.points[(seg + 1) % n].pos);
            let k = ((chord / MAX_STEP).ceil() as usize).clamp(4, 64);
            for i in 0..k {
                let s = seg as f32 + i as f32 / k as f32;
                let p = spline.pos_at(s);
                if let Some(&prev) = c.pts.last() {
                    dist += prev.distance(p);
                }
                c.s.push(s);
                c.d.push(dist);
                c.pts.push(p);
            }
        }
        let end = spline.pos_at(segs as f32);
        dist += c.pts.last().map_or(0.0, |p| p.distance(end));
        c.s.push(segs as f32);
        c.d.push(dist);
        c.pts.push(end);
        c.grid = Grid::build(&c.pts);
        c
    }

    /// Total length in metres (0 for fewer than 2 points).
    pub fn length(&self) -> f32 {
        self.d.last().copied().unwrap_or(0.0)
    }

    /// The table's polyline (local space), for drawing and cheap approximations.
    pub fn polyline(&self) -> &[Vec3] {
        &self.pts
    }

    /// Sample `distance` metres along the curve. Open splines clamp to the ends, closed ones
    /// wrap. `None` only for a spline without points.
    pub fn sample_at(&self, spline: &Spline, distance: f32) -> Option<SplineSample> {
        let len = self.length();
        if self.pts.len() < 2 || len <= 0.0 {
            return spline.sample_s(0.0);
        }
        let d = if !distance.is_finite() {
            0.0
        } else if spline.is_loop() {
            distance.rem_euclid(len)
        } else {
            distance.clamp(0.0, len)
        };
        let hi = self.d.partition_point(|&x| x <= d).clamp(1, self.d.len() - 1);
        let (d0, d1) = (self.d[hi - 1], self.d[hi]);
        let f = if d1 > d0 { (d - d0) / (d1 - d0) } else { 0.0 };
        spline.sample_s(self.s[hi - 1] + (self.s[hi] - self.s[hi - 1]) * f)
    }

    /// Distance along the curve at curve parameter `s` (segment index + fraction).
    pub fn distance_of_param(&self, s: f32) -> f32 {
        if self.s.len() < 2 {
            return 0.0;
        }
        let hi = self.s.partition_point(|&x| x <= s).clamp(1, self.s.len() - 1);
        let (s0, s1) = (self.s[hi - 1], self.s[hi]);
        let f = if s1 > s0 { ((s - s0) / (s1 - s0)).clamp(0.0, 1.0) } else { 0.0 };
        self.d[hi - 1] + (self.d[hi] - self.d[hi - 1]) * f
    }

    /// Samples every `step` metres from the start (open splines also yield the end point; closed
    /// ones stop before repeating the start).
    pub fn samples<'a>(&'a self, spline: &'a Spline, step: f32) -> SplineSamples<'a> {
        let len = self.length();
        let step = if step.is_finite() { step.max(len / 1.0e6).max(1.0e-4) } else { 1.0 };
        let (full, end) = if spline.is_loop() {
            ((len / step - 1.0e-4).ceil().max(1.0) as usize, false)
        } else {
            let full = (len / step + 1.0e-4).floor() as usize + 1;
            (full, (full - 1) as f32 * step < len - 1.0e-3)
        };
        SplineSamples { cache: self, spline, step, full, total: full + end as usize, i: 0 }
    }

    /// Closest point on the curve to `p` (local space): distance along, the sample there, and the
    /// straight-line distance. Cost is independent of spline length for nearby queries. `None`
    /// for a spline without points.
    pub fn nearest(&self, spline: &Spline, p: Vec3) -> Option<(f32, SplineSample, f32)> {
        if self.pts.len() < 2 {
            let s = spline.sample_s(0.0)?;
            return Some((0.0, s, s.pos.distance(p)));
        }
        let (piece, f) = self.grid.nearest(&self.pts, p)?;
        let (d0, d1) = (self.d[piece], self.d[piece + 1]);
        let along = d0 + (d1 - d0) * f;
        let s = self.sample_at(spline, along)?;
        Some((along, s, s.pos.distance(p)))
    }
}

/// Iterator from [`SplineCache::samples`].
pub struct SplineSamples<'a> {
    cache: &'a SplineCache,
    spline: &'a Spline,
    step: f32,
    full: usize,
    total: usize,
    i: usize,
}

impl Iterator for SplineSamples<'_> {
    type Item = SplineSample;
    fn next(&mut self) -> Option<SplineSample> {
        if self.i >= self.total {
            return None;
        }
        let d = if self.i < self.full { self.i as f32 * self.step } else { self.cache.length() };
        self.i += 1;
        self.cache.sample_at(self.spline, d)
    }
    fn size_hint(&self) -> (usize, Option<usize>) {
        let n = self.total - self.i.min(self.total);
        (n, Some(n))
    }
}

/// Closest point from `p` to segment `a`-`b`: parameter 0..1 and squared distance.
#[inline]
fn closest(a: Vec3, b: Vec3, p: Vec3) -> (f32, f32) {
    let ab = b - a;
    let l2 = ab.length_squared();
    let f = if l2 > 1e-12 { ((p - a).dot(ab) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (f, (a + ab * f - p).length_squared())
}

impl Grid {
    fn build(pts: &[Vec3]) -> Grid {
        let (mut lo, mut hi) = (Vec2::splat(f32::MAX), Vec2::splat(f32::MIN));
        for p in pts {
            let v = Vec2::new(p.x, p.z);
            lo = lo.min(v);
            hi = hi.max(v);
        }
        let ext = (hi - lo).max_element();
        let cell = (ext / GRID_MAX as f32).max(GRID_MIN_CELL);
        let nx = (((hi.x - lo.x) / cell) as usize + 1).min(GRID_MAX);
        let ny = (((hi.y - lo.y) / cell) as usize + 1).min(GRID_MAX);
        let mut g = Grid { min: lo, cell, nx, ny, start: vec![0; nx * ny + 1], items: Vec::new() };
        let range = |g: &Grid, a: Vec3, b: Vec3| {
            let (x0, y0) = g.cell_of(a.x.min(b.x), a.z.min(b.z));
            let (x1, y1) = g.cell_of(a.x.max(b.x), a.z.max(b.z));
            (x0, y0, x1, y1)
        };
        for i in 0..pts.len() - 1 {
            let (x0, y0, x1, y1) = range(&g, pts[i], pts[i + 1]);
            for y in y0..=y1 {
                for x in x0..=x1 {
                    g.start[y * nx + x + 1] += 1;
                }
            }
        }
        for c in 0..nx * ny {
            g.start[c + 1] += g.start[c];
        }
        g.items = vec![0; g.start[nx * ny] as usize];
        let mut fill = g.start.clone();
        for i in 0..pts.len() - 1 {
            let (x0, y0, x1, y1) = range(&g, pts[i], pts[i + 1]);
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let c = y * nx + x;
                    g.items[fill[c] as usize] = i as u32;
                    fill[c] += 1;
                }
            }
        }
        g
    }

    #[inline]
    fn cell_of(&self, x: f32, z: f32) -> (usize, usize) {
        let cx = ((x - self.min.x) / self.cell).max(0.0) as usize;
        let cy = ((z - self.min.y) / self.cell).max(0.0) as usize;
        (cx.min(self.nx - 1), cy.min(self.ny - 1))
    }

    /// (polyline piece index, fraction along it) closest to `p`.
    fn nearest(&self, pts: &[Vec3], p: Vec3) -> Option<(usize, f32)> {
        if self.nx == 0 || pts.len() < 2 {
            return None;
        }
        let (cx, cy) = self.cell_of(p.x, p.z);
        let mut best = (usize::MAX, 0.0f32, f32::MAX);
        let scan = |g: &Grid, x: usize, y: usize, best: &mut (usize, f32, f32)| {
            let c = y * g.nx + x;
            for &i in &g.items[g.start[c] as usize..g.start[c + 1] as usize] {
                let i = i as usize;
                let (f, d2) = closest(pts[i], pts[i + 1], p);
                if d2 < best.2 {
                    *best = (i, f, d2);
                }
            }
        };
        let max_r = self.nx.max(self.ny);
        for r in 0..=max_r {
            let (x0, x1) = (cx as isize - r as isize, cx as isize + r as isize);
            let (y0, y1) = (cy as isize - r as isize, cy as isize + r as isize);
            let (xa, xb) = (x0.max(0) as usize, x1.min(self.nx as isize - 1) as usize);
            if r == 0 {
                scan(self, cx, cy, &mut best);
            } else {
                if y0 >= 0 {
                    for x in xa..=xb {
                        scan(self, x, y0 as usize, &mut best);
                    }
                }
                if y1 < self.ny as isize {
                    for x in xa..=xb {
                        scan(self, x, y1 as usize, &mut best);
                    }
                }
                let (ya, yb) = ((y0 + 1).max(0) as usize, (y1 - 1).min(self.ny as isize - 1));
                if yb >= 0 {
                    for y in ya..=yb as usize {
                        if x0 >= 0 {
                            scan(self, x0 as usize, y, &mut best);
                        }
                        if x1 < self.nx as isize {
                            scan(self, x1 as usize, y, &mut best);
                        }
                    }
                }
            }
            // Everything unseen is at least `r` whole cells away in the ground plane.
            let reach = r as f32 * self.cell;
            if best.0 != usize::MAX && best.2 <= reach * reach {
                break;
            }
        }
        (best.0 != usize::MAX).then_some((best.0, best.1))
    }
}

/// Makes sure every spline has a cache component.
pub(crate) fn ensure_caches(mut commands: Commands, q: Query<Entity, (With<Spline>, Without<SplineCache>)>) {
    for e in &q {
        commands.entity(e).insert(SplineCache::default());
    }
}

/// Rebuilds changed splines' caches and announces them.
pub(crate) fn rebuild_caches(mut q: Query<(Entity, &Spline, &mut SplineCache), Changed<Spline>>, mut out: MessageWriter<SplineChanged>) {
    for (entity, spline, mut cache) in &mut q {
        *cache = SplineCache::build(spline);
        out.write(SplineChanged { entity });
    }
}

/// Squared distance from `p` to segment `a`-`b` (for tests).
#[cfg(test)]
pub(crate) fn tests_closest(a: Vec3, b: Vec3, p: Vec3) -> f32 {
    closest(a, b, p).1
}
