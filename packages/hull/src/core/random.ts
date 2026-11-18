// Seeded random streams. Each name gets its own sfc32 generator seeded from (world seed, hash of the name), so
// starting to use a new name never changes what the existing names produce.
import type { Random } from './types.ts';

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** One round of splitmix32, used only to spread a seed over the four state words. */
function mix(x: number): number {
  x = (x + 0x9e3779b9) | 0;
  let z = x ^ (x >>> 16);
  z = Math.imul(z, 0x21f0aaad);
  z ^= z >>> 15;
  z = Math.imul(z, 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

export class RandomStream implements Random {
  s0: number;
  s1: number;
  s2: number;
  s3: number;

  constructor(seed: number, name: string) {
    let x = mix((seed | 0) ^ mix(hashString(name)));
    this.s0 = x;
    x = mix(x);
    this.s1 = x;
    x = mix(x);
    this.s2 = x;
    this.s3 = 1;
    for (let i = 0; i < 12; i++) this.u32();
  }

  /** sfc32 */
  u32(): number {
    const t = (((this.s0 + this.s1) | 0) + this.s3) | 0;
    this.s3 = (this.s3 + 1) | 0;
    this.s0 = this.s1 ^ (this.s1 >>> 9);
    this.s1 = (this.s2 + (this.s2 << 3)) | 0;
    this.s2 = (this.s2 << 21) | (this.s2 >>> 11);
    this.s2 = (this.s2 + t) | 0;
    return t >>> 0;
  }

  next(): number {
    return this.u32() / 4294967296;
  }
  range(a: number, b: number): number {
    return a + this.next() * (b - a);
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error('random.pick: the list is empty');
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}
