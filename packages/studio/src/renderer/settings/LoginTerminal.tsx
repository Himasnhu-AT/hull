// A terminal for a program's own sign-in (`claude auth login`, `codex login`). The person signs in there and in the browser
// the program opens; Hull only draws the terminal and never sees what is typed into the account.

import { useEffect, useRef, useState, type JSX } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TermProgram } from '../../shared/agentApi.ts';

export function LoginTerminal({ program, onExit }: { program: TermProgram; onExit(code: number | null): void }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  useEffect(() => {
    const el = host.current;
    if (!el || !window.hullApp) return;
    const app = window.hullApp;
    const t = new Terminal({ fontFamily: 'SF Mono, ui-monospace, Menlo, monospace', fontSize: 12, cursorBlink: true, theme: { background: '#161513', foreground: '#e9e7e1' }, scrollback: 2000 });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el);
    try { f.fit(); } catch { /* not laid out yet */ }
    let tid: string | null = null;
    let live = true;
    const keys = t.onData((d) => { if (tid) void app.termWrite(tid, d); });
    const off = app.onAgentEvent((e) => {
      if (e.type === 'term-data' && e.tid === tid) t.write(e.data);
      else if (e.type === 'term-exit' && e.tid === tid) { tid = null; exitRef.current(e.code); }
    });
    const ro = new ResizeObserver(() => { try { f.fit(); } catch { return; } if (tid) void app.termResize(tid, t.cols, t.rows); });
    ro.observe(el);
    app.termOpen(t.cols, t.rows, program).then((r) => { if (live) { tid = r.tid; t.focus(); } else void app.termKill(r.tid); }, (e: Error) => setError(e.message));
    return () => { live = false; ro.disconnect(); off(); keys.dispose(); if (tid) void app.termKill(tid); t.dispose(); };
  }, [program]);

  return (
    <div className="st-termwrap">
      {error && <div className="note-err" role="alert">{error}</div>}
      <div className="st-term" ref={host} data-testid="login-terminal" />
    </div>
  );
}
