// One piece as a card: a preview (a sound plays), its name and kind, its tag, and Approve / Change (and Open). Everything and the
// Build screen both draw this card, so the same piece looks the same wherever it shows.

import type { JSX, ReactNode } from 'react';
import type { ContentThumb } from 'hull/dev/protocol';
import { Thumb } from '../content/Thumb.tsx';
import { Icon } from '../ui/Icon.tsx';
import { kindWords, TAG_TEXT, type Card } from './shelves.ts';

export interface PieceCardProps {
  card: Card;
  thumb: ContentThumb | undefined;
  playing: boolean;
  onPlay(): void;
  onApprove(): void;
  onChange(): void;
  /** Shows an Open button. */
  onOpen?: (() => void) | undefined;
  /** Under the buttons: the note bar. */
  extra?: ReactNode;
}

export function PieceCard({ card: c, thumb, playing, onPlay, onApprove, onChange, onOpen, extra }: PieceCardProps): JSX.Element {
  return (
    <article className="cr-card">
      <div className="cr-pv">
        <Thumb kind={c.kind} thumb={thumb} />
        <span className={`cr-tag ${c.tag}`}>{TAG_TEXT[c.tag]}</span>
        {c.kind === 'sound' && (
          <button className="cr-playsnd" onClick={onPlay} disabled={playing} aria-label={`Play ${c.name}`} title="Play"><Icon name="play" size={16} /></button>
        )}
      </div>
      <div className="cr-cb">
        <div className="cr-name"><b>{c.name}</b><span className="cr-k">{kindWords(c.kind)}</span></div>
        {c.note && <p>{c.note}</p>}
        {c.problems > 0 && <p className="cr-warn">{c.problems} problem{c.problems === 1 ? '' : 's'} to fix</p>}
        <div className="cr-ca">
          <button className="btn" onClick={onApprove} disabled={c.tag === 'approved'}>{c.tag === 'approved' ? 'Approved' : 'Approve'}</button>
          <button className="btn" onClick={onChange}>Change</button>
          {onOpen && <button className="btn ghost" onClick={onOpen}>Open</button>}
        </div>
        {extra}
      </div>
    </article>
  );
}
