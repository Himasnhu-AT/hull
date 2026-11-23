/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { GROUP, Health, Interactable, Inventory, LAYER, Level, Objectives, PauseMenu, ResultScreen, SaveSlots, TitleScreen, flagsOf } from 'hull/kits';
import { projectSources, startRig, type Rig } from 'hull/kits/testing';
import type { StepSnapshot } from 'hull/input';
import { physicsOf, type Physics } from 'hull/physics';
import { describe, expect, it } from 'vitest';
import game from './main.ts';

const sources = projectSources(fileURLToPath(new URL('..', import.meta.url)));
const USE: StepSnapshot = { interact: { d: 1, p: 1 } };

async function begin(seed = 3): Promise<Rig> {
  const r = await startRig(game, sources, 'third-person', seed);
  r.step(2);
  r.g.world.find('title')!.get(TitleScreen)!.start();
  return r;
}
const me = (r: Rig) => r.g.world.find('player')!;
/** A relic by its name, or the altar: the level's things are children of the level node, which `find` does not search. */
const thing = (r: Rig, name: string) => (name === 'altar' ? r.g.world.group('altar')[0]! : r.g.world.group('relic').find((n) => n.name === name)!);
/** Stands the player south of a node (facing north, where the interact search looks) and presses E. */
function use(r: Rig, name: string): void {
  const n = thing(r, name);
  me(r).position.set(n.position.x, n.position.y, n.position.z + (name === 'altar' ? 2.2 : 1));
  r.step(2);
  r.step(1, USE);
}
/** What the game's probes report, read from the nodes they read (there is no public probe reader for tests; the play script checks the probes). */
const read = (r: Rig) => ({
  get carrying(): number { return me(r).get(Inventory)!.count('relic'); },
  get relicsHome(): number { return r.g.world.find('objectives')!.get(Objectives)!.get('relics')?.have ?? 0; },
  get sentries(): number { return r.g.world.group(GROUP.enemy).length; },
});
const results = (r: Rig) => r.g.world.find('results')!.get(ResultScreen)!;

describe('relic yard', () => {
  it('is won by carrying all three relics to the altar', async () => {
    const r = await begin();
    const w = r.g.world;
    me(r).get(Health)!.max = me(r).get(Health)!.hp = 1e6; // the sentries are not what this test is about
    expect(w.find('level')!.get(Level)!.things('prefab/relic')).toHaveLength(3);
    // A bag holds two relics: the third stays on its plinth until there is room.
    for (const i of [0, 1, 2]) use(r, 'relic' + i);
    expect(read(r).carrying).toBe(2);
    expect(thing(r, 'relic0').object3d.visible).toBe(false);
    expect(thing(r, 'relic2').get(Interactable)!.enabled).toBe(true);
    for (let home = 1; home <= 2; home++) { use(r, 'altar'); expect(read(r).relicsHome).toBe(home); }
    use(r, 'relic2');
    expect(read(r).carrying).toBe(1);
    use(r, 'altar');
    expect(read(r).relicsHome).toBe(3);
    expect(read(r).carrying).toBe(0);
    expect(w.find('objectives')!.get(Objectives)!.isDone('relics')).toBe(true);
    expect(results(r).shown).toBe(true);
    expect(results(r).won).toBe(true);
    expect(results(r).rows.map((x) => x[0])).toEqual(['Time', 'Relics', 'Health']);
    expect(results(r).rows[1]![1]).toBe('3');
    r.g.dispose();
  });

  it('has sentries that path around the barrier and wear a standing player down to a loss', async () => {
    const r = await begin();
    const w = r.g.world;
    const level = w.find('level')!.get(Level)!;
    const from = level.marker('sentry/north')!;
    const spot = { x: 2, z: 0 }; // the long barrier across the yard is between this and the north sentry
    const line = physicsOf(w) as Physics;
    const len = Math.hypot(spot.x - from.x, spot.z - from.z);
    const blocked = line.raycast({ x: from.x, y: 0.9, z: from.z }, { x: (spot.x - from.x) / len, y: 0, z: (spot.z - from.z) / len }, len, { mask: LAYER.world });
    expect(blocked).not.toBeNull();
    const sentries = w.group(GROUP.enemy);
    expect(sentries).toHaveLength(3);
    for (const s of sentries) if (Math.abs(s.position.x - from.x) > 0.5) s.destroy();
    r.step(1);
    expect(read(r).sentries).toBe(1);
    const hp = me(r).get(Health)!;
    let met = false;
    for (let i = 0; i < 1500 && !hp.dead; i++) {
      me(r).position.set(spot.x, 0, spot.z);
      r.step(1);
      if (hp.hp < hp.max) met = true;
    }
    expect(met).toBe(true);
    expect(hp.dead).toBe(true);
    expect(results(r).shown).toBe(true);
    expect(results(r).won).toBe(false);
    r.g.dispose();
  });

  it('holds at the title, saves and loads a half-done run, heals from a pickup and starts again', async () => {
    const r = await startRig(game, sources, 'third-person', 3);
    const w = r.g.world;
    const flags = flagsOf(w);
    r.step(5, { move: { y: -1 } });
    expect(me(r).position.z).toBeCloseTo(14, 1);
    r.step(1, { pause: { d: 1, p: 1 } });
    r.step(5, { move: { y: -1 } });
    expect(flags.paused).toBe(true);
    expect(me(r).position.z).toBeCloseTo(14, 1);
    w.find('title')!.get(TitleScreen)!.start();
    r.step(2);
    expect(flags.paused).toBe(false);
    use(r, 'relic0');
    const saves = w.find('saves')!.get(SaveSlots)!;
    saves.save(1);
    use(r, 'altar');
    expect(read(r).relicsHome).toBe(1);
    use(r, 'relic1');
    saves.load(1);
    r.step(3);
    expect(read(r).relicsHome).toBe(0);
    expect(read(r).carrying).toBe(1);
    expect(thing(r, 'relic0').get(Interactable)!.enabled).toBe(false);
    expect(thing(r, 'relic1').get(Interactable)!.enabled).toBe(true);
    expect(thing(r, 'relic1').object3d.visible).toBe(true);
    expect(w.find('pause')!.get(PauseMenu)!.paused).toBe(false);

    const hp = me(r).get(Health)!;
    hp.hp = 40;
    const pickup = w.group('pickup')[0]!;
    me(r).position.set(pickup.position.x, 0, pickup.position.z);
    r.step(3);
    expect(hp.hp).toBeGreaterThan(40);

    hp.damage(1e6);
    r.step(2);
    expect(results(r).shown).toBe(true);
    results(r).playAgain();
    r.step(2);
    expect(results(r).shown).toBe(false);
    expect(flags.paused).toBe(false);
    expect(hp.dead).toBe(false);
    expect(hp.hp).toBe(hp.max);
    expect(me(r).position.z).toBeCloseTo(14, 0);
    expect(w.find('player')!.get(Inventory)!.count('relic')).toBe(0);
    expect(thing(r, 'relic0').get(Interactable)!.enabled).toBe(true);
    expect(read(r).relicsHome).toBe(0);
    expect(read(r).sentries).toBe(3);
    r.g.dispose();
  });
});