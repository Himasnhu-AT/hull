// The "Just now" feed's one hook. The engine says what the game just did (a sound started, a clip began, an effect was
// spawned, a character came alive); the dev runtime listens and keeps the last few seconds. Nothing listens in a ship
// build, so the whole cost there is a call that returns at once.
//
// Core runs in Node: nothing here touches the window, the document or the clock. The listener stamps events with game time.

export type TraceKind = 'sound' | 'anim' | 'vfx' | 'actor';
export type TraceSink = (kind: TraceKind, id: string, node?: string) => void;

let sink: TraceSink | null = null;

/** Installs the one listener, or removes it with null. */
export function setTraceSink(fn: TraceSink | null): void {
  sink = fn;
}

/** True when a listener is installed. Call sites that build their id with a template check this first, so no string is made for nothing. */
export function isTracing(): boolean {
  return sink !== null;
}

/** Reports one event. With no listener it returns at once and allocates nothing. */
export function trace(kind: TraceKind, id: string, node?: string): void {
  if (sink === null) return;
  sink(kind, id, node);
}
