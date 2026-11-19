// The builder when the person works in their own Claude Code: nothing of Claude Code is drawn here (PLAN D15, and as Bay
// does it). Hull's tools are installed into Claude Code over MCP; the person talks to it in its own app, and every change it
// makes is checked and lands in this game's history, where Changes shows it. This card says that, connects it, and hands
// over a first message to paste.

import { useEffect, useState, type JSX } from 'react';
import type { CliStatus } from '../../shared/agentApi.ts';
import { Icon } from '../ui/Icon.tsx';
import { writeVia } from './useBuilder.tsx';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function ExternalAgent({ prompt, root }: { prompt: string; root: string }): JSX.Element {
  const [s, setS] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const load = (): void => { window.hullApp?.cliStatus().then((l) => setS(l.find((c) => c.id === 'claude') ?? null), (e) => setError(msg(e))); };
  useEffect(load, []);
  const copy = (id: string, text: string): void => { void navigator.clipboard?.writeText(text); setCopied(id); setTimeout(() => setCopied(''), 1400); };
  const connect = async (): Promise<void> => {
    setBusy(true); setError('');
    try { await window.hullApp!.cliRun('claude', 'connect'); load(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };
  const cd = `cd ${JSON.stringify(root)} && claude`;

  return (
    <div className="ext">
      <div className="ext-card">
        <span className="ext-ic"><Icon name="terminal" size={18} /></span>
        <b>Working in your Claude Code</b>
        <p>Claude Code runs in its own window, signed in with your account. It works on this game through Hull's tools, and each change it makes is checked and shows up in Changes here.</p>
        <ol className="ext-steps">
          <li className={s?.connected ? 'done' : ''}>
            <span><b>Connect it to this game</b><small>{s === null ? 'Checking...' : !s.installed ? 'Claude Code is not installed on this Mac.' : s.connected ? 'Connected to Hull\'s tools.' : 'Adds Hull\'s tools to Claude Code for this folder.'}</small></span>
            {s?.installed && !s.connected && <button className="btn primary" onClick={() => void connect()} disabled={busy}>{busy ? 'Connecting...' : 'Connect'}</button>}
            {s?.connected && <Icon name="check" size={15} />}
          </li>
          <li>
            <span><b>Open it in the game's folder</b><small className="mono">{cd}</small></span>
            <button className="btn" onClick={() => copy('cd', cd)}><Icon name="copy" />{copied === 'cd' ? 'Copied' : 'Copy'}</button>
          </li>
          <li>
            <span><b>Start with this</b><small>{prompt.length > 140 ? `${prompt.slice(0, 140)}...` : prompt}</small></span>
            <button className="btn" onClick={() => copy('p', prompt)}><Icon name="copy" />{copied === 'p' ? 'Copied' : 'Copy'}</button>
          </li>
        </ol>
        {error && <div className="note-err" role="alert">{error}</div>}
        <button className="btn ghost ext-back" onClick={() => writeVia('hull')}>Use Hull's builder here instead</button>
      </div>
    </div>
  );
}
