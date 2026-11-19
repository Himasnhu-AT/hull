// brief: the game brief section by section. A section being written is marked "writing", one the builder edited since is marked
// "changed". Change fills the composer so the person can say what to change in that section.

import type { JSX } from 'react';
import type { Item } from '../transcript.ts';
import { useBuilder } from '../useBuilder.tsx';

export function BriefBlock({ item }: { item: Extract<Item, { k: 'ui' }> }): JSX.Element | null {
  const { fillDraft } = useBuilder();
  const b = item.block;
  if (b.kind !== 'brief') return null;
  return (
    <section className="cr-ui cr-brief" aria-label="The brief">
      <h3>{b.title || 'Your game'}</h3>
      {b.sections.length === 0 && <p className="cr-sub">The builder is starting to write.</p>}
      {b.sections.map((s) => (
        <div key={s.id} className="cr-bsec" data-status={s.status}>
          <div className="cr-bsec-h">
            <b>{s.title}</b>
            {s.status === 'writing' && <span className="cr-st writing">writing</span>}
            {s.status === 'changed' && <span className="cr-st changed">changed</span>}
            <span style={{ flex: 1 }} />
            {s.status !== 'writing' && <button className="cr-link" onClick={() => fillDraft(`Change ${s.title.toLowerCase()}: `)}>Change</button>}
          </div>
          {s.text && <p className="cr-bsec-t">{s.text}</p>}
        </div>
      ))}
    </section>
  );
}
