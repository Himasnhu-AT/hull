// Public interfaces of core. The classes that implement them live in the sibling files.
import type { HullEvents } from './index.ts';
import type { Node } from './node.ts';
import type { World } from './world.ts';

export interface GameDef {
  readonly ready: (game: Game) => void | Promise<void>;
  /** Fixed steps per second (30, 60 or 120). Comes from hull.json; 60 if unset. */
  readonly stepRate?: number;
  /** Seed for every random stream. Same seed, same inputs, same checksum. */
  readonly seed?: number;
}

export interface Game {
  readonly world: World;
  /** Exactly n fixed steps (default 1), no real time involved. Runs no `update` and no `onFrame` callbacks. */
  step(n?: number): void;
  /** What the browser loop calls with real seconds; clamps, scales by timeScale, runs whole steps. */
  frame(realDt: number): void;
  timeScale: number;
  paused: boolean;
  /** Render, audio and UI read state here and never write it. Returns an unsubscribe. */
  onFrame(fn: (alpha: number) => void): () => void;
  /** Runs at the start of every frame and every `step` call, before any fixed step: input sampling lives here. */
  onBeforeSteps(fn: () => void): () => void;
  dispose(): void;
}

export interface Timer { cancel(): void; readonly active: boolean }

export interface Random {
  next(): number;
  range(a: number, b: number): number;
  /** Whole number from a to b, both ends included. */
  int(a: number, b: number): number;
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
}

export interface Events {
  emit<K extends keyof HullEvents>(name: K, payload: HullEvents[K]): void;
  on<K extends keyof HullEvents>(name: K, fn: (payload: HullEvents[K]) => void, owner?: Node): () => void;
}

export interface SystemDef {
  fixedUpdate?(dt: number): void;
  update?(dt: number, alpha: number): void;
}

export interface Signal<A extends unknown[] = []> {
  connect(fn: (...a: A) => void, owner?: Node): () => void;
  emit(...a: A): void;
}
