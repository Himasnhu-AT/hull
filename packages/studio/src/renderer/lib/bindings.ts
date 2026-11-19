// The pure side of the input-map bindings table: how a pressed key is named in the file, how a name is shown on a chip,
// and which actions fight over the same key. No React and no DOM, so the unit tests run it as is.
//
// The names and aliases mirror hull/src/input/keys.ts (the game's own reader of these files); bindings.test.ts checks
// that the two agree, so the Studio never calls a key a conflict that the game would not, or the other way round.

export type ActionType = 'button' | 'axis' | 'axis2';

/** The buttons of the standard gamepad mapping, as the `pad` field names them. */
export const PAD_BUTTONS = [
  'south', 'east', 'west', 'north', 'bumperL', 'bumperR', 'triggerL', 'triggerR',
  'select', 'start', 'stickLPress', 'stickRPress', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight', 'home',
] as const;
export const PAD_AXES = ['stickLX', 'stickLY', 'stickRX', 'stickRY'] as const;
export const PAD_STICKS = ['stickL', 'stickR'] as const;

/** Slot names per action type: where its keys go. */
export const SLOTS: Readonly<Record<ActionType, readonly string[]>> = {
  button: ['main'],
  axis: ['neg', 'pos'],
  axis2: ['up', 'down', 'left', 'right'],
};

/** The pad names an action of this type can take. */
export const padChoices = (type: ActionType): readonly string[] => (type === 'button' ? PAD_BUTTONS : type === 'axis' ? PAD_AXES : PAD_STICKS);

/** The mouse uses an action of this type can take; a button reads mouse buttons from its keys instead. */
export const mouseChoices = (type: ActionType): readonly string[] => (type === 'axis' ? ['deltaX', 'deltaY', 'wheel'] : type === 'axis2' ? ['delta'] : []);

const ALIASES: Record<string, readonly string[]> = {
  Esc: ['Escape'], Return: ['Enter'], ' ': ['Space'],
  Shift: ['ShiftLeft', 'ShiftRight'], Ctrl: ['ControlLeft', 'ControlRight'], Control: ['ControlLeft', 'ControlRight'],
  Alt: ['AltLeft', 'AltRight'], Meta: ['MetaLeft', 'MetaRight'],
  Up: ['ArrowUp'], Down: ['ArrowDown'], Left: ['ArrowLeft'], Right: ['ArrowRight'],
};

/** The sources a written name stands for ('W' is 'KeyW', 'Shift' is both shift keys), or null for a name nothing reads. */
export function sourcesOf(name: string): readonly string[] | null {
  const alias = ALIASES[name];
  if (alias) return alias;
  if (/^[a-zA-Z]$/.test(name)) return [`Key${name.toUpperCase()}`];
  if (/^[0-9]$/.test(name)) return [`Digit${name}`];
  if (name.startsWith('pad:')) return (PAD_BUTTONS as readonly string[]).includes(name.slice(4)) ? [name] : null;
  return /^(?:[A-Z][A-Za-z0-9]*|Mouse[0-4])$/.test(name) ? [name] : null;
}

/**
 * The name a pressed key gets in the file: its `code` (so the key stays the same on every keyboard layout), with the
 * shorthand 'W' for letters and '1' for digits, the way the maps are written by hand. Null for a key that has no code.
 */
export function captureName(e: { code: string }): string | null {
  const c = e.code;
  if (!c || c === 'Unidentified') return null;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  return /^[A-Z][A-Za-z0-9]*$/.test(c) ? c : null;
}

const LABELS: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Up: '↑', Down: '↓', Left: '←', Right: '→',
  Space: 'Space', Escape: 'Esc', Esc: 'Esc', Enter: 'Enter', Return: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
  ShiftLeft: 'Shift', ShiftRight: 'Shift R', Shift: 'Shift',
  ControlLeft: 'Ctrl', ControlRight: 'Ctrl R', Ctrl: 'Ctrl', Control: 'Ctrl',
  AltLeft: 'Alt', AltRight: 'Alt R', Alt: 'Alt', MetaLeft: 'Cmd', MetaRight: 'Cmd R', Meta: 'Cmd',
  Mouse0: 'Left click', Mouse1: 'Middle click', Mouse2: 'Right click', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
  WheelUp: 'Wheel up', WheelDown: 'Wheel down',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backquote: '`', Backslash: '\\',
};

/** What a chip says for a name written in the file: 'W', '↑', 'Space', 'Shift', 'Left click', 'Pad south'. */
export function displayName(name: string): string {
  const known = LABELS[name];
  if (known) return known;
  if (/^[a-zA-Z0-9]$/.test(name)) return name.toUpperCase();
  if (/^Key[A-Z]$/.test(name)) return name.slice(3);
  if (/^Digit[0-9]$/.test(name)) return name.slice(5);
  if (/^Numpad/.test(name)) return `Num ${name.slice(6)}`;
  if (name.startsWith('pad:')) return `Pad ${name.slice(4)}`;
  return name;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The action's keys by slot: a button's list is the slot 'main'. Whatever shape the file has, this is the same shape. */
export function keySlots(action: unknown): Record<string, string[]> {
  if (!isObj(action)) return {};
  const keys = action['keys'];
  if (Array.isArray(keys)) return { main: list(keys) };
  if (isObj(keys)) return Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, list(v)]));
  return {};
}

/** The pad names of an action as a list: the file may write one name or an array. */
export function padList(action: unknown): string[] {
  if (!isObj(action) || action['pad'] === undefined) return [];
  return list(Array.isArray(action['pad']) ? action['pad'] : [action['pad']]);
}

/** Every name that reads a key, button or pad button for this action: its keys and (for a button) its pad buttons. */
export function boundNames(action: unknown): string[] {
  if (!isObj(action)) return [];
  const out = Object.values(keySlots(action)).flat();
  if (action['type'] === 'button') out.push(...padList(action).map((p) => `pad:${p}`));
  return out;
}

export interface Conflict {
  /** One source both actions read, e.g. 'KeyW'. */
  source: string;
  actions: string[];
}

/** Sources that two or more actions read, in the order of the first action that has them. */
export function findConflicts(actions: Record<string, unknown>): Conflict[] {
  const by = new Map<string, string[]>();
  for (const [name, a] of Object.entries(actions)) {
    const mine = new Set<string>();
    for (const n of boundNames(a)) for (const s of sourcesOf(n) ?? []) mine.add(s);
    for (const s of mine) { const l = by.get(s); if (l) l.push(name); else by.set(s, [name]); }
  }
  return [...by].filter(([, l]) => l.length > 1).map(([source, l]) => ({ source, actions: l }));
}

/** For one chip: the other actions that read a source this name stands for (empty when nothing clashes). */
export function clashesOf(name: string, self: string, conflicts: readonly Conflict[]): string[] {
  const mine = sourcesOf(name) ?? [];
  const out: string[] = [];
  for (const c of conflicts) if (mine.includes(c.source) && c.actions.includes(self)) for (const a of c.actions) if (a !== self && !out.includes(a)) out.push(a);
  return out;
}

/** The action with its type changed: keys are carried over to the new shape and what the new type cannot read is dropped. */
export function retype(action: Record<string, unknown>, type: ActionType): Record<string, unknown> {
  if (action['type'] === type) return action;
  const { keys: _k, mouse, pad, ...rest } = action;
  const all = Object.values(keySlots(action)).flat();
  const out: Record<string, unknown> = { ...rest, type };
  if (type === 'button') out['keys'] = all;
  else {
    const first = SLOTS[type][type === 'axis' ? 1 : 0]!;
    out['keys'] = Object.fromEntries(SLOTS[type].map((s) => [s, s === first ? all : []]));
  }
  if (typeof mouse === 'string' && mouseChoices(type).includes(mouse)) out['mouse'] = mouse;
  if (pad !== undefined && type === 'button' && action['type'] === 'button') out['pad'] = pad;
  return out;
}
