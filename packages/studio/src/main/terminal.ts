// A terminal pane for the person's own `claude`: a pseudo-terminal in the project folder, run unmodified, with the
// person's own environment. Hull does not log in for them, read their credentials, or wrap the program: this is the same
// thing as typing `claude` in Terminal, drawn inside the app. Nothing here imports electron.

import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import type { AgentEvent, ClaudeCodeInfo, TermInfo } from '../shared/agentApi.ts';
import { searchPath, which, type AgentProject } from './agents.ts';

interface Pty { onData(cb: (d: string) => void): unknown; onExit(cb: (e: { exitCode: number }) => void): unknown; write(d: string): void; resize(c: number, r: number): void; kill(): void }
interface PtyModule { spawn(file: string, args: string[], o: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): Pty }

export interface Terminals {
  claudeInfo(): ClaudeCodeInfo;
  open(cols: number, rows: number): Promise<TermInfo>;
  write(tid: string, data: string): void;
  resize(tid: string, cols: number, rows: number): void;
  kill(tid: string): void;
  closeAll(): void;
}

export function createTerminals(o: { project(): AgentProject | null; emit(e: AgentEvent): void; env?: NodeJS.ProcessEnv; command?: string }): Terminals {
  const env = o.env ?? process.env;
  const ttys = new Map<string, Pty>();
  let next = 1;
  let pty: PtyModule | null = null;

  function loadPty(): PtyModule {
    if (pty) return pty;
    const req = createRequire(import.meta.url);
    try {
      // pnpm can unpack the prebuilt spawn-helper without its execute bit, which makes every spawn fail with "posix_spawnp failed".
      const dir = dirname(req.resolve('node-pty/package.json'));
      for (const p of [join(dir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')]) if (existsSync(p)) { try { chmodSync(p, 0o755); } catch { /* read-only install: the spawn will say so */ } }
      return (pty = req('node-pty') as PtyModule);
    } catch (e) {
      throw new Error(`The terminal could not start (node-pty did not load): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const path = (): string | null => which(o.command ?? 'claude', env);

  return {
    claudeInfo() {
      const p = o.project();
      const p0 = path();
      return {
        installed: p0 !== null, path: p0,
        install: 'Install Claude Code from Anthropic (see claude.com/claude-code), then open this pane again.',
        mcpAdd: p ? `claude mcp add --transport http hull ${p.mcp.url}` : '',
      };
    },
    async open(cols, rows) {
      const p = o.project();
      if (!p) throw new Error('Open a project first.');
      const exe = path();
      if (!exe) throw new Error(`${o.command ?? 'claude'} was not found on this Mac. Install Claude Code first.`);
      const tid = `t${next++}`;
      const t = loadPty().spawn(exe, [], {
        name: 'xterm-256color', cols: Math.max(20, cols), rows: Math.max(5, rows), cwd: p.root,
        env: { ...(env as Record<string, string>), PATH: searchPath(env).join(delimiter), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
      ttys.set(tid, t);
      t.onData((data) => o.emit({ type: 'term-data', tid, data }));
      t.onExit((e) => { ttys.delete(tid); o.emit({ type: 'term-exit', tid, code: e.exitCode }); });
      return { tid, command: exe };
    },
    write(tid, data) { ttys.get(tid)?.write(data); },
    resize(tid, cols, rows) { try { ttys.get(tid)?.resize(Math.max(20, cols), Math.max(5, rows)); } catch { /* exited between the check and the call */ } },
    kill(tid) { try { ttys.get(tid)?.kill(); } catch { /* already gone */ } ttys.delete(tid); },
    closeAll() { for (const t of ttys.values()) { try { t.kill(); } catch { /* gone */ } } ttys.clear(); },
  };
}
