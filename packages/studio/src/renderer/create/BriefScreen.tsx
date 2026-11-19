// Step 2, Brief: a chat. The builder asks a few questions (cards the person clicks), writes GAME.md part by part (the brief card
// fills in), and the person asks for changes or approves. When the brief is approved (create.changed says so) the shell moves on.
//   rpc          the project connection (protocol methods and pushes)
//   project      the open project
//   idea         what the person typed in the launcher ('' when the project did not start from an idea)
//   onApproved() called when the brief is approved: the shell moves on to Build

import { useEffect, useRef, useState, type JSX } from 'react';
import type { OpenedProject } from '../../shared/appApi.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { BuilderSetup, ViaButton } from './BuilderSetup.tsx';
import { ExternalAgent } from './ExternalAgent.tsx';
import { Composer } from './Composer.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { builderPill } from './builderState.ts';
import { TranscriptView } from './TranscriptView.tsx';
import { waiting } from './transcript.ts';
import { useBuilder } from './useBuilder.tsx';
import { useCreateState } from './useCreate.ts';

/** `home`: shown on the home page, where the game's name heads the chat and moving on opens the game. */
export interface BriefScreenProps { rpc: RpcClient; project: OpenedProject; idea: string; onApproved(): void; home?: boolean }

/** What Claude Code is asked first when it is the builder: the same job Hull's builder does in mode brief. */
export const claudeBriefPrompt = (idea: string): string =>
  `I am making a game in Hull. Use the hull MCP tools for every change, so each one is checked and kept in the history. First write the brief: ask me a few short questions, then write GAME.md.${idea.trim() ? ` The idea: ${idea.trim()}` : ''}`;

export function BriefScreen({ rpc, project, idea, onApproved, home = false }: BriefScreenProps): JSX.Element {
  const b = useBuilder();
  const create = useCreateState(rpc);
  const [showEvents, setShowEvents] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const t = b.lanes.brief;
  const wasApproved = useRef<boolean | null>(null);
  const { startBrief } = b;

  // The idea goes to the builder once, as soon as the flow state says this brief is not approved yet.
  useEffect(() => { if (idea && create && !create.briefApproved && b.via !== 'claude') startBrief(idea); }, [idea, create, startBrief, b.via]);

  // The idea is kept with the project, so the Idea step can show it after the app was closed and the game reopened.
  useEffect(() => {
    if (idea && create && create.idea.trim() === '') rpc.call('create.set', { patch: { idea, step: 'brief' }, author: 'you' }).catch(() => { /* the idea is only a bookmark */ });
  }, [idea, create, rpc]);

  // Approval seen after this screen opened moves the shell on; one that was already there waits for the person.
  useEffect(() => {
    if (!create) return;
    if (wasApproved.current === null) { wasApproved.current = create.briefApproved; return; }
    if (!wasApproved.current && create.briefApproved) { wasApproved.current = true; onApproved(); }
  }, [create, onApproved]);

  const state = builderPill({ needs: b.needs !== null, waiting: waiting(t).length, working: t.running || b.starting });
  const send = (): void => { const text = b.draft.trim(); if (!text) return; b.setDraft(''); void b.send(text, { mode: 'brief' }); };
  const setup = b.needs !== null || choosing;
  const empty = t.items.length === 0;
  const composer = (
    <Composer value={b.draft} onChange={b.setDraft} onSend={send} label="Your message about the brief" placeholder={empty ? 'Describe the game you want' : 'Ask for a change to the brief'}
      nonce={b.draftNonce} busy={t.running} onStop={b.cancel} autoFocus={empty} footer={<ModelPicker />} />
  );

  return (
    <div className="chat">
      <header className="chat-top">
        {home && <b className="chat-title" title={project.title}>{project.title}</b>}
        <ViaButton open={setup} onClick={() => setChoosing((c) => !c)} />
        {!setup && b.via !== 'claude' && <span className={`chat-state ${state.cls}`}><i />{state.text}</span>}
        <span style={{ flex: 1 }} />
        {b.via !== 'claude' && !setup && <label className="chat-sw"><input type="checkbox" checked={showEvents} onChange={(e) => setShowEvents(e.target.checked)} />Show events</label>}
        {create?.briefApproved ? <button className="btn primary" onClick={onApproved}>Go to Build</button> : <button className="btn ghost" onClick={onApproved} title="Skip the brief and go to Build">{home ? 'Open the game' : 'Skip the brief'}</button>}
      </header>
      {setup && <div className="chat-center"><BuilderSetup onDone={() => setChoosing(false)} /></div>}
      {!setup && b.via === 'claude' && <ExternalAgent root={project.root} prompt={claudeBriefPrompt(idea || create?.idea || '')} />}
      {!setup && b.via !== 'claude' && empty && (
        <div className="chat-hero">
          <h2>{idea ? 'Reading your idea...' : 'What are we making?'}</h2>
          <p>{idea ? 'The builder will ask a few questions, then write the brief.' : 'Say what the game is. The builder asks a few questions, then writes the brief.'}</p>
          {composer}
        </div>
      )}
      {!setup && b.via !== 'claude' && !empty && (
        <>
          <TranscriptView t={t} showEvents={showEvents} thinking={t.running && waiting(t).length === 0} label="Conversation about the brief" className="chat-log" />
          <div className="chat-dock">{composer}<p className="chat-hint">Enter to send, Shift+Enter for a new line.</p></div>
        </>
      )}
    </div>
  );
}
