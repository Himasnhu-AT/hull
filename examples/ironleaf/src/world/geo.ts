// A small builder for flat-shaded, vertex-coloured geometry: boxes, roofs, cylinders, cones, leaf cards. The village, the
// trees and the bamboo are each one mesh built from these, so the whole island draws in a handful of calls.
import * as THREE from 'hull/three';

type V = [number, number, number];

const c = new THREE.Color();
function rgb(hex: string, jitter: number, k: number): V {
  // Colour.set reads a hex string as sRGB and stores it in the linear working space, which is what vertex colours use.
  c.set(hex);
  const j = 1 + (((Math.sin(k * 12.9898) * 43758.5453) % 1) - 0.5) * jitter;
  return [c.r * j, c.g * j, c.b * j];
}

export class Geo {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  private k = 1;
  /** Local transform applied to everything pushed next: a yaw and an offset. */
  yaw = 0;
  ox = 0; oy = 0; oz = 0;
  /** Colour variation between faces, 0 to 1. */
  jitter = 0.12;

  private tf(p: V): V {
    const cs = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    return [p[0] * cs + p[2] * sn + this.ox, p[1] + this.oy, -p[0] * sn + p[2] * cs + this.oz];
  }

  tri(a: V, b: V, d: V, color: string): void {
    const A = this.tf(a), B = this.tf(b), D = this.tf(d);
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = D[0] - A[0], vy = D[1] - A[1], vz = D[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const col = rgb(color, this.jitter, this.k++);
    for (const p of [A, B, D]) { this.pos.push(...p); this.nor.push(nx, ny, nz); this.col.push(...col); }
  }

  quad(a: V, b: V, d: V, e: V, color: string): void {
    this.tri(a, b, d, color);
    this.tri(a, d, e, color);
  }

  /** An axis-aligned box (before the yaw) centred at (x, y, z). */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string, top = color): void {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const p = (i: number, j: number, k: number): V => [x + i * hx, y + j * hy, z + k * hz];
    this.quad(p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1), top);
    this.quad(p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1), color);
    this.quad(p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1), color);
    this.quad(p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1), color);
    this.quad(p(1, -1, 1), p(1, -1, -1), p(1, 1, -1), p(1, 1, 1), color);
    this.quad(p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1), color);
  }

  /** A hip roof: eaves at y, ridge at y + h, the ridge running along x and as long as ridgeLen. */
  hipRoof(x: number, y: number, z: number, w: number, d: number, h: number, ridgeLen: number, color: string, side = color): void {
    const hw = w / 2, hd = d / 2, rl = ridgeLen / 2;
    const a: V = [x - hw, y, z - hd], b: V = [x + hw, y, z - hd], e: V = [x + hw, y, z + hd], f: V = [x - hw, y, z + hd];
    const r1: V = [x - rl, y + h, z], r2: V = [x + rl, y + h, z];
    this.quad(a, b, r2, r1, color);
    this.quad(e, f, r1, r2, color);
    this.tri(b, e, r2, side);
    this.tri(f, a, r1, side);
    // the underside, so the eaves are not see-through
    this.quad(a, f, e, b, '#2a211b');
  }

  /** A pyramid roof (a cone with four sides) for towers and lanterns. */
  pyramid(x: number, y: number, z: number, w: number, d: number, h: number, color: string): void {
    this.hipRoof(x, y, z, w, d, h, 0.0001, color);
  }

  /** A vertical tapered cylinder with a cap, n sides. */
  cyl(x: number, y: number, z: number, r0: number, r1: number, h: number, n: number, color: string, cap = true): void {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const p0: V = [x + Math.cos(a0) * r0, y, z + Math.sin(a0) * r0], p1: V = [x + Math.cos(a1) * r0, y, z + Math.sin(a1) * r0];
      const q0: V = [x + Math.cos(a0) * r1, y + h, z + Math.sin(a0) * r1], q1: V = [x + Math.cos(a1) * r1, y + h, z + Math.sin(a1) * r1];
      this.quad(p1, p0, q0, q1, color);
      if (cap && r1 > 0) this.tri([x, y + h, z], q1, q0, color);
    }
  }

  /** A single double-sided leaf card, base to tip, with a width. */
  leaf(base: V, tip: V, width: number, color: string, tipColor = color): void {
    const dx = tip[0] - base[0], dz = tip[2] - base[2];
    const l = Math.hypot(dx, dz) || 1;
    const sx = (-dz / l) * width * 0.5, sz = (dx / l) * width * 0.5;
    const mid: V = [(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2 + width * 0.1, (base[2] + tip[2]) / 2];
    this.tri([base[0] - sx * 0.2, base[1], base[2] - sz * 0.2], [mid[0] + sx, mid[1], mid[2] + sz], [mid[0] - sx, mid[1], mid[2] - sz], color);
    this.tri([base[0] + sx * 0.2, base[1], base[2] + sz * 0.2], [mid[0] - sx, mid[1], mid[2] - sz], [mid[0] + sx, mid[1], mid[2] + sz], color);
    this.tri([mid[0] - sx, mid[1], mid[2] - sz], [mid[0] + sx, mid[1], mid[2] + sz], tip, tipColor);
    this.tri([mid[0] + sx, mid[1], mid[2] + sz], [mid[0] - sx, mid[1], mid[2] - sz], tip, tipColor);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}
