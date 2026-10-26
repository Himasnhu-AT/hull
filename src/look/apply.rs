//! [`Look`] → components. One exclusive system ([`apply_look`]) runs only when the look, the
//! quality tier, the settings or the main cameras changed (or every frame while a transition /
//! timeline animates the look), and writes components in place (insert when missing, remove
//! when off). Nothing runs while no `Look` resource exists.

use std::borrow::Cow;

use bevy::asset::AssetPath;
use bevy::camera::{Exposure, Hdr};
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::light::atmosphere::ScatteringMedium;
use bevy::light::{
    Atmosphere, AtmosphereEnvironmentMapLight, CascadeShadowConfigBuilder, EnvironmentMapLight, FogVolume, GeneratedEnvironmentMapLight,
    GlobalAmbientLight, Skybox, SunDisk, VolumetricFog, VolumetricLight,
};
use bevy::math::cubic_splines::LinearSpline;
use bevy::pbr::{AtmosphereSettings, DistanceFog, FogFalloff};
use bevy::post_process::auto_exposure::{AutoExposure, AutoExposureCompensationCurve};
use bevy::post_process::bloom::{Bloom, BloomCompositeMode, BloomPrefilter};
use bevy::post_process::dof::{DepthOfField, DepthOfFieldMode};
use bevy::post_process::effect_stack::{ChromaticAberration, LensDistortion, Vignette};
use bevy::post_process::motion_blur::MotionBlur;
use bevy::prelude::*;
use bevy::render::view::{ColorGrading, ColorGradingGlobal, ColorGradingSection};

use super::desc::*;
use super::grain::FilmGrain;
use super::sky::{SkyGradient, fill_sky_cubemap, fill_sky_data, new_cubemap};
use crate::gfx::{AppliedQuality, MainCamera, QualityPreset, Sun};
use crate::settings::{CoreSettings, GraphicsQuality};

/// Engine-side knobs for the look module (not part of a `Look`).
#[derive(Resource, Clone, Debug)]
pub struct LookConfig {
    /// Face size (px, power of two) of the procedural gradient sky cubemap.
    pub sky_cubemap_size: u32,
    /// While a gradient sky animates, rebuild its cubemap at most this often (Hz).
    pub sky_rebuild_hz: f32,
    /// Stop refiltering a static sky's env light after the GPU filtered it this many times
    /// (0 = refilter every frame, Bevy's behaviour).
    pub freeze_env_after: u32,
}

impl Default for LookConfig {
    fn default() -> Self {
        LookConfig { sky_cubemap_size: 256, sky_rebuild_hz: 10.0, freeze_env_after: 4 }
    }
}

/// What the current quality tier allows (from [`QualityPreset`] at `CoreSettings.quality`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tier {
    pub quality: GraphicsQuality,
    pub bloom: bool,
    pub taa: bool,
    pub volumetric_fog: bool,
    pub volumetric_steps: u32,
    pub env_light: bool,
    pub env_map_size: u32,
    pub sky_samples: u32,
    pub auto_exposure: bool,
    pub camera_fx: bool,
    pub post_fx: bool,
    pub bokeh: bool,
    pub probe_refresh: u32,
    pub soft_shadows: bool,
}

impl Tier {
    pub fn of(p: &QualityPreset, quality: GraphicsQuality) -> Tier {
        let i = quality.index();
        Tier {
            quality,
            bloom: p.bloom[i],
            taa: p.taa[i],
            volumetric_fog: p.volumetric_fog[i],
            volumetric_steps: p.volumetric_steps[i],
            env_light: p.env_light[i],
            env_map_size: p.env_map_size[i],
            sky_samples: p.sky_samples[i],
            auto_exposure: p.auto_exposure[i],
            camera_fx: p.camera_fx[i],
            post_fx: p.post_fx[i],
            bokeh: p.bokeh[i],
            probe_refresh: p.probe_refresh[i],
            soft_shadows: p.soft_shadows[i],
        }
    }
}

/// The look's own sun (spawned when no [`Sun`] exists).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct LookSun;

/// The atmosphere entity the look spawned (an existing game `Atmosphere` is used instead).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct LookAtmosphere;

/// The look's volumetric `FogVolume` box.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct LookFogVolume;

/// Cameras the look applies to besides the [`MainCamera`] (reflection-probe capture cameras get
/// the sky, fog and exposure but no post effects).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct LookCapture;

/// Bookkeeping between applies.
#[derive(Resource, Default)]
pub struct LookState {
    /// Procedural sky cubemap (gradient / colour skies).
    pub sky_image: Option<Handle<Image>>,
    sky_key: Option<[f32; 16]>,
    sky_built_at: f64,
    /// Latest gradient waiting for a background rebuild.
    sky_want: Option<(SkyGradient, [f32; 16])>,
    sky_job: Option<SkyJob>,
    spare: Option<Vec<u8>>,
    /// The look was applied since `freeze_env` last looked.
    env_dirty: bool,
    env_filtered_at: u32,
    /// Loaded cubemap-mode images: (path, cubemap, diffuse, specular).
    cubemap: Option<(String, Handle<Image>, Option<Handle<Image>>, Option<Handle<Image>>)>,
    curve: Option<(u32, Handle<AutoExposureCompensationCurve>)>,
    /// Environment light size currently set up from the atmosphere.
    medium: Option<Handle<ScatteringMedium>>,
    /// Number of applies so far (tests, `look.get`).
    pub applies: u64,
    /// Last apply's cost, µs.
    pub last_apply_us: f32,
}

/// Run condition: something the look depends on changed.
pub fn look_dirty(
    look: Option<Res<Look>>,
    preset: Res<QualityPreset>,
    settings: Res<CoreSettings>,
    state: Res<LookState>,
    cams: Query<(), (Or<(With<MainCamera>, With<LookCapture>)>, With<Camera3d>, Or<(Added<Camera3d>, Added<MainCamera>, Added<LookCapture>, Changed<AppliedQuality>)>)>,
) -> bool {
    let Some(look) = look else { return false };
    let _ = state;
    look.is_changed() || preset.is_changed() || settings.is_changed() || !cams.is_empty()
}

/// Run condition for [`pump_sky`].
pub fn sky_busy(st: Res<LookState>) -> bool {
    st.sky_want.is_some() || st.sky_job.is_some()
}

/// Applies the [`Look`] resource to the main camera(s), sun, sky, ambient and fog volume.
pub fn apply_look(world: &mut World, mut cams: Local<Vec<(Entity, bool)>>) {
    let t0 = std::time::Instant::now();
    let Some(look) = world.get_resource::<Look>().cloned() else { return };
    let tier = Tier::of(world.resource::<QualityPreset>(), world.resource::<CoreSettings>().quality);
    let elapsed = world.get_resource::<Time<Real>>().map(|t| t.elapsed_secs_f64()).unwrap_or(0.0);

    cams.clear();
    let mut q = world.query_filtered::<(Entity, Has<MainCamera>), (Or<(With<MainCamera>, With<LookCapture>)>, With<Camera3d>)>();
    cams.extend(q.iter(world));

    apply_sun(world, &look, &tier);
    world.insert_resource(GlobalAmbientLight { color: look.ambient.color.color(), brightness: look.ambient.brightness, affects_lightmapped_meshes: true });
    let captures = cams.iter().any(|(_, main)| !main);
    let sky = prepare_sky(world, &look, &tier, elapsed, captures);
    apply_fog_volume(world, &look, &tier);
    let curve = exposure_curve(world, &look);

    for &(e, main) in cams.iter() {
        apply_camera(world, e, main, &look, &tier, &sky, curve.as_ref());
    }

    let mut st = world.resource_mut::<LookState>();
    st.applies += 1;
    st.env_dirty = true;
    st.last_apply_us = t0.elapsed().as_secs_f32() * 1e6;
}

/// Insert, overwrite in place, or remove a component.
fn put<T: Component<Mutability = bevy::ecs::component::Mutable>>(em: &mut EntityWorldMut, v: Option<T>) {
    match v {
        Some(v) => match em.get_mut::<T>() {
            Some(mut c) => *c = v,
            None => {
                em.insert(v);
            }
        },
        None => {
            if em.contains::<T>() {
                em.remove::<T>();
            }
        }
    }
}

fn apply_sun(world: &mut World, look: &Look, tier: &Tier) {
    let s = &look.sun;
    let mut q = world.query_filtered::<Entity, With<Sun>>();
    let existing = q.iter(world).next();
    let e = match existing {
        Some(e) => e,
        None if s.enabled => world.spawn((Name::new("Sun"), Sun, LookSun, DirectionalLight::default())).id(),
        None => return,
    };
    let dir = s.direction();
    // Fade out as the sun sinks below the horizon.
    let fade = ((s.elevation_deg + 3.0) / 3.0).clamp(0.0, 1.0);
    let lit = s.enabled && fade > 0.0;
    let mut em = world.entity_mut(e);
    if let Some(mut l) = em.get_mut::<DirectionalLight>() {
        l.illuminance = s.illuminance * fade;
        l.color = s.color.color();
        l.shadow_maps_enabled = s.shadows && lit && s.elevation_deg > -1.0;
        #[cfg(feature = "look_pcss")]
        {
            l.soft_shadow_size = (tier.soft_shadows && s.soft_shadow_size > 0.0).then_some(s.soft_shadow_size);
        }
    }
    #[cfg(not(feature = "look_pcss"))]
    let _ = tier.soft_shadows;
    let up = if dir.y.abs() > 0.99 { Vec3::Z } else { Vec3::Y };
    let tf = Transform::default().looking_to(dir, up);
    put(&mut em, Some(tf));
    put(&mut em, Some(if lit { Visibility::Inherited } else { Visibility::Hidden }));
    put(
        &mut em,
        Some(
            CascadeShadowConfigBuilder {
                num_cascades: s.cascades.clamp(1, 4) as usize,
                first_cascade_far_bound: s.first_cascade.max(0.5),
                maximum_distance: s.shadow_distance.max(s.first_cascade + 1.0),
                ..default()
            }
            .build(),
        ),
    );
    let disk = (look.sky.mode == SkyMode::Atmosphere).then(|| SunDisk { angular_size: s.disk_size_deg.max(0.0).to_radians(), intensity: s.disk_intensity });
    put(&mut em, disk);
    let shafts = look.volumetric.enabled && look.volumetric.sun_shafts && tier.volumetric_fog;
    put(&mut em, shafts.then_some(VolumetricLight));
}

/// What the sky gives each camera.
#[derive(Clone, Debug, Default)]
struct SkyOut {
    atmosphere: bool,
    skybox: Option<(Handle<Image>, f32)>,
    env: Env,
    /// What probe capture cameras get instead.
    capture_skybox: Option<(Handle<Image>, f32)>,
    capture_env: Env,
}

#[derive(Clone, Debug, Default)]
enum Env {
    #[default]
    None,
    Atmosphere {
        size: u32,
        intensity: f32,
    },
    Generated {
        image: Handle<Image>,
        intensity: f32,
    },
    Prefiltered {
        diffuse: Handle<Image>,
        specular: Handle<Image>,
        intensity: f32,
    },
}

fn gradient_of(look: &Look) -> SkyGradient {
    let k = &look.sky;
    let (zenith, horizon) = if k.mode == SkyMode::Color { (k.horizon.linear(), k.horizon.linear()) } else { (k.zenith.linear(), k.horizon.linear()) };
    SkyGradient {
        zenith,
        horizon,
        ground: k.ground.linear(),
        to_sun: -look.sun.direction(),
        sun_color: if look.sun.enabled { look.sun.color.linear() } else { Vec3::ZERO },
        sun_glow: if k.mode == SkyMode::Color { 0.0 } else { k.sun_glow },
        stars: if k.mode == SkyMode::Color { 0.0 } else { k.stars },
    }
}

fn gradient_key(g: &SkyGradient) -> [f32; 16] {
    [
        g.zenith.x, g.zenith.y, g.zenith.z, g.horizon.x, g.horizon.y, g.horizon.z, g.ground.x, g.ground.y, g.ground.z, g.to_sun.x, g.to_sun.y,
        g.to_sun.z, g.sun_color.x + g.sun_color.y * 3.1 + g.sun_color.z * 7.3, g.sun_glow, g.stars, 0.0,
    ]
}

fn prepare_sky(world: &mut World, look: &Look, tier: &Tier, now: f64, captures: bool) -> SkyOut {
    let k = &look.sky;
    let env_on = tier.env_light && look.ambient.env_intensity > 0.0;
    let has_medium = world.contains_resource::<Assets<ScatteringMedium>>();
    let has_images = world.contains_resource::<Assets<Image>>();
    let mut out = SkyOut::default();

    // Atmosphere entity: the game's, else ours; ours goes when the sky isn't an atmosphere.
    let want_atmo = k.mode == SkyMode::Atmosphere;
    let mut q = world.query_filtered::<(Entity, Has<LookAtmosphere>), With<Atmosphere>>();
    let atmos: Vec<(Entity, bool)> = q.iter(world).collect();
    if want_atmo {
        if atmos.is_empty() && has_medium {
            // The medium outlives the entity: the render world may still reference it for a
            // frame after the sky switches away (a dropped medium panics there).
            let medium = match world.resource::<LookState>().medium.clone() {
                Some(m) => m,
                None => {
                    let m = world.resource_mut::<Assets<ScatteringMedium>>().add(ScatteringMedium::earth(256, 256));
                    world.resource_mut::<LookState>().medium = Some(m.clone());
                    m
                }
            };
            world.spawn((Name::new("Atmosphere"), LookAtmosphere, Atmosphere::earth(medium)));
        }
        out.atmosphere = true;
        if env_on {
            out.env = Env::Atmosphere { size: tier.env_map_size.max(16).next_power_of_two(), intensity: look.ambient.env_intensity };
        }
        // Probe captures see the gradient approximation of the sky: per-view atmosphere LUTs
        // are costly, and a camera that is active for single frames trips Bevy's atmosphere
        // bind groups.
        if captures && has_images {
            let h = gradient_cubemap(world, look, now);
            out.capture_skybox = Some((h.clone(), k.brightness));
            if env_on {
                out.capture_env = Env::Generated { image: h, intensity: k.brightness * look.ambient.env_intensity };
            }
        }
        return out;
    }
    for (e, ours) in atmos {
        if ours {
            world.despawn(e);
        }
    }
    if !has_images {
        return out;
    }

    if k.mode == SkyMode::Cubemap && !k.cubemap.is_empty() {
        let (cube, diffuse, specular) = load_cubemap(world, k);
        out.skybox = Some((cube.clone(), k.brightness));
        if env_on {
            let intensity = k.brightness * look.ambient.env_intensity;
            out.env = match (diffuse, specular) {
                (Some(diffuse), Some(specular)) => Env::Prefiltered { diffuse, specular, intensity },
                _ => Env::Generated { image: cube, intensity },
            };
        }
    } else {
        let handle = gradient_cubemap(world, look, now);
        if k.mode == SkyMode::Color {
            world.insert_resource(ClearColor(k.horizon.color()));
        } else {
            out.skybox = Some((handle.clone(), k.brightness));
        }
        if env_on {
            out.env = Env::Generated { image: handle, intensity: k.brightness * look.ambient.env_intensity };
        }
    }
    out.capture_skybox = out.skybox.clone();
    out.capture_env = out.env.clone();
    out
}

/// The procedural gradient cubemap for `look`. The first build is synchronous; later changes
/// are rebuilt on a background thread ([`pump_sky`]), at most `LookConfig::sky_rebuild_hz`
/// times a second, so animating a look never stalls a frame.
fn gradient_cubemap(world: &mut World, look: &Look, _now: f64) -> Handle<Image> {
    let g = gradient_of(look);
    let key = gradient_key(&g);
    let size = world.resource::<LookConfig>().sky_cubemap_size.max(4).next_power_of_two();
    let handle = world.resource::<LookState>().sky_image.clone();
    let mut images = world.resource_mut::<Assets<Image>>();
    if let Some(h) = handle.filter(|h| images.get(h).is_some_and(|i| i.texture_descriptor.size.width == size)) {
        let mut st = world.resource_mut::<LookState>();
        if st.sky_key != Some(key) {
            st.sky_want = Some((g, key));
        }
        return h;
    }
    let mut img = new_cubemap(size);
    fill_sky_cubemap(&mut img, &g);
    let h = images.add(img);
    let mut st = world.resource_mut::<LookState>();
    st.sky_image = Some(h.clone());
    st.sky_key = Some(key);
    st.sky_want = None;
    h
}

/// A background rebuild of the gradient sky.
pub struct SkyJob {
    task: bevy::tasks::Task<Vec<u8>>,
    key: [f32; 16],
}

/// Starts / finishes background rebuilds of the gradient sky cubemap (runs only while one is
/// wanted or running). The finished pixels are swapped in (no copy) and the previous buffer is
/// reused for the next job.
pub fn pump_sky(mut st: ResMut<LookState>, config: Res<LookConfig>, time: Res<Time<Real>>, images: Option<ResMut<Assets<Image>>>) {
    let Some(mut images) = images else { return };
    let st = &mut *st;
    if let Some(job) = st.sky_job.as_mut()
        && let Some(data) = bevy::tasks::futures::check_ready(&mut job.task)
    {
        let key = job.key;
        st.sky_job = None;
        if let Some(mut img) = st.sky_image.as_ref().and_then(|h| images.get_mut(h))
            && img.data.as_ref().is_some_and(|d| d.len() == data.len())
        {
            st.spare = img.data.replace(data);
            st.sky_key = Some(key);
        }
    }
    let now = time.elapsed_secs_f64();
    if st.sky_job.is_none() && now - st.sky_built_at >= 1.0 / config.sky_rebuild_hz.max(0.1) as f64 {
        let Some((g, key)) = st.sky_want.take() else { return };
        let Some(size) = st.sky_image.as_ref().and_then(|h| images.get(h)).map(|i| i.texture_descriptor.size.width) else { return };
        let len = (size * size * 6 * 8) as usize;
        let mut buf = st.spare.take().filter(|b| b.len() == len).unwrap_or_else(|| vec![0; len]);
        st.sky_built_at = now;
        let task = bevy::tasks::AsyncComputeTaskPool::get().spawn(async move {
            fill_sky_data(&mut buf, size, &g);
            buf
        });
        st.sky_job = Some(SkyJob { task, key });
    }
}

fn load_cubemap(world: &mut World, k: &SkyLook) -> (Handle<Image>, Option<Handle<Image>>, Option<Handle<Image>>) {
    let cached = world.resource::<LookState>().cubemap.clone();
    if let Some((path, c, d, s)) = cached
        && path == k.cubemap
    {
        return (c, d, s);
    }
    let Some(server) = world.get_resource::<AssetServer>().cloned() else { return (Handle::default(), None, None) };
    let load = |p: &Cow<'static, str>| -> Option<Handle<Image>> { (!p.is_empty()).then(|| server.load(AssetPath::from(p.to_string()))) };
    let c = load(&k.cubemap).unwrap_or_default();
    let (d, s) = (load(&k.diffuse_map), load(&k.specular_map));
    world.resource_mut::<LookState>().cubemap = Some((k.cubemap.to_string(), c.clone(), d.clone(), s.clone()));
    (c, d, s)
}

fn apply_fog_volume(world: &mut World, look: &Look, tier: &Tier) {
    let v = &look.volumetric;
    let want = v.enabled && tier.volumetric_fog;
    let mut q = world.query_filtered::<Entity, With<LookFogVolume>>();
    let existing = q.iter(world).next();
    match (want, existing) {
        (false, Some(e)) => {
            world.despawn(e);
        }
        (false, None) => {}
        (true, _) => {
            let vol = FogVolume {
                fog_color: v.color.color(),
                density_factor: v.density,
                absorption: v.absorption,
                scattering: v.scattering,
                scattering_asymmetry: v.asymmetry.clamp(-0.99, 0.99),
                light_tint: Color::WHITE,
                light_intensity: v.light_intensity,
                ..default()
            };
            let e = existing.unwrap_or_else(|| world.spawn((Name::new("LookFogVolume"), LookFogVolume)).id());
            let mut em = world.entity_mut(e);
            let keep = em.get::<Transform>().map(|t| t.translation).unwrap_or(Vec3::from(v.center));
            let center = if v.follow_camera { Vec3::new(keep.x, v.center[1], keep.z) } else { Vec3::from(v.center) };
            put(&mut em, Some(Transform::from_translation(center).with_scale(Vec3::from(v.size).max(Vec3::splat(0.1)))));
            put(&mut em, Some(vol));
        }
    }
}

/// Keeps a `follow_camera` fog volume centred on the main camera (x/z).
pub fn follow_fog_volume(
    look: Res<Look>,
    cam: Query<&GlobalTransform, With<MainCamera>>,
    mut vol: Query<&mut Transform, (With<LookFogVolume>, Without<MainCamera>)>,
) {
    if !look.volumetric.follow_camera {
        return;
    }
    let (Some(cam), Ok(mut tf)) = (cam.iter().next(), vol.single_mut()) else { return };
    let p = cam.translation();
    if (tf.translation.x - p.x).abs() > 0.5 || (tf.translation.z - p.z).abs() > 0.5 {
        tf.translation.x = p.x;
        tf.translation.z = p.z;
    }
}

fn exposure_curve(world: &mut World, look: &Look) -> Option<Handle<AutoExposureCompensationCurve>> {
    let c = look.exposure.compensation;
    if c == 0.0 || !world.contains_resource::<Assets<AutoExposureCompensationCurve>>() {
        return None;
    }
    let bits = (c * 100.0).round() as i32 as u32;
    if let Some((b, h)) = &world.resource::<LookState>().curve
        && *b == bits
    {
        return Some(h.clone());
    }
    let (lo, hi) = (look.exposure.auto_min.min(-16.0), look.exposure.auto_max.max(16.0));
    let curve = AutoExposureCompensationCurve::from_curve(LinearSpline::new([Vec2::new(lo, c), Vec2::new(hi, c)])).ok()?;
    let h = world.resource_mut::<Assets<AutoExposureCompensationCurve>>().add(curve);
    world.resource_mut::<LookState>().curve = Some((bits, h.clone()));
    Some(h)
}

pub(crate) fn tonemapping(t: ToneMap) -> Tonemapping {
    match t {
        ToneMap::None => Tonemapping::None,
        ToneMap::Reinhard => Tonemapping::Reinhard,
        ToneMap::ReinhardLuminance => Tonemapping::ReinhardLuminance,
        ToneMap::AcesFitted => Tonemapping::AcesFitted,
        ToneMap::Agx => Tonemapping::AgX,
        ToneMap::SomewhatBoringDisplayTransform => Tonemapping::SomewhatBoringDisplayTransform,
        ToneMap::TonyMcMapface => Tonemapping::TonyMcMapface,
        ToneMap::BlenderFilmic => Tonemapping::BlenderFilmic,
        ToneMap::KhronosPbrNeutral => Tonemapping::KhronosPbrNeutral,
    }
}

fn section(s: &GradeSection) -> ColorGradingSection {
    ColorGradingSection { saturation: s.saturation, contrast: s.contrast, gamma: s.gamma, gain: s.gain, lift: s.lift }
}

pub(crate) fn color_grading(g: &GradingLook) -> ColorGrading {
    ColorGrading {
        global: ColorGradingGlobal {
            exposure: g.exposure,
            temperature: g.temperature,
            tint: g.tint,
            hue: g.hue,
            post_saturation: g.post_saturation,
            ..default()
        },
        shadows: section(&g.shadows),
        midtones: section(&g.midtones),
        highlights: section(&g.highlights),
    }
}

pub(crate) fn distance_fog(f: &FogLook) -> Option<DistanceFog> {
    let falloff = match f.mode {
        FogMode::Off => return None,
        FogMode::Linear => FogFalloff::Linear { start: f.start, end: f.end.max(f.start + 0.01) },
        FogMode::Exponential => FogFalloff::from_visibility(f.visibility.max(0.1)),
        FogMode::ExponentialSquared => FogFalloff::from_visibility_squared(f.visibility.max(0.1)),
        FogMode::Atmospheric => FogFalloff::from_visibility_colors(f.visibility.max(0.1), f.extinction.color(), f.color.color()),
    };
    let sc = f.sun_color.0;
    Some(DistanceFog {
        color: f.color.color(),
        directional_light_color: Color::srgba(sc[0], sc[1], sc[2], f.sun_amount.clamp(0.0, 1.0)),
        directional_light_exponent: f.sun_exponent.max(1.0),
        falloff,
    })
}

fn apply_camera(world: &mut World, e: Entity, main: bool, look: &Look, tier: &Tier, sky_out: &SkyOut, curve: Option<&Handle<AutoExposureCompensationCurve>>) {
    let capture_view;
    let sky = if main {
        sky_out
    } else {
        capture_view = SkyOut { atmosphere: false, skybox: sky_out.capture_skybox.clone(), env: sky_out.capture_env.clone(), ..default() };
        &capture_view
    };
    let mut em = world.entity_mut(e);
    if !em.contains::<Hdr>() {
        em.insert(Hdr);
    }
    // Capture cameras store linear, pre-exposed radiance: no tonemapping or grading.
    put(&mut em, Some(if main { tonemapping(look.tonemapping) } else { Tonemapping::None }));
    put(&mut em, Some(Exposure { ev100: look.exposure.ev100 }));
    put(&mut em, Some(if main { color_grading(&look.grading) } else { ColorGrading::default() }));
    put(&mut em, distance_fog(&look.fog));

    // Sky.
    let s = tier.sky_samples.max(4);
    let scale = (s as f32 / 16.0).clamp(0.5, 1.5);
    // (`fixes.rs` clears what Bevy leaves behind in the render world when this goes.)
    put(
        &mut em,
        sky.atmosphere.then(|| AtmosphereSettings {
            sky_view_lut_samples: s,
            aerial_view_lut_samples: (s * 10 / 16).max(4),
            sky_max_samples: s,
            sky_view_lut_size: UVec2::new((400.0 * scale) as u32, (200.0 * scale) as u32),
            aerial_view_lut_size: if scale < 0.75 { UVec3::splat(16) } else { UVec3::splat(32) },
            ..default()
        }),
    );
    put(&mut em, sky.skybox.as_ref().map(|(image, brightness)| Skybox { image: Some(image.clone()), brightness: *brightness, rotation: Quat::IDENTITY }));

    // Environment light. Bevy turns `AtmosphereEnvironmentMapLight` into a private marker plus
    // a `GeneratedEnvironmentMapLight` once and never again, so it stays on the camera for good;
    // other skies swap the generated light's source (the atmosphere's cubemap is remembered in
    // `LookAtmosphereEnv`) and `EnvironmentMapLight` is dropped whenever the source changes so
    // Bevy rebuilds the filtered maps at the new size.
    let gen_map = em.get::<GeneratedEnvironmentMapLight>().map(|g| g.environment_map.id());
    let _ = gen_map;
    // (Re)starts GPU filtering of `image`; the filtered maps are kept (and refiltered in
    // place) while the source stays the same, see `freeze_env`.
    let set_generated = |em: &mut EntityWorldMut, image: &Handle<Image>, intensity: f32| {
        if em.get::<LookEnvSource>().map(|s| s.0) != Some(image.id()) {
            em.remove::<EnvironmentMapLight>();
            em.insert(LookEnvSource(image.id()));
        }
        put(em, Some(GeneratedEnvironmentMapLight { environment_map: image.clone(), intensity, ..default() }));
    };
    match &sky.env {
        Env::None => {
            em.remove::<(GeneratedEnvironmentMapLight, EnvironmentMapLight, LookEnvSource)>();
        }
        Env::Atmosphere { size, intensity } => {
            let remembered = em.get::<LookAtmosphereEnv>().map(|a| a.0.clone());
            match em.get_mut::<AtmosphereEnvironmentMapLight>() {
                Some(mut a) => {
                    if a.intensity != *intensity {
                        a.intensity = *intensity;
                    }
                }
                // The size is fixed from here on (see above).
                None => {
                    em.remove::<(GeneratedEnvironmentMapLight, EnvironmentMapLight, LookEnvSource)>();
                    em.insert(AtmosphereEnvironmentMapLight { intensity: *intensity, size: UVec2::splat(*size), ..default() });
                }
            }
            match (gen_map, remembered) {
                (_, Some(atmo)) => set_generated(&mut em, &atmo, *intensity),
                // Bevy's own generated light (not yet remembered): keep, sync intensity.
                (Some(_), None) => {
                    if let Some(mut g) = em.get_mut::<GeneratedEnvironmentMapLight>()
                        && g.intensity != *intensity
                    {
                        g.intensity = *intensity;
                    }
                }
                (None, None) => {}
            }
        }
        Env::Generated { image, intensity } => set_generated(&mut em, image, *intensity),
        Env::Prefiltered { diffuse, specular, intensity } => {
            em.remove::<(GeneratedEnvironmentMapLight, LookEnvSource)>();
            put(&mut em, Some(EnvironmentMapLight { diffuse_map: diffuse.clone(), specular_map: specular.clone(), intensity: *intensity, ..default() }));
        }
    }

    let v = &look.volumetric;
    put(
        &mut em,
        (v.enabled && tier.volumetric_fog).then(|| VolumetricFog {
            ambient_color: look.ambient.color.color(),
            ambient_intensity: v.ambient_intensity,
            jitter: if tier.taa { 1.0 } else { 0.0 },
            step_count: tier.volumetric_steps.max(4),
        }),
    );

    // Bloom: presence is the tier's (gfx), tuning is the look's.
    if let Some(mut b) = em.get_mut::<Bloom>() {
        let l = &look.bloom;
        *b = Bloom {
            intensity: l.intensity,
            low_frequency_boost: l.low_frequency_boost,
            low_frequency_boost_curvature: l.low_frequency_boost_curvature,
            high_pass_frequency: l.high_pass_frequency,
            prefilter: BloomPrefilter { threshold: l.threshold, threshold_softness: l.threshold_softness },
            composite_mode: if l.additive { BloomCompositeMode::Additive } else { BloomCompositeMode::EnergyConserving },
            ..Bloom::NATURAL
        };
    }

    let x = &look.exposure;
    put(
        &mut em,
        (main && x.auto && tier.auto_exposure).then(|| AutoExposure {
            range: x.auto_min.min(x.auto_max - 0.1)..=x.auto_max,
            speed_brighten: x.speed_brighten.max(0.01),
            speed_darken: x.speed_darken.max(0.01),
            compensation_curve: curve.cloned().unwrap_or_default(),
            ..default()
        }),
    );

    // Lens effects: main camera only.
    let lens = &look.lens;
    let fx = main && tier.camera_fx;
    put(
        &mut em,
        (fx && lens.dof.enabled).then(|| DepthOfField {
            mode: if tier.bokeh { DepthOfFieldMode::Bokeh } else { DepthOfFieldMode::Gaussian },
            focal_distance: lens.dof.focal_distance.max(0.01),
            aperture_f_stops: lens.dof.aperture_f_stops.max(0.1),
            max_circle_of_confusion_diameter: lens.dof.max_blur_px.max(1.0),
            ..default()
        }),
    );
    put(
        &mut em,
        (fx && lens.motion_blur.enabled).then(|| MotionBlur { shutter_angle: lens.motion_blur.shutter_angle.max(0.0), samples: lens.motion_blur.samples.max(1) }),
    );
    let post = main && tier.post_fx;
    put(&mut em, (post && lens.chromatic_aberration > 0.0).then(|| ChromaticAberration { intensity: lens.chromatic_aberration, ..default() }));
    put(
        &mut em,
        (post && lens.vignette.intensity > 0.0).then(|| Vignette {
            intensity: lens.vignette.intensity,
            radius: lens.vignette.radius,
            smoothness: lens.vignette.smoothness,
            color: lens.vignette.color.color(),
            ..default()
        }),
    );
    put(&mut em, (post && lens.distortion != 0.0).then(|| LensDistortion { intensity: lens.distortion, ..default() }));
    let grain_time = em.get::<FilmGrain>().map(|g| g.time).unwrap_or(0.0);
    put(&mut em, (post && lens.film_grain > 0.0).then(|| FilmGrain { intensity: lens.film_grain, time: grain_time, ..default() }));
}

/// Which source cubemap a camera's current `EnvironmentMapLight` maps were filtered from.
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub struct LookEnvSource(pub AssetId<Image>);

/// Frames in which Bevy's env-map filter ran for a main camera (counted in the render world).
#[derive(Resource, Clone, Default)]
pub struct EnvFilterCounter(pub std::sync::Arc<std::sync::atomic::AtomicU32>);

/// Stops refiltering a main camera's sky env light once the GPU has filtered the current sky
/// `LookConfig::freeze_env_after` times (the filtered maps stay on the GPU). Bevy refilters a
/// `GeneratedEnvironmentMapLight` every frame (≈ 1 ms at 256² on an M5 Pro) although a sky only
/// changes with the look; the next apply re-inserts it.
pub fn freeze_env(
    mut commands: Commands,
    config: Res<LookConfig>,
    counter: Res<EnvFilterCounter>,
    mut st: ResMut<LookState>,
    cams: Query<Entity, (With<MainCamera>, With<GeneratedEnvironmentMapLight>, With<EnvironmentMapLight>, With<LookEnvSource>)>,
) {
    let now = counter.0.load(std::sync::atomic::Ordering::Relaxed);
    if st.env_dirty {
        st.env_dirty = false;
        st.env_filtered_at = now;
        return;
    }
    // Animated skies (blends, timelines, a rebuilding gradient) keep filtering.
    if config.freeze_env_after == 0 || st.sky_job.is_some() || st.sky_want.is_some() || now < st.env_filtered_at + config.freeze_env_after {
        return;
    }
    for e in &cams {
        commands.entity(e).remove::<GeneratedEnvironmentMapLight>();
    }
}

/// The cubemap Bevy renders the atmosphere into for a camera's env light (remembered so the
/// look can switch back to it after a gradient / cubemap sky).
#[derive(Component, Clone, Debug)]
pub struct LookAtmosphereEnv(pub Handle<Image>);

/// Remembers the atmosphere env cubemap as soon as Bevy creates it.
pub fn remember_atmosphere_env(
    mut commands: Commands,
    st: Res<LookState>,
    cams: Query<(Entity, &GeneratedEnvironmentMapLight), (With<AtmosphereEnvironmentMapLight>, Without<LookAtmosphereEnv>, Changed<GeneratedEnvironmentMapLight>)>,
) {
    for (e, g) in &cams {
        let ours = st.sky_image.as_ref().is_some_and(|h| h.id() == g.environment_map.id())
            || st.cubemap.as_ref().is_some_and(|c| c.1.id() == g.environment_map.id());
        if !ours {
            commands.entity(e).insert(LookAtmosphereEnv(g.environment_map.clone()));
        }
    }
}
