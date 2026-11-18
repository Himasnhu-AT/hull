// A stable 64-bit hash (two 32-bit lanes) over numbers, strings and plain data. Floats go in as their Float64
// bytes, so two runs agree only if they agree to the last bit. -0 is folded into 0.
const f64 = new Float64Array(1);
const u8 = new Uint8Array(f64.buffer);

export class Hasher {
  private a = 0x811c9dc5;
  private b = 0x9747b28c;

  byte(x: number): void {
    this.a = Math.imul(this.a ^ x, 0x01000193);
    this.b = Math.imul(this.b ^ x, 0x5bd1e995);
    this.b ^= this.b >>> 15;
  }

  num(x: number): void {
    f64[0] = x + 0;
    for (let i = 0; i < 8; i++) this.byte(u8[i]!);
  }

  u32(x: number): void {
    this.byte(x & 255);
    this.byte((x >>> 8) & 255);
    this.byte((x >>> 16) & 255);
    this.byte(x >>> 24);
  }

  str(s: string): void {
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.byte(c & 255);
      this.byte(c >>> 8);
    }
  }

  /** Numbers, booleans, strings, null, arrays and plain objects (keys in their own order). Anything else is a tag. */
  value(v: unknown): void {
    switch (typeof v) {
      case 'number': this.byte(1); this.num(v); return;
      case 'boolean': this.byte(v ? 2 : 3); return;
      case 'string': this.byte(4); this.str(v); return;
      case 'undefined': this.byte(5); return;
      case 'object': {
        if (v === null) { this.byte(6); return; }
        if (Array.isArray(v)) {
          this.byte(7);
          this.u32(v.length);
          for (let i = 0; i < v.length; i++) this.value(v[i]);
          return;
        }
        this.byte(8);
        const o = v as Record<string, unknown>;
        const keys = Object.keys(o);
        this.u32(keys.length);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i]!;
          this.str(k);
          this.value(o[k]);
        }
        return;
      }
      default: this.byte(9);
    }
  }

  hex(): string {
    return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
  }
}
