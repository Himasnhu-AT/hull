// The physics world on the kernel against the same world on TypeScript (plan-rust.md R2): built alike, changed
// alike, asked alike, and every answer compared bit for bit. Shapes of every kind, static, wide and moving;
// triggers, layers, tags exact and by prefix, nodes, shapes switched off, moved, removed and added; ray, sphere and
// capsule casts, both overlaps, distances, the character mover, and a pile of rigid bodies stepped for 600 steps.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineGame, startGame, type Game } from '../core/index.ts';
import { Body, Hit, MoveResult, Physics, slideMove, usePhysics, type QueryFilter, type Shape } from './index.ts';

afterEach(() => { vi.restoreAllMocks(); });

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const v = (x: number, y: number, z: number) => ({ x, y, z });
const LONG = 120_000;

interface Rig { game: Game; phys: Physics; shapes: Shape[]; nodes: import('../core/index.ts').Node[] }

function quat(R: () => number): { x: number; y: number; z: number; w: number } {
  const x = R() - 0.5, y = R() - 0.5, z = R() - 0.5, w = R() - 0.5, l = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}

/** A terrain patch as a triangle mesh, enough triangles for a BVH several levels deep. */
function patch(R: () => number, x0: number, z0: number, n: number, cell: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [], indices: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(x0 + i * cell, R() * 3, z0 + j * cell);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { positions, indices };
}

async function world(seed: number, kernels: 'on' | 'off'): Promise<Rig> {
  let phys!: Physics;
  const nodes: Rig['nodes'] = [];
  const game = await startGame(defineGame({ ready(g) {
    phys = usePhysics(g.world);
    for (let i = 0; i < 6; i++) nodes.push(g.world.spawn('n' + i));
  } }), { seed: 1, stepRate: 60, kernels });
  const R = rng(seed);
  const shapes: Shape[] = [];
  const tags = ['', 'limb:arm', 'limb:leg', 'nape', 'wall', 'limb:head'];
  const at = () => ({ x: (R() * 2 - 1) * 70, y: R() * 25, z: (R() * 2 - 1) * 70 });
  for (let i = 0; i < 320; i++) {
    const k = R();
    const o = {
      static: i % 3 === 0, layer: 1 << (i % 3), tag: tags[i % tags.length]!, trigger: i % 19 === 0, userData: i,
      position: at(), quaternion: quat(R), ...(i % 7 === 0 ? { node: nodes[i % nodes.length]! } : {}),
    };
    if (k < 0.3) shapes.push(phys.add({ type: 'sphere', radius: 0.3 + R() * 3 }, o));
    else if (k < 0.65) shapes.push(phys.add({ type: 'capsule', radius: 0.3 + R() * 1.5, height: 4 + R() * 8 }, o));
    else shapes.push(phys.add({ type: 'box', size: [0.5 + R() * 7, 0.5 + R() * 7, 0.5 + R() * 7] }, o));
  }
  // Wide statics that go to the short list, a mesh, a height field and the ground.
  shapes.push(phys.addBox(v(0, -1, 0), v(900, 2, 30), { userData: 'wall-long' }));
  const m = patch(R, -40, -40, 24, 2.5);
  shapes.push(phys.addMesh(m.positions, m.indices, { userData: 'mesh', tag: 'ground' }));
  const hs: number[] = [];
  for (let k = 0; k < 33 * 33; k++) hs.push(R() * 4);
  shapes.push(phys.addHeightfield(hs, 33, 33, 3, { origin: [20, 20], baseY: -2, userData: 'hf' }));
  shapes.push(phys.addGround(-3, { userData: 'ground' }));
  return { game, phys, shapes, nodes };
}

const hitOf = (h: Hit | null): unknown => h === null ? null : [h.distance, h.x, h.y, h.z, h.nx, h.ny, h.nz, h.shape?.userData, h.tag, h.inside, h.depth];
const ids = (list: Shape[]): unknown[] => list.map((s) => s.userData);

describe('the physics world on the kernel', () => {
  it('answers 20,000 seeded queries exactly as the world on TypeScript does', async () => {
    const said = vi.spyOn(console, 'error');
    const a = await world(5150, 'on'), b = await world(5150, 'off');
    expect(a.phys.backend).toBe('kernel');
    expect(b.phys.backend).toBe('typescript');
    const R = rng(777);
    const filters: (() => QueryFilter | undefined)[] = [
      () => undefined, () => ({ mask: 1 }), () => ({ mask: 6 }), () => ({ tag: 'limb:*' }), () => ({ tag: 'nape', triggers: true }),
      () => ({ triggers: true }), () => ({ tag: 'never' }), () => ({ tag: 'never*' }), () => ({ tag: '' }),
    ];
    const both = <T>(fn: (w: Rig, f: QueryFilter | undefined) => T, pick: number, extra?: (w: Rig) => QueryFilter): [T, T] => {
      const fa = extra ? extra(a) : filters[pick]!(), fb = extra ? extra(b) : filters[pick]!();
      return [fn(a, fa), fn(b, fb)];
    };
    const ha = new Hit(), hb = new Hit();
    const counts = { hit: 0, overlap: 0, cases: 0 };
    for (let i = 0; i < 20000; i++) {
      if (i % 50 === 0) {
        // The moving shapes move, in both worlds alike; some switch off, change tag or layer; a few go and come.
        for (let k = 0; k < a.shapes.length; k++) {
          const sa = a.shapes[k]!;
          if (sa.isStatic || R() < 0.3) continue;
          const jump = R() < 0.1;
          const p = jump ? [(R() * 2 - 1) * 70, R() * 25, (R() * 2 - 1) * 70] : [(sa.minx + sa.maxx) / 2 + (R() - 0.5), (sa.miny + sa.maxy) / 2 + (R() - 0.5) * 0.2, (sa.minz + sa.maxz) / 2 + (R() - 0.5)];
          const q = quat(R);
          for (const w of [a, b]) w.shapes[k]!.setPose(p[0]!, p[1]!, p[2]!, q.x, q.y, q.z, q.w);
        }
        const k = Math.floor(R() * 320), on = R() < 0.7, tag = ['limb:new', 'nape', ''][Math.floor(R() * 3)]!, layer = 1 << Math.floor(R() * 3);
        for (const w of [a, b]) { w.shapes[k]!.enabled = on; }
        const k2 = Math.floor(R() * 320);
        for (const w of [a, b]) { w.shapes[k2]!.tag = tag; w.shapes[k2]!.layer = layer; }
        if (i % 1000 === 500) {
          const gone = Math.floor(R() * 320);
          for (const w of [a, b]) { w.phys.remove(w.shapes[gone]!); w.shapes.splice(gone, 1, w.shapes[gone]!); }
          const p = v((R() * 2 - 1) * 70, R() * 25, (R() * 2 - 1) * 70), radius = 0.5 + R() * 2, stat = R() < 0.5;
          for (const w of [a, b]) w.shapes.push(w.phys.add({ type: 'sphere', radius }, { static: stat, position: p, userData: 'new' + i, tag: 'limb:late' }));
        }
      }
      const o = v((R() * 2 - 1) * 80, R() * 35 - 2, (R() * 2 - 1) * 80);
      const d = v(R() - 0.5, (R() - 0.6) * 0.8, R() - 0.5);
      const pick = Math.floor(R() * (filters.length + 2));
      const ignore = pick === filters.length ? (w: Rig) => ({ ignoreShape: w.shapes[i % 320]! }) : pick === filters.length + 1 ? (w: Rig) => ({ ignoreNode: w.nodes[i % 6]!, mask: 3 }) : undefined;
      const fp = Math.min(pick, filters.length - 1);
      const dist = R() < 0.1 ? 1000 : 5 + R() * 150;
      const kind = i % 7;
      counts.cases++;
      if (kind === 0) {
        const [x, y] = both((w, f) => hitOf(w.phys.raycast(o, d, dist, f, w === a ? ha : hb)), fp, ignore);
        expect(x).toEqual(y);
        if (x !== null) counts.hit++;
      } else if (kind === 1) {
        const r = 0.2 + R() * 2;
        const [x, y] = both((w, f) => hitOf(w.phys.spherecast(o, d, dist, r, f, w === a ? ha : hb)), fp, ignore);
        expect(x).toEqual(y);
        if (x !== null) counts.hit++;
      } else if (kind === 2) {
        const top = v(o.x, o.y + 1.4, o.z);
        const [x, y] = both((w, f) => hitOf(w.phys.capsulecast(o, top, 0.4, d, dist * 0.2, f, w === a ? ha : hb)), fp, ignore);
        expect(x).toEqual(y);
      } else if (kind === 3) {
        const r = 0.5 + R() * 9;
        const [x, y] = both((w, f) => ids(w.phys.overlapSphere(o, r, f)), fp, ignore);
        expect(x).toEqual(y);
        counts.overlap += x.length;
      } else if (kind === 4) {
        const top = v(o.x + d.x * 6, o.y + 3, o.z + d.z * 6);
        const [x, y] = both((w, f) => ids(w.phys.overlapCapsule(o, top, 1.5, f)), fp, ignore);
        expect(x).toEqual(y);
      } else if (kind === 5) {
        const k = Math.floor(R() * a.shapes.length);
        const da = v(0, 0, 0), db = v(0, 0, 0);
        const x = a.phys.distanceTo(a.shapes[k]!, o, da), y = b.phys.distanceTo(b.shapes[k]!, o, db);
        expect([x, da.x, da.y, da.z]).toEqual([y, db.x, db.y, db.z]);
      } else {
        // The character mover: a capsule slid through the world, contacts and all.
        const ra = new MoveResult(), rb = new MoveResult();
        const pa = v(o.x, o.y, o.z), pb = v(o.x, o.y, o.z), vel = v(d.x * 20, d.y * 20 - 5, d.z * 20);
        slideMove(a.phys, pa, 0.4, 1.6, 0.4, vel, 1 / 60, { stepHeight: 0.3, mask: 7 }, ra);
        slideMove(b.phys, pb, 0.4, 1.6, 0.4, vel, 1 / 60, { stepHeight: 0.3, mask: 7 }, rb);
        expect([pa.x, pa.y, pa.z, ra.vx, ra.vy, ra.vz, ra.grounded, ra.count, ra.moved, ra.stepped, ra.contacts.slice(0, ra.count).map((c) => [c.x, c.y, c.z, c.nx, c.ny, c.nz, c.shape?.userData, c.walkable])])
          .toEqual([pb.x, pb.y, pb.z, rb.vx, rb.vy, rb.vz, rb.grounded, rb.count, rb.moved, rb.stepped, rb.contacts.slice(0, rb.count).map((c) => [c.x, c.y, c.z, c.nx, c.ny, c.nz, c.shape?.userData, c.walkable])]);
      }
    }
    expect(counts.hit).toBeGreaterThan(1500);
    expect(counts.overlap).toBeGreaterThan(1000);
    // It answered all of them itself: it never fell back.
    expect(a.phys.backend).toBe('kernel');
    expect(said).not.toHaveBeenCalled();
  }, LONG);

  it('steps a pile of 300 rigid bodies to the same state, bit for bit, for 600 steps', async () => {
    const make = async (kernels: 'on' | 'off'): Promise<{ game: Game; phys: Physics }> => {
      let phys!: Physics;
      const game = await startGame(defineGame({ ready(g) {
        phys = usePhysics(g.world);
        phys.addGround(0);
        const half = 9;
        phys.addBox(v(-half, 4, 0), v(0.5, 8, half * 2));
        phys.addBox(v(half, 4, 0), v(0.5, 8, half * 2));
        phys.addBox(v(0, 4, -half), v(half * 2, 8, 0.5));
        phys.addBox(v(0, 4, half), v(half * 2, 8, 0.5));
        const R = rng(99);
        for (let i = 0; i < 300; i++) {
          const n = g.world.spawn('b' + i);
          n.position.set((R() * 2 - 1) * (half - 1.5), 1 + (i % 12) * 0.9 + R() * 0.3, (R() * 2 - 1) * (half - 1.5));
          n.rotation.set(R() * 3, R() * 3, R() * 3);
          if (i % 3 === 0) n.add(Body, { shape: { type: 'sphere', radius: 0.35 }, mass: 1, restitution: 0.4 });
          else n.add(Body, { shape: { type: 'box', size: [0.6 + (i % 4) * 0.1, 0.4, 0.5] }, mass: 2 });
        }
      } }), { seed: 7, stepRate: 120, kernels });
      return { game, phys };
    };
    const a = await make('on'), b = await make('off');
    expect(a.phys.backend).toBe('kernel');
    for (let s = 0; s < 600; s += 60) {
      a.game.step(60);
      b.game.step(60);
      expect(a.phys.state()).toEqual(b.phys.state());
      expect(a.game.world.checksum()).toBe(b.game.world.checksum());
    }
    const asleep = a.phys.state().bodies.filter((x) => x[13] === 1).length;
    expect(asleep).toBeGreaterThan(0);
    // Wake them with an impulse and keep going: bodies that wake and fall again match too.
    for (const w of [a, b]) for (let i = 0; i < 300; i += 7) w.game.world.find('b' + i)!.get(Body)!.applyImpulse(0, 4, 1);
    a.game.step(120); b.game.step(120);
    expect(a.phys.state()).toEqual(b.phys.state());
    expect(a.phys.backend).toBe('kernel');
  }, LONG);
});
