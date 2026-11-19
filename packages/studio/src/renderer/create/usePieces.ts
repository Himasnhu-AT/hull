// The pieces of the project as cards, for every place that shows them (Everything is the exception: it also needs the shelves).
// One instance lives in the builder's provider, so a card in the chat and the same card in Build agree.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ContentThumb, LibraryItem, ReviewEntry } from 'hull/dev/protocol';
import type { OpenedProject } from '../../shared/appApi.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { buildShelves, tagOf, type Card, type CardTag } from './shelves.ts';
import { playSound } from './soundPlay.ts';
import { useLibrary } from './useCreate.ts';
import { useReviews } from './useReviews.ts';

export interface Pieces {
  library: LibraryItem[] | null;
  cards: ReadonlyMap<string, Card>;
  thumbs: Record<string, ContentThumb>;
  reviews: ReviewEntry[];
  /** The tag of a review key (a config id, 'tunables:x' or 'explain:x'). */
  tag(key: string): CardTag;
  playing: string | null;
  error: string | null;
  approve(key: string): Promise<void>;
  /** Marks the key needs-change with the note. */
  note(key: string, note: string): Promise<boolean>;
  play(card: Card): Promise<void>;
}

export function usePieces(rpc: RpcClient, project: OpenedProject): Pieces {
  const library = useLibrary(rpc);
  const [reviews, putReview] = useReviews(rpc);
  const [thumbs, setThumbs] = useState<Record<string, ContentThumb>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const n = library?.length ?? 0;
  useEffect(() => {
    let live = true;
    const load = (): void => { rpc.call('content.list', {}).then((r) => { if (live) setThumbs(r.thumbs); }, () => { /* cards fall back to icons */ }); };
    const off = rpc.onStatus((s) => { if (s === 'open') load(); });
    if (rpc.status === 'open') load();
    return () => { live = false; off(); };
  }, [rpc, n]);

  const cards = useMemo(() => new Map(buildShelves(library ?? [], reviews).flatMap((s) => s.cards).map((c) => [c.key, c] as const)), [library, reviews]);
  const tag = useCallback((key: string): CardTag => tagOf(reviews.find((r) => r.key === key)), [reviews]);

  const approve = useCallback(async (key: string): Promise<void> => {
    setError(null);
    try {
      const r = await rpc.call('review.set', { key, state: 'approved', author: 'you' });
      if (r.ok && r.entry) putReview(r.entry); else setError(r.problems[0]?.message ?? 'Could not approve it.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [rpc, putReview]);
  const note = useCallback(async (key: string, text: string): Promise<boolean> => {
    setError(null);
    try {
      const r = await rpc.call('review.set', { key, state: 'needs-change', note: text, author: 'you' });
      if (r.ok && r.entry) { putReview(r.entry); return true; }
      setError(r.problems[0]?.message ?? 'Could not send the note.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    return false;
  }, [rpc, putReview]);
  const play = useCallback(async (c: Card): Promise<void> => {
    setError(null); setPlaying(c.key);
    try { await playSound(rpc, project.gameUrl, c.key); } catch (e) { setError(`Could not play ${c.name}: ${e instanceof Error ? e.message : String(e)}`); } finally { setPlaying(null); }
  }, [rpc, project.gameUrl]);

  return { library, cards, thumbs, reviews, tag, playing, error, approve, note, play };
}
