import type { ConfigRegistry, NumOpts, Problem, Tunable, TunableInfo, TunableValues } from './types.ts';

// Values that live in code. Each is a cell; the block object has getters over the cells, so reading one in the
// simulation allocates nothing and always sees the latest value the dev runtime set.

type TKind = Tunable<unknown>['kind'];
type Vec3 = [number, number, number];

const make = <T>(kind: TKind, value: T, opts: object): Tunable<T> => ({ kind, value, opts });

export const num = (value: number, opts: NumOpts = {}): Tunable<number> => make('num', value, opts);
export const bool = (value: boolean, opts: { help?: string } = {}): Tunable<boolean> => make('bool', value, opts);
export const color = (value: string, opts: { help?: string } = {}): Tunable<string> => make('color', value, opts);
export const vec = (value: readonly [number, number, number], opts: NumOpts = {}): Tunable<Vec3> => make('vec', [...value] as Vec3, opts);
export const choice = <const C extends readonly string[]>(value: C[number], options: C, opts: { help?: string } = {}): Tunable<C[number]> =>
  make('choice', value, { ...opts, options });
export const range = (value: readonly [number, number], opts: NumOpts = {}): Tunable<[number, number]> => make('range', [...value] as [number, number], opts);
export const curve = (value: readonly (readonly [number, number])[], opts: { help?: string } = {}): Tunable<[number, number][]> =>
  make('curve', value.map((p) => [p[0], p[1]] as [number, number]), opts);

interface Cell { block: string; key: string; kind: TKind; value: unknown; initial: unknown; opts: Record<string, unknown> }
const cells = new Map<string, Cell>();
const blocks = new Set<string>();

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Returns a plain sentence when `v` is not allowed for this tunable, otherwise null. */
const reason = (c: Cell, v: unknown): string | null => tunableProblem(c.kind, c.key, c.opts, v);

/** The same check without a declared tunable, for tools that know a tunable's kind and options from its source. */
export function tunableProblem(kind: TKind, key: string, opts: Record<string, unknown>, v: unknown): string | null {
  const c = { kind, key, opts };
  const { min, max } = c.opts as { min?: number; max?: number };
  const bounds = (n: number, label: string): string | null => {
    if (min !== undefined && n < min) return `${label} must be at least ${min}, got ${n}`;
    if (max !== undefined && n > max) return `${label} must be at most ${max}, got ${n}`;
    return null;
  };
  switch (c.kind) {
    case 'num':
      return isNum(v) ? bounds(v, c.key) : `${c.key} must be a number, got ${JSON.stringify(v)}`;
    case 'bool':
      return typeof v === 'boolean' ? null : `${c.key} must be true or false, got ${JSON.stringify(v)}`;
    case 'color':
      return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? null : `${c.key} must be a colour like #rrggbb, got ${JSON.stringify(v)}`;
    case 'choice': {
      const options = c.opts['options'] as readonly string[];
      return typeof v === 'string' && options.includes(v) ? null : `${c.key} must be one of ${options.join(', ')}, got ${JSON.stringify(v)}`;
    }
    case 'vec': {
      if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) return `${c.key} must be three numbers [x, y, z], got ${JSON.stringify(v)}`;
      for (const n of v as number[]) { const r = bounds(n, c.key); if (r) return r; }
      return null;
    }
    case 'range': {
      if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum)) return `${c.key} must be two numbers [min, max], got ${JSON.stringify(v)}`;
      const [lo, hi] = v as [number, number];
      if (lo > hi) return `${c.key} must have min no larger than max, got [${lo}, ${hi}]`;
      return bounds(lo, c.key) ?? bounds(hi, c.key);
    }
    case 'curve': {
      if (!Array.isArray(v) || v.length === 0) return `${c.key} must be a list of [t, value] points`;
      let last = 0;
      for (const p of v as unknown[]) {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(isNum)) return `${c.key} points must be [t, value] numbers, got ${JSON.stringify(p)}`;
        const t = p[0] as number;
        if (t < 0 || t > 1) return `${c.key} point t must be between 0 and 1, got ${t}`;
        if (t < last) return `${c.key} points must be in order of t, got ${t} after ${last}`;
        last = t;
      }
      return null;
    }
  }
}

/** `thirdPerson` -> `third-person`: the file name a code block's overrides live under (config/tuning/<name>.json). */
export const tuningIdOf = (block: string): string => block.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const freezeValue = (v: unknown): unknown => {
  if (Array.isArray(v)) { v.forEach(freezeValue); return Object.freeze(v); }
  return v;
};

/** Declares a block of values owned by code. Properties are getters over cells the dev runtime can set. */
export function tunables<S extends Record<string, Tunable<unknown>>>(name: string, spec: S): TunableValues<S> {
  if (blocks.has(name)) throw new Error(`tunables block "${name}" is declared twice; block names must be unique`);
  const out = {} as Record<string, unknown>;
  const made: Cell[] = [];
  for (const [key, t] of Object.entries(spec)) {
    const cell: Cell = { block: name, key, kind: t.kind, value: t.value, initial: t.value, opts: t.opts as Record<string, unknown> };
    const bad = reason(cell, t.value);
    if (bad) throw new Error(`tunables ${name}.${key}: the starting value is not allowed: ${bad}`);
    freezeValue(cell.value);
    made.push(cell);
    Object.defineProperty(out, key, { enumerable: true, get: () => cell.value });
  }
  blocks.add(name);
  for (const c of made) cells.set(`${name}.${c.key}`, c);
  if (bound) applyOverrides(name, bound);
  return Object.freeze(out) as TunableValues<S>;
}

/** Dev runtime: every declared tunable. */
export function listTunables(): TunableInfo[] {
  return [...cells.values()].map((c) => ({ block: c.block, key: c.key, kind: c.kind, value: c.value, initial: c.initial, opts: c.opts }));
}

/** Dev runtime: `setTunable('player.runSpeed', 14)`; validated against the tunable's opts. */
export function setTunable(path: string, value: unknown): Problem | null {
  const c = cells.get(path);
  if (!c) return { file: 'tunables', pointer: `/${path.split('.').join('/')}`, rule: 'tunable', message: `there is no tunable "${path}"` };
  const bad = reason(c, value);
  if (bad) return { file: 'tunables', pointer: `/${c.block}/${c.key}`, rule: 'tunable', message: bad };
  c.value = freezeValue(Array.isArray(value) ? structuredClone(value) : value);
  return null;
}

/** Tests and hot reload: forget every block so names can be declared again. */
export function resetTunables(): void {
  cells.clear();
  blocks.clear();
  overrideProblems = [];
}

// ---- Overrides from config/tuning/<block>.json ---------------------------------------------------------------------
// A project keeps its own values for a block declared in code (a kit's, above all) without touching the code. The file
// holds only the keys that differ; a key it lacks keeps the value from code. Applying runs on load and on every live
// change of the file, never per frame, so reads stay plain getters over cells.

let bound: ConfigRegistry | undefined;
let overrideProblems: Problem[] = [];

const sameValue = (a: unknown, b: unknown): boolean => a === b || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b));

/** Sets each cell of one block from its file (or back to the code value). Returns what the file got wrong. */
function applyOverrides(block: string, reg: ConfigRegistry): Problem[] {
  const id = tuningIdOf(block);
  const file = `config/tuning/${id}.json`;
  const have = reg.has(`tuning/${id}`);
  const given = have ? (reg.lookup('tuning', id) as unknown as Record<string, unknown>) : {};
  const out: Problem[] = [];
  const names = new Set([...cells.values()].filter((c) => c.block === block).map((c) => c.key));
  for (const c of cells.values()) {
    if (c.block !== block) continue;
    const mine = Object.prototype.hasOwnProperty.call(given, c.key);
    if (!mine) { if (!sameValue(c.value, c.initial)) c.value = c.initial; continue; }
    const v = given[c.key];
    const bad = reason(c, v);
    if (bad) { out.push({ file, pointer: `/${c.key}`, rule: 'tunable', message: bad }); if (!sameValue(c.value, c.initial)) c.value = c.initial; continue; }
    if (!sameValue(c.value, v)) c.value = freezeValue(Array.isArray(v) ? structuredClone(v) : v);
  }
  for (const k of Object.keys(given)) {
    if (k !== 'kind' && k !== 'note' && !names.has(k)) out.push({ file, pointer: `/${k}`, rule: 'tunable', message: `"${block}" has no tunable "${k}"` });
  }
  return out;
}

/**
 * Connects tunables to a config registry: every block takes its values from config/tuning/<block>.json when that file
 * exists, now and after each load, update or removal. Blocks declared later are applied as they are declared.
 */
export function bindTunables(reg: ConfigRegistry): void {
  bound = reg;
  const sync = (): void => {
    overrideProblems = [];
    for (const b of blocks) overrideProblems.push(...applyOverrides(b, reg));
  };
  reg.onChange(sync);
  sync();
}

/** What the project's tuning files got wrong about code blocks, as of the last load or update. */
export const tuningProblems = (): readonly Problem[] => overrideProblems;
