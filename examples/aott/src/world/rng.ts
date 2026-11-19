// Tiny deterministic helpers shared by the world builders.
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private f: () => number;
  constructor(seed = 1) { this.f = mulberry32(seed); }
  next(): number { return this.f(); }
  range(a: number, b: number): number { return a + (b - a) * this.f(); }
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }       // inclusive
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.f() * arr.length)]; }
  chance(p: number): boolean { return this.f() < p; }
  sign(): number { return this.f() < 0.5 ? -1 : 1; }
  gauss(): number { return (this.f() + this.f() + this.f() + this.f() - 2) * 1.732; } // ~N(0,1)
}

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
