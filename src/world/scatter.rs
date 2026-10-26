//! Rule-based scatter (grass, rocks, trees): deterministic placement from a seed, drawn by
//! camera distance in clusters, collision for big items through the cell system.
//!
//! **Placement** is a jittered grid in absolute world space: grid cell `(gx, gz)` of side
//! `1/sqrt(density)` holds at most one candidate, positioned and filtered by a hash of
//! `(world seed, rule seed, gx, gz)`. Results therefore don't depend on cluster or cell size,
//! load order or frame timing: the same seed always gives the same forest, and colliders
//! (generated per cell) line up with visuals (generated per cluster). Filters: terrain bounds,
//! height band, slope band, a noise mask, exclusion zones (and every prefab's `clear_radius`).
//!
//! **Rendering** per rule, in square clusters of [`ScatterRule::cluster`] metres spawned while
//! the camera is within the rule's `cull` distance:
//! - [`ScatterRender::Merged`] (grass, pebbles): one merged mesh per cluster — one draw call,
//!   no per-instance entity; faded with a dithered `VisibilityRange`.
//! - [`ScatterRender::Instanced`] (trees, big rocks): entities sharing one mesh and material,
//!   which Bevy batches into instanced (multi-draw indirect) calls. With a `far_mesh`, every
//!   item gets a far entity (cheap mesh, no shadows, fading in at `near`) and the detailed near
//!   tier is spawned only for clusters within `near` — both fade per item, so the crossfade is
//!   exact. No per-cluster mesh is allocated for these rules: merged far tiers churned Bevy's
//!   mesh slabs into multi-GB spikes while flying (measured; see docs/WORLD.md).
//!
//! Distances follow the quality preset's detail scale (via the render budget) times
//! [`super::ScatterSettings::distance_scale`].

use std::sync::Arc;

use bevy::asset::RenderAssetUsages;
use bevy::camera::primitives::MeshAabb;
use bevy::camera::visibility::{NoAutoAabb, VisibilityRange};
use bevy::light::NotShadowCaster;
use bevy::math::Affine3A;
use bevy::platform::collections::{HashMap, HashSet};
use bevy::prelude::*;
use bevy::tasks::{AsyncComputeTaskPool, Task, futures::check_ready};
use serde::{Deserialize, Serialize};

use super::heightfield::Heightfield;
use super::hlod::merge_meshes;
use super::noise::{Fbm, Rng64, hash2, mix64};
use super::{WorldCpu, WorldOrigin, WorldRoot, WorldSettings, WorldStats, WorldSystems};
use crate::gfx::MainCamera;
use crate::meshkit::MeshKit;
use crate::render_budget::Scenery;

/// Built-in low-poly meshes (vertex-coloured), or one registered in `WorldAssets::meshes`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ScatterMesh {
    /// A tuft of blades (~0.6 m), double-sided.
    Grass,
    /// Flowers in a tuft (~0.4 m).
    Flowers,
    /// Conifer (~10 m).
    Pine,
    /// Two-cone conifer for the far tier.
    PineLow,
    /// Deciduous tree (~8 m).
    Broadleaf,
    BroadleafLow,
    /// Boulder (~1 m, scale it).
    Rock,
    Bush,
    Named(String),
}

/// How a rule is drawn.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScatterRender {
    #[default]
    Merged,
    Instanced,
}

/// Where scatter never goes.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum Exclusion {
    Circle { center: [f32; 2], radius: f32 },
    Rect { min: [f32; 2], max: [f32; 2] },
}

impl Exclusion {
    #[inline]
    pub fn contains(&self, p: Vec2) -> bool {
        match *self {
            Exclusion::Circle { center, radius } => p.distance_squared(Vec2::from(center)) < radius * radius,
            Exclusion::Rect { min, max } => p.x >= min[0] && p.y >= min[1] && p.x <= max[0] && p.y <= max[1],
        }
    }
    fn overlaps(&self, lo: Vec2, hi: Vec2) -> bool {
        match *self {
            Exclusion::Circle { center, radius } => Vec2::from(center).clamp(lo, hi).distance_squared(Vec2::from(center)) < radius * radius,
            Exclusion::Rect { min, max } => min[0] <= hi.x && min[1] <= hi.y && max[0] >= lo.x && max[1] >= lo.y,
        }
    }
}

/// Collision for big scatter items: an upright cylinder (trunk / boulder).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScatterCollider {
    pub radius: f32,
    pub height: f32,
}

/// One scatter rule.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ScatterRule {
    pub name: String,
    pub mesh: ScatterMesh,
    /// Cheap mesh drawn (merged per cluster) from `near` to `cull` (instanced rules).
    pub far_mesh: Option<ScatterMesh>,
    /// Named material (`WorldAssets`), else a built-in one for the mesh.
    pub material: Option<String>,
    pub render: ScatterRender,
    /// Items per square metre (before filters).
    pub density: f32,
    pub seed: u64,
    /// Cluster side (metres): smaller for dense grass, bigger for sparse trees.
    pub cluster: f32,
    /// Absolute height band (metres).
    pub height: [f32; 2],
    /// Slope band (degrees).
    pub slope: [f32; 2],
    /// Noise mask: an item is kept where `mask(x, z) > threshold` (patches / forests).
    pub mask: Option<Fbm>,
    pub threshold: f32,
    /// Uniform scale range.
    pub scale: [f32; 2],
    /// 0 = upright, 1 = aligned to the ground normal.
    pub align: f32,
    /// Pushed this far into the ground (hides floating bases on slopes).
    pub sink: f32,
    /// Brightness variation per item (0..1).
    pub tint: f32,
    /// Instanced: per-item meshes end here (0 = at `cull`).
    pub near: f32,
    /// Nothing drawn beyond this.
    pub cull: f32,
    /// Crossfade width (metres).
    pub fade: f32,
    pub shadows: bool,
    pub collider: Option<ScatterCollider>,
    pub exclusions: Vec<Exclusion>,
}

impl Default for ScatterRule {
    fn default() -> Self {
        ScatterRule {
            name: String::new(),
            mesh: ScatterMesh::Grass,
            far_mesh: None,
            material: None,
            render: ScatterRender::Merged,
            density: 0.5,
            seed: 0,
            cluster: 32.0,
            height: [-1e6, 1e6],
            slope: [0.0, 35.0],
            mask: None,
            threshold: 0.5,
            scale: [0.8, 1.2],
            align: 0.0,
            sink: 0.05,
            tint: 0.15,
            near: 0.0,
            cull: 80.0,
            fade: 8.0,
            shadows: false,
            collider: None,
            exclusions: Vec::new(),
        }
    }
}

/// One placed item (absolute).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Instance {
    pub pos: Vec3,
    pub rot: Quat,
    pub scale: f32,
    /// Brightness multiplier.
    pub tint: f32,
}

impl Instance {
    pub fn affine(&self, rel_to: Vec3) -> Affine3A {
        Affine3A::from_scale_rotation_translation(Vec3::splat(self.scale), self.rot, self.pos - rel_to)
    }
}

/// Places `rule`'s items whose grid cell lies in absolute `[lo, hi)` (XZ), appending to `out`.
/// Pure and deterministic. `global` are world-wide exclusions (prefab clearings, roads).
pub fn place(rule: &ScatterRule, world_seed: u64, hf: &Heightfield, global: &[Exclusion], lo: Vec2, hi: Vec2, out: &mut Vec<Instance>) {
    if rule.density <= 0.0 {
        return;
    }
    let spacing = 1.0 / rule.density.sqrt();
    let seed = mix64(world_seed ^ mix64(rule.seed ^ 0x5CA7_7E55));
    let excl: Vec<Exclusion> = global.iter().chain(rule.exclusions.iter()).filter(|e| e.overlaps(lo, hi)).copied().collect();
    let g0 = (lo / spacing).ceil().as_ivec2();
    let g1 = (hi / spacing).ceil().as_ivec2();
    let (cos_lo, cos_hi) = (rule.slope[1].to_radians().cos(), rule.slope[0].to_radians().cos());
    for gz in g0.y..g1.y {
        for gx in g0.x..g1.x {
            let mut r = Rng64::new(hash2(seed, gx, gz));
            let p = Vec2::new((gx as f32 + r.f32()) * spacing, (gz as f32 + r.f32()) * spacing);
            let (yaw, s, tint, keep) = (r.f32(), r.f32(), r.f32(), r.f32());
            if !hf.contains(p.x, p.y) {
                continue;
            }
            if let Some(m) = &rule.mask {
                // Soft edge: keep probability ramps over 0.1 above the threshold.
                let v = m.sample01(p);
                if v < rule.threshold || keep > ((v - rule.threshold) / 0.1).min(1.0) {
                    continue;
                }
            }
            let h = hf.height_at(p.x, p.y);
            if h < rule.height[0] || h > rule.height[1] {
                continue;
            }
            let n = hf.smooth_normal_at(p.x, p.y);
            if n.y < cos_lo - 1e-6 || n.y > cos_hi + 1e-6 {
                continue;
            }
            if excl.iter().any(|e| e.contains(p)) {
                continue;
            }
            let up = Vec3::Y.lerp(n, rule.align.clamp(0.0, 1.0)).normalize();
            let rot = Quat::from_rotation_arc(Vec3::Y, up) * Quat::from_rotation_y(yaw * std::f32::consts::TAU);
            let scale = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * s;
            out.push(Instance { pos: Vec3::new(p.x, h - rule.sink * scale, p.y), rot, scale, tint: 1.0 + rule.tint * (tint * 2.0 - 1.0) });
        }
    }
}

/// Built-in meshes (CPU copies; positions in metres, vertex colours).
pub fn builtin_mesh(kind: &ScatterMesh) -> Option<Mesh> {
    let c = |r: f32, g: f32, b: f32| Color::srgb(r, g, b);
    let mut k = MeshKit::new();
    match kind {
        ScatterMesh::Grass | ScatterMesh::Flowers => {
            // Thin blades (one triangle each) leaning out from the centre, coloured dark at the
            // base and light at the tip, all normals up so both faces light like the ground.
            let grass = *kind == ScatterMesh::Grass;
            let blades = if grass { 7 } else { 3 };
            let flower = [c(0.92, 0.80, 0.25), c(0.85, 0.35, 0.55), c(0.95, 0.95, 0.98)];
            let mut tips = Vec::with_capacity(blades);
            for i in 0..blades {
                let a = i as f32 * std::f32::consts::TAU / blades as f32 + 0.4;
                let out = Vec3::new(a.cos(), 0.0, a.sin());
                let side = Vec3::new(-a.sin(), 0.0, a.cos()) * if grass { 0.035 } else { 0.05 };
                let off = out * (0.04 + 0.05 * ((i * 7 % 5) as f32 / 5.0));
                let h = if grass { 0.32 + 0.22 * ((i * 3 % 7) as f32 / 7.0) } else { 0.38 };
                let lean = out * h * 0.35;
                k.tri(off - side, off + side, off + lean + Vec3::Y * h, c(0.17, 0.27, 0.08));
                tips.push(if grass { c(0.40, 0.53, 0.19) } else { flower[i % 3] });
            }
            let mut m = k.build();
            if let Some(bevy::mesh::VertexAttributeValues::Float32x4(col)) = m.attribute_mut(Mesh::ATTRIBUTE_COLOR) {
                for (i, v) in col.iter_mut().enumerate() {
                    if i % 3 == 2 {
                        *v = tips[i / 3].to_linear().to_f32_array();
                    }
                }
            }
            if let Some(bevy::mesh::VertexAttributeValues::Float32x3(n)) = m.attribute_mut(Mesh::ATTRIBUTE_NORMAL) {
                n.iter_mut().for_each(|v| *v = [0.0, 1.0, 0.0]);
            }
            return Some(m);
        }
        ScatterMesh::Pine => {
            k.add(Cylinder::new(0.22, 3.0).mesh().resolution(6).build(), Transform::from_xyz(0.0, 1.5, 0.0), c(0.33, 0.22, 0.13));
            for (i, (r, h, y)) in [(2.2, 4.0, 3.6), (1.7, 3.4, 5.6), (1.1, 2.8, 7.6)].iter().enumerate() {
                let g = 0.20 + 0.03 * i as f32;
                k.add(Cone { radius: *r, height: *h }.mesh().resolution(8).build(), Transform::from_xyz(0.0, *y, 0.0), c(0.10, g, 0.12));
            }
        }
        ScatterMesh::PineLow => {
            k.add(Cylinder::new(0.25, 2.0).mesh().resolution(3).build(), Transform::from_xyz(0.0, 1.0, 0.0), c(0.33, 0.22, 0.13));
            k.add(Cone { radius: 2.1, height: 7.5 }.mesh().resolution(5).build(), Transform::from_xyz(0.0, 5.4, 0.0), c(0.11, 0.22, 0.13));
        }
        ScatterMesh::Broadleaf => {
            k.add(Cylinder::new(0.28, 3.4).mesh().resolution(6).build(), Transform::from_xyz(0.0, 1.7, 0.0), c(0.36, 0.26, 0.16));
            for (o, r, g) in [(Vec3::new(0.0, 4.6, 0.0), 2.3, 0.33), (Vec3::new(1.1, 5.4, 0.6), 1.6, 0.38), (Vec3::new(-0.9, 5.6, -0.7), 1.5, 0.30)] {
                k.add(Sphere::new(r).mesh().ico(1).unwrap(), Transform::from_translation(o), c(0.18, g, 0.10));
            }
        }
        ScatterMesh::BroadleafLow => {
            k.add(Cylinder::new(0.3, 3.4).mesh().resolution(3).build(), Transform::from_xyz(0.0, 1.7, 0.0), c(0.36, 0.26, 0.16));
            k.add(Sphere::new(2.6).mesh().ico(0).unwrap(), Transform::from_xyz(0.0, 5.0, 0.0), c(0.18, 0.33, 0.10));
        }
        ScatterMesh::Rock => {
            let mut m = Sphere::new(0.6).mesh().ico(1).unwrap();
            crate::meshkit::displace(&mut m, |p| {
                let n = super::noise::perlin(7, p.xz() * 2.3 + Vec2::splat(p.y * 1.7));
                p * (0.35 * n) - Vec3::Y * (p.y.min(0.0) * 0.5)
            });
            k.add(m, Transform::from_scale(Vec3::new(1.2, 0.95, 1.0)), c(0.44, 0.43, 0.41));
            return Some(k.build_flat());
        }
        ScatterMesh::Bush => {
            k.add(Sphere::new(0.6).mesh().ico(1).unwrap(), Transform::from_xyz(0.0, 0.4, 0.0), c(0.16, 0.30, 0.10));
            k.add(Sphere::new(0.45).mesh().ico(1).unwrap(), Transform::from_xyz(0.45, 0.35, 0.2), c(0.20, 0.34, 0.12));
        }
        ScatterMesh::Named(_) => return None,
    }
    Some(k.build_flat())
}

/// Rule data shared with build tasks.
pub(crate) struct RuleRt {
    pub rule: ScatterRule,
    /// CPU mesh data for merging (near / far).
    pub near_cpu: Option<Arc<Mesh>>,
    pub far_cpu: Option<Arc<Mesh>>,
    /// GPU handles (instanced near / far meshes) and the material.
    pub near_handle: Option<Handle<Mesh>>,
    pub far_handle: Option<Handle<Mesh>>,
    pub material: Option<Handle<StandardMaterial>>,
}

#[derive(Default)]
struct ClusterRt {
    entity: Option<Entity>,
    task: Option<Task<ClusterBuilt>>,
    instances: u32,
    vertices: u32,
    anchor: Vec3,
    /// Instanced rules with a far mesh: the items (to spawn the near tier when close) and the
    /// near tier's group entity while it exists.
    items: Vec<Instance>,
    near: Option<Entity>,
}

/// A rule's distances at the current scale.
struct Tiers {
    near: f32,
    cull: f32,
    fade: f32,
}

impl Tiers {
    fn of(r: &ScatterRule, scale: f32) -> Tiers {
        let cull = r.cull * scale;
        let fade = r.fade.min(cull * 0.5);
        let near = if r.near > 0.0 && r.far_mesh.is_some() { (r.near * scale).min(cull) } else { cull };
        Tiers { near, cull, fade }
    }
}

/// The detailed tier of an instanced rule under `parent` (fading out at `near`).
fn spawn_near(commands: &mut Commands, rt: &RuleRt, t: &Tiers, items: &[Instance], anchor: Vec3, parent: Entity) {
    let (Some(h), Some(mat)) = (rt.near_handle.clone(), rt.material.clone()) else { return };
    let range = VisibilityRange { start_margin: 0.0..0.0, end_margin: (t.near - t.fade).max(0.0)..t.near, use_aabb: false };
    let item = |i: &Instance| (Mesh3d(h.clone()), MeshMaterial3d(mat.clone()), Transform::from_matrix(Mat4::from(i.affine(anchor))), range.clone(), ChildOf(parent));
    if rt.rule.shadows {
        commands.spawn_batch(items.iter().map(item).collect::<Vec<_>>());
    } else {
        commands.spawn_batch(items.iter().map(|i| (item(i), NotShadowCaster)).collect::<Vec<_>>());
    }
}

struct ClusterBuilt {
    instances: Vec<Instance>,
    merged: Option<Mesh>,
    /// Cluster origin: centre at ground height (Bevy's GPU visibility-range dither measures
    /// distance to the mesh origin, so it must sit where the items are).
    anchor: Vec3,
}

/// Scatter runtime (inserted by the world spawner).
#[derive(Resource)]
pub struct Scatter {
    pub(crate) rules: Vec<Arc<RuleRt>>,
    pub(crate) hf: Arc<Heightfield>,
    pub(crate) exclusions: Arc<Vec<Exclusion>>,
    pub(crate) seed: u64,
    clusters: HashMap<(u16, IVec2), ClusterRt>,
    last_eye: Option<Vec3>,
    last_scale: f32,
    wanted: HashSet<(u16, IVec2)>,
    todo: Vec<(f32, u16, IVec2)>,
}

impl Scatter {
    pub(crate) fn new(rules: Vec<Arc<RuleRt>>, hf: Arc<Heightfield>, exclusions: Vec<Exclusion>, seed: u64) -> Self {
        Scatter { rules, hf, exclusions: Arc::new(exclusions), seed, clusters: HashMap::default(), last_eye: None, last_scale: 0.0, wanted: HashSet::default(), todo: Vec::new() }
    }
    pub fn rules(&self) -> impl Iterator<Item = &ScatterRule> {
        self.rules.iter().map(|r| &r.rule)
    }
    /// Items of rule `index` in absolute `[lo, hi)`.
    pub fn place(&self, index: usize, lo: Vec2, hi: Vec2) -> Vec<Instance> {
        let mut v = Vec::new();
        place(&self.rules[index].rule, self.seed, &self.hf, &self.exclusions, lo, hi, &mut v);
        v
    }
    /// Live clusters (spawned or building).
    pub fn cluster_count(&self) -> usize {
        self.clusters.len()
    }
}

pub(super) struct ScatterPlugin;

impl Plugin for ScatterPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostUpdate, stream_clusters.in_set(WorldSystems::Scatter));
    }
}

fn rect_dist(lo: Vec2, size: f32, p: Vec2) -> f32 {
    (p.clamp(lo, lo + Vec2::splat(size)) - p).length()
}

fn stream_clusters(
    mut commands: Commands,
    scatter: Option<ResMut<Scatter>>,
    settings: Res<WorldSettings>,
    origin: Res<WorldOrigin>,
    cams: Query<&GlobalTransform, With<MainCamera>>,
    roots: Query<Entity, With<WorldRoot>>,
    mut meshes: Option<ResMut<Assets<Mesh>>>,
    render: Option<Res<Assets<StandardMaterial>>>,
    eff: Option<Res<crate::render_budget::EffectiveRanges>>,
    ranges: Option<Res<crate::render_budget::SceneryRanges>>,
    mut stats: ResMut<WorldStats>,
    cpu: Res<WorldCpu>,
) {
    let _t = cpu.time();
    let (Some(mut sc), Some(meshes), Some(_)) = (scatter, meshes.as_mut(), render) else { return };
    let Some(root) = roots.iter().next() else { return };
    let s = &settings.scatter;
    let quality = match (s.follow_quality, eff, ranges) {
        (true, Some(e), Some(r)) if r.view > 0.0 => e.0.view / r.view,
        _ => 1.0,
    };
    let scale = s.distance_scale * quality;
    let sc = &mut *sc;
    let eye = super::camera_abs(&cams, &origin);
    // Re-evaluate the wanted set when the camera moved ≥ 4 m or the scale changed.
    let moved = match (eye, sc.last_eye) {
        (Some(e), Some(l)) => e.xz().distance(l.xz()) >= 4.0,
        (Some(_), None) => true,
        _ => false,
    };
    if !s.enabled {
        for (_, c) in sc.clusters.drain() {
            if let Some(e) = c.entity {
                commands.entity(e).try_despawn();
            }
        }
        sc.last_eye = None;
        stats.scatter_clusters = 0;
        stats.scatter_instances = 0;
        stats.scatter_vertices = 0;
        return;
    }
    if (moved || scale != sc.last_scale || s.resident) && (eye.is_some() || s.resident) {
        sc.last_eye = eye;
        sc.last_scale = scale;
        sc.wanted.clear();
        let (lo_w, hi_w) = (sc.hf.origin(), sc.hf.origin() + sc.hf.size());
        for (ri, r) in sc.rules.iter().enumerate() {
            let size = r.rule.cluster.max(4.0);
            let reach = r.rule.cull * scale;
            let (lo, hi) = match (s.resident, eye) {
                (false, Some(e)) => (e.xz() - Vec2::splat(reach), e.xz() + Vec2::splat(reach)),
                _ => (lo_w, hi_w),
            };
            let (lo, hi) = (lo.max(lo_w), hi.min(hi_w));
            let c0 = (lo / size).floor().as_ivec2();
            let c1 = (hi / size).floor().as_ivec2();
            for cz in c0.y..=c1.y {
                for cx in c0.x..=c1.x {
                    let key = (ri as u16, IVec2::new(cx, cz));
                    let near = s.resident || eye.is_some_and(|e| rect_dist(key.1.as_vec2() * size, size, e.xz()) <= reach);
                    if near {
                        sc.wanted.insert(key);
                    }
                }
            }
        }
    }
    // Despawn clusters no longer wanted (beyond reach + hysteresis).
    let hyst = s.hysteresis;
    let rules = sc.rules.clone();
    let wanted = &sc.wanted;
    sc.clusters.retain(|key, c| {
        if wanted.contains(key) {
            return true;
        }
        let r = &rules[key.0 as usize].rule;
        let size = r.cluster.max(4.0);
        let keep = !s.resident && eye.is_some_and(|e| rect_dist(key.1.as_vec2() * size, size, e.xz()) <= r.cull * scale + hyst);
        if !keep && let Some(e) = c.entity {
            commands.entity(e).try_despawn();
        }
        keep
    });
    // Finish builds (a budget of spawned items per frame, so a pose change doesn't spike).
    let mut in_flight = 0;
    let mut spawn_left = if s.resident { usize::MAX } else { s.max_items_per_frame.max(1) };
    let item_budget = |n: usize, left: &mut usize| *left = left.saturating_sub(n.max(1));
    for (key, c) in sc.clusters.iter_mut() {
        let Some(task) = c.task.as_mut() else { continue };
        if spawn_left == 0 {
            in_flight += 1;
            continue;
        }
        let Some(built) = check_ready(task) else {
            in_flight += 1;
            continue;
        };
        c.task = None;
        let rt = &sc.rules[key.0 as usize];
        let r = &rt.rule;
        let tiers = Tiers::of(r, scale);
        c.anchor = built.anchor;
        c.instances = built.instances.len() as u32;
        let pid = commands
            .spawn((
                Name::new(format!("scatter {} {} {}", r.name, key.1.x, key.1.y)),
                Transform::from_translation(c.anchor),
                Visibility::default(),
                Scenery,
                ChildOf(root),
            ))
            .id();
        c.entity = Some(pid);
        let Some(mat) = rt.material.clone() else { continue };
        if let Some(mesh) = built.merged {
            // Merged rule: one mesh for the whole cluster.
            c.vertices += mesh.count_vertices() as u32;
            item_budget(1, &mut spawn_left);
            let aabb = mesh.compute_aabb().unwrap_or_default();
            let mut mesh = mesh;
            mesh.asset_usage = RenderAssetUsages::RENDER_WORLD;
            let range = VisibilityRange { start_margin: 0.0..0.0, end_margin: (tiers.cull - tiers.fade)..tiers.cull, use_aabb: false };
            let mut e = commands.spawn((Mesh3d(meshes.add(mesh)), MeshMaterial3d(mat), Transform::default(), range, aabb, NoAutoAabb, ChildOf(pid)));
            if !r.shadows {
                e.insert(NotShadowCaster);
            }
            continue;
        }
        if r.render != ScatterRender::Instanced {
            continue;
        }
        item_budget(built.instances.len(), &mut spawn_left);
        match rt.far_handle.clone() {
            // Far tier: every item with the cheap shared mesh, fading in at `near`. The detailed
            // near tier is spawned only while the cluster is close (below).
            Some(far) => {
                let range = VisibilityRange { start_margin: (tiers.near - tiers.fade).max(0.0)..tiers.near, end_margin: (tiers.cull - tiers.fade)..tiers.cull, use_aabb: false };
                let anchor = c.anchor;
                commands.spawn_batch(
                    built.instances.iter().map(|i| (Mesh3d(far.clone()), MeshMaterial3d(mat.clone()), Transform::from_matrix(Mat4::from(i.affine(anchor))), range.clone(), NotShadowCaster, ChildOf(pid))).collect::<Vec<_>>(),
                );
                c.vertices += rt.far_cpu.as_ref().map_or(0, |m| m.count_vertices()) as u32 * c.instances;
                c.items = built.instances;
            }
            None => {
                spawn_near(&mut commands, rt, &tiers, &built.instances, c.anchor, pid);
                c.vertices += rt.near_cpu.as_ref().map_or(0, |m| m.count_vertices()) as u32 * c.instances;
            }
        }
    }
    // Near tiers of instanced rules with a far mesh: spawned while the cluster is within reach.
    if let Some(eye) = eye {
        for (key, c) in sc.clusters.iter_mut() {
            if c.items.is_empty() {
                continue;
            }
            let Some(pid) = c.entity else { continue };
            let rt = &sc.rules[key.0 as usize];
            let tiers = Tiers::of(&rt.rule, scale);
            let size = rt.rule.cluster.max(4.0);
            let d = rect_dist(key.1.as_vec2() * size, size, eye.xz());
            let want = if c.near.is_some() { d <= tiers.near + hyst } else { d <= tiers.near };
            match (want, c.near) {
                (true, None) if spawn_left > 0 => {
                    item_budget(c.items.len(), &mut spawn_left);
                    let group = commands.spawn((Transform::default(), Visibility::default(), ChildOf(pid))).id();
                    spawn_near(&mut commands, rt, &tiers, &c.items, c.anchor, group);
                    c.near = Some(group);
                }
                (false, Some(group)) => {
                    commands.entity(group).try_despawn();
                    c.near = None;
                }
                _ => {}
            }
        }
    }
    // Start builds, nearest first.
    sc.todo.clear();
    for key in sc.wanted.iter() {
        if sc.clusters.contains_key(key) {
            continue;
        }
        let size = sc.rules[key.0 as usize].rule.cluster.max(4.0);
        let d = eye.map_or(0.0, |e| rect_dist(key.1.as_vec2() * size, size, e.xz()));
        sc.todo.push((d, key.0, key.1));
    }
    sc.todo.sort_by(|a, b| a.0.total_cmp(&b.0));
    let pool = AsyncComputeTaskPool::get();
    let max = if s.resident { usize::MAX } else { s.max_builds_in_flight };
    let todo = std::mem::take(&mut sc.todo);
    for &(_, ri, cell) in todo.iter() {
        if in_flight >= max {
            break;
        }
        let rt = sc.rules[ri as usize].clone();
        let (hf, excl, seed) = (sc.hf.clone(), sc.exclusions.clone(), sc.seed);
        let task = pool.spawn(async move {
            let size = rt.rule.cluster.max(4.0);
            let lo = cell.as_vec2() * size;
            let mut instances = Vec::new();
            place(&rt.rule, seed, &hf, &excl, lo, lo + Vec2::splat(size), &mut instances);
            let anchor = cluster_anchor(&hf, cell, size);
            // Only merged rules build a mesh per cluster (instanced tiers share meshes: no
            // per-cluster GPU allocations, which fragmented Bevy's mesh slabs under churn).
            let merge_src = if rt.rule.render == ScatterRender::Merged { rt.near_cpu.clone() } else { None };
            let merged = merge_src.filter(|_| !instances.is_empty()).map(|m| merge_meshes(instances.iter().map(|i| (&*m, i.affine(anchor), [i.tint, i.tint, i.tint, 1.0]))));
            ClusterBuilt { instances, merged, anchor }
        });
        sc.clusters.insert((ri, cell), ClusterRt { task: Some(task), ..default() });
        in_flight += 1;
    }
    sc.todo = todo;
    stats.scatter_clusters = sc.clusters.values().filter(|c| c.entity.is_some()).count() as u32;
    stats.scatter_instances = sc.clusters.values().map(|c| c.instances as u64).sum();
    stats.scatter_vertices = sc.clusters.values().map(|c| c.vertices as u64).sum();
    stats.scatter_builds_in_flight = in_flight as u32;
    if stats.scatter_rules.len() != sc.rules.len() {
        stats.scatter_rules = sc.rules.iter().map(|r| (r.rule.name.clone(), 0, 0, 0)).collect();
    }
    for r in stats.scatter_rules.iter_mut() {
        (r.1, r.2, r.3) = (0, 0, 0);
    }
    for ((ri, _), c) in sc.clusters.iter() {
        if c.entity.is_some() {
            let r = &mut stats.scatter_rules[*ri as usize];
            r.1 += 1;
            r.2 += c.instances as u64;
            r.3 += c.vertices as u64;
        }
    }
}

/// Origin of a cluster's entities: its centre, on the ground. Bevy's GPU visibility-range
/// dither measures the distance to the mesh origin, so it must sit where the items are.
pub fn cluster_anchor(hf: &Heightfield, cell: IVec2, size: f32) -> Vec3 {
    let c = (cell.as_vec2() + Vec2::splat(0.5)) * size;
    Vec3::new(c.x, hf.height_at(c.x, c.y), c.y)
}

/// Built-in material for a built-in mesh (vertex colours × white; grass double-sided).
pub(crate) fn builtin_material(kind: &ScatterMesh) -> StandardMaterial {
    let grassy = matches!(kind, ScatterMesh::Grass | ScatterMesh::Flowers);
    StandardMaterial {
        base_color: Color::WHITE,
        perceptual_roughness: if grassy { 0.8 } else { 0.9 },
        // Both faces drawn, normals not flipped for back faces (blades light like the ground).
        double_sided: false,
        cull_mode: if grassy { None } else { Some(bevy::render::render_resource::Face::Back) },
        ..default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hills() -> Heightfield {
        Heightfield::from_fn(129, 129, 2.0, Vec2::splat(-128.0), |x, z| (x * 0.03).sin() * 10.0 + (z * 0.02).cos() * 8.0 + x.max(0.0) * 0.5)
    }

    #[test]
    fn deterministic_and_partition_independent() {
        let hf = hills();
        let rule = ScatterRule { density: 0.2, seed: 3, mask: Some(Fbm { frequency: 0.02, ..default() }), threshold: 0.45, ..default() };
        let mut whole = Vec::new();
        place(&rule, 42, &hf, &[], Vec2::splat(-128.0), Vec2::splat(128.0), &mut whole);
        assert!(whole.len() > 300, "{}", whole.len());
        // Same again.
        let mut again = Vec::new();
        place(&rule, 42, &hf, &[], Vec2::splat(-128.0), Vec2::splat(128.0), &mut again);
        assert_eq!(whole, again);
        // As 16 clusters of 64 m: the same set.
        let mut parts = Vec::new();
        for cz in -2..2 {
            for cx in -2..2 {
                let lo = Vec2::new(cx as f32, cz as f32) * 64.0;
                place(&rule, 42, &hf, &[], lo, lo + Vec2::splat(64.0), &mut parts);
            }
        }
        let key = |v: &Vec<Instance>| {
            let mut k: Vec<(i64, i64)> = v.iter().map(|i| ((i.pos.x * 1000.0) as i64, (i.pos.z * 1000.0) as i64)).collect();
            k.sort();
            k
        };
        assert_eq!(key(&whole), key(&parts));
        // Another seed: a different set.
        let mut other = Vec::new();
        place(&rule, 43, &hf, &[], Vec2::splat(-128.0), Vec2::splat(128.0), &mut other);
        assert_ne!(key(&whole), key(&other));
    }

    #[test]
    fn filters_apply() {
        let hf = hills();
        let rule = ScatterRule { density: 0.5, height: [0.0, 1e6], slope: [0.0, 20.0], ..default() };
        let ex = [Exclusion::Circle { center: [0.0, 0.0], radius: 30.0 }, Exclusion::Rect { min: [50.0, -128.0], max: [60.0, 128.0] }];
        let mut v = Vec::new();
        place(&rule, 1, &hf, &ex, Vec2::splat(-128.0), Vec2::splat(128.0), &mut v);
        assert!(!v.is_empty());
        for i in &v {
            let p = i.pos.xz();
            assert!(hf.height_at(p.x, p.y) >= 0.0);
            assert!(hf.slope_deg(p.x, p.y) <= 20.5);
            assert!(p.length() >= 30.0 && !(50.0..=60.0).contains(&p.x));
            assert!(i.scale >= 0.8 && i.scale <= 1.2);
        }
    }

    #[test]
    fn builtin_meshes_build() {
        for m in [ScatterMesh::Grass, ScatterMesh::Flowers, ScatterMesh::Pine, ScatterMesh::PineLow, ScatterMesh::Broadleaf, ScatterMesh::BroadleafLow, ScatterMesh::Rock, ScatterMesh::Bush] {
            let mesh = builtin_mesh(&m).expect("mesh");
            assert!(mesh.count_vertices() > 0, "{m:?}");
        }
        assert!(builtin_mesh(&ScatterMesh::PineLow).unwrap().count_vertices() * 3 < builtin_mesh(&ScatterMesh::Pine).unwrap().count_vertices());
    }

    #[test]
    fn grass_cluster_mesh_sits_on_the_ground() {
        use bevy::camera::primitives::MeshAabb;
        let hf = Heightfield::flat(33, 33, 1.0, Vec2::ZERO, 10.0);
        let rule = ScatterRule { density: 2.0, ..default() };
        let mut v = Vec::new();
        place(&rule, 1, &hf, &[], Vec2::ZERO, Vec2::splat(16.0), &mut v);
        let g = builtin_mesh(&ScatterMesh::Grass).unwrap();
                let m = merge_meshes(v.iter().map(|i| (&g, i.affine(Vec3::ZERO), [1.0; 4])));
        let a = m.compute_aabb().unwrap();
                assert!(a.min().y > 9.8 && a.max().y < 10.8, "{a:?}");
        // Cluster origins sit on the ground at the centre (not at y = 0).
        let hill = Heightfield::flat(65, 65, 2.0, Vec2::ZERO, 150.0);
        assert_eq!(cluster_anchor(&hill, IVec2::new(1, 2), 16.0), Vec3::new(24.0, 150.0, 40.0));
    }

    fn default<T: Default>() -> T {
        T::default()
    }
}
