// The few places that really need the wall clock or a browser timer: the sound scheduler, the HUD's fades, the date on
// a saved record. Never the simulation: game time is world.after and the step count (sim.ts). They go through
// globalThis so it is plain that this is the exception, and so house rules (no setTimeout, Date.now,
// performance.now in game code) hold everywhere else.

/** Milliseconds from a monotonic clock. UI and audio only. */
export const wallMs = (): number => globalThis.performance?.now() ?? 0;
/** Milliseconds since 1970, for a date stamp on a saved record. */
export const epochMs = (): number => globalThis.Date.now();
/** A browser timer; returns its id. UI and audio only. */
export const later = (fn: () => void, ms: number): number => globalThis.setTimeout(fn, ms) as unknown as number;
export const every = (fn: () => void, ms: number): number => globalThis.setInterval(fn, ms) as unknown as number;
export const stopEvery = (id: number): void => globalThis.clearInterval(id);
