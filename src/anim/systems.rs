//! ECS side: bind animators to skeletons and loaded clips, choose LOD, step state machines,
//! write Bevy's `AnimationPlayer`, extract root motion.

use std::sync::Arc;
use std::time::Instant;

use bevy::animation::graph::{AnimationGraph, AnimationGraphHandle, AnimationGraphNode, AnimationNodeType};
use bevy::animation::{AnimatedBy, AnimationClip, AnimationTargetId};
use bevy::mesh::skinning::SkinnedMesh;
use bevy::prelude::*;

use super::def::{AnimGraphDef, LayerMode, NotifyTime};
use super::ik::{TfQuery, parent_world, world_of};
use super::machine::{Animator, Binding, SlotInfo};
use super::root_motion::{RootMotion, RootMotionDelta, RootMotionMode, RootTrack};
use super::skeleton::{self, Skeleton};
use super::{AnimConfig, AnimNotify, AnimStats};
use crate::flow::Headless;
use crate::gfx::MainCamera;

/// Bindings and baked root tracks shared between characters.
#[derive(Resource, Default)]
pub struct BindCache {
    entries: Vec<(Arc<AnimGraphDef>, u64, Arc<Binding>)>,
    tracks: Vec<(AssetId<AnimationClip>, AnimationTargetId, Option<Arc<RootTrack>>)>,
    pub errors: Vec<String>,
}

impl BindCache {
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

pub(crate) fn bind_animators(
    mut commands: Commands,
    mut q: Query<(Entity, &mut Animator, Option<&Skeleton>, Option<&RootMotion>, Has<RootMotionDelta>)>,
    nodes: Query<(Option<&Children>, Option<&AnimationTargetId>, Option<&AnimatedBy>, Option<&Name>, &Transform)>,
    skinned: Query<&SkinnedMesh>,
    parents: Query<&ChildOf>,
    clips: Res<Assets<AnimationClip>>,
    mut graphs: ResMut<Assets<AnimationGraph>>,
    mut cache: ResMut<BindCache>,
) {
    for (e, mut anim, skel, rm, has_delta) in &mut q {
        if let Some(rm) = rm {
            anim.root_yaw = rm.yaw;
            anim.root_vertical = rm.vertical;
            if !has_delta {
                commands.entity(e).insert(RootMotionDelta::default());
            }
        }
        if anim.binding.is_some() {
            continue;
        }
        let built;
        let skel = match skel {
            Some(s) => s,
            None => {
                built = skeleton::collect(e, &nodes, &skinned, &parents);
                if built.bones.is_empty() {
                    continue; // hierarchy not spawned yet
                }
                commands.entity(e).insert(built.clone());
                &built
            }
        };
        let def = anim.def().clone();
        if !def.clip_handles().all(|h| clips.contains(h)) {
            continue; // clips still loading
        }
        let binding = match cache.entries.iter().find(|(d, sig, _)| Arc::ptr_eq(d, &def) && *sig == skel.signature) {
            Some((_, _, b)) => b.clone(),
            None => match build_binding(&def, skel, &clips, &mut graphs, &mut cache) {
                Ok(b) => {
                    let b = Arc::new(b);
                    cache.entries.push((def.clone(), skel.signature, b.clone()));
                    b
                }
                Err(err) => {
                    if !cache.errors.contains(&err) {
                        error!("{err}");
                        cache.errors.push(err);
                    }
                    continue;
                }
            },
        };
        anim.root_bone = def.root_bone.as_ref().and_then(|n| skel.entity(n));
        anim.lod_phase = (e.index().index() % 251) as u8;
        commands.entity(e).insert(AnimationGraphHandle(binding.graph.clone()));
        anim.binding = Some(binding);
    }
}

fn build_binding(
    def: &AnimGraphDef,
    skel: &Skeleton,
    clips: &Assets<AnimationClip>,
    graphs: &mut Assets<AnimationGraph>,
    cache: &mut BindCache,
) -> Result<Binding, String> {
    let ctx = |m: String| format!("anim graph `{}`: {m}", def.name);
    let mut g = AnimationGraph::new();
    let root_target = match &def.root_bone {
        Some(n) => Some(skel.find(n).map(|i| skel.bones[i].target).ok_or_else(|| ctx(format!("root bone `{n}` not in skeleton")))?),
        None => None,
    };
    let mut below = None;
    let mut layers = Vec::with_capacity(def.layers.len());
    for (k, layer) in def.layers.iter().enumerate() {
        let mut bits = 0u64;
        if let Some(mask) = &layer.mask {
            let set = skel.mask_set(mask).map_err(ctx)?;
            for (i, b) in skel.bones.iter().enumerate() {
                if !set[i] {
                    g.add_target_to_mask_group(b.target, k as u32);
                }
            }
            bits = 1 << k;
        }
        let node = g.graph.add_node(AnimationGraphNode {
            node_type: if layer.mode == LayerMode::Additive { AnimationNodeType::Add } else { AnimationNodeType::Blend },
            mask: 0,
            weight: 1.0,
        });
        if let Some(b) = below {
            g.add_edge(node, b);
        }
        let mut slots = Vec::with_capacity(layer.slot_count());
        for st in &layer.states {
            for c in st.motion.clips() {
                let clip = clips.get(&c.handle).ok_or_else(|| ctx("clip not loaded".into()))?;
                let duration = clip.duration().max(1e-4);
                let mut notifies: Vec<(f32, Arc<str>)> = c
                    .notifies
                    .iter()
                    .map(|n| {
                        let p = match n.at {
                            NotifyTime::Secs(s) => s / duration,
                            NotifyTime::Norm(p) => p,
                        };
                        (p.clamp(0.0, 1.0), n.name.clone())
                    })
                    .collect();
                notifies.sort_by(|a, b| a.0.total_cmp(&b.0));
                let track = match (k, root_target) {
                    (0, Some(t)) => {
                        let id = c.handle.id();
                        match cache.tracks.iter().find(|(c, tt, _)| *c == id && *tt == t) {
                            Some((_, _, tr)) => tr.clone(),
                            None => {
                                let tr = RootTrack::bake(clip, t).map(Arc::new);
                                cache.tracks.push((id, t, tr.clone()));
                                tr
                            }
                        }
                    }
                    _ => None,
                };
                let node_idx = g.add_clip_with_mask(c.handle.clone(), bits, 1.0, node);
                slots.push(SlotInfo { node: node_idx, duration, notifies, track });
            }
        }
        layers.push(slots);
        below = Some(node);
    }
    g.root = below.expect("at least one layer");
    Ok(Binding { graph: graphs.add(g), layers })
}

/// Picks every animator's pose interval from camera distance and visibility.
pub(crate) fn choose_lod(
    cfg: Res<AnimConfig>,
    headless: Option<Res<Headless>>,
    main_cam: Query<&GlobalTransform, With<MainCamera>>,
    cams: Query<(&GlobalTransform, &Camera), With<Camera3d>>,
    mut q: Query<(&mut Animator, Option<&GlobalTransform>, Option<&Skeleton>)>,
    vis: Query<&ViewVisibility>,
) {
    let lod = &cfg.lod;
    let cam = main_cam.iter().next().or_else(|| cams.iter().find(|(_, c)| c.is_active).map(|(g, _)| g)).map(|g| g.translation());
    let check_vis = lod.enabled && !headless.is_some_and(|h| h.0);
    for (mut a, g, skel) in &mut q {
        let mut interval = 1u8;
        if lod.enabled
            && let (Some(cam), Some(g)) = (cam, g)
        {
            let d = cam.distance(g.translation());
            let tier = lod.distances.iter().position(|&x| d < x).unwrap_or(lod.distances.len());
            interval = lod.intervals[tier.min(lod.intervals.len() - 1)].max(1);
            if check_vis
                && let Some(s) = skel
                && !s.meshes.is_empty()
                && !s.meshes.iter().any(|m| vis.get(*m).is_ok_and(|v| v.get()))
            {
                interval = if lod.offscreen_interval == 0 { u8::MAX } else { lod.offscreen_interval };
            }
        }
        if a.lod_interval != interval {
            a.lod_interval = interval;
        }
    }
}

/// An empty graph swapped onto players whose pose is skipped this frame: Bevy then visits
/// their bones with a one-node graph instead of evaluating every clip node.
#[derive(Resource, Clone)]
pub struct IdleGraph(pub Handle<AnimationGraph>);

pub(crate) fn advance(
    time: Res<Time>,
    cfg: Res<AnimConfig>,
    idle: Res<IdleGraph>,
    mut frame: Local<u64>,
    mut q: Query<(Entity, &mut Animator, &mut AnimationPlayer, Option<&mut AnimationGraphHandle>)>,
    mut notes: MessageWriter<AnimNotify>,
    mut stats: ResMut<AnimStats>,
) {
    let t0 = Instant::now();
    *frame += 1;
    let frame = *frame;
    let dt = time.delta_secs().min(cfg.max_dt);
    let mode = cfg.notify_mode;
    q.par_iter_mut().for_each(|(_, mut a, mut player, handle)| {
        let Some(b) = a.binding.clone() else { return };
        a.step_with(&b, dt, mode);
        let iv = a.lod_interval.max(1) as u64;
        let pose = iv == 1 || (iv != u8::MAX as u64 && (frame + a.lod_phase as u64).is_multiple_of(iv));
        a.posed = pose;
        let Some(mut handle) = handle else { return };
        let want = if pose { &b.graph } else { &idle.0 };
        if handle.0 != *want {
            handle.0 = want.clone();
        }
        if pose {
            write_player(&a, &b, &mut player);
        }
    });
    let (mut n, mut bound, mut posed, mut fired) = (0u32, 0u32, 0u32, 0u32);
    for (e, a, ..) in &q {
        n += 1;
        bound += a.is_bound() as u32;
        posed += a.posed as u32;
        for f in &a.out.notifies {
            fired += 1;
            notes.write(AnimNotify {
                entity: e,
                layer: f.layer,
                state: f.state,
                name: f.name.clone(),
                clip_time: f.clip_time,
                weight: f.weight,
            });
        }
    }
    stats.animators = n;
    stats.bound = bound;
    stats.posed = posed;
    stats.notifies = fired;
    stats.notifies_total += fired as u64;
    stats.advance_us = t0.elapsed().as_secs_f32() * 1e6;
}

/// Mirrors the animator's slot weights/times into the player (all paused: our clock drives).
fn write_player(a: &Animator, b: &Binding, player: &mut AnimationPlayer) {
    player.stop_all();
    let def = a.def();
    for (li, ldef) in def.layers.iter().enumerate() {
        let rt = a.layer(li);
        let lw = rt.weight;
        let scale = match (li, ldef.mode) {
            (0, _) => 1.0,
            (_, LayerMode::Override) => {
                let w = lw.min(0.999);
                w / (1.0 - w)
            }
            (_, LayerMode::Additive) => lw,
        };
        if scale <= 0.0 {
            continue;
        }
        let (ws, ts) = a.slot_weights(li);
        for (s, slot) in b.layers[li].iter().enumerate() {
            let w = ws[s] * scale;
            if w <= 1e-5 {
                continue;
            }
            player.play(slot.node).set_weight(w).seek_to(ts[s]).pause();
        }
    }
}

/// After the pose: lock the root bone in place and move the character by the extracted motion.
pub(crate) fn apply_root_motion(
    time: Res<Time>,
    mut q: Query<(Entity, &Animator, &RootMotion, Option<&mut RootMotionDelta>)>,
    mut tfs: TfQuery,
) {
    let dt = time.delta_secs();
    for (e, a, rm, delta) in &mut q {
        let out = a.last_step();
        if !out.has_root {
            continue;
        }
        let Some(bone) = a.root_bone else { continue };
        if a.posed_this_frame()
            && let Ok((mut tf, _)) = tfs.get_mut(bone)
        {
            tf.translation -= out.pose_offset;
            if out.pose_yaw != 0.0 {
                tf.rotation = Quat::from_rotation_y(-out.pose_yaw) * tf.rotation;
            }
        }
        let pw = parent_world(&tfs, bone);
        let world = pw.rotation() * (pw.scale() * out.root_delta);
        let yaw = out.root_yaw;
        if let Some(mut d) = delta {
            d.translation += world;
            d.yaw += yaw;
            d.last_translation = world;
            d.last_dt = dt;
        }
        if rm.mode == RootMotionMode::Transform && (world != Vec3::ZERO || yaw != 0.0) {
            let target = rm.target.unwrap_or(e);
            let parent = tfs.get(target).ok().and_then(|(_, p)| p).map(|p| p.parent());
            let inv = parent.and_then(|p| world_of(&tfs, p)).map(|g| g.rotation().inverse()).unwrap_or(Quat::IDENTITY);
            if let Ok((mut tf, _)) = tfs.get_mut(target) {
                tf.translation += inv * world;
                if yaw != 0.0 {
                    tf.rotation = Quat::from_rotation_y(yaw) * tf.rotation;
                }
            }
        }
    }
}
