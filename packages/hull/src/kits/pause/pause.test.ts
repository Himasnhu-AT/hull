import { describe, expect, it } from 'vitest';
import { ALL_KITS, kitSources, startRig } from '../testing.ts';
import type { StepSnapshot } from '../../input/index.ts';
import { FirstPerson } from '../fps/fps.ts';
import { Health } from '../health/health.ts';
import bench from './bench.ts';
import { PauseMenu } from './pause.ts';

const sources = kitSources(...ALL_KITS);
const press: StepSnapshot = { pause: { d: 1, p: 1 } };

describe('pause kit', () => {
  it('stops the kits while paused, keeps reading the pause action, and resumes', async () => {
    const r = await startRig(bench, sources, 'fps');
    const w = r.g.world;
    const menu = w.find('pause')!.get(PauseMenu)!;
    const me = w.find('player')!;
    r.step(30);
    r.step(30, { move: { y: -1 } });
    const z1 = me.position.z;
    expect(z1).toBeLessThan(-1);
    r.step(1, press);
    expect(menu.paused).toBe(true);
    r.step(60, { move: { y: -1 } });
    expect(me.position.z).toBeCloseTo(z1, 6);
    expect(me.get(FirstPerson)!.yaw).toBe(0);
    const h = me.get(Health)!;
    h.damage(20);
    r.step(80);
    expect(h.invuln).toBeGreaterThan(0.3); // the clock of the hit does not run
    r.step(1, press);
    expect(menu.paused).toBe(false);
    r.step(30, { move: { y: -1 } });
    expect(me.position.z).toBeLessThan(z1 - 1);
  });

  it('the pause state is part of the checksum', async () => {
    const a = await startRig(bench, sources, 'fps');
    a.step(5);
    const c0 = a.g.world.checksum();
    const b = await startRig(bench, sources, 'fps');
    b.step(4);
    b.step(1, press);
    expect(b.g.world.checksum()).not.toBe(c0);
  });
});
