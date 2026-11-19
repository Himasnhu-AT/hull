/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { Combatant, combatHub, DuelDemo, EnemyBrain, attackTokens, checkEnemy, checkMoveSet, spawnEnemy, spawnFighter, Standoff } from 'hull/kits';
import { kitSources, projectSources, startRig, type Rig } from 'hull/kits/testing';
import { config, defineGame } from 'hull';
import { describe, expect, it } from 'vitest';
import { AimLine, encounters, spawnEncounters } from './index';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sources = [...kitSources('third-person', 'health', 'combat'), ...projectSources(root)];

const KINDS = ['ashblade', 'ashpike', 'hulk', 'ashkite', 'kagari'] as const;
/** Where the player stands for each kind, in metres from the enemy (the archer wants a long shot). */
const START_DIST: Record<string, number> = { ashblade: 1.3, ashpike: 3.5, hulk: 3, ashkite: 12, kagari: 3 };

interface Log { patterns: string[]; moves: Record<string, number>; outcomes: Record<string, number>; shots: number; phases: number[]; hits: number }

/** One raider against a scripted player (guards on cue, dodges red flashes, never attacks the enemy). */
async function fight(kind: string, steps: number, tune?: (r: Rig, enemy: Combatant, player: Combatant) => void, seed = 5, demo = true): Promise<{ r: Rig; log: Log; checksum: string }> {
  const def = defineGame({
    ready(g) {
      const w = g.world;
      const p = spawnFighter(w, { name: 'player', team: 'player', x: 0, z: 0, yaw: 0, character: 'character/aya', moveSet: 'move-set/duelist', health: 100000 });
      if (demo) p.add(DuelDemo, { lead: 0.07 });
      spawnEnemy(w, kind, { name: 'foe', x: 0, z: -START_DIST[kind]!, yaw: 0, target: 'player' });
    },
  });
  const r = await startRig(def, sources, '', seed);
  const w = r.g.world;
  const log: Log = { patterns: [], moves: {}, outcomes: {}, shots: 0, phases: [], hits: 0 };
  const hub = combatHub(w);
  const foe = w.find('foe')!.get(Combatant)!, pl = w.find('player')!.get(Combatant)!;
  w.find('foe')!.get(EnemyBrain)!.patternStarted.connect((n) => log.patterns.push(n));
  w.find('foe')!.get(EnemyBrain)!.phaseChanged.connect((n) => log.phases.push(n));
  hub.moveStarted.connect((who, m) => { if (who === foe) log.moves[m] = (log.moves[m] ?? 0) + 1; });
  hub.shot.connect(() => log.shots++);
  for (const k of ['hit', 'blocked', 'deflected', 'perfectDeflect', 'dodged'] as const) hub[k].connect((i) => { if (i.defender === pl) log.outcomes[k] = (log.outcomes[k] ?? 0) + 1; });
  tune?.(r, foe, pl);
  if (process.env['DBG']) for (const k of ['hit', 'blocked', 'deflected', 'perfectDeflect', 'dodged'] as const) hub[k].connect((i) => console.log(k, i.defender.node.name, i.attacker?.node.name));
  if (process.env['DBG']) hub.moveStarted.connect((who, m) => console.log('move', m, who.node.position.z.toFixed(2), pl.node.position.z.toFixed(2)));
  if (process.env['DBG']) { r.step(120); const b = foe.bladeView!; console.log('blade', Array.from(b.cur).map((x) => x.toFixed(2)).join(','), 'foe', foe.node.position.x, foe.node.position.y, foe.node.position.z, 'shapes', pl.hurtShapes?.n, foe.animator ? 'anim' : 'noanim'); }
  r.step(steps);
  return { r, log, checksum: w.checksum() };
}

/** The farthest distance (in 0.1 m steps) at which a stationary Aya takes this move's blade or thrust, and the nearest. */
async function reachOf(kind: string, move: string): Promise<[number, number]> {
  config.load(sources);
  const en = config.lookup('enemy', kind);
  let near = -1, far = -1;
  for (let d = 0.6; d <= 4.01; d += 0.1) {
    const def = defineGame({
      ready(g) {
        const w = g.world;
        spawnFighter(w, { name: 'a', team: 'raiders', x: 0, z: -d, yaw: Math.PI, character: en.character, moveSet: en.moveSet });
        spawnFighter(w, { name: 'd', team: 'player', x: 0, z: 0, yaw: 0, character: 'character/aya', moveSet: 'move-set/duelist', health: 1000 });
      },
    });
    const r = await startRig(def, sources, '', 1);
    let hit = false;
    combatHub(r.g.world).hit.connect(() => { hit = true; });
    const ac = r.g.world.find('a')!.get(Combatant)!;
    ac.attack(move);
    if (process.env['DBG2'] && d > 1.15 && d < 1.25) for (let i = 0; i < 45; i++) { r.step(1); const b = ac.bladeView!; console.log('t', ac.moveT.toFixed(2), ac.state, Array.from(b.cur).map((x) => x.toFixed(2)).join(','), b.armed); }
    r.step(70);
    if (hit) { if (near < 0) near = d; far = d; }
    r.g.dispose();
  }
  return [Math.round(near * 10) / 10, Math.round(far * 10) / 10];
}

describe('Ironleaf enemies', () => {
  it('every blow lands at the distances its pattern is picked at, and not from far beyond', async () => {
    const want: [string, string, number, number][] = [
      ['ashblade', 'sword-cut', 1.4, 2.0], ['ashblade', 'sword-cross', 1.4, 2.0], ['ashpike', 'spear-thrust', 2.0, 2.8], ['ashpike', 'spear-sweep', 1.5, 2.4],
      ['hulk', 'hulk-smash', 1.9, 2.1], ['hulk', 'hulk-grab', 1.5, 2.2], ['kagari', 'duel-cut', 1.6, 2.1], ['kagari', 'duel-thrust', 1.8, 2.4], ['kagari', 'duel-sweep', 1.6, 2.2],
    ];
    const out: string[] = [];
    for (const [kind, move, mid, upper] of want) {
      const [near, far] = await reachOf(kind, move);
      out.push(kind + ' ' + move + ' lands from ' + near + ' to ' + far + ' m');
      console.log(kind, move, near, far);
      expect(far, kind + ' ' + move).toBeGreaterThanOrEqual(upper);
      expect(near, kind + ' ' + move).toBeLessThanOrEqual(mid);
      expect(far, kind + ' ' + move).toBeLessThanOrEqual(upper + 1.1);
    }
    console.log(out.join('\n'));
  }, 300000);

  it('every enemy and move-set file is valid and agrees with itself', () => {
    expect(config.load(sources).problems).toEqual([]);
    for (const k of KINDS) {
      const en = config.lookup('enemy', k);
      const ms = config.lookup('move-set', en.moveSet.replace('move-set/', ''));
      expect(checkMoveSet(ms, en.moveSet)).toEqual([]);
      expect(checkEnemy(en, ms, 'enemy/' + k)).toEqual([]);
    }
  });

  it('matches the stats of GAME.md', () => {
    const want: Record<string, [number, number, string]> = { ashblade: [80, 60, 'stone'], ashpike: [90, 70, 'water'], hulk: [240, 160, 'wind'], ashkite: [60, 40, ''], kagari: [400, 200, ''] };
    for (const [k, [hp, post, weak]] of Object.entries(want)) {
      const e = config.lookup('enemy', k);
      expect([e.health, e.posture!.max, e.weakTo ?? '']).toEqual([hp, post, weak]);
    }
  });

  for (const kind of KINDS) {
    it('plays ' + kind + ' against a scripted player, the same every time', async () => {
      const steps = kind === 'kagari' ? 2400 : 1800;
      const tune = kind === 'kagari' ? (r: Rig, foe: Combatant) => { foe.health.hp = foe.health.max * 0.6; r.g.world.after(8, () => { foe.health.hp = foe.health.max * 0.3; }); } : undefined;
      const a = await fight(kind, steps, tune);
      const b = await fight(kind, steps, tune);
      console.log(kind, JSON.stringify(a.log), a.checksum);
      expect(a.checksum).toBe(b.checksum);
      expect(a.log.patterns.length).toBeGreaterThan(2);
      if (kind !== 'ashkite') expect(new Set(a.log.patterns).size).toBeGreaterThan(1);
      if (kind === 'ashkite') {
        expect(a.log.shots).toBeGreaterThan(1);
        expect(a.log.moves['bow-shoot']).toBeGreaterThan(1);
      } else {
        const landed = (a.log.outcomes['hit'] ?? 0) + (a.log.outcomes['blocked'] ?? 0) + (a.log.outcomes['deflected'] ?? 0) + (a.log.outcomes['perfectDeflect'] ?? 0) + (a.log.outcomes['dodged'] ?? 0);
        expect(landed).toBeGreaterThan(0);
      }
      if (kind === 'kagari') expect(a.log.phases).toEqual([1, 2]);
      a.r.g.dispose(); b.r.g.dispose();
    }, 120000);
  }

  it('the archer\'s arrow hits a player who stands still and flies back at the archer after a deflect', async () => {
    let still = 0, back = 0;
    const r1 = await fight('ashkite', 900, (r, _f, pl) => {
      combatHub(r.g.world).hit.connect((i) => { if (i.defender === pl) still++; });
    }, 5, false);
    expect(still).toBeGreaterThan(0);
    r1.r.g.dispose();
    const r2 = await fight('ashkite', 900, (r, foe) => { combatHub(r.g.world).hit.connect((i) => { if (i.defender === foe) back++; }); });
    expect(back).toBeGreaterThan(0);
    r2.r.g.dispose();
  }, 120000);

  it('Kagari steps back to reset after three patterns in a row', async () => {
    const { log } = await fight('kagari', 60 * 45);
    expect(log.patterns.length).toBeGreaterThan(6);
    expect(log.patterns).toContain('reset');
    let run = 0, longest = 0;
    for (const p of log.patterns) { run = p === 'reset' ? 0 : run + 1; longest = Math.max(longest, run); }
    expect(longest).toBeLessThanOrEqual(4);
  });

  it('the archer draws a red aim line to Aya while it draws the bow and drops it when the arrow is loosed', async () => {
    const { r } = await fight('ashkite', 0, undefined, 5, false);
    const w = r.g.world;
    const brain = w.find('foe')!.get(EnemyBrain)!;
    brain.wake();
    w.find('foe')!.add(AimLine);
    r.step(1);
    const line = w.find('aim-line')!;
    expect(line).toBeTruthy();
    let shown = 0, shots = 0;
    combatHub(w).shot.connect(() => shots++);
    for (let i = 0; i < 60 * 10 && shots === 0; i++) { r.step(1); if (line.object3d.visible) shown++; }
    expect(shots).toBe(1);
    expect(shown).toBeGreaterThan(30);
    r.step(1);
    expect(line.object3d.visible).toBe(false);
  });

  it('the archer backs away from a player who closes in, then shoots from range', async () => {
    const def = defineGame({
      ready(g) {
        const w = g.world;
        spawnFighter(w, { name: 'player', team: 'player', x: 0, z: 0, character: 'character/aya', moveSet: 'move-set/duelist', health: 100000 });
        spawnEnemy(w, 'ashkite', { name: 'foe', x: 0, z: -4, target: 'player' });
      },
    });
    const r = await startRig(def, sources, '', 5);
    const foe = r.g.world.find('foe')!;
    const pats: string[] = [];
    foe.get(EnemyBrain)!.patternStarted.connect((n) => pats.push(n));
    let far = 0;
    for (let i = 0; i < 240; i++) { r.step(1); far = Math.max(far, Math.hypot(foe.position.x, foe.position.z)); }
    expect(pats[0]).toBe('retreat');
    expect(far).toBeGreaterThan(10);
    r.step(300);
    expect(pats).toContain('shoot');
    r.g.dispose();
  }, 60000);

  it('three raiders never attack more than two at a time, and wait at a distance', async () => {
    const def = defineGame({
      ready(g) {
        const w = g.world;
        const p = spawnFighter(w, { name: 'player', team: 'player', x: 0, z: 0, yaw: 0, character: 'character/aya', moveSet: 'move-set/duelist', health: 100000 });
        p.add(DuelDemo);
        spawnEnemy(w, 'ashblade', { name: 'r1', x: -4, z: -3, target: 'player' });
        spawnEnemy(w, 'ashblade', { name: 'r2', x: 4, z: -3, target: 'player' });
        spawnEnemy(w, 'ashpike', { name: 'r3', x: 0, z: 5, target: 'player' });
      },
    });
    const run = async (): Promise<{ max: number; waiting: number; sum: string }> => {
      const r = await startRig(def, sources, '', 9);
      const w = r.g.world;
      let max = 0, waiting = 0;
      const names = ['r1', 'r2', 'r3'];
      for (let i = 0; i < 1500; i++) {
        r.step(1);
        let n = 0;
        for (const nm of names) {
          const b = w.find(nm)?.get(EnemyBrain);
          if (b && (b.mode === 'tell' || b.mode === 'travel' || b.mode === 'strike' || b.mode === 'gap')) n++;
        }
        max = Math.max(max, n);
        expect(attackTokens(w).count).toBeLessThanOrEqual(2);
        if (i > 400) for (const nm of names) { const b = w.find(nm); if (b && b.get(EnemyBrain)!.mode === 'spacing' && !attackTokens(w).has(b)) { const d = Math.hypot(b.position.x, b.position.z); if (d > 2.6) waiting++; } }
      }
      const sum = w.checksum();
      r.g.dispose();
      return { max, waiting, sum };
    };
    const a = await run(), b = await run();
    expect(a.max).toBeLessThanOrEqual(2);
    expect(a.max).toBeGreaterThanOrEqual(1);
    expect(a.waiting).toBeGreaterThan(0);
    expect(a.sum).toBe(b.sum);
  }, 120000);

  it('the camp opens with a standoff: a release on the twitch kills the first raider and the rest wake', async () => {
    const def = defineGame({
      ready(g) {
        const w = g.world;
        spawnFighter(w, { name: 'player', team: 'player', x: -34, z: 15, yaw: -1.45, character: 'character/aya', moveSet: 'move-set/duelist', health: 100 });
        spawnEncounters(w);
      },
    });
    const r = await startRig(def, sources, '', 3);
    const w = r.g.world;
    const dir = encounters(w)!;
    let twitched = false;
    dir.standoff!.twitch.connect(() => { twitched = true; });
    const camp = dir.encounters.find((e) => e.def.name === 'camp')!;
    r.step(5);
    expect(dir.standoff!.active).toBe(true);
    expect(camp.started).toBe(false);
    expect(camp.members.every((m) => m.brain.dormant)).toBe(true);
    for (let i = 0; i < 600 && !twitched; i++) r.step(1);
    expect(twitched).toBe(true);
    const lead = dir.standoff!.enemy!;
    dir.standoff!.release();
    expect(dir.standoff!.result).toBe('win');
    expect(lead.isDead).toBe(true);
    r.step(3);
    expect(camp.started).toBe(true);
    expect(camp.members.filter((m) => !m.combatant.isDead).every((m) => !m.brain.dormant)).toBe(true);
    expect(dir.alive().length).toBe(7);
    r.g.dispose();
    void Standoff;
  }, 60000);
});
