// The moving-shape index's numbers inside the kernel's memory (plan-rust.md R1). TypeScript writes bounds into the
// views and reads the grid back out of them: an array access, no call and no copy. The one call a rebuild makes is
// `hk_mi_build`. Views are made again whenever the kernel's memory has grown, which only `reserve` causes.
import type { KernelExports } from '../kernel/index.ts';
import { MAX_CELLS, MAX_SPAN, type MovingStore } from './moving.ts';

/** The arrays in the order the kernel lays them out (lib.rs, F_*). */
const F = { headF: 0, headI: 1, aabb: 2, range: 3, state: 4, over: 5, loose: 6, seen: 7, out: 8, cellStart: 9, cursor: 10, items: 11 } as const;

export class KernelStore implements MovingStore {
  readonly kind = 'kernel' as const;
  cap = 0;
  aabb!: Float64Array;
  range!: Int32Array;
  state!: Int32Array;
  over!: Int32Array;
  loose!: Int32Array;
  cellStart!: Int32Array;
  cursor!: Int32Array;
  items!: Int32Array;
  headF!: Float64Array;
  headI!: Int32Array;
  /** Where `query` leaves its answer. */
  out!: Int32Array;

  /** Reserves the first block at once, so a world that cannot have one finds out here and not in a frame. */
  constructor(private readonly k: KernelExports, cap = 256) {
    if (!this.reserve(cap, 0)) throw new Error('the kernel could not reserve memory for the moving-shape index');
  }

  reserve(cap: number, _keep: number): boolean {
    // The bounds lie first in the block and do not move when it grows, so the slots to keep are kept by themselves.
    if (this.k.hk_mi_reserve(cap) !== 1) return false;
    this.cap = cap;
    const b = this.k.memory.buffer, k = this.k;
    this.headF = new Float64Array(b, k.hk_mi_ptr(F.headF), 4);
    this.headI = new Int32Array(b, k.hk_mi_ptr(F.headI), 8);
    this.aabb = new Float64Array(b, k.hk_mi_ptr(F.aabb), cap * 6);
    this.range = new Int32Array(b, k.hk_mi_ptr(F.range), cap * 4);
    this.state = new Int32Array(b, k.hk_mi_ptr(F.state), cap);
    this.over = new Int32Array(b, k.hk_mi_ptr(F.over), cap);
    this.loose = new Int32Array(b, k.hk_mi_ptr(F.loose), cap);
    this.out = new Int32Array(b, k.hk_mi_ptr(F.out), cap);
    this.cellStart = new Int32Array(b, k.hk_mi_ptr(F.cellStart), MAX_CELLS + 1);
    this.cursor = new Int32Array(b, k.hk_mi_ptr(F.cursor), MAX_CELLS);
    this.items = new Int32Array(b, k.hk_mi_ptr(F.items), cap * MAX_SPAN);
    return true;
  }

  build(n: number, cell: number): void { this.k.hk_mi_build(n, cell); }

  /**
   * The whole query inside the kernel, for a grid that is built: the answer is in `out`. The engine does not use it
   * (a call a query is more calls a step than the kernel boundary allows); the bench times it and the parity test
   * checks it.
   */
  query(n: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
    return this.k.hk_mi_query(n, x0, y0, z0, x1, y1, z1);
  }
}
