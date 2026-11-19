// A short number over what the soldier, the squad and the titans are doing, so Hull's checksum (which sees only its own
// nodes) changes when a run diverges. The simulation state is all in AOTT's own objects; this is its window into the
// checksum. Float bits go in as they are: two runs agree only if they agree exactly.
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

export class Digest {
  private h = 0x811c9dc5;

  reset(): this { this.h = 0x811c9dc5; return this; }

  num(x: number): this {
    f64[0] = x + 0;
    this.h = Math.imul(this.h ^ u32[0], 0x01000193);
    this.h = Math.imul(this.h ^ u32[1], 0x01000193);
    this.h ^= this.h >>> 15;
    return this;
  }

  vec(v: { x: number; y: number; z: number }): this { return this.num(v.x).num(v.y).num(v.z); }

  get value(): number { return this.h >>> 0; }
}
