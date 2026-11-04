# Splines (`engine::spline`, feature `spline`, default on)

A `Spline` component is a curve through control points that carry width, bank, tags and a data
string. It is saved in levels, edited by the editor's spline tool, and games build their own
geometry from it (road ribbons, junctions, rails, fences). No Bevy features are added; the ship
build (`--no-default-features`) compiles without it.

## Types

| Type | What |
|---|---|
| `Spline { points, closed, mode }` | Component, `Reflect`, saved in levels. `mode`: `Catmull` (centripetal Catmull-Rom, default) or `Linear`. `closed` needs 3+ points. |
| `SplinePoint { pos, width, bank, tags, data }` | `pos` in the entity's local space; `width` full width in metres; `bank` roll in radians, positive lowers the right edge; `tags: u32` and `data: Option<String>` are game-defined. |
| `SplineCache` | Not saved. Arc-length table + nearest-point grid, rebuilt in `PostUpdate` when `Spline` changes. |
| `SplineSample { pos, dir, right, up, width, bank, tags, t }` | `right`/`up` include the bank. `t` = index of the segment's start point + fraction. |
| `SplineChanged { entity }` | Message sent after a cache rebuild (also the first frame a spline exists). Order game systems after `SplineSet`. |
| `SplineGizmos`, `SplineSelection` | Resources for drawing (below). |
| `SplineRoad`, `SplineRoadMesh` | Generic road: child mesh kept in sync. |

Interpolation: `width` and `bank` are linear between control points. `tags` and `data` belong to
the segment that *starts* at the point (the last point of an open spline has none that matter).
`reverse()` keeps tags with their segments and negates bank.

## API

All queries take the entity's `Spline` and `SplineCache` (both are components):

```rust
fn follow(q: Query<(&Spline, &SplineCache)>) {
    let (spline, cache) = q.single().unwrap();
    let len = cache.length();
    let s = cache.sample_at(spline, 120.0).unwrap();             // clamps (open) / wraps (closed)
    let (along, sample, dist) = cache.nearest(spline, car_pos).unwrap();
    for s in cache.samples(spline, 2.0) { /* every 2 m, end included (open) */ }
}
let mut spline = Spline::from_positions(positions).closed();
let i = spline.insert_point(after, pos);   // width/bank averaged, tags/data from `after`
spline.remove_point(i);
let tail = spline.split(index);            // open: returns the tail; closed: opens the loop
spline.reverse();
```

`sample_at`, `nearest` return `Option` (`None` only for a spline without points). Nothing panics
on odd data: empty, one point, coincident points, NaN distances, a cache older than the spline.
`Spline::pos_at(s)` / `sample_s(s)` evaluate by curve parameter without a cache.

`nearest` works in local space; transform the query point with the entity's inverse transform
for a rotated or moved spline.

## Cost

The cache is rebuilt only for splines that changed; with none changed the plugin does one
cheap change-detection query. Measured (`cargo test --lib spline::tests::perf -- --ignored
--nocapture`, dev profile, M-series Mac), 1000 points over 5.06 km (3997 table vertices):

| | |
|---|---|
| cache build | 0.47 ms |
| `nearest` | 0.33 us per query (queries within 30 m of the curve) |
| `sample_at` | 0.09 us |

Table: at least 4 and at most 64 vertices per segment, one per ~2 m. Nearest uses a ground-plane
grid (cells of max(8 m, extent/256)) over the table's pieces and expands rings until the best hit
is closer than the unseen cells; far-away queries cost more (they scan more rings) but stay exact.
The grid is over x/z, so a spline stacked in height (a spiral ramp) is still correct, just slower.

## Drawing (debug / editor)

`SplineGizmos { enabled (default false), points, edges, banks, edge_step, range }`: curve (cyan),
width edges (orange), control points (white spheres, scaled by camera distance), bank up-arrows.
Parts farther than `range` from the camera are skipped. `SplineSelection { entity, point }`
highlights one point. Runs only when enabled and the app has gizmos; zero cost otherwise.

## Road helper

`ribbon_mesh(&spline, step, uv_scale) -> Mesh` follows width and bank: a vertex pair every
`step` m, `uv.x` 0..1 left to right, `uv.y = distance / uv_scale`, normal = banked up, tangent =
right. `SplineRoad { step, uv_scale, color }` next to a `Spline` spawns a child mesh (tagged
`Scenery`) and updates it on every `SplineChanged`. Games with their own geometry (Pacenote's
ribbons and junctions) skip it and do this:

```rust
fn rebuild(mut changed: MessageReader<SplineChanged>, q: Query<(&Spline, &SplineCache)>) {
    for c in changed.read() {
        let Ok((spline, cache)) = q.get(c.entity) else { continue };
        for s in cache.samples(spline, 1.5) {
            let (l, r) = (s.pos - s.right * s.width * 0.5, s.pos + s.right * s.width * 0.5);
            let surface = s.tags & 0b11; // game-defined
            // push vertices, junction cuts at `nearest` hits, colliders...
        }
    }
}
```

## Control commands (feature `devtools`)

`entity` is optional when the world has exactly one spline (bits or index).

| Command | Params | Result |
|---|---|---|
| `spline.list` | none | entity, name, points, length, closed |
| `spline.get` | `{entity?}` | closed, mode, length, all points |
| `spline.set_point` | `{entity?, index, point: {pos?, width?, bank?, tags?, data?}}` | merged point |
| `spline.insert` | `{entity?, after, pos}` | `{index}` |
| `spline.remove` | `{entity?, index}` | `{points}` |
| `spline.nearest` | `{entity?, pos}` | `{distance_along, distance, sample}` |
| `spline.gizmos` | `{on?, points?, edges?, banks?, select_entity?, select_point?}` | settings |

## Levels

`Spline` is `Reflect` and registered, so a `LevelEntity` with a `Spline` is saved and loaded with
the level (test: two splines, one closed, round trip identical). `SplineCache` is not registered,
so never saved; it is rebuilt on load. Needs `SplinePlugin` (added by `EnginePlugin`).

## Example

`cargo run --example spline_road`: a closed winding `SplineRoad` with varying width and bank,
gizmos on. Drive it with `spline.set_point` (see `scripts/play.py` steps in the example header).

## Known limits

- Bank is not derived from curvature; the game sets it.
- Width edges are not offset-curve exact on tight bends (the ribbon pinches if the radius is
  below half the width), like any ribbon.
- One cache vertex per ~2 m: `length()` is the polyline length (error well under 0.1%).
