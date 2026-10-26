//! Ready-made looks. Each is plain data: copy one and change fields
//! (`Look { fog: FogLook { visibility: 300.0, ..Look::dusk().fog }, ..Look::dusk() }`).

use super::desc::*;

impl Look {
    /// Names accepted by [`Look::preset`] (and `look.set {preset}`).
    pub const PRESETS: [&'static str; 5] = ["clear_day", "overcast", "dusk", "night", "indoor"];

    pub fn preset(name: &str) -> Option<Look> {
        Some(match name {
            "clear_day" | "day" | "default" => Look::clear_day(),
            "overcast" => Look::overcast(),
            "dusk" | "sunset" => Look::dusk(),
            "night" => Look::night(),
            "indoor" | "interior" => Look::indoor(),
            _ => return None,
        })
    }

    /// High sun, atmosphere sky, light haze.
    pub fn clear_day() -> Look {
        Look {
            name: "clear_day".into(),
            sun: SunLook::default(),
            sky: SkyLook::default(),
            ambient: AmbientLook { color: Rgb::new(0.75, 0.82, 1.0), brightness: 1500.0, env_intensity: 1.0 },
            fog: FogLook::default(),
            volumetric: VolumetricLook { density: 0.015, ..VolumetricLook::default() },
            exposure: ExposureLook { ev100: 14.0, ..ExposureLook::default() },
            tonemapping: ToneMap::Agx,
            grading: GradingLook {
                post_saturation: 1.08,
                midtones: GradeSection { contrast: 1.05, ..GradeSection::default() },
                ..GradingLook::default()
            },
            bloom: BloomLook::default(),
            lens: LensLook::default(),
        }
    }

    /// Grey sky, soft weak sun, short visibility, muted colours.
    pub fn overcast() -> Look {
        Look {
            name: "overcast".into(),
            sun: SunLook {
                azimuth_deg: 160.0,
                elevation_deg: 60.0,
                illuminance: 12_000.0,
                color: Rgb::new(0.92, 0.94, 1.0),
                disk_intensity: 0.0,
                ..SunLook::default()
            },
            sky: SkyLook {
                mode: SkyMode::Gradient,
                zenith: Rgb::new(0.62, 0.65, 0.7),
                horizon: Rgb::new(0.78, 0.8, 0.82),
                ground: Rgb::new(0.3, 0.3, 0.3),
                brightness: 3500.0,
                sun_glow: 0.15,
                ..SkyLook::default()
            },
            ambient: AmbientLook { color: Rgb::new(0.85, 0.88, 0.92), brightness: 1200.0, env_intensity: 1.0 },
            fog: FogLook {
                mode: FogMode::Exponential,
                color: Rgb::new(0.7, 0.72, 0.75),
                sun_amount: 0.0,
                visibility: 450.0,
                ..FogLook::default()
            },
            volumetric: VolumetricLook { density: 0.02, asymmetry: 0.2, ..VolumetricLook::default() },
            exposure: ExposureLook { ev100: 12.0, ..ExposureLook::default() },
            tonemapping: ToneMap::Agx,
            grading: GradingLook {
                post_saturation: 0.85,
                temperature: -0.05,
                ..GradingLook::default()
            },
            bloom: BloomLook { intensity: 0.08, ..BloomLook::default() },
            lens: LensLook::default(),
        }
    }

    /// Sun on the horizon, warm haze, long shadows, stronger bloom.
    pub fn dusk() -> Look {
        Look {
            name: "dusk".into(),
            sun: SunLook {
                azimuth_deg: 255.0,
                elevation_deg: 6.0,
                illuminance: 25_000.0,
                color: Rgb::new(1.0, 0.62, 0.36),
                shadow_distance: 150.0,
                ..SunLook::default()
            },
            sky: SkyLook {
                zenith: Rgb::new(0.18, 0.22, 0.42),
                horizon: Rgb::new(0.98, 0.58, 0.32),
                ground: Rgb::new(0.18, 0.13, 0.11),
                brightness: 1200.0,
                sun_glow: 2.0,
                ..SkyLook::default()
            },
            ambient: AmbientLook { color: Rgb::new(0.6, 0.6, 0.85), brightness: 400.0, env_intensity: 1.0 },
            fog: FogLook {
                color: Rgb::new(0.72, 0.52, 0.42),
                sun_color: Rgb::new(1.0, 0.6, 0.3),
                sun_amount: 0.8,
                sun_exponent: 12.0,
                visibility: 900.0,
                extinction: Rgb::new(0.5, 0.42, 0.4),
                ..FogLook::default()
            },
            volumetric: VolumetricLook { density: 0.03, color: Rgb::new(1.0, 0.85, 0.7), asymmetry: 0.75, ..VolumetricLook::default() },
            exposure: ExposureLook { ev100: 11.0, ..ExposureLook::default() },
            tonemapping: ToneMap::Agx,
            grading: GradingLook {
                temperature: 0.12,
                post_saturation: 1.12,
                shadows: GradeSection { lift: 0.01, ..GradeSection::default() },
                ..GradingLook::default()
            },
            bloom: BloomLook { intensity: 0.2, ..BloomLook::default() },
            lens: LensLook { vignette: VignetteLook { intensity: 0.25, ..VignetteLook::default() }, ..LensLook::default() },
        }
    }

    /// Moonlight (a dim blue "sun"), gradient sky with stars, emissives carry the scene.
    pub fn night() -> Look {
        Look {
            name: "night".into(),
            sun: SunLook {
                azimuth_deg: 200.0,
                elevation_deg: 38.0,
                illuminance: 0.6,
                color: Rgb::new(0.62, 0.72, 1.0),
                disk_intensity: 0.0,
                ..SunLook::default()
            },
            sky: SkyLook {
                mode: SkyMode::Gradient,
                zenith: Rgb::new(0.004, 0.008, 0.03),
                horizon: Rgb::new(0.02, 0.03, 0.07),
                ground: Rgb::new(0.004, 0.004, 0.006),
                brightness: 2.0,
                sun_glow: 0.1,
                stars: 1.0,
                ..SkyLook::default()
            },
            ambient: AmbientLook { color: Rgb::new(0.45, 0.55, 1.0), brightness: 0.02, env_intensity: 1.0 },
            fog: FogLook {
                mode: FogMode::Exponential,
                color: Rgb::new(0.015, 0.02, 0.04),
                sun_color: Rgb::new(0.2, 0.25, 0.4),
                sun_amount: 0.2,
                visibility: 350.0,
                ..FogLook::default()
            },
            volumetric: VolumetricLook { density: 0.03, ambient_intensity: 0.0, ..VolumetricLook::default() },
            exposure: ExposureLook { ev100: -1.0, ..ExposureLook::default() },
            tonemapping: ToneMap::Agx,
            grading: GradingLook {
                temperature: -0.08,
                post_saturation: 0.8,
                ..GradingLook::default()
            },
            bloom: BloomLook { intensity: 0.28, ..BloomLook::default() },
            lens: LensLook { vignette: VignetteLook { intensity: 0.35, ..VignetteLook::default() }, ..LensLook::default() },
        }
    }

    /// Interior: exposure for lamp light (the outside blows out through windows), warm
    /// ambient, dusty sun shafts where volumetrics are on.
    pub fn indoor() -> Look {
        Look {
            name: "indoor".into(),
            sun: SunLook {
                azimuth_deg: 120.0,
                elevation_deg: 32.0,
                illuminance: 50_000.0,
                color: Rgb::new(1.0, 0.92, 0.8),
                shadow_distance: 50.0,
                first_cascade: 5.0,
                ..SunLook::default()
            },
            sky: SkyLook { mode: SkyMode::Gradient, brightness: 4000.0, ..SkyLook::default() },
            ambient: AmbientLook { color: Rgb::new(1.0, 0.85, 0.7), brightness: 40.0, env_intensity: 0.25 },
            fog: FogLook { mode: FogMode::Off, ..FogLook::default() },
            volumetric: VolumetricLook {
                enabled: true,
                density: 0.08,
                color: Rgb::new(1.0, 0.95, 0.85),
                scattering: 0.8,
                absorption: 0.02,
                asymmetry: 0.7,
                ambient_intensity: 0.02,
                light_intensity: 3.0,
                size: [24.0, 8.0, 24.0],
                center: [0.0, 4.0, 0.0],
                ..VolumetricLook::default()
            },
            exposure: ExposureLook { ev100: 10.5, ..ExposureLook::default() },
            tonemapping: ToneMap::Agx,
            grading: GradingLook {
                temperature: 0.06,
                ..GradingLook::default()
            },
            bloom: BloomLook { intensity: 0.15, ..BloomLook::default() },
            lens: LensLook::default(),
        }
    }
}
