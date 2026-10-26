//! Prefabs as data: a list of parts (primitive shape or named mesh, material, transform,
//! collider), plus code prefabs for anything gameplay-specific. [`WorldAssets`] is the registry
//! both kinds (and named meshes/materials) live in.
//!
//! ```ignore
//! // Data (RON, in a WorldDesc):
//! "hut": (parts: [
//!     (shape: Cuboid((6.0, 3.0, 5.0)), material: "plaster", at: (0.0, 1.5, 0.0)),
//!     (shape: Cone(radius: 4.6, height: 2.5), material: "thatch", at: (0.0, 4.25, 0.0), collider: false),
//! ], clear_radius: 6.0, tags: ["house"]),
//! // Code:
//! app.world_mut().resource_mut::<WorldAssets>().add_code_prefab("chest", |c: &mut Commands, ctx: &PrefabCtx| {
//!     c.spawn((Chest::default(), ctx.transform, ChildOf(ctx.parent))).id()
//! });
//! ```

use std::sync::Arc;

use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use serde::{Deserialize, Serialize};

/// A primitive (metres) or a mesh registered in [`WorldAssets::meshes`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ShapeDesc {
    /// Full side lengths.
    Cuboid([f32; 3]),
    Cylinder { radius: f32, height: f32 },
    Sphere(f32),
    Cone { radius: f32, height: f32 },
    Capsule { radius: f32, length: f32 },
    Mesh(String),
}

impl ShapeDesc {
    /// Mesh for a primitive (`None` for [`ShapeDesc::Mesh`]). Low resolutions: these are for
    /// world dressing seen from afar.
    pub fn primitive_mesh(&self) -> Option<Mesh> {
        Some(match self {
            ShapeDesc::Cuboid(s) => Cuboid::new(s[0], s[1], s[2]).into(),
            ShapeDesc::Cylinder { radius, height } => Cylinder::new(*radius, *height).mesh().resolution(12).build(),
            ShapeDesc::Sphere(r) => Sphere::new(*r).mesh().ico(2).ok()?,
            ShapeDesc::Cone { radius, height } => Cone { radius: *radius, height: *height }.mesh().resolution(12).build(),
            ShapeDesc::Capsule { radius, length } => Capsule3d::new(*radius, *length).mesh().latitudes(6).longitudes(10).build(),
            ShapeDesc::Mesh(_) => return None,
        })
    }

    /// Cache key for the mesh.
    fn key(&self) -> String {
        format!("{self:?}")
    }

    #[cfg(feature = "physics")]
    fn collider(&self, mesh: Option<&Mesh>) -> Option<avian3d::prelude::Collider> {
        use avian3d::prelude::Collider;
        Some(match self {
            ShapeDesc::Cuboid(s) => Collider::cuboid(s[0], s[1], s[2]),
            ShapeDesc::Cylinder { radius, height } => Collider::cylinder(*radius, *height),
            ShapeDesc::Sphere(r) => Collider::sphere(*r),
            ShapeDesc::Cone { radius, height } => Collider::cone(*radius, *height),
            ShapeDesc::Capsule { radius, length } => Collider::capsule(*radius, *length),
            ShapeDesc::Mesh(_) => return mesh.and_then(Collider::trimesh_from_mesh),
        })
    }
}

/// A PBR material as data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MaterialDesc {
    /// sRGB.
    pub color: [f32; 3],
    pub roughness: f32,
    pub metallic: f32,
    /// sRGB × strength (0 = none).
    pub emissive: [f32; 3],
    /// Vertex colours (meshes from `MeshKit`) multiply the colour: keep white for those.
    pub double_sided: bool,
}

impl Default for MaterialDesc {
    fn default() -> Self {
        MaterialDesc { color: [0.8, 0.8, 0.8], roughness: 0.85, metallic: 0.0, emissive: [0.0; 3], double_sided: false }
    }
}

impl MaterialDesc {
    pub fn to_material(&self) -> StandardMaterial {
        StandardMaterial {
            base_color: Color::srgb(self.color[0], self.color[1], self.color[2]),
            perceptual_roughness: self.roughness,
            metallic: self.metallic,
            emissive: Color::srgb(self.emissive[0], self.emissive[1], self.emissive[2]).to_linear(),
            double_sided: self.double_sided,
            cull_mode: if self.double_sided { None } else { Some(bevy::render::render_resource::Face::Back) },
            ..default()
        }
    }
}

fn one3() -> [f32; 3] {
    [1.0; 3]
}
fn yes() -> bool {
    true
}

/// One part of a prefab.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PartDesc {
    pub shape: ShapeDesc,
    /// Name in the world's materials; empty = `color` (or grey).
    #[serde(default)]
    pub material: String,
    /// Shortcut: an sRGB colour instead of a named material.
    #[serde(default)]
    pub color: Option<[f32; 3]>,
    /// Offset from the prefab origin (metres).
    #[serde(default)]
    pub at: [f32; 3],
    /// Euler angles in degrees (applied Y, X, Z).
    #[serde(default)]
    pub rot: [f32; 3],
    #[serde(default = "one3")]
    pub scale: [f32; 3],
    /// Static collider for this part (feature `physics`).
    #[serde(default = "yes")]
    pub collider: bool,
}

impl PartDesc {
    pub fn new(shape: ShapeDesc) -> Self {
        PartDesc { shape, material: String::new(), color: None, at: [0.0; 3], rot: [0.0; 3], scale: [1.0; 3], collider: true }
    }
    pub fn at(mut self, x: f32, y: f32, z: f32) -> Self {
        self.at = [x, y, z];
        self
    }
    pub fn material(mut self, m: &str) -> Self {
        self.material = m.into();
        self
    }
    pub fn color(mut self, c: [f32; 3]) -> Self {
        self.color = Some(c);
        self
    }
    pub fn no_collider(mut self) -> Self {
        self.collider = false;
        self
    }
    pub fn transform(&self) -> Transform {
        let r = self.rot.map(f32::to_radians);
        Transform::from_translation(Vec3::from(self.at))
            .with_rotation(Quat::from_euler(EulerRot::YXZ, r[1], r[0], r[2]))
            .with_scale(Vec3::from(self.scale))
    }
    /// Key of the material this part uses (named, else `#rrggbb` of its colour).
    pub fn material_key(&self) -> String {
        if !self.material.is_empty() {
            return self.material.clone();
        }
        let c = self.color.unwrap_or([0.8, 0.8, 0.8]);
        format!("#{:02x}{:02x}{:02x}", (c[0] * 255.0) as u8, (c[1] * 255.0) as u8, (c[2] * 255.0) as u8)
    }
}

/// A prefab made of parts.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PrefabDef {
    pub parts: Vec<PartDesc>,
    /// Scatter keeps this far away from each instance (metres; 0 = none).
    pub clear_radius: f32,
    /// Free-form tags games query through [`WorldTags`].
    pub tags: Vec<String>,
    /// Merge this prefab into its cell's HLOD proxy when far (default true).
    pub no_hlod: bool,
}

/// Tags of a spawned prefab instance (from [`PrefabDef::tags`]).
#[derive(Component, Clone, Debug, Default)]
pub struct WorldTags(pub Vec<String>);

/// Root of a spawned prefab instance.
#[derive(Component, Clone, Debug)]
pub struct PrefabInstance {
    pub prefab: Arc<str>,
}

/// What a code prefab gets.
pub struct PrefabCtx {
    pub prefab: Arc<str>,
    /// Transform relative to `parent` (the cell root).
    pub transform: Transform,
    /// Absolute position.
    pub abs: Vec3,
    pub parent: Entity,
    pub cell: IVec2,
    /// Visual components may be added (false headless).
    pub visuals: bool,
}

/// A prefab written in Rust: spawn whatever you want under `ctx.parent` and return the root.
pub type PrefabFn = Arc<dyn Fn(&mut Commands, &PrefabCtx) -> Entity + Send + Sync>;

/// Registry of prefabs, named meshes and materials the world refers to by name.
#[derive(Resource, Default)]
pub struct WorldAssets {
    pub prefabs: HashMap<String, PrefabDef>,
    pub code_prefabs: HashMap<String, PrefabFn>,
    /// Named meshes ([`ShapeDesc::Mesh`], `ScatterMesh::Named`). Keep their CPU data
    /// (`RenderAssetUsages::MAIN_WORLD`) if they feed HLOD or mesh colliders.
    pub meshes: HashMap<String, Handle<Mesh>>,
    pub material_descs: HashMap<String, MaterialDesc>,
    /// Materials by key (named or `#rrggbb`), created on first use.
    pub materials: HashMap<String, Handle<StandardMaterial>>,
    shape_meshes: HashMap<String, Handle<Mesh>>,
}

impl WorldAssets {
    pub fn add_prefab(&mut self, name: impl Into<String>, def: PrefabDef) -> &mut Self {
        self.prefabs.insert(name.into(), def);
        self
    }
    pub fn add_code_prefab(&mut self, name: impl Into<String>, f: impl Fn(&mut Commands, &PrefabCtx) -> Entity + Send + Sync + 'static) -> &mut Self {
        self.code_prefabs.insert(name.into(), Arc::new(f));
        self
    }
    pub fn has_prefab(&self, name: &str) -> bool {
        self.prefabs.contains_key(name) || self.code_prefabs.contains_key(name)
    }
    /// Clear radius of a prefab (0 for code prefabs).
    pub fn clear_radius(&self, name: &str) -> f32 {
        self.prefabs.get(name).map_or(0.0, |p| p.clear_radius)
    }

    /// Material for `key`, created from its [`MaterialDesc`] (or `#rrggbb` colour) on first use.
    pub fn material(&mut self, key: &str, mats: &mut Assets<StandardMaterial>) -> Handle<StandardMaterial> {
        if let Some(h) = self.materials.get(key) {
            return h.clone();
        }
        let desc = self.material_descs.get(key).cloned().unwrap_or_else(|| MaterialDesc { color: parse_hex(key).unwrap_or([0.8, 0.8, 0.8]), ..default() });
        let h = mats.add(desc.to_material());
        self.materials.insert(key.to_string(), h.clone());
        h
    }

    /// Mesh handle for a shape (primitives are created once and shared).
    pub fn shape_mesh(&mut self, shape: &ShapeDesc, meshes: &mut Assets<Mesh>) -> Option<Handle<Mesh>> {
        if let ShapeDesc::Mesh(name) = shape {
            return self.meshes.get(name).cloned();
        }
        let key = shape.key();
        if let Some(h) = self.shape_meshes.get(&key) {
            return Some(h.clone());
        }
        let h = meshes.add(shape.primitive_mesh()?);
        self.shape_meshes.insert(key, h.clone());
        Some(h)
    }
}

fn parse_hex(key: &str) -> Option<[f32; 3]> {
    let h = key.strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let b = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok().map(|v| v as f32 / 255.0);
    Some([b(0)?, b(2)?, b(4)?])
}

/// Render assets a spawn may use (`None` headless).
pub struct RenderAssets<'a> {
    pub meshes: &'a mut Assets<Mesh>,
    pub mats: &'a mut Assets<StandardMaterial>,
}

/// Spawns prefab `name` with `transform` (relative to `parent`) and returns its root, or
/// `None` if no such prefab exists.
pub fn spawn_prefab(
    commands: &mut Commands,
    assets: &mut WorldAssets,
    mut render: Option<&mut RenderAssets>,
    name: &Arc<str>,
    transform: Transform,
    abs: Vec3,
    parent: Entity,
    cell: IVec2,
) -> Option<Entity> {
    if let Some(def) = assets.prefabs.get(&**name).cloned() {
        let root = commands
            .spawn((Name::new(name.to_string()), PrefabInstance { prefab: name.clone() }, WorldTags(def.tags.clone()), transform, Visibility::default(), ChildOf(parent)))
            .id();
        for part in &def.parts {
            let mut e = commands.spawn((part.transform(), Visibility::default(), ChildOf(root)));
            let mut mesh_for_collider: Option<Mesh> = None;
            if let Some(r) = render.as_deref_mut() {
                if let Some(m) = assets.shape_mesh(&part.shape, r.meshes) {
                    #[cfg(feature = "physics")]
                    if part.collider && matches!(part.shape, ShapeDesc::Mesh(_)) {
                        mesh_for_collider = r.meshes.get(&m).cloned();
                    }
                    e.insert(Mesh3d(m));
                }
                e.insert(MeshMaterial3d(assets.material(&part.material_key(), r.mats)));
            }
            #[cfg(feature = "physics")]
            if part.collider
                && let Some(c) = part.shape.collider(mesh_for_collider.as_ref())
            {
                e.insert((avian3d::prelude::RigidBody::Static, c));
            }
            let _ = &mut mesh_for_collider;
        }
        return Some(root);
    }
    let f = assets.code_prefabs.get(&**name)?.clone();
    let ctx = PrefabCtx { prefab: name.clone(), transform, abs, parent, cell, visuals: render.is_some() };
    let root = f(commands, &ctx);
    commands.entity(root).insert(PrefabInstance { prefab: name.clone() });
    Some(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ron_prefab_and_material_keys() {
        let def: PrefabDef = ron::from_str(
            r#"(parts: [
                (shape: Cuboid((6.0, 3.0, 5.0)), material: "plaster", at: (0.0, 1.5, 0.0)),
                (shape: Cone(radius: 4.6, height: 2.5), color: Some((0.5, 0.25, 0.0)), at: (0.0, 4.25, 0.0), rot: (0.0, 45.0, 0.0), collider: false),
            ], clear_radius: 6.0, tags: ["house"])"#,
        )
        .unwrap();
        assert_eq!(def.parts.len(), 2);
        assert!(def.parts[0].collider && !def.parts[1].collider);
        assert_eq!(def.parts[0].scale, [1.0; 3]);
        assert_eq!(def.parts[0].material_key(), "plaster");
        assert_eq!(def.parts[1].material_key(), "#7f3f00");
        assert_eq!(parse_hex("#7f3f00").map(|c| (c[0] * 255.0).round()), Some(127.0));
        let t = def.parts[1].transform();
        assert!((t.rotation * Vec3::X - Vec3::new(std::f32::consts::FRAC_1_SQRT_2, 0.0, -std::f32::consts::FRAC_1_SQRT_2)).length() < 1e-3);
        assert!(def.parts[1].shape.primitive_mesh().is_some());
    }
}
