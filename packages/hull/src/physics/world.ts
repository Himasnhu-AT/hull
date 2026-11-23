// The physics world: shapes, a uniform-grid broadphase, and the queries. Static shapes go into the grid once.
// Moving shapes (a titan's limbs, the bodies of debris) keep their bounds in a flat index with a grid of its own
// that is rebuilt as they move (moving.ts); a query asks it for the few near and tests those in the order they
// were added.
// The grid is two-dimensional (x and z): cities and arenas are wide and flat, and a column holds a building's
// whole height, so a ray from a rooftop does not step through empty vertical cells.
import type { World } from '../core/index.ts';
import { takeKernel } from '../kernel/index.ts';
import { Dda } from './dda.ts';
import { KernelWorld } from './kernel.ts';
import { ArrayStore, MovingIndex } from './moving.ts';
import { B, beginSweep, C, closestOn, rayAabb, sweepShape } from './narrow.ts';
import { RigidSolver } from './rigid.ts';
import { Shape } from './shape.ts';
import { K } from './shape.ts';
import { Hit } from './types.ts';
import type { QueryFilter, ShapeDesc, ShapeOptions, Vec3Like, Vec3Tuple } from './types.ts';

export interface PhysicsOptions {
  /** Side of a broadphase cell, m. About the size of a typical building footprint to a few of them. Default 16. */
  cell?: number;
  gravity?: Vec3Tuple;
  /** Solver passes per step for rigid bodies. Default 8. */
  iterations?: number;
}

/** Wider than this many cells and a static shape goes to the short list instead of the grid. */
const MAX_CELLS = 256;
/** A sphere cast whose bounds cover at most this many cells visits them all; longer ones walk the line. */
const BOX_CELLS = 64;

function key(i: number, k: number): number {
  return ((i + 32768) & 0xffff) * 65536 + ((k + 32768) & 0xffff);
}

export class Physics {
  readonly world: World;
  readonly cell: number;
  readonly gravity: { x: number; y: number; z: number };
  readonly iterations: number;
  /** Reused by `raycast` and friends when no `out` is given. */
  readonly hit = new Hit();
  /** Reused by the overlap queries when no `out` is given. */
  readonly overlaps: Shape[] = [];

  private readonly grid = new Map<number, Shape[]>();
  private readonly bigs: Shape[] = [];
  /** Every shape that is not static, in the order added. */
  readonly moving: Shape[] = [];
  /** Where the moving shapes are: slot i is `moving[i]`. @internal */
  readonly index: MovingIndex;
  private readonly statics: Shape[] = [];
  private stamp = 0;
  private syncedTick = -1;
  private dirty = true;
  private readonly dda = new Dda();
  private readonly cand: Shape[] = [];
  /** @internal */
  readonly solver: RigidSolver;
  /**
   * @internal The kernel's copy of this world (plan-rust.md R2), when the game started with the kernels: queries and
   * the rigid solver run there. Null on TypeScript, and after the kernel failed (the world then carries on here).
   */
  _kw: KernelWorld | null = null;

  constructor(world: World, opts: PhysicsOptions = {}) {
    this.world = world;
    this.cell = opts.cell ?? 16;
    if (!(this.cell > 0)) throw new Error(`physics: cell must be positive, got ${this.cell}`);
    const g = opts.gravity ?? [0, -9.81, 0];
    this.gravity = { x: g[0], y: g[1], z: g[2] };
    this.iterations = opts.iterations ?? 8;
    this.index = new MovingIndex(new ArrayStore(), this.cell);
    this.solver = new RigidSolver(this);
    const kernel = takeKernel();
    if (kernel !== null) {
      try { this._kw = new KernelWorld(kernel, this.cell); } catch (e) { this.dropKernel(e); }
    }
  }

  /** Which implementation answers this world's queries. Both give the same answers; tests and reports read this. */
  get backend(): 'kernel' | 'typescript' {
    return this._kw !== null ? 'kernel' : 'typescript';
  }

  /**
   * @internal The kernel stopped (a trap, a world it cannot hold): said once, and this world carries on in
   * TypeScript, whose grid, index and bodies have been kept current all along.
   */
  dropKernel(e: unknown): void {
    this._kw = null;
    for (const s of this.moving) { s._kw = null; s._kid = -1; }
    for (const s of this.statics) { s._kw = null; s._kid = -1; }
    for (const s of this.bigs) { s._kw = null; s._kid = -1; }
    console.error('physics: the kernel stopped and this world carries on in TypeScript (same answers, slower): ' + (e instanceof Error ? e.message : String(e)));
  }

  // ---- adding shapes ----

  add(desc: ShapeDesc, opts: ShapeOptions = {}): Shape {
    const s = new Shape(desc, opts);
    if (s.isStatic) this.insertStatic(s);
    else { this.moving.push(s); this.index.add(s); this.dirty = true; }
    if (this._kw !== null) {
      let ok = false;
      try { ok = this._kw.add(s); } catch (e) { this.dropKernel(e); }
      if (!ok && this._kw !== null) this.dropKernel(new Error('the world is too wide for the kernel\'s static grid'));
    }
    return s;
  }

  addSphere(center: Vec3Like, radius: number, opts: ShapeOptions = {}): Shape {
    return this.add({ type: 'sphere', radius }, { ...opts, position: center });
  }

  /** `a` and `b` are the centres of the two end caps in world space. */
  addCapsule(a: Vec3Like, b: Vec3Like, radius: number, opts: ShapeOptions = {}): Shape {
    return this.add({ type: 'capsule', radius, a: [a.x, a.y, a.z], b: [b.x, b.y, b.z] }, opts);
  }

  /** An axis-aligned box from its centre and full size; give `quaternion` for an oriented one. */
  addBox(center: Vec3Like, size: Vec3Like, opts: ShapeOptions = {}): Shape {
    return this.add({ type: 'box', size: [size.x, size.y, size.z] }, { ...opts, position: center });
  }

  addMesh(positions: ArrayLike<number>, indices?: ArrayLike<number>, opts: ShapeOptions = {}): Shape {
    return this.add(indices ? { type: 'mesh', positions, indices } : { type: 'mesh', positions }, opts);
  }

  /** Flat ground at height `y`, solid below. */
  addGround(y = 0, opts: ShapeOptions = {}): Shape {
    return this.add({ type: 'plane', height: y }, opts);
  }

  addHeightfield(
    heights: ArrayLike<number>, columns: number, rows: number, cell: number,
    opts: ShapeOptions & { origin?: readonly [number, number]; baseY?: number; scale?: number } = {},
  ): Shape {
    const d: ShapeDesc = { type: 'heightfield', heights, columns, rows, cell };
    if (opts.origin) (d as { origin?: readonly [number, number] }).origin = opts.origin;
    if (opts.baseY !== undefined) (d as { baseY?: number }).baseY = opts.baseY;
    if (opts.scale !== undefined) (d as { scale?: number }).scale = opts.scale;
    return this.add(d, opts);
  }

  remove(s: Shape): void {
    if (s._removed) return;
    if (this._kw !== null) { try { this._kw.remove(s); } catch (e) { this.dropKernel(e); } }
    s._removed = true;
    s.enabled = false;
    if (s._cells !== null) {
      for (let i = 0; i < s._cells.length; i++) {
        const list = this.grid.get(s._cells[i]!);
        if (list === undefined) continue;
        const k = list.indexOf(s);
        if (k >= 0) list.splice(k, 1);
        if (list.length === 0) this.grid.delete(s._cells[i]!);
      }
      s._cells = null;
    }
    let k = this.bigs.indexOf(s);
    if (k >= 0) this.bigs.splice(k, 1);
    k = this.moving.indexOf(s);
    if (k >= 0) { this.moving.splice(k, 1); this.index.remove(k, s, this.moving); }
    k = this.statics.indexOf(s);
    if (k >= 0) this.statics.splice(k, 1);
  }

  /** Calls `fn` for every shape: grid shapes, long-list shapes, then moving shapes. */
  eachShape(fn: (s: Shape) => void): void {
    for (let i = 0; i < this.statics.length; i++) fn(this.statics[i]!);
    for (let i = 0; i < this.bigs.length; i++) fn(this.bigs[i]!);
    for (let i = 0; i < this.moving.length; i++) fn(this.moving[i]!);
  }

  get shapeCount(): number {
    return this.statics.length + this.bigs.length + this.moving.length;
  }

  private insertStatic(s: Shape): void {
    const c = this.cell;
    const i0 = Math.floor(s.minx / c), i1 = Math.floor(s.maxx / c);
    const k0 = Math.floor(s.minz / c), k1 = Math.floor(s.maxz / c);
    if (s.kind === K.plane || (i1 - i0 + 1) * (k1 - k0 + 1) > MAX_CELLS) {
      s._big = true;
      this.bigs.push(s);
      return;
    }
    const cells: number[] = [];
    for (let i = i0; i <= i1; i++) {
      for (let k = k0; k <= k1; k++) {
        const kk = key(i, k);
        let list = this.grid.get(kk);
        if (list === undefined) { list = []; this.grid.set(kk, list); }
        list.push(s);
        cells.push(kk);
      }
    }
    s._cells = cells;
    this.statics.push(s);
  }

  // ---- moving shapes ----

  /** Reads the pose of every shape that follows an object. Queries do this once per game step by themselves. */
  sync(): void {
    const m = this.moving;
    for (let i = 0; i < m.length; i++) m[i]!.syncFollow();
    this.syncedTick = this.world.tick;
    this.dirty = false;
  }

  private ensureSynced(): void {
    if (this.dirty || this.syncedTick !== this.world.tick) this.sync();
  }

  /** One fixed step of the rigid bodies, then the poses are read again for the next step's queries. @internal */
  step(dt: number): void {
    if (this.solver.bodies.length === 0) return;
    this.sync();
    let done = false;
    if (this._kw !== null) {
      try { done = this._kw.rigidStep(this.solver.bodies, dt, this.gravity, this.iterations); } catch (e) { this.dropKernel(e); }
    }
    if (!done) this.solver.step(dt);
    this.sync();
  }

  // ---- filters ----

  /** @internal */
  pass(s: Shape, f: QueryFilter | undefined): boolean {
    if (!s.enabled) return false;
    if (f === undefined) return !s.trigger;
    if (s.trigger && f.triggers !== true) return false;
    if (f.mask !== undefined && (f.mask & s.layer) === 0) return false;
    if (f.ignoreShape === s) return false;
    if (f.ignoreNode !== undefined && f.ignoreNode !== null && s.node === f.ignoreNode) return false;
    const tag = f.tag;
    if (tag !== undefined) {
      if (tag.charCodeAt(tag.length - 1) === 42) {
        if (!s.tag.startsWith(tag.slice(0, -1))) return false;
      } else if (s.tag !== tag) return false;
    }
    return true;
  }

  // ---- sweeps ----

  /**
   * Sweeps a sphere from o along unit d, up to B.t (set by `beginSweep`), against everything that passes the
   * filter. The best hit is left in B. @internal
   */
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number, f: QueryFilter | undefined): void {
    this.ensureSynced();
    if (this._kw !== null) {
      try { if (this._kw.cast(ox, oy, oz, dx, dy, dz, r, f)) return; } catch (e) { this.dropKernel(e); }
    }
    const maxT = B.t;
    const stamp = ++this.stamp;
    const c = this.cell;
    if (this.grid.size > 0) {
      let boxMode = false;
      let i0 = 0, i1 = 0, k0 = 0, k1 = 0;
      if (r > 0) {
        const ex = ox + dx * maxT, ez = oz + dz * maxT;
        i0 = Math.floor((Math.min(ox, ex) - r) / c); i1 = Math.floor((Math.max(ox, ex) + r) / c);
        k0 = Math.floor((Math.min(oz, ez) - r) / c); k1 = Math.floor((Math.max(oz, ez) + r) / c);
        boxMode = (i1 - i0 + 1) * (k1 - k0 + 1) <= BOX_CELLS;
      }
      if (boxMode) {
        for (let i = i0; i <= i1; i++) {
          for (let k = k0; k <= k1; k++) {
            const list = this.grid.get(key(i, k));
            if (list !== undefined) this.testList(list, stamp, ox, oy, oz, dx, dy, dz, r, f);
          }
        }
      } else {
        const ring = r > 0 ? Math.ceil(r / c) : 0;
        const dda = this.dda;
        dda.init(ox, oz, dx, dz, maxT, c);
        for (let n = 0; n < 100000; n++) {
          if (ring === 0) {
            const list = this.grid.get(key(dda.ix, dda.iz));
            if (list !== undefined) this.testList(list, stamp, ox, oy, oz, dx, dy, dz, r, f);
            if (B.shape !== null && B.t <= dda.tExit) break;
          } else {
            for (let i = dda.ix - ring; i <= dda.ix + ring; i++) {
              for (let k = dda.iz - ring; k <= dda.iz + ring; k++) {
                const list = this.grid.get(key(i, k));
                if (list !== undefined) this.testList(list, stamp, ox, oy, oz, dx, dy, dz, r, f);
              }
            }
          }
          if (!dda.advance()) break;
        }
      }
    }
    const bigs = this.bigs;
    for (let i = 0; i < bigs.length; i++) {
      const s = bigs[i]!;
      if (!this.pass(s, f)) continue;
      if (!rayAabb(ox, oy, oz, dx, dy, dz, s.minx - r, s.miny - r, s.minz - r, s.maxx + r, s.maxy + r, s.maxz + r, B.t)) continue;
      sweepShape(s, ox, oy, oz, dx, dy, dz, r);
    }
    // Moving shapes: the index gives those whose bounds meet the box around what is left of the sweep, padded a
    // little so rounding can only add a shape; the exact test below is the one that was made against every one.
    const mv = this.moving, index = this.index;
    const tx = ox + dx * B.t, ty = oy + dy * B.t, tz = oz + dz * B.t;
    const pad = r + 1e-3 + 1e-9 * (Math.abs(ox) + Math.abs(oy) + Math.abs(oz) + Math.abs(tx) + Math.abs(ty) + Math.abs(tz));
    const m = index.box(
      (ox < tx ? ox : tx) - pad, (oy < ty ? oy : ty) - pad, (oz < tz ? oz : tz) - pad,
      (ox > tx ? ox : tx) + pad, (oy > ty ? oy : ty) + pad, (oz > tz ? oz : tz) + pad);
    const found = index.found;
    for (let i = 0; i < m; i++) {
      const s = mv[found[i]!]!;
      if (!this.pass(s, f)) continue;
      if (!rayAabb(ox, oy, oz, dx, dy, dz, s.minx - r, s.miny - r, s.minz - r, s.maxx + r, s.maxy + r, s.maxz + r, B.t)) continue;
      sweepShape(s, ox, oy, oz, dx, dy, dz, r);
    }
  }

  private testList(list: Shape[], stamp: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number, f: QueryFilter | undefined): void {
    for (let n = 0; n < list.length; n++) {
      const s = list[n]!;
      if (s._stamp === stamp) continue;
      s._stamp = stamp;
      if (!this.pass(s, f)) continue;
      sweepShape(s, ox, oy, oz, dx, dy, dz, r);
    }
  }

  private fill(out: Hit, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): Hit | null {
    const s = B.shape;
    if (s === null) return null;
    out.distance = B.t;
    out.nx = B.nx; out.ny = B.ny; out.nz = B.nz;
    out.x = ox + dx * B.t - B.nx * r;
    out.y = oy + dy * B.t - B.ny * r;
    out.z = oz + dz * B.t - B.nz * r;
    out.shape = s;
    out.node = s.node;
    out.tag = s.tag;
    out.inside = B.inside;
    out.depth = B.depth;
    return out;
  }

  /** Closest hit along a ray. `dir` need not be unit length. Null when nothing is hit within `maxDist`. */
  raycast(origin: Vec3Like, dir: Vec3Like, maxDist: number, filter?: QueryFilter, out: Hit = this.hit): Hit | null {
    return this.spherecast(origin, dir, maxDist, 0, filter, out);
  }

  /** Closest hit of a sphere of `radius` swept along `dir`. A cast that starts overlapping reports distance 0. */
  spherecast(origin: Vec3Like, dir: Vec3Like, maxDist: number, radius: number, filter?: QueryFilter, out: Hit = this.hit): Hit | null {
    const l = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (!(l > 0) || !(maxDist >= 0)) return null;
    const dx = dir.x / l, dy = dir.y / l, dz = dir.z / l;
    beginSweep(maxDist);
    this.cast(origin.x, origin.y, origin.z, dx, dy, dz, radius, filter);
    return this.fill(out, origin.x, origin.y, origin.z, dx, dy, dz, radius);
  }

  /** A capsule between end-cap centres `a` and `b` swept along `dir`. Built from spheres spaced half a radius apart. */
  capsulecast(a: Vec3Like, b: Vec3Like, radius: number, dir: Vec3Like, maxDist: number, filter?: QueryFilter, out: Hit = this.hit): Hit | null {
    const l = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (!(l > 0) || !(maxDist >= 0)) return null;
    const dx = dir.x / l, dy = dir.y / l, dz = dir.z / l;
    beginSweep(maxDist);
    const len = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);
    const n = Math.max(1, Math.ceil(len / (radius * 0.5)));
    let bx = a.x, by = a.y, bz = a.z;
    for (let i = 0; i <= n; i++) {
      const u = n === 0 ? 0 : i / n;
      const ox = a.x + (b.x - a.x) * u, oy = a.y + (b.y - a.y) * u, oz = a.z + (b.z - a.z) * u;
      const before = B.t, was = B.shape;
      this.cast(ox, oy, oz, dx, dy, dz, radius, filter);
      if (B.shape !== was || B.t !== before) { bx = ox; by = oy; bz = oz; }
    }
    return this.fill(out, bx, by, bz, dx, dy, dz, radius);
  }

  // ---- overlaps ----

  /** Fills `this.cand` with the shapes whose bounds meet the box and that pass the filter. @internal */
  gather(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, f: QueryFilter | undefined): Shape[] {
    this.ensureSynced();
    const cand = this.cand;
    if (this._kw !== null) {
      try { if (this._kw.gather(x0, y0, z0, x1, y1, z1, f, cand)) return cand; } catch (e) { this.dropKernel(e); }
    }
    cand.length = 0;
    const stamp = ++this.stamp;
    const c = this.cell;
    const i0 = Math.floor(x0 / c), i1 = Math.floor(x1 / c), k0 = Math.floor(z0 / c), k1 = Math.floor(z1 / c);
    if ((i1 - i0 + 1) * (k1 - k0 + 1) > 4096) {
      const st = this.statics;
      for (let n = 0; n < st.length; n++) this.take(st[n]!, stamp, x0, y0, z0, x1, y1, z1, f);
    } else {
      for (let i = i0; i <= i1; i++) {
        for (let k = k0; k <= k1; k++) {
          const list = this.grid.get(key(i, k));
          if (list === undefined) continue;
          for (let n = 0; n < list.length; n++) this.take(list[n]!, stamp, x0, y0, z0, x1, y1, z1, f);
        }
      }
    }
    const bigs = this.bigs;
    for (let n = 0; n < bigs.length; n++) this.take(bigs[n]!, stamp, x0, y0, z0, x1, y1, z1, f);
    const mv = this.moving, index = this.index;
    const m = index.box(x0, y0, z0, x1, y1, z1);
    const found = index.found;
    for (let n = 0; n < m; n++) {
      const s = mv[found[n]!]!;
      if (this.pass(s, f)) cand.push(s);
    }
    return cand;
  }

  private take(s: Shape, stamp: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, f: QueryFilter | undefined): void {
    if (s._stamp === stamp) return;
    s._stamp = stamp;
    if (s.minx > x1 || s.maxx < x0 || s.miny > y1 || s.maxy < y0 || s.minz > z1 || s.maxz < z0) return;
    if (!this.pass(s, f)) return;
    this.cand.push(s);
  }

  /** Shapes that touch or overlap the sphere. Fills and returns `out` (default: the world's own list). */
  overlapSphere(center: Vec3Like, radius: number, filter?: QueryFilter, out: Shape[] = this.overlaps): Shape[] {
    out.length = 0;
    if (this._kw !== null) {
      this.ensureSynced();
      try { if (this._kw.overlapSphere(center.x, center.y, center.z, radius, filter, out)) return out; } catch (e) { this.dropKernel(e); }
      out.length = 0;
    }
    const cand = this.gather(center.x - radius, center.y - radius, center.z - radius, center.x + radius, center.y + radius, center.z + radius, filter);
    for (let i = 0; i < cand.length; i++) {
      const s = cand[i]!;
      if (closestOn(s, center.x, center.y, center.z) <= radius) out.push(s);
    }
    return out;
  }

  /** Shapes that touch or overlap the capsule between end-cap centres `a` and `b`. */
  overlapCapsule(a: Vec3Like, b: Vec3Like, radius: number, filter?: QueryFilter, out: Shape[] = this.overlaps): Shape[] {
    out.length = 0;
    const len = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);
    const n = Math.max(1, Math.ceil(len / (radius * 0.5)));
    if (this._kw !== null) {
      this.ensureSynced();
      try { if (this._kw.overlapCapsule(a.x, a.y, a.z, b.x, b.y, b.z, radius, n, filter, out)) return out; } catch (e) { this.dropKernel(e); }
      out.length = 0;
    }
    const cand = this.gather(
      Math.min(a.x, b.x) - radius, Math.min(a.y, b.y) - radius, Math.min(a.z, b.z) - radius,
      Math.max(a.x, b.x) + radius, Math.max(a.y, b.y) + radius, Math.max(a.z, b.z) + radius, filter);
    // The spheres leave a gap of about 3% of the radius between them; growing them by that much covers it.
    const rr = radius * 1.03;
    for (let i = 0; i < cand.length; i++) {
      const s = cand[i]!;
      for (let k = 0; k <= n; k++) {
        const u = k / n;
        if (closestOn(s, a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u) <= rr) { out.push(s); break; }
      }
    }
    return out;
  }

  /** Distance from a point to a shape (negative inside) and the direction away, for game code that wants them. */
  distanceTo(s: Shape, p: Vec3Like, outDir?: Vec3Like): number {
    this.ensureSynced();
    let d = NaN;
    let done = false;
    if (this._kw !== null && s._kid >= 0) {
      try { d = this._kw.closest(s, p.x, p.y, p.z); done = true; } catch (e) { this.dropKernel(e); }
    }
    if (!done) d = closestOn(s, p.x, p.y, p.z);
    if (outDir) { outDir.x = C.nx; outDir.y = C.ny; outDir.z = C.nz; }
    return d;
  }

  // ---- state ----

  /** Everything that changes in the simulation, as plain data, for tests, saves and the checksum. */
  state(): { tick: number; bodies: number[][] } {
    return { tick: this.world.tick, bodies: this.solver.state() };
  }
}
