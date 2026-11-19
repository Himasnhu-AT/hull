// Step 2, Brief: a chat. The builder asks a few questions (cards the person clicks), writes GAME.md part by part (the brief card
// fills in), and the person asks for changes or approves. When the brief is approved (create.changed says so) the shell moves on.
//   rpc          the project connection (protocol methods and pushes)
//   project      the open project
//   idea         what the person typed in the launcher ('' when the project did not start from an idea)
//   onApproved() called when the brief is approved: the shell moves on to Build

import { useEffect, useRef, useState, type JSX } from 'react';
import type { OpenedProject } from '../../shared/appApi.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { Composer } from './Composer.tsx';
import { builderPill } from './builderState.ts';
import { TranscriptView } from './TranscriptView.tsx';
import { waiting } from './transcript.ts';
import { useBuilder } from './useBuilder.tsx';
import { useCreateState } from './useCreate.ts';

export interface BriefScreenProps { rpc: RpcClient; project: OpenedProject; idea: string; onApproved(): void }

export function NeedsKey({ text }: { text: string }): JSX.Element {
  const { openSettings } = useBuilder();
  return (
    <div className="cr-ui cr-needs" role="status">
      <b>The builder needs a key</b>
      <p className="cr-sub">{text}</p>
      <div className="cr-opts"><button className="btn primary" onClick={openSettings}>Add a key</button></div>
    </div>
  );
}

export function BriefScreen({ rpc, idea, onApproved }: BriefScreenProps): JSX.Element {
  const b = useBuilder();
  const create = useCreateState(rpc);
  const [showEvents, setShowEvents] = useState(false);
  const t = b.lanes.brief;
  const wasApproved = useRef<boolean | null>(null);
  const { startBrief } = b;

  // The idea goes to the builder once, as soon as the flow state says this brief is not approved yet.
  useEffect(() => { if (idea && create && !create.briefApproved) startBrief(idea); }, [idea, create, startBrief]);

  // Approval seen after this screen opened moves the shell on; one that was already there waits for the person.
  useEffect(() => {
    if (!create) return;
    if (wasApproved.current === null) { wasApproved.current = create.briefApproved; return; }
    if (!wasApproved.current && create.briefApproved) { wasApproved.current = true; onApproved(); }
  }, [create, onApproved]);

  const state = builderPill({ needs: b.needs !== null, waiting: waiting(t).length, working: t.running || b.starting });
  const send = (): void => { const text = b.draft.trim(); if (!text) return; b.setDraft(''); void b.send(text, { mode: 'brief' }); };

  return (
    <div className="cr-chat">
      <div className="cr-chat-top">
        <b>Brief</b><span className={`pill ${state.cls}`}>{state.text}</span>
        <span style={{ flex: 1 }} />
        <label className="cr-sw"><input type="checkbox" checked={showEvents} onChange={(e) => setShowEvents(e.target.checked)} /> Show what the builder sends</label>
        {create?.briefApproved ? <button className="btn primary" onClick={onApproved}>Go to Build</button> : <button className="btn" onClick={onApproved} title="Skip the brief and go to Build">Skip the brief</button>}
      </div>
      <TranscriptView t={t} showEvents={showEvents} label="Conversation about the brief" className="cr-chat-log"
        empty={b.needs ? null : <p className="cr-sub">{idea ? 'The builder is reading your idea...' : 'Tell the builder what the game is and it will write the brief.'}</p>} />
      {b.needs && <div className="cr-chat-needs"><NeedsKey text={b.needs} /></div>}
      <Composer value={b.draft} onChange={b.setDraft} onSend={send} label="Your message about the brief" placeholder={t.items.length === 0 ? 'Describe the game' : 'Ask for a change to the brief'}
        nonce={b.draftNonce} busy={t.running} onStop={b.cancel} disabled={b.needs !== null} />
    </div>
  );
}
