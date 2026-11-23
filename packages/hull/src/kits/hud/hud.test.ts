import { afterEach, describe, expect, it } from 'vitest';
import { defineGame } from '../../core/index.ts';
import { fakeUi } from '../fake-ui.ts';
import { GROUP, flagsOf } from '../common.ts';
import { Objectives } from '../objectives/objectives.ts';
import { ALL_KITS, kitSources, runScenario, startRig } from '../testing.ts';
import bench from './bench.ts';
import { Hud, hudTuning } from './hud.ts';

const sources = kitSources(...ALL_KITS);
let undo: (() => void) | null = null;
afterEach(() => { undo?.(); undo = null; });

describe('hud kit', () => {
  it('shows each slot and updates it as the game changes', async () => {
    let score = 0;
    let left = 30.2;
    let stamina = 100;
    const def = defineGame({
      ready(g) {
        g.world.spawn('hud').add(Hud).score(() => score).timer(() => left, { countDown: true }).objective('Reach the tower').bar('Stamina', () => stamina, 100);
      },
    });
    const r = await startRig(def, sources, '');
    const ui = fakeUi();
    undo = ui.install(r.g);
    expect(ui.texts()).toEqual([]);
    r.g.frame(0);
    expect(ui.texts()).toEqual(['STAMINA', 'SCORE', '0', 'TIME', '0:31', 'OBJECTIVE', 'Reach the tower']);
    expect(ui.bars()).toEqual([['Stamina', 100, 100]]);
    score = 120.9; left = 4; stamina = 25;
    r.g.frame(0);
    expect(ui.texts()).toContain('120');
    expect(ui.texts()).toContain('0:04');
    expect(ui.bars()).toEqual([['Stamina', 25, 100]]);
    // A slot added after the screen was built appears too.
    r.g.world.find('hud')!.get(Hud)!.bar('Heat', () => 5, 10);
    r.g.frame(0);
    expect(ui.bars().map((b) => b[0])).toEqual(['Stamina', 'Heat']);
  });

  it('a prompt shows while set and goes when cleared', async () => {
    const r = await startRig(bench, sources, '');
    const ui = fakeUi();
    undo = ui.install(r.g);
    r.g.frame(0);
    const hud = r.g.world.find('hud')!.get(Hud)!;
    expect(ui.texts()).toContain('E to open');
    hud.prompt(null);
    r.g.frame(0);
    expect(ui.texts()).not.toContain('E to open');
    hud.prompt('Press F');
    r.g.frame(0);
    expect(ui.texts()).toContain('Press F');
  });

  it('messages show one at a time for their seconds of game time, and not while paused', async () => {
    const def = defineGame({ ready(g) { g.world.spawn('hud').add(Hud); } });
    const r = await startRig(def, sources, '');
    const ui = fakeUi();
    undo = ui.install(r.g);
    const hud = r.g.world.find('hud')!.get(Hud)!;
    hud.message('first', 1).message('second', 2).message('third');
    r.step(30); r.g.frame(0);
    expect(ui.texts()).toEqual(['first']);
    flagsOf(r.g.world).paused = true;
    r.step(120); r.g.frame(0);
    expect(ui.texts()).toEqual(['first']); // the toast waits while paused
    flagsOf(r.g.world).paused = false;
    r.step(31); r.g.frame(0);
    expect(ui.texts()).toEqual(['second']);
    r.step(120); r.g.frame(0);
    expect(ui.texts()).toEqual(['third']);
    r.step(Math.ceil(hudTuning.messageSeconds * 60) + 2); r.g.frame(0);
    expect(ui.texts()).toEqual([]);
    expect(hud.queue.length).toBe(0);
  });

  it('lists the objectives of a node named "objectives"', async () => {
    const def = defineGame({
      ready(g) {
        g.world.spawn('hud').add(Hud);
        const o = g.world.spawn('objectives').addTo(GROUP.save).add(Objectives);
        o.add('gems', 'Collect gems', { count: 3 });
        o.add('door', 'Open the door');
      },
    });
    const r = await startRig(def, sources, '');
    const ui = fakeUi();
    undo = ui.install(r.g);
    r.g.frame(0);
    expect(ui.texts()).toEqual(['OBJECTIVE', 'Collect gems (0/3)', 'Open the door']);
    const o = r.g.world.find('objectives')!.get(Objectives)!;
    o.progress('gems', 3);
    r.g.frame(0);
    expect(ui.texts()).toEqual(['OBJECTIVE', '[x] Collect gems (3/3)', 'Open the door']);
  });

  it('the bench replays to the same checksum, and messages are part of it', async () => {
    const run = (seed: number, steps = 400) => runScenario({ def: bench, sources, inputMap: '', steps, seed, input: () => ({}) });
    const a = await run(3);
    const b = await run(3);
    expect(b.checksum).toBe(a.checksum);
    const c = await run(3, 60);
    expect(c.checksum).not.toBe(a.checksum);
    expect(a.rig.g.world.find('hud')!.get(Hud)!.current).toBe('');
  });
});
