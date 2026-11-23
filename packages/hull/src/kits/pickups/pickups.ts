import { Behaviour, signal, type Node, type World } from '../../core/index.ts';
import { num, tunables } from '../../config/index.ts';
import { Mesh, teleported } from '../../render/index.ts';
import type { UiView } from '../../ui/index.ts';
import { flagsOf, GROUP, KitUi, upFrom, type KitFlags, type LevelLike } from '../common.ts';
import { Health } from '../health/health.ts';
import { kitIO } from '../io.ts';

export const pickupTuning = tunables('pickup', {
  spinSpeed: num(2.2, { min: 0, max: 12, step: 0.1, unit: 'rad/s', widget: 'dial' }),
  bobHeight: num(0.12, { min: 0, max: 1, step: 0.01, unit: 'm' }),
  bobSpeed: num(3, { min: 0, max: 12, step: 0.1, unit: 'rad/s' }),
  collectRadius: num(0.9, { min: 0.2, max: 3, step: 0.05, unit: 'm', help: 'How close the player must be to collect.' }),
  height: num(0.7, { min: 0, max: 3, step: 0.05, unit: 'm', help: 'Height of the pickup above the floor.' }),
});

/**
 * Named counters with a cap: "gas", "blades", "ammo". `add` returns how much fitted, `take` spends only if there is
 * enough. Put one on the node that carries the things (the player); a Pickup of that kind fills it.
 */
export class Stock extends Behaviour {
  static override state = ['values'];
  values: Record<string, number> = {};
  /** Caps by name; a name with no cap holds as much as you like. */
  caps: Record<string, number> = {};
  readonly changed = signal<[name: string, value: number]>();

  get(name: string): number { return this.values[name] ?? 0; }

  has(name: string): boolean { return name in this.values || name in this.caps; }

  add(name: string, amount: number): number {
    const cap = this.caps[name] ?? Infinity;
    const now = this.values[name] ?? 0;
    const next = Math.min(cap, now + amount);
    if (next === now) return 0;
    this.values[name] = next;
    this.changed.emit(name, next);
    return next - now;
  }

  /** Takes `amount` if there is that much; otherwise nothing and false. */
  take(name: string, amount: number): boolean {
    const now = this.values[name] ?? 0;
    if (now < amount) return false;
    this.values[name] = now - amount;
    this.changed.emit(name, now - amount);
    return true;
  }

  /** Takes up to `amount` and returns what was taken (a drain over time). */
  drain(name: string, amount: number): number {
    const now = this.values[name] ?? 0;
    const took = Math.min(now, amount);
    if (took > 0) { this.values[name] = now - took; this.changed.emit(name, now - took); }
    return took;
  }
}

const COLOURS: Record<string, string> = { health: '#ff5a5a', ammo: '#ffd24a', gas: '#5ad1ff', blades: '#c9d1d9' };

/**
 * Something to collect. A player (a node in the `player` group) within `collectRadius` takes it: kind "health" heals
 * the Health on that node, any other kind fills the Stock of that name. A pickup the taker has no room for is left
 * alone. With `respawn` above 0 it comes back after that many seconds; otherwise it is gone.
 */
export class Pickup extends Behaviour {
  static override state = ['active', 'timer', 'phase'];
  kind = 'health';
  amount = 25;
  /** Seconds until it returns, or 0 for never. */
  respawn = 0;
  sound = 'sound/pickup';
  material = '';
  active = true;
  timer = 0;
  phase = 0;
  readonly collected = signal<[kind: string, amount: number, by: Node]>();
  private flags!: KitFlags;
  private gem!: Node;
  private baseY = 0;

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.node.addTo(GROUP.pickup).addTo(GROUP.save);
    this.gem = this.world.spawn('gem', this.node);
    this.gem.scale.setScalar(0.4);
    this.gem.rotation.set(Math.PI / 4, 0, Math.PI / 4);
    this.gem.add(Mesh, { shape: 'box', material: this.material || `material/pickup-${this.kind}`, color: COLOURS[this.kind] ?? '#ffffff', castShadow: false });
    this.baseY = this.node.position.y;
    this.phase = this.world.random('pickups').range(0, 6.28);
    this.show();
  }

  afterLoad(): void { this.show(); }

  private show(): void { this.node.object3d.visible = this.active; }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused) return;
    this.phase += dt;
    const n = this.node;
    n.object3d.rotation.y = this.phase * pickupTuning.spinSpeed;
    n.position.y = this.baseY + Math.sin(this.phase * pickupTuning.bobSpeed) * pickupTuning.bobHeight;
    if (!this.active) {
      if (this.respawn > 0) {
        this.timer -= dt;
        if (this.timer <= 0) { this.active = true; this.show(); }
      }
      return;
    }
    const takers = this.world.group(GROUP.player);
    const reach = pickupTuning.collectRadius;
    for (let i = 0; i < takers.length; i++) {
      const who = takers[i]!;
      const dx = who.position.x - n.position.x;
      const dz = who.position.z - n.position.z;
      if (dx * dx + dz * dz < reach * reach && this.take(who)) return;
    }
  }

  private take(who: Node): boolean {
    let got = 0;
    if (this.kind === 'health') got = upFrom(who, Health)?.heal(this.amount) ?? 0;
    else got = who.get(Stock)?.add(this.kind, this.amount) ?? 0;
    if (got <= 0) return false;
    this.active = false;
    this.timer = this.respawn;
    this.show();
    if (this.sound !== '') kitIO.play(this.sound);
    this.collected.emit(this.kind, got, who);
    return true;
  }
}

/** Puts `count` pickups of one kind on free floor of the level (from the world's 'pickups' random stream). */
export function scatterPickups(world: World, level: LevelLike, kind: string, count: number, opts: { amount?: number; respawn?: number } = {}): Node[] {
  const out: Node[] = [];
  const spot = { x: 0, z: 0 };
  for (let i = 0; i < count; i++) {
    if (!level.freeSpot(spot, 1.2, 'pickups', 0, 0, 5)) break;
    const n = world.spawn(`pickup-${kind}${i}`);
    n.position.set(spot.x, pickupTuning.height, spot.z);
    n.add(Pickup, { kind, amount: opts.amount ?? 25, respawn: opts.respawn ?? 0 });
    teleported(n);
    out.push(n);
  }
  return out;
}

/** One line per stock name at the bottom right: "GAS 80/100". */
export class StockHud extends KitUi {
  /** Names to show, in order. */
  names: string[] = [];
  protected build(ui: UiView): void {
    const s = this.node.get(Stock)!;
    const p = ui.root.panel({ anchor: 'bottom-right', label: 'Supplies', width: 200 });
    for (const name of this.names) {
      p.text(name.toUpperCase(), { muted: true });
      p.title('0').bind(() => s.get(name), (v) => (s.caps[name] ? `${Math.round(v)} / ${s.caps[name]}` : `${Math.round(v)}`));
    }
  }
}
