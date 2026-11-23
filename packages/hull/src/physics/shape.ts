// A Shape is one collider in the physics world: its local description, its current world pose and bounds.
// Games get Shapes back from `physics.add*` and from hits; they read `tag`, `node`, `userData` and do not
// write the underscore fields.
import type { Object3D } from 'three';
import type { Node } from '../core/index.ts';
import { buildMesh, type MeshData } from './mesh.ts';
import type { MovingIndex } from './moving.ts';
import type { ShapeDesc, ShapeOptions } from './types.ts';
import { LAYER_ALL } from './types.ts';

export const K = { sphere: 0, capsule: 1, box: 2, mesh: 3, plane: 4, heightfield: 5 } as const;
export type Kind = (typeof K)[keyof typeof K];

const BIG = 1e9;

export class HeightField {
  h!: Float32Array;
  columns = 0;
  rows = 0;
  cell = 1;
  x0 = 0;
  z0 = 0;
  y0 = 0;
  scale = 1;

  /** World height at (x, z) on the same two-triangle split the sweeps use; NaN outside the field. */
  heightAt(x: number, z: number): number {
    const fx = (x - this.x0) / this.cell;
    const fz = (z - this.z0) / this.cell;
    if (!(fx >= 0 && fz >= 0 && fx <= this.columns - 1 && fz <= this.rows - 1)) return NaN;
    let i = Math.floor(fx);
    let j = Math.floor(fz);
    if (i >= this.columns - 1) i = this.columns - 2;
    if (j >= this.rows - 1) j = this.rows - 2;
    const u = fx - i;
    const v = fz - j;
    const c = this.columns;
    const h = this.h;
    const h00 = h[j * c + i]!, h10 = h[j * c + i + 1]!, h01 = h[(j + 1) * c + i]!, h11 = h[(j + 1) * c + i + 1]!;
    const y = u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
    return this.y0 + y * this.scale;
  }
}

const els = new Float64Array(16);

/** Column-major 4x4 from a position and a unit quaternion. */
function fromPose(px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): Float64Array {
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
  els[0] = 1 - (yy + zz); els[1] = xy + wz; els[2] = xz - wy; els[3] = 0;
  els[4] = xy - wz; els[5] = 1 - (xx + zz); els[6] = yz + wx; els[7] = 0;
  els[8] = xz + wy; els[9] = yz - wx; els[10] = 1 - (xx + yy); els[11] = 0;
  els[12] = px; els[13] = py; els[14] = pz; els[15] = 1;
  return els;
}

let nextId = 1;

export class Shape {
  readonly id = nextId++;
  readonly kind: Kind;
  layer: number;
  mask: number;
  tag: string;
  trigger: boolean;
  readonly isStatic: boolean;
  enabled = true;
  node: Node | null;
  follow: Object3D | null;
  userData: unknown;

  // Local description.
  lcx = 0; lcy = 0; lcz = 0;
  lax = 0; lay = 0; laz = 0; lbx = 0; lby = 0; lbz = 0;
  lr = 0;
  lhx = 0; lhy = 0; lhz = 0;

  // World pose.
  cx = 0; cy = 0; cz = 0;
  ax = 0; ay = 0; az = 0; bx = 0; by = 0; bz = 0;
  r = 0;
  hx = 0; hy = 0; hz = 0;
  /** Box axes in world space: u[0..2] is local X, u[3..5] local Y, u[6..8] local Z. */
  readonly u = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  /** The box is aligned to the world axes, so queries skip the rotation. */
  aa = true;
  planeY = 0;
  mesh: MeshData | null = null;
  hf: HeightField | null = null;

  minx = 0; miny = 0; minz = 0; maxx = 0; maxy = 0; maxz = 0;

  /** @internal broadphase bookkeeping */
  _stamp = 0;
  _cells: number[] | null = null;
  _big = false;
  _removed = false;
  /** @internal rigid body that owns this shape, if any */
  _rb: unknown = null;
  /** @internal the world's index of moving shapes and this shape's slot in it; null and -1 for a static shape */
  _index: MovingIndex | null = null;
  _slot = -1;

  constructor(desc: ShapeDesc, o: ShapeOptions) {
    this.layer = o.layer ?? 1;
    this.mask = o.mask ?? LAYER_ALL;
    this.tag = o.tag ?? '';
    this.trigger = o.trigger ?? false;
    this.follow = o.follow ?? null;
    this.isStatic = o.static ?? o.follow === undefined;
    this.node = o.node ?? null;
    this.userData = o.userData;

    switch (desc.type) {
      case 'sphere': {
        this.kind = K.sphere;
        const c = desc.center ?? [0, 0, 0];
        this.lcx = c[0]; this.lcy = c[1]; this.lcz = c[2];
        this.lr = desc.radius;
        if (!(desc.radius > 0)) throw new Error(`physics: sphere radius must be positive, got ${desc.radius}`);
        break;
      }
      case 'capsule': {
        this.kind = K.capsule;
        this.lr = desc.radius;
        if (!(desc.radius > 0)) throw new Error(`physics: capsule radius must be positive, got ${desc.radius}`);
        if (desc.a !== undefined && desc.b !== undefined) {
          this.lax = desc.a[0]; this.lay = desc.a[1]; this.laz = desc.a[2];
          this.lbx = desc.b[0]; this.lby = desc.b[1]; this.lbz = desc.b[2];
        } else {
          const h = desc.height ?? desc.radius * 2;
          if (h < desc.radius * 2) throw new Error(`physics: capsule height ${h} is less than two radii (${desc.radius * 2})`);
          const c = desc.center ?? [0, 0, 0];
          const half = h / 2 - desc.radius;
          this.lax = c[0]; this.lay = c[1] - half; this.laz = c[2];
          this.lbx = c[0]; this.lby = c[1] + half; this.lbz = c[2];
        }
        break;
      }
      case 'box': {
        this.kind = K.box;
        const c = desc.center ?? [0, 0, 0];
        this.lcx = c[0]; this.lcy = c[1]; this.lcz = c[2];
        this.lhx = desc.size[0] / 2; this.lhy = desc.size[1] / 2; this.lhz = desc.size[2] / 2;
        if (!(this.lhx > 0 && this.lhy > 0 && this.lhz > 0)) throw new Error(`physics: box size must be positive, got [${desc.size.join(', ')}]`);
        break;
      }
      case 'mesh':
        this.kind = K.mesh;
        if (!this.isStatic) throw new Error('physics: a mesh collider must be static');
        break;
      case 'plane':
        this.kind = K.plane;
        this.planeY = desc.height;
        break;
      case 'heightfield': {
        this.kind = K.heightfield;
        if (!this.isStatic) throw new Error('physics: a heightfield collider must be static');
        if (desc.columns < 2 || desc.rows < 2) throw new Error('physics: a heightfield needs at least 2 columns and 2 rows');
        if (desc.heights.length < desc.columns * desc.rows) {
          throw new Error(`physics: heightfield has ${desc.heights.length} samples, needs ${desc.columns * desc.rows}`);
        }
        const hf = new HeightField();
        hf.columns = desc.columns;
        hf.rows = desc.rows;
        hf.cell = desc.cell;
        hf.x0 = desc.origin?.[0] ?? 0;
        hf.z0 = desc.origin?.[1] ?? 0;
        hf.y0 = desc.baseY ?? 0;
        hf.scale = desc.scale ?? 1;
        hf.h = Float32Array.from({ length: desc.columns * desc.rows }, (_, i) => desc.heights[i]!);
        this.hf = hf;
        break;
      }
    }

    if (desc.type === 'mesh') {
      this.updatePose(o);
      this.mesh = buildMesh(desc.positions, desc.indices, this.matrixFor(o));
    }
    this.updatePose(o);
  }

  private matrixFor(o: ShapeOptions): ArrayLike<number> {
    if (this.follow) {
      this.follow.updateWorldMatrix(true, false);
      return this.follow.matrixWorld.elements;
    }
    const p = o.position;
    const q = o.quaternion;
    return fromPose(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0, q?.x ?? 0, q?.y ?? 0, q?.z ?? 0, q?.w ?? 1);
  }

  private updatePose(o: ShapeOptions): void {
    this.setMatrix(this.matrixFor(o));
  }

  /** Re-reads the followed object's world matrix. */
  syncFollow(): void {
    const f = this.follow;
    if (f === null) return;
    f.updateWorldMatrix(true, false);
    this.setMatrix(f.matrixWorld.elements);
  }

  setPose(px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): void {
    this.setMatrix(fromPose(px, py, pz, qx, qy, qz, qw));
  }

  /** Places the shape from a column-major world matrix. Uniform scale is assumed for spheres and capsules. */
  setMatrix(e: ArrayLike<number>): void {
    const sx = Math.sqrt(e[0]! * e[0]! + e[1]! * e[1]! + e[2]! * e[2]!);
    const sy = Math.sqrt(e[4]! * e[4]! + e[5]! * e[5]! + e[6]! * e[6]!);
    const sz = Math.sqrt(e[8]! * e[8]! + e[9]! * e[9]! + e[10]! * e[10]!);
    switch (this.kind) {
      case K.sphere: {
        this.cx = e[0]! * this.lcx + e[4]! * this.lcy + e[8]! * this.lcz + e[12]!;
        this.cy = e[1]! * this.lcx + e[5]! * this.lcy + e[9]! * this.lcz + e[13]!;
        this.cz = e[2]! * this.lcx + e[6]! * this.lcy + e[10]! * this.lcz + e[14]!;
        this.r = this.lr * Math.max(sx, sy, sz);
        this.minx = this.cx - this.r; this.maxx = this.cx + this.r;
        this.miny = this.cy - this.r; this.maxy = this.cy + this.r;
        this.minz = this.cz - this.r; this.maxz = this.cz + this.r;
        break;
      }
      case K.capsule: {
        this.ax = e[0]! * this.lax + e[4]! * this.lay + e[8]! * this.laz + e[12]!;
        this.ay = e[1]! * this.lax + e[5]! * this.lay + e[9]! * this.laz + e[13]!;
        this.az = e[2]! * this.lax + e[6]! * this.lay + e[10]! * this.laz + e[14]!;
        this.bx = e[0]! * this.lbx + e[4]! * this.lby + e[8]! * this.lbz + e[12]!;
        this.by = e[1]! * this.lbx + e[5]! * this.lby + e[9]! * this.lbz + e[13]!;
        this.bz = e[2]! * this.lbx + e[6]! * this.lby + e[10]! * this.lbz + e[14]!;
        this.r = this.lr * Math.max(sx, sy, sz);
        this.minx = Math.min(this.ax, this.bx) - this.r; this.maxx = Math.max(this.ax, this.bx) + this.r;
        this.miny = Math.min(this.ay, this.by) - this.r; this.maxy = Math.max(this.ay, this.by) + this.r;
        this.minz = Math.min(this.az, this.bz) - this.r; this.maxz = Math.max(this.az, this.bz) + this.r;
        break;
      }
      case K.box: {
        this.cx = e[0]! * this.lcx + e[4]! * this.lcy + e[8]! * this.lcz + e[12]!;
        this.cy = e[1]! * this.lcx + e[5]! * this.lcy + e[9]! * this.lcz + e[13]!;
        this.cz = e[2]! * this.lcx + e[6]! * this.lcy + e[10]! * this.lcz + e[14]!;
        this.hx = this.lhx * sx; this.hy = this.lhy * sy; this.hz = this.lhz * sz;
        const u = this.u;
        u[0] = e[0]! / sx; u[1] = e[1]! / sx; u[2] = e[2]! / sx;
        u[3] = e[4]! / sy; u[4] = e[5]! / sy; u[5] = e[6]! / sy;
        u[6] = e[8]! / sz; u[7] = e[9]! / sz; u[8] = e[10]! / sz;
        this.aa = Math.abs(u[0]!) > 1 - 1e-9 && Math.abs(u[4]!) > 1 - 1e-9 && Math.abs(u[8]!) > 1 - 1e-9;
        const ex = this.aa ? this.hx : Math.abs(u[0]!) * this.hx + Math.abs(u[3]!) * this.hy + Math.abs(u[6]!) * this.hz;
        const ey = this.aa ? this.hy : Math.abs(u[1]!) * this.hx + Math.abs(u[4]!) * this.hy + Math.abs(u[7]!) * this.hz;
        const ez = this.aa ? this.hz : Math.abs(u[2]!) * this.hx + Math.abs(u[5]!) * this.hy + Math.abs(u[8]!) * this.hz;
        this.minx = this.cx - ex; this.maxx = this.cx + ex;
        this.miny = this.cy - ey; this.maxy = this.cy + ey;
        this.minz = this.cz - ez; this.maxz = this.cz + ez;
        break;
      }
      case K.mesh: {
        const m = this.mesh;
        if (m) {
          this.minx = m.minx; this.miny = m.miny; this.minz = m.minz;
          this.maxx = m.maxx; this.maxy = m.maxy; this.maxz = m.maxz;
        }
        break;
      }
      case K.plane: {
        this.minx = -BIG; this.maxx = BIG; this.minz = -BIG; this.maxz = BIG;
        this.miny = -BIG; this.maxy = this.planeY;
        break;
      }
      case K.heightfield: {
        const hf = this.hf!;
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < hf.h.length; i++) {
          const v = hf.h[i]!;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        const a = hf.y0 + lo * hf.scale, b = hf.y0 + hi * hf.scale;
        this.minx = hf.x0; this.maxx = hf.x0 + (hf.columns - 1) * hf.cell;
        this.minz = hf.z0; this.maxz = hf.z0 + (hf.rows - 1) * hf.cell;
        this.miny = Math.min(a, b); this.maxy = Math.max(a, b);
        break;
      }
    }
    if (this._index !== null) this._index.touch(this._slot, this);
  }
}
