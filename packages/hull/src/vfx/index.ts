// Particle effects driven by `vfx` config. A game calls `mountVfx(game)` once (the dev page does it for you), then
// `vfx.burst('dust', at, dir)` for a one-shot and `vfx.trail('gas', node)` for a stream that follows a node.
import type { Game, Node } from '../core/index.ts';
import { VfxSystem, type BurstOptions, type TrailHandle, type VfxStats } from './system.ts';
import type { GroundFn, V3 } from './emitter.ts';

export type { BurstOptions, GroundFn, TrailHandle, VfxStats, V3 };
export { compile, drawCount, nearFade, Pool, spawnOne } from './emitter.ts';
export type { Compiled } from './emitter.ts';
export { buildLut, lutAt, parseColor, sampleColorCurve, sampleCurve } from './curves.ts';

let current: VfxSystem | null = null;
let warned = false;

function active(call: string): VfxSystem | null {
  if (current) return current;
  if (!warned) {
    warned = true;
    console.warn(`[hull] vfx.${call}: call mountVfx(game) first; effects are skipped until then.`);
  }
  return null;
}

const none: TrailHandle = { stop() {}, active: false };

/** What a game calls. Safe before `mountVfx`: it does nothing (and says so once). */
export const vfx = {
  /**
   * One burst at `at`; `dir` aims the effect's cone (the up axis in the config otherwise). `opts` changes this call's
   * count, size and speed without a second config.
   */
  burst(id: string, at: V3, dir?: V3, opts?: BurstOptions): void {
    active('burst')?.burst(id, at, dir, opts);
  },
  /** Gives effects with `particle.ground` the ground's height at (x, z); null takes it away. */
  setGround(fn: GroundFn | null): void {
    active('setGround')?.setGround(fn);
  },
  /** Particles along the path of `node`, `emit.rate` a second, until the handle's `stop()` or the node is destroyed. */
  trail(id: string, node: Node): TrailHandle {
    return active('trail')?.trail(id, node) ?? none;
  },
  stats(): VfxStats {
    return current?.stats() ?? { live: 0, capacity: 0, spawned: 0, dropped: 0, drawCalls: 0, effects: {} };
  },
  /** Remove every live particle (a restart, a bench reset). */
  clear(): void {
    current?.clear();
  },
};

export interface VfxView {
  readonly system: VfxSystem;
  dispose(): void;
}

/** Attaches particles to the game's world. They are simulated in the fixed step and drawn by `mountRender`. */
export function mountVfx(game: Game): VfxView {
  const system = new VfxSystem(game.world);
  current = system;
  return {
    system,
    dispose() {
      system.dispose();
      if (current === system) current = null;
    },
  };
}

/**
 * For the app's bench: plays `id` once at `at` (default the origin, aimed up) and again every `every` seconds until
 * stopped. Needs `mountVfx` to have run. Returns a function that stops it.
 */
export function previewVfx(id: string, opts: { at?: V3; dir?: V3; every?: number; game: Game }): () => void {
  const at = opts.at ?? { x: 0, y: 0, z: 0 };
  const every = opts.every ?? 1.5;
  vfx.burst(id, at, opts.dir);
  const timer = opts.game.world.every(every, () => vfx.burst(id, at, opts.dir));
  return () => timer.cancel();
}
