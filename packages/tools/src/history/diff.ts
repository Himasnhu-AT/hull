// The diff that understands files (ARCHITECTURE section 7): config JSON by path, tunables by name, assets by size,
// other text by lines. Its output is what the timeline shows, what authorship reads, and what a merge works from.
import type { ChangeDelta } from 'hull/dev/protocol';
import { findTunables } from '../server/tsTunables.ts';
import { lineStats, splitLines } from './lines.ts';

/** The tracked files of one state of the project: path (with '/') to bytes. */
export type FileMap = Map<string, Buffer>;

export const isConfigPath = (p: string): boolean => p === 'hull.json' || (p.startsWith('config/') && p.endsWith('.json'));
export const isTsSource = (p: string): boolean => p.startsWith('src/') && p.endsWith('.ts') && !p.endsWith('.d.ts');
export const isAssetPath = (p: string): boolean => p.startsWith('assets/');
/** 'config/sound/sword/hit.json' -> 'sound/sword/hit'; the manifest keeps its file name, as in the protocol. */
export const configIdOf = (p: string): string => (p === 'hull.json' ? p : p.slice('config/'.length, -'.json'.length));

const MINUS = '−';
const ARROW = '→';

export function showValue(v: unknown): string {
  if (typeof v === 'number') return String(+v.toPrecision(12)).replace('-', MINUS);
  if (v === undefined) return 'nothing';
  const s = JSON.stringify(v);
  return s.length > 48 ? `${s.slice(0, 45)}...` : s;
}

/** '/layers/0/freq' -> 'layers[0].freq'. */
export function pointerWords(pointer: string): string {
  if (pointer === '') return '';
  let out = '';
  for (const raw of pointer.slice(1).split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    out += /^\d+$/.test(seg) ? `[${seg}]` : out ? `.${seg}` : seg;
  }
  return out;
}

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};
const esc = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

function jsonText(id: string, op: ChangeDelta['op'], pointer: string, from: unknown, to: unknown): string {
  const w = pointerWords(pointer);
  if (w === '') return op === 'add' ? `${id} added` : op === 'remove' ? `${id} removed` : `${id}: replaced`;
  if (op === 'add') return `${id}: ${w} added (${showValue(to)})`;
  if (op === 'remove') return `${id}: ${w} removed (was ${showValue(from)})`;
  return `${id}: ${w} ${showValue(from)} ${ARROW} ${showValue(to)}`;
}

/** Differences between two parsed JSON values, by path. Arrays compare by index. */
export function jsonDiff(file: string, id: string, a: unknown, b: unknown, pointer = '', out: ChangeDelta[] = []): ChangeDelta[] {
  const push = (op: ChangeDelta['op'], p: string, from: unknown, to: unknown): void => {
    out.push({ file, kind: 'json', op, target: id, path: p, ...(op !== 'add' ? { from } : {}), ...(op !== 'remove' ? { to } : {}), text: jsonText(id, op, p, from, to) });
  };
  if (deepEqual(a, b)) return out;
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) {
      const p = `${pointer}/${esc(k)}`;
      if (!(k in b)) push('remove', p, a[k], undefined);
      else jsonDiff(file, id, a[k], b[k], p, out);
    }
    for (const k of Object.keys(b)) if (!(k in a)) push('add', `${pointer}/${esc(k)}`, undefined, b[k]);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) jsonDiff(file, id, a[i], b[i], `${pointer}/${i}`, out);
    for (let i = n; i < a.length; i++) push('remove', `${pointer}/${i}`, a[i], undefined);
    for (let i = n; i < b.length; i++) push('add', `${pointer}/${i}`, undefined, b[i]);
  } else push('set', pointer, a, b);
  return out;
}

export interface TunableSpot { block: string; key: string; value: unknown; start: number; end: number }

/** Tunable literals in a source text by 'block.key'. A file that does not parse has none. */
export function tunablesOf(file: string, text: string): Map<string, TunableSpot> {
  const out = new Map<string, TunableSpot>();
  if (!text.includes('tunables')) return out;
  try {
    for (const b of findTunables(file, text)) for (const t of b.tunables) out.set(`${b.block}.${t.key}`, { block: b.block, key: t.key, value: t.value, start: t.start, end: t.end });
  } catch { /* not parseable: no tunables */ }
  return out;
}

/** The text with every tunable literal blanked, so what is left is "the rest of the code". */
export function withoutTunables(file: string, text: string): string {
  const spans = [...tunablesOf(file, text).values()].sort((x, y) => y.start - x.start);
  let out = text;
  for (const s of spans) out = `${out.slice(0, s.start)}0${out.slice(s.end)}`;
  return out;
}

export const isBinary = (b: Buffer): boolean => b.subarray(0, 4096).includes(0);

function linesDelta(file: string, a: string, b: string): ChangeDelta {
  const { added, removed } = lineStats(a, b);
  return { file, kind: 'lines', op: 'set', target: file, path: '', added, removed, text: `${file}: +${added} ${MINUS}${removed} lines` };
}

function diffOne(path: string, a: Buffer | undefined, b: Buffer | undefined): ChangeDelta[] {
  if (isAssetPath(path) || (a && isBinary(a)) || (b && isBinary(b))) {
    const op = !a ? 'add' : !b ? 'remove' : 'set';
    const text = !a ? `${path} added (${size(b!.length)})` : !b ? `${path} removed` : `${path} replaced (${size(a.length)} ${ARROW} ${size(b.length)})`;
    return [{ file: path, kind: 'asset', op, target: path, path: '', text }];
  }
  if (isConfigPath(path)) {
    const id = configIdOf(path);
    const parse = (x: Buffer): { ok: true; v: unknown } | { ok: false } => { try { return { ok: true, v: JSON.parse(x.toString('utf8')) }; } catch { return { ok: false }; } };
    const pa = a ? parse(a) : undefined;
    const pb = b ? parse(b) : undefined;
    if (!a && pb?.ok) return [{ file: path, kind: 'json', op: 'add', target: id, path: '', to: pb.v, text: `${id} added` }];
    if (!b && pa?.ok) return [{ file: path, kind: 'json', op: 'remove', target: id, path: '', from: pa.v, text: `${id} removed` }];
    if (pa?.ok && pb?.ok) return jsonDiff(path, id, pa.v, pb.v);
  }
  const ta = a?.toString('utf8') ?? '';
  const tb = b?.toString('utf8') ?? '';
  if (!a || !b) {
    const n = splitLines(a ? ta : tb).length;
    return [{ file: path, kind: 'file', op: a ? 'remove' : 'add', target: path, path: '', text: a ? `${path} removed (${n} lines)` : `${path} added (${n} lines)` }];
  }
  if (isTsSource(path)) {
    const ma = tunablesOf(path, ta);
    const mb = tunablesOf(path, tb);
    const out: ChangeDelta[] = [];
    const delta = (name: string, op: ChangeDelta['op'], from: unknown, to: unknown, block: string, key: string): void => {
      const text = op === 'add' ? `${name} added (${showValue(to)})` : op === 'remove' ? `${name} removed (was ${showValue(from)})` : `${name} ${showValue(from)} ${ARROW} ${showValue(to)}`;
      out.push({ file: path, kind: 'tunable', op, target: `tunables:${block}`, path: key, ...(op !== 'add' ? { from } : {}), ...(op !== 'remove' ? { to } : {}), text });
    };
    for (const [name, t] of ma) {
      const u = mb.get(name);
      if (!u) delta(name, 'remove', t.value, undefined, t.block, t.key);
      else if (!deepEqual(t.value, u.value)) delta(name, 'set', t.value, u.value, t.block, t.key);
    }
    for (const [name, u] of mb) if (!ma.has(name)) delta(name, 'add', undefined, u.value, u.block, u.key);
    if (withoutTunables(path, ta) !== withoutTunables(path, tb)) out.push(linesDelta(path, ta, tb));
    return out;
  }
  return [linesDelta(path, ta, tb)];
}

/** Everything that differs between two states, in file order. */
export function diffFiles(before: FileMap, after: FileMap): ChangeDelta[] {
  const out: ChangeDelta[] = [];
  for (const p of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(p);
    const b = after.get(p);
    if (a && b && a.equals(b)) continue;
    out.push(...diffOne(p, a, b));
  }
  return out;
}

/** The one-line description of a change: the first deltas in words, and how many more there were. */
export function summarize(deltas: readonly ChangeDelta[]): string {
  if (deltas.length === 0) return 'no changes';
  const shown = deltas.slice(0, 2).map((d) => d.text).join('; ');
  const more = deltas.length - 2;
  return more > 0 ? `${shown}; +${more} more` : shown;
}
