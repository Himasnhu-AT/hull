// The UI layer rules the kits share: HUD panels step aside for a menu, a game can hide one, a menu's first button has
// focus and answers Enter and Space, a stock shows only what the game has, and a result screen shows every row it is given.
import { afterEach, describe, expect, it } from 'vitest';
import { defineGame } from '../core/index.ts';
import { fakeUi } from './fake-ui.ts';
import { Hud } from './hud/hud.ts';
import { ResultScreen, TitleScreen } from './menu/menu.ts';
import { PauseMenu } from './pause/pause.ts';
import { Stock, StockHud } from './pickups/pickups.ts';
import { ALL_KITS, kitSources, startRig } from './testing.ts';

const sources = kitSources(...ALL_KITS, 'menu');
let undo: (() => void) | null = null;
afterEach(() => { undo?.(); undo = null; });

const game = defineGame({
  ready(g) {
    g.world.spawn('title').add(TitleScreen, { title: 'Layers' });
    g.world.spawn('results').add(ResultScreen);
    g.world.spawn('hud').add(Hud).score(() => 7).objective('Reach the tower');
  },
});

describe('ui layers', () => {
  it('a menu hides the HUD behind it, and the HUD returns when the menu goes', async () => {
    const r = await startRig(game, sources, 'fps');
    const ui = fakeUi();
    undo = ui.install(r.g);
    r.g.frame(0);
    r.g.frame(0);
    expect(ui.texts()).toEqual(['Layers']); // the title only: no SCORE, no OBJECTIVE
    ui.press('Start');
    r.g.frame(0);
    r.g.frame(0);
    expect(ui.texts()).toEqual(expect.arrayContaining(['SCORE', '7', 'Reach the tower']));
    r.g.world.find('results')!.get(ResultScreen)!.show(false, { Score: 7 });
    r.g.frame(0);
    r.g.frame(0);
    expect(ui.texts()).toEqual(['Defeat', 'Score', '7']);
    r.g.world.find('results')!.get(ResultScreen)!.playAgain();
    r.g.frame(0);
    r.g.frame(0);
    expect(ui.texts()).toContain('SCORE');
  });

  it('the pause menu also clears the HUD', async () => {
    const def = defineGame({ ready(g) {
      g.world.spawn('pause').add(PauseMenu);
      g.world.spawn('hud').add(Hud).score(() => 1);
    } });
    const r = await startRig(def, sources, 'fps');
    const ui = fakeUi();
    undo = ui.install(r.g);
    r.g.frame(0);
    expect(ui.texts()).toContain('SCORE');
    r.g.world.find('pause')!.get(PauseMenu)!.set(true);
    r.g.frame(0);
    r.g.frame(0);
    expect(ui.texts()).not.toContain('SCORE');
    expect(ui.texts()).toContain('Paused');
  });

  it('a game can hide one KitUi with show(false)', async () => {
    const r = await startRig(game, sources, 'fps');
    const ui = fakeUi();
    undo = ui.install(r.g);
    r.g.world.find('title')!.get(TitleScreen)!.start();
    r.g.frame(0);
    r.g.frame(0);
    const hud = r.g.world.find('hud')!.get(Hud)!;
    expect(ui.texts()).toContain('SCORE');
    hud.show(false);
    r.g.frame(0);
    expect(ui.texts()).not.toContain('SCORE');
    hud.show(true);
    r.g.frame(0);
    expect(ui.texts()).toContain('SCORE');
  });

  it('a menu opens with its first button focused; Enter and Space press it, even when focus was lost', async () => {
    const r = await startRig(game, sources, 'fps');
    const ui = fakeUi();
    undo = ui.install(r.g);
    r.g.frame(0);
    expect(ui.focused()).toBe('Start');
    expect(ui.key('Enter')).toBe(true);
    expect(r.g.world.find('title')!.get(TitleScreen)!.started).toBe(true);
    // A result screen: focus moved away (a click on the canvas), then Space still plays again.
    const res = r.g.world.find('results')!.get(ResultScreen)!;
    let again = 0;
    res.again.connect(() => again++);
    res.show(true, { Time: 3 });
    r.g.frame(0);
    expect(ui.focused()).toBe('Play again');
    ui.root.all()[0]!.focus();
    expect(ui.focused()).toBe(null);
    expect(ui.key(' ')).toBe(true);
    expect(again).toBe(1);
  });

  it('a stock panel shows only the resources the game has', async () => {
    const def = defineGame({ ready(g) {
      const p = g.world.spawn('player');
      p.add(Stock, { caps: { ammo: 30 } });
      p.add(StockHud, { names: ['gas', 'ammo', 'blades'] });
    } });
    const r = await startRig(def, sources, '');
    const ui = fakeUi();
    undo = ui.install(r.g);
    r.g.frame(0);
    r.g.frame(0);
    expect(ui.texts()).toEqual(['AMMO', '0 / 30']);
    r.g.world.find('player')!.get(Stock)!.add('blades', 2);
    r.g.frame(0);
    expect(ui.texts()).toEqual(['AMMO', '0 / 30', 'BLADES', '2']);
  });

  it('a result screen shows every stat row it is given, up to eight', async () => {
    const r = await startRig(game, sources, 'fps');
    const ui = fakeUi();
    undo = ui.install(r.g);
    r.g.world.find('title')!.get(TitleScreen)!.start();
    const res = r.g.world.find('results')!.get(ResultScreen)!;
    res.show(true, { Time: '1:20', Kills: 12, Score: 340 });
    r.g.frame(0);
    expect(ui.texts()).toEqual(['Victory', 'Time', '1:20', 'Kills', '12', 'Score', '340']);
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Row ${i + 1}`, i + 1]));
    res.show(true, many);
    r.g.frame(0);
    expect(ui.texts().length).toBe(1 + 8 * 2);
    // A zero is a row, not an empty one, and so is a label made of digits.
    res.show(true, { Deaths: 0, 3: 'x' });
    r.g.frame(0);
    expect(ui.texts()).toEqual(['Victory', '3', 'x', 'Deaths', '0']);
  });
});
