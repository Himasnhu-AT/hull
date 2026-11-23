// A stand-in for the browser UI layer, for tests of kits that draw: it builds real widgets over a fake DOM, builds
// ui-screen configs with the real screen builder, and lets a test read the visible text and press buttons. Node only;
// never imported by a game.
import { config } from '../config/index.ts';
import type { Game } from '../core/index.ts';
import type { UiScreenDef } from '../schema/ui-screen.ts';
import { buildNode, UiPanel, type UiContext, type UiScreen, type UiView, type ViewModel } from '../ui/index.ts';

export class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs: Record<string, string> = {};
  classes = new Set<string>();
  listeners: Record<string, (() => void)[]> = {};
  className = '';
  textContent = '';
  disabled = false;
  style: Record<string, unknown> & { setProperty(k: string, v: string): void } = { setProperty() {} };
  /** Real elements have these; the fake keeps them so a test can read the layout the ui module sets. */
  clientWidth = 0;
  clientHeight = 0;
  classList = {
    add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)),
    toggle: (c: string, on: boolean) => { if (on) this.classes.add(c); else this.classes.delete(c); },
  };
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  appendChild(c: FakeEl): void { c.parent = this; this.children.push(c); }
  addEventListener(t: string, fn: () => void): void { (this.listeners[t] ??= []).push(fn); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  click(): void { this.listeners['click']?.forEach((f) => f()); }
  focus(): void { FakeEl.active = this; }
  static active: FakeEl | null = null;
  contains(e: unknown): boolean { return e === this || this.children.some((c) => c.contains(e)); }
  querySelector(sel: string): FakeEl | null { return sel === '[role=menu]' ? this.all().find((e) => e.attrs['role'] === 'menu') ?? null : null; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  preventDefault(): void {}
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  /** Hidden by its own class or by an ancestor's. */
  get hidden(): boolean { return this.classes.has('hull-hidden') || this.classes.has('hull-off') || (this.parent?.hidden ?? false); }
}

export interface FakeUi {
  view: UiView;
  root: FakeEl;
  /** Runs every binding once, like a frame of the page. */
  tick(): void;
  /** The text of each visible, non-empty text element, in order. */
  texts(): string[];
  /** Presses the visible button with this text; false when there is none. */
  press(label: string): boolean;
  /** Visible bars as [label, value, max]. */
  bars(): [string, number, number][];
  /** Puts the fake on `globalThis.hull.ui` (where `kitIO.ui()` looks) and ticks it every frame of `game`. Returns the undo. */
  install(game: Game): () => void;
  /** Names of the ui-screens that are open. */
  open(): string[];
  /** The text of the focused button, or null. */
  focused(): string | null;
  /** Presses a key like the page does for a menu (Enter, Space): the view's own key handling. */
  key(k: string): boolean;
}

export function fakeUi(): FakeUi {
  const live: (() => void)[] = [];
  const ctx: UiContext = {
    doc: { createElement: (t: string) => new FakeEl(t), get activeElement() { return FakeEl.active; } } as unknown as Document,
    track: (fn) => { live.push(fn); return () => { const i = live.indexOf(fn); if (i >= 0) live.splice(i, 1); }; },
  };
  const root = new UiPanel(ctx, 'stack');
  const actions = new Map<string, () => void>();
  const open: { id: string; panel: UiPanel }[] = [];
  const view: UiView = {
    root,
    setTheme() {},
    action(name, fn) { actions.set(name, fn); return () => { if (actions.get(name) === fn) actions.delete(name); }; },
    setStrings() {},
    screen(id: string, vm: ViewModel): UiScreen {
      const full = id.startsWith('ui-screen/') ? id : `ui-screen/${id}`;
      const panel = root.stack({ label: full });
      const def = config.lookup('ui-screen', full.slice('ui-screen/'.length)) as UiScreenDef;
      buildNode(panel, def.root, `${full}#/root`, { vm, mock: {}, strings: (k) => k, run: (n) => actions.get(n)?.() });
      const entry = { id: full, panel };
      open.push(entry);
      return { id: full, panel, focusFirst: () => panel.focusFirst(), activate: () => panel.activate(), close() { const i = open.indexOf(entry); if (i >= 0) { open.splice(i, 1); panel.dispose(); } } };
    },
    get screens() { return open.map((o) => ({ id: o.id, panel: o.panel }) as unknown as UiScreen); },
    focusMove: (d) => (open.length ? open[open.length - 1]!.panel : root).focusMove(d),
    activate: () => (open.length ? open[open.length - 1]!.panel : root).activate(),
    scale: 1,
    dispose() {},
  };
  const el = (): FakeEl => root.el as unknown as FakeEl;
  const tick = (): void => { for (const f of live.slice()) f(); };
  return {
    view,
    get root() { return el(); },
    tick,
    texts: () => el().all().filter((e) => (e.tag === 'p' || e.tag === 'h2') && !e.hidden && e.textContent !== '').map((e) => e.textContent),
    press(label) {
      const b = el().all().find((e) => e.tag === 'button' && !e.hidden && e.textContent === label);
      b?.click();
      return !!b;
    },
    bars: () => el().all().filter((e) => e.attrs['role'] === 'progressbar' && !e.hidden)
      .map((e): [string, number, number] => [e.attrs['aria-label'] ?? '', Number(e.attrs['aria-valuenow']), Number(e.attrs['aria-valuemax'])]),
    install(game) {
      const g = globalThis as { hull?: Record<string, unknown> };
      const prev = g.hull;
      g.hull = { ...prev, ui: view };
      const off = game.onFrame(tick);
      return () => { off(); g.hull = prev; };
    },
    open: () => open.map((o) => o.id),
    focused: () => (FakeEl.active && FakeEl.active.tag === 'button' ? FakeEl.active.textContent : null),
    key(k) {
      if (k !== 'Enter' && k !== ' ') return false;
      const top = open[open.length - 1];
      const active = FakeEl.active;
      // A focused button presses itself, like a real <button>; otherwise the menu's first button does.
      if (active && top?.panel.focusables().includes(active as unknown as HTMLElement)) { active.click(); return true; }
      return top ? top.panel.activate() : false;
    },
  };
}
