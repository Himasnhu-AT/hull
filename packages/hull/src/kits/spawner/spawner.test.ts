import { describe, expect, it } from 'vitest';
import { ALL_KITS, kitSources, startRig } from '../testing.ts';
import { Health } from '../health/health.ts';
import bench from './bench.ts';
import { Spawner } from './spawner.ts';

const sources = kitSources(...ALL_KITS);

async function run(): Promise<{ log: string; checksum: string }> {
  const r = await startRig(bench, sources, 'fps', 21);
  const w = r.g.world;
  w.find('player')!.get(Health)!.max = 1e6;
  w.find('player')!.get(Health)!.hp = 1e6;
  const sp = w.find('spawner')!.get(Spawner)!;
  const log: string[] = [];
  sp.waveStarted.connect((n) => log.push(`start ${n}`));
  sp.waveCleared.connect((n) => log.push(`clear ${n}`));
  sp.spawned.connect((e) => log.push(`spawn ${e.position.x.toFixed(2)},${e.position.z.toFixed(2)}`));
  const killAll = (): void => { for (const e of w.group('enemy').slice()) e.get(Health)!.damage(1e5); };
  r.step(130);
  expect(sp.wave).toBe(1);
  r.step(90);
  expect(w.group('enemy').length).toBe(3);
  killAll();
  r.step(2);
  expect(sp.kills).toBe(3);
  expect(w.group('enemy').length).toBe(0);
  r.step(30);
  expect(log).toContain('clear 1');
  r.step(330);
  expect(sp.wave).toBe(2);
  r.step(200);
  expect(w.group('enemy').length).toBe(5);
  const checksum = w.checksum();
  r.g.dispose();
  return { log: log.join('\n'), checksum };
}

describe('spawner kit', () => {
  it('runs waves: spawn, clear, rest, a bigger wave; the same every time', async () => {
    const a = await run();
    expect(a.log).toMatch(/start 1[\s\S]*spawn[\s\S]*clear 1[\s\S]*start 2/);
    const b = await run();
    expect(b).toEqual(a);
  });

  it('spawns no closer than the minimum distance and respects maxAlive', async () => {
    const r = await startRig(bench, sources, 'fps', 4);
    const w = r.g.world;
    w.find('player')!.get(Health)!.max = 1e6;
    w.find('player')!.get(Health)!.hp = 1e6;
    r.step(600);
    for (const e of w.group('enemy')) expect(Math.hypot(e.position.x, e.position.z)).toBeGreaterThan(0.5);
    expect(w.group('enemy').length).toBeLessThanOrEqual(10);
  });
});
