// change: a fix the builder made, as what changed from -> to on which piece. Keep leaves it; Put back reverts that one change.

import { useState, type JSX } from 'react';
import { putBackById } from '../putBack.ts';
import type { Item } from '../transcript.ts';
import { useBuilder } from '../useBuilder.tsx';

// What the person decided about each card, kept for the session so it reads the same after the column is reopened.
const decided = new Map<string, 'kept' | 'back'>();

export function ChangeBlock({ item }: { item: Extract<Item, { k: 'ui' }> }): JSX.Element | null {
  const { rpc } = useBuilder();
  const b = item.block;
  const [state, setState] = useState<'kept' | 'back' | null>(() => (b.kind === 'change' ? decided.get(b.id) ?? null : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (b.kind !== 'change') return null;
  const decide = (s: 'kept' | 'back'): void => { decided.set(b.id, s); setState(s); };
  const putBack = async (): Promise<void> => {
    if (!b.change) return;
    setBusy(true); setError(null);
    const problem = await putBackById(rpc, b.change);
    setBusy(false);
    if (problem) setError(problem); else decide('back');
  };
  return (
    <div className="cr-ui cr-chg" role="group" aria-label={b.title}>
      <b>{b.title}</b>
      <span className="cr-piece">{b.piece}</span>
      <ul className="cr-kv">
        {b.lines.map((l) => (
          <li key={l.label}><span>{l.label}</span> <s>{l.from}</s> <span aria-hidden="true">{'→'}</span><span className="cr-sr"> to </span> <b>{l.to}</b></li>
        ))}
      </ul>
      {error && <div className="note-err" role="alert">{error}</div>}
      <div className="cr-acts">
        {state === null && <button className="btn primary" onClick={() => decide('kept')}>Keep</button>}
        {state === null && <button className="btn" onClick={() => void putBack()} disabled={busy || !b.change}>{busy ? 'Putting back...' : 'Put back'}</button>}
        {state === 'kept' && <span className="pill ok">kept</span>}
        {state === 'back' && <span className="pill">put back</span>}
      </div>
    </div>
  );
}
