# Navigation & AI (`engine::ai`, feature `ai`)

Code-first equivalents of Unreal's Navmesh + Behavior Trees + AI Perception and Unity's
NavMesh/NavMeshAgent, with no editor or baked binary assets. A level made of avian colliders gets a
navmesh automatically, baked in the background. Agents path-find, steer and avoid each other.
Behaviour trees and utility scorers are plain Rust values. Every part can be inspected over the
control port and tested headless with `App::update()`.

`EnginePlugin` adds `AiPlugin` when the `ai` feature is on (default; it needs `physics`). If
nothing uses it, the cost is a few empty system runs per frame.

```text
colliders ──track_sources──▶ SourceCache ──dirty tiles──▶ bake job (AsyncComputeTaskPool)
                                                          │ voxelize → filter → compact → erode → rects
NavLink ──sync_links──▶ NavMeshes (one per agent type) ◀──┘ swap tiles + relink, NavMeshChanged
                          │
 NavPathQueue / agents ──process_paths (budget)──▶ A* over polys + funnel ──▶ NavAgentState.path
 steer_agents: follow corners → arrive → separation → ORCA → move_along_surface / LinearVelocity
 tick_agents (exclusive): UtilityAi + BtAgent trees with closures over (world, entity, blackboard)
 update_perception: cone filter → stalest-first LOS rays (budget) → Perception memory; Noise → hearing
```

## Navmesh

### Sources
- Every avian `Collider` on a static body (or one with no body) is baked. `Sensor`s, entities
  tagged `NavIgnore` and `NavAgent`s are skipped.
- `NavSource` adds a kinematic or dynamic collider (a door, a pushable crate), or a plain `Mesh3d`
  with no collider (its asset must keep `MAIN_WORLD` usage).
- Pure code: `NavGeometry` (a triangle soup with `push_box` / `push_quad` / `push_indexed`), then
  `nav::bake_mesh(&settings, &mut geom)`. No ECS is needed, which suits tools and unit tests.

### Settings (`NavMeshSettings`, one per agent type in `AiConfig::agent_types`)
| field | default | meaning |
|---|---|---|
| `cell_size` / `cell_height` | 0.2 / 0.1 m | voxel size |
| `agent_radius` / `agent_height` / `agent_climb` | 0.4 / 1.8 / 0.4 m | erosion, clearance, step height |
| `max_slope_deg` | 45 | steeper triangles aren't walkable |
| `tile_size` | 48 cells (9.6 m) | rebake unit; tiles are aligned to world (0, 0) |
| `flatness` | 0.25 m | height error allowed when merging cells into one poly |
| `max_poly_cells` | 0 (tile size) | cap on poly edge length |
| `filter_ledges` / `filter_low_hanging` | true | Recast's filters |

To give agents of different sizes their own mesh, add more entries to `agent_types` and set
`NavAgent::agent_type`. Change the config at runtime and every mesh is rebuilt.

### Baking (Recast-style, our own implementation)
1. Rasterize triangles into a span heightfield per tile, plus a border of `radius + 3` cells
   so the tile edges come out right.
2. Run the filters: low-hanging obstacles, ledges (drops deeper than `climb`), and spans without
   enough clearance.
3. Build a compact open-span field with 4-neighbour connections.
4. Erode by the agent radius (chamfer distance field).
5. **Regions → polys:** a greedy partition into maximal rectangles of connected cells whose
   heights fit a plane within `flatness`. Each rectangle gets per-corner heights, so ramps stay
   one poly. Links are the shared runs along the sides. Cross-tile links are rebuilt when a tile
   or its neighbour changes.

Polys are axis-aligned rectangles, not Recast's general convex polygons. Nearest-point, height
and raycast queries are therefore branch-light, and a flat floor is about one poly per tile.
Diagonal walls produce staircase edges at cell resolution.

Bake jobs run on `AsyncComputeTaskPool`, one task per chunk of tiles. When every task has
finished, all of the job's tiles are swapped in together. `AiConfig::async_bake = false` bakes in
the frame instead, which gives deterministic tests.

**Incremental rebakes:** when a source is added, moved, resized or removed, the tiles under its
old and new bounds are marked dirty. After `rebake_delay` (0.2 s debounce), only those tiles are
rebaked. `NavMeshChanged { agent_type, tiles }` is sent, and agents whose corridor crossed a
changed tile request a new path. `NavMeshes::request_full_rebake()` (or `ai.nav.bake`) rebakes
everything.

### Off-mesh links
Spawn `NavLink(OffMeshLink { start, end, bidirectional, cost, tag, .. })`, or call
`NavMesh::add_offmesh_link` without the ECS. Each end snaps to the nearest poly within `radius`.
A* uses `length × cost`. In a path, the link's start point has `offmesh = Some(index)`. Agents
switch to `NavStatus::TraversingLink`: `Transform` agents move along the link in a straight line
at `max_speed`, `Velocity` agents steer at its end, and `Manual` agents see the status and do the
jump or climb themselves.

### Queries (`nav::query`, no allocation after warm-up except the returned path)
- `NavQuery::find_path(mesh, from, to, extents, max_nodes)` runs A* over polys (portal midpoints)
  and then the simple-stupid-funnel. It returns `NavPath { points, polys, complete }`. When the
  goal can't be reached, the path ends at the closest reachable point and `complete` is false.
- `raycast(mesh, ref, from, to)` walks the surface and reports the first wall: `t`, the point and
  the normal.
- `move_along_surface(mesh, ref, from, to)` slides along walls (agents use it).
- `NavMesh::nearest_poly` / `nearest_point` / `height_at`.
- `random_point(mesh, rng)` picks a point weighted by area. `random_point_around(mesh, ref,
  center, radius, rng)` picks one reachable from `ref`.
- Budgeted async API: `NavPathQueue::request(from, to, agent_type) -> PathTicket`, then
  `take(ticket)`. Each answer also sends a `PathReady(ticket)` message. At most
  `path_queries_per_frame` (32) are answered per frame, and answering stops after
  `path_budget_ms` (1 ms), although at least one query always runs. Agents share the same queue.

## Agents (`NavAgent` + `NavAgentState`)
```rust
commands.spawn((NavAgent { radius: 0.3, max_speed: 3.0, ..default() }, Transform::from_xyz(0.0, 0.0, 0.0)));
state.set_target(goal);   // NavAgentState: status Pending → Moving → Arrived (or Failed)
```
- Steering: the agent follows path corners (it advances within `radius / 2`), slows down
  linearly inside `slowing_distance`, and has arrived within `stop_distance`. Acceleration is
  capped at `max_accel`.
- Avoidance: ORCA (RVO2's linear programs) against up to `avoidance_max_neighbors` (10) agents
  within `avoidance_neighbor_dist` (4 m), with time horizon `avoidance_time_horizon` (1.5 s).
  Agents with `avoidance: false` are treated as obstacles that won't move. `separation` adds a
  push away from neighbours for looser crowds.
- Motion: `NavMotion::Transform` (default) moves the Transform along the mesh surface with wall
  sliding, so no physics is needed. `Velocity` writes avian `LinearVelocity` XZ and leaves gravity
  to physics; use it for kinematic or dynamic bodies. `Manual` fills `desired_velocity` for your
  own controller (e.g. `FpsInput` on bots). `base_offset` is the height of the Transform origin
  above the feet, e.g. half a capsule. `turn_speed` turns the agent to face its movement.
- Re-pathing: when the corridor's tiles change, or when the agent is pushed out of its corridor
  (throttled to once every 0.5 s).

## Decision making
**Behaviour trees** (`bt.rs`) are built with constructor functions and run per entity with
`BtAgent` + `Blackboard`:
```rust
let tree = BehaviorTree::new(Bt::reactive_selector("guard", [
    Bt::sequence("chase", [Bt::condition("sees", |c| sees(c)), Bt::action("run", run_at)]),
    Bt::sequence("patrol", [Bt::action("to a", to_a), Bt::wait(1.0), Bt::action("to b", to_b)]).forever(),
]));
commands.spawn((BtAgent::new(tree.clone()).with_interval(0.1), Blackboard::default(), NavAgent::default()));
```
- Composites: `sequence` and `selector`, which remember the running child; `reactive_sequence`
  and `reactive_selector`, which re-check earlier children every tick and abort the running one;
  `parallel(success_n, failure_n)`; and `utility(hysteresis, [(score, child)])`.
- Decorators: `invert`, `succeed`, `fail`, `repeat(n)`, `forever`, `retry(n)`, `timeout(s)`,
  `cooldown(s)`, `Bt::guard(cond, child)`. Leaves: `condition`, `action`, `wait(s)`.
- Leaves get `BtCtx { world, entity, bb, dt, now }`, with full `&mut World` access. While a tree
  runs, the entity's own `BtAgent` and `Blackboard` are moved out. Trees are `Arc`-shared and
  immutable, and each agent keeps a small runtime array. `tick_interval` sets the tick rate and
  staggers agents across the interval.
- Ticking is deterministic: the same world and blackboard give the same result (tested).
- Inspection: `BtAgent::active_path()` lists the running node names, e.g.
  `["guard", "chase", "run"]`. `to_json()` gives the full tree with each node's last status,
  `running`, `ticked` this tick, and utility scores.

**Utility AI** (`utility.rs`): `UtilityAi::new([UtilityOption::new("eat").weight(1.0)
.consider(Consideration::new(name, input_fn, min, max, Curve::Logistic{..}))])`. Each input is
normalized, run through a curve, and the results are multiplied using Dave Mark's compensation
factor. The pick has `hysteresis` and is written to `bb["utility"]`. The same scorers work inside
`Bt::utility`.

**Blackboard**: a small ordered map from string keys to `Bool / Int / Float / Vec3 / Entity /
Text`, with typed getters and `to_json`.

## Perception
- `Perceiver { sight_range, fov_deg, eye_height, hearing, memory_secs, team }` looks along the
  Transform's forward direction (-Z). `Perceivable { team, aim_height }` marks things that can be
  seen.
- Sight runs in two stages. First, a cheap filter (a grid over targets, then range, then the
  cone). Then the `sight_rays_per_frame` (64) stalest pairs get an avian line-of-sight ray. The
  ray ignores the perceiver and its children, and counts the target or its children as a hit.
  Pairs that aren't raycast this frame keep their last result. Visible targets are tracked every
  frame, and they become invisible as soon as they leave the cone.
- Hearing: `Noise { pos, radius, source }` messages reach perceivers within `radius × hearing`.
- Memory: `Perception::known` holds a `Percept` for each target: last position, time, visibility
  and sense. Entries are forgotten `memory_secs` after they were last sensed. Helpers: `sees(e)`,
  `last_known(e)`, `visible()`, `most_recent()`.

## Debug
`AiDebug { navmesh, paths, agents, perception, agent_type }` turns on gizmos:
- poly outlines with a diagonal, and off-mesh links as orange arcs;
- agents as discs coloured by status, with a velocity line;
- remaining path corners;
- sight cones (magenta), with lines to visible targets and spheres at remembered positions.

Gizmos only run when Bevy's gizmo plugin exists (windowed). The `ai.nav.debug` command toggles
them. Example: `cargo run --example ai_crowd -- --play --ai-debug [--agents 300]`.

## Control commands (feature `devtools`)
| command | params | result |
|---|---|---|
| `ai.nav.bake` | — | deferred: full rebake, replies with stats when finished |
| `ai.nav.path` | `from`, `to` ([x,y,z]), `agent_type?` | `complete, length, points[{pos, offmesh}], polys, nodes, us` |
| `ai.nav.raycast` | `from`, `to` | `hit, t, point, normal` |
| `ai.nav.nearest` | `pos` | `found, point, distance` |
| `ai.nav.stats` | — | per mesh: tiles/polys/area/links/bounds; last bake (tiles, polys, cpu/wall ms, gather ms); sources |
| `ai.nav.debug` | `on?`, `navmesh?`, `paths?`, `agents?`, `perception?`, `agent_type?` | the flags |
| `ai.agents` | `limit?` | `count`, rows with entity, pos, status, target, speed, path, remaining |
| `ai.agent.goto` | `to`, `entity?` (bits or index; all agents if omitted) | number of agents sent |
| `ai.bt` | `entity?` (first BT agent if omitted) | `bt` (tree JSON + active path), `utility`, `blackboard` |
| `ai.perception` | `entity` | known percepts |
| `ai.noise` | `pos`, `radius?` | emits a `Noise` |
| `ai.stats` | — | `AiStats` (per-frame µs and counts) |

`scripts/ai-crowd.json` drives the example: it takes screenshots with debug off and on, makes a
noise, and dumps a BT. Run it with
`python3 -I scripts/play.py scripts/ai-crowd.json --example ai_crowd`.

Metrics (dev builds): `ai.agents`, `ai.steer_ms`, `ai.path_ms`, `ai.path_queries`,
`ai.think_ms`, `ai.sense_ms`, `ai.sight_rays`, `ai.nav_bake_ms`.

## Measurements
Apple M5 Pro, dev profile: engine code at opt-level 1, dependencies at 3. A release build is
faster still. Headless numbers come from `cargo test --test ai -- --ignored --nocapture
bench_ai`, which also writes the `ai` bench report (`scripts/bench.py`).

**Bake** (`AsyncComputeTaskPool`, all tiles):
| level | tiles | polys | wall ms | CPU ms (all threads) | main-thread gather |
|---|---|---|---|---|---|
| 100×100 m floor + 60 crates | 144 | 655 | 14–16 | 42–51 | 0.07–0.11 ms |
| 300×300 m floor + 600 crates | 1024 | 6124 | 102 | 381–390 | 0.3 ms |
| ai_crowd arena (60×60 m, 11 colliders) | 64 | 167 | 12.8 | 19.5 | 0.06 ms |

An incremental rebake after one crate moves touches its 1–4 tiles: about 0.3–0.6 ms of CPU
(≈ CPU ms ÷ tiles), off the main thread.

**Paths**: 200 cross-map queries cost 0.013–0.015 ms each on 100 m (92 m paths) and
0.12–0.13 ms each on 300 m (272 m paths, 6 k polys).

**Crowds** (headless, 120 m floor, agents crossing a circle to the opposite side, all moving):
| agents | steer + ORCA + move | path queue | whole headless frame |
|---|---|---|---|
| 100 | 0.043 ms | ~0 | 0.39 ms |
| 500 | 0.18 ms | 0.004 ms | 0.54 ms |

**Behaviour trees + perception** (headless; every agent has a patrol BT ticking every frame, and
every agent is both perceiver and perceivable):
| agents | BT tick | perception | rays/frame | in-cone pairs |
|---|---|---|---|---|
| 100 | 0.015 ms | 0.08 ms | 64 | 1 570 |
| 500 | 0.06 ms | 0.9 ms | 64 | 60 679 |

The 500 row is a stress case in which every agent sees 120 others. Cost grows with the number of
in-cone pairs, not with agents: 0.9 ms for 60 k pairs. Rays stay capped at the budget.

**Windowed** (`ai_crowd` example, `--offscreen --uncapped`, 1920×1080, High; 2 BT guards with
perception plus N wanderers, each a capsule mesh):
| agents | fps | p50 ms | p95 ms | `ai.steer` | `ai.sense` |
|---|---|---|---|---|---|
| 0 | 305 | 3.11 | 4.13 | 0.001 ms | 0.004 ms |
| 100 | 226 | 4.42 | 4.80 | 0.047 ms | 0.013 ms |
| 500 | 233 | 4.49 | 4.95 | 0.39 ms | 0.051 ms |
| 500 + all debug gizmos | 218 | 4.46 | 5.52 | | |

Going from 0 to 100 agents adds about 1.3 ms. That is the rendering and render-budget cost of
100 extra meshes with shadows, not AI: the AI systems together take under 0.1 ms. From 100 to
500, frame time barely moves. Inside a running app, steering at 500 agents is 0.39 ms against
0.18 ms headless, because of contention with the render and physics threads.

## Known limits
- Polys are rectangles. Diagonal walls give staircase edges at cell resolution, and a mesh has
  more polys than a Recast one with contour simplification. There is no watershed or monotone
  region pass: regions *are* the rectangles.
- No detail mesh: heights within a poly are bilinear over its corners and accurate to
  `flatness`, so curved terrain becomes many small polys.
- Avoidance doesn't include navmesh walls as ORCA obstacles. Walls are handled by wall sliding
  (`move_along_surface`), so very dense crowds can rub along walls.
- No area types or per-area costs (water, road), no query filters by area, and no dynamic
  obstacle carving without rebaking (moving sources rebake their tiles instead).
- The behaviour tree has no blackboard observers or event-driven aborts beyond `reactive_*` and
  `guard`, and actions get no `on_halt` callback. Keep action state in the blackboard.
- Perception: no peripheral or vision-strength falloff, no team attitudes beyond "same team is
  ignored", and hearing isn't occluded.
- A bake job snapshots all sources overlapping the dirty tiles on the main thread. That is cheap
  (≤ 0.3 ms at 600 colliders), but source triangles are cached per entity in memory.
