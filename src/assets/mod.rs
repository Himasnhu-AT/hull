//! Cooked 3D assets at runtime (`docs/ASSETS.md`, "3D pipeline"): load what `asset-pipe` wrote
//! (LOD meshes, collider, impostor atlas, tags) and spawn it in one call:
//!
//! ```ignore
//! fn setup(mut commands: Commands, server: Res<AssetServer>) {
//!     engine::assets::spawn(&mut commands, &server, "library/trees/pine", Transform::from_xyz(4.0, 0.0, -9.0));
//! }
//! ```
//!
//! `spawn` returns the root entity at once; the children appear when the `.asset.ron` has loaded
//! ([`CookedBuilt`] marks the root then):
//! - one child per LOD (`WorldAssetRoot` of its glTF), each visible between its switch distances;
//! - the impostor quad (a camera-facing billboard that picks the atlas cell by view angle) beyond
//!   the last LOD, up to its max distance or the render budget's view distance;
//! - a collider on the root (feature `physics`): box, sphere, capsule, convex hull, or a trimesh
//!   built from one LOD's meshes.
//!
//! **Render budget**: distances are metres at High quality and follow the quality preset like the
//! engine's own scenery tiers ([`EffectiveRanges`] over [`SceneryRanges`]); nothing is drawn past
//! the effective view distance; crossfades are Bevy's dithered `VisibilityRange` with the budget's
//! fade width; spawns are `Scenery` (or `Actor` with the tag `actor`) and the LOD meshes are
//! [`KeepDetail`] so the budget's own tiers leave them alone.
//!
//! Extension points: the data (a `.asset.ron` is plain RON), [`CookedLodSwitch`] (replace the
//! distance policy), the `CookedBuilt` marker (hang your own components on finished instances).

use bevy::asset::{AssetLoader, LoadContext, io::Reader};
use bevy::camera::visibility::VisibilityRange;
use bevy::light::{NotShadowCaster, NotShadowReceiver};
use bevy::prelude::*;
use bevy::world_serialization::WorldAssetRoot;

use asset_pipe::desc::{AssetDesc, ColliderDesc};

use crate::render_budget::detail::KeepDetail;
use crate::render_budget::{Actor, EffectiveRanges, Scenery, SceneryRanges};

mod impostor;

pub use impostor::{ImpostorExt, ImpostorMat, atlas_of};

/// A loaded `.asset.ron`.
#[derive(Asset, TypePath, Debug, Clone)]
pub struct CookedAsset {
    pub desc: AssetDesc,
    /// Asset-relative folder of the sidecar (LOD / atlas file names are relative to it).
    pub dir: String,
}

#[derive(Default, TypePath)]
struct CookedLoader;

impl AssetLoader for CookedLoader {
    type Asset = CookedAsset;
    type Settings = ();
    type Error = std::io::Error;

    async fn load(&self, reader: &mut dyn Reader, _: &(), ctx: &mut LoadContext<'_>) -> Result<CookedAsset, Self::Error> {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await?;
        let text = std::str::from_utf8(&bytes).map_err(std::io::Error::other)?;
        let desc = AssetDesc::from_ron(text).map_err(std::io::Error::other)?;
        let dir = ctx.path().path().parent().map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        Ok(CookedAsset { desc, dir })
    }

    fn extensions(&self) -> &[&str] {
        &["asset.ron"]
    }
}

/// On the root [`spawn`] returns: which asset it shows.
#[derive(Component, Clone, Debug)]
pub struct CookedInstance {
    pub handle: Handle<CookedAsset>,
}

/// The root's children exist now.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct CookedBuilt;

/// On each LOD's scene root: its index and distance window in metres at High quality
/// (`None` = from the camera / to the view distance).
#[derive(Component, Clone, Copy, Debug)]
pub struct CookedLod {
    pub index: usize,
    pub window: LodWindow,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LodWindow {
    pub from: Option<f32>,
    pub to: Option<f32>,
}

/// On every mesh entity that carries a LOD's `VisibilityRange`: the unscaled window it came from.
#[derive(Component, Clone, Copy, Debug)]
pub struct LodRange(pub LodWindow);

/// The distance policy: turns a window (High-quality metres) into a `VisibilityRange` for the
/// current effective ranges. Replace the resource to change how LODs fade.
#[derive(Resource, Clone, Copy)]
pub struct CookedLodSwitch(pub fn(LodWindow, &EffectiveRanges, f32) -> VisibilityRange);

impl Default for CookedLodSwitch {
    fn default() -> Self {
        CookedLodSwitch(default_switch)
    }
}

/// `scale`: effective view distance over the configured one (the quality preset's detail scale).
fn default_switch(w: LodWindow, eff: &EffectiveRanges, scale: f32) -> VisibilityRange {
    let view = eff.0.view;
    let fade = eff.0.fade.max(0.2);
    let start = w.from.map(|d| d * scale);
    let end = w.to.map_or(view, |d| (d * scale).min(view));
    let start_margin = match start {
        Some(s) => (s - fade / 2.0).max(0.0)..(s + fade / 2.0),
        None => 0.0..0.0,
    };
    VisibilityRange { start_margin, end_margin: (end - fade / 2.0).max(0.0)..(end + fade / 2.0), use_aabb: false }
}

pub struct AssetsPlugin;

impl Plugin for AssetsPlugin {
    fn build(&self, app: &mut App) {
        app.init_asset::<CookedAsset>().init_asset_loader::<CookedLoader>().init_resource::<CookedLodSwitch>();
        if app.is_plugin_added::<bevy::pbr::PbrPlugin>() {
            bevy::asset::embedded_asset!(app, "impostor.wesl");
            app.add_plugins(MaterialPlugin::<ImpostorMat>::default());
        }
        app.add_systems(Update, (build_instances, tag_lod_meshes, rescale_ranges).chain());
        #[cfg(feature = "devtools")]
        devtools::register(app);
    }
}

/// Spawns the cooked asset `path` (`"library/trees/pine"` loads `library/trees/pine.asset.ron`)
/// at `transform` and returns its root.
pub fn spawn(commands: &mut Commands, server: &AssetServer, path: &str, transform: Transform) -> Entity {
    let (file, name) = file_and_name(path);
    commands.spawn((Name::new(name), CookedInstance { handle: server.load(file) }, transform, Visibility::default())).id()
}

/// [`spawn`] for code holding `&mut World` (scripts, exclusive systems).
pub fn spawn_world(world: &mut World, path: &str, transform: Transform) -> Result<Entity, String> {
    let server = world.get_resource::<AssetServer>().cloned().ok_or("no AssetServer")?;
    let (file, name) = file_and_name(path);
    Ok(world.spawn((Name::new(name), CookedInstance { handle: server.load(file) }, transform, Visibility::default())).id())
}

fn file_and_name(path: &str) -> (String, String) {
    let file = if path.ends_with(".asset.ron") { path.to_string() } else { format!("{path}.asset.ron") };
    (file, path.rsplit('/').next().unwrap_or(path).trim_end_matches(".asset.ron").to_string())
}

/// `commands.spawn_cooked(&server, "library/trees/pine", transform)`.
pub trait SpawnCooked {
    fn spawn_cooked(&mut self, server: &AssetServer, path: &str, transform: Transform) -> Entity;
}

impl SpawnCooked for Commands<'_, '_> {
    fn spawn_cooked(&mut self, server: &AssetServer, path: &str, transform: Transform) -> Entity {
        spawn(self, server, path, transform)
    }
}

fn scale_of(eff: &EffectiveRanges, base: Option<&SceneryRanges>) -> f32 {
    base.map_or(1.0, |b| if b.view > 0.0 { eff.0.view / b.view } else { 1.0 })
}

#[allow(clippy::too_many_arguments)]
fn build_instances(
    mut commands: Commands,
    pending: Query<(Entity, &CookedInstance), Without<CookedBuilt>>,
    assets: Res<Assets<CookedAsset>>,
    server: Res<AssetServer>,
    eff: Res<EffectiveRanges>,
    base: Option<Res<SceneryRanges>>,
    switch: Res<CookedLodSwitch>,
    mut meshes: Option<ResMut<Assets<Mesh>>>,
    mut mats: Option<ResMut<Assets<ImpostorMat>>>,
) {
    let scale = scale_of(&eff, base.as_deref());
    for (root, inst) in &pending {
        let Some(asset) = assets.get(&inst.handle) else { continue };
        let (d, dir) = (&asset.desc, &asset.dir);
        let file = |f: &str| if dir.is_empty() { f.to_string() } else { format!("{dir}/{f}") };
        let mut e = commands.entity(root);
        e.insert(CookedBuilt);
        if d.tags.iter().any(|t| t == "actor") {
            e.insert(Actor);
        } else {
            e.insert(Scenery);
        }
        let n = d.lods.len();
        for (i, lod) in d.lods.iter().enumerate() {
            let window = LodWindow { from: (i > 0).then(|| d.lods[i - 1].distance), to: (i + 1 < n || d.impostor.is_some()).then_some(lod.distance) };
            let scene = commands
                .spawn((
                    Name::new(format!("lod{i}")),
                    WorldAssetRoot(server.load(GltfAssetLabel::Scene(0).from_asset(file(&lod.mesh)))),
                    CookedLod { index: i, window },
                    Transform::default(),
                    Visibility::default(),
                    ChildOf(root),
                ))
                .id();
            #[cfg(feature = "physics")]
            if matches!(d.collider, ColliderDesc::Trimesh { lod } if lod == i) {
                use avian3d::prelude::*;
                commands.entity(scene).insert(ColliderConstructorHierarchy::new(ColliderConstructor::TrimeshFromMesh));
                commands.entity(root).insert(RigidBody::Static);
            }
            let _ = scene;
        }
        if let (Some(imp), Some(ms), Some(mt)) = (&d.impostor, meshes.as_deref_mut(), mats.as_deref_mut()) {
            let atlas = impostor::atlas_of(imp, server.load(file(&imp.atlas)));
            let (quad, aabb) = impostor::quad(&atlas);
            let window = LodWindow { from: d.lods.last().map(|l| l.distance), to: imp.max_distance };
            commands.spawn((
                Name::new("impostor"),
                Mesh3d(ms.add(quad)),
                MeshMaterial3d(mt.add(impostor::material(&atlas))),
                aabb,
                // No shadows either way: the LOD meshes (still in the shadow pass) would shade it.
                NotShadowCaster,
                NotShadowReceiver,
                KeepDetail,
                LodRange(window),
                (switch.0)(window, &eff, scale),
                Transform::default(),
                ChildOf(root),
            ));
        }
        #[cfg(feature = "physics")]
        add_collider(&mut commands, root, &d.collider, d.tags.iter().any(|t| t == "dynamic"));
    }
}

#[cfg(feature = "physics")]
fn add_collider(commands: &mut Commands, root: Entity, c: &ColliderDesc, dynamic: bool) {
    use avian3d::prelude::*;
    let v = |a: &[f32; 3]| Vec3::from(*a);
    let shape = match c {
        ColliderDesc::None | ColliderDesc::Trimesh { .. } => return,
        ColliderDesc::Box { center, half } => Collider::compound(vec![(v(center), Quat::IDENTITY, Collider::cuboid(half[0] * 2.0, half[1] * 2.0, half[2] * 2.0))]),
        ColliderDesc::Sphere { center, radius } => Collider::compound(vec![(v(center), Quat::IDENTITY, Collider::sphere(*radius))]),
        ColliderDesc::Capsule { center, radius, half_height } => Collider::compound(vec![(v(center), Quat::IDENTITY, Collider::capsule(*radius, half_height * 2.0))]),
        ColliderDesc::Convex { points } => {
            let pts: Vec<Vec3> = points.iter().map(v).collect();
            match Collider::convex_hull(&pts) {
                Some(c) => c,
                None => return,
            }
        }
    };
    commands.entity(root).insert((shape, if dynamic { RigidBody::Dynamic } else { RigidBody::Static }));
}

/// Gives every mesh that appears under a LOD scene root the LOD's `VisibilityRange` (Bevy applies
/// ranges per mesh entity; glTF scenes spawn them a few frames after the root).
fn tag_lod_meshes(
    mut commands: Commands,
    new: Query<Entity, (Added<Mesh3d>, Without<LodRange>)>,
    parents: Query<&ChildOf>,
    lods: Query<&CookedLod>,
    eff: Res<EffectiveRanges>,
    base: Option<Res<SceneryRanges>>,
    switch: Res<CookedLodSwitch>,
) {
    let scale = scale_of(&eff, base.as_deref());
    for e in &new {
        let mut cur = e;
        for _ in 0..16 {
            if let Ok(l) = lods.get(cur) {
                commands.entity(e).insert((LodRange(l.window), (switch.0)(l.window, &eff, scale), KeepDetail));
                break;
            }
            match parents.get(cur) {
                Ok(p) => cur = p.parent(),
                Err(_) => break,
            }
        }
    }
}

/// Quality changes move the distances: recompute every LOD range when the effective ranges do.
fn rescale_ranges(eff: Res<EffectiveRanges>, base: Option<Res<SceneryRanges>>, switch: Res<CookedLodSwitch>, mut q: Query<(&LodRange, &mut VisibilityRange)>) {
    if !eff.is_changed() {
        return;
    }
    let scale = scale_of(&eff, base.as_deref());
    for (r, mut vr) in &mut q {
        let next = (switch.0)(r.0, &eff, scale);
        if *vr != next {
            *vr = next;
        }
    }
}

// ---------------------------------------------------------------- introspection

/// Which part of an instance is drawn at `dist` metres from the camera, by the nominal windows:
/// `"lod<i>"`, `"impostor"` or `"none"` (what the `VisibilityRange`s should produce).
pub fn active_part(d: &AssetDesc, dist: f32, eff: &EffectiveRanges, scale: f32) -> String {
    let view = eff.0.view;
    if dist >= view {
        return "none".into();
    }
    let n = d.lods.len();
    for (i, l) in d.lods.iter().enumerate() {
        let from = if i == 0 { 0.0 } else { d.lods[i - 1].distance * scale };
        let last = i + 1 == n;
        if dist >= from && (dist < l.distance * scale || (last && d.impostor.is_none())) {
            return format!("lod{i}");
        }
    }
    match &d.impostor {
        Some(imp) if dist < imp.max_distance.map_or(view, |m| (m * scale).min(view)) => "impostor".into(),
        _ => "none".into(),
    }
}

#[cfg(feature = "devtools")]
mod devtools {
    use serde_json::{Value as Json, json};

    use super::*;
    use crate::devtools::{AddControlCommand, params};
    use crate::gfx::MainCamera;

    pub(super) fn register(app: &mut App) {
        app.add_control_command("assets.list", "Cooked asset instances: asset, distance to the main camera, drawn part (lod<i>/impostor/none), triangles", params(&[]), list);
    }

    fn list(world: &mut World, _: Json) -> Result<Json, String> {
        let cam = world.query_filtered::<&GlobalTransform, With<MainCamera>>().iter(world).next().map(|t| t.translation());
        let eff = world.resource::<EffectiveRanges>().clone();
        let scale = scale_of(&eff, world.get_resource::<SceneryRanges>());
        let mut counts = std::collections::BTreeMap::<String, u32>::new();
        let mut items = vec![];
        let rows: Vec<(Entity, Handle<CookedAsset>, Vec3, bool)> =
            world.query::<(Entity, &CookedInstance, &GlobalTransform, Has<CookedBuilt>)>().iter(world).map(|(e, i, t, b)| (e, i.handle.clone(), t.translation(), b)).collect();
        let assets = world.resource::<Assets<CookedAsset>>();
        for (e, h, pos, built) in rows {
            let Some(a) = assets.get(&h) else {
                items.push(json!({"entity": e.to_bits(), "loaded": false}));
                continue;
            };
            let dist = cam.map_or(0.0, |c| c.distance(pos));
            let part = active_part(&a.desc, dist, &eff, scale);
            let tris = part.strip_prefix("lod").and_then(|i| i.parse::<usize>().ok()).and_then(|i| a.desc.lods.get(i)).map_or(0, |l| l.triangles);
            *counts.entry(part.clone()).or_default() += 1;
            items.push(json!({"entity": e.to_bits(), "asset": a.desc.name, "built": built, "distance": dist, "part": part, "triangles": tris, "position": [pos.x, pos.y, pos.z]}));
        }
        Ok(json!({"instances": items, "parts": counts, "view": eff.0.view, "scale": scale}))
    }
}

#[cfg(test)]
mod tests;
