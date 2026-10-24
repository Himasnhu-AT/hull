//! Rendering presets and texture helpers. Owner: core stream (ported from Shroud `gfx.rs`).
//!
//! - Tag the game's camera with [`MainCamera`]; on `Camera3d` main cameras the engine adds the
//!   quality bundle for `CoreSettings.quality` (from [`QualityPreset`]: FXAA or TAA, SSAO,
//!   bloom, directional shadow-map size) plus `Msaa::Off`, keeps FOV in sync with
//!   `CoreSettings.fov_deg` (perspective only), and re-applies when settings change. The spatial
//!   audio listener is attached by `audio`. The engine never touches `Exposure`,
//!   `DistanceFog`, `Tonemapping` or atmosphere components (games own the look).
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
use bevy::pbr::{ScreenSpaceAmbientOcclusion, ScreenSpaceAmbientOcclusionQualityLevel};
use bevy::platform::collections::HashSet;
use bevy::post_process::bloom::Bloom;
use bevy::prelude::*;
use bevy::render::camera::{MipBias, TemporalJitter};
use bevy::render::render_resource::TextureFormat;

use crate::flow::has_visuals;
use crate::paths::AssetsDir;
use crate::settings::{CoreSettings, GraphicsQuality};

/// The camera the player sees through (one per app).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct MainCamera;

/// Per-quality camera features (Low: no SSAO/bloom, FXAA, small shadows … Ultra: best SSAO,
/// big shadows). Indexed by [`GraphicsQuality::index`]. Games may override the resource.
#[derive(Resource, Clone, Debug)]
pub struct QualityPreset {
    pub ssao: [bool; 4],
    pub bloom: [bool; 4],
    /// TAA when true, FXAA when false.
    pub taa: [bool; 4],
    pub shadow_map_size: [usize; 4],
    /// Bloom strength when enabled.
    pub bloom_intensity: f32,
    /// GPU occlusion culling on the main camera (adds a depth prepass when the camera has none;
    /// see `render_budget`). Only used where the GPU supports it.
    pub occlusion_culling: [bool; 4],
    /// Multiplier on `render_budget::SceneryRanges` (scenery detail and streaming distances).
    pub detail_scale: [f32; 4],
}

impl Default for QualityPreset {
    fn default() -> Self {
        QualityPreset {
            ssao: [false, false, true, true],
            bloom: [false, true, true, true],
            taa: [false, true, true, true],
            shadow_map_size: [1024, 2048, 2048, 4096],
            bloom_intensity: 0.12,
            occlusion_culling: [true, true, true, true],
            detail_scale: [0.6, 0.8, 1.0, 1.5],
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
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct FaceCamera;

/// Marker on the directional light spawned by [`sky_and_sun`].
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Sun;

pub struct GfxPlugin;

impl Plugin for GfxPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PendingMips>()
            .init_resource::<QualityPreset>()
            .add_systems(Update, (generate_mips, face_camera, apply_camera_quality, apply_fov).run_if(has_visuals));
    }
}

/// Adds/removes AA, SSAO and bloom on `Camera3d` main cameras when they appear, when
/// `CoreSettings.quality` changes, or when [`QualityPreset`] changes; sets shadow-map size.
pub fn apply_camera_quality(
    mut commands: Commands,
    settings: Res<CoreSettings>,
    preset: Res<QualityPreset>,
    cams: Query<(Entity, Option<&AppliedQuality>), (With<MainCamera>, With<Camera3d>)>,
    shadow_map: Option<ResMut<DirectionalLightShadowMap>>,
) {
    let q = settings.quality;
    let i = q.index();
    let force = preset.is_changed();
    let mut applied_any = false;
    for (e, applied) in &cams {
        if !force && applied.is_some_and(|a| a.0 == q) {
            continue;
        }
        applied_any = true;
        let mut ec = commands.entity(e);
        ec.insert((AppliedQuality(q), Msaa::Off));
        if preset.taa[i] {
            ec.remove::<Fxaa>().insert(TemporalAntiAliasing::default());
        } else {
            ec.remove::<(TemporalAntiAliasing, TemporalJitter, MipBias)>().insert(Fxaa::default());
        }
        if preset.ssao[i] {
            let quality_level = if q == GraphicsQuality::Ultra {
                ScreenSpaceAmbientOcclusionQualityLevel::Ultra
            } else {
                ScreenSpaceAmbientOcclusionQualityLevel::High
            };
            ec.insert(ScreenSpaceAmbientOcclusion { quality_level, ..default() });
        } else {
            ec.remove::<ScreenSpaceAmbientOcclusion>();
        }
        if preset.bloom[i] {
            ec.insert(Bloom { intensity: preset.bloom_intensity, ..Bloom::NATURAL });
        } else {
            ec.remove::<Bloom>();
        }
    }
    if (applied_any || settings.is_changed())
        && let Some(mut shadow_map) = shadow_map
        && shadow_map.size != preset.shadow_map_size[i]
    {
        shadow_map.size = preset.shadow_map_size[i];
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
