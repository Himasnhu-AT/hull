/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { Health, PauseMenu, SaveSlots, Spawner, fpsTuning } from 'hull/kits';
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

const angle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Aims at the nearest enemy and shoots, then walks to the nearest pickup, pauses, and plays on. */
function bot(i: number, rig: Rig): StepSnapshot {
  const w = rig.g.world;
  const me = w.find('player')!;
  if (i === PAUSE_AT || i === PAUSE_END) return { pause: { d: 1, p: 1 } };
  if (i > PAUSE_AT && i < PAUSE_END) return { move: { y: -1 } };
  // A walk first, then let the enemies come close: they bite before the bot shoots.
  if (i < 120) return { move: { y: -1 } };
  const yaw = me.rotation.y;
  const near = (list: readonly { position: { x: number; z: number } }[]): { dx: number; dz: number; d: number } | null => {
    let best: { dx: number; dz: number; d: number } | null = null;
    for (const n of list) {
      const dx = n.position.x - me.position.x;
      const dz = n.position.z - me.position.z;
      const d = Math.hypot(dx, dz);
      if (!best || d < best.d) best = { dx, dz, d };
    }
    return best;
  };
  const hp = me.get(Health)!;
  const hurt = hp.hp < hp.max;
  const foe = near(w.group('enemy'));
  // Fights what is close once hurt (or what is already biting); otherwise goes for a pickup if hurt.
  const fight = foe !== null && foe.d < 4 && (hurt || foe.d < 1.25);
  const wantPickup = !fight && hurt && i > 300;
  const t = wantPickup ? near(w.group('pickup').filter((p) => p.object3d.visible)) : foe;
  if (!t) return {};
  const diff = angle(Math.atan2(-t.dx, -t.dz) - yaw);
  const snap: StepSnapshot = { look: { x: -diff / fpsTuning.mouseSensitivity } };
  if (wantPickup && t.d > 0.5) snap['move'] = { y: -1 };
  else if (fight && Math.abs(diff) < 0.12) snap['fire'] = { d: 1 };
  return snap;
}

describe('first-person template', () => {
  it('moves, takes damage, picks up, pauses, saves and loads; its recorded input replays to the same checksum twice', async () => {
    const seen = { minHp: 1e9, hpBeforePickup: 0, pickedUp: 0, pausedSteps: 0, pausedMoved: 0, saved: null as null | { x: number; z: number; hp: number }, loadedOk: false, moved: 0 };
    let last: { x: number; z: number } | null = null;
    let prevHp = 100;
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
      seen.minHp = Math.min(seen.minHp, hp);
      if (hp > prevHp && i < SAVE_AT - 1) { seen.pickedUp++; seen.hpBeforePickup = prevHp; }
      prevHp = hp;
      if (rig.g.world.find('pause')!.get(PauseMenu)!.paused) { seen.pausedSteps++; if (last) seen.pausedMoved += Math.hypot(me.position.x - last.x, me.position.z - last.z); }
      if (last && i < PAUSE_AT) seen.moved += Math.hypot(me.position.x - last.x, me.position.z - last.z);
      last = { x: me.position.x, z: me.position.z };
    };
    const run = await runScenario({ def: game, sources, inputMap: 'fps', steps: STEPS, input: bot, at, observe });
    const sp = run.rig.g.world.find('spawner')!.get(Spawner)!;
    console.log(`fps scenario: min hp ${seen.minHp.toFixed(0)}, pickups ${seen.pickedUp}, paused ${seen.pausedSteps} steps, moved ${seen.moved.toFixed(1)} m, wave ${sp.wave}, kills ${sp.kills}, sounds ${JSON.stringify(run.rig.sounds)}, checksum ${run.checksum}`);
    expect(seen.moved).toBeGreaterThan(3);
    expect(seen.minHp).toBeLessThan(100);
    expect(seen.pickedUp).toBeGreaterThanOrEqual(1);
    expect(seen.pausedSteps).toBeGreaterThanOrEqual(PAUSE_END - PAUSE_AT - 1);
    expect(seen.pausedMoved).toBeLessThan(1e-9);
    expect(seen.loadedOk).toBe(true);
    expect(sp.kills).toBeGreaterThanOrEqual(1);
    expect(run.rig.sounds['sound/shot']).toBeGreaterThan(3);
    expect(run.recording).toHaveLength(STEPS);
    run.rig.g.dispose();

    const replay = async (): Promise<string> => {
      const r = await runScenario({ def: game, sources, inputMap: 'fps', steps: STEPS, input: (i) => run.recording[i]!, at });
      const c = r.checksum;
      r.rig.g.dispose();
      return c;
    };
    expect(await replay()).toBe(run.checksum);
    expect(await replay()).toBe(run.checksum);
  });
});
