// A piece that is only numbers (a tunables block, a tuning config) as a table a person can read: each value's name in words, the
// value with its unit, and what it was before the stage when that is known. No React here, so it is unit-tested in Node.

import type { ChangeDelta, TunableWire } from 'hull/dev/protocol';
import { buildForm, tunableFields, type Field } from '../lib/schemaForm.ts';
import { show } from '../history/changesView.ts';

export interface ValueRow {
  /** "Jump height". */
  name: string;
  /** "2.2 m". */
  value: string;
  /** The value before the stage, when the stage changed it; 'same' when it did not. Undefined when no earlier point is known. */
  before?: string;
  changed: boolean;
}

export interface ValuesView {
  rows: ValueRow[];
  /** Rows left out to keep the card short. */
  more: number;
  /** Whether the table has a "Before" column: the history had an earlier point to compare with. */
  hasBefore: boolean;
}

export const MAX_ROWS = 14;

function rowsFrom(fields: readonly Field[], find: (f: Field) => ChangeDelta | undefined, deltas: readonly ChangeDelta[] | null, withGroup: boolean): ValuesView {
  const rows: ValueRow[] = fields.map((f) => {
    const d = deltas ? find(f) : undefined;
    const name = withGroup && f.group && f.group !== 'General' && f.group.toLowerCase() !== f.label.toLowerCase() ? `${f.group}: ${f.label}` : f.label;
    const base = { name, value: show(f.value, f).text, changed: d !== undefined };
    if (!deltas) return base;
    // A value the stage added had nothing before it.
    return { ...base, before: d ? (d.op === 'add' ? 'new' : show(d.from, f).text) : 'same' };
  });
  return { rows: rows.slice(0, MAX_ROWS), more: Math.max(0, rows.length - MAX_ROWS), hasBefore: deltas !== null };
}

/** The values of one tunables block. `deltas` are the changes from the stage's earlier point (null when unknown). */
export function tunableValues(block: string, list: readonly TunableWire[], deltas: readonly ChangeDelta[] | null): ValuesView {
  const fields = tunableFields(list.filter((t) => t.block === block));
  const target = `tunables:${block}`;
  return rowsFrom(fields, (f) => deltas?.find((d) => d.kind === 'tunable' && d.target === target && d.path === f.pointer), deltas, false);
}

/** The values of one config file, laid out the way the Inspector would. */
export function configValues(id: string, schema: unknown, value: unknown, deltas: readonly ChangeDelta[] | null): ValuesView {
  const fields = buildForm(schema, value, { showAdvanced: true }).flatMap((g) => [...g.dials, ...g.fields]).filter((f) => f.widget !== 'json' && f.widget !== 'map' && f.widget !== 'list');
  return rowsFrom(fields, (f) => deltas?.find((d) => d.kind === 'json' && d.target === id && d.path === f.pointer), deltas, true);
}
