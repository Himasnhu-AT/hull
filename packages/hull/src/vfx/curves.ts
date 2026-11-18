// Curves over a particle's life, turned into small lookup tables so the per-frame loop does one table read per
// particle instead of searching keys. Pure: runs and is tested in Node.
export type Key = readonly [number, number];
export type ColorKey = readonly [number, string];

/** Entries in a lookup table. 64 is smooth enough for any curve a designer draws and costs 1 KB. */
export const LUT = 64;

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** '#rrggbb' to linear-light [r, g, b], 0 to 1. Throws on anything else, naming the text. */
export function parseColor(hex: string, out: Float32Array | number[] = [0, 0, 0], at = 0): Float32Array | number[] {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`vfx: "${hex}" is not a colour like "#rrggbb"`);
  const n = parseInt(hex.slice(1), 16);
  out[at] = srgbToLinear(((n >> 16) & 255) / 255);
  out[at + 1] = srgbToLinear(((n >> 8) & 255) / 255);
  out[at + 2] = srgbToLinear((n & 255) / 255);
  return out;
}

/** Value of a piecewise-linear curve at t. Before the first key and after the last it holds the end value. */
export function sampleCurve(keys: readonly Key[], t: number): number {
  const n = keys.length;
  if (n === 0) return 0;
  const first = keys[0]!;
  if (t <= first[0] || n === 1) return first[1];
  for (let i = 1; i < n; i++) {
    const b = keys[i]!;
    if (t <= b[0]) {
      const a = keys[i - 1]!;
      const span = b[0] - a[0];
      return span <= 0 ? b[1] : a[1] + ((b[1] - a[1]) * (t - a[0])) / span;
    }
  }
  return keys[n - 1]![1];
}

/** The same for colours: each linear channel is interpolated, so a blend does not darken in the middle. */
export function sampleColorCurve(keys: readonly ColorKey[], t: number, out: Float32Array | number[], at = 0): void {
  const n = keys.length;
  const c0 = [0, 0, 0];
  const c1 = [0, 0, 0];
  if (n === 0) { out[at] = out[at + 1] = out[at + 2] = 1; return; }
  const first = keys[0]!;
  if (t <= first[0] || n === 1) { parseColor(first[1], out, at); return; }
  for (let i = 1; i < n; i++) {
    const b = keys[i]!;
    if (t <= b[0]) {
      const a = keys[i - 1]!;
      const span = b[0] - a[0];
      const k = span <= 0 ? 1 : (t - a[0]) / span;
      parseColor(a[1], c0);
      parseColor(b[1], c1);
      for (let c = 0; c < 3; c++) out[at + c] = c0[c]! + (c1[c]! - c0[c]!) * k;
      return;
    }
  }
  parseColor(keys[n - 1]![1], out, at);
}

/** Five floats per entry: size, r, g, b, alpha. Built once when a config loads or changes. */
export function buildLut(size: readonly Key[], color: readonly ColorKey[], alpha: readonly Key[]): Float32Array {
  const lut = new Float32Array(LUT * 5);
  for (let i = 0; i < LUT; i++) {
    const t = i / (LUT - 1);
    lut[i * 5] = sampleCurve(size, t);
    sampleColorCurve(color, t, lut, i * 5 + 1);
    lut[i * 5 + 4] = sampleCurve(alpha, t);
  }
  return lut;
}

/** Reads entry `channel` (0 size, 1 r, 2 g, 3 b, 4 alpha) at t in 0..1, interpolating between table entries. */
export function lutAt(lut: Float32Array, t: number, channel: number): number {
  const f = (t < 0 ? 0 : t > 1 ? 1 : t) * (LUT - 1);
  const i = f | 0;
  const j = i < LUT - 1 ? i + 1 : i;
  const k = f - i;
  const a = lut[i * 5 + channel]!;
  return a + (lut[j * 5 + channel]! - a) * k;
}
