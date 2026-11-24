// Adding and removing shapes on the kernel (plan-rust.md section 14): static shapes in a sparse grid that keeps the
// order TypeScript's does, mesh and height-field arrays given back, and input that is not a finite number answered
// at once, the same on both implementations. The world on the kernel is always compared with the same world on
// TypeScript.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defineGame, startGame } from '../core/index.ts';
import { Hit, Physics, usePhysics, type Shape } from './index.ts';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const v = (x: number, y: number, z: number) => ({ x, y, z });
const hitOf = (h: Hit | null): unknown => h === null ? null : [h.distance, h.x, h.y, h.z, h.nx, h.ny, h.nz, h.shape?.userData, h.tag, h.inside, h.depth];
const ids = (list: Shape[]): unknown[] => list.map((s) => s.userData);

async function make(kernels: 'on' | 'off'): Promise<Physics> {
  let phys!: Physics;
  await startGame(defineGame({ ready(g) { phys = usePhysics(g.world); } }), { seed: 1, stepRate: 60, kernels });
  return phys;
}

/** Bytes of the kernel's memory. */
const memory = (p: Physics): number => (p._kw as unknown as { k: { memory: WebAssembly.Memory } }).k.memory.buffer.byteLength;

function patch(R: () => number, n: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [], indices: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(i * 2, R() * 3, j * 2);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { positions, indices };
}

describe('static shapes coming and going on the kernel', () => {
  it('keeps every answer and its order through 4,000 additions and removals', async () => {
    const a = await make('on'), b = await make('off');
    expect(a.backend).toBe('kernel');
    const R = rng(77);
    const live: [Shape, Shape][] = [];
    const ha = new Hit(), hb = new Hit();
    let hits = 0;
    for (let n = 0; n < 4000; n++) {
      if (live.length > 40 && R() < 0.45) {
        const [x, y] = live.splice(Math.floor(R() * live.length), 1)[0]!;
        a.remove(x); b.remove(y);
      } else {
        // Mostly a crowd in a small square, so cells hold several shapes and ties are common; some far away, some
        // that share a spot exactly, some big enough to span a good many cells.
        const far = R() < 0.15;
        const p = far ? v((R() * 2 - 1) * 9000, 0, (R() * 2 - 1) * 9000) : v(Math.round((R() * 2 - 1) * 12) * 8, 0, Math.round((R() * 2 - 1) * 12) * 8);
        const s = R() < 0.1 ? 60 : 2 + R() * 14;
        const opt = { userData: n, tag: n % 3 === 0 ? 'a' : 'b', ...(n % 11 === 0 ? { trigger: true } : {}) };
        live.push([a.addBox(p, v(s, 4, s), opt), b.addBox(p, v(s, 4, s), opt)]);
      }
      if (n % 7 === 0) {
        const o = v((R() * 2 - 1) * 110, 8, (R() * 2 - 1) * 110);
        const d = v(R() - 0.5, -0.1 - R() * 0.2, R() - 0.5);
        const r = R() < 0.5 ? 0 : R() * 3;
        const x = hitOf(a.spherecast(o, d, 400, r, undefined, ha)), y = hitOf(b.spherecast(o, d, 400, r, undefined, hb));
        expect(x).toEqual(y);
        if (x !== null) hits++;
        const rad = 20 + R() * 40;
        expect(ids(a.overlapSphere(o, rad))).toEqual(ids(b.overlapSphere(o, rad)));
      }
    }
    expect(hits).toBeGreaterThan(100);
    expect(a.backend).toBe('kernel');
  }, 120_000);

  it('keeps shapes that share a cell in the order they were added, however others come and go', async () => {
    const a = await make('on');
    const mk = (i: number) => a.addBox(v(1, 0, 1), v(2, 2, 2), { userData: i });
    const s = [0, 1, 2, 3, 4].map(mk);
    a.remove(s[1]!); a.remove(s[3]!);
    s.push(mk(5));
    expect(ids(a.overlapSphere(v(1, 0, 1), 1))).toEqual([0, 2, 4, 5]);
    // The nearest of equal hits is the first added that is still there.
    expect((a.raycast(v(-5, 0, 1), v(1, 0, 0), 20)!).shape!.userData).toBe(0);
    a.remove(s[0]!);
    expect((a.raycast(v(-5, 0, 1), v(1, 0, 0), 20)!).shape!.userData).toBe(2);
  });

  it('holds a world of shapes far apart in a small module, and does not grow on churn', async () => {
    const a = await make('on'), b = await make('off');
    const R = rng(5);
    for (let i = 0; i < 200; i++) {
      const p = v((R() * 2 - 1) * 8000, 0, (R() * 2 - 1) * 8000);
      a.addBox(p, v(4, 4, 4), { userData: i }); b.addBox(p, v(4, 4, 4), { userData: i });
    }
    expect(memory(a)).toBeLessThan(2 * 1024 * 1024);
    for (let w = 0; w < 2000; w++) {
      const p = v((R() * 2 - 1) * 8000, 0, (R() * 2 - 1) * 8000);
      const s = a.addBox(p, v(4, 4, 4), { userData: 'c' });
      a.raycast(v(p.x - 10, 0, p.z), v(1, 0, 0), 20);
      a.remove(s);
      a.raycast(v(p.x - 10, 0, p.z), v(1, 0, 0), 20);
    }
    expect(memory(a)).toBeLessThan(2 * 1024 * 1024);
    expect(hitOf(a.raycast(v(-9000, 0, 0), v(1, 0, 0), 20000))).toEqual(hitOf(b.raycast(v(-9000, 0, 0), v(1, 0, 0), 20000)));
    expect(a.backend).toBe('kernel');
  }, 60_000);
});

describe('mesh and height-field data on the kernel', () => {
  it('gives the arrays of a removed mesh back, so adding and removing one all game does not grow the module', async () => {
    const a = await make('on'), b = await make('off');
    const R = rng(3);
    const m = patch(R, 12);
    expect(m.indices.length / 3).toBe(288);
    let warm = 0;
    for (let n = 0; n < 1500; n++) {
      const sa = a.addMesh(m.positions, m.indices, { userData: 'm' }), sb = b.addMesh(m.positions, m.indices, { userData: 'm' });
      const o = v(R() * 20 + 2, 10, R() * 20 + 2);
      expect(hitOf(a.raycast(o, v(0, -1, 0), 30))).toEqual(hitOf(b.raycast(o, v(0, -1, 0), 30)));
      a.remove(sa); b.remove(sb);
      if (n === 100) warm = memory(a);
    }
    expect(warm).toBeGreaterThan(0);
    expect(memory(a)).toBeLessThanOrEqual(warm * 1.1);
    expect(a.backend).toBe('kernel');
  }, 60_000);

  it('does the same for height fields, and a mesh added after others went is the mesh it should be', async () => {
    const a = await make('on'), b = await make('off');
    const R = rng(4);
    const hs: number[] = [];
    for (let k = 0; k < 40 * 40; k++) hs.push(R() * 4);
    let warm = 0;
    const kept: [Shape, Shape][] = [];
    for (let n = 0; n < 600; n++) {
      const sa = a.addHeightfield(hs, 40, 40, 2, { userData: 'h' }), sb = b.addHeightfield(hs, 40, 40, 2, { userData: 'h' });
      if (n % 100 === 0) kept.push([sa, sb]);
      else { a.remove(sa); b.remove(sb); }
      if (n === 50) warm = memory(a);
    }
    // Meshes that take the freed data slots next to height fields that stayed.
    const m = patch(R, 6);
    const ma = a.addMesh(m.positions, m.indices, { userData: 'm', position: v(500, 0, 500) }), mb = b.addMesh(m.positions, m.indices, { userData: 'm', position: v(500, 0, 500) });
    for (let k = 0; k < 50; k++) {
      const o = v(500 + R() * 12, 10, 500 + R() * 12), p = v(R() * 70, 10, R() * 70);
      expect(hitOf(a.raycast(o, v(0, -1, 0), 30))).toEqual(hitOf(b.raycast(o, v(0, -1, 0), 30)));
      expect(hitOf(a.raycast(p, v(0, -1, 0), 30))).toEqual(hitOf(b.raycast(p, v(0, -1, 0), 30)));
    }
    expect(ma.userData).toBe(mb.userData);
    // The module grows a page (64 kB) at a time and now also holds six height fields and a mesh that stayed.
    expect(memory(a)).toBeLessThanOrEqual(warm * 2);
    expect(a.backend).toBe('kernel');
  }, 60_000);
});

describe('capsules whose end points or radius are not usable numbers', () => {
  it('overlapCapsule gives no shapes when a point is NaN, on the kernel as on TypeScript', async () => {
    for (const k of ['on', 'off'] as const) {
      const p = await make(k);
      p.addBox(v(0, 0, 0), v(10, 10, 10), { userData: 'box' });
      expect(ids(p.overlapCapsule(v(-1, 0, 0), v(1, 0, 0), 1))).toEqual(['box']);
      expect(ids(p.overlapCapsule(v(NaN, 0, 0), v(1, 0, 0), 1))).toEqual([]);
      expect(ids(p.overlapCapsule(v(0, 0, 0), v(0, NaN, 0), 1))).toEqual([]);
      expect(ids(p.overlapCapsule(v(0, 0, 0), v(1, 0, 0), NaN))).toEqual([]);
      // A zero radius makes the sample count infinite, and one beyond an i32 cannot be counted: no shapes either way.
      expect(ids(p.overlapCapsule(v(0, 0, 0), v(1, 0, 0), 0))).toEqual([]);
      expect(ids(p.overlapCapsule(v(0, 0, 0), v(3e9, 0, 0), 1))).toEqual([]);
    }
  });
});

/**
 * Cases that never returned before, run in a child process so a regression fails with a timeout instead of freezing
 * the whole test run (a loop that does not end cannot be interrupted from inside the process).
 */
const PROBE = `
import { defineGame, startGame } from ${JSON.stringify(new URL('../core/index.ts', import.meta.url).href)};
import { usePhysics } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
const v = (x, y, z) => ({ x, y, z });
const ids = (l) => l.map((s) => s.userData);
const hit = (h) => h === null ? null : [h.distance, h.shape.userData];
const out = {};
for (const kernels of ['on', 'off']) {
  let p;
  await startGame(defineGame({ ready(g) { p = usePhysics(g.world); } }), { seed: 1, kernels });
  p.addBox(v(0, 0, 0), v(10, 10, 10), { userData: 'near' });
  p.addBox(v(100, 0, 0), v(10, 10, 10), { userData: 'far' });
  p.addGround(-5, { userData: 'ground' });
  const r = {};
  const dir = v(1, 0, 0);
  r.sphereInfX = hit(p.spherecast(v(Infinity, 0, 0), dir, 50, 0.5));
  r.sphereNegInfZ = hit(p.spherecast(v(0, 0, -Infinity), dir, 50, 0.5));
  r.sphereHugeX = hit(p.spherecast(v(1e300, 0, 0), dir, 50, 0.5));
  r.sphereInfRadius = hit(p.spherecast(v(-20, 0, 0), dir, 50, Infinity));
  r.capsuleInfX = hit(p.capsulecast(v(Infinity, 0, 0), v(Infinity, 1, 0), 0.5, dir, 50));
  r.capsuleZeroRadius = hit(p.capsulecast(v(-20, 0, 0), v(-20, 3, 0), 0, dir, 50));
  r.rayInfX = hit(p.raycast(v(Infinity, 0, 0), dir, 50));
  r.sphereFinite = hit(p.spherecast(v(-20, 0, 0), dir, 50, 0.5));
  r.overlapInfCentre = ids(p.overlapSphere(v(Infinity, 0, 0), 1));
  r.overlapNegInfZ = ids(p.overlapSphere(v(0, 0, -Infinity), 5));
  r.overlapHugeCentre = ids(p.overlapSphere(v(1e300, 0, 1e300), 5));
  r.overlapInfRadius = ids(p.overlapSphere(v(0, 0, 0), Infinity));
  r.overlapFinite = ids(p.overlapSphere(v(0, 0, 0), 6));
  r.capsuleOverlapInf = ids(p.overlapCapsule(v(Infinity, 0, 0), v(0, 0, 0), 1));
  r.capsuleOverlapZero = ids(p.overlapCapsule(v(0, 0, 0), v(5, 0, 0), 0));
  // Static shapes with bounds that are not numbers go to the short list instead of looping while they are filed.
  p.addBox(v(Infinity, 0, 0), v(1, 1, 1), { userData: 'inf-centre' });
  p.addBox(v(0, 0, 0), v(Infinity, 1, 1), { userData: 'inf-size' });
  p.addSphere(v(0, 0, 1e300), 1, { userData: 'huge-far' });
  p.addBox(v(NaN, 0, 0), v(1, 1, 1), { userData: 'nan' });
  r.afterAdding = hit(p.raycast(v(-20, 0, 0), dir, 50));
  r.afterAddingOverlap = ids(p.overlapSphere(v(0, 0, 0), 6)).filter((u) => u === 'near' || u === 'far' || u === 'ground');
  r.shapeCount = p.shapeCount;
  out[kernels] = r;
}
console.log(JSON.stringify(out));
`;

describe('input that is not a finite number', () => {
  it('returns at once, with no hit or no shapes, and the same on the kernel and on TypeScript', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', PROBE], { cwd: fileURLToPath(new URL('../../../..', import.meta.url)), encoding: 'utf8', timeout: 60_000 });
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split('\n').pop()!) as { on: Record<string, unknown>; off: Record<string, unknown> };
    expect(out.on).toEqual(out.off);
    const r = out.on;
    for (const k of ['sphereInfX', 'sphereNegInfZ', 'sphereHugeX', 'sphereInfRadius', 'capsuleInfX', 'capsuleZeroRadius', 'rayInfX']) expect(r[k], k).toBeNull();
    for (const k of ['overlapInfCentre', 'overlapNegInfZ', 'overlapHugeCentre', 'capsuleOverlapInf', 'capsuleOverlapZero']) expect(r[k], k).toEqual([]);
    // What is finite is answered as before.
    expect(r.sphereFinite).toEqual([14.5, 'near']);
    expect(r.overlapFinite).toEqual(['near', 'ground']);
    // A box of infinite size holds every point, so a ray starts inside it.
    expect(r.afterAdding).toEqual([0, 'inf-size']);
    expect(r.shapeCount).toBe(7);
  }, 90_000);
});
