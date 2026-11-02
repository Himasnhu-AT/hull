//! [`Primitive`]: a box / sphere / cylinder / capsule / plane with a flat colour, described by
//! data. Meshes and materials are runtime assets with no path, so they cannot live in a level
//! file; a `Primitive` is the file-friendly stand-in. [`sync_primitives`] builds (and shares)
//! the `Mesh3d` + `MeshMaterial3d` whenever a `Primitive` is added or edited.

use bevy::platform::collections::HashMap;
use bevy::prelude::*;

/// Which shape a [`Primitive`] is.
#[derive(Reflect, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum PrimitiveShape {
    #[default]
    Cuboid,
    Sphere,
    Cylinder,
    Capsule,
    /// Flat quad in the XZ plane facing up.
    Plane,
}

/// A simple shape with a colour. `size` is the full extent in metres: a cuboid uses all three
/// axes; a sphere uses `x` (diameter); a cylinder `x` (diameter) and `y` (height); a capsule
/// `x` (diameter) and `y` (total height); a plane `x` and `z`.
#[derive(Component, Reflect, Clone, Debug, PartialEq)]
#[reflect(Component, Default)]
#[require(Transform, Visibility)]
pub struct Primitive {
    pub shape: PrimitiveShape,
    pub size: Vec3,
    pub color: Color,
    pub metallic: f32,
    pub roughness: f32,
}

impl Default for Primitive {
    fn default() -> Self {
        Primitive { shape: PrimitiveShape::Cuboid, size: Vec3::ONE, color: Color::srgb(0.7, 0.7, 0.7), metallic: 0.0, roughness: 0.6 }
    }
}

impl Primitive {
    pub fn cuboid(size: Vec3, color: Color) -> Self {
        Primitive { shape: PrimitiveShape::Cuboid, size, color, ..default() }
    }
    pub fn sphere(diameter: f32, color: Color) -> Self {
        Primitive { shape: PrimitiveShape::Sphere, size: Vec3::splat(diameter), color, ..default() }
    }
    pub fn plane(x: f32, z: f32, color: Color) -> Self {
        Primitive { shape: PrimitiveShape::Plane, size: Vec3::new(x, 0.0, z), color, ..default() }
    }

    fn mesh(&self) -> Mesh {
        let s = self.size.max(Vec3::splat(0.001));
        match self.shape {
            PrimitiveShape::Cuboid => Cuboid::new(s.x, s.y, s.z).into(),
            PrimitiveShape::Sphere => Sphere::new(s.x * 0.5).into(),
            PrimitiveShape::Cylinder => Cylinder::new(s.x * 0.5, s.y).into(),
            PrimitiveShape::Capsule => {
                let r = s.x * 0.5;
                Capsule3d::new(r, (s.y - 2.0 * r).max(0.0)).into()
            }
            PrimitiveShape::Plane => Plane3d::default().mesh().size(s.x, s.z).into(),
        }
    }
}

/// Shared meshes / materials, keyed by the exact values (identical primitives share handles).
#[derive(Resource, Default)]
pub struct PrimitiveCache {
    meshes: HashMap<(PrimitiveShape, [u32; 3]), Handle<Mesh>>,
    materials: HashMap<[u32; 6], Handle<StandardMaterial>>,
}

/// Builds `Mesh3d` + `MeshMaterial3d` for added / changed [`Primitive`]s. Does nothing without
/// mesh assets (headless).
pub fn sync_primitives(
    mut commands: Commands,
    q: Query<(Entity, &Primitive), Changed<Primitive>>,
    mut cache: ResMut<PrimitiveCache>,
    meshes: Option<ResMut<Assets<Mesh>>>,
    materials: Option<ResMut<Assets<StandardMaterial>>>,
) {
    let (Some(mut meshes), Some(mut materials)) = (meshes, materials) else { return };
    for (e, p) in &q {
        let mkey = (p.shape, [p.size.x.to_bits(), p.size.y.to_bits(), p.size.z.to_bits()]);
        let c = p.color.to_linear();
        let ckey = [c.red.to_bits(), c.green.to_bits(), c.blue.to_bits(), c.alpha.to_bits(), p.metallic.to_bits(), p.roughness.to_bits()];
        let mesh = cache.meshes.entry(mkey).or_insert_with(|| meshes.add(p.mesh())).clone();
        let mat = cache
            .materials
            .entry(ckey)
            .or_insert_with(|| {
                materials.add(StandardMaterial {
                    base_color: p.color,
                    metallic: p.metallic,
                    perceptual_roughness: p.roughness,
                    alpha_mode: if c.alpha < 1.0 { AlphaMode::Blend } else { AlphaMode::Opaque },
                    ..default()
                })
            })
            .clone();
        commands.entity(e).insert((Mesh3d(mesh), MeshMaterial3d(mat)));
    }
}
