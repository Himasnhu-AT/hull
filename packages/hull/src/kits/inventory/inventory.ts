import { Behaviour, signal } from '../../core/index.ts';
import { GROUP } from '../common.ts';

/**
 * What a character carries: named items with counts, a number of slots (kinds of item it can hold at once) and a
 * stack limit per kind. It sits beside the pickups kit's `Stock`, which is for resources with a cap each (gas,
 * ammo): use Stock for numbers that drain, Inventory for things you keep, give and can run out of room for. The items
 * are saved with the save kit when the node is in the `save` group.
 */
export class Inventory extends Behaviour {
  static override state = ['items'];
  items: Record<string, number> = {};
  /** How many kinds of item fit at once; 0 for no limit. */
  capacity = 0;
  /** Most of one kind in a slot; 0 for no limit. */
  stack = 0;
  /** Stack limits that override `stack` for one kind: { arrow: 99 }. */
  limits: Record<string, number> = {};
  /** (name, count now) whenever a count changes. */
  readonly changed = signal<[name: string, count: number]>();
  /** (name, how many did not fit) when an add could not take everything. */
  readonly full = signal<[name: string, left: number]>();

  override ready(): void { this.node.addTo(GROUP.save); }

  count(name: string): number { return this.items[name] ?? 0; }

  has(name: string, n = 1): boolean { return this.count(name) >= n; }

  /** Kinds held now. */
  get slots(): number { let n = 0; for (const _k in this.items) n++; return n; }

  /** Number of all items together. */
  get total(): number { let n = 0; for (const k in this.items) n += this.items[k]!; return n; }

  /** Names held, in the order they were first added. */
  names(): string[] { return Object.keys(this.items); }

  /** How many of `name` could be added right now. */
  room(name: string): number {
    const have = this.items[name];
    if (have === undefined && this.capacity > 0 && this.slots >= this.capacity) return 0;
    const lim = this.limits[name] ?? this.stack;
    return lim > 0 ? Math.max(0, lim - (have ?? 0)) : Infinity;
  }

  /** Adds up to `n` and returns how many fitted; what did not fit raises `full`. */
  add(name: string, n = 1): number {
    if (!(n > 0)) return 0;
    const fit = Math.min(n, this.room(name));
    if (fit > 0) {
      const now = (this.items[name] ?? 0) + fit;
      this.items[name] = now;
      this.changed.emit(name, now);
    }
    if (fit < n) this.full.emit(name, n - fit);
    return fit;
  }

  /** Takes `n` if there are that many; otherwise nothing and false. */
  remove(name: string, n = 1): boolean {
    const have = this.items[name] ?? 0;
    if (!(n > 0) || have < n) return false;
    if (have === n) delete this.items[name];
    else this.items[name] = have - n;
    this.changed.emit(name, have - n);
    return true;
  }

  /** Takes every one of `name` and returns how many there were. */
  clear(name: string): number {
    const have = this.items[name] ?? 0;
    if (have > 0) this.remove(name, have);
    return have;
  }
}
