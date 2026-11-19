// hull core: the loop, the world, nodes, behaviours, signals, timers, random. Runs in Node and the browser.

/** Event names and payloads, declared by the game through module augmentation, so a typo does not compile. */
export interface HullEvents {}

export type * from './types.ts';
export { defineGame, startGame } from './game.ts';
export { World } from './world.ts';
export { Node } from './node.ts';
export { Behaviour } from './behaviour.ts';
export { signal } from './signal.ts';
export { scratch } from './scratch.ts';
export { trace, setTraceSink, isTracing, type TraceKind, type TraceSink } from './trace.ts';
