import type { Timer } from './types.ts';

export class TimerImpl implements Timer {
  active = true;
  constructor(public due: number, readonly interval: number, readonly fn: () => void) {}
  cancel(): void {
    this.active = false;
  }
}

/**
 * Timers counted in fixed steps, so they follow game time exactly and never drift. They fire in creation order
 * when their step comes. A timer made while others are firing is due at least one step later, so it waits.
 */
export class Timers {
  private list: TimerImpl[] = [];
  private next = Infinity;

  /** `interval` is 0 for a one-shot. */
  add(due: number, interval: number, fn: () => void): TimerImpl {
    const t = new TimerImpl(due, interval, fn);
    this.list.push(t);
    if (due < this.next) this.next = due;
    return t;
  }

  /** Fires what is due at `tick`, drops finished and cancelled timers, and works out when to look again. */
  run(tick: number): void {
    if (tick < this.next) return;
    const list = this.list;
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const t = list[i]!;
      if (t.active && t.due <= tick) {
        if (t.interval === 0) t.active = false;
        else t.due += t.interval;
        t.fn();
      }
    }
    // Sweep, including timers appended while firing (indexes n and up).
    let w = 0;
    let nextDue = Infinity;
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      if (!t.active) continue;
      list[w++] = t;
      if (t.due < nextDue) nextDue = t.due;
    }
    list.length = w;
    this.next = nextDue;
  }

  clear(): void {
    const list = this.list;
    for (let i = 0; i < list.length; i++) list[i]!.active = false;
    list.length = 0;
    this.next = Infinity;
  }
}
