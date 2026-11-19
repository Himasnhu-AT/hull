import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ClaudeCodeInfo } from '../../shared/agentApi.ts';
import { Icon } from '../ui/Icon.tsx';

// The person's own `claude`, in a terminal in this project's folder. Hull does not sign in for them, read their
// credentials or wrap the program; this is Terminal drawn inside the app. The MCP line is shown, not run for them.
export function ClaudePane({ visible, projectRoot }: { visible: boolean; projectRoot: string }): JSX.Element {
  const [info, setInfo] = useState<ClaudeCodeInfo | null>(null);
  const [state, setState] = useState<'idle' | 'running' | 'exited'>('idle');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const tid = useRef<string | null>(null);

  useEffect(() => { void window.hullApp?.claudeInfo().then(setInfo, (e: Error) => setError(e.message)); }, [projectRoot]);

  // One xterm for the life of the pane; the program behind it can be restarted.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = new Terminal({ fontFamily: 'SF Mono, ui-monospace, Menlo, monospace', fontSize: 12, cursorBlink: true, convertEol: false, theme: { background: '#101216' }, scrollback: 5000 });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el);
    term.current = t; fit.current = f;
    const keys = t.onData((d) => { if (tid.current) void window.hullApp?.termWrite(tid.current, d); });
    const off = window.hullApp?.onAgentEvent((e) => {
      if (e.type === 'term-data' && e.tid === tid.current) t.write(e.data);
      else if (e.type === 'term-exit' && e.tid === tid.current) { tid.current = null; setState('exited'); t.write(`\r\n\x1b[2m[claude exited${e.code ? ` with code ${e.code}` : ''}]\x1b[0m\r\n`); }
    });
    const ro = new ResizeObserver(() => {
      if (!el.offsetParent) return;
      try { f.fit(); } catch { return; }
      if (tid.current) void window.hullApp?.termResize(tid.current, t.cols, t.rows);
    });
    ro.observe(el);
    return () => { ro.disconnect(); off?.(); keys.dispose(); if (tid.current) void window.hullApp?.termKill(tid.current); tid.current = null; t.dispose(); term.current = null; };
  }, []);

  useEffect(() => { if (visible) setTimeout(() => { try { fit.current?.fit(); } catch { /* hidden */ } term.current?.focus(); }, 0); }, [visible]);

  const open = useCallback(async () => {
    const t = term.current; const f = fit.current;
    if (!t || !f || !window.hullApp) return;
    setError('');
    try { f.fit(); } catch { /* not laid out yet: the observer resizes it */ }
    t.reset();
    try {
      const r = await window.hullApp.termOpen(t.cols, t.rows);
      tid.current = r.tid; setState('running'); t.focus();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  const copy = (): void => { if (info) { void navigator.clipboard?.writeText(info.mcpAdd); setCopied(true); setTimeout(() => setCopied(false), 1200); } };
  const paste = (): void => { if (info && tid.current) { void window.hullApp?.termWrite(tid.current, info.mcpAdd); term.current?.focus(); } };

  return (
    <div className="cc">
      {info && !info.installed && (
        <div className="ag-card warn"><Icon name="warn" size={14} /><div><b>Claude Code was not found on this Mac.</b><div className="ag-sub">{info.install}</div></div></div>
      )}
      {info?.installed && (
        <div className="ag-mcp">
          <div className="ag-sub">Runs your own <span className="mono">claude</span> in <span className="mono">{projectRoot.split('/').slice(-2).join('/')}</span>, signed in with your own account. To let it use this project's tools, run this once in it:</div>
          <pre className="mono">{info.mcpAdd}</pre>
          <div className="ag-actions">
            <button className="btn" onClick={copy}><Icon name="copy" />{copied ? 'Copied' : 'Copy'}</button>
            <button className="btn" onClick={paste} disabled={state !== 'running'} title="Types the line into the terminal; press Enter to run it"><Icon name="console" />Type it in the terminal</button>
            {state !== 'running' && <button className="btn primary" onClick={() => void open()}><Icon name="play" />{state === 'exited' ? 'Restart' : 'Open Claude Code'}</button>}
            {state === 'running' && <button className="btn ghost" onClick={() => { if (tid.current) void window.hullApp?.termKill(tid.current); tid.current = null; setState('exited'); }}>Close</button>}
          </div>
        </div>
      )}
      {error && <div className="ag-card err"><Icon name="warn" size={14} /><div>{error}</div></div>}
      <div className="term" ref={host} data-testid="claude-terminal" />
    </div>
  );
}
