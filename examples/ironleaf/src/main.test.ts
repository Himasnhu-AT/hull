/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { FollowCamera, Health } from 'hull/kits';
import { projectSources, runScenario, type Rig } from 'hull/kits/testing';
import type { StepSnapshot } from 'hull/input';
import { describe, expect, it } from 'vitest';
import game from './main.ts';
import { Atmosphere } from './atmosphere';
import { Island } from './world/island';
import { CAST, groundHeight, pampasAmount, surfaceAt, STARTS } from './world/map';

const sources = projectSources(fileURLToPath(new URL('..', import.meta.url)));
const STEPS = 900;
const JUMP_TO_CAMP = 10;

/** Runs forward, then goes to the camp, swings at the nearest raider and presses the look key once. */
function bot(i: number, rig: Rig): StepSnapshot {
  const w = rig.g.world;
  const me = w.find('player')!;
  if (i === 300) return { looks: { d: 1, p: 1 } };
  if (i < JUMP_TO_CAMP) return { move: { y: -1 } };
  let best: { dx: number; dz: number; d: number } | null = null;
  for (const n of w.group('enemy')) {
    const dx = n.position.x - me.position.x, dz = n.position.z - me.position.z;
    const d = Math.hypot(dx, dz);
    if (!best || d < best.d) best = { dx, dz, d };
  }
  if (!best) return {};
  // The stick is relative to the camera's yaw: turn the world direction into it.
  const yaw = w.find('camera')!.get(FollowCamera)!.yaw;
  const wx = best.dx / best.d, wz = best.dz / best.d;
  const snap: StepSnapshot = { move: { x: wx * Math.cos(yaw) - wz * Math.sin(yaw), y: wx * Math.sin(yaw) + wz * Math.cos(yaw) } };
  if (best.d < 2.4) snap['attack'] = { d: 1 };
  return snap;
}

describe('Ironleaf phase 1', () => {
  it('has a map the same every time: ground, surfaces, a pampas field, every raider on solid ground', () => {
    expect(groundHeight(62, -20)).toBeCloseTo(groundHeight(62, -20), 12);
    expect(groundHeight(62, -20)).toBeGreaterThan(5);
    expect(groundHeight(-110, 0)).toBeLessThan(0);
    expect(pampasAmount(-48, 8)).toBeGreaterThan(0.2);
    expect(surfaceAt(-100, 40)).toBe('sand');
    expect(Object.keys(STARTS)).toContain('camp');
    for (const c of CAST) expect(groundHeight(c.x, c.z)).toBeGreaterThan(0.5);
  });

  it('builds the island, stands the raiders, lets the swing land, changes the look, and replays to the same checksum twice', async () => {
    const seen = { moved: 0, minEnemyHp: 1e9, looks: new Set<string>(), enemies: 0, houses: 0, pampas: 0, ayaY: 0 };
    let last: { x: number; z: number } | null = null;
    const at = {
      [JUMP_TO_CAMP]: (rig: Rig) => {
        const me = rig.g.world.find('player')!;
        me.position.set(-30, groundHeight(-30, 16) + 0.05, 16);
      },
    };
    const observe = (i: number, rig: Rig): void => {
      const w = rig.g.world;
      const me = w.find('player')!;
      if (i === 5) {
        seen.enemies = w.group('enemy').length;
        const isl = w.find('island')!.get(Island)!;
        seen.houses = isl.stats.houses;
        seen.pampas = isl.stats.plants['pampas']!;
      }
      if (last && i < JUMP_TO_CAMP) seen.moved += Math.hypot(me.position.x - last.x, me.position.z - last.z);
      last = { x: me.position.x, z: me.position.z };
      seen.ayaY = me.position.y;
      for (const n of w.group('enemy')) { const h = n.get(Health); if (h) seen.minEnemyHp = Math.min(seen.minEnemyHp, h.hp); }
      seen.looks.add(w.find('atmosphere')!.get(Atmosphere)!.look);
    };
    const run = await runScenario({ def: game, sources, inputMap: 'ironleaf', steps: STEPS, input: bot, at, observe });
    console.log(`ironleaf scenario: enemies ${seen.enemies}, houses ${seen.houses}, pampas ${seen.pampas}, moved ${seen.moved.toFixed(2)} m, min enemy hp ${seen.minEnemyHp}, looks ${[...seen.looks]}, sounds ${JSON.stringify(run.rig.sounds)}, checksum ${run.checksum}`);
    expect(seen.enemies).toBe(CAST.length);
    expect(seen.houses).toBeGreaterThanOrEqual(8);
    expect(seen.pampas).toBeGreaterThan(1000);
    expect(seen.moved).toBeGreaterThan(0.2);
    expect(seen.minEnemyHp).toBeLessThan(80);
    expect(seen.looks.size).toBe(2);
    expect(seen.ayaY).toBeGreaterThan(-1);
    expect(run.rig.sounds['sound/swing/light']).toBeGreaterThan(0);
    expect(run.recording).toHaveLength(STEPS);
    run.rig.g.dispose();

    const replay = async (): Promise<string> => {
      const r = await runScenario({ def: game, sources, inputMap: 'ironleaf', steps: STEPS, input: (i) => run.recording[i]!, at });
      const c = r.checksum;
      r.rig.g.dispose();
      return c;
    };
    expect(await replay()).toBe(run.checksum);
    expect(await replay()).toBe(run.checksum);
  }, 120000);
});
