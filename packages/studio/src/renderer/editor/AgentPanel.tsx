import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { AgentEvent, AgentInfo, PermissionOption, PlanEntry, ToolView } from '../../shared/agentApi.ts';
import type { OpenedProject } from '../../shared/appApi.ts';
import { Icon } from '../ui/Icon.tsx';
import { diffStat, lineDiff, planProgress, reduce, toolWord, type Item } from './agentView.ts';
import { ClaudePane } from './ClaudePane.tsx';

// The agent panel: an ACP client. It lists the agents on this Mac, starts one with Hull's tools, streams what it says,
// shows its plan as a checklist, its tool calls with diffs, and asks before anything it was not already allowed to do.
// It stays mounted while hidden so a run keeps streaming and the terminal keeps its program.

type Tab = 'agents' | 'claude' | 'connect';

const connectLines = (m: OpenedProject['mcp'], root: string): { id: string; label: string; text: string }[] => [
  { id: 'claude', label: 'Claude Code', text: `claude mcp add --transport http hull ${m.url}` },
  { id: 'codex', label: 'Codex (~/.codex/config.toml)', text: `[mcp_servers.hull]\ncommand = "node"\nargs = ["${m.launcher}", "${root}"]` },
  { id: 'url', label: 'Any MCP client (streamable HTTP)', text: m.url },
];

const useCopy = (): [string, (id: string, text: string) => void] => {
  const [copied, setCopied] = useState('');
  return [copied, (id, text) => { void navigator.clipboard?.writeText(text); setCopied(id); setTimeout(() => setCopied(''), 1200); }];
};

export function AgentPanel({ project, open, onClose }: { project: OpenedProject; open: boolean; onClose(): void }): JSX.Element {
  const [tab, setTab] = useState<Tab>('agents');
  const [seenClaude, setSeenClaude] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [listError, setListError] = useState('');
  const [session, setSession] = useState<{ sid: string; agent: AgentInfo } | null>(null);
  const [starting, setStarting] = useState('');
  const [startError, setStartError] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [text, setText] = useState('');
  const sidRef = useRef<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [copied, copy] = useCopy();

  const refresh = useCallback(() => { window.hullApp?.agentList().then((l) => { setAgents(l); setListError(''); }, (e: Error) => setListError(e.message)); }, []);
  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  useEffect(() => {
    return window.hullApp?.onAgentEvent((e: AgentEvent) => {
      if (!('sid' in e) || e.sid !== sidRef.current) return;
      setItems((cur) => reduce(cur, e));
      if (e.type === 'status') {
        if (e.state === 'running') setRunning(true);
        else if (e.state === 'ready' || e.state === 'error') setRunning(false);
        else if (e.state === 'closed') { setRunning(false); sidRef.current = null; setSession(null); }
      }
    });
  }, []);
  useEffect(() => { const el = scroll.current; if (el) el.scrollTop = el.scrollHeight; }, [items]);

  // A project switch ends the session: the agent's tools belong to the project it started in.
  useEffect(() => () => { if (sidRef.current) void window.hullApp?.agentStop(sidRef.current); sidRef.current = null; }, [project.root]);
  useEffect(() => { setSession(null); setItems([]); setRunning(false); }, [project.root]);

  const start = async (a: AgentInfo): Promise<void> => {
    setStarting(a.id); setStartError('');
    try {
      const sid = await window.hullApp!.agentStart(a.id);
      sidRef.current = sid; setItems([]); setRunning(false); setSession({ sid, agent: a });
    } catch (e) { setStartError(e instanceof Error ? e.message : String(e)); }
    finally { setStarting(''); }
  };
  const end = (): void => { if (sidRef.current) void window.hullApp?.agentStop(sidRef.current); sidRef.current = null; setSession(null); setItems([]); setRunning(false); };
  const send = (): void => {
    const t = text.trim();
    if (!t || !session || running) return;
    setText(''); setRunning(true);
    setItems((cur) => [...cur, { k: 'user', text: t }]);
    window.hullApp!.agentPrompt(session.sid, t).catch((e: Error) => { setRunning(false); setItems((cur) => [...cur, { k: 'note', text: e.message, error: true }]); });
  };
  const answer = (reqId: string, optionId: string | null): void => { if (session) void window.hullApp?.agentAnswer(session.sid, reqId, optionId); };

  useEffect(() => { if (open) { const key = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest?.('.term')) onClose(); }; addEventListener('keydown', key); return () => removeEventListener('keydown', key); } return undefined; }, [open, onClose]);

  const hasPending = items.some((i) => i.k === 'perm' && !i.answer);
  const pick = (t: Tab): void => { setTab(t); if (t === 'claude') setSeenClaude(true); };

  return (
    <div className="agents glass" role="dialog" aria-label="Agents" style={open ? undefined : { display: 'none' }}>
      <div className="ag-top">
        <h3><Icon name="chat" size={14} />Agents</h3>
        <div className="ag-tabs" role="tablist">
          {(['agents', 'claude', 'connect'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => pick(t)}>{t === 'agents' ? 'Agents' : t === 'claude' ? 'Claude Code' : 'Connect'}</button>
          ))}
        </div>
        <button className="btn ghost" onClick={onClose} aria-label="Close the agent panel" style={{ padding: '0 6px' }}><Icon name="close" /></button>
      </div>

      <div className="ag-body" hidden={tab !== 'agents'}>
        {!session && (
          <div className="ag-list">
            <p className="ag-sub">Pick an agent. It works on this project through Hull's tools, so every change is checked and recorded under its name in the History.</p>
            {listError && <div className="ag-card err"><Icon name="warn" size={14} /><div>{listError}</div></div>}
            {startError && <div className="ag-card err"><Icon name="warn" size={14} /><div style={{ whiteSpace: 'pre-wrap' }}>{startError}</div></div>}
            {!agents && !listError && <p className="ag-sub">Looking for agents on this Mac...</p>}
            {agents?.map((a) => (
              <div key={a.id} className={`ag-agent${a.installed ? '' : ' off'}`} data-agent={a.id}>
                <div className="ag-agent-h">
                  <b>{a.name}</b>
                  <span className={`pill ${a.installed ? (a.needs ? 'warn' : 'ok') : ''}`}>{a.installed ? (a.needs ? 'needs setup' : 'ready') : 'not installed'}</span>
                  <span style={{ flex: 1 }} />
                  <button className="btn primary" disabled={!a.installed || !!starting} onClick={() => void start(a)}>{starting === a.id ? 'Starting...' : 'Start'}</button>
                </div>
                <div className="ag-sub">{a.note}</div>
                {a.needs && <div className="ag-sub warnline">{a.needs}</div>}
                {a.install && (
                  <>
                    <div className="ag-row">
                      <pre className="mono">{a.install}</pre>
                      <button className="btn ghost" onClick={() => copy(a.id, a.install ?? '')}>{copied === a.id ? 'Copied' : 'Copy'}</button>
                    </div>
                    {a.after && <div className="ag-sub">{a.after}</div>}
                  </>
                )}
              </div>
            ))}
            <div className="ag-agent" data-agent="claude-code">
              <div className="ag-agent-h"><b>Claude Code</b><span className="pill">terminal</span><span style={{ flex: 1 }} /><button className="btn" onClick={() => pick('claude')}>Open terminal</button></div>
              <div className="ag-sub">Your own Claude Code, run as it is in a terminal in this project. Hull does not sign in for you.</div>
            </div>
            <button className="btn ghost" onClick={refresh} style={{ alignSelf: 'flex-start' }}><Icon name="reload" />Look again</button>
          </div>
        )}
        {session && (
          <>
            <div className="ag-session">
              <b>{session.agent.name}</b>
              <span className={`pill ${running ? 'warn' : 'ok'}`}>{running ? (hasPending ? 'waiting for you' : 'working') : 'ready'}</span>
              <span style={{ flex: 1 }} />
              <button className="btn ghost" onClick={end}>End session</button>
            </div>
            <div className="ag-log" ref={scroll} data-testid="agent-log">
              {items.length === 0 && <p className="ag-sub">Ask for a change, for example "make the jump a little higher". It will check the project before and after.</p>}
              {items.map((it, n) => <ItemView key={n} item={it} answer={answer} />)}
              {running && !hasPending && <div className="ag-typing" aria-label="Working"><i /><i /><i /></div>}
            </div>
            <div className="ag-compose">
              <textarea value={text} placeholder="Ask for a change" rows={2} disabled={running}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
              {running
                ? <button className="btn" onClick={() => void window.hullApp?.agentCancel(session.sid)}>Cancel</button>
                : <button className="btn primary" onClick={send} disabled={!text.trim()}>Send</button>}
            </div>
          </>
        )}
      </div>

      <div className="ag-body" hidden={tab !== 'claude'}>{(seenClaude || tab === 'claude') && <ClaudePane visible={open && tab === 'claude'} projectRoot={project.root} />}</div>

      <div className="ag-body ag-connect" hidden={tab !== 'connect'}>
        <p className="ag-sub">The app serves this project to any local agent over MCP while it is open. Changes they make are recorded under their name and show up here live.</p>
        {connectLines(project.mcp, project.root).map((l) => (
          <div key={l.id} className="ag-row-col">
            <div className="ag-h"><span>{l.label}</span><button className="btn ghost" onClick={() => copy(l.id, l.text)}>{copied === l.id ? 'Copied' : 'Copy'}</button></div>
            <pre className="mono">{l.text}</pre>
          </div>
        ))}
        <p className="ag-sub">With the app closed, an agent can start the same server itself with the Codex-style command above.</p>
      </div>
    </div>
  );
}

function ItemView({ item, answer }: { item: Item; answer(reqId: string, optionId: string | null): void }): JSX.Element | null {
  switch (item.k) {
    case 'user': return <div className="ag-msg user">{item.text}</div>;
    case 'agent': return <div className="ag-msg">{item.text}</div>;
    case 'thought': return <details className="ag-thought"><summary>Thinking</summary>{item.text}</details>;
    case 'plan': return <Plan entries={item.entries} />;
    case 'tool': return <Tool tool={item.tool} />;
    case 'perm': return <Permission item={item} answer={answer} />;
    case 'end': return <div className="ag-end">{item.stopReason === 'end_turn' ? 'Finished' : item.stopReason === 'cancelled' ? 'Cancelled' : `Stopped: ${item.stopReason.replace(/_/g, ' ')}`}</div>;
    case 'note': return <div className={`ag-card${item.error ? ' err' : ''}`}><Icon name="warn" size={14} /><div style={{ whiteSpace: 'pre-wrap' }}>{item.text}</div></div>;
  }
}

function Plan({ entries }: { entries: PlanEntry[] }): JSX.Element {
  const p = planProgress(entries);
  return (
    <div className="ag-plan" data-testid="agent-plan">
      <div className="ag-plan-h"><b>Plan</b><span className="ag-sub">{p.done} of {p.total} done</span></div>
      <ul>
        {entries.map((e, n) => (
          <li key={n} className={e.status}><span className="box" aria-hidden="true">{e.status === 'completed' ? <Icon name="check" size={11} /> : e.status === 'in_progress' ? <i /> : null}</span><span>{e.content}</span></li>
        ))}
      </ul>
    </div>
  );
}

function Diff({ path, oldText, newText }: { path: string; oldText: string | null; newText: string }): JSX.Element {
  const d = useMemo(() => lineDiff(oldText, newText), [oldText, newText]);
  const s = diffStat(d);
  return (
    <div className="ag-diff">
      <div className="ag-diff-h mono"><span>{path}</span><span><b className="add">+{s.added}</b> <b className="del">-{s.removed}</b></span></div>
      <pre className="mono">{d.map((l, n) => <div key={n} className={`dl ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '…' ? 'gap' : ''}`}>{l.t === '…' ? `... ${l.s}` : `${l.t} ${l.s}`}</div>)}</pre>
    </div>
  );
}

function Tool({ tool }: { tool: ToolView }): JSX.Element {
  return (
    <div className={`ag-tool ${tool.status}`} data-testid="agent-tool">
      <div className="ag-tool-h"><span className={`dot ${tool.status}`} /><span className="kind">{toolWord(tool.toolKind)}</span><span className="title">{tool.title}</span></div>
      {tool.content.map((c, n) => c.kind === 'diff' ? <Diff key={n} path={c.path} oldText={c.oldText} newText={c.newText} />
        : c.kind === 'text' ? <pre key={n} className="mono ag-out">{c.text}</pre> : null)}
    </div>
  );
}

function Permission({ item, answer }: { item: Extract<Item, { k: 'perm' }>; answer(reqId: string, optionId: string | null): void }): JSX.Element {
  const allow = (o: PermissionOption): boolean => o.kind.startsWith('allow');
  return (
    <div className={`ag-perm${item.answer ? ' done' : ''}`} data-testid="agent-permission">
      <div className="ag-perm-h"><Icon name="warn" size={14} /><b>{item.answer ? 'Asked to' : 'Wants to'} {item.tool.title}</b></div>
      {item.tool.content.map((c, n) => c.kind === 'diff' ? <Diff key={n} path={c.path} oldText={c.oldText} newText={c.newText} /> : c.kind === 'text' ? <pre key={n} className="mono ag-out">{c.text}</pre> : null)}
      {item.answer
        ? <div className="ag-sub">{item.answer.optionId === null ? 'Denied' : item.answer.name}</div>
        : (
          <div className="ag-actions">
            {item.options.map((o) => <button key={o.id} className={`btn${allow(o) && o.kind === 'allow_once' ? ' primary' : ''}`} data-option={o.kind} onClick={() => answer(item.reqId, o.id)}>{o.name}</button>)}
            <button className="btn ghost" onClick={() => answer(item.reqId, null)}>Deny</button>
          </div>
        )}
    </div>
  );
}
