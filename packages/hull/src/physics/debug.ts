// Debug drawing of colliders as line segments. `line` is any sink, for example `debug.line` from hull/render, so
// this file needs no renderer and runs in Node.
import type { Shape } from './shape.ts';
import { K } from './shape.ts';
import type { Physics } from './world.ts';

type P = { x: number; y: number; z: number };
type Line = (a: P, b: P, color: number) => void;

const a: P = { x: 0, y: 0, z: 0 };
const b: P = { x: 0, y: 0, z: 0 };
const SEG = 16;

function seg(line: Line, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number): void {
  a.x = x0; a.y = y0; a.z = z0; b.x = x1; b.y = y1; b.z = z1;
  line(a, b, c);
}

/** A circle of radius r at (cx, cy, cz) in the plane spanned by unit vectors u and v. */
function ring(line: Line, cx: number, cy: number, cz: number, r: number, ux: number, uy: number, uz: number, vx: number, vy: number, vz: number, c: number): void {
  for (let i = 0; i < SEG; i++) {
    const t0 = (i / SEG) * Math.PI * 2, t1 = ((i + 1) / SEG) * Math.PI * 2;
    const c0 = Math.cos(t0) * r, s0 = Math.sin(t0) * r, c1 = Math.cos(t1) * r, s1 = Math.sin(t1) * r;
    seg(line, cx + ux * c0 + vx * s0, cy + uy * c0 + vy * s0, cz + uz * c0 + vz * s0,
      cx + ux * c1 + vx * s1, cy + uy * c1 + vy * s1, cz + uz * c1 + vz * s1, c);
  }
}

let kx = 0, ky = 0, kz = 0;
function corner(s: Shape, i: number): void {
  const u = s.u;
  const x = (i & 1 ? 1 : -1) * s.hx, y = (i & 2 ? 1 : -1) * s.hy, z = (i & 4 ? 1 : -1) * s.hz;
  kx = s.cx + x * u[0]! + y * u[3]! + z * u[6]!;
  ky = s.cy + x * u[1]! + y * u[4]! + z * u[7]!;
  kz = s.cz + x * u[2]! + y * u[5]! + z * u[8]!;
}

function drawShape(line: Line, s: Shape, c: number, center: P): void {
  switch (s.kind) {
    case K.sphere:
      ring(line, s.cx, s.cy, s.cz, s.r, 1, 0, 0, 0, 1, 0, c);
      ring(line, s.cx, s.cy, s.cz, s.r, 1, 0, 0, 0, 0, 1, c);
      ring(line, s.cx, s.cy, s.cz, s.r, 0, 1, 0, 0, 0, 1, c);
      break;
    case K.capsule: {
      ring(line, s.ax, s.ay, s.az, s.r, 1, 0, 0, 0, 0, 1, c);
      ring(line, s.bx, s.by, s.bz, s.r, 1, 0, 0, 0, 0, 1, c);
      ring(line, s.ax, s.ay, s.az, s.r, 1, 0, 0, 0, 1, 0, c);
      ring(line, s.bx, s.by, s.bz, s.r, 1, 0, 0, 0, 1, 0, c);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        seg(line, s.ax + dx * s.r, s.ay, s.az + dz * s.r, s.bx + dx * s.r, s.by, s.bz + dz * s.r, c);
      }
      break;
    }
    case K.box:
      for (let i = 0; i < 8; i++) {
        for (let k = 0; k < 3; k++) {
          if (i & (1 << k)) continue;
          corner(s, i);
          const ax = kx, ay = ky, az = kz;
          corner(s, i | (1 << k));
          seg(line, ax, ay, az, kx, ky, kz, c);
        }
      }
      break;
    case K.plane: {
      const n = 10, step = 2;
      const gx = Math.round(center.x / step) * step, gz = Math.round(center.z / step) * step;
      for (let i = -n; i <= n; i++) {
        seg(line, gx + i * step, s.planeY, gz - n * step, gx + i * step, s.planeY, gz + n * step, c);
        seg(line, gx - n * step, s.planeY, gz + i * step, gx + n * step, s.planeY, gz + i * step, c);
      }
      break;
    }
    default: {
      // Mesh and heightfield: their bounds.
      for (const y of [s.miny, s.maxy]) {
        seg(line, s.minx, y, s.minz, s.maxx, y, s.minz, c); seg(line, s.maxx, y, s.minz, s.maxx, y, s.maxz, c);
        seg(line, s.maxx, y, s.maxz, s.minx, y, s.maxz, c); seg(line, s.minx, y, s.maxz, s.minx, y, s.minz, c);
      }
    }
  }
}

/**
 * Draws every collider within `radius` of `center` through `line`. Static shapes are grey, moving ones orange,
 * triggers purple, tagged ones green. Call it each frame from a render-side `update`.
 */
export function debugShapes(phys: Physics, line: Line, center: P, radius = 60): void {
  phys.sync();
  phys.eachShape((s) => {
    if (!s.enabled) return;
    if (s.kind !== K.plane && (s.minx > center.x + radius || s.maxx < center.x - radius || s.minz > center.z + radius || s.maxz < center.z - radius)) return;
    const col = s.trigger ? 0xb07cff : s.tag !== '' ? 0x4ade80 : s.isStatic ? 0x8a93a6 : 0xf0a43a;
    drawShape(line, s, col, center);
  });
}
