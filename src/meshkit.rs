//! Procedural meshes from primitives: append Bevy primitives (or raw triangles) with a transform
//! and a colour each, get one mesh with per-vertex colours. For games that ship no models
//! (low-poly trees, houses, vehicles): one mesh + one shared white material per object type, so
//! thousands of copies batch well.
//!
//! ```ignore
//! let mut k = MeshKit::new();
//! k.add(Cylinder::new(0.2, 2.0), Transform::from_xyz(0.0, 1.0, 0.0), Color::srgb(0.4, 0.3, 0.2))
//!  .add(Cone { radius: 1.2, height: 3.0 }, Transform::from_xyz(0.0, 3.0, 0.0), Color::srgb(0.2, 0.5, 0.2));
//! let tree: Mesh = k.build_flat(); // faceted low-poly look
//! // material: StandardMaterial { base_color: Color::WHITE, .. } (vertex colours multiply it)
//! ```
//!
//! Colours are given in sRGB (`Color`) and stored linear, like Bevy expects.

use bevy::asset::RenderAssetUsages;
use bevy::mesh::{Indices, PrimitiveTopology, VertexAttributeValues};
use bevy::prelude::*;

/// Accumulates triangles with positions, normals, colours and UVs.
#[derive(Clone, Debug, Default)]
pub struct MeshKit {
    pos: Vec<[f32; 3]>,
    nrm: Vec<[f32; 3]>,
    col: Vec<[f32; 4]>,
    uv: Vec<[f32; 2]>,
    idx: Vec<u32>,
}

impl MeshKit {
    pub fn new() -> Self {
        Self::default()
    }

    /// Vertices so far.
    pub fn vertex_count(&self) -> usize {
        self.pos.len()
    }

    /// Appends a primitive (anything that meshes: `Cuboid`, `Cone`, `Cylinder`, `Sphere`, ...)
    /// with the default meshing settings.
    pub fn add(&mut self, shape: impl Into<Mesh>, tf: Transform, color: Color) -> &mut Self {
        self.add_mesh(&shape.into(), tf, color)
    }

    /// Appends any triangle-list mesh (positions required; normals/UVs used when present).
    pub fn add_mesh(&mut self, mesh: &Mesh, tf: Transform, color: Color) -> &mut Self {
        let Some(VertexAttributeValues::Float32x3(p)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else {
            return self;
        };
        let normals = match mesh.attribute(Mesh::ATTRIBUTE_NORMAL) {
            Some(VertexAttributeValues::Float32x3(n)) => Some(n),
            _ => None,
        };
        let uvs = match mesh.attribute(Mesh::ATTRIBUTE_UV_0) {
            Some(VertexAttributeValues::Float32x2(u)) => Some(u),
            _ => None,
        };
        let base = self.pos.len() as u32;
        let c = color.to_linear().to_f32_array();
        let m = tf.to_matrix();
        // Normals: inverse-transpose for non-uniform scale.
        let nm = Mat3::from_mat4(m).inverse().transpose();
        for (i, v) in p.iter().enumerate() {
            self.pos.push(m.transform_point3(Vec3::from(*v)).to_array());
            let n = normals.map(|n| (nm * Vec3::from(n[i])).normalize_or_zero()).unwrap_or(Vec3::Y);
            self.nrm.push(n.to_array());
            self.col.push(c);
            self.uv.push(uvs.map(|u| u[i]).unwrap_or([0.0, 0.0]));
        }
        match mesh.indices() {
            Some(Indices::U16(ix)) => self.idx.extend(ix.iter().map(|&i| base + i as u32)),
            Some(Indices::U32(ix)) => self.idx.extend(ix.iter().map(|&i| base + i)),
            None => self.idx.extend(base..base + p.len() as u32),
        }
        self
    }

    /// Appends one triangle (counter-clockwise seen from the front), flat normal.
    pub fn tri(&mut self, a: Vec3, b: Vec3, c: Vec3, color: Color) -> &mut Self {
        let n = (b - a).cross(c - a).normalize_or_zero();
        let col = color.to_linear().to_f32_array();
        let base = self.pos.len() as u32;
        for v in [a, b, c] {
            self.pos.push(v.to_array());
            self.nrm.push(n.to_array());
            self.col.push(col);
            self.uv.push([0.0, 0.0]);
        }
        self.idx.extend([base, base + 1, base + 2]);
        self
    }

    /// Appends a quad `a b c d` (counter-clockwise seen from the front) as two triangles.
    pub fn quad(&mut self, a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: Color) -> &mut Self {
        self.tri(a, b, c, color).tri(a, c, d, color)
    }

    /// Smooth-shaded mesh (normals as given by the primitives).
    pub fn build(self) -> Mesh {
        Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default())
            .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, self.pos)
            .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, self.nrm)
            .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, self.uv)
            .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, self.col)
            .with_inserted_indices(Indices::U32(self.idx))
    }

    /// Faceted (flat-shaded) mesh: every triangle gets its own vertices and face normal.
    pub fn build_flat(self) -> Mesh {
        let mut m = self.build();
        m.duplicate_vertices();
        m.compute_flat_normals();
        m
    }
}

/// Moves each vertex of `mesh` by `f(position) -> offset` (e.g. noise for rocks). Recompute
/// normals afterwards (`compute_flat_normals` / `compute_smooth_normals`).
pub fn displace(mesh: &mut Mesh, f: impl Fn(Vec3) -> Vec3) {
    if let Some(VertexAttributeValues::Float32x3(p)) = mesh.attribute_mut(Mesh::ATTRIBUTE_POSITION) {
        for v in p.iter_mut() {
            let q = Vec3::from(*v);
            *v = (q + f(q)).to_array();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_with_transform_and_colour() {
        let mut k = MeshKit::new();
        k.add(Cuboid::new(1.0, 1.0, 1.0), Transform::from_xyz(0.0, 5.0, 0.0), Color::srgb(1.0, 0.0, 0.0));
        k.tri(Vec3::ZERO, Vec3::X, Vec3::Z, Color::WHITE);
        let n = k.vertex_count();
        let m = k.build();
        let Some(VertexAttributeValues::Float32x3(p)) = m.attribute(Mesh::ATTRIBUTE_POSITION) else { panic!() };
        assert_eq!(p.len(), n);
        // Cube moved up 5 m: its vertices are between 4.5 and 5.5.
        assert!(p[..24].iter().all(|v| (4.5..=5.5).contains(&v[1])));
        let Some(VertexAttributeValues::Float32x4(c)) = m.attribute(Mesh::ATTRIBUTE_COLOR) else { panic!() };
        assert_eq!(c[0], [1.0, 0.0, 0.0, 1.0]);
        // The raw triangle (x, z order from origin) faces down: counter-clockwise from below.
        let Some(VertexAttributeValues::Float32x3(nr)) = m.attribute(Mesh::ATTRIBUTE_NORMAL) else { panic!() };
        assert!(nr[n - 1][1] < -0.99);
    }

    #[test]
    fn flat_build_duplicates_vertices() {
        let mut k = MeshKit::new();
        k.add(Sphere::new(1.0).mesh().ico(1).unwrap(), Transform::default(), Color::WHITE);
        let m = k.build_flat();
        assert_eq!(m.indices().map(|i| i.len()).unwrap_or(0), 0);
        assert_eq!(m.count_vertices() % 3, 0);
    }
}
