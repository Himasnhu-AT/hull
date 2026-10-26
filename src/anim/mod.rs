//! Code-first character animation over Bevy's `AnimationPlayer` / `AnimationGraph` (feature
//! `anim`; docs/ANIM.md).
//!
//! - [`AnimGraphDef`]: parameters, layers (override / additive, bone masks), state machines
//!   with clip or 1D/2D blend-space states, transitions (conditions, exit time, crossfade
//!   duration + easing, any-state), clip notifies — all Rust data.
//! - [`Animator`]: per-character runtime; set parameters, read states. Bevy samples and blends
//!   the clips; this module owns time, weights, notifies and root motion.
//! - [`RootMotion`] / [`RootMotionDelta`], [`AnimNotify`] messages, procedural [`LookAt`],
//!   [`TwoBoneIk`], [`SpringBone`], [`FootPlacement`] (feature `physics`).
//! - [`ClipBuilder`], [`RigDef`], [`Mannequin`]: clips, rigs and a skinned test character
//!   made in code (no assets; headless tests use them).
//! - LOD: far or off-screen characters pose every 2nd/4th/8th frame (state machines, notifies
//!   and root motion still run every frame).
//!
//! Schedule (PostUpdate): `AnimSystems::Bind → Lod → Advance` before Bevy's
//! `AnimationSystems`, then `AnimSystems::RootMotion → Procedural` before transform
//! propagation. Set parameters in `Update`.

pub mod blend;
pub mod clip;
pub mod def;
#[cfg(feature = "physics")]
pub mod foot;
pub mod ik;
pub mod machine;
pub mod mannequin;
pub mod root_motion;
pub mod skeleton;
pub mod systems;

#[cfg(feature = "devtools")]
mod commands;

use std::sync::Arc;
use std::time::Instant;

use bevy::app::AnimationSystems;
use bevy::prelude::*;
use bevy::transform::TransformSystems;

pub use clip::{BoneIds, ClipBuilder};
pub use def::{AnimGraphBuilder, AnimGraphDef, AnimLayer, AnimState, Blend2dMode, BoneMask, Clip, Cond, LayerMode, Motion, Notify, NotifyTime, ParamValue, Transition};
#[cfg(feature = "physics")]
pub use foot::FootPlacement;
pub use ik::{LookAt, SpringBone, TwoBoneIk, aim_delta, solve_two_bone};
pub use machine::{Animator, Binding, FiredNotify, NotifyMode, SlotInfo};
pub use mannequin::{Mannequin, MannequinClips};
pub use root_motion::{RootMotion, RootMotionDelta, RootMotionMode, RootTrack};
pub use skeleton::{Bone, Humanoid, RigBone, RigDef, Skeleton};
pub use systems::BindCache;

/// A clip notify that fired this frame.
#[derive(Message, Clone, Debug)]
pub struct AnimNotify {
    /// The [`Animator`] entity.
    pub entity: Entity,
    pub layer: u16,
    /// State index in the layer (`def.layers[layer].states[state]`).
    pub state: u16,
    pub name: Arc<str>,
    /// Seconds into the clip.
    pub clip_time: f32,
    /// Weight of the clip when it fired.
    pub weight: f32,
}

/// Update-rate LOD (Unreal's "update rate optimisation"): the pose is evaluated every
/// `intervals[tier]` frames, tier by camera distance; skipped frames keep the last pose.
#[derive(Clone, Debug)]
pub struct AnimLod {
    pub enabled: bool,
    /// Tier boundaries in metres from the camera.
    pub distances: [f32; 3],
    /// Frames between poses per tier (nearest first; the last is beyond `distances[2]`).
    pub intervals: [u8; 4],
    /// Interval when none of the character's skinned meshes is visible (0 = don't pose).
    pub offscreen_interval: u8,
}

impl Default for AnimLod {
    fn default() -> Self {
        AnimLod { enabled: true, distances: [15.0, 35.0, 70.0], intervals: [1, 2, 4, 8], offscreen_interval: 0 }
    }
}

/// Global animation settings. Build with `..default()`.
#[derive(Resource, Clone, Debug)]
pub struct AnimConfig {
    pub notify_mode: NotifyMode,
    pub lod: AnimLod,
    /// Largest step (seconds) a frame may advance animations (hitches don't skip notifies'
    /// order, but a 2 s stall won't fast-forward three loops).
    pub max_dt: f32,
}

impl Default for AnimConfig {
    fn default() -> Self {
        AnimConfig { notify_mode: NotifyMode::Dominant, lod: AnimLod::default(), max_dt: 0.1 }
    }
}

/// Counters of the last frame.
#[derive(Resource, Clone, Debug, Default)]
pub struct AnimStats {
    pub animators: u32,
    pub bound: u32,
    /// Animators whose pose was evaluated this frame.
    pub posed: u32,
    pub notifies: u32,
    pub notifies_total: u64,
    /// CPU time of the state-machine step + player writes (µs).
    pub advance_us: f32,
    /// CPU time of root motion + IK + springs (µs).
    pub post_us: f32,
}

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub enum AnimSystems {
    Bind,
    Lod,
    Advance,
    RootMotion,
    Procedural,
}

/// Put on a glTF `SceneRoot` (or any ancestor) to give the first `AnimationPlayer` found below
/// it an [`Animator`] once the scene has spawned (plus `extra` components, e.g. RootMotion, are
/// added by the game in an observer of [`AnimatorAttached`]).
#[derive(Component, Clone, Debug)]
pub struct AnimateScene(pub Arc<AnimGraphDef>);

/// Triggered on the scene root when [`AnimateScene`] attached its animator.
#[derive(EntityEvent, Clone, Copy, Debug)]
pub struct AnimatorAttached {
    pub entity: Entity,
    pub animator: Entity,
}

pub struct AnimPlugin;

impl Plugin for AnimPlugin {
    fn build(&self, app: &mut App) {
        if !app.is_plugin_added::<bevy::animation::AnimationPlugin>() {
            app.add_plugins(bevy::animation::AnimationPlugin);
        }
        let idle = app.world_mut().resource_mut::<Assets<bevy::animation::graph::AnimationGraph>>().add(bevy::animation::graph::AnimationGraph::new());
        app.insert_resource(systems::IdleGraph(idle));
        app.init_resource::<AnimConfig>()
            .init_resource::<AnimStats>()
            .init_resource::<BindCache>()
            .init_resource::<PostTimer>()
            .add_message::<AnimNotify>()
            .configure_sets(
                PostUpdate,
                (AnimSystems::Bind, AnimSystems::Lod, AnimSystems::Advance).chain().before(AnimationSystems),
            )
            .configure_sets(
                PostUpdate,
                (AnimSystems::RootMotion, AnimSystems::Procedural)
                    .chain()
                    .after(AnimationSystems)
                    .before(TransformSystems::Propagate),
            )
            .add_systems(PostUpdate, (attach_scene_animators, systems::bind_animators).chain().in_set(AnimSystems::Bind))
            .add_systems(PostUpdate, systems::choose_lod.in_set(AnimSystems::Lod))
            .add_systems(PostUpdate, systems::advance.in_set(AnimSystems::Advance))
            .add_systems(PostUpdate, (post_timer_start, systems::apply_root_motion).chain().in_set(AnimSystems::RootMotion))
            .add_systems(
                PostUpdate,
                (ik::look_at, ik::two_bone_ik, ik::spring_bones, post_timer_end).chain().in_set(AnimSystems::Procedural),
            );
        #[cfg(feature = "physics")]
        if app.is_plugin_added::<avian3d::spatial_query::SpatialQueryPlugin>() {
            app.add_systems(PostUpdate, foot::place_feet.in_set(AnimSystems::Procedural).before(ik::two_bone_ik).after(ik::look_at));
        }
        #[cfg(feature = "devtools")]
        commands::register(app);
    }
}

#[derive(Resource, Default)]
struct PostTimer(Option<Instant>);

fn post_timer_start(mut t: ResMut<PostTimer>) {
    t.0 = Some(Instant::now());
}

fn post_timer_end(t: Res<PostTimer>, mut stats: ResMut<AnimStats>) {
    if let Some(t) = t.0 {
        stats.post_us = t.elapsed().as_secs_f32() * 1e6;
    }
}

fn attach_scene_animators(
    mut commands: Commands,
    q: Query<(Entity, &AnimateScene)>,
    children: Query<&Children>,
    players: Query<(), (With<AnimationPlayer>, Without<Animator>)>,
) {
    for (root, scene) in &q {
        let mut stack = vec![root];
        while let Some(e) = stack.pop() {
            if players.contains(e) {
                commands.entity(e).insert(Animator::new(scene.0.clone()));
                commands.entity(root).remove::<AnimateScene>();
                commands.trigger(AnimatorAttached { entity: root, animator: e });
                break;
            }
            if let Ok(c) = children.get(e) {
                stack.extend(c.iter());
            }
        }
    }
}
