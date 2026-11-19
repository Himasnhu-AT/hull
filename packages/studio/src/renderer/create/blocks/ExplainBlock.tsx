// explain: a drawing of something the person cannot see, with a sentence on what was decided, in the conversation.

import type { JSX } from 'react';
import { ExplainCard } from '../ExplainCard.tsx';
import type { Item } from '../transcript.ts';

export function ExplainBlock({ item }: { item: Extract<Item, { k: 'ui' }> }): JSX.Element | null {
  const b = item.block;
  if (b.kind !== 'explain') return null;
  return <div className="cr-ui cr-ui-flush"><ExplainCard doc={b.doc} compact /></div>;
}
