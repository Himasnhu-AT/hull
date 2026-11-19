// A group of piece cards for a stage: Approve sends the approval; Change opens a note bar, and sending it marks the piece
// "needs change" with the note and gives the note to the builder (mode build, that stage, about that piece).

import { useState, type JSX } from 'react';
import type { StageId } from 'hull/dev/protocol';
import { NoteBar } from './NoteBar.tsx';
import { PieceCard } from './PieceCard.tsx';
import { useBuilder } from './useBuilder.tsx';

export function PieceGrid({ keys, stage, compact }: { keys: readonly string[]; stage?: StageId | undefined; compact?: boolean | undefined }): JSX.Element {
  const b = useBuilder();
  const p = b.pieces;
  const [changing, setChanging] = useState<string | null>(null);
  return (
    <>
      {p.error && <div className="note-err" role="alert">{p.error}</div>}
      <div className={`cr-grid${compact ? ' compact' : ''}`}>
        {keys.map((k) => {
          const c = p.cards.get(k);
          if (!c) return <div key={k} className="cr-card cr-missing"><div className="cr-cb"><div className="cr-name"><b>{k}</b></div><p>{p.library === null ? 'Loading...' : 'This piece is not in the project (any more).'}</p></div></div>;
          return (
            <PieceCard key={k} card={c} thumb={p.thumbs[k]} playing={p.playing === k} onPlay={() => void p.play(c)} onApprove={() => void p.approve(k)}
              onChange={() => setChanging(changing === k ? null : k)}
              extra={changing === k && (
                <NoteBar label={`What should change about ${c.name}`} placeholder={`What should change about ${c.name}?`} onCancel={() => setChanging(null)}
                  onSend={(note) => { void p.note(k, note).then((ok) => { if (!ok) return; setChanging(null); void b.send(`Change ${c.name}: ${note}`, { mode: stage ? 'build' : 'fix', ...(stage ? { stage } : {}), about: [k] }); }); }} />
              )} />
          );
        })}
      </div>
    </>
  );
}
