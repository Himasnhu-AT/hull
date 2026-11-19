// The builder: one session for the open project, shared by the Brief chat, the Build screen and the column at the right of Play.
// It owns the session (agentEnsure), the events, the prompts and the answers, and keeps three transcripts, one per kind of run
// (brief, build, fix), so each screen shows its own conversation. The model is editor/AgentPanel.tsx; the data is transcript.ts.

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type JSX, type ReactNode } from 'react';
import type { AgentMode, StageId } from 'hull/dev/protocol';
import type { PromptOptions } from '../../shared/agentApi.ts';
import type { OpenedProject } from '../../shared/appApi.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { useSettings } from '../settings/open.tsx';
import { emptyTranscript, reduce, waiting, type Transcript, type TranscriptEvent } from './transcript.ts';
import { usePieces, type Pieces } from './usePieces.ts';

type Lanes = Record<AgentMode, Transcript>;
const initial = (): Lanes => ({ brief: emptyTranscript(), build: emptyTranscript(), fix: emptyTranscript() });

export interface SendOptions extends PromptOptions { /** Small chips shown on the note in the conversation (the moment, the pieces). */ chips?: string[] }

export interface Builder {
  rpc: RpcClient;
  project: OpenedProject;
  lanes: Lanes;
  /** Something the builder needs before it can start (a key), else null. */
  needs: string | null;
  starting: boolean;
  /** A run is going, in any lane. */
  running: boolean;
  pieces: Pieces;
  /** Sends a note. While a run goes it waits for the run to end; a card that waits is cancelled first, so typing replaces clicking. */
  send(text: string, o?: SendOptions): Promise<void>;
  /** Answers a card that waits: the option id, or null to answer in words instead. */
  answer(reqId: string, optionId: string | null): void;
  cancel(): void;
  /** Sends the idea in mode brief, once per project. */
  startBrief(idea: string): void;
  /** Starts mode build for every stage, once per project. */
  startBuild(): void;
  retryStage(stage: StageId): void;
  /** Starts the builder if it is not running, so a missing key shows before the person types. */
  prepare(): void;
  openSettings(): void;
  /** Who does the work: Hull's own agent (an API key), Codex over ACP (its own ChatGPT sign-in), or the person's own Claude Code in a terminal. */
  via: BuilderVia;
  setVia(v: BuilderVia): void;
  /** The composer's text, which a card's Change link can fill. */
  draft: string;
  setDraft(s: string): void;
  fillDraft(s: string): void;
  draftNonce: number;
}

export type BuilderVia = 'hull' | 'codex' | 'claude';
const VIA_KEY = 'hull.builderVia';
const readVia = (): BuilderVia => { try { const v = localStorage.getItem(VIA_KEY); return v === 'codex' || v === 'claude' ? v : 'hull'; } catch { return 'hull'; } };

const Ctx = createContext<Builder | null>(null);
export function useBuilder(): Builder {
  const b = useContext(Ctx);
  if (!b) throw new Error('useBuilder needs a BuilderProvider above it.');
  return b;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function BuilderProvider({ rpc, project, children }: { rpc: RpcClient; project: OpenedProject; children: ReactNode }): JSX.Element {
  const [lanes, dispatch] = useReducer((s: Lanes, a: { lane: AgentMode; e: TranscriptEvent }): Lanes => ({ ...s, [a.lane]: reduce(s[a.lane], a.e) }), undefined, initial);
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;
  const sid = useRef<string | null>(null);
  const ensuring = useRef<Promise<string | null> | null>(null);
  const runLane = useRef<AgentMode>('fix');
  const queue = useRef<{ text: string; o: SendOptions } | null>(null);
  const started = useRef({ brief: false, build: false });
  const pending = useRef<(() => void) | null>(null);
  const [needs, setNeeds] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [via, setViaState] = useState<BuilderVia>(readVia);
  const viaRef = useRef(via);
  viaRef.current = via;
  const settings = useSettings();
  const [draft, setDraft] = useState('');
  const [draftNonce, setDraftNonce] = useState(0);
  const pieces = usePieces(rpc, project);
  const running = lanes.brief.running || lanes.build.running || lanes.fix.running;

  useEffect(() => {
    const app = window.hullApp;
    if (!app) return;
    return app.onAgentEvent((e) => {
      if (!('sid' in e) || e.sid !== sid.current) return;
      if (e.type === 'status' && (e.state === 'closed' || e.state === 'error')) sid.current = null;
      dispatch({ lane: runLane.current, e });
    });
  }, []);

  const ensure = useCallback(async (): Promise<string | null> => {
    if (sid.current) return sid.current;
    if (ensuring.current) return ensuring.current;
    const app = window.hullApp;
    if (!app) { setNeeds('The builder needs the Hull app.'); return null; }
    setStarting(true);
    ensuring.current = (async () => {
      try {
        // Claude Code runs in its own terminal (PLAN D15): there is no session here to start.
        if (viaRef.current === 'claude') { setNeeds(null); return null; }
        if (viaRef.current === 'codex') { const id = await app.agentStart('codex'); setNeeds(null); sid.current = id; return id; }
        const r = await app.agentEnsure();
        if ('needs' in r) { setNeeds(r.needs); return null; }
        setNeeds(null); sid.current = r.sid;
        return r.sid;
      } catch (e) {
        dispatch({ lane: runLane.current, e: { type: 'status', sid: '', state: 'error', message: messageOf(e) } });
        return null;
      } finally { setStarting(false); ensuring.current = null; }
    })();
    return ensuring.current;
  }, []);

  const doSend = useCallback(async (text: string, o: SendOptions): Promise<boolean> => {
    const lane: AgentMode = o.mode ?? 'fix';
    const id = await ensure();
    if (!id) return false;
    runLane.current = lane;
    const { chips, ...po } = o;
    dispatch({ lane, e: { type: 'sent', text, ...(chips ? { chips } : {}) } });
    try { await window.hullApp!.agentPrompt(id, text, po); } catch (e) { dispatch({ lane, e: { type: 'status', sid: id, state: 'error', message: messageOf(e) } }); }
    return true;
  }, [ensure]);

  const answer = useCallback((reqId: string, optionId: string | null): void => {
    const id = sid.current;
    if (id) void window.hullApp?.agentAnswer(id, reqId, optionId);
  }, []);

  const send = useCallback(async (text: string, o: SendOptions = {}): Promise<void> => {
    const cur = lanesRef.current;
    if (cur.brief.running || cur.build.running || cur.fix.running) {
      queue.current = { text, o };
      for (const w of [...waiting(cur.brief), ...waiting(cur.build), ...waiting(cur.fix)]) answer(w.reqId!, null);
      return;
    }
    await doSend(text, o);
  }, [answer, doSend]);

  // A note typed while a run goes is sent when the run ends.
  useEffect(() => {
    if (running || !queue.current) return;
    const q = queue.current; queue.current = null;
    void doSend(q.text, q.o);
  }, [running, doSend]);

  const cancel = useCallback((): void => {
    queue.current = null;
    const id = sid.current;
    if (id) void window.hullApp?.agentCancel(id);
  }, []);

  const startBrief = useCallback((idea: string): void => {
    if (started.current.brief) return;
    started.current.brief = true;
    const run = (): void => { void send(idea, { mode: 'brief' }).then(() => { if (!sid.current) started.current.brief = false; }); };
    pending.current = () => { started.current.brief = true; run(); };
    run();
  }, [send]);
  const startBuild = useCallback((): void => {
    if (started.current.build) return;
    started.current.build = true;
    const run = (): void => { void send('Build the game from the approved brief.', { mode: 'build' }).then(() => { if (!sid.current) started.current.build = false; }); };
    pending.current = () => { started.current.build = true; run(); };
    run();
  }, [send]);
  const retryStage = useCallback((stage: StageId): void => { void send(`Try the ${stage} stage again.`, { mode: 'build', stage }); }, [send]);

  const fillDraft = useCallback((s: string): void => { setDraft(s); setDraftNonce((n) => n + 1); }, []);
  const saved = useCallback((): void => {
    // The saved key reaches the builder when it starts again, so the old session is let go and the start that waited is tried again.
    sid.current = null; setNeeds(null);
    const p = pending.current; pending.current = null;
    if (p) p(); else void ensure();
  }, [ensure]);

  const setVia = useCallback((v: BuilderVia): void => {
    try { localStorage.setItem(VIA_KEY, v); } catch { /* not remembered */ }
    const old = sid.current;
    sid.current = null; viaRef.current = v; setViaState(v); setNeeds(null);
    if (old) void window.hullApp?.agentStop(old);
    if (v !== 'claude') { const p = pending.current; pending.current = null; if (p) p(); else void ensure(); }
  }, [ensure]);

  const value = useMemo<Builder>(() => ({
    rpc, project, lanes, needs, starting, running, pieces, send, answer, cancel, startBrief, startBuild, retryStage, prepare: () => { void ensure(); }, openSettings: () => settings.open('builder', saved), via, setVia, draft, setDraft, fillDraft, draftNonce,
  }), [rpc, project, lanes, needs, starting, running, pieces, send, answer, cancel, startBrief, startBuild, retryStage, draft, fillDraft, draftNonce, ensure, settings, saved, via, setVia]);

  return (
    <Ctx.Provider value={value}>
      {children}
    </Ctx.Provider>
  );
}
