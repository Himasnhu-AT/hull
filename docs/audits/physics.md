# Physics audit: engine + avian3d 0.7 vs Chaos (UE 5.8) / Jolt (Godot)

Read-only audit. No builds were run, so the ms/MB figures are estimates from the code paths and need confirming with the benchmarks below. Paths: `A/` = `~/.cargo/registry/src/index.crates.io-*/avian3d-0.7.0/src`, `UE/` = `refs/UnrealEngine/Engine/Source/Runtime/Experimental/Chaos`, `GJ/` = `refs/godot/modules/jolt_physics`.

**Correction to the premise:** Shroud has **no dynamic rigid bodies**. Casings (`weapon/casings.rs:99,137`), grenades (`enemy/grenade.rs:138-158`) and glass shards (`map/glass.rs:48`) use custom ballistics with one raycast per step. Level blocks are statics (`map.rs:183-261`), and the player and enemies are kinematic. Shroud's physics cost is therefore **queries, wasted kinematic contact pairs and fixed per-step overhead**, not the solver.

## Ranked findings

**1. Kinematic bodies generate contacts against statics and other kinematics.**
- (1) What avian does: every moving proxy, kinematic ones included, queries the kinematic and static trees (`A/collision/broad_phase/bvh_broad_phase.rs:107-145`). The narrowphase then builds full manifolds for every active pair (`A/collision/narrow_phase/system_param.rs:480-700`). Shroud's enemy hitbox capsule and sphere (`enemy/mod.rs:303-321`) and the engine `FpsController` (`src/fps.rs:84-97`) all hit this path, against the floor slab, walls and each other.
- (2) Chaos and Jolt: Chaos accepts a pair only if one side is an awake dynamic (`UE/Public/Chaos/Collision/SpatialAccelerationBroadPhase.h:140-170`). In Jolt, kinematic-vs-non-dynamic contacts are off by default (`GJ/jolt_project_settings.cpp:40`, `GJ/objects/jolt_body_3d.cpp:105`).
- (3) Impact: about 30–80 pairs × 0.5–1 µs ≈ 0.02–0.08 ms per step in Shroud. All of it is waste, and it grows to 1–2 ms per step for a crowd of 200 agents.
- (4) Fix (engine): add an `engine::physics` layer convention (World / Dynamic / Character / Hitbox) where characters and hitboxes filter only `Dynamic`. Use it in the `FpsController` bundle and in Shroud's hitboxes. Spatial queries still see them, because queries test memberships.
- (5) Risk: low.

**2. Movement and AI queries run at render rate, unbudgeted, and allocate.**
- (1) What we do: `move_controllers` runs in `Update` with up to 9 shape casts per controller (`src/fps.rs:212-218,280-330`). Each Shroud enemy, every frame, makes 2 line-of-sight rays (`enemy/mod.rs:547`), a capsule slide (`:644-646`), a fresh `Vec` plus an `EntityHashSet` filter (`:529-531`) and a new `Collider::capsule` (`:644`). `fps.rs:280` also allocates a new collider every frame.
- (2) What others do: Godot runs `move_and_slide` in `_physics_process` at a fixed 60 Hz. The engine's own `ai/perception.rs:236` already does it right with `sight_rays_per_frame` and stalest-first ordering.
- (3) Impact: about 10–18 µs per enemy per frame, so 0.1–0.15 ms at 60 fps with 8 enemies, and 4× that at 240 fps. It scales with fps for no gameplay gain.
- (4) Fix:
  - Shroud: move `think_and_act` and enemy movement to `FixedUpdate`, render them with avian `TransformInterpolation`, and time-slice line of sight at 10–20 Hz.
  - Engine: cache the two crouch colliders and reuse one filter.
- (5) Risk: medium (AI feel). The player controller stays per-frame.

**3. Queries in `Update` see a stale kinematic BVH.**
- (1) What avian does: kinematic trees and `Position` refresh only inside the physics step (`A/collider_tree/mod.rs:9-11`, `A/physics_transform/mod.rs:187`). Shroud moves enemies in `Update`, so bullets (`weapon/fire.rs:359`) hit hitboxes that can be up to one tick (15.6 ms, 8–12 cm) old.
- (2) What others do: Jolt's `SetPositionAndRotation` updates the broadphase immediately, and Godot moves characters inside the physics tick.
- (3) Impact: a correctness problem rather than a performance cost.
- (4) Fix: the same as #2 (move enemies in the fixed step).
- (5) Risk: low.

**4. `transform_to_position` is O(all colliders) every step.**
- (1) What avian does: it iterates every entity with `Position`, statics included, and calls `GlobalTransform::compute_transform` (a matrix decomposition) on each, with no `Changed` filter (`A/physics_transform/mod.rs:187-235`). The AABB pass also walks every collider (`A/collider_tree/update.rs:890`).
- (2) What others do: Jolt iterates only active bodies, and Chaos marshals a dirty-proxy list from the game thread.
- (3) Impact: about 10 µs per step in Shroud. In engine worlds (terrain chunks, scatter trunks, prefabs; Courier has about 9k props) with 10k colliders it is about 0.3–0.4 ms per step on one core.
- (4) Fix (engine): set `PhysicsTransformConfig { transform_to_position: false }` and add an equivalent system filtered on `Changed<GlobalTransform>`, keeping avian's "user-set Position wins" tick logic. Then upstream it to avian.
- (5) Risk: low to medium.

**5. Prefab mesh colliders are built per instance from the full render mesh.**
- (1) What we do: `world/prefab.rs:296-312` clones the `Mesh` asset and builds a new parry TriMesh and BVH for every instance, on the main thread during cell load. The collider exists only when rendering, so headless runs get **no collider**, and none is built if the mesh hasn't loaded yet. (`pcg/mod.rs:70` shares colliders correctly.)
- (2) What others do: Unreal shares one collision setup per mesh, held as a refcounted `FImplicitObjectPtr` (`UE/Public/Chaos/ImplicitFwd.h:33`). Jolt and Godot share refcounted shapes.
- (3) Impact: an estimated 20–100 KB per instance for 1–2k triangles, so 10–50 MB per 500 instances, plus 0.1–1 ms of hitch per instance.
- (4) Fix (engine): cache the collider by mesh path, build it from mesh data on a worker without depending on rendering, and prefer convex-hull or primitive colliders for props.
- (5) Risk: low.

**6. Nav source tracking treats moving child colliders as static.**
- (1) What we do: `ai/nav/sources.rs:186` uses `rb.is_none_or(is_static)`, but a child collider has no `RigidBody` of its own (its body is reached through `ColliderOf`). Every moving compound or hitbox collider is re-tessellated each frame (`collider_tris`), allocates, and pushes dirty regions, so rebakes thrash or never settle.
- (2) What others do: not compared; this is an engine bug.
- (3) Impact: 5–20 µs per collider per frame, plus repeated bakes. It affects games with the `ai` feature; Shroud doesn't use it.
- (4) Fix (engine): resolve the body through `ColliderOf`.
- (5) Risk: low.

**7. No contact-manifold reuse.**
- (1) What avian does: it recomputes every active pair's manifold on every step (`system_param.rs:480-700`).
- (2) What others do: Jolt's body-pair cache reuses a manifold when the bodies moved less than 1 mm and 2° (`GJ/spaces/jolt_space_3d.cpp:127-134`). Chaos restores manifolds the same way (`UE/Private/Chaos/Collision/ParticlePairMidPhase.cpp:526`).
- (3) Impact: narrowphase is about 30–50% of a step in piles that don't sleep.
- (4) Fix: needs an avian change upstream.
- (5) Risk: medium.

**8. Solver budget and tick are not exposed.**
- (1) What we do: avian runs 6 substeps per step at 64 Hz (`A/dynamics/solver/schedule.rs:187`), which is 384 substep schedule runs per second even with zero dynamic bodies, as in Shroud. Interpolation is off by default (`A/interpolation.rs:183`), and the engine never enables it. Parry's `simd` feature is off.
- (2) What others do: Jolt uses 10 velocity + 2 position iterations in a single step (`GJ/jolt_project_settings.cpp:37-38`). Chaos uses 8 position + 2 velocity iterations (`UE/Public/Chaos/PBDRigidsEvolutionGBF.h:62-63`).
- (3) Impact: about 30–60 µs per step of fixed overhead (estimate; measure it with avian `PhysicsDiagnostics`).
- (4) Fix:
  - Engine: put `SubstepCount`, the tick rate and interpolation in `EngineOptions` and the quality presets.
  - Shroud: use `SubstepCount(1)`.
  - Try `simd` (it rebuilds only parry and avian, not Bevy).
- (5) Risk: low.

**9. Scatter trunks use cylinder colliders.**
- (1) What we do: `world/cells.rs:380` spawns a cylinder per tree trunk.
- (2) What others do: capsules are the usual choice for trunks (UE foliage uses capsules).
- (3) Impact: parry handles cylinders through GJK, where capsules have analytic paths. That makes trunk collisions about 2–4× slower in the narrowphase and in shape casts.
- (4) Fix (engine): default trunks to capsules.
- (5) Risk: low.

**What avian already does well:**
- per-body-type BVHs (`A/collider_tree/mod.rs:8-11`), equivalent to Jolt's broadphase layers;
- a Box2D-v3-style soft-step solver with graph coloring, warm starting and parallel colors (`A/dynamics/solver/plugin.rs:388`);
- island sleeping;
- the engine's budgeted rays in sound, VFX and perception;
- `RigidBodyDisabled` streaming freeze.

## Switch backend?

**No, not now.** Shroud doesn't exercise the solver at all, and #1–#6 and #8 are fixes in the engine and Shroud that remove all of Shroud's avoidable physics cost.

Jolt's real advantages are SIMD, the manifold cache, mature CCD and throughput on large piles. They matter only for scenes with many active dynamic bodies. A Jolt binding would mean C++ FFI, a second transform world, and rewiring `SpatialQuery`, which `fps`, `ai`, `vfx`, `sound`, `anim`, `chase`, `world` and `render_budget` all use.

Decision gate: switch only if, after these fixes, avian is more than 2× slower than Jolt on benchmark A **and** a shipped game needs more than 500 active bodies. Otherwise contribute #4 and #7 upstream to avian.

## Matched benchmarks (engine vs Godot 4.x + Jolt, headless)

Common settings for all scenes:
- 60 Hz tick for both. Report avian at its default 6 substeps and at 2 substeps, and Jolt at 10/2 iterations.
- Same shapes, sizes, masses and friction.
- Release builds, 15 worker threads on both sides.
- Measure the physics step only: our `perf_span` "physics" (`devtools/perf.rs:412`) against Godot's `Performance.TIME_PHYSICS_PROCESS`. Godot needs an empty scene so no script cost is counted.
- Report p50 and p95 ms, ms per active body, time until everything sleeps, and memory footprint.

1. **Stacks and pile:** 20 pyramids of 10 boxes, plus 2,000 boxes dropped into a walled bin, over 20 s. This tests the solver, sleeping and the manifold cache (#7, #8).
2. **Query throughput:** a 64×64 grid of static boxes with 10k random rays and 1k capsule casts per tick. Godot must use a GDExtension in C++, not GDScript. Add an idle variant with 20k statics, 0 queries and 10 kinematic bodies; this exposes #4.
3. **Character crowd:** 200 kinematic capsules doing collide-and-slide (4 sweeps each) through 500 boxes and 1,000 trunks. Godot uses `CharacterBody3D.move_and_slide` under Jolt. Run it with and without fix #1, and with cylinder vs capsule trunks (#9).
