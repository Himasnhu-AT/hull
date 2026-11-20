// The builder when the person works in their own Claude Code: nothing of Claude Code is drawn here (PLAN D15, and as Bay
// does it). Hull's tools are installed into Claude Code over MCP; "Open Claude Code" starts the person's own claude in a
// Terminal window in the game's folder with a first message. This card then follows the game from the project itself:
// whether Claude Code is calling Hull's tools right now (the app's MCP server says so as each call starts and ends), the
// plan as written to GAME.md, where the flow is (plan, approval, the seven build stages, from create.get), what changed,
// and the next message to send it. Everything shown is read from the project, so it is true whoever made the change.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { BriefDoc, CreateState, HistoryChange, StageId } from 'hull/dev/protocol';
import type { CliStatus } from '../../shared/agentApi.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { Icon } from '../ui/Icon.tsx';
import { authorName, plainLine } from './plainNames.ts';
import { useCreateState } from './useCreate.ts';
import { writeVia } from './useBuilder.tsx';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const who = (by: HistoryChange['by']): string => (typeof by === 'string' && by.startsWith('ai:') ? by.slice(3) : authorName(by));

const STAGE_NAME: Record<StageId, string> = { world: 'The world', actors: 'Characters', animations: 'Animations', rules: 'Rules', sounds: 'Sounds', effects: 'Effects', screens: 'Screens' };
/** Tool names as a person would say what is happening. */
const DOING: Record<string, string> = {
  'brief.write': 'writing the plan', 'brief.read': 'reading the plan', 'create.set': 'recording progress', 'create.get': 'checking progress',
  'config.set': 'changing a setting', 'config.write': 'writing a piece', 'code.write': 'writing code', 'code.edit': 'editing code', 'code.read': 'reading code',
  check: 'checking the game', test: 'running the tests', build: 'building the game', 'game.run': 'playing the game', 'game.moment': 'looking at the game',
  'history.checkpoint': 'saving a point to go back to', 'library.list': 'looking through the pieces', 'docs.read': 'reading Hull\'s docs',
};
const doing = (tool: string): string => DOING[tool] ?? (tool.startsWith('config') ? 'changing a piece' : tool.startsWith('code') ? 'working on the code' : `using ${tool}`);

/** The plan (GAME.md), kept fresh as it changes. */
function useBrief(rpc: RpcClient): BriefDoc | null {
  const [doc, setDoc] = useState<BriefDoc | null>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => { rpc.call('brief.read', {}).then((d) => { if (live) setDoc(d); }, () => {}); };
    const offs = [rpc.onStatus((s) => { if (s === 'open') load(); }), rpc.on('brief.changed', (d) => { if (live) setDoc(d as BriefDoc); })];
    if (rpc.status === 'open') load();
    return () => { live = false; offs.forEach((o) => o()); };
  }, [rpc]);
  return doc;
}

/** The changes made by anyone but the person, newest first. */
function useAgentChanges(rpc: RpcClient): HistoryChange[] {
  const [list, setList] = useState<HistoryChange[]>([]);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      rpc.call('history.list', { limit: 40 }).then((c) => {
        if (live) setList((c as HistoryChange[]).filter((x) => x.kind !== 'start' && authorName(x.by) !== 'You'));
      }, () => {});
    };
    const offs = [rpc.on('history.added', load), rpc.onStatus((s) => { if (s === 'open') load(); })];
    load();
    return () => { live = false; offs.forEach((o) => o()); };
  }, [rpc]);
  return list;
}

/** What an outside agent is doing now: the tool in flight, or the last one for a few seconds after it ends. */
function useLiveCall(): { tool: string; at: number } | null {
  const [now, setNow] = useState<{ tool: string; at: number; open: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => window.hullApp?.onAgentEvent((e) => {
    if (e.type !== 'mcp-call') return;
    if (timer.current) clearTimeout(timer.current);
    setNow((cur) => {
      const open = Math.max(0, (cur?.open ?? 0) + (e.phase === 'start' ? 1 : -1));
      return { tool: e.tool, at: Date.now(), open };
    });
    // Between calls it is still thinking; quiet for 20 s means it is waiting for the person.
    timer.current = setTimeout(() => setNow(null), 20_000);
  }), []);
  return now;
}

/** The message that moves things on from where the game is, for the person to paste into Claude Code. */
function nextMessage(brief: BriefDoc | null, c: CreateState | null, idea: string): { label: string; text: string } | null {
  const done = c?.stages.every((s) => s.status === 'ready');
  if (!brief?.exists) return { label: 'First message', text: firstPrompt(idea) };
  if (!c?.briefApproved && !c?.stages.some((s) => s.status !== 'waiting')) return {
    label: 'When the plan reads right',
    text: 'Approved. Record it with the hull tool create.set (patch: briefApproved true, step build). Then build the game in Hull\'s seven stages in order: world, actors, animations, rules, sounds, effects, screens. For each, set its status to building with create.set, make it with Hull\'s tools, run check, then set it ready with a one-line summary (or failed with the reason).',
  };
  if (!done) return { label: 'If it stopped', text: 'Carry on with the next build stage. Record each stage with create.set (building, then ready or failed) and run check after each.' };
  return null;
}

/** What Claude Code is asked first: the same job Hull's builder does, recorded the same way, so this card can follow it. */
export const firstPrompt = (idea: string): string =>
  `I am making a game in Hull. Use the hull MCP tools for every change, so each one is checked and kept in the history. First the plan: ask me a few short questions, then write GAME.md with brief.write. When I approve it, record that with create.set (patch: briefApproved true, step build) and build in Hull's seven stages, world, actors, animations, rules, sounds, effects, screens: set each to building with create.set, make it, run check, then set it ready with a one-line summary.${idea.trim() ? ` The idea: ${idea.trim()}` : ''}`;

/** GAME.md is Markdown; the card shows it as plain text, without the asterisks and backticks. */
const plainMd = (s: string): string => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|\s)\*(\S.*?)\*(?=\s|$)/g, '$1$2').replace(/`([^`]+)`/g, '$1');

type Row = { key: string; label: string; state: 'done' | 'now' | 'todo' | 'failed'; note?: string | undefined };

export function ExternalAgent({ root, rpc, idea = '', onPlay }: { root: string; rpc: RpcClient; idea?: string; onPlay?: (() => void) | undefined }): JSX.Element {
  const [s, setS] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [showPlan, setShowPlan] = useState<boolean | null>(null);
  const brief = useBrief(rpc);
  const create = useCreateState(rpc);
  const changes = useAgentChanges(rpc);
  const live = useLiveCall();
  const load = (): void => { window.hullApp?.cliStatus().then((l) => setS(l.find((c) => c.id === 'claude') ?? null), (e) => setError(msg(e))); };
  useEffect(load, []);
  const copy = (id: string, text: string): void => { void navigator.clipboard?.writeText(text); setCopied(id); setTimeout(() => setCopied(''), 1400); };
  const open = async (): Promise<void> => {
    setBusy('open'); setError('');
    try {
      if (s && !s.connected) await window.hullApp!.cliRun('claude', 'connect');
      await window.hullApp!.openClaude(firstPrompt(idea || create?.idea || ''));
      load();
    } catch (e) { setError(msg(e)); } finally { setBusy(''); }
  };

  const approved = !!create?.briefApproved || !!create?.stages.some((x) => x.status !== 'waiting');
  const allReady = !!create && create.stages.length > 0 && create.stages.every((x) => x.status === 'ready');
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [
      { key: 'plan', label: 'Plan written', state: brief?.exists ? 'done' : live ? 'now' : 'todo', note: brief?.exists ? `GAME.md · ${brief.sections.length} parts` : undefined },
      { key: 'ok', label: 'Plan approved', state: approved ? 'done' : brief?.exists ? 'now' : 'todo', note: approved ? undefined : brief?.exists ? 'Waiting for you to approve it in Claude Code' : undefined },
    ];
    for (const st of create?.stages ?? []) {
      out.push({ key: st.id, label: STAGE_NAME[st.id], state: st.status === 'ready' ? 'done' : st.status === 'building' ? 'now' : st.status === 'failed' ? 'failed' : 'todo', note: st.status === 'waiting' ? undefined : st.summary });
    }
    return out;
  }, [brief, create, approved, live]);
  // The plan is open while it is being decided, and folds away once it is approved so the progress stays in view.
  const planOpen = showPlan ?? !approved;
  const next = nextMessage(brief, create, idea || create?.idea || '');
  const status = live
    ? { cls: 'busy', text: `Claude Code is ${doing(live.tool)}` }
    : allReady ? { cls: 'ok', text: 'Built. Ready to play' }
    : brief?.exists && !approved ? { cls: 'wait', text: 'Waiting for you in Claude Code' }
    : changes.length > 0 ? { cls: 'wait', text: 'Idle. Waiting for Claude Code' }
    : { cls: '', text: 'Not started yet' };

  return (
    <div className="ext">
      <div className="ext-card">
        <div className="ext-top">
          <span className="ext-ic"><Icon name="terminal" size={18} /></span>
          <div className="ext-t"><b>Your Claude Code</b><span className={`ext-live ${status.cls}`}><i />{status.text}</span></div>
          {s?.installed !== false && <button className={`btn${changes.length ? '' : ' primary'}`} onClick={() => void open()} disabled={busy !== '' || s === null}><Icon name="terminal" />{busy === 'open' ? 'Opening...' : changes.length ? 'Open Claude Code again' : 'Open Claude Code'}</button>}
        </div>
        {s && !s.installed && <div className="st-callout">Claude Code is not installed on this Mac: <code>{s.install}</code></div>}

        <ol className="ext-flow" aria-label="Progress">
          {rows.map((r) => (
            <li key={r.key} className={r.state}>
              <i aria-hidden="true">{r.state === 'done' ? <Icon name="check" size={11} /> : r.state === 'failed' ? '!' : null}</i>
              <span><b>{r.label}</b>{r.note && <small>{r.note}</small>}</span>
              {r.state === 'now' && r.key !== 'ok' && <em>working</em>}
            </li>
          ))}
        </ol>
        {allReady && onPlay && <button className="btn primary lg ext-play" onClick={onPlay}><Icon name="play" />Play the game</button>}

        {brief?.exists && (
          <div className="ext-plan">
            <button className="ext-plan-h" onClick={() => setShowPlan(!planOpen)} aria-expanded={planOpen}><b>The plan</b><span className="cr-k">GAME.md</span><span style={{ flex: 1 }} /><Icon name="chevron" size={11} /></button>
            {planOpen && <div className="ext-plan-b">{brief.sections.map((sec) => <div key={sec.id} className="cr-bsec"><b>{sec.title}</b><p className="cr-bsec-t">{plainMd(sec.text)}</p></div>)}</div>}
          </div>
        )}

        {next && (
          <div className="ext-next">
            <div><b>{next.label}</b><small>Paste this into Claude Code.</small></div>
            <p>{next.text}</p>
            <button className="btn" onClick={() => copy('next', next.text)}><Icon name="copy" />{copied === 'next' ? 'Copied' : 'Copy'}</button>
          </div>
        )}

        {changes.length > 0 && (
          <details className="ext-more">
            <summary>What it changed ({changes.length})</summary>
            <ul className="ext-changes">{changes.slice(0, 12).map((c) => <li key={c.id}><span>{plainLine(c.message || 'A change')}</span><small>{who(c.by)}</small></li>)}</ul>
          </details>
        )}
        <details className="ext-more">
          <summary>Open it yourself instead</summary>
          <div className="ext-row"><code className="mono">{`cd ${JSON.stringify(root)} && claude`}</code><button className="btn ghost" onClick={() => copy('cd', `cd ${JSON.stringify(root)} && claude`)}>{copied === 'cd' ? 'Copied' : 'Copy'}</button></div>
        </details>
        {error && <div className="note-err" role="alert">{error}</div>}
        <button className="btn ghost ext-back" onClick={() => writeVia('hull')}>Use Hull's builder here instead</button>
      </div>
    </div>
  );
}
