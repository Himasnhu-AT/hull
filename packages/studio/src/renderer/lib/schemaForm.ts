// Turns a config file's JSON Schema (plus its `x-ui` hints, docs/SCHEMAS.md) and current value into the list of
// fields the Inspector draws. Pure data in, pure data out: no React here, so it runs in the unit tests.
//
// A field the mapping does not understand becomes a `json` field (a text box holding the JSON), so every part of
// a config file stays editable and the server's validation has the last word.

import type { TunableWire } from 'hull/dev/protocol';
import { autoStep } from './math.ts';

export type Widget =
  | 'slider' | 'dial' | 'number' | 'toggle' | 'select' | 'segments' | 'color' | 'curve' | 'vec3' | 'range'
  | 'ref' | 'text' | 'keys' | 'json' | 'map' | 'list' | 'checks';

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
  /** The schema's default, when it names one. */
  def: unknown;
  /** The file has no value here: `value` is the default (or nothing) and the form shows it muted. */
  unset: boolean;
  /** The schema had no widget for this shape, so the field is the raw JSON. */
  fallback: boolean;
  /** For `select`/`segments`: the real value behind each option label (numbers and booleans stay what they are). */
  optionValues: unknown[];
  /** For `map`: the schema of each value; for `list`: the schema of each item. `schemaRoot` is the whole schema they resolve against. */
  valueSchema: Schema | null;
  schemaRoot: Schema | null;
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
function pickBranch(root: Schema, branches: unknown[], value: unknown): Schema | null {
  const all = branches.map((b) => resolve(root, b));
  for (const b of all) {
    const props = isObj(b['properties']) ? b['properties'] : {};
    const ok = Object.entries(props).every(([k, p]) => {
      const c = resolve(root, p)['const'];
      return c === undefined || (isObj(value) && value[k] === c);
    });
    if (ok && isObj(value) && typeOf(b) === 'object') return b;
    if ((typeOf(b) === 'number' || typeOf(b) === 'integer') && typeof value === 'number') return b;
    if (typeOf(b) === 'boolean' && typeof value === 'boolean') return b;
    if (typeOf(b) === 'array' && Array.isArray(value)) return b;
    if (typeOf(b) === 'string' && typeof value === 'string') return b;
  }
  // No branch fits the value: with no value yet the first one is the shape to start from, otherwise the JSON shows what is there.
  return value === undefined ? (all[0] ?? null) : null;
}

/** The values of a union whose every branch is one constant (`anyOf: [{const: 'a'}, {const: 'b'}]`), or null. */
export function constUnion(root: Schema, branches: unknown[]): unknown[] | null {
  const out: unknown[] = [];
  for (const b of branches) {
    const r = resolve(root, b);
    if (r['const'] !== undefined) out.push(r['const']);
    else if (Array.isArray(r['enum'])) out.push(...(r['enum'] as unknown[]));
    else return null;
  }
  return out.length > 0 ? out : null;
}

interface Ctx { root: Schema; fields: Field[]; groups: string[] }

function leaf(ctx: Ctx, schema: Schema, key: string, pointer: string, value: unknown, group: string, order: number, mapValue: Schema | null = null): void {
  // The whole file as one text box would let a stray edit drop `kind`; a file the schema says nothing about shows no form.
  if (pointer === '') return;
  const ui = isObj(schema['x-ui']) ? schema['x-ui'] : {};
  const type = typeOf(schema);
  const enumVals = Array.isArray(schema['enum']) ? (schema['enum'] as unknown[]) : null;
  const def = schema['default'];
  const unset = value === undefined;
  const shown = unset ? def : value;
  const min = num(ui['min'], num(schema['minimum'], -Infinity));
  const max = num(ui['max'], num(schema['maximum'], Infinity));
  const finite = Number.isFinite(min) && Number.isFinite(max);
  const explicit = str(ui['widget']) as Widget | '';
  const refKind = str(schema['x-ref']);
  // An array's items: a fixed set of choices (several can be on), or objects (rows to add, remove and reorder).
  const items = type === 'array' && isObj(schema['items']) ? resolve(ctx.root, schema['items']) : null;
  const itemUnion = items ? ((items['anyOf'] ?? items['oneOf']) as unknown[] | undefined) : undefined;
  const itemEnum: unknown[] | null = !items ? null : Array.isArray(items['enum']) ? (items['enum'] as unknown[]) : Array.isArray(itemUnion) ? constUnion(ctx.root, itemUnion) : null;
  const objectItems = !!items && !itemEnum && (typeOf(items) === 'object' || isObj(items['properties']) || isObj(items['patternProperties']) || isObj(items['additionalProperties']) || Array.isArray(itemUnion));

  let widget: Widget;
  // Few options are segments, many a select, whatever the schema asked: a bar of ten labels is unreadable.
  if (enumVals && explicit !== 'select' && explicit !== 'ref') widget = enumVals.length <= 4 && enumVals.reduce<number>((n, o) => n + String(o).length, 0) <= 40 ? 'segments' : 'select';
  else if (mapValue) widget = 'map';
  else if (explicit && !(explicit === 'segments' && !enumVals)) widget = explicit;
  else if (refKind) widget = 'ref';
  else if (itemEnum) widget = 'checks';
  else if (objectItems) widget = 'list';
  else if (enumVals) widget = 'select';
  else if (type === 'boolean') widget = 'toggle';
  else if (type === 'number' || type === 'integer') widget = finite ? 'slider' : 'number';
  else if (type === 'array' && isObj(schema['items']) && typeOf(resolve(ctx.root, schema['items'])) === 'string' && !resolve(ctx.root, schema['items'])['enum']) widget = 'keys';
  else if (type === 'array') widget = Array.isArray(shown) && shown.length === 3 && shown.every((n) => typeof n === 'number') ? 'vec3'
    : Array.isArray(shown) && shown.length === 2 && shown.every((n) => typeof n === 'number') ? 'range' : 'json';
  else if (type === 'string') widget = schema['format'] === 'color' || (typeof shown === 'string' && /^#[0-9a-f]{6}$/i.test(shown)) ? 'color' : 'text';
  else widget = 'json';
  const fallback = widget === 'json';

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
    options: (enumVals ?? itemEnum ?? []).map(String),
    optionValues: enumVals ?? itemEnum ?? [],
    refKind,
    value: shown,
    live: ui['live'] !== false,
    def, unset, fallback,
    valueSchema: mapValue ?? (widget === 'list' ? items : null), schemaRoot: mapValue || widget === 'list' ? ctx.root : null,
  });
}

function walk(ctx: Ctx, schemaIn: unknown, value: unknown, pointer: string, key: string, group: string, order: number): void {
  let schema = resolve(ctx.root, schemaIn);
  const variants = (schema['oneOf'] ?? schema['anyOf']) as unknown[] | undefined;
  const ui = isObj(schema['x-ui']) ? schema['x-ui'] : {};
  if (Array.isArray(variants)) {
    const consts = constUnion(ctx.root, variants);
    if (consts) {
      // A union of constants is a choice among them, however the schema spelled it.
      const { anyOf: _a, oneOf: _o, ...rest } = schema;
      schema = { ...rest, enum: consts };
    } else if (!ui['widget']) {
      const branch = pickBranch(ctx.root, variants, value);
      if (!branch) {
        const { anyOf: _a, oneOf: _o, type: _t, ...rest } = schema;
        leaf(ctx, rest, key, pointer, value, group, order);
        return;
      }
      schema = { ...schema, ...branch };
    }
  }
  const props = isObj(schema['properties']) ? schema['properties'] : null;
  const addl = isObj(schema['additionalProperties']) ? resolve(ctx.root, schema['additionalProperties']) : null;
  const patterns = isObj(schema['patternProperties']) ? Object.values(schema['patternProperties']) : [];
  const asObject = typeOf(schema) === 'object' || props || addl || patterns.length > 0;
  // A map: an object whose keys the user names (sockets, materials, clips). One editor with add, remove and rename.
  if (asObject && !props && !ui['widget'] && pointer !== '' && (addl || patterns.length > 0 || schema['additionalProperties'] === true)) {
    leaf(ctx, schema, key, pointer, value, group, order, addl ?? resolve(ctx.root, patterns[0]));
    return;
  }

  if (asObject && !ui['widget']) {
    const obj = isObj(value) ? value : {};
    // The group name for a nested object is its own label, unless it set one.
    const name = pointer === '' ? group : str(ui['group']) || str(schema['title']) || humanize(key);
    let i = 0;
    const start = ctx.fields.length;
    if (props) {
      for (const [k, sub] of Object.entries(props)) {
        const r = resolve(ctx.root, sub);
        if (r['const'] !== undefined || k === 'kind' || r['x-ui'] && isObj(r['x-ui']) && r['x-ui']['hidden'] === true) { i++; continue; }
        walk(ctx, r, obj[k], `${pointer}/${k}`, k, name, i++);
      }
    }
    // An optional object the file leaves out, with a long list of fields (a ui-screen node has fourteen), would bury the
    // form in "not set" rows: it waits behind "Show all" until the file has it.
    if (value === undefined && pointer !== '' && ctx.fields.length - start > 8) for (let i = start; i < ctx.fields.length; i++) ctx.fields[i]!.advanced = true;
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
      refKind: '', value: t.value, live: true, def: undefined, unset: false, fallback: false, optionValues: Array.isArray(o['options']) ? (o['options'] as unknown[]) : [], valueSchema: null, schemaRoot: null,
    };
  });
}

export const groupFields = (fields: Field[]): FormGroup[] => toGroups(fields, true);

const escKey = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');

/** The fields of one entry of a map field, with pointers below the entry. A plain value (a string, a number) is one unlabeled field. */
export function mapEntryFields(field: Field, key: string, value: unknown): Field[] {
  const root = field.schemaRoot ?? {};
  const ctx: Ctx = { root, fields: [], groups: [] };
  const pointer = `${field.pointer}/${escKey(key)}`;
  walk(ctx, field.valueSchema, value, pointer, 'value', key, 0);
  const out = toGroups(ctx.fields, true).flatMap((g) => [...g.dials, ...g.fields]);
  // A plain value has nothing to label: the entry's own name above it says what it is.
  if (out.length === 1 && out[0]!.pointer === pointer) out[0] = { ...out[0]!, label: '' };
  return out;
}

/** The fields of one row of a `list` field, with pointers below the row (`/transitions/0/to`). A row that is a plain value is one unlabeled field. */
export function listItemFields(field: Field, index: number, value: unknown): Field[] {
  const ctx: Ctx = { root: field.schemaRoot ?? {}, fields: [], groups: [] };
  const pointer = `${field.pointer}/${index}`;
  walk(ctx, field.valueSchema, value, pointer, 'item', String(index + 1), 0);
  const out = toGroups(ctx.fields, true).flatMap((g) => [...g.dials, ...g.fields]);
  if (out.length === 1 && out[0]!.pointer === pointer) out[0] = { ...out[0]!, label: '' };
  return out;
}

/** What a row of a list says about itself when it is closed: "idle → walk · speed > 0.1" for a transition, a name otherwise. */
export function itemTitle(item: unknown, index: number): string {
  if (!isObj(item)) return String(item ?? index + 1);
  const s = (k: string): string => (typeof item[k] === 'string' ? (item[k] as string) : '');
  if (s('from') && s('to')) return `${s('from')} → ${s('to')}${s('when') ? ` · ${s('when')}` : ''}`;
  for (const k of ['name', 'bone', 'id', 'clip', 'type', 'to', 'from']) if (s(k)) return s(k);
  const first = Object.values(item).find((v) => typeof v === 'string' || typeof v === 'number');
  return first === undefined ? String(index + 1) : String(first);
}

/** A value for a new map entry: the schema's default, else the plainest value of its type that the schema accepts. */
export function defaultFor(root: Schema, schemaIn: unknown, refs: readonly string[] = [], depth = 0): unknown {
  let schema = resolve(root, schemaIn);
  const variants = (schema['oneOf'] ?? schema['anyOf']) as unknown[] | undefined;
  if (Array.isArray(variants) && variants.length > 0) {
    const consts = constUnion(root, variants);
    if (consts) return schema['default'] ?? consts[0];
    schema = { ...schema, ...resolve(root, variants[0]) };
  }
  if (schema['default'] !== undefined) return structuredClone(schema['default']);
  if (schema['const'] !== undefined) return schema['const'];
  if (Array.isArray(schema['enum'])) return (schema['enum'] as unknown[])[0];
  if (schema['x-ref'] && refs.length > 0) return refs[0];
  switch (typeOf(schema)) {
    case 'string': return '';
    case 'boolean': return false;
    case 'number': case 'integer': return num(schema['minimum'], 0) > 0 ? num(schema['minimum'], 0) : num(schema['exclusiveMinimum'], 0) >= 0 && schema['exclusiveMinimum'] !== undefined ? 1 : 0;
    case 'array': return [];
    case 'object': {
      const out: Record<string, unknown> = {};
      const req = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
      const props = isObj(schema['properties']) ? schema['properties'] : {};
      if (depth < 6) for (const k of req) if (k in props) out[k] = defaultFor(root, props[k], refs, depth + 1);
      return out;
    }
    default: return null;
  }
}
