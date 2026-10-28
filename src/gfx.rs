//! Rendering presets and texture helpers. Owner: core stream (ported from Shroud `gfx.rs`).
//!
//! - Tag the game's camera with [`MainCamera`]; on `Camera3d` main cameras the engine adds the
//!   quality bundle for `CoreSettings.quality` (from [`QualityPreset`]: FXAA or TAA, SSAO,
//!   bloom, directional shadow-map size, shadow filtering, contact shadows, SSR) plus `Msaa::Off`, keeps FOV in sync with
//!   `CoreSettings.fov_deg` (perspective only), and re-applies when settings change. The spatial
//!   audio listener is attached by `audio`. Without a `look::Look` resource (feature `look`)
//!   the engine never touches `Exposure`, `DistanceFog`, `Tonemapping` or atmosphere
//!   components (games own the look); with one, `look` does. [`prune_prepasses`] drops
//!   prepasses only a removed feature needed.
//! - Textures: [`load_pbr`] (+ CPU mip generation through [`PendingMips`]), [`world_uv_cuboid`].
//! - Helpers: [`FaceCamera`] billboards, [`sky_and_sun`] for a ready-made outdoor look.
//!
//! Nothing here runs headless.

use bevy::anti_alias::fxaa::Fxaa;
use bevy::anti_alias::taa::TemporalAntiAliasing;
use bevy::image::{ImageAddressMode, ImageLoaderSettings, ImageSampler, ImageSamplerDescriptor};
use bevy::light::atmosphere::ScatteringMedium;
use bevy::light::{Atmosphere, CascadeShadowConfigBuilder, DirectionalLightShadowMap, light_consts::lux};
use bevy::mesh::VertexAttributeValues;
use bevy::core_pipeline::prepass::{DeferredPrepass, DepthPrepass, MotionVectorPrepass, NormalPrepass};
use bevy::light::ShadowFilteringMethod;
use bevy::pbr::{
    ContactShadows, DefaultOpaqueRendererMethod, ScreenSpaceAmbientOcclusion, ScreenSpaceAmbientOcclusionQualityLevel,
    ScreenSpaceReflections,
};
use bevy::post_process::motion_blur::MotionBlur;
use bevy::platform::collections::HashSet;
use bevy::post_process::bloom::Bloom;
use bevy::prelude::*;
use bevy::render::camera::{MipBias, TemporalJitter};
use bevy::render::render_resource::TextureFormat;

use crate::flow::has_visuals;
use crate::paths::AssetsDir;
use crate::render_budget::stats::BudgetDepthPrepass;
use crate::settings::{CoreSettings, GraphicsQuality};

/// The camera the player sees through (one per app).
#[derive(Component, Reflect, Clone, Copy, Debug, Default)]
#[reflect(Component)]
pub struct MainCamera;

/// Per-quality camera features (Low: no SSAO/bloom, FXAA, small shadows … Ultra: best SSAO,
/// big shadows, contact shadows, SSR). Indexed by [`GraphicsQuality::index`]. Games may override
/// the resource (build it with `..default()`).
///
/// [`apply_camera_quality`] applies the camera-wide fields (AA, SSAO, bloom, shadow map size,
/// shadow filtering, contact shadows, SSR). The `look` module (feature `look`) reads the
/// "look tier" fields (volumetric fog, env lighting, auto exposure, lens / post effects, sky
/// quality, probe refresh) to gate what a [`crate::look::Look`] asks for.
#[derive(Resource, Clone, Debug, PartialEq)]
pub struct QualityPreset {
    pub ssao: [bool; 4],
    pub bloom: [bool; 4],
    /// TAA when true, FXAA when false.
    pub taa: [bool; 4],
    pub shadow_map_size: [usize; 4],
    /// Bloom strength when enabled (a `Look` overrides it with its own bloom tuning).
    pub bloom_intensity: f32,
    /// GPU occlusion culling on the main camera (adds a depth prepass when the camera has none;
    /// see `render_budget`). Only used where the GPU supports it.
    pub occlusion_culling: [bool; 4],
    /// Multiplier on `render_budget::SceneryRanges` (scenery detail and streaming distances).
    pub detail_scale: [f32; 4],
    /// Shadow-map filtering on the main camera. `Temporal` falls back to `Gaussian` without TAA.
    pub shadow_filter: [ShadowFilteringMethod; 4],
    /// Screen-space contact shadows: `ContactShadows` on the camera (+ depth prepass) and
    /// `contact_shadows_enabled` on [`Sun`] lights.
    pub contact_shadows: [bool; 4],
    /// Screen-space reflections. While any main camera has SSR the default opaque renderer
    /// method is switched to deferred (SSR reads the G-buffer); off again → forward.
    pub ssr: [bool; 4],
    /// Look tier: volumetric fog / light shafts (`Look::volumetric`).
    pub volumetric_fog: [bool; 4],
    /// Look tier: volumetric fog ray-march steps.
    pub volumetric_steps: [u32; 4],
    /// Look tier: image-based ambient + reflections from the sky (atmosphere or generated
    /// cubemap). Off → flat ambient only.
    pub env_light: [bool; 4],
    /// Look tier: cubemap size (px) of environment lighting generated from the atmosphere.
    pub env_map_size: [u32; 4],
    /// Look tier: atmosphere sky-view / aerial-perspective samples per ray.
    pub sky_samples: [u32; 4],
    /// Look tier: histogram auto exposure (`Look::exposure.auto`); off → manual `ev100`.
    pub auto_exposure: [bool; 4],
    /// Look tier: depth of field and motion blur (`Look::lens`).
    pub camera_fx: [bool; 4],
    /// Look tier: chromatic aberration and vignette (`Look::lens`).
    pub post_fx: [bool; 4],
    /// Look tier: depth of field uses the bokeh (true) or the cheaper gaussian (false) mode.
    pub bokeh: [bool; 4],
    /// Look tier: frames between realtime reflection-probe face updates (0 = bake once, never
    /// refresh). See `look::ReflectionProbe`.
    pub probe_refresh: [u32; 4],
    /// Look tier: PCSS soft sun shadows (only with the `look_pcss` cargo feature). Off by
    /// default: like temporal filtering it leans on TAA and sparkles at low or uneven fps.
    pub soft_shadows: [bool; 4],
    /// Look tier: at most this many sun shadow cascades (the look's `cascades` is capped).
    pub max_cascades: [u32; 4],
    /// Point-light shadow cube face size (`PointLightShadowMap`; 6 faces per shadowed light).
    pub point_shadow_map_size: [usize; 4],
}

impl Default for QualityPreset {
    fn default() -> Self {
        use ShadowFilteringMethod::{Gaussian, Hardware2x2};
        QualityPreset {
            ssao: [false, false, true, true],
            bloom: [false, true, true, true],
            taa: [false, true, true, true],
            // Spot-light shadows are layers of this same texture in Bevy 0.19: at 4096 each spot
            // costs 64 MB, and the texture is rebuilt whenever a shadowed light enters or
            // leaves view. 2048 keeps Ultra's 4 cascades + 10 spots near 230 MB.
            shadow_map_size: [1024, 2048, 2048, 2048],
            bloom_intensity: 0.12,
            occlusion_culling: [true, true, true, true],
            detail_scale: [0.6, 0.8, 1.0, 1.5],
            // Temporal filtering needs steady TAA history: it crawls at low or spiky fps.
            shadow_filter: [Hardware2x2, Gaussian, Gaussian, Gaussian],
            contact_shadows: [false, false, true, true],
            ssr: [false, false, false, true],
            volumetric_fog: [false, false, true, true],
            volumetric_steps: [16, 24, 32, 64],
            env_light: [true, true, true, true],
            env_map_size: [64, 128, 256, 512],
            sky_samples: [8, 12, 16, 24],
            auto_exposure: [false, true, true, true],
            camera_fx: [false, false, true, true],
            post_fx: [false, true, true, true],
            bokeh: [false, false, false, true],
            probe_refresh: [0, 0, 4, 1],
            soft_shadows: [false, false, false, false],
            max_cascades: [1, 2, 3, 4],
            point_shadow_map_size: [256, 512, 512, 512],
        }
    }
}

/// Images that still need a CPU-built mip chain (JPG/PNG ship without mips).
#[derive(Resource, Default)]
pub struct PendingMips(pub HashSet<AssetId<Image>>);

/// Quality preset currently applied to a camera.
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppliedQuality(pub GraphicsQuality);

/// Rotates the entity to face the [`MainCamera`] (or any `Camera3d`) every frame, keeping its roll.
#[derive(Component, Reflect, Clone, Copy, Debug, Default)]
#[reflect(Component)]
pub struct FaceCamera;

/// Marker on the directional light spawned by [`sky_and_sun`].
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Sun;

pub struct GfxPlugin;

/// Order of the camera quality systems in `Update`: [`apply_camera_quality`] (`Apply`), then
/// systems that tune what it added (`Look`: the `look` module), then [`prune_prepasses`].
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum QualitySet {
    Apply,
    Look,
    Prune,
}

impl Plugin for GfxPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PendingMips>()
            .init_resource::<QualityPreset>()
            .init_resource::<SsrDeferred>()
            .add_systems(
                Update,
                (generate_mips, face_camera, apply_camera_quality.in_set(QualitySet::Apply), apply_fov, prune_prepasses.in_set(QualitySet::Prune), deferred_side_views.after(QualitySet::Prune))
                    .run_if(has_visuals),
            )
            .configure_sets(Update, (QualitySet::Apply, QualitySet::Look, QualitySet::Prune).chain());
        if app.is_plugin_added::<bevy::render::RenderPlugin>() {
            app.add_systems(PreUpdate, patch_grading_shader);
        }
    }
}

/// The buggy lines in Bevy 0.19's `tonemapping_shared.wgsl` (`sectional_color_grading`).
const GRADING_BUG: &str = "levels.y = ((level - midtone_range.x) * LEVEL_MARGIN_DIV) + 0.5;\n        levels.z = 1.0 - levels.y;";
const GRADING_FIX: &str = "levels.y = ((level - midtone_range.x) * LEVEL_MARGIN_DIV) + 0.5;\n        levels.x = 1.0 - levels.y;";

/// Fixes Bevy 0.19's sectional colour grading in `source`, or `None` if it has nothing to fix.
///
/// Between shadows and midtones Bevy blends the midtone settings with the *highlight* ones
/// (`levels.z`) instead of the shadow ones, so any shadow lift / gamma / gain / saturation
/// jumps where scene brightness crosses `midtones_range.x - 0.1`: a hard curved band across a
/// smooth sky or floor (it showed up in the `dusk` look, which lifts shadows).
pub fn fix_sectional_grading(source: &str) -> Option<String> {
    source.contains(GRADING_BUG).then(|| source.replacen(GRADING_BUG, GRADING_FIX, 1))
}

/// Patches the tonemapping shader library once it has loaded (see [`fix_sectional_grading`]).
/// The pipeline cache recompiles the shaders that import it. A newer Bevy without the bug (or
/// with different code) is left alone.
fn patch_grading_shader(mut events: MessageReader<AssetEvent<Shader>>, mut shaders: ResMut<Assets<Shader>>, mut done: Local<bool>) {
    if *done {
        events.clear();
        return;
    }
    for ev in events.read() {
        let AssetEvent::LoadedWithDependencies { id } = ev else { continue };
        let Some(shader) = shaders.get(*id) else { continue };
        let bevy::shader::Source::Wgsl(src) = &shader.source else { continue };
        if !src.contains("fn sectional_color_grading") {
            continue;
        }
        *done = true;
        match fix_sectional_grading(src) {
            Some(fixed) => {
                if let Some(mut shader) = shaders.get_mut(*id) {
                    shader.source = bevy::shader::Source::Wgsl(fixed.into());
                }
            }
            None => debug!("gfx: sectional colour grading has no known bug to patch (newer Bevy?)"),
        }
    }
}

/// Adds/removes AA, SSAO, bloom, contact shadows and SSR on `Camera3d` main cameras and sets
/// their shadow filtering when they appear, when `CoreSettings.quality` changes, or when
/// [`QualityPreset`] changes; sets shadow-map size and `contact_shadows_enabled` on [`Sun`]s.
/// The quality features a camera has now (see [`apply_camera_quality`]).
type CameraFeatures = (
    Has<TemporalAntiAliasing>,
    Has<Fxaa>,
    Option<&'static ScreenSpaceAmbientOcclusion>,
    Option<&'static Bloom>,
    Option<&'static ShadowFilteringMethod>,
    Has<ContactShadows>,
    Has<ScreenSpaceReflections>,
);

#[allow(clippy::too_many_arguments)]
pub fn apply_camera_quality(
    mut commands: Commands,
    settings: Res<CoreSettings>,
    preset: Res<QualityPreset>,
    cams: Query<
        (
            Entity,
            Option<&AppliedQuality>,
            (Has<DepthPrepass>, Has<BudgetDepthPrepass>, Has<NormalPrepass>, Has<MotionVectorPrepass>, Has<DeferredPrepass>),
            CameraFeatures,
        ),
        (With<MainCamera>, With<Camera3d>),
    >,
    shadow_map: Option<ResMut<DirectionalLightShadowMap>>,
    point_map: Option<ResMut<bevy::light::PointLightShadowMap>>,
    mut suns: Query<(Ref<Sun>, &mut DirectionalLight)>,
    renderer: Option<ResMut<DefaultOpaqueRendererMethod>>,
    mut materials: Option<ResMut<Assets<StandardMaterial>>>,
    mut deferred_for_ssr: ResMut<SsrDeferred>,
) {
    if deferred_for_ssr.grace > 0 {
        deferred_for_ssr.grace -= 1;
    }
    let q = settings.quality;
    let i = q.index();
    let force = preset.is_changed();
    let mut applied_any = false;
    let mut any_ssr = None;
    for (e, applied, (depth, budget_depth, normal, motion, deferred), f) in &cams {
        let have = (
            f.0,
            f.1,
            f.2.map(|s| s.quality_level),
            f.3.map(|b| b.intensity),
            f.4.copied(),
            f.5,
            f.6,
        );
        if !force && applied.is_some_and(|a| a.0 == q) {
            any_ssr = Some(any_ssr.unwrap_or(false) | preset.ssr[i]);
            continue;
        }
        applied_any = true;
        let mut ec = commands.entity(e);
        if applied.is_none() {
            // Prepasses the game put there itself are never pruned (see `prune_prepasses`).
            ec.insert(GamePrepasses { depth: depth && !budget_depth, normal, motion, deferred });
        }
        // Insert only what's missing or different: re-inserting TAA resets its history (one
        // aliased frame), and re-inserting the rest re-extracts them for nothing.
        let (has_taa, has_fxaa, ssao, bloom, filter_now, has_contact, has_ssr) = have;
        ec.insert(AppliedQuality(q));
        if applied.is_none() {
            ec.insert(Msaa::Off);
        }
        if preset.taa[i] {
            if has_fxaa {
                ec.remove::<Fxaa>();
            }
            if !has_taa {
                ec.insert(TemporalAntiAliasing::default());
            }
        } else {
            if has_taa {
                ec.remove::<(TemporalAntiAliasing, TemporalJitter, MipBias)>();
            }
            if !has_fxaa {
                ec.insert(Fxaa::default());
            }
        }
        if preset.ssao[i] {
            let quality_level = if q == GraphicsQuality::Ultra {
                ScreenSpaceAmbientOcclusionQualityLevel::Ultra
            } else {
                ScreenSpaceAmbientOcclusionQualityLevel::High
            };
            if ssao != Some(quality_level) {
                ec.insert(ScreenSpaceAmbientOcclusion { quality_level, ..default() });
            }
        } else if ssao.is_some() {
            ec.remove::<ScreenSpaceAmbientOcclusion>();
        }
        if preset.bloom[i] {
            if bloom != Some(preset.bloom_intensity) {
                ec.insert(Bloom { intensity: preset.bloom_intensity, ..Bloom::NATURAL });
            }
        } else if bloom.is_some() {
            ec.remove::<Bloom>();
        }
        let filter = match preset.shadow_filter[i] {
            ShadowFilteringMethod::Temporal if !preset.taa[i] => ShadowFilteringMethod::Gaussian,
            f => f,
        };
        if filter_now != Some(filter) {
            ec.insert(filter);
        }
        if preset.contact_shadows[i] != has_contact {
            if has_contact {
                ec.remove::<ContactShadows>();
            } else {
                ec.insert(ContactShadows::default());
            }
        }
        if preset.ssr[i] != has_ssr {
            if has_ssr {
                ec.remove::<ScreenSpaceReflections>();
            } else {
                ec.insert(ScreenSpaceReflections::default());
            }
        }
        any_ssr = Some(any_ssr.unwrap_or(false) | preset.ssr[i]);
    }
    for (tag, mut light) in &mut suns {
        if (applied_any || tag.is_added() || settings.is_changed()) && light.contact_shadows_enabled != preset.contact_shadows[i] {
            light.contact_shadows_enabled = preset.contact_shadows[i];
        }
    }
    // SSR shades from the G-buffer: opaque materials go deferred while it's on. Materials bake
    // their render method when prepared, so they're touched to re-prepare.
    // Only switches back to forward what it switched to deferred itself.
    if let (Some(want), Some(mut method)) = (any_ssr, renderer)
        && want != deferred_for_ssr.on
    {
        deferred_for_ssr.on = want;
        deferred_for_ssr.grace = if want { 0 } else { SsrDeferred::GRACE };
        if want {
            method.set_to_deferred();
        } else {
            method.set_to_forward();
        }
        if let Some(mats) = materials.as_mut() {
            let ids: Vec<_> = mats.ids().collect();
            for id in ids {
                // `get_mut` alone doesn't count as a change (only a write does): mark it.
                if let Some(m) = mats.get_mut(id) {
                    m.into_inner();
                }
            }
        }
    }
    if (applied_any || settings.is_changed())
        && let Some(mut shadow_map) = shadow_map
        && shadow_map.size != preset.shadow_map_size[i]
    {
        shadow_map.size = preset.shadow_map_size[i];
    }
    if (applied_any || settings.is_changed())
        && let Some(mut point) = point_map
        && point.size != preset.point_shadow_map_size[i]
    {
        point.size = preset.point_shadow_map_size[i];
    }
}

/// Whether [`apply_camera_quality`] switched opaque materials to deferred (for SSR).
#[derive(Resource, Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct SsrDeferred {
    pub on: bool,
    /// Frames left in which views keep their deferred prepass after switching back to forward:
    /// materials re-prepare a few frames later, and a deferred material in a view without a
    /// deferred prepass panics in Bevy 0.19.
    pub grace: u32,
}

impl SsrDeferred {
    /// Frames views keep their deferred prepass after SSR goes off.
    pub const GRACE: u32 = 10;
    /// Whether 3D views need a deferred prepass now.
    pub fn views_need_it(&self) -> bool {
        self.on || self.grace > 0
    }
}

/// Marks a non-main 3D camera that got a deferred prepass from [`deferred_side_views`].
#[derive(Component)]
pub struct SsrSideDeferred;

/// While SSR has switched materials to deferred, every other 3D camera (reflection-probe
/// captures, extra views) needs a deferred prepass too: Bevy 0.19 panics on a deferred material
/// in a view without one (`prepass/mod.rs`, `opaque_deferred_phase.unwrap()`). Added here and
/// removed again [`SsrDeferred::GRACE`] frames after SSR goes off.
pub fn deferred_side_views(
    mut commands: Commands,
    ssr: Res<SsrDeferred>,
    cams: Query<(Entity, Has<DeferredPrepass>, Has<DepthPrepass>, Has<SsrSideDeferred>), (With<Camera3d>, Without<MainCamera>)>,
) {
    let need = ssr.views_need_it();
    for (e, deferred, depth, ours) in &cams {
        if need && !deferred {
            let mut ec = commands.entity(e);
            ec.insert((DeferredPrepass, SsrSideDeferred));
            if !depth {
                ec.insert(DepthPrepass);
            }
        } else if !need && ours {
            commands.entity(e).remove::<(DeferredPrepass, SsrSideDeferred)>();
        }
    }
}

/// Prepasses a main camera had before the quality system first touched it (kept forever).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct GamePrepasses {
    pub depth: bool,
    pub normal: bool,
    pub motion: bool,
    pub deferred: bool,
}

/// Put on a main camera to keep its depth prepass (forward decals need one, see `look`).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct KeepDepthPrepass;

/// Removes depth / normal / deferred prepasses that only a since-removed feature needed (SSAO,
/// TAA, contact shadows, SSR, motion blur, occlusion culling), so turning a feature off also
/// drops its prepass cost.
/// Prepasses the game added itself ([`GamePrepasses`]) stay.
pub fn prune_prepasses(
    mut commands: Commands,
    cams: Query<
        (
            Entity,
            &GamePrepasses,
            (Has<DepthPrepass>, Has<NormalPrepass>, Has<MotionVectorPrepass>, Has<DeferredPrepass>),
            (Has<ScreenSpaceAmbientOcclusion>, Has<TemporalAntiAliasing>, Has<ContactShadows>, Has<ScreenSpaceReflections>),
            (Has<MotionBlur>, Has<BudgetDepthPrepass>, Has<KeepDepthPrepass>),
        ),
        With<MainCamera>,
    >,
    ssr_deferred: Option<Res<SsrDeferred>>,
) {
    // Deferred materials need a deferred (and depth) prepass in every view until they're forward again.
    let materials_deferred = ssr_deferred.is_some_and(|d| d.views_need_it());
    for (e, game, (depth, normal, motion, deferred), (ssao, taa, contact, ssr), (blur, budget, keep)) in &cams {
        let need_depth = game.depth || ssao || taa || contact || ssr || blur || budget || keep || materials_deferred;
        let need_normal = game.normal || ssao;
        let need_motion = game.motion || taa || blur;
        let need_deferred = game.deferred || ssr || materials_deferred;
        let mut ec = commands.entity(e);
        if depth && !need_depth {
            ec.remove::<DepthPrepass>();
        }
        if normal && !need_normal {
            ec.remove::<NormalPrepass>();
        }
        // Motion vectors stay: Bevy 0.19 keeps drawing the skybox's cached
        // `background_motion_vectors_pipeline` into the pass for a frame after they go, which is a
        // fatal wgpu validation error. (They're cheap without TAA / motion blur reading them.)
        let _ = (motion, need_motion);
        if deferred && !need_deferred {
            ec.remove::<DeferredPrepass>();
        }
    }
}

/// `CoreSettings.fov_deg` → perspective main cameras (on change and on new cameras).
fn apply_fov(settings: Res<CoreSettings>, mut cams: Query<(Ref<MainCamera>, &mut Projection)>) {
    let fov = settings.fov_deg.clamp(30.0, 150.0).to_radians();
    for (tag, mut p) in &mut cams {
        if !settings.is_changed() && !tag.is_added() {
            continue;
        }
        if let Projection::Perspective(pp) = p.as_ref()
            && (pp.fov - fov).abs() > 1e-4
            && let Projection::Perspective(pp) = p.as_mut()
        {
            pp.fov = fov;
        }
    }
}

fn face_camera(
    main: Query<&GlobalTransform, (With<MainCamera>, Without<FaceCamera>)>,
    any: Query<&GlobalTransform, (With<Camera3d>, Without<FaceCamera>)>,
    mut q: Query<(&mut Transform, &GlobalTransform), With<FaceCamera>>,
) {
    let Some(cam) = main.iter().next().or_else(|| any.iter().next()) else { return };
    let eye = cam.translation();
    for (mut tf, gtf) in &mut q {
        let to = eye - gtf.translation();
        if to.length_squared() > 1e-6 {
            let roll = tf.rotation.to_euler(EulerRot::YXZ).2;
            tf.look_to(-to, Vec3::Y);
            tf.rotate_local_z(roll);
        }
    }
}

/// Optional helper: atmosphere sky (falls back to a hazy `ClearColor` without the atmosphere
/// asset), a shadowed low afternoon [`Sun`], and cool ambient fill. Pair with a camera that has
/// `AtmosphereSettings` / `Exposure { ev100: 13.0 }` for Shroud's look.
pub fn sky_and_sun(commands: &mut Commands) {
    sky_and_sun_with(commands, SunSetup::default());
}

/// Sun, shadow and ambient parameters for [`sky_and_sun_with`]. The default is Shroud's
/// arena look (shadows to 90 m); open maps want a longer `shadow_distance` and more cascades.
#[derive(Clone, Debug)]
pub struct SunSetup {
    /// Direction the sunlight travels (from the sun towards the ground).
    pub direction: Vec3,
    pub illuminance: f32,
    pub color: Color,
    pub cascades: usize,
    pub first_cascade: f32,
    /// Shadows end here (metres from the camera).
    pub shadow_distance: f32,
    pub ambient: Color,
    pub ambient_brightness: f32,
    /// Spawn the atmosphere (sky) entity; otherwise only `fallback_sky` as `ClearColor`.
    pub atmosphere: bool,
    pub fallback_sky: Color,
}

impl Default for SunSetup {
    fn default() -> Self {
        SunSetup {
            direction: Vec3::new(30.0, -22.0, -26.0),
            illuminance: lux::RAW_SUNLIGHT,
            color: Color::srgb(1.0, 0.93, 0.84),
            cascades: 3,
            first_cascade: 10.0,
            shadow_distance: 90.0,
            ambient: Color::srgb(0.7, 0.78, 0.95),
            ambient_brightness: 800.0,
            atmosphere: true,
            fallback_sky: Color::srgb(0.58, 0.62, 0.70),
        }
    }
}

/// [`sky_and_sun`] with explicit [`SunSetup`].
pub fn sky_and_sun_with(commands: &mut Commands, s: SunSetup) {
    let (atmosphere, fallback) = (s.atmosphere, s.fallback_sky);
    commands.queue(move |world: &mut World| {
        let medium = if atmosphere {
            world.get_resource_mut::<Assets<ScatteringMedium>>().map(|mut m| m.add(ScatteringMedium::earth(256, 256)))
        } else {
            None
        };
        match medium {
            Some(m) => {
                world.spawn((Name::new("Atmosphere"), Atmosphere::earth(m)));
            }
            None => world.insert_resource(ClearColor(fallback)),
        }
    });
    let dir = s.direction.try_normalize().unwrap_or(Vec3::NEG_Y);
    commands.spawn((
        Name::new("Sun"),
        Sun,
        DirectionalLight { illuminance: s.illuminance, shadow_maps_enabled: true, color: s.color, ..default() },
        CascadeShadowConfigBuilder {
            num_cascades: s.cascades.max(1),
            first_cascade_far_bound: s.first_cascade,
            maximum_distance: s.shadow_distance,
            ..default()
        }
        .build(),
        Transform::default().looking_to(dir, if dir.y.abs() > 0.99 { Vec3::Z } else { Vec3::Y }),
    ));
    commands.insert_resource(GlobalAmbientLight { color: s.ambient, brightness: s.ambient_brightness, ..default() });
}

// ---------------------------------------------------------------- textures

/// A PBR texture set under `assets/textures/<name>/` (`color`, `normal`, `rough`, optional
/// `ao`, all `.jpg`), repeat-wrapped with 16× anisotropy and CPU-built mips. `None` if the
/// colour map is missing (fall back to a flat material).
pub fn load_pbr(server: &AssetServer, dir: &AssetsDir, pending: &mut PendingMips, name: &str, tint: Color) -> Option<StandardMaterial> {
    let path = |m: &str| format!("textures/{name}/{m}.jpg");
    if !dir.has(&path("color")) {
        return None;
    }
    let mut load = |m: &str, srgb: bool| -> Option<Handle<Image>> {
        let p = path(m);
        if !dir.has(&p) {
            return None;
        }
        let h = server
            .load_builder()
            .with_settings(move |s: &mut ImageLoaderSettings| {
                s.is_srgb = srgb;
                s.sampler = ImageSampler::Descriptor(ImageSamplerDescriptor {
                    address_mode_u: ImageAddressMode::Repeat,
                    address_mode_v: ImageAddressMode::Repeat,
                    // 16x anisotropic + trilinear mips: no shimmer on floors at grazing angles.
                    anisotropy_clamp: 16,
                    ..ImageSamplerDescriptor::linear()
                });
            })
            .load(p);
        pending.0.insert(h.id());
        Some(h)
    };
    Some(StandardMaterial {
        base_color: tint,
        base_color_texture: load("color", true),
        normal_map_texture: load("normal", false),
        // Greyscale roughness map: G drives roughness; `metallic: 0` zeroes B.
        metallic_roughness_texture: load("rough", false),
        occlusion_texture: load("ao", false),
        perceptual_roughness: 1.0,
        metallic: 0.0,
        ..default()
    })
}

fn generate_mips(mut events: MessageReader<AssetEvent<Image>>, mut pending: ResMut<PendingMips>, mut images: ResMut<Assets<Image>>) {
    for ev in events.read() {
        let AssetEvent::LoadedWithDependencies { id } = ev else { continue };
        if !pending.0.remove(id) {
            continue;
        }
        if let Some(mut img) = images.get_mut(*id) {
            build_mips(&mut img);
        }
    }
}

/// Box-filtered mip chain for single-layer RGBA8 images without mips (others untouched).
pub fn build_mips(img: &mut Image) {
    let fmt = img.texture_descriptor.format;
    if !matches!(fmt, TextureFormat::Rgba8Unorm | TextureFormat::Rgba8UnormSrgb)
        || img.texture_descriptor.mip_level_count != 1
        || img.texture_descriptor.size.depth_or_array_layers != 1
    {
        return;
    }
    let Some(base) = img.data.take() else { return };
    let (mut w, mut h) = (img.texture_descriptor.size.width as usize, img.texture_descriptor.size.height as usize);
    let mut out = base.clone();
    let mut prev = base;
    let mut levels = 1;
    while w > 1 || h > 1 {
        let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
        let mut next = vec![0u8; nw * nh * 4];
        for y in 0..nh {
            for x in 0..nw {
                for c in 0..4 {
                    let mut s = 0u32;
                    for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                        let sx = (x * 2 + dx).min(w - 1);
                        let sy = (y * 2 + dy).min(h - 1);
                        s += prev[(sy * w + sx) * 4 + c] as u32;
                    }
                    next[(y * nw + x) * 4 + c] = (s / 4) as u8;
                }
            }
        }
        out.extend_from_slice(&next);
        prev = next;
        (w, h) = (nw, nh);
        levels += 1;
    }
    img.data = Some(out);
    img.texture_descriptor.mip_level_count = levels;
}

/// A cuboid whose UVs are planar projections in world metres divided by `tile`, so textures
/// keep their scale on any block size and line up across blocks. `center` = world position.
pub fn world_uv_cuboid(size: Vec3, center: Vec3, tile: f32) -> Mesh {
    let mut mesh = Mesh::from(Cuboid::from_size(size));
    let pos: Vec<[f32; 3]> = match mesh.attribute(Mesh::ATTRIBUTE_POSITION) {
        Some(VertexAttributeValues::Float32x3(p)) => p.clone(),
        _ => return mesh,
    };
    let nrm: Vec<[f32; 3]> = match mesh.attribute(Mesh::ATTRIBUTE_NORMAL) {
        Some(VertexAttributeValues::Float32x3(n)) => n.clone(),
        _ => return mesh,
    };
    let uvs: Vec<[f32; 2]> = pos
        .iter()
        .zip(&nrm)
        .map(|(p, n)| {
            let w = Vec3::from(*p) + center;
            let n = Vec3::from(*n);
            let uv = if n.y.abs() > 0.5 {
                Vec2::new(w.x, w.z)
            } else if n.x.abs() > 0.5 {
                Vec2::new(w.z * -n.x.signum(), -w.y)
            } else {
                Vec2::new(w.x * n.z.signum(), -w.y)
            };
            (uv / tile).to_array()
        })
        .collect();
    mesh.insert_attribute(Mesh::ATTRIBUTE_UV_0, uvs);
    mesh.with_generated_tangents().unwrap_or_else(|_| Mesh::from(Cuboid::from_size(size)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::asset::RenderAssetUsages;
    use bevy::render::render_resource::{Extent3d, TextureDimension};

    #[test]
    fn sectional_grading_fix_blends_shadows_not_highlights() {
        let buggy = "} else if (level < midtone_range.x + LEVEL_MARGIN) {\n        levels.y = ((level - midtone_range.x) * LEVEL_MARGIN_DIV) + 0.5;\n        levels.z = 1.0 - levels.y;\n    } else if (level < midtone_range.y - LEVEL_MARGIN) {\n        levels.y = 1.0;\n    } else if (level < midtone_range.y + LEVEL_MARGIN) {\n        levels.z = ((level - midtone_range.y) * LEVEL_MARGIN_DIV) + 0.5;\n        levels.y = 1.0 - levels.z;";
        let fixed = fix_sectional_grading(buggy).expect("patched");
        assert!(fixed.contains("levels.x = 1.0 - levels.y;"));
        // the midtone → highlight blend is right already and stays
        assert!(fixed.contains("levels.z = ((level - midtone_range.y) * LEVEL_MARGIN_DIV) + 0.5;\n        levels.y = 1.0 - levels.z;"));
        assert_eq!(fix_sectional_grading(&fixed), None);
    }

    /// Guards the patch against a Bevy upgrade: the shipped shader must still contain the
    /// exact buggy lines (else drop the patch if Bevy fixed it, or update it).
    #[test]
    fn bevy_tonemapping_shader_still_has_the_patched_bug() {
        let Some(dir) = std::env::var_os("CARGO_HOME").map(std::path::PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".cargo"))) else { return };
        let Ok(regs) = std::fs::read_dir(dir.join("registry/src")) else { return };
        for reg in regs.flatten() {
            let f = reg.path().join("bevy_core_pipeline-0.19.1/src/tonemapping/tonemapping_shared.wgsl");
            if let Ok(src) = std::fs::read_to_string(&f) {
                assert!(fix_sectional_grading(&src).is_some(), "{} no longer has the grading bug", f.display());
                return;
            }
        }
    }

    #[test]
    fn mips_cover_full_chain() {
        let mut img = Image::new(
            Extent3d { width: 4, height: 2, depth_or_array_layers: 1 },
            TextureDimension::D2,
            vec![200; 4 * 2 * 4],
            TextureFormat::Rgba8UnormSrgb,
            RenderAssetUsages::RENDER_WORLD,
        );
        build_mips(&mut img);
        assert_eq!(img.texture_descriptor.mip_level_count, 3); // 4x2, 2x1, 1x1
        assert_eq!(img.data.as_ref().unwrap().len(), (8 + 2 + 1) * 4);
        assert!(img.data.unwrap().iter().all(|&b| b == 200));
    }

    #[test]
    fn world_uvs_tile_by_metres() {
        let m = world_uv_cuboid(Vec3::new(2.0, 1.0, 2.0), Vec3::ZERO, 1.0);
        let Some(VertexAttributeValues::Float32x2(uv)) = m.attribute(Mesh::ATTRIBUTE_UV_0) else { panic!("no uvs") };
        let max = uv.iter().map(|u| u[0].abs()).fold(0.0, f32::max);
        assert!((max - 1.0).abs() < 1e-5);
    }
}
