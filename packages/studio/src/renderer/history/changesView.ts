// The Changes panel's words: a list of deltas (history.diff) turned into rows a person reads, with the Inspector's labels
// and formatting. No React and no disk here, so it is unit-tested in Node.
//   config JSON:  "Sky › Horizon   #d6c1ac → #5a9bff" (colours get swatches, numbers their unit)
//   tunables:     "hook › Range   115 → 160"
//   everything else is a file with a line count, whose compact line diff is fetched when it is opened.

import type { ChangeDelta, HistoryAuthor } from 'hull/dev/protocol';
import { formatNumber, unescapePointer } from '../lib/math.ts';
import { humanize, type Field } from '../lib/schemaForm.ts';

/** One value as the Inspector would show it. `swatch` is a CSS colour for colour fields. */
export interface Shown { text: string; swatch?: string }

/** What the Inspector knows about the field a delta touches. */
export type FieldInfo = Pick<Field, 'pointer' | 'label' | 'group' | 'widget' | 'unit' | 'step'>;
/** Finds the field for a config id ('look/dawn') or 'tunables:<block>' and a pointer or tunable key; undefined when the Inspector has none. */
export type FieldLookup = (target: string, pointer: string) => FieldInfo | undefined;

/** How a row goes back: through the same validated, recorded paths the Inspector's edits take. */
export type Revert =
  | { via: 'config.set'; id: string; pointer: string; value: unknown }
  | { via: 'tunables.set'; block: string; key: string; value: unknown }
  | { via: 'history.revert'; file: string; pointer?: string };

export interface ChangeRow {
  key: string;
  file: string;
  kind: ChangeDelta['kind'];
  op: ChangeDelta['op'];
  /** 'Sky', 'Horizon' / 'hook', 'Range' / a file path. */
  path: string[];
  from?: Shown;
  to?: Shown;
  /** A small badge for the shape of the change: 'added', 'removed', '+3 −1 lines'. */
  note: string;
  revert: Revert;
  by?: HistoryAuthor;
}

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const MINUS = '−';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const plainNum = (n: number): string => String(Math.round(n * 10000) / 10000).replace('-', MINUS);

/** A value the way the field's widget would write it: a number with its unit, a colour with a swatch, on/off. */
export function show(v: unknown, f?: FieldInfo): Shown {
  if (v === undefined) return { text: 'nothing' };
  const unit = f?.unit ? ` ${f.unit}` : '';
  if (typeof v === 'string' && (f?.widget === 'color' || HEX.test(v)) && HEX.test(v)) return { text: v.toLowerCase(), swatch: v };
  if (typeof v === 'boolean') return { text: v ? 'on' : 'off' };
  if (typeof v === 'number') return { text: `${f && Number.isFinite(f.step) && f.step > 0 ? formatNumber(v, f.step).replace('-', MINUS) : plainNum(v)}${unit}` };
  if (typeof v === 'string') return { text: v.length > 40 ? `${v.slice(0, 38)}...` : v };
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
    const parts = v.map((x) => (f && f.step > 0 ? formatNumber(x as number, f.step) : plainNum(x as number)).replace('-', MINUS));
    return { text: `${f?.widget === 'range' ? parts.join(' to ') : parts.join(', ')}${unit}` };
  }
  const s = JSON.stringify(v);
  return { text: s.length > 44 ? `${s.slice(0, 42)}...` : s };
}

const lastSeg = (p: string): string => unescapePointer(p.slice(p.lastIndexOf('/') + 1));

/** The place of a config delta in words: the Inspector's group and label, then anything below that field. */
function jsonPath(d: ChangeDelta, lookup: FieldLookup): { path: string[]; field?: FieldInfo } {
  const segs = d.path === '' ? [] : d.path.slice(1).split('/');
  // The longest pointer prefix the Inspector has a field for; the rest is spelled out below it.
  for (let n = segs.length; n > 0; n--) {
    const ptr = `/${segs.slice(0, n).join('/')}`;
    const f = lookup(d.target, ptr);
    if (!f) continue;
    const rest = segs.slice(n).map((s) => (/^\d+$/.test(s) ? `row ${Number(s) + 1}` : humanize(unescapePointer(s))));
    const head = f.group && f.group.toLowerCase() !== f.label.toLowerCase() ? [f.group, f.label] : [f.label];
    return { path: [...head, ...rest], ...(n === segs.length ? { field: f } : {}) };
  }
  return { path: segs.map((s) => (/^\d+$/.test(s) ? `row ${Number(s) + 1}` : humanize(unescapePointer(s)))) };
}

export function describe(d: ChangeDelta, lookup: FieldLookup, by?: HistoryAuthor): ChangeRow {
  const key = `${d.file}|${d.target}|${d.path}|${d.op}`;
  const base = { key, file: d.file, kind: d.kind, op: d.op, ...(by ? { by } : {}) };
  const whole: Revert = { via: 'history.revert', file: d.file };
  if (d.kind === 'json') {
    if (d.path === '') return { ...base, path: [d.target], note: d.op === 'add' ? 'new file' : d.op === 'remove' ? 'file removed' : 'replaced', revert: whole };
    const { path, field } = jsonPath(d, lookup);
    const isRow = /^\d+$/.test(lastSeg(d.path)) && d.op !== 'set';
    const row: ChangeRow = {
      ...base, path,
      ...(d.op !== 'add' ? { from: show(d.from, field) } : {}),
      ...(d.op !== 'remove' ? { to: show(d.to, field) } : {}),
      note: d.op === 'add' ? (isRow ? 'row added' : 'added') : d.op === 'remove' ? (isRow ? 'row removed' : 'removed') : '',
      revert: d.op === 'add' ? { via: 'history.revert', file: d.file, pointer: d.path } : { via: 'config.set', id: d.target, pointer: d.path, value: d.from },
    };
    return row;
  }
  if (d.kind === 'tunable') {
    const block = d.target.replace(/^tunables:/, '');
    const f = lookup(d.target, d.path);
    return {
      ...base, path: [block, f?.label ?? humanize(d.path)],
      ...(d.op !== 'add' ? { from: show(d.from, f) } : {}),
      ...(d.op !== 'remove' ? { to: show(d.to, f) } : {}),
      note: d.op === 'add' ? 'added' : d.op === 'remove' ? 'removed' : '',
      revert: d.op === 'set' ? { via: 'tunables.set', block, key: d.path, value: d.from } : whole,
    };
  }
  const note = d.kind === 'lines' ? `+${d.added ?? 0} ${MINUS}${d.removed ?? 0} lines` : d.op === 'add' ? 'new' : d.op === 'remove' ? 'removed' : 'changed';
  return { ...base, path: [d.file], note, revert: whole };
}

export interface FileGroup { file: string; title: string; kind: 'config' | 'code' | 'asset' | 'other'; rows: ChangeRow[]; by?: HistoryAuthor }

/** The deltas grouped by file, in file order, each row described. `authors` says who last changed each file. */
export function groupRows(deltas: readonly ChangeDelta[], lookup: FieldLookup, authors: ReadonlyMap<string, HistoryAuthor> = new Map()): FileGroup[] {
  const out = new Map<string, FileGroup>();
  for (const d of deltas) {
    let g = out.get(d.file);
    if (!g) {
      const kind = d.file === 'hull.json' || d.file.startsWith('config/') ? 'config' : d.file.startsWith('src/') ? 'code' : d.file.startsWith('assets/') ? 'asset' : 'other';
      const title = d.kind === 'json' ? d.target : d.file;
      const by = authors.get(d.file);
      g = { file: d.file, title, kind, rows: [], ...(by ? { by } : {}) };
      out.set(d.file, g);
    }
    g.rows.push(describe(d, lookup, authors.get(d.file)));
  }
  return [...out.values()];
}

/** The latest author of each file, from the changes after the baseline (oldest first). */
export function lastAuthors(steps: readonly { by: HistoryAuthor; deltas: readonly ChangeDelta[] }[]): Map<string, HistoryAuthor> {
  const m = new Map<string, HistoryAuthor>();
  for (const s of steps) for (const d of s.deltas) m.set(d.file, s.by);
  return m;
}

/** Revert actions for a whole file: field reverts go back to front so array rows keep their indexes. */
export function revertOrder(rows: readonly ChangeRow[]): ChangeRow[] {
  return [...rows].sort((a, b) => b.key.localeCompare(a.key, undefined, { numeric: true }));
}
