import type { NumOpts, Problem, Tunable, TunableInfo, TunableValues } from './types.ts';

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
function reason(c: Cell, v: unknown): string | null {
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
}
