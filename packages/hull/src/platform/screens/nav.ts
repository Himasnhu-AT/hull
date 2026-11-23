// Gamepad navigation for menus: the d-pad (and left stick) move focus, South presses, East goes back. The keyboard
// already works through the ui kit's menu panels; this adds the pad. The edge and repeat logic is pure so it is tested
// without a gamepad.
import type { Game } from '../../core/index.ts';
import type { UiView } from '../../ui/index.ts';

/** Frames a direction is held before it repeats, then frames between repeats. Frames, not seconds: no clock here. */
const FIRST = 24;
const EVERY = 7;
const STICK = 0.6;

export type NavEvent = 'prev' | 'next' | 'press' | 'back';

/** Turns held directions and buttons into one event per press, with key-style repeat for the directions. */
export class PadNav {
  private held = { prev: 0, next: 0 };
  private south = false;
  private east = false;

  /** `dir` is -1 (up/left), 0 or +1 (down/right). Calls `emit` for what happened this frame. */
  update(dir: number, south: boolean, east: boolean, emit: (e: NavEvent) => void): void {
    this.held.prev = dir < 0 ? this.held.prev + 1 : 0;
    this.held.next = dir > 0 ? this.held.next + 1 : 0;
    for (const k of ['prev', 'next'] as const) {
      const n = this.held[k];
      if (n === 1 || (n > FIRST && (n - FIRST) % EVERY === 0)) emit(k);
    }
    if (south && !this.south) emit('press');
    if (east && !this.east) emit('back');
    this.south = south;
    this.east = east;
  }

  reset(): void { this.held.prev = this.held.next = 0; this.south = this.east = false; }
}

export interface NavOptions {
  /** Navigation stands still while this returns true (a rebind is waiting for a button). */
  paused?: () => boolean;
}

/** Drives `ui` focus from the first connected gamepad while a screen is open. Returns a function that stops it. */
export function attachPadNav(game: Game, ui: UiView, opts: NavOptions = {}, nav: Navigator | undefined = globalThis.navigator): () => void {
  const pad = new PadNav();
  let was = false;
  const off = game.onFrame(() => {
    // Not a menu moment: stay quiet, and forget held buttons so a press that opened the menu does not also press in it.
    const menuOpen = ui.screens.length > 0 || ui.root.el.querySelector('[role=menu]') !== null;
    if (!menuOpen || opts.paused?.()) { pad.reset(); was = false; return; }
    const list = nav?.getGamepads?.() ?? [];
    for (let i = 0; i < list.length; i++) {
      const gp = list[i];
      if (!gp || !gp.connected) continue;
      const b = gp.buttons;
      const ax = gp.axes[0] ?? 0;
      const ay = gp.axes[1] ?? 0;
      const up = !!b[12]?.pressed || !!b[14]?.pressed || ay < -STICK || ax < -STICK;
      const down = !!b[13]?.pressed || !!b[15]?.pressed || ay > STICK || ax > STICK;
      const dir = up && !down ? -1 : down && !up ? 1 : 0;
      if (!was) { was = true; pad.reset(); }
      pad.update(dir, !!b[0]?.pressed, !!b[1]?.pressed, (e) => {
        const doc = ui.root.el.ownerDocument;
        const focused = doc.activeElement as HTMLElement | null;
        if (e === 'prev') ui.focusMove(-1);
        else if (e === 'next') ui.focusMove(1);
        else if (e === 'press') { if (!ui.activate()) focused?.click(); }
        else (focused ?? doc.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      return;
    }
  });
  return off;
}
