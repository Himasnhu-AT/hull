// The builder as the person's own Claude Code: the real `claude`, unmodified, in a terminal in the project folder, signed in with
// their own account (PLAN D15: Hull never signs in to Claude or drives it through an SDK). It reaches the project through Hull's
// MCP tools, so its changes land in the history like the builder's. An opening message, when given, is claude's own argument.

import { useEffect, useRef, useState, type JSX } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function ClaudeChat({ prompt, onExit }: { prompt?: string | undefined; onExit?: () => void }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(false);
  const [run, setRun] = useState(0);
  const first = useRef(prompt);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  useEffect(() => {
    const el = host.current;
    const app = window.hullApp;
    if (!el || !app) return;
    setError(''); setEnded(false);
    const t = new Terminal({
      fontFamily: 'SF Mono, ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, scrollback: 5000,
      theme: { background: '#ffffff', foreground: '#1c1b18', cursor: '#1c1b18', cursorAccent: '#ffffff', selectionBackground: 'rgba(212, 80, 31, 0.22)' },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el);
    try { f.fit(); } catch { /* not laid out yet: the observer fits it */ }
    let tid: string | null = null;
    let live = true;
    const keys = t.onData((d) => { if (tid) void app.termWrite(tid, d); });
    const off = app.onAgentEvent((e) => {
      if (e.type === 'term-data' && e.tid === tid) t.write(e.data);
      else if (e.type === 'term-exit' && e.tid === tid) { tid = null; setEnded(true); exitRef.current?.(); }
    });
    const ro = new ResizeObserver(() => { if (!el.offsetParent) return; try { f.fit(); } catch { return; } if (tid) void app.termResize(tid, t.cols, t.rows); });
    ro.observe(el);
    // The opening message goes with the first start only; a restart is a fresh, empty session.
    const opening = run === 0 ? first.current : undefined;
    app.termOpen(t.cols, t.rows, 'claude', opening || undefined).then(
      (r) => { if (live) { tid = r.tid; t.focus(); } else void app.termKill(r.tid); },
      (e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')),
    );
    return () => { live = false; ro.disconnect(); off(); keys.dispose(); if (tid) void app.termKill(tid); t.dispose(); };
  }, [run]);

  return (
    <div className="cc-chat">
      {error && <div className="note-err" role="alert">{error}</div>}
      <div className="cc-term" ref={host} data-testid="claude-chat" />
      {ended && <div className="cc-ended"><span>Claude Code closed.</span><button className="btn" onClick={() => setRun((n) => n + 1)}>Start it again</button></div>}
    </div>
  );
}
