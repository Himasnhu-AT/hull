import { Behaviour, signal } from '../../core/index.ts';
import type { UiScreen, UiView } from '../../ui/index.ts';
import { flagsOf, type KitFlags } from '../common.ts';
import { kitIO } from '../io.ts';

const ROWS = 8;

/** Opens and closes one ui-screen as the UI layer comes and goes; shared by both menus. */
class ScreenHolder {
  private ui: UiView | null = null;
  private open: UiScreen | null = null;
  private offs: (() => void)[] = [];

  constructor(private readonly id: string, private readonly vm: Record<string, unknown>, private readonly actions: Record<string, () => void>) {}

  sync(want: boolean): void {
    const ui = kitIO.ui();
    if (ui !== this.ui) {
      for (const f of this.offs.splice(0)) f();
      this.open = null;
      this.ui = ui;
      if (ui) for (const name in this.actions) this.offs.push(ui.action(name, this.actions[name]!));
    }
    if (!ui) return;
    if (want && !this.open) {
      this.open = ui.screen(this.id, this.vm);
      this.open.focusFirst();
    } else if (!want && this.open) {
      this.open.close();
      this.open = null;
    }
  }

  dispose(): void {
    for (const f of this.offs.splice(0)) f();
    this.open?.close();
    this.open = null;
  }
}

/**
 * A title screen: the game stays paused (the same flag the pause kit uses) until the player presses Start. The screen is
 * `ui-screen/title`, with the actions `title.start`; the first button takes keyboard and gamepad focus. Spawn it first.
 */
export class TitleScreen extends Behaviour {
  static override state = ['started'];
  title = 'Untitled';
  subtitle = '';
  started = false;
  /** Fires once, when Start is pressed (or `start()` is called). */
  readonly begun = signal();
  readonly vm: Record<string, unknown> = { title: () => this.title, subtitle: () => this.subtitle };
  private flags!: KitFlags;
  private screen = new ScreenHolder('ui-screen/title', this.vm, { 'title.start': () => this.start() });

  override ready(): void {
    this.flags = flagsOf(this.world);
    if (!this.started) this.flags.paused = true;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.flags.paused = false;
    this.begun.emit();
  }

  /** The pause action must not get past the title, so the flag is held every step until Start. */
  override fixedUpdate(): void {
    if (!this.started) this.flags.paused = true;
  }

  override update(): void { this.screen.sync(!this.started); }

  override dispose(): void { this.screen.dispose(); }
}

/**
 * The end of a round: won or lost, a table of stats, and Play again. `show(won, { Time: 94, Kills: 12 })` pauses the game
 * and opens `ui-screen/result` (up to 8 stat rows). Play again closes it, unpauses and fires `again`: the game
 * connects that to whatever restarts it (reset the world, reload the level).
 */
export class ResultScreen extends Behaviour {
  static override state = ['shown', 'won', 'rows'];
  shown = false;
  won = false;
  /** The table as [label, value] pairs. */
  rows: [string, string][] = [];
  winText = 'Victory';
  loseText = 'Defeat';
  readonly again = signal();
  readonly vm: Record<string, unknown> = { heading: () => (this.won ? this.winText : this.loseText), stat: {} as Record<string, unknown> };
  private flags!: KitFlags;
  private screen = new ScreenHolder('ui-screen/result', this.vm, { 'result.again': () => this.playAgain() });

  override ready(): void {
    this.flags = flagsOf(this.world);
    const stat = this.vm['stat'] as Record<string, unknown>;
    for (let i = 0; i < ROWS; i++) stat[String(i + 1)] = { label: () => this.rows[i]?.[0] ?? '', value: () => this.rows[i]?.[1] ?? '' };
  }

  show(won: boolean, stats: Record<string, string | number> = {}): void {
    this.won = won;
    this.rows = Object.entries(stats).slice(0, ROWS).map(([k, v]): [string, string] => [k, String(v)]);
    this.shown = true;
    this.flags.paused = true;
    kitIO.input.unlockPointer();
  }

  playAgain(): void {
    if (!this.shown) return;
    this.shown = false;
    this.flags.paused = false;
    this.again.emit();
  }

  override fixedUpdate(): void {
    if (this.shown) this.flags.paused = true;
  }

  override update(): void { this.screen.sync(this.shown); }

  override dispose(): void { this.screen.dispose(); }
}
