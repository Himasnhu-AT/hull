//! Named rendering features and how to switch them at runtime (`look.feature`): each is a
//! per-tier flag of [`QualityPreset`] (what the tier allows) and, for look-driven effects, an
//! enable flag in the [`Look`] (what the scene asks for). A feature is active when both agree.

use crate::gfx::QualityPreset;

use super::desc::Look;

/// Every feature `look.feature` knows, cheapest first.
pub const FEATURES: [&str; 16] = [
    "fog",
    "film_grain",
    "bloom",
    "taa",
    "post_fx",
    "env_light",
    "auto_exposure",
    "contact_shadows",
    "ssao",
    "volumetric",
    "dof",
    "motion_blur",
    "ssr",
    "soft_shadows",
    "atmosphere",
    "shadows",
];

/// The tier flag array of a feature (None: the feature is look-only).
pub fn tier_slot<'a>(p: &'a mut QualityPreset, name: &str) -> Option<&'a mut [bool; 4]> {
    Some(match name {
        "bloom" => &mut p.bloom,
        "taa" => &mut p.taa,
        "post_fx" | "vignette" | "chromatic_aberration" | "film_grain" => &mut p.post_fx,
        "env_light" => &mut p.env_light,
        "auto_exposure" => &mut p.auto_exposure,
        "contact_shadows" => &mut p.contact_shadows,
        "ssao" => &mut p.ssao,
        "volumetric" => &mut p.volumetric_fog,
        "dof" | "motion_blur" | "camera_fx" => &mut p.camera_fx,
        "ssr" => &mut p.ssr,
        "soft_shadows" => &mut p.soft_shadows,
        _ => return None,
    })
}

/// Whether the look asks for a feature (None: tier-only feature).
pub fn look_wants(l: &Look, name: &str) -> Option<bool> {
    use super::desc::{FogMode, SkyMode};
    Some(match name {
        "fog" => l.fog.mode != FogMode::Off,
        "volumetric" => l.volumetric.enabled,
        "dof" => l.lens.dof.enabled,
        "motion_blur" => l.lens.motion_blur.enabled,
        "auto_exposure" => l.exposure.auto,
        "post_fx" => l.lens.vignette.intensity > 0.0 || l.lens.chromatic_aberration > 0.0 || l.lens.distortion != 0.0 || l.lens.film_grain > 0.0,
        "film_grain" => l.lens.film_grain > 0.0,
        "vignette" => l.lens.vignette.intensity > 0.0,
        "chromatic_aberration" => l.lens.chromatic_aberration > 0.0,
        "env_light" => l.ambient.env_intensity > 0.0,
        "atmosphere" => l.sky.mode == SkyMode::Atmosphere,
        "shadows" => l.sun.shadows,
        _ => return None,
    })
}

/// Sets the look's side of a feature. Turning on an effect whose strength is 0 gives it a
/// modest default strength.
pub fn set_look(l: &mut Look, name: &str, on: bool) {
    use super::desc::{FogMode, SkyMode};
    match name {
        "fog" => {
            l.fog.mode = match (on, l.fog.mode) {
                (false, _) => FogMode::Off,
                (true, FogMode::Off) => FogMode::Atmospheric,
                (true, m) => m,
            }
        }
        "volumetric" => l.volumetric.enabled = on,
        "dof" => l.lens.dof.enabled = on,
        "motion_blur" => l.lens.motion_blur.enabled = on,
        "auto_exposure" => l.exposure.auto = on,
        "vignette" | "post_fx" | "chromatic_aberration" => {
            let (v, ca) = (name != "chromatic_aberration", name != "vignette");
            if v {
                l.lens.vignette.intensity = if on { l.lens.vignette.intensity.max(0.3) } else { 0.0 };
            }
            if ca {
                l.lens.chromatic_aberration = if on { l.lens.chromatic_aberration.max(0.015) } else { 0.0 };
            }
            if !on && name == "post_fx" {
                l.lens.distortion = 0.0;
                l.lens.film_grain = 0.0;
            }
        }
        "film_grain" => l.lens.film_grain = if on { l.lens.film_grain.max(0.05) } else { 0.0 },
        "env_light" => l.ambient.env_intensity = if on { l.ambient.env_intensity.max(1.0) } else { 0.0 },
        "atmosphere" => {
            l.sky.mode = match (on, l.sky.mode) {
                (true, _) => SkyMode::Atmosphere,
                (false, SkyMode::Atmosphere) => SkyMode::Gradient,
                (false, m) => m,
            }
        }
        "shadows" => l.sun.shadows = on,
        _ => {}
    }
}

/// `look.feature` semantics: set the current tier's flag and the look's flag.
/// Returns false for an unknown name.
pub fn set_feature(p: &mut QualityPreset, tier: usize, l: &mut Look, name: &str, on: bool) -> bool {
    let tiered = tier_slot(p, name).map(|s| s[tier.min(3)] = on).is_some();
    let looked = look_wants(l, name).is_some();
    if looked {
        set_look(l, name, on);
    }
    tiered || looked
}
