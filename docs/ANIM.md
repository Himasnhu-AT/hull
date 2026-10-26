# Animation (`engine::anim`, feature `anim`)

Code-first character animation: the role of Unreal's Animation Blueprints / Unity's Mecanim
controllers, as plain Rust data over Bevy 0.19's `AnimationPlayer` + `AnimationGraph`.
No editor, no binary controller assets: a graph is a value an agent can read, diff, build in a
test and drive over the control port.

Bevy samples and blends the clips (parallel, all curve types, glTF clips). This module owns
everything above that: time, state machines, crossfades, blend spaces, layer weights and masks,
notifies, root motion, procedural bones and LOD.

On by default (`default` features). `EnginePlugin` adds `AnimPlugin` (headless too; it adds
Bevy's `AnimationPlugin` when the base plugins didn't).

## Quick start

```rust
use engine::anim::{AnimGraphDef, AnimLayer, AnimState, Clip, Cond, Motion, Transition, Animator, RootMotion};

let def = AnimGraphDef::builder("hero")
    .float("speed", 0.0)
    .trigger("attack")
    .root_bone("Hips")
    .layer(
        AnimLayer::new("base")
            .state(AnimState::new("idle", Motion::clip(idle))
                .on(Transition::to("move").when(Cond::gt("speed", 0.1)).fade(0.2)))
            .state(AnimState::new("move", Motion::blend1d("speed", [
                    (1.4, Clip::new(walk).notify_norm(0.25, "footstep_l").notify_norm(0.75, "footstep_r")),
                    (3.8, Clip::new(run)),
                ]))
                .on(Transition::to("idle").when(Cond::lt("speed", 0.1)).fade(0.25)))
            .state(AnimState::new("attack", Motion::clip(Clip::new(swing).notify(0.32, "hit"))).once()
                .on(Transition::to("idle").exit_time(0.9).fade(0.15)))
            .any(Transition::to("attack").when(Cond::trigger("attack")).fade(0.08)),
    )
    .build()?;                       // Err names the unknown state / parameter / bone

commands.entity(player_entity).insert((Animator::new(def), RootMotion::default()));
// gameplay (Update):
animator.set_float("speed", v);  animator.trigger("attack");
// events:
fn steps(mut ev: MessageReader<AnimNotify>) { for n in ev.read() { if &*n.name == "footstep_l" { .. } } }
```

Runnable: `cargo run --example anim_demo -- --play` (procedural mannequins: locomotion blend
space with root motion, wave overlay, additive lean, hit reaction, look-at, springs, foot
placement on a step; `--crowd 300` for a crowd). `tests/anim.rs` has every feature driven
headless.

## Concepts and API

### Graph definition (`def.rs`)
- `AnimGraphDef::builder(name)` → `.float/.bool/.trigger(name, default)` parameters,
  `.root_bone(name)`, `.layer(AnimLayer)`, `.build() -> Result<Arc<AnimGraphDef>, String>`.
  Names are resolved to indices once; nothing is looked up by string per frame.
- `AnimLayer::new(name)`: `.state(..)`, `.any(Transition)` (any-state transitions, checked
  first), `.entry(state)`, `.weight(w)` or `.weight_param(p)` (0..1, per frame), `.mask(BoneMask)`,
  `.additive()`. Layer 0 is the base pose; later layers override (lerp by weight on the masked
  bones) or add (additive clips hold deltas: rotations pre-multiply in the parent's space,
  translations add) on top.
- `BoneMask::subtree("Spine").and_bone("Head").without("LeftHand")`. Bone names match
  case/prefix-insensitively (`Spine` matches `mixamorig:Spine`).
- `AnimState::new(name, Motion)`: `.once()` (holds the last frame), `.speed(s)`,
  `.speed_param(p)`, `.on(Transition)`.
- `Motion::clip(c)`, `Motion::blend1d(param, [(value, clip)..])`, `Motion::blend2d(x, y,
  [(Vec2, clip)..])` (gradient-band "freeform cartesian"), `Motion::blend2d_directional(..)`
  (polar gradient bands: direction first, then speed; for idle-at-origin + rings). Clips in a
  blend space play in sync (shared normalized time; the effective length is the weighted
  average), so feet stay in phase.
- `Transition::to(state)`: `.when(Cond)` (all must hold), `.exit_time(t)` (normalized; `< 1` on
  a looping state checks every loop), `.fade(secs)`, `.ease(EaseFunction)` (default
  smoothstep), `.offset(t)`, `.interruptible()` (the destination's transitions may fire during
  the fade), `.can_self()` (any-state may restart the current state).
- `Cond::gt/lt(param, v)`, `Cond::is(param, bool)`, `Cond::trigger(param)` (consumed when the
  transition fires), `Cond::func(fn(&[ParamValue]) -> bool)`.
- `Clip::new(handle).notify(secs, name)` / `.notify_norm(fraction, name)`.

### Runtime (`machine.rs`)
`Animator` (requires `AnimationPlayer`, marks the entity a render-budget `Actor`):
- params: `set_float`, `set_bool`, `trigger`, `set(name, ParamValue)`, `set_id(ParamId, ..)`
  (no string compare), `param`, `params()`.
- inspection: `current_state(layer)`, `state_time(layer)`, `in_transition(layer)`,
  `playing(layer)` (state, weight, time), `slot_weights(layer)`, `last_step()` (notifies, root
  motion), `lod_interval()`, `posed_this_frame()`.
- control: `play(layer, state, fade)` (crossfade now, ignoring conditions), `speed`, `paused`.
- `Animator::step(dt, NotifyMode)` is pure math (unit-tested without an `App`).

Crossfades stack: a transition during a fade keeps the old states fading (≤ 4 per layer, the
weakest dropped); going back to a state that is still fading out continues its time and weight
(A → B → A doesn't pop). One transition per layer per frame.

### Bevy mapping (`systems.rs`)
On bind (once per definition × skeleton, cached): one Bevy `AnimationGraph` per definition:
layer k is a Blend (or Add) node whose children are the layer-below node and layer k's clip
nodes (masked by group k). Override layers scale their clip weights by `w / (1 - w)`, which
under Bevy's normalized blending gives exactly `lerp(below, layer, w)` on masked-in bones and
leaves masked-out bones untouched. Every frame the animator writes, per playing clip, weight +
seek time into the `AnimationPlayer` (all paused: our clock drives time, Bevy only samples).

### Notifies
`AnimNotify { entity, layer, state, name, clip_time, weight }` Bevy message, fired once per pass
over the marker (looping, reverse playback, entry at time 0 all handled). `AnimConfig::notify_mode`:
`Dominant` (default: only the most weighted state of a layer and, in a blend space, its most
weighted clip — no doubled footsteps while blending walk/run) or `All { min_weight }`.

### Root motion (`root_motion.rs`)
`.root_bone("Hips")` on the graph + `RootMotion` on the animator entity: each clip's root track
is baked once (60 Hz, via `AnimationClip::sample_clamped`, glTF clips included); per frame the
base layer's blended delta is applied to the entity's `Transform` (`RootMotionMode::Transform`,
or to `RootMotion::target`, an ancestor such as a glTF `SceneRoot`) and the horizontal travel is
taken out of the root bone's pose. `RootMotion::delta()` only accumulates world-space motion in
`RootMotionDelta` for a physics / character controller: `let (d, yaw) = delta.take();` (e.g.
`FpsMotor.velocity = d / dt`), `delta.velocity()` for readouts. Options: `yaw` (turn-in-place
clips; deltas are then relative to the clip's facing), `vertical`.

### Procedural (`ik.rs`, `foot.rs`)
Components on the bone they drive; run after the pose, before transform propagation, in
hierarchy order, always starting from the animated pose (unanimated bones use their rest pose,
so nothing accumulates); skipped on LOD-skipped frames.
- `TwoBoneIk::new(target).pole(p)` on the tip (foot / hand): exact analytic solve (law of
  cosines + swing + pole twist), `weight`, optional `tip_rotation`.
- `LookAt::new(target).axis(Vec3::NEG_Z).max_angle(a).weight(w)`: aim/look; put it on spine,
  neck and head with partial weights for a distributed look.
- `SpringBone::new(stiffness, damping)` (+ `gravity`): damped point-mass tip, substepped at
  120 Hz; teleports reset it.
- `FootPlacement::new(feet, pelvis)` (feature `physics`, on the animator): avian rays from above
  each animated foot; the pelvis drops so the lower foot reaches, each foot's `TwoBoneIk` gets
  the hit height (keeping the animated lift) and a tip rotation aligned to the ground normal;
  smoothed, weights fade when rays miss. Exclude the character's own colliders with `filter`.

### Skeletons, clips in code (`skeleton.rs`, `clip.rs`, `mannequin.rs`)
- `Skeleton` (built automatically on the animator): bones in hierarchy order, `find(name)`
  (exact, then case/prefix/separator-insensitive), `entity(name)`, `mask_set`, and
  `humanoid()` → hips/spine/chest/neck/head and `[left, right]` arms/legs/feet found by name
  across Mixamo (`mixamorig:LeftUpLeg`), Unreal (`thigh_l`, `calf_r`), Blender/Rigify
  (`thigh.L`, `forearm.R`) and VRM-style (`LeftUpperLeg`) names. No retargeting needed to wire
  IK or masks to an arbitrary rig.
- `RigDef::new().bone(name, parent, rest)` + `.spawn(&mut commands, root)`: procedural rigs
  (bones get `Name`, `AnimationTargetId`, `AnimatedBy`).
- `ClipBuilder::new(&rig_or_skeleton, secs)`: `.rotation/.translation/.scale(bone, &[(t, v)])`,
  `.rotation_fn/.translation_fn(bone, n, |fraction| ..)`, `.curve(bone, VariableCurve)`,
  `.build() -> Result<AnimationClip, String>` (unknown bones listed).
- `Mannequin`: rig, skinned mesh, clip set (idle, walk, run, back, strafes with footsteps and
  root motion, wave, additive lean, hit) and its graph (`vel_x`, `vel_z`, `wave`, `lean`,
  `hit`). `Mannequin::spawn(&mut commands, def, transform, visual)`; headless pass `None`.

### glTF
```rust
let hero = server.load(GltfAssetLabel::Scene(0).from_asset("models/hero.glb"));
let walk: Handle<AnimationClip> = server.load(GltfAssetLabel::Animation(1).from_asset("models/hero.glb"));
// ... build `def` with these handles (binding waits until every clip is loaded)
commands.spawn((SceneRoot(hero), AnimateScene(def), Transform::from_xyz(0.0, 0.0, 0.0)));
app.add_observer(|ev: On<AnimatorAttached>, mut c: Commands| {
    c.entity(ev.animator).insert(RootMotion { target: Some(ev.entity), ..default() });
});
```
`AnimateScene` gives the scene's `AnimationPlayer` entity an `Animator` once spawned; bones,
masks and the root bone resolve by name (`"Hips"` finds `mixamorig:Hips`). Clips can also be
built in code against the loaded `Skeleton` (`ClipBuilder::new(skeleton, secs)`).

### LOD and cost (`AnimConfig::lod`)
State machines, notifies and root motion run every frame for every animator (cheap, keeps
gameplay exact). The pose — Bevy's per-bone sampling, our root lock / IK / springs — runs every
`intervals[tier]` frames: tiers by distance to the `MainCamera` (default `< 15 m: 1, < 35: 2,
< 70: 4, beyond: 8`), staggered across characters; characters whose skinned meshes are all
off-screen use `offscreen_interval` (default 0 = no pose until visible). On skipped frames the
player is pointed at an empty graph, so Bevy's evaluation visits the bones with a one-node graph.
Zero cost when unused: no animators, no work (systems iterate empty queries).

## Schedule
`PostUpdate`: `AnimSystems::Bind → Lod → Advance` (before Bevy's `AnimationSystems`), then
`AnimSystems::RootMotion → Procedural` (look-at → foot placement → two-bone IK → springs),
before `TransformSystems::Propagate`. Set parameters and IK targets in `Update`.

## Control commands (feature `devtools`)
| Command | Params | Result |
|---|---|---|
| `anim.list` | — | every animator: `id`, `entity`, `name`, graph, current state per layer, LOD, + stats |
| `anim.state` | `{entity?}` | params, per layer: weight, mode, current state, normalized time, fading states, playing clips (weight, time); notifies this frame; root motion step / pending / velocity |
| `anim.param` | `{entity?, name?, value?}` | set a float/bool (`true` fires a trigger); no `name`: list params with kinds |
| `anim.play` | `{entity?, state, layer?, fade?}` | crossfade a layer to a state now |
| `anim.bones` | `{entity?, name?}` | bone local translation, rotation (yaw/pitch/roll °), world position, parent |
| `anim.config` | `{lod?, notify_all?}` | toggle LOD; `notify_all: w` fires every clip above weight w (negative: dominant) |

`entity`: the `id` from `anim.list`, an entity string (`"625v0"`) or a `Name`; omitted with one
animator. Metrics (dev builds): `anim.animators`, `anim.posed`, `anim.advance_us`,
`anim.post_us`; perf spans `anim.advance`, `anim.eval` (Bevy's sampling), `anim.post`.

Screenshots: `python3 -I scripts/play.py steps.json --example anim_demo` with
`demo.cam {name: hero|lineup|feet|crowd}` steps.

## Measurements
Apple M5 Pro, dev profile (deps opt-level 3), mannequin = 30 bones / 16 animated, 3 layers, a
6-sample 2D blend space, root motion on. The machine was shared with other build jobs, so
frame times carry ±20 % noise; CPU microseconds are the module's own timers.

Headless (`cargo test --test anim bench -- --ignored --nocapture`; no rendering; the camera at a
corner of a 3 m grid, so most characters are 15–70 m away):

| characters | LOD | ms / `App::update()` | over empty app | state machines (µs) | root motion + procedural (µs) | posed / frame |
|---|---|---|---|---|---|---|
| 100 | off | 0.77–0.80 | +0.45 | 20–23 | 12 | 100 |
| 100 | on | 0.71–0.72 | +0.39 | 22 | 11 | 27–36 |
| 500 | off | 1.68–1.82 | +1.4 | 70–74 | 45–50 | 500 |
| 500 | on | 1.29–1.53 | +1.0 | 69–80 | 41–45 | 90–110 |

- The animation layer itself (all state machines, blend spaces, notifies, root-motion deltas
  and the player writes) costs ~0.15 µs per character per frame (parallel query). Most of the
  remaining per-character cost is Bevy's per-bone sampling and transform propagation of the
  ~15 k bone entities, which LOD reduces (skipped characters keep their pose and are visited
  with an empty graph).
- Windowed demo, `--crowd 300 --offscreen --uncapped` (309 skinned mannequins, 1080p, shadows):
  see the table below.

| camera | LOD | posed / 309 | frame p50 / p95 ms | `anim.eval` span ms (Bevy sampling) | state machines µs* | post µs* |
|---|---|---|---|---|---|---|
| crowd overview (20–70 m) | on | 60 | 4.03 / 4.80 | 0.46 | 83 | 150 |
| crowd overview | off | 309 | 4.09 / 5.25 | 0.80 | 79 | 85 |
| crowd overview (again) | on | 60 | 4.66 / 5.79 | 0.55 | 50 | 48 |
| lineup (crowd behind the camera) | on | 154 | 4.83 / 5.89 | 0.74 | 89 | 131 |
| lineup | off | 309 | 4.38 / 5.42 | 0.83 | 65 | 78 |

\* single-frame samples from `anim.config`. The frame is GPU/render bound (~4 ms) and the
machine was busy, so p50/p95 differences between rows are within noise; the reliable signal is
Bevy's evaluation span (0.8 → 0.46–0.55 ms with LOD). Characters behind the camera still count as
visible when their shadow falls into view (Bevy marks meshes visible to shadow cascades), which
is why the lineup view poses 154.

## Known limits
- One `Animator` per `AnimationPlayer`. Transition-to-self (`can_self`) restarts the state with
  a cut (Bevy has one active instance per clip node, so a clip can't crossfade with itself).
- Override layers blend in Bevy's normalized way: a bone animated only by an override layer (no
  base clip touches it) takes that layer fully regardless of weight. Additive clips must hold
  deltas (identity = no change); there is no automatic "make additive from a reference pose".
- No inertialization, no pose caching / pose snapshot blending (crossfades blend live clips),
  no motion matching, no animation compression or curve retargeting between differently
  proportioned skeletons (`Skeleton::humanoid` maps names, not motion).
- IK: two-bone and look-at/aim are analytic; no FABRIK/CCD chains, no full-body IK. Spring bones
  have no collision.
- Foot placement casts one ray per foot (no toe/heel pair, no slope-aware stride).
- LOD reads distance and skinned-mesh `ViewVisibility` of the previous frame; headless runs
  ignore visibility. GPU skinning cost is unchanged by LOD (Bevy uploads joint matrices for
  every visible skinned mesh).
- Root motion takes horizontal travel (+ optional yaw / vertical) from the base layer only.
