//! Procedural test models: a cube and a pine-like tree (trunk + three cones, two materials,
//! textured). Used by the unit tests and `examples/asset_pipeline_demo.rs`.

use std::f32::consts::TAU;
use std::io::Cursor;

use crate::{ImageData, MaterialData, MeshData, Model};

pub fn png(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
    let img = image::RgbaImage::from_fn(w, h, |x, y| image::Rgba(f(x, y)));
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).expect("png");
    out.into_inner()
}

pub fn cube(size: f32) -> Model {
    let h = size / 2.0;
    let mut m = MeshData { name: "cube".into(), ..Default::default() };
    // Six faces, four vertices each (flat normals).
    let faces: [([f32; 3], [f32; 3], [f32; 3]); 6] = [
        ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ([0.0, 0.0, -1.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ([1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]),
        ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
        ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]),
        ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
    ];
    for (n, r, u) in faces {
        let base = m.positions.len() as u32;
        for (sx, sy) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
            m.positions.push([(n[0] + r[0] * sx + u[0] * sy) * h, (n[1] + r[1] * sx + u[1] * sy) * h, (n[2] + r[2] * sx + u[2] * sy) * h]);
            m.normals.push(n);
            m.uvs.push([(sx + 1.0) / 2.0, (1.0 - sy) / 2.0]);
        }
        m.indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    Model { name: "cube".into(), meshes: vec![m], materials: vec![MaterialData::default()], images: vec![] }
}

/// A ring-built cone (or cylinder when `top_ratio` is 1): `rings` bands of `seg` quads.
fn lathe(name: &str, y0: f32, h: f32, r0: f32, r1: f32, rings: usize, seg: usize, material: usize) -> MeshData {
    let mut m = MeshData { name: name.into(), material, ..Default::default() };
    for k in 0..=rings {
        let t = k as f32 / rings as f32;
        let (y, r) = (y0 + h * t, r0 + (r1 - r0) * t);
        for s in 0..=seg {
            let a = TAU * s as f32 / seg as f32;
            m.positions.push([r * a.cos(), y, r * a.sin()]);
            m.uvs.push([s as f32 / seg as f32, 1.0 - t]);
        }
    }
    for k in 0..rings {
        for s in 0..seg {
            let a = (k * (seg + 1) + s) as u32;
            let (b, c, d) = (a + 1, a + seg as u32 + 1, a + seg as u32 + 2);
            m.indices.extend([a, c, b, b, c, d]);
        }
    }
    m.compute_normals();
    m
}

/// ~6 m pine: trunk (material 0, bark) and three stacked cones (material 1, needles), 1.2k
/// triangles, base at y = 0, centred on the origin.
pub fn tree() -> Model {
    let bark = png(8, 8, |x, y| if (x + y) % 3 == 0 { [92, 62, 38, 255] } else { [110, 76, 46, 255] });
    let needles = png(8, 8, |x, y| if (x * 3 + y) % 4 == 0 { [28, 84, 40, 255] } else { [38, 110, 52, 255] });
    let mut meshes = vec![lathe("trunk", 0.0, 2.2, 0.28, 0.18, 2, 10, 0)];
    for (i, (y0, h, r)) in [(1.2, 2.4, 1.6), (2.4, 2.2, 1.2), (3.6, 2.4, 0.8)].into_iter().enumerate() {
        meshes.push(lathe(&format!("crown{i}"), y0, h, r, 0.0, 8, 28, 1));
    }
    let mat = |name: &str, tex: usize, rough: f32| MaterialData { name: name.into(), base_color_tex: Some(tex), roughness: rough, metallic: 0.0, ..Default::default() };
    Model {
        name: "pine".into(),
        meshes,
        materials: vec![mat("bark", 0, 0.9), MaterialData { double_sided: true, ..mat("needles", 1, 0.8) }],
        images: vec![
            ImageData { name: "bark".into(), bytes: bark, mime: "image/png".into() },
            ImageData { name: "needles".into(), bytes: needles, mime: "image/png".into() },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    #[test]
    fn tree_normals_point_outward_and_it_has_real_triangle_counts() {
        let t = tree();
        assert!(t.triangle_count() > 1000, "{}", t.triangle_count());
        let (lo, hi) = t.bounds().unwrap();
        assert!(lo.y.abs() < 1e-4 && (hi.y - 6.0).abs() < 1e-3, "{lo} {hi}");
        let crown = &t.meshes[1];
        // Winding: geometric normal agrees with the smooth one on side faces.
        let mut agree = 0;
        for i in 0..crown.triangles() {
            let [a, b, c] = crown.tri(i);
            let n = (b - a).cross(c - a);
            let vn = Vec3::from(crown.normals[crown.indices[i * 3] as usize]);
            if n.dot(vn) > 0.0 {
                agree += 1;
            }
        }
        assert!(agree as f32 / crown.triangles() as f32 > 0.9, "{agree}/{}", crown.triangles());
        let radial = Vec3::from(crown.positions[10]) * Vec3::new(1.0, 0.0, 1.0);
        assert!(Vec3::from(crown.normals[10]).dot(radial) >= 0.0);
    }
}
