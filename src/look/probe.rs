//! Reflection probes captured at runtime (no baking tool, no asset files) and irradiance
//! volumes built from code.
//!
//! [`ReflectionProbe`]: spawn it with a `Transform` whose scale is the probe's box (a room). It
//! renders the scene into a cubemap from its centre with six 90° cameras and lights everything
//! inside the box: parallax-corrected reflections and indoor ambient instead of the sky's.
//!
//! - **Specular**: Bevy filters the cubemap on the GPU (`GeneratedEnvironmentMapLight` on a
//!   hidden worker entity); the probe samples the worker's filtered specular map.
//! - **Diffuse**: Bevy's realtime irradiance filter point-samples the cubemap, which is blotchy
//!   for interiors (small bright windows / lamps). Instead the cubemap is read back (async) and
//!   projected onto 9 spherical harmonics on the CPU (≈ 0.3 ms per update), giving a smooth
//!   irradiance map.
//! - **Bake** (refresh 0; Low / Medium): captures all six faces a few times while shaders
//!   warm up, then *freezes*: the worker stops filtering and the probe costs nothing per frame.
//!   It re-bakes when the [`Look`] changes (throttled) or on `look.probe {bake: true}`.
//! - **Realtime** (refresh n > 0; High 4, Ultra 1): one face every n frames, round robin; the
//!   worker filters every frame and diffuse is refreshed after every full turn.
//!
//! The copy from the six face targets into the cubemap runs in the render world right after
//! the frame's command buffers are submitted.
//!
//! [`irradiance_volume_image`] builds Bevy's ambient-cube voxel texture from a closure, e.g.
//! [`sky_ambient_cube`] for sky light with per-voxel occlusion you compute yourself.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use bevy::asset::RenderAssetUsages;
use bevy::camera::{Exposure, RenderTarget};
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::light::{EnvironmentMapLight, GeneratedEnvironmentMapLight, LightProbe};
use bevy::prelude::*;
use bevy::render::gpu_readback::{Readback, ReadbackComplete};
use bevy::render::render_asset::RenderAssets;
use bevy::render::render_resource::{
    CommandEncoderDescriptor, Extent3d, Origin3d, TexelCopyTextureInfo, TextureAspect, TextureDimension, TextureFormat, TextureUsages,
};
use bevy::render::renderer::{RenderDevice, RenderGraph, RenderGraphSystems, RenderQueue};
use bevy::render::sync_world::RenderEntity;
use bevy::render::texture::GpuImage;
use bevy::render::{Extract, ExtractSchedule, Render, RenderApp, RenderSystems};

use super::apply::{LookCapture, Tier};
use super::desc::Look;
use super::sky::{SkyGradient, cube_texel_dir, f16_bits, f16_to_f32, new_cubemap, sky_radiance};
use crate::gfx::QualityPreset;
use crate::settings::CoreSettings;

/// Face size of the SH diffuse cubemap (irradiance is smooth; 16 px is plenty).
const DIFFUSE_SIZE: u32 = 16;

/// A runtime-captured reflection probe (see the module docs). Its `Transform` scale is the box
/// it affects (Bevy light probes are unit cubes).
#[derive(Component, Clone, Debug)]
#[require(Transform, Visibility)]
pub struct ReflectionProbe {
    /// Cube face size in px (power of two; 64–256 is plenty for rough indoor reflections).
    pub resolution: u32,
    /// Brightness multiplier on what the probe captured.
    pub intensity: f32,
    /// Frames between face updates; `None` = the tier's `probe_refresh`, `Some(0)` = bake only.
    pub refresh: Option<u32>,
    pub near: f32,
    pub far: f32,
    /// Re-bake (static probes) when the `Look` changes, at most every this many seconds.
    pub rebake_on_look_change: Option<f32>,
    state: ProbeRun,
}

impl Default for ReflectionProbe {
    fn default() -> Self {
        ReflectionProbe { resolution: 128, intensity: 1.0, refresh: None, near: 0.05, far: 500.0, rebake_on_look_change: Some(0.5), state: ProbeRun::default() }
    }
}

#[derive(Clone, Debug, Default)]
struct ProbeRun {
    /// Remaining full-capture frames of the current bake.
    bake_frames: u32,
    /// Frames until the next warm-up re-capture (shaders compile asynchronously).
    warmup: u32,
    warmups_left: u32,
    face: usize,
    frame: u32,
    frozen: bool,
    captures: u32,
    filtered_at_copy: u32,
    copies_seen: u32,
    look_dirty_at: Option<f64>,
    /// Faces captured since the last diffuse readback.
    fresh_faces: u8,
    readback_in_flight: bool,
    diffuse_updates: u32,
    /// Faces captured since the specular map was last filtered (realtime probes).
    spec_faces: u8,
}

impl ReflectionProbe {
    /// Capture all faces again (also un-freezes a baked probe until it is filtered).
    pub fn rebake(&mut self) {
        self.state.bake_frames = 2;
    }

    /// Faces captured so far (counts each face of a full capture).
    pub fn captures(&self) -> u32 {
        self.state.captures
    }

    /// Times the SH diffuse map was rebuilt from a readback.
    pub fn diffuse_updates(&self) -> u32 {
        self.state.diffuse_updates
    }

    /// (cubemap copies done on the GPU, frames the env-map filter ran) — for diagnostics.
    pub fn gpu_counters(targets: &ProbeTargets) -> (u32, u32) {
        (targets.shared.copies.load(Ordering::Relaxed), targets.shared.filtered.load(Ordering::Relaxed))
    }

    /// True once a baked probe stopped refreshing / filtering.
    pub fn is_frozen(&self) -> bool {
        self.state.frozen
    }
}

/// Render resources of a probe (added by the probe systems).
#[derive(Component, Clone, Debug)]
pub struct ProbeTargets {
    pub cube: Handle<Image>,
    pub faces: [Handle<Image>; 6],
    pub cameras: [Entity; 6],
    /// SH irradiance cubemap (the probe's diffuse map).
    pub diffuse: Handle<Image>,
    /// Hidden entity whose `GeneratedEnvironmentMapLight` filters `cube` into the specular map.
    pub worker: Entity,
    shared: Arc<ProbeShared>,
}

/// Set on probe cameras for the frame they capture; read by the render-world copy.
#[derive(Component, Clone, Copy, Debug)]
pub struct ProbeCamera {
    pub probe: Entity,
    pub face: usize,
}

/// The filter worker of a probe.
#[derive(Component, Clone, Copy, Debug)]
pub struct ProbeWorker {
    pub probe: Entity,
}

#[derive(Debug, Default)]
struct ProbeShared {
    copies: AtomicU32,
    filtered: AtomicU32,
    readback: Mutex<Option<Vec<u8>>>,
}

/// Faces to copy this frame, per probe (main → render world).
#[derive(Component, Clone, Copy, Debug, Default)]
struct ProbeCopyMask(u8);

/// Camera orientation per cube face: (forward, up), matching Bevy's cube layout.
const FACES: [(Vec3, Vec3); 6] = [
    (Vec3::X, Vec3::Y),
    (Vec3::NEG_X, Vec3::Y),
    (Vec3::Y, Vec3::Z),
    (Vec3::NEG_Y, Vec3::NEG_Z),
    (Vec3::NEG_Z, Vec3::Y),
    (Vec3::Z, Vec3::Y),
];

pub(super) fn plugin(app: &mut App) {
    app.add_systems(Update, (setup_probes, drive_probes).chain().in_set(crate::gfx::QualitySet::Look).run_if(any_with_component::<ReflectionProbe>));
    let Some(render_app) = app.get_sub_app_mut(RenderApp) else { return };
    render_app
        .init_resource::<ExtractedProbes>()
        .init_resource::<ExtractedSkyEnv>()
        .add_systems(ExtractSchedule, (extract_probes, extract_sky_env))
        .add_systems(Render, count_filtered.after(RenderSystems::PrepareBindGroups).before(RenderSystems::Render))
        .add_systems(RenderGraph, copy_probe_faces.after(RenderGraphSystems::Submit).before(RenderGraphSystems::Finish));
}

fn setup_probes(
    mut commands: Commands,
    mut images: Option<ResMut<Assets<Image>>>,
    look: Option<Res<Look>>,
    probes: Query<(Entity, &ReflectionProbe, &GlobalTransform), Without<ProbeTargets>>,
) {
    let Some(images) = images.as_mut() else { return };
    for (e, probe, gtf) in &probes {
        let n = probe.resolution.clamp(16, 2048).next_power_of_two();
        // Zero-filled (not uninitialised): it is filtered before the first capture lands.
        let mut cube = new_cubemap(n);
        cube.texture_descriptor.usage = TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST | TextureUsages::COPY_SRC;
        let cube = images.add(cube);
        let diffuse = images.add(new_cubemap(DIFFUSE_SIZE));
        let faces: [Handle<Image>; 6] = std::array::from_fn(|_| {
            let mut img = Image::new_target_texture(n, n, TextureFormat::Rgba16Float, None);
            img.texture_descriptor.usage |= TextureUsages::COPY_SRC;
            images.add(img)
        });
        let pos = gtf.translation();
        let ev100 = look.as_ref().map(|l| l.exposure.ev100).unwrap_or(Exposure::EV100_BLENDER);
        let cameras: [Entity; 6] = std::array::from_fn(|i| {
            let (fwd, up) = FACES[i];
            commands
                .spawn((
                    Name::new(format!("ProbeCamera{i}")),
                    Camera3d::default(),
                    Camera { order: -100 - i as isize, is_active: false, ..default() },
                    RenderTarget::from(faces[i].clone()),
                    Projection::Perspective(PerspectiveProjection {
                        fov: std::f32::consts::FRAC_PI_2,
                        aspect_ratio: 1.0,
                        near: probe.near,
                        far: probe.far,
                        ..default()
                    }),
                    Tonemapping::None,
                    bevy::camera::Hdr,
                    // Forward decals need it in every view that draws them.
                    bevy::core_pipeline::prepass::DepthPrepass,
                    Msaa::Off,
                    Exposure { ev100 },
                    LookCapture,
                    ProbeCamera { probe: e, face: i },
                    Transform::from_translation(pos).looking_to(fwd, up),
                ))
                .id()
        });
        let worker = commands
            .spawn((Name::new("ProbeFilter"), ProbeWorker { probe: e }, GeneratedEnvironmentMapLight { environment_map: cube.clone(), intensity: 1.0, ..default() }))
            .id();
        let mut run = probe.clone();
        run.state = ProbeRun { bake_frames: 1, warmup: 10, warmups_left: 12, ..default() };
        commands.entity(e).insert((run, LightProbe::default(), ProbeTargets { cube, faces, cameras, diffuse, worker, shared: Arc::default() }, ProbeCopyMask(0)));
    }
}

/// Exposure → env intensity: captures are stored pre-exposed (`Tonemapping::None`).
fn pre_exposure_inverse(ev100: f32) -> f32 {
    1.2 * 2f32.powf(ev100)
}

fn drive_probes(
    mut commands: Commands,
    time: Res<Time<Real>>,
    preset: Res<QualityPreset>,
    settings: Res<CoreSettings>,
    look: Option<Res<Look>>,
    mut images: Option<ResMut<Assets<Image>>>,
    mut probes: Query<(Entity, &mut ReflectionProbe, &ProbeTargets, &mut ProbeCopyMask, &GlobalTransform, Option<&mut EnvironmentMapLight>), Without<ProbeWorker>>,
    workers: Query<(Has<GeneratedEnvironmentMapLight>, Option<&EnvironmentMapLight>), With<ProbeWorker>>,
    mut cams: Query<(&mut Camera, &mut Transform, &Exposure), With<ProbeCamera>>,
) {
    let tier = Tier::of(&preset, settings.quality);
    let now = time.elapsed_secs_f64();
    let look_changed = look.as_ref().is_some_and(|l| l.is_changed());
    for (e, mut probe, targets, mut mask, gtf, env) in &mut probes {
        let refresh = probe.refresh.unwrap_or(tier.probe_refresh);
        let throttle = probe.rebake_on_look_change;
        let p = &mut probe.state;
        let copies = targets.shared.copies.load(Ordering::Relaxed);
        let filtered = targets.shared.filtered.load(Ordering::Relaxed);
        if copies != p.copies_seen {
            p.copies_seen = copies;
            p.filtered_at_copy = filtered;
        }
        if look_changed
            && let Some(throttle) = throttle
            && p.look_dirty_at.is_none()
        {
            p.look_dirty_at = Some(now + throttle as f64);
        }
        if p.look_dirty_at.is_some_and(|t| now >= t) {
            p.look_dirty_at = None;
            p.bake_frames = p.bake_frames.max(1);
        }
        // Warm-up: shaders and pipelines compile over the first frames; re-capture a few times.
        if p.warmups_left > 0 {
            p.warmup = p.warmup.saturating_sub(1);
            if p.warmup == 0 {
                p.warmups_left -= 1;
                p.warmup = 10;
                p.bake_frames = p.bake_frames.max(1);
            }
        }
        let mut want = 0u8;
        if p.bake_frames > 0 {
            p.bake_frames -= 1;
            want = 0b11_1111;
        } else if refresh > 0 {
            p.frame += 1;
            if p.frame >= refresh {
                p.frame = 0;
                want = 1 << p.face;
                p.face = (p.face + 1) % 6;
            }
        }
        if want != 0 {
            p.captures += want.count_ones();
        }

        // Diffuse: read the cubemap back once every face is fresh; SH-project the result.
        if let Some(data) = targets.shared.readback.lock().ok().and_then(|mut r| r.take()) {
            p.readback_in_flight = false;
            if let Some(images) = images.as_mut() {
                let size = images.get(&targets.cube).map(|i| i.texture_descriptor.size.width).unwrap_or(0);
                let sh = sh9_from_cube_rgba16f(&data, size, 2);
                if let Some(mut img) = images.get_mut(&targets.diffuse) {
                    fill_irradiance_cubemap(&mut img, &sh);
                    p.diffuse_updates += 1;
                }
            }
        }
        // Faces copied this frame land in the cube after this frame's render; a readback
        // requested now is copied after that (same frame), so it sees them.
        p.fresh_faces |= want;
        if p.fresh_faces == 0b11_1111 && !p.readback_in_flight && p.warmups_left < 11 {
            p.fresh_faces = 0;
            p.readback_in_flight = true;
            let shared = targets.shared.clone();
            commands.spawn((Name::new("ProbeReadback"), Readback::texture(targets.cube.clone()))).observe(
                move |ev: On<ReadbackComplete>, mut commands: Commands| {
                    if let Ok(mut slot) = shared.readback.lock() {
                        *slot = Some(ev.event().data.clone());
                    }
                    commands.entity(ev.event().entity).try_despawn();
                },
            );
        }

        // Specular: the worker filters while captures land; a baked probe freezes after the GPU
        // filtered its latest capture twice. A realtime probe filters once per full cycle of
        // fresh faces instead of every frame: each filter re-creates Bevy's bind groups and
        // buffers, which cost ~3 GB of Metal driver memory and frame time at High.
        let latest_filtered = p.copies_seen > 0 && filtered >= p.filtered_at_copy + 2;
        let (working, worker_env) = workers.get(targets.worker).unwrap_or((false, None));
        let start = |commands: &mut Commands| {
            commands.entity(targets.worker).insert(GeneratedEnvironmentMapLight { environment_map: targets.cube.clone(), intensity: 1.0, ..default() });
        };
        if refresh == 0 {
            let settled = want == 0 && p.warmups_left == 0 && latest_filtered && !p.readback_in_flight;
            if settled && working {
                p.frozen = true;
                commands.entity(targets.worker).remove::<GeneratedEnvironmentMapLight>();
            } else if want != 0 && !working {
                p.frozen = false;
                start(&mut commands);
            }
        } else {
            p.frozen = false;
            p.spec_faces |= want;
            if p.spec_faces == 0b11_1111 {
                // A full set of fresh faces: (keep) filtering until it has seen the last copy.
                p.spec_faces = 0;
                if !working {
                    start(&mut commands);
                }
            } else if working && want == 0 && latest_filtered && p.warmups_left == 0 {
                commands.entity(targets.worker).remove::<GeneratedEnvironmentMapLight>();
            }
        }

        let ev = cams.get(targets.cameras[0]).map(|c| c.2.ev100).unwrap_or(Exposure::EV100_BLENDER);
        let intensity = probe.intensity * pre_exposure_inverse(ev);
        match (env, worker_env) {
            (Some(mut env), _) => {
                if env.intensity != intensity {
                    env.intensity = intensity;
                }
            }
            (None, Some(w)) => {
                commands.entity(e).insert(EnvironmentMapLight { diffuse_map: targets.diffuse.clone(), specular_map: w.specular_map.clone(), intensity, ..default() });
            }
            _ => {}
        }

        if mask.0 != want {
            mask.0 = want;
        }
        let pos = gtf.translation();
        for (i, cam) in targets.cameras.iter().enumerate() {
            if let Ok((mut c, mut tf, _)) = cams.get_mut(*cam) {
                let on = want & (1 << i) != 0;
                if c.is_active != on {
                    c.is_active = on;
                }
                if on && tf.translation != pos {
                    tf.translation = pos;
                }
            }
        }
    }
}

/// Solid angle of the cube texel at (`x`, `y`) of a `size` face.
fn texel_solid_angle(x: u32, y: u32, size: u32) -> f32 {
    let inv = 1.0 / size as f32;
    let (u0, v0) = (2.0 * x as f32 * inv - 1.0, 2.0 * y as f32 * inv - 1.0);
    let (u1, v1) = (u0 + 2.0 * inv, v0 + 2.0 * inv);
    let a = |u: f32, v: f32| (u * v).atan2((u * u + v * v + 1.0).sqrt());
    a(u0, v0) - a(u0, v1) - a(u1, v0) + a(u1, v1)
}

fn sh9_basis(d: Vec3) -> [f32; 9] {
    [
        0.282_095,
        0.488_603 * d.y,
        0.488_603 * d.z,
        0.488_603 * d.x,
        1.092_548 * d.x * d.y,
        1.092_548 * d.y * d.z,
        0.315_392 * (3.0 * d.z * d.z - 1.0),
        1.092_548 * d.x * d.z,
        0.546_274 * (d.x * d.x - d.y * d.y),
    ]
}

/// Radiance SH (order 2) of an `Rgba16Float` cube read back from the GPU (`data` holds the six
/// faces, rows padded to 256 bytes), sampling every `step`-th texel.
pub fn sh9_from_cube_rgba16f(data: &[u8], size: u32, step: u32) -> [Vec3; 9] {
    let mut sh = [Vec3::ZERO; 9];
    if size == 0 {
        return sh;
    }
    let row = (size as usize * 8).div_ceil(256) * 256;
    if data.len() < row * size as usize * 6 {
        return sh;
    }
    let step = step.max(1);
    for face in 0..6 {
        for y in (0..size).step_by(step as usize) {
            for x in (0..size).step_by(step as usize) {
                let i = face * row * size as usize + y as usize * row + x as usize * 8;
                let px = |k: usize| f16_to_f32(u16::from_le_bytes([data[i + k * 2], data[i + k * 2 + 1]]));
                let l = Vec3::new(px(0), px(1), px(2));
                if !l.is_finite() {
                    continue;
                }
                let d = cube_texel_dir(face, x, y, size);
                let w = texel_solid_angle(x, y, size) * (step * step) as f32;
                for (c, b) in sh.iter_mut().zip(sh9_basis(d)) {
                    *c += l * (b * w);
                }
            }
        }
    }
    sh
}

/// Cosine-weighted average radiance (Bevy's diffuse env-map units: irradiance / π) in
/// direction `n` from radiance SH.
pub fn sh9_irradiance(sh: &[Vec3; 9], n: Vec3) -> Vec3 {
    use std::f32::consts::PI;
    const A: [f32; 9] = [PI, 2.0 * PI / 3.0, 2.0 * PI / 3.0, 2.0 * PI / 3.0, PI / 4.0, PI / 4.0, PI / 4.0, PI / 4.0, PI / 4.0];
    let b = sh9_basis(n);
    let mut e = Vec3::ZERO;
    for i in 0..9 {
        e += sh[i] * (A[i] * b[i]);
    }
    (e / PI).max(Vec3::ZERO)
}

/// Writes the irradiance of `sh` into a cube image (from `sky::new_cubemap`).
pub fn fill_irradiance_cubemap(img: &mut Image, sh: &[Vec3; 9]) {
    let size = img.texture_descriptor.size.width;
    let texels = (size * size) as usize;
    let Some(data) = img.data.as_mut() else { return };
    if data.len() != texels * 6 * 8 {
        return;
    }
    for face in 0..6 {
        for y in 0..size {
            for x in 0..size {
                let c = sh9_irradiance(sh, cube_texel_dir(face, x, y, size));
                let i = (face * texels + (y * size + x) as usize) * 8;
                for (k, v) in [c.x, c.y, c.z, 1.0].into_iter().enumerate() {
                    data[i + k * 2..i + k * 2 + 2].copy_from_slice(&f16_bits(v).to_le_bytes());
                }
            }
        }
    }
}

#[derive(Clone)]
struct ExtractedProbe {
    worker: Option<Entity>,
    cube: AssetId<Image>,
    faces: [AssetId<Image>; 6],
    mask: u8,
    shared: Arc<ProbeShared>,
}

#[derive(Resource, Default)]
struct ExtractedProbes(Vec<ExtractedProbe>);

/// Render entity of the sky env worker and whether it filters the atmosphere (for
/// `apply::EnvFilterCounter`).
#[derive(Resource, Default)]
struct ExtractedSkyEnv(Option<(Entity, bool)>, super::apply::EnvFilterCounter);

fn extract_sky_env(
    mut out: ResMut<ExtractedSkyEnv>,
    counter: Extract<Option<Res<super::apply::EnvFilterCounter>>>,
    workers: Extract<Query<(&RenderEntity, &super::apply::SkyEnvWorker)>>,
) {
    out.0 = workers.iter().next().map(|(r, w)| (r.id(), w.atmosphere));
    if let Some(c) = counter.as_ref() {
        out.1 = (**c).clone();
    }
}

fn extract_probes(mut out: ResMut<ExtractedProbes>, probes: Extract<Query<(&ProbeTargets, &ProbeCopyMask)>>, render: Extract<Query<&RenderEntity>>) {
    out.0.clear();
    for (t, mask) in &probes {
        out.0.push(ExtractedProbe {
            worker: render.get(t.worker).ok().map(|r| r.id()),
            cube: t.cube.id(),
            faces: std::array::from_fn(|i| t.faces[i].id()),
            mask: mask.0,
            shared: t.shared.clone(),
        });
    }
}

/// Counts frames in which Bevy's env-map filter had everything it needs for a probe (and for
/// the sky env worker; an atmosphere one also needs Bevy's atmosphere cubemap pipeline).
fn count_filtered(
    probes: Res<ExtractedProbes>,
    sky_env: Res<ExtractedSkyEnv>,
    mut atmosphere_ready: Local<bool>,
    pipelines: Option<Res<bevy::pbr::generate::GeneratorPipelines>>,
    cache: Res<bevy::render::render_resource::PipelineCache>,
    envs: Query<(), With<bevy::pbr::generate::RenderEnvironmentMap>>,
) {
    let Some(p) = pipelines else { return };
    let ready = [p.downsample_first, p.downsample_second, p.copy, p.radiance, p.irradiance].iter().all(|id| cache.get_compute_pipeline(*id).is_some());
    if !ready {
        return;
    }
    for pr in &probes.0 {
        if pr.worker.is_some_and(|e| envs.contains(e)) {
            pr.shared.filtered.fetch_add(1, Ordering::Relaxed);
        }
    }
    let Some((worker, atmosphere)) = sky_env.0 else { return };
    if atmosphere && !*atmosphere_ready {
        use bevy::render::render_resource::{CachedPipelineState, PipelineDescriptor};
        *atmosphere_ready = cache.pipelines().any(|p| {
            matches!(&p.descriptor, PipelineDescriptor::ComputePipelineDescriptor(d) if d.label.as_deref() == Some("environment_pipeline"))
                && matches!(p.state, CachedPipelineState::Ok(_))
        });
    }
    if envs.contains(worker) && (!atmosphere || *atmosphere_ready) {
        sky_env.1.0.fetch_add(1, Ordering::Relaxed);
    }
}

fn copy_probe_faces(probes: Res<ExtractedProbes>, images: Res<RenderAssets<GpuImage>>, device: Res<RenderDevice>, queue: Res<RenderQueue>) {
    if probes.0.iter().all(|p| p.mask == 0) {
        return;
    }
    let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor { label: Some("look_probe_copy") });
    let mut any = false;
    for p in probes.0.iter().filter(|p| p.mask != 0) {
        let Some(cube) = images.get(p.cube) else { continue };
        let mut copied = false;
        for (i, face) in p.faces.iter().enumerate() {
            if p.mask & (1 << i) == 0 {
                continue;
            }
            let Some(src) = images.get(*face) else { continue };
            let size = src.texture_descriptor.size;
            if size.width != cube.texture_descriptor.size.width {
                continue;
            }
            encoder.copy_texture_to_texture(
                TexelCopyTextureInfo { texture: &src.texture, mip_level: 0, origin: Origin3d::ZERO, aspect: TextureAspect::All },
                TexelCopyTextureInfo { texture: &cube.texture, mip_level: 0, origin: Origin3d { x: 0, y: 0, z: i as u32 }, aspect: TextureAspect::All },
                Extent3d { width: size.width, height: size.height, depth_or_array_layers: 1 },
            );
            copied = true;
        }
        if copied {
            any = true;
            p.shared.copies.fetch_add(1, Ordering::Relaxed);
        }
    }
    if any {
        queue.submit([encoder.finish()]);
    }
}

// ---------------------------------------------------------------- irradiance volumes

/// Ambient-cube side order used by [`irradiance_volume_image`]'s closure.
pub const SIDES: [Vec3; 6] = [Vec3::NEG_X, Vec3::X, Vec3::NEG_Y, Vec3::Y, Vec3::NEG_Z, Vec3::Z];

/// Bevy's irradiance-volume texture (`Rgba16Float`, `(Rx, 2Ry, 3Rz)`) from a closure giving the
/// light (linear RGB, cd/m² before the volume's `intensity`) arriving at voxel `cell`
/// (0..res) from [`SIDES`]`[side]`. Spawn it as
/// `(LightProbe, IrradianceVolume { voxels: images.add(img), intensity, .. }, Transform)`.
pub fn irradiance_volume_image(res: UVec3, mut light: impl FnMut(UVec3, usize) -> Vec3) -> Image {
    let res = res.max(UVec3::ONE);
    let (w, h, d) = (res.x, res.y * 2, res.z * 3);
    let mut data = vec![0u8; (w * h * d) as usize * 8];
    for z in 0..res.z {
        for y in 0..res.y {
            for x in 0..res.x {
                for (side, _) in SIDES.iter().enumerate() {
                    let c = light(UVec3::new(x, y, z), side);
                    let t = y + if side % 2 == 1 { res.y } else { 0 };
                    let p = z + res.z * (side as u32 / 2);
                    let i = ((p * h + t) * w + x) as usize * 8;
                    for (k, v) in [c.x, c.y, c.z, 1.0].into_iter().enumerate() {
                        data[i + k * 2..i + k * 2 + 2].copy_from_slice(&f16_bits(v.max(0.0)).to_le_bytes());
                    }
                }
            }
        }
    }
    Image::new(Extent3d { width: w, height: h, depth_or_array_layers: d }, TextureDimension::D3, data, TextureFormat::Rgba16Float, RenderAssetUsages::RENDER_WORLD)
}

/// Sky light arriving from `side` ([`SIDES`]) for a gradient sky: the average of the sky
/// over that hemisphere (cosine-weighted, 64 samples), times `visibility` (0..1, your occlusion).
pub fn sky_ambient_cube(g: &SkyGradient, side: usize, visibility: f32) -> Vec3 {
    let n = SIDES[side.min(5)];
    let (t, b) = n.any_orthonormal_pair();
    let mut sum = Vec3::ZERO;
    let mut wsum = 0.0;
    for i in 0..8 {
        for j in 0..8 {
            let (u, v) = ((i as f32 + 0.5) / 8.0, (j as f32 + 0.5) / 8.0);
            let r = u.sqrt();
            let phi = v * std::f32::consts::TAU;
            let dir = (t * (r * phi.cos()) + b * (r * phi.sin()) + n * (1.0 - u).max(0.0).sqrt()).normalize();
            sum += sky_radiance(g, dir);
            wsum += 1.0;
        }
    }
    sum / wsum * visibility
}

/// A cube image of the sky gradient (for capturing tests and custom probes).
pub fn gradient_cubemap(size: u32, g: &SkyGradient) -> Image {
    let mut img = new_cubemap(size);
    super::sky::fill_sky_cubemap(&mut img, g);
    img
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::look::sky::f16_to_f32;

    #[test]
    fn irradiance_layout_matches_bevy() {
        let res = UVec3::new(2, 3, 4);
        let img = irradiance_volume_image(res, |c, side| Vec3::new(c.x as f32, c.y as f32 + 10.0 * side as f32, c.z as f32));
        let s = img.texture_descriptor.size;
        assert_eq!((s.width, s.height, s.depth_or_array_layers), (2, 6, 12));
        let data = img.data.as_ref().unwrap();
        let at = |s: u32, t: u32, p: u32| {
            let i = ((p * 6 + t) * 2 + s) as usize * 8;
            (f16_to_f32(u16::from_le_bytes([data[i], data[i + 1]])), f16_to_f32(u16::from_le_bytes([data[i + 2], data[i + 3]])))
        };
        // Voxel (1, 2, 3) side +Y (index 3): t = y + Ry, p = z + Rz.
        let (r, g) = at(1, 2 + 3, 3 + 4);
        assert_eq!((r, g), (1.0, 32.0));
        // Side -Z (index 4): t = y, p = z + 2 Rz.
        let (_, g) = at(0, 1, 2 + 8);
        assert_eq!(g, 41.0);
    }

    /// A GPU-style readback (rows padded to 256 bytes) of a cube with radiance `f(dir)`.
    fn readback_of(size: u32, f: impl Fn(Vec3) -> Vec3) -> Vec<u8> {
        let row = (size as usize * 8).div_ceil(256) * 256;
        let mut data = vec![0u8; row * size as usize * 6];
        for face in 0..6 {
            for y in 0..size {
                for x in 0..size {
                    let c = f(cube_texel_dir(face, x, y, size));
                    let i = face * row * size as usize + y as usize * row + x as usize * 8;
                    for (k, v) in [c.x, c.y, c.z, 1.0].into_iter().enumerate() {
                        data[i + k * 2..i + k * 2 + 2].copy_from_slice(&f16_bits(v).to_le_bytes());
                    }
                }
            }
        }
        data
    }

    #[test]
    fn sh_irradiance_of_uniform_and_half_lit_cubes() {
        let total: f32 = (0..16).flat_map(|y| (0..16).map(move |x| texel_solid_angle(x, y, 16))).sum::<f32>() * 6.0;
        assert!((total - 4.0 * std::f32::consts::PI).abs() < 1e-3, "solid angles sum to 4π: {total}");
        let sh = sh9_from_cube_rgba16f(&readback_of(16, |_| Vec3::ONE), 16, 1);
        for n in [Vec3::X, Vec3::NEG_Y, Vec3::new(0.3, 0.5, -0.8).normalize()] {
            let e = sh9_irradiance(&sh, n);
            assert!((e.x - 1.0).abs() < 0.02, "uniform sky → 1 everywhere, got {e} at {n}");
        }
        // Light only from above: the up-facing irradiance is near the cosine average (1), the
        // down-facing one near 0, sideways ≈ 0.5.
        let sh = sh9_from_cube_rgba16f(&readback_of(32, |d| if d.y > 0.0 { Vec3::ONE } else { Vec3::ZERO }), 32, 2);
        let (up, down, side) = (sh9_irradiance(&sh, Vec3::Y).x, sh9_irradiance(&sh, Vec3::NEG_Y).x, sh9_irradiance(&sh, Vec3::X).x);
        assert!(up > 0.9 && down < 0.1 && (side - 0.5).abs() < 0.05, "up {up} down {down} side {side}");
        let mut img = new_cubemap(8);
        fill_irradiance_cubemap(&mut img, &sh);
        assert!(img.data.unwrap().iter().any(|b| *b != 0));
    }

    #[test]
    fn faces_are_right_handed() {
        for (f, u) in FACES {
            let r = f.cross(u);
            assert!((r.length() - 1.0).abs() < 1e-6);
        }
        // Face direction matches the cube layout used by the gradient sky.
        for (i, (f, _)) in FACES.iter().enumerate() {
            let d = super::super::sky::cube_texel_dir(i, 8, 8, 16);
            assert!(d.dot(*f) > 0.99, "face {i}");
        }
    }

    #[test]
    fn sky_cube_brighter_from_above() {
        let g = SkyGradient {
            zenith: Vec3::splat(1.0),
            horizon: Vec3::splat(0.5),
            ground: Vec3::splat(0.05),
            to_sun: Vec3::Y,
            sun_color: Vec3::ZERO,
            sun_glow: 0.0,
            stars: 0.0,
        };
        let up = sky_ambient_cube(&g, 3, 1.0);
        let down = sky_ambient_cube(&g, 2, 1.0);
        assert!(up.x > 0.6 && down.x < 0.3, "{up} {down}");
        assert_eq!(sky_ambient_cube(&g, 3, 0.0), Vec3::ZERO);
    }
}
