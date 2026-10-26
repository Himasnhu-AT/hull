//! 3D: listener, distance attenuation (see [`super::Attenuation`]), equal-power panning,
//! rear darkening, doppler, and raycast occlusion (feature `physics`, a budget of rays per
//! frame, round-robin over 3D voices).
//!
//! The listener is the first entity with [`SoundListener`], else Bevy's `SpatialListener`, else
//! the [`crate::gfx::MainCamera`]; with none, the origin looking down −Z.

use bevy::prelude::*;

use super::bus::{NO_LOWPASS, lerp_hz};
use super::cue::Attenuation;

/// Marks the entity whose `GlobalTransform` is the ears (overrides the camera).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct SoundListener;

/// Colliders on this entity never occlude sound (e.g. the player's own body).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct SoundOcclusionIgnore;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Listener {
    pub pos: Vec3,
    pub right: Vec3,
    pub forward: Vec3,
    pub vel: Vec3,
    pub entity: Option<Entity>,
}

impl Default for Listener {
    fn default() -> Self {
        Listener { pos: Vec3::ZERO, right: Vec3::X, forward: Vec3::NEG_Z, vel: Vec3::ZERO, entity: None }
    }
}

/// Spatial knobs shared by every voice (from [`super::SoundConfig`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpatialCfg {
    /// Cut-off for a source fully behind the listener (≥ 19 kHz disables).
    pub rear_lowpass_hz: f32,
    pub speed_of_sound: f32,
    /// Global doppler multiplier (× each cue's `doppler`).
    pub doppler_scale: f32,
}

impl Default for SpatialCfg {
    fn default() -> Self {
        SpatialCfg { rear_lowpass_hz: 9_000.0, speed_of_sound: 343.0, doppler_scale: 1.0 }
    }
}

/// Result of [`spatialize`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spatial {
    pub gain: f32,
    pub pan: [f32; 2],
    pub lowpass: f32,
    pub doppler: f32,
    pub dist: f32,
    /// −1 left .. 1 right (for captions' direction hints).
    pub pan_x: f32,
    /// 0 in front .. 1 directly behind.
    pub behind: f32,
}

/// Equal-power pan, normalised so centre = (1, 1). `x` in −1..1.
#[inline]
pub fn pan_gains(x: f32) -> [f32; 2] {
    let th = (x.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
    let k = std::f32::consts::SQRT_2;
    [th.cos() * k, th.sin() * k]
}

/// Doppler pitch ratio for a source at `pos` moving at `vel`, heard by `l`. Clamped 0.5..2.
pub fn doppler(l: &Listener, pos: Vec3, vel: Vec3, c: f32) -> f32 {
    let d = pos - l.pos;
    let len = d.length();
    if len < 1e-3 {
        return 1.0;
    }
    let dir = d / len; // listener → source
    let v_l = l.vel.dot(dir); // listener moving towards the source: +
    let v_s = -vel.dot(dir); // source moving towards the listener: +
    let c = c.max(1.0);
    ((c + v_l) / (c - v_s).max(c * 0.25)).clamp(0.5, 2.0)
}

pub fn spatialize(att: &Attenuation, l: &Listener, pos: Vec3, vel: Vec3, cfg: &SpatialCfg) -> Spatial {
    let d = pos - l.pos;
    let dist = d.length();
    let blend = att.spatial_blend.clamp(0.0, 1.0);
    let gain = att.blended_gain(dist);
    let (pan_x, behind) = if dist > 1e-3 {
        let dir = d / dist;
        (dir.dot(l.right), (-dir.dot(l.forward)).max(0.0))
    } else {
        (0.0, 0.0)
    };
    // Close sources pan less (a source inside the head is centred).
    let near = (dist / att.min_distance.max(0.1)).min(1.0);
    let p = pan_gains(pan_x * near);
    let pan = [1.0 + (p[0] - 1.0) * blend, 1.0 + (p[1] - 1.0) * blend];
    let lowpass = if cfg.rear_lowpass_hz < NO_LOWPASS { lerp_hz(NO_LOWPASS, cfg.rear_lowpass_hz, behind * blend) } else { NO_LOWPASS };
    let amount = (att.doppler * cfg.doppler_scale * blend).clamp(0.0, 4.0);
    let doppler = if amount > 0.0 { 1.0 + (doppler(l, pos, vel, cfg.speed_of_sound) - 1.0) * amount } else { 1.0 };
    Spatial { gain, pan, lowpass, doppler, dist, pan_x, behind }
}

/// Finds the listener each frame (before the voice update).
pub(crate) fn update_listener(
    time: Res<Time<Real>>,
    mut voices: ResMut<super::voice::Voices>,
    explicit: Query<(Entity, &GlobalTransform), With<SoundListener>>,
    spatial: Query<(Entity, &GlobalTransform), (With<bevy::audio::SpatialListener>, Without<SoundListener>)>,
    cams: Query<(Entity, &GlobalTransform), (With<crate::gfx::MainCamera>, Without<SoundListener>)>,
) {
    let Some((e, tf)) = explicit.iter().next().or_else(|| spatial.iter().next()).or_else(|| cams.iter().next()) else {
        return;
    };
    let dt = time.delta_secs();
    let pos = tf.translation();
    let l = &mut voices.listener;
    let vel = if dt > 0.0 && l.entity == Some(e) { (pos - l.pos) / dt } else { Vec3::ZERO };
    l.vel = l.vel.lerp(vel, 0.3);
    l.pos = pos;
    l.right = tf.right().as_vec3();
    l.forward = tf.forward().as_vec3();
    l.entity = Some(e);
}

/// Raycast occlusion: up to `occlusion_rays_per_frame` rays, round-robin over 3D voices whose
/// cue asks for it. A hit between listener and source (ignoring the source's own entity, the
/// listener and [`SoundOcclusionIgnore`] colliders) sets the voice's occlusion target.
#[cfg(feature = "physics")]
pub(crate) fn occlusion_rays(
    spatial: avian3d::prelude::SpatialQuery,
    cfg: Res<super::SoundConfig>,
    mut voices: ResMut<super::voice::Voices>,
    ignore: Query<(), With<SoundOcclusionIgnore>>,
    parents: Query<&ChildOf>,
) {
    let budget = cfg.occlusion_rays_per_frame;
    if budget == 0 {
        return;
    }
    let voices = &mut *voices;
    let n = voices.list.len();
    if n == 0 {
        return;
    }
    let l = voices.listener;
    let filter = avian3d::prelude::SpatialQueryFilter::default();
    // Ignore an entity if it, or an ancestor, is the listener / the source / marked ignored.
    let skip = |e: Entity, follow: Option<Entity>| {
        let mut cur = Some(e);
        let mut hops = 0;
        while let Some(x) = cur {
            if Some(x) == follow || Some(x) == l.entity || ignore.contains(x) {
                return true;
            }
            cur = parents.get(x).ok().map(|p| p.parent());
            hops += 1;
            if hops > 8 {
                break;
            }
        }
        false
    };
    let mut cast = 0;
    let mut tried = 0;
    while cast < budget && tried < n {
        let i = voices.ray_cursor % n;
        voices.ray_cursor = voices.ray_cursor.wrapping_add(1);
        tried += 1;
        let v = &voices.list[i];
        if !v.wants_occlusion() {
            continue;
        }
        cast += 1;
        let d = v.pos - l.pos;
        let dist = d.length();
        let target = match Dir3::new(d) {
            Ok(dir) if dist > 0.6 => {
                let follow = v.follow;
                let hit = spatial.cast_ray_predicate(l.pos + dir * 0.3, dir, (dist - 0.6).max(0.0), true, &filter, &|e| !skip(e, follow));
                if hit.is_some() { 1.0 } else { 0.0 }
            }
            _ => 0.0,
        };
        voices.list[i].occl_target = target;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pan_law() {
        assert_eq!(pan_gains(0.0).map(|g| (g * 1e4).round()), [1e4, 1e4]);
        let r = pan_gains(1.0);
        assert!(r[0].abs() < 1e-6 && (r[1] - std::f32::consts::SQRT_2).abs() < 1e-6);
        let p = pan_gains(0.3);
        assert!((p[0] * p[0] + p[1] * p[1] - 2.0).abs() < 1e-5, "constant power");
    }

    #[test]
    fn source_on_the_right_pans_right_and_behind_darkens() {
        let l = Listener::default();
        let att = Attenuation { min_distance: 1.0, max_distance: 50.0, ..default() };
        let cfg = SpatialCfg::default();
        let s = spatialize(&att, &l, Vec3::new(5.0, 0.0, 0.0), Vec3::ZERO, &cfg);
        assert!(s.pan[1] > s.pan[0] * 3.0, "{s:?}");
        assert!((s.gain - 0.2).abs() < 1e-5);
        assert_eq!(s.lowpass, NO_LOWPASS);
        let back = spatialize(&att, &l, Vec3::new(0.0, 0.0, 5.0), Vec3::ZERO, &cfg);
        assert!((back.lowpass - 9_000.0).abs() < 1.0, "behind → rear low-pass: {}", back.lowpass);
        let flat = Attenuation { spatial_blend: 0.0, ..att };
        let s2 = spatialize(&flat, &l, Vec3::new(5.0, 0.0, 0.0), Vec3::ZERO, &cfg);
        assert_eq!((s2.gain, s2.pan), (1.0, [1.0, 1.0]), "2D: no rolloff, no pan");
    }

    #[test]
    fn doppler_approaching_raises_pitch() {
        let l = Listener::default();
        let towards = doppler(&l, Vec3::new(0.0, 0.0, -50.0), Vec3::new(0.0, 0.0, 34.3), 343.0);
        assert!((towards - 343.0 / (343.0 - 34.3)).abs() < 1e-4);
        let away = doppler(&l, Vec3::new(0.0, 0.0, -50.0), Vec3::new(0.0, 0.0, -34.3), 343.0);
        assert!(away < 1.0);
        let still = doppler(&l, Vec3::new(3.0, 0.0, 0.0), Vec3::ZERO, 343.0);
        assert_eq!(still, 1.0);
    }
}
