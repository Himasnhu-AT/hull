// The builder column at the right of Play, Everything and Changes: the conversation in mode fix, the frozen moment and attached pieces
// as chips above the box, and the box. Notes go with the moment (screenshot, time, what just played) and the pieces they are about.
//   project              the open project
//   attached             the pieces the person pressed Change on, or the Just now chips, shown as chips above the box
//   onClearAttached()    remove them all
//   moment               the frozen moment, or null
//   onClearMoment()      carry on without a moment
//   onRemoveAttached(k)  remove one chip
//   onSent()             a note was sent: the shell clears the chips and the moment

import { useEffect, useState, type JSX } from 'react';
import type { GameMoment } from 'hull/dev/protocol';
import type { OpenedProject } from '../../shared/appApi.ts';
import { Icon } from '../ui/Icon.tsx';
import { BuilderSetup, ViaButton } from './BuilderSetup.tsx';
import { ClaudeChat } from './ClaudeChat.tsx';
import { Composer } from './Composer.tsx';
import { clock } from './recentStrip.ts';
import { builderPill } from './builderState.ts';
import { TranscriptView } from './TranscriptView.tsx';
import { waiting } from './transcript.ts';
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
  const [choosing, setChoosing] = useState(false);
  const setup = b.needs !== null || choosing;
  useEffect(() => { prepare(); }, [prepare]);
  const one = attached.length === 1 ? attached[0]! : null;
  const state = builderPill({ needs: b.needs !== null, waiting: waiting(t).length, working: t.running || b.starting });

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
        <ViaButton open={setup} onClick={() => setChoosing((c) => !c)} />
        {!setup && b.via !== 'claude' && <span className={`chat-state ${state.cls}`}><i />{state.text}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={b.openSettings} aria-label="Settings" title="Settings (⌘,)"><Icon name="gear" size={14} /></button>
      </div>
      {setup && <div className="cr-b-setup"><BuilderSetup onDone={() => setChoosing(false)} /></div>}
      {!setup && b.via === 'claude' && <ClaudeChat />}
      {!setup && b.via !== 'claude' && (
        <>
          <TranscriptView t={t} showEvents={false} thinking={t.running && waiting(t).length === 0} label="Conversation with the builder" className="cr-b-log"
            empty={<div className="chat-empty"><b>Say what feels wrong</b><span>Press Something is off (N) to freeze the game first, or pick a piece with Change on its card.</span></div>} />
          {(moment || attached.length > 0) && (
            <div className="cr-b-attach" aria-label="What the note is about">
              {moment && <span className="chip"><span className="cr-k">moment</span>Frozen at {clock(moment.time)}<button className="x" onClick={onClearMoment} aria-label="Remove the frozen moment"><Icon name="close" size={10} /></button></span>}
              {attached.map((a) => (
                <span key={a.key} className="chip"><span className="cr-k">{a.kind}</span>{a.name}{onRemoveAttached && <button className="x" onClick={() => onRemoveAttached(a.key)} aria-label={`Remove ${a.name}`}><Icon name="close" size={10} /></button>}</span>
              ))}
              {attached.length > 1 && <button className="btn ghost" onClick={onClearAttached} aria-label="Remove the attached pieces" title="Remove all"><Icon name="close" size={12} /></button>}
            </div>
          )}
          <div className="cr-b-dock">
            <Composer value={b.draft} onChange={b.setDraft} onSend={send} label="Your note to the builder" nonce={b.draftNonce} busy={t.running} onStop={b.cancel}
              placeholder={moment ? 'What felt wrong here?' : one ? `What should change about ${one.name}?` : 'Say what feels wrong'} />
          </div>
        </>
      )}
    </aside>
  );
}
