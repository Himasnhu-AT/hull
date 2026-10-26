//! Foot placement on uneven ground (feature `physics`): rays from above each animated foot find
//! the ground, the pelvis drops so the lower foot can reach it, and each foot's [`TwoBoneIk`]
//! gets a target that keeps the animated lift (so steps still lift off) on the hit height, plus
//! a tip rotation aligned to the ground normal.
//!
//! Put [`FootPlacement`] on the [`super::Animator`] entity and a [`TwoBoneIk`] on each foot bone.
//! Runs before the IK solve; feet without a hit fade their IK weight out.

use avian3d::prelude::{SpatialQuery, SpatialQueryFilter};
use bevy::prelude::*;

use super::ik::{Base, TfQuery, TwoBoneIk, parent_world, world_of};
use super::machine::Animator;

#[derive(Component, Clone, Debug)]
pub struct FootPlacement {
    /// Foot bones (each with a [`TwoBoneIk`]).
    pub feet: Vec<Entity>,
    /// Bone lowered when a foot must reach below the character's ground plane.
    pub pelvis: Option<Entity>,
    /// Ray starts this far above the character's ground plane.
    pub ray_up: f32,
    /// ... and reaches this far below it.
    pub ray_down: f32,
    pub max_pelvis_drop: f32,
    /// Exponential smoothing rate of the offsets, 1/s.
    pub smoothing: f32,
    /// Tilt feet to the ground normal.
    pub align: bool,
    /// Colliders to ignore (add the character's own capsule).
    pub filter: SpatialQueryFilter,
    pub(crate) offsets: Vec<f32>,
    pub(crate) weights: Vec<f32>,
    pub(crate) pelvis_offset: f32,
    pub(crate) pelvis_base: Base<Vec3>,
}

impl FootPlacement {
    pub fn new(feet: Vec<Entity>, pelvis: Option<Entity>) -> Self {
        let n = feet.len();
        FootPlacement {
            feet,
            pelvis,
            ray_up: 0.6,
            ray_down: 0.8,
            max_pelvis_drop: 0.45,
            smoothing: 14.0,
            align: true,
            filter: SpatialQueryFilter::default(),
            offsets: vec![0.0; n],
            weights: vec![0.0; n],
            pelvis_offset: 0.0,
            pelvis_base: default(),
        }
    }
}

pub(crate) fn place_feet(
    time: Res<Time>,
    spatial: SpatialQuery,
    mut chars: Query<(Entity, &mut FootPlacement, &Animator)>,
    mut iks: Query<&mut TwoBoneIk>,
    mut tfs: TfQuery,
) {
    let dt = time.delta_secs();
    let k = |rate: f32| 1.0 - (-rate * dt).exp();
    for (e, mut fp, anim) in &mut chars {
        if !anim.posed_this_frame() {
            continue;
        }
        let Some(root) = world_of(&tfs, e) else { continue };
        let ground = root.translation().y;
        let fp = &mut *fp;
        if fp.offsets.len() != fp.feet.len() {
            fp.offsets.resize(fp.feet.len(), 0.0);
            fp.weights.resize(fp.feet.len(), 0.0);
        }
        // Restore the pelvis' animated translation before measuring feet.
        if let Some(p) = fp.pelvis
            && let Ok((mut tf, _)) = tfs.get_mut(p)
        {
            let b = fp.pelvis_base.input(tf.translation);
            tf.translation = b;
        }
        let mut lowest = 0.0f32;
        let mut targets = [(Vec3::ZERO, None::<Quat>, false); 8];
        for (i, &foot) in fp.feet.iter().enumerate().take(8) {
            let Some(g) = world_of(&tfs, foot) else { continue };
            let f = g.translation();
            let origin = Vec3::new(f.x, ground + fp.ray_up, f.z);
            let hit = spatial.cast_ray(origin, Dir3::NEG_Y, fp.ray_up + fp.ray_down, true, &fp.filter);
            let (want, w, normal) = match hit {
                Some(h) => (origin.y - h.distance - ground, 1.0, h.normal),
                None => (0.0, 0.0, Vec3::Y),
            };
            fp.offsets[i] += (want - fp.offsets[i]) * k(fp.smoothing);
            fp.weights[i] += (w - fp.weights[i]) * k(fp.smoothing);
            lowest = lowest.min(fp.offsets[i]);
            let rot = (fp.align && hit.is_some()).then(|| Quat::from_rotation_arc(Vec3::Y, normal.normalize_or(Vec3::Y)) * g.rotation());
            targets[i] = (f + Vec3::Y * fp.offsets[i], rot, true);
        }
        let drop = lowest.max(-fp.max_pelvis_drop);
        fp.pelvis_offset += (drop - fp.pelvis_offset) * k(fp.smoothing);
        if let Some(p) = fp.pelvis {
            let pw = parent_world(&tfs, p);
            let local_delta = pw.rotation().inverse() * Vec3::new(0.0, fp.pelvis_offset, 0.0) / pw.scale().max(Vec3::splat(1e-4));
            if let Ok((mut tf, _)) = tfs.get_mut(p) {
                tf.translation += local_delta;
                fp.pelvis_base.output(tf.translation);
            }
        }
        for (i, &foot) in fp.feet.iter().enumerate().take(8) {
            let (t, rot, ok) = targets[i];
            if !ok {
                continue;
            }
            if let Ok(mut ik) = iks.get_mut(foot) {
                ik.target = t;
                ik.tip_rotation = rot;
                ik.weight = fp.weights[i];
            }
        }
    }
}
