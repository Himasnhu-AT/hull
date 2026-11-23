// Reading the running game for the control port: one node in full, the tree, and the conditions `until` waits for.
// Dev only. Pure over a World (no window, no clock), so a test drives it in Node. Allocation is fine here: it runs when an
// agent asks, never per frame.
import type { Behaviour, Node, World } from '../core/index.ts';
import { probeNames, readProbe } from '../core/probes.ts';
import type { ControlCmp, ControlCond, ControlInspect, ControlTree } from './protocol.ts';

const MAX_FIELDS = 40;
const MAX_LINES = 200;

const round = (n: number): number => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 : n);
const triple = (a: number, b: number, c: number): [number, number, number] => [round(a), round(b), round(c)];

/** 'squad/ana': the names from the root down, which is what `world.find` takes. */
export function pathOf(n: Node): string {
  const parts: string[] = [];
  for (let c: Node | null = n; c && c.parent; c = c.parent) parts.push(c.name);
  return parts.reverse().join('/');
}

/** A value as plain JSON an agent can read: numbers rounded, long lists cut, anything odd named by its type. */
function plain(v: unknown, depth = 0): unknown {
  if (typeof v === 'number') return round(v);
  if (typeof v === 'string' || typeof v === 'boolean' || v === null) return v;
  if (v === undefined) return null;
  if (Array.isArray(v)) return depth >= 2 ? `[${v.length} items]` : v.slice(0, 8).map((x) => plain(x, depth + 1));
  if (typeof v === 'object') {
    const o = v as { x?: unknown; y?: unknown; z?: unknown; constructor?: { name?: string }; name?: unknown };
    if (typeof o.x === 'number' && typeof o.y === 'number') return typeof o.z === 'number' ? triple(o.x, o.y, o.z) : [round(o.x), round(o.y)];
    if (typeof o.name === 'string' && 'children' in (v as object)) return `node ${o.name}`;
    if (depth >= 2) return `{${o.constructor?.name ?? 'object'}}`;
    const out: Record<string, unknown> = {};
    let k = 0;
    for (const key of Object.keys(v as object)) {
      if (k++ >= 8) break;
      out[key] = plain((v as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return `<${typeof v}>`;
}

const behaviourName = (b: Behaviour): string => b.constructor?.name || 'Behaviour';

/** The fields a behaviour class lists in static state, then its own number, string and boolean fields; 40 at most. */
export function stateOfBehaviour(b: Behaviour): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  const bag = b as unknown as Record<string, unknown>;
  for (const f of (b.constructor as typeof Behaviour).state ?? []) {
    if (count >= MAX_FIELDS) return out;
    out[f] = plain(bag[f]);
    count++;
  }
  for (const key of Object.keys(b)) {
    if (count >= MAX_FIELDS) break;
    if (key in out || key === 'node') continue;
    const v = bag[key];
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') { out[key] = plain(v); count++; }
  }
  return out;
}

export function inspectNode(world: World, path: string): ControlInspect {
  const n = world.find(path);
  if (!n) return { found: false, path };
  return {
    found: true,
    path: pathOf(n),
    position: triple(n.position.x, n.position.y, n.position.z),
    rotation: triple(n.rotation.x, n.rotation.y, n.rotation.z),
    scale: triple(n.scale.x, n.scale.y, n.scale.z),
    groups: [...n._groups],
    children: n.children.map((c) => c.name),
    behaviours: n.behaviours.map((b) => ({ name: behaviourName(b), state: stateOfBehaviour(b) })),
  };
}

/** Paths with behaviour names, `depth` levels below `root`, at most 200 lines. A node at the depth limit says how many children it hides. */
export function treeLines(world: World, root: string | undefined, depth: number): ControlTree {
  const start = root ? world.find(root) : world.root;
  if (!start) return { lines: [], more: 0 };
  const lines: string[] = [];
  let more = 0;
  const walk = (n: Node, level: number): void => {
    if (n !== world.root) {
      if (lines.length >= MAX_LINES) { more++; } else {
        const bs = n.behaviours.map(behaviourName);
        const hidden = level >= depth && n.children.length > 0 ? ` (+${n.children.length} below)` : '';
        lines.push(`${pathOf(n)}${bs.length ? `  [${bs.join(', ')}]` : ''}${hidden}`);
      }
    }
    if (level >= depth) return;
    for (const k of n.children) walk(k, level + 1);
  };
  walk(start, 0);
  return { lines, more };
}

const CMPS: readonly string[] = ['<', '<=', '>', '>=', '==', '!='];

export function compare(a: unknown, cmp: ControlCmp, b: unknown): boolean {
  switch (cmp) {
    case '==': return a === b;
    case '!=': return a !== b;
    default: {
      if (typeof a !== typeof b || (typeof a !== 'number' && typeof a !== 'string')) return false;
      const x = a as number, y = b as number;
      return cmp === '<' ? x < y : cmp === '<=' ? x <= y : cmp === '>' ? x > y : x >= y;
    }
  }
}

/** The check for `until`, made once before the loop so a bad condition fails at tick 0 and says why. */
export function checkCond(c: unknown): ControlCond {
  const shape = 'until needs "when" as {node, field, cmp, value} | {probe, cmp, value} | {event}';
  if (typeof c !== 'object' || c === null) throw new Error(shape);
  const o = c as Record<string, unknown>;
  const cmpOk = typeof o['cmp'] === 'string' && CMPS.includes(o['cmp']);
  const valOk = ['number', 'string', 'boolean'].includes(typeof o['value']);
  if (typeof o['event'] === 'string' && o['event']) return { event: o['event'] };
  if (typeof o['probe'] === 'string') {
    if (!cmpOk || !valOk) throw new Error(`${shape}: "cmp" is one of ${CMPS.join(' ')} and "value" a number, string or boolean`);
    return { probe: o['probe'], cmp: o['cmp'] as ControlCmp, value: o['value'] as number };
  }
  if (typeof o['node'] === 'string' && typeof o['field'] === 'string') {
    if (!cmpOk || !valOk) throw new Error(`${shape}: "cmp" is one of ${CMPS.join(' ')} and "value" a number, string or boolean`);
    return { node: o['node'], field: o['field'], cmp: o['cmp'] as ControlCmp, value: o['value'] as number };
  }
  throw new Error(shape);
}

/** A node's field: "x" | "y" | "z", or "<BehaviourName>.<field>". Undefined when the node, behaviour or field is missing. */
export function readField(world: World, node: string, field: string): unknown {
  const n = world.find(node);
  if (!n) return undefined;
  if (field === 'x' || field === 'y' || field === 'z') return n.position[field];
  const dot = field.indexOf('.');
  if (dot < 0) return undefined;
  const name = field.slice(0, dot);
  const b = n.behaviours.find((x) => behaviourName(x) === name);
  return b ? (b as unknown as Record<string, unknown>)[field.slice(dot + 1)] : undefined;
}

/** Every probe's value now; a probe that throws reads as "error: <message>" so one bad reader does not hide the others. */
export function probeValues(): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const name of probeNames()) {
    try { const v = readProbe(name); if (v !== undefined) out[name] = typeof v === 'number' ? round(v) : v; } catch (e) { out[name] = `error: ${(e as Error).message}`; }
  }
  return out;
}

/** Does the condition hold now? `eventSeen` says the trace event an `event` condition names has happened since the wait began. */
export function holds(world: World, c: ControlCond, eventSeen: boolean): boolean {
  if ('event' in c) return eventSeen;
  if ('probe' in c) {
    let v: unknown;
    try { v = readProbe(c.probe); } catch { return false; }
    return v !== undefined && compare(v, c.cmp, c.value);
  }
  const v = readField(world, c.node, c.field);
  return v !== undefined && compare(v, c.cmp, c.value);
}
