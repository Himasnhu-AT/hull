// The maths behind the Inspector's widgets, kept apart from React so it can be tested and so a drag never
// depends on rendering order.

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Number of decimals a step implies: 0.01 -> 2, 0.5 -> 1, 1 -> 0. */
export function decimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 3;
  const s = step.toString();
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Snap to the step grid anchored at `min`, then clamp. Rounds away float noise (0.1 + 0.2). */
export function snap(v: number, min: number, max: number, step: number): number {
  const lo = Number.isFinite(min) ? min : 0;
  let r = step > 0 ? lo + Math.round((v - lo) / step) * step : v;
  r = Number(r.toFixed(Math.min(decimals(step), 6)));
  return clamp(r, Number.isFinite(min) ? min : -Infinity, Number.isFinite(max) ? max : Infinity);
}

/** A sensible step when the schema gives none: about 1/200 of the span, as 1, 2 or 5 times a power of ten. */
export function autoStep(min: number, max: number): number {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / 200;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
}

export const toFraction = (v: number, min: number, max: number): number => (max > min ? clamp((v - min) / (max - min), 0, 1) : 0);
export const fromFraction = (f: number, min: number, max: number): number => min + clamp(f, 0, 1) * (max - min);

/** Dial geometry: a 270 degree sweep opening at the bottom, like a hardware knob. Angles in degrees, 0 = up, clockwise. */
export const DIAL_START = -135;
export const DIAL_END = 135;
export const dialAngle = (f: number): number => DIAL_START + clamp(f, 0, 1) * (DIAL_END - DIAL_START);

export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** SVG arc path between two angles (clockwise). Empty when the sweep is too small to draw. */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (a1 - a0 < 0.5) return '';
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Drag modifiers: Shift is fine (x0.1), Alt or Ctrl coarse (x10), like Unity. */
export const dragScale = (e: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean }): number => (e.shiftKey ? 0.1 : e.altKey || e.ctrlKey ? 10 : 1);

/**
 * Value after a vertical drag on a dial: 200 px of travel cover the whole range, up raises it. Computed from the
 * value at pointer-down so the knob never jumps to where it was grabbed.
 */
export function dialDrag(startValue: number, dyPixels: number, min: number, max: number, step: number, scale = 1): number {
  return snap(startValue - (dyPixels / 200) * (max - min) * scale, min, max, step);
}

/** Scrubbing a label sideways: with a finite range 300 px cover it, otherwise one step per 4 px. */
export function scrubDelta(startValue: number, dxPixels: number, min: number, max: number, step: number, scale = 1): number {
  const finite = Number.isFinite(min) && Number.isFinite(max) && max > min;
  const raw = finite ? startValue + (dxPixels / 300) * (max - min) * scale : startValue + (dxPixels / 4) * step * scale;
  return snap(raw, finite ? min : -Infinity, finite ? max : Infinity, step);
}

/** Dual range: moving one end never passes the other. `which` is the end being dragged. */
export function rangeMove(pair: readonly [number, number], which: 0 | 1, v: number, min: number, max: number, step: number): [number, number] {
  const s = snap(v, min, max, step);
  return which === 0 ? [Math.min(s, pair[1]), pair[1]] : [pair[0], Math.max(s, pair[0])];
}

/** The end nearest to a value, for clicking on the track. */
export const nearestEnd = (pair: readonly [number, number], v: number): 0 | 1 => (Math.abs(v - pair[0]) <= Math.abs(v - pair[1]) ? 0 : 1);

export type CurvePoint = [number, number];

/** Moves one point of a curve. The first and last keep their time; the others stay between their neighbours. */
export function curveMove(points: readonly CurvePoint[], i: number, t: number, v: number, vMin: number, vMax: number): CurvePoint[] {
  const out = points.map((p) => [p[0], p[1]] as CurvePoint);
  const p = out[i];
  if (!p) return out;
  const last = out.length - 1;
  const lo = i === 0 ? 0 : (out[i - 1]?.[0] ?? 0);
  const hi = i === last ? 1 : (out[i + 1]?.[0] ?? 1);
  if (i !== 0 && i !== last) p[0] = clamp(Number(t.toFixed(3)), lo, hi);
  p[1] = clamp(Number(v.toFixed(3)), vMin, vMax);
  return out;
}

/** Piecewise linear sample. */
export function curveAt(points: readonly CurvePoint[], t: number): number {
  const n = points.length;
  if (n === 0) return 0;
  const first = points[0]!;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < n; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (t <= b[0]) return b[0] === a[0] ? b[1] : a[1] + ((t - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
  }
  return points[n - 1]![1];
}

/** Formats a value for display with the step's precision. */
export const formatNumber = (v: number, step: number): string => (Number.isFinite(v) ? v.toFixed(Math.min(decimals(step), 4)) : '-');

/** Deep equality for JSON values: how "changed" is decided. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  if (ka.length !== Object.keys(b as object).length) return false;
  return ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** JSON pointer helpers (RFC 6901). */
export const escapePointer = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');
export const unescapePointer = (s: string): string => s.replace(/~1/g, '/').replace(/~0/g, '~');

export function getAtPointer(root: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return root;
  let cur: unknown = root;
  for (const raw of pointer.split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[unescapePointer(raw)];
  }
  return cur;
}

/** A copy of `root` with the value at `pointer` replaced (objects and arrays on the path are copied). */
export function setAtPointer(root: unknown, pointer: string, value: unknown): unknown {
  if (pointer === '') return value;
  const parts = pointer.split('/').slice(1).map(unescapePointer);
  const go = (node: unknown, i: number): unknown => {
    const key = parts[i]!;
    const base = (Array.isArray(node) ? [...node] : { ...((node as object | null | undefined) ?? {}) }) as Record<string, unknown>;
    base[key] = i === parts.length - 1 ? value : go(base[key], i + 1);
    return base;
  };
  return go(root, 0);
}

type Throttled<A extends unknown[]> = ((...a: A) => void) & { flush(): void; cancel(): void };

/** Calls `fn` at most once per `ms` with the latest arguments, and once more at the end. `flush` sends the pending call now. */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number): Throttled<A> {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  const fire = (): void => {
    timer = null;
    if (!pending) return;
    const a = pending;
    pending = null;
    last = Date.now();
    fn(...a);
  };
  const t = ((...a: A) => {
    pending = a;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) { if (timer) { clearTimeout(timer); timer = null; } fire(); }
    else if (!timer) timer = setTimeout(fire, wait);
  }) as Throttled<A>;
  t.flush = () => { if (timer) { clearTimeout(timer); timer = null; } fire(); };
  t.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } pending = null; };
  return t;
}
