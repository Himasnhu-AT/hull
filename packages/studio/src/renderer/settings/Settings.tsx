// Settings: the builder's keys, the person's own Claude Code and Codex (signed in by those programs, connected to this project
// over MCP), and the MCP address for any other client. A sheet over the app, like a Mac's settings window: Escape closes it.
// Keys go to the main process and are never shown again; sign-in happens in the programs' own login, in a terminal here.

import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { AgentInfo, AgentSettings, CliAction, CliId, CliStatus, KeyProvider, TermProgram } from '../../shared/agentApi.ts';
import type { HullApp, OpenedProject } from '../../shared/appApi.ts';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { LoginTerminal } from './LoginTerminal.tsx';
import { mcpLines } from './mcpLines.ts';
import type { SettingsSection } from './open.tsx';
import './settings.css';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const SECTIONS: { id: SettingsSection; label: string; icon: IconName; hint: string }[] = [
  { id: 'builder', label: 'Builder', icon: 'key', hint: 'Model and API keys' },
  { id: 'claude', label: 'Claude Code', icon: 'terminal', hint: 'Connect your own' },
  { id: 'codex', label: 'Codex', icon: 'terminal', hint: 'Sign in with ChatGPT' },
  { id: 'mcp', label: 'MCP', icon: 'plug', hint: 'Any other client' },
];

export interface SettingsProps {
  app: HullApp;
  project: OpenedProject | null;
  section?: SettingsSection | undefined;
  onClose(): void;
  /** A key was saved for the provider in use. */
  onKeysSaved?: (() => void) | undefined;
}

export function Settings({ app, project, section, onClose, onKeysSaved }: SettingsProps): JSX.Element {
  const [sec, setSec] = useState<SettingsSection>(section ?? 'builder');
  const [clis, setClis] = useState<CliStatus[] | null>(null);
  const [cliError, setCliError] = useState('');
  const box = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => { app.cliStatus().then((c) => { setClis(c); setCliError(''); }, (e) => setCliError(msg(e))); }, [app]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => {
    // Escape belongs to a terminal while it has focus (a sign-in may ask for it).
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest?.('.st-term')) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const cli = (id: CliId): CliStatus | null => clis?.find((c) => c.id === id) ?? null;

  return (
    <div className="st-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="st" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1} ref={box}>
        <nav className="st-side" aria-label="Settings sections">
          <h2>Settings</h2>
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button className={sec === s.id ? 'on' : ''} aria-current={sec === s.id ? 'page' : undefined} onClick={() => setSec(s.id)}>
                  <span className="st-ic"><Icon name={s.icon} size={14} /></span>
                  <span className="st-nl"><b>{s.label}</b><small>{s.hint}</small></span>
                  {(s.id === 'claude' || s.id === 'codex') && <Dot s={cli(s.id)} />}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <section className="st-main">
          <button className="btn ghost st-x" onClick={onClose} aria-label="Close settings" title="Close (Esc)"><Icon name="close" /></button>
          {sec === 'builder' && <BuilderKeys app={app} onKeysSaved={onKeysSaved} />}
          {(sec === 'claude' || sec === 'codex') && <CliPane key={sec} app={app} id={sec} status={cli(sec)} error={cliError} project={project} refresh={refresh} />}
          {sec === 'mcp' && <McpPane project={project} />}
        </section>
      </div>
    </div>
  );
}

/** Green when signed in and connected, amber when one is missing, nothing while unknown. */
function Dot({ s }: { s: CliStatus | null }): JSX.Element | null {
  if (!s || !s.installed) return null;
  const ok = s.signedIn === true && s.connected !== false;
  return <i className={`st-dot ${ok ? 'ok' : 'warn'}`} aria-label={ok ? 'ready' : 'needs setup'} />;
}

function Group({ title, children, foot }: { title?: string; children: ReactNode; foot?: ReactNode }): JSX.Element {
  return (
    <div className="st-group">
      {title && <h4>{title}</h4>}
      <div className="st-list">{children}</div>
      {foot && <p className="st-foot">{foot}</p>}
    </div>
  );
}

function Row({ label, sub, children }: { label: ReactNode; sub?: ReactNode; children?: ReactNode }): JSX.Element {
  return (
    <div className="st-row">
      <div className="st-rl"><span>{label}</span>{sub && <small>{sub}</small>}</div>
      {children && <div className="st-rc">{children}</div>}
    </div>
  );
}

function useCopy(): [string, (id: string, text: string) => void] {
  const [copied, setCopied] = useState('');
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return [copied, (id, text) => { void navigator.clipboard?.writeText(text); setCopied(id); if (t.current) clearTimeout(t.current); t.current = setTimeout(() => setCopied(''), 1400); }];
}

// ---------- builder: model and keys ----------

const PROVIDER_NAME: Record<KeyProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI-compatible' };

function BuilderKeys({ app, onKeysSaved }: { app: HullApp; onKeysSaved?: (() => void) | undefined }): JSX.Element {
  const [cur, setCur] = useState<AgentSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [draft, setDraft] = useState<Record<KeyProvider, string>>({ anthropic: '', openai: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    app.agentSettings().then((s) => { setCur(s); setBaseUrl(s.baseUrl ?? ''); setModel(s.model ?? ''); }, (e) => setError(msg(e)));
  }, [app]);

  const env = cur?.source === 'environment';
  const save = async (what: string, patch: { provider?: KeyProvider; apiKey?: string; keyFor?: KeyProvider; clearKey?: KeyProvider }): Promise<void> => {
    if (!cur) return;
    setBusy(what); setError(''); setNote('');
    try {
      const provider = patch.provider ?? cur.provider;
      const next = await app.setAgentSettings({
        provider, ...(patch.apiKey ? { apiKey: patch.apiKey, keyFor: patch.keyFor ?? provider } : {}), ...(patch.clearKey ? { clearKey: patch.clearKey } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}),
      });
      setCur(next);
      if (patch.apiKey) { setDraft((d) => ({ ...d, [patch.keyFor ?? provider]: '' })); setNote(`${PROVIDER_NAME[patch.keyFor ?? provider]} key saved.`); }
      else if (patch.clearKey) setNote(`${PROVIDER_NAME[patch.clearKey]} key removed.`);
      else setNote('Saved.');
      if (next.hasKey) onKeysSaved?.();
    } catch (e) { setError(msg(e)); } finally { setBusy(''); }
  };

  const keyRow = (p: KeyProvider, placeholder: string): JSX.Element => {
    const has = cur?.keys?.[p] === true;
    return (
      <Row label="API key" sub={has ? 'Saved in your keychain' : 'Not set'}>
        <form className="st-keyf" onSubmit={(e) => { e.preventDefault(); if (draft[p].trim()) void save(`key-${p}`, { apiKey: draft[p].trim(), keyFor: p }); }}>
          <input className="field-in" type="password" autoComplete="off" spellCheck={false} aria-label={`${PROVIDER_NAME[p]} API key`} value={draft[p]} placeholder={has ? 'Replace the saved key' : placeholder} onChange={(e) => setDraft((d) => ({ ...d, [p]: e.target.value }))} disabled={env} />
          <button className="btn" type="submit" disabled={env || !draft[p].trim() || busy !== ''}>{busy === `key-${p}` ? 'Saving...' : 'Save'}</button>
          {has && <button className="btn ghost" type="button" onClick={() => void save(`clear-${p}`, { clearKey: p })} disabled={busy !== ''}>Remove</button>}
        </form>
      </Row>
    );
  };

  return (
    <div className="st-pane">
      <header className="st-h"><h3>Builder</h3><p>Hull's own builder runs on your API key. Keys are encrypted by your Mac's keychain and handed to the builder when it starts; Hull never shows them again or writes them to a log.</p></header>
      {cur === null && !error && <div className="skeleton" />}
      {env && <div className="st-callout">In this window the environment decides: set <code>ANTHROPIC_API_KEY</code>, or <code>HULL_AGENT_BASE_URL</code> and <code>HULL_AGENT_API_KEY</code>, before starting Hull. {cur?.hasKey ? 'A key is set.' : 'No key is set.'}</div>}
      {cur !== null && (
        <>
          <Group title="Provider" foot="The builder uses one provider at a time. Each keeps its own key, so you can switch back and forth.">
            <Row label="Use">
              <div className="seg" role="radiogroup" aria-label="Provider">
                {(['anthropic', 'openai'] as KeyProvider[]).map((p) => (
                  <button key={p} role="radio" aria-checked={cur.provider === p} className={cur.provider === p ? 'on' : ''} disabled={env || busy !== ''} onClick={() => { if (cur.provider !== p) void save('provider', { provider: p }); }}>{PROVIDER_NAME[p]}</button>
                ))}
              </div>
            </Row>
            <Row label="Model" sub="Leave empty for the provider's default">
              <input className="field-in st-in" value={model} spellCheck={false} placeholder={cur.provider === 'anthropic' ? 'Default Claude model' : 'Default model of the endpoint'} onChange={(e) => setModel(e.target.value)} onBlur={() => { if ((cur.model ?? '') !== model.trim()) void save('model', {}); }} disabled={env} />
            </Row>
          </Group>
          <Group title="Anthropic">{keyRow('anthropic', 'sk-ant-...')}</Group>
          <Group title="OpenAI-compatible" foot="OpenAI, OpenRouter, a local server, or Marl's gateway: anything that speaks the OpenAI chat API.">
            {keyRow('openai', 'Paste your key')}
            <Row label="Endpoint">
              <input className="field-in st-in" value={baseUrl} spellCheck={false} placeholder="https://api.openai.com/v1" onChange={(e) => setBaseUrl(e.target.value)} onBlur={() => { if ((cur.baseUrl ?? '') !== baseUrl.trim()) void save('url', {}); }} disabled={env} />
            </Row>
          </Group>
        </>
      )}
      <div className="st-status" role="status">{note}</div>
      {error && <div className="note-err" role="alert">{error}</div>}
    </div>
  );
}

// ---------- Claude Code and Codex ----------

// Claude Code has no sign-in here: Hull never offers claude.ai login or handles Claude accounts (PLAN D15). It only shows what
// Claude Code says about itself; the person signs in inside Claude Code.
const CLI_COPY: Record<CliId, { lead: string; signIn: string | null; login: TermProgram | null; how: string }> = {
  claude: {
    lead: 'Your own Claude Code, signed in with your own account. Connect it and it works on the open project through Hull\'s tools, with every change checked and kept in the history under its name.',
    signIn: null, login: null,
    how: 'Hull does not sign you in to Claude or touch your Claude account. If Claude Code is not signed in, run claude in Terminal: it asks you to sign in the first time.',
  },
  codex: {
    lead: 'OpenAI\'s Codex, signed in with your ChatGPT account or an OpenAI key. Connect it and it works on the open project through Hull\'s tools.',
    signIn: 'Sign in with ChatGPT', login: 'codex-login',
    how: 'Signing in runs Codex\'s own login (codex login), which opens ChatGPT in your browser. Hull never sees your password or token.',
  },
};

function CliPane({ app, id, status, error, project, refresh }: { app: HullApp; id: CliId; status: CliStatus | null; error: string; project: OpenedProject | null; refresh(): void }): JSX.Element {
  const c = CLI_COPY[id];
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState<CliAction | ''>('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [adapter, setAdapter] = useState<AgentInfo | null>(null);
  const [copied, copy] = useCopy();

  // Codex inside Hull's own agent panel needs its ACP adapter as well; Claude Code runs in a terminal and needs nothing more.
  useEffect(() => { if (id === 'codex') app.agentList().then((l) => setAdapter(l.find((a) => a.id === 'codex') ?? null), () => {}); }, [app, id]);

  const act = async (a: CliAction): Promise<void> => {
    setBusy(a); setErr(''); setNote('');
    try { setNote(await app.cliRun(id, a)); refresh(); } catch (e) { setErr(msg(e)); } finally { setBusy(''); }
  };

  const s = status;
  return (
    <div className="st-pane">
      <header className="st-h"><h3>{id === 'claude' ? 'Claude Code' : 'Codex'}</h3><p>{c.lead}</p></header>
      {error && <div className="note-err" role="alert">{error}</div>}
      {!s && !error && <div className="skeleton" />}
      {s && !s.installed && (
        <Group title="Install" foot="Then come back here to sign in.">
          <Row label={`${s.name} was not found on this Mac`} sub={<code className="mono">{s.install}</code>}>
            <button className="btn" onClick={() => copy('install', s.install)}><Icon name="copy" />{copied === 'install' ? 'Copied' : 'Copy'}</button>
          </Row>
        </Group>
      )}
      {s?.installed && (
        <>
          <Group foot={c.how}>
            <Row label="Account" sub={<State on={s.signedIn} yes={`Signed in${s.via ? ` with ${s.via}` : ''}`} no="Not signed in" />}>
              {c.login && (s.signedIn
                ? <button className="btn" onClick={() => void act('logout')} disabled={busy !== ''}>{busy === 'logout' ? 'Signing out...' : 'Sign out'}</button>
                : <button className="btn primary" onClick={() => { setLogin(true); setNote(''); setErr(''); }} disabled={login}>{c.signIn}</button>)}
            </Row>
            <Row label="This project" sub={project ? <State on={s.connected} yes="Connected to Hull's tools" no="Not connected" /> : 'Open a project to connect it'}>
              {project && (s.connected
                ? <button className="btn" onClick={() => void act('disconnect')} disabled={busy !== ''}>{busy === 'disconnect' ? 'Disconnecting...' : 'Disconnect'}</button>
                : <button className="btn primary" onClick={() => void act('connect')} disabled={busy !== ''}>{busy === 'connect' ? 'Connecting...' : 'Connect'}</button>)}
            </Row>
            <Row label="Version" sub={s.version ?? 'Unknown'}>
              <button className="btn ghost" onClick={refresh} title="Check again"><Icon name="reload" />Check again</button>
            </Row>
          </Group>
          {login && c.login && (
            <div className="st-login">
              <div className="st-login-h"><b>{c.signIn}</b><span>Follow the steps below and in your browser.</span><button className="btn ghost" onClick={() => { setLogin(false); refresh(); }}>Done</button></div>
              <LoginTerminal program={c.login} onExit={(code) => { setLogin(false); setNote(code === 0 ? 'Sign-in finished.' : 'Sign-in ended without finishing.'); refresh(); }} />
            </div>
          )}
          {id === 'codex' && adapter && !adapter.installed && adapter.install && (
            <Group title="Inside Hull" foot="Connecting is enough to use Codex in its own window. To run it in Hull's Agents panel too, install its adapter once.">
              <Row label="Codex adapter (ACP)" sub={<code className="mono">{adapter.install}</code>}>
                <button className="btn" onClick={() => copy('acp', adapter.install ?? '')}><Icon name="copy" />{copied === 'acp' ? 'Copied' : 'Copy'}</button>
              </Row>
            </Group>
          )}
        </>
      )}
      <div className="st-status" role="status">{note}</div>
      {err && <div className="note-err" role="alert">{err}</div>}
    </div>
  );
}

function State({ on, yes, no }: { on: boolean | null; yes: string; no: string }): JSX.Element {
  if (on === null) return <span className="st-state">Could not tell</span>;
  return <span className={`st-state ${on ? 'ok' : ''}`}><i />{on ? yes : no}</span>;
}

// ---------- MCP ----------

function McpPane({ project }: { project: OpenedProject | null }): JSX.Element {
  const [copied, copy] = useCopy();
  return (
    <div className="st-pane">
      <header className="st-h"><h3>MCP</h3><p>Any agent that speaks MCP can work on the open project through Hull's tools. Every change it makes is checked and kept in the history under its name.</p></header>
      {!project && <div className="st-callout">Open a project to get its address. Each project has its own.</div>}
      {project && (
        <Group title={project.title}>
          {mcpLines(project.mcp, project.root).map((l) => (
            <div className="st-row st-code" key={l.id}>
              <div className="st-rl"><span>{l.label}</span>{l.note && <small>{l.note}</small>}</div>
              <pre className="mono">{l.text}</pre>
              <button className="btn" onClick={() => copy(l.id, l.text)} aria-label={`Copy: ${l.label}`}><Icon name="copy" />{copied === l.id ? 'Copied' : 'Copy'}</button>
            </div>
          ))}
        </Group>
      )}
    </div>
  );
}
