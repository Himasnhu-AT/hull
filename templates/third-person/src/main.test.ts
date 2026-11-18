/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { Health, PauseMenu, SaveSlots, Spawner, Stock } from 'hull/kits';
import { projectSources, runScenario, type Rig } from 'hull/kits/testing';
import type { StepSnapshot } from 'hull/input';
import { describe, expect, it } from 'vitest';
import game from './main.ts';

const sources = projectSources(fileURLToPath(new URL('..', import.meta.url)));
const STEPS = 1500;
const SAVE_AT = 1000;
const LOAD_AT = 1250;
const PAUSE_AT = 800;
const PAUSE_END = 860;

/** Runs at the nearest enemy (boosting when it is far) and swings; with gas spent or hurt it goes for a pickup. */
function bot(i: number, rig: Rig): StepSnapshot {
  const w = rig.g.world;
  const me = w.find('player')!;
  if (i === PAUSE_AT || i === PAUSE_END) return { pause: { d: 1, p: 1 } };
  if (i > PAUSE_AT && i < PAUSE_END) return { move: { y: -1 } };
  const hp = me.get(Health)!;
  const gas = me.get(Stock)!;
  const hurt = hp.hp < hp.max || gas.get('gas') < 40;
  const list = hurt && i > 300 ? w.group('pickup').filter((p) => p.object3d.visible) : w.group('enemy');
  let best: { dx: number; dz: number; d: number } | null = null;
  for (const n of list) {
    const dx = n.position.x - me.position.x;
    const dz = n.position.z - me.position.z;
    const d = Math.hypot(dx, dz);
    if (!best || d < best.d) best = { dx, dz, d };
  }
  if (!best) return {};
  // The camera has not turned, so forward on the stick is -z: the stick is the direction to the target.
  const snap: StepSnapshot = { move: { x: best.dx / best.d, y: best.dz / best.d } };
  if (best.d > 9 && gas.get('gas') > 5) snap['boost'] = { d: 1 };
  if (!hurt && best.d < 2.2) snap['attack'] = { d: 1 };
  return snap;
}

describe('third-person template', () => {
  it('moves, takes damage, picks up, pauses, saves and loads; its recorded input replays to the same checksum twice', async () => {
    const seen = { minHp: 1e9, minGas: 1e9, pickedUp: 0, pausedSteps: 0, pausedMoved: 0, saved: null as null | { x: number; z: number; hp: number }, loadedOk: false, moved: 0, maxSpeed: 0 };
    let last: { x: number; z: number } | null = null;
    let prevHp = 100;
    let prevGas = 100;
    const at = {
      [SAVE_AT]: (rig: Rig) => {
        const me = rig.g.world.find('player')!;
        seen.saved = { x: me.position.x, z: me.position.z, hp: me.get(Health)!.hp };
        expect(rig.g.world.find('saves')!.get(SaveSlots)!.save(1)).toBe(true);
      },
      [LOAD_AT]: (rig: Rig) => {
        const me = rig.g.world.find('player')!;
        expect(rig.g.world.find('saves')!.get(SaveSlots)!.load(1)).toBe(true);
        seen.loadedOk = Math.abs(me.position.x - seen.saved!.x) < 1e-9 && Math.abs(me.position.z - seen.saved!.z) < 1e-9 && me.get(Health)!.hp === seen.saved!.hp;
      },
    };
    const observe = (i: number, rig: Rig): void => {
      const me = rig.g.world.find('player')!;
      const hp = me.get(Health)!.hp;
      const gas = me.get(Stock)!.get('gas');
      seen.minHp = Math.min(seen.minHp, hp);
      seen.minGas = Math.min(seen.minGas, gas);
      if ((hp > prevHp || gas > prevGas) && i < SAVE_AT - 1) seen.pickedUp++;
      prevHp = hp;
      prevGas = gas;
      if (rig.g.world.find('pause')!.get(PauseMenu)!.paused) { seen.pausedSteps++; if (last) seen.pausedMoved += Math.hypot(me.position.x - last.x, me.position.z - last.z); }
      if (last && i < PAUSE_AT) {
        const d = Math.hypot(me.position.x - last.x, me.position.z - last.z);
        seen.moved += d;
        seen.maxSpeed = Math.max(seen.maxSpeed, d * 60);
      }
      last = { x: me.position.x, z: me.position.z };
    };
    const run = await runScenario({ def: game, sources, inputMap: 'third-person', steps: STEPS, input: bot, at, observe });
    const sp = run.rig.g.world.find('spawner')!.get(Spawner)!;
    console.log(`third-person scenario: min hp ${seen.minHp.toFixed(0)}, min gas ${seen.minGas.toFixed(0)}, pickups ${seen.pickedUp}, paused ${seen.pausedSteps} steps, moved ${seen.moved.toFixed(1)} m, top speed ${seen.maxSpeed.toFixed(1)}, wave ${sp.wave}, kills ${sp.kills}, sounds ${JSON.stringify(run.rig.sounds)}, checksum ${run.checksum}`);
    expect(seen.moved).toBeGreaterThan(10);
    expect(seen.maxSpeed).toBeGreaterThan(14);
    expect(seen.minHp).toBeLessThan(100);
    expect(seen.minGas).toBeLessThan(100);
    expect(seen.pickedUp).toBeGreaterThanOrEqual(1);
    expect(seen.pausedSteps).toBeGreaterThanOrEqual(PAUSE_END - PAUSE_AT - 1);
    expect(seen.pausedMoved).toBeLessThan(1e-9);
    expect(seen.loadedOk).toBe(true);
    expect(sp.kills).toBeGreaterThanOrEqual(1);
    expect(run.rig.sounds['sound/swing']).toBeGreaterThan(0);
    expect(run.recording).toHaveLength(STEPS);
    run.rig.g.dispose();

    const replay = async (): Promise<string> => {
      const r = await runScenario({ def: game, sources, inputMap: 'third-person', steps: STEPS, input: (i) => run.recording[i]!, at });
      const c = r.checksum;
      r.rig.g.dispose();
      return c;
    };
    expect(await replay()).toBe(run.checksum);
    expect(await replay()).toBe(run.checksum);
  });
});
