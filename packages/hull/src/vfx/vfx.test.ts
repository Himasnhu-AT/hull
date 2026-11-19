/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config, defineGame, startGame } from '../index.ts';
import { RandomStream } from '../core/random.ts';
import { validateAgainst } from '../config/validate.ts';
import { lookSchema } from '../schema/look.ts';
import { vfxSchema, type Vfx } from '../schema/vfx.ts';
import { buildLut, lutAt, parseColor, sampleColorCurve, sampleCurve, LUT } from './curves.ts';
import { compile, drawCount, look, nearFade, Pool, spawnOne } from './emitter.ts';
import { mountVfx, vfx } from './index.ts';

const dir = join(import.meta.dirname, 'examples', 'config');
const files = (kind: string): { path: string; text: string }[] =>
  readdirSync(join(dir, kind)).map((f) => ({ path: `config/${kind}/${f}`, text: readFileSync(join(dir, kind, f), 'utf8') }));

const base: Vfx = {
  kind: 'vfx',
  emit: { count: [5, 9] },
  particle: { life: [1, 1], speed: [2, 2], direction: { cone: [0, 1, 0], angleDeg: 30 }, size: [[0, 1]] },
};

describe('vfx schema', () => {
  it('accepts every example and the SCHEMAS.md section 10 sample', () => {
    for (const f of files('vfx')) expect(validateAgainst(vfxSchema, JSON.parse(f.text)), f.path).toEqual([]);
    const doc = {
      kind: 'vfx',
      emit: { count: [8, 14], over: 0.05, shape: { disc: 0.4 } },
      particle: { life: [0.5, 1.1], speed: [0.8, 2.4], direction: { cone: [0, 1, 0], angleDeg: 55 }, gravity: -0.6, drag: 2.2, size: [[0, 0.2], [1, 1.1]], color: [[0, '#cfc6b6'], [1, '#8f887c']], alpha: [[0, 0.7], [1, 0]], sprite: 'smoke' },
      budget: { max: 400, fadeNear: 1.5 },
    };
    expect(validateAgainst(vfxSchema, doc)).toEqual([]);
  });

  it('rejects strays, bad colours and a missing life', () => {
    expect(validateAgainst(vfxSchema, { ...base, extra: 1 }).length).toBeGreaterThan(0);
    expect(validateAgainst(vfxSchema, { ...base, particle: { ...base.particle, color: [[0, 'red']] } }).length).toBeGreaterThan(0);
    expect(validateAgainst(vfxSchema, { ...base, particle: { speed: [1, 2] } }).length).toBeGreaterThan(0);
    expect(validateAgainst(vfxSchema, { ...base, particle: { ...base.particle, sprite: 'blob' } }).length).toBeGreaterThan(0);
  });

  it('look accepts the new post and environment fields', () => {
    for (const f of files('look')) expect(validateAgainst(lookSchema, JSON.parse(f.text)), f.path).toEqual([]);
    expect(validateAgainst(lookSchema, { kind: 'look', post: { lift: [0, 0, 0], aa: 'smaa' } }).length).toBeGreaterThan(0);
  });
});

describe('curves', () => {
  const keys = [[0, 0], [0.5, 10], [1, 4]] as const;
  it('interpolates between keys and holds the ends', () => {
    expect(sampleCurve(keys, -1)).toBe(0);
    expect(sampleCurve(keys, 0.25)).toBeCloseTo(5);
    expect(sampleCurve(keys, 0.75)).toBeCloseTo(7);
    expect(sampleCurve(keys, 2)).toBe(4);
    expect(sampleCurve([[0.3, 2]], 0.9)).toBe(2);
  });

  it('turns hex into linear light and blends in linear', () => {
    const c = parseColor('#ffffff') as number[];
    expect(c).toEqual([1, 1, 1]);
    expect((parseColor('#808080') as number[])[0]).toBeCloseTo(0.2158, 3);
    const out = [0, 0, 0];
    sampleColorCurve([[0, '#000000'], [1, '#ffffff']], 0.5, out);
    expect(out[0]).toBeCloseTo(0.5);
    expect(() => parseColor('red')).toThrow(/#rrggbb/);
  });

  it('a lookup table agrees with the curve', () => {
    const lut = buildLut(keys, [[0, '#000000'], [1, '#ffffff']], [[0, 1], [1, 0]]);
    expect(lut.length).toBe(LUT * 5);
    for (const t of [0, 0.1, 0.37, 0.5, 0.82, 1]) {
      expect(lutAt(lut, t, 0)).toBeCloseTo(sampleCurve(keys, t), 0);
      expect(lutAt(lut, t, 4)).toBeCloseTo(1 - t, 2);
    }
  });
});

describe('burst options, ground and flutter', () => {
  it('scales size and speed per call without changing the draws', () => {
    const c = compile(base);
    const a = new Pool(20), b = new Pool(20);
    const ra = new RandomStream(4, 'cosmetic'), rb = new RandomStream(4, 'cosmetic');
    for (let i = 0; i < 10; i++) { spawnOne(a, c, ra, 0, 0, 0, undefined); spawnOne(b, c, rb, 0, 0, 0, undefined, { size: 2, speed: 3 }); }
    for (let i = 0; i < 10; i++) {
      expect(b.scale[i]!).toBeCloseTo(a.scale[i]! * 2, 5);
      expect(b.vy[i]!).toBeCloseTo(a.vy[i]! * 3, 4);
    }
    expect(ra.next()).toBe(rb.next());
  });

  it('dies, bounces or rests at the ground the game supplies', () => {
    const fall = (ground: 'die' | 'bounce' | 'rest'): Pool => {
      const c = compile({ ...base, particle: { life: [5, 5], speed: [0, 0], gravity: -10, ground } });
      const pool = new Pool(4);
      spawnOne(pool, c, new RandomStream(1, 'cosmetic'), 0, 1, 0, undefined);
      for (let i = 0; i < 240; i++) pool.step(c, 1 / 120, () => 0);
      return pool;
    };
    expect(fall('die').count).toBe(0);
    const rest = fall('rest');
    expect(rest.count).toBe(1);
    expect(rest.py[0]!).toBeCloseTo(0.02, 5);
    const bounce = fall('bounce');
    expect(bounce.py[0]!).toBeGreaterThanOrEqual(0.02 - 1e-6);
    expect(bounce.py[0]!).toBeLessThan(0.5);
  });

  it('flutter moves a particle sideways and none without it', () => {
    const run = (flutter: number): number => {
      const c = compile({ ...base, particle: { life: [5, 5], speed: [0, 0], flutter } });
      const pool = new Pool(2);
      spawnOne(pool, c, new RandomStream(1, 'cosmetic'), 0, 0, 0, undefined);
      for (let i = 0; i < 120; i++) pool.step(c, 1 / 120);
      return Math.hypot(pool.px[0]!, pool.pz[0]!);
    };
    expect(run(0)).toBe(0);
    expect(run(5)).toBeGreaterThan(0.01);
  });

  it('accepts the new sprites and ground modes in a config', () => {
    for (const sprite of ['chip', 'leaf'] as const) expect(validateAgainst(vfxSchema, { ...base, particle: { ...base.particle, sprite, ground: 'bounce', flutter: 2 } })).toEqual([]);
    expect(validateAgainst(vfxSchema, { ...base, particle: { ...base.particle, ground: 'sink' } }).length).toBeGreaterThan(0);
  });
});

describe('emitter maths', () => {
  it('draws counts inside the range and the same ones for the same seed', () => {
    const c = compile(base);
    const a = new RandomStream(5, 'cosmetic');
    const b = new RandomStream(5, 'cosmetic');
    const other = new RandomStream(6, 'cosmetic');
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (let i = 0; i < 200; i++) { xs.push(drawCount(c, a)); ys.push(drawCount(c, b)); zs.push(drawCount(c, other)); }
    expect(xs).toEqual(ys);
    expect(xs).not.toEqual(zs);
    expect(Math.min(...xs)).toBe(5);
    expect(Math.max(...xs)).toBe(9);
  });

  it('keeps particles inside the cone, at the speed asked', () => {
    const c = compile(base);
    const rng = new RandomStream(1, 'cosmetic');
    const pool = new Pool(500);
    for (let i = 0; i < 500; i++) spawnOne(pool, c, rng, 0, 0, 0, undefined);
    const cos = Math.cos((30 * Math.PI) / 180);
    for (let i = 0; i < 500; i++) {
      const sp = Math.hypot(pool.vx[i]!, pool.vy[i]!, pool.vz[i]!);
      expect(sp).toBeCloseTo(2, 4);
      expect(pool.vy[i]! / sp).toBeGreaterThanOrEqual(cos - 1e-5);
    }
  });

  it('aims the cone at `dir` and spreads from a shape', () => {
    const c = compile({ ...base, emit: { shape: { sphere: 1 } }, particle: { ...base.particle, direction: { cone: [0, 1, 0], angleDeg: 10 } } });
    const rng = new RandomStream(2, 'cosmetic');
    const pool = new Pool(300);
    for (let i = 0; i < 300; i++) spawnOne(pool, c, rng, 10, 0, 0, { x: 1, y: 0, z: 0 });
    let maxR = 0;
    for (let i = 0; i < 300; i++) {
      expect(pool.vx[i]! / 2).toBeGreaterThan(Math.cos((10 * Math.PI) / 180) - 1e-5);
      maxR = Math.max(maxR, Math.hypot(pool.px[i]! - 10, pool.py[i]!, pool.pz[i]!));
    }
    expect(maxR).toBeLessThanOrEqual(1.0001);
    expect(maxR).toBeGreaterThan(0.7);
  });

  it('goes straight out from the centre when asked', () => {
    const c = compile({ ...base, emit: { shape: { sphere: 2 } }, particle: { ...base.particle, direction: { outward: true } } });
    const rng = new RandomStream(3, 'cosmetic');
    const pool = new Pool(50);
    for (let i = 0; i < 50; i++) spawnOne(pool, c, rng, 0, 0, 0, undefined);
    for (let i = 0; i < 50; i++) {
      const d = Math.hypot(pool.px[i]!, pool.py[i]!, pool.pz[i]!);
      expect((pool.px[i]! * pool.vx[i]! + pool.py[i]! * pool.vy[i]! + pool.pz[i]! * pool.vz[i]!) / (d * 2)).toBeCloseTo(1, 3);
    }
  });

  it('applies gravity and drag independent of the step length, and retires old particles', () => {
    const c = compile({ ...base, particle: { ...base.particle, life: [1, 1], gravity: -10, drag: 1, direction: { cone: [1, 0, 0], angleDeg: 0 } } });
    const run = (steps: number): [number, number, number] => {
      const pool = new Pool(1);
      spawnOne(pool, c, new RandomStream(1, 'cosmetic'), 0, 0, 0, undefined);
      for (let i = 0; i < steps; i++) pool.step(c, 0.5 / steps);
      return [pool.px[0]!, pool.vx[0]!, pool.count];
    };
    const coarse = run(5);
    const fine = run(500);
    expect(coarse[1]).toBeCloseTo(2 * Math.exp(-0.5), 4);
    expect(fine[1]).toBeCloseTo(coarse[1], 4);
    expect(fine[0]).toBeCloseTo(coarse[0], 1);
    const pool = new Pool(4);
    for (let i = 0; i < 4; i++) spawnOne(pool, c, new RandomStream(i, 'cosmetic'), 0, 0, 0, undefined);
    pool.step(c, 0.6);
    expect(pool.count).toBe(4);
    pool.step(c, 0.6);
    expect(pool.count).toBe(0);
  });

  it('drops spawns when full without shifting the random stream', () => {
    const c = compile(base);
    const full = new RandomStream(9, 'cosmetic');
    const roomy = new RandomStream(9, 'cosmetic');
    const small = new Pool(3);
    const big = new Pool(50);
    for (let i = 0; i < 10; i++) { spawnOne(small, c, full, 0, 0, 0, undefined); spawnOne(big, c, roomy, 0, 0, 0, undefined); }
    expect(small.count).toBe(3);
    expect(small.dropped).toBe(7);
    expect(full.u32()).toBe(roomy.u32());
  });

  it('reads size, colour and alpha through life, and fades near the camera', () => {
    const c = compile({ ...base, particle: { ...base.particle, size: [[0, 1], [1, 3]], alpha: [[0, 1], [1, 0]], glow: 2, color: [[0, '#ffffff']] } });
    const pool = new Pool(1);
    spawnOne(pool, c, new RandomStream(1, 'cosmetic'), 0, 0, 0, undefined);
    pool.age[0] = 0.5;
    const out = new Float32Array(5);
    look(pool, c, 0, out);
    expect(out[0]).toBeCloseTo(2, 1);
    expect(out[1]).toBeCloseTo(2);
    expect(out[4]).toBeCloseTo(0.5, 1);
    expect(nearFade(0, 2)).toBe(0);
    expect(nearFade(1, 2)).toBeCloseTo(0.5);
    expect(nearFade(5, 2)).toBe(1);
    expect(nearFade(0, 0)).toBe(1);
  });
});

describe('vfx system', () => {
  const load = (): void => {
    config.load([...files('vfx'), ...files('look'), ...files('material')]);
  };

  async function run(seed: number): Promise<{ counts: number[]; live: number[] }> {
    load();
    const g = await startGame(defineGame({ ready() {} }), { seed });
    mountVfx(g);
    const counts: number[] = [];
    const live: number[] = [];
    for (let i = 0; i < 6; i++) {
      vfx.burst('dust', { x: i, y: 0, z: 0 });
      vfx.burst('vfx/sparks', { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
      g.step(7);
      counts.push(vfx.stats().spawned);
      live.push(vfx.stats().live);
    }
    g.dispose();
    return { counts, live };
  }

  it('spawns the same particles for the same seed, even in the checksum', async () => {
    const a = await run(11);
    const b = await run(11);
    expect(a).toEqual(b);
    expect(a.counts[5]).toBeGreaterThan(60);
    expect((await run(12)).counts).not.toEqual(a.counts);
  });

  it('leaves the game checksum alone (the cosmetic stream is not in it)', async () => {
    load();
    const plain = await startGame(defineGame({ ready() {} }), { seed: 4 });
    const withFx = await startGame(defineGame({ ready() {} }), { seed: 4 });
    mountVfx(withFx);
    vfx.burst('dust', { x: 0, y: 0, z: 0 });
    plain.step(30);
    withFx.step(30);
    expect(withFx.world.checksum()).toBe(plain.world.checksum());
    expect(vfx.stats().spawned).toBeGreaterThan(0);
    plain.dispose();
    withFx.dispose();
  });

  it('spreads a burst over time, follows a trail and stops it', async () => {
    load();
    const g = await startGame(defineGame({ ready() {} }), { seed: 3 });
    mountVfx(g);
    vfx.burst('steam', { x: 0, y: 0, z: 0 });
    g.step(1);
    const early = vfx.stats().effects['vfx/steam']!.spawned;
    g.step(40);
    const late = vfx.stats().effects['vfx/steam']!.spawned;
    expect(early).toBeLessThan(late);
    expect(late).toBeGreaterThanOrEqual(10);
    expect(late).toBeLessThanOrEqual(16);

    const n = g.world.spawn('ship');
    const h = vfx.trail('gas-trail', n);
    expect(h.active).toBe(true);
    for (let i = 0; i < 30; i++) { n.position.x += 0.1; g.step(1); }
    const mid = vfx.stats().effects['vfx/gas-trail']!.spawned;
    expect(mid).toBeGreaterThan(30);
    h.stop();
    expect(h.active).toBe(false);
    g.step(30);
    expect(vfx.stats().effects['vfx/gas-trail']!.spawned).toBeLessThanOrEqual(mid + 2);
    g.dispose();
  });

  it('skips an effect that does not exist, naming it once', async () => {
    load();
    const g = await startGame(defineGame({ ready() {} }), { seed: 1 });
    mountVfx(g);
    expect(() => vfx.burst('nope', { x: 0, y: 0, z: 0 })).not.toThrow();
    expect(vfx.stats().live).toBe(0);
    g.dispose();
  });
});
