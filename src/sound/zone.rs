//! Reverb / ambience zones: volumes in the world that, while the listener is inside (with a
//! soft `fade` margin), drive a mix snapshot's weight (e.g. "cave" reverb, "underwater"
//! muffling) and crossfade a looping ambience cue.
//!
//! ```ignore
//! commands.spawn((Transform::from_xyz(0., 2., -20.), SoundZone::sphere(8.0).snapshot("cave").ambience("amb.drips")));
//! ```

use std::borrow::Cow;

use bevy::platform::collections::HashMap;
use bevy::prelude::*;

use super::bus::Mixer;
use super::voice::{PlayParams, SoundCtl, VoiceId, Voices};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ZoneShape {
    Sphere(f32),
    /// Half extents, in the zone's local (rotated) frame.
    Box(Vec3),
}

#[derive(Component, Clone, Debug, PartialEq)]
pub struct SoundZone {
    pub shape: ZoneShape,
    /// Metres outside the shape over which the weight falls from 1 to 0.
    pub fade: f32,
    pub snapshot: Option<Cow<'static, str>>,
    /// Looping cue played (2D) at the zone weight.
    pub ambience: Option<Cow<'static, str>>,
    pub ambience_volume: f32,
}

impl Default for SoundZone {
    fn default() -> Self {
        SoundZone { shape: ZoneShape::Sphere(5.0), fade: 2.0, snapshot: None, ambience: None, ambience_volume: 1.0 }
    }
}

impl SoundZone {
    pub fn sphere(r: f32) -> Self {
        SoundZone { shape: ZoneShape::Sphere(r), ..default() }
    }
    pub fn cuboid(half: Vec3) -> Self {
        SoundZone { shape: ZoneShape::Box(half), ..default() }
    }
    pub fn snapshot(mut self, s: impl Into<Cow<'static, str>>) -> Self {
        self.snapshot = Some(s.into());
        self
    }
    pub fn ambience(mut self, cue: impl Into<Cow<'static, str>>) -> Self {
        self.ambience = Some(cue.into());
        self
    }
    pub fn fade(mut self, m: f32) -> Self {
        self.fade = m.max(0.0);
        self
    }

    /// Listener weight 0..1 for a zone at `tf`.
    pub fn weight(&self, tf: &GlobalTransform, p: Vec3) -> f32 {
        let outside = match self.shape {
            ZoneShape::Sphere(r) => (p.distance(tf.translation()) - r).max(0.0),
            ZoneShape::Box(h) => {
                let local = tf.affine().inverse().transform_point3(p);
                (local.abs() - h).max(Vec3::ZERO).length()
            }
        };
        if outside <= 0.0 {
            1.0
        } else if self.fade <= 0.0 {
            0.0
        } else {
            let t = (outside / self.fade).min(1.0);
            1.0 - t * t * (3.0 - 2.0 * t)
        }
    }
}

/// Weights → snapshots, ambience voices up/down.
pub(crate) fn update_zones(
    zones: Query<(Entity, &SoundZone, &GlobalTransform)>,
    voices: Res<Voices>,
    mut mixer: ResMut<Mixer>,
    mut ctl: ResMut<SoundCtl>,
    mut amb: Local<HashMap<Entity, (VoiceId, f32)>>,
    mut weights: Local<Vec<f32>>,
) {
    if zones.is_empty() && amb.is_empty() && weights.iter().all(|w| *w == 0.0) {
        return;
    }
    let p = voices.listener().pos;
    weights.clear();
    weights.resize(mixer.snapshot_count(), 0.0);
    for (e, z, tf) in &zones {
        let w = z.weight(tf, p);
        if let Some(s) = &z.snapshot
            && let Some(i) = mixer.snapshot_index(s)
        {
            weights[i] = weights[i].max(w);
        }
        if let Some(cue) = &z.ambience {
            let vol = w * z.ambience_volume;
            match amb.get_mut(&e) {
                Some((id, last)) => {
                    if vol <= 0.0 {
                        ctl.stop(*id, 0.5);
                        amb.remove(&e);
                    } else if (vol - *last).abs() > 0.01 {
                        ctl.set_volume(*id, vol);
                        *last = vol;
                    }
                }
                None if vol > 0.0 => {
                    let id = ctl.play_with(cue.clone(), PlayParams { owner: Some(e), ..default() });
                    ctl.set_volume(id, vol);
                    amb.insert(e, (id, vol));
                }
                None => {}
            }
        }
    }
    amb.retain(|e, _| zones.contains(*e));
    for (i, w) in weights.iter().enumerate() {
        mixer.set_zone_weight(i, *w);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_inside_fade_outside() {
        let tf = GlobalTransform::from(Transform::from_xyz(10.0, 0.0, 0.0));
        let z = SoundZone::sphere(4.0).fade(2.0);
        assert_eq!(z.weight(&tf, Vec3::new(10.0, 0.0, 0.0)), 1.0);
        assert_eq!(z.weight(&tf, Vec3::new(14.0, 0.0, 0.0)), 1.0);
        assert!((z.weight(&tf, Vec3::new(15.0, 0.0, 0.0)) - 0.5).abs() < 1e-5);
        assert_eq!(z.weight(&tf, Vec3::new(17.0, 0.0, 0.0)), 0.0);
        let b = SoundZone::cuboid(Vec3::new(1.0, 1.0, 5.0)).fade(1.0);
        let rot = GlobalTransform::from(Transform::from_rotation(Quat::from_rotation_y(std::f32::consts::FRAC_PI_2)));
        assert_eq!(b.weight(&rot, Vec3::new(4.0, 0.0, 0.0)), 1.0, "box rotated: long axis now along X");
        assert_eq!(b.weight(&rot, Vec3::new(0.0, 0.0, 4.0)), 0.0);
    }
}
