// ask: a question with a few answers as buttons. The builder waits; typing in the composer answers in words instead.

import type { JSX } from 'react';
import type { Item } from '../transcript.ts';
import { useBuilder } from '../useBuilder.tsx';

export function AskBlock({ item }: { item: Extract<Item, { k: 'ui' }> }): JSX.Element | null {
  const { answer } = useBuilder();
  const b = item.block;
  if (b.kind !== 'ask') return null;
  const waits = item.reqId !== undefined && item.answer === undefined && b.answer === undefined;
  const chosen = item.answer ? item.answer.name : b.answer;
  return (
    <div className="cr-ui" role="group" aria-label={b.question}>
      <b>{b.question}</b>
      <div className="cr-opts">
        {b.options.map((o, i) => (
          <button key={o} className="btn" aria-pressed={chosen === o} disabled={!waits} onClick={() => answer(item.reqId!, String(i))}>{o}</button>
        ))}
      </div>
      {waits && <span className="cr-hint">Or type your own answer below.</span>}
      {item.answer?.optionId === null && <span className="cr-hint">You answered in your own words.</span>}
    </div>
  );
}
