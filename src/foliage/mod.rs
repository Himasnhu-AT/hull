//! Foliage LOD (feature `foliage`): distant trees as **impostors**, with the switch from the real
//! models done for you. Near plants are your own meshes (spawned per chunk around the camera,
//! with Bevy's `VisibilityRange` fading them out); far plants are one camera-facing quad each,
//! merged per chunk, drawn from an [`ImpostorAtlas`]; the two crossfade with the same 4x4
//! dither so no pixel is drawn twice and none is missed. Docs: `docs/ENVIRONMENT.md`.
//!
//! ```ignore
//! let atlas = ImpostorAtlas::new(images.load("trees/oak.impostor.png"), params);   // from any baker
//! let mut foliage = Foliage::default();
//! let oak = foliage.add_species(FoliageSpecies::new("oak", atlas).near(trunk_mesh, trunk_mat).near(crown_mesh, crown_mat));
//! foliage.scatter(oak, Vec2::ZERO, 400.0, 3000, 7, |x, z| terrain_height(x, z));
//! app.insert_resource(foliage).insert_resource(FoliageConfig { near: 60.0, far: 900.0, ..default() });
//! ```
//!
//! The runtime API does not care how the atlas was made: [`ImpostorParams`] (serde) is the whole
//! contract (grid, frames in a ring, size). One frame is a plain billboard; a ring of views turns
//! with the camera. Nothing here bakes.
//!
//! Cost: instances live in a chunk grid ([`FoliageConfig::chunk`]); a refresh (a few times a
//! second) spawns / drops the near entities and impostor chunk meshes of chunks entering /
//! leaving range, a budgeted number per frame. An impostor chunk is one mesh per species: no
//! per-instance entity, no per-frame work. Tag: near entities and impostor meshes are `Scenery` +
//! `KeepDetail` (this module owns their ranges; the render budget leaves them alone). Impostors
//! cast no shadows. Headless: the index and stats run, the GPU material is skipped.
//! Control commands (feature `devtools`): `foliage.get`, `foliage.config`.

mod atlas;

#[cfg(feature = "devtools")]
mod control;

use bevy::asset::RenderAssetUsages;
use bevy::camera::primitives::Aabb;
use bevy::camera::visibility::{NoAutoAabb, VisibilityRange};
use bevy::light::NotShadowCaster;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::pbr::{ExtendedMaterial, MaterialExtension, MaterialPlugin};
use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use bevy::render::render_resource::{AsBindGroup, ShaderType};
use bevy::shader::ShaderRef;

pub use atlas::{ImpostorAtlas, ImpostorParams};

use crate::gfx::MainCamera;
use crate::render_budget::{KeepDetail, Scenery};

// ---------------------------------------------------------------- data

/// One piece of a species' near model: a shared mesh + material at a local transform (trunk,
/// crown, ...). Share handles: Bevy batches identical ones into instanced draws.
#[derive(Clone, Debug)]
pub struct NearPart {
    pub mesh: Handle<Mesh>,
    pub material: Handle<StandardMaterial>,
    pub local: Transform,
}

/// A kind of plant: its near model (parts) and its impostor pictures.
#[derive(Clone, Debug)]
pub struct FoliageSpecies {
    pub name: String,
    pub near: Vec<NearPart>,
    pub impostor: ImpostorAtlas,
    /// Near parts cast shadows.
    pub near_shadows: bool,
}

impl FoliageSpecies {
    pub fn new(name: impl Into<String>, impostor: ImpostorAtlas) -> Self {
        FoliageSpecies { name: name.into(), near: vec![], impostor, near_shadows: true }
    }
    /// Adds a near part at the origin.
    pub fn near(mut self, mesh: Handle<Mesh>, material: Handle<StandardMaterial>) -> Self {
        self.near.push(NearPart { mesh, material, local: Transform::IDENTITY });
        self
    }
    pub fn near_at(mut self, mesh: Handle<Mesh>, material: Handle<StandardMaterial>, local: Transform) -> Self {
        self.near.push(NearPart { mesh, material, local });
        self
    }
}

/// One plant in the world.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FoliageInstance {
    pub species: u16,
    /// Base point (at the ground).
    pub pos: Vec3,
    /// Rotation about +Y (radians).
    pub yaw: f32,
    /// Width scale (x, z) and height scale (y).
    pub scale: Vec2,
    /// Colour multiplier (1,1,1 = as drawn); the near model and impostor should agree.
    pub tint: Vec3,
}

impl FoliageInstance {
    pub fn new(species: u16, pos: Vec3) -> Self {
        FoliageInstance { species, pos, yaw: 0.0, scale: Vec2::ONE, tint: Vec3::ONE }
    }
}

/// The plants of the world. Insert it (and edit it: bump [`Foliage::version`] via
/// [`Foliage::touch`], or use the methods, to rebuild).
#[derive(Resource, Default, Clone)]
pub struct Foliage {
    pub species: Vec<FoliageSpecies>,
    pub instances: Vec<FoliageInstance>,
    version: u32,
}

impl Foliage {
    pub fn add_species(&mut self, s: FoliageSpecies) -> u16 {
        self.species.push(s);
        self.version += 1;
        (self.species.len() - 1) as u16
    }
    pub fn add(&mut self, i: FoliageInstance) {
        self.instances.push(i);
        self.version += 1;
    }
    /// Marks the data changed after editing `instances` directly.
    pub fn touch(&mut self) {
        self.version += 1;
    }
    /// Scatters `count` instances of `species` over the square `centre` +- `half` (m), seeded and
    /// repeatable, at the height `ground(x, z)` with random yaw, size and tint variation.
    pub fn scatter(&mut self, species: u16, centre: Vec2, half: f32, count: usize, seed: u64, ground: impl Fn(f32, f32) -> f32) {
        let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut next = move || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s >> 40) as f32 / (1u64 << 24) as f32
        };
        for _ in 0..count {
            let (x, z) = (centre.x + (next() * 2.0 - 1.0) * half, centre.y + (next() * 2.0 - 1.0) * half);
            let k = 0.8 + 0.5 * next();
            let shade = 0.85 + 0.3 * next();
            self.instances.push(FoliageInstance {
                species,
                pos: Vec3::new(x, ground(x, z), z),
                yaw: next() * std::f32::consts::TAU,
                scale: Vec2::new(k * (0.9 + 0.2 * next()), k),
                tint: Vec3::new(shade, shade * (0.97 + 0.06 * next()), shade * 0.95),
            });
        }
        self.version += 1;
    }
}

/// The LOD ranges and budgets. Distances are from the camera in metres.
#[derive(Resource, Clone, Debug)]
pub struct FoliageConfig {
    pub enabled: bool,
    /// Near models are fully drawn up to here; they fade out over `fade` metres beyond.
    pub near: f32,
    pub fade: f32,
    /// Impostors fade in over `near..near + fade`, are fully drawn, and fade out by `far`.
    pub far: f32,
    /// Chunk size (m): spawn / drop granularity.
    pub chunk: f32,
    /// Chunk changes per refresh: near spawns, near drops, impostor builds.
    pub near_per_frame: usize,
    pub impostors_per_frame: usize,
    /// Refreshes per second (real time).
    pub refresh_hz: f32,
    /// Only every `thin`-th instance gets an impostor (1 = all; 2 = every other on Low).
    pub thin: u32,
    /// No impostors (near models only), to compare cost.
    pub impostors: bool,
}

impl Default for FoliageConfig {
    fn default() -> Self {
        FoliageConfig { enabled: true, near: 70.0, fade: 25.0, far: 900.0, chunk: 128.0, near_per_frame: 4, impostors_per_frame: 2, refresh_hz: 4.0, thin: 1, impostors: true }
    }
}

/// What is resident, for `foliage.get` and tests.
#[derive(Resource, Default, Clone, Copy, Debug, PartialEq)]
pub struct FoliageStats {
    pub chunks: usize,
    pub near_chunks: usize,
    pub near_entities: usize,
    pub impostor_chunks: usize,
    pub impostor_quads: usize,
}

// ---------------------------------------------------------------- impostor material

/// Far plants: one camera-facing quad per instance (`impostor.wesl`). The base material is the
/// species' picture (alpha mask); no prepass, no shadows.
pub type ImpostorMat = ExtendedMaterial<StandardMaterial, ImpostorExt>;

/// Shader parameters: the `VisibilityRange`-style fade distances and the atlas grid.
#[derive(Clone, Copy, Debug, Default, ShaderType, Reflect)]
pub struct ImpostorUniform {
    /// Fade in from x to y, fade out from z to w (m).
    pub range: Vec4,
    /// x columns, y rows, z frames.
    pub grid: Vec4,
}

#[derive(Asset, AsBindGroup, Reflect, Debug, Clone, Default)]
pub struct ImpostorExt {
    #[uniform(100)]
    pub params: ImpostorUniform,
}

impl MaterialExtension for ImpostorExt {
    fn vertex_shader() -> ShaderRef {
        "embedded://engine/foliage/impostor.wesl".into()
    }
    fn fragment_shader() -> ShaderRef {
        "embedded://engine/foliage/impostor.wesl".into()
    }
    fn enable_prepass() -> bool {
        false
    }
    fn enable_shadows() -> bool {
        false
    }
}

// ---------------------------------------------------------------- runtime

/// Marks a near-model entity / an impostor chunk mesh, with the chunk it belongs to.
#[derive(Component, Clone, Copy, Debug)]
pub struct FoliageNear(pub IVec2);
#[derive(Component, Clone, Copy, Debug)]
pub struct FoliageImpostor(pub IVec2);

#[derive(Default)]
struct Chunk {
    /// Indices into `Foliage::instances`.
    items: Vec<u32>,
    near: Vec<Entity>,
    near_spawned: bool,
    imp: Vec<Entity>,
    imp_built: bool,
    quads: usize,
}

#[derive(Resource, Default)]
struct FoliageIndex {
    chunks: HashMap<IVec2, Chunk>,
    version: u32,
    chunk: f32,
    mats: Vec<Option<Handle<ImpostorMat>>>,
    last: f64,
    range_key: [f32; 4],
}

pub struct FoliagePlugin;

impl Plugin for FoliagePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<FoliageConfig>().init_resource::<FoliageStats>().init_resource::<FoliageIndex>();
        if app.get_sub_app(bevy::render::RenderApp).is_some() {
            bevy::asset::embedded_asset!(app, "impostor.wesl");
            app.add_plugins(MaterialPlugin::<ImpostorMat>::default());
        } else {
            app.init_asset::<ImpostorMat>();
        }
        app.add_systems(Update, stream.run_if(resource_exists::<Foliage>));
        #[cfg(feature = "devtools")]
        control::register(app);
    }
}

fn chunk_of(p: Vec3, size: f32) -> IVec2 {
    IVec2::new((p.x / size).floor() as i32, (p.z / size).floor() as i32)
}

/// Horizontal distance from `p` to the chunk's square.
pub fn chunk_distance(key: IVec2, size: f32, p: Vec3) -> f32 {
    let lo = Vec2::new(key.x as f32, key.y as f32) * size;
    let hi = lo + Vec2::splat(size);
    let d = Vec2::new((lo.x - p.x).max(0.0).max(p.x - hi.x), (lo.y - p.z).max(0.0).max(p.z - hi.y));
    d.length()
}

/// The impostor quads of one chunk's instances of one species, relative to `origin`.
#[derive(Default, Debug)]
pub struct Quads {
    pub pos: Vec<[f32; 3]>,
    pub uv: Vec<[f32; 2]>,
    pub off: Vec<[f32; 2]>,
    pub col: Vec<[f32; 4]>,
    pub idx: Vec<u32>,
    pub lo: Vec3,
    pub hi: Vec3,
}

impl Quads {
    pub fn triangles(&self) -> usize {
        self.idx.len() / 3
    }
}

/// Builds the quads of `items` (instances of one species) for `params`. Each instance is four
/// vertices at its base point; corners are offsets in UV_1 and the yaw is packed in UV_0.
pub fn build_quads(items: &[&FoliageInstance], params: &ImpostorParams, origin: Vec3, thin: u32) -> Quads {
    let mut q = Quads { lo: Vec3::MAX, hi: Vec3::MIN, ..default() };
    for (n, inst) in items.iter().enumerate() {
        if thin > 1 && !(n as u32).is_multiple_of(thin) {
            continue;
        }
        let base = inst.pos - origin;
        let (hw, y0, y1) = (params.half_width * inst.scale.x, params.y0 * inst.scale.y, params.y1 * inst.scale.y);
        let i = q.pos.len() as u32;
        // Yaw in 256ths of a turn, packed as `u + 2 q` (exact in f32).
        let k = ((inst.yaw / std::f32::consts::TAU).rem_euclid(1.0) * 256.0).round() as u32 % 256;
        let pack = |u: f32| u + 2.0 * k as f32;
        q.pos.extend([base.to_array(); 4]);
        q.uv.extend([[pack(0.0), 1.0], [pack(1.0), 1.0], [pack(1.0), 0.0], [pack(0.0), 0.0]]);
        q.off.extend([[-hw, y0], [hw, y0], [hw, y1], [-hw, y1]]);
        q.col.extend([[inst.tint.x, inst.tint.y, inst.tint.z, 1.0]; 4]);
        q.idx.extend_from_slice(&[i, i + 1, i + 2, i, i + 2, i + 3]);
        q.lo = q.lo.min(base + Vec3::new(-hw, y0, -hw));
        q.hi = q.hi.max(base + Vec3::new(hw, y1, hw));
    }
    q
}

fn impostor_mesh(q: Quads) -> Mesh {
    let n = q.pos.len();
    let mut m = Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::RENDER_WORLD);
    m.insert_attribute(Mesh::ATTRIBUTE_POSITION, q.pos);
    m.insert_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0f32, 1.0, 0.0]; n]);
    m.insert_attribute(Mesh::ATTRIBUTE_UV_0, q.uv);
    m.insert_attribute(Mesh::ATTRIBUTE_UV_1, q.off);
    m.insert_attribute(Mesh::ATTRIBUTE_COLOR, q.col);
    m.insert_indices(Indices::U32(q.idx));
    m
}

fn near_transform(inst: &FoliageInstance) -> Transform {
    Transform { translation: inst.pos, rotation: Quat::from_rotation_y(inst.yaw), scale: Vec3::new(inst.scale.x, inst.scale.y, inst.scale.x) }
}

/// Keeps entities for what is in range of the camera: near models per chunk, impostor chunks
/// out to the far distance. Runs a few times a second.
#[allow(clippy::too_many_arguments)]
fn stream(
    mut commands: Commands,
    real: Res<Time<Real>>,
    cfg: Res<FoliageConfig>,
    foliage: Res<Foliage>,
    mut idx: ResMut<FoliageIndex>,
    mut stats: ResMut<FoliageStats>,
    cam: Query<&GlobalTransform, With<MainCamera>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: Option<ResMut<Assets<ImpostorMat>>>,
) {
    let now = real.elapsed_secs_f64();
    let rebuild = idx.version != foliage.version || idx.chunk != cfg.chunk;
    let range_key = [cfg.near, cfg.fade, cfg.far, cfg.thin as f32 + cfg.impostors as u32 as f32 * 0.5];
    let retune = idx.range_key != range_key;
    if !rebuild && !retune && now - idx.last < 1.0 / cfg.refresh_hz.max(0.1) as f64 {
        return;
    }
    idx.last = now;
    let Some(cam) = cam.iter().next().map(|c| c.translation()) else { return };
    if rebuild || retune {
        // Drop everything (data changed or ranges retuned: the impostor materials carry them).
        for (_, c) in idx.chunks.drain() {
            for e in c.near.into_iter().chain(c.imp) {
                commands.entity(e).despawn();
            }
        }
        idx.mats.clear();
        idx.version = foliage.version;
        idx.chunk = cfg.chunk;
        idx.range_key = range_key;
        if rebuild {
            let size = cfg.chunk.max(8.0);
            for (i, inst) in foliage.instances.iter().enumerate() {
                idx.chunks.entry(chunk_of(inst.pos, size)).or_default().items.push(i as u32);
            }
        } else {
            // Retune only: the chunk lists are still right; rebuild them (cheap) and move on.
            let size = cfg.chunk.max(8.0);
            for (i, inst) in foliage.instances.iter().enumerate() {
                idx.chunks.entry(chunk_of(inst.pos, size)).or_default().items.push(i as u32);
            }
        }
    }
    *stats = FoliageStats { chunks: idx.chunks.len(), ..default() };
    if !cfg.enabled {
        for c in idx.chunks.values_mut() {
            for e in c.near.drain(..).chain(c.imp.drain(..)) {
                commands.entity(e).despawn();
            }
            c.near_spawned = false;
            c.imp_built = false;
            c.quads = 0;
        }
        return;
    }
    let size = cfg.chunk.max(8.0);
    let near_reach = cfg.near + cfg.fade;
    let range = VisibilityRange { start_margin: 0.0..0.0, end_margin: cfg.near..near_reach, use_aabb: false };
    let (mut near_budget, mut imp_budget) = (cfg.near_per_frame, cfg.impostors_per_frame);
    // Nearest chunks first, so the view fills from the camera outwards.
    let mut keys: Vec<(f32, IVec2)> = idx.chunks.keys().map(|k| (chunk_distance(*k, size, cam), *k)).collect();
    keys.sort_by(|a, b| a.0.total_cmp(&b.0));
    for (d, key) in keys {
        let idx = &mut *idx;
        let Some(chunk) = idx.chunks.get_mut(&key) else { continue };
        // Near models (hysteresis: drop a quarter chunk later than spawn).
        let want_near = if chunk.near_spawned { d < near_reach + size * 0.25 } else { d < near_reach };
        if want_near && !chunk.near_spawned && near_budget > 0 {
            near_budget -= 1;
            chunk.near_spawned = true;
            for &i in &chunk.items {
                let inst = &foliage.instances[i as usize];
                let Some(sp) = foliage.species.get(inst.species as usize) else { continue };
                let root = near_transform(inst);
                for part in &sp.near {
                    let mut e = commands.spawn((
                        Name::new("foliage near"),
                        Mesh3d(part.mesh.clone()),
                        MeshMaterial3d(part.material.clone()),
                        root * part.local,
                        range.clone(),
                        Scenery,
                        KeepDetail,
                        FoliageNear(key),
                    ));
                    if !sp.near_shadows {
                        e.insert(NotShadowCaster);
                    }
                    chunk.near.push(e.id());
                }
            }
        } else if !want_near && chunk.near_spawned {
            for e in chunk.near.drain(..) {
                commands.entity(e).despawn();
            }
            chunk.near_spawned = false;
        }
        // Impostors out to the far distance (dropped a chunk later).
        let want_imp = cfg.impostors && if chunk.imp_built { d < cfg.far + size } else { d < cfg.far };
        if want_imp && !chunk.imp_built && imp_budget > 0 {
            imp_budget -= 1;
            chunk.imp_built = true;
            let origin = Vec3::new((key.x as f32 + 0.5) * size, 0.0, (key.y as f32 + 0.5) * size);
            let mut per: HashMap<u16, Vec<&FoliageInstance>> = HashMap::default();
            for &i in &chunk.items {
                let inst = &foliage.instances[i as usize];
                per.entry(inst.species).or_default().push(inst);
            }
            for (sp_i, items) in per {
                let Some(sp) = foliage.species.get(sp_i as usize) else { continue };
                let q = build_quads(&items, &sp.impostor.params, origin, cfg.thin);
                if q.pos.is_empty() {
                    continue;
                }
                chunk.quads += q.pos.len() / 4;
                let aabb = Aabb::from_min_max(q.lo, q.hi);
                let mesh = meshes.add(impostor_mesh(q));
                let mut e = commands.spawn((
                    Name::new("foliage far"),
                    Mesh3d(mesh),
                    Transform::from_translation(origin),
                    aabb,
                    NoAutoAabb,
                    NotShadowCaster,
                    Scenery,
                    KeepDetail,
                    FoliageImpostor(key),
                ));
                // The GPU material (a stats-only headless run has no asset store for it).
                if let Some(mats) = mats.as_mut() {
                    if idx.mats.len() <= sp_i as usize {
                        idx.mats.resize(sp_i as usize + 1, None);
                    }
                    let h = idx.mats[sp_i as usize].get_or_insert_with(|| mats.add(impostor_material(&sp.impostor, &cfg))).clone();
                    e.insert(MeshMaterial3d(h));
                }
                chunk.imp.push(e.id());
            }
        } else if !want_imp && chunk.imp_built {
            for e in chunk.imp.drain(..) {
                commands.entity(e).despawn();
            }
            chunk.imp_built = false;
            chunk.quads = 0;
        }
        if chunk.near_spawned {
            stats.near_chunks += 1;
            stats.near_entities += chunk.near.len();
        }
        if chunk.imp_built {
            stats.impostor_chunks += 1;
            stats.impostor_quads += chunk.quads;
        }
    }
}

/// The impostor material of a species: the atlas picture with an alpha mask, the fade range and
/// the grid in the extension.
pub fn impostor_material(atlas: &ImpostorAtlas, cfg: &FoliageConfig) -> ImpostorMat {
    let p = &atlas.params;
    ImpostorMat {
        base: StandardMaterial {
            base_color_texture: Some(atlas.image.clone()),
            alpha_mode: AlphaMode::Mask(p.cutoff),
            perceptual_roughness: 0.95,
            reflectance: 0.1,
            double_sided: true,
            cull_mode: None,
            ..default()
        },
        extension: ImpostorExt {
            params: ImpostorUniform {
                // In from where the near model ends, out at the far distance (a quarter of
                // the span, at least 40 m, to fade).
                range: Vec4::new(cfg.near, cfg.near + cfg.fade, (cfg.far - (cfg.far * 0.15).max(40.0)).max(cfg.near + cfg.fade), cfg.far),
                grid: Vec4::new(p.grid[0] as f32, p.grid[1] as f32, p.frames as f32, 0.0),
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::asset::AssetPlugin;

    fn inst(x: f32, z: f32, yaw: f32) -> FoliageInstance {
        FoliageInstance { yaw, ..FoliageInstance::new(0, Vec3::new(x, 1.0, z)) }
    }

    #[test]
    fn quads_carry_base_offsets_tint_and_packed_yaw() {
        let p = ImpostorParams { half_width: 2.0, y0: 0.0, y1: 6.0, ..default() };
        let a = FoliageInstance { scale: Vec2::new(1.5, 2.0), tint: Vec3::new(0.8, 0.9, 1.0), ..inst(10.0, 20.0, std::f32::consts::PI) };
        let q = build_quads(&[&a], &p, Vec3::new(8.0, 0.0, 16.0), 1);
        assert_eq!(q.pos.len(), 4);
        assert_eq!(q.pos[0], [2.0, 1.0, 4.0]);
        assert_eq!(q.triangles(), 2);
        assert_eq!(q.off[0], [-3.0, 0.0]);
        assert_eq!(q.off[2], [3.0, 12.0]);
        // Yaw = half a turn = 128/256: u + 2 * 128.
        assert_eq!(q.uv[1][0], 1.0 + 256.0);
        assert_eq!(q.col[0], [0.8, 0.9, 1.0, 1.0]);
        assert!(q.hi.y - q.lo.y >= 12.0 - 1e-4);
    }

    #[test]
    fn thinning_keeps_every_nth() {
        let items: Vec<FoliageInstance> = (0..10).map(|i| inst(i as f32, 0.0, 0.0)).collect();
        let refs: Vec<&FoliageInstance> = items.iter().collect();
        assert_eq!(build_quads(&refs, &ImpostorParams::default(), Vec3::ZERO, 1).pos.len(), 40);
        assert_eq!(build_quads(&refs, &ImpostorParams::default(), Vec3::ZERO, 2).pos.len(), 20);
    }

    #[test]
    fn scatter_is_repeatable_and_stays_in_the_square() {
        let (mut a, mut b) = (Foliage::default(), Foliage::default());
        a.scatter(0, Vec2::new(100.0, -50.0), 40.0, 200, 3, |x, _| x * 0.01);
        b.scatter(0, Vec2::new(100.0, -50.0), 40.0, 200, 3, |x, _| x * 0.01);
        assert_eq!(a.instances, b.instances);
        assert!(a.instances.iter().all(|i| (i.pos.x - 100.0).abs() <= 40.0 && (i.pos.z + 50.0).abs() <= 40.0 && (i.pos.y - i.pos.x * 0.01).abs() < 1e-4));
        let mut c = Foliage::default();
        c.scatter(0, Vec2::new(100.0, -50.0), 40.0, 200, 4, |_, _| 0.0);
        assert_ne!(a.instances[0].pos.x, c.instances[0].pos.x);
    }

    #[test]
    fn chunk_distance_is_zero_inside_and_grows_outside() {
        let k = IVec2::new(1, 0);
        assert_eq!(chunk_distance(k, 100.0, Vec3::new(150.0, 0.0, 50.0)), 0.0);
        assert!((chunk_distance(k, 100.0, Vec3::new(50.0, 0.0, 50.0)) - 50.0).abs() < 1e-4);
        assert!((chunk_distance(k, 100.0, Vec3::new(300.0, 0.0, 250.0)) - (100.0f32.powi(2) + 150.0f32.powi(2)).sqrt()).abs() < 1e-3);
    }

    #[test]
    fn material_range_lines_up_with_the_near_fade() {
        let cfg = FoliageConfig { near: 60.0, fade: 20.0, far: 800.0, ..default() };
        let atlas = ImpostorAtlas::billboard(Handle::default(), 2.0, 6.0);
        let m = impostor_material(&atlas, &cfg);
        let r = m.extension.params.range;
        // Impostor fades in exactly where the near model's range ends.
        assert_eq!((r.x, r.y), (60.0, 80.0));
        assert_eq!(r.w, 800.0);
        assert!(r.z > r.y && r.z < r.w);
    }

    fn app() -> App {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, AssetPlugin::default(), TransformPlugin));
        app.init_asset::<Mesh>().init_asset::<StandardMaterial>().init_asset::<Image>();
        app.add_plugins(FoliagePlugin);
        app
    }

    fn species(app: &mut App) -> FoliageSpecies {
        let mesh = app.world_mut().resource_mut::<Assets<Mesh>>().add(Cuboid::new(1.0, 4.0, 1.0));
        let mat = app.world_mut().resource_mut::<Assets<StandardMaterial>>().add(StandardMaterial::default());
        FoliageSpecies::new("t", ImpostorAtlas::billboard(Handle::default(), 2.0, 4.0)).near(mesh.clone(), mat.clone()).near(mesh, mat)
    }

    #[test]
    fn near_and_far_follow_the_camera() {
        let mut app = app();
        let sp = species(&mut app);
        let mut f = Foliage::default();
        let s = f.add_species(sp);
        // A 2 x 2 km square of trees, camera at the west end.
        f.scatter(s, Vec2::ZERO, 1000.0, 4000, 1, |_, _| 0.0);
        app.insert_resource(f);
        app.insert_resource(FoliageConfig { near: 60.0, fade: 20.0, far: 500.0, chunk: 100.0, near_per_frame: 100, impostors_per_frame: 100, refresh_hz: 1000.0, ..default() });
        let cam = app.world_mut().spawn((MainCamera, Transform::from_xyz(-900.0, 2.0, 0.0), GlobalTransform::from_xyz(-900.0, 2.0, 0.0))).id();
        for _ in 0..3 {
            app.update();
        }
        let a = *app.world().resource::<FoliageStats>();
        assert_eq!(a.chunks, 400);
        assert!(a.near_chunks > 0 && a.near_chunks < 20, "near chunks {a:?}");
        assert!(a.near_entities > 0 && a.near_entities.is_multiple_of(2), "two parts per tree: {a:?}");
        assert!(a.impostor_chunks > a.near_chunks && a.impostor_chunks < 100, "far chunks {a:?}");
        assert!(a.impostor_quads > 100);
        // Fly to the east end: the resident set moves with it, nothing leaks.
        app.world_mut().entity_mut(cam).insert((Transform::from_xyz(900.0, 2.0, 0.0), GlobalTransform::from_xyz(900.0, 2.0, 0.0)));
        for _ in 0..3 {
            app.update();
        }
        let b = *app.world().resource::<FoliageStats>();
        assert!(b.near_chunks > 0 && b.impostor_chunks > 0 && b.impostor_chunks < 100, "{b:?}");
        let live = app.world_mut().query::<&FoliageNear>().iter(app.world()).count();
        assert_eq!(live, b.near_entities, "stats match live entities");
        let imp = app.world_mut().query::<&FoliageImpostor>().iter(app.world()).count();
        assert!(imp >= b.impostor_chunks, "{imp} meshes for {} chunks", b.impostor_chunks);
        // Turning impostors off drops them; near models stay.
        app.world_mut().resource_mut::<FoliageConfig>().impostors = false;
        for _ in 0..2 {
            app.update();
        }
        let c = *app.world().resource::<FoliageStats>();
        assert_eq!(c.impostor_chunks, 0);
        assert!(c.near_chunks > 0);
    }

    #[test]
    fn near_models_carry_the_visibility_range_that_matches_the_impostor_fade() {
        let mut app = app();
        let sp = species(&mut app);
        let mut f = Foliage::default();
        let s = f.add_species(sp);
        f.add(FoliageInstance::new(s, Vec3::new(10.0, 0.0, 0.0)));
        app.insert_resource(f);
        app.insert_resource(FoliageConfig { near: 50.0, fade: 10.0, refresh_hz: 1000.0, ..default() });
        app.world_mut().spawn((MainCamera, GlobalTransform::default()));
        for _ in 0..2 {
            app.update();
        }
        let r = app.world_mut().query::<&VisibilityRange>().iter(app.world()).next().expect("a near entity").clone();
        assert_eq!(r.end_margin, 50.0..60.0);
        assert_eq!(r.start_margin, 0.0..0.0);
    }

    #[test]
    fn editing_the_data_rebuilds() {
        let mut app = app();
        let sp = species(&mut app);
        let mut f = Foliage::default();
        let s = f.add_species(sp);
        f.add(FoliageInstance::new(s, Vec3::new(10.0, 0.0, 0.0)));
        app.insert_resource(f);
        app.insert_resource(FoliageConfig { refresh_hz: 1000.0, ..default() });
        app.world_mut().spawn((MainCamera, GlobalTransform::default()));
        for _ in 0..2 {
            app.update();
        }
        assert_eq!(app.world().resource::<FoliageStats>().near_entities, 2);
        app.world_mut().resource_mut::<Foliage>().add(FoliageInstance::new(s, Vec3::new(20.0, 0.0, 0.0)));
        for _ in 0..2 {
            app.update();
        }
        assert_eq!(app.world().resource::<FoliageStats>().near_entities, 4);
    }
}
