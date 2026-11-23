// Parity for the moving-shape index (plan-rust.md R1): the grid may only change how few shapes a query looks at,
// never what it answers. Two checks, 10,000 seeded cases each, bit for bit:
//   1. the index against the plain walk over every slot, through adds, removals, moves and bounds that are not numbers;
//   2. a physics world against the same world made to walk every moving shape, as it did before the index existed.
// Each check runs once per store (TypeScript arrays, and the kernel's memory when the kernel is built in).
import { beforeAll, describe, expect, it } from 'vitest';
import { defineGame, startGame } from '../core/index.ts';
import { loadKernels, takeKernel } from '../kernel/index.ts';
import { Hit, Physics, usePhysics, type QueryFilter, type Shape } from './index.ts';
import { KernelStore } from './kernel-store.ts';
import { ArrayStore, buildGrid, GRID, MovingIndex, NI, NITEMS, NK, NOVER, type MovingStore } from './moving.ts';

beforeAll(() => loadKernels('on'));

// Ten thousand cases take a second or two alone and several times that while the rest of the suite runs beside them.
const LONG = 60_000;

function kernelStore(): KernelStore {
  const k = takeKernel();
  if (k === null) throw new Error('the kernel module did not load in this test run');
  return new KernelStore(k);
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The stores under test: a name and how to make one. */
const STORES: { name: string; make: () => MovingStore }[] = [
  { name: 'typescript', make: () => new ArrayStore() },
  { name: 'kernel', make: kernelStore },
];

/** A stand-in for a Shape: the index only reads its bounds and writes its slot. */
interface Box { minx: number; miny: number; minz: number; maxx: number; maxy: number; maxz: number; _index: unknown; _slot: number; id: number }
const asShape = (b: Box): Shape => b as unknown as Shape;

function place(b: Box, R: () => number, spread: number): void {
  const k = R();
  const x = (R() * 2 - 1) * spread, y = R() * 60, z = (R() * 2 - 1) * spread;
  // Mostly limb-sized, some wide enough for the short list, a few that are not numbers or lie past FAR.
  const w = k < 0.9 ? 0.2 + R() * 6 : k < 0.96 ? 40 + R() * 200 : 1;
  b.minx = x - w; b.maxx = x + w; b.miny = y - w; b.maxy = y + w; b.minz = z - w; b.maxz = z + w;
  if (k >= 0.96 && k < 0.97) b.minx = NaN;
  else if (k >= 0.97 && k < 0.98) b.maxz = Infinity;
  else if (k >= 0.98 && k < 0.99) { b.minx = 5e12; b.maxx = 6e12; }
  else if (k >= 0.99) { const t = b.minx; b.minx = b.maxx; b.maxx = t; }
}

/** The old walk: every slot in order, the same rejection test. */
function walk(list: Box[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    if (s.minx > x1 || s.maxx < x0 || s.miny > y1 || s.maxy < y0 || s.minz > z1 || s.maxz < z0) continue;
    out.push(i);
  }
  return out;
}

describe.each(STORES)('moving index on the $name store', ({ make }) => {
  it('answers 10,000 seeded boxes exactly as the plain walk does', () => {
    const store = make();
    const R = rng(20261123);
    let cases = 0, grown = 0, nextId = 0;
    for (let scene = 0; cases < 10000; scene++) {
      const index = new MovingIndex(scene === 0 ? store : make(), [4, 16, 16, 64][scene % 4]!);
      const spread = [30, 300, 300, 5000][scene % 4]!;
      const list: Box[] = [];
      const add = (): void => {
        const b: Box = { minx: 0, miny: 0, minz: 0, maxx: 0, maxy: 0, maxz: 0, _index: null, _slot: -1, id: nextId++ };
        place(b, R, spread);
        list.push(b);
        index.add(asShape(b));
      };
      const count = 1 + Math.floor(R() * (scene % 5 === 0 ? 700 : 120));
      for (let i = 0; i < count; i++) add();
      for (let round = 0; round < 25; round++) {
        // Between queries the world changes the way a game changes it: most shapes drift, some jump, a few come and go.
        const moves = Math.floor(R() * list.length * (round % 3 === 0 ? 1 : 0.1));
        for (let m = 0; m < moves; m++) {
          const b = list[Math.floor(R() * list.length)]!;
          if (R() < 0.8) { const d = (R() - 0.5) * 2; b.minx += d; b.maxx += d; b.minz += d * 0.5; b.maxz += d * 0.5; } else place(b, R, spread);
          index.touch(b._slot, asShape(b));
        }
        if (R() < 0.3 && list.length > 1) {
          const k = Math.floor(R() * list.length);
          const [gone] = list.splice(k, 1);
          index.remove(k, asShape(gone!), list.map(asShape));
        }
        if (R() < 0.3) add();
        for (let i = 0; i < list.length; i++) expect(list[i]!._slot).toBe(i);
        for (let q = 0; q < 16; q++, cases++) {
          const k = R();
          const cx = (R() * 2 - 1) * spread * 1.2, cy = R() * 60, cz = (R() * 2 - 1) * spread * 1.2;
          const h = k < 0.7 ? R() * 8 : k < 0.9 ? R() * 120 : spread * 4;
          let x0 = cx - h, x1 = cx + h, z0 = cz - h, z1 = cz + h;
          const y0 = cy - h, y1 = cy + h;
          if (k > 0.97) x0 = NaN;
          else if (k > 0.95) x1 = Infinity;
          else if (k > 0.93) { z0 = -Infinity; z1 = Infinity; }
          const m = index.box(x0, y0, z0, x1, y1, z1);
          expect(Array.from(index.found.subarray(0, m))).toEqual(walk(list, x0, y0, z0, x1, y1, z1));
        }
      }
      grown += index.builds;
    }
    expect(cases).toBeGreaterThanOrEqual(10000);
    // The grid was really in use: it was built many times, not once.
    expect(grown).toBeGreaterThan(100);
  }, LONG);
});

// ---------------------------------------------------------------- the kernel against TypeScript, array by array

const bits = (a: Float64Array, n: number): string[] => Array.from(new BigUint64Array(a.buffer, a.byteOffset, n), (v) => v.toString(16));

/** The first n entries are the same numbers. A plain loop: these arrays are long and compared thousands of times. */
function same(what: string, got: Int32Array, want: Int32Array, n: number): void {
  for (let i = 0; i < n; i++) if (got[i] !== want[i]) throw new Error(`${what}[${i}] is ${got[i]}, TypeScript built ${want[i]}`);
}


describe('the kernel', () => {
  it('builds 3,000 seeded grids into the same bits as buildGrid', () => {
    const R = rng(8151);
    const ts = new ArrayStore(), k = kernelStore();
    ts.reserve(1024, 0);
    k.reserve(1024, 0);
    let cells = 0, wide = 0;
    for (let scene = 0; scene < 3000; scene++) {
      const n = scene % 50 === 0 ? 1024 : Math.floor(R() * 300);
      const spread = [20, 300, 4000, 3e9][scene % 4]!;
      const b: Box = { minx: 0, miny: 0, minz: 0, maxx: 0, maxy: 0, maxz: 0, _index: null, _slot: -1, id: 0 };
      for (let i = 0; i < n; i++) {
        place(b, R, spread);
        // Whole numbers of cells and negative zero are where a floor could differ.
        if (i % 11 === 0) { b.minx = Math.round(b.minx / 16) * 16; b.maxx = b.minx + 16; }
        if (i % 97 === 0) { b.minx = -0; b.minz = -0; b.maxx = 3; b.maxz = 3; }
        const o = i * 6;
        for (const s of [ts, k]) { s.aabb[o] = b.minx; s.aabb[o + 1] = b.miny; s.aabb[o + 2] = b.minz; s.aabb[o + 3] = b.maxx; s.aabb[o + 4] = b.maxy; s.aabb[o + 5] = b.maxz; }
      }
      const cell = [16, 16, 4, 0.37, 1e-7, 250][scene % 6]!;
      buildGrid(ts, n, cell);
      k.build(n, cell);
      expect(bits(k.headF, 3)).toEqual(bits(ts.headF, 3));
      expect(Array.from(k.headI.subarray(0, 5))).toEqual(Array.from(ts.headI.subarray(0, 5)));
      const nCells = ts.headI[NI]! * ts.headI[NK]!;
      same(`scene ${scene}: state`, k.state, ts.state, n);
      same(`scene ${scene}: over`, k.over, ts.over, ts.headI[NOVER]!);
      same(`scene ${scene}: cellStart`, k.cellStart, ts.cellStart, nCells + 1);
      same(`scene ${scene}: items`, k.items, ts.items, ts.headI[NITEMS]!);
      // A slot outside the grid has no range; whatever an earlier build left there is not part of the answer.
      for (let i = 0; i < n; i++) {
        if (ts.state[i] !== GRID) continue;
        for (let j = 0; j < 4; j++) if (k.range[i * 4 + j] !== ts.range[i * 4 + j]) throw new Error(`scene ${scene}: range of slot ${i} differs`);
      }
      cells += nCells;
      wide += ts.headI[NOVER]!;
    }
    // The scenes were not all empty or all in the short list.
    expect(cells).toBeGreaterThan(100000);
    expect(wide).toBeGreaterThan(1000);
  }, LONG);

  it('answers 10,000 seeded boxes inside the module exactly as MovingIndex.box does', () => {
    const R = rng(99173);
    let cases = 0, found = 0, nextId = 0;
    for (let scene = 0; cases < 10000; scene++) {
      const store = kernelStore();
      const index = new MovingIndex(store, [4, 16, 64][scene % 3]!);
      const spread = [30, 300, 5000][scene % 3]!;
      const list: Box[] = [];
      for (let i = 0, n = 1 + Math.floor(R() * 400); i < n; i++) {
        const b: Box = { minx: 0, miny: 0, minz: 0, maxx: 0, maxy: 0, maxz: 0, _index: null, _slot: -1, id: nextId++ };
        place(b, R, spread);
        list.push(b);
        index.add(asShape(b));
      }
      for (let round = 0; round < 10; round++) {
        // Some shapes leave their cells, so the module reads the loose list TypeScript keeps in its memory.
        for (let m = 0, moves = Math.floor(R() * list.length * 0.1); m < moves; m++) {
          const b = list[Math.floor(R() * list.length)]!;
          place(b, R, spread);
          index.touch(b._slot, asShape(b));
        }
        for (let q = 0; q < 25; q++, cases++) {
          const kq = R();
          const cx = (R() * 2 - 1) * spread * 1.2, cy = R() * 60, cz = (R() * 2 - 1) * spread * 1.2;
          const h = kq < 0.7 ? R() * 8 : kq < 0.9 ? R() * 120 : spread * 4;
          let x0 = cx - h, x1 = cx + h;
          const z0 = cz - h, z1 = cz + h;
          if (kq > 0.97) x0 = NaN;
          else if (kq > 0.95) x1 = Infinity;
          const m = index.box(x0, cy - h, z0, x1, cy + h, z1);
          const want = Array.from(index.found.subarray(0, m));
          const got = store.query(index.n, x0, cy - h, z0, x1, cy + h, z1);
          expect(Array.from(store.out.subarray(0, got))).toEqual(want);
          found += m;
        }
      }
    }
    expect(found).toBeGreaterThan(10000);
  }, LONG);
});

// ---------------------------------------------------------------- the whole world

interface Rig { phys: Physics; shapes: Shape[]; }

async function world(seed: number, oldWalk: boolean, store: MovingStore): Promise<Rig> {
  let phys!: Physics;
  await startGame(defineGame({ ready(g) { phys = usePhysics(g.world); } }), { seed: 1, stepRate: 60 });
  (phys as unknown as { index: MovingIndex }).index = new MovingIndex(store, phys.cell);
  if (oldWalk) {
    // Before the index: a sweep tested every moving shape in order, an overlap kept those whose bounds met the box.
    const index = phys.index as unknown as { n: number; found: Int32Array; box(...a: number[]): number; linear(...a: number[]): number };
    let sweeping = false;
    const cast = phys.cast.bind(phys);
    phys.cast = (...a: Parameters<Physics['cast']>): void => { sweeping = true; try { cast(...a); } finally { sweeping = false; } };
    index.box = (...a: number[]): number => {
      if (!sweeping) return index.linear(...a);
      for (let i = 0; i < index.n; i++) index.found[i] = i;
      return index.n;
    };
  }
  const R = rng(seed);
  const shapes: Shape[] = [];
  const tags = ['', 'limb:arm', 'limb:leg', 'nape'];
  for (let i = 0; i < 260; i++) {
    const k = R();
    const at = { x: (R() * 2 - 1) * 60, y: R() * 30, z: (R() * 2 - 1) * 60 };
    const o = { static: i % 4 === 0, layer: 1 << (i % 3), tag: tags[i % 4]!, trigger: i % 17 === 0, userData: i,
      position: at, quaternion: quat(R) };
    if (k < 0.3) shapes.push(phys.add({ type: 'sphere', radius: 0.3 + R() * 3 }, o));
    else if (k < 0.7) shapes.push(phys.add({ type: 'capsule', radius: 0.3 + R() * 1.5, height: 4 + R() * 8 }, o));
    else shapes.push(phys.add({ type: 'box', size: [0.5 + R() * 6, 0.5 + R() * 6, 0.5 + R() * 6] }, o));
  }
  phys.addGround(0, { userData: -1 });
  return { phys, shapes };
}

function quat(R: () => number): { x: number; y: number; z: number; w: number } {
  const x = R() - 0.5, y = R() - 0.5, z = R() - 0.5, w = R() - 0.5, l = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}

const hitOf = (h: Hit | null): unknown => h === null ? null : [h.distance, h.x, h.y, h.z, h.nx, h.ny, h.nz, h.shape?.userData, h.tag, h.inside, h.depth];

describe.each(STORES)('physics queries on the $name store', ({ make }) => {
  it('10,000 seeded casts and overlaps match the walk over every moving shape, bit for bit', async () => {
    const store = make();
    const a = await world(77, false, store), b = await world(77, true, new ArrayStore());
    expect(a.phys.index.kind).toBe(store.kind);
    const R = rng(4242);
    const filters: (QueryFilter | undefined)[] = [undefined, { mask: 1 }, { mask: 6 }, { tag: 'limb:*' }, { tag: 'nape', triggers: true }, { triggers: true }];
    const ha = new Hit(), hb = new Hit();
    let hits = 0, overlaps = 0;
    for (let i = 0; i < 10000; i++) {
      if (i % 40 === 0) {
        // The moving shapes move, in both worlds alike; a few are switched off, removed or added.
        for (let k = 0; k < a.shapes.length; k++) {
          if (a.shapes[k]!.isStatic || R() < 0.3) continue;
          const jump = R() < 0.1;
          const s = a.shapes[k]!;
          const p = jump ? [(R() * 2 - 1) * 60, R() * 30, (R() * 2 - 1) * 60] : [(s.minx + s.maxx) / 2 + (R() - 0.5), (s.miny + s.maxy) / 2 + (R() - 0.5) * 0.2, (s.minz + s.maxz) / 2 + (R() - 0.5)];
          const q = quat(R);
          for (const w of [a, b]) w.shapes[k]!.setPose(p[0]!, p[1]!, p[2]!, q.x, q.y, q.z, q.w);
        }
        const k = Math.floor(R() * a.shapes.length);
        const on = R() < 0.7;
        for (const w of [a, b]) w.shapes[k]!.enabled = on;
        if (i % 400 === 200) {
          const gone = Math.floor(R() * a.shapes.length);
          for (const w of [a, b]) { w.phys.remove(w.shapes[gone]!); w.shapes.splice(gone, 1); }
          const at = { x: (R() * 2 - 1) * 60, y: R() * 30, z: (R() * 2 - 1) * 60 }, radius = 0.5 + R() * 2;
          for (const w of [a, b]) w.shapes.push(w.phys.add({ type: 'sphere', radius }, { static: false, position: at, userData: 1000 + i }));
        }
      }
      const o = { x: (R() * 2 - 1) * 65, y: R() * 40, z: (R() * 2 - 1) * 65 };
      const d = { x: R() - 0.5, y: (R() - 0.6) * 0.6, z: R() - 0.5 };
      const f = filters[Math.floor(R() * filters.length)];
      const dist = R() < 0.1 ? 1000 : 5 + R() * 150;
      const kind = i % 5;
      if (kind === 0) expect(hitOf(a.phys.raycast(o, d, dist, f, ha))).toEqual(hitOf(b.phys.raycast(o, d, dist, f, hb)));
      else if (kind === 1) {
        const r = 0.2 + R() * 2;
        expect(hitOf(a.phys.spherecast(o, d, dist, r, f, ha))).toEqual(hitOf(b.phys.spherecast(o, d, dist, r, f, hb)));
      }
      else if (kind === 2) {
        const top = { x: o.x, y: o.y + 1.2, z: o.z };
        expect(hitOf(a.phys.capsulecast(o, top, 0.4, d, dist * 0.2, f, ha))).toEqual(hitOf(b.phys.capsulecast(o, top, 0.4, d, dist * 0.2, f, hb)));
      } else if (kind === 3) {
        const r = 0.5 + R() * 9;
        const ra = a.phys.overlapSphere(o, r, f).map((s) => s.userData), rb = b.phys.overlapSphere(o, r, f).map((s) => s.userData);
        expect(ra).toEqual(rb);
        overlaps += ra.length;
      } else {
        const top = { x: o.x + d.x * 6, y: o.y + 3, z: o.z + d.z * 6 };
        expect(a.phys.overlapCapsule(o, top, 1.5, f).map((s) => s.userData)).toEqual(b.phys.overlapCapsule(o, top, 1.5, f).map((s) => s.userData));
      }
      if (ha.shape !== null) hits++;
    }
    // The cases were not all misses.
    expect(hits).toBeGreaterThan(1000);
    expect(overlaps).toBeGreaterThan(1000);
    expect(a.phys.index.builds).toBeGreaterThan(50);
  }, LONG);
});
