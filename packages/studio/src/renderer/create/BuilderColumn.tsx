// The builder column at the right of Play, Everything and Changes. SLOT: worker D puts the conversation in it; keep the props.
//   project              the open project
//   attached             the pieces the person pressed Change on, shown as chips above the box
//   onClearAttached()    remove them all
// For now: shows what is attached and a disabled box.

import type { JSX } from 'react';
import type { OpenedProject } from '../../shared/appApi.ts';
import { Icon } from '../ui/Icon.tsx';
import type { AttachedPiece } from './types.ts';

export interface BuilderColumnProps { project: OpenedProject; attached: AttachedPiece[]; onClearAttached(): void }

export function BuilderColumn({ attached, onClearAttached }: BuilderColumnProps): JSX.Element {
  const one = attached.length === 1 ? attached[0]! : null;
  return (
    <aside className="cr-builder" aria-label="Builder">
      <div className="cr-b-head"><b>Builder</b><span className="pill">not connected yet</span></div>
      <div className="cr-b-log">
        <p className="cr-sub">Say what feels wrong and the builder changes it. Pick a piece with Change on its card to talk about that piece.</p>
      </div>
      {attached.length > 0 && (
        <div className="cr-b-attach" aria-label="Attached pieces">
          {attached.map((a) => <span key={a.key} className="chip"><span className="cr-k">{a.kind}</span>{a.name}</span>)}
          <button className="btn ghost" onClick={onClearAttached} aria-label="Remove the attached pieces" title="Remove"><Icon name="close" size={12} /></button>
        </div>
      )}
      <form className="cr-b-form" onSubmit={(e) => e.preventDefault()}>
        <textarea rows={2} disabled aria-label="Your note to the builder" placeholder={one ? `What should change about ${one.name}?` : 'Say what feels wrong'} />
        <button className="btn primary" type="submit" disabled>Send</button>
      </form>
    </aside>
  );
}
