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

## Streaming (`PcgStreaming`)

Without it, every cell of a volume is evaluated and kept for the whole run (output cache, root
entities, emitted points). For large worlds put `PcgStreaming` on the volume entity:

```rust
commands.spawn((PcgVolume { cell: 64.0, ..PcgVolume::new(graph, inputs, area) }, PcgStreaming::radius(600.0)));
```

- A cell loads when its square is within `radius` (XZ) of the `MainCamera` or of any
  `world::StreamSource` (feature `world`), and is dropped past `radius + margin`
  (`PcgStreaming::radius(r)` sets margin to r/8, at least 16 m).
- Dropping a cell despawns its root, frees its cached output and cancels an evaluation in
  flight. Cells that had spawned send `PcgCellDropped { volume, cell }`: drop whatever you
  built from that cell's `PcgEmitted` points. On re-entry the cell evaluates again (same
  seeds, same points) and emits again.
- Dropped and replaced cell roots are despawned in `Last`, after every `Update` / `PostUpdate`
  command has applied, so a game system that tags fresh output (`insert` on `Added`
  entities) never meets a root despawned under it. A system in `Last` should still use
  `try_insert` / `try_remove`.
- Only cells around the sources are visited each frame; `pcg.stats` shows `cells` (loaded)
  and `cells_dropped`.
- Things that must exist far away (impostor fields, map markers) shouldn't come from a
  streamed volume's emits: put them in a second, unstreamed volume with only the `Emit`
  nodes they need, or generate them with `pcg-core` directly.

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
| `pcg.stats` | | volumes, cells, pending, evaluations, cache hits, cells dropped, live cell roots, points spawned/thinned, last evaluation µs, errors, density |
| `pcg.inspect` | `x`, `z`, `volume` | points per node in that cell, spawns, emits |
| `pcg.regen` | | regenerate every cell |
| `pcg.scale` | `density` | set `PcgSettings::density` (respawns from cache) |

## Overrides (hand edits on top of the graph)

`PcgOverrides` (a reflected component on the `PcgVolume` entity, saved in levels) holds what a
person changed: `removed` (generated points deleted), `moved` (point -> new transform), `added`
(hand-placed `item` + transform + the Spawn `node` it belongs to) and `areas` (XZ polygons with a
`density`; 0 = clear, e.g. a no-tree zone; `nodes: Some([..])` limits it to those nodes). No
component = no cost.

**Keys.** A generated point is named by `PointKey { node, seed }`: the Spawn / Emit node id and
the point's seed. `pcg_core::seed_at` hashes graph seed, node and the world position (1 mm), so
the key is the same after re-evaluation, after a streaming drop and re-entry, at any cell size
and in any order (tested). Moving a point keeps its key (it is the generated identity); a
hand-placed item's key follows its position. A key whose point no longer exists (graph changed)
is ignored. A move records the item, so it is self-contained and area-correct: any area apply drops a
moved point whose destination is outside it and appends one whose destination is inside, even
if it was generated elsewhere, so it appears exactly once (origin and destination cells both
respawn). Moved and hand-placed points are never thinned by quality or the governor.

**Apply.** `OverrideIndex` (`ov.index(cell_size)`) removes, moves, thins by area (deterministic
by seed, nested: density 0.3 is a subset of 0.6) and appends hand-placed items inside the area it
is given (half-open, so tiles never double). The volume applies it to the cached evaluation when a
cell spawns, so editing overrides respawns only the cells they touch (a per-cell hash compares),
without evaluating the graph again; `PcgStats::override_respawns` counts them. `PcgEmitted` carries
the edited points; when an edit changes a cell that has emits, `PcgCellDropped` then a fresh
`PcgEmitted` is sent (drop what you built from that cell, rebuild from the new points).

**In a game's own evaluation** (colliders, nav): evaluate the graph per tile as before, then

```rust
let ix = overrides.index(32.0);                       // once per change, not per tile
let area = Area::new(tile_min, tile_max);            // the tile's XZ rect
for s in &mut out.spawns { ix.apply_spawned(area, s); }       // or
ix.apply_points("trees", area, &mut points);                  // any PointSet of node "trees"
```

The result equals what the volume spawned in that area (same removed / moved / thinned points).
Added items are appended to the set whose area contains them, with `HAND_ATTR` ("hand") = 1.
`PcgOverrides::apply(node, area, pts)` is the one-shot form (builds an index each call).
Edit helpers: `remove_point`, `move_point`, `add_item`.

**Picking.** `pcg_pick(&World, origin, dir) -> Option<PcgPick { volume, key, item, transform,
distance, cell, emitted }>` rays against the point sets of loaded cells (bounding sphere per point
from the catalog mesh AABB x scale; Emit points use their extent), so it works on merged meshes;
thinned and removed points are not hit, hand-placed ones are. `find_point(world, volume, &key)`
looks a key up.

| Command | Params | Returns |
|---|---|---|
| `pcg.pick` | `origin`, `dir` | nearest hit: volume, key `{node, seed}` (seed as a string), item, transform, distance, cell |
| `pcg.overrides.get` | `volume` (entity id, default first) | counts and every entry |
| `pcg.overrides.remove` | `volume`, `key`, `at`? | removes a generated or hand-placed point (`at` only for unloaded cells) |
| `pcg.overrides.move` | `volume`, `key`, `transform` `{translation, rotation (xyzw), scale}`, `at`? | the key afterwards |
| `pcg.overrides.add` | `volume`, `item`, `transform`, `node`? | its key (`node` defaults to the Spawn node listing the item) |
| `pcg.overrides.area` | `volume`, `polygon` `[[x,z],..]`, `density`? (0), `nodes`? | counts |
| `pcg.overrides.clear` | `volume` | removes all |

`pcg.inspect` takes `node` and then lists that node's points with keys. Demo:
`python3 -I scripts/play.py examples/pcg_town_edit.steps.json --example pcg_town --features pcg`
(clears a polygon, removes three trees, hand-places two trees and a bush).

Cost (dev build, Apple M5 Pro): building the index for 1000 edits 0.4 ms; applying it to a cell
of 4000 points with 1000 removed / moved and an area 46 us; a cell no override touches is used as
is (one hash lookup).

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

- Streaming radius is distance only (no view-direction or speed look-ahead); positions are
  world coordinates (with a floating origin, keep volumes and sources in the same frame).
- `Difference` / `Intersect` test rects and point boxes, not polylines (buffer streets into
  rects to keep things off them).
- No subgraphs, loops, splines (`SplineSample`), grammar (`SubdivideSegment`) or GPU path.
- Merged meshes carry positions, normals, UVs and tangents only (no vertex colours or skinning).
- Overrides: hand-placed Emit points carry no item name; keys are lost if the graph's node ids change.
- No gizmo overlay yet; use `pcg.inspect` and screenshots.
