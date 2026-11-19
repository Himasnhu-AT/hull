// Key bindings: every game action maps to up to two keys, which the player can change on the KEYS screen.
// Key names are the ones the HUD shows and the game reads: 'Z', 'Space', 'ArrowUp', 'ShiftLeft', 'Digit1', 'Comma', ...
// The bindings live in Hull's input map (config/input-map/play.json); this file is the view the HUD and the tips read
// them through, and the keys screen's changes go back into the engine's rebinding, kept in localStorage. ACTIONS
// below supplies the names and groups shown, and the keys used until an input view is attached (and in Node).

import type { InputView } from 'hull/input';

export interface ActionDef { id: string; name: string; group: 'MOVE' | 'ROPES' | 'GAS' | 'CUT' | 'OTHER'; keys: string[] }

export const ACTIONS: readonly ActionDef[] = [
  { id: 'forward', name: 'Forward / pump', group: 'MOVE', keys: ['W', 'ArrowUp'] },
  { id: 'back', name: 'Back / brake / slacken', group: 'MOVE', keys: ['S', 'ArrowDown'] },
  { id: 'strafeL', name: 'Step left', group: 'MOVE', keys: ['A'] },
  { id: 'strafeR', name: 'Step right', group: 'MOVE', keys: ['D'] },
  { id: 'left', name: 'Turn left', group: 'MOVE', keys: ['ArrowLeft'] },
  { id: 'right', name: 'Turn right', group: 'MOVE', keys: ['ArrowRight'] },
  { id: 'jump', name: 'Jump (in the air: cut)', group: 'MOVE', keys: ['Space'] },
  { id: 'ropeL', name: 'Left rope', group: 'ROPES', keys: ['Z', 'Q'] },
  { id: 'ropeR', name: 'Right rope', group: 'ROPES', keys: ['X', 'E'] },
  { id: 'land', name: 'Land on rope', group: 'ROPES', keys: ['V'] },
  { id: 'skip', name: 'Next anchor', group: 'ROPES', keys: ['C', 'Tab'] },
  { id: 'hang', name: 'Lock the lines / hang', group: 'ROPES', keys: ['B'] },
  { id: 'gas', name: 'Gas boost', group: 'GAS', keys: ['ShiftLeft', 'ShiftRight'] },
  { id: 'cut', name: 'Cut / whirlwind', group: 'CUT', keys: ['K', 'Enter'] },
  { id: 'blades', name: 'Swap blades', group: 'CUT', keys: ['R'] },
  { id: 'whistle', name: 'Whistle horse', group: 'OTHER', keys: ['F'] },
  { id: 'flare', name: 'Fire a signal flare', group: 'OTHER', keys: ['T'] },
  { id: 'pause', name: 'Pause', group: 'OTHER', keys: ['P'] },
  { id: 'mute', name: 'Mute', group: 'OTHER', keys: ['M'] },
  { id: 'card', name: 'Controls card', group: 'OTHER', keys: ['H'] },
  { id: 'board', name: 'Leaderboard', group: 'OTHER', keys: ['L'] },
  { id: 'quality', name: 'Graphics', group: 'OTHER', keys: ['G'] },
];
export const SLOTS = 2;
const STORE = 'aott.keys.hull.v1';
/** Action id -> its key slots (null: empty slot). */
export type Bindings = Record<string, (string | null)[]>;
const DEFAULTS: Bindings = Object.fromEntries(ACTIONS.map((a) => [a.id, [...a.keys, null, null].slice(0, SLOTS)]));

let view: InputView | null = null;
let map: Bindings = structuredClone(DEFAULTS);
let byKey = index();
let listeners: (() => void)[] = [];
/** Bumps on every change, so displays can tell when to redraw. */
export let version = 0;

/** 'KeyZ' -> 'Z'; everything else keeps its engine name. */
const nameOf = (source: string): string => (source.startsWith('Key') && source.length === 4 ? source.slice(3) : source);
/** 'Z' -> 'KeyZ'. */
const sourceOf = (k: string): string => (/^[A-Z]$/.test(k) ? 'Key' + k : k);

function index(): Map<string, string> {
  const ix = new Map<string, string>();
  for (const id in map) for (const k of map[id]) if (k) ix.set(k, id);
  return ix;
}
function rebuild(): void {
  const m: Bindings = structuredClone(DEFAULTS);
  if (view) {
    const rows = view.bindings();
    for (const id in m) {
      const row = rows.find((r) => r.action === id && r.slot === 'main');
      if (row) m[id] = [...row.sources.map(nameOf), null, null].slice(0, SLOTS);
    }
  }
  map = m;
  byKey = index();
  version++;
}
function changed(): void {
  rebuild();
  if (view) { try { localStorage.setItem(STORE, JSON.stringify(view.overrides())); } catch { /* not kept */ } }
  for (const f of listeners) f();
}

/** Connects the bindings to the engine's input (the mounted one, or a headless core). Pass null to disconnect. */
export function attach(v: InputView | null): void {
  view = v;
  if (!v) { rebuild(); return; }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && typeof saved === 'object') v.setOverrides(saved);
  } catch { /* storage blocked or bad JSON: the map's keys */ }
  v.onBindingsChanged(() => { rebuild(); for (const f of listeners) f(); });
  rebuild();
}

/** The key name for a KeyboardEvent: 'KeyZ' -> 'Z', everything else is e.code. */
export const keyName = (e: KeyboardEvent): string => (e.code && e.code.startsWith('Key') ? e.code.slice(3) : e.code || e.key);
/** Keys bound to an action (slot order, empty slots dropped). */
export const keysFor = (id: string): string[] => (map[id] || []).filter((k): k is string => !!k);
/** Key in one slot, or null. */
export const slotKey = (id: string, slot: number): string | null => (map[id] && map[id][slot]) || null;
/** The action a key is bound to, or undefined. */
export const actionOf = (k: string): string | undefined => byKey.get(k);
export const onChange = (f: () => void): (() => void) => { listeners.push(f); return () => { listeners = listeners.filter((x) => x !== f); }; };

/** Bind key k to an action slot (null clears it). A key belongs to one action only: it leaves its old place. */
export function bind(id: string, slot: number, k: string | null): void {
  if (!view || !map[id]) return;
  try {
    if (k) {
      for (const other in map) {
        if (other === id) continue;
        const i = map[other].indexOf(k);
        if (i >= 0 && view.bindings().some((r) => r.action === other && r.slot === 'main' && r.rebind)) view.unbind(other, 'main', i);
      }
      view.rebind(id, 'main', slot, sourceOf(k));
    } else {
      view.unbind(id, 'main', slot);
    }
  } catch (e) { console.warn('[keys]', (e as Error).message); }
  changed();
}
export function reset(): void { view?.resetBindings(); changed(); }

const LABEL: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  ShiftLeft: 'Shift', ShiftRight: 'R Shift', ControlLeft: 'Ctrl', ControlRight: 'R Ctrl', AltLeft: 'Alt', AltRight: 'R Alt',
  MetaLeft: 'Meta', MetaRight: 'R Meta', Escape: 'Esc', Enter: 'Enter', NumpadEnter: 'Num Enter', Backspace: 'Bksp',
  CapsLock: 'Caps', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', IntlBackslash: '\\', PageUp: 'PgUp', PageDown: 'PgDn',
  Delete: 'Del', Insert: 'Ins', NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .', ContextMenu: 'Menu',
};
/** Short keycap text for a key name: 'ArrowUp' -> '↑', 'Digit4' -> '4', 'Numpad4' -> 'Num 4'. */
export function keyLabel(k: string | null | undefined): string {
  if (!k) return '';
  if (LABEL[k]) return LABEL[k];
  if (k.startsWith('Digit')) return k.slice(5);
  if (k.startsWith('Numpad')) return 'Num ' + k.slice(6);
  return k;
}
/** Keycap text for an action's first key ('—' when it has none). */
export const label = (id: string): string => keyLabel(keysFor(id)[0]) || '—';
/** Text with {action} tokens replaced by key labels: 'Hold {ropeR}' -> 'Hold X'. */
export const fill = (s: unknown): string => String(s).replace(/\{(\w+)\}/g, (m: string, id: string) => (map[id] ? label(id) : m));
