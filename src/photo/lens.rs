//! Lens and exposure maths (pure functions, no Bevy state). Lengths in millimetres unless the
//! name says `_m`.

/// Full-frame sensor height (24 mm).
pub const FULL_FRAME_HEIGHT_MM: f32 = 24.0;
/// Bevy's `DepthOfField` assumes a Super 35 sensor of this height unless told otherwise.
pub const BEVY_SENSOR_HEIGHT_MM: f32 = 18.66;

/// Vertical field of view (radians) of a lens of `focal_mm` on a sensor `sensor_height_mm` tall.
pub fn vertical_fov(focal_mm: f32, sensor_height_mm: f32) -> f32 {
    2.0 * (sensor_height_mm / (2.0 * focal_mm.max(0.1))).atan()
}

/// The focal length that gives `fov` (radians) on that sensor.
pub fn focal_for_fov(fov: f32, sensor_height_mm: f32) -> f32 {
    sensor_height_mm / (2.0 * (fov * 0.5).tan())
}

/// Exposure value at ISO 100 (the number `look.exposure.ev100` and Bevy's `Exposure` use).
pub fn ev100(f_stops: f32, shutter_s: f32, iso: f32) -> f32 {
    (f_stops * f_stops * 100.0 / (shutter_s.max(1e-6) * iso.max(1.0))).log2()
}

/// Circle of confusion limit (mm) for acceptably sharp: sensor diagonal / 1500.
pub fn coc_limit_mm(sensor_height_mm: f32) -> f32 {
    let w = sensor_height_mm * 1.5;
    (w * w + sensor_height_mm * sensor_height_mm).sqrt() / 1500.0
}

/// Depth of field around a focus distance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DofRange {
    pub hyperfocal_m: f32,
    pub near_m: f32,
    /// `f32::INFINITY` when focused at or past the hyperfocal distance.
    pub far_m: f32,
}

impl DofRange {
    pub fn depth_m(&self) -> f32 {
        self.far_m - self.near_m
    }
    pub fn contains(&self, d: f32) -> bool {
        d >= self.near_m && d <= self.far_m
    }
}

/// Thin-lens depth of field: sharp from `near_m` to `far_m` when focused at `focus_m`.
pub fn depth_of_field(focal_mm: f32, f_stops: f32, focus_m: f32, coc_mm: f32) -> DofRange {
    let f = focal_mm.max(0.1);
    let s = (focus_m * 1000.0).max(f + 1.0);
    let h = f * f / (f_stops.max(0.1) * coc_mm.max(1e-4)) + f;
    let near = s * (h - f) / (h + s - 2.0 * f);
    let far = if s >= h { f32::INFINITY } else { s * (h - f) / (h - s) };
    DofRange { hyperfocal_m: h / 1000.0, near_m: near / 1000.0, far_m: far / 1000.0 }
}

/// Aperture to hand Bevy's `DepthOfField` so its blur matches this lens. Bevy derives the focal
/// length from the projection FOV and its own sensor height; blur scales with `f² / (N · sensor)`,
/// so a sensor of a different size needs `N · (bevy sensor / our sensor)`.
pub fn bevy_aperture(f_stops: f32, sensor_height_mm: f32) -> f32 {
    f_stops * BEVY_SENSOR_HEIGHT_MM / sensor_height_mm.max(1.0)
}

/// Bevy `MotionBlur::shutter_angle` (fraction of a frame, 0.5 = 180°) for a shutter speed shown
/// at `ref_fps`: a 1/60 s shutter at 60 fps is a full frame of blur, 1/500 almost none.
pub fn blur_shutter_angle(shutter_s: f32, ref_fps: f32) -> f32 {
    (shutter_s * ref_fps).clamp(0.0, 1.0)
}

/// Log-space step from `current` toward `target` metres (autofocus hunting feels natural when
/// the speed is in stops of distance per second).
pub fn focus_step(current: f32, target: f32, speed_per_s: f32, dt: f32) -> f32 {
    let (c, t) = (current.max(0.05).ln(), target.max(0.05).ln());
    let step = (speed_per_s * dt).min(1.0);
    (c + (t - c) * step).exp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fov_round_trip_and_known_values() {
        // 50 mm on full frame: ~27° vertical.
        let fov = vertical_fov(50.0, FULL_FRAME_HEIGHT_MM);
        assert!((fov.to_degrees() - 27.0).abs() < 0.1, "{}", fov.to_degrees());
        assert!((focal_for_fov(fov, FULL_FRAME_HEIGHT_MM) - 50.0).abs() < 1e-3);
        assert!(vertical_fov(200.0, 24.0) < fov && fov < vertical_fov(24.0, 24.0));
    }

    #[test]
    fn dof_matches_the_textbook() {
        // 50 mm f/8 focused at 5 m, CoC 0.03 mm: hyperfocal ~10.5 m, sharp ~3.4 m to ~9.6 m.
        let d = depth_of_field(50.0, 8.0, 5.0, 0.03);
        assert!((d.hyperfocal_m - 10.4).abs() < 0.3, "{d:?}");
        assert!((d.near_m - 3.39).abs() < 0.1, "{d:?}");
        assert!((d.far_m - 9.6).abs() < 0.4, "{d:?}");
        assert!(d.contains(5.0) && !d.contains(2.0));
        // Wider aperture, shallower field.
        assert!(depth_of_field(50.0, 1.8, 5.0, 0.03).depth_m() < d.depth_m());
        // Longer lens, shallower field.
        assert!(depth_of_field(200.0, 8.0, 5.0, 0.03).depth_m() < d.depth_m());
        // Past the hyperfocal distance everything to infinity is sharp.
        assert!(depth_of_field(50.0, 8.0, 30.0, 0.03).far_m.is_infinite());
    }

    #[test]
    fn exposure_and_blur() {
        // Sunny 16: f/16, 1/100, ISO 100 is about EV 14.6.
        assert!((ev100(16.0, 0.01, 100.0) - 14.64).abs() < 0.05);
        // Doubling ISO is one stop brighter (lower EV100).
        assert!((ev100(8.0, 0.01, 100.0) - ev100(8.0, 0.01, 200.0) - 1.0).abs() < 1e-3);
        assert!(blur_shutter_angle(1.0 / 500.0, 60.0) < 0.13);
        assert_eq!(blur_shutter_angle(1.0, 60.0), 1.0);
        assert!((blur_shutter_angle(1.0 / 120.0, 60.0) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn bevy_aperture_compensates_for_sensor_size() {
        assert!((bevy_aperture(4.0, BEVY_SENSOR_HEIGHT_MM) - 4.0).abs() < 1e-5);
        // A bigger sensor blurs more at the same f-stop, so Bevy needs a wider (smaller N) aperture.
        assert!(bevy_aperture(4.0, FULL_FRAME_HEIGHT_MM) < 4.0);
    }

    #[test]
    fn autofocus_converges_without_overshoot() {
        let mut f = 2.0;
        for _ in 0..120 {
            let n = focus_step(f, 40.0, 6.0, 1.0 / 60.0);
            assert!(n >= f && n <= 40.0 + 1e-3);
            f = n;
        }
        assert!((f - 40.0).abs() < 1.0, "{f}");
    }
}
