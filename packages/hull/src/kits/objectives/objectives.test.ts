import { describe, expect, it } from 'vitest';
import { defineGame } from '../../core/index.ts';
import { SaveSlots } from '../saves/saves.ts';
import { ALL_KITS, kitSources, runScenario, startRig } from '../testing.ts';
import bench from './bench.ts';
import { Objectives } from './objectives.ts';

const sources = kitSources(...ALL_KITS);

describe('objectives kit', () => {
  it('counts toward a goal, completes it, and fires the signals', async () => {
    const r = await startRig(bench, sources, '');
    const o = r.g.world.find('objectives')!.get(Objectives)!;
    const log: string[] = [];
    o.changed.connect((id) => log.push(`changed:${id}`));
    o.completed.connect((id) => log.push(`done:${id}`));
    o.allDone.connect(() => log.push('all'));
    expect(o.progress('gems', 2)).toBe(true);
    expect(o.line(o.get('gems')!)).toBe('Collect the gems (2/5)');
    expect(o.progress('gems', 10)).toBe(true); // clamps at the count
    expect(o.get('gems')!.have).toBe(5);
    expect(o.progress('gems')).toBe(false); // already done
    expect(o.progress('nothing')).toBe(false);
    o.complete('door');
    expect(o.remaining).toBe(1);
    expect(log).toEqual(['changed:gems', 'changed:gems', 'done:gems', 'changed:door', 'done:door']);
    o.complete('exit');
    expect(log.slice(-3)).toEqual(['changed:exit', 'done:exit', 'all']);
    expect(o.finished).toBe(true);
    o.add('bonus', 'A bonus');
    expect(o.finished).toBe(false);
    o.complete('bonus');
    expect(log.filter((l) => l === 'all')).toHaveLength(2);
  });

  it('survives a save and a load', async () => {
    const def = defineGame({
      ready(g) {
        bench.ready(g);
        g.world.spawn('saves').add(SaveSlots);
      },
    });
    const r = await startRig(def, sources, '');
    const o = r.g.world.find('objectives')!.get(Objectives)!;
    const saves = r.g.world.find('saves')!.get(SaveSlots)!;
    o.progress('gems', 3);
    o.complete('door');
    expect(saves.save(1)).toBe(true);
    o.progress('gems', 2);
    o.complete('exit');
    expect(o.finished).toBe(true);
    const v = o.version;
    expect(saves.load(1)).toBe(true);
    expect(o.get('gems')!.have).toBe(3);
    expect(o.isDone('gems')).toBe(false);
    expect(o.isDone('door')).toBe(true);
    expect(o.isDone('exit')).toBe(false);
    expect(o.finished).toBe(false);
    expect(o.version).toBeGreaterThan(v);
    let all = 0;
    o.allDone.connect(() => all++);
    o.progress('gems', 2);
    o.complete('exit');
    expect(all).toBe(1);
  });

  it('replays to the same checksum and the progress is part of it', async () => {
    const run = (n: number) => runScenario({
      def: bench, sources, inputMap: '', steps: 60, seed: 2, input: () => ({}),
      at: { 10: (rig) => rig.g.world.find('objectives')!.get(Objectives)!.progress('gems', n) },
    });
    const a = await run(2);
    expect((await run(2)).checksum).toBe(a.checksum);
    expect((await run(3)).checksum).not.toBe(a.checksum);
  });
});
