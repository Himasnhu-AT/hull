// The "Just now" strip: the last few things the game did, newest first, as chips. No React, so it is tested in Node.

import type { RecentEvent } from 'hull/dev/protocol';
import type { AttachedPiece } from './types.ts';

export const STRIP_MAX = 5;

const same = (a: RecentEvent, b: RecentEvent): boolean => a.at === b.at && a.kind === b.kind && a.id === b.id;

/** Folds a push into the strip: the new events go in front (newest first within the push), repeats are dropped, five are kept. */
export function mergeRecent(strip: readonly RecentEvent[], incoming: readonly RecentEvent[], max = STRIP_MAX): RecentEvent[] {
  const fresh = [...incoming].sort((a, b) => b.at - a.at).filter((e) => !strip.some((s) => same(s, e)));
  const out: RecentEvent[] = [];
  for (const e of [...fresh, ...strip]) if (!out.some((o) => same(o, e))) out.push(e);
  return out.slice(0, max);
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
