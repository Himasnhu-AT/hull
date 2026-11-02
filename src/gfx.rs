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
//! - Texture size cap: [`QualityPreset::max_texture_size`] (default Low 1024, Medium 2048, High
//!   4096, Ultra no cap; 0 = no cap). A bigger image loses its top mip levels before it is
//!   uploaded ([`cap_texture_size`]): BC7 2048² with mips is 5.6 MB, capped to 1024² 1.4 MB
//!   (RGBA8: 22.4 → 5.6 MB). Applies to
//!   - every 2D image that arrives with a mip chain and CPU data (cooked KTX2 from [`load_pbr`]
//!     or anywhere else; arrays and cubemaps too, mip- or layer-major),
//!   - [`load_pbr`]'s JPEG sets, after their CPU mips are built,
//!   - with `cap_material_images` (default on), mip-less RGBA8 images used by a
//!     `StandardMaterial` slot (base colour, normal, metallic-roughness, occlusion, emissive):
//!     glTF / PNG / JPEG textures get CPU mips ([`cap_mipless`]), then the cap. Only material
//!     slots, so UI images, fonts, sprites and render targets keep their size (they have no
//!     mips, and stretching UI to a lower resolution would blur it).
//!
//!   Not capped: images without CPU data (render targets, GPU-generated maps), mip-less images
//!   outside material slots or in other formats, 3D textures, data whose length does not match
//!   its descriptor, and images that are already extracted and GPU-only. The cap runs in
//!   `PostUpdate` on the frame's `AssetEvent::Added` (after Bevy publishes asset events, before
//!   extraction takes GPU-only images' data), changing images with `get_mut_untracked` so only
//!   the capped data is ever uploaded. A quality change applies to textures loaded after it;
//!   restart (or reload the textures) to apply it to loaded ones: nothing is reloaded during
//!   play. Stats: [`TextureCapStats`], `perf.stats` → `textures` (`capped`, `mb_saved`). Idle
//!   cost: reading the frame's image and material asset events.
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
use bevy::platform::collections::{HashMap, HashSet};
use bevy::post_process::bloom::Bloom;
use bevy::prelude::*;
use bevy::render::camera::{MipBias, TemporalJitter};
use bevy::ecs::message::MessageCursor;
use bevy::render::render_resource::{TextureDataOrder, TextureDimension, TextureFormat};

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
    /// Largest texture side (px) kept at load; 0 = no cap. Bigger images lose their top mip
    /// levels before upload (see [`cap_texture_size`] and the module docs: which images, when).
    /// Applies to textures loaded after a quality change; restart or reload them to apply.
    pub max_texture_size: [u32; 4],
    /// Also cap textures without a mip chain (glTF / PNG / JPEG) that a `StandardMaterial`
    /// uses: build RGBA8 mips on the CPU, then drop the top levels. Off → only images that
    /// arrive with a mip chain (cooked KTX2) or get one from [`load_pbr`] are capped.
    pub cap_material_images: bool,
    /// Highest render scale per tier on a high-DPI window (scale factor at or above
    /// `hidpi_scale_factor`): `render_budget::RenderScale` never draws above it there. A Retina
    /// panel at 0.7 still has more pixels than 1080p. 1 = no cap.
    pub hidpi_render_scale: [f32; 4],
    /// Window scale factor from which `hidpi_render_scale` applies (Retina is 2).
    pub hidpi_scale_factor: f32,
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
            // BC7 2048² with mips is 5.6 MB, 1024² 1.4 MB: Low fits an 8 GB Mac's budget.
            max_texture_size: [1024, 2048, 4096, 0],
            cap_material_images: true,
            hidpi_render_scale: [0.7, 0.85, 1.0, 1.0],
            hidpi_scale_factor: 1.5,
        }
    }
}

/// Images that still need a CPU-built mip chain (JPG/PNG ship without mips).
#[derive(Resource, Default)]
pub struct PendingMips(
    pub HashSet<AssetId<Image>>,
    /// Average colour (linear) of colour maps whose pixels never reach the CPU (GPU-only
    /// KTX2): read from the cook's `color.avg`, used for automatic far-detail materials.
    pub HashMap<AssetId<Image>, Color>,
);

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

/// A new main camera gets `Msaa::Off` at once, not a frame later from [`apply_camera_quality`]:
/// for that frame it would draw with Bevy's default 4x MSAA. A warm-up sent right after spawning
/// it compiled 4x pipelines that were never used again, and Bevy's prepass depth textures are
/// shared per render target with the first view's sample count, so a 4x frame next to another
/// view on the same target failed wgpu validation ("depth sample count 4, colour 1").
fn main_camera_msaa_off(ev: On<Add<MainCamera>>, mut commands: Commands) {
    commands.entity(ev.event().entity).try_insert(Msaa::Off);
}

impl Plugin for GfxPlugin {
    fn build(&self, app: &mut App) {
        app.add_observer(main_camera_msaa_off);
        app.init_resource::<PendingMips>()
            .init_resource::<QualityPreset>()
            .init_resource::<TextureCapStats>()
            .add_systems(PostUpdate, cap_textures.after(bevy::asset::AssetEventSystems).run_if(has_visuals))
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

/// The buggy lines in Bevy's tonemapping shader (`sectional_color_grading`): 0.19's
/// `tonemapping_shared.wgsl`, still there in 0.20's `tonemapping.wesl`.
const GRADING_BUG: &str = "levels.y = ((level - midtone_range.x) * LEVEL_MARGIN_DIV) + 0.5;\n        levels.z = 1.0 - levels.y;";
const GRADING_FIX: &str = "levels.y = ((level - midtone_range.x) * LEVEL_MARGIN_DIV) + 0.5;\n        levels.x = 1.0 - levels.y;";

/// Fixes Bevy's (0.19, 0.20) sectional colour grading in `source`, or `None` if it has nothing to fix.
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
        // 0.20 ships the tonemapping library as WESL; keep the source kind when patching.
        let (src, wesl) = match &shader.source {
            bevy::shader::Source::Wgsl(s) => (s, false),
            bevy::shader::Source::Wesl(s) => (s, true),
            _ => continue,
        };
        if !src.contains("fn sectional_color_grading") {
            continue;
        }
        *done = true;
        match fix_sectional_grading(src) {
            Some(fixed) => {
                if let Some(mut shader) = shaders.get_mut(*id) {
                    shader.source = if wesl { bevy::shader::Source::Wesl(fixed.into()) } else { bevy::shader::Source::Wgsl(fixed.into()) };
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

/// A PBR texture set under `assets/textures/<name>/`, repeat-wrapped with 16× anisotropy.
/// `None` if there is no colour map (fall back to a flat material).
///
/// - **Cooked** (feature `ktx2`, `color.ktx2` present): `color.ktx2` (sRGB, e.g. BC7),
///   `normal.ktx2` (RG, e.g. BC5: Bevy reconstructs Z) and `orm.ktx2` (R = AO, G = roughness)
///   with their own mip chains, GPU-only (no CPU copy). `color.avg` (three linear floats) gives
///   far-detail materials their colour.
/// - **Source**: `color`, `normal`, `rough`, optional `ao` `.jpg`, with CPU-built mips.
pub fn load_pbr(server: &AssetServer, dir: &AssetsDir, pending: &mut PendingMips, name: &str, tint: Color) -> Option<StandardMaterial> {
    let sampler = || {
        ImageSampler::Descriptor(ImageSamplerDescriptor {
            address_mode_u: ImageAddressMode::Repeat,
            address_mode_v: ImageAddressMode::Repeat,
            // 16x anisotropic + trilinear mips: no shimmer on floors at grazing angles.
            anisotropy_clamp: 16,
            ..ImageSamplerDescriptor::linear()
        })
    };
    if cfg!(feature = "ktx2") && dir.has(&format!("textures/{name}/color.ktx2")) {
        let load = |m: &str| -> Option<Handle<Image>> {
            let p = format!("textures/{name}/{m}.ktx2");
            dir.has(&p).then(|| {
                server
                    .load_builder()
                    .with_settings(move |s: &mut ImageLoaderSettings| {
                        s.sampler = sampler();
                        s.asset_usage = bevy::asset::RenderAssetUsages::RENDER_WORLD;
                    })
                    .load(p)
            })
        };
        let color = load("color");
        if let (Some(c), Some(avg)) = (&color, read_avg(dir, name)) {
            pending.1.insert(c.id(), avg);
        }
        let orm = load("orm");
        return Some(StandardMaterial {
            base_color: tint,
            base_color_texture: color,
            normal_map_texture: load("normal"),
            // R = AO, G = roughness; `metallic: 0` zeroes B.
            occlusion_texture: orm.clone(),
            metallic_roughness_texture: orm,
            perceptual_roughness: 1.0,
            metallic: 0.0,
            ..default()
        });
    }
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
                s.sampler = sampler();
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

/// `textures/<name>/color.avg`: three linear floats (the cooked colour map's average).
fn read_avg(dir: &AssetsDir, name: &str) -> Option<Color> {
    let s = std::fs::read_to_string(dir.0.join(format!("textures/{name}/color.avg"))).ok()?;
    let v: Vec<f32> = s.split_whitespace().filter_map(|x| x.parse().ok()).collect();
    (v.len() >= 3).then(|| Color::LinearRgba(LinearRgba::rgb(v[0], v[1], v[2])))
}

fn generate_mips(
    mut events: MessageReader<AssetEvent<Image>>,
    mut pending: ResMut<PendingMips>,
    mut images: ResMut<Assets<Image>>,
    settings: Res<CoreSettings>,
    preset: Res<QualityPreset>,
    mut stats: ResMut<TextureCapStats>,
) {
    let max = preset.max_texture_size[settings.quality.index()];
    for ev in events.read() {
        let AssetEvent::LoadedWithDependencies { id } = ev else { continue };
        if !pending.0.remove(id) {
            continue;
        }
        if let Some(mut img) = images.get_mut(*id) {
            let full = img.data.as_ref().map_or(0, Vec::len) * 4 / 3;
            build_mips(&mut img);
            if cap_texture_size(&mut img, max).is_some() {
                // Saved against the full-size mip chain.
                stats.add(full.saturating_sub(img.data.as_ref().map_or(0, Vec::len)));
            }
        }
    }
}

/// What [`QualityPreset::max_texture_size`] has done since start (`perf.stats` → `textures`).
#[derive(Resource, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextureCapStats {
    /// Images that lost top mip levels.
    pub capped: u32,
    /// Bytes of texture data not uploaded (against the full-size image with mips).
    pub bytes_saved: u64,
}

impl TextureCapStats {
    fn add(&mut self, saved: usize) {
        self.capped += 1;
        self.bytes_saved += saved as u64;
    }
}

/// Drops the top mip levels of `img` until its larger side is at most `max` (0 = no cap) and
/// returns the bytes removed. Works on 2D images (single layer, arrays, cubemaps) with CPU data
/// and a mip chain, in any format with a fixed block size, mip-major (KTX2) or layer-major (DDS).
/// Untouched (`None`): no data (render targets), one mip level, small enough already, data length
/// not matching the descriptor, a view descriptor that picks mips, or a compressed base level
/// that would not be whole blocks.
pub fn cap_texture_size(img: &mut Image, max: u32) -> Option<usize> {
    let d = &img.texture_descriptor;
    let (w, h, levels) = (d.size.width, d.size.height, d.mip_level_count);
    if max == 0 || w.max(h) <= max || levels < 2 || d.dimension != TextureDimension::D2 {
        return None;
    }
    if img.texture_view_descriptor.as_ref().is_some_and(|v| v.base_mip_level != 0 || v.mip_level_count.is_some()) {
        return None;
    }
    let layers = d.size.depth_or_array_layers.max(1) as usize;
    let (bw, bh) = d.format.block_dimensions();
    let block = d.format.block_copy_size(None)? as usize;
    let side = |s: u32, l: u32| (s >> l).max(1);
    let level_bytes = |l: u32| side(w, l).div_ceil(bw) as usize * side(h, l).div_ceil(bh) as usize * block;
    let data = img.data.as_ref()?;
    let per_layer: usize = (0..levels).map(level_bytes).sum();
    if per_layer * layers != data.len() {
        return None;
    }
    let mut drop = 0;
    while side(w, drop).max(side(h, drop)) > max && drop + 1 < levels {
        drop += 1;
    }
    // A compressed texture's base level must be whole blocks.
    while drop > 0 && (side(w, drop) % bw != 0 || side(h, drop) % bh != 0) {
        drop -= 1;
    }
    if drop == 0 {
        return None;
    }
    let skip: usize = (0..drop).map(level_bytes).sum();
    let out: Vec<u8> = match img.data_order {
        TextureDataOrder::MipMajor => data[skip * layers..].to_vec(),
        TextureDataOrder::LayerMajor => data.chunks_exact(per_layer).flat_map(|l| &l[skip..]).copied().collect(),
    };
    let saved = data.len() - out.len();
    img.data = Some(out);
    let d = &mut img.texture_descriptor;
    d.size.width = side(w, drop);
    d.size.height = side(h, drop);
    d.mip_level_count = levels - drop;
    Some(saved)
}

/// [`cap_texture_size`] for an image without mips: builds the chain ([`build_mips`]: single-layer
/// RGBA8 only), then drops the top levels. Returns the bytes saved against the full-size image
/// with mips; `None` (untouched) when under the cap, without data or not RGBA8.
pub fn cap_mipless(img: &mut Image, max: u32) -> Option<usize> {
    let d = &img.texture_descriptor;
    if max == 0 || d.mip_level_count != 1 || d.size.width.max(d.size.height) <= max || img.data.is_none() {
        return None;
    }
    let full = img.data.as_ref().map_or(0, Vec::len) * 4 / 3;
    build_mips(img);
    if img.texture_descriptor.mip_level_count == 1 {
        return None;
    }
    cap_texture_size(img, max)?;
    Some(full.saturating_sub(img.data.as_ref().map_or(0, Vec::len)))
}

/// A material's mip-less texture: capped if loaded (`true`), `false` while it is not loaded yet.
fn cap_material_image(id: AssetId<Image>, fresh: bool, max: u32, images: &mut Assets<Image>, stats: &mut TextureCapStats) -> bool {
    let Some(img) = images.get(id) else { return false };
    let d = &img.texture_descriptor;
    if img.data.is_none() || d.mip_level_count != 1 || d.size.width.max(d.size.height) <= max {
        return true;
    }
    // Fresh images are not extracted yet: change them in place. Older ones still have their data
    // only if they are MAIN_WORLD too; a tracked change uploads the capped version.
    let saved = if fresh { images.get_mut_untracked(id).and_then(|i| cap_mipless(i, max)) } else { images.get_mut(id).and_then(|mut i| cap_mipless(&mut i, max)) };
    if let Some(s) = saved {
        stats.add(s);
    }
    true
}

/// Applies [`QualityPreset::max_texture_size`] to images as they are added: in `PostUpdate`
/// after Bevy publishes the frame's asset events and before extraction takes GPU-only images'
/// data, through `get_mut_untracked` so the full-size image is never uploaded. Mip-less material
/// textures are found through `StandardMaterial` events and capped once both are loaded. Idle
/// cost: reading the frame's asset events.
#[allow(clippy::too_many_arguments)]
fn cap_textures(
    settings: Res<CoreSettings>,
    preset: Res<QualityPreset>,
    mut image_events: MessageReader<AssetEvent<Image>>,
    material_events: Option<Res<Messages<AssetEvent<StandardMaterial>>>>,
    mut material_cursor: Local<MessageCursor<AssetEvent<StandardMaterial>>>,
    materials: Option<Res<Assets<StandardMaterial>>>,
    mut images: ResMut<Assets<Image>>,
    pending: Res<PendingMips>,
    mut stats: ResMut<TextureCapStats>,
    mut added: Local<Vec<AssetId<Image>>>,
    mut waiting: Local<HashSet<AssetId<Image>>>,
) {
    let max = preset.max_texture_size[settings.quality.index()];
    added.clear();
    added.extend(image_events.read().filter_map(|e| match e {
        AssetEvent::Added { id } => Some(*id),
        _ => None,
    }));
    let Some(material_events) = material_events.as_deref() else { return cap_added(&added, &mut waiting, max, &mut images, &mut stats) };
    let mids = material_cursor.read(material_events).filter_map(|e| match e {
        AssetEvent::Added { id } | AssetEvent::Modified { id } => Some(*id),
        _ => None,
    });
    match materials.as_deref() {
        Some(materials) if max != 0 && preset.cap_material_images => {
            for mid in mids {
                let Some(m) = materials.get(mid) else { continue };
                let slots = [&m.base_color_texture, &m.normal_map_texture, &m.metallic_roughness_texture, &m.occlusion_texture, &m.emissive_texture];
                for id in slots.into_iter().flatten().map(Handle::id) {
                    if !pending.0.contains(&id) && !cap_material_image(id, added.contains(&id), max, &mut images, &mut stats) {
                        waiting.insert(id);
                    }
                }
            }
        }
        _ => mids.for_each(drop),
    }
    cap_added(&added, &mut waiting, max, &mut images, &mut stats);
}

fn cap_added(added: &[AssetId<Image>], waiting: &mut HashSet<AssetId<Image>>, max: u32, images: &mut Assets<Image>, stats: &mut TextureCapStats) {
    if max == 0 {
        return;
    }
    for &id in added {
        if waiting.remove(&id) {
            cap_material_image(id, true, max, images, stats);
        }
        if let Some(saved) = images.get_mut_untracked(id).and_then(|i| cap_texture_size(i, max)) {
            stats.add(saved);
        }
    }
}

/// Box-filtered mip chain for single-layer RGBA8 images without mips (others untouched);
/// sRGB colour is filtered in linear light.
pub fn build_mips(img: &mut Image) {
    let fmt = img.texture_descriptor.format;
    if !matches!(fmt, TextureFormat::Rgba8Unorm | TextureFormat::Rgba8UnormSrgb)
        || img.texture_descriptor.mip_level_count != 1
        || img.texture_descriptor.size.depth_or_array_layers != 1
    {
        return;
    }
    let Some(base) = img.data.take() else { return };
    // sRGB colour is averaged in linear light (averaging the encoded values darkens distant
    // mips); alpha and non-sRGB data are averaged as stored.
    let srgb = fmt == TextureFormat::Rgba8UnormSrgb;
    let to_lin: [f32; 256] = std::array::from_fn(|i| {
        let c = i as f32 / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    });
    let to_srgb = |l: f32| -> u8 {
        let l = l.clamp(0.0, 1.0);
        let c = if l <= 0.0031308 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 };
        (c * 255.0 + 0.5) as u8
    };
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
                    let texels = [(0, 0), (1, 0), (0, 1), (1, 1)].map(|(dx, dy)| {
                        let sx = (x * 2 + dx).min(w - 1);
                        let sy = (y * 2 + dy).min(h - 1);
                        prev[(sy * w + sx) * 4 + c]
                    });
                    next[(y * nw + x) * 4 + c] = if srgb && c < 3 {
                        to_srgb(texels.iter().map(|&v| to_lin[v as usize]).sum::<f32>() / 4.0)
                    } else {
                        ((texels.iter().map(|&v| v as u32).sum::<u32>() + 2) / 4) as u8
                    };
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
            // Update with the Bevy version in Cargo.toml (the old copy stays in the cache).
            let f = reg.path().join("bevy_core_pipeline-0.20.1/src/tonemapping.wesl");
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
    fn srgb_mips_average_in_linear_light() {
        // Black and white texels: the linear mean (0.5) encodes to sRGB 188, not 128.
        let px: Vec<u8> = [0u8, 255].iter().flat_map(|&v| [v, v, v, 255]).collect();
        let mut img = Image::new(
            Extent3d { width: 2, height: 1, depth_or_array_layers: 1 },
            TextureDimension::D2,
            px,
            TextureFormat::Rgba8UnormSrgb,
            RenderAssetUsages::RENDER_WORLD,
        );
        build_mips(&mut img);
        let d = img.data.unwrap();
        assert_eq!(&d[8..12], &[188, 188, 188, 255]);
    }

    /// A `w`×`h` image of `format` with a full mip chain (each level filled with its index).
    fn with_mips(w: u32, h: u32, layers: u32, format: TextureFormat, order: TextureDataOrder) -> Image {
        let levels = 32 - w.max(h).leading_zeros();
        let (bw, bh) = format.block_dimensions();
        let block = format.block_copy_size(None).unwrap() as usize;
        let level = |l: u32| ((w >> l).max(1).div_ceil(bw) * (h >> l).max(1).div_ceil(bh)) as usize * block;
        let mut data = Vec::new();
        match order {
            TextureDataOrder::MipMajor => (0..levels).for_each(|l| (0..layers).for_each(|_| data.extend(std::iter::repeat_n(l as u8, level(l))))),
            TextureDataOrder::LayerMajor => (0..layers).for_each(|_| (0..levels).for_each(|l| data.extend(std::iter::repeat_n(l as u8, level(l))))),
        }
        let mut img = Image::new_uninit(Extent3d { width: w, height: h, depth_or_array_layers: layers }, TextureDimension::D2, format, RenderAssetUsages::RENDER_WORLD);
        img.data = Some(data);
        img.data_order = order;
        img.texture_descriptor.mip_level_count = levels;
        img
    }

    #[test]
    fn bc7_2048_capped_to_1024_drops_one_level() {
        let mut img = with_mips(2048, 2048, 1, TextureFormat::Bc7RgbaUnormSrgb, TextureDataOrder::MipMajor);
        assert_eq!(img.texture_descriptor.mip_level_count, 12);
        let before = img.data.as_ref().unwrap().len();
        let saved = cap_texture_size(&mut img, 1024).unwrap();
        assert_eq!(saved, 2048 * 2048); // BC7: 1 byte per texel
        let d = &img.texture_descriptor;
        assert_eq!((d.size.width, d.size.height, d.mip_level_count), (1024, 1024, 11));
        let data = img.data.unwrap();
        assert_eq!(data.len(), before - saved);
        // 1024² … 4×4 at 1 B/texel, then 2×2 and 1×1 still take one 16-byte block each.
        let expect: usize = (0..9).map(|l| (1024usize >> l).pow(2)).sum::<usize>() + 2 * 16;
        assert_eq!(data.len(), expect);
        assert_eq!(data[0], 1, "new base is the old level 1");
        assert!(before > 5_500_000 && data.len() < 1_400_000);
    }

    #[test]
    fn cap_handles_arrays_in_both_orders() {
        for order in [TextureDataOrder::MipMajor, TextureDataOrder::LayerMajor] {
            let mut img = with_mips(256, 128, 3, TextureFormat::Bc5RgUnorm, order);
            cap_texture_size(&mut img, 64).unwrap();
            let d = &img.texture_descriptor;
            assert_eq!((d.size.width, d.size.height, d.mip_level_count), (64, 32, 7));
            // Same as a 64×32 chain whose level i holds the old level i + 2.
            let mut want = with_mips(64, 32, 3, TextureFormat::Bc5RgUnorm, order);
            want.data.as_mut().unwrap().iter_mut().for_each(|b| *b += 2);
            assert_eq!(img, want, "{order:?}");
        }
    }

    #[test]
    fn rgba8_without_mips_is_built_then_capped() {
        let mut img = Image::new(
            Extent3d { width: 64, height: 32, depth_or_array_layers: 1 },
            TextureDimension::D2,
            vec![200; 64 * 32 * 4],
            TextureFormat::Rgba8Unorm,
            RenderAssetUsages::default(),
        );
        let saved = cap_mipless(&mut img, 16).unwrap();
        let d = &img.texture_descriptor;
        assert_eq!((d.size.width, d.size.height, d.mip_level_count), (16, 8, 5));
        let len = img.data.as_ref().unwrap().len();
        assert_eq!(len, (16 * 8 + 8 * 4 + 4 * 2 + 2 + 1) * 4);
        assert_eq!(saved, 64 * 32 * 4 * 4 / 3 - len);
        assert!(img.data.unwrap().iter().all(|&b| b == 200));
    }

    #[test]
    fn small_mipless_and_target_images_are_untouched() {
        let mut small = with_mips(1024, 1024, 1, TextureFormat::Bc7RgbaUnorm, TextureDataOrder::MipMajor);
        let copy = small.clone();
        assert_eq!(cap_texture_size(&mut small, 1024), None);
        assert_eq!(cap_texture_size(&mut small, 0), None);
        assert_eq!(small, copy);
        // No mip chain: only `cap_mipless` touches it.
        let mut flat = Image::new_fill(Extent3d { width: 4096, height: 4096, depth_or_array_layers: 1 }, TextureDimension::D2, &[0, 0, 0, 255], TextureFormat::Rgba8UnormSrgb, RenderAssetUsages::default());
        assert_eq!(cap_texture_size(&mut flat, 1024), None);
        assert_eq!(flat.texture_descriptor.size.width, 4096);
        // Render target: no data.
        let mut target = Image::new_target_texture(4096, 4096, TextureFormat::Rgba8Unorm, None);
        target.texture_descriptor.mip_level_count = 13;
        assert_eq!(cap_texture_size(&mut target, 1024), None);
        assert_eq!(cap_mipless(&mut target, 1024), None);
        assert_eq!(target.texture_descriptor.size.width, 4096);
        // A compressed base that would not be whole blocks stays as it is.
        let mut odd = with_mips(8, 2, 1, TextureFormat::Bc7RgbaUnorm, TextureDataOrder::MipMajor);
        assert_eq!(cap_texture_size(&mut odd, 4), None);
    }

    /// The system: images added this frame are capped before extraction would see them; a
    /// material's mip-less texture is capped whether the material or the image arrives first.
    #[test]
    fn cap_system_caps_added_and_material_images() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_plugins(bevy::asset::AssetPlugin::default())
            .init_asset::<Image>()
            .init_asset::<StandardMaterial>()
            .insert_resource(CoreSettings { quality: GraphicsQuality::Low, ..default() })
            .init_resource::<QualityPreset>()
            .init_resource::<PendingMips>()
            .init_resource::<TextureCapStats>()
            .add_systems(PostUpdate, cap_textures.after(bevy::asset::AssetEventSystems));
        let rgba = |side| Image::new_fill(Extent3d { width: side, height: side, depth_or_array_layers: 1 }, TextureDimension::D2, &[9, 9, 9, 255], TextureFormat::Rgba8UnormSrgb, RenderAssetUsages::RENDER_WORLD);
        let w = app.world_mut();
        let (cooked, ui, early) = {
            let mut images = w.resource_mut::<Assets<Image>>();
            let cooked = images.add(with_mips(2048, 2048, 1, TextureFormat::Bc7RgbaUnormSrgb, TextureDataOrder::MipMajor));
            (cooked, images.add(rgba(2048)), images.add(rgba(2048)))
        };
        let late = w.resource::<Assets<Image>>().reserve_handle();
        let _mats = {
            let mut mats = w.resource_mut::<Assets<StandardMaterial>>();
            [mats.add(StandardMaterial { base_color_texture: Some(early.clone()), ..default() }), mats.add(StandardMaterial { normal_map_texture: Some(late.clone()), ..default() })]
        };
        app.update();
        let side = |app: &App, h: &Handle<Image>| app.world().resource::<Assets<Image>>().get(h).unwrap().texture_descriptor.size.width;
        assert_eq!(side(&app, &cooked), 1024);
        assert_eq!(side(&app, &early), 1024);
        assert_eq!(side(&app, &ui), 2048, "mip-less images outside materials are left alone");
        // The material's image arrives later.
        app.world_mut().resource_mut::<Assets<Image>>().insert(&late, rgba(4096)).unwrap();
        app.update();
        assert_eq!(side(&app, &late), 1024);
        assert_eq!(app.world().resource::<TextureCapStats>().capped, 3);
    }

    #[test]
    fn world_uvs_tile_by_metres() {
        let m = world_uv_cuboid(Vec3::new(2.0, 1.0, 2.0), Vec3::ZERO, 1.0);
        let Some(VertexAttributeValues::Float32x2(uv)) = m.attribute(Mesh::ATTRIBUTE_UV_0) else { panic!("no uvs") };
        let max = uv.iter().map(|u| u[0].abs()).fold(0.0, f32::max);
        assert!((max - 1.0).abs() < 1e-5);
    }

    /// Bevy 0.20 dropped naga_oil: shaders with `#import` / `#ifdef` / `#{DEF}` fail to compile
    /// at runtime (only when first drawn), so `cargo test` never sees it. Engine shaders are WESL.
    #[test]
    fn engine_shaders_use_no_naga_oil_directives() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![root];
        let mut checked = 0;
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                let src = std::fs::read_to_string(&path).unwrap_or_default();
                // Shader files, and Rust files that carry inline shader source.
                let shader = matches!(ext, "wgsl" | "wesl") || (ext == "rs" && src.contains("@fragment") && !path.ends_with("gfx.rs"));
                if !shader {
                    continue;
                }
                checked += 1;
                assert!(ext != "wgsl" || !src.contains("import "), "{}: imports need a .wesl file", path.display());
                for (i, line) in src.lines().enumerate() {
                    let t = line.trim_start();
                    let bad = ["#import", "#ifdef", "#ifndef", "#else", "#endif", "#define", "#{"].iter().any(|d| t.starts_with(d) || line.contains("#{"));
                    assert!(!bad, "{}:{}: naga_oil directive (Bevy 0.20 shaders are WESL): {line}", path.display(), i + 1);
                }
            }
        }
        assert!(checked >= 4, "found only {checked} shaders");
    }
}
