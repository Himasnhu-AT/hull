//! Build `AnimationClip`s in code: keyframes per bone by name, or a function of the clip
//! fraction sampled at N keys (procedural gaits, tests). No binary assets needed.
//!
//! ```ignore
//! let clip = ClipBuilder::new(&rig, 1.0)
//!     .rotation_fn("LeftUpLeg", 16, |p| Quat::from_rotation_x((p * TAU).sin() * 0.5))
//!     .translation("Hips", &[(0.0, Vec3::Y), (1.0, Vec3::new(0.0, 1.0, -1.5))])
//!     .build()?;
//! ```

use bevy::animation::{AnimationClip, AnimationTargetId, VariableCurve, animated_field};
use bevy::prelude::*;

/// Anything that maps bone names to animation target ids: [`super::RigDef`] (procedural rigs)
/// and [`super::Skeleton`] (any bound hierarchy, e.g. a loaded glTF scene).
pub trait BoneIds {
    fn target_id(&self, bone: &str) -> Option<AnimationTargetId>;
    /// Known bone names (for error messages).
    fn bone_names(&self) -> Vec<String>;
}

/// Builds an [`AnimationClip`]. Keys are `(seconds, value)`; values are linearly interpolated
/// (slerp for rotations). Unknown bones are collected and reported by [`Self::build`].
pub struct ClipBuilder<'a, B: BoneIds + ?Sized> {
    ids: &'a B,
    clip: AnimationClip,
    duration: f32,
    unknown: Vec<String>,
    bad: Vec<String>,
}

impl<'a, B: BoneIds + ?Sized> ClipBuilder<'a, B> {
    pub fn new(ids: &'a B, duration: f32) -> Self {
        let mut clip = AnimationClip::default();
        clip.set_duration(duration);
        ClipBuilder { ids, clip, duration, unknown: Vec::new(), bad: Vec::new() }
    }

    fn target(&mut self, bone: &str) -> Option<AnimationTargetId> {
        let id = self.ids.target_id(bone);
        if id.is_none() && !self.unknown.iter().any(|u| u == bone) {
            self.unknown.push(bone.to_string());
        }
        id
    }

    fn keys<T: Clone>(&mut self, bone: &str, keys: &[(f32, T)]) -> Vec<(f32, T)> {
        let mut k: Vec<(f32, T)> = keys.to_vec();
        if k.len() == 1 {
            let v = k[0].1.clone();
            k.push((k[0].0.max(self.duration).max(k[0].0 + 1e-3), v));
        }
        if k.is_empty() {
            self.bad.push(format!("{bone}: no keys"));
        }
        k
    }

    pub fn rotation(mut self, bone: &str, keys: &[(f32, Quat)]) -> Self {
        let Some(id) = self.target(bone) else { return self };
        let k = self.keys(bone, keys);
        match AnimatableKeyframeCurve::new(k) {
            Ok(c) => self.clip.add_curve_to_target(id, AnimatableCurve::new(animated_field!(Transform::rotation), c)),
            Err(e) => self.bad.push(format!("{bone} rotation: {e:?}")),
        }
        self
    }

    pub fn translation(mut self, bone: &str, keys: &[(f32, Vec3)]) -> Self {
        let Some(id) = self.target(bone) else { return self };
        let k = self.keys(bone, keys);
        match AnimatableKeyframeCurve::new(k) {
            Ok(c) => self.clip.add_curve_to_target(id, AnimatableCurve::new(animated_field!(Transform::translation), c)),
            Err(e) => self.bad.push(format!("{bone} translation: {e:?}")),
        }
        self
    }

    pub fn scale(mut self, bone: &str, keys: &[(f32, Vec3)]) -> Self {
        let Some(id) = self.target(bone) else { return self };
        let k = self.keys(bone, keys);
        match AnimatableKeyframeCurve::new(k) {
            Ok(c) => self.clip.add_curve_to_target(id, AnimatableCurve::new(animated_field!(Transform::scale), c)),
            Err(e) => self.bad.push(format!("{bone} scale: {e:?}")),
        }
        self
    }

    /// `n` ≥ 2 keys of `f(fraction)` spread evenly over the clip (fraction 0..=1).
    pub fn rotation_fn(self, bone: &str, n: usize, f: impl Fn(f32) -> Quat) -> Self {
        let d = self.duration;
        let keys: Vec<(f32, Quat)> = (0..=n.max(1)).map(|i| i as f32 / n.max(1) as f32).map(|p| (p * d, f(p))).collect();
        self.rotation(bone, &keys)
    }

    pub fn translation_fn(self, bone: &str, n: usize, f: impl Fn(f32) -> Vec3) -> Self {
        let d = self.duration;
        let keys: Vec<(f32, Vec3)> = (0..=n.max(1)).map(|i| i as f32 / n.max(1) as f32).map(|p| (p * d, f(p))).collect();
        self.translation(bone, &keys)
    }

    /// Adds an already-built curve (any `AnimationCurve`, e.g. a morph-weight curve).
    pub fn curve(mut self, bone: &str, curve: VariableCurve) -> Self {
        if let Some(id) = self.target(bone) {
            self.clip.add_variable_curve_to_target(id, curve);
        }
        self
    }

    pub fn build(self) -> Result<AnimationClip, String> {
        if !self.unknown.is_empty() {
            return Err(format!("unknown bones {:?} (known: {})", self.unknown, self.ids.bone_names().join(", ")));
        }
        if !self.bad.is_empty() {
            return Err(self.bad.join("; "));
        }
        let mut clip = self.clip;
        clip.set_duration(self.duration);
        Ok(clip)
    }
}
