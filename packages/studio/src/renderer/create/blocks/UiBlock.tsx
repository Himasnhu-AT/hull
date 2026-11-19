// One renderer per kind of card the builder can send.

import type { JSX } from 'react';
import type { Item } from '../transcript.ts';
import { ApproveBlock } from './ApproveBlock.tsx';
import { AskBlock } from './AskBlock.tsx';
import { BriefBlock } from './BriefBlock.tsx';
import { ChangeBlock } from './ChangeBlock.tsx';
import { ExplainBlock } from './ExplainBlock.tsx';
import { PiecesBlock } from './PiecesBlock.tsx';
import { StagesBlock } from './StagesBlock.tsx';

export function UiBlock({ item }: { item: Extract<Item, { k: 'ui' }> }): JSX.Element | null {
  switch (item.block.kind) {
    case 'ask': return <AskBlock item={item} />;
    case 'approve': return <ApproveBlock item={item} />;
    case 'brief': return <BriefBlock item={item} />;
    case 'stages': return <StagesBlock item={item} />;
    case 'pieces': return <PiecesBlock item={item} />;
    case 'explain': return <ExplainBlock item={item} />;
    case 'change': return <ChangeBlock item={item} />;
  }
}
