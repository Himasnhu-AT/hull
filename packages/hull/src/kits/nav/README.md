# nav kit

A walkable grid baked from the level's solid shapes, A* paths over it, and a follower that gives a walker its move direction.

- **Behaviours**: `NavGrid` (put it on a node named `nav`; `bounds`; `findPath(fromX, fromZ, toX, toZ, out: NavPath): boolean`,
  `reachable(...)`, `nearestFree(x, z, out, maxCells?)`, `walkable(x, z)`, `lineClear(x0, z0, x1, z1)`, `rebake()`).
  `NavPath` is the route (`xs`, `zs`, `count`, `length`), reused between queries. `newFollower(grid)` makes a `PathFollower` state
  object; `followPath(state, pos, speed, dt, out)` fills `out.dx, out.dz` (a unit direction on the floor) and returns false when
  there is no route or the walker has arrived.
- **How it works**: at `ready` each cell is tested with an upright capsule (the agent) against static shapes on physics layer
  `world`; a flood fill gives each pocket a region number, so "no path" answers without a search. A* runs on preallocated
  arrays (octile distance, no corner cutting), then the route is pulled straight wherever the line of sight is clear.
  A start or goal inside an obstacle moves to the nearest walkable cell. Nothing allocates per query once `NavPath` has
  grown to the longest route asked for.
- **Follower**: plans on the first call, every `replanInterval` seconds, when the goal moves more than a cell, and after a
  `rebake()`. A waypoint is skipped as soon as the next is in clear sight.
- **Tunables** (`nav` block, read at bake): `cellSize`, `agentRadius`, `agentHeight`, `stepHeight`; read live: `replanInterval`,
  `arriveDistance`.
- **Config**: none. Random streams: none. No saved state: the grid is rebuilt from the level.
- **Wiring**: a physics world with the level's solids on layer `world` (`ArenaLevel` does this), and the NavGrid created after
  the level, because it bakes in `ready`. Pass `bounds` to cover the floor. Anything that moves on layer `world` is not baked;
  call `rebake()` after a static wall appears or goes. A sloped floor taller than `stepHeight` counts as a wall.
- **Chaser**: the spawner's `Chaser` walks by path whenever `world.find('nav')` has a NavGrid and the straight line to the
  player is blocked; it stands still when the player cannot be reached. With no NavGrid it walks straight, as before.
- **Measured** (this machine, `pnpm vitest run packages/hull/src/kits/nav`): bake of a 60 m square at 0.5 m (120x120 cells) with
  200 boxes about 5 ms (budget 50 ms, checked with `HULL_PERF=1`); a cross-map query about 0.4 ms.
- **Bench**: `bench.ts`. **Test**: `nav.test.ts`.

## Use it

```ts
import { NavGrid, NavPath, newFollower, followPath, type FollowOut } from 'hull/kits';

const nav = world.spawn('nav').add(NavGrid, { bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 } });
const path = new NavPath();
const ok = nav.findPath(-5, 0, 5, 0, path); // false when walled off
const walker = newFollower(nav);
const dir: FollowOut = { dx: 0, dz: 0, remaining: 0 };
walker.goalX = 5; walker.goalZ = 0;
if (followPath(walker, me.position, 3, dt, dir)) me.position.x += dir.dx * 3 * dt;
```
