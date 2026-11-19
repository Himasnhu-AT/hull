// Everything: every piece of the project as cards on shelves. A card shows what it is (a preview, a sound that plays),
// says what the person has done with it (new, approved, note sent) and offers Approve, Change and Open.
// Data: the library (from the shell), content.list for the previews, review.list for the tags.
//   rpc, project   as everywhere
//   library        the project's pieces (library.list), null while loading
//   onAttach(p)    Change: attach the piece to the builder column
//   onOpen(key)    Open: the shell shows the piece on its bench or in the Inspector, in a sheet

import { useEffect, useMemo, useState, type JSX } from 'react';
import type { ContentThumb, LibraryItem } from 'hull/dev/protocol';
import type { OpenedProject } from '../../shared/appApi.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { PieceCard } from './PieceCard.tsx';
import { buildShelves, type Card } from './shelves.ts';
import { playSound } from './soundPlay.ts';
import type { AttachedPiece } from './types.ts';
import { useReviews } from './useReviews.ts';

export interface EverythingProps { rpc: RpcClient; project: OpenedProject; library: LibraryItem[] | null; onAttach(p: AttachedPiece): void; onOpen(key: string): void }

export function Everything({ rpc, project, library, onAttach, onOpen }: EverythingProps): JSX.Element {
  const [reviews, putReview] = useReviews(rpc);
  const [thumbs, setThumbs] = useState<Record<string, ContentThumb>>({});
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const n = library?.length ?? 0;
  useEffect(() => {
    let live = true;
    const load = (): void => { rpc.call('content.list', {}).then((r) => { if (live) setThumbs(r.thumbs); }, () => { /* cards fall back to icons */ }); };
    const off = rpc.onStatus((s) => { if (s === 'open') load(); });
    if (rpc.status === 'open') load();
    return () => { live = false; off(); };
  }, [rpc, n]);

  const shelves = useMemo(() => buildShelves(library ?? [], reviews), [library, reviews]);

  const approve = async (c: Card): Promise<void> => {
    setError(null);
    try {
      const r = await rpc.call('review.set', { key: c.key, state: 'approved', author: 'you' });
      if (r.ok && r.entry) putReview(r.entry); else setError(r.problems[0]?.message ?? 'Could not approve it.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const play = async (c: Card): Promise<void> => {
    setError(null); setPlaying(c.key);
    try { await playSound(rpc, project.gameUrl, c.key); } catch (e) { setError(`Could not play ${c.name}: ${e instanceof Error ? e.message : String(e)}`); } finally { setPlaying(null); }
  };

  if (library === null) return <div className="cr-pad"><div className="skeleton" /><div className="skeleton" /></div>;
  if (shelves.length === 0) return <div className="cr-pad"><h2>Nothing here yet</h2><p className="cr-sub">The pieces of your game appear here as the builder makes them.</p></div>;
  return (
    <div className="cr-every">
      {error && <div className="note-err" role="alert">{error}</div>}
      {shelves.map((s) => (
        <section key={s.id} className="cr-shelf" aria-label={s.title}>
          <h3>{s.title} <span className="cr-cnt">{s.cards.length}</span></h3>
          <div className="cr-grid">
            {s.cards.map((c) => (
              <PieceCard key={c.key} card={c} thumb={thumbs[c.key]} playing={playing === c.key} onPlay={() => void play(c)} onApprove={() => void approve(c)}
                onChange={() => onAttach({ key: c.key, kind: c.kind, name: c.name })} onOpen={() => onOpen(c.key)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
