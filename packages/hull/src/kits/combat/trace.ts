// Weapon traces. A blade is a line segment in a character socket's space; a hurt shape is a capsule, sphere or box that
// follows a bone (the character's `hits`). Each fixed step the blade's world segment is swept from where it was a step
// ago to where it is now and tested against the shapes, so a fast swing cannot skip over a thin limb and a blade that is
// drawn two metres away cannot hit. Nothing here allocates per step: scratch numbers and typed arrays made once.
import { Matrix4, Vector3, type Object3D } from 'three';
import { characterHits, type Animator } from '../../anim/index.ts';
import type { Character } from '../../schema/character.ts';

let closestS = 0;
let closestT = 0;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Squared distance between segments p1-q1 and p2-q2. The parameters of the closest points are left in
 * `closestParams` (0 is p, 1 is q).
 */
export function segSegDistSq(
  p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number,
  p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number,
): number {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-12;
  let s: number, t: number;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = clamp01(f / e); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) { t = 0; s = clamp01(-c / a); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  closestS = s;
  closestT = t;
  const cx = p1x + d1x * s - (p2x + d2x * t);
  const cy = p1y + d1y * s - (p2y + d2y * t);
  const cz = p1z + d1z * s - (p2z + d2z * t);
  return cx * cx + cy * cy + cz * cz;
}

/** Where the last `segSegDistSq` found its closest points: [on the first segment, on the second]. */
export const closestParams = (): [number, number] => [closestS, closestT];

/** Whether the segment p-q passes through the box of half extents h at the origin (axis aligned). */
export function segmentHitsBox(px: number, py: number, pz: number, qx: number, qy: number, qz: number, hx: number, hy: number, hz: number): boolean {
  let t0 = 0, t1 = 1;
  const dx = qx - px, dy = qy - py, dz = qz - pz;
  for (let k = 0; k < 3; k++) {
    const p = k === 0 ? px : k === 1 ? py : pz;
    const d = k === 0 ? dx : k === 1 ? dy : dz;
    const h = k === 0 ? hx : k === 1 ? hy : hz;
    if (Math.abs(d) < 1e-12) { if (p < -h || p > h) return false; continue; }
    let a = (-h - p) / d, b = (h - p) / d;
    if (a > b) { const x = a; a = b; b = x; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  return true;
}

const SPHERE = 1, BOX = 2;
const _m = new Matrix4();
const _v = new Vector3();
const _w = new Vector3();

/** The hurt shapes of one character, resolved against its body and kept in world space for one step at a time. */
export class HurtShapes {
  readonly n: number;
  /** The `part` of each shape ("head", "body", "limb:arm"), the game's word for what was hit. */
  readonly parts: string[] = [];
  private readonly boneNames: string[] = [];
  private readonly kind: Uint8Array;
  private readonly local: Float64Array;
  /** World space: a, b, r for capsules and spheres. */
  readonly world: Float64Array;
  private readonly inv: Float64Array;
  private readonly live: Uint8Array;
  private stamp = -1;
  private animator: Animator | null = null;
  private bones: (Object3D | undefined)[] = [];
  /** World position of the contact of the last `firstHit`. */
  cx = 0; cy = 0; cz = 0;

  constructor(def: Character, at = 'character') {
    const hits = characterHits(def, at);
    this.n = hits.length;
    this.kind = new Uint8Array(this.n);
    this.local = new Float64Array(this.n * 7);
    this.world = new Float64Array(this.n * 7);
    this.inv = new Float64Array(this.n * 16);
    this.live = new Uint8Array(this.n);
    hits.forEach((h, i) => {
      const s = h.hit;
      this.parts.push(s.part);
      this.boneNames.push(s.bone);
      const L = this.local, o = i * 7;
      if (s.shape === 'capsule') { L.set([s.a![0], s.a![1], s.a![2], s.b![0], s.b![1], s.b![2], s.r!], o); }
      else if (s.shape === 'sphere') { this.kind[i] = SPHERE; L.set([s.c![0], s.c![1], s.c![2], s.c![0], s.c![1], s.c![2], s.r!], o); }
      else { this.kind[i] = BOX; L.set([s.c![0], s.c![1], s.c![2], s.h![0], s.h![1], s.h![2], 0], o); }
    });
  }

  /** Follows the bones of this animator. Call again if the animator is rebuilt. */
  bind(animator: Animator): void {
    this.animator = animator;
    this.bones = this.boneNames.map((b) => animator.bone(b));
    this.stamp = -1;
  }

  get bound(): boolean { return this.animator !== null; }

  /** Brings the shapes to where the bones are at tick `tick`; once per tick however often it is asked. */
  refresh(tick: number): void {
    if (this.stamp === tick || !this.animator) return;
    this.stamp = tick;
    poseNow(this.animator, tick);
    for (let i = 0; i < this.n; i++) {
      const bone = this.bones[i];
      if (!bone) { this.live[i] = 0; continue; }
      this.live[i] = 1;
      const m = bone.matrixWorld;
      const e = m.elements;
      const sc = Math.sqrt(e[0]! * e[0]! + e[1]! * e[1]! + e[2]! * e[2]!);
      const L = this.local, W = this.world, o = i * 7;
      if (this.kind[i] === BOX) {
        _m.copy(m).invert();
        for (let k = 0; k < 16; k++) this.inv[i * 16 + k] = _m.elements[k]!;
        W[o] = L[o + 3]! * sc; W[o + 1] = L[o + 4]! * sc; W[o + 2] = L[o + 5]! * sc; // half extents in world scale
        W[o + 3] = L[o]!; W[o + 4] = L[o + 1]!; W[o + 5] = L[o + 2]!; // box centre, local
        W[o + 6] = sc;
      } else {
        _v.set(L[o]!, L[o + 1]!, L[o + 2]!).applyMatrix4(m);
        W[o] = _v.x; W[o + 1] = _v.y; W[o + 2] = _v.z;
        _v.set(L[o + 3]!, L[o + 4]!, L[o + 5]!).applyMatrix4(m);
        W[o + 3] = _v.x; W[o + 4] = _v.y; W[o + 5] = _v.z;
        W[o + 6] = L[o + 6]! * sc;
      }
    }
  }

  /**
   * The shape the segment (with the given thickness) touches, or -1. When several are touched the one the blade
   * passes deepest into wins. The contact is left in `cx, cy, cz`.
   */
  firstHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, thick: number): number {
    let best = -1, bestGap = Infinity;
    const W = this.world;
    for (let i = 0; i < this.n; i++) {
      if (!this.live[i]) continue;
      const o = i * 7;
      let gap: number;
      if (this.kind[i] === BOX) {
        const I = this.inv, io = i * 16;
        const tx = (x: number, y: number, z: number, k: number): number => I[io + k]! * x + I[io + 4 + k]! * y + I[io + 8 + k]! * z + I[io + 12 + k]!;
        const sc = W[o + 6]!;
        // To box space, which is the bone's; the box is then axis aligned with extents in local units.
        const lx = tx(ax, ay, az, 0) - W[o + 3]!, ly = tx(ax, ay, az, 1) - W[o + 4]!, lz = tx(ax, ay, az, 2) - W[o + 5]!;
        const mx = tx(bx, by, bz, 0) - W[o + 3]!, my = tx(bx, by, bz, 1) - W[o + 4]!, mz = tx(bx, by, bz, 2) - W[o + 5]!;
        const pad = thick / (sc || 1);
        const hx = W[o]! / (sc || 1) + pad, hy = W[o + 1]! / (sc || 1) + pad, hz = W[o + 2]! / (sc || 1) + pad;
        if (!segmentHitsBox(lx, ly, lz, mx, my, mz, hx, hy, hz)) continue;
        gap = 0;
        // Contact: the middle of the blade's part inside; good enough for a spark.
        _v.set((lx + mx) / 2 + W[o + 3]!, (ly + my) / 2 + W[o + 4]!, (lz + mz) / 2 + W[o + 5]!);
        _w.copy(_v).applyMatrix4(this.bones[i]!.matrixWorld);
        if (gap < bestGap) { bestGap = gap; best = i; this.cx = _w.x; this.cy = _w.y; this.cz = _w.z; }
        continue;
      }
      const d2 = segSegDistSq(ax, ay, az, bx, by, bz, W[o]!, W[o + 1]!, W[o + 2]!, W[o + 3]!, W[o + 4]!, W[o + 5]!);
      const reach = W[o + 6]! + thick;
      if (d2 > reach * reach) continue;
      gap = Math.sqrt(d2) - reach;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
        const s = closestS;
        this.cx = ax + (bx - ax) * s; this.cy = ay + (by - ay) * s; this.cz = az + (bz - az) * s;
      }
    }
    return best;
  }

  /** The nearest point of any shape to a world point, as a distance: for broad checks and for debug draw. */
  center(out: { x: number; y: number; z: number }): void {
    let n = 0;
    out.x = 0; out.y = 0; out.z = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.live[i] || this.kind[i] === BOX) continue;
      const o = i * 7;
      out.x += this.world[o]!; out.y += this.world[o + 1]!; out.z += this.world[o + 2]!;
      n++;
    }
    if (n > 0) { out.x /= n; out.y /= n; out.z /= n; }
  }

  isLive(i: number): boolean { return this.live[i] === 1; }
  isBox(i: number): boolean { return this.kind[i] === BOX; }
}

const stamps = new WeakMap<Animator, number>();

/** Builds the animator's pose for the latest fixed step and updates the world matrices of its node and bones, once per tick. */
export function poseNow(a: Animator, tick: number): void {
  if (stamps.get(a) === tick) return;
  stamps.set(a, tick);
  a.render(1, 0);
  a.node.object3d.updateWorldMatrix(true, true);
}

/** The blade of a weapon: where it was a step ago and where it is now, in world space. */
export class Blade {
  /** [base xyz, tip xyz] a step ago, and now. */
  readonly prev = new Float64Array(6);
  readonly cur = new Float64Array(6);
  /** True when `prev` holds a real sample from the step before. */
  armed = false;
  radius = 0.04;
  private socket: Object3D | undefined;
  private animator: Animator | null = null;
  readonly base = new Vector3();
  readonly tip = new Vector3();

  constructor(private socketName: string, base: readonly number[], tip: readonly number[], radius: number) {
    this.base.set(base[0]!, base[1]!, base[2]!);
    this.tip.set(tip[0]!, tip[1]!, tip[2]!);
    this.radius = radius;
  }

  setShape(base: readonly number[], tip: readonly number[], radius: number, socket: string): void {
    this.base.set(base[0]!, base[1]!, base[2]!);
    this.tip.set(tip[0]!, tip[1]!, tip[2]!);
    this.radius = radius;
    if (socket !== this.socketName) { this.socketName = socket; this.socket = undefined; }
  }

  bind(a: Animator): void { this.animator = a; this.socket = undefined; this.armed = false; }
  get bound(): boolean { return this.animator !== null; }
  /** The length of the blade in the world right now. */
  get length(): number { return Math.hypot(this.cur[3]! - this.cur[0]!, this.cur[4]! - this.cur[1]!, this.cur[5]! - this.cur[2]!); }

  /** Takes the sample for `tick`; the old one becomes `prev`. False when there is no animator or no such socket. */
  sample(tick: number): boolean {
    const a = this.animator;
    if (!a) return false;
    this.socket ??= a.socket(this.socketName);
    const s = this.socket;
    if (!s) return false;
    poseNow(a, tick);
    this.prev.set(this.cur);
    _m.copy(s.matrixWorld);
    _v.copy(this.base).applyMatrix4(_m);
    this.cur[0] = _v.x; this.cur[1] = _v.y; this.cur[2] = _v.z;
    _v.copy(this.tip).applyMatrix4(_m);
    this.cur[3] = _v.x; this.cur[4] = _v.y; this.cur[5] = _v.z;
    return true;
  }

  /** Forget the old sample (a new move starts; the blade teleported). */
  disarm(): void { this.armed = false; }
}

const sub = new Float64Array(6);

/**
 * Sweeps the blade from `prev` to `cur` against `shapes`: the segment is tested at enough points between the two that
 * no point of it moves more than a shape's thickness between tests. Returns the shape hit, or -1; the contact is on
 * `shapes`.
 */
export function sweepBlade(blade: Blade, shapes: HurtShapes): number {
  const p = blade.prev, c = blade.cur;
  // Travel of the faster end, in blade thicknesses (at least a hand's width), decides how many in-between tests.
  const travel = Math.max(Math.hypot(c[0]! - p[0]!, c[1]! - p[1]!, c[2]! - p[2]!), Math.hypot(c[3]! - p[3]!, c[4]! - p[4]!, c[5]! - p[5]!));
  const n = Math.min(12, Math.max(1, Math.ceil(travel / Math.max(0.05, blade.radius * 2))));
  const start = blade.armed ? 1 : n;
  for (let k = start; k <= n; k++) {
    const u = blade.armed ? k / n : 1;
    for (let j = 0; j < 6; j++) sub[j] = p[j]! + (c[j]! - p[j]!) * u;
    const hit = shapes.firstHit(sub[0]!, sub[1]!, sub[2]!, sub[3]!, sub[4]!, sub[5]!, blade.radius);
    if (hit >= 0) return hit;
  }
  return -1;
}
