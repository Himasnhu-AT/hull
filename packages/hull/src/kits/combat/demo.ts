import { Behaviour } from '../../core/index.ts';
import { flagsOf, type KitFlags } from '../common.ts';
import { Combatant, FIGHTERS } from './combatant.ts';

/**
 * A scripted player for benches and tests: guards so that the guard goes up just before the nearest enemy's blade
 * lands (a perfect deflect), cuts when the enemy is open, and dodges what cannot be blocked. It reads the enemy's
 * move timings, so it plays the same duel for the same seed. Put it on a node with a Combatant.
 */
export class DuelDemo extends Behaviour {
  /** Seconds before the blow that the guard goes up. Inside the perfect window to deflect perfectly. */
  lead = 0.07;
  /** Dodge unblockables instead of guarding them. */
  dodgeUnblockable = true;
  private c!: Combatant;
  private flags!: KitFlags;

  override ready(): void { this.flags = flagsOf(this.world); this.c = this.node.get(Combatant)!; }

  override fixedUpdate(): void {
    if (this.flags.paused || this.c.state === 'dead') return;
    const c = this.c;
    let foe: Combatant | null = null, best = 1e9;
    const g = this.world.group(FIGHTERS);
    for (let i = 0; i < g.length; i++) {
      const o = g[i]!.get(Combatant);
      if (!o || o === c || o.team === c.team || o.state === 'dead') continue;
      const d = Math.hypot(o.node.position.x - c.node.position.x, o.node.position.z - c.node.position.z);
      if (d < best) { best = d; foe = o; }
    }
    if (!foe) return;
    c.node.rotation.y = Math.atan2(-(foe.node.position.x - c.node.position.x), -(foe.node.position.z - c.node.position.z));
    const m = foe.move;
    const dt = this.world.dt;
    if (m && best < (m.reach ?? 2) + 1) {
      const until = foe.untilWindow('trace');
      const unb = foe.unblockableOverride ?? m.unblockable;
      if (unb && this.dodgeUnblockable) {
        if (until >= 0 && until <= 0.12) c.dodge(c.node.position.x - foe.node.position.x, c.node.position.z - foe.node.position.z);
      } else if (until >= 0 && until <= this.lead + dt * 0.5) c.guard(true);
      return;
    }
    if (foe.finisherReady && best < 2.3) { c.guard(false); c.press('finisher'); return; }
    // Between blows: guard down, cut when close and the enemy is not attacking.
    if (c.guarding && c.guardAge > 0.5) c.guard(false);
    // Cut now and then when the enemy is not mid-swing, and always when it is down.
    if (!m && c.state === 'free' && best < 1.8 && (foe.state === 'stagger' || this.world.random('demo').chance(0.012))) c.press(foe.state === 'stagger' ? 'heavy' : 'light');
  }
}
