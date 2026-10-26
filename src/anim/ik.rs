//! Procedural bone modifiers applied after the animation pose, before transform propagation:
//! [`LookAt`] (aim a bone axis at a point), [`TwoBoneIk`] (arms/legs reach a target, bending
//! towards a pole), [`SpringBone`] (secondary motion: tails, antennas, ponytails).
//!
//! Each component sits on the bone it drives. They compute fresh world transforms by walking up
//! the hierarchy (this frame's pose, not last frame's `GlobalTransform`), run in hierarchy depth
//! order, and always start from the animated pose (a bone no clip animates keeps its rest pose
//! as the base, so modifiers never accumulate). Bones of an [`super::Animator`] are skipped on
//! frames where LOD skipped the pose.

use bevy::animation::AnimatedBy;
use bevy::prelude::*;

use super::machine::Animator;

/// Remembers what a modifier wrote, to find the animated (or rest) input next frame.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Base<T> {
    base: T,
    wrote: T,
    valid: bool,
}

impl<T: Copy + PartialEq> Base<T> {
    /// The unmodified value: `cur` unless `cur` is exactly what we wrote last time.
    pub(crate) fn input(&mut self, cur: T) -> T {
        if !(self.valid && cur == self.wrote) {
            self.base = cur;
        }
        self.base
    }
    pub(crate) fn output(&mut self, v: T) {
        self.wrote = v;
        self.valid = true;
    }
}

/// Rotates the bone so its local `axis` points at `target` (world space).
#[derive(Component, Clone, Debug)]
pub struct LookAt {
    pub target: Vec3,
    /// Bone-local direction to aim (e.g. `Vec3::NEG_Z` for a head facing -Z in bind pose).
    pub axis: Vec3,
    pub weight: f32,
    /// Largest rotation away from the animated pose, radians.
    pub max_angle: f32,
    pub(crate) base: Base<Quat>,
    pub(crate) depth: Option<u16>,
}

impl LookAt {
    pub fn new(target: Vec3) -> Self {
        LookAt { target, axis: Vec3::NEG_Z, weight: 1.0, max_angle: 1.2, base: default(), depth: None }
    }
    pub fn axis(mut self, a: Vec3) -> Self {
        self.axis = a.normalize_or(Vec3::NEG_Z);
        self
    }
    pub fn weight(mut self, w: f32) -> Self {
        self.weight = w;
        self
    }
    pub fn max_angle(mut self, a: f32) -> Self {
        self.max_angle = a;
        self
    }
}

/// Two-bone IK on the bone it sits on (the tip: foot / hand); its parent is the middle joint
/// (knee / elbow) and grandparent the root (thigh / upper arm).
#[derive(Component, Clone, Debug)]
pub struct TwoBoneIk {
    /// World position the tip should reach.
    pub target: Vec3,
    /// World point the middle joint bends towards (knee forward, elbow back). `None`: keep the
    /// animated bend plane.
    pub pole: Option<Vec3>,
    /// Optional world rotation for the tip bone (foot flat on a slope).
    pub tip_rotation: Option<Quat>,
    pub weight: f32,
    pub(crate) bases: [Base<Quat>; 3],
}

impl TwoBoneIk {
    pub fn new(target: Vec3) -> Self {
        TwoBoneIk { target, pole: None, tip_rotation: None, weight: 1.0, bases: default() }
    }
    pub fn pole(mut self, p: Vec3) -> Self {
        self.pole = Some(p);
        self
    }
    pub fn weight(mut self, w: f32) -> Self {
        self.weight = w;
        self
    }
}

/// Spring-driven secondary motion: the bone's tip is a damped point mass pulled towards where
/// the animation puts it.
#[derive(Component, Clone, Debug)]
pub struct SpringBone {
    /// Pull towards the animated tip, 1/s² (higher = stiffer).
    pub stiffness: f32,
    /// Velocity damping, 1/s.
    pub damping: f32,
    /// Extra acceleration (world), e.g. `Vec3::new(0., -9.8, 0.) * 0.2` for droop.
    pub gravity: Vec3,
    /// Bone-local direction and distance to the tip (default: the first child's offset, else
    /// 0.1 m along +Y).
    pub tip: Option<Vec3>,
    pub(crate) state: Option<(Vec3, Vec3)>,
    pub(crate) base: Base<Quat>,
    pub(crate) depth: Option<u16>,
}

impl Default for SpringBone {
    fn default() -> Self {
        SpringBone { stiffness: 120.0, damping: 9.0, gravity: Vec3::ZERO, tip: None, state: None, base: default(), depth: None }
    }
}

impl SpringBone {
    pub fn new(stiffness: f32, damping: f32) -> Self {
        SpringBone { stiffness, damping, ..default() }
    }
}

// ---------------- math ----------------

/// Two-bone IK in world space. `a`, `b`, `c`: root, middle, tip joint positions; `t` target.
/// Returns the world-space rotations to apply to the root bone and to the middle bone
/// (`new_world = r * old_world` for each), solving exactly for reachable targets.
pub fn solve_two_bone(a: Vec3, b: Vec3, c: Vec3, t: Vec3, pole: Option<Vec3>) -> (Quat, Quat) {
    const EPS: f32 = 1e-5;
    let lab = (b - a).length();
    let lbc = (c - b).length();
    if lab < EPS || lbc < EPS {
        return (Quat::IDENTITY, Quat::IDENTITY);
    }
    let dist = (t - a).length().clamp((lab - lbc).abs() + 1e-4, (lab + lbc) * 0.9999).max(EPS);
    let cos_cur = (a - b).normalize().dot((c - b).normalize()).clamp(-1.0, 1.0);
    let cos_want = ((lab * lab + lbc * lbc - dist * dist) / (2.0 * lab * lbc)).clamp(-1.0, 1.0);
    let (cur, want) = (cos_cur.acos(), cos_want.acos());
    // Bend axis: the chain's plane, or the pole's when the chain is straight.
    let mut n = (b - a).cross(c - b);
    if n.length_squared() < 1e-10 {
        let hint = pole.map(|p| p - a).unwrap_or(Vec3::Z);
        n = (c - a).cross(hint);
        if n.length_squared() < 1e-10 {
            n = (c - a).any_orthonormal_vector();
        }
        // The pole twist below turns the bend plane towards the pole either way.
    }
    let n = n.normalize();
    let rb = Quat::from_axis_angle(n, cur - want);
    let c1 = b + rb * (c - b);
    let ra1 = Quat::from_rotation_arc((c1 - a).normalize(), (t - a).normalize_or((c1 - a).normalize()));
    let mut ra = ra1;
    if let Some(p) = pole {
        let axis = (t - a).normalize_or(Vec3::Y);
        let b2 = ra1 * (b - a);
        let pb = b2 - axis * b2.dot(axis);
        let pp = (p - a) - axis * (p - a).dot(axis);
        if pb.length_squared() > 1e-10 && pp.length_squared() > 1e-10 {
            let (pb, pp) = (pb.normalize(), pp.normalize());
            let ang = pb.cross(pp).dot(axis).atan2(pb.dot(pp));
            ra = Quat::from_axis_angle(axis, ang) * ra1;
        }
    }
    (ra, ra * rb)
}

/// Rotation (world) turning `from` towards `to`, limited to `max_angle` and scaled by `weight`.
pub fn aim_delta(from: Vec3, to: Vec3, max_angle: f32, weight: f32) -> Quat {
    let (f, t) = (from.normalize_or_zero(), to.normalize_or_zero());
    if f == Vec3::ZERO || t == Vec3::ZERO {
        return Quat::IDENTITY;
    }
    let q = Quat::from_rotation_arc(f, t);
    let ang = f.dot(t).clamp(-1.0, 1.0).acos();
    let limit = if ang > max_angle && ang > 1e-6 { max_angle / ang } else { 1.0 };
    Quat::IDENTITY.slerp(q, (limit * weight).clamp(0.0, 1.0))
}

// ---------------- hierarchy helpers ----------------

pub(crate) type TfQuery<'w, 's> = Query<'w, 's, (&'static mut Transform, Option<&'static ChildOf>)>;

/// This frame's world transform of `e` (walks up the parents' local transforms).
pub(crate) fn world_of(tfs: &TfQuery, e: Entity) -> Option<GlobalTransform> {
    let (tf, parent) = tfs.get(e).ok()?;
    let mut g = GlobalTransform::from(*tf);
    let mut cur = parent.map(ChildOf::parent);
    let mut guard = 0;
    while let Some(p) = cur {
        let Ok((ptf, pp)) = tfs.get(p) else { break };
        g = GlobalTransform::from(*ptf) * g;
        cur = pp.map(ChildOf::parent);
        guard += 1;
        if guard > 256 {
            break;
        }
    }
    Some(g)
}

pub(crate) fn parent_world(tfs: &TfQuery, e: Entity) -> GlobalTransform {
    tfs.get(e).ok().and_then(|(_, p)| p).and_then(|p| world_of(tfs, p.parent())).unwrap_or_default()
}

fn depth_of(tfs: &TfQuery, e: Entity) -> u16 {
    let mut d = 0;
    let mut cur = tfs.get(e).ok().and_then(|(_, p)| p.map(ChildOf::parent));
    while let Some(p) = cur {
        d += 1;
        cur = tfs.get(p).ok().and_then(|(_, pp)| pp.map(ChildOf::parent));
        if d > 256 {
            break;
        }
    }
    d
}

/// Skip bones whose animator didn't pose this frame (LOD).
fn skipped(by: Option<&AnimatedBy>, anims: &Query<&Animator>) -> bool {
    by.and_then(|b| anims.get(b.0).ok()).is_some_and(|a| !a.posed_this_frame())
}

/// Sets the local rotation of `e` so that its world rotation becomes `world_rot`.
fn set_world_rotation(tfs: &mut TfQuery, e: Entity, world_rot: Quat) -> Quat {
    let parent_rot = parent_world(tfs, e).rotation();
    let local = parent_rot.inverse() * world_rot;
    if let Ok((mut tf, _)) = tfs.get_mut(e) {
        tf.rotation = local.normalize();
    }
    local
}

// ---------------- systems ----------------

pub(crate) fn look_at(
    mut q: Query<(Entity, &mut LookAt, Option<&AnimatedBy>)>,
    mut tfs: TfQuery,
    anims: Query<&Animator>,
    mut order: Local<Vec<(u16, Entity)>>,
) {
    order.clear();
    for (e, mut la, by) in &mut q {
        if la.weight <= 0.0 || skipped(by, &anims) {
            continue;
        }
        let d = *la.depth.get_or_insert_with(|| depth_of(&tfs, e));
        order.push((d, e));
    }
    order.sort_unstable();
    for &(_, e) in order.iter() {
        let Ok((_, mut la, _)) = q.get_mut(e) else { continue };
        let Ok((tf, _)) = tfs.get(e) else { continue };
        let base = la.base.input(tf.rotation);
        if let Ok((mut tf, _)) = tfs.get_mut(e) {
            tf.rotation = base;
        }
        let Some(g) = world_of(&tfs, e) else { continue };
        let (_, rot, pos) = g.to_scale_rotation_translation();
        let delta = aim_delta(rot * la.axis, la.target - pos, la.max_angle, la.weight);
        let local = set_world_rotation(&mut tfs, e, delta * rot);
        la.base.output(local.normalize());
    }
}

pub(crate) fn two_bone_ik(mut q: Query<(Entity, &mut TwoBoneIk, Option<&AnimatedBy>)>, mut tfs: TfQuery, anims: Query<&Animator>) {
    for (tip, mut ik, by) in &mut q {
        if ik.weight <= 0.0 || skipped(by, &anims) {
            continue;
        }
        let Some(mid) = tfs.get(tip).ok().and_then(|(_, p)| p.map(ChildOf::parent)) else { continue };
        let Some(root) = tfs.get(mid).ok().and_then(|(_, p)| p.map(ChildOf::parent)) else { continue };
        // Restore animated inputs.
        for (k, e) in [root, mid, tip].into_iter().enumerate() {
            if let Ok((mut tf, _)) = tfs.get_mut(e) {
                let b = ik.bases[k].input(tf.rotation);
                tf.rotation = b;
            }
        }
        let (Some(ga), Some(gb), Some(gc)) = (world_of(&tfs, root), world_of(&tfs, mid), world_of(&tfs, tip)) else { continue };
        let (ra, rb) = solve_two_bone(ga.translation(), gb.translation(), gc.translation(), ik.target, ik.pole);
        let w = ik.weight.clamp(0.0, 1.0);
        let (ra, rb) = (Quat::IDENTITY.slerp(ra, w), Quat::IDENTITY.slerp(rb, w));
        let la = set_world_rotation(&mut tfs, root, ra * ga.rotation());
        let lb = set_world_rotation(&mut tfs, mid, rb * gb.rotation());
        ik.bases[0].output(la.normalize());
        ik.bases[1].output(lb.normalize());
        let tip_world = match ik.tip_rotation {
            Some(r) => gc.rotation().slerp(r, w),
            // Keep the tip's animated world rotation (feet stay level when the knee bends).
            None => gc.rotation(),
        };
        let lc = set_world_rotation(&mut tfs, tip, tip_world);
        ik.bases[2].output(lc.normalize());
    }
}

pub(crate) fn spring_bones(
    time: Res<Time>,
    mut q: Query<(Entity, &mut SpringBone, Option<&AnimatedBy>, Option<&Children>)>,
    mut tfs: TfQuery,
    anims: Query<&Animator>,
    mut order: Local<Vec<(u16, Entity)>>,
) {
    let dt = time.delta_secs().min(0.1);
    if dt <= 0.0 {
        return;
    }
    order.clear();
    for (e, mut sb, by, _) in &mut q {
        if skipped(by, &anims) {
            continue;
        }
        let d = *sb.depth.get_or_insert_with(|| depth_of(&tfs, e));
        order.push((d, e));
    }
    order.sort_unstable();
    for &(_, e) in order.iter() {
        let Ok((_, mut sb, _, children)) = q.get_mut(e) else { continue };
        let tip_local = sb.tip.unwrap_or_else(|| {
            children
                .and_then(|c| c.first())
                .and_then(|c| tfs.get(*c).ok())
                .map(|(t, _)| t.translation)
                .filter(|v| v.length_squared() > 1e-8)
                .unwrap_or(Vec3::Y * 0.1)
        });
        sb.tip = Some(tip_local);
        let len = tip_local.length().max(1e-4);
        let Ok((tf, _)) = tfs.get(e) else { continue };
        let base = sb.base.input(tf.rotation);
        if let Ok((mut tf, _)) = tfs.get_mut(e) {
            tf.rotation = base;
        }
        let Some(g) = world_of(&tfs, e) else { continue };
        let (_, rot, pos) = g.to_scale_rotation_translation();
        let goal = pos + rot * tip_local;
        let (mut x, mut v) = sb.state.unwrap_or((goal, Vec3::ZERO));
        if x.distance(goal) > len * 20.0 {
            (x, v) = (goal, Vec3::ZERO); // teleported
        }
        let steps = (dt / (1.0 / 120.0)).ceil().clamp(1.0, 12.0) as usize;
        let h = dt / steps as f32;
        for _ in 0..steps {
            let acc = (goal - x) * sb.stiffness - v * sb.damping + sb.gravity;
            v += acc * h;
            x += v * h;
            x = pos + (x - pos).normalize_or(goal - pos) * len;
        }
        sb.state = Some((x, v));
        let delta = Quat::from_rotation_arc((goal - pos).normalize_or(Vec3::Y), (x - pos).normalize_or(Vec3::Y));
        let local = set_world_rotation(&mut tfs, e, delta * rot);
        sb.base.output(local.normalize());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_bone_reaches_reachable_targets() {
        // Leg along -Y: hip at 1.0, knee at 0.55, ankle at 0.1.
        let (a, b, c) = (Vec3::new(0.0, 1.0, 0.0), Vec3::new(0.0, 0.55, -0.02), Vec3::new(0.0, 0.1, 0.0));
        for t in [Vec3::new(0.0, 0.3, -0.2), Vec3::new(0.2, 0.4, 0.1), Vec3::new(0.0, 0.15, 0.0), Vec3::new(-0.3, 0.5, -0.3)] {
            let pole = Some(Vec3::new(0.0, 0.55, -1.0));
            let (ra, rab) = solve_two_bone(a, b, c, t, pole);
            // Forward kinematics with the new rotations.
            let b2 = a + ra * (b - a);
            let c2 = b2 + rab * (c - b);
            assert!(c2.distance(t) < 1e-3, "target {t}: got {c2}");
            assert!(((b2 - a).length() - (b - a).length()).abs() < 1e-4, "bone length kept");
            // Knee bends forward (towards the pole at -Z).
            let mid = (a + t) * 0.5;
            assert!(b2.z < mid.z + 1e-3, "knee towards pole: {b2} vs {mid}");
        }
        // Unreachable: chain points straight at the target.
        let (ra, rab) = solve_two_bone(a, b, c, Vec3::new(0.0, -5.0, 0.0), None);
        let b2 = a + ra * (b - a);
        let c2 = b2 + rab * (c - b);
        assert!((c2 - a).normalize().dot(Vec3::NEG_Y) > 0.999, "{c2}");
    }

    #[test]
    fn aim_delta_limits_angle() {
        let q = aim_delta(Vec3::NEG_Z, Vec3::X, 0.5, 1.0);
        let ang = (q * Vec3::NEG_Z).angle_between(Vec3::NEG_Z);
        assert!((ang - 0.5).abs() < 1e-4, "{ang}");
        let q = aim_delta(Vec3::NEG_Z, Vec3::X, 3.0, 1.0);
        assert!((q * Vec3::NEG_Z).distance(Vec3::X) < 1e-4);
    }

    #[test]
    fn base_restores_animated_input() {
        let mut b = Base::<Quat>::default();
        let anim = Quat::from_rotation_x(0.3);
        assert_eq!(b.input(anim), anim);
        let wrote = Quat::from_rotation_x(0.8);
        b.output(wrote);
        // Nobody overwrote: base stays the animated value.
        assert_eq!(b.input(wrote), anim);
        // The animation wrote a new value.
        let anim2 = Quat::from_rotation_x(0.1);
        assert_eq!(b.input(anim2), anim2);
    }
}
