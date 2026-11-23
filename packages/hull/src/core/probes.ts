// Probes: named readings a game registers so a tool can see what the game means, not just where nodes are. The dev runtime
// reads them for `state` and `until`. In a ship build nothing reads them: the cost is one Map entry per probe.
//
// Core runs in Node: no window, no clock. A probe's reader must be cheap and must not change the game.

export type ProbeValue = number | string | boolean;
export type ProbeReader = () => ProbeValue;

const probes = new Map<string, ProbeReader>();

/** Registers (or replaces) a reading, usually in `ready`: `probe('score', () => round.score)`. */
export function probe(name: string, read: () => ProbeValue): void {
  probes.set(name, read);
}

/** Forgets every probe. The dev runtime calls it when the game restarts, so a new `ready` registers them afresh. */
export function clearProbes(): void {
  probes.clear();
}

/** @internal The registered names, in registration order. */
export function probeNames(): IterableIterator<string> {
  return probes.keys();
}

/** @internal One probe's value now, or undefined when none is registered under that name. A reader that throws propagates. */
export function readProbe(name: string): ProbeValue | undefined {
  return probes.get(name)?.();
}
