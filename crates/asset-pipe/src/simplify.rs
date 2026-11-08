//! Mesh simplification for LODs: vertex clustering on a uniform grid. Each occupied cell keeps its
//! one vertex nearest the cell's centroid (with that vertex's normal and UV, so textures never
//! smear), triangles that collapse are dropped. The cell size is searched so the triangle count
//! lands on the requested ratio. Small and robust, rougher than quadric edge collapse: swap it for
//! one by replacing the `Lods` stage's `Simplifier`.

use std::collections::{HashMap, HashSet};

use glam::Vec3;

use crate::{MeshData, Model};

/// Anything that turns a model into a cheaper one (`ratio` = wanted share of the triangles).
pub trait Simplifier {
    fn simplify(&self, model: &Model, ratio: f32) -> Model;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Clustering;

impl Simplifier for Clustering {
    fn simplify(&self, model: &Model, ratio: f32) -> Model {
        let mut out = model.clone();
        out.meshes = model.meshes.iter().map(|m| simplify_mesh(m, ratio)).collect();
        out
    }
}

pub fn simplify_mesh(m: &MeshData, ratio: f32) -> MeshData {
    let target = ((m.triangles() as f32 * ratio).round() as usize).max(4);
    if m.triangles() <= target {
        return m.clone();
    }
    let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
    for p in &m.positions {
        lo = lo.min(Vec3::from(*p));
        hi = hi.max(Vec3::from(*p));
    }
    let ext = (hi - lo).max_element().max(1e-6);
    // Binary search on the cell size: bigger cell, fewer triangles.
    let (mut a, mut b) = (ext / 4096.0, ext);
    let mut best = cluster(m, lo, b);
    for _ in 0..20 {
        let mid = (a + b) * 0.5;
        let r = cluster(m, lo, mid);
        if r.triangles() > target {
            a = mid;
        } else {
            b = mid;
            best = r;
        }
    }
    if best.triangles() == 0 { m.clone() } else { best }
}

fn cluster(m: &MeshData, origin: Vec3, cell: f32) -> MeshData {
    let key = |p: Vec3| {
        let q = (p - origin) / cell;
        (q.x.floor() as i32, q.y.floor() as i32, q.z.floor() as i32)
    };
    let mut sums: HashMap<(i32, i32, i32), (Vec3, u32)> = HashMap::new();
    for p in &m.positions {
        let p = Vec3::from(*p);
        let e = sums.entry(key(p)).or_insert((Vec3::ZERO, 0));
        e.0 += p;
        e.1 += 1;
    }
    // Representative: the vertex nearest the cell centroid (lowest index on ties).
    let mut rep: HashMap<(i32, i32, i32), (f32, u32)> = HashMap::new();
    for (i, p) in m.positions.iter().enumerate() {
        let p = Vec3::from(*p);
        let k = key(p);
        let (s, c) = sums[&k];
        let d = p.distance_squared(s / c as f32);
        let e = rep.entry(k).or_insert((f32::MAX, i as u32));
        if d < e.0 {
            *e = (d, i as u32);
        }
    }
    let map = |i: u32| rep[&key(Vec3::from(m.positions[i as usize]))].1;
    let mut out = MeshData { name: m.name.clone(), material: m.material, ..Default::default() };
    let mut remap: HashMap<u32, u32> = HashMap::new();
    let mut seen: HashSet<[u32; 3]> = HashSet::new();
    for t in m.indices.chunks_exact(3) {
        let (a, b, c) = (map(t[0]), map(t[1]), map(t[2]));
        if a == b || b == c || a == c {
            continue;
        }
        let mut s = [a, b, c];
        s.sort_unstable();
        if !seen.insert(s) {
            continue;
        }
        for v in [a, b, c] {
            let n = remap.len() as u32;
            let id = *remap.entry(v).or_insert_with(|| {
                out.positions.push(m.positions[v as usize]);
                out.normals.push(m.normals[v as usize]);
                out.uvs.push(m.uvs[v as usize]);
                n
            });
            out.indices.push(id);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(n: usize) -> MeshData {
        let mut m = MeshData::default();
        for z in 0..=n {
            for x in 0..=n {
                m.positions.push([x as f32, ((x + z) as f32 * 0.3).sin() * 0.2, z as f32]);
                m.normals.push([0.0, 1.0, 0.0]);
                m.uvs.push([x as f32 / n as f32, z as f32 / n as f32]);
            }
        }
        for z in 0..n {
            for x in 0..n {
                let i = (z * (n + 1) + x) as u32;
                let w = n as u32 + 1;
                m.indices.extend([i, i + w, i + 1, i + 1, i + w, i + w + 1]);
            }
        }
        m
    }

    #[test]
    fn clustering_hits_the_ratio_and_keeps_valid_indices() {
        let m = grid(32);
        assert_eq!(m.triangles(), 2048);
        let s = simplify_mesh(&m, 0.25);
        let (t, want) = (s.triangles() as f32, 512.0);
        assert!(t > want * 0.5 && t <= want * 1.05, "{t} triangles for target {want}");
        assert!(s.indices.iter().all(|i| (*i as usize) < s.positions.len()));
        assert_eq!(s.positions.len(), s.uvs.len());
        // Bounds survive (extreme vertices stay in their cells).
        let max_x = s.positions.iter().map(|p| p[0]).fold(0.0, f32::max);
        assert!(max_x > 28.0, "{max_x}");
    }

    #[test]
    fn small_meshes_and_ratio_one_are_untouched() {
        let m = grid(1);
        assert_eq!(simplify_mesh(&m, 0.1).triangles(), 2);
        let g = grid(8);
        assert_eq!(simplify_mesh(&g, 1.0).triangles(), g.triangles());
    }
}
