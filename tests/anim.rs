//! Animation end to end, headless through `App::update()`: procedural mannequin (rig + clips in
//! code, no assets) driven by its graph; checks bone poses against the clips, crossfades,
//! masks, additive layers, root motion, notifies, IK, look-at, springs, LOD, foot placement and
//! the control commands.
#![cfg(feature = "anim")]

use std::path::PathBuf;
use std::time::Duration;

use bevy::animation::graph::AnimationGraphHandle;
use bevy::animation::{AnimationClip, AnimationTargetId, animated_field};
use bevy::ecs::message::Messages;
use engine::anim::mannequin::{MannequinRig, WALK_SPEED};
use engine::anim::*;
use engine::prelude::*;

const STEP: Duration = Duration::from_nanos(16_666_667);
const DT: f32 = 1.0 / 60.0;

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("engine-anim-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

struct Harness {
    app: App,
    clips: MannequinClips,
    def: std::sync::Arc<AnimGraphDef>,
    dir: PathBuf,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn setup(tag: &str) -> Harness {
    let dir = temp_dir(tag);
    let mut app = engine::app_with(GameInfo::new("anim-test", "Anim test"), EngineOptions::headless_test(&dir));
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(STEP));
    app.finish();
    app.cleanup();
    app.update();
    let clips = Mannequin::clips(&mut app.world_mut().resource_mut::<Assets<AnimationClip>>());
    let def = Mannequin::graph(&clips);
    Harness { app, clips, def, dir }
}

impl Harness {
    fn spawn(&mut self, tf: Transform) -> MannequinRig {
        let def = self.def.clone();
        let world = self.app.world_mut();
        let mut commands = world.commands();
        let rig = Mannequin::spawn(&mut commands, def, tf, None);
        world.flush();
        rig
    }
    fn run(&mut self, frames: usize) {
        for _ in 0..frames {
            self.app.update();
        }
    }
    fn secs(&mut self, s: f32) {
        self.run((s / DT).round() as usize);
    }
    fn anim(&self, e: Entity) -> &Animator {
        self.app.world().get::<Animator>(e).unwrap()
    }
    fn anim_mut(&mut self, e: Entity) -> Mut<'_, Animator> {
        self.app.world_mut().get_mut::<Animator>(e).unwrap()
    }
    fn tf(&self, e: Entity) -> Transform {
        *self.app.world().get::<Transform>(e).unwrap()
    }
    fn world_pos(&self, e: Entity) -> Vec3 {
        self.app.world().get::<GlobalTransform>(e).unwrap().translation()
    }
    fn clip(&self, h: &Handle<AnimationClip>) -> AnimationClip {
        self.app.world().resource::<Assets<AnimationClip>>().get(h).unwrap().clone()
    }
    /// Rotation `clip` gives `bone` at `t` seconds.
    fn sample(&self, h: &Handle<AnimationClip>, bone: &str, t: f32) -> Quat {
        let rig = Mannequin::rig();
        let id: AnimationTargetId = rig.target(rig.index(bone).unwrap());
        self.clip(h).sample_clamped(animated_field!(Transform::rotation), id, t).unwrap()
    }
}

fn qclose(a: Quat, b: Quat, tol: f32) -> bool {
    a.dot(b).abs() > 1.0 - tol
}

#[test]
fn binds_and_poses_bones_from_clips() {
    let mut w = setup("pose");
    let rig = w.spawn(Transform::default());
    w.run(3);
    let a = w.anim(rig.root);
    assert!(a.is_bound(), "bound after the hierarchy and clips exist");
    let skel = w.app.world().get::<Skeleton>(rig.root).expect("skeleton built");
    assert_eq!(skel.bones.len(), Mannequin::rig().bones.len());
    assert!(w.app.world().get::<AnimationGraphHandle>(rig.root).is_some());

    // Idle: every pose bone matches the idle clip at the animator's clock.
    w.run(30);
    let a = w.anim(rig.root);
    assert_eq!(a.current_state(0), "locomotion");
    let (ws, ts) = a.slot_weights(0);
    assert!((ws[0] - 1.0).abs() < 1e-5, "idle sample only: {ws:?}");
    let t = ts[0];
    let idle = w.clips.idle.clone();
    for bone in ["Chest", "Head", "LeftUpperArm", "RightLowerLeg"] {
        let want = w.sample(&idle, bone, t);
        let got = w.tf(rig.bone(bone)).rotation;
        assert!(qclose(got, want, 1e-5), "{bone}: {got} vs clip {want} at {t}");
    }
    // Walk: blend space at the walk sample.
    w.anim_mut(rig.root).set_float("vel_z", WALK_SPEED);
    w.run(40);
    let (ws, ts) = w.anim(rig.root).slot_weights(0);
    assert!((ws[1] - 1.0).abs() < 1e-4, "walk only: {ws:?}");
    let t = ts[1];
    let walk = w.clips.walk.clone();
    for bone in ["LeftUpperLeg", "RightLowerLeg", "LeftUpperArm"] {
        let want = w.sample(&walk, bone, t);
        assert!(qclose(w.tf(rig.bone(bone)).rotation, want, 1e-5), "{bone} follows walk");
    }
}

#[test]
fn blend_space_and_crossfade_weights() {
    let mut w = setup("blend");
    let rig = w.spawn(Transform::default());
    w.run(5);
    // Halfway between walk and run speeds, straight ahead.
    w.anim_mut(rig.root).set_float("vel_z", (WALK_SPEED + 3.8) * 0.5);
    w.run(10);
    let (ws, _) = w.anim(rig.root).slot_weights(0);
    assert!((ws[1] - 0.5).abs() < 0.05 && (ws[2] - 0.5).abs() < 0.05, "walk/run halves: {ws:?}");
    // Hit trigger: crossfade into hit, back to locomotion after its exit time.
    w.anim_mut(rig.root).trigger("hit");
    w.run(2);
    let a = w.anim(rig.root);
    assert_eq!(a.current_state(0), "hit");
    assert!(a.in_transition(0));
    let total: f32 = a.playing(0).map(|p| p.1).sum();
    assert!((total - 1.0).abs() < 1e-4);
    w.secs(0.6);
    assert_eq!(w.anim(rig.root).current_state(0), "locomotion");
}

#[test]
fn mask_overlay_and_additive_layers() {
    let mut w = setup("layers");
    let rig = w.spawn(Transform::default());
    w.run(10);
    let leg_before = w.tf(rig.bone("LeftUpperLeg")).rotation;
    // Full wave: the right arm follows the wave clip, the legs (outside the mask) don't.
    w.anim_mut(rig.root).set_float("wave", 1.0);
    w.run(1);
    let (_, ts) = w.anim(rig.root).slot_weights(1);
    let t = ts[0];
    let want = w.sample(&w.clips.wave.clone(), "RightUpperArm", t);
    let got = w.tf(rig.bone("RightUpperArm")).rotation;
    assert!(qclose(got, want, 1e-4), "arm waves: {got} vs {want}");
    let (_, ts0) = w.anim(rig.root).slot_weights(0);
    let leg_want = w.sample(&w.clips.idle.clone(), "LeftUpperLeg", ts0[0]);
    assert!(qclose(w.tf(rig.bone("LeftUpperLeg")).rotation, leg_want, 1e-5), "legs masked out of the wave layer");
    let _ = leg_before;

    // Half wave: halfway between idle and wave.
    w.anim_mut(rig.root).set_float("wave", 0.5);
    w.run(1);
    let (_, t0) = w.anim(rig.root).slot_weights(0);
    let (_, t1) = w.anim(rig.root).slot_weights(1);
    let base = w.sample(&w.clips.idle.clone(), "RightUpperArm", t0[0]);
    let wave = w.sample(&w.clips.wave.clone(), "RightUpperArm", t1[0]);
    let want = base.slerp(wave, 0.5);
    let got = w.tf(rig.bone("RightUpperArm")).rotation;
    assert!(qclose(got, want, 2e-3), "half override: {got} vs {want}");

    // Additive lean on top: spine = Rz(0.3) * base.
    w.anim_mut(rig.root).set_float("wave", 0.0);
    w.anim_mut(rig.root).set_float("lean", 1.0);
    w.run(1);
    let (_, t0) = w.anim(rig.root).slot_weights(0);
    let base = w.sample(&w.clips.idle.clone(), "Spine", t0[0]);
    let got = w.tf(rig.bone("Spine")).rotation;
    let want = Quat::from_rotation_z(0.3) * base;
    assert!(qclose(got, want, 1e-4), "additive lean: {got} vs {want}");
}

#[test]
fn root_motion_moves_the_character_and_locks_hips() {
    let mut w = setup("root");
    let rig = w.spawn(Transform::from_xyz(2.0, 0.0, 0.0));
    w.app.world_mut().entity_mut(rig.root).insert(RootMotion::default());
    w.run(3);
    w.anim_mut(rig.root).set_float("vel_z", WALK_SPEED);
    w.secs(0.5); // fade into walk
    let p0 = w.tf(rig.root).translation;
    w.secs(2.0);
    let p1 = w.tf(rig.root).translation;
    let moved = p1 - p0;
    assert!((moved.z + WALK_SPEED * 2.0).abs() < 0.08, "walked 2 s at 1.4 m/s towards -Z: {moved}");
    assert!(moved.x.abs() < 0.02 && moved.y.abs() < 1e-4, "{moved}");
    // Hips stay over the root (horizontal travel taken out of the pose).
    let hips = w.tf(rig.bone("Hips")).translation;
    assert!(hips.x.abs() < 1e-3 && hips.z.abs() < 1e-3, "hips locked: {hips}");
    let d = w.app.world().get::<RootMotionDelta>(rig.root).unwrap();
    assert!((d.velocity().z + WALK_SPEED).abs() < 0.05, "velocity readout {}", d.velocity());

    // Rotated character walks along its own forward.
    let mut w = setup("root-rot");
    let rig = w.spawn(Transform::from_rotation(Quat::from_rotation_y(std::f32::consts::FRAC_PI_2)));
    w.app.world_mut().entity_mut(rig.root).insert(RootMotion::delta());
    w.run(3);
    w.anim_mut(rig.root).set_float("vel_z", WALK_SPEED);
    w.secs(1.0);
    let (moved, _) = w.app.world_mut().get_mut::<RootMotionDelta>(rig.root).unwrap().take();
    assert!(moved.x < -0.8 && moved.z.abs() < 0.05, "forward is -X after a 90° turn: {moved}");
    assert_eq!(w.tf(rig.root).translation, Vec3::ZERO, "delta mode doesn't move the transform");
}

#[test]
fn footstep_notifies_arrive_as_messages() {
    let mut w = setup("notify");
    let rig = w.spawn(Transform::default());
    w.run(3);
    w.anim_mut(rig.root).set_float("vel_z", WALK_SPEED);
    w.secs(0.5);
    // Drain, then collect 2 s of messages.
    let mut seen: Vec<(u32, String, Entity)> = Vec::new();
    let mut cursor = w.app.world().resource::<Messages<AnimNotify>>().get_cursor_current();
    for f in 0..120u32 {
        w.app.update();
        let msgs = w.app.world().resource::<Messages<AnimNotify>>();
        for m in cursor.read(msgs) {
            seen.push((f, m.name.to_string(), m.entity));
        }
    }
    let names: Vec<&str> = seen.iter().map(|s| s.1.as_str()).collect();
    assert_eq!(names.len(), 4, "2 steps per 1 s cycle: {seen:?}");
    for pair in names.windows(2) {
        assert_ne!(pair[0], pair[1], "alternating feet: {names:?}");
    }
    assert!(seen.iter().all(|s| s.2 == rig.root));
    // Half a cycle (0.5 s = 30 frames) apart.
    let gap = seen[1].0 - seen[0].0;
    assert!((29..=31).contains(&gap), "{seen:?}");
}

#[test]
fn ik_look_at_and_springs() {
    let mut w = setup("ik");
    let rig = w.spawn(Transform::default());
    let foot = rig.bone("LeftFoot");
    let head = rig.bone("Head");
    let tip = rig.bone("Antenna2");
    w.run(3);
    let rest_foot = w.world_pos(foot);
    let target = rest_foot + Vec3::new(0.05, 0.25, -0.15);
    w.app.world_mut().entity_mut(foot).insert(TwoBoneIk::new(target).pole(Vec3::new(-0.1, 0.5, -2.0)));
    let look = Vec3::new(3.0, 1.6, -3.0);
    w.app.world_mut().entity_mut(head).insert(LookAt::new(look).max_angle(1.5));
    w.app.world_mut().entity_mut(rig.bone("Antenna1")).insert(SpringBone::new(80.0, 6.0));
    w.app.world_mut().entity_mut(tip).insert(SpringBone::new(80.0, 6.0));
    w.run(5);
    let got = w.world_pos(foot);
    assert!(got.distance(target) < 0.01, "foot reaches IK target: {got} vs {target}");
    // Knee bends forward (-Z) towards the pole.
    let knee = w.world_pos(rig.bone("LeftLowerLeg"));
    assert!(knee.z < w.world_pos(rig.bone("LeftUpperLeg")).z, "knee forward: {knee}");
    // Head's -Z points at the target.
    let g = w.app.world().get::<GlobalTransform>(head).unwrap();
    let fwd = g.rotation() * Vec3::NEG_Z;
    let to = (look - g.translation()).normalize();
    assert!(fwd.dot(to) > 0.995, "head looks at the target: {fwd} vs {to}");
    // IK doesn't accumulate: the result is stable frame to frame.
    let r1 = w.tf(rig.bone("LeftUpperLeg")).rotation;
    w.run(1);
    assert!(qclose(w.tf(rig.bone("LeftUpperLeg")).rotation, r1, 1e-3));

    // Springs: a sudden move makes the antenna lag, then it settles back to the pose.
    let a0 = w.world_pos(rig.bone("Antenna3")) - w.world_pos(head);
    w.app.world_mut().get_mut::<Transform>(rig.root).unwrap().translation.x += 0.3;
    w.run(2);
    let a1 = w.world_pos(rig.bone("Antenna3")) - w.world_pos(head);
    assert!(a1.distance(a0) > 0.01, "antenna lags: {a0} → {a1}");
    w.secs(2.0);
    let a2 = w.world_pos(rig.bone("Antenna3")) - w.world_pos(head);
    assert!(a2.distance(a0) < 0.02, "settles: {a0} vs {a2}");
}

#[test]
fn lod_skips_pose_updates_for_far_characters() {
    let mut w = setup("lod");
    let near = w.spawn(Transform::from_xyz(0.0, 0.0, -5.0));
    let far = w.spawn(Transform::from_xyz(0.0, 0.0, -100.0));
    w.app.world_mut().spawn((MainCamera, Transform::default(), GlobalTransform::default()));
    w.run(5);
    assert_eq!(w.anim(near.root).lod_interval(), 1);
    assert_eq!(w.anim(far.root).lod_interval(), 8);
    let mut posed = 0;
    let mut changes = 0;
    let mut last = w.tf(far.bone("Chest")).rotation;
    for _ in 0..64 {
        w.app.update();
        let a = w.anim(far.root);
        posed += a.posed_this_frame() as u32;
        let r = w.tf(far.bone("Chest")).rotation;
        if r != last {
            changes += 1;
        }
        last = r;
        assert!(w.anim(near.root).posed_this_frame());
    }
    assert_eq!(posed, 8, "far: one pose in 8 frames");
    assert!((7..=8).contains(&changes), "pose only changes on posed frames: {changes}");
    // The state machine still runs every frame (time keeps flowing).
    let t0 = w.anim(far.root).state_time(0);
    w.app.update();
    assert!(w.anim(far.root).state_time(0) > t0);
    // Turning LOD off poses every frame.
    w.app.world_mut().resource_mut::<AnimConfig>().lod.enabled = false;
    w.run(2);
    assert_eq!(w.anim(far.root).lod_interval(), 1);
}

#[test]
fn scene_animator_attaches_to_nested_player() {
    // A glTF-like hierarchy: scene root → armature node with the AnimationPlayer → bones.
    let mut w = setup("scene");
    let def = w.def.clone();
    let world = w.app.world_mut();
    let scene = world.spawn((Transform::default(), AnimateScene(def))).id();
    let armature = world.spawn((Transform::default(), AnimationPlayer::default(), ChildOf(scene))).id();
    let mut commands = world.commands();
    Mannequin::rig().spawn(&mut commands, armature);
    world.flush();
    w.run(4);
    let a = w.app.world().get::<Animator>(armature).expect("animator attached to the player entity");
    assert!(a.is_bound());
    assert!(w.app.world().get::<AnimateScene>(scene).is_none());
}

#[cfg(feature = "physics")]
#[test]
fn foot_placement_lifts_foot_onto_a_step() {
    use engine::avian3d::prelude::{Collider, RigidBody};
    let mut w = setup("feet");
    // Flat ground at y = 0 and a 0.2 m step under the left foot (left = -X).
    w.app.world_mut().spawn((RigidBody::Static, Collider::cuboid(10.0, 0.2, 10.0), Transform::from_xyz(0.0, -0.1, 0.0)));
    w.app.world_mut().spawn((RigidBody::Static, Collider::cuboid(0.3, 0.2, 0.6), Transform::from_xyz(-0.1, 0.1, 0.0)));
    let rig = w.spawn(Transform::default());
    let (l, r) = (rig.bone("LeftFoot"), rig.bone("RightFoot"));
    w.run(3);
    let rest_l = w.world_pos(l);
    let rest_r = w.world_pos(r);
    for f in [l, r] {
        w.app.world_mut().entity_mut(f).insert(TwoBoneIk::new(Vec3::ZERO).weight(0.0).pole(Vec3::new(0.0, 0.5, -3.0)));
    }
    w.app.world_mut().entity_mut(rig.root).insert(FootPlacement::new(vec![l, r], Some(rig.bone("Hips"))));
    w.secs(1.5);
    let (pl, pr) = (w.world_pos(l), w.world_pos(r));
    assert!((pl.y - rest_l.y - 0.2).abs() < 0.03, "left foot on the step: {} → {}", rest_l.y, pl.y);
    assert!((pr.y - rest_r.y).abs() < 0.03, "right foot on the ground: {} → {}", rest_r.y, pr.y);
}

#[cfg(feature = "devtools")]
#[test]
fn control_commands() {
    use engine::devtools::ControlRegistry;
    use engine::devtools::control::Handler;
    use serde_json::{Value, json};
    let mut w = setup("cmd");
    w.spawn(Transform::default());
    w.run(3);
    let call = |w: &mut Harness, id: &str, p: Value| -> Result<Value, String> {
        let h = w.app.world().resource::<ControlRegistry>().get(id).unwrap_or_else(|| panic!("{id} registered")).handler;
        match h {
            Handler::Instant(f) => f(w.app.world_mut(), p),
            Handler::Deferred(_) => panic!("instant expected"),
        }
    };
    let list = call(&mut w, "anim.list", json!({})).unwrap();
    assert_eq!(list["animators"].as_array().unwrap().len(), 1);
    let id = list["animators"][0]["id"].as_u64().unwrap();
    call(&mut w, "anim.param", json!({"entity": id, "name": "vel_z", "value": 1.4})).unwrap();
    assert!(call(&mut w, "anim.param", json!({"name": "nope", "value": 1})).unwrap_err().contains("unknown parameter"));
    w.run(30);
    let s = call(&mut w, "anim.state", json!({})).unwrap();
    assert_eq!(s["params"]["vel_z"], json!(1.4f32));
    assert_eq!(s["layers"][0]["state"], "locomotion");
    assert_eq!(s["layers"][0]["clips"][0]["index"], 1, "walk clip playing: {}", s["layers"][0]);
    call(&mut w, "anim.play", json!({"state": "hit", "fade": 0.0})).unwrap();
    w.run(1);
    let s = call(&mut w, "anim.state", json!({"entity": "Mannequin"})).unwrap();
    assert_eq!(s["layers"][0]["state"], "hit");
    let b = call(&mut w, "anim.bones", json!({"name": "LeftFoot"})).unwrap();
    assert_eq!(b["bones"][0]["parent"], "LeftLowerLeg");
    let c = call(&mut w, "anim.config", json!({"lod": false})).unwrap();
    assert_eq!(c["lod"]["enabled"], false);
}

/// CPU cost headless (no rendering): `memgate -- cargo test --test anim bench -- --ignored
/// --nocapture`. Prints ms per `App::update()` for N walking mannequins, LOD off/on, camera at
/// one corner of the grid.
#[test]
#[ignore]
fn bench_crowd_cpu() {
    for n in [100usize, 500] {
        let mut w = setup("bench");
        let empty = {
            let t = std::time::Instant::now();
            w.run(120);
            t.elapsed().as_secs_f64() * 1000.0 / 120.0
        };
        let side = (n as f32).sqrt().ceil() as usize;
        let mut roots = Vec::new();
        for i in 0..n {
            let at = Vec3::new((i % side) as f32 * 3.0, 0.0, -((i / side) as f32) * 3.0);
            let rig = w.spawn(Transform::from_translation(at));
            w.app.world_mut().entity_mut(rig.root).insert(RootMotion::default());
            roots.push(rig.root);
        }
        w.app.world_mut().spawn((MainCamera, Transform::from_xyz(-5.0, 2.0, 5.0), GlobalTransform::from_xyz(-5.0, 2.0, 5.0)));
        w.run(10);
        for &r in &roots {
            w.anim_mut(r).set_float("vel_z", WALK_SPEED);
        }
        w.run(60);
        for lod in [false, true, false, true] {
            w.app.world_mut().resource_mut::<AnimConfig>().lod.enabled = lod;
            w.run(30);
            let frames = 240;
            let (mut adv, mut post, mut posed) = (0.0, 0.0, 0u64);
            let t = std::time::Instant::now();
            for _ in 0..frames {
                w.app.update();
                let s = w.app.world().resource::<AnimStats>();
                adv += s.advance_us as f64;
                post += s.post_us as f64;
                posed += s.posed as u64;
            }
            let ms = t.elapsed().as_secs_f64() * 1000.0 / frames as f64;
            println!(
                "n={n} lod={lod}: {ms:.3} ms/frame (empty app {empty:.3}), anim step {:.0} µs, post {:.0} µs, posed {:.0}/frame",
                adv / frames as f64,
                post / frames as f64,
                posed as f64 / frames as f64
            );
        }
    }
}
