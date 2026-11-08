//! Collider generation from a model: primitive fits, a convex hull as a few dozen extreme points
//! (the runtime builds the hull from them), or "use LOD n as a triangle mesh".

use glam::Vec3;

use crate::Model;
use crate::desc::ColliderDesc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ColliderChoice {
    /// Box when the mesh fills most of its bounds, else convex.
    #[default]
    Auto,
    None,
    Box,
    Sphere,
    Capsule,
    Convex,
    Trimesh,
}

impl ColliderChoice {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "auto" => Self::Auto,
            "none" => Self::None,
            "box" => Self::Box,
            "sphere" => Self::Sphere,
            "capsule" => Self::Capsule,
            "convex" => Self::Convex,
            "trimesh" => Self::Trimesh,
            _ => return None,
        })
    }
}

/// `trimesh_lod`: which LOD a `Trimesh` collider refers to.
pub fn generate(model: &Model, choice: ColliderChoice, trimesh_lod: usize) -> ColliderDesc {
    let Some((lo, hi)) = model.bounds() else { return ColliderDesc::None };
    let center = (lo + hi) * 0.5;
    let half = (hi - lo) * 0.5;
    let choice = match choice {
        ColliderChoice::Auto => {
            let aabb = (half.x * half.y * half.z * 8.0).max(1e-9);
            if volume(model) / aabb > 0.6 { ColliderChoice::Box } else { ColliderChoice::Convex }
        }
        c => c,
    };
    match choice {
        ColliderChoice::None | ColliderChoice::Auto => ColliderDesc::None,
        ColliderChoice::Box => ColliderDesc::Box { center: center.to_array(), half: half.to_array() },
        ColliderChoice::Sphere => {
            let r = model.meshes.iter().flat_map(|m| m.positions.iter()).map(|p| Vec3::from(*p).distance(center)).fold(0.0, f32::max);
            ColliderDesc::Sphere { center: center.to_array(), radius: r }
        }
        ColliderChoice::Capsule => {
            let radius = half.x.max(half.z);
            ColliderDesc::Capsule { center: center.to_array(), radius, half_height: (half.y - radius).max(0.0) }
        }
        ColliderChoice::Convex => ColliderDesc::Convex { points: hull_points(model, 64) },
        ColliderChoice::Trimesh => ColliderDesc::Trimesh { lod: trimesh_lod },
    }
}

/// Enclosed volume by signed tetrahedra (right for closed meshes, a lower bound otherwise).
pub fn volume(model: &Model) -> f32 {
    let mut v = 0.0;
    for m in &model.meshes {
        for t in 0..m.triangles() {
            let [a, b, c] = m.tri(t);
            v += a.dot(b.cross(c)) / 6.0;
        }
    }
    v.abs()
}

/// The vertices farthest along `dirs` Fibonacci directions plus the six axes: their convex hull is
/// within a few percent of the mesh's.
pub fn hull_points(model: &Model, dirs: usize) -> Vec<[f32; 3]> {
    let pts: Vec<Vec3> = model.meshes.iter().flat_map(|m| m.positions.iter()).map(|p| Vec3::from(*p)).collect();
    if pts.is_empty() {
        return vec![];
    }
    let mut d: Vec<Vec3> = vec![Vec3::X, Vec3::NEG_X, Vec3::Y, Vec3::NEG_Y, Vec3::Z, Vec3::NEG_Z];
    let golden = std::f32::consts::PI * (3.0 - 5f32.sqrt());
    for i in 0..dirs {
        let y = 1.0 - 2.0 * (i as f32 + 0.5) / dirs as f32;
        let r = (1.0 - y * y).sqrt();
        d.push(Vec3::new(r * (golden * i as f32).cos(), y, r * (golden * i as f32).sin()));
    }
    let mut picked: Vec<usize> = vec![];
    for dir in d {
        let best = (0..pts.len()).max_by(|&a, &b| pts[a].dot(dir).total_cmp(&pts[b].dot(dir))).unwrap();
        if !picked.contains(&best) {
            picked.push(best);
        }
    }
    picked.into_iter().map(|i| pts[i].to_array()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures;

    #[test]
    fn a_cube_is_a_box_and_a_tree_is_convex() {
        let cube = fixtures::cube(2.0);
        assert!(matches!(generate(&cube, ColliderChoice::Auto, 0), ColliderDesc::Box { half, .. } if (half[0] - 1.0).abs() < 1e-5));
        assert!((volume(&cube) - 8.0).abs() < 1e-3);
        let tree = fixtures::tree();
        match generate(&tree, ColliderChoice::Auto, 0) {
            ColliderDesc::Convex { points } => assert!(points.len() >= 8 && points.len() <= 70),
            other => panic!("{other:?}"),
        }
        assert!(matches!(generate(&tree, ColliderChoice::Capsule, 0), ColliderDesc::Capsule { radius, .. } if radius > 0.5));
        assert_eq!(generate(&tree, ColliderChoice::Trimesh, 2), ColliderDesc::Trimesh { lod: 2 });
    }
}
