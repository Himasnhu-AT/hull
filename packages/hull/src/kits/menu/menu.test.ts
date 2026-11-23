import { afterEach, describe, expect, it } from 'vitest';
import type { StepSnapshot } from '../../input/index.ts';
import { fakeUi } from '../fake-ui.ts';
import { flagsOf } from '../common.ts';
import { ALL_KITS, kitSources, runScenario, startRig } from '../testing.ts';
import bench from './bench.ts';
import { ResultScreen, TitleScreen } from './menu.ts';

const sources = kitSources(...ALL_KITS, 'menu');
const press: StepSnapshot = { pause: { d: 1, p: 1 } };
let undo: (() => void) | null = null;
afterEach(() => { undo?.(); undo = null; });

describe('menu kit', () => {
  it('the title screen holds the pause flag until Start, even against the pause action', async () => {
    const r = await startRig(bench, sources, 'fps');
    const ui = fakeUi();
    undo = ui.install(r.g);
    const flags = flagsOf(r.g.world);
    const title = r.g.world.find('title')!.get(TitleScreen)!;
    let begun = 0;
    title.begun.connect(() => begun++);
    expect(flags.paused).toBe(true);
    r.step(5, press);
    r.g.frame(0);
    expect(flags.paused).toBe(true);
    expect(ui.texts()).toEqual(['Bench Run', 'Reach ten seconds']);
    expect(ui.press('Start')).toBe(true);
    expect(flags.paused).toBe(false);
    expect(begun).toBe(1);
    r.g.frame(0);
    expect(ui.open()).not.toContain('ui-screen/title');
    expect(ui.texts()).toEqual([]);
    ui.press('Start');
    expect(begun).toBe(1);
  });

  it('the result screen shows the outcome and stats, and Play again restarts through its signal', async () => {
    const r = await startRig(bench, sources, 'fps');
    const ui = fakeUi();
    undo = ui.install(r.g);
    const flags = flagsOf(r.g.world);
    r.g.world.find('title')!.get(TitleScreen)!.start();
    const results = r.g.world.find('results')!.get(ResultScreen)!;
    let again = 0;
    results.again.connect(() => again++);
    r.step(601); // the bench opens it after ten seconds
    r.g.frame(0);
    expect(results.shown).toBe(true);
    expect(flags.paused).toBe(true);
    expect(ui.texts()).toEqual(['Victory', 'Time', '10 s', 'Kills', '0']);
    r.step(3, press); // the pause action cannot dismiss it
    expect(flags.paused).toBe(true);
    results.show(false, { Score: 42 });
    r.g.frame(0);
    expect(ui.texts()).toEqual(['Defeat', 'Score', '42']);
    expect(ui.press('Play again')).toBe(true);
    expect(again).toBe(1);
    expect(flags.paused).toBe(false);
    r.g.frame(0);
    expect(ui.open()).toEqual([]);
  });

  it('replays to the same checksum, and the screens\' state is part of it', async () => {
    const run = (steps: number, pressStart: boolean) => runScenario({
      def: bench, sources, inputMap: 'fps', steps, seed: 5, input: () => ({}),
      at: pressStart ? { 2: (rig) => rig.g.world.find('title')!.get(TitleScreen)!.start() } : {},
    });
    const a = await run(700, true);
    const b = await run(700, true);
    expect(b.checksum).toBe(a.checksum);
    const c = await run(700, false);
    expect(c.checksum).not.toBe(a.checksum);
    expect(a.rig.g.world.find('results')!.get(ResultScreen)!.shown).toBe(true);
  });
});
