// Names a piece and a field the way a person says them: "Player: jump height", "Thud sound: level", "Hud colours: accent".
// One place for the Changes list, the change card, chips and notes, so the same thing is never called two names. No React here.
// The raw id stays reachable: callers put it in a title attribute.

import type { HistoryAuthor } from 'hull/dev/protocol';
import { words } from '../history/plain.ts';

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The word that follows a piece's name for its kind: 'sound/thud' is "Thud sound". An empty word leaves the name as it is. */
const KIND_WORD: Record<string, string> = {
  sound: 'sound', vfx: 'effect', look: 'look', material: 'material', 'ui-theme': 'colours', 'ui-screen': 'screen', 'input-map': 'controls',
  'anim-graph': 'animation', 'anim-set': 'animations', mixer: 'mixer', tuning: 'rules', level: 'level', 'move-set': 'moves', character: '', enemy: '',
};

/** A piece in words. Accepts a config id ('sound/thud'), 'tunables:<block>' or an 'explain:<id>' review key. */
export function pieceName(key: string): string {
  if (key === 'hull.json') return 'Game settings';
  // A source file or any other path is not a piece with a name.
  if (/\.[a-z]+$/i.test(key)) return key;
  if (key.startsWith('tunables:')) return cap(words(key.slice('tunables:'.length)));
  if (key.startsWith('explain:')) return cap(words(key.slice('explain:'.length)));
  const at = key.indexOf('/');
  if (at < 0) return cap(words(key)) || key;
  const kind = key.slice(0, at);
  const rest = cap(words(key.slice(at + 1).replace(/\//g, ' ')));
  const word = KIND_WORD[kind];
  if (word === undefined) return rest || key;
  return word && !rest.toLowerCase().endsWith(word) ? `${rest} ${word}` : rest;
}

/** The kind of config an id names (its first part), or '' for a tunables block. */
export const kindOfKey = (key: string): string => (key.startsWith('tunables:') || key.startsWith('explain:') || key.indexOf('/') < 0 ? '' : key.slice(0, key.indexOf('/')));

/**
 * A field in words: 'jumpHeight' -> 'jump height'; a JSON pointer '/color/accent' on a ui-theme -> 'accent' (the piece is already
 * called "colours"). A file path or anything else that is not a name is left as it is.
 */
export function fieldName(field: string, pieceKey = ''): string {
  if (field.startsWith('/')) {
    let segs = field.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (kindOfKey(pieceKey) === 'ui-theme' && segs.length > 1 && /^colou?rs?$/.test(segs[0]!)) segs = segs.slice(1);
    return segs.map((s) => (/^\d+$/.test(s) ? `row ${Number(s) + 1}` : words(s))).join(' ');
  }
  if (!/^[A-Za-z_][\w.-]*$/.test(field)) return field;
  // The history writes a nested value as 'color.accent'.
  let segs = field.split('.');
  if (kindOfKey(pieceKey) === 'ui-theme' && segs.length > 1 && /^colou?rs?$/.test(segs[0]!)) segs = segs.slice(1);
  return segs.map((s) => (/^\d+$/.test(s) ? `row ${Number(s) + 1}` : words(s))).join(' ');
}

/** 'Player: jump height'. */
export const pieceField = (key: string, field: string): string => `${pieceName(key)}: ${fieldName(field, key)}`;

/** Who made a change: the builder (any agent) or the person. */
export function authorName(by: HistoryAuthor | string): string {
  if (by === 'you') return 'You';
  if (by === 'disk') return 'A file edit';
  return 'Builder';
}

export interface ParsedLine { key: string; field: string; from: string; to: string }

const ARROW = '(?:→|->|\\bto\\b)';
/**
 * One line of a change's details, as the history writes it:
 *   "tuning/arena: crateCount 14 → 20"   a config value (the piece is a config id whose first part is a kind)
 *   "player.runSpeed 7 → 8"              a tunable
 * Anything else (code, the brief, a whole file) is not a value change and gives null.
 */
export function parseLine(text: string): ParsedLine | null {
  const cfg = new RegExp(`^([a-z0-9-]+(?:/[^:\\s]+)+): (\\S+) (.*?) ${ARROW} (.*)$`).exec(text);
  if (cfg) return { key: cfg[1]!, field: cfg[2]!, from: cfg[3]!, to: cfg[4]! };
  const tun = new RegExp(`^(\\w+)\\.(\\w+) (.*?) ${ARROW} (.*)$`).exec(text);
  if (tun) return { key: 'tunables:' + tun[1], field: tun[2]!, from: tun[3]!, to: tun[4]! };
  return null;
}

/** A line of details in words: "Player: jump height 2 → 1.6". Lines that are not value changes come back as they were. */
export function plainLine(text: string): string {
  const p = parseLine(text);
  const unq = (s: string): string => (s.length > 1 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
  return p ? `${pieceField(p.key, p.field)} ${unq(p.from)} → ${unq(p.to)}` : text;
}

/**
 * The lines of `before` that every value change in `now` turns round (same field, from and to swapped): the change a put-back
 * put back. Null when `now` is not a put-back of `before`.
 */
export function undoneBy(now: readonly string[], before: readonly string[]): string[] | null {
  const mine = now.map(parseLine).filter((p): p is ParsedLine => p !== null);
  if (mine.length === 0) return null;
  const old = before.map((text) => ({ text, p: parseLine(text) })).filter((o): o is { text: string; p: ParsedLine } => o.p !== null);
  const found: string[] = [];
  for (const m of mine) {
    const o = old.find((x) => x.p.key === m.key && x.p.field === m.field && x.p.from === m.to && x.p.to === m.from);
    if (!o) return null;
    found.push(o.text);
  }
  return found;
}
