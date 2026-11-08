//! Sun, moon and sidereal time from a latitude, a day of the year and a local solar clock.
//!
//! Low-precision formulas (a degree or so): enough for light, shadows and a believable sky. The
//! clock is *local solar time shifted by `solar_noon`*: the sun crosses the meridian at the clock
//! hour `solar_noon` (12 with no time-zone / summer-time shift). Compass azimuths: 0 = north
//! (-Z), 90 = east (+X); elevations in degrees.

use bevy::prelude::*;

/// Mean synodic month (days).
pub const SYNODIC_DAYS: f32 = 29.530_588;
const OBLIQUITY: f32 = 23.439_3;

/// Sun ecliptic longitude (degrees) on day-of-year `day` (0 = 1 January; fractions allowed).
pub fn sun_longitude(day: f32) -> f32 {
    let g = (357.528 + 0.985_600_3 * day).to_radians();
    (280.46 + 0.985_647_4 * day + 1.915 * g.sin() + 0.02 * (2.0 * g).sin()).rem_euclid(360.0)
}

/// (right ascension, declination) in radians of the point on the ecliptic at longitude `lon` degrees.
fn equatorial(lon: f32) -> (f32, f32) {
    let (l, e) = (lon.to_radians(), OBLIQUITY.to_radians());
    ((e.cos() * l.sin()).atan2(l.cos()), (e.sin() * l.sin()).asin())
}

/// Azimuth (degrees from north, clockwise) and elevation (degrees) of a body with hour angle
/// `h` and declination `dec` (radians) seen from latitude `lat_deg`.
fn horizontal(lat_deg: f32, h: f32, dec: f32) -> (f32, f32) {
    let lat = lat_deg.to_radians();
    let sin_el = lat.sin() * dec.sin() + lat.cos() * dec.cos() * h.cos();
    let el = sin_el.clamp(-1.0, 1.0).asin();
    let az = h.sin().atan2(h.cos() * lat.sin() - dec.tan() * lat.cos());
    ((az.to_degrees() + 180.0).rem_euclid(360.0), el.to_degrees())
}

/// Sun (azimuth, elevation) at clock `hours` on `day`. Solar noon is at clock hour `solar_noon`.
pub fn sun(lat_deg: f32, day: f32, hours: f32, solar_noon: f32) -> (f32, f32) {
    let (_, dec) = equatorial(sun_longitude(day + hours / 24.0));
    horizontal(lat_deg, (15.0 * (hours - solar_noon)).to_radians(), dec)
}

/// Moon state: position, lit fraction and phase angle (radians, 0 = full).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MoonState {
    pub azimuth: f32,
    pub elevation: f32,
    /// 0 new .. 1 full.
    pub illumination: f32,
    /// Sun-moon-observer angle: 0 = full, pi = new.
    pub phase_angle: f32,
    /// Age in days since the new moon, `0..SYNODIC_DAYS`.
    pub age: f32,
}

/// The moon at clock `hours` on `day`. `new_moon_day` is a day-of-year with a new moon (the
/// phase cycle runs from it, 29.53 days at a time).
pub fn moon(lat_deg: f32, day: f32, hours: f32, solar_noon: f32, new_moon_day: f32) -> MoonState {
    let t = day + hours / 24.0;
    let age = (t - new_moon_day).rem_euclid(SYNODIC_DAYS);
    let elong = age / SYNODIC_DAYS * 360.0;
    let sun_lon = sun_longitude(t);
    let (ra_s, _) = equatorial(sun_lon);
    let (ra_m, dec_m) = equatorial(sun_lon + elong);
    // Local sidereal angle = the sun's right ascension + its hour angle.
    let lst = ra_s + (15.0 * (hours - solar_noon)).to_radians();
    let (azimuth, elevation) = horizontal(lat_deg, lst - ra_m, dec_m);
    let e = elong.to_radians();
    MoonState { azimuth, elevation, illumination: (1.0 - e.cos()) * 0.5, phase_angle: std::f32::consts::PI - e.rem_euclid(std::f32::consts::TAU), age }
}

/// Local sidereal angle (radians): how far the star sphere has turned. Drives the star field.
pub fn sidereal(day: f32, hours: f32, solar_noon: f32) -> f32 {
    let (ra_s, _) = equatorial(sun_longitude(day + hours / 24.0));
    (ra_s + (15.0 * (hours - solar_noon)).to_radians()).rem_euclid(std::f32::consts::TAU)
}

/// World direction towards a body at compass azimuth / elevation (degrees); north is -Z.
pub fn to_dir(azimuth: f32, elevation: f32) -> Vec3 {
    let (az, el) = (azimuth.to_radians(), elevation.to_radians());
    Vec3::new(el.cos() * az.sin(), el.sin(), -el.cos() * az.cos())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sun_follows_the_day() {
        // 21 May (day 140) at 46 N, solar noon at 13:00: south, ~64 degrees up.
        let (az, el) = sun(46.0, 140.0, 13.0, 13.0);
        assert!((az - 180.0).abs() < 0.5, "noon az {az}");
        assert!((el - 64.0).abs() < 1.5, "noon el {el}");
        assert!((60.0..120.0).contains(&sun(46.0, 140.0, 7.0, 13.0).0));
        assert!((240.0..300.0).contains(&sun(46.0, 140.0, 19.0, 13.0).0));
        assert!(sun(46.0, 140.0, 5.0, 13.0).1 < 0.0 && sun(46.0, 140.0, 6.0, 13.0).1 > 0.0);
        assert!(sun(46.0, 140.0, 23.0, 13.0).1 < -15.0);
    }

    #[test]
    fn seasons_and_latitude_move_the_noon_sun() {
        let noon = |lat, day| sun(lat, day, 12.0, 12.0).1;
        assert!(noon(46.0, 172.0) > noon(46.0, 355.0) + 40.0, "summer {} winter {}", noon(46.0, 172.0), noon(46.0, 355.0));
        assert!(noon(0.0, 80.0) > 85.0, "equator at the equinox: {}", noon(0.0, 80.0));
        // Southern hemisphere: noon sun is to the north.
        let (az, _) = sun(-35.0, 355.0, 12.0, 12.0);
        assert!(az < 30.0 || az > 330.0, "{az}");
    }

    #[test]
    fn moon_phases() {
        // New moon: lit 0, near the sun's place in the sky.
        let n = moon(46.0, 100.0, 12.0, 12.0, 100.0);
        assert!(n.illumination < 0.01 && n.phase_angle > 3.0);
        let s = sun(46.0, 100.0, 12.0, 12.0);
        assert!((n.elevation - s.1).abs() < 3.0, "{} vs {}", n.elevation, s.1);
        // Full moon, a fortnight on: opposite the sun, up at midnight.
        let f = moon(46.0, 100.0 + SYNODIC_DAYS / 2.0 - 0.5, 24.0, 12.0, 100.0);
        assert!(f.illumination > 0.98 && f.phase_angle.abs() < 0.2, "{f:?}");
        assert!(f.elevation > 10.0, "full moon at midnight {f:?}");
        // The moon rises later each day (about 50 minutes): same hour, different place.
        let a = moon(46.0, 120.0, 22.0, 12.0, 100.0);
        let b = moon(46.0, 121.0, 22.0, 12.0, 100.0);
        assert!((a.azimuth - b.azimuth).abs() > 3.0 || (a.elevation - b.elevation).abs() > 3.0);
    }

    #[test]
    fn sidereal_time_turns_about_once_a_day() {
        let a = sidereal(10.0, 0.0, 12.0);
        let b = sidereal(10.0, 24.0, 12.0);
        let turn = (b - a).rem_euclid(std::f32::consts::TAU);
        // 24 clock hours is one turn plus ~1 degree (the sun's own drift).
        assert!(turn < 0.03 || turn > std::f32::consts::TAU - 0.03, "{turn}");
    }

    #[test]
    fn directions() {
        assert!((to_dir(0.0, 0.0) - Vec3::NEG_Z).length() < 1e-5);
        assert!((to_dir(90.0, 0.0) - Vec3::X).length() < 1e-5);
        assert!((to_dir(0.0, 90.0) - Vec3::Y).length() < 1e-5);
    }
}
