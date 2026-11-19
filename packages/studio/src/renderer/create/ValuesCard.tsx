// A piece that is only numbers, as a table: the name of each value, the value with its unit and what it was before this stage.
// Reviewed under the piece's own key (the one its card would have used), so Looks right and Change work as for any explained piece.

import { useState, type JSX } from 'react';
import type { ChangeDelta, StageId } from 'hull/dev/protocol';
import { NoteBar } from './NoteBar.tsx';
import { pieceName } from './plainNames.ts';
import { TAG_TEXT } from './shelves.ts';
import { useValues } from './useValues.ts';
import { useBuilder } from './useBuilder.tsx';

export interface ValuesCardProps { pieceKey: string; stage: StageId; deltas: ChangeDelta[] | null }

export function ValuesCard({ pieceKey, stage, deltas }: ValuesCardProps): JSX.Element {
  const b = useBuilder();
  const view = useValues(b.rpc, pieceKey, deltas);
  const name = b.pieces.cards.get(pieceKey)?.name ?? pieceName(pieceKey);
  const tag = b.pieces.tag(pieceKey);
  const [changing, setChanging] = useState(false);
  return (
    <article className="cr-xcard cr-vcard" aria-label={name}>
      <div className="cr-cb">
        <div className="cr-name"><b title={pieceKey}>{name}</b><span className={`cr-tag inline ${tag}`}>{TAG_TEXT[tag]}</span></div>
        {view === null && <div className="skeleton" />}
        {view !== null && view.rows.length === 0 && <p className="cr-why">No values to show yet.</p>}
        {view !== null && view.rows.length > 0 && (
          <div className="cr-tbl cr-vals">
            <table>
              <caption className="cr-sr">{name}</caption>
              <thead><tr><th scope="col">Value</th><th scope="col" className="num">Now</th>{view.hasBefore && <th scope="col" className="num">Before this stage</th>}</tr></thead>
              <tbody>
                {view.rows.map((r) => (
                  <tr key={r.name} className={r.changed ? 'changed' : ''}>
                    <th scope="row">{r.name}</th>
                    <td className="num">{r.value}</td>
                    {view.hasBefore && <td className={`num cr-before${r.before === 'same' ? ' same' : ''}`}>{r.before}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {view.more > 0 && <p className="cr-sub">and {view.more} more</p>}
          </div>
        )}
        <div className="cr-ca">
          <button className="btn" onClick={() => void b.pieces.approve(pieceKey)} disabled={tag === 'approved'}>Looks right</button>
          <button className="btn" onClick={() => setChanging(!changing)}>Change</button>
        </div>
        {changing && (
          <NoteBar label={`What should change about ${name}`} placeholder="What is wrong with these numbers?" onCancel={() => setChanging(false)}
            onSend={(note) => { void b.pieces.note(pieceKey, note).then((ok) => { if (!ok) return; setChanging(false); void b.send(`Change ${name}: ${note}`, { mode: 'build', stage, about: [pieceKey] }); }); }} />
        )}
      </div>
    </article>
  );
}
