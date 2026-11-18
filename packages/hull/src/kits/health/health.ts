import { Behaviour, signal, type Node } from '../../core/index.ts';
import { num, tunables } from '../../config/index.ts';
import type { UiView } from '../../ui/index.ts';
import { flagsOf, KitUi, type KitFlags } from '../common.ts';

export const healthTuning = tunables('health', {
  playerMax: num(100, { min: 1, max: 2000, step: 5, widget: 'dial', help: 'Hit points of the player.' }),
  invulnSeconds: num(0.4, { min: 0, max: 3, step: 0.05, unit: 's', widget: 'slider', help: 'After a hit, how long nothing hurts again.' }),
  headMultiplier: num(2, { min: 0, max: 10, step: 0.25, widget: 'dial', help: 'Damage multiplier for a hit zone tagged "head".' }),
  napeMultiplier: num(3, { min: 0, max: 10, step: 0.25, widget: 'dial', help: 'Damage multiplier for a hit zone tagged "nape".' }),
  limbMultiplier: num(0.5, { min: 0, max: 10, step: 0.25, widget: 'dial', help: 'Damage multiplier for zones tagged "limb:...".' }),
});

/**
 * Hit points. `damage(amount, zone)` scales by the zone ("head", "nape", "limb:left-arm": the tag of the collider
 * that was hit), applies the short invulnerability after a hit, and emits `died` once. Put it on the node that
 * should die; a collider on a child node finds it by walking up (`upFrom`).
 */
export class Health extends Behaviour {
  static override state = ['hp', 'dead', 'invuln'];
  max = 100;
  hp = 100;
  dead = false;
  /** Seconds of invulnerability left. */
  invuln = 0;
  /** Seconds of invulnerability after each hit; negative uses the tuning. */
  invulnAfterHit = -1;
  /** Per-zone multipliers that override the tuning: { nape: 5 }. */
  zones: Record<string, number> = {};

  readonly damaged = signal<[amount: number, zone: string, from: Node | null]>();
  readonly healed = signal<[amount: number]>();
  readonly died = signal<[from: Node | null]>();
  private flags!: KitFlags;

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.hp = Math.min(this.hp, this.max);
  }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused) return;
    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);
  }

  get fraction(): number { return this.max > 0 ? this.hp / this.max : 0; }

  multiplier(zone: string): number {
    if (zone === '') return 1;
    const own = this.zones[zone];
    if (own !== undefined) return own;
    const colon = zone.indexOf(':');
    const base = colon >= 0 ? zone.slice(0, colon) : zone;
    const o2 = this.zones[base];
    if (o2 !== undefined) return o2;
    return base === 'head' ? healthTuning.headMultiplier : base === 'nape' ? healthTuning.napeMultiplier : base === 'limb' ? healthTuning.limbMultiplier : 1;
  }

  /** Returns the damage that was applied (0 when dead, still invulnerable, or the amount is not positive). */
  damage(amount: number, zone = '', from: Node | null = null): number {
    if (this.dead || this.invuln > 0 || amount <= 0) return 0;
    const applied = Math.min(this.hp, amount * this.multiplier(zone));
    this.hp -= applied;
    this.invuln = this.invulnAfterHit >= 0 ? this.invulnAfterHit : healthTuning.invulnSeconds;
    this.damaged.emit(applied, zone, from);
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.died.emit(from);
    }
    return applied;
  }

  /** Returns what was added; 0 when dead or already full. */
  heal(amount: number): number {
    if (this.dead) return 0;
    const added = Math.min(this.max - this.hp, amount);
    if (added <= 0) return 0;
    this.hp += added;
    this.healed.emit(added);
    return added;
  }

  revive(): void {
    this.dead = false;
    this.hp = this.max;
    this.invuln = 0;
  }
}

/** A health bar at the bottom left, for the Health on the same node. */
export class HealthHud extends KitUi {
  protected build(ui: UiView): void {
    const h = this.node.get(Health)!;
    const p = ui.root.panel({ anchor: 'bottom-left', label: 'Health', width: 240 });
    p.text('HEALTH', { muted: true });
    p.title('').bind(() => Math.ceil(h.hp), (v) => `${v}`);
    p.bar({ label: 'Health', lowBelow: 0.3 }).bind(() => h.hp, () => h.max);
  }
}
