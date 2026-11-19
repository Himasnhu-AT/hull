// Everything: every piece of the project as cards on shelves. A card shows what it is (a preview, a sound that plays),
// says what the person has done with it (new, approved, note sent) and offers Approve, Change and Open.
// Data: the library (from the shell), content.list for the previews, review.list for the tags.
//   rpc, project   as everywhere
//   library        the project's pieces (library.list), null while loading
//   onAttach(p)    Change: attach the piece to the builder column
//   onOpen(key)    Open: the shell shows the piece on its bench or in the Inspector, in a sheet

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { ContentThumb, LibraryItem, ReviewEntry } from 'hull/dev/protocol';
import type { OpenedProject } from '../../shared/appApi.ts';
import { Thumb } from '../content/Thumb.tsx';
import type { RpcClient } from '../lib/rpc.ts';
import { Icon } from '../ui/Icon.tsx';
import { buildShelves, kindWords, TAG_TEXT, type Card } from './shelves.ts';
import { playSound } from './soundPlay.ts';
import type { AttachedPiece } from './types.ts';

export interface EverythingProps { rpc: RpcClient; project: OpenedProject; library: LibraryItem[] | null; onAttach(p: AttachedPiece): void; onOpen(key: string): void }

function useReviews(rpc: RpcClient): [ReviewEntry[], (e: ReviewEntry) => void] {
  const [list, setList] = useState<ReviewEntry[]>([]);
  useEffect(() => {
    let live = true;
    const load = (): void => { rpc.call('review.list', {}).then((r) => { if (live) setList(r); }, () => { /* older server: every card stays new */ }); };
    const offs = [rpc.onStatus((s) => { if (s === 'open') load(); }), rpc.on('review.changed', load)];
    if (rpc.status === 'open') load();
    return () => { live = false; offs.forEach((o) => o()); };
  }, [rpc]);
  const put = useCallback((e: ReviewEntry) => setList((l) => [...l.filter((x) => x.key !== e.key), e]), []);
  return [list, put];
}

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
              <article key={c.key} className="cr-card">
                <div className="cr-pv">
                  <Thumb kind={c.kind} thumb={thumbs[c.key]} />
                  <span className={`cr-tag ${c.tag}`}>{TAG_TEXT[c.tag]}</span>
                  {c.kind === 'sound' && (
                    <button className="cr-playsnd" onClick={() => void play(c)} disabled={playing === c.key} aria-label={`Play ${c.name}`} title="Play"><Icon name="play" size={16} /></button>
                  )}
                </div>
                <div className="cr-cb">
                  <div className="cr-name"><b>{c.name}</b><span className="cr-k">{kindWords(c.kind)}</span></div>
                  {c.note && <p>{c.note}</p>}
                  {c.problems > 0 && <p className="cr-warn">{c.problems} problem{c.problems === 1 ? '' : 's'} to fix</p>}
                  <div className="cr-ca">
                    <button className="btn" onClick={() => void approve(c)} disabled={c.tag === 'approved'}>{c.tag === 'approved' ? 'Approved' : 'Approve'}</button>
                    <button className="btn" onClick={() => onAttach({ key: c.key, kind: c.kind, name: c.name })}>Change</button>
                    <button className="btn ghost" onClick={() => onOpen(c.key)}>Open</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
