//! The day as data: keyframes by **sun elevation** (so they hold at any latitude and season),
//! the light the sun / moon give, and the [`Look`] built from both.

use bevy::prelude::*;
use serde::{Deserialize, Serialize};

use super::astro::MoonState;
use super::{DayConfig, DayWeather};
use crate::look::desc::log_lerp;
use crate::look::{ExposureLook, FogMode, Look, Rgb};

/// One key of the day. Everything is a look quantity at a sun elevation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DayKey {
    /// Sun elevation (degrees) this key applies at.
    pub sun_el: f32,
    /// Base EV100.
    pub ev: f32,
    /// Haze: fog visibility (m), the colour of the far horizon after exposure (display
    /// referred) and the haze colour towards the sun.
    pub vis: f32,
    pub haze: [f32; 3],
    pub glow: [f32; 3],
    /// Flat fill light (cd/m2) and its colour.
    pub amb: f32,
    pub amb_col: [f32; 3],
    /// Cloud coverage 0..1.
    pub cover: f32,
}

impl Default for DayKey {
    fn default() -> Self {
        DayKey { sun_el: 45.0, ev: 14.0, vis: 8000.0, haze: [0.72, 0.78, 0.88], glow: [1.0, 0.94, 0.84], amb: 550.0, amb_col: [0.78, 0.83, 1.0], cover: 0.5 }
    }
}

/// Keys sorted by `sun_el` ascending. Outside the range the end keys hold.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DayKeys(pub Vec<DayKey>);

impl Default for DayKeys {
    /// A temperate clear day: night, blue hour, dawn / dusk glow, low gold sun, morning,
    /// noon (tuned on a rally game; tweak per game).
    fn default() -> Self {
        let k = |sun_el, ev, vis, haze, glow, amb, amb_col, cover| DayKey { sun_el, ev, vis, haze, glow, amb, amb_col, cover };
        DayKeys(vec![
            k(-14.0, 1.6, 1600.0, [0.022, 0.028, 0.045], [0.05, 0.06, 0.09], 0.3, [0.45, 0.55, 1.0], 0.3),
            k(-7.5, 3.6, 2000.0, [0.06, 0.065, 0.1], [0.16, 0.12, 0.13], 2.0, [0.5, 0.58, 0.95], 0.35),
            k(-3.5, 7.6, 3000.0, [0.3, 0.3, 0.38], [0.7, 0.5, 0.4], 40.0, [0.55, 0.62, 0.9], 0.35),
            k(-1.0, 8.8, 3000.0, [0.38, 0.36, 0.44], [0.8, 0.52, 0.4], 70.0, [0.55, 0.6, 0.95], 0.35),
            k(3.7, 10.5, 4000.0, [0.72, 0.66, 0.65], [1.0, 0.7, 0.47], 145.0, [0.64, 0.69, 0.95], 0.3),
            k(8.5, 11.6, 5000.0, [0.74, 0.74, 0.76], [1.0, 0.82, 0.62], 230.0, [0.7, 0.74, 0.95], 0.28),
            k(13.5, 12.4, 5500.0, [0.76, 0.74, 0.74], [1.0, 0.8, 0.58], 300.0, [0.68, 0.72, 0.95], 0.45),
            k(34.0, 13.6, 8000.0, [0.7, 0.77, 0.88], [1.0, 0.94, 0.82], 450.0, [0.75, 0.82, 1.0], 0.42),
            k(45.0, 14.1, 8000.0, [0.72, 0.78, 0.88], [1.0, 0.94, 0.84], 550.0, [0.78, 0.83, 1.0], 0.55),
            k(60.0, 14.4, 9000.0, [0.72, 0.79, 0.9], [1.0, 0.96, 0.88], 600.0, [0.78, 0.84, 1.0], 0.55),
        ])
    }
}

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

impl DayKeys {
    /// The keys blended at sun elevation `el` (fill light and visibility in log space, the rest
    /// linearly, eased so nothing kinks at a key).
    pub fn sample(&self, el: f32) -> DayKey {
        let ks = &self.0;
        let (Some(first), Some(last)) = (ks.first(), ks.last()) else { return DayKey::default() };
        if el <= first.sun_el {
            return DayKey { sun_el: el, ..first.clone() };
        }
        if el >= last.sun_el {
            return DayKey { sun_el: el, ..last.clone() };
        }
        let i = ks.iter().rposition(|k| k.sun_el <= el).unwrap_or(0);
        let (a, b) = (&ks[i], &ks[i + 1]);
        let t = ((el - a.sun_el) / (b.sun_el - a.sun_el).max(1e-3)).clamp(0.0, 1.0);
        let t = t * t * (3.0 - 2.0 * t);
        let ll = |x: f32, y: f32| log_lerp(x.max(1e-4), y.max(1e-4), t);
        DayKey {
            sun_el: el,
            ev: a.ev + (b.ev - a.ev) * t,
            vis: ll(a.vis, b.vis),
            haze: lerp3(a.haze, b.haze, t),
            glow: lerp3(a.glow, b.glow, t),
            amb: ll(a.amb, b.amb),
            amb_col: lerp3(a.amb_col, b.amb_col, t),
            cover: a.cover + (b.cover - a.cover) * t,
        }
    }
}

/// What the directional light is doing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Light {
    pub azimuth: f32,
    pub elevation: f32,
    /// Lux to give the engine (before its below-horizon fade), above the atmosphere.
    pub lux: f32,
    pub color: [f32; 3],
    /// 1 when the light is the moon.
    pub moon: f32,
}

/// The directional light for a sun at (`az`, `el`) and the moon: the raw sun, held at the
/// horizon and dimmed through twilight, then the moon (steady, so night stays playable).
pub fn light_at(cfg: &DayConfig, az: f32, el: f32, moon: &MoonState) -> Light {
    if el <= cfg.moon_from {
        let m = ((cfg.moon_from - el) / 3.0).clamp(0.0, 1.0);
        let phase = cfg.moon_phase_dim + (1.0 - cfg.moon_phase_dim) * moon.illumination;
        let (azimuth, elevation, above) = if cfg.moon_follows {
            let ab = ((moon.elevation + 5.0) / 13.0).clamp(0.0, 1.0);
            (moon.azimuth, moon.elevation.max(cfg.moon_min_elevation), cfg.moon_floor + (1.0 - cfg.moon_floor) * ab)
        } else {
            ((az + 180.0).rem_euclid(360.0), 35.0, 1.0)
        };
        return Light { azimuth, elevation, lux: (cfg.moon_lux * m * phase * above).max(1e-3), color: cfg.moon_color, moon: 1.0 };
    }
    let lit_el = el.max(cfg.twilight_el);
    let dim = 10f32.powf((el.min(cfg.twilight_el) - cfg.twilight_el) / cfg.twilight_decade);
    // The engine fades the light out from 0 to -3 degrees; give it back so the sky keeps its glow.
    let fade = ((lit_el + 3.0) / 3.0).clamp(0.05, 1.0);
    Light { azimuth: az, elevation: lit_el, lux: cfg.raw_sun * dim / fade, color: cfg.sun_color, moon: 0.0 }
}

/// How built-up cumulus are at local `hours` (0 flat morning puffs .. 1 towering afternoon cells).
pub fn cloud_growth(hours: f32) -> f32 {
    let x = ((hours - 15.0) / 5.0).clamp(-1.0, 1.0);
    (0.15 + 0.85 * (1.0 - x * x)).clamp(0.0, 1.0)
}

/// Cloud coverage 0..1 for the current sun and weather (before the slow wander the cloud layer adds).
pub fn cloud_cover(cfg: &DayConfig, weather: &DayWeather, sun_el: f32) -> f32 {
    let keyed = weather.cover.unwrap_or_else(|| cfg.keys.sample(sun_el).cover);
    keyed + (1.0 - keyed) * weather.overcast.clamp(0.0, 1.0)
}

/// The look for a sun at (`az`, `el`) with the moon, in `weather`: `cfg.base` with its sun,
/// ambient, exposure and fog replaced from the keys. Never switches the sky mode.
pub fn day_look(cfg: &DayConfig, weather: &DayWeather, az: f32, el: f32, moon: &MoonState, name: String) -> Look {
    let k = cfg.keys.sample(el);
    let light = light_at(cfg, az, el, moon);
    let low = light.moon == 0.0 && light.elevation < 8.0;
    let o = weather.overcast.clamp(0.0, 1.0);
    let mut look = cfg.base.clone();
    look.name = name.into();
    look.sun.azimuth_deg = light.azimuth;
    look.sun.elevation_deg = light.elevation;
    look.sun.color = Rgb::new(light.color[0], light.color[1], light.color[2]);
    // Cloud cover thins the direct sun (the light is diffuse; the clouds' own shading shows it).
    look.sun.illuminance = light.lux * (1.0 - 0.8 * o);
    // Moon: a short shadow range; low sun: long shadows waste resolution.
    look.sun.shadow_distance = if light.moon > 0.0 { 60.0 } else if low { 110.0 } else { cfg.base.sun.shadow_distance.max(160.0) };
    look.sun.cascades = if light.moon > 0.0 { 2 } else { cfg.base.sun.cascades.max(4) };
    look.sun.first_cascade = 10.0;
    // The sun's disk sets with it; the moon's is the same disk, dimmer light.
    look.sun.disk_intensity = if light.moon > 0.0 { 1.0 } else { ((el + 1.0) / 2.0).clamp(0.0, 1.0) * (1.0 - o) };
    look.ambient.brightness = k.amb * (1.0 + 0.6 * o);
    look.ambient.color = Rgb::new(k.amb_col[0], k.amb_col[1], k.amb_col[2]);
    look.ambient.env_intensity = if light.moon > 0.0 { 0.8 } else { 1.0 };
    look.exposure = ExposureLook { ev100: k.ev, ..cfg.base.exposure.clone() };
    look.fog.mode = FogMode::Atmospheric;
    look.fog.visibility = (k.vis * cfg.visibility_scale * (1.0 - 0.6 * o)).max(cfg.min_visibility);
    look.fog.color = Rgb::new(k.haze[0], k.haze[1], k.haze[2]);
    look.fog.sun_color = Rgb::new(k.glow[0], k.glow[1], k.glow[2]);
    look.fog.sun_amount = if light.moon > 0.0 { 0.15 } else { 0.55 * (1.0 - o) };
    look
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daytime::astro;

    fn day(cfg: &DayConfig, hours: f32) -> Look {
        let (az, el) = astro::sun(46.0, 140.0, hours, 13.0);
        let moon = astro::moon(46.0, 140.0, hours, 13.0, 130.0);
        day_look(cfg, &DayWeather::default(), az, el, &moon, format!("{hours}"))
    }

    #[test]
    fn keys_blend_and_hold_at_the_ends() {
        let keys = DayKeys::default();
        assert_eq!(keys.sample(-40.0).ev, keys.0[0].ev);
        assert_eq!(keys.sample(90.0).ev, keys.0.last().unwrap().ev);
        let (a, b) = (keys.sample(10.0), keys.sample(20.0));
        assert!(a.ev < b.ev && a.amb < b.amb && a.vis < b.vis);
        // Empty keys fall back to one default key.
        assert_eq!(DayKeys(vec![]).sample(5.0).ev, DayKey::default().ev);
    }

    #[test]
    fn the_day_is_smooth_and_never_switches_the_sky() {
        let cfg = DayConfig::default();
        let mut prev = day(&cfg, 0.0);
        for i in 1..=24 * 60 {
            let l = day(&cfg, i as f32 / 60.0);
            assert_eq!(l.sky.mode, cfg.base.sky.mode);
            assert!((l.exposure.ev100 - prev.exposure.ev100).abs() < 0.25, "ev jump at {}", i as f32 / 60.0);
            assert!(l.ambient.brightness > 0.0 && l.sun.illuminance > 0.0);
            prev = l;
        }
    }

    #[test]
    fn noon_is_bright_midnight_is_moonlit_and_dusk_holds_the_horizon() {
        let cfg = DayConfig::default();
        let noon = day(&cfg, 13.0);
        assert!(noon.sun.illuminance > 50_000.0 && (350.0..=650.0).contains(&noon.ambient.brightness));
        let night = day(&cfg, 1.0);
        assert!(night.sun.illuminance <= cfg.moon_lux * 1.001, "{}", night.sun.illuminance);
        assert_eq!(night.sun.cascades, 2);
        // Twilight: the light stays just under the horizon, dimmed.
        let moon = astro::moon(46.0, 140.0, 21.0, 13.0, 130.0);
        let dusk = light_at(&cfg, 290.0, -6.0, &moon);
        assert_eq!(dusk.elevation, cfg.twilight_el);
        assert_eq!(dusk.moon, 0.0);
        assert!(dusk.lux < cfg.raw_sun);
    }

    #[test]
    fn overcast_dims_the_sun_and_cuts_visibility() {
        let cfg = DayConfig::default();
        let moon = astro::moon(46.0, 140.0, 13.0, 13.0, 130.0);
        let clear = day_look(&cfg, &DayWeather::default(), 180.0, 60.0, &moon, "c".into());
        let grey = day_look(&cfg, &DayWeather { overcast: 1.0, ..default() }, 180.0, 60.0, &moon, "g".into());
        assert!(grey.sun.illuminance < clear.sun.illuminance * 0.3);
        assert!(grey.fog.visibility < clear.fog.visibility);
        assert!(cloud_cover(&cfg, &DayWeather { overcast: 1.0, ..default() }, 60.0) > 0.99);
        assert_eq!(cloud_cover(&cfg, &DayWeather { cover: Some(0.2), ..default() }, 60.0), 0.2);
    }

    #[test]
    fn a_moon_that_follows_dims_when_low_and_with_phase() {
        let cfg = DayConfig { moon_follows: true, ..default() };
        let full = MoonState { azimuth: 100.0, elevation: 50.0, illumination: 1.0, phase_angle: 0.0, age: 14.7 };
        let new = MoonState { illumination: 0.0, ..full };
        let low = MoonState { elevation: -20.0, ..full };
        let a = light_at(&cfg, 0.0, -30.0, &full);
        assert_eq!((a.azimuth, a.elevation), (100.0, 50.0));
        assert!(light_at(&cfg, 0.0, -30.0, &new).lux < a.lux * 0.4);
        let b = light_at(&cfg, 0.0, -30.0, &low);
        assert_eq!(b.elevation, cfg.moon_min_elevation);
        assert!(b.lux < a.lux * 0.5);
    }

    #[test]
    fn keys_round_trip_as_data() {
        let text = serde_json::to_string(&DayKeys::default()).unwrap();
        let back: DayKeys = serde_json::from_str(&text).unwrap();
        assert_eq!(back, DayKeys::default());
    }
}
