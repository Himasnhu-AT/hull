// hull/ui: a small DOM UI kit. Widgets are plain elements styled by theme variables; values update in onFrame and
// touch the DOM only when they changed. Nothing here writes game state: buttons call functions the game gave them.
import { config } from '../config/index.ts';
import type { Game } from '../core/index.ts';
import '../schema/index.ts';
import type { UiScreenDef } from '../schema/ui-screen.ts';
import type { UiTheme } from '../schema/ui-theme.ts';
import { buildNode, screenProblems, type ScreenEnv, type ViewModel } from './screen.ts';
import { injectStyles } from './styles.ts';
import { applyVars, themeVars } from './theme.ts';
import { UiPanel, type UiContext } from './widgets.ts';

export { UiPanel, UiText, UiBar, UiButton, UiImage, UiWidget } from './widgets.ts';
export type { Anchor, BoxOpts, PanelOpts, UiContext } from './widgets.ts';
export { themeVars, applyVars, DEFAULT_THEME } from './theme.ts';
export { buildNode, readPath, getter, widgetOf, screenProblems, type ScreenEnv, type ViewModel } from './screen.ts';

export interface ScreenOpts {
  /** A named state of the screen: its `mock` values replace the view model's, so the bench can show every state. */
  state?: string;
}

export interface UiScreen {
  readonly id: string;
  readonly panel: UiPanel;
  /** Takes focus to the first button, for a menu that just opened. */
  focusFirst(): boolean;
  close(): void;
}

export interface UiView {
  /** The full-size layer over the game. Add widgets to it: `ui.root.text('Score').setAnchor('top-left')`. */
  root: UiPanel;
  /** An `ui-theme` id ('ui-theme/dark'), a theme value, or undefined for the defaults. Config ids update live. */
  setTheme(theme: string | UiTheme | undefined): void;
  /** Registers a named action for the `on` of ui-screen buttons: 'game.resume'. */
  action(name: string, fn: () => void): () => void;
  /** Where '@key' text comes from. Default: the key itself. */
  setStrings(fn: (key: string) => string | undefined): void;
  /** Builds a `ui-screen` config on top of the layer, bound to `vm`. It is rebuilt when the file changes. */
  screen(id: string, vm: ViewModel, opts?: ScreenOpts): UiScreen;
  /** The open screens, top last. */
  readonly screens: readonly UiScreen[];
  /** Moves keyboard focus through the buttons of the top screen (or the root): for gamepad and d-pad navigation. */
  focusMove(delta: number): boolean;
  dispose(): void;
}

export function mountUi(game: Game, el: HTMLElement, theme?: string): UiView {
  const doc = el.ownerDocument;
  injectStyles(doc);
  const win = doc.defaultView!;
  if (win.getComputedStyle(el).position === 'static') el.style.position = 'relative';

  // Per-frame bindings: a plain array walked by index. Removal leaves a hole that is swept after the walk.
  let live: (() => void)[] = [];
  let holes = false;
  let walking = false;
  const ctx: UiContext = {
    doc,
    track(fn) {
      live.push(fn);
      return () => {
        const i = live.indexOf(fn);
        if (i < 0) return;
        if (walking) { live[i] = noop; holes = true; } else live.splice(i, 1);
      };
    },
  };
  const noop = (): void => {};

  const host = doc.createElement('div');
  host.className = 'hull-ui';
  host.setAttribute('data-hull-ui', '');
  el.appendChild(host);
  const root = new UiPanel(ctx, 'stack');
  // The root is the host element itself so anchors position against the whole game view.
  host.appendChild(root.el);
  root.el.style.cssText = 'position:absolute;inset:0';

  const offs: (() => void)[] = [];
  let lastVars: Record<string, string> = {};
  const setVar = (n: string, v: string): void => host.style.setProperty(n, v);
  const paint = (t: UiTheme | undefined): void => { lastVars = applyVars(setVar, themeVars(t), lastVars); };
  let themeOff: (() => void) | null = null;
  const setTheme = (t: string | UiTheme | undefined): void => {
    themeOff?.();
    themeOff = null;
    if (typeof t === 'string') {
      const id = t.startsWith('ui-theme/') ? t : `ui-theme/${t}`;
      if (config.has(id)) {
        paint(config.lookup('ui-theme', id.slice('ui-theme/'.length)));
        themeOff = config.watch(id, (now) => paint(now as UiTheme));
      } else paint(undefined);
    } else paint(t);
  };
  setTheme(theme);

  const actions = new Map<string, () => void>();
  let strings: (key: string) => string | undefined = () => undefined;
  const open: ScreenImpl[] = [];

  class ScreenImpl implements UiScreen {
    readonly panel: UiPanel;
    private off: (() => void) | null = null;

    constructor(readonly id: string, readonly vm: ViewModel, private readonly opts: ScreenOpts) {
      this.panel = root.stack({ label: id });
      this.panel.el.style.cssText = 'position:absolute;inset:0';
      this.build();
      if (config.has(id)) this.off = config.watch(id, () => this.build());
    }

    private build(): void {
      // A rebuild after a file edit keeps the focused button's place, so tuning a menu does not reset the keyboard.
      const kept = doc.activeElement && this.panel.el.contains(doc.activeElement)
        ? Array.from(this.panel.el.querySelectorAll('button')).indexOf(doc.activeElement as HTMLButtonElement) : -1;
      this.panel.clear();
      if (!config.has(this.id)) throw new Error(`${this.id}: there is no such ui-screen in config/`);
      const def = config.lookup('ui-screen', this.id.slice('ui-screen/'.length)) as UiScreenDef;
      const mock = def.states?.[this.opts.state ?? 'default']?.mock ?? {};
      const env: ScreenEnv = {
        vm: this.vm,
        mock,
        strings: (k) => strings(k) ?? k,
        run: (name) => run(name, this),
      };
      try {
        buildNode(this.panel, def.root, `${this.id}#/root`, env);
      } catch (e) {
        this.panel.clear();
        console.error(`${(e as Error).message}\n(other problems: ${screenProblems(def, this.id).length})`);
        return;
      }
      if (kept >= 0) this.panel.el.querySelectorAll('button')[kept]?.focus();
    }

    focusFirst(): boolean { return this.panel.focusFirst(); }

    close(): void {
      const i = open.indexOf(this);
      if (i < 0) return;
      open.splice(i, 1);
      this.off?.();
      this.panel.dispose();
    }
  }

  function run(name: string, from: ScreenImpl): void {
    if (name === 'ui.close') { from.close(); return; }
    if (name.startsWith('ui.open:')) {
      const s = view.screen(name.slice('ui.open:'.length), from.vm);
      s.focusFirst();
      return;
    }
    const fn = actions.get(name);
    if (fn) fn();
    else console.warn(`ui: no action named "${name}" is registered (a button on ${from.id} presses it)`);
  }

  const view: UiView = {
    root,
    setTheme,
    action(name, fn) {
      actions.set(name, fn);
      return () => { if (actions.get(name) === fn) actions.delete(name); };
    },
    setStrings(fn) { strings = fn; },
    screen(id, vm, opts = {}) {
      const full = id.startsWith('ui-screen/') ? id : `ui-screen/${id}`;
      const s = new ScreenImpl(full, vm, opts);
      open.push(s);
      return s;
    },
    get screens() { return open; },
    focusMove(delta) { return (open.length ? open[open.length - 1]!.panel : root).focusMove(delta); },
    dispose() {
      themeOff?.();
      for (const f of offs.splice(0)) f();
      for (const s of open.slice()) s.close();
      live = [];
      host.remove();
    },
  };

  offs.push(game.onFrame(() => {
    walking = true;
    for (let i = 0; i < live.length; i++) live[i]!();
    walking = false;
    if (holes) { live = live.filter((f) => f !== noop); holes = false; }
  }));
  return view;
}
