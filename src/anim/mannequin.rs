//! A procedural humanoid made entirely in code: rig, skinned low-poly mesh, a clip set
//! (idle, walk/run/back/strafes with footstep notifies and root motion, a wave overlay, an
//! additive lean, a hit reaction) and a ready-made graph. For prototypes, tests and demos; also
//! the reference for building your own clips with [`ClipBuilder`].
//!
//! Faces -Z, feet at y = 0, 1.75 m tall. Bone names follow the Unity/VRM humanoid style
//! (`Hips`, `Spine`, `Chest`, `Neck`, `Head`, `LeftUpperArm`, `LeftLowerArm`, `LeftHand`,
//! `LeftUpperLeg`, `LeftLowerLeg`, `LeftFoot`, `LeftToes`, right likewise) plus an antenna
//! chain (`Antenna1..3`) for spring bones.

use std::f32::consts::{PI, TAU};
use std::sync::Arc;

use bevy::animation::AnimationClip;
use bevy::asset::RenderAssetUsages;
use bevy::mesh::skinning::{SkinnedMesh, SkinnedMeshInverseBindposes};
use bevy::mesh::{Indices, PrimitiveTopology, VertexAttributeValues};
use bevy::prelude::*;

use super::clip::ClipBuilder;
use super::def::{AnimGraphDef, AnimLayer, AnimState, BoneMask, Clip, Cond, Motion, Transition};
use super::machine::Animator;
use super::skeleton::RigDef;

/// Handles of the mannequin's clips.
#[derive(Clone, Debug)]
pub struct MannequinClips {
    pub idle: Handle<AnimationClip>,
    pub walk: Handle<AnimationClip>,
    pub run: Handle<AnimationClip>,
    pub walk_back: Handle<AnimationClip>,
    pub strafe_left: Handle<AnimationClip>,
    pub strafe_right: Handle<AnimationClip>,
    pub wave: Handle<AnimationClip>,
    pub lean: Handle<AnimationClip>,
    pub hit: Handle<AnimationClip>,
}

/// Shared render assets for mannequins (one mesh + bindposes + material for all of them).
#[derive(Clone, Debug)]
pub struct MannequinVisual {
    pub mesh: Handle<Mesh>,
    pub bindposes: Handle<SkinnedMeshInverseBindposes>,
    pub material: Handle<StandardMaterial>,
}

/// A spawned mannequin.
#[derive(Clone, Debug)]
pub struct MannequinRig {
    pub root: Entity,
    pub bones: Vec<Entity>,
}

impl MannequinRig {
    pub fn bone(&self, name: &str) -> Entity {
        self.bones[Mannequin::rig().index(name).unwrap_or_else(|| panic!("no mannequin bone `{name}`"))]
    }
}

/// Speeds the locomotion clips travel at (m/s): walk, run, back, strafe.
pub const WALK_SPEED: f32 = 1.4;
pub const RUN_SPEED: f32 = 3.8;
pub const BACK_SPEED: f32 = 1.1;
pub const STRAFE_SPEED: f32 = 1.2;

pub struct Mannequin;

const LIMBS: [&str; 17] = [
    "Hips", "Spine", "Chest", "Neck", "Head", "LeftUpperArm", "LeftLowerArm", "LeftHand", "RightUpperArm", "RightLowerArm", "RightHand", "LeftUpperLeg",
    "LeftLowerLeg", "LeftFoot", "RightUpperLeg", "RightLowerLeg", "RightFoot",
];

impl Mannequin {
    pub const HIP_HEIGHT: f32 = 0.95;

    pub fn rig() -> RigDef {
        let t = |x: f32, y: f32, z: f32| Transform::from_xyz(x, y, z);
        let mut r = RigDef::new()
            .bone("Hips", None, t(0.0, Self::HIP_HEIGHT, 0.0))
            .bone("Spine", Some("Hips"), t(0.0, 0.12, 0.0))
            .bone("Chest", Some("Spine"), t(0.0, 0.18, 0.0))
            .bone("Neck", Some("Chest"), t(0.0, 0.24, 0.0))
            .bone("Head", Some("Neck"), t(0.0, 0.08, 0.0))
            .bone("Antenna1", Some("Head"), t(0.05, 0.2, 0.0))
            .bone("Antenna2", Some("Antenna1"), t(0.0, 0.1, 0.0))
            .bone("Antenna3", Some("Antenna2"), t(0.0, 0.1, 0.0));
        for (side, x) in [("Left", -1.0f32), ("Right", 1.0)] {
            let n = |s: &str| format!("{side}{s}");
            r = r
                .bone(n("UpperArm"), Some("Chest"), t(0.2 * x, 0.2, 0.0))
                .bone(n("LowerArm"), Some(&n("UpperArm")), t(0.0, -0.28, 0.0))
                .bone(n("Hand"), Some(&n("LowerArm")), t(0.0, -0.25, 0.0))
                .bone(n("UpperLeg"), Some("Hips"), t(0.1 * x, -0.05, 0.0))
                .bone(n("LowerLeg"), Some(&n("UpperLeg")), t(0.0, -0.42, 0.0))
                .bone(n("Foot"), Some(&n("LowerLeg")), t(0.0, -0.42, 0.0))
                .bone(n("Toes"), Some(&n("Foot")), t(0.0, -0.04, -0.13));
        }
        r
    }

    /// The skinned mesh: one rigid part per bone (vertex colours, joint weights 1).
    pub fn mesh() -> Mesh {
        let rig = Self::rig();
        let bind = rig.model_space();
        let mut pos: Vec<[f32; 3]> = Vec::new();
        let mut nrm: Vec<[f32; 3]> = Vec::new();
        let mut col: Vec<[f32; 4]> = Vec::new();
        let mut joints: Vec<[u16; 4]> = Vec::new();
        let mut idx: Vec<u32> = Vec::new();
        let body = Color::srgb(0.32, 0.42, 0.58);
        let limb_l = Color::srgb(0.85, 0.55, 0.25);
        let limb_r = Color::srgb(0.25, 0.65, 0.55);
        let skin = Color::srgb(0.9, 0.86, 0.8);
        let dark = Color::srgb(0.15, 0.16, 0.2);
        let mut part = |bone: &str, shape: Mesh, at: Transform, color: Color| {
            let i = rig.index(bone).expect("bone");
            let m = bind[i].affine() * at.to_matrix();
            let base = pos.len() as u32;
            let Some(VertexAttributeValues::Float32x3(p)) = shape.attribute(Mesh::ATTRIBUTE_POSITION) else { return };
            let Some(VertexAttributeValues::Float32x3(n)) = shape.attribute(Mesh::ATTRIBUTE_NORMAL) else { return };
            let c = color.to_linear().to_f32_array();
            for (p, n) in p.iter().zip(n) {
                pos.push(m.transform_point3(Vec3::from(*p)).to_array());
                nrm.push(m.transform_vector3(Vec3::from(*n)).normalize_or_zero().to_array());
                col.push(c);
                joints.push([i as u16, 0, 0, 0]);
            }
            match shape.indices() {
                Some(Indices::U16(v)) => idx.extend(v.iter().map(|&k| base + k as u32)),
                Some(Indices::U32(v)) => idx.extend(v.iter().map(|&k| base + k)),
                None => idx.extend((0..p.len() as u32).map(|k| base + k)),
            }
        };
        let cap = |r: f32, len: f32| Mesh::from(Capsule3d::new(r, len).mesh().rings(2).latitudes(8).longitudes(10));
        let cube = |x: f32, y: f32, z: f32| Mesh::from(Cuboid::new(x, y, z));
        let at = |x: f32, y: f32, z: f32| Transform::from_xyz(x, y, z);
        part("Hips", cube(0.32, 0.16, 0.2), at(0.0, 0.0, 0.0), body);
        part("Spine", cube(0.28, 0.2, 0.18), at(0.0, 0.09, 0.0), body);
        part("Chest", cube(0.4, 0.28, 0.22), at(0.0, 0.12, 0.0), body);
        part("Neck", cap(0.05, 0.06), at(0.0, 0.04, 0.0), skin);
        part("Head", Sphere::new(0.12).mesh().uv(14, 10), at(0.0, 0.12, 0.0), skin);
        part("Head", cube(0.16, 0.05, 0.04), at(0.0, 0.14, -0.11), dark); // visor: shows facing
        for a in ["Antenna1", "Antenna2"] {
            part(a, cap(0.012, 0.08), at(0.0, 0.05, 0.0), dark);
        }
        part("Antenna3", Sphere::new(0.03).mesh().uv(8, 6), at(0.0, 0.0, 0.0), limb_l);
        for (side, c) in [("Left", limb_l), ("Right", limb_r)] {
            let n = |s: &str| format!("{side}{s}");
            part(&n("UpperArm"), cap(0.05, 0.18), at(0.0, -0.14, 0.0), c);
            part(&n("LowerArm"), cap(0.045, 0.16), at(0.0, -0.125, 0.0), c);
            part(&n("Hand"), cube(0.07, 0.1, 0.05), at(0.0, -0.06, 0.0), skin);
            part(&n("UpperLeg"), cap(0.075, 0.26), at(0.0, -0.21, 0.0), c);
            part(&n("LowerLeg"), cap(0.06, 0.3), at(0.0, -0.21, 0.0), c);
            part(&n("Foot"), cube(0.1, 0.07, 0.24), at(0.0, -0.025, -0.06), dark);
        }
        let mut mesh = Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default())
            .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
            .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, nrm)
            .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, col)
            .with_inserted_attribute(Mesh::ATTRIBUTE_JOINT_INDEX, VertexAttributeValues::Uint16x4(joints))
            .with_inserted_indices(Indices::U32(idx));
        let n = mesh.count_vertices();
        mesh.insert_attribute(Mesh::ATTRIBUTE_JOINT_WEIGHT, vec![[1.0f32, 0.0, 0.0, 0.0]; n]);
        mesh.with_generated_skinned_mesh_bounds().expect("mannequin skinned bounds")
    }

    /// Inverse bind matrices matching [`Self::mesh`]'s joint order (rig bone order).
    pub fn inverse_bindposes() -> SkinnedMeshInverseBindposes {
        Self::rig().model_space().iter().map(|g| g.to_matrix().inverse()).collect::<Vec<Mat4>>().into()
    }

    pub fn visual(meshes: &mut Assets<Mesh>, bindposes: &mut Assets<SkinnedMeshInverseBindposes>, materials: &mut Assets<StandardMaterial>) -> MannequinVisual {
        MannequinVisual {
            mesh: meshes.add(Self::mesh()),
            bindposes: bindposes.add(Self::inverse_bindposes()),
            material: materials.add(StandardMaterial { base_color: Color::WHITE, perceptual_roughness: 0.75, ..default() }),
        }
    }

    /// Spawns a mannequin driven by `def` at `transform`; with `visual`, its skinned mesh too
    /// (leave it out headless). The root has `Animator`, `AnimationPlayer`, `Transform`.
    pub fn spawn(commands: &mut Commands, def: Arc<AnimGraphDef>, transform: Transform, visual: Option<&MannequinVisual>) -> MannequinRig {
        let rig = Self::rig();
        let root = commands.spawn((Name::new("Mannequin"), transform, Visibility::default(), Animator::new(def))).id();
        let bones = rig.spawn(commands, root);
        if let Some(v) = visual {
            commands.spawn((
                Name::new("MannequinMesh"),
                Mesh3d(v.mesh.clone()),
                MeshMaterial3d(v.material.clone()),
                SkinnedMesh { inverse_bindposes: v.bindposes.clone(), joints: bones.clone() },
                bevy::camera::visibility::DynamicSkinnedMeshBounds,
                Transform::IDENTITY,
                ChildOf(root),
            ));
        }
        MannequinRig { root, bones }
    }

    /// Builds every clip and adds it to `clips`.
    pub fn clips(clips: &mut Assets<AnimationClip>) -> MannequinClips {
        let rig = Self::rig();
        let mut add = |c: AnimationClip| clips.add(c);
        MannequinClips {
            idle: add(idle_clip(&rig)),
            walk: add(gait_clip(&rig, Vec2::Y, WALK_SPEED, 1.0, 0.0)),
            run: add(gait_clip(&rig, Vec2::Y, RUN_SPEED, 0.72, 1.0)),
            walk_back: add(gait_clip(&rig, Vec2::NEG_Y, BACK_SPEED, 1.1, 0.0)),
            strafe_left: add(gait_clip(&rig, Vec2::NEG_X, STRAFE_SPEED, 1.0, 0.0)),
            strafe_right: add(gait_clip(&rig, Vec2::X, STRAFE_SPEED, 1.0, 0.0)),
            wave: add(wave_clip(&rig)),
            lean: add(lean_clip(&rig)),
            hit: add(hit_clip(&rig)),
        }
    }

    /// The demo graph. Params: `vel_x`, `vel_z` (local velocity, m/s; +z = forward), `wave`
    /// and `lean` (layer weights 0..1), trigger `hit`. Layers: `base` (2D locomotion blend +
    /// hit reaction), `upper` (wave, masked to the spine and above), `lean` (additive).
    pub fn graph(c: &MannequinClips) -> Arc<AnimGraphDef> {
        let steps = |h: &Handle<AnimationClip>| Clip::new(h.clone()).notify_norm(0.25, "footstep_l").notify_norm(0.75, "footstep_r");
        AnimGraphDef::builder("mannequin")
            .float("vel_x", 0.0)
            .float("vel_z", 0.0)
            .float("wave", 0.0)
            .float("lean", 0.0)
            .trigger("hit")
            .root_bone("Hips")
            .layer(
                AnimLayer::new("base")
                    .state(
                        AnimState::new(
                            "locomotion",
                            Motion::blend2d(
                                "vel_x",
                                "vel_z",
                                [
                                    (Vec2::ZERO, Clip::new(c.idle.clone())),
                                    (Vec2::new(0.0, WALK_SPEED), steps(&c.walk)),
                                    (Vec2::new(0.0, RUN_SPEED), steps(&c.run)),
                                    (Vec2::new(0.0, -BACK_SPEED), steps(&c.walk_back)),
                                    (Vec2::new(-STRAFE_SPEED, 0.0), steps(&c.strafe_left)),
                                    (Vec2::new(STRAFE_SPEED, 0.0), steps(&c.strafe_right)),
                                ],
                            ),
                        )
                        .on(Transition::to("hit").when(Cond::trigger("hit")).fade(0.08)),
                    )
                    .state(
                        AnimState::new("hit", Motion::clip(Clip::new(c.hit.clone()).notify_norm(0.3, "hit_peak")))
                            .once()
                            .on(Transition::to("locomotion").exit_time(0.8).fade(0.3)),
                    ),
            )
            .layer(
                AnimLayer::new("upper")
                    .mask(BoneMask::subtree("Spine"))
                    .weight_param("wave")
                    .state(AnimState::new("wave", Motion::clip(c.wave.clone()))),
            )
            .layer(AnimLayer::new("lean").additive().weight_param("lean").state(AnimState::new("lean", Motion::clip(c.lean.clone()))))
            .build()
            .expect("mannequin graph")
    }
}

/// Local rotations of the main bones (indexed like [`LIMBS`]) plus the hips translation.
struct Pose {
    rot: [Quat; 17],
    hips: Vec3,
}

impl Pose {
    fn rest() -> Self {
        Pose { rot: [Quat::IDENTITY; 17], hips: Vec3::new(0.0, Mannequin::HIP_HEIGHT, 0.0) }
    }
    fn set(&mut self, bone: &str, q: Quat) {
        let i = LIMBS.iter().position(|b| *b == bone).expect("limb");
        self.rot[i] = q;
    }
}

/// A full-body clip from a pose function sampled at `n` keys.
fn pose_clip(rig: &RigDef, dur: f32, n: usize, f: impl Fn(f32) -> Pose) -> AnimationClip {
    let poses: Vec<Pose> = (0..=n).map(|i| f(i as f32 / n as f32)).collect();
    let mut b = ClipBuilder::new(rig, dur);
    let times: Vec<f32> = (0..=n).map(|i| dur * i as f32 / n as f32).collect();
    for (bi, bone) in LIMBS.iter().enumerate() {
        let keys: Vec<(f32, Quat)> = times.iter().zip(&poses).map(|(t, p)| (*t, p.rot[bi])).collect();
        b = b.rotation(bone, &keys);
    }
    let keys: Vec<(f32, Vec3)> = times.iter().zip(&poses).map(|(t, p)| (*t, p.hips)).collect();
    b.translation("Hips", &keys).build().expect("mannequin clip")
}

fn arms_down(p: &mut Pose, out: f32) {
    p.set("LeftUpperArm", Quat::from_rotation_z(-out));
    p.set("RightUpperArm", Quat::from_rotation_z(out));
}

fn idle_clip(rig: &RigDef) -> AnimationClip {
    pose_clip(rig, 3.0, 24, |ph| {
        let s = (ph * TAU).sin();
        let mut p = Pose::rest();
        p.hips.y += 0.008 * (ph * TAU * 2.0).cos();
        p.set("Chest", Quat::from_rotation_x(0.03 * s));
        p.set("Head", Quat::from_rotation_y(0.15 * (ph * TAU).sin()) * Quat::from_rotation_x(-0.03 * s));
        arms_down(&mut p, 0.12 + 0.02 * s);
        p.set("LeftLowerArm", Quat::from_rotation_x(-0.15));
        p.set("RightLowerArm", Quat::from_rotation_x(-0.15));
        p.set("LeftLowerLeg", Quat::from_rotation_x(-0.05));
        p.set("RightLowerLeg", Quat::from_rotation_x(-0.05));
        p
    })
}

/// A locomotion cycle moving along `dir` (x right, y forward) at `speed` m/s; `run` 0..1
/// scales stride, knee lift, lean and arm pump.
fn gait_clip(rig: &RigDef, dir: Vec2, speed: f32, dur: f32, run: f32) -> AnimationClip {
    let travel = Vec3::new(dir.x, 0.0, -dir.y).normalize_or_zero();
    let axis = travel.cross(Vec3::Y).normalize_or(Vec3::X);
    let swing = 0.42 + 0.38 * run;
    let knee = 0.7 + 0.7 * run;
    let bob = 0.025 + 0.03 * run;
    pose_clip(rig, dur, 32, |ph| {
        let a = ph * TAU;
        let mut p = Pose::rest();
        p.hips += travel * speed * dur * ph;
        p.hips.y += -bob * (2.0 * a).cos() - 0.02 * run;
        p.set("Hips", Quat::from_rotation_y(0.08 * a.sin()));
        p.set("Spine", Quat::from_rotation_y(-0.1 * a.sin()) * Quat::from_rotation_x(-0.25 * run));
        p.set("Chest", Quat::from_rotation_y(-0.06 * a.sin()));
        p.set("Head", Quat::from_rotation_x(0.2 * run));
        for (side, sgn) in [("Left", 1.0f32), ("Right", -1.0)] {
            let leg = sgn * a.sin() * swing;
            let lift = (sgn * a.cos()).max(0.0);
            let thigh = Quat::from_axis_angle(axis, leg);
            let shin = Quat::from_rotation_x(-(0.08 + knee * lift * lift.sqrt()));
            p.set(&format!("{side}UpperLeg"), thigh);
            p.set(&format!("{side}LowerLeg"), shin);
            // Foot stays roughly level.
            p.set(&format!("{side}Foot"), (thigh * shin).inverse() * Quat::from_rotation_x(0.15 * lift));
            let arm = -sgn * a.sin() * (0.35 + 0.45 * run);
            let out = if side == "Left" { -0.1 } else { 0.1 };
            p.set(&format!("{side}UpperArm"), Quat::from_rotation_x(arm) * Quat::from_rotation_z(out));
            p.set(&format!("{side}LowerArm"), Quat::from_rotation_x(-(0.3 + 1.1 * run)));
        }
        p
    })
}

fn wave_clip(rig: &RigDef) -> AnimationClip {
    let n = 24;
    ClipBuilder::new(rig, 1.2)
        .rotation_fn("RightUpperArm", n, |ph| Quat::from_rotation_z(2.5 + 0.08 * (ph * TAU).sin()))
        .rotation_fn("RightLowerArm", n, |ph| Quat::from_rotation_z(0.45 * (ph * TAU * 2.0).sin()) * Quat::from_rotation_x(-0.4))
        .rotation_fn("RightHand", n, |ph| Quat::from_rotation_z(0.3 * (ph * TAU * 2.0).sin()))
        .rotation_fn("Head", n, |ph| Quat::from_rotation_z(-0.12 + 0.04 * (ph * TAU).sin()) * Quat::from_rotation_y(0.25))
        .build()
        .expect("wave clip")
}

/// Additive: rotation deltas only.
fn lean_clip(rig: &RigDef) -> AnimationClip {
    ClipBuilder::new(rig, 1.0)
        .rotation("Spine", &[(0.0, Quat::from_rotation_z(0.3)), (1.0, Quat::from_rotation_z(0.3))])
        .rotation("Chest", &[(0.0, Quat::from_rotation_z(0.2)), (1.0, Quat::from_rotation_z(0.2))])
        .build()
        .expect("lean clip")
}

fn hit_clip(rig: &RigDef) -> AnimationClip {
    pose_clip(rig, 0.6, 18, |ph| {
        let k = (ph * PI).sin() * (1.0 - ph).powf(0.5);
        let mut p = Pose::rest();
        p.hips.z += 0.08 * k;
        p.set("Spine", Quat::from_rotation_x(0.35 * k));
        p.set("Chest", Quat::from_rotation_x(0.3 * k));
        p.set("Head", Quat::from_rotation_x(0.4 * k));
        arms_down(&mut p, 0.12 + 0.6 * k);
        p.set("LeftLowerArm", Quat::from_rotation_x(-0.15 - 0.6 * k));
        p.set("RightLowerArm", Quat::from_rotation_x(-0.15 - 0.6 * k));
        p.set("LeftLowerLeg", Quat::from_rotation_x(-0.05 - 0.3 * k));
        p.set("RightLowerLeg", Quat::from_rotation_x(-0.05 - 0.3 * k));
        p.set("LeftUpperLeg", Quat::from_rotation_x(0.15 * k));
        p.set("RightUpperLeg", Quat::from_rotation_x(0.15 * k));
        p
    })
}
