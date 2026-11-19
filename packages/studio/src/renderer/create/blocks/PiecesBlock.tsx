// pieces: the cards a stage made, in the conversation. The same cards as the Build screen.

import type { JSX } from 'react';
import { STAGE_LABEL, splitPieces } from '../buildView.ts';
import { ExplainCardById } from '../ExplainCard.tsx';
import { PieceGrid } from '../PieceGrid.tsx';
import { ValuesCard } from '../ValuesCard.tsx';
import type { Item } from '../transcript.ts';

export function PiecesBlock({ item }: { item: Extract<Item, { k: 'ui' }> }): JSX.Element | null {
  const b = item.block;
  if (b.kind !== 'pieces') return null;
  const { look, explained, numbers } = splitPieces(b.keys);
  return (
    <section className="cr-ui" aria-label={`Made for ${STAGE_LABEL[b.stage]}`}>
      <b>Made for {STAGE_LABEL[b.stage].toLowerCase()}</b>
      {look.length === 0 && explained.length === 0 && numbers.length === 0 && <p className="cr-sub">Nothing to look at yet.</p>}
      {look.length > 0 && <PieceGrid keys={look} stage={b.stage} compact />}
      {explained.map((id) => <ExplainCardById key={id} id={id} stage={b.stage} compact />)}
      {numbers.map((k) => <ValuesCard key={k} pieceKey={k} stage={b.stage} deltas={null} />)}
    </section>
  );
}
