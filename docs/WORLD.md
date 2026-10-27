# Large worlds (`engine::world`, feature `world`)

World Partition + Landscape + Foliage, code first: a world is a `WorldDesc` (Rust struct or RON
text) that an agent can write, diff and test; one call spawns it; every part is inspectable
from the control port and testable headless with `App::update()`.

| Unreal / Unity | here |
|---|---|
| Landscape / Terrain | `Terrain`: heightfield (code, noise, 16-bit PNG, raw16) → 128 m chunks, geomipmapped by screen-space error, skirts, 4-layer splat material, per-chunk avian heightfield colliders, height/normal/slope/raycast queries |
| Foliage / Terrain details | `ScatterRule`: deterministic rule-based placement (density, height, slope, noise mask, exclusions, seed); merged clusters (grass) or batched instances with a per-item far tier (trees); trunk colliders through cells |
| World Partition (streaming grid) | `WorldCells`: opt-in `StreamMode::Streamed` loads gameplay data + colliders around `StreamSource`s, coarse fallback collider always loaded, `StreamFreeze` for bodies outside |
| HLOD | per-cell, per-material merged + vertex-clustered proxies built in background tasks |
| Origin rebasing / World Composition | `OriginSettings` floating origin; `WorldOrigin` absolute↔local |
| Level / prefab placement in the editor | `WorldDesc` placements + rule-based groups (villages), data prefabs + code prefabs, cell hooks |

`EnginePlugin` adds `WorldPlugin` (feature `world`, on by default). It costs nothing until a
world is spawned: every system early-outs on a missing resource.

## Quick start

```rust
use engine::prelude::*;
use engine::world::*;

fn setup(mut commands: Commands) {
    let desc = WorldDesc::from_ron(include_str!("../assets/world.ron")).unwrap();
    commands.queue(SpawnWorld(desc)); // or spawn_world(world, desc) / spawn_world_with(world, desc, Some(heightfield))
}
```

```ron
(
    seed: 7,
    terrain: (size: (4096.0, 4096.0), spacing: 2.0, chunk_quads: 64,
              source: Noise((amplitude: 700.0, exponent: 2.4, fbm: (frequency: 0.0006, octaves: 7, ridged: 0.45, warp: 140.0)))),
    cell_size: 256.0,
    streaming: Some(Streamed),
    materials: { "plaster": (color: (0.86, 0.80, 0.68)) },
    prefabs: {
        "hut": (parts: [
            (shape: Cuboid((6.0, 3.0, 5.0)), material: "plaster", at: (0.0, 1.5, 0.0)),
            (shape: Cone(radius: 4.8, height: 2.6), color: Some((0.62, 0.48, 0.25)), at: (0.0, 4.3, 0.0), collider: false),
        ], clear_radius: 7.0, tags: ["house"]),
    },
    placements: [(prefab: "hut", at: (120.0, 0.0, -40.0), yaw: 30.0)],      // y = offset above ground
    groups: [(prefabs: ["hut"], center: (600.0, 300.0), radius: 90.0, count: 18, min_spacing: 16.0)],
    scatter: [
        (name: "grass", mesh: Grass, density: 3.0, cluster: 16.0, cull: 90.0, slope: (0.0, 26.0)),
        (name: "pines", mesh: Pine, far_mesh: Some(PineLow), render: Instanced, density: 0.006, cluster: 64.0,
         near: 320.0, cull: 1900.0, height: (25.0, 255.0), mask: Some((frequency: 0.0022)), threshold: 0.42,
         shadows: true, collider: Some((radius: 0.35, height: 6.0))),
    ],
    exclusions: [Circle(center: (0.0, 0.0), radius: 40.0)],
)
```

`WorldDesc::to_ron()` writes one back (the example's `--dump-ron <path>`), so an agent can start
from a generated world and edit it. Generation is deterministic: same description + seed = same
world (heights, scatter, village layouts).

## Coordinates

Every `world` API takes **absolute** metres (f32 XZ, heights as-is). With the floating origin
off (default) that is Bevy world space. With it on, Bevy space = absolute − `WorldOrigin.offset`
(`origin.to_abs(local)`, `origin.to_local(abs)`). Everything the world spawns sits under one
`WorldRoot` entity whose transform is `-offset`.

## Terrain

- **Data**: `Heightfield` (row-major f32 grid, `spacing` metres, absolute `origin`). Sources:
  `from_fn`, `from_noise(NoiseTerrain)`, `from_png` (8/16-bit greyscale, black→min, white→max),
  `from_raw16` (World Machine / Gaea `.r16`), `flat`; `to_png16` exports. Built on all cores
  (2049² samples of 7-octave warped noise: ~75 ms on an M5 Pro).
- **Queries** (`Terrain` resource): `height_at`, `normal_at`, `slope_deg`, `raycast`,
  `on_ground`, `chunk_at`. Heights use the *same triangulation* as the mesh and parry's
  heightfield (each cell split along its (x0,z1)–(x1,z0) diagonal), so a body resting on the
  collider is exactly at `height_at` (tested to 2 cm against avian raycasts, including chunk
  borders).
- **LOD**: chunks of `chunk_quads`² quads (64 → 128 m at 2 m spacing). LOD n draws every 2ⁿ-th
  sample. Per chunk and LOD the exact worst height error is precomputed; a chunk takes the
  coarsest LOD whose error projected at its distance is under `TerrainSettings::pixel_error`
  (default 2 px at `screen_scale` 935 ≈ 1080p/60°) and that `lod_distance · 2^(n-1)` allows
  (full detail within one chunk size), with 15 % hysteresis when coarsening. Flat chunks go
  coarse immediately, rough ones stay detailed. Meshes are built in background tasks (8 in
  flight), nearest first; the old mesh stays until the new one is ready (no holes).
- **Seams**: vertical skirts along every chunk edge. Depth per chunk/LOD =
  `max over edges (edge error at my LOD + worst edge error at any LOD) + margin`, which bounds
  any T-junction gap between neighbours at any LOD pair (`skirts_cover_every_lod_mismatch`
  checks every pair). Vertex normals come from the full-res heightfield, so neighbours agree.
- **Material**: `TerrainMaterial = ExtendedMaterial<StandardMaterial, TerrainExt>` (PBR
  lighting, shadows, fog). An RGBA8 splat map over the whole terrain blends 4 layers per pixel;
  each layer is a colour, roughness and optional tiling texture (world-XZ UVs), plus a
  low-frequency variation noise. The splat map is generated from `SplatLayer` rules (height
  band, slope band, softness, noise, weight) on all cores. Default layers: grass, rock (slopes),
  sand (low), snow (high).
- **Colliders** (`physics`): one avian heightfield per chunk, owned by the chunk's cell.
- Tags: chunks are `Scenery + KeepDetail` (the render budget leaves them alone).

## Scatter

`ScatterRule`s place items on a jittered grid in absolute space (one candidate per
`1/sqrt(density)` cell, everything derived from a hash of world seed, rule seed and grid cell),
filtered by terrain bounds, height band, slope band, an `Fbm` mask with a soft threshold,
global exclusions (+ every placed prefab's `clear_radius`) and per-rule exclusions. Placement
doesn't depend on cluster or cell size or load order: colliders (per cell) and visuals (per
cluster) always agree and two runs with a seed are identical.

Rendering, per rule, in clusters of `cluster` metres spawned while the camera is within `cull`
(× quality detail scale × `ScatterSettings::distance_scale`), built in background tasks:
- `Merged` (default; grass, flowers, bushes): one merged mesh per cluster with per-item tint.
- `Instanced` (trees, rocks): entities sharing one mesh + material (Bevy batches them into
  instanced multi-draw-indirect calls). With a `far_mesh` (e.g. `PineLow`) every item has a far
  entity (no shadows) that fades in at `near` and lasts to `cull`; the detailed tier is spawned
  only for clusters within `near` (+ hysteresis). Both tiers fade per item (exact crossfade).
  No per-cluster meshes for these rules: an earlier version merged the far tier per cluster,
  and the constant alloc/free of differently sized meshes while flying fragmented Bevy's mesh
  slab allocator into 2.8–5 GB footprint spikes (steady 1.2 GB after the change).
- `ScatterSettings::max_items_per_frame` (1000; a merged cluster costs one per 500 vertices) caps what spawns per frame, so a pose
  change or teleport doesn't spike.
- Dithered `VisibilityRange` fades. Cluster origins sit at the cluster centre on the ground:
  Bevy's GPU dither measures distance to the mesh *origin*, so an origin at y = 0 under a
  150 m hill hid all grass (found by screenshot; now covered by a test of cluster bounds).
- Built-in low-poly meshes (`Grass`, `Flowers`, `Pine`, `PineLow`, `Broadleaf`,
  `BroadleafLow`, `Rock`, `Bush`) or `Named(..)` meshes registered in `WorldAssets::meshes`.
- `collider: Some((radius, height))`: an upright cylinder per item, spawned with its cell.

## Cell streaming (gameplay data + colliders)

A cell (`cell_size`, rounded to whole chunks) owns, while loaded, a `WorldCell` root with its
terrain chunk colliders, placed prefabs, scatter colliders and whatever cell hooks spawn.

- `StreamMode::Resident` (**default**): every cell loads at spawn and stays. Physics, AI and
  navigation see the whole map, like the render budget's "colliders are never streamed" rule.
- `StreamMode::Streamed` (opt-in): cells within `load_radius` of any `StreamSource` (the main
  camera always counts) load nearest first, `loads_per_frame` per frame; beyond
  `unload_radius` from every source they unload (root despawned). A coarse heightfield collider
  (`coarse_step` samples, min-pooled so it is never above the real ground, `coarse_margin` below
  it) covers the whole map at all times. Terrain *visuals* are never streamed (they're LOD'd);
  far cells keep drawing their HLOD proxy.

**Contract for games in streamed mode**
- Per-cell gameplay data: `cells.on_load(|commands, ctx| ...)` or read `CellLoaded`; parent it
  to `ctx.root` to unload with the cell. Keep state you need across unloads keyed by `CellId`
  (`CellUnloaded` fires after the despawn).
- The player and AI agents that must keep simulating get `StreamSource { radius }` (e.g. 64 m
  for an agent): the ground and obstacles around them stay loaded.
- Dynamic bodies that may end up outside loaded cells get `StreamFreeze`: while their cell is
  unloaded they get avian `RigidBodyDisabled` (+ `Frozen`), and resume when it loads.
- Teleports / far spawns: check `cells.ready_around(p, r)` (or `world.teleport`'s `ready`) or wait
  for `CellLoaded`. Until then the coarse collider catches anything that falls.
- Don't parent dynamic actors to a cell root (they'd unload with it and be hidden with its
  prefabs when the cell shows its HLOD).

## HLOD

At spawn, each cell's data-prefab parts are grouped by material, merged (`merge_meshes`) and
simplified by vertex clustering (`simplify_clustered`: positions snapped to a `voxel` grid and
split by dominant normal axis, so boxy architecture keeps its hard edges) in background tasks.
Beyond `HlodSettings::distance` (to the cell rectangle, with a hysteresis band) a cell's
prefabs are hidden and its proxies (one draw per material, no shadows) shown until `view`. In
streamed mode the proxies outlive the cell's prefabs, so villages on the horizon stay. Code
prefabs and `no_hlod` prefabs aren't merged.

## Floating origin

`OriginSettings { enabled: true, threshold: 2048, snap: 256 }`: when the main camera is
farther than `threshold` from Bevy's origin (XZ), the scene moves by the snapped camera
position in `First`: every root `Transform` and every `GlobalTransform` shift (so the frame
stays consistent), the `WorldRoot` is set to `-offset` exactly, avian picks the move up from
`GlobalTransform` (velocities kept), the terrain material's world extent is updated, and
`OriginShifted { delta, offset }` is written. `world::origin::rebase_to(world, abs)` rebases
on demand (before a long teleport).

What games must do: keep long-lived positions (saves, quest markers, AI memory, network state)
absolute (`to_abs`) or re-base them on `OriginShifted`; positions that live only in
`Transform`s are handled. Heights are never shifted.

## Prefabs and registry

`WorldAssets` (resource) holds data prefabs (`PrefabDef`: parts with `ShapeDesc` —
`Cuboid`, `Cylinder`, `Sphere`, `Cone`, `Capsule`, `Mesh(name)` — material name or colour,
transform, `collider`), code prefabs (`add_code_prefab(name, |commands, ctx| ...)`), named
meshes and materials (`MaterialDesc` or `#rrggbb` keys, created once and shared). Placed
instances carry `PrefabInstance` and `WorldTags`. Without a renderer (headless) prefabs spawn
colliders and gameplay components only.

## Control commands

| Command | Params | Result |
|---|---|---|
| `world.stats` | — | `WorldStats` (terrain chunks/LOD histogram/triangles/mesh bytes, cells, colliders, scatter per rule, HLOD, origin, world CPU µs) + mode, bounds, height range |
| `world.cells` | `{all?}` | `{cell_size, dims, loaded: [[x,z]…], queued, mode}`; `all`: every cell with state and prefab count |
| `world.height` | `{x, z}` | `{height, normal, slope_deg, inside, chunk, lod, cell, loaded}` |
| `world.teleport` | `{x, z, y?, up?}` | moves the player `StreamSource` (no radius) or the main camera's root; `{at, ground, cell, ready}` |
| `world.settings` | `{mode?, pixel_error?, load_radius?, unload_radius?, scatter?, scatter_scale?, hlod?, hlod_distance?, origin?}` | current values |

Metrics (dev builds): `world.cpu_us`, `world.terrain_triangles`, `world.terrain_chunks_drawn`,
`world.cells_loaded`, `world.scatter_instances`, `world.scatter_clusters`, `world.hlod_cells_far`.

## Settings (`WorldSettings`, build with `..default()`)

`terrain` (pixel_error 2, screen_scale 935, lod_distance = chunk, hysteresis 0.15, 8 builds in
flight, max_lod 6, view_distance ∞, colliders), `streaming` (mode Resident, load 400 m,
unload 480 m, 2 loads/frame, coarse_step 8, coarse_margin 0.05), `scatter` (enabled,
distance_scale 1, follow_quality, 16 builds in flight, hysteresis 16 m, resident false,
max_items_per_frame 1000; a merged cluster costs one item per 500 vertices),
`hlod` (enabled, distance 320, view 4000, voxel 1 m, hysteresis 24), `origin` (off, 2048, 256).

## Example and measurements

`examples/open_world.rs`: 4 × 4 km, 2 m samples (2049², 1024 chunks), 4 splat layers, 12
villages (~200 prefabs) on flat spots, grass / flowers / pines / broadleaf / rocks / bushes,
streamed cells, HLOD. `--baseline` = nothing streamed (resident cells: all colliders and
prefabs; every tree and rock spawned; no HLOD). Poses: `overview`, `valley`, `ground`,
`forest`, `ground`, `fly` (`cam.pose {name}`); WASD + right mouse fly freely; `debug.scatter {name}`
lists a rule's nearby cluster entities with their visibility state.

```sh
python3 -I scripts/play.py scripts/open-world.json --example open_world          # screenshots
python3 -I scripts/play.py scripts/open-world-perf.json --example open_world -- --uncapped [--baseline]
```

### Measurements

Apple M5 Pro, `--offscreen --uncapped` (vsync off), High quality, 1920×1080, 4 × 4 km world
(2049² samples, 1024 chunks, 256 cells of 256 m, ~200 prefabs, ~170 k scatter items in
range of a full map), driven by `scripts/open-world-perf.json` (15 s settle per pose; frame
stats over the last ~600 frames). Streamed and baseline ran back to back; the machine was
shared with other agents' builds (load average ~10), so absolute fps are pessimistic and
noisy (±15 %); counts are exact.

| pose | mode | fps | p50 ms | p95 ms | GPU ms | entities | colliders (terrain + scatter) | world CPU µs |
|---|---|---|---|---|---|---|---|---|
| ground (village meadow) | **streamed** | 152 | 6.5 | 7.4 | 3.0 | 25 k | 40 + 2 776 | 163 |
| ground | baseline (nothing streamed) | 67 | 15.1 | 19.7 | 3.8 | 184 k | 1 024 + 83 440 | 374 |
| overview (900 m up, corner) | **streamed** | 187 | 5.3 | 6.2 | 3.1 | 22 k | 44 + 3 523 | 131 |
| overview | baseline | 55 | 16.1 | 31.7 | 4.2 | 184 k | 1 024 + 83 440 | 468 |
| fly (60 m/s, 90 m up) | **streamed** | 180 | 5.5 | 7.1 | 3.9 | 34 k | 64 + 5 241 | 139 |
| fly | baseline | 55 | 17.5 | 27.1 | 3.2 | 185 k | 1 024 + 83 440 | 396 |

- The win is CPU: ~7× fewer entities and ~16× fewer colliders → 2.7–3.3× shorter frames.
  GPU time is about the same (the GPU never drew what was out of range: dithered visibility
  ranges cull it either way).
- Memory (process footprint, Metal included): 1.2–1.7 GB in both modes, dominated by the
  renderer's fixed costs (shadow cascades, TAA/SSAO targets, pipelines) — at 4 km the streamed
  content itself is small: heightfield 16.8 MB, splat map 16.8 MB (GPU), terrain chunk meshes
  20–24 MB, instanced trees share one mesh per tier. Streaming saves CPU and physics memory
  (83 k fewer colliders), but sampled footprint varies ±400 MB run to run with allocator
  high-water marks after pose jumps, so no reliable total-memory delta is claimed.
- A fault found by measuring: an earlier version merged the far tree tier per 64 m cluster;
  flying at 60 m/s allocated and freed ~100 differently sized meshes per second and Bevy's mesh
  slab allocator fragmented into 2.8–5.0 GB footprint spikes (+760 MB RSS, +500 MB Metal) after
  ~55 s. With per-item instanced far tiers footprint stayed at 1.15–1.32 GB over 90 s of flight
  (sampled every 3 s).
- Terrain: 0.40 M (overview) – 1.29 M (fly) triangles for all 1024 chunks; LOD histogram in
  flight ≈ [74, 147, 309, 354, 135, 5] chunks at LOD 0..5. The world's own systems cost
  0.08–0.16 ms CPU per frame streamed (0.25–0.47 ms baseline, more clusters/cells to visit).
- Startup: heightfield 2049² (7-octave warped noise) 68 ms + `spawn_world` 54–62 ms (chunk
  LOD tables, 2048² splat map, HLOD jobs queued), both on all cores; chunk meshes and scatter
  clusters then stream in from background tasks over the first second.
- Headless tests: the 7 integration tests (1 km² worlds with avian) run in 0.13 s.

## Render budget interplay

No changes to `src/render_budget`: world entities are tagged `Scenery` (+ `KeepDetail` for
terrain chunks, cell roots and HLOD proxies) or carry their own `VisibilityRange`, which the
budget's distance detail skips; scatter distances follow `QualityPreset::detail_scale` by
reading the budget's `EffectiveRanges`. Set `SceneryRanges::view` beyond your fog for any other
scenery in an open world (the example uses 4000 m).

## Tests

- Unit (`cargo test --lib world`): noise determinism, heightfield sampling/normals/raycast/PNG16
  and raw16 round trips, coarse collider never above, chunk layout/padding, LOD errors and
  hysteresis, same-LOD seams bit-identical, **skirts cover every LOD pair's gap**, skirts face
  out, splat rules, scatter determinism/partition independence/filters, cluster bounds, HLOD
  merge counts and clustering, prefab RON, desc RON round trip, origin rebase.
- Integration (`cargo test --test world`, headless `App::update()` with avian): heights equal
  avian raycasts on chunk colliders; resident cell/collider counts; scatter colliders identical
  for a seed and different for another, clear of village clearings; streaming loads within the
  budget, colliders only in loaded cells, coarse fallback under unloaded cells, `StreamFreeze`
  freezes and resumes, `StreamSource` agents keep cells, switching modes at runtime; HLOD merge
  vertex counts (a 4 m box keeps 24 vertices; villages shrink); floating origin rebase keeps
  absolute positions and physics; code prefabs + cell hooks load/unload with cells; all
  `world.*` commands.

## Known limits

- Terrain is read-only after spawn (no runtime sculpting / holes / caves); edits need a respawn.
- No terrain virtual texturing or per-layer normal/roughness maps; layer textures share one UV
  scale per layer; no triplanar on cliffs.
- Grass has no wind or interaction; no GPU-driven grass (merged CPU clusters instead).
- HLOD simplification is vertex clustering (cheap, robust, can look blobby on organic meshes);
  no impostors/billboards for trees (the far tier is a cheaper mesh).
- Streaming loads cell content on the main thread (spawning); a cell with thousands of prefabs
  costs a frame spike — keep `loads_per_frame` low or cells small. Cell content is not saved.
- Floating origin shifts XZ only and iterates every `GlobalTransform` once per rebase.
- Water, roads/splines, and navmesh generation are not part of this module.
