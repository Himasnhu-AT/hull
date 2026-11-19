// The "Just now" ring: the last 64 things the running game did, stamped with game time, handed to the project server in
// batches. Pure (no window, no clock of its own): the runtime gives it the game's time and a way to send, so it runs in
// a test the same as in the page.
import type { TraceKind } from '../core/trace.ts';
import type { RecentEvent } from './protocol.ts';

export const RING = 64;

interface Slot { at: number; kind: TraceKind; id: string; node: string | undefined }

/** A chip's plain name when the config has no title: the last part of the id ('sound/sword/hit' -> 'hit', 'anim-graph/hero#attack' -> 'attack'). */
export function lastPart(id: string): string {
  const parts = id.split(/[/#]/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? id;
}

export interface RecentFeed {
  /** The trace sink. Writes one slot of the ring; allocates nothing. */
  add(kind: TraceKind, id: string, node?: string): void;
  /** Sends the events added since the last flush (nothing when there are none). */
  flush(): number;
  /** Forgets everything, for a restart. */
  clear(): void;
  /** What is in the ring, oldest first. For tests and tools. */
  snapshot(): RecentEvent[];
}

export function createRecentFeed(o: { time(): number; title(kind: TraceKind, id: string): string | undefined; send(items: RecentEvent[]): void }): RecentFeed {
  const ring: Slot[] = [];
  for (let i = 0; i < RING; i++) ring.push({ at: 0, kind: 'sound', id: '', node: undefined });
  // Counts of events ever added and ever sent; the slot of event n is n % RING.
  let added = 0;
  let sent = 0;

  const event = (s: Slot): RecentEvent => {
    const e: RecentEvent = { at: s.at, kind: s.kind, id: s.id, label: o.title(s.kind, s.id) ?? lastPart(s.id) };
    if (s.node !== undefined) e.node = s.node;
    return e;
  };
  return {
    add(kind, id, node) {
      const s = ring[added % RING]!;
      s.at = o.time(); s.kind = kind; s.id = id; s.node = node;
      added++;
    },
    flush() {
      // A burst of more than a ring's worth between flushes loses the oldest: the strip only shows the newest anyway.
      const from = Math.max(sent, added - RING);
      sent = added;
      if (from === added) return 0;
      const items: RecentEvent[] = [];
      for (let n = from; n < added; n++) items.push(event(ring[n % RING]!));
      o.send(items);
      return items.length;
    },
    clear() { added = 0; sent = 0; },
    snapshot() {
      const out: RecentEvent[] = [];
      for (let n = Math.max(0, added - RING); n < added; n++) out.push(event(ring[n % RING]!));
      return out;
    },
  };
}
