// CollisionWorld: the game's face of collision. Oriented boxes, spheres and capsules (static world pieces and the dynamic
// ones that ride on Object3Ds, titan limbs) live in hull/physics and are answered by its raycast and overlap queries.
// What hull/physics has no shape for stays here: vertical cylinders (trunks, posts) in a small grid of their own, and
// the analytic height-field ground (AOTT's ground is a function, not a sampled grid). A collider is still the game's
// object (material, hookable, userData, the world pose fields player.ts reads); each carries the physics Shape that
// answers for it. Used for tether-gear anchor raycasts, the player's swept sphere and titan steering.
import { physicsOf, usePhysics, type Hit, type Physics, type QueryFilter, type Shape } from 'hull/physics';
import type { World } from 'hull';
import * as THREE from 'hull/three';
import type { SurfaceMaterial } from '../types';

// Math.hypot is variadic and boxes its arguments in hot loops (it was the top source of garbage); this doesn't.
const hypot = (a: number, b: number, c = 0): number => Math.sqrt(a * a + b * b + c * c);


const CELL = 24;
// Layer bits: which kind of collider a physics shape is, so a query can leave out dynamic or non-hookable ones.
const L_STATIC_HOOK = 1, L_STATIC = 2, L_DYN_HOOK = 4, L_DYN = 8;
const M_ALL = 15, M_STATIC = L_STATIC_HOOK | L_STATIC, M_HOOK = L_STATIC_HOOK | L_DYN_HOOK, M_STATIC_HOOK = L_STATIC_HOOK;
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
let _ids = 1, _stamp = 1;

/** Fields every collider has. `userData` carries back-references (titan, dummy, branch...) for the gameplay code. */
interface ColliderBase {
  id: number;
  material: SurfaceMaterial | string;
  hookable: boolean;
  dynamic: boolean;
  userData: Record<string, any>;
  /** Dynamic colliders follow this object's matrixWorld (shape given in its local space). */
  object3D: THREE.Object3D | null;
  /** The physics shape that answers for this collider (boxes, spheres, capsules); null for cylinders. */
  _phys: Shape | null;
  /** Set by the game while a collider is taken out of play (town houses); remove/_register keep the shape in step. */
  removed?: boolean;
  _stamp: number;
  _cells: number[] | null;
  min: THREE.Vector3;
  max: THREE.Vector3;
}
/** Oriented box. lc/lh/lq: local centre, half extents, rotation; center/half/q/axes: the current world pose. */
export interface BoxCollider extends ColliderBase {
  type: 'box';
  lc: THREE.Vector3; lh: THREE.Vector3; lq: THREE.Quaternion;
  center: THREE.Vector3; half: THREE.Vector3; q: THREE.Quaternion;
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
}
/** Vertical cylinder (tree trunks, posts): static only. */
export interface CylinderCollider extends ColliderBase {
  type: 'cylinder';
  x: number; z: number; y0: number; y1: number; r: number;
}
/** Capsule between a and b (la/lb/lr: local). */
export interface CapsuleCollider extends ColliderBase {
  type: 'capsule';
  la: THREE.Vector3; lb: THREE.Vector3; lr: number;
  a: THREE.Vector3; b: THREE.Vector3; r: number;
}
/** Sphere (lc/lr: local). */
export interface SphereCollider extends ColliderBase {
  type: 'sphere';
  lc: THREE.Vector3; lr: number;
  center: THREE.Vector3; r: number;
}
export type ShapeCollider = BoxCollider | CylinderCollider | CapsuleCollider | SphereCollider;
/** The height-field ground (one shared object). */
export interface GroundCollider {
  id: 0; type: 'ground'; material: 'ground'; hookable: true; dynamic: false; userData: Record<string, any>;
  object3D?: null;
}
/** Anything a raycast or contact can report. */
export type Collider = ShapeCollider | GroundCollider;

/** Options shared by every add* call. */
export interface ColliderOptions {
  material?: SurfaceMaterial | string;
  /** Ropes may anchor to it (default true). */
  hookable?: boolean;
  /** Follows object3D every frame (updateDynamic) instead of living in the static grid. */
  dynamic?: boolean;
  userData?: Record<string, any>;
  object3D?: THREE.Object3D | null;
}
export interface BoxOptions extends ColliderOptions { center: THREE.Vector3; halfExtents: THREE.Vector3; quaternion?: THREE.Quaternion }
export interface CylinderOptions extends ColliderOptions { x: number; z: number; y0: number; y1: number; radius: number }
export interface CapsuleOptions extends ColliderOptions { a: THREE.Vector3; b: THREE.Vector3; radius: number }
export interface SphereOptions extends ColliderOptions { center: THREE.Vector3; radius: number }

export interface RayHit { point: THREE.Vector3; normal: THREE.Vector3; distance: number; collider: Collider }
export interface RayOptions {
  /** Test dynamic colliders too (default true). */
  dynamic?: boolean;
  hookableOnly?: boolean;
  ignore?: Set<Collider> | null;
}
/** A push-out contact: normal points out of the shape, depth is the overlap. */
export interface Contact { normal: THREE.Vector3; depth: number; collider: Collider }
/** A sphere's push-out contact (collideSphere). */
export type SphereContact = Contact;

export type GroundFn = (x: number, z: number) => number;

export class CollisionWorld {
  /** Vertical cylinders only (what hull/physics has no shape for), in a uniform grid. */
  grid = new Map<number, CylinderCollider[]>();
  /** Every static collider, of every type. */
  statics: ShapeCollider[] = [];
  dynamics: ShapeCollider[] = [];
  groundFn: GroundFn = () => 0;
  readonly physics: Physics;
  private _filter: QueryFilter = { mask: M_ALL };
  private _skipped: Shape[] = [];
  private _found: Shape[] = [];
  private _dir = { x: 0, y: 0, z: 0 };

  /** `world` is the Hull world; its physics is used (installed if the game has not). */
  constructor(world: World) { this.physics = physicsFor(world); }

  // ---------- shape creation ----------
  _make(o: ColliderOptions): ColliderBase {
    return {
      id: _ids++, material: o.material || 'stone', hookable: o.hookable !== false,
      dynamic: !!o.dynamic, userData: o.userData || {}, object3D: o.object3D || null, _phys: null, _stamp: 0, _cells: null,
      min: new THREE.Vector3(), max: new THREE.Vector3(),
    };
  }
  addBox(o: BoxOptions): BoxCollider {
    const lc = o.center.clone(), lh = o.halfExtents.clone(), lq = (o.quaternion || new THREE.Quaternion()).clone();
    const c: BoxCollider = {
      ...this._make(o), type: 'box', lc, lh, lq, center: lc.clone(), half: lh.clone(), q: lq.clone(),
      axes: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
    };
    this._boxAxes(c);
    return this._register(c);
  }
  addCylinder(o: CylinderOptions): CylinderCollider {
    const c: CylinderCollider = {
      ...this._make(o), type: 'cylinder', x: o.x, z: o.z, y0: Math.min(o.y0, o.y1), y1: Math.max(o.y0, o.y1), r: o.radius,
    };
    return this._register(c);
  }
  addCapsule(o: CapsuleOptions): CapsuleCollider {
    const la = o.a.clone(), lb = o.b.clone();
    const c: CapsuleCollider = { ...this._make(o), type: 'capsule', la, lb, lr: o.radius, a: la.clone(), b: lb.clone(), r: o.radius };
    return this._register(c);
  }
  addSphere(o: SphereOptions): SphereCollider {
    const lc = o.center.clone();
    const c: SphereCollider = { ...this._make(o), type: 'sphere', lc, lr: o.radius, center: lc.clone(), r: o.radius };
    return this._register(c);
  }
  setGround(fn: GroundFn): void { this.groundFn = fn; }
  groundHeight(x: number, z: number): number { return this.groundFn(x, z); }
  groundNormal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 0.5;
    const hx = this.groundFn(x + e, z) - this.groundFn(x - e, z);
    const hz = this.groundFn(x, z + e) - this.groundFn(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** Puts a collider in play (also how a removed one comes back). */
  _register<C extends ShapeCollider>(c: C): C {
    c.removed = false;
    if (c.type !== 'cylinder') c._phys = this._makeShape(c);
    if (c.dynamic) { this._dynPose(c); this.dynamics.push(c); return c; }
    this._bounds(c);
    this.statics.push(c);
    if (c.type !== 'cylinder') return c;
    const x0 = Math.floor(c.min.x / CELL), x1 = Math.floor(c.max.x / CELL);
    const z0 = Math.floor(c.min.z / CELL), z1 = Math.floor(c.max.z / CELL);
    const cells: number[] = c._cells = [];
    for (let i = x0; i <= x1; i++) for (let k = z0; k <= z1; k++) {
      const key = i * 73856093 ^ k * 19349663;
      let arr = this.grid.get(key);
      if (!arr) this.grid.set(key, arr = []);
      arr.push(c); cells.push(key);
    }
    return c;
  }
  remove(c: ShapeCollider): void {
    if (c._phys) { this.physics.remove(c._phys); c._phys = null; }
    if (c.dynamic) { const i = this.dynamics.indexOf(c); if (i >= 0) this.dynamics.splice(i, 1); return; }
    const i = this.statics.indexOf(c); if (i >= 0) this.statics.splice(i, 1);
    if (c.type === 'cylinder') for (const key of c._cells || []) { const arr = this.grid.get(key); const j = arr ? arr.indexOf(c) : -1; if (arr && j >= 0) arr.splice(j, 1); }
  }

  /** The physics shape for a box, sphere or capsule. A dynamic one starts with no object to follow: updateDynamic places it. */
  private _makeShape(c: BoxCollider | SphereCollider | CapsuleCollider): Shape {
    const layer = c.dynamic ? (c.hookable ? L_DYN_HOOK : L_DYN) : (c.hookable ? L_STATIC_HOOK : L_STATIC);
    const o = { layer, static: !c.dynamic, userData: c };
    // An oriented box carries its rotation in the pose, so its centre is the pose's position (or the local centre
    // for a dynamic one, whose pose comes from the object's matrix).
    if (c.type === 'box') {
      const size: [number, number, number] = [c.lh.x * 2, c.lh.y * 2, c.lh.z * 2];
      if (c.dynamic) return this.physics.add({ type: 'box', size }, o);
      return this.physics.add({ type: 'box', size }, { ...o, position: c.lc, quaternion: c.lq });
    }
    if (c.type === 'sphere') {
      return c.dynamic ? this.physics.add({ type: 'sphere', radius: c.lr, center: [c.lc.x, c.lc.y, c.lc.z] }, o)
        : this.physics.addSphere(c.lc, c.lr, o);
    }
    return c.dynamic ? this.physics.add({ type: 'capsule', radius: c.lr, a: [c.la.x, c.la.y, c.la.z], b: [c.lb.x, c.lb.y, c.lb.z] }, o)
      : this.physics.addCapsule(c.la, c.lb, c.lr, o);
  }

  _boxAxes(c: BoxCollider): void {
    c.axes[0].set(1, 0, 0).applyQuaternion(c.q);
    c.axes[1].set(0, 1, 0).applyQuaternion(c.q);
    c.axes[2].set(0, 0, 1).applyQuaternion(c.q);
  }
  _bounds(c: ShapeCollider): void {
    if (c.type === 'box') {
      const ex = Math.abs(c.axes[0].x) * c.half.x + Math.abs(c.axes[1].x) * c.half.y + Math.abs(c.axes[2].x) * c.half.z;
      const ey = Math.abs(c.axes[0].y) * c.half.x + Math.abs(c.axes[1].y) * c.half.y + Math.abs(c.axes[2].y) * c.half.z;
      const ez = Math.abs(c.axes[0].z) * c.half.x + Math.abs(c.axes[1].z) * c.half.y + Math.abs(c.axes[2].z) * c.half.z;
      c.min.set(c.center.x - ex, c.center.y - ey, c.center.z - ez); c.max.set(c.center.x + ex, c.center.y + ey, c.center.z + ez);
    } else if (c.type === 'cylinder') {
      c.min.set(c.x - c.r, c.y0, c.z - c.r); c.max.set(c.x + c.r, c.y1, c.z + c.r);
    } else if (c.type === 'capsule') {
      c.min.copy(c.a).min(c.b).subScalar(c.r); c.max.copy(c.a).max(c.b).addScalar(c.r);
    } else {
      c.min.copy(c.center).subScalar(c.r); c.max.copy(c.center).addScalar(c.r);
    }
  }
  /** Reads a dynamic collider's pose from its object into the game-side fields and into its physics shape. */
  _dynPose(c: ShapeCollider): void {
    const o = c.object3D;
    if (!o) { this._bounds(c); return; }
    const mw = o.matrixWorld;
    mw.decompose(_p, _q, _s);
    const sc = Math.max(Math.abs(_s.x), Math.abs(_s.y), Math.abs(_s.z));
    if (c.type === 'box') {
      c.center.copy(c.lc).applyMatrix4(mw); c.q.copy(_q).multiply(c.lq); c.half.copy(c.lh).multiply(_s.set(Math.abs(_s.x), Math.abs(_s.y), Math.abs(_s.z)));
      this._boxAxes(c);
      // the shape's pose is the object's matrix, then the local centre and rotation
      if (c._phys) c._phys.setMatrix(_m4.compose(c.lc, c.lq, _one).premultiply(mw).elements);
    } else if (c.type === 'capsule') {
      c.a.copy(c.la).applyMatrix4(mw); c.b.copy(c.lb).applyMatrix4(mw); c.r = c.lr * sc;
      if (c._phys) c._phys.setMatrix(mw.elements);
    } else if (c.type === 'sphere') {
      c.center.copy(c.lc).applyMatrix4(mw); c.r = c.lr * sc;
      if (c._phys) c._phys.setMatrix(mw.elements);
    }
    this._bounds(c);
  }
  /** Recompute world poses of dynamic colliders from their Object3D.matrixWorld. */
  updateDynamic(): void { for (const c of this.dynamics) this._dynPose(c); }

  /** World position of a point given in a collider's attached-object local space (for anchors on titans). */
  toLocal(c: Collider, worldPoint: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    if (!c.object3D) return out.copy(worldPoint);
    return c.object3D.worldToLocal(out.copy(worldPoint));
  }
  toWorld(c: Collider, localPoint: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    if (!c.object3D) return out.copy(localPoint);
    return out.copy(localPoint).applyMatrix4(c.object3D.matrixWorld);
  }

  // ---------- broadphase (cylinders) ----------
  _gather(minx: number, minz: number, maxx: number, maxz: number, out: CylinderCollider[]): CylinderCollider[] {
    const st = ++_stamp;
    const x0 = Math.floor(minx / CELL), x1 = Math.floor(maxx / CELL), z0 = Math.floor(minz / CELL), z1 = Math.floor(maxz / CELL);
    for (let i = x0; i <= x1; i++) for (let k = z0; k <= z1; k++) {
      const arr = this.grid.get(i * 73856093 ^ k * 19349663);
      if (!arr) continue;
      for (const c of arr) if (c._stamp !== st) { c._stamp = st; out.push(c); }
    }
    return out;
  }

  // ---------- raycast ----------
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, opts: RayOptions = {}): RayHit | null {
    const dynamic = opts.dynamic !== false, hookOnly = !!opts.hookableOnly, ignore = opts.ignore;
    let best = maxDist, hit = null as Collider | null;
    // cylinders: walk the grid along the ray in half-cell steps
    if (this.grid.size > 0) {
      const steps = Math.ceil(maxDist / (CELL * 0.5)) + 1;
      const st = ++_stamp;
      for (let s = 0; s <= steps; s++) {
        const t = Math.min(maxDist, s * CELL * 0.5);
        if (t > best + CELL) break;
        const px = origin.x + dir.x * t, pz = origin.z + dir.z * t;
        const ci = Math.floor(px / CELL), ck = Math.floor(pz / CELL);
        for (let i = ci - 1; i <= ci + 1; i++) for (let k = ck - 1; k <= ck + 1; k++) {
          const arr = this.grid.get(i * 73856093 ^ k * 19349663);
          if (!arr) continue;
          for (const c of arr) {
            if (c._stamp === st) continue;
            c._stamp = st;
            if (hookOnly && !c.hookable) continue;
            if (ignore && ignore.has(c)) continue;
            const t2 = rayCylinder(c, origin, dir, best, _n);
            if (t2 !== null && t2 < best) { best = t2; hit = c; _bestN.copy(_n); }
          }
        }
      }
    }
    // everything else: hull/physics. A box the ray starts inside is not a hit (the soldier stands in houses' bounds
    // while walking through doors); ignored colliders are switched off for the cast and back on after.
    const f = this._filter;
    f.mask = dynamic ? (hookOnly ? M_HOOK : M_ALL) : (hookOnly ? M_STATIC_HOOK : M_STATIC);
    const skipped = this._skipped; skipped.length = 0;
    for (let n = 0; n < 64; n++) {
      const h: Hit | null = this.physics.raycast(origin, dir, best, f);
      if (!h || !h.shape) break;
      const c = h.shape.userData as ShapeCollider;
      if ((ignore && ignore.has(c)) || (h.inside && c.type === 'box')) { h.shape.enabled = false; skipped.push(h.shape); continue; }
      best = h.distance; hit = c; _bestN.set(h.nx, h.ny, h.nz);
      break;
    }
    for (let i = 0; i < skipped.length; i++) skipped[i]!.enabled = true;
    // ground (ray-march + bisection)
    const gt = this._rayGround(origin, dir, best);
    if (gt !== null && gt < best) {
      best = gt; hit = GROUND;
      const px = origin.x + dir.x * gt, pz = origin.z + dir.z * gt;
      this.groundNormal(px, pz, _bestN);
    }
    if (!hit) return null;
    return { point: origin.clone().addScaledVector(dir, best), normal: _bestN.clone(), distance: best, collider: hit };
  }
  _rayGround(o: THREE.Vector3, d: THREE.Vector3, maxD: number): number | null {
    const g = this.groundFn;
    let prevT = 0, prevH = o.y - g(o.x, o.z);
    if (prevH < 0) return 0;
    const step = 2.0;
    for (let t = step; t <= maxD + step; t += step) {
      const tt = Math.min(t, maxD);
      const h = o.y + d.y * tt - g(o.x + d.x * tt, o.z + d.z * tt);
      if (h <= 0) {
        let a = prevT, b = tt;
        for (let i = 0; i < 12; i++) {
          const m = (a + b) * 0.5;
          if (o.y + d.y * m - g(o.x + d.x * m, o.z + d.z * m) > 0) a = m; else b = m;
        }
        return a;
      }
      prevT = tt; prevH = h;
      if (tt >= maxD) break;
      // skip ahead when high above the terrain
      if (h > 30 && d.y >= 0) t += step * 4;
    }
    return null;
  }

  // ---------- overlap / contacts ----------
  querySphere(center: THREE.Vector3, radius: number, opts: { dynamic?: boolean } = {}): ShapeCollider[] {
    const out: ShapeCollider[] = [];
    if (this.grid.size > 0) {
      const cand = this._gather(center.x - radius, center.z - radius, center.x + radius, center.z + radius, []);
      for (const c of cand) {
        if (c.max.y < center.y - radius || c.min.y > center.y + radius) continue;
        if (closestOnCylinder(c, center, _w) <= radius * radius) out.push(c);
      }
    }
    this._filter.mask = opts.dynamic ? M_ALL : M_STATIC;
    const found = this.physics.overlapSphere(center, radius, this._filter, this._found);
    for (let i = 0; i < found.length; i++) out.push(found[i]!.userData as ShapeCollider);
    return out;
  }

  /** Contacts that push a sphere out of every overlapping shape (incl. ground). */
  collideSphere(center: THREE.Vector3, radius: number, opts: { dynamic?: boolean } = {}): Contact[] {
    const out: Contact[] = [];
    if (this.grid.size > 0) {
      _cand.length = 0;
      const cand = this._gather(center.x - radius, center.z - radius, center.x + radius, center.z + radius, _cand);
      for (const c of cand) {
        if (c.max.y < center.y - radius || c.min.y > center.y + radius) continue;
        const contact = cylinderContact(c, center, radius);
        if (contact) out.push(contact);
      }
      cand.length = 0;
    }
    this._filter.mask = opts.dynamic !== false ? M_ALL : M_STATIC;
    const found = this.physics.overlapSphere(center, radius, this._filter, this._found);
    for (let i = 0; i < found.length; i++) {
      const s = found[i]!;
      const d = this.physics.distanceTo(s, center, this._dir);
      out.push({ normal: new THREE.Vector3(this._dir.x, this._dir.y, this._dir.z), depth: radius - d, collider: s.userData as ShapeCollider });
    }
    const gh = this.groundFn(center.x, center.z);
    if (center.y - radius < gh + 0.001) {
      const n = this.groundNormal(center.x, center.z);
      const depth = (gh - (center.y - radius)) * n.y;
      out.push({ normal: n, depth: Math.max(depth, 0), collider: GROUND });
    }
    return out;
  }
}

/** The world's physics, installed on first use. */
export function physicsFor(world: World): Physics {
  try { return physicsOf(world); } catch { return usePhysics(world, { cell: CELL }); }
}

export const GROUND: GroundCollider = { id: 0, type: 'ground', material: 'ground', hookable: true, dynamic: false, userData: {} };
const _n = new THREE.Vector3(), _bestN = new THREE.Vector3();
const _cand: CylinderCollider[] = [];
const _m4 = new THREE.Matrix4(), _one = new THREE.Vector3(1, 1, 1);

// ---------- cylinders (no hull/physics shape for them) ----------
function rayCylinder(c: CylinderCollider, o: THREE.Vector3, d: THREE.Vector3, maxT: number, nOut: THREE.Vector3): number | null {
  // infinite vertical cylinder in xz, clipped to y range, plus caps
  const ox = o.x - c.x, oz = o.z - c.z;
  const a = d.x * d.x + d.z * d.z;
  let best: number | null = null;
  if (a > 1e-9) {
    const b = ox * d.x + oz * d.z, cc = ox * ox + oz * oz - c.r * c.r;
    const disc = b * b - a * cc;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      if (t >= 0 && t <= maxT) {
        const y = o.y + d.y * t;
        if (y >= c.y0 && y <= c.y1) { best = t; nOut.set(ox + d.x * t, 0, oz + d.z * t).normalize(); }
      }
    }
  }
  if (Math.abs(d.y) > 1e-9) {
    for (const yc of [c.y1, c.y0]) {
      const t = (yc - o.y) / d.y;
      if (t >= 0 && t <= maxT && (best === null || t < best)) {
        const px = ox + d.x * t, pz = oz + d.z * t;
        if (px * px + pz * pz <= c.r * c.r && ((yc === c.y1 && d.y < 0) || (yc === c.y0 && d.y > 0))) { best = t; nOut.set(0, yc === c.y1 ? 1 : -1, 0); }
      }
    }
  }
  return best;
}

/** Writes the closest point on the cylinder to p into out; returns squared distance (0 if inside). */
function closestOnCylinder(c: CylinderCollider, p: THREE.Vector3, out: THREE.Vector3): number {
  const y = THREE.MathUtils.clamp(p.y, c.y0, c.y1);
  const dx = p.x - c.x, dz = p.z - c.z, l = hypot(dx, dz);
  const k = l > c.r ? c.r / l : 1;
  out.set(c.x + dx * k, y, c.z + dz * k); return out.distanceToSquared(p);
}

/** Sphere-vs-cylinder contact: { normal (out of the shape), depth, collider } or null. */
function cylinderContact(c: CylinderCollider, p: THREE.Vector3, r: number): Contact | null {
  const dx = p.x - c.x, dz = p.z - c.z, l = hypot(dx, dz);
  if (l > c.r + r) return null;
  if (p.y > c.y1 + r || p.y < c.y0 - r) return null;
  if (p.y > c.y1) { // above the top cap
    if (l <= c.r) return { normal: new THREE.Vector3(0, 1, 0), depth: c.y1 + r - p.y, collider: c };
    const ex = c.x + dx / l * c.r, ez = c.z + dz / l * c.r;
    const n = new THREE.Vector3(p.x - ex, p.y - c.y1, p.z - ez); const d = n.length();
    if (d > r || d < 1e-9) return null; n.multiplyScalar(1 / d); return { normal: n, depth: r - d, collider: c };
  }
  if (p.y < c.y0) {
    if (l <= c.r) return { normal: new THREE.Vector3(0, -1, 0), depth: p.y - (c.y0 - r), collider: c };
    return null;
  }
  const side = c.r + r - l;
  const top = c.y1 + r - p.y;
  if (top < side && l < c.r) return { normal: new THREE.Vector3(0, 1, 0), depth: top, collider: c };
  const n = l > 1e-9 ? new THREE.Vector3(dx / l, 0, dz / l) : new THREE.Vector3(1, 0, 0);
  return { normal: n, depth: side, collider: c };
}
