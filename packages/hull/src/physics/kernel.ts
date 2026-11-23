// The physics world's mirror in the kernel (plan-rust.md R2): every shape and rigid body is also written into the
// WebAssembly module's memory, and queries and the rigid solver run there. TypeScript keeps the API, the Shape and
// RigidBody objects, and its own grid and index, always current, so the world can drop the kernel at any moment
// (a trap, a world too wide for it) and carry on in TypeScript with the same answers.
//
// The numbers cross through typed-array views over the module's memory: a pose is written, not passed in a call.
// The field numbers are crates/hull-kernels' (shapes.rs, rigid.rs, lib.rs `h`, world.rs FILT).
import type { Node } from '../core/index.ts';
import type { KernelExports } from '../kernel/index.ts';
import { B, C } from './narrow.ts';
import type { RigidBody } from './rigid.ts';
import type { Shape } from './shape.ts';
import { K } from './shape.ts';
import type { QueryFilter } from './types.ts';

// Header slots (lib.rs `mod h`).
const H_EPOCH = 0, H_SF = 1, H_SI = 2, H_SCAP = 3, H_RES = 4, H_FILT = 5, H_OUT = 6, H_OUTCAP = 7, H_UPF = 8, H_UPI = 9, H_UPH = 10;
const H_DIRTY = 11, H_NDIRTY = 12, H_DIRTYCAP = 13, H_BF = 14, H_BI = 15, H_BCAP = 16;
// Shape fields (shapes.rs).
const SF = 48, SI = 12;
const U = 13, PLANE_Y = 22, MINX = 23, LCX = 29, LAX = 32, LR = 38, LHX = 39;
const KIND = 0, LAYER = 1, MASK = 2, FLAGS = 3, TAG = 4, NODE = 5, DATA = 6;
const F_ENABLED = 1, F_TRIGGER = 2, F_STATIC = 4, F_AA = 8, F_DIRTY = 16;
// Bodies (rigid.rs).
const BF = 64, BI = 4;
const B_PX = 0, B_INV_MASS = 13, B_IIX = 20, B_PT_R = 23, B_INNER = 24, B_OUTER = 25, B_SLEEP_TIME = 26, B_IW = 27, B_PTS = 36;
const B_SHAPE = 0, B_SLEEPING = 1, B_TOUCHING = 2, B_NPTS = 3;
/// FILT words given to the prefix bit set of a tag filter (world.rs FILT is 264 words, the set starts at 8).
const TAG_WORDS = 256;

export class KernelWorld {
  private readonly k: KernelExports;
  private hdr: Int32Array;
  private epoch = -1;
  private sf!: Float64Array;
  private si!: Int32Array;
  private res!: Float64Array;
  private filt!: Int32Array;
  private dirty!: Int32Array;
  private out!: Int32Array;
  private bf!: Float64Array;
  private bi!: Int32Array;
  /** Shape by kernel id. */
  private readonly byId: (Shape | null)[] = [];
  private readonly tagIds = new Map<string, number>([['', 0]]);
  private readonly tagNames: string[] = [''];
  private readonly prefixes = new Map<string, { words: Int32Array; tags: number }>();
  private readonly nodeIds = new WeakMap<Node, number>();
  private nextNode = 1;
  private awake = new Uint8Array(64);

  constructor(k: KernelExports, cell: number) {
    this.k = k;
    k.hk_world_init(cell);
    this.hdr = new Int32Array(k.memory.buffer, k.hk_hdr(), 64);
    this.views();
  }

  /** Remakes the views when the module's arrays have moved or grown (its epoch says so) or its memory grew. */
  private views(): void {
    const buf = this.k.memory.buffer;
    if (this.hdr.buffer !== buf) this.hdr = new Int32Array(buf, this.k.hk_hdr(), 64);
    const h = this.hdr;
    if (h[H_EPOCH] === this.epoch && this.sf !== undefined && this.sf.buffer === buf) return;
    this.epoch = h[H_EPOCH]!;
    const cap = h[H_SCAP]!;
    this.sf = new Float64Array(buf, h[H_SF]!, cap * SF);
    this.si = new Int32Array(buf, h[H_SI]!, cap * SI);
    this.res = new Float64Array(buf, h[H_RES]!, 16);
    this.filt = new Int32Array(buf, h[H_FILT]!, 8 + TAG_WORDS);
    this.dirty = new Int32Array(buf, h[H_DIRTY]!, h[H_DIRTYCAP]!);
    this.out = new Int32Array(buf, h[H_OUT]!, h[H_OUTCAP]!);
    this.bf = new Float64Array(buf, h[H_BF]!, h[H_BCAP]! * BF);
    this.bi = new Int32Array(buf, h[H_BI]!, h[H_BCAP]! * BI);
  }

  // ---- shapes ----

  private tagId(tag: string): number {
    let id = this.tagIds.get(tag);
    if (id === undefined) {
      id = this.tagNames.length;
      this.tagIds.set(tag, id);
      this.tagNames.push(tag);
    }
    return id;
  }

  private nodeId(node: Node): number {
    let id = this.nodeIds.get(node);
    if (id === undefined) { id = this.nextNode++; this.nodeIds.set(node, id); }
    return id;
  }

  /** Mirrors a shape the world has just added. False when the kernel cannot hold the world any more. */
  add(s: Shape): boolean {
    const id = this.k.hk_shape_new(s.kind);
    this.views();
    s._kw = this;
    s._kid = id;
    this.byId[id] = s;
    const f = this.sf, o = id * SF;
    f[o + LCX] = s.lcx; f[o + LCX + 1] = s.lcy; f[o + LCX + 2] = s.lcz;
    f[o + LAX] = s.lax; f[o + LAX + 1] = s.lay; f[o + LAX + 2] = s.laz;
    f[o + LAX + 3] = s.lbx; f[o + LAX + 4] = s.lby; f[o + LAX + 5] = s.lbz;
    f[o + LR] = s.lr;
    f[o + LHX] = s.lhx; f[o + LHX + 1] = s.lhy; f[o + LHX + 2] = s.lhz;
    this.si[id * SI + KIND] = s.kind;
    if (s.mesh !== null) this.uploadMesh(s, id);
    else if (s.hf !== null) this.uploadHeightfield(s, id);
    this.props(s);
    this.pose(s);
    // The pose is filed by the commit itself; nothing is left to flush for it.
    this.si[id * SI + FLAGS]! &= ~F_DIRTY;
    this.hdr[H_NDIRTY] = 0;
    const failed = this.k.hk_shape_commit(id);
    this.views();
    return failed === 0;
  }

  private uploadMesh(s: Shape, id: number): void {
    const m = s.mesh!;
    const data = this.k.hk_mesh_data(m.tris, m.nodes);
    this.views();
    const buf = this.k.memory.buffer, h = this.hdr;
    const fv = new Float64Array(buf, h[H_UPF]!, m.tris * 12 + m.nodes * 6);
    fv.set(m.v.subarray(0, m.tris * 9), 0);
    fv.set(m.n.subarray(0, m.tris * 3), m.tris * 9);
    fv.set(m.bb.subarray(0, m.nodes * 6), m.tris * 12);
    const iv = new Int32Array(buf, h[H_UPI]!, m.nodes * 4);
    iv.set(m.left.subarray(0, m.nodes), 0);
    iv.set(m.right.subarray(0, m.nodes), m.nodes);
    iv.set(m.first.subarray(0, m.nodes), m.nodes * 2);
    iv.set(m.count.subarray(0, m.nodes), m.nodes * 3);
    this.si[id * SI + DATA] = data;
  }

  private uploadHeightfield(s: Shape, id: number): void {
    const hf = s.hf!;
    const data = this.k.hk_hf_data(hf.columns, hf.rows);
    this.views();
    const buf = this.k.memory.buffer, h = this.hdr;
    const fv = new Float64Array(buf, h[H_UPF]!, 5);
    fv[0] = hf.cell; fv[1] = hf.x0; fv[2] = hf.z0; fv[3] = hf.y0; fv[4] = hf.scale;
    new Float32Array(buf, h[H_UPH]!, hf.columns * hf.rows).set(hf.h.subarray(0, hf.columns * hf.rows));
    this.si[id * SI + DATA] = data;
  }

  remove(s: Shape): void {
    const id = s._kid;
    if (id < 0) return;
    this.views();
    // A shape still waiting in the dirty list is dropped from it by the kernel's flush (it skips free shapes),
    // but its id may be reused before then, so the flush runs first.
    this.k.hk_shape_remove(id);
    this.byId[id] = null;
    s._kw = null;
    s._kid = -1;
  }

  /** Layer, mask, flags, tag and node, after any of them changed. */
  props(s: Shape): void {
    this.views();
    const o = s._kid * SI, si = this.si;
    si[o + LAYER] = s.layer;
    si[o + MASK] = s.mask;
    si[o + FLAGS] = (s.enabled ? F_ENABLED : 0) | (s.trigger ? F_TRIGGER : 0) | (s.isStatic ? F_STATIC : 0) | (s.aa ? F_AA : 0) | (si[o + FLAGS]! & F_DIRTY);
    si[o + TAG] = this.tagId(s.tag);
    si[o + NODE] = s.node === null ? 0 : this.nodeId(s.node);
  }

  /** The pose Shape.setMatrix has just worked out; the shape joins the list the kernel files before its next query. */
  pose(s: Shape): void {
    this.views();
    const id = s._kid, f = this.sf, o = id * SF;
    f[o] = s.cx; f[o + 1] = s.cy; f[o + 2] = s.cz;
    f[o + 3] = s.ax; f[o + 4] = s.ay; f[o + 5] = s.az;
    f[o + 6] = s.bx; f[o + 7] = s.by; f[o + 8] = s.bz;
    f[o + 9] = s.r;
    f[o + 10] = s.hx; f[o + 11] = s.hy; f[o + 12] = s.hz;
    const u = s.u;
    for (let k = 0; k < 9; k++) f[o + U + k] = u[k]!;
    f[o + PLANE_Y] = s.planeY;
    f[o + MINX] = s.minx; f[o + MINX + 1] = s.miny; f[o + MINX + 2] = s.minz;
    f[o + MINX + 3] = s.maxx; f[o + MINX + 4] = s.maxy; f[o + MINX + 5] = s.maxz;
    const si = this.si, fo = id * SI + FLAGS;
    let flags = si[fo]!;
    flags = s.aa ? flags | F_AA : flags & ~F_AA;
    if ((flags & F_DIRTY) === 0) {
      flags |= F_DIRTY;
      const n = this.hdr[H_NDIRTY]!;
      this.dirty[n] = id;
      this.hdr[H_NDIRTY] = n + 1;
    }
    si[fo] = flags;
  }

  // ---- queries ----

  /** Writes a query filter into FILT. False when it cannot be said there (more tags than the bit set holds). */
  private filter(f: QueryFilter | undefined): boolean {
    const w = this.filt;
    if (f === undefined) { w[0] = 0; return true; }
    w[0] = 1;
    w[1] = f.mask !== undefined ? 1 : 0;
    w[2] = f.mask ?? 0;
    w[3] = f.triggers === true ? 1 : 0;
    w[4] = f.ignoreShape !== undefined && f.ignoreShape !== null ? f.ignoreShape._kid : -1;
    w[5] = f.ignoreNode !== undefined && f.ignoreNode !== null ? this.nodeId(f.ignoreNode) : 0;
    const tag = f.tag;
    if (tag === undefined) { w[6] = 0; return true; }
    if (tag.charCodeAt(tag.length - 1) !== 42) { w[6] = 1; w[7] = this.tagIds.get(tag) ?? -1; return true; }
    const set = this.prefixSet(tag.slice(0, -1));
    if (set === null) return false;
    w[6] = 2;
    w[7] = set.length;
    w.set(set, 8);
    return true;
  }

  /** Which tags start with `prefix`, as a bit set over tag ids; kept until a new tag appears. */
  private prefixSet(prefix: string): Int32Array | null {
    const n = this.tagNames.length;
    if (n > TAG_WORDS * 32) return null;
    let p = this.prefixes.get(prefix);
    if (p === undefined || p.tags !== n) {
      const words = new Int32Array((n + 31) >> 5);
      for (let t = 0; t < n; t++) if (this.tagNames[t]!.startsWith(prefix)) words[t >> 5]! |= 1 << (t & 31);
      p = { words, tags: n };
      this.prefixes.set(prefix, p);
    }
    return p.words;
  }

  /** world.ts `cast` on the kernel: B in, B out. False when the kernel could not answer (the caller falls back). */
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number, f: QueryFilter | undefined): boolean {
    this.views();
    if (!this.filter(f)) return false;
    const res = this.res;
    res[0] = B.t; res[1] = B.nx; res[2] = B.ny; res[3] = B.nz;
    res[4] = B.shape === null ? -1 : B.shape._kid; res[5] = B.inside ? 1 : 0; res[6] = B.depth;
    if (this.k.hk_cast(ox, oy, oz, dx, dy, dz, r) !== 0) return false;
    this.views();
    const out = this.res;
    B.t = out[0]!; B.nx = out[1]!; B.ny = out[2]!; B.nz = out[3]!;
    const id = out[4]!;
    B.shape = id < 0 ? null : this.byId[id]!;
    B.inside = out[5] !== 0; B.depth = out[6]!;
    return true;
  }

  private collect(n: number, into: Shape[]): boolean {
    if (n < 0) return false;
    this.views();
    into.length = 0;
    const o = this.out;
    for (let i = 0; i < n; i++) into.push(this.byId[o[i]!]!);
    return true;
  }

  gather(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, f: QueryFilter | undefined, into: Shape[]): boolean {
    this.views();
    if (!this.filter(f)) return false;
    return this.collect(this.k.hk_gather(x0, y0, z0, x1, y1, z1), into);
  }

  overlapSphere(x: number, y: number, z: number, radius: number, f: QueryFilter | undefined, into: Shape[]): boolean {
    this.views();
    if (!this.filter(f)) return false;
    return this.collect(this.k.hk_overlap_sphere(x, y, z, radius), into);
  }

  overlapCapsule(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number, n: number, f: QueryFilter | undefined, into: Shape[]): boolean {
    this.views();
    if (!this.filter(f)) return false;
    return this.collect(this.k.hk_overlap_capsule(ax, ay, az, bx, by, bz, radius, n), into);
  }

  /** world.ts `distanceTo`; the direction away is left in narrow.ts's C, as closestOn leaves it. */
  closest(s: Shape, x: number, y: number, z: number): number {
    const d = this.k.hk_closest(s._kid, x, y, z);
    this.views();
    const r = this.res;
    C.dist = r[8]!; C.nx = r[9]!; C.ny = r[10]!; C.nz = r[11]!;
    return d;
  }

  // ---- rigid bodies ----

  bodyAdd(b: RigidBody): void {
    const i = this.k.hk_body_add(b.shape._kid);
    this.views();
    const f = this.bf, o = i * BF;
    f[o + B_IIX] = b.iix; f[o + B_IIX + 1] = b.iiy; f[o + B_IIX + 2] = b.iiz;
    f[o + B_PT_R] = b.ptR; f[o + B_INNER] = b.inner; f[o + B_OUTER] = b.outer;
    f.set(b.pts, o + B_PTS);
    this.bi[i * BI + B_NPTS] = b.pts.length / 3;
  }

  bodyRemove(index: number): void {
    this.k.hk_body_remove(index);
  }

  /**
   * One rigid step: what game code may have changed goes in, the solver runs, the state comes back out, and the
   * shapes and nodes of bodies that moved are posed in TypeScript as rigid.ts's step 5 poses them.
   */
  rigidStep(bodies: readonly RigidBody[], dt: number, g: { x: number; y: number; z: number }, iterations: number): boolean {
    this.views();
    const n = bodies.length;
    if (this.awake.length < n) this.awake = new Uint8Array(n * 2);
    let f = this.bf, bi = this.bi;
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!, o = i * BF, p = i * BI;
      f[o] = b.px; f[o + 1] = b.py; f[o + 2] = b.pz;
      f[o + 3] = b.qx; f[o + 4] = b.qy; f[o + 5] = b.qz; f[o + 6] = b.qw;
      f[o + 7] = b.vx; f[o + 8] = b.vy; f[o + 9] = b.vz;
      f[o + 10] = b.wx; f[o + 11] = b.wy; f[o + 12] = b.wz;
      f[o + B_INV_MASS] = b.invMass; f[o + 14] = b.restitution; f[o + 15] = b.friction;
      f[o + 16] = b.linearDamping; f[o + 17] = b.angularDamping; f[o + 18] = b.gravityScale; f[o + 19] = b.rollingResistance;
      f[o + B_SLEEP_TIME] = b.sleepTime;
      bi[p + B_SLEEPING] = b.sleeping ? 1 : 0;
      bi[p + B_TOUCHING] = b.touching ? 1 : 0;
      this.awake[i] = b.sleeping ? 0 : 1;
    }
    if (this.k.hk_rigid_step(dt, g.x, g.y, g.z, iterations) !== 0) return false;
    this.views();
    f = this.bf; bi = this.bi;
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!, o = i * BF, p = i * BI;
      b.px = f[o + B_PX]!; b.py = f[o + 1]!; b.pz = f[o + 2]!;
      b.qx = f[o + 3]!; b.qy = f[o + 4]!; b.qz = f[o + 5]!; b.qw = f[o + 6]!;
      b.vx = f[o + 7]!; b.vy = f[o + 8]!; b.vz = f[o + 9]!;
      b.wx = f[o + 10]!; b.wy = f[o + 11]!; b.wz = f[o + 12]!;
      b.sleepTime = f[o + B_SLEEP_TIME]!;
      for (let k = 0; k < 9; k++) b.iw[k] = f[o + B_IW + k]!;
      b.sleeping = bi[p + B_SLEEPING] !== 0;
      b.touching = bi[p + B_TOUCHING] !== 0;
      if (this.awake[i] === 1 || !b.sleeping) b.shape.setPose(b.px, b.py, b.pz, b.qx, b.qy, b.qz, b.qw);
      const node = b.node;
      if (node !== null && !b.sleeping) {
        node.position.set(b.px, b.py, b.pz);
        node.object3d.quaternion.set(b.qx, b.qy, b.qz, b.qw);
      }
    }
    return true;
  }
}

/** For the narrow-phase test and anything else that wants a kind's name. */
export const kindName = (k: number): string => Object.keys(K).find((n) => K[n as keyof typeof K] === k) ?? String(k);
