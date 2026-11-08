//! Clouds: a camera-following dome (`clouds.wesl`) ray-marches a 1.8-3.2 km cloud shell over a
//! curved earth (Low: one sample of a flat layer; Medium 4 steps, 1 light tap; High+ 8 steps,
//! 2 taps), with a procedural star field and Milky Way band, and a procedural moon that comes up
//! where the night light is. Cloud shadows: the same cloud field is sampled on the CPU
//! ([`CloudField`]) to dim the sun as clouds pass over the camera ([`CloudShadowParams`] also
//! exposes the layer for a material that wants shaped ground shadows).
//!
//! One mesh (a unit sphere centred on the camera in the vertex shader), unlit, premultiplied
//! alpha, depth-tested and not written: only sky pixels shade, in the transparent pass after
//! Bevy's atmosphere. Density = a macro coverage map x a Perlin-Worley shape (2D, 256^2,
//! tiling) with a height profile, eroded by a 3D Worley detail volume (32^3); both textures are
//! generated at startup (0.3 MB). Wind drifts the layer. Needs `Look.sky.mode = Atmosphere`
//! (the default): the clouds are drawn over Bevy's atmosphere.

use std::f32::consts::PI;
use std::sync::Arc;

use bevy::asset::RenderAssetUsages;
use bevy::camera::visibility::NoFrustumCulling;
use bevy::image::{ImageAddressMode, ImageFilterMode, ImageSampler, ImageSamplerDescriptor};
use bevy::light::{NotShadowCaster, NotShadowReceiver};
use bevy::mesh::{Indices, MeshVertexBufferLayoutRef, PrimitiveTopology};
use bevy::pbr::{Material, MaterialPipeline, MaterialPipelineKey, MaterialPlugin};
use bevy::prelude::*;
use bevy::render::render_resource::{AsBindGroup, Extent3d, RenderPipelineDescriptor, ShaderType, SpecializedMeshPipelineError, TextureDimension, TextureFormat};
use bevy::shader::ShaderRef;

use super::{DayClock, DayConfig, DaySet, DaySky, DayWeather, keys};
use crate::gfx::{MainCamera, Sun};
use crate::look::Look;
use crate::render_budget::Actor;

/// Radius of the cloud mesh around the camera (m): beyond any terrain, so the depth test keeps
/// clouds to the sky. The camera's far plane must reach it (Bevy's default is infinite).
pub const DOME_R: f32 = 40_000.0;

/// Cloud knobs.
#[derive(Clone, Debug)]
pub struct CloudConfig {
    pub enabled: bool,
    /// Wind at cloud height (m/s, world XZ).
    pub wind: Vec2,
    /// Layer altitudes (m, world Y).
    pub base: f32,
    pub top: f32,
    /// Extinction (1/m) at full density.
    pub extinction: f32,
    /// Dim the sun as clouds pass over the camera.
    pub shadows: bool,
    /// How much of the direct sun a solid cloud takes off (0..1).
    pub shadow_strength: f32,
    /// Share of sky cells that hold a star, and their overall brightness.
    pub star_density: f32,
    pub star_brightness: f32,
    /// The drawn moon: angular radius (rad), radiance, maria contrast 0..1.
    pub moon_radius: f32,
    pub moon_radiance: f32,
    pub moon_contrast: f32,
}

impl Default for CloudConfig {
    fn default() -> Self {
        CloudConfig {
            enabled: true,
            wind: Vec2::new(11.0, -3.5),
            base: 1800.0,
            top: 3200.0,
            extinction: 0.045,
            shadows: true,
            shadow_strength: 0.75,
            star_density: 0.03,
            star_brightness: 2.2,
            // 3.5x the true size (0.26 degrees): a dot through a wide game camera.
            moon_radius: 0.016,
            moon_radiance: 12.0,
            moon_contrast: 0.7,
        }
    }
}

// ---------------------------------------------------------------- cloud material

/// Shader parameters (`clouds.wesl` `Clouds`). Colours are linear radiance in cd/m2 (the shader
/// multiplies by the view's exposure, as Bevy's sky does).
#[derive(Clone, Copy, Debug, Default, ShaderType)]
pub struct CloudUniform {
    /// xyz: towards the light (sun or moon); w: 1 when it is the moon.
    pub sun_dir: Vec4,
    /// rgb: illuminance of the light on the clouds (colour x lux); w: daylight 0..1.
    pub sun_rad: Vec4,
    /// rgb: sky radiance lighting the clouds from above / from the ground below.
    pub amb_top: Vec4,
    pub amb_bot: Vec4,
    /// rgb: horizon haze radiance; w: cumulus growth 0..1 (how tall the cells build).
    pub haze: Vec4,
    /// coverage 0..1, extinction (1/m) at full density, base and top altitude (m).
    pub shape: Vec4,
    /// xy: wind offset (m), z: detail offset (m), w: march steps (1 = flat layer).
    pub wind: Vec4,
    /// x: star radiance, y: sky rotation (rad), z: time (s), w: light taps.
    pub stars: Vec4,
    /// x: the moon's angular radius (rad), y: phase angle (rad, 0 = full), z: its radiance at
    /// full light, w: visible 0..1 (drawn where `sun_dir` points while it is the moon).
    pub moon: Vec4,
    /// x: latitude (rad), y: star density, z: moon maria contrast.
    pub sky: Vec4,
}

#[derive(Asset, AsBindGroup, TypePath, Debug, Clone)]
pub struct CloudMaterial {
    #[uniform(100)]
    pub p: CloudUniform,
    #[texture(101)]
    #[sampler(102)]
    pub weather: Handle<Image>,
    #[texture(103, dimension = "3d")]
    #[sampler(104)]
    pub detail: Handle<Image>,
}

impl Material for CloudMaterial {
    fn vertex_shader() -> ShaderRef {
        "embedded://engine/daytime/clouds.wesl".into()
    }
    fn fragment_shader() -> ShaderRef {
        "embedded://engine/daytime/clouds.wesl".into()
    }
    fn alpha_mode(&self) -> AlphaMode {
        AlphaMode::Premultiplied
    }
    fn enable_prepass() -> bool {
        false
    }
    fn enable_shadows() -> bool {
        false
    }
    fn specialize(_: &MaterialPipeline, descriptor: &mut RenderPipelineDescriptor, _: &MeshVertexBufferLayoutRef, _: MaterialPipelineKey<Self>) -> Result<(), SpecializedMeshPipelineError> {
        // The camera is inside the dome.
        descriptor.primitive.cull_mode = None;
        Ok(())
    }
}

/// The cloud dome entity.
#[derive(Component)]
pub struct CloudDome;

/// Cloud bookkeeping: the material, the drift, the CPU copy of the cloud field.
#[derive(Resource)]
pub struct CloudState {
    pub material: Option<Handle<CloudMaterial>>,
    /// Accumulated wind drift (m).
    pub drift: Vec2,
    /// Current coverage fed to the shader (after the slow wander).
    pub cover: f32,
    /// Sun transmittance at the camera from cloud shadows (1 = unshadowed).
    pub sun_factor: f32,
}

impl Default for CloudState {
    fn default() -> Self {
        CloudState { material: None, drift: Vec2::ZERO, cover: 0.0, sun_factor: 1.0 }
    }
}

/// The cloud layer for materials that draw shaped ground shadows: world-XZ wind offset, the
/// coverage, shadow strength and the layer's mid altitude, plus the light direction. Updated
/// every frame. (The engine itself only dims the sun with [`CloudField::shadow`].)
#[derive(Resource, Clone, Copy, Debug, Default, PartialEq)]
pub struct CloudShadowParams {
    pub wind_offset: Vec2,
    pub coverage: f32,
    pub strength: f32,
    pub to_light: Vec3,
    pub mid_altitude: f32,
}

/// The weather map on the CPU (256^2 RGBA8, tiling): samples cloud density the way the shader
/// does, for shadows and gameplay (is it cloudy over there).
#[derive(Resource, Clone)]
pub struct CloudField {
    pixels: Arc<Vec<u8>>,
    n: u32,
}

impl CloudField {
    pub fn new() -> Self {
        const N: u32 = 256;
        CloudField { pixels: Arc::new(weather_pixels(N)), n: N }
    }

    /// Bilinear, wrapping sample of channel `ch` (0..3) at texture coords `uv`.
    fn tex(&self, uv: Vec2, ch: usize) -> f32 {
        let n = self.n as f32;
        let p = uv * n - 0.5;
        let (i, f) = (p.floor(), p - p.floor());
        let at = |dx: f32, dy: f32| {
            let (x, y) = ((i.x + dx).rem_euclid(n) as u32, (i.y + dy).rem_euclid(n) as u32);
            self.pixels[((y * self.n + x) * 4) as usize + ch] as f32 / 255.0
        };
        let (a, b) = (at(0.0, 0.0) + (at(1.0, 0.0) - at(0.0, 0.0)) * f.x, at(0.0, 1.0) + (at(1.0, 1.0) - at(0.0, 1.0)) * f.x);
        a + (b - a) * f.y
    }

    /// Cloud density 0..1 at world XZ `xz` and layer height fraction `h` (0 base .. 1 top), without the shader's fine detail.
    pub fn density(&self, xz: Vec2, h: f32, wind_offset: Vec2, coverage: f32, growth: f32) -> f32 {
        let q = xz + wind_offset;
        let m = self.tex(q / MACRO_TILE, 0);
        let uv = q / SHAPE_TILE + Vec2::new(0.31, 0.17);
        let (sg, sb) = (self.tex(uv, 1), self.tex(uv, 2));
        let cov = (coverage + (m - 0.5) * 0.7).clamp(0.0, 1.0);
        let tall = (0.3 + 0.7 * sb) * (0.45 + 0.55 * growth);
        let profile = remap(h, 0.0, 0.08) * remap(h, tall, tall * 0.55);
        remap(sg * 0.75 + sb * 0.25, 1.0 - cov * 1.25, 1.05 - cov * 0.4) * profile
    }

    /// Sun transmittance (0..1) at ground point `at` for light travelling from direction
    /// `to_light` through the layer: 1 in the open, down to `1 - strength` under solid cloud.
    pub fn shadow(&self, at: Vec3, p: &CloudShadowParams, growth: f32) -> f32 {
        if p.to_light.y < 0.05 || p.strength <= 0.0 {
            return 1.0;
        }
        let t = (p.mid_altitude - at.y) / p.to_light.y;
        let hit = Vec2::new(at.x, at.z) + Vec2::new(p.to_light.x, p.to_light.z) * t;
        // Three heights through the layer: a cell is densest low down.
        let d = (self.density(hit, 0.15, p.wind_offset, p.coverage, growth) + self.density(hit, 0.35, p.wind_offset, p.coverage, growth) + self.density(hit, 0.6, p.wind_offset, p.coverage, growth)) / 3.0;
        1.0 - p.strength * (d * 3.0).min(1.0)
    }
}

impl Default for CloudField {
    fn default() -> Self {
        CloudField::new()
    }
}

// Map scales (m per texture tile), as in the shader.
const MACRO_TILE: f32 = 60_000.0;
const SHAPE_TILE: f32 = 19_000.0;

pub(super) fn plugin(app: &mut App) {
    app.init_resource::<CloudState>().init_resource::<CloudShadowParams>();
    if app.get_sub_app(bevy::render::RenderApp).is_some() {
        bevy::asset::embedded_asset!(app, "clouds.wesl");
        app.add_plugins(MaterialPlugin::<CloudMaterial>::default());
        app.add_systems(Update, spawn_dome.in_set(DaySet::Clouds).run_if(super::live));
    }
    app.add_systems(Update, make_field.in_set(DaySet::Clouds).run_if(super::live.and_then(field_missing)))
        .add_systems(Update, (feed_clouds, cloud_shadows.run_if(resource_exists::<CloudField>)).chain().in_set(DaySet::Clouds).run_if(super::live));
}

/// A unit ico-sphere with positions only (the vertex shader scales and centres it).
fn dome_mesh() -> Mesh {
    let s = Sphere::new(1.0).mesh().ico(3).expect("ico sphere");
    let pos = s.attribute(Mesh::ATTRIBUTE_POSITION).cloned().expect("positions");
    let idx: Vec<u32> = s.indices().expect("indices").iter().map(|i| i as u32).collect();
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::RENDER_WORLD)
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
        .with_inserted_indices(Indices::U32(idx))
}

/// Spawns the dome once there is a camera and an atmosphere sky.
fn spawn_dome(
    mut commands: Commands,
    cfg: Res<DayConfig>,
    look: Option<Res<Look>>,
    cam: Query<(), With<MainCamera>>,
    domes: Query<(), With<CloudDome>>,
    mut st: ResMut<CloudState>,
    mut images: ResMut<Assets<Image>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: Option<ResMut<Assets<CloudMaterial>>>,
) {
    let (Some(mats), Some(look)) = (mats.as_mut(), look) else { return };
    if !cfg.clouds.enabled || !domes.is_empty() || cam.is_empty() || look.sky.mode != crate::look::SkyMode::Atmosphere {
        return;
    }
    let mat = mats.add(CloudMaterial { p: CloudUniform::default(), weather: images.add(weather_image()), detail: images.add(detail_image()) });
    st.material = Some(mat.clone());
    commands.spawn((
        Name::new("Clouds"),
        CloudDome,
        Mesh3d(meshes.add(dome_mesh())),
        MeshMaterial3d(mat),
        Transform::default(),
        NoFrustumCulling,
        NotShadowCaster,
        NotShadowReceiver,
        Actor,
    ));
}

/// Steps and light taps per graphics quality (Low: a flat layer, one sample).
fn tier_steps(q: usize) -> (f32, f32) {
    match q {
        0 => (1.0, 0.0),
        1 => (4.0, 1.0),
        _ => (8.0, 2.0),
    }
}

/// Rough sunlight transmittance through the air at sun elevation `el` (degrees), seen from
/// cloud height: Kasten-Young air mass, Rayleigh + haze optical depths per channel.
pub fn sun_transmittance(el: f32) -> Vec3 {
    let e = el.max(-1.5);
    let mass = 1.0 / (e.to_radians().sin() + 0.505_72 * (e + 6.079_95).powf(-1.636_4));
    let tau = Vec3::new(0.1, 0.17, 0.32) * 0.8;
    (-tau * mass.max(1.0)).exp()
}

/// Display value of 1 cd/m2 at the look's exposure (the fog colour is display-referred).
fn exposure_scale(look: &Look) -> f32 {
    1.0 / (1.2 * 2f32.powf(look.exposure.ev100))
}

/// The coverage the shader gets: the keyed / weather value plus a slow wander (a few tenths
/// over a couple of game hours).
pub fn wandering_cover(base: f32, hours: f32) -> f32 {
    let t = hours / 24.0 * 2.0 * PI;
    (base + 0.08 * (t * 3.0 + 1.3).sin() + 0.05 * (t * 7.0 + 0.4).sin()).clamp(0.0, 1.0)
}

/// Feeds the clock, the look's light and the wind to the cloud shader each frame.
fn feed_clouds(
    time: Res<Time<Virtual>>,
    real: Res<Time<Real>>,
    clock: Res<DayClock>,
    sky: Res<DaySky>,
    cfg: Res<DayConfig>,
    weather: Res<DayWeather>,
    look: Option<Res<Look>>,
    core: Option<Res<crate::settings::CoreSettings>>,
    mut st: ResMut<CloudState>,
    mut shadow: ResMut<CloudShadowParams>,
    mut mats: Option<ResMut<Assets<CloudMaterial>>>,
    cam: Query<&GlobalTransform, With<MainCamera>>,
    mut dome: Query<&mut Transform, With<CloudDome>>,
) {
    let Some(look) = look else { return };
    let c = &cfg.clouds;
    // Wind runs on game time at the real wind speed (pause stops it).
    st.drift += c.wind * time.delta_secs();
    let sun_el = sky.sun_elevation;
    let to_light = -look.sun.direction();
    let cover = wandering_cover(keys::cloud_cover(&cfg, &weather, sun_el), clock.hours);
    st.cover = cover;
    *shadow = CloudShadowParams { wind_offset: st.drift, coverage: cover, strength: if sky.light.moon > 0.0 { 0.0 } else { c.shadow_strength * sky.daylight }, to_light, mid_altitude: (c.base + c.top) * 0.5 };
    let (Some(h), Some(mats)) = (st.material.clone(), mats.as_mut()) else { return };
    // What the engine actually gives the light (it fades it under the horizon).
    let fade = ((look.sun.elevation_deg + 3.0) / 3.0).clamp(0.0, 1.0);
    let lux = look.sun.illuminance * fade;
    let col = look.sun.color.linear();
    // The light as the clouds get it: through the atmosphere (Bevy does this for the sky and the
    // ground; the clouds are ours). The moon is high: no reddening.
    let trans = if sky.light.moon > 0.0 { Vec3::splat(0.85) } else { sun_transmittance(look.sun.elevation_deg.max(sun_el)) };
    let sin_el = look.sun.elevation_deg.to_radians().sin();
    let up = sin_el.max(0.0);
    // Sky light on the clouds: blue from above, warmer while the sun is low.
    let sky_col = Vec3::new(0.9, 0.72, 0.62).lerp(Vec3::new(0.45, 0.62, 1.0), (sin_el * 5.0).clamp(0.0, 1.0));
    let amb = look.ambient.color.linear() * look.ambient.brightness;
    let top = sky_col * (lux * (0.006 + 0.045 * up)) + amb * 0.1;
    let bottom = Vec3::new(0.32, 0.34, 0.3) * (lux * up * 0.12 / PI) * trans + amb * 0.03;
    let haze = look.fog.color.linear() / exposure_scale(&look);
    let (steps, taps) = tier_steps(core.map_or(2, |c| c.quality.index()));
    let Some(mut m) = mats.get_mut(&h) else { return };
    m.p = CloudUniform {
        sun_dir: to_light.extend(sky.light.moon),
        sun_rad: (col * lux * trans).extend(sky.daylight),
        amb_top: top.extend(0.0),
        amb_bot: bottom.extend(0.0),
        haze: haze.extend(keys::cloud_growth(clock.hours)),
        shape: Vec4::new(cover, c.extinction, c.base, c.top),
        wind: Vec4::new(st.drift.x, st.drift.y, st.drift.x * 0.6, steps),
        stars: Vec4::new(sky.stars * c.star_brightness, sky.sidereal, real.elapsed_secs_wrapped(), taps),
        // The moon comes up with the stars, drawn where the light is while it is the moon.
        moon: Vec4::new(c.moon_radius, sky.moon.phase_angle, c.moon_radiance, sky.stars * sky.light.moon),
        sky: Vec4::new(clock.latitude.to_radians(), c.star_density, c.moon_contrast, 0.0),
    };
    // The farthest transparent thing (drawn first): far ahead of the camera.
    if let (Some(cam), Ok(mut tf)) = (cam.iter().next(), dome.single_mut()) {
        let p = cam.translation() + cam.forward() * DOME_R;
        if tf.translation.distance_squared(p) > 1.0 {
            tf.translation = p;
        }
    }
}

/// Dims the sun as clouds pass over the camera: transmittance sampled from the CPU cloud field,
/// eased over a second, written onto the sun light after the look applied.
fn cloud_shadows(
    time: Res<Time>,
    cfg: Res<DayConfig>,
    clock: Res<DayClock>,
    params: Res<CloudShadowParams>,
    look: Option<Res<Look>>,
    field: Res<CloudField>,
    mut st: ResMut<CloudState>,
    cam: Query<&GlobalTransform, With<MainCamera>>,
    mut sun: Query<&mut DirectionalLight, With<Sun>>,
) {
    let Some(look) = look else { return };
    let target = if cfg.clouds.shadows && cfg.clouds.enabled { cam.iter().next().map_or(1.0, |c| field.shadow(c.translation(), &params, keys::cloud_growth(clock.hours))) } else { 1.0 };
    let k = 1.0 - (-time.delta_secs() * 1.2).exp();
    let cur = st.sun_factor;
    let next = cur + (target - cur) * k;
    st.sun_factor = next;
    // Only touch the light while shadowing (or just after, to restore it).
    if (next - 1.0).abs() < 0.002 && (cur - 1.0).abs() < 0.002 {
        st.sun_factor = 1.0;
        return;
    }
    let s = &look.sun;
    let fade = ((s.elevation_deg + 3.0) / 3.0).clamp(0.0, 1.0);
    for mut l in &mut sun {
        let want = s.illuminance * fade * next;
        if (l.illuminance - want).abs() > want * 0.002 {
            l.illuminance = want;
        }
    }
}

fn field_missing(f: Option<Res<CloudField>>) -> bool {
    f.is_none()
}

/// Builds the CPU cloud field the first frame the clock runs (not before: zero cost unused).
fn make_field(mut commands: Commands) {
    commands.insert_resource(CloudField::new());
}

// ---------------------------------------------------------------- noise textures

fn hash3(x: i32, y: i32, z: i32, seed: u32) -> u32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343) ^ (y as u32).wrapping_mul(0xd816_3841) ^ (z as u32).wrapping_mul(0xcb1a_b31f) ^ seed.wrapping_mul(0x165_667b1);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5bd1_e995);
    h ^ (h >> 15)
}

fn unit(h: u32) -> f32 {
    (h & 0x00ff_ffff) as f32 / 16_777_216.0
}

/// Tileable gradient noise (Perlin) at `p` with lattice period `period` (≈ −1..1).
fn perlin2(p: Vec2, period: i32, seed: u32) -> f32 {
    let i = p.floor();
    let f = p - i;
    let g = |dx: i32, dy: i32| {
        let (x, y) = ((i.x as i32 + dx).rem_euclid(period), (i.y as i32 + dy).rem_euclid(period));
        let a = unit(hash3(x, y, 0, seed)) * 2.0 * PI;
        Vec2::new(a.cos(), a.sin()).dot(f - Vec2::new(dx as f32, dy as f32))
    };
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let (a, b, c, d) = (g(0, 0), g(1, 0), g(0, 1), g(1, 1));
    (a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y) * 1.4
}

/// Tileable Worley noise: distance to the nearest feature point (0..≈1), period in cells.
fn worley3(p: Vec3, period: i32, seed: u32) -> f32 {
    let i = p.floor();
    let mut best = 9.0f32;
    for dz in -1..=1 {
        for dy in -1..=1 {
            for dx in -1..=1 {
                let c = i + Vec3::new(dx as f32, dy as f32, dz as f32);
                let (x, y, z) = ((c.x as i32).rem_euclid(period), (c.y as i32).rem_euclid(period), (c.z as i32).rem_euclid(period));
                let h = hash3(x, y, z, seed);
                let o = Vec3::new(unit(h), unit(h.rotate_left(11)), unit(h.rotate_left(22)));
                best = best.min((c + o).distance_squared(p));
            }
        }
    }
    best.sqrt()
}

fn remap(v: f32, lo: f32, hi: f32) -> f32 {
    ((v - lo) / (hi - lo)).clamp(0.0, 1.0)
}

/// Weather map, 256² RGBA8, tiling: R macro coverage (Perlin fbm), G cloud shape (Perlin-Worley),
/// B puffs (Worley fbm).
pub fn weather_pixels(n: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((n * n * 4) as usize);
    for y in 0..n {
        for x in 0..n {
            let uv = Vec2::new(x as f32, y as f32) / n as f32;
            let fbm = |base: i32, oct: u32, seed: u32| {
                let (mut s, mut a, mut w) = (0.0, 0.5, 0.0);
                for o in 0..oct {
                    let p = 1 << o;
                    s += a * perlin2(uv * (base * p) as f32, base * p, seed + o);
                    w += a;
                    a *= 0.5;
                }
                (s / w) * 0.5 + 0.5
            };
            let wor = |base: i32, seed: u32| {
                let p = uv.extend(0.37);
                let f = |k: i32| 1.0 - worley3(p * (base * k) as f32, base * k, seed + k as u32).min(1.0);
                f(1) * 0.625 + f(2) * 0.25 + f(4) * 0.125
            };
            let macro_ = remap(fbm(3, 4, 11), 0.2, 0.8);
            let pw = fbm(6, 5, 23);
            let w = wor(6, 31);
            // Perlin-Worley: billowy Worley carving the Perlin's lumps.
            let shape = remap(pw, (1.0 - w) * 0.75, 1.0);
            let puffs = wor(12, 47);
            out.extend_from_slice(&[(macro_ * 255.0) as u8, (shape * 255.0) as u8, (puffs * 255.0) as u8, 255]);
        }
    }
    out
}

/// Detail volume, 32³ R8, tiling: inverted Worley fbm (erodes cloud edges into wisps).
pub fn detail_pixels(n: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((n * n * n) as usize);
    for z in 0..n {
        for y in 0..n {
            for x in 0..n {
                let p = Vec3::new(x as f32, y as f32, z as f32) / n as f32;
                let f = |k: i32, s: u32| 1.0 - worley3(p * k as f32, k, s).min(1.0);
                let v = f(4, 3) * 0.55 + f(8, 5) * 0.3 + f(16, 7) * 0.15;
                out.push((v.clamp(0.0, 1.0) * 255.0) as u8);
            }
        }
    }
    out
}

fn repeat_sampler() -> ImageSampler {
    ImageSampler::Descriptor(ImageSamplerDescriptor {
        address_mode_u: ImageAddressMode::Repeat,
        address_mode_v: ImageAddressMode::Repeat,
        address_mode_w: ImageAddressMode::Repeat,
        mag_filter: ImageFilterMode::Linear,
        min_filter: ImageFilterMode::Linear,
        mipmap_filter: ImageFilterMode::Linear,
        ..default()
    })
}

/// The cloud layer's weather map as an image (R macro coverage, G shape, B puffs).
pub fn weather_image() -> Image {
    const N: u32 = 256;
    let mut img = Image::new(Extent3d { width: N, height: N, depth_or_array_layers: 1 }, TextureDimension::D2, weather_pixels(N), TextureFormat::Rgba8Unorm, RenderAssetUsages::RENDER_WORLD);
    img.sampler = repeat_sampler();
    img
}

fn detail_image() -> Image {
    const N: u32 = 32;
    let mut img = Image::new(Extent3d { width: N, height: N, depth_or_array_layers: N }, TextureDimension::D3, detail_pixels(N), TextureFormat::R8Unorm, RenderAssetUsages::RENDER_WORLD);
    img.sampler = repeat_sampler();
    img
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_tiles_and_spans_its_range() {
        let n = 64;
        let w = weather_pixels(n);
        assert_eq!(w.len(), (n * n * 4) as usize);
        for ch in 0..3 {
            let v: Vec<u8> = w.iter().skip(ch).step_by(4).copied().collect();
            let (lo, hi) = (*v.iter().min().unwrap(), *v.iter().max().unwrap());
            assert!(lo < 60 && hi > 150, "channel {ch}: {lo}..{hi}");
        }
        // Tiling: the noise functions wrap at their period.
        let a = perlin2(Vec2::new(0.3, 0.7), 5, 9);
        let b = perlin2(Vec2::new(5.3, 0.7), 5, 9);
        assert!((a - b).abs() < 1e-4);
        let a = worley3(Vec3::new(0.2, 0.4, 0.9), 4, 1);
        let b = worley3(Vec3::new(4.2, 0.4, 4.9), 4, 1);
        assert!((a - b).abs() < 1e-4);
        assert_eq!(detail_pixels(16).len(), 16 * 16 * 16);
    }

    #[test]
    fn field_density_follows_coverage_and_shadows_dim_the_sun() {
        let f = CloudField::new();
        let mean = |cov: f32| {
            let mut s = 0.0;
            for i in 0..40 {
                for j in 0..40 {
                    s += f.density(Vec2::new(i as f32 * 900.0, j as f32 * 900.0), 0.3, Vec2::ZERO, cov, 0.8);
                }
            }
            s / 1600.0
        };
        let (clear, cloudy) = (mean(0.05), mean(0.95));
        assert!(cloudy > clear + 0.1, "{clear} {cloudy}");
        let p = CloudShadowParams { coverage: 0.95, strength: 0.75, to_light: Vec3::new(0.3, 0.8, 0.2).normalize(), mid_altitude: 2500.0, ..default() };
        let mut lo = 1.0f32;
        let mut hi = 0.0f32;
        for i in 0..200 {
            let s = f.shadow(Vec3::new(i as f32 * 400.0, 0.0, 0.0), &p, 0.8);
            lo = lo.min(s);
            hi = hi.max(s);
        }
        assert!((0.25 - 1e-4..0.9).contains(&lo) && hi > lo, "shadow range {lo}..{hi}");
        // Night / sun under the horizon: no shadow.
        assert_eq!(f.shadow(Vec3::ZERO, &CloudShadowParams { to_light: Vec3::NEG_Y, ..p }, 0.5), 1.0);
    }

    #[test]
    fn the_sun_reddens_low_down() {
        let (hi, lo) = (sun_transmittance(60.0), sun_transmittance(3.0));
        assert!(lo.z / lo.x < hi.z / hi.x);
    }
}
