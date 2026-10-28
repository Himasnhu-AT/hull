# AI / navigation audit vs Unreal 5.8 (Recast/Detour) and Godot (navigation_3d)

Read-only audit. Paths: engine `src/ai/...`, shroud `crates/...`, UE `Runtime/Navmesh|NavigationSystem/...`, Godot `modules/navigation_3d/...`.
Short version: the engine's measured numbers (docs/AI.md) are already good. Steering for 500 agents takes 0.18 ms and a 92 m path takes 0.013 ms. The big losses are in **Shroud** (thread oversubscription, a grid A* that allocates per call) and in **structural gaps**: no parallelism, no sliced or concurrent queries, rebakes go through full re-voxelization, and the poly count grows on diagonal geometry. Impact figures are estimates from reading the code unless they are quoted from AI.md.

## Ranked findings

**1. Shroud evolve runs 6 normal-priority threads (the "600 %").** *(shroud)*
- What we do: `EvolveConfig::default().threads = available_parallelism().clamp(1,6)` (`crates/brain/src/evolve.rs:380`). `evolving.rs:73` uses it with no `worker_init`, so no priority drop. `Parallel::run` spawns new OS threads every generation (`evolve.rs:331`). Separately, `trainer_task.rs:109` → `TrainerHandle::finish()` (`trainer.rs:185`) **joins on the main thread** on entering Playing, which blocks for up to one sim round.
- What UE/Godot do: UE time-slices nav regeneration (`NavigationSystem/Public/NavMesh/RecastNavMeshGenerator.h:44,279-290`, `FNavRegenTimeSliceManager`). Godot runs background work as low-priority `WorkerThreadPool` tasks and polls for completion (`3d/nav_mesh_generator_3d.cpp:98-131,230`).
- Impact: 6 of 15 cores are taken at render priority, which competes with Bevy's render, main and task threads. There is also a one-off hitch at match start, equal to the length of one sim round (likely 10–100 ms).
- Fix:
  - Set `threads = 2..3` and `worker_init: Some(lower_priority)` for Evolving.
  - Keep one persistent worker pool instead of spawning threads per generation.
  - Make `stop` cancel without blocking: set the flag, park the handle, poll `is_finished()`.
- Risk: low. Evolve may reach fewer generations inside its 8 s budget.

**2. Shroud grid A* allocates per call and does redundant work.** *(shroud)*
- What we do: `NavGrid::find_path_cost` (`crates/brain/src/nav.rs:117-172`) allocates and clears `g` and `came` for every cell on each call. At 96×96 cells that is about 110 KB. The open list has no stale-entry check: `while let Some(Node{idx,..})` at `:132` re-expands duplicates. Smoothing (`:239-253`) is O(k²) `clear_line` calls, each sampling every 0.25 m.
- The tactical cost closure (`squad.rs:158`) allocates a 48² cache per path and runs `line_of_sight` over **every block** (`arena.rs:870`) for each new 2 m cell.
- `distance_field` runs a full-map Dijkstra per member at `squad.rs:1742` and `:1894`, allocating each time.
- What Detour/Godot do instead:
  - Detour reuses a fixed `dtNodePool` plus a decrease-key `dtNodeQueue` (`Navmesh/Public/Detour/DetourNode.h:38-49,116-147`).
  - Godot keeps per-slot dense arrays with an indexed heap (`3d/nav_mesh_queries_3d.cpp:287-337`).
  - Both search polygons, not 1 m cells: a 96 m arena is about 100–300 polys versus 9 216 cells.
- Impact: estimated 0.2–1 ms per tactical repath. Re-plans cluster: a squad order means 4–8 members at once. That adds per-frame spikes on the main thread, plus a large amount of allocation churn.
- Fix (cheapest first):
  1. Reusable buffers with generation stamps.
  2. Skip stale heap entries (`f > g[idx]+h`).
  3. One-pass string pull: funnel or LOS from the anchor along the cell chain.
  4. Rasterize blocks once into an occupancy/height bitmap and do LOS with a grid DDA.
  5. Longer term, drive Shroud bots from `engine::ai` (`NavQuery` plus per-poly cost hooks). That needs area costs (finding 7).
- Risk: medium. Tactical routes may change shape, so re-validate brain tests and trainer win rates.

**3. Nothing in the AI frame runs in parallel.** *(engine)*
- What we do:
  - ORCA (`src/ai/agent.rs:296-350`), the perception cone filter (`perception.rs:186-204`) and paths (`nav/paths.rs:91-120`) all run on one thread.
  - `bt::tick_agents` is an **exclusive** system every frame (`bt.rs:591`), even when no agent is due. That stalls the whole Update schedule.
  - `utility::evaluate_all` clones the Blackboard and allocates a `due` Vec and a name `String` on each evaluation (`utility.rs:187-200`).
- What Godot does: avoidance runs as a `WorkerThreadPool` group task per agent (`nav_map_3d.cpp:615-631`). Path queries run concurrently through `path_query_slots` and a semaphore (`nav_map_3d.cpp:154-181`).
- Impact: ORCA at 500 agents takes 0.39 ms in-app (AI.md). Phase 2 only reads `sims` and writes `out[i]`, so `ComputeTaskPool` chunks bring it to about 0.08 ms. Perception at 500 agents takes 0.9 ms, and the cone stage dominates (60 k pairs); per-perceiver chunks bring it to about 0.2 ms. Paths: 32 × 0.13 ms is about 4 ms serial on a 300 m map; per-thread `NavQuery`s give roughly 6× throughput inside the same 1 ms budget.
- Fix:
  - `par_chunks` over sims and over perceivers, then merge `in_view` per chunk.
  - Parallel path batch: `&NavMesh` is read-only, with one `NavQuery` per worker.
  - BT: `run_if(any BtAgent)`. Gather due entities without exclusive access. Intern blackboard keys (UE-style `FKey` ids).
- Risk: low to medium. Determinism: keep ordered writes back, and run in a serial fallback for tests.

**4. Rebakes always re-voxelize, and the main thread re-triangulates moving sources.** *(engine)*
- What we do:
  - `track_sources` runs `TrimeshBuilder` on every `Changed<GlobalTransform>`, on the main thread (`nav/sources.rs:185-209`). A moving door therefore triangulates every frame.
  - `schedule_bakes` gathers all triangles inside the **union box** of all dirty tiles (`:311-329`). Two distant changes pull in the whole map between them.
  - A source below `origin_y` forces a full rebake (`:291`).
  - Each dirty tile goes through the full rasterize→erode pipeline (`bake.rs:131-576`).
- What UE/Detour do: Detour/UE cache compressed heightfield layers per tile and carve obstacles (cylinder/box) into those layers without re-rasterizing (`Navmesh/Public/DetourTileCache/DetourTileCache.h:63,151`). In UE, `CompressedLayers` and dynamic-modifier-only rebuilds (`RecastNavMeshGenerator.h:293-395`) are time-sliced.
- Impact: today a rebake costs 0.3–0.6 ms CPU per tile, plus main-thread triangulation for moving sources and a 0.2 s debounce. On streamed terrain each `origin_y` drop costs a 380 ms CPU full bake (1024 tiles). A layer cache with obstacle carving would cost about 0.05–0.1 ms per tile, with no main-thread work.
- Fix:
  - Store each tile's compact field after erosion, about 30–60 KB per tile with RLE.
  - Add `NavObstacle {shape}` that only marks cells and re-runs the rect partition.
  - Gather triangles per dirty tile instead of the union box.
  - Give each tile its own `origin_y`.
  - Cache local-space triangles per collider and transform them on the worker.
- Risk: medium (memory, extra code paths).

**5. A* data layout.** *(engine)*
- What we do:
  - `Node` is about 88 B because it embeds `Option<Link>` (`nav/query.rs:59-68`).
  - Every neighbour does a `HashMap<PolyRef,u32>` lookup (`:89,184`).
  - The `BinaryHeap` uses lazy deletion.
  - `for_each_link` hashes `offmesh_from` on **every expansion**, even when there are no links (`nav/mesh.rs:239`).
  - `find_path_refs` clones the corridor (`query.rs:136`).
- What Detour does: Detour's nodes are 32 B, with a bucketed hash and decrease-key (`DetourNode.h`). Godot maps polys to dense ids (`nav_mesh_queries_3d.cpp:297`).
- Impact: an estimated 1.5–2× gain, taking the 300 m query from 0.12 ms to about 0.06 ms.
- Fix:
  - Dense node index `tile_base[slot] + poly` into a stamped `Vec<u32>`.
  - Store the link index, not a copy of the `Link`.
  - Keep a per-poly "has off-mesh link" bit.
  - Move the result out instead of cloning it.
- Risk: low.

**6. No path corridor, quick-start path or sliced search.** *(engine)*
- What we do:
  - Every frame, each agent scans its corridor linearly (`agent.rs:246`) and re-sums the whole remaining path (`:280`, `remaining()` at `:129`).
  - Agents wait in a FIFO for a full A* (`paths.rs:81-117`).
  - There is no visibility or topology shortcutting.
- What Detour does:
  - `dtPathCorridor::movePosition`, `findCorners` and `optimizePathVisibility`/`Topology` (`Navmesh/Public/DetourCrowd/DetourPathCorridor.h:78-125`).
  - In crowds, a 20-iteration quick search lets the agent start moving at once (`Private/DetourCrowd/DetourCrowd.cpp:855-861`). The path queue then completes it with sliced `updateSlicedFindPath` (`:43,936`; `DetourNavMeshQuery.h:396-426`), and topology optimisation runs every 0.5 s (`:1063`).
- Impact: CPU per frame is small (about 0.03 ms at 500 agents). The real gain is latency: a mesh change that invalidates 500 corridors currently takes about 16 frames before the last agent moves. With quick-start the latency is one frame.
- Fix:
  - Trim the corridor prefix as the agent advances, so `contains` is O(1).
  - Cache the remaining length.
  - Add a 20-node quick partial path, then a full or sliced refinement.
- Risk: low.

**7. Poly count and the missing area costs.** *(engine)*
- What we do: polys are greedy rectangles (`bake.rs:369-467`). Diagonal or curved walls come out as staircases at cell resolution, and there are no area types (AI.md "Known limits").
- What Recast does: regions → contours → convex polys with up to 6 vertices, plus simplification. The poly count then depends on wall count, not wall angle.
- Impact: on 45° geometry, an estimated 3–10× more polys than Recast. A* and memory scale with that (`Link` is 40 B with two `Vec3`s).
- Fix:
  - Post-pass that merges adjacent rects into convex polys, keeping the rect fast path when a poly has 4 vertices.
  - Area ids with per-query cost multipliers.
  - Remove per-tile allocations in the bake (`bake.rs:184,412-417,521-526`).
- Risk: high (query code assumes rects). Benchmark B below decides whether it is worth it.

**8. Smaller engine items.**
- Point queries: `nearest_poly` and `height_at` scan every poly in each overlapped tile (`nav/mesh.rs:488-541`). Detour uses a per-tile BV tree (`DetourNavMesh.h:307`). Fix: a 48×48 `u16` cell→poly grid per tile (4.6 KB). This only matters in cluttered tiles.
- ORCA ignores walls; agents only slide along them (`agent.rs:397-411`). Detour adds `dtLocalBoundary` segments to avoidance (`DetourLocalBoundary.h:33-66`) and Godot uses an RVO obstacle tree (`nav_map_3d.cpp:485`). Fix: add nearby unlinked rect sides as obstacle lines (`linear_program3` already takes `num_obst`). This is a quality fix, not CPU: crowds jam less in doorways.
- Shroud allocates an `excluded` Vec and a `SpatialQueryFilter` per enemy per frame (`crates/game/src/enemy/mod.rs:530-532`).

## Matched benchmark scenes (engine vs Godot 4.4)

Use the same geometry, exported as glTF from a `NavGeometry` dump, and the same parameters: cell 0.2/0.1, radius 0.4, height 1.8, climb 0.4, slope 45°. Same M5 Pro, release builds, 5 runs, report the median.

**A. Bake, "warehouse300"**
- Scene: 300×300 m floor, 600 crates (a third rotated 45°), 20 ramps, 2 mezzanines.
- Ours: `bake_mesh` with `bake_threads = 1` and with all threads. Godot: `NavigationServer3D.bake_from_source_geometry_data` with `baking_use_multiple_threads` off and on.
- Report: wall ms, CPU ms, polys, mesh bytes. Repeat one crate moving 1 m and report the incremental rebake ms. Godot rebakes whole regions, so use a 4×4 grid of regions for fairness.

**B. 1000 path queries**
- Pairs: 1000 seeded random point pairs (export them as JSON).
- Run twice: (1) each engine on its own baked mesh; (2) the **same graph**, by feeding our rect polys into Godot through `NavigationMesh.set_vertices/add_polygon`.
- Ours: `NavQuery::find_path`. Godot: `NavigationServer3D.query_path`, with `path_postprocessing = corridorfunnel`.
- Report: µs p50/p95, nodes expanded, path length ratio, single-threaded and with all threads.

**C. Crowd circle swap**
- Setup: 200 and 1000 agents on a 120 m floor with 30 pillars. ORCA with neighbour distance 4, max 10 neighbours, horizon 1.5. Godot uses `NavigationAgent3D` with `avoidance_use_multiple_threads` on and off.
- Run: 600 fixed 60 Hz frames, headless.
- Report: AI ms per frame (ours: `ai.steer_ms + ai.path_ms`; Godot: physics-frame time minus a no-agent baseline), time until all agents arrive, and count of overlaps deeper than 10 % of the radius.
- Ours runs as a scenario test next to `bench_ai`.
