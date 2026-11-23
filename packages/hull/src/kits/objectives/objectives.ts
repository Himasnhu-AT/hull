import { Behaviour, signal } from '../../core/index.ts';

/** One goal. `count` is how many steps finish it (collect 3 of 5 is count 5); a plain goal has count 1. */
export interface Goal { id: string; text: string; count: number; have: number; done: boolean }

/**
 * A list of goals the game ticks off. `progress(id)` counts toward one, `complete(id)` finishes it, and the signals tell
 * the game what happened. The list is declared state, so it is saved with the save kit (put the node in the `save`
 * group) and is part of the checksum. The `Hud` shows it when the node is named "objectives".
 */
export class Objectives extends Behaviour {
  static override state = ['goals', 'finished'];
  goals: Goal[] = [];
  /** True once every goal was done and `allDone` fired; adding a goal after that opens the list again. */
  finished = false;
  readonly changed = signal<[id: string]>();
  readonly completed = signal<[id: string]>();
  readonly allDone = signal();
  /** Bumped on every change, so a HUD rebuilds its text only then. Not state: a load bumps it in `afterLoad`. */
  version = 0;

  /** Adds a goal. An id that exists is replaced (text and count), keeping nothing of its progress. */
  add(id: string, text: string, opts: { count?: number } = {}): Goal {
    const count = Math.max(1, Math.floor(opts.count ?? 1));
    const g: Goal = { id, text, count, have: 0, done: false };
    const i = this.goals.findIndex((x) => x.id === id);
    if (i >= 0) this.goals[i] = g; else this.goals.push(g);
    this.finished = false;
    this.touch(id);
    return g;
  }

  get(id: string): Goal | undefined { return this.goals.find((g) => g.id === id); }

  isDone(id: string): boolean { return this.get(id)?.done ?? false; }

  /** How many goals are not done. */
  get remaining(): number {
    let n = 0;
    for (let i = 0; i < this.goals.length; i++) if (!this.goals[i]!.done) n++;
    return n;
  }

  /** Counts `n` toward a goal; finishes it at its count. False for an unknown or finished goal. */
  progress(id: string, n = 1): boolean {
    const g = this.get(id);
    if (!g || g.done) return false;
    g.have = Math.min(g.count, g.have + n);
    if (g.have >= g.count) this.finish(g);
    else this.touch(id);
    return true;
  }

  complete(id: string): boolean {
    const g = this.get(id);
    if (!g || g.done) return false;
    g.have = g.count;
    this.finish(g);
    return true;
  }

  remove(id: string): boolean {
    const i = this.goals.findIndex((g) => g.id === id);
    if (i < 0) return false;
    this.goals.splice(i, 1);
    this.touch(id);
    this.checkAll();
    return true;
  }

  /** The line a HUD shows: "Find the key", "Collect gems (3/5)", "[x] " in front when done. */
  line(g: Goal): string {
    const n = g.count > 1 ? ` (${g.have}/${g.count})` : '';
    return `${g.done ? '[x] ' : ''}${g.text}${n}`;
  }

  afterLoad(): void { this.version++; }

  private finish(g: Goal): void {
    g.done = true;
    this.touch(g.id);
    this.completed.emit(g.id);
    this.checkAll();
  }

  private checkAll(): void {
    if (this.finished || this.goals.length === 0 || this.remaining > 0) return;
    this.finished = true;
    this.allDone.emit();
  }

  private touch(id: string): void {
    this.version++;
    this.changed.emit(id);
  }
}
