//! Worlds as data: a [`WorldDesc`] (Rust struct or RON text) says what the terrain is made of,
//! which prefabs exist and where they go, what gets scattered, and how cells stream.
//! [`spawn_world`] (or the [`SpawnWorld`] command) turns it into a running world.
//!
//! ```ron
//! (
//!     seed: 7,
//!     terrain: (size: (4096.0, 4096.0), spacing: 2.0, source: Noise((amplitude: 260.0))),
//!     cell_size: 256.0,
//!     materials: { "plaster": (color: (0.85, 0.80, 0.70)) },
//!     prefabs: { "hut": (parts: [(shape: Cuboid((6.0, 3.0, 5.0)), material: "plaster", at: (0.0, 1.5, 0.0))], clear_radius: 6.0) },
//!     placements: [(prefab: "hut", at: (120.0, 0.0, -40.0), yaw: 30.0)],
//!     groups: [(prefabs: ["hut"], center: (600.0, 300.0), radius: 90.0, count: 14, seed: 2)],
//!     scatter: [(name: "trees", mesh: Pine, far_mesh: Some(PineLow), render: Instanced, density: 0.004, cluster: 64.0, near: 250.0, cull: 1200.0)],
//! )
//! ```
//!
//! Generation is deterministic: the same description and seed give the same world.

use std::sync::Arc;

use bevy::math::Affine3A;
use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use serde::{Deserialize, Serialize};

use super::cells::WorldCells;
use super::heightfield::{Heightfield, HeightmapError, NoiseTerrain};
use super::hlod::{HlodInput, HlodState};
use super::material::{SplatLayer, TerrainExt, TerrainMaterial, default_layers, generate_splat, repeat_sampler, splat_image, terrain_params};
use super::noise::{Rng64, hash2};
use super::prefab::{MaterialDesc, PrefabDef, ShapeDesc, WorldAssets};
use super::scatter::{Exclusion, RuleRt, Scatter, ScatterMesh, ScatterRule, builtin_material, builtin_mesh};
use super::terrain::{Terrain, TerrainChunks, TerrainLook};
use super::{StreamMode, WorldOrigin, WorldRoot, WorldSettings, WorldStats};
use crate::paths::AssetsDir;

/// Where heights come from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum HeightSource {
    Flat(f32),
    Noise(NoiseTerrain),
    /// 8/16-bit greyscale PNG under the assets folder; black = `min`, white = `max`.
    Png { path: String, min: f32, max: f32 },
    /// Little-endian u16 raw file under the assets folder.
    Raw16 { path: String, width: u32, height: u32, min: f32, max: f32 },
}

impl Default for HeightSource {
    fn default() -> Self {
        HeightSource::Noise(NoiseTerrain::default())
    }
}

/// The terrain part of a [`WorldDesc`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TerrainDesc {
    /// Metres (X, Z). PNG/raw sources: derived from the image size × spacing when zero.
    pub size: [f32; 2],
    /// Metres between height samples.
    pub spacing: f32,
    /// Quads per chunk side (power of two).
    pub chunk_quads: u32,
    /// Absolute min corner; `None` = centred on (0, 0).
    pub origin: Option<[f32; 2]>,
    pub source: HeightSource,
    /// Up to 4 splat layers (empty = grass/rock/sand/snow defaults).
    pub layers: Vec<SplatLayer>,
    /// Splat map side in texels (0 = one per height sample, max 2048).
    pub splat_resolution: u32,
}

impl Default for TerrainDesc {
    fn default() -> Self {
        TerrainDesc { size: [1024.0, 1024.0], spacing: 2.0, chunk_quads: 64, origin: None, source: HeightSource::default(), layers: Vec::new(), splat_resolution: 0 }
    }
}

/// A prefab put at one place.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    pub prefab: String,
    /// Absolute X, Y, Z. With `ground` (default) Y is an offset above the terrain.
    pub at: [f32; 3],
    #[serde(default)]
    pub yaw: f32,
    #[serde(default = "one")]
    pub scale: f32,
    #[serde(default = "yes")]
    pub ground: bool,
}

fn one() -> f32 {
    1.0
}
fn yes() -> bool {
    true
}

/// `count` prefabs scattered in a circle with a minimum spacing (villages, ruins, camps).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Group {
    /// Picked at random per item.
    pub prefabs: Vec<String>,
    pub center: [f32; 2],
    pub radius: f32,
    pub count: u32,
    pub min_spacing: f32,
    pub max_slope: f32,
    pub seed: u64,
    /// Face the centre (± 20°) instead of a random yaw.
    pub face_center: bool,
}

impl Default for Group {
    fn default() -> Self {
        Group { prefabs: Vec::new(), center: [0.0; 2], radius: 50.0, count: 8, min_spacing: 12.0, max_slope: 20.0, seed: 0, face_center: true }
    }
}

/// A whole world as data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorldDesc {
    pub seed: u64,
    pub terrain: TerrainDesc,
    /// Streaming / HLOD cell side (metres; rounded up to a multiple of the chunk size).
    pub cell_size: f32,
    /// `None` = keep [`WorldSettings::streaming`]'s mode.
    pub streaming: Option<StreamMode>,
    pub materials: std::collections::BTreeMap<String, MaterialDesc>,
    pub prefabs: std::collections::BTreeMap<String, PrefabDef>,
    pub placements: Vec<Placement>,
    pub groups: Vec<Group>,
    pub scatter: Vec<ScatterRule>,
    /// World-wide scatter exclusions (roads, plazas).
    pub exclusions: Vec<Exclusion>,
}

impl Default for WorldDesc {
    fn default() -> Self {
        WorldDesc {
            seed: 1,
            terrain: TerrainDesc::default(),
            cell_size: 256.0,
            streaming: None,
            materials: Default::default(),
            prefabs: Default::default(),
            placements: Vec::new(),
            groups: Vec::new(),
            scatter: Vec::new(),
            exclusions: Vec::new(),
        }
    }
}

/// Why a world could not spawn.
#[derive(Debug, Clone, PartialEq)]
pub enum WorldError {
    Parse(String),
    Heightmap(HeightmapError),
    UnknownPrefab(String),
    Invalid(String),
}

impl std::fmt::Display for WorldError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorldError::Parse(e) => write!(f, "world description: {e}"),
            WorldError::Heightmap(e) => write!(f, "{e}"),
            WorldError::UnknownPrefab(p) => write!(f, "unknown prefab `{p}`"),
            WorldError::Invalid(e) => write!(f, "invalid world: {e}"),
        }
    }
}

impl std::error::Error for WorldError {}

impl WorldDesc {
    pub fn from_ron(text: &str) -> Result<Self, WorldError> {
        ron::from_str(text).map_err(|e| WorldError::Parse(e.to_string()))
    }
    pub fn to_ron(&self) -> String {
        ron::ser::to_string_pretty(self, ron::ser::PrettyConfig::default()).unwrap_or_default()
    }

    /// Builds the heightfield (files are read from `assets`).
    pub fn heightfield(&self, assets: Option<&std::path::Path>) -> Result<Heightfield, WorldError> {
        let t = &self.terrain;
        let sp = t.spacing.max(0.01);
        let read = |p: &str| -> Result<Vec<u8>, WorldError> {
            let path = assets.map_or_else(|| std::path::PathBuf::from(p), |a| a.join(p));
            std::fs::read(&path).map_err(|e| WorldError::Heightmap(HeightmapError::Io(format!("{}: {e}", path.display()))))
        };
        let (nx, nz) = ((t.size[0] / sp).round() as u32 + 1, (t.size[1] / sp).round() as u32 + 1);
        let centred = |nx: u32, nz: u32| t.origin.map(Vec2::from).unwrap_or(-Vec2::new((nx - 1) as f32, (nz - 1) as f32) * sp * 0.5);
        Ok(match &t.source {
            HeightSource::Flat(h) => Heightfield::flat(nx.max(2), nz.max(2), sp, centred(nx, nz), *h),
            HeightSource::Noise(n) => {
                let mut n = n.clone();
                n.fbm.seed ^= self.seed;
                Heightfield::from_noise(nx.max(2), nz.max(2), sp, centred(nx, nz), &n)
            }
            HeightSource::Png { path, min, max } => {
                let bytes = read(path)?;
                let probe = Heightfield::from_png(&bytes, sp, Vec2::ZERO, *min, *max).map_err(WorldError::Heightmap)?;
                let o = centred(probe.nx(), probe.nz());
                Heightfield::from_heights(probe.nx(), probe.nz(), sp, o, probe.heights().to_vec())
            }
            HeightSource::Raw16 { path, width, height, min, max } => {
                let bytes = read(path)?;
                Heightfield::from_raw16(&bytes, *width, *height, sp, centred(*width, *height), *min, *max).map_err(WorldError::Heightmap)?
            }
        })
    }
}

/// Command: `commands.queue(SpawnWorld(desc))`. Logs errors.
pub struct SpawnWorld(pub WorldDesc);

impl Command for SpawnWorld {
    type Out = ();
    fn apply(self, world: &mut World) {
        if let Err(e) = spawn_world(world, self.0) {
            error!("world: {e}");
        }
    }
}

/// Removes the current world (entities and resources). Settings stay.
pub fn despawn_world(world: &mut World) {
    let roots: Vec<Entity> = world.query_filtered::<Entity, With<WorldRoot>>().iter(world).collect();
    for e in roots {
        world.entity_mut(e).despawn();
    }
    world.remove_resource::<Terrain>();
    world.remove_resource::<TerrainLook>();
    world.remove_resource::<WorldCells>();
    world.remove_resource::<Scatter>();
    world.insert_resource(HlodState::default());
    world.insert_resource(TerrainChunks::default());
    world.resource_mut::<WorldStats>().spawned = false;
}

/// Picks deterministic positions for a [`Group`] (absolute XZ + yaw degrees).
pub fn group_positions(g: &Group, world_seed: u64, terrain: &Terrain) -> Vec<(Vec2, f32, usize)> {
    let mut out: Vec<(Vec2, f32, usize)> = Vec::new();
    let mut r = Rng64::new(hash2(world_seed ^ 0x6A0C, g.seed as i32, g.count as i32));
    let c = Vec2::from(g.center);
    let mut tries = 0;
    while out.len() < g.count as usize && tries < g.count * 60 {
        tries += 1;
        let a = r.f32() * std::f32::consts::TAU;
        let d = g.radius * r.f32().sqrt();
        let p = c + Vec2::new(a.cos(), a.sin()) * d;
        let pick = (r.f32() * g.prefabs.len().max(1) as f32) as usize;
        let jitter = r.range(-20.0, 20.0);
        let random_yaw = r.range(0.0, 360.0);
        if !terrain.heightfield().contains(p.x, p.y) || terrain.slope_deg(p.x, p.y) > g.max_slope {
            continue;
        }
        if out.iter().any(|(q, _, _)| q.distance(p) < g.min_spacing) {
            continue;
        }
        let yaw = if g.face_center {
            let to = c - p;
            to.x.atan2(to.y).to_degrees() + jitter
        } else {
            random_yaw
        };
        out.push((p, yaw, pick.min(g.prefabs.len().saturating_sub(1))));
    }
    out
}

/// Spawns `desc` (replacing any current world). Headless: terrain data, colliders, prefabs
/// (colliders + gameplay) and HLOD meshes; no visuals.
pub fn spawn_world(world: &mut World, desc: WorldDesc) -> Result<(), WorldError> {
    spawn_world_with(world, desc, None)
}

/// [`spawn_world`] with a heightfield built in code (overrides `desc.terrain.source`).
pub fn spawn_world_with(world: &mut World, desc: WorldDesc, heightfield: Option<Heightfield>) -> Result<(), WorldError> {
    let started = std::time::Instant::now();
    despawn_world(world);
    let assets_dir = world.get_resource::<AssetsDir>().map(|a| a.0.clone());
    let hf = match heightfield {
        Some(h) => h,
        None => desc.heightfield(assets_dir.as_deref())?,
    };
    let terrain = Terrain::new(hf, desc.terrain.chunk_quads);
    let render = super::has_render(world);
    if let Some(mode) = desc.streaming {
        world.resource_mut::<WorldSettings>().streaming.mode = mode;
    }

    // Registry: materials + prefabs.
    {
        let mut a = world.resource_mut::<WorldAssets>();
        for (k, m) in &desc.materials {
            a.material_descs.insert(k.clone(), m.clone());
            a.materials.remove(k);
        }
        for (k, p) in &desc.prefabs {
            a.prefabs.insert(k.clone(), p.clone());
        }
    }

    // Placements (absolute), grouped by cell.
    let cell_size = (desc.cell_size / terrain.chunk_size()).ceil().max(1.0) * terrain.chunk_size();
    let (lo, hi) = terrain.bounds();
    let mut cells = WorldCells::new(lo, hi, cell_size);
    let mut exclusions = desc.exclusions.clone();
    {
        let a = world.resource::<WorldAssets>();
        let mut put = |name: &str, p: Vec2, y: f32, ground: bool, yaw: f32, scale: f32| -> Result<(), WorldError> {
            if !a.has_prefab(name) {
                return Err(WorldError::UnknownPrefab(name.to_string()));
            }
            let h = if ground { terrain.height_at(p.x, p.y) + y } else { y };
            let tf = Transform::from_xyz(p.x, h, p.y).with_rotation(Quat::from_rotation_y(yaw.to_radians())).with_scale(Vec3::splat(scale));
            cells.place(name, tf);
            let r = a.clear_radius(name) * scale;
            if r > 0.0 {
                exclusions.push(Exclusion::Circle { center: p.into(), radius: r });
            }
            Ok(())
        };
        for pl in &desc.placements {
            put(&pl.prefab, Vec2::new(pl.at[0], pl.at[2]), pl.at[1], pl.ground, pl.yaw, pl.scale)?;
        }
        for g in &desc.groups {
            for (p, yaw, i) in group_positions(g, desc.seed, &terrain) {
                let name = g.prefabs.get(i).ok_or_else(|| WorldError::Invalid("group without prefabs".into()))?;
                put(name, p, 0.0, true, yaw, 1.0)?;
            }
        }
    }

    // HLOD inputs: every data prefab part, relative to its cell corner.
    let hlod_inputs = if world.resource::<WorldSettings>().hlod.enabled { hlod_inputs(world, &cells) } else { Vec::new() };
    let voxel = world.resource::<WorldSettings>().hlod.voxel;
    world.resource_mut::<HlodState>().start(hlod_inputs, voxel);

    // Root.
    let origin = *world.resource::<WorldOrigin>();
    world.spawn((Name::new("World"), WorldRoot, Transform::from_translation(origin.root_translation()), Visibility::default()));

    // Terrain look.
    if render {
        let layers = if desc.terrain.layers.is_empty() { default_layers() } else { desc.terrain.layers.clone() };
        let hf = terrain.heightfield();
        let res = if desc.terrain.splat_resolution > 0 { desc.terrain.splat_resolution } else { hf.nx().max(hf.nz()).min(2048) };
        let bytes = generate_splat(hf, &layers, res, desc.seed);
        let splat = world.resource_mut::<Assets<Image>>().add(splat_image(bytes, res));
        let mut tex: [Option<Handle<Image>>; 4] = Default::default();
        if let Some(server) = world.get_resource::<AssetServer>() {
            for (i, l) in layers.iter().take(4).enumerate() {
                if let Some(p) = &l.texture {
                    tex[i] = Some(server.load_builder().with_settings(|s: &mut bevy::image::ImageLoaderSettings| s.sampler = repeat_sampler()).load(p.clone()));
                }
            }
        }
        let params = terrain_params(&layers, hf, &origin, tex.clone().map(|t| t.is_some()));
        let [layer0, layer1, layer2, layer3] = tex;
        let mat = TerrainMaterial {
            base: StandardMaterial { perceptual_roughness: 0.9, ..default() },
            extension: TerrainExt { params, splat: Some(splat), layer0, layer1, layer2, layer3 },
        };
        let look = match world.get_resource_mut::<Assets<TerrainMaterial>>() {
            Some(mut m) => TerrainLook::Splat(m.add(mat)),
            None => TerrainLook::Standard(world.resource_mut::<Assets<StandardMaterial>>().add(StandardMaterial { base_color: Color::srgb(0.35, 0.45, 0.2), perceptual_roughness: 0.95, ..default() })),
        };
        world.insert_resource(look);
    }

    // Scatter.
    let seed = desc.seed;
    let mut rules = Vec::new();
    for r in &desc.scatter {
        let near_cpu = scatter_mesh_cpu(world, &r.mesh).map(Arc::new);
        let far_cpu = r.far_mesh.as_ref().and_then(|m| scatter_mesh_cpu(world, m)).map(Arc::new);
        let (mut near_handle, mut far_handle, mut material) = (None, None, None);
        if render {
            near_handle = match &r.mesh {
                ScatterMesh::Named(n) => world.resource::<WorldAssets>().meshes.get(n).cloned(),
                _ => near_cpu.as_ref().map(|m| world.resource_mut::<Assets<Mesh>>().add((**m).clone())),
            };
            far_handle = match &r.far_mesh {
                Some(ScatterMesh::Named(n)) => world.resource::<WorldAssets>().meshes.get(n).cloned(),
                Some(_) => far_cpu.as_ref().map(|m| world.resource_mut::<Assets<Mesh>>().add((**m).clone())),
                None => None,
            };
            material = Some(match &r.material {
                Some(name) => world.resource_scope(|w, mut a: Mut<WorldAssets>| a.material(name, &mut w.resource_mut::<Assets<StandardMaterial>>())),
                None => world.resource_mut::<Assets<StandardMaterial>>().add(builtin_material(&r.mesh)),
            });
        }
        rules.push(Arc::new(RuleRt { rule: r.clone(), near_cpu, far_cpu, near_handle, far_handle, material }));
    }
    world.insert_resource(Scatter::new(rules, terrain.heightfield_arc(), exclusions, seed));
    world.insert_resource(cells);
    world.insert_resource(TerrainChunks::default());
    world.insert_resource(terrain);
    let mut st = world.resource_mut::<WorldStats>();
    st.spawned = true;
    info!("world: spawned in {:.0} ms", started.elapsed().as_secs_f64() * 1000.0);
    Ok(())
}

fn scatter_mesh_cpu(world: &World, m: &ScatterMesh) -> Option<Mesh> {
    match m {
        ScatterMesh::Named(n) => {
            let h = world.resource::<WorldAssets>().meshes.get(n)?.clone();
            world.get_resource::<Assets<Mesh>>()?.get(&h).cloned()
        }
        other => builtin_mesh(other),
    }
}

/// Every data prefab part placed in each cell, as (material key, mesh, transform rel. to cell).
fn hlod_inputs(world: &World, cells: &WorldCells) -> Vec<(IVec2, HlodInput)> {
    let a = world.resource::<WorldAssets>();
    let meshes = world.get_resource::<Assets<Mesh>>();
    let mut cache: HashMap<String, Option<Arc<Mesh>>> = HashMap::default();
    let mut out = Vec::new();
    for z in 0..cells.dims().y {
        for x in 0..cells.dims().x {
            let id = IVec2::new(x, z);
            let corner = cells.cell_min(id);
            let mut parts: HlodInput = Vec::new();
            for p in cells.placed(id) {
                let Some(def) = a.prefabs.get(&*p.prefab) else { continue };
                if def.no_hlod {
                    continue;
                }
                let mut tf = p.transform;
                tf.translation -= Vec3::new(corner.x, 0.0, corner.y);
                let root = Affine3A::from_mat4(tf.to_matrix());
                for part in &def.parts {
                    let key = format!("{:?}", part.shape);
                    let mesh = cache
                        .entry(key)
                        .or_insert_with(|| match &part.shape {
                            ShapeDesc::Mesh(n) => a.meshes.get(n).and_then(|h| meshes?.get(h).cloned()).map(Arc::new),
                            s => s.primitive_mesh().map(Arc::new),
                        })
                        .clone();
                    if let Some(m) = mesh {
                        parts.push((part.material_key(), m, root * Affine3A::from_mat4(part.transform().to_matrix())));
                    }
                }
            }
            if !parts.is_empty() {
                out.push((id, parts));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ron_round_trip_and_defaults() {
        let d = WorldDesc::from_ron(
            r#"(
                seed: 7,
                terrain: (size: (512.0, 256.0), spacing: 4.0, source: Noise((amplitude: 50.0))),
                prefabs: { "hut": (parts: [(shape: Cuboid((6.0, 3.0, 5.0)), at: (0.0, 1.5, 0.0))], clear_radius: 6.0) },
                placements: [(prefab: "hut", at: (10.0, 0.0, -20.0), yaw: 30.0)],
                groups: [(prefabs: ["hut"], center: (100.0, 50.0), radius: 60.0, count: 5)],
                scatter: [(name: "trees", mesh: Pine, far_mesh: Some(PineLow), render: Instanced, density: 0.004, collider: Some((radius: 0.3, height: 4.0)))],
                exclusions: [Circle(center: (0.0, 0.0), radius: 20.0)],
            )"#,
        )
        .unwrap();
        assert_eq!(d.terrain.chunk_quads, 64);
        assert_eq!(d.scatter[0].cull, ScatterRule::default().cull);
        assert!(d.placements[0].ground);
        let back = WorldDesc::from_ron(&d.to_ron()).unwrap();
        assert_eq!(back, d);
        let hf = d.heightfield(None).unwrap();
        assert_eq!((hf.nx(), hf.nz()), (129, 65));
        assert_eq!(hf.origin(), Vec2::new(-256.0, -128.0));
        assert!(WorldDesc::from_ron("(seed: \"x\")").is_err());
    }
}
