import { Behaviour, signal, type Node, type Signal } from '../../core/index.ts';
import { combatHub } from './hub.ts';
import type { Combatant } from './combatant.ts';

export type StandoffResult = 'win' | 'lose';

/**
 * A standoff before a fight: both stand still, the enemy waits a hidden time, then twitches (the `twitch` signal is the
 * tell). The player's `release()` inside the window after the twitch wins: the enemy dies at once. Releasing before
 * the twitch (a misread) or too late loses: the enemy's strike hits. The wait comes from the 'standoff' random stream
 * and every clock is game time, so a replay gives the same duel. Add it to any node, then call `begin`.
 */
export class Standoff extends Behaviour {
  static override state = ['phase', 'wait', 'since'];
  /** 'idle' | 'waiting' | 'twitched' | 'done'. */
  phase = 'idle';
  wait = 0;
  since = 0;
  /** Seconds the player has after the twitch. */
  window = 0.35;
  /** Range of the hidden wait, in seconds. */
  waitRange: [number, number] = [1.2, 3.2];
  /** Hit points the losing strike takes (the enemy's own damage is not used: the strike is an ambush). */
  strike = 40;
  player: Combatant | null = null;
  enemy: Combatant | null = null;
  result: StandoffResult | null = null;

  readonly twitch: Signal<[]> = signal<[]>();
  readonly resolved: Signal<[result: StandoffResult]> = signal<[StandoffResult]>();

  begin(player: Combatant, enemy: Combatant): void {
    this.player = player;
    this.enemy = enemy;
    this.phase = 'waiting';
    this.wait = this.world.random('standoff').range(this.waitRange[0], this.waitRange[1]);
    this.since = 0;
    this.result = null;
  }

  get active(): boolean { return this.phase === 'waiting' || this.phase === 'twitched'; }

  /** The player lets go. */
  release(): void {
    if (!this.active) return;
    this.finish(this.phase === 'twitched' && this.since <= this.window ? 'win' : 'lose');
  }

  override fixedUpdate(dt: number): void {
    if (!this.active) return;
    this.since += dt;
    if (this.phase === 'waiting' && this.since >= this.wait) {
      this.phase = 'twitched';
      this.since = 0;
      combatHub(this.world).tell.emit(this.enemy!, 'glint');
      this.twitch.emit();
    } else if (this.phase === 'twitched' && this.since > this.window) {
      this.finish('lose');
    }
  }

  private finish(r: StandoffResult): void {
    this.phase = 'done';
    this.result = r;
    const p = this.player!, e = this.enemy!;
    const info = (r === 'win' ? e : p).info;
    info.attacker = r === 'win' ? p : e;
    info.defender = r === 'win' ? e : p;
    info.move = 'standoff';
    info.zone = ''; info.posture = 0; info.unblockable = true; info.heavy = true;
    info.outcome = 'hit';
    if (r === 'win') {
      info.damage = e.health.max;
      e.health.damage(e.health.max, '', p.node);
      e.killedByStandoff();
    } else {
      info.damage = p.health.damage(this.strike, '', e.node);
      p.hit.emit(info);
      combatHub(this.world).hit.emit(info);
      if (p.health.dead) p.killedByStandoff();
      else p.stagger(0.6);
    }
    this.resolved.emit(r);
  }

  /** Convenience: begin a standoff between two nodes that carry Combatants. */
  static between(host: Node, player: Combatant, enemy: Combatant): Standoff {
    const s = host.get(Standoff) ?? host.add(Standoff);
    s.begin(player, enemy);
    return s;
  }
}
