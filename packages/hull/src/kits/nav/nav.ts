import { Behaviour } from '../../core/index.ts';
import { num, tunables } from '../../config/index.ts';
import { physicsOf, type Physics } from '../../physics/index.ts';
import { LAYER } from '../common.ts';

// Cell size, agent size and step height are read when the grid bakes, so they take effect on the next bake.
export const navTuning = tunables('nav', {
  cellSize: num(0.5, { min: 0.1, max: 4, step: 0.05, unit: 'm', help: 'Edge of one grid cell. Smaller finds tighter gaps and costs more to bake.' }),
  agentRadius: num(0.4, { min: 0.05, max: 2, step: 0.05, unit: 'm', help: 'Walls are pushed out by this much, so a path never scrapes them.' }),
  agentHeight: num(1.7, { min: 0.3, max: 4, step: 0.05, unit: 'm', help: 'Anything lower than this above the floor blocks the walker.' }),
  stepHeight: num(0.3, { min: 0, max: 2, step: 0.05, unit: 'm', help: 'Ledges lower than this are walked over, not around.' }),
  replanInterval: num(0.5, { min: 0.05, max: 5, step: 0.05, unit: 's', help: 'How often a follower asks for a fresh path while its goal is still.' }),
  arriveDistance: num(0.35, { min: 0.05, max: 3, step: 0.05, unit: 'm', help: 'A follower counts a waypoint as reached this close.' }),
});

/** A planned route: the points to walk through, in order, ending at the goal. Reused between queries. */
export class NavPath {
  xs = new Float32Array(32);
  zs = new Float32Array(32);
  count = 0;
  /** Walking length, m. */
  length = 0;

  clear(): void { this.count = 0; this.length = 0; }

  /** @internal Grows (rarely, and only while warming up) so a query never fails for lack of room. */
  push(x: number, z: number): void {
    if (this.count === this.xs.length) {
      const nx = new Float32Array(this.count * 2);
      const nz = new Float32Array(this.count * 2);
      nx.set(this.xs); nz.set(this.zs);
      this.xs = nx; this.zs = nz;
    }
    if (this.count > 0) this.length += Math.hypot(x - this.xs[this.count - 1]!, z - this.zs[this.count - 1]!);
    this.xs[this.count] = x;
    this.zs[this.count] = z;
    this.count++;
  }
}

export interface NavBounds { minX: number; maxX: number; minZ: number; maxZ: number }
const SQRT2 = Math.SQRT2;

/**
 * A walkable grid over the floor, baked once from the static shapes on physics layer "world": a cell is blocked when an
 * upright capsule of the agent's size, standing there, would touch one. `findPath` is A* over preallocated arrays, then
 * pulled straight wherever the line of sight is clear. Put it on a node named 'nav' so other kits find it with
 * `world.find('nav')`. Bake order: it bakes in `ready`, so create it after the level.
 */
export class NavGrid extends Behaviour {
  /** The floor area to cover. */
  bounds: NavBounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
  /** Counts bakes, so a follower knows its path is from an older map. */
  version = 0;
  nx = 0;
  nz = 0;
  cell = 0.5;
  private blocked = new Uint8Array(0);
  private region = new Int32Array(0);
  private g = new Float32Array(0);
  private f = new Float32Array(0);
  private parent = new Int32Array(0);
  private seen = new Int32Array(0);
  private closed = new Int32Array(0);
  private heap = new Int32Array(0);
  private keys = new Float32Array(0);
  private raw = new Int32Array(0);
  private stamp = 0;
  private heapN = 0;
  private readonly snapA = { x: 0, z: 0 };
  private readonly snapB = { x: 0, z: 0 };
  private readonly probeA = { x: 0, y: 0, z: 0 };
  private readonly probeB = { x: 0, y: 0, z: 0 };

  override ready(): void { this.bake(); }

  /** Bakes the grid again (a door opened, a wall fell). Followers re-plan on their next step. */
  rebake(): void { this.bake(); }

  private bake(): void {
    const phys: Physics = physicsOf(this.world);
    const b = this.bounds;
    const cs = navTuning.cellSize;
    this.cell = cs;
    this.nx = Math.max(1, Math.ceil((b.maxX - b.minX) / cs));
    this.nz = Math.max(1, Math.ceil((b.maxZ - b.minZ) / cs));
    const n = this.nx * this.nz;
    if (this.blocked.length !== n) {
      this.blocked = new Uint8Array(n);
      this.region = new Int32Array(n);
      this.g = new Float32Array(n);
      this.f = new Float32Array(n);
      this.parent = new Int32Array(n);
      this.seen = new Int32Array(n);
      this.closed = new Int32Array(n);
      this.heap = new Int32Array(2 * n + 2);
      this.keys = new Float32Array(2 * n + 2);
      this.raw = new Int32Array(n + 1);
      this.stamp = 0;
    }
    const r = navTuning.agentRadius;
    const lo = navTuning.stepHeight + r;
    const hi = Math.max(lo, navTuning.agentHeight - r);
    const a = this.probeA;
    const c = this.probeB;
    const filter = { mask: LAYER.world };
    for (let k = 0; k < this.nz; k++) {
      for (let i = 0; i < this.nx; i++) {
        a.x = c.x = b.minX + (i + 0.5) * cs;
        a.z = c.z = b.minZ + (k + 0.5) * cs;
        a.y = lo; c.y = hi;
        this.blocked[k * this.nx + i] = phys.overlapCapsule(a, c, r, filter).length > 0 ? 1 : 0;
      }
    }
    this.label();
    this.version++;
  }

  /** Flood fill: cells that can reach each other share a region number, so "no path" is known without a search. */
  private label(): void {
    const { nx, nz, blocked, region, raw } = this;
    region.fill(0);
    let next = 0;
    for (let s = 0; s < nx * nz; s++) {
      if (blocked[s] || region[s]) continue;
      next++;
      let head = 0;
      let tail = 0;
      raw[tail++] = s;
      region[s] = next;
      while (head < tail) {
        const u = raw[head++]!;
        const ux = u % nx;
        const uz = (u - ux) / nx;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if ((dx | dz) === 0) continue;
            const vx = ux + dx;
            const vz = uz + dz;
            if (vx < 0 || vz < 0 || vx >= nx || vz >= nz) continue;
            const v = vz * nx + vx;
            if (blocked[v] || region[v]) continue;
            if (dx !== 0 && dz !== 0 && (blocked[uz * nx + vx] || blocked[vz * nx + ux])) continue;
            region[v] = next;
            raw[tail++] = v;
          }
        }
      }
    }
  }

  /** The centre of a cell, by its index. */
  private cx(c: number): number { return this.bounds.minX + ((c % this.nx) + 0.5) * this.cell; }
  private cz(c: number): number { return this.bounds.minZ + (Math.floor(c / this.nx) + 0.5) * this.cell; }

  private cellOf(x: number, z: number): number {
    const i = Math.floor((x - this.bounds.minX) / this.cell);
    const k = Math.floor((z - this.bounds.minZ) / this.cell);
    if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) return -1;
    return k * this.nx + i;
  }

  /** True when the agent can stand at (x, z). Outside the grid is not walkable. */
  walkable(x: number, z: number): boolean {
    const c = this.cellOf(x, z);
    return c >= 0 && this.blocked[c] === 0;
  }

  /** The nearest walkable point to (x, z), searched ring by ring up to `maxCells` away. False when none is near. */
  nearestFree(x: number, z: number, out: { x: number; z: number }, maxCells = 12): boolean {
    const bx = this.bounds.minX;
    const bz = this.bounds.minZ;
    const ci = Math.floor((x - bx) / this.cell);
    const ck = Math.floor((z - bz) / this.cell);
    let best = Infinity;
    let bi = -1;
    let bk = -1;
    for (let ring = 0; ring <= maxCells; ring++) {
      // A ring further out than the best found so far cannot hold a closer cell.
      if (bi >= 0 && (ring - 1) * this.cell > best) break;
      for (let k = ck - ring; k <= ck + ring; k++) {
        for (let i = ci - ring; i <= ci + ring; i++) {
          if (Math.max(Math.abs(i - ci), Math.abs(k - ck)) !== ring) continue;
          if (i < 0 || k < 0 || i >= this.nx || k >= this.nz || this.blocked[k * this.nx + i]) continue;
          const d = Math.hypot(bx + (i + 0.5) * this.cell - x, bz + (k + 0.5) * this.cell - z);
          if (d < best) { best = d; bi = i; bk = k; }
        }
      }
    }
    if (bi < 0) return false;
    if (this.walkable(x, z)) { out.x = x; out.z = z; } else { out.x = bx + (bi + 0.5) * this.cell; out.z = bz + (bk + 0.5) * this.cell; }
    return true;
  }

  /** True when a straight walk from one point to the other crosses only walkable cells. */
  lineClear(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(len / (this.cell * 0.5)));
    for (let s = 0; s <= n; s++) {
      const u = s / n;
      if (!this.walkable(x0 + dx * u, z0 + dz * u)) return false;
    }
    return true;
  }

  /** True when a path exists between the two points (each snapped to the nearest walkable cell). Allocation free. */
  reachable(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
    const a = this.snapA;
    const b = this.snapB;
    if (!this.nearestFree(fromX, fromZ, a) || !this.nearestFree(toX, toZ, b)) return false;
    return this.region[this.cellOf(a.x, a.z)] === this.region[this.cellOf(b.x, b.z)];
  }

  /**
   * Plans a route into `out`: false (and an empty `out`) when the points are in separate pockets or off the map.
   * A start or goal inside an obstacle is moved to the nearest walkable point; the path ends at the goal itself when
   * that is walkable. Allocation free once `out` has grown to the longest route asked for.
   */
  findPath(fromX: number, fromZ: number, toX: number, toZ: number, out: NavPath): boolean {
    out.clear();
    const a = this.snapA;
    const b = this.snapB;
    if (!this.nearestFree(fromX, fromZ, a) || !this.nearestFree(toX, toZ, b)) return false;
    const s = this.cellOf(a.x, a.z);
    const t = this.cellOf(b.x, b.z);
    if (this.region[s] !== this.region[t]) return false;
    const goalIsExact = b.x === toX && b.z === toZ;
    const count = this.search(s, t);
    if (count === 0) return false;
    const { raw } = this;
    // raw[0..count) runs goal to start. Pull it tight: from each anchor jump to the furthest cell still in sight.
    const startFree = this.walkable(fromX, fromZ);
    let ax = startFree ? fromX : a.x;
    let az = startFree ? fromZ : a.z;
    out.push(ax, az);
    let j = count - 1;
    while (j > 0) {
      let far = j - 1;
      for (let m = 0; m < j; m++) {
        if (this.lineClear(ax, az, this.cx(raw[m]!), this.cz(raw[m]!))) { far = m; break; }
      }
      // `far` is the smallest index in sight, that is the one nearest the goal.
      ax = this.cx(raw[far]!); az = this.cz(raw[far]!);
      if (far === 0) break;
      out.push(ax, az);
      j = far;
    }
    if (goalIsExact) out.push(toX, toZ); else out.push(b.x, b.z);
    return true;
  }

  /** A* from cell s to cell t. Leaves the route in `raw` goal first and returns how many cells; 0 when none. */
  private search(s: number, t: number): number {
    const { nx, nz, blocked, g, f, parent, seen, closed, raw } = this;
    const stamp = ++this.stamp;
    const cs = this.cell;
    const tx = t % nx;
    const tz = (t - tx) / nx;
    this.heapN = 0;
    g[s] = 0; parent[s] = -1; seen[s] = stamp;
    f[s] = this.h(s % nx, Math.floor(s / nx), tx, tz) * cs;
    this.push(s, f[s]!);
    while (this.heapN > 0) {
      const u = this.pop();
      if (closed[u] === stamp) continue;
      closed[u] = stamp;
      if (u === t) {
        let n = 0;
        for (let c = u; c !== -1; c = parent[c]!) raw[n++] = c;
        return n;
      }
      const ux = u % nx;
      const uz = (u - ux) / nx;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx | dz) === 0) continue;
          const vx = ux + dx;
          const vz = uz + dz;
          if (vx < 0 || vz < 0 || vx >= nx || vz >= nz) continue;
          const v = vz * nx + vx;
          if (blocked[v] || closed[v] === stamp) continue;
          const diag = dx !== 0 && dz !== 0;
          if (diag && (blocked[uz * nx + vx] || blocked[vz * nx + ux])) continue;
          const ng = g[u]! + (diag ? SQRT2 : 1) * cs;
          if (seen[v] === stamp && ng >= g[v]!) continue;
          seen[v] = stamp;
          g[v] = ng;
          parent[v] = u;
          f[v] = ng + this.h(vx, vz, tx, tz) * cs;
          this.push(v, f[v]!);
        }
      }
    }
    return 0;
  }

  /** Octile distance in cells: exact on an open grid, so A* does not wander. */
  private h(x: number, z: number, tx: number, tz: number): number {
    const dx = Math.abs(x - tx);
    const dz = Math.abs(z - tz);
    return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
  }

  // Binary min-heap of cells with the f each was pushed with. A cell can be in it twice (a cheaper route found
  // later); the dearer entry is skipped when it pops. Sized for that; grows only if a search is far worse.
  private push(c: number, key: number): void {
    if (this.heapN + 1 >= this.heap.length) {
      const h = new Int32Array(this.heap.length * 2);
      const k = new Float32Array(this.heap.length * 2);
      h.set(this.heap); k.set(this.keys);
      this.heap = h; this.keys = k;
    }
    const { heap, keys } = this;
    let i = this.heapN++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= key) break;
      heap[i] = heap[p]!; keys[i] = keys[p]!;
      i = p;
    }
    heap[i] = c; keys[i] = key;
  }

  private pop(): number {
    const { heap, keys } = this;
    const top = heap[0]!;
    const n = --this.heapN;
    const lc = heap[n]!;
    const lk = keys[n]!;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && keys[c + 1]! < keys[c]!) c++;
      if (keys[c]! >= lk) break;
      heap[i] = heap[c]!; keys[i] = keys[c]!;
      i = c;
    }
    heap[i] = lc; keys[i] = lk;
    return top;
  }
}

/** What a walker keeps between steps to follow a route. Plain data; make one per walker with `newFollower`. */
export interface PathFollower {
  grid: NavGrid;
  path: NavPath;
  /** Next point of `path` to walk to. */
  index: number;
  goalX: number;
  goalZ: number;
  /** Goal the current path was planned for. */
  plannedX: number;
  plannedZ: number;
  /** Seconds since the last plan. */
  age: number;
  /** The grid version the path came from. */
  version: number;
  /** A path is held. False means the last plan failed: the walker should stand still. */
  hasPath: boolean;
  /** Set when a plan has been made at all, so the first call plans at once. */
  planned: boolean;
}

/** The move direction followPath fills in: a unit vector on the floor (zero when there is nothing to do). */
export interface FollowOut { dx: number; dz: number; /** Distance left along the path, m. */ remaining: number }

export function newFollower(grid: NavGrid): PathFollower {
  return { grid, path: new NavPath(), index: 0, goalX: 0, goalZ: 0, plannedX: 0, plannedZ: 0, age: 0, version: -1, hasPath: false, planned: false };
}

/**
 * The move direction for a walker at `pos` heading for (`state.goalX`, `state.goalZ`). It plans on the first call, again
 * every `replanInterval` seconds, when the goal has moved more than a cell, and when the grid was rebaked. Returns
 * false when there is no route (`out` is zero: stand still) or the walker is at the goal. Allocation free.
 */
export function followPath(state: PathFollower, pos: { x: number; z: number }, speed: number, dt: number, out: FollowOut): boolean {
  out.dx = 0; out.dz = 0; out.remaining = 0;
  const grid = state.grid;
  state.age += dt;
  const moved = Math.hypot(state.goalX - state.plannedX, state.goalZ - state.plannedZ);
  if (!state.planned || state.age >= navTuning.replanInterval || moved > grid.cell || state.version !== grid.version) {
    state.hasPath = grid.findPath(pos.x, pos.z, state.goalX, state.goalZ, state.path);
    state.planned = true;
    state.age = 0;
    state.index = 1;
    state.plannedX = state.goalX; state.plannedZ = state.goalZ;
    state.version = grid.version;
  }
  if (!state.hasPath) return false;
  const p = state.path;
  const arrive = Math.max(navTuning.arriveDistance, speed * dt);
  // Skip a waypoint when the one after it is already in clear sight: corners are cut as soon as it is safe.
  while (state.index < p.count) {
    const wx = p.xs[state.index]!;
    const wz = p.zs[state.index]!;
    const d = Math.hypot(wx - pos.x, wz - pos.z);
    const last = state.index === p.count - 1;
    if (d <= (last ? Math.min(arrive, 0.1 + speed * dt) : arrive)) { state.index++; continue; }
    if (!last && grid.lineClear(pos.x, pos.z, p.xs[state.index + 1]!, p.zs[state.index + 1]!)) { state.index++; continue; }
    break;
  }
  if (state.index >= p.count) return false;
  const wx = p.xs[state.index]!;
  const wz = p.zs[state.index]!;
  const d = Math.hypot(wx - pos.x, wz - pos.z);
  if (d < 1e-6) return false;
  out.dx = (wx - pos.x) / d;
  out.dz = (wz - pos.z) / d;
  let rest = d;
  for (let i = state.index; i < p.count - 1; i++) rest += Math.hypot(p.xs[i + 1]! - p.xs[i]!, p.zs[i + 1]! - p.zs[i]!);
  out.remaining = rest;
  return true;
}
