// Interpolation between fixed steps. The simulation moves nodes in whole steps; the screen refreshes at any rate.
// Each tracked node keeps its transform from the step before the last one, and at draw time the node shows a
// blend of the two by `alpha`. After the draw the real transform is put back, so the simulation (and the
// checksum) never sees the blend.
import type { Node, World } from '../core/index.ts';

const STRIDE = 9; // position xyz, rotation xyz (Euler), scale xyz

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class Interp {
  private nodes: (Node | null)[] = [];
  private prev = new Float64Array(STRIDE * 64);
  /** Transform as the last fixed step left it; this is what gets restored after drawing. */
  private cur = new Float64Array(STRIDE * 64);
  /** 1 until a step has run since the node was tracked, so a node moved in ready() does not glide from nowhere. */
  private fresh = new Uint8Array(64);
  private shown = new Uint8Array(64);
  private count = 0;
  private readonly index = new Map<Node, number>();

  /** Tracks the node and every ancestor: a child's blended transform needs its parent's blended too. */
  track(node: Node): void {
    for (let n: Node | null = node; n !== null && !this.index.has(n); n = n.parent) this.add(n);
  }

  /** Forget the history of a node that jumped (a respawn, a portal): it appears at the new place at once. */
  snap(node: Node): void {
    const i = this.index.get(node);
    if (i !== undefined) this.fresh[i] = 1;
  }

  get tracked(): number {
    return this.count;
  }

  /** Called after each fixed step: what was current becomes previous, and the node's transform becomes current. */
  capture(): void {
    for (let i = 0; i < this.count; ) {
      const node = this.nodes[i]!;
      if (node.destroyed) {
        this.removeAt(i);
        continue;
      }
      const o = i * STRIDE;
      if (this.fresh[i] === 1) {
        this.read(node, this.cur, o);
        for (let k = 0; k < STRIDE; k++) this.prev[o + k] = this.cur[o + k]!;
        this.fresh[i] = 0;
      } else {
        for (let k = 0; k < STRIDE; k++) this.prev[o + k] = this.cur[o + k]!;
        this.read(node, this.cur, o);
      }
      i++;
    }
  }

  /**
   * Shows the blend. A node whose transform no longer matches the last step was moved by `update` (a camera that
   * follows in a frame callback), and it is left alone: that code already works in frame time.
   */
  apply(alpha: number): void {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    for (let i = 0; i < this.count; i++) {
      this.shown[i] = 0;
      const node = this.nodes[i]!;
      if (node.destroyed || this.fresh[i] === 1) continue;
      const o = i * STRIDE;
      const c = this.cur;
      const p = node.position;
      const r = node.rotation;
      const s = node.scale;
      if (p.x !== c[o] || p.y !== c[o + 1] || p.z !== c[o + 2] || r.x !== c[o + 3] || r.y !== c[o + 4] || r.z !== c[o + 5] || s.x !== c[o + 6] || s.y !== c[o + 7] || s.z !== c[o + 8]) continue;
      const q = this.prev;
      p.set(lerp(q[o]!, c[o]!, a), lerp(q[o + 1]!, c[o + 1]!, a), lerp(q[o + 2]!, c[o + 2]!, a));
      r.set(lerp(q[o + 3]!, c[o + 3]!, a), lerp(q[o + 4]!, c[o + 4]!, a), lerp(q[o + 5]!, c[o + 5]!, a));
      s.set(lerp(q[o + 6]!, c[o + 6]!, a), lerp(q[o + 7]!, c[o + 7]!, a), lerp(q[o + 8]!, c[o + 8]!, a));
      this.shown[i] = 1;
    }
  }

  /** Gives every blended node its real transform back. */
  restore(): void {
    for (let i = 0; i < this.count; i++) {
      if (this.shown[i] === 0) continue;
      this.shown[i] = 0;
      const node = this.nodes[i]!;
      if (node.destroyed) continue;
      const o = i * STRIDE;
      const c = this.cur;
      node.position.set(c[o]!, c[o + 1]!, c[o + 2]!);
      node.rotation.set(c[o + 3]!, c[o + 4]!, c[o + 5]!);
      node.scale.set(c[o + 6]!, c[o + 7]!, c[o + 8]!);
    }
  }

  private read(node: Node, into: Float64Array, o: number): void {
    const p = node.position;
    const r = node.rotation;
    const s = node.scale;
    into[o] = p.x; into[o + 1] = p.y; into[o + 2] = p.z;
    into[o + 3] = r.x; into[o + 4] = r.y; into[o + 5] = r.z;
    into[o + 6] = s.x; into[o + 7] = s.y; into[o + 8] = s.z;
  }

  private add(node: Node): void {
    if (this.count === this.fresh.length) this.grow();
    const i = this.count++;
    this.nodes[i] = node;
    this.index.set(node, i);
    this.fresh[i] = 1;
    this.shown[i] = 0;
    this.read(node, this.cur, i * STRIDE);
    this.read(node, this.prev, i * STRIDE);
  }

  private removeAt(i: number): void {
    const last = --this.count;
    this.index.delete(this.nodes[i]!);
    if (i !== last) {
      const moved = this.nodes[last]!;
      this.nodes[i] = moved;
      this.index.set(moved, i);
      for (let k = 0; k < STRIDE; k++) {
        this.prev[i * STRIDE + k] = this.prev[last * STRIDE + k]!;
        this.cur[i * STRIDE + k] = this.cur[last * STRIDE + k]!;
      }
      this.fresh[i] = this.fresh[last]!;
      this.shown[i] = this.shown[last]!;
    }
    this.nodes[last] = null;
  }

  private grow(): void {
    const n = this.fresh.length * 2;
    const prev = new Float64Array(n * STRIDE); prev.set(this.prev); this.prev = prev;
    const cur = new Float64Array(n * STRIDE); cur.set(this.cur); this.cur = cur;
    const fresh = new Uint8Array(n); fresh.set(this.fresh); this.fresh = fresh;
    const shown = new Uint8Array(n); shown.set(this.shown); this.shown = shown;
  }
}

/** What the render side keeps per world. */
export interface RenderState {
  readonly interp: Interp;
  /** Sun Light behaviours alive in this world; while there is one, the look's own sun is switched off. */
  suns: number;
}

const states = new WeakMap<World, RenderState>();

export function stateFor(world: World): RenderState {
  let s = states.get(world);
  if (s === undefined) {
    const interp = new Interp();
    s = { interp, suns: 0 };
    states.set(world, s);
    // Systems run after every behaviour's fixedUpdate, so this sees the step's final transforms.
    world.system('render.interp', { fixedUpdate: () => interp.capture() });
  }
  return s;
}

/** Mark a node as having jumped this step, so no blend is drawn between its old and new place. */
export function teleported(node: Node): void {
  stateFor(node.world).interp.snap(node);
}
