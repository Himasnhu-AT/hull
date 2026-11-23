// Where the moving shapes are: their bounds in one flat array, and a grid over them so a query visits the few near it
// instead of every one. Until plan-rust.md R0 the world walked the whole moving list for each query, which at about
// 2,500 moving shapes (160 titans) and 400 queries a step was a million box tests a step.
//
// The layout is flat on purpose (plan-rust.md section 4, test 4): numbers in typed arrays, no objects, so the same
// arrays can live in a WebAssembly kernel's memory and be built there. `MovingStore` is that seam: the TypeScript
// store below owns plain arrays and builds the grid here; a kernel store hands out views over its own memory and
// builds the same grid, bit for bit. Everything that reads the grid (this file) is shared by both.
//
// What a query returns never depends on the grid: candidates come back in the order the shapes were added, exactly
// the shapes the old walk accepted. The grid only decides how few are looked at.
import type { Shape } from './shape.ts';

/** The grid never has more cells than this; a world wider than that many cells gets coarser cells instead. */
export const MAX_CELLS = 16384;
/** A shape that covers more cells than this is kept in a short list that every query checks. */
export const MAX_SPAN = 16;
/** Bounds past this (or not numbers at all) are kept out of the grid and in that short list. */
export const FAR = 1e12;

/** `state` of a slot: in the grid, in the short list, or moved out of its cells since the grid was built. */
export const GRID = 0, WIDE = 1, LOOSE = 2;
/** Indices into `headF`: the cell side the grid was built with, and its first column and row. */
export const CS = 0, FI0 = 1, FK0 = 2;
/** Indices into `headI`: columns, rows, entries in `items`, entries in `over`, entries in `loose`. */
export const NI = 0, NK = 1, NITEMS = 2, NOVER = 3, NLOOSE = 4;

/** Where the index's numbers live, and who builds the grid from the bounds. */
export interface MovingStore {
  readonly kind: 'typescript' | 'kernel';
  /** Slots the arrays have room for. */
  cap: number;
  /** minx, miny, minz, maxx, maxy, maxz for each slot. */
  aabb: Float64Array;
  /** First and last column, first and last row a slot was filed under when the grid was built. */
  range: Int32Array;
  state: Int32Array;
  /** Slots in the short list (too wide, too far, or not numbers). */
  over: Int32Array;
  /** Slots that have left their cells since the build. */
  loose: Int32Array;
  /** Cell c holds items[cellStart[c]] to items[cellStart[c + 1] - 1], slots in rising order. */
  cellStart: Int32Array;
  cursor: Int32Array;
  items: Int32Array;
  headF: Float64Array;
  headI: Int32Array;
  /** Makes room for `cap` slots, keeping the first `keep` slots' bounds. False when it cannot (the caller falls back). */
  reserve(cap: number, keep: number): boolean;
  /** Files slots 0 to n - 1 into a grid of `cell`-sized cells: fills range, state, over, cellStart, items and the heads. */
  build(n: number, cell: number): void;
}

/**
 * The grid build, in TypeScript: the fallback, and the oracle the kernel's build is tested against bit for bit.
 * Only add, subtract, multiply, divide, floor and compare on doubles, so the two agree exactly.
 */
export function buildGrid(s: MovingStore, n: number, cell: number): void {
  const a = s.aabb, range = s.range, state = s.state, over = s.over, start = s.cellStart, cur = s.cursor, items = s.items;
  let lox = Infinity, hix = -Infinity, loz = Infinity, hiz = -Infinity;
  for (let i = 0, o = 0; i < n; i++, o += 6) {
    const x0 = a[o]!, z0 = a[o + 2]!, x1 = a[o + 3]!, z1 = a[o + 5]!;
    if (x0 >= -FAR && x1 <= FAR && z0 >= -FAR && z1 <= FAR && x1 >= x0 && z1 >= z0) {
      state[i] = GRID;
      if (x0 < lox) lox = x0;
      if (x1 > hix) hix = x1;
      if (z0 < loz) loz = z0;
      if (z1 > hiz) hiz = z1;
    } else state[i] = WIDE;
  }
  let cs = cell, fi0 = 0, fk0 = 0, ni = 0, nk = 0;
  if (lox <= hix) {
    // Cells double until the whole extent fits the cell budget; bounds are within FAR, so this ends.
    for (;;) {
      fi0 = Math.floor(lox / cs); fk0 = Math.floor(loz / cs);
      const w = Math.floor(hix / cs) - fi0 + 1, d = Math.floor(hiz / cs) - fk0 + 1;
      if (w * d <= MAX_CELLS) { ni = w; nk = d; break; }
      cs *= 2;
    }
  }
  const cells = ni * nk;
  for (let c = 0; c <= cells; c++) start[c] = 0;
  let nOver = 0;
  for (let i = 0, o = 0; i < n; i++, o += 6) {
    if (state[i] !== GRID) { over[nOver++] = i; continue; }
    const a0 = Math.floor(a[o]! / cs) - fi0, a1 = Math.floor(a[o + 3]! / cs) - fi0;
    const c0 = Math.floor(a[o + 2]! / cs) - fk0, c1 = Math.floor(a[o + 5]! / cs) - fk0;
    if ((a1 - a0 + 1) * (c1 - c0 + 1) > MAX_SPAN) { state[i] = WIDE; over[nOver++] = i; continue; }
    const r = i * 4;
    range[r] = a0; range[r + 1] = a1; range[r + 2] = c0; range[r + 3] = c1;
    for (let x = a0; x <= a1; x++) for (let z = c0; z <= c1; z++) start[x * nk + z + 1]!++;
  }
  for (let c = 0; c < cells; c++) { start[c + 1]! += start[c]!; cur[c] = start[c]!; }
  for (let i = 0; i < n; i++) {
    if (state[i] !== GRID) continue;
    const r = i * 4;
    const a0 = range[r]!, a1 = range[r + 1]!, c0 = range[r + 2]!, c1 = range[r + 3]!;
    for (let x = a0; x <= a1; x++) for (let z = c0; z <= c1; z++) { const c = x * nk + z; items[cur[c]!] = i; cur[c]!++; }
  }
  s.headF[CS] = cs; s.headF[FI0] = fi0; s.headF[FK0] = fk0;
  s.headI[NI] = ni; s.headI[NK] = nk; s.headI[NITEMS] = start[cells]!; s.headI[NOVER] = nOver; s.headI[NLOOSE] = 0;
}

/** The store that is plain TypeScript arrays. */
export class ArrayStore implements MovingStore {
  readonly kind = 'typescript' as const;
  cap = 0;
  aabb = new Float64Array(0);
  range = new Int32Array(0);
  state = new Int32Array(0);
  over = new Int32Array(0);
  loose = new Int32Array(0);
  readonly cellStart = new Int32Array(MAX_CELLS + 1);
  readonly cursor = new Int32Array(MAX_CELLS);
  items = new Int32Array(0);
  readonly headF = new Float64Array(4);
  readonly headI = new Int32Array(8);

  reserve(cap: number, keep: number): boolean {
    const aabb = new Float64Array(cap * 6);
    aabb.set(this.aabb.subarray(0, keep * 6));
    this.aabb = aabb;
    this.range = new Int32Array(cap * 4);
    this.state = new Int32Array(cap);
    this.over = new Int32Array(cap);
    this.loose = new Int32Array(cap);
    this.items = new Int32Array(cap * MAX_SPAN);
    this.cap = cap;
    return true;
  }

  build(n: number, cell: number): void { buildGrid(this, n, cell); }
}

/** The moving shapes of one physics world, by slot: slot i is `Physics.moving[i]`. */
export class MovingIndex {
  /** Slots in use. */
  n = 0;
  /** Slots a query found, in rising order; valid until the next query. */
  found = new Int32Array(0);
  /** Times the grid has been built, for the benches. */
  builds = 0;
  store: MovingStore;
  private readonly cell: number;
  private built = false;
  private limit = 0;
  private seen = new Int32Array(0);
  private stamp = 0;
  // The store's arrays, held here so a query reads fields of one object; `adopt` re-reads them after the store grows.
  private aabb!: Float64Array;
  private range!: Int32Array;
  private state!: Int32Array;
  private over!: Int32Array;
  private loose!: Int32Array;
  private cellStart!: Int32Array;
  private items!: Int32Array;
  private headF!: Float64Array;
  private headI!: Int32Array;

  constructor(store: MovingStore, cell: number) {
    this.store = store;
    this.cell = cell;
    this.adopt();
  }

  get kind(): 'typescript' | 'kernel' { return this.store.kind; }

  private adopt(): void {
    const s = this.store;
    this.aabb = s.aabb; this.range = s.range; this.state = s.state; this.over = s.over; this.loose = s.loose;
    this.cellStart = s.cellStart; this.items = s.items; this.headF = s.headF; this.headI = s.headI;
    if (this.seen.length < s.cap) { this.seen = new Int32Array(s.cap); this.found = new Int32Array(s.cap); this.stamp = 0; }
  }

  /** Room for one more slot. A kernel store that cannot grow is replaced by arrays: the world keeps working. */
  private grow(): void {
    const cap = Math.max(256, this.store.cap * 2);
    if (!this.store.reserve(cap, this.n)) {
      const plain = new ArrayStore();
      plain.reserve(cap, 0);
      plain.aabb.set(this.aabb.subarray(0, this.n * 6));
      console.error('physics: the kernel could not grow its memory; this world continues on the TypeScript broadphase');
      this.store = plain;
    }
    this.built = false;
    this.adopt();
  }

  /** Gives a new moving shape the next slot. */
  add(s: Shape): void {
    if (this.n === this.store.cap) this.grow();
    s._index = this;
    s._slot = this.n++;
    this.write(s._slot, s);
    this.built = false;
  }

  /** Frees slot `k`; `moving` is the world's list with that shape already taken out, so later shapes move down one. */
  remove(k: number, gone: Shape, moving: readonly Shape[]): void {
    gone._index = null;
    gone._slot = -1;
    this.aabb.copyWithin(k * 6, (k + 1) * 6, this.n * 6);
    this.n--;
    for (let i = k; i < this.n; i++) moving[i]!._slot = i;
    this.built = false;
  }

  private write(slot: number, s: Shape): void {
    const a = this.aabb, o = slot * 6;
    a[o] = s.minx; a[o + 1] = s.miny; a[o + 2] = s.minz; a[o + 3] = s.maxx; a[o + 4] = s.maxy; a[o + 5] = s.maxz;
  }

  /**
   * A shape's bounds changed. While it stays inside the cells it was filed under, nothing else is needed: queries
   * test the bounds written here. Once it leaves them it joins the loose list, which every query checks, and when
   * that list is long the next query builds the grid again.
   */
  touch(slot: number, s: Shape): void {
    const a = this.aabb, o = slot * 6;
    const x0 = s.minx, z0 = s.minz, x1 = s.maxx, z1 = s.maxz;
    a[o] = x0; a[o + 1] = s.miny; a[o + 2] = z0; a[o + 3] = x1; a[o + 4] = s.maxy; a[o + 5] = z1;
    if (!this.built || this.state[slot] !== GRID) return;
    const cs = this.headF[CS]!, fi0 = this.headF[FI0]!, fk0 = this.headF[FK0]!, r = slot * 4, range = this.range;
    // Written so bounds that are not numbers fail it and go loose.
    if (Math.floor(x0 / cs) - fi0 >= range[r]! && Math.floor(x1 / cs) - fi0 <= range[r + 1]!
      && Math.floor(z0 / cs) - fk0 >= range[r + 2]! && Math.floor(z1 / cs) - fk0 <= range[r + 3]!) return;
    this.state[slot] = LOOSE;
    this.loose[this.headI[NLOOSE]!] = slot;
    this.headI[NLOOSE]!++;
  }

  private rebuild(): void {
    this.store.build(this.n, this.cell);
    this.built = true;
    this.builds++;
    // A grid is rebuilt once this many shapes have left their cells: few enough that checking them all stays cheap.
    this.limit = 16 + (this.n >> 3);
  }

  /** Every slot whose bounds meet the box, the plain way. Slots come out in rising order by themselves. */
  private linear(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
    const a = this.aabb, found = this.found, n = this.n;
    let m = 0;
    for (let i = 0, o = 0; i < n; i++, o += 6) {
      if (a[o]! > x1 || a[o + 3]! < x0 || a[o + 1]! > y1 || a[o + 4]! < y0 || a[o + 2]! > z1 || a[o + 5]! < z0) continue;
      found[m++] = i;
    }
    return m;
  }

  /**
   * Fills `found` with the slots whose bounds meet the box, in rising order, and returns how many. The test on each
   * slot is the one the old walk made (a bound that is not a number rejects nothing), so the answer is the same set.
   */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
    const n = this.n;
    if (n === 0) return 0;
    if (!this.built || this.headI[NLOOSE]! > this.limit) this.rebuild();
    // A box with an edge that is not a number has no cells; the plain walk gives the old answer for it.
    if (x0 !== x0 || x1 !== x1 || z0 !== z0 || z1 !== z1) return this.linear(x0, y0, z0, x1, y1, z1);
    const hf = this.headF, hi = this.headI;
    const cs = hf[CS]!, ni = hi[NI]!, nk = hi[NK]!;
    let a0 = Math.floor(x0 / cs) - hf[FI0]!, a1 = Math.floor(x1 / cs) - hf[FI0]!;
    let c0 = Math.floor(z0 / cs) - hf[FK0]!, c1 = Math.floor(z1 / cs) - hf[FK0]!;
    if (a0 < 0) a0 = 0;
    if (c0 < 0) c0 = 0;
    if (a1 > ni - 1) a1 = ni - 1;
    if (c1 > nk - 1) c1 = nk - 1;
    // A box over more cells than there are shapes is cheaper walked plainly.
    if (a1 >= a0 && c1 >= c0 && (a1 - a0 + 1) * (c1 - c0 + 1) > n) return this.linear(x0, y0, z0, x1, y1, z1);
    if (this.stamp === 0x7fffffff) { this.seen.fill(0); this.stamp = 0; }
    const stamp = ++this.stamp;
    const a = this.aabb, found = this.found, seen = this.seen, start = this.cellStart, items = this.items;
    let m = 0;
    for (let x = a0; x <= a1; x++) {
      for (let z = c0; z <= c1; z++) {
        const c = x * nk + z;
        for (let j = start[c]!, end = start[c + 1]!; j < end; j++) {
          const i = items[j]!;
          if (seen[i] === stamp) continue;
          seen[i] = stamp;
          const o = i * 6;
          if (a[o]! > x1 || a[o + 3]! < x0 || a[o + 1]! > y1 || a[o + 4]! < y0 || a[o + 2]! > z1 || a[o + 5]! < z0) continue;
          found[m++] = i;
        }
      }
    }
    const over = this.over, loose = this.loose;
    for (let j = 0, end = hi[NOVER]!; j < end; j++) {
      const i = over[j]!, o = i * 6;
      if (a[o]! > x1 || a[o + 3]! < x0 || a[o + 1]! > y1 || a[o + 4]! < y0 || a[o + 2]! > z1 || a[o + 5]! < z0) continue;
      found[m++] = i;
    }
    // A loose shape is still filed under its old cells, so it may have been seen (and judged) already.
    for (let j = 0, end = hi[NLOOSE]!; j < end; j++) {
      const i = loose[j]!;
      if (seen[i] === stamp) continue;
      const o = i * 6;
      if (a[o]! > x1 || a[o + 3]! < x0 || a[o + 1]! > y1 || a[o + 4]! < y0 || a[o + 2]! > z1 || a[o + 5]! < z0) continue;
      found[m++] = i;
    }
    // Back into the order the shapes were added: the order the old walk offered them in, which settles ties.
    if (m > 48) found.subarray(0, m).sort();
    else {
      for (let j = 1; j < m; j++) {
        const v = found[j]!;
        let k = j - 1;
        while (k >= 0 && found[k]! > v) { found[k + 1] = found[k]!; k--; }
        found[k + 1] = v;
      }
    }
    return m;
  }
}
