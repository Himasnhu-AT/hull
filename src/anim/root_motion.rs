//! Root motion: the root bone's horizontal travel (and optionally its yaw) is taken out of the
//! pose and handed to the character, either applied to a `Transform` or accumulated as a delta
//! for a physics / character controller to consume.
//!
//! Each clip's root track is baked once at bind time ([`RootTrack::bake`], 60 samples per
//! second, through `AnimationClip::sample_clamped`, so glTF clips work too). Per frame a delta is
//! a few lerps per playing clip, blended by the base layer's weights; no allocation.

use bevy::animation::{AnimationClip, AnimationTargetId, animated_field};
use bevy::prelude::*;

/// Put on an [`super::Animator`] entity (whose graph names a `root_bone`) to extract root motion.
#[derive(Component, Clone, Debug)]
pub struct RootMotion {
    pub mode: RootMotionMode,
    /// Also extract rotation about Y (turn-in-place clips). Default false.
    pub yaw: bool,
    /// Also extract vertical travel (default false: hip bob stays in the pose).
    pub vertical: bool,
    /// Entity moved by `RootMotionMode::Transform` (default: the animator entity itself). Must
    /// be the animator or one of its ancestors.
    pub target: Option<Entity>,
}

impl Default for RootMotion {
    fn default() -> Self {
        RootMotion { mode: RootMotionMode::Transform, yaw: false, vertical: false, target: None }
    }
}

impl RootMotion {
    /// Accumulate into [`RootMotionDelta`] instead of moving anything.
    pub fn delta() -> Self {
        RootMotion { mode: RootMotionMode::Delta, ..default() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum RootMotionMode {
    /// Move the target's `Transform` (PostUpdate, before transform propagation).
    #[default]
    Transform,
    /// Only accumulate [`RootMotionDelta`]; a controller calls `take()` (e.g. in `FixedUpdate`
    /// to set a kinematic velocity).
    Delta,
}

/// World-space root motion accumulated since the last [`RootMotionDelta::take`]. Inserted with
/// [`RootMotion`]; filled in both modes.
#[derive(Component, Clone, Copy, Debug, Default, PartialEq)]
pub struct RootMotionDelta {
    pub translation: Vec3,
    /// Radians about world Y.
    pub yaw: f32,
    /// Motion of the last animation step alone (for velocity readouts).
    pub last_translation: Vec3,
    pub last_dt: f32,
}

impl RootMotionDelta {
    /// Returns the accumulated motion and resets it.
    pub fn take(&mut self) -> (Vec3, f32) {
        let r = (self.translation, self.yaw);
        self.translation = Vec3::ZERO;
        self.yaw = 0.0;
        r
    }
    /// Root-motion speed of the last step, m/s.
    pub fn velocity(&self) -> Vec3 {
        if self.last_dt > 0.0 { self.last_translation / self.last_dt } else { Vec3::ZERO }
    }
}

/// A clip's baked root-bone track, in the root bone's parent space, sampled uniformly over the
/// clip (index 0 = start, last = end).
#[derive(Clone, Debug, Default)]
pub struct RootTrack {
    pub pos: Vec<Vec3>,
    /// Unwrapped yaw (radians).
    pub yaw: Vec<f32>,
}

/// Samples per second when baking.
const BAKE_HZ: f32 = 60.0;

impl RootTrack {
    /// Bakes `target`'s translation/rotation from `clip`. `None` if the clip doesn't animate the
    /// target's translation.
    pub fn bake(clip: &AnimationClip, target: AnimationTargetId) -> Option<RootTrack> {
        let dur = clip.duration().max(1e-4);
        clip.sample_clamped(animated_field!(Transform::translation), target, 0.0)?;
        let n = ((dur * BAKE_HZ).ceil() as usize).clamp(2, 4096);
        let mut pos = Vec::with_capacity(n + 1);
        let mut yaw = Vec::with_capacity(n + 1);
        let mut last = 0.0f32;
        for i in 0..=n {
            let t = dur * i as f32 / n as f32;
            pos.push(clip.sample_clamped(animated_field!(Transform::translation), target, t).unwrap_or_default());
            let q = clip.sample_clamped(animated_field!(Transform::rotation), target, t).unwrap_or_default();
            let f = q * Vec3::Z;
            let mut y = f.x.atan2(f.z);
            if i > 0 {
                // unwrap
                while y - last > std::f32::consts::PI {
                    y -= std::f32::consts::TAU;
                }
                while y - last < -std::f32::consts::PI {
                    y += std::f32::consts::TAU;
                }
            }
            last = y;
            yaw.push(y);
        }
        Some(RootTrack { pos, yaw })
    }

    /// From explicit samples (tests, procedural tracks).
    pub fn from_samples(pos: Vec<Vec3>, yaw: Vec<f32>) -> RootTrack {
        RootTrack { pos, yaw }
    }

    /// Position and yaw at clip fraction `f` (0..1).
    pub fn at(&self, f: f32) -> (Vec3, f32) {
        let n = self.pos.len();
        if n == 0 {
            return (Vec3::ZERO, 0.0);
        }
        let x = f.clamp(0.0, 1.0) * (n - 1) as f32;
        let i = (x.floor() as usize).min(n - 1);
        let j = (i + 1).min(n - 1);
        let t = x - i as f32;
        let y = |k: usize| self.yaw.get(k).copied().unwrap_or(0.0);
        (self.pos[i].lerp(self.pos[j], t), y(i) + (y(j) - y(i)) * t)
    }

    /// Motion from fraction `f0` to `f1` of one pass, in the clip's frame at `f0` when `yaw`.
    fn seg(&self, f0: f32, f1: f32, yaw: bool) -> (Vec3, f32) {
        let (p0, y0) = self.at(f0);
        let (p1, y1) = self.at(f1);
        if yaw { (Quat::from_rotation_y(-y0) * (p1 - p0), y1 - y0) } else { (p1 - p0, 0.0) }
    }

    /// Motion between normalized times `t0` and `t1` (cycles; may span loops, capped at 3).
    pub fn delta(&self, t0: f32, t1: f32, looping: bool, yaw: bool) -> (Vec3, f32) {
        if !looping {
            return self.seg(t0.clamp(0.0, 1.0), t1.clamp(0.0, 1.0), yaw);
        }
        let (k0, k1) = (t0.floor(), t1.floor());
        let (f0, f1) = (t0 - k0, t1 - k1);
        if k0 == k1 {
            return self.seg(f0, f1, yaw);
        }
        let compose = |a: (Vec3, f32), b: (Vec3, f32)| (a.0 + Quat::from_rotation_y(a.1) * b.0, a.1 + b.1);
        let full = (k1 - k0).abs() as i32 - 1;
        if t1 > t0 {
            let mut d = self.seg(f0, 1.0, yaw);
            for _ in 0..full.min(3) {
                d = compose(d, self.seg(0.0, 1.0, yaw));
            }
            compose(d, self.seg(0.0, f1, yaw))
        } else {
            let mut d = self.seg(f0, 0.0, yaw);
            for _ in 0..full.min(3) {
                d = compose(d, self.seg(1.0, 0.0, yaw));
            }
            compose(d, self.seg(1.0, f1, yaw))
        }
    }

    /// Offset of the pose at fraction `f` from the clip's start (what gets locked out).
    pub fn offset(&self, f: f32) -> (Vec3, f32) {
        let (p0, y0) = self.at(0.0);
        let (p, y) = self.at(f);
        (p - p0, y - y0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn straight(len: f32) -> RootTrack {
        let n = 10;
        RootTrack::from_samples((0..=n).map(|i| Vec3::new(0.0, 1.0, -len * i as f32 / n as f32)).collect(), vec![0.0; n + 1])
    }

    #[test]
    fn delta_across_loops() {
        let tr = straight(1.5);
        let (d, _) = tr.delta(0.2, 0.4, true, false);
        assert!((d.z + 0.3).abs() < 1e-5, "{d}");
        // 0.9 → 1.1 wraps: 0.1 + 0.1 of a cycle.
        let (d, _) = tr.delta(0.9, 1.1, true, false);
        assert!((d.z + 0.3).abs() < 1e-5, "{d}");
        // 0.5 → 2.5: two whole cycles.
        let (d, _) = tr.delta(0.5, 2.5, true, false);
        assert!((d.z + 3.0).abs() < 1e-4, "{d}");
        // once: clamped at the end.
        let (d, _) = tr.delta(0.9, 1.4, false, false);
        assert!((d.z + 0.15).abs() < 1e-5, "{d}");
    }

    #[test]
    fn yaw_relative_delta_turns_translation() {
        // Walks along -Z while turning 90° to the left over the clip.
        let n = 40;
        let pos = (0..=n).map(|i| Vec3::new(0.0, 0.0, -(i as f32) / n as f32)).collect();
        let yaw = (0..=n).map(|i| std::f32::consts::FRAC_PI_2 * i as f32 / n as f32).collect();
        let tr = RootTrack::from_samples(pos, yaw);
        let (d, y) = tr.delta(0.5, 0.75, true, true);
        assert!((y - std::f32::consts::FRAC_PI_4 * 0.5).abs() < 1e-5);
        // In the clip frame at 0.5 (yawed 45°), -Z travel appears rotated.
        assert!(d.x.abs() > 0.1, "{d}");
    }
}
