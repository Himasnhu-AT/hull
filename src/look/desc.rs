//! The [`Look`] description: plain data (serde, `Default`, [`Lerp`]) that says how a scene is
//! lit and graded. Nothing here touches the ECS; `apply.rs` turns it into components.
//!
//! Units follow Bevy: sun `illuminance` in lux, sky / ambient `brightness` in cd/m², exposure
//! in EV100. Colours are sRGB triples ([`Rgb`]) so JSON stays readable; blends happen in
//! linear space.

use std::borrow::Cow;

use bevy::prelude::*;
use serde::{Deserialize, Serialize};

/// An sRGB colour, `[r, g, b]` in 0..1 (values above 1 are allowed for HDR tints).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Rgb(pub [f32; 3]);

impl Rgb {
    pub const WHITE: Rgb = Rgb([1.0, 1.0, 1.0]);
    pub const BLACK: Rgb = Rgb([0.0, 0.0, 0.0]);

    pub const fn new(r: f32, g: f32, b: f32) -> Self {
        Rgb([r, g, b])
    }

    pub fn color(self) -> Color {
        Color::srgb(self.0[0], self.0[1], self.0[2])
    }

    /// Linear RGB (for shading maths and blends).
    pub fn linear(self) -> Vec3 {
        let l = self.color().to_linear();
        Vec3::new(l.red, l.green, l.blue)
    }

    pub fn from_linear(v: Vec3) -> Self {
        let s = Color::linear_rgb(v.x, v.y, v.z).to_srgba();
        Rgb([s.red, s.green, s.blue])
    }
}

impl Default for Rgb {
    fn default() -> Self {
        Rgb::WHITE
    }
}

/// Interpolation between two values of a look (`t` in 0..1). Numbers and colours blend; flags,
/// enums and strings switch at `t = 0.5`.
pub trait Lerp {
    fn lerp_to(&self, other: &Self, t: f32) -> Self;
}

impl Lerp for f32 {
    fn lerp_to(&self, o: &Self, t: f32) -> Self {
        self + (o - self) * t
    }
}

impl Lerp for u32 {
    fn lerp_to(&self, o: &Self, t: f32) -> Self {
        (*self as f32).lerp_to(&(*o as f32), t).round() as u32
    }
}

impl Lerp for Rgb {
    fn lerp_to(&self, o: &Self, t: f32) -> Self {
        if self == o || t <= 0.0 {
            return *self;
        }
        Rgb::from_linear(self.linear().lerp(o.linear(), t))
    }
}

impl Lerp for [f32; 3] {
    fn lerp_to(&self, o: &Self, t: f32) -> Self {
        [self[0].lerp_to(&o[0], t), self[1].lerp_to(&o[1], t), self[2].lerp_to(&o[2], t)]
    }
}

macro_rules! step_lerp {
    ($($ty:ty),* $(,)?) => {$(
        impl Lerp for $ty {
            fn lerp_to(&self, o: &Self, t: f32) -> Self {
                if t < 0.5 { self.clone() } else { o.clone() }
            }
        }
    )*};
}
step_lerp!(bool, Cow<'static, str>, SkyMode, FogMode, ToneMap);

/// A name or asset path in a look (borrowed for presets: blends never allocate).
pub type Text = Cow<'static, str>;

/// `impl Lerp` for a struct by lerping every listed field.
macro_rules! lerp_fields {
    ($ty:ident { $($f:ident),* $(,)? }) => {
        impl Lerp for $ty {
            fn lerp_to(&self, o: &Self, t: f32) -> Self {
                $ty { $($f: self.$f.lerp_to(&o.$f, t)),* }
            }
        }
    };
}

/// Everything about how a scene looks, applied to the [`crate::gfx::MainCamera`] (and the sun,
/// sky, ambient light) by `LookPlugin` while this resource exists. Swap it at runtime
/// (`commands.insert_resource(Look::dusk())`), blend to another with
/// [`super::LookTransition`], edit fields over the control port (`look.set`).
///
/// Features that cost GPU time (volumetric fog, env lighting, auto exposure, DOF, motion blur,
/// vignette …) are additionally gated by the current quality tier ([`crate::gfx::QualityPreset`]).
#[derive(Resource, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Look {
    /// Preset name, or anything (shown by `look.get`).
    pub name: Text,
    pub sun: SunLook,
    pub sky: SkyLook,
    pub ambient: AmbientLook,
    pub fog: FogLook,
    pub volumetric: VolumetricLook,
    pub exposure: ExposureLook,
    pub tonemapping: ToneMap,
    pub grading: GradingLook,
    pub bloom: BloomLook,
    pub lens: LensLook,
}

impl Default for Look {
    /// The clear-day preset.
    fn default() -> Self {
        Look::clear_day()
    }
}

lerp_fields!(Look { name, sun, sky, ambient, fog, volumetric, exposure, tonemapping, grading, bloom, lens });

impl Look {
    /// Blend `self` → `other` (`t` 0..1).
    pub fn blend(&self, other: &Look, t: f32) -> Look {
        if t <= 0.0 {
            self.clone()
        } else if t >= 1.0 {
            other.clone()
        } else {
            self.lerp_to(other, t)
        }
    }

    /// `self` with the JSON object `patch` merged in (nested objects merge; other values
    /// replace). Unknown keys are an error, so typos don't pass silently.
    pub fn patched(&self, patch: &serde_json::Value) -> Result<Look, String> {
        let mut v = serde_json::to_value(self).map_err(|e| e.to_string())?;
        merge(&mut v, patch);
        serde_json::from_value(v).map_err(|e| e.to_string())
    }
}

fn merge(dst: &mut serde_json::Value, src: &serde_json::Value) {
    match (dst, src) {
        (serde_json::Value::Object(d), serde_json::Value::Object(s)) => {
            for (k, v) in s {
                match d.get_mut(k) {
                    Some(slot) => merge(slot, v),
                    None => {
                        d.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (d, s) => *d = s.clone(),
    }
}

/// The sun (or moon): a shadowed directional light tagged [`crate::gfx::Sun`]. An existing
/// `Sun` entity (e.g. from `gfx::sky_and_sun`) is taken over; otherwise one is spawned.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SunLook {
    pub enabled: bool,
    /// Compass bearing of the sun in degrees: 0 = towards -Z, 90 = towards +X.
    pub azimuth_deg: f32,
    /// Height above the horizon in degrees (light shines downwards for > 0).
    pub elevation_deg: f32,
    /// Lux. Raw sunlight ≈ 110 000, overcast ≈ 10 000–20 000, full moon ≈ 0.3.
    pub illuminance: f32,
    pub color: Rgb,
    pub shadows: bool,
    /// Shadows end here (metres from the camera).
    pub shadow_distance: f32,
    pub cascades: u32,
    pub first_cascade: f32,
    /// Apparent disk diameter in degrees for the atmosphere sky (0 hides the disk).
    pub disk_size_deg: f32,
    pub disk_intensity: f32,
    /// PCSS light size (radians-ish, Bevy's `soft_shadow_size`); feature `look_pcss` + tier.
    pub soft_shadow_size: f32,
}

impl Default for SunLook {
    fn default() -> Self {
        SunLook {
            enabled: true,
            azimuth_deg: 140.0,
            elevation_deg: 45.0,
            illuminance: 100_000.0,
            color: Rgb::new(1.0, 0.96, 0.9),
            shadows: true,
            shadow_distance: 120.0,
            cascades: 4,
            first_cascade: 8.0,
            disk_size_deg: 0.53,
            disk_intensity: 1.0,
            soft_shadow_size: 0.02,
        }
    }
}

impl Lerp for SunLook {
    fn lerp_to(&self, o: &Self, t: f32) -> Self {
        // Shortest way round the compass.
        let d = (o.azimuth_deg - self.azimuth_deg + 540.0).rem_euclid(360.0) - 180.0;
        SunLook {
            enabled: self.enabled.lerp_to(&o.enabled, t),
            azimuth_deg: (self.azimuth_deg + d * t).rem_euclid(360.0),
            elevation_deg: self.elevation_deg.lerp_to(&o.elevation_deg, t),
            // Light levels span decades (day ↔ night): blend in log space.
            illuminance: log_lerp(self.illuminance, o.illuminance, t),
            color: self.color.lerp_to(&o.color, t),
            shadows: self.shadows.lerp_to(&o.shadows, t),
            shadow_distance: self.shadow_distance.lerp_to(&o.shadow_distance, t),
            cascades: self.cascades.lerp_to(&o.cascades, t),
            first_cascade: self.first_cascade.lerp_to(&o.first_cascade, t),
            disk_size_deg: self.disk_size_deg.lerp_to(&o.disk_size_deg, t),
            disk_intensity: self.disk_intensity.lerp_to(&o.disk_intensity, t),
            soft_shadow_size: self.soft_shadow_size.lerp_to(&o.soft_shadow_size, t),
        }
    }
}

/// Geometric blend for quantities spanning orders of magnitude (falls back to linear at 0).
pub fn log_lerp(a: f32, b: f32, t: f32) -> f32 {
    if a == b || t <= 0.0 {
        a
    } else if a > 0.0 && b > 0.0 { (a.ln() + (b.ln() - a.ln()) * t).exp() } else { a.lerp_to(&b, t) }
}

impl SunLook {
    /// Direction the light travels (from the sun towards the ground).
    pub fn direction(&self) -> Vec3 {
        let (az, el) = (self.azimuth_deg.to_radians(), self.elevation_deg.to_radians());
        -Vec3::new(el.cos() * az.sin(), el.sin(), -el.cos() * az.cos()).normalize_or(Vec3::Y)
    }
}

/// How the background and the image-based (environment) light are made.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SkyMode {
    /// Bevy's physically based atmosphere (sky colour follows the sun; aerial perspective).
    #[default]
    Atmosphere,
    /// A procedural cubemap from `zenith` / `horizon` / `ground` (+ sun glow, stars), built
    /// on the CPU (a few ms, only when the colours change) and filtered on the GPU.
    Gradient,
    /// A flat `ClearColor` (`horizon`); env lighting uses the gradient cubemap.
    Color,
    /// A KTX2 cubemap from the assets folder (`cubemap`), optional prefiltered maps.
    Cubemap,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SkyLook {
    pub mode: SkyMode,
    pub zenith: Rgb,
    pub horizon: Rgb,
    pub ground: Rgb,
    /// cd/m² of a gradient colour of 1.0 (sky luminance; daylight ≈ 5 000–10 000).
    pub brightness: f32,
    /// Gradient: sun halo strength baked into the cubemap (0 = none).
    pub sun_glow: f32,
    /// Gradient: star field brightness (0 = no stars).
    pub stars: f32,
    /// Cubemap mode: KTX2 cubemap path under the assets folder (skybox + env light source).
    pub cubemap: Text,
    /// Cubemap mode: optional prefiltered diffuse / specular KTX2 maps; empty → the cubemap is
    /// filtered on the GPU.
    pub diffuse_map: Text,
    pub specular_map: Text,
}

impl Default for SkyLook {
    fn default() -> Self {
        SkyLook {
            mode: SkyMode::Atmosphere,
            zenith: Rgb::new(0.25, 0.45, 0.85),
            horizon: Rgb::new(0.7, 0.8, 0.95),
            ground: Rgb::new(0.25, 0.23, 0.2),
            brightness: 6000.0,
            sun_glow: 1.0,
            stars: 0.0,
            cubemap: Text::Borrowed(""),
            diffuse_map: Text::Borrowed(""),
            specular_map: Text::Borrowed(""),
        }
    }
}

impl Lerp for SkyLook {
    fn lerp_to(&self, o: &Self, t: f32) -> Self {
        SkyLook {
            mode: self.mode.lerp_to(&o.mode, t),
            zenith: self.zenith.lerp_to(&o.zenith, t),
            horizon: self.horizon.lerp_to(&o.horizon, t),
            ground: self.ground.lerp_to(&o.ground, t),
            brightness: log_lerp(self.brightness, o.brightness, t),
            sun_glow: self.sun_glow.lerp_to(&o.sun_glow, t),
            stars: self.stars.lerp_to(&o.stars, t),
            cubemap: self.cubemap.lerp_to(&o.cubemap, t),
            diffuse_map: self.diffuse_map.lerp_to(&o.diffuse_map, t),
            specular_map: self.specular_map.lerp_to(&o.specular_map, t),
        }
    }
}

/// Fill light: a flat ambient term plus image-based light from the sky.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AmbientLook {
    pub color: Rgb,
    /// `GlobalAmbientLight` brightness (cd/m²).
    pub brightness: f32,
    /// Multiplier on the environment (sky) light: diffuse ambient + specular reflections.
    /// 0 turns env lighting off. Needs the tier's `env_light`.
    pub env_intensity: f32,
}

impl Default for AmbientLook {
    fn default() -> Self {
        AmbientLook { color: Rgb::new(0.75, 0.82, 1.0), brightness: 300.0, env_intensity: 1.0 }
    }
}

impl Lerp for AmbientLook {
    fn lerp_to(&self, o: &Self, t: f32) -> Self {
        AmbientLook {
            color: self.color.lerp_to(&o.color, t),
            brightness: log_lerp(self.brightness, o.brightness, t),
            env_intensity: self.env_intensity.lerp_to(&o.env_intensity, t),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FogMode {
    Off,
    /// `start`..`end` metres.
    Linear,
    /// Reaches 95 % opacity at `visibility` metres.
    Exponential,
    ExponentialSquared,
    /// Per-channel extinction (`extinction`) and in-scattering (`color`) at `visibility`.
    #[default]
    Atmospheric,
}

/// Distance fog (`DistanceFog` on the camera; cheap, every tier).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FogLook {
    pub mode: FogMode,
    pub color: Rgb,
    /// Fog colour towards the sun (glow); its strength falls off with `sun_exponent`.
    pub sun_color: Rgb,
    pub sun_exponent: f32,
    /// 0..1 opacity of the sun glow colour.
    pub sun_amount: f32,
    pub start: f32,
    pub end: f32,
    pub visibility: f32,
    pub extinction: Rgb,
}

impl Default for FogLook {
    fn default() -> Self {
        FogLook {
            mode: FogMode::Atmospheric,
            color: Rgb::new(0.62, 0.7, 0.82),
            sun_color: Rgb::new(1.0, 0.9, 0.7),
            sun_exponent: 30.0,
            sun_amount: 0.5,
            start: 30.0,
            end: 400.0,
            visibility: 1500.0,
            extinction: Rgb::new(0.35, 0.5, 0.66),
        }
    }
}

impl Lerp for FogLook {
    fn lerp_to(&self, o: &Self, t: f32) -> Self {
        FogLook {
            mode: self.mode.lerp_to(&o.mode, t),
            color: self.color.lerp_to(&o.color, t),
            sun_color: self.sun_color.lerp_to(&o.sun_color, t),
            sun_exponent: self.sun_exponent.lerp_to(&o.sun_exponent, t),
            sun_amount: self.sun_amount.lerp_to(&o.sun_amount, t),
            start: self.start.lerp_to(&o.start, t),
            end: self.end.lerp_to(&o.end, t),
            visibility: log_lerp(self.visibility, o.visibility, t),
            extinction: self.extinction.lerp_to(&o.extinction, t),
        }
    }
}

/// Ray-marched volumetric fog with light shafts: `VolumetricFog` on the camera, one
/// `FogVolume` box, `VolumetricLight` on the sun. Expensive: tier `volumetric_fog`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct VolumetricLook {
    pub enabled: bool,
    pub density: f32,
    pub color: Rgb,
    pub absorption: f32,
    pub scattering: f32,
    /// Henyey-Greenstein g: > 0 scatters forward (bright shafts looking into the sun).
    pub asymmetry: f32,
    pub light_intensity: f32,
    pub ambient_intensity: f32,
    /// Box size (metres) and centre of the fog volume. Keep it as small as the effect needs:
    /// sun shafts fade with the box's radius and the box dims what is behind it.
    pub size: [f32; 3],
    pub center: [f32; 3],
    /// Keep the box centred on the camera (x/z) every frame.
    pub follow_camera: bool,
    /// Shafts from the sun (`VolumetricLight` on it).
    pub sun_shafts: bool,
}

impl Default for VolumetricLook {
    fn default() -> Self {
        VolumetricLook {
            enabled: false,
            density: 0.04,
            color: Rgb::WHITE,
            // Low absorption: Bevy dims the sun inside the box by exp(-density × box radius ×
            // (absorption + scattering)), so big boxes need thin, mostly-scattering fog.
            absorption: 0.05,
            scattering: 0.3,
            asymmetry: 0.6,
            light_intensity: 1.0,
            ambient_intensity: 0.1,
            size: [80.0, 24.0, 80.0],
            center: [0.0, 8.0, 0.0],
            follow_camera: true,
            sun_shafts: true,
        }
    }
}

lerp_fields!(VolumetricLook {
    enabled,
    density,
    color,
    absorption,
    scattering,
    asymmetry,
    light_intensity,
    ambient_intensity,
    size,
    center,
    follow_camera,
    sun_shafts
});

/// Camera exposure: manual EV100, or histogram auto exposure (tier `auto_exposure`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ExposureLook {
    /// Manual exposure (also the base auto exposure adapts around). Sunny 15, overcast 12,
    /// indoor 7, night ≈ 0.
    pub ev100: f32,
    pub auto: bool,
    /// Auto exposure EV range relative to `ev100`.
    pub auto_min: f32,
    pub auto_max: f32,
    /// EV per second.
    pub speed_brighten: f32,
    pub speed_darken: f32,
    /// Auto exposure target offset in EV (auto exposure aims the scene average at 1.0 before
    /// tonemapping; −1 is a little darker, closer to mid-grey).
    pub compensation: f32,
}

impl Default for ExposureLook {
    fn default() -> Self {
        ExposureLook { ev100: 14.0, auto: false, auto_min: -4.0, auto_max: 4.0, speed_brighten: 3.0, speed_darken: 1.0, compensation: -1.0 }
    }
}

lerp_fields!(ExposureLook { ev100, auto, auto_min, auto_max, speed_brighten, speed_darken, compensation });

/// Tonemapping operator (Bevy's `Tonemapping`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToneMap {
    None,
    Reinhard,
    ReinhardLuminance,
    AcesFitted,
    #[default]
    Agx,
    SomewhatBoringDisplayTransform,
    TonyMcMapface,
    BlenderFilmic,
    KhronosPbrNeutral,
}

impl ToneMap {
    pub const ALL: [ToneMap; 9] = [
        ToneMap::None,
        ToneMap::Reinhard,
        ToneMap::ReinhardLuminance,
        ToneMap::AcesFitted,
        ToneMap::Agx,
        ToneMap::SomewhatBoringDisplayTransform,
        ToneMap::TonyMcMapface,
        ToneMap::BlenderFilmic,
        ToneMap::KhronosPbrNeutral,
    ];
}

/// One tonal range of the colour grade (Bevy's `ColorGradingSection`).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GradeSection {
    pub saturation: f32,
    pub contrast: f32,
    pub gamma: f32,
    pub gain: f32,
    pub lift: f32,
}

impl Default for GradeSection {
    fn default() -> Self {
        GradeSection { saturation: 1.0, contrast: 1.0, gamma: 1.0, gain: 1.0, lift: 0.0 }
    }
}

lerp_fields!(GradeSection { saturation, contrast, gamma, gain, lift });

/// Colour grading (Bevy's `ColorGrading`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GradingLook {
    /// Extra exposure in EV after everything else.
    pub exposure: f32,
    /// White balance: > 0 warmer, < 0 cooler.
    pub temperature: f32,
    /// Green (< 0) ↔ magenta (> 0).
    pub tint: f32,
    pub hue: f32,
    pub post_saturation: f32,
    pub shadows: GradeSection,
    pub midtones: GradeSection,
    pub highlights: GradeSection,
}

impl Default for GradingLook {
    fn default() -> Self {
        GradingLook {
            exposure: 0.0,
            temperature: 0.0,
            tint: 0.0,
            hue: 0.0,
            post_saturation: 1.0,
            shadows: GradeSection::default(),
            midtones: GradeSection::default(),
            highlights: GradeSection::default(),
        }
    }
}

lerp_fields!(GradingLook { exposure, temperature, tint, hue, post_saturation, shadows, midtones, highlights });

/// Bloom tuning; whether bloom is on at all is the tier's `bloom`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BloomLook {
    pub intensity: f32,
    pub low_frequency_boost: f32,
    pub low_frequency_boost_curvature: f32,
    pub high_pass_frequency: f32,
    /// Prefilter threshold (0 = physically based, everything blooms a little).
    pub threshold: f32,
    pub threshold_softness: f32,
    /// Additive (stylised glow) instead of energy-conserving.
    pub additive: bool,
}

impl Default for BloomLook {
    fn default() -> Self {
        BloomLook {
            intensity: 0.12,
            low_frequency_boost: 0.7,
            low_frequency_boost_curvature: 0.95,
            high_pass_frequency: 1.0,
            threshold: 0.0,
            threshold_softness: 0.0,
            additive: false,
        }
    }
}

lerp_fields!(BloomLook { intensity, low_frequency_boost, low_frequency_boost_curvature, high_pass_frequency, threshold, threshold_softness, additive });

/// Depth of field (tier `camera_fx`; bokeh mode on tier `bokeh`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DofLook {
    pub enabled: bool,
    pub focal_distance: f32,
    pub aperture_f_stops: f32,
    /// Max blur diameter in pixels.
    pub max_blur_px: f32,
}

impl Default for DofLook {
    fn default() -> Self {
        DofLook { enabled: false, focal_distance: 8.0, aperture_f_stops: 2.8, max_blur_px: 48.0 }
    }
}

lerp_fields!(DofLook { enabled, focal_distance, aperture_f_stops, max_blur_px });

/// Per-object motion blur (tier `camera_fx`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MotionBlurLook {
    pub enabled: bool,
    /// 0.5 = 180° shutter (film look).
    pub shutter_angle: f32,
    pub samples: u32,
}

impl Default for MotionBlurLook {
    fn default() -> Self {
        MotionBlurLook { enabled: false, shutter_angle: 0.5, samples: 2 }
    }
}

lerp_fields!(MotionBlurLook { enabled, shutter_angle, samples });

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct VignetteLook {
    /// 0 = off.
    pub intensity: f32,
    pub radius: f32,
    pub smoothness: f32,
    pub color: Rgb,
}

impl Default for VignetteLook {
    fn default() -> Self {
        VignetteLook { intensity: 0.0, radius: 0.75, smoothness: 3.0, color: Rgb::BLACK }
    }
}

lerp_fields!(VignetteLook { intensity, radius, smoothness, color });

/// Lens and camera effects; all opt-in (off in every preset except where noted).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct LensLook {
    pub dof: DofLook,
    pub motion_blur: MotionBlurLook,
    /// Chromatic aberration strength (0 = off; 0.01–0.03 is subtle). Tier `post_fx`.
    pub chromatic_aberration: f32,
    pub vignette: VignetteLook,
    /// Barrel (> 0) / pincushion (< 0) distortion (0 = off). Tier `post_fx`.
    pub distortion: f32,
    /// Animated film grain strength (0 = off; 0.03–0.08 is film-like). Tier `post_fx`.
    pub film_grain: f32,
}

lerp_fields!(LensLook { dof, motion_blur, chromatic_aberration, vignette, distortion, film_grain });

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blend_endpoints_and_midpoint() {
        let (a, b) = (Look::clear_day(), Look::night());
        assert_eq!(a.blend(&b, 0.0), a);
        assert_eq!(a.blend(&b, 1.0).sun, b.sun);
        let m = a.blend(&b, 0.5);
        let ev = (a.exposure.ev100 + b.exposure.ev100) * 0.5;
        assert!((m.exposure.ev100 - ev).abs() < 1e-4);
        // Illuminance blends geometrically.
        let lux = (a.sun.illuminance * b.sun.illuminance).sqrt();
        assert!((m.sun.illuminance - lux).abs() / lux < 1e-3);
    }

    #[test]
    fn azimuth_takes_short_way() {
        let a = SunLook { azimuth_deg: 350.0, ..default() };
        let b = SunLook { azimuth_deg: 10.0, ..default() };
        assert!((a.lerp_to(&b, 0.5).azimuth_deg - 0.0).abs() < 1e-3 || (a.lerp_to(&b, 0.5).azimuth_deg - 360.0).abs() < 1e-3);
    }

    #[test]
    fn sun_direction_points_down_for_positive_elevation() {
        let s = SunLook { azimuth_deg: 90.0, elevation_deg: 30.0, ..default() };
        let d = s.direction();
        assert!(d.y < -0.49 && d.y > -0.51);
        assert!(d.x < -0.8, "sun in the east shines towards -X: {d}");
    }

    #[test]
    fn json_patch_merges_and_rejects_typos() {
        let l = Look::clear_day();
        let p = l.patched(&serde_json::json!({"fog": {"visibility": 99.0}, "tonemapping": "aces_fitted"})).unwrap();
        assert_eq!(p.fog.visibility, 99.0);
        assert_eq!(p.fog.color, l.fog.color);
        assert_eq!(p.tonemapping, ToneMap::AcesFitted);
        assert!(l.patched(&serde_json::json!({"fog": {"visibilty": 1.0}})).is_err());
        // Round trip.
        let s = serde_json::to_string(&l).unwrap();
        assert_eq!(serde_json::from_str::<Look>(&s).unwrap(), l);
    }

    #[test]
    fn rgb_linear_round_trip() {
        let c = Rgb::new(0.2, 0.5, 0.9);
        let r = Rgb::from_linear(c.linear());
        for i in 0..3 {
            assert!((r.0[i] - c.0[i]).abs() < 1e-4);
        }
    }
}
