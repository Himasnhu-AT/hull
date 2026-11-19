// The builder when the person works in their own Claude Code: nothing of Claude Code is drawn here (PLAN D15, and as Bay
// does it). Hull's tools are installed into Claude Code over MCP; "Open Claude Code" starts the person's own claude in a
// Terminal window in the game's folder with a first message, and the card then shows, live, each change it makes (they come
// through Hull's tools, so they are checked and in the history).

import { useEffect, useRef, useState, type JSX } from 'react';
import type { HistoryChange } from 'hull/dev/protocol';
import type { CliStatus } from '../../shared/agentApi.ts';
import type { RpcClient } from '../lib/rpc.ts';
import { Icon } from '../ui/Icon.tsx';
import { authorName, plainLine } from './plainNames.ts';
import { writeVia } from './useBuilder.tsx';

/** "ai:Claude Code" -> "Claude Code"; the rest as the history names them. */
const who = (by: HistoryChange['by']): string => (typeof by === 'string' && by.startsWith('ai:') ? by.slice(3) : authorName(by));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** The changes made since `since` by anyone but the person, newest first. */
function useLiveChanges(rpc: RpcClient): HistoryChange[] {
  const [list, setList] = useState<HistoryChange[]>([]);
  const since = useRef(new Date().toISOString());
  useEffect(() => {
    let live = true;
    const load = (): void => {
      rpc.call('history.list', { limit: 40 }).then((c) => {
        if (!live) return;
        setList((c as HistoryChange[]).filter((x) => x.at >= since.current && x.kind !== 'start' && authorName(x.by) !== 'You'));
      }, () => {});
    };
    const offs = [rpc.on('history.added', load), rpc.onStatus((s) => { if (s === 'open') load(); })];
    load();
    return () => { live = false; offs.forEach((o) => o()); };
  }, [rpc]);
  return list;
}

export function ExternalAgent({ prompt, root, rpc }: { prompt: string; root: string; rpc: RpcClient }): JSX.Element {
  const [s, setS] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [opened, setOpened] = useState(false);
  const changes = useLiveChanges(rpc);
  const load = (): void => { window.hullApp?.cliStatus().then((l) => setS(l.find((c) => c.id === 'claude') ?? null), (e) => setError(msg(e))); };
  useEffect(load, []);
  const copy = (id: string, text: string): void => { void navigator.clipboard?.writeText(text); setCopied(id); setTimeout(() => setCopied(''), 1400); };
  const act = async (id: string, f: () => Promise<unknown>): Promise<void> => {
    setBusy(id); setError('');
    try { await f(); } catch (e) { setError(msg(e)); } finally { setBusy(''); }
  };
  const open = (): Promise<void> => act('open', async () => {
    if (s && !s.connected) await window.hullApp!.cliRun('claude', 'connect');
    await window.hullApp!.openClaude(prompt);
    setOpened(true); load();
  });
  const cd = `cd ${JSON.stringify(root)} && claude`;

  return (
    <div className="ext">
      <div className="ext-card">
        <span className="ext-ic"><Icon name="terminal" size={18} /></span>
        <b>Working in your Claude Code</b>
        <p>Claude Code opens in its own Terminal window, signed in with your account, and works on this game through Hull's tools. Talk to it there; what it changes shows up here.</p>
        {s && !s.installed ? (
          <div className="st-callout">Claude Code is not installed on this Mac: <code>{s.install}</code></div>
        ) : (
          <div className="ext-go">
            <button className="btn primary lg" onClick={() => void open()} disabled={busy !== '' || s === null}>
              <Icon name="terminal" />{busy === 'open' ? 'Opening...' : opened ? 'Open another Claude Code' : 'Open Claude Code'}
            </button>
            <small>{s === null ? 'Checking Claude Code...' : s.connected ? 'Connected to this game. Opens with the first message already sent.' : 'Connects it to this game first, then opens it with the first message.'}</small>
          </div>
        )}
        <div className="ext-feed" aria-live="polite">
          <div className="ext-fh"><b>What it changed</b>{(opened || changes.length > 0) && <span className={changes.length ? 'ok' : 'wait'}><i />{changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'Waiting for Claude Code...'}</span>}</div>
          {changes.length === 0
            ? <p className="ext-none">{opened ? 'Answer its questions in Terminal. Each change it makes appears here.' : 'Nothing yet.'}</p>
            : <ul>{changes.slice(0, 8).map((c) => <li key={c.id}><span>{plainLine(c.message || 'A change')}</span><small>{who(c.by)}</small></li>)}</ul>}
        </div>
        <details className="ext-more">
          <summary>Open it yourself instead</summary>
          <div className="ext-row"><code className="mono">{cd}</code><button className="btn ghost" onClick={() => copy('cd', cd)}>{copied === 'cd' ? 'Copied' : 'Copy'}</button></div>
          <div className="ext-row"><span>{prompt.length > 160 ? `${prompt.slice(0, 160)}...` : prompt}</span><button className="btn ghost" onClick={() => copy('p', prompt)}>{copied === 'p' ? 'Copied' : 'Copy'}</button></div>
        </details>
        {error && <div className="note-err" role="alert">{error}</div>}
        <button className="btn ghost ext-back" onClick={() => writeVia('hull')}>Use Hull's builder here instead</button>
      </div>
    </div>
  );
}
