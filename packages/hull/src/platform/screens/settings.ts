// The settings screen: a `ui-screen` value made from the settings and the mixer's buses, built with the hull/ui kit so
// the game's `ui-theme` styles it. A game that wants its own layout puts a `ui-screen/settings` file in config/ and
// this module uses that instead, with the same view model and action names.
import { config } from '../../config/index.ts';
import { buildNode, type ScreenEnv, type UiView, type ViewModel } from '../../ui/index.ts';
import type { UiScreenDef } from '../../schema/ui-screen.ts';
import { QUALITIES, SENSITIVITY_RANGE, type Settings } from '../settings.ts';

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const STEP = 0.1;
const SENS_STEP = 0.25;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The screen as plain data. `buses` are the volume sliders, in the order given. */
export function settingsScreenDef(buses: readonly string[]): UiScreenDef {
  const row = (label: string, ...kids: unknown[]): unknown => ({ row: { gap: 12 }, children: [{ text: { text: label, width: 150 } }, ...kids] });
  const step = (name: string, down: string, up: string, value: string): unknown[] => [
    { button: { text: '-', label: `Lower ${name}` }, on: { press: down } },
    { text: { bind: value, width: 64 } },
    { button: { text: '+', label: `Raise ${name}` }, on: { press: up } },
  ];
  const children: unknown[] = [{ title: { text: 'Settings' } }];
  for (const b of buses) {
    children.push(row(`${cap(b)} volume`,
      { bar: { bind: `settings.volume.${b}`, max: 1, width: 120, label: `${b} volume` } },
      ...step(`${b} volume`, `settings.volume.${b}.down`, `settings.volume.${b}.up`, `settings.volumeText.${b}`)));
  }
  children.push(
    row('Quality', { text: { bind: 'settings.quality', width: 64 } }, { button: { text: 'Change' }, on: { press: 'settings.quality.next' } }),
    row('Fullscreen', { text: { bind: 'settings.fullscreen', width: 64 } }, { button: { text: 'Toggle' }, on: { press: 'settings.fullscreen.toggle' } }),
    row('Invert Y', { text: { bind: 'settings.invertY', width: 64 } }, { button: { text: 'Toggle' }, on: { press: 'settings.invertY.toggle' } }),
    row('Look sensitivity', ...step('sensitivity', 'settings.sensitivity.down', 'settings.sensitivity.up', 'settings.sensitivityText')),
    { row: { gap: 12 }, children: [
      { button: { text: 'Key bindings' }, on: { press: 'settings.bindings' } },
      { button: { text: 'Reset' }, on: { press: 'settings.reset' } },
      { button: { text: 'Back', primary: true }, on: { press: 'settings.back' } },
    ] },
  );
  return { kind: 'ui-screen', pausesGame: true, root: { panel: { align: 'center' as const, menu: true, label: 'Settings', gap: 10 }, on: { back: 'settings.back' }, children } };
}

export interface SettingsScreenDeps {
  settings: Settings;
  /** The bus names to show. Default: the buses of `mixer/main`, else sfx, music, ui, voice. */
  buses?: readonly string[];
  /** Called by the 'Key bindings' button: open the key-binding screen. */
  onBindings?: () => void;
  onClose?: () => void;
  /** Sets the platform's fullscreen state; the settings value follows it. */
  setFullscreen?: (on: boolean) => void;
}

export interface OpenScreen { close(): void; readonly vm: ViewModel; readonly def: UiScreenDef }

function defaultBuses(): string[] {
  if (config.has('mixer/main')) {
    const m = config.lookup('mixer', 'main') as { buses?: Record<string, unknown> };
    const names = Object.keys(m.buses ?? {}).filter((b) => b !== 'master');
    if (names.length) return ['master', ...names];
  }
  return ['master', 'sfx', 'music', 'ui', 'voice'];
}

/** The values and actions behind the screen. Exported so a game's own `ui-screen/settings` can use them. */
export function settingsModel(deps: SettingsScreenDeps, buses: readonly string[]): { vm: ViewModel; actions: Record<string, () => void> } {
  const s = deps.settings;
  const v = (): Readonly<typeof s.values> => s.values;
  const volume: Record<string, () => number> = {};
  const volumeText: Record<string, () => string> = {};
  const actions: Record<string, () => void> = {};
  for (const b of buses) {
    volume[b] = () => v().volume[b] ?? 1;
    volumeText[b] = () => pct(v().volume[b] ?? 1);
    actions[`settings.volume.${b}.down`] = () => s.setVolume(b, Math.round(((v().volume[b] ?? 1) - STEP) * 100) / 100);
    actions[`settings.volume.${b}.up`] = () => s.setVolume(b, Math.round(((v().volume[b] ?? 1) + STEP) * 100) / 100);
  }
  actions['settings.quality.next'] = () => s.set({ quality: QUALITIES[(QUALITIES.indexOf(v().quality) + 1) % QUALITIES.length]! });
  actions['settings.fullscreen.toggle'] = () => {
    const on = !v().fullscreen;
    s.set({ fullscreen: on });
    // `apply` already asks the window to follow; this covers a game that did not call it.
    deps.setFullscreen?.(on);
  };
  actions['settings.invertY.toggle'] = () => s.set({ invertY: !v().invertY });
  actions['settings.sensitivity.down'] = () => s.set({ sensitivity: Math.max(SENSITIVITY_RANGE.min, v().sensitivity - SENS_STEP) });
  actions['settings.sensitivity.up'] = () => s.set({ sensitivity: Math.min(SENSITIVITY_RANGE.max, v().sensitivity + SENS_STEP) });
  actions['settings.reset'] = () => s.reset();
  actions['settings.bindings'] = () => deps.onBindings?.();
  actions['settings.back'] = () => deps.onClose?.();
  const vm: ViewModel = {
    settings: {
      volume,
      volumeText,
      quality: () => cap(v().quality),
      fullscreen: () => (v().fullscreen ? 'On' : 'Off'),
      invertY: () => (v().invertY ? 'On' : 'Off'),
      sensitivityText: () => `${v().sensitivity.toFixed(2)}x`,
    },
  };
  return { vm, actions };
}

/** Opens the settings screen on `ui`. Close it with the returned handle, the Back button or Escape. */
export function openSettingsScreen(ui: UiView, deps: SettingsScreenDeps): OpenScreen {
  const buses = deps.buses ?? defaultBuses();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    offs.forEach((f) => f());
    handle.close();
    deps.onClose?.();
  };
  const { vm, actions } = settingsModel({ ...deps, onClose: close }, buses);
  const offs = Object.entries(actions).map(([n, fn]) => ui.action(n, fn));
  const def = settingsScreenDef(buses);

  let handle: { close(): void };
  if (config.has('ui-screen/settings')) {
    const screen = ui.screen('ui-screen/settings', vm);
    screen.focusFirst();
    handle = screen;
  } else {
    // No file: build the built-in tree on the layer. `buildNode` throws an Error that names the place of a mistake.
    const host = ui.root.stack({ label: 'settings' });
    host.el.style.cssText = 'position:absolute;inset:0';
    const env: ScreenEnv = { vm, mock: {}, strings: (k) => k, run: (n) => actions[n]?.() };
    buildNode(host, def.root, 'settings#/root', env);
    host.focusFirst();
    handle = { close: () => host.dispose() };
  }
  return { close, vm, def };
}
