// Signals and the listener list shared with world.events. A connection can name an owner node; when the owner is
// destroyed every connection it owns ends, so nothing keeps calling into a dead node.
import type { Node } from './node.ts';
import type { Signal } from './types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...a: any[]) => void;

export class Listener {
  dead = false;
  constructor(readonly fn: Fn, readonly owner: Node | null, readonly list: ListenerList) {}

  /** Called by the user's unsubscribe, or by the owner when it is destroyed (`fromOwner`). */
  end(fromOwner = false): void {
    if (this.dead) return;
    this.dead = true;
    if (this.owner !== null && !fromOwner) this.owner._unlink(this);
    this.list.dirty = true;
    if (this.list.depth === 0) this.list.compact();
  }
}

/**
 * Listeners in connection order. Firing never allocates: it walks the array by index up to the length it had when
 * firing began, so a listener added during a fire waits for the next one, and a listener ended during a fire is
 * skipped and swept when the outermost fire finishes.
 */
export class ListenerList {
  items: Listener[] = [];
  depth = 0;
  dirty = false;

  add(fn: Fn, owner: Node | null): Listener {
    const l = new Listener(fn, owner, this);
    this.items.push(l);
    if (owner !== null) owner._link(l);
    return l;
  }

  fire1(x: unknown): void {
    const items = this.items;
    const n = items.length;
    this.depth++;
    try {
      for (let i = 0; i < n; i++) {
        const l = items[i]!;
        if (!l.dead) l.fn(x);
      }
    } finally {
      this.depth--;
      if (this.depth === 0 && this.dirty) this.compact();
    }
  }

  fireN(args: unknown[]): void {
    const items = this.items;
    const n = items.length;
    this.depth++;
    try {
      for (let i = 0; i < n; i++) {
        const l = items[i]!;
        if (!l.dead) l.fn(...args);
      }
    } finally {
      this.depth--;
      if (this.depth === 0 && this.dirty) this.compact();
    }
  }

  compact(): void {
    const items = this.items;
    let w = 0;
    for (let r = 0; r < items.length; r++) {
      const l = items[r]!;
      if (!l.dead) items[w++] = l;
    }
    items.length = w;
    this.dirty = false;
  }
}

const noop = (): void => {};

class SignalImpl<A extends unknown[]> implements Signal<A> {
  private readonly list = new ListenerList();

  connect(fn: (...a: A) => void, owner?: Node): () => void {
    if (owner !== undefined && owner.destroyed) return noop;
    const l = this.list.add(fn, owner ?? null);
    return () => l.end();
  }

  emit(...a: A): void {
    this.list.fireN(a);
  }
}

export function signal<A extends unknown[] = []>(): Signal<A> {
  return new SignalImpl<A>();
}
