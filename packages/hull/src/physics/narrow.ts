// Narrow phase. Two jobs, both on plain numbers so nothing allocates:
//   sweep: a sphere of radius r moving from o along the unit direction d, against one shape. r = 0 is a ray.
//          The nearest hit goes into `B`. A sweep that starts overlapping the shape reports t = 0 with the
//          direction to push out and how deep it is.
//   closest: how far a point is from a shape (negative inside) and the direction away from it.
// A sphere of radius r moving against a convex shape is a ray against that shape grown by r. Grown shapes are
// tested as faces moved out by r, edges as cylinders, corners as spheres.
import { Dda } from './dda.ts';
import type { Shape } from './shape.ts';
import { K } from './shape.ts';

export const B = {
  t: 0,
  nx: 0, ny: 0, nz: 0,
  shape: null as Shape | null,
  inside: false,
  depth: 0,
};

/** Closest-point result. */
export const C = { dist: 0, nx: 0, ny: 1, nz: 0 };

const T = { t: 0, nx: 0, ny: 0, nz: 0, inside: false, depth: 0 };
const CP = { x: 0, y: 0, z: 0 };

export function beginSweep(maxT: number): void {
  B.t = maxT;
  B.shape = null;
  B.inside = false;
  B.depth = 0;
}

function offer(t: number, nx: number, ny: number, nz: number, s: Shape, inside: boolean, depth: number): void {
  if (t < B.t || (B.shape === null && t <= B.t)) {
    B.t = t; B.nx = nx; B.ny = ny; B.nz = nz; B.shape = s; B.inside = inside; B.depth = depth;
  }
}

function offerT(s: Shape): void {
  offer(T.t, T.nx, T.ny, T.nz, s, T.inside, T.depth);
}

/** Ray against an axis-aligned box, only the parameter range [0, tmax]. */
export function rayAabb(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tmax: number,
): boolean {
  let t0 = 0;
  let t1 = tmax;
  if (dx > 1e-12 || dx < -1e-12) {
    let a = (x0 - ox) / dx, b = (x1 - ox) / dx;
    if (a > b) { const c = a; a = b; b = c; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  } else if (ox < x0 || ox > x1) return false;
  if (dy > 1e-12 || dy < -1e-12) {
    let a = (y0 - oy) / dy, b = (y1 - oy) / dy;
    if (a > b) { const c = a; a = b; b = c; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  } else if (oy < y0 || oy > y1) return false;
  if (dz > 1e-12 || dz < -1e-12) {
    let a = (z0 - oz) / dz, b = (z1 - oz) / dz;
    if (a > b) { const c = a; a = b; b = c; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  } else if (oz < z0 || oz > z1) return false;
  return true;
}

// ---- primitives: write T and return true on a hit ----

/** Sphere (centre c, radius R) hit by a ray from o along d. */
function sphereP(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, R: number): boolean {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - R * R;
  if (c > 0 && b > 0) return false;
  const disc = b * b - c;
  if (disc < 0) return false;
  if (c <= 0) {
    const l = Math.sqrt(mx * mx + my * my + mz * mz);
    T.t = 0;
    if (l > 1e-12) { T.nx = mx / l; T.ny = my / l; T.nz = mz / l; } else { T.nx = -dx; T.ny = -dy; T.nz = -dz; }
    T.inside = true;
    T.depth = R - l;
    return true;
  }
  const t = -b - Math.sqrt(disc);
  T.t = t;
  T.nx = (mx + dx * t) / R; T.ny = (my + dy * t) / R; T.nz = (mz + dz * t) / R;
  T.inside = false;
  T.depth = 0;
  return true;
}

/** Side of a cylinder: axis from a along unit e for length L, radius R. The end caps are left to spheres. */
function cylP(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number, ex: number, ey: number, ez: number, L: number, R: number,
): boolean {
  const aox = ox - ax, aoy = oy - ay, aoz = oz - az;
  const od = aox * ex + aoy * ey + aoz * ez;
  const dd = dx * ex + dy * ey + dz * ez;
  const px = aox - od * ex, py = aoy - od * ey, pz = aoz - od * ez;
  const qx = dx - dd * ex, qy = dy - dd * ey, qz = dz - dd * ez;
  const A = qx * qx + qy * qy + qz * qz;
  if (A < 1e-14) return false;
  const Bq = px * qx + py * qy + pz * qz;
  const Cq = px * px + py * py + pz * pz - R * R;
  if (Cq > 0 && Bq >= 0) return false;
  const disc = Bq * Bq - A * Cq;
  if (disc < 0) return false;
  const t = (-Bq - Math.sqrt(disc)) / A;
  if (t < 0) return false;
  const h = od + dd * t;
  if (h < 0 || h > L) return false;
  T.t = t;
  T.nx = (px + qx * t) / R; T.ny = (py + qy * t) / R; T.nz = (pz + qz * t) / R;
  T.inside = false;
  T.depth = 0;
  return true;
}

// ---- sphere shape ----

function sweepSphereShape(s: Shape, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): void {
  if (sphereP(ox, oy, oz, dx, dy, dz, s.cx, s.cy, s.cz, s.r + r)) offerT(s);
}

// ---- capsule shape ----

function sweepCapsuleShape(s: Shape, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): void {
  const abx = s.bx - s.ax, aby = s.by - s.ay, abz = s.bz - s.az;
  const l2 = abx * abx + aby * aby + abz * abz;
  const R = s.r + r;
  let u = l2 > 1e-18 ? ((ox - s.ax) * abx + (oy - s.ay) * aby + (oz - s.az) * abz) / l2 : 0;
  if (u < 0) u = 0; else if (u > 1) u = 1;
  const px = ox - (s.ax + abx * u), py = oy - (s.ay + aby * u), pz = oz - (s.az + abz * u);
  const d2 = px * px + py * py + pz * pz;
  if (d2 < R * R) {
    const l = Math.sqrt(d2);
    if (l > 1e-12) offer(0, px / l, py / l, pz / l, s, true, R - l);
    else offer(0, -dx, -dy, -dz, s, true, R);
    return;
  }
  if (l2 > 1e-18) {
    const L = Math.sqrt(l2);
    if (cylP(ox, oy, oz, dx, dy, dz, s.ax, s.ay, s.az, abx / L, aby / L, abz / L, L, R)) offerT(s);
  }
  if (sphereP(ox, oy, oz, dx, dy, dz, s.ax, s.ay, s.az, R)) offerT(s);
  if (l2 > 1e-18 && sphereP(ox, oy, oz, dx, dy, dz, s.bx, s.by, s.bz, R)) offerT(s);
}

// ---- box shape ----

const LO = new Float64Array(3);
const LD = new Float64Array(3);
const LH = new Float64Array(3);

function offerBox(s: Shape, t: number, nl0: number, nl1: number, nl2: number, inside: boolean, depth: number): void {
  if (!(t < B.t || (B.shape === null && t <= B.t))) return;
  if (s.aa) {
    offer(t, nl0, nl1, nl2, s, inside, depth);
  } else {
    const u = s.u;
    offer(t,
      nl0 * u[0]! + nl1 * u[3]! + nl2 * u[6]!,
      nl0 * u[1]! + nl1 * u[4]! + nl2 * u[7]!,
      nl0 * u[2]! + nl1 * u[5]! + nl2 * u[8]!,
      s, inside, depth);
  }
}

function sweepBoxShape(s: Shape, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): void {
  let lx = ox - s.cx, ly = oy - s.cy, lz = oz - s.cz;
  let ldx = dx, ldy = dy, ldz = dz;
  if (!s.aa) {
    const u = s.u;
    const rx = lx, ry = ly, rz = lz;
    lx = rx * u[0]! + ry * u[1]! + rz * u[2]!;
    ly = rx * u[3]! + ry * u[4]! + rz * u[5]!;
    lz = rx * u[6]! + ry * u[7]! + rz * u[8]!;
    ldx = dx * u[0]! + dy * u[1]! + dz * u[2]!;
    ldy = dx * u[3]! + dy * u[4]! + dz * u[5]!;
    ldz = dx * u[6]! + dy * u[7]! + dz * u[8]!;
  }
  const hx = s.hx, hy = s.hy, hz = s.hz;
  const ax = Math.abs(lx), ay = Math.abs(ly), az = Math.abs(lz);

  // Starting strictly inside the box: push out through the nearest face.
  if (ax < hx && ay < hy && az < hz) {
    const px = hx - ax, py = hy - ay, pz = hz - az;
    if (px <= py && px <= pz) offerBox(s, 0, lx < 0 ? -1 : 1, 0, 0, true, px + r);
    else if (py <= pz) offerBox(s, 0, 0, ly < 0 ? -1 : 1, 0, true, py + r);
    else offerBox(s, 0, 0, 0, lz < 0 ? -1 : 1, true, pz + r);
    return;
  }
  if (r > 0) {
    const qx = lx < -hx ? lx + hx : lx > hx ? lx - hx : 0;
    const qy = ly < -hy ? ly + hy : ly > hy ? ly - hy : 0;
    const qz = lz < -hz ? lz + hz : lz > hz ? lz - hz : 0;
    const d2 = qx * qx + qy * qy + qz * qz;
    if (d2 < r * r) {
      const l = Math.sqrt(d2);
      if (l > 1e-12) offerBox(s, 0, qx / l, qy / l, qz / l, true, r - l);
      else {
        // On the surface itself: use the face being touched.
        const fx = ax / hx, fy = ay / hy, fz = az / hz;
        if (fx >= fy && fx >= fz) offerBox(s, 0, lx < 0 ? -1 : 1, 0, 0, true, r);
        else if (fy >= fz) offerBox(s, 0, 0, ly < 0 ? -1 : 1, 0, true, r);
        else offerBox(s, 0, 0, 0, lz < 0 ? -1 : 1, true, r);
      }
      return;
    }
  }

  // Quick reject against the box grown by r.
  if (!rayAabb(lx, ly, lz, ldx, ldy, ldz, -hx - r, -hy - r, -hz - r, hx + r, hy + r, hz + r, B.t)) return;

  LO[0] = lx; LO[1] = ly; LO[2] = lz;
  LD[0] = ldx; LD[1] = ldy; LD[2] = ldz;
  LH[0] = hx; LH[1] = hy; LH[2] = hz;

  // Faces, moved out by r. The hit has to land inside the face's own rectangle.
  for (let i = 0; i < 3; i++) {
    const di = LD[i]!;
    if (di > -1e-12 && di < 1e-12) continue;
    const side = di > 0 ? -1 : 1;
    const t = (side * (LH[i]! + r) - LO[i]!) / di;
    if (t < 0 || t > B.t) continue;
    const j = i === 0 ? 1 : 0;
    const k = i === 2 ? 1 : 2;
    const pj = LO[j]! + LD[j]! * t;
    const pk = LO[k]! + LD[k]! * t;
    if (pj < -LH[j]! - 1e-9 || pj > LH[j]! + 1e-9 || pk < -LH[k]! - 1e-9 || pk > LH[k]! + 1e-9) continue;
    const n0 = i === 0 ? side : 0, n1 = i === 1 ? side : 0, n2 = i === 2 ? side : 0;
    offerBox(s, t, n0, n1, n2, false, 0);
  }
  if (r <= 0) return;

  // Edges (cylinders of radius r) and corners (spheres of radius r).
  for (let k = 0; k < 3; k++) {
    const i = (k + 1) % 3;
    const j = (k + 2) % 3;
    for (let si = -1; si <= 1; si += 2) {
      for (let sj = -1; sj <= 1; sj += 2) {
        // Edge start: coordinate k at -h, i and j at their signed extents.
        const cs = EDGE;
        cs[k] = -LH[k]!;
        cs[i] = si * LH[i]!;
        cs[j] = sj * LH[j]!;
        const px = cs[0]!, py = cs[1]!, pz = cs[2]!;
        const ex = k === 0 ? 1 : 0, ey = k === 1 ? 1 : 0, ez = k === 2 ? 1 : 0;
        if (cylP(lx, ly, lz, ldx, ldy, ldz, px, py, pz, ex, ey, ez, 2 * LH[k]!, r)) {
          offerBox(s, T.t, T.nx, T.ny, T.nz, false, 0);
        }
      }
    }
  }
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        if (sphereP(lx, ly, lz, ldx, ldy, ldz, sx * hx, sy * hy, sz * hz, r)) offerBox(s, T.t, T.nx, T.ny, T.nz, false, 0);
      }
    }
  }
}
const EDGE = new Float64Array(3);

// ---- triangles ----

/** Closest point on triangle (a, b, c) to p, into CP. Returns squared distance. */
function closestTri(px: number, py: number, pz: number, v: Float64Array, o: number): number {
  const ax = v[o]!, ay = v[o + 1]!, az = v[o + 2]!;
  const bx = v[o + 3]!, by = v[o + 4]!, bz = v[o + 5]!;
  const cx = v[o + 6]!, cy = v[o + 7]!, cz = v[o + 8]!;
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let rx: number, ry: number, rz: number;
  if (d1 <= 0 && d2 <= 0) { rx = ax; ry = ay; rz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { rx = bx; ry = by; rz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const w = d1 / (d1 - d3);
        rx = ax + abx * w; ry = ay + aby * w; rz = az + abz * w;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { rx = cx; ry = cy; rz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            rx = ax + acx * w; ry = ay + acy * w; rz = az + acz * w;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              rx = bx + (cx - bx) * w; ry = by + (cy - by) * w; rz = bz + (cz - bz) * w;
            } else {
              const den = 1 / (va + vb + vc);
              const vv = vb * den, ww = vc * den;
              rx = ax + abx * vv + acx * ww; ry = ay + aby * vv + acy * ww; rz = az + abz * vv + acz * ww;
            }
          }
        }
      }
    }
  }
  CP.x = rx; CP.y = ry; CP.z = rz;
  const ex = px - rx, ey = py - ry, ez = pz - rz;
  return ex * ex + ey * ey + ez * ez;
}

/** A sphere sweep against one triangle (two-sided). `v` holds the vertices at `vo`, `n` the unit normal at `no`. */
function triSweep(
  s: Shape, v: Float64Array, vo: number, n: Float64Array, no: number,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number,
): void {
  const nx = n[no]!, ny = n[no + 1]!, nz = n[no + 2]!;
  if (nx === 0 && ny === 0 && nz === 0) return;
  const ax = v[vo]!, ay = v[vo + 1]!, az = v[vo + 2]!;
  if (r > 0) {
    const d2 = closestTri(ox, oy, oz, v, vo);
    if (d2 < r * r) {
      const l = Math.sqrt(d2);
      if (l > 1e-12) offer(0, (ox - CP.x) / l, (oy - CP.y) / l, (oz - CP.z) / l, s, true, r - l);
      else {
        const side = (ox - ax) * nx + (oy - ay) * ny + (oz - az) * nz >= 0 ? 1 : -1;
        offer(0, nx * side, ny * side, nz * side, s, true, r);
      }
      return;
    }
  }
  const sd = (ox - ax) * nx + (oy - ay) * ny + (oz - az) * nz;
  const side = sd >= 0 ? 1 : -1;
  const dn = dx * nx + dy * ny + dz * nz;
  if (side * dn < 0) {
    const t = (side * r - sd) / dn;
    if (t >= 0 && t <= B.t) {
      const px = ox + dx * t - side * r * nx, py = oy + dy * t - side * r * ny, pz = oz + dz * t - side * r * nz;
      if (pointInTri(px, py, pz, v, vo, nx, ny, nz)) offer(t, nx * side, ny * side, nz * side, s, false, 0);
    }
  }
  if (r <= 0) return;
  const bx = v[vo + 3]!, by = v[vo + 4]!, bz = v[vo + 5]!;
  const cx = v[vo + 6]!, cy = v[vo + 7]!, cz = v[vo + 8]!;
  edgeCyl(s, ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r);
  edgeCyl(s, ox, oy, oz, dx, dy, dz, bx, by, bz, cx, cy, cz, r);
  edgeCyl(s, ox, oy, oz, dx, dy, dz, cx, cy, cz, ax, ay, az, r);
  if (sphereP(ox, oy, oz, dx, dy, dz, ax, ay, az, r)) offerT(s);
  if (sphereP(ox, oy, oz, dx, dy, dz, bx, by, bz, r)) offerT(s);
  if (sphereP(ox, oy, oz, dx, dy, dz, cx, cy, cz, r)) offerT(s);
}

function edgeCyl(
  s: Shape, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number,
): void {
  const ex = bx - ax, ey = by - ay, ez = bz - az;
  const L = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (L < 1e-12) return;
  if (cylP(ox, oy, oz, dx, dy, dz, ax, ay, az, ex / L, ey / L, ez / L, L, r)) offerT(s);
}

function pointInTri(px: number, py: number, pz: number, v: Float64Array, o: number, nx: number, ny: number, nz: number): boolean {
  // Same-side test against each edge, with a small tolerance so shared edges leave no cracks.
  const eps = -1e-9;
  for (let k = 0; k < 3; k++) {
    const i = o + k * 3;
    const j = o + ((k + 1) % 3) * 3;
    const ex = v[j]! - v[i]!, ey = v[j + 1]! - v[i + 1]!, ez = v[j + 2]! - v[i + 2]!;
    const qx = px - v[i]!, qy = py - v[i + 1]!, qz = pz - v[i + 2]!;
    const cx = ey * qz - ez * qy, cy = ez * qx - ex * qz, cz = ex * qy - ey * qx;
    const el = ex * ex + ey * ey + ez * ez;
    if (cx * nx + cy * ny + cz * nz < eps * Math.sqrt(el)) return false;
  }
  return true;
}

// ---- mesh ----

const stack = new Int32Array(128);

function sweepMeshShape(s: Shape, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): void {
  const m = s.mesh!;
  if (m.nodes === 0) return;
  let sp = 0;
  stack[sp++] = 0;
  const bb = m.bb;
  while (sp > 0) {
    const node = stack[--sp]!;
    const o = node * 6;
    if (!rayAabb(ox, oy, oz, dx, dy, dz, bb[o]! - r, bb[o + 1]! - r, bb[o + 2]! - r, bb[o + 3]! + r, bb[o + 4]! + r, bb[o + 5]! + r, B.t)) continue;
    const l = m.left[node]!;
    if (l < 0) {
      const f = m.first[node]!;
      const e = f + m.count[node]!;
      for (let i = f; i < e; i++) triSweep(s, m.v, i * 9, m.n, i * 3, ox, oy, oz, dx, dy, dz, r);
    } else {
      stack[sp++] = m.right[node]!;
      stack[sp++] = l;
    }
  }
}

// ---- plane ----

function sweepPlaneShape(s: Shape, oy: number, dy: number, r: number): void {
  const sd = oy - s.planeY;
  if (sd < r) { offer(0, 0, 1, 0, s, true, r - sd); return; }
  if (dy < 0) offer((sd - r) / -dy, 0, 1, 0, s, false, 0);
}

// ---- heightfield ----

const HV = new Float64Array(9);
const HN = new Float64Array(3);
const hfDda = new Dda();

function hfTri(s: Shape, i0: number, j0: number, i1: number, j1: number, i2: number, j2: number,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): void {
  const hf = s.hf!;
  const c = hf.columns;
  HV[0] = hf.x0 + i0 * hf.cell; HV[1] = hf.y0 + hf.h[j0 * c + i0]! * hf.scale; HV[2] = hf.z0 + j0 * hf.cell;
  HV[3] = hf.x0 + i1 * hf.cell; HV[4] = hf.y0 + hf.h[j1 * c + i1]! * hf.scale; HV[5] = hf.z0 + j1 * hf.cell;
  HV[6] = hf.x0 + i2 * hf.cell; HV[7] = hf.y0 + hf.h[j2 * c + i2]! * hf.scale; HV[8] = hf.z0 + j2 * hf.cell;
  const e1x = HV[3]! - HV[0]!, e1y = HV[4]! - HV[1]!, e1z = HV[5]! - HV[2]!;
  const e2x = HV[6]! - HV[0]!, e2y = HV[7]! - HV[1]!, e2z = HV[8]! - HV[2]!;
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (l < 1e-12) return;
  nx /= l; ny /= l; nz /= l;
  HN[0] = nx; HN[1] = ny; HN[2] = nz;
  triSweep(s, HV, 0, HN, 0, ox, oy, oz, dx, dy, dz, r);
}

function hfCell(s: Shape, i: number, j: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): void {
  hfTri(s, i, j, i, j + 1, i + 1, j, ox, oy, oz, dx, dy, dz, r);
  hfTri(s, i + 1, j, i, j + 1, i + 1, j + 1, ox, oy, oz, dx, dy, dz, r);
}

function sweepHeightfieldShape(s: Shape, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): void {
  const hf = s.hf!;
  const h0 = hf.heightAt(ox, oz);
  if (h0 === h0 && oy < h0) {
    offer(0, 0, 1, 0, s, true, h0 - oy + r);
    return;
  }
  const k = r > 0 ? Math.ceil(r / hf.cell) : 0;
  const cmax = hf.columns - 2;
  const rmax = hf.rows - 2;
  hfDda.init(ox - hf.x0, oz - hf.z0, dx, dz, B.t, hf.cell);
  for (;;) {
    const ci = hfDda.ix, cj = hfDda.iz;
    if (ci >= -k && ci <= cmax + k && cj >= -k && cj <= rmax + k) {
      for (let j = cj - k; j <= cj + k; j++) {
        if (j < 0 || j > rmax) continue;
        for (let i = ci - k; i <= ci + k; i++) {
          if (i < 0 || i > cmax) continue;
          hfCell(s, i, j, ox, oy, oz, dx, dy, dz, r);
        }
      }
    } else if ((hfDda.stepSignX > 0 && ci > cmax + k) || (hfDda.stepSignX < 0 && ci < -k) ||
      (hfDda.stepSignZ > 0 && cj > rmax + k) || (hfDda.stepSignZ < 0 && cj < -k)) {
      break;
    }
    if (k === 0 && B.t <= hfDda.tExit) break;
    if (!hfDda.advance()) break;
  }
}

/** Sweeps a sphere of radius r from o along unit d against one shape, updating B. */
export function sweepShape(s: Shape, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): void {
  switch (s.kind) {
    case K.sphere: sweepSphereShape(s, ox, oy, oz, dx, dy, dz, r); break;
    case K.capsule: sweepCapsuleShape(s, ox, oy, oz, dx, dy, dz, r); break;
    case K.box: sweepBoxShape(s, ox, oy, oz, dx, dy, dz, r); break;
    case K.mesh: sweepMeshShape(s, ox, oy, oz, dx, dy, dz, r); break;
    case K.plane: sweepPlaneShape(s, oy, dy, r); break;
    case K.heightfield: sweepHeightfieldShape(s, ox, oy, oz, dx, dy, dz, r); break;
  }
}

// ---- closest point ----

function boxLocal(s: Shape, px: number, py: number, pz: number): void {
  // Result: signed distance in C.dist, local normal in C.n*, converted to world below.
  let lx = px - s.cx, ly = py - s.cy, lz = pz - s.cz;
  if (!s.aa) {
    const u = s.u;
    const rx = lx, ry = ly, rz = lz;
    lx = rx * u[0]! + ry * u[1]! + rz * u[2]!;
    ly = rx * u[3]! + ry * u[4]! + rz * u[5]!;
    lz = rx * u[6]! + ry * u[7]! + rz * u[8]!;
  }
  const hx = s.hx, hy = s.hy, hz = s.hz;
  const ax = Math.abs(lx), ay = Math.abs(ly), az = Math.abs(lz);
  let nx: number, ny: number, nz: number;
  if (ax < hx && ay < hy && az < hz) {
    const qx = hx - ax, qy = hy - ay, qz = hz - az;
    if (qx <= qy && qx <= qz) { C.dist = -qx; nx = lx < 0 ? -1 : 1; ny = 0; nz = 0; }
    else if (qy <= qz) { C.dist = -qy; nx = 0; ny = ly < 0 ? -1 : 1; nz = 0; }
    else { C.dist = -qz; nx = 0; ny = 0; nz = lz < 0 ? -1 : 1; }
  } else {
    const qx = lx < -hx ? lx + hx : lx > hx ? lx - hx : 0;
    const qy = ly < -hy ? ly + hy : ly > hy ? ly - hy : 0;
    const qz = lz < -hz ? lz + hz : lz > hz ? lz - hz : 0;
    const l = Math.sqrt(qx * qx + qy * qy + qz * qz);
    C.dist = l;
    if (l > 1e-12) { nx = qx / l; ny = qy / l; nz = qz / l; }
    else { nx = lx < 0 ? -1 : 1; ny = 0; nz = 0; }
  }
  if (s.aa) { C.nx = nx; C.ny = ny; C.nz = nz; }
  else {
    const u = s.u;
    C.nx = nx * u[0]! + ny * u[3]! + nz * u[6]!;
    C.ny = nx * u[1]! + ny * u[4]! + nz * u[7]!;
    C.nz = nx * u[2]! + ny * u[5]! + nz * u[8]!;
  }
}

function closestMesh(s: Shape, px: number, py: number, pz: number): void {
  const m = s.mesh!;
  C.dist = Infinity;
  C.nx = 0; C.ny = 1; C.nz = 0;
  if (m.nodes === 0) return;
  let best = Infinity;
  let bx = 0, by = 1, bz = 0;
  let sp = 0;
  stack[sp++] = 0;
  const bb = m.bb;
  while (sp > 0) {
    const node = stack[--sp]!;
    const o = node * 6;
    const ex = px < bb[o]! ? bb[o]! - px : px > bb[o + 3]! ? px - bb[o + 3]! : 0;
    const ey = py < bb[o + 1]! ? bb[o + 1]! - py : py > bb[o + 4]! ? py - bb[o + 4]! : 0;
    const ez = pz < bb[o + 2]! ? bb[o + 2]! - pz : pz > bb[o + 5]! ? pz - bb[o + 5]! : 0;
    if (ex * ex + ey * ey + ez * ez >= best) continue;
    const l = m.left[node]!;
    if (l < 0) {
      const f = m.first[node]!;
      const e = f + m.count[node]!;
      for (let i = f; i < e; i++) {
        if (m.n[i * 3] === 0 && m.n[i * 3 + 1] === 0 && m.n[i * 3 + 2] === 0) continue;
        const d2 = closestTri(px, py, pz, m.v, i * 9);
        if (d2 < best) {
          best = d2;
          const d = Math.sqrt(d2);
          if (d > 1e-12) { bx = (px - CP.x) / d; by = (py - CP.y) / d; bz = (pz - CP.z) / d; }
          else {
            const side = (px - m.v[i * 9]!) * m.n[i * 3]! + (py - m.v[i * 9 + 1]!) * m.n[i * 3 + 1]! + (pz - m.v[i * 9 + 2]!) * m.n[i * 3 + 2]! >= 0 ? 1 : -1;
            bx = m.n[i * 3]! * side; by = m.n[i * 3 + 1]! * side; bz = m.n[i * 3 + 2]! * side;
          }
        }
      }
    } else {
      stack[sp++] = m.right[node]!;
      stack[sp++] = l;
    }
  }
  C.dist = Math.sqrt(best);
  C.nx = bx; C.ny = by; C.nz = bz;
}

function closestHeightfield(s: Shape, px: number, py: number, pz: number): void {
  const hf = s.hf!;
  const h = hf.heightAt(px, pz);
  if (h !== h) { C.dist = Infinity; C.nx = 0; C.ny = 1; C.nz = 0; return; }
  // Normal of the triangle under the point, from the same split heightAt uses.
  const fx = (px - hf.x0) / hf.cell, fz = (pz - hf.z0) / hf.cell;
  let i = Math.floor(fx), j = Math.floor(fz);
  if (i >= hf.columns - 1) i = hf.columns - 2;
  if (j >= hf.rows - 1) j = hf.rows - 2;
  const c = hf.columns;
  const h00 = hf.h[j * c + i]!, h10 = hf.h[j * c + i + 1]!, h01 = hf.h[(j + 1) * c + i]!, h11 = hf.h[(j + 1) * c + i + 1]!;
  const lower = (fx - i) + (fz - j) <= 1;
  // Slope along x and z within the triangle, per metre.
  const sx = (lower ? h10 - h00 : h11 - h01) * hf.scale / hf.cell;
  const sz = (lower ? h01 - h00 : h11 - h10) * hf.scale / hf.cell;
  const l = Math.sqrt(sx * sx + 1 + sz * sz);
  C.nx = -sx / l; C.ny = 1 / l; C.nz = -sz / l;
  C.dist = (py - h) * C.ny;
}

/** Signed distance from p to the shape (negative inside) and the unit direction away from it, in `C`. */
export function closestOn(s: Shape, px: number, py: number, pz: number): number {
  switch (s.kind) {
    case K.sphere: {
      const x = px - s.cx, y = py - s.cy, z = pz - s.cz;
      const l = Math.sqrt(x * x + y * y + z * z);
      C.dist = l - s.r;
      if (l > 1e-12) { C.nx = x / l; C.ny = y / l; C.nz = z / l; } else { C.nx = 0; C.ny = 1; C.nz = 0; }
      break;
    }
    case K.capsule: {
      const abx = s.bx - s.ax, aby = s.by - s.ay, abz = s.bz - s.az;
      const l2 = abx * abx + aby * aby + abz * abz;
      let u = l2 > 1e-18 ? ((px - s.ax) * abx + (py - s.ay) * aby + (pz - s.az) * abz) / l2 : 0;
      if (u < 0) u = 0; else if (u > 1) u = 1;
      const x = px - (s.ax + abx * u), y = py - (s.ay + aby * u), z = pz - (s.az + abz * u);
      const l = Math.sqrt(x * x + y * y + z * z);
      C.dist = l - s.r;
      if (l > 1e-12) { C.nx = x / l; C.ny = y / l; C.nz = z / l; } else { C.nx = 0; C.ny = 1; C.nz = 0; }
      break;
    }
    case K.box: boxLocal(s, px, py, pz); break;
    case K.mesh: closestMesh(s, px, py, pz); break;
    case K.plane: C.dist = py - s.planeY; C.nx = 0; C.ny = 1; C.nz = 0; break;
    case K.heightfield: closestHeightfield(s, px, py, pz); break;
  }
  return C.dist;
}
