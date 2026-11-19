// A scripted player for balancing the camp fight (GAME.md section 6): a "competent" one that reads the tells and a
// "careless" one that only attacks. It drives Aya's Combatant the way the buttons do (press, guard, dodge), with a
// human's reaction time and timing spread drawn from its own seeded stream, so the same seed gives the same fight.
import { Behaviour, defineGame } from 'hull';
import { Combatant, combatHub, EnemyBrain, FIGHTERS, spawnFighter } from 'hull/kits';
import { kitSources, projectSources, startRig } from 'hull/kits/testing';
import { Grounded, spawnEncounters } from './enemies';
import { groundHeight, STARTS } from '../world/map';

export type BotMode = 'competent' | 'careless';

/** What a competent player is assumed to do: see a blow this long after the swing starts, answer most of them. */
export interface BotSkill {
  /** Seconds from the start of a swing until the bot has read it. */
  react: number;
  /** Chance it answers a blockable blow with a guard (else it stands there). */
  guardRate: number;
  /** Chance it dodges a red flash. */
  dodgeRate: number;
  /** The guard goes up this many seconds before the blade lands: a draw from [lo, hi] (perfect is under 0.12). */
  lead: [number, number];
}

export const COMPETENT: BotSkill = { react: 0.12, guardRate: 0.85, dodgeRate: 0.9, lead: [0.03, 0.2] };

interface Decision { foe: Combatant; lastT: number; act: 'guard' | 'dodge' | 'none'; lead: number; done: boolean }

export class Bot extends Behaviour {
  mode: BotMode = 'competent';
  skill: BotSkill = COMPETENT;
  private c!: Combatant;
  private decisions: Decision[] = [];
  private guardUntil = 0;

  override ready(): void { this.c = this.node.get(Combatant)!; }

  private foes(): Combatant[] {
    const out: Combatant[] = [];
    const g = this.world.group(FIGHTERS);
    for (let i = 0; i < g.length; i++) {
      const o = g[i]!.get(Combatant);
      if (o && o !== this.c && o.team !== this.c.team && o.state !== 'dead') out.push(o);
    }
    return out;
  }

  override fixedUpdate(dt: number): void {
    const c = this.c, me = this.node.position, r = this.world.random('bot');
    if (c.state === 'dead') return;
    const foes = this.foes();
    if (foes.length === 0) return;
    let near = foes[0]!, nd = 1e9;
    for (const f of foes) {
      const d = Math.hypot(f.node.position.x - me.x, f.node.position.z - me.z);
      if (d < nd) { nd = d; near = f; }
    }
    // Face what it fights (a free fighter only; a move in the air keeps its heading).
    if (c.state === 'free') this.node.rotation.y = Math.atan2(-(near.node.position.x - me.x), -(near.node.position.z - me.z));
    const step = 3.4 * dt;
    if (this.mode === 'careless') {
      if (c.state !== 'free' && c.state !== 'attack') return;
      if (nd > 1.5) { c.drive(((near.node.position.x - me.x) / nd) * step, ((near.node.position.z - me.z) / nd) * step); return; }
      c.press(near.finisherReady ? 'finisher' : 'light');
      return;
    }

    // Competent: read every swing aimed at it.
    const sk = this.skill;
    let pending = false;
    for (const f of foes) {
      const m = f.move;
      if (!m || f.state !== 'attack') continue;
      const d = Math.hypot(f.node.position.x - me.x, f.node.position.z - me.z);
      if (d > (m.reach ?? 2) + 1.2) continue;
      const until = f.untilWindow('trace');
      if (until < 0) continue;
      pending = true;
      let dec = this.decisions.find((x) => x.foe === f);
      // A move time that went backwards is a new swing: forget the old answer.
      if (dec && f.moveT < dec.lastT) { this.decisions.splice(this.decisions.indexOf(dec), 1); dec = undefined; }
      if (dec) dec.lastT = f.moveT;
      if (!dec) {
        if (f.moveT < sk.react) continue;
        const unb = f.unblockableOverride ?? m.unblockable;
        const act = unb ? (r.chance(sk.dodgeRate) ? 'dodge' : 'none') : (r.chance(sk.guardRate) ? 'guard' : 'none');
        dec = { foe: f, lastT: f.moveT, act, lead: r.range(sk.lead[0], sk.lead[1]), done: false };
        this.decisions.push(dec);
      }
      if (dec.done || dec.act === 'none') continue;
      if (dec.act === 'dodge' && until <= 0.14) { dec.done = true; c.dodge(me.x - f.node.position.x, me.z - f.node.position.z); }
      else if (dec.act === 'guard' && until <= dec.lead) {
        // Busy in a swing of its own: the guard cannot go up, so it steps out of the way if the swing lets it.
        if (c.state === 'attack') { if (until <= 0.14 && c.dodge(me.x - f.node.position.x, me.z - f.node.position.z)) dec.done = true; }
        else { dec.done = true; c.guard(true); this.guardUntil = this.world.tick + 36; }
      }
    }
    if (c.guarding && !pending && this.world.tick > this.guardUntil) c.guard(false);
    if (pending || c.guarding) return;
    if (c.state !== 'free' && c.state !== 'attack') return;

    // The stance the nearest enemy is weak to.
    if (near.weakTo && c.state === 'free' && c.stance !== near.weakTo) c.setStance(near.weakTo);
    const broken = foes.find((f) => f.finisherReady && Math.hypot(f.node.position.x - me.x, f.node.position.z - me.z) < 2.2);
    if (broken) { c.press('finisher'); return; }
    // Openings: the enemy is down, or nobody has a blow coming right now.
    const threat = foes.some((f) => f.state === 'attack' && Math.hypot(f.node.position.x - me.x, f.node.position.z - me.z) < 3.6);
    const brainOf = (f: Combatant): EnemyBrain | null => f.node.get(EnemyBrain) ?? null;
    const tellingNear = foes.some((f) => { const b = brainOf(f); return b !== null && b.mode === 'tell' && Math.hypot(f.node.position.x - me.x, f.node.position.z - me.z) < 3.6; });
    if (nd > 1.45) {
      if (!threat) c.drive(((near.node.position.x - me.x) / nd) * step, ((near.node.position.z - me.z) / nd) * step);
      return;
    }
    if (near.state === 'stagger' || (!threat && !tellingNear)) c.press(near.state === 'stagger' ? 'heavy' : 'light');
  }
}

export interface CampResult { tally: Record<string, number>; won: boolean; died: boolean; seconds: number; hp: number; killed: number }

/** Plays the camp fight once from the road, no standoff, and says how it ended. */
export async function playCamp(seed: number, mode: BotMode, seconds = 100, skill: BotSkill = COMPETENT): Promise<CampResult> {
  const root = new URL('../..', import.meta.url).pathname;
  const sources = [...kitSources('third-person', 'health', 'combat'), ...projectSources(root)];
  const [sx, sz, syaw] = STARTS['camp']!;
  const def = defineGame({
    ready(g) {
      const w = g.world;
      const p = spawnFighter(w, { name: 'player', team: 'player', x: sx, z: sz, yaw: syaw, character: 'character/aya', moveSet: 'move-set/aya', health: 100, stance: 'stone' });
      p.position.y = groundHeight(sx, sz);
      p.add(Grounded);
      const c = p.get(Combatant)!;
      c.maxPosture = 100; c.postureRecover = 18; c.postureDelay = 1.2; c.postureRecoverFight = 8; c.brokenSeconds = 1.0;
      p.add(Bot, { mode, skill });
      spawnEncounters(w, { standoffs: false });
    },
  });
  const rig = await startRig(def, sources, '', seed);
  const w = rig.g.world;
  const pc = w.find('player')!.get(Combatant)!;
  const tally: Record<string, number> = {};
  const hub = combatHub(w);
  for (const k of ['hit', 'blocked', 'deflected', 'perfectDeflect', 'dodged'] as const) hub[k].connect((i) => { if (i.defender === pc) tally[k] = (tally[k] ?? 0) + 1; });
  let t = 0;
  for (; t < seconds * 60; t += 10) {
    rig.step(10);
    if (pc.isDead) break;
    const alive = w.group(FIGHTERS).filter((n) => n.name.startsWith('camp-') && !n.get(Combatant)!.isDead).length;
    if (alive === 0) break;
  }
  const alive = w.group(FIGHTERS).filter((n) => n.name.startsWith('camp-') && !n.get(Combatant)!.isDead).length;
  const res = { tally, won: !pc.isDead && alive === 0, died: pc.isDead, seconds: t / 60, hp: pc.health.hp, killed: 5 - alive };
  rig.g.dispose();
  return res;
}
