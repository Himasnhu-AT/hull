//! Distance detail for [`Scenery`] meshes, never [`Actor`]s.
//!
//! Every mesh is classified once (when its bounds are known) as actor, scenery or other
//! ([`BudgetClass`]). Tags decide first ([`Actor`] / [`Scenery`] on the mesh or an ancestor).
//! Untagged meshes are classified automatically (`RenderBudget::auto_classify`, on): under a
//! camera, skinned/morphed, or under a non-static avian `RigidBody` → [`AutoActor`] at once;
//! otherwise they are watched ([`Settling`]) and become [`AutoScenery`] after
//! `RenderBudget::settle_frames` frames without moving, or [`AutoActor`] as soon as they move.
//! Auto scenery that moves later is demoted to an actor (full detail, shadows back). Scenery meshes get a [`DetailTier`] and a Bevy `VisibilityRange`
//! (dithered crossfade over [`SceneryRanges::fade`] metres, so nothing pops):
//!
//! | tier | what | visible |
//! |---|---|---|
//! | `Small` | largest side < `small_size` | `0 .. small_props` |
//! | `Near`  | anything bigger: the piece itself | `0 .. far` |
//! | `Far`   | a child twin of a `Near` piece: the game's [`FarLook`], else the same mesh with a flat untextured material, never casts shadows | `far .. view` |
//!
//! Small scenery that casts shadows stops doing so beyond [`SceneryRanges::shadow`] (checked
//! when the camera has moved ≥ 1 m). Big pieces keep their shadows while near (their far twin
//! casts none): a building's shadow vanishing at mid range is visible, a crate's is not. Meshes under a `Scenery` root are sized by their
//! extent from the root's origin, so the wheel of a parked truck counts as part of a big piece.
//!
//! Skipped: [`KeepDetail`] pieces, meshes that already have a `VisibilityRange` (the game's own
//! LOD), meshes with `NoFrustumCulling`.

use bevy::camera::primitives::Aabb;
use bevy::camera::visibility::{NoFrustumCulling, VisibilityRange};
use bevy::light::NotShadowCaster;
use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use bevy::render::render_resource::TextureFormat;

use super::{Actor, EffectiveRanges, RenderBudget, RenderBudgetSystems, RenderStats, Scenery, SceneryRanges};
use crate::gfx::MainCamera;

/// What the render budget considers a mesh. Inserted once on every `Mesh3d` entity.
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub enum BudgetClass {
    /// Under an [`Actor`]: always full detail.
    Actor,
    /// Under [`Scenery`].
    Scenery,
    /// Untagged (counted, never changed).
    Other,
}

/// Detail level the engine manages on a scenery mesh (see the module docs).
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetailTier {
    Small,
    Near,
    Far,
}

/// Keep this scenery piece (or mesh) at full detail and shadows at any distance.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct KeepDetail;

/// The far version of a scenery mesh: what draws beyond [`SceneryRanges::far`]. `None` fields
/// fall back to the near mesh / an automatic flat material.
///
/// ```ignore
/// commands.spawn((Scenery, Mesh3d(tower), MeshMaterial3d(stone), FarLook::new(tower_lo, flat_grey), tf));
/// ```
#[derive(Component, Clone, Debug, Default)]
pub struct FarLook {
    pub mesh: Option<Handle<Mesh>>,
    pub material: Option<Handle<StandardMaterial>>,
}

impl FarLook {
    pub fn new(mesh: Handle<Mesh>, material: Handle<StandardMaterial>) -> Self {
        FarLook { mesh: Some(mesh), material: Some(material) }
    }
    pub fn material(material: Handle<StandardMaterial>) -> Self {
        FarLook { mesh: None, material: Some(material) }
    }
}

/// An untagged mesh being watched: it becomes [`AutoScenery`] if it stays put for
/// `RenderBudget::settle_frames`, an [`AutoActor`] if it moves.
#[derive(Component, Clone, Copy, Debug)]
pub struct Settling {
    age: u32,
    at: GlobalTransform,
}

/// Untagged mesh the engine decided is scenery (it hasn't moved). Moving it turns it into an
/// [`AutoActor`] (full detail again).
#[derive(Component, Clone, Copy, Debug)]
pub struct AutoScenery {
    /// Where it settled (a rewrite of the same transform, e.g. when it gains children, is not a move).
    at: GlobalTransform,
}

/// Untagged mesh the engine decided is an actor (it moved, is skinned/morphed, sits under a
/// camera or a non-static physics body). Never demoted back.
#[derive(Component, Clone, Copy, Debug)]
pub struct AutoActor;

#[cfg(feature = "physics")]
type Body = avian3d::prelude::RigidBody;
#[cfg(feature = "physics")]
fn is_dynamic(b: &Body) -> bool {
    !b.is_static()
}
/// Stand-in without physics (never present).
#[cfg(not(feature = "physics"))]
#[derive(Component)]
struct Body;
#[cfg(not(feature = "physics"))]
fn is_dynamic(_: &Body) -> bool {
    false
}

/// What the hierarchy above a mesh says about it.
#[derive(bevy::ecs::system::SystemParam)]
struct Tags<'w, 's> {
    nodes: Query<'w, 's, (Option<&'static ChildOf>, Has<Actor>, Has<Scenery>, Has<AutoScenery>, Has<KeepDetail>, Has<Camera>, &'static GlobalTransform)>,
    bodies: Query<'w, 's, &'static Body>,
    animated: Query<'w, 's, (), Or<(With<bevy::mesh::skinning::SkinnedMesh>, With<bevy::mesh::morph::MeshMorphWeights>)>>,
}

/// Untagged result of [`find_class`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Found {
    Tagged(BudgetClass),
    /// No tag; `true` = something marks it as moving (camera child, physics body, skinned).
    Untagged(bool),
}

/// Small scenery mesh that cast shadows when classified: shadow trimming may toggle
/// `NotShadowCaster` on it.
#[derive(Component, Clone, Copy, Debug)]
pub struct ShadowTrimmable;

/// Near material → automatic far material, plus far materials still waiting for their
/// texture to load (to pick up its average colour).
#[derive(Resource, Default)]
pub struct FarMaterials {
    by_near: HashMap<AssetId<StandardMaterial>, Handle<StandardMaterial>>,
    pending: Vec<(Handle<Image>, Color, Handle<StandardMaterial>)>,
}

pub(super) struct DetailPlugin;

impl Plugin for DetailPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<FarMaterials>().add_systems(
            PostUpdate,
            (settle, demote_moved, classify_meshes, update_ranges, trim_shadows, refine_far_materials)
                .chain()
                .in_set(RenderBudgetSystems::Detail),
        );
    }
}

/// Distance that hides nothing / never shows (abrupt edge, no crossfade).
const NEVER: f32 = 1.0e7;

/// The `VisibilityRange` for a tier. `on = false` (detail off): near tiers always visible,
/// far twins never.
pub fn tier_range(tier: DetailTier, r: &SceneryRanges, on: bool) -> VisibilityRange {
    let fade = r.fade.max(0.0);
    let far = r.far.max(fade);
    let view = r.view.max(far + fade);
    let small = r.small_props.max(fade);
    let range = |start: f32, end: f32| VisibilityRange {
        start_margin: (start - if start > 0.0 { fade } else { 0.0 }).max(0.0)..start,
        end_margin: (end - fade)..end,
        use_aabb: false,
    };
    match (tier, on) {
        (DetailTier::Small | DetailTier::Near, false) => VisibilityRange::abrupt(0.0, NEVER),
        (DetailTier::Far, false) => VisibilityRange::abrupt(NEVER, NEVER),
        (DetailTier::Small, true) => range(0.0, small),
        (DetailTier::Near, true) => range(0.0, far),
        (DetailTier::Far, true) => range(far, view),
    }
}

/// Size used to pick a tier: the mesh's largest world-space side, or for a part of a bigger
/// piece, twice its farthest reach from the piece's origin.
pub fn piece_size(aabb: &Aabb, gt: &GlobalTransform, root: Option<Vec3>) -> f32 {
    let (scale, _, _) = gt.to_scale_rotation_translation();
    let half = Vec3::from(aabb.half_extents) * scale.abs();
    let own = 2.0 * half.max_element();
    match root {
        Some(origin) => {
            let center = gt.transform_point(Vec3::from(aabb.center));
            own.max(2.0 * ((center - origin).length() + half.length()))
        }
        None => own,
    }
}

/// Walks up from a mesh: the first `Actor` / `Scenery` ancestor (or self) decides. Returns the
/// class, whether `KeepDetail` was seen on the way, and the scenery root (when not self).
fn find_class(e: Entity, tags: &Tags) -> (Found, bool, Option<Vec3>) {
    let mut cur = e;
    let mut keep = false;
    let mut dynamic = tags.animated.contains(e);
    for depth in 0..16 {
        let Ok((parent, actor, scenery, auto, k, cam, gt)) = tags.nodes.get(cur) else { break };
        keep |= k;
        if actor {
            return (Found::Tagged(BudgetClass::Actor), keep, None);
        }
        if scenery || (auto && depth == 0) {
            return (Found::Tagged(BudgetClass::Scenery), keep, (depth > 0).then(|| gt.translation()));
        }
        dynamic |= cam || tags.bodies.get(cur).is_ok_and(is_dynamic);
        match parent {
            Some(p) => cur = p.parent(),
            None => break,
        }
    }
    (Found::Untagged(dynamic), keep, None)
}

/// Settling meshes: moved → actor; still after `settle_frames` → scenery (re-classified).
fn settle(mut commands: Commands, budget: Res<RenderBudget>, mut q: Query<(Entity, &GlobalTransform, &mut Settling)>) {
    for (e, gt, mut s) in &mut q {
        if moved(&s.at, gt) {
            commands.entity(e).remove::<Settling>().insert((BudgetClass::Actor, AutoActor));
        } else if s.age >= budget.settle_frames {
            commands.entity(e).remove::<(Settling, BudgetClass)>().insert(AutoScenery { at: s.at });
        } else {
            s.age += 1;
        }
    }
}

fn moved(a: &GlobalTransform, b: &GlobalTransform) -> bool {
    let (a, b) = (a.affine(), b.affine());
    a.translation.distance_squared(b.translation) > 1e-6 || !a.matrix3.abs_diff_eq(b.matrix3, 1e-4)
}

/// Automatic scenery that moved: back to full detail as an actor (twin despawned, ranges and
/// trimmed shadows removed).
fn demote_moved(
    mut commands: Commands,
    q: Query<(Entity, &AutoScenery, &GlobalTransform, Option<&Children>, Has<ShadowTrimmable>), Changed<GlobalTransform>>,
    tiers: Query<&DetailTier>,
) {
    for (e, auto, gt, children, trimmable) in &q {
        if !moved(&auto.at, gt) {
            continue;
        }
        let mut ec = commands.entity(e);
        ec.remove::<(AutoScenery, DetailTier, VisibilityRange, ShadowTrimmable)>().insert((BudgetClass::Actor, AutoActor));
        if trimmable {
            ec.remove::<NotShadowCaster>();
        }
        for c in children.into_iter().flatten() {
            if tiers.get(*c) == Ok(&DetailTier::Far) {
                commands.entity(*c).despawn();
            }
        }
    }
}

fn classify_meshes(
    mut commands: Commands,
    budget: Res<RenderBudget>,
    eff: Res<EffectiveRanges>,
    new: Query<
        (
            Entity,
            &GlobalTransform,
            Option<&Aabb>,
            &Mesh3d,
            Option<&MeshMaterial3d<StandardMaterial>>,
            Option<&FarLook>,
            Has<VisibilityRange>,
            Has<NotShadowCaster>,
            Has<NoFrustumCulling>,
        ),
        Without<BudgetClass>,
    >,
    tags: Tags,
    mut far_mats: ResMut<FarMaterials>,
    mut materials: Option<ResMut<Assets<StandardMaterial>>>,
    images: Option<Res<Assets<Image>>>,
    cpu: Res<super::BudgetCpu>,
) {
    let _cpu = cpu.time();
    let r = &eff.0;
    for (e, gt, aabb, mesh, mat, far_look, has_range, no_shadow, no_cull) in &new {
        let (found, keep, root) = find_class(e, &tags);
        let class = match found {
            Found::Tagged(c) => c,
            Found::Untagged(true) if budget.auto_classify => {
                commands.entity(e).insert((BudgetClass::Actor, AutoActor));
                continue;
            }
            Found::Untagged(false) if budget.auto_classify && !keep && !has_range && !no_cull => {
                commands.entity(e).insert((BudgetClass::Other, Settling { age: 0, at: *gt }));
                continue;
            }
            Found::Untagged(_) => BudgetClass::Other,
        };
        if class != BudgetClass::Scenery || keep || has_range || no_cull {
            commands.entity(e).insert(class);
            continue;
        }
        // Scenery: wait for bounds (the mesh asset may still be loading).
        let Some(aabb) = aabb else { continue };
        let mut ec = commands.entity(e);
        ec.insert(BudgetClass::Scenery);
        if piece_size(aabb, gt, root) < r.small_size {
            ec.insert((DetailTier::Small, tier_range(DetailTier::Small, r, budget.scenery_detail)));
            if !no_shadow {
                ec.insert(ShadowTrimmable);
            }
            continue;
        }
        ec.insert((DetailTier::Near, tier_range(DetailTier::Near, r, budget.scenery_detail)));
        let far_mesh = far_look.and_then(|f| f.mesh.clone()).unwrap_or_else(|| mesh.0.clone());
        let far_mat = match (far_look.and_then(|f| f.material.clone()), mat, materials.as_mut()) {
            (Some(m), ..) => Some(m),
            (None, Some(near), Some(mats)) => Some(far_mats.far_for(&near.0, mats, images.as_deref())),
            _ => None,
        };
        let Some(far_mat) = far_mat else { continue };
        commands.spawn((
            Name::new("far detail"),
            DetailTier::Far,
            BudgetClass::Scenery,
            Mesh3d(far_mesh),
            MeshMaterial3d(far_mat),
            NotShadowCaster,
            tier_range(DetailTier::Far, r, budget.scenery_detail),
            Transform::IDENTITY,
            // Right from the first frame (propagation runs before us).
            *gt,
            ChildOf(e),
        ));
    }
}

impl FarMaterials {
    /// The automatic far material for `near`: same colour (times its texture's average), no
    /// textures, fully rough.
    fn far_for(&mut self, near: &Handle<StandardMaterial>, mats: &mut Assets<StandardMaterial>, images: Option<&Assets<Image>>) -> Handle<StandardMaterial> {
        if let Some(h) = self.by_near.get(&near.id()) {
            return h.clone();
        }
        let Some(src) = mats.get(near) else {
            // Not loaded: a neutral placeholder keyed to it (rare for scenery made in code).
            let h = mats.add(StandardMaterial { base_color: Color::srgb(0.5, 0.5, 0.5), perceptual_roughness: 1.0, ..default() });
            self.by_near.insert(near.id(), h.clone());
            return h;
        };
        let tint = src.base_color;
        let tex = src.base_color_texture.clone();
        let mut far = StandardMaterial {
            base_color: tint,
            emissive: src.emissive,
            perceptual_roughness: 1.0,
            metallic: 0.0,
            reflectance: 0.3,
            alpha_mode: src.alpha_mode,
            unlit: src.unlit,
            fog_enabled: src.fog_enabled,
            double_sided: src.double_sided,
            cull_mode: src.cull_mode,
            ..default()
        };
        let mut wait = None;
        if let Some(tex) = tex {
            match images.and_then(|i| i.get(&tex)).and_then(average_color) {
                Some(avg) => far.base_color = multiply(tint, avg),
                None => wait = Some(tex),
            }
        }
        let h = mats.add(far);
        if let Some(tex) = wait {
            self.pending.push((tex, tint, h.clone()));
        }
        self.by_near.insert(near.id(), h.clone());
        h
    }
}

/// Far materials created before their near texture loaded: tint them once it has.
fn refine_far_materials(mut far: ResMut<FarMaterials>, images: Option<Res<Assets<Image>>>, mats: Option<ResMut<Assets<StandardMaterial>>>) {
    if far.pending.is_empty() {
        return;
    }
    let (Some(images), Some(mut mats)) = (images, mats) else { return };
    far.pending.retain(|(tex, tint, h)| {
        let Some(img) = images.get(tex) else { return true };
        if let (Some(avg), Some(mut m)) = (average_color(img), mats.get_mut(h)) {
            m.base_color = multiply(*tint, avg);
        }
        false
    });
}

fn multiply(a: Color, b: Color) -> Color {
    let (a, b) = (a.to_linear(), b.to_linear());
    Color::LinearRgba(LinearRgba::new(a.red * b.red, a.green * b.green, a.blue * b.blue, a.alpha))
}

/// Average colour of an RGBA8 image's base level (≤ 4096 samples). `None` for other formats.
pub fn average_color(img: &Image) -> Option<Color> {
    let fmt = img.texture_descriptor.format;
    let srgb = match fmt {
        TextureFormat::Rgba8UnormSrgb => true,
        TextureFormat::Rgba8Unorm => false,
        _ => return None,
    };
    let data = img.data.as_ref()?;
    let size = img.texture_descriptor.size;
    let px = (size.width as usize * size.height as usize).min(data.len() / 4);
    if px == 0 {
        return None;
    }
    let step = (px / 4096).max(1);
    let mut sum = Vec3::ZERO;
    let mut n = 0.0;
    for i in (0..px).step_by(step) {
        let p = &data[i * 4..i * 4 + 3];
        let c = if srgb {
            Color::srgb_u8(p[0], p[1], p[2]).to_linear()
        } else {
            LinearRgba::rgb(p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0)
        };
        sum += Vec3::new(c.red, c.green, c.blue);
        n += 1.0;
    }
    let avg = sum / n;
    Some(Color::LinearRgba(LinearRgba::rgb(avg.x, avg.y, avg.z)))
}

/// Re-applies tier ranges when the effective distances or `RenderBudget::scenery_detail` change.
fn update_ranges(budget: Res<RenderBudget>, eff: Res<EffectiveRanges>, mut q: Query<(&DetailTier, &mut VisibilityRange)>, mut last_on: Local<Option<bool>>,
    cpu: Res<super::BudgetCpu>,
) {
    let _cpu = cpu.time();
    if !eff.is_changed() && *last_on == Some(budget.scenery_detail) {
        return;
    }
    *last_on = Some(budget.scenery_detail);
    for (tier, mut range) in &mut q {
        let next = tier_range(*tier, &eff.0, budget.scenery_detail);
        if *range != next {
            *range = next;
        }
    }
}

/// Scenery beyond `shadow` (+ half the fade, hysteresis) stops casting; back within
/// `shadow - fade/2` it casts again. Runs when the camera moved ≥ 1 m, settings changed or new
/// scenery appeared.
fn trim_shadows(
    mut commands: Commands,
    budget: Res<RenderBudget>,
    eff: Res<EffectiveRanges>,
    cam: Query<&GlobalTransform, With<MainCamera>>,
    q: Query<(Entity, &GlobalTransform, Has<NotShadowCaster>), With<ShadowTrimmable>>,
    added: Query<(), Added<ShadowTrimmable>>,
    mut last: Local<Option<(Vec3, bool)>>,
    mut stats: ResMut<RenderStats>,
    cpu: Res<super::BudgetCpu>,
) {
    let _cpu = cpu.time();
    let Some(eye) = cam.iter().next().map(GlobalTransform::translation) else { return };
    let on = budget.shadow_trim;
    let moved = last.is_none_or(|(p, was_on)| p.distance_squared(eye) >= 1.0 || was_on != on);
    if !moved && !eff.is_changed() && added.is_empty() {
        return;
    }
    *last = Some((eye, on));
    let half = eff.0.fade * 0.5;
    let (cut, keep) = ((eff.0.shadow + half).powi(2), (eff.0.shadow - half).max(0.0).powi(2));
    let mut trimmed = 0;
    for (e, gt, off) in &q {
        let d2 = gt.translation().distance_squared(eye);
        let want_off = on && if off { d2 > keep } else { d2 > cut };
        if want_off != off {
            if want_off {
                commands.entity(e).insert(NotShadowCaster);
            } else {
                commands.entity(e).remove::<NotShadowCaster>();
            }
        }
        trimmed += want_off as u32;
    }
    stats.shadows_trimmed = trimmed;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_hand_over_without_gaps() {
        let r = SceneryRanges::default();
        let near = tier_range(DetailTier::Near, &r, true);
        let far = tier_range(DetailTier::Far, &r, true);
        // The far twin fades in exactly where the near piece fades out.
        assert_eq!(near.end_margin, far.start_margin);
        for d in [0.0, 10.0, r.far - r.fade * 0.5, r.far + 1.0, r.view - 1.0] {
            assert!(near.is_visible_at_all(d) || far.is_visible_at_all(d), "gap at {d} m");
        }
        assert!(near.is_culled(r.far + 1.0));
        assert!(far.is_culled(r.view + 1.0));
        assert!(tier_range(DetailTier::Small, &r, true).is_culled(r.small_props + 0.1));
    }

    #[test]
    fn detail_off_keeps_near_and_hides_far() {
        let r = SceneryRanges::default();
        assert!(tier_range(DetailTier::Near, &r, false).is_visible_at_all(5000.0));
        assert!(tier_range(DetailTier::Small, &r, false).is_visible_at_all(5000.0));
        assert!(tier_range(DetailTier::Far, &r, false).is_culled(r.far + 10.0));
    }

    #[test]
    fn parts_of_a_piece_are_sized_by_reach() {
        let aabb = Aabb::from_min_max(Vec3::splat(-0.25), Vec3::splat(0.25));
        let gt = GlobalTransform::from_translation(Vec3::new(2.0, 0.0, 0.0));
        assert!((piece_size(&aabb, &gt, None) - 0.5).abs() < 1e-5);
        // 2 m from its root's origin: part of a ~4.9 m piece.
        assert!(piece_size(&aabb, &gt, Some(Vec3::ZERO)) > 4.0);
    }

    #[test]
    fn texture_average_is_linear_mean() {
        use bevy::asset::RenderAssetUsages;
        use bevy::render::render_resource::{Extent3d, TextureDimension};
        let img = Image::new(
            Extent3d { width: 2, height: 1, depth_or_array_layers: 1 },
            TextureDimension::D2,
            vec![255, 0, 0, 255, 0, 0, 255, 255],
            TextureFormat::Rgba8Unorm,
            RenderAssetUsages::all(),
        );
        let c = average_color(&img).unwrap().to_linear();
        assert!((c.red - 0.5).abs() < 1e-3 && c.green.abs() < 1e-3 && (c.blue - 0.5).abs() < 1e-3);
    }
}
