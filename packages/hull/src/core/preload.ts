// What has to be in place before a game's `ready` runs and takes an await to get. A module of the engine registers a
// loader here when it is imported (hull/kernel compiles its WebAssembly this way) and `startGame` awaits them all.
// Core knows nothing of what they load, so it stays free of every one of them.
import type { StartOptions } from './types.ts';

type Preload = (opts: StartOptions) => Promise<void>;
const preloads: Preload[] = [];

/** Registers a loader that every later `startGame` awaits before `ready`. Registering the same function twice is one registration. */
export function beforeStart(fn: Preload): void {
  if (!preloads.includes(fn)) preloads.push(fn);
}

/** @internal */
export async function runPreloads(opts: StartOptions): Promise<void> {
  for (let i = 0; i < preloads.length; i++) await preloads[i]!(opts);
}
