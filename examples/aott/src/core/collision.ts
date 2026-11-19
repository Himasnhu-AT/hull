// CollisionWorld: analytic shapes (oriented boxes, vertical cylinders, capsules, spheres, a height-field ground)
// in a uniform-grid broadphase. Static shapes for the world, dynamic shapes that ride on Object3Ds (titan limbs).
// Used for tether-gear anchor raycasts, the player's swept sphere and titan steering.
import * as THREE from 'hull/three';
import type { SurfaceMaterial } from '../types';

// Math.hypot is variadic and boxes its arguments in hot loops (it was the top source of garbage); this doesn't.
const hypot = (a: number, b: number, c = 0): number => Math.sqrt(a * a + b * b + c * c);


const CELL = 24;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3();
const _m3 = new THREE.Matrix3();
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
  grid = new Map<number, ShapeCollider[]>();
  statics: ShapeCollider[] = [];
  dynamics: ShapeCollider[] = [];
  groundFn: GroundFn = () => 0;

  // ---------- shape creation ----------
  _make(o: ColliderOptions): ColliderBase {
    return {
      id: _ids++, material: o.material || 'stone', hookable: o.hookable !== false,
      dynamic: !!o.dynamic, userData: o.userData || {}, object3D: o.object3D || null, _stamp: 0, _cells: null,
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

  _register<C extends ShapeCollider>(c: C): C {
    if (c.dynamic) { this._dynPose(c); this.dynamics.push(c); return c; }
    this._bounds(c);
    this.statics.push(c);
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
    if (c.dynamic) { const i = this.dynamics.indexOf(c); if (i >= 0) this.dynamics.splice(i, 1); return; }
    const i = this.statics.indexOf(c); if (i >= 0) this.statics.splice(i, 1);
    for (const key of c._cells || []) { const arr = this.grid.get(key); const j = arr ? arr.indexOf(c) : -1; if (arr && j >= 0) arr.splice(j, 1); }
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
  _dynPose(c: ShapeCollider): void {
    const o = c.object3D;
    if (!o) { this._bounds(c); return; }
    const mw = o.matrixWorld;
    mw.decompose(_p, _q, _s);
    const sc = Math.max(Math.abs(_s.x), Math.abs(_s.y), Math.abs(_s.z));
    if (c.type === 'box') {
      c.center.copy(c.lc).applyMatrix4(mw); c.q.copy(_q).multiply(c.lq); c.half.copy(c.lh).multiply(_s.set(Math.abs(_s.x), Math.abs(_s.y), Math.abs(_s.z)));
      this._boxAxes(c);
    } else if (c.type === 'capsule') {
      c.a.copy(c.la).applyMatrix4(mw); c.b.copy(c.lb).applyMatrix4(mw); c.r = c.lr * sc;
    } else if (c.type === 'sphere') {
      c.center.copy(c.lc).applyMatrix4(mw); c.r = c.lr * sc;
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

  // ---------- broadphase ----------
  _gather(minx: number, minz: number, maxx: number, maxz: number, out: ShapeCollider[]): ShapeCollider[] {
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
    const test = (c: ShapeCollider) => {
      if (hookOnly && !c.hookable) return;
      if (ignore && ignore.has(c)) return;
      const t = rayShape(c, origin, dir, best, _n);
      if (t !== null && t < best) { best = t; hit = c; _bestN.copy(_n); }
    };
    // walk the grid along the ray in CELL steps (coarse DDA)
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
        for (const c of arr) if (c._stamp !== st) { c._stamp = st; test(c); }
      }
    }
    if (dynamic) for (const c of this.dynamics) test(c);
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
    const cand = this._gather(center.x - radius, center.z - radius, center.x + radius, center.z + radius, []);
    if (opts.dynamic) cand.push(...this.dynamics);
    for (const c of cand) {
      if (c.max.y < center.y - radius || c.min.y > center.y + radius) continue;
      if (closestOnShape(c, center, _w) <= radius * radius) out.push(c);
    }
    return out;
  }

  /** Contacts that push a sphere out of every overlapping shape (incl. ground). */
  collideSphere(center: THREE.Vector3, radius: number, opts: { dynamic?: boolean } = {}): Contact[] {
    const out: Contact[] = [];
    _cand.length = 0;
    const cand = this._gather(center.x - radius, center.z - radius, center.x + radius, center.z + radius, _cand);
    if (opts.dynamic !== false) for (const c of this.dynamics) cand.push(c);
    for (const c of cand) {
      if (c.max.y < center.y - radius || c.min.y > center.y + radius) continue;
      if (c.max.x < center.x - radius || c.min.x > center.x + radius) continue;
      if (c.max.z < center.z - radius || c.min.z > center.z + radius) continue;
      const contact = sphereContact(c, center, radius);
      if (contact) out.push(contact);
    }
    cand.length = 0;
    const gh = this.groundFn(center.x, center.z);
    if (center.y - radius < gh + 0.001) {
      const n = this.groundNormal(center.x, center.z);
      const depth = (gh - (center.y - radius)) * n.y;
      out.push({ normal: n, depth: Math.max(depth, 0), collider: GROUND });
    }
    return out;
  }
}

export const GROUND: GroundCollider = { id: 0, type: 'ground', material: 'ground', hookable: true, dynamic: false, userData: {} };
const _n = new THREE.Vector3(), _bestN = new THREE.Vector3();
const _cand: ShapeCollider[] = [];

// ---------- narrow phase helpers ----------
function rayAABBLocal(o: THREE.Vector3, d: THREE.Vector3, h: THREE.Vector3, maxT: number, nOut: THREE.Vector3): number | null {
  // slab test in box-local coordinates, returns entry t (or null), normal in local space
  let tmin = -Infinity, tmax = Infinity, axis = -1, sign = 0;
  for (let i = 0; i < 3; i++) {
    const oi = i === 0 ? o.x : i === 1 ? o.y : o.z, di = i === 0 ? d.x : i === 1 ? d.y : d.z, hi = i === 0 ? h.x : i === 1 ? h.y : h.z;
    if (Math.abs(di) < 1e-9) { if (oi < -hi || oi > hi) return null; continue; }
    let t1 = (-hi - oi) / di, t2 = (hi - oi) / di, s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax || tmax < 0) return null;
  }
  if (tmin < 0 || tmin > maxT || axis < 0) return null;
  nOut.set(0, 0, 0); if (axis === 0) nOut.x = sign; else if (axis === 1) nOut.y = sign; else nOut.z = sign;
  return tmin;
}
const _lo = new THREE.Vector3(), _ld = new THREE.Vector3();
function rayShape(c: ShapeCollider, o: THREE.Vector3, d: THREE.Vector3, maxT: number, nOut: THREE.Vector3): number | null {
  if (c.type === 'box') {
    _v.subVectors(o, c.center);
    _lo.set(_v.dot(c.axes[0]), _v.dot(c.axes[1]), _v.dot(c.axes[2]));
    _ld.set(d.dot(c.axes[0]), d.dot(c.axes[1]), d.dot(c.axes[2]));
    const t = rayAABBLocal(_lo, _ld, c.half, maxT, nOut);
    if (t === null) return null;
    const lx = nOut.x, ly = nOut.y, lz = nOut.z;
    nOut.set(0, 0, 0).addScaledVector(c.axes[0], lx).addScaledVector(c.axes[1], ly).addScaledVector(c.axes[2], lz);
    return t;
  }
  if (c.type === 'sphere') return raySphere(o, d, c.center, c.r, maxT, nOut);
  if (c.type === 'cylinder') {
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
    // top cap
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
  if (c.type === 'capsule') return rayCapsule(o, d, c.a, c.b, c.r, maxT, nOut);
  return null;
}
function raySphere(o: THREE.Vector3, d: THREE.Vector3, ctr: THREE.Vector3, r: number, maxT: number, nOut: THREE.Vector3): number | null {
  _w.subVectors(o, ctr);
  const b = _w.dot(d), cc = _w.lengthSq() - r * r;
  if (cc > 0 && b > 0) return null;
  const disc = b * b - cc;
  if (disc < 0) return null;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  if (t > maxT) return null;
  nOut.copy(o).addScaledVector(d, t).sub(ctr).normalize();
  return t;
}
const _w2 = new THREE.Vector3(), _ba = new THREE.Vector3(), _oa = new THREE.Vector3(), _tmp = new THREE.Vector3();
function rayCapsule(o: THREE.Vector3, d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number, maxT: number, nOut: THREE.Vector3): number | null {
  _ba.subVectors(b, a); _oa.subVectors(o, a);
  const baba = _ba.dot(_ba), bard = _ba.dot(d), baoa = _ba.dot(_oa), rdoa = d.dot(_oa), oaoa = _oa.dot(_oa);
  const A = baba - bard * bard, B = baba * rdoa - baoa * bard, C = baba * oaoa - baoa * baoa - r * r * baba;
  let best: number | null = null;
  if (A > 1e-9) {
    const h = B * B - A * C;
    if (h >= 0) {
      const t = (-B - Math.sqrt(h)) / A;
      const y = baoa + t * bard;
      if (t >= 0 && t <= maxT && y > 0 && y < baba) {
        best = t;
        _tmp.copy(o).addScaledVector(d, t);
        const s = y / baba;
        nOut.copy(_tmp).sub(_v.copy(a).addScaledVector(_ba, s)).normalize();
      }
    }
  }
  if (best === null) {
    const t1 = raySphere(o, d, a, r, maxT, _u);
    const t2 = raySphere(o, d, b, r, maxT, _w2);
    if (t1 !== null && (t2 === null || t1 <= t2)) { best = t1; nOut.copy(_u); }
    else if (t2 !== null) { best = t2; nOut.copy(_w2); }
  }
  return best;
}

/** Writes the closest point on shape to p into out; returns squared distance (0 if inside). */
function closestOnShape(c: ShapeCollider, p: THREE.Vector3, out: THREE.Vector3): number {
  if (c.type === 'box') {
    _v.subVectors(p, c.center);
    out.copy(c.center);
    for (let i = 0; i < 3; i++) {
      const h = i === 0 ? c.half.x : i === 1 ? c.half.y : c.half.z;
      const dd = THREE.MathUtils.clamp(_v.dot(c.axes[i]), -h, h);
      out.addScaledVector(c.axes[i], dd);
    }
    return out.distanceToSquared(p);
  }
  if (c.type === 'sphere') {
    _v.subVectors(p, c.center); const l = _v.length();
    if (l <= c.r) { out.copy(p); return 0; }
    out.copy(c.center).addScaledVector(_v, c.r / l); return out.distanceToSquared(p);
  }
  if (c.type === 'cylinder') {
    const y = THREE.MathUtils.clamp(p.y, c.y0, c.y1);
    const dx = p.x - c.x, dz = p.z - c.z, l = hypot(dx, dz);
    const k = l > c.r ? c.r / l : 1;
    out.set(c.x + dx * k, y, c.z + dz * k); return out.distanceToSquared(p);
  }
  if (c.type === 'capsule') {
    _ba.subVectors(c.b, c.a);
    const t = THREE.MathUtils.clamp(_v.subVectors(p, c.a).dot(_ba) / Math.max(_ba.lengthSq(), 1e-9), 0, 1);
    _u.copy(c.a).addScaledVector(_ba, t);
    _v.subVectors(p, _u); const l = _v.length();
    if (l <= c.r) { out.copy(p); return 0; }
    out.copy(_u).addScaledVector(_v, c.r / l); return out.distanceToSquared(p);
  }
  return Infinity;
}

/** Sphere-vs-shape contact: { normal (out of the shape), depth, collider } or null. */
function sphereContact(c: ShapeCollider, p: THREE.Vector3, r: number): Contact | null {
  if (c.type === 'box') {
    _v.subVectors(p, c.center);
    const lx = _v.dot(c.axes[0]), ly = _v.dot(c.axes[1]), lz = _v.dot(c.axes[2]);
    const cx = THREE.MathUtils.clamp(lx, -c.half.x, c.half.x), cy = THREE.MathUtils.clamp(ly, -c.half.y, c.half.y), cz = THREE.MathUtils.clamp(lz, -c.half.z, c.half.z);
    const dx = lx - cx, dy = ly - cy, dz = lz - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r * r) return null;
    const n = new THREE.Vector3();
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      n.copy(c.axes[0]).multiplyScalar(dx / d).addScaledVector(c.axes[1], dy / d).addScaledVector(c.axes[2], dz / d);
      return { normal: n, depth: r - d, collider: c };
    }
    // centre inside: push out through the nearest face
    const px = c.half.x - Math.abs(lx), py = c.half.y - Math.abs(ly), pz = c.half.z - Math.abs(lz);
    if (px <= py && px <= pz) { n.copy(c.axes[0]).multiplyScalar(Math.sign(lx) || 1); return { normal: n, depth: px + r, collider: c }; }
    if (py <= pz) { n.copy(c.axes[1]).multiplyScalar(Math.sign(ly) || 1); return { normal: n, depth: py + r, collider: c }; }
    n.copy(c.axes[2]).multiplyScalar(Math.sign(lz) || 1); return { normal: n, depth: pz + r, collider: c };
  }
  if (c.type === 'cylinder') {
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
  if (c.type === 'sphere' || c.type === 'capsule') {
    let cx: number, cy: number, cz: number;
    if (c.type === 'sphere') { cx = c.center.x; cy = c.center.y; cz = c.center.z; }
    else {
      _ba.subVectors(c.b, c.a);
      const t = THREE.MathUtils.clamp(_v.subVectors(p, c.a).dot(_ba) / Math.max(_ba.lengthSq(), 1e-9), 0, 1);
      cx = c.a.x + _ba.x * t; cy = c.a.y + _ba.y * t; cz = c.a.z + _ba.z * t;
    }
    const n = new THREE.Vector3(p.x - cx, p.y - cy, p.z - cz);
    const d = n.length();
    if (d > c.r + r) return null;
    if (d < 1e-9) n.set(0, 1, 0); else n.multiplyScalar(1 / d);
    return { normal: n, depth: c.r + r - d, collider: c };
  }
  return null;
}
