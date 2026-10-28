# Procedural content generation (`engine::pcg`, feature `pcg`; `crates/pcg-core`)

Dress a map from data: **points → filters → spawn**, the same mental model as Unreal's PCG.
A graph samples points from the map's shapes (lots, streets, buildings), filters and moves
them, and spawns meshes, decals or lights, or hands the points back to game code. Graphs are
RON files (or Rust), results are deterministic, and they don't depend on how the map is split
into cells.

- **`crates/pcg-core`** (no Bevy): data, graphs, evaluation. Game-logic crates use it directly
  for anything that affects gameplay (cover, props on the nav mesh), so they know it before
  baking navigation.
- **`engine::pcg`**: evaluates graphs per cell on worker threads, caches by cell, spawns the
  results as `Scenery`, scales with quality and the governor, and has control commands.
- Example: `cargo run --example pcg_town --features pcg`; graph `assets/pcg/town.pcg.ron`.

## Quick start

```rust
use engine::pcg::{PcgCatalog, PcgGraphRef, PcgVolume};
use engine::pcg::pcg_core::{Area, Inputs, Polyline, Rect};

// 1. Catalog: the graph's item names → assets (once).
catalog.mesh("tree", tree_mesh, leaves_mat).mesh("rock", rock_mesh, stone_mat);

// 2. Inputs: named shape sets from your map.
let inputs = Inputs::default()
    .rects("lots", lots)                 // areas to dress
    .rects("blocks", buildings)          // keep clear of these
    .lines("streets", street_polylines);

// 3. A volume: graph + inputs + area, split into cells.
commands.spawn(PcgVolume {
    graph: PcgGraphRef::Asset(server.load("pcg/town.pcg.ron")),
    inputs: Arc::new(inputs),
    area: Area::new(Vec2::new(-64.0, -48.0), Vec2::new(64.0, 48.0)),
    cell: 32.0,
});
```

The same graph in Rust:

```rust
let g = Graph::build(11)
    .input("lots").poisson(4.0).noise(18.0, 0.35, 0.7).density(0.2, 1.0)
    .difference("blocks", 2.0)
    .node("blocks", Op::Input { name: "blocks".into() }, &[]).from("difference4")
    .transform(Vec3::ZERO, (0.0, 360.0), (0.7, 1.3), 0.0)
    .spawn(&[("tree", 3.0), ("bush", 1.0)], Tier::Normal)
    .finish()?;
```

## Data

| Type | What |
|---|---|
| `Inputs` | Named `Shapes` sets plus an optional ground `Surface` |
| `Shapes` | `rects: Vec<Rect>` (oriented XZ boxes at a height, tagged), `lines: Vec<Polyline>` (3D, open or closed, tagged), `points: PointSet` |
| `Surface` | `Plane(y)` or `Heightfield { origin, cell, width, heights }` |
| `PointSet` | Columns: `pos`, `rot`, `scale`, `extent` (half size), `density` (0..1), `seed`, `tag` (`tag_id(name)`), `attrs` (named f32 columns) |
| `Area` | XZ box, min inclusive, max exclusive; `Area::cell(x, z, size)` |

## Nodes (`Op`)

Distances in metres, angles in degrees. Every node has an `id` and `inputs` (node ids), and
an optional `seed` (default: hash of the id).

| Op | Inputs | Does |
|---|---|---|
| `Input { name }` | – | The named input set (shapes for samplers, points downstream) |
| `GridSample { spacing, jitter }` | an `Input` | World-anchored grid inside its rects; `jitter` 0..1 of a cell |
| `PoissonSample { radius }` | an `Input` | Points about `radius` apart inside its rects |
| `EdgeSample { spacing, offset, side }` | an `Input` | Along rect edges and polylines every `spacing`, `offset` to `side` (`Out`/`In`/`Left`/`Right`/`On`); local −Z faces away from the edge |
| `RectFill` | an `Input` | One point per rect: centre, yaw, size (decals, room props) |
| `DensityNoise { scale, octaves, lo, hi }` | points | Density × value-noise fBm remapped from `[lo, hi]` |
| `DensityFilter { lo, hi }` | points | Keep `lo ≤ density ≤ hi` |
| `Keep { fraction }` | points | Keep with probability `density × fraction` |
| `Difference { against, pad }` | points | Drop points inside `against`'s rects / point boxes (+`pad`) |
| `Intersect { with, pad }` | points | Keep only those inside |
| `SelfPrune { radius }` | points | Drop points with a higher-priority (density, then seed) point within `radius` |
| `ByTag { tags, keep }` | points | Keep (or drop) points from shapes with these tags |
| `Transform { offset, yaw, scale, jitter }` | points | Local offset, random extra yaw and uniform scale ranges, XZ jitter |
| `Project { offset, align }` | points | Onto the `Surface` (+`offset`); `align` tilts to its normal |
| `Copy` | targets, template | A copy of the template points (around the origin) at each target |
| `Union` | 1+ | All inputs' points |
| `Spawn(SpawnDef)` | points | `kind` (`Mesh`/`Decal`/`Light`), weighted `items` (or `by_attr`), `tier`, `collider`, `shadows` |
| `Emit { port }` | points | Hand points back to game code (`PcgEmitted` messages / `Output::emits`) |

`Graph::validate` (also run by `from_ron` and the builder) reports duplicate ids, unknown
inputs, wrong input counts, cycles and bad parameters, naming the node.

## Seeds and partitions (the contract)

- A point's seed is `seed_at(graph.seed, node seed, world position quantised to 1 mm)`. All
  random choices (jitter, noise, yaw, scale, item pick, tier thinning) hash it.
- Samplers use world-anchored grids; pruning only looks at neighbours within its radius; each
  cell is evaluated over the cell plus `Graph::halo` (the sum of every node's reach), then
  clipped. **Splitting a map into 8, 16 or 64 m cells gives exactly the points of evaluating it
  whole** (tested).
- What reshuffles results: the graph seed, a node's id or seed, an op's parameters, inputs
  near the point. What doesn't: cell size, evaluation order, inputs far away, quality.
- Poisson and SelfPrune keep a point unless a higher-priority neighbour exists (not greedy
  elimination): slightly sparser than true Poisson-disk, but local, so partition-independent.

## Execution, cache, output (`engine::pcg`)

- Cells overlapping `PcgVolume::area` evaluate on the async compute pool, nearest the
  `MainCamera` first, `PcgSettings::in_flight` (4) at once.
- Each cell's cache key is the graph hash plus a hash of the inputs within the cell + halo:
  editing a rect regenerates only the cells around it (tested). A graph asset reload
  regenerates everything.
- Each cell gets a root entity (`PcgCellRoot`). Mesh items used ≥ `merge_min_count` (8) times
  in a cell with ≤ `merge_max_vertices` (2048) vertices are merged into one mesh per item;
  others are separate entities sharing handles (Bevy batches them). Everything is `Scenery`, so
  distance detail, shadow trimming and streaming apply. `collider: true` adds the catalog
  collider per point (feature `physics`; the root becomes a static body). Decals need feature
  `look`; lights come from the catalog template (shadows off unless it casts them).
- `PcgSettings::cells_per_frame` (2) cells spawn per frame.
- `Emit` ports arrive once per evaluated cell as `PcgEmitted { volume, cell, port, points }`.

## Scalability

- `Spawn` tiers: `Essential` (gameplay: never thinned), `Normal`, `Fine` (thinned first).
- `PcgScalability { normal, fine }`: fractions kept per graphics quality (Low…Ultra; defaults
  normal 0.6/0.85/1/1, fine 0.25/0.5/0.8/1), × `PcgSettings::density`, × the governor's
  `GovernorStep::PcgDensity(f)` (`GovernorState::pcg_density`; add it to your ladder — it isn't
  in the default one). Thinning is by seed, so a lower setting is a strict subset of a higher
  one; changing it respawns cells from the cache without re-evaluating.

## Control commands (feature `devtools`)

| Command | Params | Returns |
|---|---|---|
| `pcg.stats` | | volumes, cells, pending, evaluations, cache hits, live cell roots, points spawned/thinned, last evaluation µs, errors, density |
| `pcg.inspect` | `x`, `z`, `volume` | points per node in that cell, spawns, emits |
| `pcg.regen` | | regenerate every cell |
| `pcg.scale` | `density` | set `PcgSettings::density` (respawns from cache) |

## Gameplay safety

Anything players collide with, take cover behind or path around is gameplay: mark it
`Essential`, and generate it in the logic crate with `pcg-core` (`Emit` → your own blocks)
**before** the navmesh bake, using the same seed as the client. Visual dressing (grime, litter,
foliage) belongs in the game crate as `Normal` / `Fine`.

## Measurements (Apple M5 Pro, dev build)

`pcg_town` (128 × 96 m, 16 cells of 32 m, town.pcg.ron with 19 nodes): ~80 µs per cell on a
worker thread, ~300 points spawned; density 0.3 respawned all 16 cells from the cache with no
re-evaluation.

## Known limits (v1)

- No streaming by distance yet: every cell of a volume is generated (nearest first).
- `Difference` / `Intersect` test rects and point boxes, not polylines (buffer streets into
  rects to keep things off them).
- No subgraphs, loops, splines (`SplineSample`), grammar (`SubdivideSegment`) or GPU path.
- Merged meshes carry positions, normals, UVs and tangents only (no vertex colours or skinning).
- No gizmo overlay yet; use `pcg.inspect` and screenshots.
