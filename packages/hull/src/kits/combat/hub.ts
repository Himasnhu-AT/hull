// What a fight tells the rest of the game. One hub per world: the combatants emit into it, and a camera, a sound mixer
// or a particle system listens to it without knowing who fought.
import { signal, type Signal, type World } from '../../core/index.ts';
import type { Combatant } from './combatant.ts';

export type Outcome = 'hit' | 'blocked' | 'deflected' | 'perfect' | 'dodged' | 'finisher' | 'ignored';

/**
 * What one exchange was. A single object per combatant is reused for every event it takes part in, so read it inside the
 * handler and copy what you want to keep.
 */
export class HitInfo {
  attacker: Combatant | null = null;
  defender!: Combatant;
  /** The attacker's move name. */
  move = '';
  /** The hurt shape's part ("head", "body"), or "" when the attack had no shape. */
  zone = '';
  /** Hit points taken. */
  damage = 0;
  /** Posture added to the defender (the attacker, for a perfect deflect). */
  posture = 0;
  /** Where the blade met the shape, in the world. */
  x = 0; y = 0; z = 0;
  unblockable = false;
  heavy = false;
  outcome: Outcome = 'ignored';
}

export class CombatHub {
  /** A combatant took a clean hit. */
  readonly hit: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  /** A combatant stopped a blow with a guard held a while. */
  readonly blocked: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  /** A guard raised shortly before the blow: little posture lost, no stagger. */
  readonly deflected: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  /** A guard raised just before the blow: the attacker staggers and loses posture. `info.defender` deflected it. */
  readonly perfectDeflect: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  /** A combatant's posture filled up; it is open to a finisher. */
  readonly postureBroken: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  readonly killed: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  /** A blow went through an i-frame. */
  readonly dodged: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  /** The pause both fighters take on contact, in seconds, for a game that wants to freeze more than them. */
  readonly hitStop: Signal<[seconds: number]> = signal<[number]>();
  /** Camera shake: strength (0 to 1) and seconds. */
  readonly shake: Signal<[amount: number, seconds: number]> = signal<[number, number]>();
  /** A tell: an attack is about to land. kind is "glint" or "unblockable" (the red flash). */
  readonly tell: Signal<[who: Combatant, kind: string]> = signal<[Combatant, string]>();
  readonly moveStarted: Signal<[who: Combatant, move: string]> = signal<[Combatant, string]>();
}

const hubs = new WeakMap<World, CombatHub>();
/** The world's hub. */
export function combatHub(world: World): CombatHub {
  let h = hubs.get(world);
  if (!h) { h = new CombatHub(); hubs.set(world, h); }
  return h;
}
