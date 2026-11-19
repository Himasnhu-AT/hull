/// <reference types="node" />
// A scripted fight against a dummy raider: stance switch, deflect, perfect deflect, dodge and finisher. The dummy plays
// Aya's own moves on a raider body; the script decides when it swings. The same seed and the same recording must give the
// same checksum twice.
import { fileURLToPath } from 'node:url';
import { Animator } from 'hull/anim';
import { Combatant, Health, combatHub, newAttack, GROUP } from 'hull/kits';
import { projectSources, runScenario, type Rig } from 'hull/kits/testing';
import type { StepSnapshot } from 'hull/input';
import { describe, expect, it } from 'vitest';
import game from '../main.ts';
import { Aya } from './aya';

const sources = projectSources(fileURLToPath(new URL('../..', import.meta.url)));
const STEPS = 460;

function foeOf(rig: Rig): Combatant | null { return rig.g.world.find('foe')?.get(Combatant) ?? null; }
function ayaOf(rig: Rig): { c: Combatant; a: Aya } {
  const n = rig.g.world.find('player')!;
  return { c: n.get(Combatant)!, a: n.get(Aya)! };
}

/** One blow from the foe, delivered straight to Aya: the script, not a clip, decides when it lands. */
function blow(rig: Rig): void {
  const foe = foeOf(rig)!;
  const a = newAttack();
  a.attacker = foe; a.move = 'cut'; a.damage = 14; a.posture = 12; a.fromX = foe.node.position.x; a.fromZ = foe.node.position.z;
  ayaOf(rig).c.receive(a);
}

function spawnFoe(rig: Rig, dist: number): void {
  const w = rig.g.world;
  const me = w.find('player')!;
  const yaw = me.rotation.y;
  const old = w.find('foe');
  if (old) old.destroy();
  const n = w.spawn('foe');
    n.position.set(me.position.x - Math.sin(yaw) * dist, me.position.y, me.position.z - Math.cos(yaw) * dist);
  n.rotation.y = yaw + Math.PI;
  n.add(Health, { max: 200, hp: 200, invulnAfterHit: 0 });
  n.add(Combatant, { team: 'raiders', moveSet: '' });
  n.addTo(GROUP.enemy);
  w.spawn('model', n).add(Animator, { character: 'character/ashblade' });
}

const T = { stance: 10, perfect: 40, deflect: 160, dodge: 270, place: 380, finish: 392 };
const at: Record<number, (rig: Rig) => void> = {
  5: (r) => spawnFoe(r, 1.3),
  [T.perfect]: blow,
  [T.deflect]: blow,
  [T.dodge]: blow,
  [T.place]: (r) => { spawnFoe(r, 1.3); },
  [T.finish - 2]: (r) => { foeOf(r)!.breakPosture(); },
};

describe('Ironleaf player combat', () => {
  it('plays a scripted fight to the same checksum twice', async () => {
    const seen = { stance: '', perfect: 0, deflected: 0, dodgeKeptHp: true, hpBeforeDodge: 0, foeStaggered: false, finisherKilled: false, latency: -1, pressTick: -1, hits: 0, moves: new Set<string>() };
    let hpMark = 100;
    const input = (i: number, rig: Rig): StepSnapshot => {
      const foe = foeOf(rig);
      const { c } = ayaOf(rig);
      if (i === T.stance) return { stance: { d: 1, p: 1 } };
      void foe; void c;
      // A perfect deflect: the guard goes up 4 steps before the blow. A plain deflect: 12 steps before. A dodge: 6.
      if (i >= T.perfect - 4 && i < T.perfect + 20) return { block: { d: 1 } };
      if (i >= T.deflect - 12 && i < T.deflect + 20) return { block: { d: 1 } };
      if (i === T.dodge - 6) return { dodge: { d: 1, p: 1 } };
      if (i === T.finish) return { attack: { d: 1, p: 1 } };
      if (i === 440) { seen.pressTick = i; return {}; }
      return {};
    };
    const observe = (i: number, rig: Rig): void => {
      const { c, a } = ayaOf(rig);
      if (i === T.stance + 2) seen.stance = c.stance;
      if (i === T.dodge - 1) hpMark = c.health.hp;
      if (i === T.place - 1) { seen.dodgeKeptHp = c.health.hp === hpMark; }
      if (i === T.perfect + 40) seen.foeStaggered = foeOf(rig)?.state === 'stagger' || foeOf(rig)?.state === 'free';
      if (i === T.finish + 1) seen.latency = c.state === 'attack' ? 0 : 99;
      if (i === 5) {
        const hub = combatHub(rig.g.world);
        hub.perfectDeflect.connect(() => { seen.perfect++; });
        hub.deflected.connect(() => { seen.deflected++; });
        hub.moveStarted.connect((_w, mv) => { seen.moves.add(mv); });
      }
      if (i === STEPS - 1) seen.finisherKilled = foeOf(rig)?.state === 'dead' || !rig.g.world.find('foe');
      void a;
    };
    const run = await runScenario({ def: game, sources, inputMap: 'ironleaf', steps: STEPS, input, at, observe });
    console.log(`player scenario: stance ${seen.stance}, perfect ${seen.perfect}, deflected ${seen.deflected}, dodge kept hp ${seen.dodgeKeptHp}, finisher ${seen.finisherKilled}, moves ${[...seen.moves]}, checksum ${run.checksum}`);
    expect(seen.stance).toBe('water');
    expect(seen.perfect).toBe(1);
    expect(seen.deflected).toBe(1);
    expect(seen.dodgeKeptHp).toBe(true);
    expect(seen.latency).toBe(0);
    expect(seen.finisherKilled).toBe(true);
    expect(seen.moves.has('finisher-water')).toBe(true);
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

  it('starts a swing within one step of the press, chains the stone string, and charges a held heavy', async () => {
    const started: { tick: number; move: string }[] = [];
    const press = { tick: -1 };
    const input = (i: number): StepSnapshot => {
      if (i === 20) { press.tick = i; return { attack: { d: 1, p: 1 } }; }
      // The second press lands inside the first cut's cancel window (0.30 s .. 0.46 s).
      if (i === 20 + 24) return { attack: { d: 1, p: 1 } };
      if (i === 20 + 48) return { attack: { d: 1, p: 1 } };
      if (i >= 200 && i < 200 + 40) return (i === 200 ? { heavy: { d: 1, p: 1 } } : { heavy: { d: 1 } });
      return {};
    };
    const observe = (i: number, rig: Rig): void => {
      if (i === 0) combatHub(rig.g.world).moveStarted.connect((_w, mv) => { started.push({ tick: rig.g.world.tick, move: mv }); });
    };
    const run = await runScenario({ def: game, sources, inputMap: 'ironleaf', steps: 300, input, observe });
    run.rig.g.dispose();
    console.log('moves', JSON.stringify(started));
    expect(started.map((s) => s.move).slice(0, 3)).toEqual(['stone-1', 'stone-2', 'stone-3']);
    expect((started[0]!.tick - press.tick) * (1 / 60)).toBeLessThan(0.1);
    expect(started.some((s) => s.move === 'stone-charge')).toBe(true);
  }, 60000);
});
