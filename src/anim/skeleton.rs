//! Skeletons: [`RigDef`] describes a bone hierarchy in code (and spawns it), [`Skeleton`] is the
//! runtime view of any animated hierarchy (procedural or glTF), with name lookup that tolerates
//! the usual naming schemes (`mixamorig:LeftUpLeg`, `thigh_l`, `upper_arm.L`, ...).

use std::borrow::Cow;
use std::hash::{Hash, Hasher};

use bevy::animation::{AnimatedBy, AnimationTargetId};
use bevy::prelude::*;

use super::clip::BoneIds;
use super::def::BoneMask;

/// One bone of a [`RigDef`]: rest transform relative to its parent (or to the rig root).
#[derive(Clone, Debug)]
pub struct RigBone {
    pub name: Cow<'static, str>,
    pub parent: Option<usize>,
    pub rest: Transform,
}

/// A bone hierarchy defined in code. Parents come before children.
#[derive(Clone, Debug, Default)]
pub struct RigDef {
    pub bones: Vec<RigBone>,
}

impl RigDef {
    pub fn new() -> Self {
        RigDef::default()
    }

    /// Adds a bone under `parent` (None: a root bone, child of the rig entity).
    /// Panics if `parent` isn't defined yet: rigs are code, a typo is a bug.
    pub fn bone(mut self, name: impl Into<Cow<'static, str>>, parent: Option<&str>, rest: Transform) -> Self {
        let parent = parent.map(|p| self.index(p).unwrap_or_else(|| panic!("RigDef: parent bone `{p}` not defined yet")));
        self.bones.push(RigBone { name: name.into(), parent, rest });
        self
    }

    pub fn index(&self, name: &str) -> Option<usize> {
        self.bones.iter().position(|b| b.name == name)
    }

    /// Bone names from the root bone down to `i` (the `AnimationTargetId` path).
    pub fn path(&self, i: usize) -> Vec<&str> {
        let mut p = vec![&*self.bones[i].name];
        let mut cur = self.bones[i].parent;
        while let Some(c) = cur {
            p.push(&self.bones[c].name);
            cur = self.bones[c].parent;
        }
        p.reverse();
        p
    }

    pub fn target(&self, i: usize) -> AnimationTargetId {
        AnimationTargetId::from_iter(self.path(i))
    }

    /// Bind-pose transforms in rig (model) space, by bone index.
    pub fn model_space(&self) -> Vec<GlobalTransform> {
        let mut out: Vec<GlobalTransform> = Vec::with_capacity(self.bones.len());
        for b in &self.bones {
            let g = match b.parent {
                Some(p) => out[p] * b.rest,
                None => GlobalTransform::from(b.rest),
            };
            out.push(g);
        }
        out
    }

    /// Spawns the bones under `root` (which gets / must have the `AnimationPlayer`): each bone
    /// has `Name`, its rest `Transform`, `AnimationTargetId` and `AnimatedBy(root)`. Returns
    /// the bone entities by index.
    pub fn spawn(&self, commands: &mut Commands, root: Entity) -> Vec<Entity> {
        let mut ents: Vec<Entity> = Vec::with_capacity(self.bones.len());
        for (i, b) in self.bones.iter().enumerate() {
            let parent = b.parent.map(|p| ents[p]).unwrap_or(root);
            let e = commands
                .spawn((Name::new(b.name.clone()), b.rest, self.target(i), AnimatedBy(root), ChildOf(parent)))
                .id();
            ents.push(e);
        }
        ents
    }
}

impl BoneIds for RigDef {
    fn target_id(&self, bone: &str) -> Option<AnimationTargetId> {
        self.index(bone).map(|i| self.target(i))
    }
    fn bone_names(&self) -> Vec<String> {
        self.bones.iter().map(|b| b.name.to_string()).collect()
    }
}

/// A bone of a bound [`Skeleton`].
#[derive(Clone, Debug)]
pub struct Bone {
    pub name: String,
    pub entity: Entity,
    pub parent: Option<u16>,
    pub target: AnimationTargetId,
    /// Local transform when the skeleton was built (bind / rest pose for fresh spawns).
    pub rest: Transform,
    pub depth: u16,
}

/// The animated bones under an [`super::Animator`], built automatically once the hierarchy
/// exists (bones = descendants with `AnimationTargetId` + `AnimatedBy(this)`), in hierarchy
/// order (parents first). Also lists skinned meshes driven by these bones (for visibility LOD).
#[derive(Component, Clone, Debug, Default)]
pub struct Skeleton {
    pub bones: Vec<Bone>,
    pub meshes: Vec<Entity>,
    pub(crate) signature: u64,
}

impl Skeleton {
    pub fn from_bones(bones: Vec<Bone>, meshes: Vec<Entity>) -> Self {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for b in &bones {
            b.target.hash(&mut h);
            b.parent.hash(&mut h);
        }
        Skeleton { bones, meshes, signature: h.finish() }
    }

    /// Exact name match.
    pub fn index(&self, name: &str) -> Option<usize> {
        self.bones.iter().position(|b| b.name == name)
    }

    /// Exact name, then case/prefix/separator-insensitive (`mixamorig:Spine` ~ `spine`), then a
    /// bone whose normalized name ends with the query. For sided limbs across naming schemes
    /// (`LeftUpLeg` vs `thigh_l`) use [`Self::humanoid`].
    pub fn find(&self, name: &str) -> Option<usize> {
        if let Some(i) = self.index(name) {
            return Some(i);
        }
        let q = normalize(name);
        if q.is_empty() {
            return None;
        }
        self.bones
            .iter()
            .position(|b| normalize(&b.name) == q)
            .or_else(|| self.bones.iter().position(|b| normalize(&b.name).ends_with(&q)))
    }

    pub fn entity(&self, name: &str) -> Option<Entity> {
        self.find(name).map(|i| self.bones[i].entity)
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.bones.iter().map(|b| b.name.as_str())
    }

    /// `true` for `i` if bone `i` is `ancestor` or below it.
    pub fn is_under(&self, mut i: usize, ancestor: usize) -> bool {
        loop {
            if i == ancestor {
                return true;
            }
            match self.bones[i].parent {
                Some(p) => i = p as usize,
                None => return false,
            }
        }
    }

    /// Per-bone membership of a [`BoneMask`]; unknown names are an error.
    pub fn mask_set(&self, mask: &BoneMask) -> Result<Vec<bool>, String> {
        let look = |n: &str| self.find(n).ok_or_else(|| format!("mask bone `{n}` not in skeleton ({})", self.names().collect::<Vec<_>>().join(", ")));
        let subs: Vec<usize> = mask.subtrees.iter().map(|n| look(n)).collect::<Result<_, _>>()?;
        let ones: Vec<usize> = mask.bones.iter().map(|n| look(n)).collect::<Result<_, _>>()?;
        let outs: Vec<usize> = mask.without.iter().map(|n| look(n)).collect::<Result<_, _>>()?;
        Ok((0..self.bones.len())
            .map(|i| {
                let inc = ones.contains(&i) || subs.iter().any(|&s| self.is_under(i, s));
                inc && !outs.iter().any(|&o| self.is_under(i, o))
            })
            .collect())
    }

    /// Common humanoid bones found by name heuristics (Mixamo, Unreal, Blender/Rigify, VRM-ish
    /// and this engine's mannequin names).
    pub fn humanoid(&self) -> Humanoid {
        let parsed: Vec<(Side, String)> = self.bones.iter().map(|b| parse_side(&b.name)).collect();
        let pick = |side: Side, syn: &[&str]| -> Option<Entity> {
            for s in syn {
                if let Some(i) = parsed.iter().position(|(sd, body)| *sd == side && body == s) {
                    return Some(self.bones[i].entity);
                }
            }
            None
        };
        use Side::*;
        Humanoid {
            hips: pick(Center, &["hips", "pelvis", "hip"]),
            spine: pick(Center, &["spine", "spine01", "spine0"]),
            chest: pick(Center, &["chest", "upperchest", "spine2", "spine02", "spine1", "spine01"]),
            neck: pick(Center, &["neck", "neck01", "neck1"]),
            head: pick(Center, &["head"]),
            upper_arm: [pick(Left, &["upperarm", "arm"]), pick(Right, &["upperarm", "arm"])],
            lower_arm: [pick(Left, &["lowerarm", "forearm", "elbow"]), pick(Right, &["lowerarm", "forearm", "elbow"])],
            hand: [pick(Left, &["hand", "wrist"]), pick(Right, &["hand", "wrist"])],
            upper_leg: [pick(Left, &["upperleg", "upleg", "thigh"]), pick(Right, &["upperleg", "upleg", "thigh"])],
            lower_leg: [pick(Left, &["lowerleg", "leg", "calf", "shin", "knee"]), pick(Right, &["lowerleg", "leg", "calf", "shin", "knee"])],
            foot: [pick(Left, &["foot", "ankle"]), pick(Right, &["foot", "ankle"])],
        }
    }
}

impl BoneIds for Skeleton {
    fn target_id(&self, bone: &str) -> Option<AnimationTargetId> {
        self.find(bone).map(|i| self.bones[i].target)
    }
    fn bone_names(&self) -> Vec<String> {
        self.bones.iter().map(|b| b.name.clone()).collect()
    }
}

/// Humanoid bone entities; `[left, right]` for limbs.
#[derive(Clone, Copy, Debug, Default)]
pub struct Humanoid {
    pub hips: Option<Entity>,
    pub spine: Option<Entity>,
    pub chest: Option<Entity>,
    pub neck: Option<Entity>,
    pub head: Option<Entity>,
    pub upper_arm: [Option<Entity>; 2],
    pub lower_arm: [Option<Entity>; 2],
    pub hand: [Option<Entity>; 2],
    pub upper_leg: [Option<Entity>; 2],
    pub lower_leg: [Option<Entity>; 2],
    pub foot: [Option<Entity>; 2],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
    Center,
    Left,
    Right,
}

/// Lowercase, without a `prefix:` / `Armature|` namespace and without separators.
pub fn normalize(name: &str) -> String {
    let n = name.rsplit([':', '|']).next().unwrap_or(name);
    n.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Splits a bone name into tokens (separators and camelCase), pulls out a side token.
fn parse_side(name: &str) -> (Side, String) {
    let n = name.rsplit([':', '|']).next().unwrap_or(name);
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in n.chars() {
        if !c.is_alphanumeric() {
            if !cur.is_empty() {
                tokens.push(std::mem::take(&mut cur));
            }
            prev_lower = false;
            continue;
        }
        if c.is_uppercase() && prev_lower && !cur.is_empty() {
            tokens.push(std::mem::take(&mut cur));
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        cur.extend(c.to_lowercase());
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    let mut side = Side::Center;
    let mut body = String::new();
    for t in &tokens {
        match t.as_str() {
            "l" | "left" => side = Side::Left,
            "r" | "right" => side = Side::Right,
            _ => body.push_str(t),
        }
    }
    (side, body)
}

/// Collects the skeleton under `root` (see [`Skeleton`]). Empty when nothing is spawned yet.
pub(crate) fn collect(
    root: Entity,
    nodes: &Query<(Option<&Children>, Option<&AnimationTargetId>, Option<&AnimatedBy>, Option<&Name>, &Transform)>,
    skinned: &Query<&bevy::mesh::skinning::SkinnedMesh>,
    parents: &Query<&ChildOf>,
) -> Skeleton {
    let mut bones: Vec<Bone> = Vec::new();
    // (entity, parent bone index, depth)
    let mut stack: Vec<(Entity, Option<u16>, u16)> = vec![(root, None, 0)];
    let mut meshes = Vec::new();
    while let Some((e, parent_bone, depth)) = stack.pop() {
        let Ok((children, target, by, name, tf)) = nodes.get(e) else { continue };
        let mut me = parent_bone;
        if let (Some(t), Some(by)) = (target, by)
            && by.0 == root
        {
            bones.push(Bone {
                name: name.map(|n| n.as_str().to_string()).unwrap_or_else(|| format!("{e}")),
                entity: e,
                parent: parent_bone,
                target: *t,
                rest: *tf,
                depth,
            });
            me = Some((bones.len() - 1) as u16);
        }
        if skinned.contains(e) {
            meshes.push(e);
        }
        if let Some(ch) = children {
            // Reverse so siblings come out in order.
            for c in ch.iter().rev() {
                stack.push((c, me, depth + 1));
            }
        }
    }
    // glTF puts skinned meshes next to the armature: look under the root's parent too.
    if let Ok(p) = parents.get(root) {
        let mut stack = vec![p.parent()];
        let mut guard = 0;
        while let Some(e) = stack.pop() {
            guard += 1;
            if guard > 4096 {
                break;
            }
            if e == root {
                continue;
            }
            if let Ok(sm) = skinned.get(e)
                && !meshes.contains(&e)
                && sm.joints.iter().any(|j| bones.iter().any(|b| b.entity == *j))
            {
                meshes.push(e);
            }
            if let Ok((Some(ch), ..)) = nodes.get(e) {
                stack.extend(ch.iter());
            }
        }
    }
    Skeleton::from_bones(bones, meshes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skel(names: &[&str]) -> Skeleton {
        let bones = names
            .iter()
            .enumerate()
            .map(|(i, n)| Bone {
                name: n.to_string(),
                entity: Entity::from_raw_u32(i as u32 + 1).unwrap(),
                parent: if i == 0 { None } else { Some(0) },
                target: AnimationTargetId::from_name(&Name::new(n.to_string())),
                rest: Transform::IDENTITY,
                depth: (i > 0) as u16,
            })
            .collect();
        Skeleton::from_bones(bones, vec![])
    }

    #[test]
    fn humanoid_names_across_conventions() {
        let mixamo = skel(&["mixamorig:Hips", "mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2", "mixamorig:LeftUpLeg", "mixamorig:LeftLeg", "mixamorig:RightFoot", "mixamorig:LeftForeArm"]);
        let h = mixamo.humanoid();
        assert_eq!(h.hips, Some(mixamo.bones[0].entity));
        assert_eq!(h.chest, Some(mixamo.bones[3].entity));
        assert_eq!(h.upper_leg[0], Some(mixamo.bones[4].entity));
        assert_eq!(h.lower_leg[0], Some(mixamo.bones[5].entity));
        assert_eq!(h.foot[1], Some(mixamo.bones[6].entity));
        assert_eq!(h.lower_arm[0], Some(mixamo.bones[7].entity));
        assert_eq!(h.foot[0], None);

        let ue = skel(&["pelvis", "spine_01", "thigh_l", "calf_r", "foot_l", "upperarm_r", "hand_l"]);
        let h = ue.humanoid();
        assert_eq!(h.hips, Some(ue.bones[0].entity));
        assert_eq!(h.upper_leg[0], Some(ue.bones[2].entity));
        assert_eq!(h.lower_leg[1], Some(ue.bones[3].entity));
        assert_eq!(h.upper_arm[1], Some(ue.bones[5].entity));

        let rigify = skel(&["hips", "thigh.L", "shin.R", "upper_arm.L", "forearm.R"]);
        let h = rigify.humanoid();
        assert_eq!(h.upper_leg[0], Some(rigify.bones[1].entity));
        assert_eq!(h.lower_leg[1], Some(rigify.bones[2].entity));
        assert_eq!(h.upper_arm[0], Some(rigify.bones[3].entity));

        assert_eq!(mixamo.find("spine2"), Some(3));
        assert_eq!(mixamo.find("Hips"), Some(0));
    }

    #[test]
    fn mask_set_subtrees() {
        let rig = RigDef::new()
            .bone("Hips", None, Transform::IDENTITY)
            .bone("Spine", Some("Hips"), Transform::IDENTITY)
            .bone("Arm", Some("Spine"), Transform::IDENTITY)
            .bone("Hand", Some("Arm"), Transform::IDENTITY)
            .bone("Leg", Some("Hips"), Transform::IDENTITY);
        let bones = rig
            .bones
            .iter()
            .enumerate()
            .map(|(i, b)| Bone {
                name: b.name.to_string(),
                entity: Entity::from_raw_u32(i as u32 + 1).unwrap(),
                parent: b.parent.map(|p| p as u16),
                target: rig.target(i),
                rest: b.rest,
                depth: 0,
            })
            .collect();
        let s = Skeleton::from_bones(bones, vec![]);
        let m = s.mask_set(&BoneMask::subtree("Spine").without("Hand")).unwrap();
        assert_eq!(m, [false, true, true, false, false]);
        assert!(s.mask_set(&BoneMask::subtree("Tail")).is_err());
        assert_eq!(rig.path(3), ["Hips", "Spine", "Arm", "Hand"]);
    }
}
