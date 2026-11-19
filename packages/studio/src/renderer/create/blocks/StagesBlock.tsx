// stages: the seven stages and where each one is.

import type { JSX } from 'react';
import { STAGE_LABEL, STAGE_STATUS } from '../buildView.ts';
import type { Item } from '../transcript.ts';

export function StagesBlock({ item }: { item: Extract<Item, { k: 'ui' }> }): JSX.Element | null {
  const b = item.block;
  if (b.kind !== 'stages') return null;
  return (
    <ol className="cr-ui cr-stagelist" aria-label="Build stages">
      {b.stages.map((s) => (
        <li key={s.id} data-status={s.status}>
          <i className={`cr-dot ${s.status}`} aria-hidden="true" />
          <span>{STAGE_LABEL[s.id]}</span>
          <span className="cr-k">{STAGE_STATUS[s.status]}</span>
        </li>
      ))}
    </ol>
  );
}
