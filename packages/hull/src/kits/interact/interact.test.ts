import { describe, expect, it } from 'vitest';
import type { StepSnapshot } from '../../input/index.ts';
import { ALL_KITS, kitSources, runScenario, startRig } from '../testing.ts';
import { FirstPerson } from '../fps/fps.ts';
import { Interactable, Interactor } from './interact.ts';
import bench from './bench.ts';

const sources = kitSources(...ALL_KITS, 'interact', 'checkpoint', 'projectile');

const press = { interact: { d: 1 as const, p: 1 as const } };

describe('interact kit', () => {
  it('picks the nearest one in front, and ignores one behind, behind a wall, or out of radius', async () => {
    const r = await startRig(bench, sources, 'fps');
    const w = r.g.world;
    const eye = w.find('player')!.get(FirstPerson)!.eye;
    const me = eye.get(Interactor)!;
    const lever = w.find('lever')!.get(Interactable)!;
    const chest = w.find('chest')!.get(Interactable)!;
    const door = w.find('door')!.get(Interactable)!;
    r.step(2);
    expect(me.target).toBe(lever); // the chest is 3 m behind, the door is behind the wall
    expect(me.promptText).toBe('[E] Pull lever');
    lever.enabled = false;
    r.step(1);
    expect(me.target).toBe(null); // chest behind; door behind the wall (12 m reach would allow it)
    expect(me.promptText).toBe('');
    // Out of radius: the lever at 2 m with a reach of 1.
    lever.enabled = true;
    lever.radius = 1;
    r.step(1);
    expect(me.target).toBe(null);
    lever.radius = 0;
    // Take the wall away and the door counts.
    lever.enabled = false;
    w.find('wall')!.destroy();
    r.step(2);
    expect(me.target).toBe(door);
    void chest;
  });

  it('uses the target on the interact action, once, and a once-only one switches off', async () => {
    const r = await startRig(bench, sources, 'fps');
    const w = r.g.world;
    const lever = w.find('lever')!.get(Interactable)!;
    lever.once = true;
    const by: string[] = [];
    lever.used.connect((n) => by.push(n.name));
    r.step(2);
    r.step(1, press);
    r.step(3, press);
    expect(lever.uses).toBe(1);
    expect(by.length).toBe(1);
    expect(lever.enabled).toBe(false);
    expect(r.sounds['sound/interact']).toBe(1);
  });

  it('replays to the same checksum', async () => {
    const run = async (): Promise<string> => {
      const { rig, checksum } = await runScenario({
        def: bench, sources, inputMap: 'fps', steps: 120,
        input: (i): StepSnapshot => (i % 40 === 10 ? press : i % 40 < 20 ? { look: { x: 3, y: 0 } } : {}),
      });
      rig.g.dispose();
      return checksum;
    };
    expect(await run()).toBe(await run());
  });
});
