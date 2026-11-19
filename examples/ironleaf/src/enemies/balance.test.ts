/// <reference types="node" />
// Balance of the camp fight (GAME.md section 6): a competent scripted player wins most seeds, a careless one loses.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { defineGame } from 'hull';
import { Combatant, combatHub, newAttack, spawnFighter } from 'hull/kits';
import { kitSources, projectSources, startRig } from 'hull/kits/testing';
import { playCamp, type BotMode } from './balance';

const SEEDS = Array.from({ length: Number(process.env['SEEDS'] ?? 20) }, (_, i) => i + 1);

async function rate(mode: BotMode): Promise<{ wins: number; deaths: number; avgHp: number; rows: string[] }> {
  let wins = 0, deaths = 0, hp = 0;
  const agg: Record<string, number> = {};
  const rows: string[] = [];
  for (const s of SEEDS) {
    const r = await playCamp(s, mode);
    if (r.won) { wins++; hp += r.hp; }
    if (r.died) deaths++;
    for (const [k, v] of Object.entries(r.tally)) agg[k] = (agg[k] ?? 0) + v;
    rows.push(s + ':' + (r.won ? 'W' : r.died ? 'L' : 'T') + ' ' + r.seconds.toFixed(0) + 's hp' + r.hp.toFixed(0) + ' k' + r.killed);
  }
  rows.push(JSON.stringify(agg));
  return { wins, deaths, avgHp: wins ? hp / wins : 0, rows };
}

describe('Ironleaf damage matches GAME.md', () => {
  it('a 14-damage cut takes 14 health from Aya wherever it lands', async () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const def = defineGame({
      ready(g) {
        spawnFighter(g.world, { name: 'player', team: 'player', x: 0, z: 0, character: 'character/aya', moveSet: 'move-set/aya', health: 100 });
        spawnFighter(g.world, { name: 'foe', team: 'raiders', x: 0, z: -3, character: 'character/ashblade', moveSet: 'move-set/raider-sword', health: 1000 });
      },
    });
    const rig = await startRig(def, [...kitSources('third-person', 'health', 'combat'), ...projectSources(root)], '', 3);
    const w = rig.g.world;
    const me = w.find('player')!.get(Combatant)!, foe = w.find('foe')!.get(Combatant)!;
    const seen: number[] = [];
    combatHub(w).hit.connect((i) => { if (i.defender === me) seen.push(i.damage); });
    for (const zone of ['head', 'body', 'limb:arm', 'nape', '']) {
      const hp = me.health.hp;
      const a = newAttack();
      a.attacker = foe; a.move = 'sword-cut'; a.damage = 14; a.posture = 12; a.zone = zone; a.fromX = 0; a.fromZ = -3;
      me.state = 'free'; me.health.invuln = 0;
      me.receive(a);
      expect(hp - me.health.hp, 'zone ' + zone).toBeCloseTo(14, 9);
    }
    expect(seen).toEqual([14, 14, 14, 14, 14]);
    rig.g.dispose();
  });
});

describe('Ironleaf camp balance', () => {
  it('a competent player wins most seeds and a careless one loses', async () => {
    const good = await rate('competent');
    const bad = await rate('careless');
    console.log('competent', good.wins + '/' + SEEDS.length, 'avg hp left', good.avgHp.toFixed(0), good.rows.join(' | '));
    console.log('careless', bad.wins + '/' + SEEDS.length, bad.rows.join(' | '));
    expect(good.wins / SEEDS.length).toBeGreaterThanOrEqual(0.7);
    expect(bad.wins / SEEDS.length).toBeLessThanOrEqual(0.15);
  }, 900000);
});
