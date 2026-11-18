// The browser and the desktop shell behind one object: where data is kept, the window, fullscreen, the pointer lock
// policy and what happens when the page is hidden. Everything a game needs from the host, and nothing else.
import type { Game } from '../core/index.ts';
import { detectKind, shellBridge, type PlatformKind } from './detect.ts';
import { createSaves, type Migrations, type Saves } from './saves.ts';
import { createSettings, type Settings, type SettingsValues } from './settings.ts';
import { localStore, memoryStore } from './store.ts';
import type { HullShell, Report, Store } from './types.ts';

/**
 * When the mouse is taken for look control:
 * - `click`: the first click on the game's element locks it (what a first-person game wants).
 * - `manual`: only when game code calls `input.lockPointer()`.
 * - `never`: not at all (a game played with the cursor).
 * Whatever the policy, the lock is dropped while a menu is open or the page is hidden.
 */
export type PointerLockPolicy = 'click' | 'manual' | 'never';

export interface PlatformOptions {
  /** Names the game's data: localStorage keys, and (by the shell) the app-data folder. */
  id: string;
  version?: number;
  migrations?: Migrations;
  /** The element clicks are read on for the `click` pointer lock policy. */
  el?: HTMLElement;
  pointerLock?: PointerLockPolicy;
  /** The input view, for the pointer lock and for menus (`input.enabled`). */
  input?: { lockPointer(): void; unlockPointer(): void; readonly pointerLocked: boolean; enabled: boolean };
  defaults?: Partial<SettingsValues>;
  report?: Report;
  /** For tests. */
  store?: Store;
  doc?: Document;
  win?: Window & { hullShell?: HullShell };
}

export interface Fullscreen {
  readonly active: boolean;
  set(on: boolean): void;
  toggle(): void;
}

export interface Platform {
  readonly kind: PlatformKind;
  readonly saves: Saves;
  readonly settings: Settings;
  readonly fullscreen: Fullscreen;
  /** true while a menu has the keyboard: the lock is released and game input reads idle. */
  setMenuOpen(open: boolean): void;
  /** The desktop shell quits; a browser has nothing to quit and this does nothing. */
  quit(): void;
  /** The cap `settings.quality` puts on the device pixel ratio; the view that sizes the canvas reads this. */
  readonly pixelRatioCap: number;
  /** The ratio the canvas should use now: the device's, up to the cap. */
  pixelRatio(): number;
  dispose(): void;
}

export function createPlatform(game: Game, opts: PlatformOptions): Platform {
  const win = opts.win ?? (globalThis as unknown as Window & { hullShell?: HullShell });
  const doc = opts.doc ?? win.document;
  const shell = shellBridge(win);
  const kind = detectKind(win);
  const report: Report = opts.report ?? ((m) => console.warn(`[hull platform] ${m}`));

  let store: Store;
  if (opts.store) store = opts.store;
  else if (shell) store = shell;
  else {
    let ls: Storage | null = null;
    try { ls = win.localStorage; } catch { /* blocked site data */ }
    if (ls) store = localStore(opts.id, ls);
    else { report('platform: localStorage is not available, saves and settings last only for this session'); store = memoryStore(); }
  }

  const saves = createSaves({ store, version: opts.version ?? 1, ...(opts.migrations ? { migrations: opts.migrations } : {}), report });
  const settings = createSettings({ store, ...(opts.defaults ? { defaults: opts.defaults } : {}), report });
  const offs: (() => void)[] = [];

  // ---- fullscreen --------------------------------------------------------------------------------------------
  const fullscreen: Fullscreen = {
    get active() { return shell ? shell.getFullscreen() : !!doc.fullscreenElement; },
    set(on) {
      if (shell) { shell.setFullscreen(on); return; }
      // Browsers only allow this from a click or key press; a refusal is normal at start and not worth a report.
      try {
        const p = on ? doc.documentElement.requestFullscreen() : doc.fullscreenElement ? doc.exitFullscreen() : undefined;
        void p?.catch(() => {});
      } catch { /* not supported here */ }
    },
    toggle() { fullscreen.set(!fullscreen.active); },
  };
  // Fullscreen entered or left by the browser's own key (Esc) is kept in step with the setting.
  const onFs = (): void => { if (doc.fullscreenElement ? !settings.values.fullscreen : settings.values.fullscreen) settings.set({ fullscreen: !!doc.fullscreenElement }); };
  doc.addEventListener('fullscreenchange', onFs);
  offs.push(() => doc.removeEventListener('fullscreenchange', onFs));

  // ---- visibility: a hidden tab stops the game -----------------------------------------------------------------
  // We only undo a pause we made, so a game the player paused stays paused when they come back.
  let pausedByUs = false;
  const onVis = (): void => {
    if (doc.hidden) {
      if (!game.paused) { game.paused = true; pausedByUs = true; }
      if (opts.input?.pointerLocked) opts.input.unlockPointer();
    } else if (pausedByUs) {
      game.paused = false;
      pausedByUs = false;
    }
  };
  doc.addEventListener('visibilitychange', onVis);
  offs.push(() => doc.removeEventListener('visibilitychange', onVis));

  // ---- pointer lock policy -------------------------------------------------------------------------------------
  let menuOpen = false;
  const policy = opts.pointerLock ?? 'manual';
  if (policy === 'click' && opts.el && opts.input) {
    const input = opts.input;
    const onClick = (): void => { if (!menuOpen && !doc.hidden && !input.pointerLocked) input.lockPointer(); };
    opts.el.addEventListener('click', onClick);
    offs.push(() => opts.el!.removeEventListener('click', onClick));
  }

  // ---- pixel ratio and quality ---------------------------------------------------------------------------------
  let cap = 1.5;
  const self: Platform = {
    kind,
    saves,
    settings,
    fullscreen,
    setMenuOpen(open) {
      menuOpen = open;
      if (!opts.input) return;
      opts.input.enabled = !open;
      if (open && opts.input.pointerLocked) opts.input.unlockPointer();
    },
    quit() { shell?.quit(); },
    get pixelRatioCap() { return cap; },
    pixelRatio() { return Math.min(win.devicePixelRatio || 1, cap); },
    dispose() { for (const f of offs.splice(0)) f(); },
  };
  // The quality preset sets the cap even for games that never call `settings.apply`.
  offs.push(settings.apply({ pixelRatioCap: (c) => { cap = c; } }));
  return self;
}
