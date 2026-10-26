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
    /// Frames the GPU filters a freshly created sky env light before it is frozen (later
    /// refreshes take 2–3 frames). 0 = never freeze: refilter every frame, Bevy's behaviour.
    pub freeze_env_after: u32,
    /// While the sky changes (day cycle, blends, sun moves), refilter its env light at most
    /// this often (Hz). Each refresh costs one filter pass over 2–3 frames.
    pub env_refresh_hz: f32,
}

impl Default for LookConfig {
    fn default() -> Self {
        LookConfig { sky_cubemap_size: 256, sky_rebuild_hz: 10.0, freeze_env_after: 4, env_refresh_hz: 10.0 }
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
    /// What the sky env worker filters, and the worker ([`SkyEnvWorker`]).
    env_key: Option<EnvKey>,
    env_worker: Option<Entity>,
    /// The filtered sky env maps every look camera uses: (diffuse, specular).
    env_maps: Option<(Handle<Image>, Handle<Image>)>,
    /// The sky changed since its env light was last filtered.
    env_dirty: bool,
    /// `EnvFilterCounter` when the current filtering started (None = frozen / idle).
    env_filter_from: Option<u32>,
    /// Filtered frames the current filtering needs.
    env_frames: u32,
    env_started_at: f64,
    /// Finished sky env filterings (first fill + refreshes).
    pub env_refilters: u64,
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
    sync_env_worker(world, &sky.env);
    apply_fog_volume(world, &look, &tier);
    let curve = exposure_curve(world, &look);

    for &(e, main) in cams.iter() {
        apply_camera(world, e, main, &look, &tier, &sky, curve.as_ref());
    }

    let mut st = world.resource_mut::<LookState>();
    st.applies += 1;
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
        // bind groups. Their env light is the main camera's (filtered once, shared).
        out.capture_env = out.env.clone();
        if captures && has_images {
            let h = gradient_cubemap(world, look, now);
            out.capture_skybox = Some((h.clone(), k.brightness));
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
            // The env light filtered from this cubemap is now stale.
            if st.env_key.is_some() && st.env_key == st.sky_image.as_ref().map(|h| EnvKey::Source(h.id())) {
                st.env_dirty = true;
            }
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
    let maps = world.resource::<LookState>().env_maps.clone();
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

    // Environment light: sky sources are filtered once by the shared `SkyEnvWorker`; cameras
    // only get its filtered maps (no per-camera GPU filtering).
    match &sky.env {
        Env::None => {
            em.remove::<(GeneratedEnvironmentMapLight, EnvironmentMapLight, LookSkyEnv)>();
        }
        Env::Atmosphere { intensity, .. } | Env::Generated { intensity, .. } => {
            em.remove::<GeneratedEnvironmentMapLight>();
            put(&mut em, Some(LookSkyEnv(*intensity)));
            // Until the worker has filtered the new sky the previous maps stay.
            if let Some((diffuse, specular)) = &maps {
                set_env_maps(&mut em, diffuse, specular, *intensity);
            }
        }
        Env::Prefiltered { diffuse, specular, intensity } => {
            em.remove::<(GeneratedEnvironmentMapLight, LookSkyEnv)>();
            set_env_maps(&mut em, diffuse, specular, *intensity);
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

/// Sets a camera's `EnvironmentMapLight` (only when it differs, so change detection stays quiet).
fn set_env_maps(em: &mut EntityWorldMut, diffuse: &Handle<Image>, specular: &Handle<Image>, intensity: f32) {
    if let Some(cur) = em.get::<EnvironmentMapLight>()
        && cur.diffuse_map == *diffuse
        && cur.specular_map == *specular
        && cur.intensity == intensity
    {
        return;
    }
    em.insert(EnvironmentMapLight { diffuse_map: diffuse.clone(), specular_map: specular.clone(), intensity, ..default() });
}

/// On look cameras whose env light is the shared, filtered sky: that light's intensity.
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub struct LookSkyEnv(pub f32);

/// What the sky env worker filters.
#[derive(Clone, Copy, Debug, PartialEq)]
enum EnvKey {
    /// Bevy's atmosphere env cubemap at this face size.
    Atmosphere(u32),
    /// A cubemap image (gradient sky, KTX2 sky).
    Source(AssetId<Image>),
}

/// Hidden entity that filters the sky's env light once for every look camera (main and probe
/// captures). Bevy's `GeneratedEnvironmentMapLight` refilters every frame (on a camera, once per
/// camera); the worker only carries it while the sky changed and drops it again (frozen) once the
/// GPU filtered the new sky, so a static sky costs nothing per frame. Atmosphere skies put
/// `AtmosphereEnvironmentMapLight` on the worker: Bevy renders the sky into its cubemap (a cheap
/// pass) and the worker filters that.
#[derive(Component, Clone, Debug, Default)]
pub struct SkyEnvWorker {
    /// The cubemap being filtered (Bevy's atmosphere cubemap once Bevy made it).
    source: Option<Handle<Image>>,
    /// Filters Bevy's atmosphere env cubemap.
    pub atmosphere: bool,
}

/// Frames in which Bevy's env-map filter ran for the [`SkyEnvWorker`] (counted in the render
/// world, only once every pipeline it needs is ready).
#[derive(Resource, Clone, Default)]
pub struct EnvFilterCounter(pub std::sync::Arc<std::sync::atomic::AtomicU32>);

/// (Re)creates the sky env worker when the env source changes and marks the sky dirty.
fn sync_env_worker(world: &mut World, env: &Env) {
    let key = match env {
        Env::Atmosphere { size, .. } => Some(EnvKey::Atmosphere(*size)),
        Env::Generated { image, .. } => Some(EnvKey::Source(image.id())),
        Env::None | Env::Prefiltered { .. } => None,
    };
    let first = world.resource::<LookConfig>().freeze_env_after.max(2);
    let (old_key, old_worker) = {
        let st = world.resource::<LookState>();
        (st.env_key, st.env_worker)
    };
    if key == old_key {
        // The atmosphere follows the sun and the look; a cubemap source is marked dirty when its
        // pixels change (`pump_sky`).
        if matches!(key, Some(EnvKey::Atmosphere(_))) {
            world.resource_mut::<LookState>().env_dirty = true;
        }
        return;
    }
    if let Some(w) = old_worker
        && let Ok(e) = world.get_entity_mut(w)
    {
        e.despawn();
    }
    // Same-size sources filter into the maps the cameras already use (no flash, no realloc).
    let size = match env {
        Env::Atmosphere { size, .. } => Some(*size),
        Env::Generated { image, .. } => world.get_resource::<Assets<Image>>().and_then(|i| i.get(image)).map(|i| i.texture_descriptor.size.width),
        _ => None,
    };
    let mut st = world.resource_mut::<LookState>();
    st.env_key = key;
    st.env_worker = None;
    st.env_filter_from = None;
    let Some(key) = key else {
        st.env_maps = None;
        st.env_dirty = false;
        return;
    };
    let maps = st.env_maps.clone();
    let reuse = maps.filter(|(_, spec)| {
        let w = world.get_resource::<Assets<Image>>().and_then(|i| i.get(spec)).map(|i| i.texture_descriptor.size.width);
        w.is_some() && w == size
    });
    let mut w = match (key, env) {
        (EnvKey::Atmosphere(size), _) => world.spawn((
            Name::new("SkyEnvFilter"),
            SkyEnvWorker { source: None, atmosphere: true },
            AtmosphereEnvironmentMapLight { intensity: 1.0, size: UVec2::splat(size), ..default() },
        )),
        (_, Env::Generated { image, .. }) => world.spawn((
            Name::new("SkyEnvFilter"),
            SkyEnvWorker { source: Some(image.clone()), atmosphere: false },
            GeneratedEnvironmentMapLight { environment_map: image.clone(), intensity: 1.0, ..default() },
        )),
        _ => unreachable!(),
    };
    if let Some((diffuse, specular)) = reuse {
        w.insert(EnvironmentMapLight { diffuse_map: diffuse, specular_map: specular, intensity: 1.0, ..default() });
    }
    let id = w.id();
    let mut st = world.resource_mut::<LookState>();
    st.env_worker = Some(id);
    st.env_dirty = true;
    // The atmosphere cubemap needs its own pipeline and the view's LUTs first.
    st.env_frames = if matches!(key, EnvKey::Atmosphere(_)) { first + 4 } else { first };
    st.env_started_at = f64::NEG_INFINITY;
}

/// Run condition for [`drive_sky_env`].
pub fn sky_env_busy(st: Res<LookState>) -> bool {
    st.env_worker.is_some() && (st.env_dirty || st.env_filter_from.is_some())
}

/// Filters the sky env light when the sky changed (at most `LookConfig::env_refresh_hz` times a
/// second), hands the filtered maps to the look cameras, then freezes the worker. Runs only
/// while there is something to filter.
pub fn drive_sky_env(
    mut commands: Commands,
    config: Res<LookConfig>,
    counter: Res<EnvFilterCounter>,
    time: Res<Time<Real>>,
    mut st: ResMut<LookState>,
    mut workers: Query<(&mut SkyEnvWorker, Option<&GeneratedEnvironmentMapLight>, Option<&EnvironmentMapLight>)>,
    mut cams: Query<(Entity, &LookSkyEnv, Option<&EnvironmentMapLight>), Without<SkyEnvWorker>>,
) {
    let Some(we) = st.env_worker else { return };
    let Ok((mut worker, generated, filtered)) = workers.get_mut(we) else { return };
    if let Some(g) = generated
        && worker.source.as_ref().map(|h| h.id()) != Some(g.environment_map.id())
    {
        worker.source = Some(g.environment_map.clone());
    }
    let now = counter.0.load(std::sync::atomic::Ordering::Relaxed);
    let t = time.elapsed_secs_f64();
    let Some(from) = st.env_filter_from else {
        if !st.env_dirty || t - st.env_started_at < 1.0 / config.env_refresh_hz.max(0.1) as f64 {
            return;
        }
        if generated.is_none() {
            // An atmosphere worker gets its generated light from Bevy the first time.
            let Some(source) = worker.source.clone() else { return };
            commands.entity(we).insert(GeneratedEnvironmentMapLight { environment_map: source, intensity: 1.0, ..default() });
        }
        st.env_dirty = false;
        st.env_filter_from = Some(now);
        st.env_started_at = t;
        return;
    };
    if now < from + st.env_frames {
        return;
    }
    let Some(filtered) = filtered else { return };
    st.env_filter_from = None;
    st.env_refilters += 1;
    // A refresh: Bevy's atmosphere cubemap is rendered after the filter in a frame, so the
    // atmosphere needs one frame more.
    st.env_frames = if worker.atmosphere { 3 } else { 2 };
    if config.freeze_env_after > 0 {
        commands.entity(we).remove::<GeneratedEnvironmentMapLight>();
    }
    let (diffuse, specular) = (filtered.diffuse_map.clone(), filtered.specular_map.clone());
    for (e, env, cur) in &mut cams {
        if cur.is_none_or(|c| c.diffuse_map != diffuse || c.specular_map != specular || c.intensity != env.0) {
            commands.entity(e).insert(EnvironmentMapLight { diffuse_map: diffuse.clone(), specular_map: specular.clone(), intensity: env.0, ..default() });
        }
    }
    st.env_maps = Some((diffuse, specular));
}

/// `look.get` summary of the sky env light.
pub fn env_state_json(st: &LookState) -> serde_json::Value {
    serde_json::json!({
        "source": match st.env_key {
            Some(EnvKey::Atmosphere(size)) => format!("atmosphere {size}"),
            Some(EnvKey::Source(_)) => "cubemap".to_string(),
            None => "none".to_string(),
        },
        "filtering": st.env_filter_from.is_some(),
        "dirty": st.env_dirty,
        "ready": st.env_maps.is_some(),
        "refilters": st.env_refilters,
    })
}
