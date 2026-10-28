# Audit: frame scheduling, threading, ECS overhead, world streaming

This audit is read-only: I read code and ran no builds. Every µs figure is an estimate for about 4000 entities and 1000 meshes, with the reasoning given. Confirm each one with `perf.stats`, `ecs.systems` and `render.cpu_us` before acting on it.
Machine fact (from `sysctl`): the M5 Pro has **5 "Super" + 10 "Performance" cores**. There are no efficiency cores, so the main and render threads should sit on the 5 Super cores.

## Ranked findings

**1. Shroud's AI code is built at opt-level 1 in dev builds (biggest cause of the 26 fps).**
(1) `shroud/Cargo.toml:17-23` sets `[profile.dev] opt-level=1` and `[profile.dev.package."*"] opt-level=3`. Cargo's `"*"` skips workspace members, so `crates/brain`, which holds the per-frame mind/perception/utility AI and the evolve sims, is built at opt-level 1. The engine is a path dependency outside the workspace, so it gets opt-level 3.
(2) Unreal's "DebugGame" config does the same in reverse: game module unoptimised, engine optimised. Unreal games, though, don't keep their hot simulation in the game module.
(3) Iterator- and float-heavy Rust usually runs 2–4× slower at O1 than at O3. If the brain costs 4–8 ms of the 38 ms frame, the fix returns about 2–5 ms/frame. It also makes the 8 s evolve do 2–3× more generations.
(4) **shroud**: add `[profile.dev.package.brain] opt-level = 3` (brain has no Bevy, so it recompiles fast).
(5) Risk: low. Stepping through brain in a debugger gets harder.

**2. Fixed-step catch-up multiplies physics cost at low fps.**
(1) avian runs in `FixedPostUpdate` at Bevy's default 64 Hz (`bevy_time-0.19.1/src/fixed.rs:76`) with 6 substeps (`avian3d-0.7.0/src/dynamics/solver/schedule.rs:187-190`). `Time<Virtual>` allows a 250 ms catch-up per frame, and the engine never caps it (`src/app.rs:162` only adds `PhysicsPlugins::default()`). At 26 fps, FixedMain runs about 2.4× per frame, and up to 16× after a hitch. That feeds a spiral.
(2) Unreal caps physics substeps (MaxSubsteps / MaxSubstepDeltaTime project settings). Godot caps steps with `max_physics_steps_per_frame` (default 8). Neither file is in the local refs.
(3) A physics step costing 1–1.5 ms becomes 2.5–3.5 ms/frame at 26 fps. Every system in FixedMain also pays the executor cost 2.4×.
(4) **engine**: in `app()`, set `Time<Virtual>::set_max_delta` to about 3 steps (50 ms), and expose `SubstepCount` in `EngineOptions`. Shroud is an FPS with no stacking, so 4 substeps is likely enough.
(5) Risk: low. Under heavy load, game time runs slower instead of spiralling.

**3. No thread QoS, and the thread pools are oversubscribed.**
(1) Bevy sets no QoS: there is no qos or priority code in `bevy_tasks-0.19.1/src`. Its pools are io=4, async=4 and compute=the remaining 7 (`bevy_app-0.19.1/src/task_pool_plugin.rs:70-142`). The render thread is a bare `std::thread::spawn` (`bevy_render-0.19.1/src/pipelined_rendering.rs:149`).
On top of that, Shroud's evolve runs an `evolve` thread plus 6 scoped workers at normal priority for 8 s (`shroud/crates/game/src/evolving.rs:69-74`, `crates/brain/src/evolve.rs:380`), with no `worker_init`, unlike the trainer (`trainer_task.rs:98`). That is the 600 % CPU. Total: about 24 runnable threads on 15 cores.
(2) Unreal raises the Mac game thread to sched priority 45 (`Core/Private/Mac/CocoaThread.cpp:360-368`). It splits workers into foreground and background pools with their own priorities (`Core/Private/Async/TaskGraph.cpp:1284-1287`, `Fundamental/Scheduler.cpp:228-346`) and keeps few foreground workers so other apps have cores (`TaskGraph.cpp:1785-1790`). Godot uses one pool and caps low-priority tasks at a ratio, so frame work always finds a free thread (`core/object/worker_thread_pool.cpp:250-259, 818`).
(3) Average frame time barely changes. p99 and hitches during evolve or trainer runs should drop, because macOS stops placing main and render on the same cores as 7 busy background threads.
(4) **engine**:
- Set `QOS_CLASS_USER_INTERACTIVE` on the main thread at startup and on the render thread from a one-time `Render` system (`note_render_thread` at `devtools/perf.rs:448` already runs there).
- Set compute workers to `USER_INITIATED` and async/io workers to `UTILITY` via `TaskPoolPlugin { task_pool_options: … on_thread_spawn }`. This needs no Bevy change.
- Shrink io to 2.

**shroud**: run evolve with `worker_init: Some(lower_priority)` and `threads = min(6, ncpu-4)`.
(5) Risk: medium-low. Keep USER_INTERACTIVE on only 2 threads, or the rest of the system can starve.

**4. Loading a world cell is one synchronous main-thread burst.**
(1) `src/world/cells.rs:234-312` re-evaluates every cell every frame. `load_cell` (`:314-397`) then spawns the root, builds heightfield colliders (`terrain.rs:491 chunk_collider`), prefabs, scatter colliders and hooks in that same frame. The budget counts cells, not time (`loads_per_frame: 2`, `world/mod.rs:137`). PERF.md still lists 40–90 ms frames in `open_world`.
(2) WorldPartition:
- skips the update when a hash of the quantised streaming sources hasn't changed (`Engine/Private/WorldPartition/WorldPartitionStreamingPolicy.cpp:159-195`, used at `:337-351`);
- can compute the target state on a task (`:68-71, :288-313`);
- caps loads with `MaxCellsToLoad` (`:981-1032`);
- adds loaded cells to the world in time-sliced steps (`PendingAddToWorld`, `:1260`);
- blocks only when streaming falls critically behind (`:32-35`).
(3) Removes the 10–80 ms load spikes. Steady state saves about 5–30 µs (cell scan plus `prefabs_live` sum).
(4) **engine**:
- Prefetch the cells in the band `load_radius..load_radius+margin` on `AsyncComputeTaskPool`, which already powers terrain, HLOD and scatter. That task builds the collider shapes, transforms and spawn lists.
- Apply the results on the main thread under a µs budget (e.g. 1 ms) instead of a cell count.
- Skip the cell scan when the eye's cell and the sources haven't changed.
(5) Risk: medium. Gameplay must already wait for `CellLoaded`, which is the existing contract.

**5. Executor cost per system and per run.**
(1) Bevy's multi-threaded executor spawns one task per runnable system and evaluates run conditions serially on the executor (`bevy_ecs-0.19.1/src/schedule/executor/multi_threaded.rs:584-642, 650-688`). Main, Render, and FixedMain at 2.4× add up to roughly 700–1000 system runs per frame.
(2) Unreal ticks only registered and enabled tick functions. Godot calls `_process` only on nodes with processing on. Unused features cost zero in both.
(3) At about 0.5–1 µs per system task, that is **0.4–1 ms/frame** of overhead on the critical path.
(4) **engine**:
- Count the systems with `ecs.systems`.
- Put each subsystem's systems in a set with one set-level `run_if(any_with_component::<…>)`. Skipped systems never spawn a task.
- Keep FixedMain small.
- Turn off unused Bevy plugins with `DefaultPlugins.build().disable::<…>()` (e.g. gizmos and picking in ship builds). This changes no Cargo features, so Bevy does not recompile.
(5) Risk: low.

**6. Automatic sync points on the visibility critical path.**
(1) `render_budget/detail.rs:150-155` chains 6 systems that use `Commands`. `.chain()` then inserts up to 5 `ApplyDeferred` barriers between `TransformSystems::Propagate` and `CheckVisibility` (auto-insert: `schedule/auto_insert_apply_deferred.rs:148`). `world/cells.rs:215` and `hlod.rs:211` add more. Each barrier drains every worker before an exclusive apply.
(2) Unreal's tick groups run component-tick prerequisites without world-wide barriers.
(3) Each barrier idles the cores for about 10–30 µs, so roughly **50–150 µs/frame**.
(4) **engine**: use `.chain_ignore_deferred()`, since one-frame-late classification is already tolerated (`settle` waits frames anyway). Or merge `settle`, `demote_moved` and `classify_meshes` into one system.
(5) Risk: low.

**7. Dev-only O(n) stats scan every frame.**
(1) `render_budget/stats.rs:150-226 count_stats` is on by default with `devtools` (`mod.rs:201`). It does a random `classes.get(e)` for each visible mesh and a `VisibleEntityRanges` hash lookup for each mesh.
(3) About 40–80 µs/frame in dev builds. This also skews dev-build perf against ship builds.
(4) **engine**: run it every 10th frame, or only while the overlay, metrics or `render.stats` is reading. Turn the per-entity `get` into one linear query.
(5) Risk: none.

**8. VFX extract copies every particle on the main thread.**
(1) `vfx/gpu.rs:239-262` copies each 52-byte `SpriteInstance` into the render buffer during extract, while the main world is locked.
(3) 100k sprites is 5.2 MB, about 0.4–0.8 ms/frame on the main thread. Shroud's few thousand cost under 30 µs.
(4) **engine**: double-buffer the Vecs and `mem::swap` them in extract (through `ResMut<MainWorld>`), which is O(1).
(5) Risk: low.

**9. Small wastes (engine), together about 20–60 µs.**
- `stream.rs:291` counts `live.iter().flatten()` every frame; keep a counter instead.
- `stream.rs:314-318` scans linearly over removed entities × roots; use a map from entity to root.
- `stream.rs:384` re-counts hidden roots every frame.
- `detail.rs:481-516` toggles `NotShadowCaster` by insert/remove. Each toggle is an archetype move plus re-extraction and possibly re-specialisation for the crossing entity. That is acceptable as written; keep the hysteresis.

Already good (no change): mesh extraction and visibility are change-driven in Bevy 0.19 (`bevy_pbr render/mesh.rs:1901-1925`, `bevy_camera visibility/mod.rs:733, 908`). Idle-skip already gates extract, and offscreen runs limit frames in flight to 2.

## Matched CPU benchmarks (engine vs Godot 4.4)

Shared setup for every run:
- 1920×1080, vsync off (`--uncapped`), shadows/MSAA/post off, static camera.
- 8 s warm-up, then a 20 s window. Same power state.
- Godot: `--rendering-driver metal`.
- Report: frame p50/p99, main-thread CPU ms/frame (engine: `cpu.main_ms`; Godot: `Performance.TIME_PROCESS` plus its process CPU sampled by our `perf_sys`), process CPU %, and memory.

**A. `bench_swarm`: 10,000 moving meshes.** Each entity has a Transform, a Velocity, one shared cube mesh and one shared material. One system does `pos += vel*dt` and bounces off a 200 m box.
- Engine variants: with `Mesh3d` (ECS, extract and GPU-culling path) and without (pure ECS iteration).
- Godot variants:
  - (a) 10k `MeshInstance3D` moved from one script loop;
  - (b) `RenderingServer.instance_create` RIDs moved with `instance_set_transform`;
  - (c) `MultiMesh`, as an upper bound.
- Goal: engine main-thread time at or below Godot (b).

**B. `bench_churn`: spawn/despawn churn.** Hold a steady population of 20,000. Each frame, despawn the 500 oldest and spawn 500 new ones (4 meshes × 4 materials, random transforms) for 30 s.
- Engine: also report allocs/frame (`CountingAlloc`) and memory growth.
- Godot: `PackedScene.instantiate()` + `add_child` / `queue_free`, plus a `RenderingServer` RID variant.
- Goal: p99 under 1.5× p50, and no memory growth.

Add both as engine examples so `scripts/perf_suite.py` runs them, and keep the Godot projects next to them under `bench/godot/`.
