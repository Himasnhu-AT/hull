// The "Just now" strip: the last few things the game did, newest first, as chips. No React, so it is tested in Node.

import type { RecentEvent } from 'hull/dev/protocol';
import type { AttachedPiece } from './types.ts';

export const STRIP_MAX = 5;
/** How many raw events the strip remembers: the chips fold repeats of one piece, so it needs more than it shows. */
export const STRIP_KEEP = 40;

const same = (a: RecentEvent, b: RecentEvent): boolean => a.at === b.at && a.kind === b.kind && a.id === b.id;

/** Folds a push into the strip: the new events go in front (newest first within the push), the same event twice is dropped, the last STRIP_KEEP are kept. */
export function mergeRecent(strip: readonly RecentEvent[], incoming: readonly RecentEvent[], max = STRIP_KEEP): RecentEvent[] {
  const fresh = [...incoming].sort((a, b) => b.at - a.at).filter((e) => !strip.some((s) => same(s, e)));
  const out: RecentEvent[] = [];
  for (const e of [...fresh, ...strip]) if (!out.some((o) => same(o, e))) out.push(e);
  return out.slice(0, max);
}

export interface Chip { event: RecentEvent; count: number }

/** One chip per piece (kind and id), newest first, with how many times it happened; at most five. */
export function chips(strip: readonly RecentEvent[], max = STRIP_MAX): Chip[] {
  const out: Chip[] = [];
  for (const e of [...strip].sort((a, b) => b.at - a.at)) {
    const c = out.find((o) => o.event.kind === e.kind && o.event.id === e.id);
    if (c) c.count++; else out.push({ event: e, count: 1 });
  }
  return out.slice(0, max);
}

/** The game page's address with this frame's client id on it, keeping any query the address already has. */
export function frameUrl(gameUrl: string, client: string): string {
  return `${gameUrl}${gameUrl.includes('?') ? '&' : '?'}hull-client=${encodeURIComponent(client)}`;
}

/** Game time as m:ss. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const KIND_WORD: Record<RecentEvent['kind'], string> = { sound: 'sound', anim: 'animation', vfx: 'effect', actor: 'character' };

/** A chip's piece for the builder column. One id appears once, whatever happened to it. */
export function piecesOf(events: readonly RecentEvent[]): AttachedPiece[] {
  const out: AttachedPiece[] = [];
  for (const e of events) if (!out.some((p) => p.key === e.id)) out.push({ key: e.id, kind: KIND_WORD[e.kind], name: e.label });
  return out;
}
