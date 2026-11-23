import { describe, expect, it } from 'vitest';
import type { StepSnapshot } from '../../input/index.ts';
import { ALL_KITS, kitSources, runScenario, startRig } from '../testing.ts';
import { FirstPerson } from '../fps/fps.ts';
import { SaveSlots } from '../saves/saves.ts';
import { Interactable } from '../interact/interact.ts';
import { Inventory } from './inventory.ts';
import bench from './bench.ts';

const sources = kitSources(...ALL_KITS, 'interact', 'checkpoint', 'projectile');

describe('inventory kit', () => {
  it('holds counts within slots and stack limits and says what did not fit', async () => {
    const r = await startRig(bench, sources, 'fps');
    const inv = r.g.world.find('player')!.get(Inventory)!;
    const changes: string[] = [];
    const lost: string[] = [];
    inv.changed.connect((n, c) => changes.push(`${n}=${c}`));
    inv.full.connect((n, left) => lost.push(`${n}:${left}`));
    expect(inv.add('key', 5)).toBe(3); // stack limit 3
    expect(inv.add('gem', 1)).toBe(1);
    expect(inv.add('map', 1)).toBe(0); // two slots only
    expect(inv.slots).toBe(2);
    expect(inv.total).toBe(4);
    expect(inv.remove('key', 4)).toBe(false);
    expect(inv.remove('key', 3)).toBe(true);
    expect(inv.has('key')).toBe(false);
    expect(inv.add('map', 1)).toBe(1); // the freed slot
    inv.limits.map = 1;
    expect(inv.add('map', 1)).toBe(0);
    expect(inv.clear('gem')).toBe(1);
    expect(changes).toEqual(['key=3', 'gem=1', 'key=0', 'map=1', 'gem=0']);
    expect(lost).toEqual(['key:2', 'map:1', 'map:1']);
  });

  it('is filled through an interactable, and saves and loads', async () => {
    const a = await startRig(bench, sources, 'fps');
    const inv = a.g.world.find('player')!.get(Inventory)!;
    a.step(2);
    a.step(1, { interact: { d: 1, p: 1 } });
    a.step(2);
    a.step(1, { interact: { d: 1, p: 1 } });
    expect(inv.count('key')).toBe(2);
    expect(a.g.world.find('crate')!.get(Interactable)!.uses).toBe(2);
    a.g.world.find('saves')!.get(SaveSlots)!.save(1);
    inv.add('gem', 2);
    const saved = inv.items;
    a.g.world.find('saves')!.get(SaveSlots)!.load(1);
    expect(inv.items).toBe(saved); // filled in place
    expect(inv.count('gem')).toBe(0);
    expect(inv.count('key')).toBe(2);
  });

  it('replays to the same checksum', async () => {
    const run = async (): Promise<string> => {
      const { rig, checksum } = await runScenario({
        def: bench, sources, inputMap: 'fps', steps: 150, input: (i): StepSnapshot => (i % 30 === 5 ? { interact: { d: 1, p: 1 } } : {}),
      });
      rig.g.dispose();
      return checksum;
    };
    expect(await run()).toBe(await run());
  });
});
