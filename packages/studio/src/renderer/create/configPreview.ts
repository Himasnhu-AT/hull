// A small picture for pieces whose card would otherwise show only an icon: a theme as colour swatches, an input map as its first
// actions with their keys, an animation graph or set as the names of its states or clips. Read from what config.read returns, so
// it is cheap, and pure so it is unit-tested in Node.

export type ConfigPreview =
  | { type: 'swatches'; swatches: { name: string; color: string }[]; more: number }
  | { type: 'keys'; rows: { action: string; keys: string }[]; more: number }
  | { type: 'names'; label: string; names: string[]; more: number };

/** The kinds that get one; every other kind keeps the preview the content browser draws. */
export const PREVIEW_KINDS: ReadonlySet<string> = new Set(['ui-theme', 'input-map', 'anim-graph', 'anim-set']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const COLOR = /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([^)]*\))$/i;

const LIMIT = { swatches: 6, keys: 4, names: 8 };

function cut<T>(all: T[], n: number): { shown: T[]; more: number } { return { shown: all.slice(0, n), more: Math.max(0, all.length - n) }; }

/** Keys of one action in words: ['Space'] -> 'Space'; an axis with up/left/down/right -> 'W A S D'. */
function keysOf(action: unknown): string {
  if (!isObj(action)) return '';
  const k = action['keys'];
  const first = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '');
  if (Array.isArray(k)) return k.slice(0, 2).map(String).join(' / ');
  if (isObj(k)) {
    const dirs = ['up', 'left', 'down', 'right'].map((d) => first(k[d])).filter(Boolean);
    if (dirs.length > 0) return dirs.join(' ');
    return Object.values(k).map(first).filter(Boolean).slice(0, 4).join(' ');
  }
  const pad = action['pad'];
  return typeof pad === 'string' ? pad : '';
}

function swatches(value: Record<string, unknown>): ConfigPreview | null {
  const src = isObj(value['color']) ? value['color'] : isObj(value['colors']) ? value['colors'] : {};
  const all = Object.entries(src).filter((e): e is [string, string] => typeof e[1] === 'string' && COLOR.test(e[1])).map(([name, color]) => ({ name, color }));
  if (all.length === 0) return null;
  const { shown, more } = cut(all, LIMIT.swatches);
  return { type: 'swatches', swatches: shown, more };
}

function keyRows(value: Record<string, unknown>): ConfigPreview | null {
  const actions = isObj(value['actions']) ? value['actions'] : {};
  const all = Object.entries(actions).map(([action, a]) => ({ action, keys: keysOf(a) }));
  if (all.length === 0) return null;
  const { shown, more } = cut(all, LIMIT.keys);
  return { type: 'keys', rows: shown, more };
}

function graphStates(value: Record<string, unknown>): ConfigPreview | null {
  const layers = isObj(value['layers']) ? Object.values(value['layers']) : [];
  const names: string[] = [];
  for (const l of layers) if (isObj(l) && isObj(l['states'])) for (const s of Object.keys(l['states'])) if (!names.includes(s)) names.push(s);
  if (names.length === 0) return null;
  const { shown, more } = cut(names, LIMIT.names);
  return { type: 'names', label: 'states', names: shown, more };
}

function clipNames(value: Record<string, unknown>): ConfigPreview | null {
  const names = isObj(value['clips']) ? Object.keys(value['clips']) : [];
  if (names.length === 0) return null;
  const { shown, more } = cut(names, LIMIT.names);
  return { type: 'names', label: 'clips', names: shown, more };
}

/** The preview for a config's kind and value, or null when there is nothing to show (the card keeps its icon). */
export function previewOf(kind: string, value: unknown): ConfigPreview | null {
  if (!isObj(value)) return null;
  switch (kind) {
    case 'ui-theme': return swatches(value);
    case 'input-map': return keyRows(value);
    case 'anim-graph': return graphStates(value);
    case 'anim-set': return clipNames(value);
    default: return null;
  }
}
