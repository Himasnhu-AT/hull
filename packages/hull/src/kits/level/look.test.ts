// The level kits put the page in a look: ArenaLevel names 'look/day' by default, '' applies none, and a config-built Level
// applies the look its file names unless told not to.
import { afterEach, describe, expect, it } from 'vitest';
import { defineGame } from '../../core/index.ts';
import { ALL_KITS, kitSources, startRig } from '../testing.ts';
import { Level } from './built.ts';
import { ArenaLevel } from './level.ts';

const sources = kitSources(...ALL_KITS);
const looks: string[] = [];
const g = globalThis as { hull?: Record<string, unknown> };
afterEach(() => { delete g.hull; looks.length = 0; });

const withRender = (): void => { g.hull = { render: { setLook: (id: string) => looks.push(id) } }; };

describe('level looks', () => {
  it('ArenaLevel applies look/day by default, once, when the renderer is there', async () => {
    const r = await startRig(defineGame({ ready(game) { game.world.spawn('level').add(ArenaLevel); } }), sources, '');
    r.g.frame(0); // no renderer yet: nothing to apply, and no error
    expect(looks).toEqual([]);
    withRender();
    r.g.frame(0);
    expect(looks).toEqual(['look/day']);
    r.g.frame(0);
    expect(looks).toEqual(['look/day']);
  });

  it('ArenaLevel takes another look, or none', async () => {
    withRender();
    const night = await startRig(defineGame({ ready(game) { game.world.spawn('level').add(ArenaLevel, { look: 'look/day' }); } }), sources, '');
    night.g.frame(0);
    expect(looks).toEqual(['look/day']);
    looks.length = 0;
    const none = await startRig(defineGame({ ready(game) { game.world.spawn('level').add(ArenaLevel, { look: '' }); } }), sources, '');
    none.g.frame(0);
    expect(looks).toEqual([]);
  });

  it('a look the project does not have is skipped, not applied', async () => {
    withRender();
    const r = await startRig(defineGame({ ready(game) { game.world.spawn('level').add(ArenaLevel, { look: 'look/missing' }); } }), sources, '');
    r.g.frame(0);
    expect(looks).toEqual([]);
  });

  it('Level applies the look its file names unless applyLook is false', async () => {
    withRender();
    const on = await startRig(defineGame({ ready(game) { game.world.spawn('level').add(Level, { level: 'yard' }); } }), sources, '');
    on.g.frame(0);
    expect(looks).toEqual(['look/day']);
    looks.length = 0;
    const off = await startRig(defineGame({ ready(game) { game.world.spawn('level').add(Level, { level: 'yard', applyLook: false }); } }), sources, '');
    off.g.frame(0);
    expect(looks).toEqual([]);
  });
});
