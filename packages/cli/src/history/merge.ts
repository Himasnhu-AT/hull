// Three-way merge (base, ours, theirs) by path for config and by name for tunables; a line merge for other files.
// A conflict is only the same value changed on both sides (ARCHITECTURE section 7).
import type { ChangeDelta, MergeConflict } from 'hull/dev/protocol';
import { setJsonPointer } from '../server/jsonEdit.ts';
import { rewriteTunable } from '../server/tsTunables.ts';
import { configIdOf, deepEqual, isAssetPath, isBinary, isConfigPath, isTsSource, jsonDiff, tunablesOf, withoutTunables, type FileMap } from './diff.ts';
import { merge3Lines, splitLines } from './lines.ts';

export type Resolve = Record<string, 'ours' | 'theirs'>;
export const conflictKey = (c: { target: string; path: string }): string => `${c.target}#${c.path}`;

const ABSENT = Symbol('absent');
type V = unknown | typeof ABSENT;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const esc = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

export interface JsonMerge { value: unknown; conflicts: { path: string; base?: unknown; ours?: unknown; theirs?: unknown }[] }

/**
 * Merges parsed JSON. Objects merge key by key, arrays that kept their length merge item by item (a different item in
 * the same list is not a conflict), everything else is a value: changed on one side it takes that change, changed on
 * both to different results it is a conflict. Ours is kept for an open conflict.
 */
export function mergeJson(base: unknown, ours: unknown, theirs: unknown, pick?: (path: string) => 'ours' | 'theirs' | undefined): JsonMerge {
  const conflicts: JsonMerge['conflicts'] = [];
  const un = (v: V): unknown => (v === ABSENT ? undefined : v);
  const go = (b: V, o: V, t: V, path: string): V => {
    if (deepEqual(o, t)) return o;
    if (deepEqual(b, o)) return t;
    if (deepEqual(b, t)) return o;
    const bb = b === ABSENT ? (isObj(o) && isObj(t) ? {} : b) : b;
    if (isObj(o) && isObj(t) && isObj(bb)) {
      const out: Record<string, unknown> = {};
      for (const k of [...Object.keys(o), ...Object.keys(t)]) {
        if (k in out) continue;
        const r = go(k in bb ? bb[k] : ABSENT, k in o ? o[k] : ABSENT, k in t ? t[k] : ABSENT, `${path}/${esc(k)}`);
        if (r !== ABSENT) out[k] = r;
      }
      return out;
    }
    if (Array.isArray(o) && Array.isArray(t) && Array.isArray(bb) && o.length === t.length && o.length === bb.length) {
      return o.map((_, i) => { const r = go(bb[i], o[i], t[i], `${path}/${i}`); return r === ABSENT ? undefined : r; });
    }
    const choice = pick?.(path);
    if (choice === undefined) conflicts.push({ path, base: un(b), ours: un(o), theirs: un(t) });
    return choice === 'theirs' ? t : o;
  };
  const value = go(base, ours, theirs, '');
  return { value: un(value), conflicts };
}

export interface MergeResult {
  files: FileMap;
  conflicts: MergeConflict[];
  /** The paths whose content differs from ours. */
  changed: string[];
}

const text = (b: Buffer | undefined): string => b?.toString('utf8') ?? '';
const eq = (a: Buffer | undefined, b: Buffer | undefined): boolean => (a === undefined || b === undefined ? a === b : a.equals(b));

function mergeConfig(path: string, base: Buffer | undefined, ours: Buffer, theirs: Buffer, resolve: Resolve, conflicts: MergeConflict[]): Buffer | undefined {
  let b: unknown = {};
  let o: unknown;
  let t: unknown;
  try {
    if (base) b = JSON.parse(text(base));
    o = JSON.parse(text(ours));
    t = JSON.parse(text(theirs));
  } catch { return undefined; }
  const id = configIdOf(path);
  const r = mergeJson(b, o, t, (p) => resolve[`${id}#${p}`]);
  for (const c of r.conflicts) conflicts.push({ file: path, kind: 'json', target: id, path: c.path, base: c.base, ours: c.ours, theirs: c.theirs });
  // Edit ours in place so its formatting survives; only a removal needs the whole file written again.
  const deltas: ChangeDelta[] = jsonDiff(path, id, o, r.value);
  let out = text(ours);
  if (deltas.some((d) => d.op === 'remove')) {
    const indent = /\n(\s+)\S/.exec(out)?.[1] ?? '  ';
    return Buffer.from(`${JSON.stringify(r.value, null, indent)}\n`);
  }
  for (const d of deltas) {
    const e = setJsonPointer(out, d.path, d.to);
    if (!e.ok) return Buffer.from(`${JSON.stringify(r.value, null, 2)}\n`);
    out = e.text;
  }
  return Buffer.from(out);
}

function mergeText(path: string, base: Buffer | undefined, ours: Buffer, theirs: Buffer, resolve: Resolve, conflicts: MergeConflict[]): Buffer {
  let b = text(base);
  let o = text(ours);
  let t = text(theirs);
  const tunableConflicts: MergeConflict[] = [];

  if (isTsSource(path)) {
    // Tunables first, by name: a different knob on each side never touches the line merge.
    const tb = tunablesOf(path, b);
    const to = tunablesOf(path, o);
    const tt = tunablesOf(path, t);
    const apply = (src: string, block: string, key: string, v: unknown): string => {
      const r = rewriteTunable(path, src, block, key, v);
      return r.ok ? r.text : src;
    };
    for (const [name, th] of tt) {
      const ou = to.get(name);
      if (!ou) continue;
      const ba = tb.get(name);
      if (deepEqual(ou.value, th.value)) continue;
      const target = `tunables:${th.block}`;
      const key = `${target}#${th.key}`;
      if (ba && deepEqual(ba.value, ou.value)) o = apply(o, th.block, th.key, th.value);
      else if (ba && deepEqual(ba.value, th.value)) continue;
      else if (resolve[key] === 'theirs') o = apply(o, th.block, th.key, th.value);
      else if (resolve[key] === undefined) tunableConflicts.push({ file: path, kind: 'tunable', target, path: th.key, base: ba?.value, ours: ou.value, theirs: th.value });
      // Both sides now agree on this knob for the line merge.
      const now = tunablesOf(path, o).get(name);
      if (now) t = apply(t, th.block, th.key, now.value);
    }
    if (withoutTunables(path, b) === withoutTunables(path, o) && withoutTunables(path, b) === withoutTunables(path, t)) {
      conflicts.push(...tunableConflicts);
      return Buffer.from(o);
    }
  }

  const m = merge3Lines(splitLines(b), splitLines(o), splitLines(t), (c) => resolve[`${path}#lines:${c.line}`]);
  conflicts.push(...tunableConflicts);
  for (const c of m.conflicts) conflicts.push({ file: path, kind: 'lines', target: path, path: `lines:${c.line}`, base: c.base.join('\n'), ours: c.ours.join('\n'), theirs: c.theirs.join('\n') });
  const endsNl = o.endsWith('\n') || t.endsWith('\n');
  return Buffer.from(m.lines.join('\n') + (endsNl && m.lines.length ? '\n' : ''));
}

/** Merges whole project states. Files only one side touched are taken as they are. */
export function mergeFiles(base: FileMap, ours: FileMap, theirs: FileMap, resolve: Resolve = {}): MergeResult {
  const files: FileMap = new Map();
  const conflicts: MergeConflict[] = [];
  const changed: string[] = [];
  for (const p of [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort()) {
    const b = base.get(p);
    const o = ours.get(p);
    const t = theirs.get(p);
    let r: Buffer | undefined;
    if (eq(o, t) || eq(b, t)) r = o;
    else if (eq(b, o)) r = t;
    else if (!o || !t) {
      // One side deleted what the other changed.
      const key = `${p}#`;
      const pick = resolve[key];
      if (pick === undefined) conflicts.push({ file: p, kind: 'file', target: p, path: '', base: b ? 'present' : 'absent', ours: o ? 'present' : 'deleted', theirs: t ? 'present' : 'deleted' });
      r = pick === 'theirs' ? t : o;
    } else if (isAssetPath(p) || isBinary(o) || isBinary(t)) {
      const key = `${p}#`;
      const pick = resolve[key];
      if (pick === undefined) conflicts.push({ file: p, kind: 'asset', target: p, path: '', ours: `${o.length} bytes`, theirs: `${t.length} bytes` });
      r = pick === 'theirs' ? t : o;
    } else if (isConfigPath(p)) {
      r = mergeConfig(p, b, o, t, resolve, conflicts) ?? mergeText(p, b, o, t, resolve, conflicts);
    } else r = mergeText(p, b, o, t, resolve, conflicts);
    if (r) files.set(p, r);
    if (!eq(r, o)) changed.push(p);
  }
  return { files, conflicts, changed };
}
