import { num, tunables } from '../../config/index.ts';
import type { UiPanel, UiView } from '../../ui/index.ts';
import { flagsOf, KitUi, type KitFlags } from '../common.ts';
import { Objectives } from '../objectives/objectives.ts';

export const hudTuning = tunables('hud', {
  messageSeconds: num(2.5, { min: 0.5, max: 10, step: 0.1, unit: 's', help: 'How long a message shows when the game gives no time.' }),
  maxQueued: num(6, { min: 1, max: 20, step: 1, unit: 'messages', help: 'Messages waiting behind the one on screen; more are dropped.' }),
});

const MAX_GOALS = 6;
type Read = () => number;
interface BarSlot { name: string; read: Read; max: number | Read }

/** Seconds as m:ss. Runs when the shown second changes, not every frame. */
const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * The slots of a game's HUD, filled by name: `score`, `timer`, `objective`, `message`, `prompt` and `bar`. A slot nobody
 * filled is not shown. Every look (colour, type, spacing) comes from the game's `ui-theme`. When a node named
 * "objectives" has an `Objectives`, its goals are listed too. Messages are timed in game time: a queue shows one at a
 * time and does not run while the game is paused. Spawn it on a node named "hud".
 */
export class Hud extends KitUi {
  static override state = ['current', 'left', 'queue', 'promptText', 'objectiveText'];
  /** The message on screen, and the seconds it has left. */
  current = '';
  left = 0;
  /** Messages waiting, as [text, seconds]. */
  queue: [string, number][] = [];
  promptText = '';
  objectiveText = '';

  private flags!: KitFlags;
  private scoreRead: Read | null = null;
  private scoreLabel = 'SCORE';
  private timerRead: Read | null = null;
  private countDown = false;
  private objectiveRead: (() => string) | null = null;
  private bars: BarSlot[] = [];
  private barsVersion = 0;
  private barsBuilt = -1;
  private barsPanel: UiPanel | null = null;
  private goals: Objectives | null = null;
  private tries = 0;
  private goalLines: string[] = [];
  private goalsSeen = -1;

  override ready(): void { this.flags = flagsOf(this.world); }

  /** A number shown top right, read every frame. */
  score(read: Read, label = 'SCORE'): this { this.scoreRead = read; this.scoreLabel = label; return this; }

  /** Seconds shown as m:ss. `countDown`: `read` is the time left (shown rounded up, never below 0); else the time so far. */
  timer(read: Read, opts: { countDown?: boolean } = {}): this { this.timerRead = read; this.countDown = !!opts.countDown; return this; }

  /** The current objective, one line: a fixed text or a function that returns it. */
  objective(text: string | (() => string)): this {
    if (typeof text === 'string') { this.objectiveText = text; this.objectiveRead = null; } else { this.objectiveRead = text; this.objectiveText = ''; }
    return this;
  }

  /** A toast at the top. One shows at a time for `seconds` of game time; the rest wait in order. */
  message(text: string, seconds: number = hudTuning.messageSeconds): this {
    if (this.current === '') { this.current = text; this.left = seconds; } else if (this.queue.length < hudTuning.maxQueued) this.queue.push([text, seconds]);
    return this;
  }

  /** The hint at the bottom centre ("E to open"); null clears it. */
  prompt(text: string | null): this { this.promptText = text ?? ''; return this; }

  /** A named bar at the top left. `max` is a number or a function. Same name again replaces it. */
  bar(name: string, read: Read, max: number | Read): this {
    const i = this.bars.findIndex((b) => b.name === name);
    const slot = { name, read, max };
    if (i >= 0) this.bars[i] = slot; else this.bars.push(slot);
    this.barsVersion++;
    return this;
  }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused || this.current === '') return;
    this.left -= dt;
    if (this.left > 0) return;
    const next = this.queue.shift();
    this.current = next ? next[0] : '';
    this.left = next ? next[1] : 0;
  }

  override update(dt: number, alpha: number): void {
    super.update(dt, alpha);
    // The goals node may be spawned after the Hud: look again now and then until it is found.
    if (!this.goals && this.tries++ % 30 === 0) this.goals = this.world.find('objectives')?.get(Objectives) ?? null;
    if (this.barsPanel && this.barsBuilt !== this.barsVersion) this.buildBars();
  }

  private goalLine(i: number): string {
    const g = this.goals;
    if (!g) return '';
    if (this.goalsSeen !== g.version) {
      this.goalsSeen = g.version;
      this.goalLines.length = 0;
      for (let k = 0; k < MAX_GOALS; k++) this.goalLines.push(g.goals[k] ? g.line(g.goals[k]!) : '');
    }
    return this.goalLines[i] ?? '';
  }

  private objectiveNow(): string { return this.objectiveRead ? this.objectiveRead() : this.objectiveText; }

  private buildBars(): void {
    const p = this.barsPanel!;
    p.clear();
    this.barsBuilt = this.barsVersion;
    for (const b of this.bars) {
      p.text(b.name.toUpperCase(), { muted: true });
      p.bar({ label: b.name, lowBelow: 0.3 }).bind(b.read, b.max);
    }
  }

  protected build(ui: UiView): void {
    const r = ui.root;
    this.barsPanel = r.panel({ anchor: 'top-left', label: 'Meters', width: 220 });
    this.barsPanel.bindVisible(() => this.bars.length > 0);
    this.buildBars();

    const top = r.panel({ anchor: 'top-right', label: 'Status', width: 200 });
    top.bindVisible(() => this.scoreRead !== null || this.timerRead !== null);
    const score = top.stack();
    score.text('', { muted: true }).bind(() => this.scoreLabel, (v) => v);
    score.title('0', { }).bind(() => (this.scoreRead ? Math.floor(this.scoreRead()) : 0), (v) => `${v}`);
    score.bindVisible(() => this.scoreRead !== null);
    const time = top.stack();
    time.text('TIME', { muted: true });
    time.title('0:00').bind(() => {
      const t = this.timerRead ? this.timerRead() : 0;
      return this.countDown ? Math.max(0, Math.ceil(t)) : Math.max(0, Math.floor(t));
    }, clock);
    time.bindVisible(() => this.timerRead !== null);

    const goals = r.panel({ anchor: 'left', label: 'Objectives', width: 260 });
    goals.bindVisible(() => this.objectiveNow() !== '' || (this.goals?.goals.length ?? 0) > 0);
    goals.text('OBJECTIVE', { muted: true });
    goals.text('').bind(() => this.objectiveNow(), (v) => v).bindVisible(() => this.objectiveNow() !== '');
    for (let i = 0; i < MAX_GOALS; i++) {
      goals.text('').bind(() => this.goalLine(i), (v) => v).bindVisible(() => this.goalLine(i) !== '');
    }

    const toast = r.panel({ anchor: 'top', label: 'Message' });
    toast.title('', { }).bind(() => this.current, (v) => v);
    toast.bindVisible(() => this.current !== '');

    const hint = r.panel({ anchor: 'bottom', label: 'Prompt' });
    hint.text('').bind(() => this.promptText, (v) => v);
    hint.bindVisible(() => this.promptText !== '');
  }
}
