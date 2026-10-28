//! Evaluation: runs a graph over an area and returns what to spawn and what to hand back.
//!
//! Results inside an area never depend on where the area's edges are (or what order cells run
//! in): samplers sit on world-anchored grids, every random choice hashes the point's world
//! position, pruning only looks at neighbours within its radius, and each area is evaluated
//! with a halo of [`Graph::halo`] around it, then clipped.

use std::collections::{BTreeMap, HashMap, HashSet};

use glam::{IVec2, Quat, Vec2, Vec3};

use crate::graph::{Graph, Op, PcgError, Side, SpawnDef, Tier};
use crate::points::{Area, Inputs, Point, PointSet, Rect, mix64, seed_at, str_hash, tag_id, unit};

/// What a spawn node produced in the area.
#[derive(Clone, Debug, PartialEq)]
pub struct Spawned {
    pub node: String,
    pub def: SpawnDef,
    pub points: PointSet,
    /// Per point: index into `def.items`.
    pub item: Vec<u16>,
}

/// Everything an evaluation produced.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Output {
    pub spawns: Vec<Spawned>,
    /// `Emit` ports.
    pub emits: BTreeMap<String, PointSet>,
    /// Points each node produced (inside the halo-grown area), in node order: for inspection.
    pub counts: Vec<(String, usize)>,
}

impl Output {
    /// Spawned points of all spawn nodes, total.
    pub fn spawned(&self) -> usize {
        self.spawns.iter().map(|s| s.points.len()).sum()
    }
}

/// Whether a point survives at this quality. `normal` / `fine`: the fraction of `Normal` /
/// `Fine` points kept (1 = all). A point kept at a lower fraction is kept at every higher one,
/// so lower quality is always a subset.
pub fn keep_for_tier(seed: u64, tier: Tier, normal: f32, fine: f32) -> bool {
    let f = match tier {
        Tier::Essential => return true,
        Tier::Normal => normal,
        Tier::Fine => fine,
    };
    f >= 1.0 || unit(mix64(seed ^ 0x7e57_7e57_7e57_7e57)) < f
}

struct Val {
    points: PointSet,
    /// Set for `Input` nodes: the shapes samplers read.
    input: Option<String>,
}

/// Runs `g` over `area` (`None`: everywhere). Output points lie inside `area`.
pub fn evaluate(g: &Graph, inputs: &Inputs, area: Option<Area>) -> Result<Output, PcgError> {
    let order = g.order()?;
    let clip = area.unwrap_or(Area::ALL);
    let work = if clip.is_finite() { clip.expand(g.halo(inputs)) } else { Area::ALL };
    let mut vals: HashMap<&str, Val> = HashMap::new();
    let mut out = Output::default();
    for i in order {
        let n = &g.nodes[i];
        let nseed = n.seed.unwrap_or_else(|| str_hash(&n.id));
        let e = |msg: &str| PcgError { node: n.id.clone(), msg: msg.into() };
        let first = n.inputs.first().and_then(|id| vals.get(id.as_str()));
        let shapes = || -> Result<&crate::Shapes, PcgError> {
            let name = first.and_then(|v| v.input.as_ref()).ok_or_else(|| e("samplers read shapes: their input must be an Input node"))?;
            inputs.sets.get(name).ok_or_else(|| e(&format!("no input set `{name}`")))
        };
        let pts = || first.map(|v| &v.points);
        let points: PointSet = match &n.op {
            Op::Input { name } => {
                let p = inputs.sets.get(name).map(|s| s.points.retain(|i| work.contains(xz(s.points.pos[i])))).unwrap_or_default();
                vals.insert(&n.id, Val { points: p.clone(), input: Some(name.clone()) });
                out.counts.push((n.id.clone(), p.len()));
                continue;
            }
            Op::GridSample { spacing, jitter } => grid(&shapes()?.rects, *spacing, *jitter, work, g.seed, nseed),
            Op::PoissonSample { radius } => poisson(&shapes()?.rects, *radius, work, g.seed, nseed),
            Op::EdgeSample { spacing, offset, side } => edges(shapes()?, *spacing, *offset, *side, work, g.seed, nseed),
            Op::RectFill => rect_fill(&shapes()?.rects, work, g.seed, nseed),
            Op::DensityNoise { scale, octaves, lo, hi } => {
                let mut p = pts().cloned().unwrap_or_default();
                for k in 0..p.len() {
                    let v = fbm(xz(p.pos[k]) / *scale, (*octaves).max(1), g.seed ^ nseed);
                    p.density[k] *= ((v - lo) / (hi - lo).max(1e-6)).clamp(0.0, 1.0);
                }
                p
            }
            Op::DensityFilter { lo, hi } => {
                let p = pts().ok_or_else(|| e("no input"))?;
                p.retain(|k| p.density[k] >= *lo && p.density[k] <= *hi)
            }
            Op::Keep { fraction } => {
                let p = pts().ok_or_else(|| e("no input"))?;
                p.retain(|k| unit(mix64(p.seed[k] ^ nseed)) < p.density[k] * fraction)
            }
            Op::Difference { against, pad } | Op::Intersect { with: against, pad } => {
                let p = pts().ok_or_else(|| e("no input"))?;
                let other = vals.get(against.as_str()).ok_or_else(|| e("missing input"))?;
                let rects = other.input.as_ref().and_then(|name| inputs.sets.get(name)).map(|s| &s.rects[..]).unwrap_or(&[]);
                let inside = |q: Vec3| rects.iter().any(|r| r.contains(xz(q), *pad)) || in_points(&other.points, q, *pad);
                let keep_inside = matches!(n.op, Op::Intersect { .. });
                p.retain(|k| inside(p.pos[k]) == keep_inside)
            }
            Op::SelfPrune { radius } => {
                let p = pts().ok_or_else(|| e("no input"))?;
                let prio: Vec<(f32, u64)> = (0..p.len()).map(|k| (p.density[k], mix64(p.seed[k]))).collect();
                let keep = prune(&p.pos, *radius, |a, b| prio[a].0.total_cmp(&prio[b].0).then(prio[a].1.cmp(&prio[b].1)));
                p.retain(|k| keep[k])
            }
            Op::ByTag { tags, keep } => {
                let p = pts().ok_or_else(|| e("no input"))?;
                let ids: HashSet<u32> = tags.iter().map(|t| tag_id(t)).collect();
                p.retain(|k| ids.contains(&p.tag[k]) == *keep)
            }
            Op::Transform { offset, yaw, scale, jitter } => {
                let mut p = pts().cloned().unwrap_or_default();
                for k in 0..p.len() {
                    let h = mix64(p.seed[k] ^ nseed);
                    let a = (yaw.0 + (yaw.1 - yaw.0) * unit(h)).to_radians();
                    let s = scale.0 + (scale.1 - scale.0) * unit(mix64(h ^ 1));
                    let j = Vec3::new(unit(mix64(h ^ 2)) - 0.5, 0.0, unit(mix64(h ^ 3)) - 0.5) * (2.0 * jitter);
                    p.pos[k] += p.rot[k] * *offset + j;
                    p.rot[k] *= Quat::from_rotation_y(a);
                    p.scale[k] *= s;
                }
                p
            }
            Op::Project { offset, align } => {
                let surf = inputs.surface.as_ref().ok_or_else(|| e("Project needs Inputs::surface"))?;
                let mut p = pts().cloned().unwrap_or_default();
                for k in 0..p.len() {
                    let q = xz(p.pos[k]);
                    p.pos[k].y = surf.height(q) + offset;
                    if *align {
                        p.rot[k] = Quat::from_rotation_arc(Vec3::Y, surf.normal(q)) * p.rot[k];
                    }
                }
                p
            }
            Op::Copy => {
                let targets = pts().ok_or_else(|| e("no input"))?;
                let template = n.inputs.get(1).and_then(|id| vals.get(id.as_str())).map(|v| &v.points).ok_or_else(|| e("no template"))?;
                let mut p = PointSet::default();
                for t in 0..targets.len() {
                    let tp = targets.get(t);
                    for c in 0..template.len() {
                        let cp = template.get(c);
                        p.push(Point {
                            pos: tp.pos + tp.rot * (tp.scale * cp.pos),
                            rot: tp.rot * cp.rot,
                            scale: tp.scale * cp.scale,
                            extent: cp.extent,
                            density: tp.density * cp.density,
                            seed: mix64(tp.seed ^ mix64(cp.seed ^ nseed ^ c as u64)),
                            tag: if cp.tag != 0 { cp.tag } else { tp.tag },
                        });
                    }
                }
                p
            }
            Op::Union => {
                let mut p = PointSet::default();
                for id in &n.inputs {
                    if let Some(v) = vals.get(id.as_str()) {
                        p.extend(&v.points);
                    }
                }
                p
            }
            Op::Spawn(def) => {
                let p = pts().ok_or_else(|| e("no input"))?;
                let p = p.retain(|k| clip.contains(xz(p.pos[k])));
                let item = pick(&p, def, nseed);
                out.spawns.push(Spawned { node: n.id.clone(), def: def.clone(), points: p.clone(), item });
                p
            }
            Op::Emit { port } => {
                let p = pts().ok_or_else(|| e("no input"))?;
                let p = p.retain(|k| clip.contains(xz(p.pos[k])));
                out.emits.entry(port.clone()).or_default().extend(&p);
                p
            }
        };
        out.counts.push((n.id.clone(), points.len()));
        vals.insert(&n.id, Val { points, input: None });
    }
    Ok(out)
}

#[inline]
fn xz(p: Vec3) -> Vec2 {
    Vec2::new(p.x, p.z)
}

/// Inside any point's box (XZ, grown by `pad`)?
fn in_points(p: &PointSet, q: Vec3, pad: f32) -> bool {
    (0..p.len()).any(|k| {
        let l = p.rot[k].inverse() * (q - p.pos[k]);
        let e = p.extent[k] * p.scale[k];
        l.x.abs() <= e.x + pad && l.z.abs() <= e.z + pad
    })
}

/// First rect (in input order) containing `q`.
fn first_rect(rects: &[Rect], q: Vec2) -> Option<&Rect> {
    rects.iter().find(|r| r.contains(q, 0.0))
}

fn grid(rects: &[Rect], s: f32, jitter: f32, work: Area, gs: u64, ns: u64) -> PointSet {
    let mut p = PointSet::default();
    let mut seen: HashSet<IVec2> = HashSet::new();
    for r in rects {
        let bb = r.aabb().intersect(work);
        if bb.min.x > bb.max.x || bb.min.y > bb.max.y {
            continue;
        }
        let (i0, i1) = ((bb.min.x / s).floor() as i32 - 1, (bb.max.x / s).ceil() as i32 + 1);
        let (j0, j1) = ((bb.min.y / s).floor() as i32 - 1, (bb.max.y / s).ceil() as i32 + 1);
        for j in j0..=j1 {
            for i in i0..=i1 {
                let key = IVec2::new(i, j);
                if seen.contains(&key) {
                    continue;
                }
                let h = mix64(gs ^ mix64(ns ^ mix64(((i as u64) << 32) ^ (j as u32 as u64))));
                let q = (Vec2::new(i as f32, j as f32) + 0.5 + Vec2::new(unit(h) - 0.5, unit(mix64(h)) - 0.5) * jitter) * s;
                if !work.contains(q) {
                    continue;
                }
                // The first rect containing it owns it (overlaps don't double up).
                let Some(owner) = first_rect(rects, q) else { continue };
                if !std::ptr::eq(owner, r) {
                    continue;
                }
                seen.insert(key);
                let pos = Vec3::new(q.x, r.y, q.y);
                p.push(Point { pos, extent: Vec3::splat(s * 0.5), seed: seed_at(gs, ns, pos), tag: tag_id(&r.tag), ..Default::default() });
            }
        }
    }
    p
}

fn poisson(rects: &[Rect], r: f32, work: Area, gs: u64, ns: u64) -> PointSet {
    // One candidate per cell of a world grid fine enough that no two candidates are closer
    // than they'd be in a Poisson disk set, then the local priority prune.
    let c = r / std::f32::consts::SQRT_2;
    let cand_area = if work.is_finite() { work.expand(r) } else { work };
    let mut cand = PointSet::default();
    for rect in rects {
        let bb = rect.aabb().intersect(cand_area);
        if bb.min.x > bb.max.x || bb.min.y > bb.max.y {
            continue;
        }
        for j in (bb.min.y / c).floor() as i32..=(bb.max.y / c).ceil() as i32 {
            for i in (bb.min.x / c).floor() as i32..=(bb.max.x / c).ceil() as i32 {
                let h = mix64(gs ^ mix64(ns ^ mix64(((i as u64) << 32) ^ (j as u32 as u64))));
                let q = (Vec2::new(i as f32, j as f32) + Vec2::new(unit(h), unit(mix64(h)))) * c;
                if !cand_area.contains(q) {
                    continue;
                }
                let Some(owner) = first_rect(rects, q) else { continue };
                if !std::ptr::eq(owner, rect) {
                    continue;
                }
                let pos = Vec3::new(q.x, rect.y, q.y);
                cand.push(Point { pos, extent: Vec3::splat(r * 0.5), seed: seed_at(gs, ns, pos), tag: tag_id(&rect.tag), ..Default::default() });
            }
        }
    }
    let prio: Vec<u64> = cand.seed.iter().map(|s| mix64(*s)).collect();
    let keep = prune(&cand.pos, r, |a, b| prio[a].cmp(&prio[b]));
    cand.retain(|k| keep[k] && work.contains(xz(cand.pos[k])))
}

/// Keeps a point unless another within `r` (XZ) ranks higher. Only neighbours matter, so the
/// result inside an area is the same whatever lies beyond `r` of it.
fn prune(pos: &[Vec3], r: f32, rank: impl Fn(usize, usize) -> std::cmp::Ordering) -> Vec<bool> {
    let cell = r.max(1e-4);
    let key = |p: Vec3| IVec2::new((p.x / cell).floor() as i32, (p.z / cell).floor() as i32);
    let mut buckets: HashMap<IVec2, Vec<usize>> = HashMap::new();
    for (i, p) in pos.iter().enumerate() {
        buckets.entry(key(*p)).or_default().push(i);
    }
    let r2 = r * r;
    (0..pos.len())
        .map(|i| {
            let k = key(pos[i]);
            for dz in -1..=1 {
                for dx in -1..=1 {
                    if let Some(b) = buckets.get(&(k + IVec2::new(dx, dz))) {
                        for &j in b {
                            if j != i && xz(pos[j]).distance_squared(xz(pos[i])) < r2 && rank(j, i) == std::cmp::Ordering::Greater {
                                return false;
                            }
                        }
                    }
                }
            }
            true
        })
        .collect()
}

fn edges(s: &crate::Shapes, spacing: f32, offset: f32, side: Side, work: Area, gs: u64, ns: u64) -> PointSet {
    let mut p = PointSet::default();
    let mut put = |a: Vec3, b: Vec3, normal: Vec3, tag: u32| {
        let d = b - a;
        let len = Vec2::new(d.x, d.z).length();
        if len < 1e-4 {
            return;
        }
        let dir = d / len;
        let mut t = spacing * 0.5;
        while t < len {
            let pos = a + dir * t + normal * offset;
            t += spacing;
            if !work.contains(xz(pos)) {
                continue;
            }
            // Local -Z (Bevy's forward) faces away from the edge.
            let face = if normal.length_squared() > 0.5 { normal } else { Vec3::new(dir.z, 0.0, -dir.x) };
            let rot = Quat::from_rotation_arc(Vec3::NEG_Z, face.normalize());
            p.push(Point { pos, rot, extent: Vec3::splat(spacing * 0.5), seed: seed_at(gs, ns, pos), tag, ..Default::default() });
        }
    };
    for r in &s.rects {
        let c = r.corners();
        let center = Vec3::new(r.center.x, r.y, r.center.y);
        for k in 0..4 {
            let (a, b) = (Vec3::new(c[k].x, r.y, c[k].y), Vec3::new(c[(k + 1) % 4].x, r.y, c[(k + 1) % 4].y));
            let d = b - a;
            let mut out = Vec3::new(d.z, 0.0, -d.x).normalize_or_zero();
            if out.dot((a + b) * 0.5 - center) < 0.0 {
                out = -out;
            }
            let n = match side {
                Side::Out | Side::Left => out,
                Side::In | Side::Right => -out,
                Side::On => Vec3::ZERO,
            };
            put(a, b, n, tag_id(&r.tag));
        }
    }
    for l in &s.lines {
        let m = l.points.len();
        let segs = if l.closed { m } else { m.saturating_sub(1) };
        for k in 0..segs {
            let (a, b) = (l.points[k], l.points[(k + 1) % m]);
            let d = b - a;
            // Left of travel = up × direction.
            let left = Vec3::new(d.z, 0.0, -d.x).normalize_or_zero();
            let n = match side {
                Side::Out | Side::Left => left,
                Side::In | Side::Right => -left,
                Side::On => Vec3::ZERO,
            };
            put(a, b, n, tag_id(&l.tag));
        }
    }
    p
}

fn rect_fill(rects: &[Rect], work: Area, gs: u64, ns: u64) -> PointSet {
    let mut p = PointSet::default();
    for r in rects {
        if !work.contains(r.center) {
            continue;
        }
        let pos = Vec3::new(r.center.x, r.y, r.center.y);
        p.push(Point {
            pos,
            rot: Quat::from_rotation_y(r.yaw),
            extent: Vec3::new(r.half.x, 0.5, r.half.y),
            seed: seed_at(gs, ns, pos),
            tag: tag_id(&r.tag),
            ..Default::default()
        });
    }
    p
}

/// Value-noise fBm in [0, 1].
fn fbm(p: Vec2, octaves: u32, seed: u64) -> f32 {
    let (mut sum, mut amp, mut norm, mut f) = (0.0, 1.0, 0.0, 1.0);
    for o in 0..octaves {
        sum += value(p * f, mix64(seed ^ o as u64)) * amp;
        norm += amp;
        amp *= 0.5;
        f *= 2.0;
    }
    sum / norm
}

fn value(p: Vec2, seed: u64) -> f32 {
    let i = p.floor();
    let f = p - i;
    let at = |x: f32, z: f32| unit(mix64(seed ^ mix64(((x as i64 as u64) << 32) ^ (z as i64 as u32 as u64))));
    let s = f * f * (Vec2::splat(3.0) - 2.0 * f);
    let (a, b, c, d) = (at(i.x, i.y), at(i.x + 1.0, i.y), at(i.x, i.y + 1.0), at(i.x + 1.0, i.y + 1.0));
    let top = a + (b - a) * s.x;
    let bot = c + (d - c) * s.x;
    top + (bot - top) * s.y
}

fn pick(p: &PointSet, def: &SpawnDef, nseed: u64) -> Vec<u16> {
    let n = def.items.len().max(1);
    if let Some(col) = def.by_attr.as_ref().and_then(|a| p.attrs.get(a)) {
        return col.iter().map(|v| (v.max(0.0) as usize).min(n - 1) as u16).collect();
    }
    let total: f32 = def.items.iter().map(|(_, w)| w.max(0.0)).sum();
    (0..p.len())
        .map(|k| {
            if total <= 0.0 {
                return 0;
            }
            let mut x = unit(mix64(p.seed[k] ^ nseed ^ 0x5157)) * total;
            for (i, (_, w)) in def.items.iter().enumerate() {
                x -= w.max(0.0);
                if x < 0.0 {
                    return i as u16;
                }
            }
            (n - 1) as u16
        })
        .collect()
}
