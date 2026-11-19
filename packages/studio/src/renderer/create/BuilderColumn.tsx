// The builder column at the right of Play, Everything and Changes: the conversation in mode fix, the frozen moment and attached pieces
// as chips above the box, and the box. Notes go with the moment (screenshot, time, what just played) and the pieces they are about.
//   project              the open project
//   attached             the pieces the person pressed Change on, or the Just now chips, shown as chips above the box
//   onClearAttached()    remove them all
//   moment               the frozen moment, or null
//   onClearMoment()      carry on without a moment
//   onRemoveAttached(k)  remove one chip
//   onSent()             a note was sent: the shell clears the chips and the moment

import { useEffect, type JSX } from 'react';
import type { GameMoment } from 'hull/dev/protocol';
import type { OpenedProject } from '../../shared/appApi.ts';
import { Icon } from '../ui/Icon.tsx';
import { NeedsKey } from './BriefScreen.tsx';
import { Composer } from './Composer.tsx';
import { clock } from './recentStrip.ts';
import { TranscriptView } from './TranscriptView.tsx';
import type { AttachedPiece } from './types.ts';
import { useBuilder } from './useBuilder.tsx';

export interface BuilderColumnProps {
  project: OpenedProject; attached: AttachedPiece[]; onClearAttached(): void;
  moment?: GameMoment | null; onClearMoment?: () => void; onRemoveAttached?: (key: string) => void; onSent?: () => void;
}

export function BuilderColumn({ attached, onClearAttached, moment = null, onClearMoment, onRemoveAttached, onSent }: BuilderColumnProps): JSX.Element {
  const b = useBuilder();
  const t = b.lanes.fix;
  const { prepare } = b;
  useEffect(() => { prepare(); }, [prepare]);
  const one = attached.length === 1 ? attached[0]! : null;
  const state = b.needs ? { text: 'needs a key', cls: 'warn' } : t.running || b.starting ? { text: 'working', cls: '' } : { text: 'ready', cls: 'ok' };

  const send = (): void => {
    const text = b.draft.trim();
    if (!text) return;
    const chips = [...(moment ? [`Frozen at ${clock(moment.time)}`] : []), ...attached.map((a) => a.name)];
    void b.send(text, { mode: 'fix', ...(moment ? { moment } : {}), ...(attached.length > 0 ? { about: attached.map((a) => a.key) } : {}), chips });
    b.setDraft('');
    onSent?.();
  };

  return (
    <aside className="cr-builder" aria-label="Builder">
      <div className="cr-b-head">
        <b>Builder</b><span className={`pill ${state.cls}`}>{state.text}</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={b.openSettings} aria-label="Key settings" title="Key settings"><Icon name="sliders" size={14} /></button>
      </div>
      <TranscriptView t={t} showEvents={false} label="Conversation with the builder" className="cr-b-log"
        empty={b.needs ? <NeedsKey text={b.needs} /> : <p className="cr-sub">Say what feels wrong and the builder changes it. Press Something is off (N) to freeze the game first, or pick a piece with Change on its card.</p>} />
      {b.needs && t.items.length > 0 && <div className="cr-b-needs"><NeedsKey text={b.needs} /></div>}
      {(moment || attached.length > 0) && (
        <div className="cr-b-attach" aria-label="What the note is about">
          {moment && <span className="chip"><span className="cr-k">moment</span>Frozen at {clock(moment.time)}<button className="x" onClick={onClearMoment} aria-label="Remove the frozen moment"><Icon name="close" size={10} /></button></span>}
          {attached.map((a) => (
            <span key={a.key} className="chip"><span className="cr-k">{a.kind}</span>{a.name}{onRemoveAttached && <button className="x" onClick={() => onRemoveAttached(a.key)} aria-label={`Remove ${a.name}`}><Icon name="close" size={10} /></button>}</span>
          ))}
          {attached.length > 1 && <button className="btn ghost" onClick={onClearAttached} aria-label="Remove the attached pieces" title="Remove all"><Icon name="close" size={12} /></button>}
        </div>
      )}
      <Composer value={b.draft} onChange={b.setDraft} onSend={send} label="Your note to the builder" nonce={b.draftNonce} busy={t.running} onStop={b.cancel} disabled={b.needs !== null}
        placeholder={moment ? 'What felt wrong here?' : one ? `What should change about ${one.name}?` : 'Say what feels wrong'} />
    </aside>
  );
}
