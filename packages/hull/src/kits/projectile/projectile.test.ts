import { describe, expect, it } from 'vitest';
import type { StepSnapshot } from '../../input/index.ts';
import { ALL_KITS, kitSources, runScenario, startRig } from '../testing.ts';
import { FirstPerson } from '../fps/fps.ts';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Health } from '../health/health.ts';
import { fire, Launcher, projectilesOf } from './projectile.ts';
import bench from './bench.ts';

const sources = kitSources(...ALL_KITS, 'interact', 'checkpoint', 'projectile');

describe('projectile kit', () => {
  it('a 200 m/s shot does not tunnel a 0.2 m wall', async () => {
    const r = await startRig(bench, sources, 'fps');
    const w = r.g.world;
    const pool = projectilesOf(w);
    let hits = 0, hitZ = 0;
    pool.hit.connect((t, _x, _y, z) => { hits++; hitZ = z; expect(t).toBe(null); });
    const shot = fire(w, { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: -1 }, { speed: 200 });
    r.step(10);
    expect(hits).toBe(1);
    expect(pool.live).toBe(0);
    expect(hitZ).toBeCloseTo(-9.9, 1);
    expect(shot.position.z).toBeGreaterThan(-10);
  });

  it('damages a Health once, and gravity bends the path', async () => {
    const r = await startRig(bench, sources, 'fps');
    const w = r.g.world;
    const hp = w.find('target')!.get(Health)!;
    let damaged = 0;
    hp.damaged.connect(() => damaged++);
    fire(w, { x: 2, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { speed: 200, damage: 30 });
    r.step(8);
    expect(damaged).toBe(1);
    expect(hp.hp).toBe(70);
    const flat = fire(w, { x: -3, y: 2, z: 0 }, { x: 0, y: 0, z: -1 }, { speed: 20, gravity: 20 });
    r.step(30);
    expect(flat.position.y).toBeLessThan(2); // fell while flying
    r.step(120);
    expect(projectilesOf(w).live).toBe(0);
  });

  it('a shot never hurts its own shooter', async () => {
    const r = await startRig(bench, sources, 'fps');
    const w = r.g.world;
    const me = w.find('player')!;
    const hp = me.get(Health)!;
    fire(w, { x: me.position.x, y: 1, z: me.position.z }, { x: 0, y: 0, z: -1 }, { speed: 100, from: me });
    r.step(30);
    expect(hp.hp).toBe(hp.max);
  });

  it('the launcher fires on the fire action at its rate', async () => {
    const r = await startRig(bench, sources, 'fps');
    const w = r.g.world;
    const l = w.find('player')!.get(FirstPerson)!.eye.get(Launcher)!;
    let n = 0;
    l.fired.connect(() => n++);
    r.step(60, { fire: { d: 1 } });
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(7);
  });

  it('1000 shots after warm-up allocate nothing', async () => {
    const r = await startRig(bench, sources, 'fps');
    const w = r.g.world;
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const o = { x: 0, y: 2, z: 0 };
    const d = { x: 0, y: 0, z: -1 };
    const opts = { speed: 200, hitSound: '' };
    const go = (n: number): void => {
      for (let i = 0; i < n; i++) {
        fire(w, o, d, opts);
        r.g.step(1);
        r.g.step(1);
      }
    };
    const idle = (n: number): void => { for (let i = 0; i < n; i++) { r.g.step(1); r.g.step(1); } };
    idle(50);
    gc(); gc();
    const b0 = process.memoryUsage().heapUsed;
    idle(1000);
    gc(); gc();
    void b0;
    go(50);
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    go(1000);
    gc(); gc();
    const grew = process.memoryUsage().heapUsed - before;
    (globalThis as { __grew?: number }).__grew = grew;
    expect(grew).toBeLessThan(150_000);
    expect(projectilesOf(w).all.length).toBeLessThan(5);
  });

  it('replays to the same checksum', async () => {
    const run = async (): Promise<string> => {
      const { rig, checksum } = await runScenario({
        def: bench, sources, inputMap: 'fps', steps: 200, input: (i): StepSnapshot => (i % 50 < 30 ? { fire: { d: 1 }, look: { x: 2, y: 0 } } : {}),
      });
      rig.g.dispose();
      return checksum;
    };
    expect(await run()).toBe(await run());
  });
});
