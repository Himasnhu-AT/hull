//! Lights that come on at dusk: [`NightLight`] on any `PointLight` / `SpotLight` (street lamps,
//! vehicle lights, campfire-side lanterns).

use bevy::prelude::*;

use super::DaySky;

/// Scales the light's intensity with darkness: `intensity` (lumens) at a sun elevation of
/// `dusk_el` or lower, 0 at `dawn_el` or higher, a smooth ramp between (no flicker: it only
/// depends on the sun). `force` overrides it (a manual switch).
#[derive(Component, Reflect, Clone, Copy, Debug, PartialEq)]
#[reflect(Component)]
pub struct NightLight {
    pub intensity: f32,
    pub dusk_el: f32,
    pub dawn_el: f32,
    pub force: Option<bool>,
}

impl NightLight {
    /// A street lamp: fully on by 1 degree under, off from 4 degrees up.
    pub fn lamp(lumens: f32) -> Self {
        NightLight { intensity: lumens, dusk_el: 1.0, dawn_el: 4.0, force: None }
    }
    /// How on it is (0..1) with the sun at `el`.
    pub fn level(&self, el: f32) -> f32 {
        match self.force {
            Some(true) => 1.0,
            Some(false) => 0.0,
            None => ((self.dawn_el - el) / (self.dawn_el - self.dusk_el).max(1e-3)).clamp(0.0, 1.0),
        }
    }
}

pub(super) fn drive_night_lights(
    sky: Res<DaySky>,
    mut lights: Query<(Ref<NightLight>, Option<&mut PointLight>, Option<&mut SpotLight>)>,
) {
    let any_new = lights.iter().any(|(n, ..)| n.is_added() || n.is_changed());
    if !sky.is_changed() && !any_new {
        return;
    }
    for (n, point, spot) in &mut lights {
        let want = n.intensity * n.level(sky.sun_elevation);
        if let Some(mut p) = point
            && p.intensity != want
        {
            p.intensity = want;
        }
        if let Some(mut s) = spot
            && s.intensity != want
        {
            s.intensity = want;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ramps_with_the_sun_and_obeys_force() {
        let n = NightLight::lamp(1000.0);
        assert_eq!(n.level(20.0), 0.0);
        assert_eq!(n.level(-10.0), 1.0);
        assert!((n.level(2.5) - 0.5).abs() < 1e-5);
        assert_eq!(NightLight { force: Some(true), ..n }.level(40.0), 1.0);
        assert_eq!(NightLight { force: Some(false), ..n }.level(-40.0), 0.0);
    }
}
