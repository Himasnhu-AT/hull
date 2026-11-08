//! The in-memory model every stage reads and rewrites: meshes with one material each, materials,
//! encoded images. Y-up, metres, right-handed (glTF's own convention).

use glam::{Mat4, Vec3};

#[derive(Clone, Debug, Default)]
pub struct Model {
    pub name: String,
    pub meshes: Vec<MeshData>,
    pub materials: Vec<MaterialData>,
    pub images: Vec<ImageData>,
}

#[derive(Clone, Debug, Default)]
pub struct MeshData {
    pub name: String,
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub uvs: Vec<[f32; 2]>,
    /// Triangle list.
    pub indices: Vec<u32>,
    pub material: usize,
}

#[derive(Clone, Debug)]
pub struct MaterialData {
    pub name: String,
    /// Linear RGBA factor.
    pub base_color: [f32; 4],
    pub base_color_tex: Option<usize>,
    pub normal_tex: Option<usize>,
    /// glTF layout: G roughness, B metallic.
    pub metal_rough_tex: Option<usize>,
    pub metallic: f32,
    pub roughness: f32,
    pub double_sided: bool,
    /// `Some(cutoff)`: alpha-masked (foliage).
    pub alpha_mask: Option<f32>,
    pub alpha_blend: bool,
}

impl Default for MaterialData {
    fn default() -> Self {
        MaterialData {
            name: "default".into(),
            base_color: [1.0; 4],
            base_color_tex: None,
            normal_tex: None,
            metal_rough_tex: None,
            metallic: 0.0,
            roughness: 1.0,
            double_sided: false,
            alpha_mask: None,
            alpha_blend: false,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ImageData {
    pub name: String,
    /// PNG or JPEG bytes (empty: the file was missing).
    pub bytes: Vec<u8>,
    pub mime: String,
}

impl MeshData {
    pub fn triangles(&self) -> usize {
        self.indices.len() / 3
    }

    pub fn tri(&self, i: usize) -> [Vec3; 3] {
        let p = |k: usize| Vec3::from(self.positions[self.indices[i * 3 + k] as usize]);
        [p(0), p(1), p(2)]
    }

    /// Smooth, area-weighted vertex normals (for meshes that came without).
    pub fn compute_normals(&mut self) {
        let mut n = vec![Vec3::ZERO; self.positions.len()];
        for t in 0..self.triangles() {
            let [a, b, c] = self.tri(t);
            let fn_ = (b - a).cross(c - a);
            for k in 0..3 {
                n[self.indices[t * 3 + k] as usize] += fn_;
            }
        }
        self.normals = n.into_iter().map(|v| v.try_normalize().unwrap_or(Vec3::Y).to_array()).collect();
    }
}

impl Model {
    pub fn triangle_count(&self) -> usize {
        self.meshes.iter().map(MeshData::triangles).sum()
    }

    pub fn vertex_count(&self) -> usize {
        self.meshes.iter().map(|m| m.positions.len()).sum()
    }

    pub fn bounds(&self) -> Option<(Vec3, Vec3)> {
        let mut it = self.meshes.iter().flat_map(|m| m.positions.iter()).map(|p| Vec3::from(*p));
        let first = it.next()?;
        Some(it.fold((first, first), |(lo, hi), p| (lo.min(p), hi.max(p))))
    }

    /// Applies `m` to every position (and the inverse transpose to normals).
    pub fn transform(&mut self, m: Mat4) {
        let nm = glam::Mat3::from_mat4(m).inverse().transpose();
        let flip = m.determinant() < 0.0;
        for me in &mut self.meshes {
            for p in &mut me.positions {
                *p = m.transform_point3(Vec3::from(*p)).to_array();
            }
            for n in &mut me.normals {
                *n = (nm * Vec3::from(*n)).try_normalize().unwrap_or(Vec3::Y).to_array();
            }
            if flip {
                for t in me.indices.chunks_exact_mut(3) {
                    t.swap(1, 2);
                }
            }
        }
    }
}
