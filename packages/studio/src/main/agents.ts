// The app's side of ACP (Agent Client Protocol): finds agents on this Mac, starts one as a child process over stdio,
// hands it Hull's MCP server in session/new, and turns what it streams back into plain events for the panel.
// Nothing here imports electron, so Electron's main process and the web dev mode share it.
//
// Rules from the terms of the agents' makers: this never reads or stores another product's credentials, and it never
// starts Claude Code through an SDK adapter. Claude Code is only ever the person's own `claude`, in a terminal (terminal.ts).

import { spawn, type ChildProcess } from 'node:child_process';
import { constants, accessSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type McpServer, type SessionUpdate, type ToolCall, type ToolCallContent, type ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { AgentEvent, AgentInfo, PermissionOption, ToolContent, ToolView } from '../shared/agentApi.ts';

/** The open project, as far as an agent needs it. */
export interface AgentProject { root: string; mcp: { url: string; launcher: string } }

export interface HubOptions {
  /** The project agents work on; null when none is open. */
  project(): AgentProject | null;
  emit(e: AgentEvent): void;
  log?: (line: string) => void;
  /** Overrides process.env (tests). */
  env?: NodeJS.ProcessEnv;
}

export interface Hub {
  list(): Promise<AgentInfo[]>;
  start(agentId: string): Promise<string>;
  prompt(sid: string, text: string): Promise<void>;
  cancel(sid: string): Promise<void>;
  stop(sid: string): Promise<void>;
  answer(sid: string, reqId: string, optionId: string | null): Promise<void>;
  closeAll(): Promise<void>;
}

interface Spec {
  id: string;
  name: string;
  note: string;
  /** The command to run to get it. */
  install: string;
  /** What to do once it is installed (sign in). */
  after?: string;
  /** Executable name looked up on PATH, or an absolute path. */
  bin: string;
  args: string[];
  /** Env the agent needs to be useful at all; its absence is reported, not hidden. */
  needsEnv?: { any: string[]; hint: string };
  kind: 'hull' | 'acp';
}

/** Folders a Finder-launched app does not have on PATH but a person's terminal does. */
export function searchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin'), join(home, '.npm-global/bin'), join(home, '.cargo/bin'), join(home, '.bun/bin'), join(home, '.opencode/bin'), '/usr/bin', '/bin'];
  return [...(env['PATH'] ?? '').split(delimiter).filter(Boolean), ...extra];
}

export function which(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const ok = (p: string): boolean => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
  if (bin.includes('/')) return ok(bin) ? bin : null;
  for (const d of searchPath(env)) { const p = join(d, bin); if (existsSync(p) && ok(p)) return p; }
  return null;
}

const HULL_AGENT_BIN = fileURLToPath(new URL('../../../agent/bin/hull-agent.js', import.meta.url));

/** Extra agents a person (or a test) adds: HULL_ACP_AGENTS='[{"id":"x","name":"X","command":"/path","args":["acp"]}]'. */
function extraSpecs(env: NodeJS.ProcessEnv): Spec[] {
  try {
    const raw = JSON.parse(env['HULL_ACP_AGENTS'] ?? '[]') as { id: string; name: string; command: string; args?: string[] }[];
    return raw.filter((a) => a && typeof a.id === 'string' && typeof a.command === 'string').map((a) => ({
      id: a.id, name: a.name || a.id, kind: 'acp', note: 'Added with HULL_ACP_AGENTS.', install: '', bin: a.command, args: a.args ?? [],
    }));
  } catch { return []; }
}

function catalog(env: NodeJS.ProcessEnv, geminiAcpFlag: string): Spec[] {
  return [
    {
      id: 'hull', name: 'Hull agent', kind: 'hull', bin: process.execPath, args: [HULL_AGENT_BIN],
      note: 'Hull\'s own agent. Uses your API key, or credits on Marl\'s gateway.',
      install: 'Ships with Hull.',
      needsEnv: { any: ['ANTHROPIC_API_KEY', 'HULL_AGENT_API_KEY', 'HULL_AGENT_FAKE'], hint: 'Set ANTHROPIC_API_KEY (Anthropic), or HULL_AGENT_BASE_URL and HULL_AGENT_API_KEY (any OpenAI-compatible endpoint, such as ai.marlstudio.com), then restart Hull.' },
    },
    { id: 'codex', name: 'Codex', kind: 'acp', bin: 'codex-acp', args: [], note: 'OpenAI Codex through its ACP adapter, signed in with your own Codex account.', install: 'npm install -g @zed-industries/codex-acp', after: 'Then run `codex login` once to sign in with your own account.' },
    { id: 'gemini', name: 'Gemini CLI', kind: 'acp', bin: 'gemini', args: [geminiAcpFlag], note: 'Google\'s Gemini CLI in ACP mode, signed in with your own account.', install: 'npm install -g @google/gemini-cli', after: 'Then run `gemini` once to sign in with your own account.' },
    { id: 'opencode', name: 'OpenCode', kind: 'acp', bin: 'opencode', args: ['acp'], note: 'OpenCode in ACP mode, with whichever provider you set up in it.', install: 'npm install -g opencode-ai', after: 'Then run `opencode auth login` to add a provider.' },
    ...extraSpecs(env),
  ];
}

const cut = (s: string, n = 4000): string => (s.length > n ? `${s.slice(0, n)}\n...` : s);

function contentOf(c: ToolCallContent): ToolContent | null {
  if (c.type === 'diff') return { kind: 'diff', path: c.path, oldText: c.oldText ?? null, newText: cut(c.newText, 20000) };
  if (c.type === 'terminal') return { kind: 'terminal', id: c.terminalId };
  const b = c.content;
  if (b.type === 'text') return { kind: 'text', text: cut(b.text) };
  return { kind: 'text', text: `[${b.type}]` };
}

interface SessionState {
  sid: string;
  agent: Spec;
  child: ChildProcess;
  conn: ClientConnection;
  tools: Map<string, ToolView>;
  perms: Map<string, (optionId: string | null) => void>;
  running: boolean;
  closed: boolean;
  stderr: string[];
}

export function createHub(o: HubOptions): Hub {
  const env = o.env ?? process.env;
  const log = o.log ?? (() => {});
  const sessions = new Map<string, SessionState>();
  let nextPerm = 1;
  let geminiFlag: string | null = null;

  async function geminiAcpFlag(): Promise<string> {
    if (geminiFlag) return geminiFlag;
    const path = which('gemini', env);
    let flag = '--experimental-acp';
    if (path) {
      // Newer releases renamed the flag; ask the CLI which one it has.
      const help = await new Promise<string>((res) => {
        const c = spawn(path, ['--help'], { env: { ...env, PATH: searchPath(env).join(delimiter) } });
        let t = ''; c.stdout.on('data', (d: Buffer) => (t += d)); c.stderr.on('data', (d: Buffer) => (t += d));
        c.on('error', () => res('')); c.on('close', () => res(t));
        setTimeout(() => { c.kill(); res(t); }, 4000).unref();
      });
      if (/--acp\b/.test(help)) flag = '--acp';
    }
    return (geminiFlag = flag);
  }

  async function specs(): Promise<Spec[]> { return catalog(env, await geminiAcpFlag()); }

  async function list(): Promise<AgentInfo[]> {
    const out: AgentInfo[] = [];
    for (const s of await specs()) {
      const path = s.kind === 'hull' ? (existsSync(HULL_AGENT_BIN) ? HULL_AGENT_BIN : null) : which(s.bin, env);
      const info: AgentInfo = { id: s.id, name: s.name, kind: s.kind === 'hull' ? 'hull' : 'acp', installed: path !== null, note: s.note };
      if (path) info.command = [s.kind === 'hull' ? 'hull-agent' : path, ...(s.kind === 'hull' ? [] : s.args)].join(' ');
      if (!path && s.kind === 'hull') info.needs = 'The Hull agent package is not built in this checkout (packages/agent).';
      else if (!path) { info.install = s.install; if (s.after) info.after = s.after; }
      if (path && s.needsEnv && !s.needsEnv.any.some((k) => env[k])) info.needs = s.needsEnv.hint;
      out.push(info);
    }
    return out;
  }

  const view = (s: SessionState, t: ToolCall | ToolCallUpdate): ToolView => {
    const id = t.toolCallId;
    const prev = s.tools.get(id);
    const content = t.content ? t.content.map(contentOf).filter((c): c is ToolContent => c !== null) : (prev?.content ?? []);
    const locs = t.locations ? t.locations.map((l) => l.path) : (prev?.paths ?? []);
    const next: ToolView = {
      id,
      title: t.title ?? prev?.title ?? 'Tool call',
      toolKind: t.kind ?? prev?.toolKind ?? 'other',
      status: (t.status ?? prev?.status ?? 'pending') as ToolView['status'],
      content, paths: locs,
    };
    s.tools.set(id, next);
    return next;
  };

  function onUpdate(s: SessionState, u: SessionUpdate): void {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
      case 'user_message_chunk': {
        if (u.content.type !== 'text') return;
        const role = u.sessionUpdate === 'agent_message_chunk' ? 'agent' : u.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'user';
        o.emit({ type: 'message', sid: s.sid, role, text: u.content.text });
        return;
      }
      case 'plan':
        o.emit({ type: 'plan', sid: s.sid, entries: u.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority })) });
        return;
      case 'tool_call':
      case 'tool_call_update':
        o.emit({ type: 'tool', sid: s.sid, tool: view(s, u) });
        return;
      default: return; // modes, commands, usage: not shown yet
    }
  }

  async function start(agentId: string): Promise<string> {
    const project = o.project();
    if (!project) throw new Error('Open a project first.');
    const spec = (await specs()).find((x) => x.id === agentId);
    if (!spec) throw new Error(`No agent called ${agentId}.`);
    const exe = spec.kind === 'hull' ? process.execPath : which(spec.bin, env);
    if (!exe || (spec.kind === 'hull' && !existsSync(HULL_AGENT_BIN))) throw new Error(`${spec.name} is not installed. ${spec.install}`);

    const childEnv = { ...env, PATH: searchPath(env).join(delimiter) } as NodeJS.ProcessEnv;
    const args = spec.kind === 'hull' ? [...spec.args, project.root] : spec.args;
    const child = spawn(exe, args, { cwd: project.root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr: string[] = [];
    child.stderr.on('data', (d: Buffer) => { for (const l of d.toString('utf8').split('\n')) if (l.trim()) { stderr.push(l); if (stderr.length > 30) stderr.shift(); log(`[${spec.id}] ${l}`); } });
    const exited = new Promise<never>((_, rej) => {
      child.once('error', (e) => rej(new Error(`Could not start ${spec.name}: ${e.message}`)));
      child.once('exit', (code, sig) => rej(new Error(`${spec.name} exited (${sig ?? code}) before it was ready.\n${stderr.slice(-6).join('\n')}`.trim())));
    });
    exited.catch(() => {});

    let s!: SessionState;
    const app = client({ name: 'hull-studio' })
      .onNotification(methods.client.session.update, ({ params }) => { if (s && params.sessionId === s.sid) onUpdate(s, params.update); })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => {
        if (!s || params.sessionId !== s.sid) return { outcome: { outcome: 'cancelled' } };
        const reqId = `p${nextPerm++}`;
        const options: PermissionOption[] = params.options.map((x) => ({ id: x.optionId, name: x.name, kind: x.kind }));
        const tool = view(s, params.toolCall);
        const answer = new Promise<string | null>((res) => s.perms.set(reqId, res));
        o.emit({ type: 'permission', sid: s.sid, reqId, tool, options });
        const picked = await answer;
        s.perms.delete(reqId);
        o.emit({ type: 'permission-done', sid: s.sid, reqId, optionId: picked });
        return picked === null ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: picked } };
      });
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const conn = app.connect(stream);

    try {
      const init = await Promise.race([conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'hull-studio', title: 'Hull', version: '0.0.0' } }), exited]);
      // The author header tells Hull's MCP server who made each change, so the history names the agent, not "mcp".
      const mcp: McpServer = init.agentCapabilities?.mcpCapabilities?.http
        ? { type: 'http', name: 'hull', url: project.mcp.url, headers: [{ name: 'x-hull-author', value: spec.name }] }
        : { name: 'hull', command: process.execPath, args: [project.mcp.launcher, project.root], env: [{ name: 'HULL_MCP_AUTHOR', value: spec.name }] };
      const created = await Promise.race([conn.agent.request(methods.agent.session.new, { cwd: project.root, mcpServers: [mcp] }), exited]);
      s = { sid: created.sessionId, agent: spec, child, conn, tools: new Map(), perms: new Map(), running: false, closed: false, stderr };
      sessions.set(s.sid, s);
      child.once('exit', (code, sig) => {
        s.closed = true; sessions.delete(s.sid);
        for (const r of s.perms.values()) r(null);
        o.emit({ type: 'status', sid: s.sid, state: s.running && code ? 'error' : 'closed', message: `${spec.name} exited (${sig ?? code})`, agent: spec.name });
      });
      o.emit({ type: 'status', sid: s.sid, state: 'ready', agent: spec.name });
      return s.sid;
    } catch (e) {
      child.kill();
      const m = e instanceof Error ? e.message : String(e);
      throw new Error(/auth/i.test(m) ? `${spec.name} needs you to sign in first: ${spec.install || 'run it once in a terminal'}. (${m})` : m);
    }
  }

  const get = (sid: string): SessionState => { const s = sessions.get(sid); if (!s) throw new Error('That agent session has ended.'); return s; };

  return {
    list,
    start,
    async prompt(sid, text) {
      const s = get(sid);
      if (s.running) throw new Error('The agent is still working. Cancel it first.');
      s.running = true; s.tools.clear();
      o.emit({ type: 'status', sid, state: 'running' });
      // Streams to the panel as events; the promise here is only the end of the run.
      void s.conn.agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: 'text', text }] }).then(
        (r) => { s.running = false; o.emit({ type: 'done', sid, stopReason: r.stopReason }); o.emit({ type: 'status', sid, state: 'ready' }); },
        (e: unknown) => { s.running = false; o.emit({ type: 'status', sid, state: 'error', message: e instanceof Error ? e.message : String(e) }); },
      );
    },
    async cancel(sid) {
      const s = get(sid);
      for (const r of s.perms.values()) r(null);
      await s.conn.agent.notify(methods.agent.session.cancel, { sessionId: sid });
    },
    async stop(sid) {
      const s = sessions.get(sid);
      if (!s) return;
      for (const r of s.perms.values()) r(null);
      s.child.kill();
    },
    async answer(sid, reqId, optionId) { get(sid).perms.get(reqId)?.(optionId); },
    async closeAll() { for (const s of [...sessions.values()]) { for (const r of s.perms.values()) r(null); s.child.kill(); } sessions.clear(); },
  };
}
