// approve: a yes or no with the builder's own wording on each button.

import type { JSX } from 'react';
import type { Item } from '../transcript.ts';
import { useBuilder } from '../useBuilder.tsx';

export function ApproveBlock({ item }: { item: Extract<Item, { k: 'ui' }> }): JSX.Element | null {
  const { answer } = useBuilder();
  const b = item.block;
  if (b.kind !== 'approve') return null;
  const waits = item.reqId !== undefined && item.answer === undefined && b.answer === undefined;
  const chosen = item.answer ? item.answer.optionId : b.answer;
  return (
    <div className="cr-ui" role="group" aria-label={b.question}>
      <b>{b.question}</b>
      {b.detail && <p className="cr-sub">{b.detail}</p>}
      <div className="cr-opts">
        <button className={`btn${waits ? ' primary' : ''}`} aria-pressed={chosen === 'yes'} disabled={!waits} onClick={() => answer(item.reqId!, 'yes')}>{b.yes}</button>
        <button className="btn" aria-pressed={chosen === 'no'} disabled={!waits} onClick={() => answer(item.reqId!, 'no')}>{b.no}</button>
      </div>
      {waits && <span className="cr-hint">Or type what to change below.</span>}
    </div>
  );
}
