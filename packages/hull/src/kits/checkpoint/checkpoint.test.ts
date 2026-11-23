import { describe, expect, it } from 'vitest';
import { ALL_KITS, kitSources, runScenario, startRig } from '../testing.ts';
import { FirstPerson } from '../fps/fps.ts';
import { kitIO } from '../io.ts';
import { Health } from '../health/health.ts';
import { SaveSlots } from '../saves/saves.ts';
import { Checkpoint, Respawn } from './checkpoint.ts';
import bench from './bench.ts';

const sources = kitSources(...ALL_KITS, 'interact', 'checkpoint', 'projectile');

describe('checkpoint kit', () => {
  it('a player who dies comes back at the last checkpoint after the delay, with full health', async () => {
    const r = await startRig(bench, sources, 'fps');
    const w = r.g.world;
    const me = w.find('player')!;
    const hp = me.get(Health)!;
    const re = me.get(Respawn)!;
    re.delay = 1;
    r.step(2);
    expect(re.id).toBe('');
    me.position.set(0.5, 0, -10);
    r.step(2);
    expect(re.id).toBe('cp1');
    expect(w.find('cp1')!.get(Checkpoint)!.reached).toBe(true);
    me.position.set(20, 0, 5);
    r.step(2);
    hp.damage(1000);
    expect(hp.dead).toBe(true);
    r.step(50);
    expect(hp.dead).toBe(true);
    r.step(15);
    expect(hp.dead).toBe(false);
    expect(hp.hp).toBe(hp.max);
    expect(me.position.x).toBeCloseTo(0, 1);
    expect(me.position.z).toBeCloseTo(-10, 1);
    expect(me.get(FirstPerson)!.yaw).toBeCloseTo(0.5, 5);
    expect(re.deaths).toBe(1);
  });

  it('the checkpoint survives a save and a load into a fresh game', async () => {
    const a = await startRig(bench, sources, 'fps');
    const me = a.g.world.find('player')!;
    me.position.set(12, 0, -10);
    a.step(3);
    expect(me.get(Respawn)!.id).toBe('cp2');
    expect(a.g.world.find('saves')!.get(SaveSlots)!.save(1)).toBe(true);
    const saves = kitIO.saves();
    a.g.dispose();

    const b = await startRig(bench, sources, 'fps');
    kitIO.useSaves(saves);
    const re = b.g.world.find('player')!.get(Respawn)!;
    expect(re.id).toBe('');
    expect(b.g.world.find('saves')!.get(SaveSlots)!.load(1)).toBe(true);
    expect(re.id).toBe('cp2');
    const hp = b.g.world.find('player')!.get(Health)!;
    re.delay = 0.1;
    b.g.world.find('player')!.position.set(-20, 0, 8);
    b.step(1);
    hp.damage(1000);
    b.step(20);
    expect(hp.dead).toBe(false);
    expect(b.g.world.find('player')!.position.x).toBeCloseTo(12, 1);
    expect(b.g.world.find('player')!.position.z).toBeCloseTo(-10, 1);
    kitIO.useSaves(null);
  });

  it('replays to the same checksum', async () => {
    const run = async (): Promise<string> => {
      const { rig, checksum } = await runScenario({
        def: bench, sources, inputMap: 'fps', steps: 400,
        input: () => ({ move: { y: -1 } }),
        at: {
          100: (rg) => rg.g.world.find('player')!.get(Health)!.damage(1000),
          250: (rg) => { rg.g.world.find('saves')!.get(SaveSlots)!.save(2); },
          300: (rg) => { rg.g.world.find('saves')!.get(SaveSlots)!.load(2); },
        },
      });
      rig.g.dispose();
      return checksum;
    };
    expect(await run()).toBe(await run());
  });
});
