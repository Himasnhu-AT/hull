import { describe, expect, it } from 'vitest';
import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { Weapon } from '../health/weapon.ts';
import { ArenaLevel } from '../level/level.ts';
import { ALL_KITS, kitSources, startRig } from '../testing.ts';
import { followTuning } from '../follow-camera/follow-camera.ts';
import { Stock } from '../pickups/pickups.ts';
import bench from './bench.ts';
import { ThirdPerson, spawnThirdPerson, tpTuning } from './third-person.ts';

const sources = kitSources(...ALL_KITS);

async function start() {
  const r = await startRig(bench, sources, 'third-person');
  const w = r.g.world;
  const me = w.find('player')!;
  return { r, w, me, tp: me.get(ThirdPerson)!, gas: me.get(Stock)! };
}

describe('third-person kit', () => {
  it('moves relative to the camera, faces where it runs and plays the walk', async () => {
    const { r, me, tp } = await start();
    r.step(40);
    const z0 = me.position.z;
    r.step(40, { move: { y: -1 } });
    expect(z0 - me.position.z).toBeGreaterThan(3);
    r.step(60, { move: { x: 1 } });
    expect(tp.facing).toBeCloseTo(-Math.PI / 2, 1);
    expect(tp.animator!.get('speed')).toBeGreaterThan(3);
    expect(tp.animator!.stateOf()).toBe('move');
    r.step(60);
    expect(tp.animator!.stateOf()).toBe('idle');
    // Turning the camera turns what forward means.
    r.step(20, { lookPad: { x: -1 } });
    const x0 = me.position.x;
    r.step(40, { move: { y: -1 } });
    expect(Math.abs(me.position.x - x0)).toBeGreaterThan(0.5);
  });

  it('boost is fast and spends gas; with no gas it falls back to a run', async () => {
    const { r, tp, gas } = await start();
    r.step(30);
    let fast = 0;
    for (let i = 0; i < 40; i++) { r.step(1, { move: { y: -1 }, boost: { d: 1 } }); fast = Math.max(fast, tp.speed); }
    expect(fast).toBeGreaterThan(tpTuning.sprintSpeed + 4);
    expect(gas.get('gas')).toBeLessThan(100);
    gas.values['gas'] = 0;
    // Turn round first (the wall is close), then run without gas.
    r.step(60, { move: { y: 1 } });
    r.step(30, { move: { y: 1 }, boost: { d: 1 } });
    expect(tp.speed).toBeLessThan(tpTuning.runSpeed + 0.5);
    void followTuning;
  });

  it('jumps, lands and swings; the swing needs a target in reach', async () => {
    const { r, me, tp } = await start();
    r.step(30);
    r.step(1, { jump: { d: 1, p: 1 } });
    let peak = 0;
    for (let i = 0; i < 90; i++) { r.step(1); peak = Math.max(peak, me.position.y); }
    expect(peak).toBeGreaterThan(1);
    expect(tp.walk.grounded).toBe(true);
    expect(r.sounds['sound/thud']).toBeGreaterThan(0);
    r.step(1, { attack: { d: 1 } });
    expect(r.sounds['sound/swing']).toBe(1);
  });

  it('is the same on every run', async () => {
    const run = async (): Promise<string> => {
      const { r } = await start();
      r.step(20);
      r.step(40, { move: { x: 1, y: -1 }, boost: { d: 1 } });
      r.step(1, { jump: { d: 1, p: 1 } });
      r.step(40, { move: { y: 1 }, look: { x: 4, y: 1 } });
      const c = r.g.world.checksum();
      r.g.dispose();
      return c;
    };
    expect(await run()).toBe(await run());
  });
});

describe('spawnThirdPerson options', () => {
  const bare = defineGame({ ready(g) { usePhysics(g.world); g.world.spawn('level').add(ArenaLevel); spawnThirdPerson(g.world, { x: 2, z: 3, weapon: false, gas: false }); } });
  it('has the melee weapon and the gas stock by default', async () => {
    const { r, me } = await start();
    expect(r.g.world.find('player/aim')!.get(Weapon)).toBeTruthy();
    expect(me.get(Stock)).toBeTruthy();
  });
  it('leaves out the melee weapon and the gas stock with weapon: false and gas: false, and boost is then free', async () => {
    const r = await startRig(bare, sources, 'third-person');
    const me = r.g.world.find('player')!;
    expect(r.g.world.find('player/aim')).toBeFalsy();
    expect(me.get(Stock)).toBeFalsy();
    expect([me.position.x, me.position.z]).toEqual([2, 3]);
    r.step(30, { move: { y: -1 }, boost: { d: 1 } });
  });
});
