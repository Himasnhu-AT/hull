// The particle maths, with no three.js: a config value is compiled to plain numbers, spawning draws from a seeded
// random stream, and the pool is a set of flat typed arrays that never grow. Node tests run all of this.
import type { Random } from '../core/types.ts';
import type { Vfx } from '../schema/vfx.ts';
import { buildLut, lutAt } from './curves.ts';

export type Sprite = 'soft' | 'smoke' | 'hard' | 'spark';
export type Blend = 'alpha' | 'additive';
export interface V3 { x: number; y: number; z: number }

export interface Compiled {
  countMin: number;
  countMax: number;
  over: number;
  rate: number;
  shape: { kind: 'point' | 'sphere' | 'disc' | 'box'; r: number; bx: number; by: number; bz: number };
  lifeMin: number;
  lifeMax: number;
  speedMin: number;
  speedMax: number;
  /** Cone axis (unit) and half-angle; `outward` ignores both. */
  cone: { x: number; y: number; z: number; cosAngle: number; outward: boolean };
  gravity: number;
  drag: number;
  sizeMin: number;
  sizeMax: number;
  glow: number;
  spinMin: number;
  spinMax: number;
  stretch: number;
  sprite: Sprite;
  blend: Blend;
  max: number;
  fadeNear: number;
  lut: Float32Array;
}

const RAD = Math.PI / 180;

/** Fills every default and builds the lookup table. */
export function compile(v: Vfx): Compiled {
  const p = v.particle;
  const e = v.emit;
  const dir = p.direction;
  let ax = 0, ay = 1, az = 0, cosAngle = Math.cos(180 * RAD), outward = false;
  if (dir === undefined) {
    // No direction given: any way at all.
  } else if ('outward' in dir) {
    outward = true;
  } else {
    const len = Math.hypot(dir.cone[0], dir.cone[1], dir.cone[2]);
    if (len > 0) { ax = dir.cone[0] / len; ay = dir.cone[1] / len; az = dir.cone[2] / len; }
    cosAngle = Math.cos(dir.angleDeg * RAD);
  }
  const s = e.shape ?? 'point';
  const shape: Compiled['shape'] = { kind: 'point', r: 0, bx: 0, by: 0, bz: 0 };
  if (s !== 'point') {
    if ('sphere' in s) { shape.kind = 'sphere'; shape.r = s.sphere; }
    else if ('disc' in s) { shape.kind = 'disc'; shape.r = s.disc; }
    else { shape.kind = 'box'; shape.bx = s.box[0]; shape.by = s.box[1]; shape.bz = s.box[2]; }
  }
  const count = e.count ?? [10, 10];
  const life = p.life;
  const speed = p.speed ?? [1, 2];
  const scale = p.sizeScale ?? [1, 1];
  const spin = p.spin ?? [0, 0];
  return {
    countMin: Math.min(count[0], count[1]),
    countMax: Math.max(count[0], count[1]),
    over: e.over ?? 0,
    rate: e.rate ?? 0,
    shape,
    lifeMin: Math.max(0.001, Math.min(life[0], life[1])),
    lifeMax: Math.max(0.001, Math.max(life[0], life[1])),
    speedMin: Math.min(speed[0], speed[1]),
    speedMax: Math.max(speed[0], speed[1]),
    cone: { x: ax, y: ay, z: az, cosAngle, outward },
    gravity: p.gravity ?? 0,
    drag: p.drag ?? 0,
    sizeMin: Math.min(scale[0], scale[1]),
    sizeMax: Math.max(scale[0], scale[1]),
    glow: p.glow ?? 1,
    spinMin: Math.min(spin[0], spin[1]),
    spinMax: Math.max(spin[0], spin[1]),
    stretch: p.stretch ?? 0,
    sprite: p.sprite ?? 'soft',
    blend: p.blend ?? 'alpha',
    max: v.budget?.max ?? 400,
    fadeNear: v.budget?.fadeNear ?? 0,
    lut: buildLut(p.size ?? [[0, 0.2]], p.color ?? [[0, '#ffffff']], p.alpha ?? [[0, 1]]),
  };
}

/** Flat storage for one effect's live particles. Dead ones are replaced by the last live one, so 0..count is dense. */
export class Pool {
  readonly capacity: number;
  count = 0;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  /** Per-particle multiplier of the size curve. */
  readonly scale: Float32Array;
  readonly rot: Float32Array;
  readonly spin: Float32Array;
  /** Total spawned, and total refused because the pool was full. */
  spawned = 0;
  dropped = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.scale = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
  }

  clear(): void {
    this.count = 0;
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.px[i] = this.px[last]!; this.py[i] = this.py[last]!; this.pz[i] = this.pz[last]!;
    this.vx[i] = this.vx[last]!; this.vy[i] = this.vy[last]!; this.vz[i] = this.vz[last]!;
    this.age[i] = this.age[last]!; this.life[i] = this.life[last]!; this.scale[i] = this.scale[last]!;
    this.rot[i] = this.rot[last]!; this.spin[i] = this.spin[last]!;
  }

  /** Moves every particle forward `dt` seconds: drag, gravity, position, age. Particles past their life leave. */
  step(c: Compiled, dt: number): void {
    // Drag as an exponential, so the result does not depend on the step length.
    const keep = Math.exp(-c.drag * dt);
    const g = c.gravity * dt;
    for (let i = 0; i < this.count; ) {
      const a = this.age[i]! + dt;
      if (a >= this.life[i]!) { this.remove(i); continue; }
      this.age[i] = a;
      const vx = this.vx[i]! * keep;
      const vy = this.vy[i]! * keep + g;
      const vz = this.vz[i]! * keep;
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      this.px[i] = this.px[i]! + vx * dt;
      this.py[i] = this.py[i]! + vy * dt;
      this.pz[i] = this.pz[i]! + vz * dt;
      this.rot[i] = this.rot[i]! + this.spin[i]! * dt;
      i++;
    }
  }
}

/** A whole number from the effect's count range, drawn from the stream (always one draw, so streams stay in step). */
export function drawCount(c: Compiled, rng: Random): number {
  return rng.int(c.countMin, c.countMax);
}

/**
 * Starts one particle. `(ox, oy, oz)` is the emitter centre; `dir` (unit, optional) aims the cone and replaces the
 * config's axis. Returns false, and counts it as dropped, when the pool is full. Always draws the same number of
 * random values, full or not, so a full pool does not shift the stream.
 */
export function spawnOne(pool: Pool, c: Compiled, rng: Random, ox: number, oy: number, oz: number, dir: V3 | undefined): boolean {
  // Shape offset.
  let dx = 0, dy = 0, dz = 0;
  const sh = c.shape;
  const r0 = rng.next(), r1 = rng.next(), r2 = rng.next();
  if (sh.kind === 'sphere') {
    const z = r0 * 2 - 1;
    const phi = r1 * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    const rad = sh.r * Math.cbrt(r2);
    dx = Math.cos(phi) * s * rad; dy = z * rad; dz = Math.sin(phi) * s * rad;
  } else if (sh.kind === 'disc') {
    const phi = r1 * Math.PI * 2;
    const rad = sh.r * Math.sqrt(r0);
    dx = Math.cos(phi) * rad; dz = Math.sin(phi) * rad;
  } else if (sh.kind === 'box') {
    dx = (r0 - 0.5) * sh.bx; dy = (r1 - 0.5) * sh.by; dz = (r2 - 0.5) * sh.bz;
  }

  // Direction: uniform over the cone's solid angle, or outward from the centre.
  const u = rng.next(), w = rng.next();
  let nx: number, ny: number, nz: number;
  const cone = c.cone;
  if (cone.outward) {
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) { nx = dx / len; ny = dy / len; nz = dz / len; }
    else {
      const z = u * 2 - 1, s = Math.sqrt(Math.max(0, 1 - z * z)), phi = w * Math.PI * 2;
      nx = Math.cos(phi) * s; ny = z; nz = Math.sin(phi) * s;
    }
  } else {
    let ax = cone.x, ay = cone.y, az = cone.z;
    if (dir !== undefined) {
      const len = Math.hypot(dir.x, dir.y, dir.z);
      if (len > 1e-6) { ax = dir.x / len; ay = dir.y / len; az = dir.z / len; }
    }
    const cosT = 1 - u * (1 - cone.cosAngle);
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = w * Math.PI * 2;
    // Any vector not parallel to the axis gives a perpendicular pair.
    let bx: number, by: number, bz: number;
    if (Math.abs(ay) < 0.9) { bx = -az; by = 0; bz = ax; } else { bx = 0; by = az; bz = -ay; }
    const bl = Math.hypot(bx, by, bz) || 1;
    bx /= bl; by /= bl; bz /= bl;
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const cp = Math.cos(phi) * sinT, sp = Math.sin(phi) * sinT;
    nx = ax * cosT + bx * cp + cx * sp;
    ny = ay * cosT + by * cp + cy * sp;
    nz = az * cosT + bz * cp + cz * sp;
  }
  const speed = rng.range(c.speedMin, c.speedMax);
  const life = rng.range(c.lifeMin, c.lifeMax);
  const scale = rng.range(c.sizeMin, c.sizeMax);
  const rot = rng.next() * Math.PI * 2;
  const spin = rng.range(c.spinMin, c.spinMax);

  if (pool.count >= pool.capacity) { pool.dropped++; return false; }
  const i = pool.count++;
  pool.px[i] = ox + dx; pool.py[i] = oy + dy; pool.pz[i] = oz + dz;
  pool.vx[i] = nx * speed; pool.vy[i] = ny * speed; pool.vz[i] = nz * speed;
  pool.age[i] = 0; pool.life[i] = life; pool.scale[i] = scale; pool.rot[i] = rot; pool.spin[i] = spin;
  pool.spawned++;
  return true;
}

/** Size, linear colour and alpha of particle `i` now, written to `out` (size, r, g, b, alpha). */
export function look(pool: Pool, c: Compiled, i: number, out: Float32Array): void {
  const t = pool.age[i]! / pool.life[i]!;
  out[0] = lutAt(c.lut, t, 0) * pool.scale[i]!;
  out[1] = lutAt(c.lut, t, 1) * c.glow;
  out[2] = lutAt(c.lut, t, 2) * c.glow;
  out[3] = lutAt(c.lut, t, 3) * c.glow;
  out[4] = lutAt(c.lut, t, 4);
}

/** Fade for a particle `dist` metres from the camera: 0 at the camera, 1 from `fadeNear` outward. */
export function nearFade(dist: number, fadeNear: number): number {
  if (fadeNear <= 0) return 1;
  const k = dist / fadeNear;
  return k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k);
}
