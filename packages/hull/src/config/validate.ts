// Ajv over the TypeBox schemas, with errors turned into plain sentences, and x-ref collection.
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { colorPattern } from '../schema/ui.ts';

// Ajv is CommonJS; depending on the loader the class is the default export or on `.default`.
const AjvClass = ((Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020) as typeof Ajv2020;

const ajv = new AjvClass({ allErrors: true, strict: true });
ajv.addKeyword({ keyword: 'x-ui', schemaType: 'object' });
ajv.addKeyword({ keyword: 'x-ref', schemaType: 'string' });

const compiled = new WeakMap<object, ValidateFunction>();
function compile(schema: object): ValidateFunction {
  let fn = compiled.get(schema);
  if (!fn) { fn = ajv.compile(schema); compiled.set(schema, fn); }
  return fn;
}

export interface RawProblem { pointer: string; message: string; prefer: 'value' | 'key' }

const unescape = (s: string): string => s.replace(/~1/g, '/').replace(/~0/g, '~');
export const segments = (pointer: string): string[] => (pointer === '' ? [] : pointer.slice(1).split('/').map(unescape));

export function valueAt(root: unknown, pointer: string): unknown {
  let cur = root;
  for (const s of segments(pointer)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/** The field's name for messages: 'jumpHeight', or 'layers[0]' for an array item, or 'the file' for the root. */
function nameOf(pointer: string): string {
  const s = segments(pointer);
  const last = s[s.length - 1];
  if (last === undefined) return 'the file';
  if (/^\d+$/.test(last)) return `${s[s.length - 2] ?? 'item'}[${last}]`;
  return last;
}

function describe(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return 'an array';
  if (v === null) return 'null';
  if (typeof v === 'object') return 'an object';
  if (v === undefined) return 'nothing';
  return String(v);
}

function convert(e: ErrorObject, root: unknown): RawProblem {
  const p = e.instancePath;
  const params = e.params as Record<string, unknown>;
  const got = (ptr: string): string => describe(valueAt(root, ptr));
  switch (e.keyword) {
    case 'required': {
      const name = String(params['missingProperty']);
      return { pointer: `${p}/${name}`, message: `missing required field "${name}"`, prefer: 'value' };
    }
    case 'additionalProperties': {
      const name = String(params['additionalProperty']);
      return { pointer: `${p}/${name}`, message: `unknown field "${name}"`, prefer: 'key' };
    }
    case 'type': {
      const t = String(params['type']);
      return { pointer: p, message: `${nameOf(p)} must be ${/^[aeiou]/.test(t) ? 'an' : 'a'} ${t}, got ${got(p)}`, prefer: 'value' };
    }
    case 'minimum': return { pointer: p, message: `${nameOf(p)} must be at least ${String(params['limit'])}, got ${got(p)}`, prefer: 'value' };
    case 'maximum': return { pointer: p, message: `${nameOf(p)} must be at most ${String(params['limit'])}, got ${got(p)}`, prefer: 'value' };
    case 'exclusiveMinimum': return { pointer: p, message: `${nameOf(p)} must be more than ${String(params['limit'])}, got ${got(p)}`, prefer: 'value' };
    case 'exclusiveMaximum': return { pointer: p, message: `${nameOf(p)} must be less than ${String(params['limit'])}, got ${got(p)}`, prefer: 'value' };
    case 'enum': {
      const list = (params['allowedValues'] as unknown[]).map((v) => (typeof v === 'string' ? v : String(v))).join(', ');
      return { pointer: p, message: `${nameOf(p)} must be one of ${list}, got ${got(p)}`, prefer: 'value' };
    }
    case 'const': return { pointer: p, message: `${nameOf(p)} must be ${describe(params['allowedValue'])}, got ${got(p)}`, prefer: 'value' };
    case 'pattern': {
      const pat = String(params['pattern']);
      const want = pat === colorPattern ? 'a colour like #rrggbb' : `text matching ${pat}`;
      return { pointer: p, message: `${nameOf(p)} must be ${want}, got ${got(p)}`, prefer: 'value' };
    }
    default: return { pointer: p, message: `${nameOf(p)} ${e.message ?? 'is not valid'}, got ${got(p)}`, prefer: 'value' };
  }
}

/** Validates `data` against a schema; returns plain problems with JSON pointers (deduplicated). */
export function validateAgainst(schema: object, data: unknown): RawProblem[] {
  const fn = compile(schema);
  if (fn(data)) return [];
  const seen = new Set<string>();
  const out: RawProblem[] = [];
  for (const e of fn.errors ?? []) {
    const r = convert(e, data);
    const key = `${r.pointer}|${r.message}`;
    if (!seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}

export interface RefUse { pointer: string; kind: string; id: string }

/** Finds every string in `data` that sits where the schema says `x-ref`. Follows properties, items and additional properties. */
export function collectRefs(schema: unknown, data: unknown, pointer = '', out: RefUse[] = []): RefUse[] {
  if (schema === null || typeof schema !== 'object') return out;
  const s = schema as Record<string, unknown>;
  if (typeof s['x-ref'] === 'string' && typeof data === 'string') out.push({ pointer, kind: s['x-ref'], id: data });
  if (Array.isArray(data)) {
    if (s['items']) data.forEach((item, n) => collectRefs(s['items'], item, `${pointer}/${n}`, out));
  } else if (data !== null && typeof data === 'object') {
    const props = (s['properties'] ?? {}) as Record<string, unknown>;
    const patterns = Object.entries((s['patternProperties'] ?? {}) as Record<string, unknown>);
    for (const [k, v] of Object.entries(data)) {
      const child = `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (k in props) collectRefs(props[k], v, child, out);
      else {
        const hit = patterns.find(([re]) => new RegExp(re).test(k));
        if (hit) collectRefs(hit[1], v, child, out);
        else if (typeof s['additionalProperties'] === 'object') collectRefs(s['additionalProperties'], v, child, out);
      }
    }
  }
  return out;
}
