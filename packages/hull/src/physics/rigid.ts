// Basic rigid bodies for debris and severed limbs: spheres and boxes that fall, tumble, bounce and settle.
// Kept small on purpose. A body is a set of contact points (a sphere's centre with its radius, a box's eight
// corners); each step the points are tested against every other shape, and sequential impulses fix the
// velocities. Order of everything is fixed (bodies in the order added, shapes in grid order), and nothing reads
// the clock or a random number, so the same inputs give the same states bit for bit.
//
// Not built for: stacks taller than a few boxes, thin shapes at high speed, box-on-box edge contact (only corners
// are tested), rolling cylinders, joints.
import { B, beginSweep, C, closestOn } from './narrow.ts';
import type { Shape } from './shape.ts';
import { K } from './shape.ts';
import type { Node } from '../core/index.ts';
import type { Physics } from './world.ts';
import type { QueryFilter } from './types.ts';

const CONTACT_SKIN = 0.004;
const SLOP = 0.003;
const MAX_ANGULAR = 60;

export interface BodyOptions {
  mass?: number;
  restitution?: number;
  friction?: number;
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
  /** Extra damping while resting on something, per second. Without it, spheres roll for ever. Default 1.5. */
  rollingResistance?: number;
  node?: Node | null;
}

export class RigidBody {
  readonly shape: Shape;
  node: Node | null;
  mass: number;
  invMass: number;
  restitution: number;
  friction: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  rollingResistance: number;
  // Inverse inertia about the local axes.
  readonly iix: number; readonly iiy: number; readonly iiz: number;
  px = 0; py = 0; pz = 0;
  qx = 0; qy = 0; qz = 0; qw = 1;
  vx = 0; vy = 0; vz = 0;
  wx = 0; wy = 0; wz = 0;
  sleeping = false;
  sleepTime = 0;
  touching = false;
  /** Contact points in the body's frame, 3 numbers each, and their radius. */
  readonly pts: Float64Array;
  readonly ptR: number;
  /** Radius of a sphere that fits inside, for deciding when to sweep. */
  readonly inner: number;
  /** Radius of the sphere around the whole body, for the sleep test. */
  readonly outer: number;
  /** World inverse inertia, row-major, refreshed each step. */
  readonly iw = new Float64Array(9);
  _index = 0;

  constructor(shape: Shape, o: BodyOptions) {
    this.shape = shape;
    this.node = o.node ?? shape.node;
    this.mass = o.mass ?? 1;
    if (!(this.mass > 0)) throw new Error(`physics: body mass must be positive, got ${this.mass}`);
    this.invMass = 1 / this.mass;
    this.restitution = o.restitution ?? 0.3;
    this.friction = o.friction ?? 0.5;
    this.linearDamping = o.linearDamping ?? 0.01;
    this.angularDamping = o.angularDamping ?? 0.05;
    this.gravityScale = o.gravityScale ?? 1;
    this.rollingResistance = o.rollingResistance ?? 1.5;
    if (shape.kind === K.sphere) {
      const r = shape.r;
      const i = 0.4 * this.mass * r * r;
      this.iix = this.iiy = this.iiz = 1 / i;
      this.pts = new Float64Array([0, 0, 0]);
      this.ptR = r;
      this.inner = r;
      this.outer = r;
    } else if (shape.kind === K.box) {
      const hx = shape.hx, hy = shape.hy, hz = shape.hz;
      const m = this.mass / 3;
      this.iix = 1 / (m * (hy * hy + hz * hz));
      this.iiy = 1 / (m * (hx * hx + hz * hz));
      this.iiz = 1 / (m * (hx * hx + hy * hy));
      const p = new Float64Array(24);
      let n = 0;
      for (let sx = -1; sx <= 1; sx += 2) for (let sy = -1; sy <= 1; sy += 2) for (let sz = -1; sz <= 1; sz += 2) {
        p[n++] = sx * hx; p[n++] = sy * hy; p[n++] = sz * hz;
      }
      this.pts = p;
      this.ptR = 0;
      this.inner = Math.min(hx, hy, hz);
      this.outer = Math.sqrt(hx * hx + hy * hy + hz * hz);
    } else {
      throw new Error('physics: a rigid body must be a sphere or a box');
    }
  }

  setPose(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void {
    this.px = x; this.py = y; this.pz = z;
    this.qx = qx; this.qy = qy; this.qz = qz; this.qw = qw;
    this.shape.setPose(x, y, z, qx, qy, qz, qw);
  }

  applyImpulse(x: number, y: number, z: number): void {
    this.vx += x * this.invMass; this.vy += y * this.invMass; this.vz += z * this.invMass;
    this.wake();
  }

  wake(): void {
    this.sleeping = false;
    this.sleepTime = 0;
  }
}

class Con {
  a!: RigidBody;
  b: RigidBody | null = null;
  nx = 0; ny = 0; nz = 0;
  px = 0; py = 0; pz = 0;
  depth = 0;
  rax = 0; ray = 0; raz = 0;
  rbx = 0; rby = 0; rbz = 0;
  mu = 0;
  e = 0;
  target = 0;
  jn = 0;
  jt1 = 0;
  jt2 = 0;
}

const filter: { ignoreShape?: Shape | null } = {};

export class RigidSolver {
  readonly bodies: RigidBody[] = [];
  private readonly cons: Con[] = [];
  private nc = 0;

  constructor(private readonly phys: Physics) {}

  add(b: RigidBody): void {
    b._index = this.bodies.length;
    b.shape._rb = b;
    this.bodies.push(b);
  }

  remove(b: RigidBody): void {
    const i = this.bodies.indexOf(b);
    if (i >= 0) this.bodies.splice(i, 1);
    b.shape._rb = null;
    for (let k = 0; k < this.bodies.length; k++) this.bodies[k]!._index = k;
  }

  state(): number[][] {
    return this.bodies.map((b) => [b.px, b.py, b.pz, b.qx, b.qy, b.qz, b.qw, b.vx, b.vy, b.vz, b.wx, b.wy, b.wz, b.sleeping ? 1 : 0]);
  }

  private con(): Con {
    let c = this.cons[this.nc];
    if (c === undefined) { c = new Con(); this.cons[this.nc] = c; }
    this.nc++;
    return c;
  }

  step(dt: number): void {
    const bodies = this.bodies;
    const n = bodies.length;
    if (n === 0) return;
    const g = this.phys.gravity;

    // 1. Velocities, then positions, with a sweep of each contact point so a fast body cannot pass through a wall.
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!;
      if (b.sleeping) continue;
      const gs = b.gravityScale * dt;
      b.vx += g.x * gs; b.vy += g.y * gs; b.vz += g.z * gs;
      // Resting on something drains energy faster (rolling resistance), so spheres on a floor come to rest.
      const rest = b.touching ? b.rollingResistance : 0;
      const ld = 1 / (1 + (b.linearDamping + rest * 0.1) * dt);
      const ad = 1 / (1 + (b.angularDamping + rest) * dt);
      b.vx *= ld; b.vy *= ld; b.vz *= ld;
      b.wx *= ad; b.wy *= ad; b.wz *= ad;
      this.advance(b, dt);
    }

    // 2. Contacts at the new poses.
    this.nc = 0;
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!;
      b.touching = false;
      if (b.sleeping) continue;
      this.collect(b);
    }
    const nc = this.nc;

    // 3. Impulses.
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!;
      if (!b.sleeping) inertia(b);
    }
    for (let k = 0; k < nc; k++) this.prepare(this.cons[k]!);
    const iters = this.phys.iterations;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < nc; k++) this.solve(this.cons[k]!);
    }

    // 4. Push the bodies apart where they still overlap.
    for (let k = 0; k < nc; k++) {
      const c = this.cons[k]!;
      const over = c.depth - SLOP;
      if (over <= 0) continue;
      const ima = c.a.sleeping ? 0 : c.a.invMass;
      const imb = c.b === null || c.b.sleeping ? 0 : c.b.invMass;
      const tot = ima + imb;
      if (tot === 0) continue;
      const corr = Math.min(over, 0.2) * 0.8 / tot;
      c.a.px += c.nx * corr * ima; c.a.py += c.ny * corr * ima; c.a.pz += c.nz * corr * ima;
      if (c.b !== null && imb > 0) { c.b.px -= c.nx * corr * imb; c.b.py -= c.ny * corr * imb; c.b.pz -= c.nz * corr * imb; }
    }

    // 5. Sleep, and write poses out.
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!;
      if (!b.sleeping) {
        const lin = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
        const ang = (b.wx * b.wx + b.wy * b.wy + b.wz * b.wz) * b.outer * b.outer;
        if (b.touching && lin + ang < 0.05 * 0.05) {
          b.sleepTime += dt;
          if (b.sleepTime > 0.5) {
            b.sleeping = true;
            b.vx = b.vy = b.vz = 0;
            b.wx = b.wy = b.wz = 0;
          }
        } else b.sleepTime = 0;
        b.shape.setPose(b.px, b.py, b.pz, b.qx, b.qy, b.qz, b.qw);
      }
      const node = b.node;
      if (node !== null && !b.sleeping) {
        node.position.set(b.px, b.py, b.pz);
        node.object3d.quaternion.set(b.qx, b.qy, b.qz, b.qw);
      }
    }
  }

  private advance(b: RigidBody, dt: number): void {
    let mx = b.vx * dt, my = b.vy * dt, mz = b.vz * dt;
    const dist = Math.sqrt(mx * mx + my * my + mz * mz);
    if (dist > b.inner * 0.25) {
      const dx = mx / dist, dy = my / dist, dz = mz / dist;
      filter.ignoreShape = b.shape;
      let best = dist;
      const p = b.pts;
      // World position of each point is the body position plus its rotated local offset.
      for (let k = 0; k < p.length; k += 3) {
        rot(b, p[k]!, p[k + 1]!, p[k + 2]!);
        beginSweep(best);
        this.phys.cast(b.px + RX, b.py + RY, b.pz + RZ, dx, dy, dz, b.ptR, filter as QueryFilter);
        if (B.shape !== null && B.t < best && !B.inside) best = Math.max(0, B.t - 0.002);
      }
      if (best < dist) { const s = best / dist; mx *= s; my *= s; mz *= s; }
    }
    b.px += mx; b.py += my; b.pz += mz;
    let wl = Math.sqrt(b.wx * b.wx + b.wy * b.wy + b.wz * b.wz);
    if (wl > MAX_ANGULAR) { const s = MAX_ANGULAR / wl; b.wx *= s; b.wy *= s; b.wz *= s; wl = MAX_ANGULAR; }
    // q += 0.5 * dt * (w, 0) * q, then renormalise.
    const hx = 0.5 * dt * b.wx, hy = 0.5 * dt * b.wy, hz = 0.5 * dt * b.wz;
    const qx = b.qx, qy = b.qy, qz = b.qz, qw = b.qw;
    let nx = qx + hx * qw + hy * qz - hz * qy;
    let ny = qy + hy * qw + hz * qx - hx * qz;
    let nz = qz + hz * qw + hx * qy - hy * qx;
    let nw = qw - hx * qx - hy * qy - hz * qz;
    const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    nx *= l; ny *= l; nz *= l; nw *= l;
    b.qx = nx; b.qy = ny; b.qz = nz; b.qw = nw;
    b.shape.setPose(b.px, b.py, b.pz, nx, ny, nz, nw);
  }

  private collect(b: RigidBody): void {
    const phys = this.phys;
    const p = b.pts;
    const reach = b.ptR + CONTACT_SKIN;
    for (let k = 0; k < p.length; k += 3) {
      rot(b, p[k]!, p[k + 1]!, p[k + 2]!);
      const wx = b.px + RX, wy = b.py + RY, wz = b.pz + RZ;
      const cand = phys.gather(wx - reach, wy - reach, wz - reach, wx + reach, wy + reach, wz + reach, undefined);
      for (let i = 0; i < cand.length; i++) {
        const s = cand[i]!;
        if (s === b.shape) continue;
        if ((b.shape.mask & s.layer) === 0 || (s.mask & b.shape.layer) === 0) continue;
        const d = closestOn(s, wx, wy, wz);
        if (d >= reach) continue;
        const other = s._rb as RigidBody | null;
        const c = this.con();
        c.a = b;
        c.b = other;
        c.nx = C.nx; c.ny = C.ny; c.nz = C.nz;
        c.depth = b.ptR - d;
        c.px = wx - C.nx * d; c.py = wy - C.ny * d; c.pz = wz - C.nz * d;
        c.rax = c.px - b.px; c.ray = c.py - b.py; c.raz = c.pz - b.pz;
        if (other !== null) {
          c.rbx = c.px - other.px; c.rby = c.py - other.py; c.rbz = c.pz - other.pz;
          if (other.sleeping) other.wake();
          c.mu = Math.sqrt(b.friction * other.friction);
          c.e = Math.max(b.restitution, other.restitution);
        } else {
          c.mu = b.friction;
          c.e = b.restitution;
        }
        b.touching = true;
      }
    }
  }

  private prepare(c: Con): void {
    c.jn = 0; c.jt1 = 0; c.jt2 = 0;
    const vn = relNormal(c);
    c.target = vn < -1 ? -c.e * vn : 0;
  }

  private solve(c: Con): void {
    const a = c.a, b = c.b;
    // Relative velocity of the contact point.
    let rvx = a.vx + a.wy * c.raz - a.wz * c.ray;
    let rvy = a.vy + a.wz * c.rax - a.wx * c.raz;
    let rvz = a.vz + a.wx * c.ray - a.wy * c.rax;
    if (b !== null) {
      rvx -= b.vx + b.wy * c.rbz - b.wz * c.rby;
      rvy -= b.vy + b.wz * c.rbx - b.wx * c.rbz;
      rvz -= b.vz + b.wx * c.rby - b.wy * c.rbx;
    }
    const vn = rvx * c.nx + rvy * c.ny + rvz * c.nz;
    const kn = effMass(c, c.nx, c.ny, c.nz);
    if (kn > 0) {
      let j = (c.target - vn) / kn;
      const old = c.jn;
      c.jn = Math.max(0, old + j);
      j = c.jn - old;
      apply(c, c.nx * j, c.ny * j, c.nz * j);
    }
    // Friction along the sliding direction at the start of this pass.
    rvx = a.vx + a.wy * c.raz - a.wz * c.ray;
    rvy = a.vy + a.wz * c.rax - a.wx * c.raz;
    rvz = a.vz + a.wx * c.ray - a.wy * c.rax;
    if (b !== null) {
      rvx -= b.vx + b.wy * c.rbz - b.wz * c.rby;
      rvy -= b.vy + b.wz * c.rbx - b.wx * c.rbz;
      rvz -= b.vz + b.wx * c.rby - b.wy * c.rbx;
    }
    const vn2 = rvx * c.nx + rvy * c.ny + rvz * c.nz;
    const tx = rvx - c.nx * vn2, ty = rvy - c.ny * vn2, tz = rvz - c.nz * vn2;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl > 1e-9) {
      const ux = tx / tl, uy = ty / tl, uz = tz / tl;
      const kt = effMass(c, ux, uy, uz);
      if (kt > 0) {
        let j = -tl / kt;
        const lim = c.mu * c.jn;
        const old = c.jt1;
        c.jt1 = Math.max(-lim, Math.min(lim, old + j));
        j = c.jt1 - old;
        apply(c, ux * j, uy * j, uz * j);
      }
    }
  }
}

// ---- helpers ----

let RX = 0, RY = 0, RZ = 0;

/** Rotates a body-frame vector into the world by the body's orientation, into RX, RY, RZ. */
function rot(b: RigidBody, x: number, y: number, z: number): void {
  const qx = b.qx, qy = b.qy, qz = b.qz, qw = b.qw;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  RX = x + qw * tx + (qy * tz - qz * ty);
  RY = y + qw * ty + (qz * tx - qx * tz);
  RZ = z + qw * tz + (qx * ty - qy * tx);
}

/** World inverse inertia: R diag(i) R^T. */
function inertia(b: RigidBody): void {
  const x = b.qx, y = b.qy, z = b.qz, w = b.qw;
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - z * w), r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - x * w);
  const r20 = 2 * (x * z - y * w), r21 = 2 * (y * z + x * w), r22 = 1 - 2 * (x * x + y * y);
  const a = b.iix, c = b.iiy, d = b.iiz;
  const m = b.iw;
  m[0] = r00 * r00 * a + r01 * r01 * c + r02 * r02 * d;
  m[1] = r00 * r10 * a + r01 * r11 * c + r02 * r12 * d;
  m[2] = r00 * r20 * a + r01 * r21 * c + r02 * r22 * d;
  m[3] = m[1]!;
  m[4] = r10 * r10 * a + r11 * r11 * c + r12 * r12 * d;
  m[5] = r10 * r20 * a + r11 * r21 * c + r12 * r22 * d;
  m[6] = m[2]!;
  m[7] = m[5]!;
  m[8] = r20 * r20 * a + r21 * r21 * c + r22 * r22 * d;
}

function relNormal(c: Con): number {
  const a = c.a, b = c.b;
  let rvx = a.vx + a.wy * c.raz - a.wz * c.ray;
  let rvy = a.vy + a.wz * c.rax - a.wx * c.raz;
  let rvz = a.vz + a.wx * c.ray - a.wy * c.rax;
  if (b !== null) {
    rvx -= b.vx + b.wy * c.rbz - b.wz * c.rby;
    rvy -= b.vy + b.wz * c.rbx - b.wx * c.rbz;
    rvz -= b.vz + b.wx * c.rby - b.wy * c.rbx;
  }
  return rvx * c.nx + rvy * c.ny + rvz * c.nz;
}

/** Inverse of the effective mass along unit direction u at the contact. */
function effMass(c: Con, ux: number, uy: number, uz: number): number {
  const a = c.a;
  let k = a.sleeping ? 0 : a.invMass;
  if (!a.sleeping) k += inertiaTerm(a, c.rax, c.ray, c.raz, ux, uy, uz);
  const b = c.b;
  if (b !== null && !b.sleeping) {
    k += b.invMass + inertiaTerm(b, c.rbx, c.rby, c.rbz, ux, uy, uz);
  }
  return k;
}

function inertiaTerm(b: RigidBody, rx: number, ry: number, rz: number, ux: number, uy: number, uz: number): number {
  // (I^-1 (r x u)) x r . u
  const cx = ry * uz - rz * uy, cy = rz * ux - rx * uz, cz = rx * uy - ry * ux;
  const m = b.iw;
  const ix = m[0]! * cx + m[1]! * cy + m[2]! * cz;
  const iy = m[3]! * cx + m[4]! * cy + m[5]! * cz;
  const iz = m[6]! * cx + m[7]! * cy + m[8]! * cz;
  const ex = iy * rz - iz * ry, ey = iz * rx - ix * rz, ez = ix * ry - iy * rx;
  return ex * ux + ey * uy + ez * uz;
}

/** Applies impulse (jx, jy, jz) at the contact: to a, and the opposite to b. */
function apply(c: Con, jx: number, jy: number, jz: number): void {
  const a = c.a;
  a.vx += jx * a.invMass; a.vy += jy * a.invMass; a.vz += jz * a.invMass;
  angular(a, c.rax, c.ray, c.raz, jx, jy, jz, 1);
  const b = c.b;
  if (b !== null && !b.sleeping) {
    b.vx -= jx * b.invMass; b.vy -= jy * b.invMass; b.vz -= jz * b.invMass;
    angular(b, c.rbx, c.rby, c.rbz, jx, jy, jz, -1);
  }
}

function angular(b: RigidBody, rx: number, ry: number, rz: number, jx: number, jy: number, jz: number, sign: number): void {
  const cx = (ry * jz - rz * jy) * sign, cy = (rz * jx - rx * jz) * sign, cz = (rx * jy - ry * jx) * sign;
  const m = b.iw;
  b.wx += m[0]! * cx + m[1]! * cy + m[2]! * cz;
  b.wy += m[3]! * cx + m[4]! * cy + m[5]! * cz;
  b.wz += m[6]! * cx + m[7]! * cy + m[8]! * cz;
}
