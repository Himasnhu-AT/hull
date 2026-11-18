// Adopting an experiment can meet values changed on both sides. Nothing is written until each one has an answer:
// keep what the project has now ("ours") or take the experiment's ("theirs").

import { useState, type JSX } from 'react';
import { Icon } from '../ui/Icon.tsx';
import type { HistoryState } from './useHistory.ts';
import { say, words } from './plain.ts';
import './history.css';

export function AdoptDialog({ h }: { h: HistoryState }): JSX.Element | null {
  const a = h.adopting;
  const [choice, setChoice] = useState<Record<string, 'ours' | 'theirs'>>({});
  if (!a) return null;
  const key = (c: { target: string; path: string }): string => `${c.target}#${c.path}`;
  const done = a.conflicts.every((c) => choice[key(c)]);
  const all = (v: 'ours' | 'theirs'): void => setChoice(Object.fromEntries(a.conflicts.map((c) => [key(c), v])));
  return (
    <div className="hx-scrim" role="presentation">
      <div className="hx-dialog glass" role="dialog" aria-modal="true" aria-label={`Adopt ${a.name}`}>
        <h3>Adopt {a.name}: {a.conflicts.length} value{a.conflicts.length === 1 ? ' was' : 's were'} changed on both sides</h3>
        <p className="hx-sub">Pick which one the project keeps. Nothing is written until every row has an answer.</p>
        <div className="hx-conf">
          {a.conflicts.map((c) => {
            const k = key(c);
            const label = c.kind === 'tunable' ? `${c.target.replace(/^tunables:/, '')} · ${words(c.path)}` : `${c.target} · ${c.path ? words(c.path.split('/').pop() ?? '') : 'whole file'}`;
            return (
              <div className="hx-crow" key={k}>
                <div className="hx-what">{label}<span className="hx-sub"> was {say(c.base)}</span></div>
                <div className="seg" role="radiogroup" aria-label={label}>
                  <button role="radio" aria-checked={choice[k] === 'ours'} className={choice[k] === 'ours' ? 'on' : ''} onClick={() => setChoice((s) => ({ ...s, [k]: 'ours' }))}>Keep mine {say(c.ours)}</button>
                  <button role="radio" aria-checked={choice[k] === 'theirs'} className={choice[k] === 'theirs' ? 'on' : ''} onClick={() => setChoice((s) => ({ ...s, [k]: 'theirs' }))}>Take {a.name} {say(c.theirs)}</button>
                </div>
              </div>
            );
          })}
        </div>
        {a.error && <div className="note-err">{a.error}</div>}
        <div className="hx-acts">
          <button className="btn ghost" onClick={() => all('ours')}>Keep all mine</button>
          <button className="btn ghost" onClick={() => all('theirs')}>Take all of {a.name}</button>
          <span className="hx-grow" />
          <button className="btn" onClick={() => { h.cancelAdopt(); setChoice({}); }}>Cancel</button>
          <button className="btn primary" disabled={!done || a.busy} onClick={() => void h.resolveAdopt(choice).then(() => setChoice({}))}><Icon name="check" />{a.busy ? 'Adopting...' : 'Adopt'}</button>
        </div>
      </div>
    </div>
  );
}

