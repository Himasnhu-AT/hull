// Turns a config file's JSON Schema (plus its `x-ui` hints, docs/SCHEMAS.md) and current value into the list of
// fields the Inspector draws. Pure data in, pure data out: no React here, so it runs in the unit tests.
//
// A field the mapping does not understand becomes a `json` field (a text box holding the JSON), so every part of
// a config file stays editable and the server's validation has the last word.

import type { TunableWire } from 'hull/dev/protocol';
import { autoStep } from './math.ts';

export type Widget =
  | 'slider' | 'dial' | 'number' | 'toggle' | 'select' | 'segments' | 'color' | 'curve' | 'vec3' | 'range'
  | 'ref' | 'text' | 'keys' | 'json';

export interface Field {
  /** JSON pointer into the config value; for a tunable, the key. */
  pointer: string;
  key: string;
  label: string;
  widget: Widget;
  group: string;
  order: number;
  advanced: boolean;
  min: number;
  max: number;
  step: number;
  unit: string;
  help: string;
  options: string[];
  /** Kind of config file this id points at (widget `ref`). */
  refKind: string;
  value: unknown;
  /** `false` when a change needs the bench restarted. */
  live: boolean;
}

export interface FormGroup { name: string; dials: Field[]; fields: Field[] }

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);

/** "airControl" -> "Air control", "minGap" -> "Min gap", "level_db" -> "Level db". */
export function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function resolve(root: Schema, node: unknown, depth = 0): Schema {
  if (!isObj(node)) return {};
  const ref = node['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/') && depth < 12) {
    let cur: unknown = root;
    for (const part of ref.slice(2).split('/')) cur = isObj(cur) ? cur[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    const { $ref: _drop, ...rest } = node;
    return { ...resolve(root, cur, depth + 1), ...rest };
  }
  return node;
}

const typeOf = (n: Schema): string | undefined => {
  const t = n['type'];
  return Array.isArray(t) ? (t.find((x) => x !== 'null') as string | undefined) : (t as string | undefined);
};
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Picks the branch of a oneOf/anyOf that fits the value. */
function pickBranch(root: Schema, branches: unknown[], value: unknown): Schema {
  const all = branches.map((b) => resolve(root, b));
  for (const b of all) {
    const props = isObj(b['properties']) ? b['properties'] : {};
    const ok = Object.entries(props).every(([k, p]) => {
      const c = resolve(root, p)['const'];
      return c === undefined || (isObj(value) && value[k] === c);
    });
    if (ok && isObj(value) && typeOf(b) === 'object') return b;
    if (typeOf(b) === 'number' && typeof value === 'number') return b;
    if (typeOf(b) === 'array' && Array.isArray(value)) return b;
    if (typeOf(b) === 'string' && typeof value === 'string') return b;
  }
  return all[0] ?? {};
}

interface Ctx { root: Schema; fields: Field[]; groups: string[] }

function leaf(ctx: Ctx, schema: Schema, key: string, pointer: string, value: unknown, group: string, order: number): void {
  // The whole file as one text box would let a stray edit drop `kind`; a file the schema says nothing about shows no form.
  if (pointer === '') return;
  const ui = isObj(schema['x-ui']) ? schema['x-ui'] : {};
  const type = typeOf(schema);
  const enumVals = Array.isArray(schema['enum']) ? (schema['enum'] as unknown[]) : null;
  const min = num(ui['min'], num(schema['minimum'], -Infinity));
  const max = num(ui['max'], num(schema['maximum'], Infinity));
  const finite = Number.isFinite(min) && Number.isFinite(max);
  const explicit = str(ui['widget']) as Widget | '';
  const refKind = str(schema['x-ref']);

  let widget: Widget;
  if (explicit) widget = explicit;
  else if (refKind) widget = 'ref';
  else if (enumVals) widget = enumVals.length <= 4 && enumVals.every((o) => String(o).length <= 12) ? 'segments' : 'select';
  else if (type === 'boolean') widget = 'toggle';
  else if (type === 'number' || type === 'integer') widget = finite ? 'slider' : 'number';
  else if (type === 'array') widget = Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number') ? 'vec3'
    : Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number') ? 'range' : 'json';
  else if (type === 'string') widget = schema['format'] === 'color' || (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) ? 'color' : 'text';
  else widget = 'json';

  // A slider needs a span to drag over; with one bound missing a number box is the honest widget.
  if ((widget === 'slider' || widget === 'dial') && !finite) widget = 'number';

  const step = num(ui['step'], type === 'integer' ? 1 : finite ? autoStep(min, max) : 0.1);
  ctx.fields.push({
    pointer, key,
    label: str(ui['label']) || str(schema['title']) || humanize(key),
    widget,
    group: str(ui['group']) || group,
    order: num(ui['order'], order),
    advanced: ui['advanced'] === true,
    min, max, step,
    unit: str(ui['unit']),
    help: str(ui['help']) || str(schema['description']),
    options: enumVals ? enumVals.map(String) : [],
    refKind,
    value,
    live: ui['live'] !== false,
  });
}

function walk(ctx: Ctx, schemaIn: unknown, value: unknown, pointer: string, key: string, group: string, order: number): void {
  let schema = resolve(ctx.root, schemaIn);
  const variants = (schema['oneOf'] ?? schema['anyOf']) as unknown[] | undefined;
  const ui = isObj(schema['x-ui']) ? schema['x-ui'] : {};
  if (Array.isArray(variants) && !ui['widget']) schema = { ...schema, ...pickBranch(ctx.root, variants, value) };
  const props = isObj(schema['properties']) ? schema['properties'] : null;
  const addl = isObj(schema['additionalProperties']) ? resolve(ctx.root, schema['additionalProperties']) : null;
  const asObject = typeOf(schema) === 'object' || props || addl;

  if (asObject && !ui['widget']) {
    const obj = isObj(value) ? value : {};
    // The group name for a nested object is its own label, unless it set one.
    const name = pointer === '' ? group : str(ui['group']) || str(schema['title']) || humanize(key);
    let i = 0;
    if (props) {
      for (const [k, sub] of Object.entries(props)) {
        const r = resolve(ctx.root, sub);
        if (r['const'] !== undefined || k === 'kind' || r['x-ui'] && isObj(r['x-ui']) && r['x-ui']['hidden'] === true) { i++; continue; }
        walk(ctx, r, obj[k], `${pointer}/${k}`, k, name, i++);
      }
    }
    if (addl) {
      // Free-form maps (named layers, tuning numbers): one field per key that exists.
      for (const k of Object.keys(obj)) {
        if (props && k in props) continue;
        if (pointer === '' && (k === 'kind' || k === 'note')) continue;
        walk(ctx, addl, obj[k], `${pointer}/${k}`, k, pointer === '' ? 'Values' : name, i++);
      }
    } else if (!props) {
      leaf(ctx, schema, key, pointer, value, group, order);
    }
    return;
  }
  leaf(ctx, schema, key, pointer, value, group, order);
}

/** Groups in the order they first appear; inside a group, by `order` then position. Dials gather in their own grid. */
function toGroups(fields: Field[], showAdvanced: boolean): FormGroup[] {
  const groups = new Map<string, FormGroup>();
  for (const f of fields) {
    if (f.advanced && !showAdvanced) continue;
    let g = groups.get(f.group);
    if (!g) groups.set(f.group, (g = { name: f.group, dials: [], fields: [] }));
    (f.widget === 'dial' ? g.dials : g.fields).push(f);
  }
  for (const g of groups.values()) {
    g.dials.sort((a, b) => a.order - b.order);
    g.fields.sort((a, b) => a.order - b.order);
  }
  return [...groups.values()].filter((g) => g.dials.length + g.fields.length > 0);
}

export function buildForm(schema: unknown, value: unknown, opts: { showAdvanced?: boolean } = {}): FormGroup[] {
  const root = isObj(schema) ? schema : {};
  const ctx: Ctx = { root, fields: [], groups: [] };
  walk(ctx, root, value, '', '', 'General', 0);
  return toGroups(ctx.fields, opts.showAdvanced === true);
}

/** How many fields are hidden as advanced, so the form can offer "Show all". */
export function advancedCount(schema: unknown, value: unknown): number {
  return buildForm(schema, value, { showAdvanced: true }).reduce((n, g) => n + g.dials.length + g.fields.length, 0)
    - buildForm(schema, value).reduce((n, g) => n + g.dials.length + g.fields.length, 0);
}

/** Tunables are fields too: the dev runtime's kind and opts say which widget. */
export function tunableFields(list: readonly TunableWire[]): Field[] {
  return list.map((t, i) => {
    const o = t.opts;
    const min = num(o['min'], -Infinity);
    const max = num(o['max'], Infinity);
    const finite = Number.isFinite(min) && Number.isFinite(max);
    let widget: Widget;
    switch (t.kind) {
      case 'num': {
        const w = str(o['widget']) as Widget | '';
        widget = w === 'dial' || w === 'slider' || w === 'number' ? w : finite ? 'slider' : 'number';
        if ((widget === 'dial' || widget === 'slider') && !finite) widget = 'number';
        break;
      }
      case 'bool': widget = 'toggle'; break;
      case 'color': widget = 'color'; break;
      case 'vec': widget = 'vec3'; break;
      case 'choice': widget = (o['options'] as unknown[] | undefined ?? []).length <= 4 ? 'segments' : 'select'; break;
      case 'range': widget = 'range'; break;
      case 'curve': widget = 'curve'; break;
    }
    return {
      pointer: t.key, key: t.key, label: str(o['label']) || humanize(t.key), widget,
      group: str(o['group']) || humanize(t.block), order: i, advanced: false,
      min, max, step: num(o['step'], finite ? autoStep(min, max) : 0.1),
      unit: str(o['unit']), help: str(o['help']), options: Array.isArray(o['options']) ? (o['options'] as unknown[]).map(String) : [],
      refKind: '', value: t.value, live: true,
    };
  });
}

export const groupFields = (fields: Field[]): FormGroup[] => toGroups(fields, true);
