// Settings' view of the coding agents a person already has: Claude Code and Codex. Hull asks each program about itself
// (`claude auth status`, `codex login status`, `… mcp get hull`) and runs their own commands to connect them to the open
// project. It never reads their credential files, never sees a token, and never signs in for them. Codex's sign-in is its own
// login command in a terminal pane (terminal.ts). Claude Code gets no sign-in or sign-out from Hull at all: Hull never offers
// claude.ai login (PLAN D15), so Settings only says whether Claude Code reports itself signed in.
// Nothing here imports electron.

import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';
import type { CliAction, CliId, CliStatus } from '../shared/agentApi.ts';
import { searchPath, which, type AgentProject } from './agents.ts';

/** Runs a program and resolves with its exit code and output (stdout and stderr together). Tests pass a fake. */
export type Runner = (file: string, args: string[], o: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number | null; out: string }>;

export const runProgram: Runner = (file, args, o) => new Promise((res) => {
  let out = '';
  const c = spawn(file, args, { ...(o.cwd ? { cwd: o.cwd } : {}), env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', (d: Buffer) => { out += d; });
  c.stderr.on('data', (d: Buffer) => { out += d; });
  const t = setTimeout(() => { c.kill(); }, o.timeoutMs);
  c.on('error', (e) => { clearTimeout(t); res({ code: null, out: e.message }); });
  c.on('close', (code) => { clearTimeout(t); res({ code, out }); });
});

export interface Accounts {
  status(): Promise<CliStatus[]>;
  /** Connect or disconnect the open project's tools, or sign out. Resolves with a short line for the page. */
  run(id: CliId, action: CliAction): Promise<string>;
}

const INSTALL: Record<CliId, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
};
const NAME: Record<CliId, string> = { claude: 'Claude Code', codex: 'Codex' };

/** "Claude Max", "Claude account", "API key": how Claude Code says it is signed in, without anything that names the person. */
export function claudeVia(j: Record<string, unknown>): string | null {
  const sub = typeof j['subscriptionType'] === 'string' ? j['subscriptionType'] : '';
  if (sub) return `Claude ${sub.charAt(0).toUpperCase()}${sub.slice(1)}`;
  const m = typeof j['authMethod'] === 'string' ? j['authMethod'] : '';
  if (/key/i.test(m)) return 'API key';
  if (/claude\.ai|oauth|subscription/i.test(m)) return 'Claude account';
  return m || null;
}

/** Codex's `login status` line, reduced to how: its API-key line shows part of the key, so the line itself is never passed on. */
export function codexVia(out: string): string | null {
  if (/chatgpt/i.test(out)) return 'ChatGPT';
  if (/api key/i.test(out)) return 'API key';
  return null;
}

/** The last useful line a program printed, for an error the person can act on. */
const tail = (out: string): string => out.trim().split('\n').filter((l) => l.trim()).slice(-2).join(' ').slice(0, 300);

export function createAccounts(o: { project(): AgentProject | null; env?: NodeJS.ProcessEnv; run?: Runner; find?: (bin: string) => string | null }): Accounts {
  const env = o.env ?? process.env;
  const run = o.run ?? runProgram;
  // Finding a program also looks in Homebrew and npm folders a Finder-launched app lacks (agents.ts); tests pass their own.
  const find = o.find ?? ((bin: string) => which(bin, env));
  const childEnv = (): NodeJS.ProcessEnv => ({ ...env, PATH: searchPath(env).join(delimiter) });
  const exec = (file: string, args: string[], cwd?: string, timeoutMs = 8000): ReturnType<Runner> =>
    run(file, args, { ...(cwd ? { cwd } : {}), env: childEnv(), timeoutMs });

  async function one(id: CliId): Promise<CliStatus> {
    const path = find(id);
    const s: CliStatus = { id, name: NAME[id], installed: path !== null, version: null, signedIn: null, via: null, connected: null, install: INSTALL[id] };
    if (!path) return s;
    const p = o.project();
    const [ver, auth, mcp] = await Promise.all([
      exec(path, ['--version']),
      id === 'claude' ? exec(path, ['auth', 'status', '--json']) : exec(path, ['login', 'status']),
      p ? exec(path, ['mcp', 'get', 'hull'], p.root, 15000) : Promise.resolve(null),
    ]);
    s.version = ver.code === 0 ? (ver.out.match(/\d+\.\d+\.\d+/)?.[0] ?? null) : null;
    if (id === 'claude') {
      try {
        const j = JSON.parse(auth.out) as Record<string, unknown>;
        s.signedIn = j['loggedIn'] === true;
        if (s.signedIn) s.via = claudeVia(j);
      } catch { s.signedIn = auth.code === 0 ? null : false; }
    } else {
      s.signedIn = auth.code === 0;
      if (s.signedIn) s.via = codexVia(auth.out);
    }
    // Connected means it points at this project: Claude Code by the app's URL, Codex by the project folder.
    if (p && mcp) s.connected = mcp.code === 0 && mcp.out.includes(id === 'claude' ? p.mcp.url : p.root);
    return s;
  }

  return {
    async status() { return Promise.all((['claude', 'codex'] as const).map(one)); },
    async run(id, action) {
      if (id !== 'claude' && id !== 'codex') throw new Error(`No coding agent called ${String(id)}.`);
      const path = find(id);
      if (!path) throw new Error(`${NAME[id]} is not installed. ${INSTALL[id]}`);
      if (action === 'logout') {
        if (id === 'claude') throw new Error('Sign out inside Claude Code itself: Hull does not handle Claude accounts.');
        const r = await exec(path, ['logout']);
        if (r.code !== 0) throw new Error(`${NAME[id]} could not sign out: ${tail(r.out)}`);
        return `Signed out of ${NAME[id]}.`;
      }
      const p = o.project();
      if (!p) throw new Error('Open a project first: the connection points at the project that is open.');
      if (action !== 'connect' && action !== 'disconnect') throw new Error(`Unknown action ${String(action)}.`);
      // Claude Code keeps the entry for this folder only (its local scope); Codex has one list, so its entry follows the open project.
      const remove = id === 'claude' ? ['mcp', 'remove', 'hull', '-s', 'local'] : ['mcp', 'remove', 'hull'];
      if (action === 'disconnect') {
        const r = await exec(path, remove, p.root);
        if (r.code !== 0 && !/not found|no .*server/i.test(r.out)) throw new Error(`${NAME[id]} could not remove Hull: ${tail(r.out)}`);
        return `${NAME[id]} no longer has Hull's tools.`;
      }
      await exec(path, remove, p.root);
      let add: string[];
      // Each says who it is, so the history names Claude Code or Codex rather than a generic builder.
      if (id === 'claude') add = ['mcp', 'add', '--transport', 'http', 'hull', p.mcp.url, '--header', 'x-hull-author: Claude Code', ...(p.mcp.token ? ['--header', `Authorization: Bearer ${p.mcp.token}`] : [])];
      else {
        // Codex starts Hull's tools itself (stdio), so they work while the app is closed too.
        const node = find('node');
        if (!node) throw new Error('Codex starts Hull\'s tools with Node, and node was not found on this Mac.');
        add = ['mcp', 'add', 'hull', '--env', 'HULL_MCP_AUTHOR=Codex', '--', node, p.mcp.launcher, p.root];
      }
      const r = await exec(path, add, p.root);
      if (r.code !== 0) throw new Error(`${NAME[id]} could not add Hull: ${tail(r.out)}`);
      return `${NAME[id]} can use this project's tools.`;
    },
  };
}
