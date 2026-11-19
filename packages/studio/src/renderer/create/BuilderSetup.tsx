// How the builder runs, offered when it cannot start on its own (no key) and from the builder's name in the chat header:
// the person's own Claude Code (signed in with their account, connected to the project), Codex (signed in with ChatGPT, run over
// ACP with its adapter), or Hull's own agent on an API key. Hull reads the programs' own status; it never signs in for Claude (D15).

import { useCallback, useEffect, useState, type JSX } from 'react';
import type { AgentInfo, CliStatus } from '../../shared/agentApi.ts';
import { useSettings } from '../settings/open.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { useBuilder, type BuilderVia } from './useBuilder.tsx';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

interface Choice { via: BuilderVia; icon: IconName; title: string; sub: string; ready: boolean; action: string; why?: string; copy?: string }

export function BuilderSetup({ onDone }: { onDone?: () => void }): JSX.Element {
  const b = useBuilder();
  const settings = useSettings();
  const [clis, setClis] = useState<CliStatus[] | null>(null);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [busy, setBusy] = useState<BuilderVia | ''>('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    const app = window.hullApp;
    if (!app) return;
    app.cliStatus().then(setClis, () => setClis([]));
    app.agentList().then(setAgents, () => setAgents([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const claude = clis?.find((c) => c.id === 'claude');
  const codex = clis?.find((c) => c.id === 'codex');
  const adapter = agents?.find((a) => a.id === 'codex');
  const hull = agents?.find((a) => a.id === 'hull');

  const choices: Choice[] = [
    {
      via: 'claude', icon: 'terminal', title: 'Your Claude Code',
      sub: claude?.signedIn ? `Signed in${claude.via ? ` with ${claude.via}` : ''}. Runs here, in the project, with Hull's tools.` : 'Runs your own claude here, with Hull\'s tools.',
      ready: !!claude?.installed && claude.signedIn !== false, action: claude?.connected === false ? 'Connect and use' : 'Use Claude Code',
      ...(!claude?.installed ? { why: 'Claude Code is not installed.', copy: claude?.install } : claude.signedIn === false ? { why: 'Not signed in: run claude in Terminal once to sign in.' } : {}),
    },
    {
      via: 'codex', icon: 'terminal', title: 'Codex',
      sub: codex?.signedIn ? `Signed in${codex.via ? ` with ${codex.via}` : ''}.` : 'Signed in with your ChatGPT account.',
      ready: !!codex?.signedIn && !!adapter?.installed, action: 'Use Codex',
      ...(!codex?.installed ? { why: 'Codex is not installed.', copy: codex?.install } : !codex.signedIn ? { why: 'Sign in with ChatGPT in Settings first.' } : !adapter?.installed ? { why: 'Hull talks to Codex through its adapter. Install it once:', copy: adapter?.install } : {}),
    },
    {
      via: 'hull', icon: 'key', title: 'Hull\'s builder, on an API key',
      sub: 'Anthropic, or any OpenAI-compatible endpoint. Draws plans, questions and changes as cards.',
      ready: !!hull && !hull.needs, action: hull?.needs ? 'Add a key' : 'Use the key',
    },
  ];

  const pick = async (c: Choice): Promise<void> => {
    setError('');
    if (c.via === 'hull' && !c.ready) { b.openSettings(); return; }
    if (c.via === 'codex' && codex?.installed && !codex.signedIn) { settings.open('codex', load); return; }
    setBusy(c.via);
    try {
      if (c.via === 'claude' && claude?.connected === false) await window.hullApp!.cliRun('claude', 'connect');
      b.setVia(c.via);
      onDone?.();
    } catch (e) { setError(msg(e)); } finally { setBusy(''); }
  };

  return (
    <div className="bs" role="group" aria-label="How the builder runs">
      <div className="bs-h"><b>Who should build this?</b><span>Pick one. You can switch any time from the builder's name.</span></div>
      <ul className="bs-list">
        {choices.map((c, i) => (
          <li key={c.via} className={`bs-opt${b.via === c.via && !b.needs ? ' on' : ''}`} style={{ animationDelay: `${i * 40}ms` }}>
            <span className="bs-ic"><Icon name={c.icon} size={15} /></span>
            <span className="bs-t"><b>{c.title}</b><small>{c.sub}</small>
              {c.why && <small className="bs-why">{c.why}</small>}
              {c.copy && <span className="bs-copy"><code>{c.copy}</code><button className="btn ghost" onClick={() => { void navigator.clipboard?.writeText(c.copy!); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>{copied ? 'Copied' : 'Copy'}</button></span>}
            </span>
            <button className={`btn${c.ready || c.via === 'hull' ? ' primary' : ''}`} disabled={busy !== '' || (!c.ready && c.via !== 'hull' && !(c.via === 'codex' && codex?.installed && !codex.signedIn))} onClick={() => void pick(c)}>
              {busy === c.via ? 'One moment...' : c.via === 'codex' && codex?.installed && !codex.signedIn ? 'Sign in' : c.action}
            </button>
          </li>
        ))}
      </ul>
      {clis === null && <div className="bs-wait">Looking for Claude Code and Codex on this Mac...</div>}
      {error && <div className="note-err" role="alert">{error}</div>}
      <button className="btn ghost bs-again" onClick={load}><Icon name="reload" />Check again</button>
    </div>
  );
}

/** The builder's name in a chat header: which engine runs it, and a way to change it. */
export function ViaButton({ onClick, open }: { onClick(): void; open: boolean }): JSX.Element {
  const { via } = useBuilder();
  const name = via === 'claude' ? 'Claude Code' : via === 'codex' ? 'Codex' : 'Hull builder';
  return <button className={`via${open ? ' on' : ''}`} onClick={onClick} aria-expanded={open} title="Change who builds">{name}<Icon name="chevron" size={11} /></button>;
}
