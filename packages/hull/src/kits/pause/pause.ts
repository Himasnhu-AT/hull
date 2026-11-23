import { Behaviour } from '../../core/index.ts';
import type { UiScreen, UiView } from '../../ui/index.ts';
import { flagsOf, setMenuShowing, type KitFlags } from '../common.ts';
import { kitIO } from '../io.ts';
import { SaveSlots } from '../saves/saves.ts';

/**
 * A pause menu on the `pause` action (Escape, P, the start button). While paused the kits' behaviours skip their
 * steps; the clock keeps ticking so the menu can still read the input. The menu is the `ui-screen/pause` file: Resume,
 * and a Save and a Load button per slot of the `SaveSlots` on the node named "saves", if there is one.
 * Add it before the gameplay behaviours so a step sees the flag before anything acts on it.
 */
export class PauseMenu extends Behaviour {
  static override state = ['paused', 'mine'];
  /** True while this menu is what paused the game. A title or a result screen holds the same flag, and is not ours to draw over or to dismiss. */
  mine = false;
  screen = 'ui-screen/pause';
  readonly vm: Record<string, unknown> = { slot: {}, message: '' };
  private flags!: KitFlags;
  private open: UiScreen | null = null;
  private ui: UiView | null = null;
  private offs: (() => void)[] = [];
  private labels: string[] = [];
  private message = '';

  get paused(): boolean { return this.flags.paused; }
  set paused(v: boolean) { this.set(v); }

  override ready(): void {
    this.flags = flagsOf(this.world);
    const slot = this.vm['slot'] as Record<string, () => string>;
    for (let i = 1; i <= 9; i++) slot[String(i)] = () => this.labels[i - 1] ?? '';
    this.vm['message'] = () => this.message;
  }

  set(on: boolean): void {
    if (on === this.flags.paused) return;
    // Someone else's pause (the title, the result): leave it alone.
    if (!on && !this.mine) return;
    this.flags.paused = on;
    this.mine = on;
    if (on) { kitIO.input.unlockPointer(); this.message = ''; this.refresh(); }
  }

  toggle(): void {
    if (this.flags.paused && !this.mine) return;
    this.set(!this.flags.paused);
  }

  private saves(): SaveSlots | null { return this.world.find('saves')?.get(SaveSlots) ?? null; }

  private refresh(): void {
    const s = this.saves();
    this.labels.length = 0;
    for (let i = 1; s && i <= s.slots; i++) {
      const at = s.savedAt(i);
      this.labels.push(at > 0 ? `Slot ${i}: ${new Date(at).toLocaleTimeString()}` : `Slot ${i}: empty`);
    }
  }

  override fixedUpdate(): void {
    if (kitIO.input.action('pause').pressed) this.toggle();
  }

  override update(): void {
    const ui = kitIO.ui();
    if (ui !== this.ui) {
      for (const f of this.offs.splice(0)) f();
      this.open = null;
      this.ui = ui;
      if (ui) this.wire(ui);
    }
    if (!this.flags.paused) this.mine = false;
    if (!ui) return;
    const showing = this.flags.paused && this.mine;
    if (showing && !this.open) {
      this.open = ui.screen(this.screen, this.vm);
      this.open.focusFirst();
    } else if (!showing && this.open) {
      this.open.close();
      this.open = null;
    }
    // While it is on screen the HUD layers step aside (KitUi, layer 'hud').
    setMenuShowing(this.world, this, this.open !== null);
  }

  private wire(ui: UiView): void {
    this.offs.push(ui.action('pause.resume', () => this.set(false)));
    for (let i = 1; i <= 9; i++) {
      this.offs.push(ui.action(`pause.save.${i}`, () => {
        const s = this.saves();
        this.message = s && s.save(i) ? `Saved to slot ${i}` : 'Could not save';
        this.refresh();
      }));
      this.offs.push(ui.action(`pause.load.${i}`, () => {
        const s = this.saves();
        const ok = !!s && s.load(i);
        this.message = ok ? `Loaded slot ${i}` : 'That slot is empty';
        if (ok) this.set(false);
      }));
    }
  }

  override dispose(): void {
    for (const f of this.offs.splice(0)) f();
    this.open?.close();
    setMenuShowing(this.world, this, false);
  }
}
