// Game time for the simulation: Hull's named random streams and timers, reached through the world the host binds at
// start. 'sim' feeds everything that changes play; 'cosmetic' feeds particles, debris, sound variation and the like,
// and is left out of the checksum, so drawing more or fewer effects (a headless run draws none) never changes a run.
import type { Random, World } from 'hull';
import { later } from './realtime';

let world: World | null = null;
let sim: Random | null = null;
let cosmetic: Random | null = null;
// Before a world is bound (a module that runs at import time) there is still a stream, fixed and deterministic.
let spare = 0x2545f491;
function fallback(): number {
  spare = (Math.imul(spare ^ (spare >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0;
  return (spare >>> 0) / 4294967296;
}

export function bindWorld(w: World | null): void {
  world = w;
  sim = w ? w.random('sim') : null;
  cosmetic = w ? w.random('cosmetic') : null;
}

/** Random numbers in [0, 1). Plain functions, so they can stand in for Math.random as a value. */
export const R = {
  /** Gameplay: where a titan spawns, how big, which area. */
  sim: (): number => (sim ? sim.next() : fallback()),
  /** Looks and sound only: never read the result into a decision. */
  fx: (): number => (cosmetic ? cosmetic.next() : fallback()),
};

/** Runs `fn` after `ms` of game time (a fixed number of steps). The replacement for setTimeout in the simulation. */
export function afterMs(fn: () => void, ms: number): void {
  if (world) world.after(ms / 1000, fn);
  else later(fn, ms);
}
