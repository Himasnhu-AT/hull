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
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { UiBlock } from 'hull/dev/protocol';
import type { AgentEvent, AgentInfo, EnsureResult, PermissionOption, PromptOptions, ToolContent, ToolView } from '../shared/agentApi.ts';
import { KEY_ENV, NEEDS_KEY, type SettingsStore } from './agentSettings.ts';
import { nodeChildEnv } from '@hull/tools';

// The keys Hull adds to ACP messages (HULL_META in hull/dev/protocol). Spelled out here because this file runs in Node
// without the engine package's runtime exports.
const META_UI = 'hull.ui';
const META_MODE = 'hull.mode';
const META_STAGE = 'hull.stage';

/** The open project, as far as an agent needs it. */
export interface AgentProject { root: string; mcp: { url: string; launcher: string; token?: string } }

export interface HubOptions {
  /** The project agents work on; null when none is open. */
  project(): AgentProject | null;
  emit(e: AgentEvent): void;
  log?: (line: string) => void;
  /** Overrides process.env (tests). */
  env?: NodeJS.ProcessEnv;
  /** The builder's model and key. Without it the environment alone decides. */
  settings?: SettingsStore;
}

export interface Hub {
  list(): Promise<AgentInfo[]>;
  start(agentId: string): Promise<string>;
  prompt(sid: string, text: string, options?: PromptOptions): Promise<void>;
  /** Hull's own agent for the open project, started if it is not running. HULL_ENSURE_AGENT=<id> starts that catalogue agent instead (tests, screenshots). */
  ensure(): Promise<EnsureResult>;
  /** Stops the builder that ensure() started, so the next ensure() starts one with the current settings. */
  stopEnsured(): Promise<void>;
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

/** The content blocks of a prompt: the note, then (for a frozen moment) the screenshot and a line on what just played. */
export function promptBlocks(text: string, opts: PromptOptions = {}): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text }];
  const m = opts.moment;
  const about = opts.about && opts.about.length > 0 ? `About: ${opts.about.join(', ')}` : '';
  if (m) {
    blocks.push({ type: 'image', mimeType: 'image/png', data: m.png });
    const just = m.recent.length > 0 ? m.recent.map((r) => `${r.kind} ${r.id} (${r.label})`).join(', ') : 'nothing';
    blocks.push({ type: 'text', text: `Moment: time ${m.time.toFixed(1)} s, tick ${m.tick}. Just now: ${just}${about ? `\n${about}` : ''}` });
  } else if (about) blocks.push({ type: 'text', text: about });
  return blocks;
}

/** The _meta of a prompt: what kind of run it is. No mode means the builder treats it as a fix. */
export function promptMeta(opts: PromptOptions = {}): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (opts.mode) meta[META_MODE] = opts.mode;
  if (opts.stage) meta[META_STAGE] = opts.stage;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

const uiOf = (meta: unknown): UiBlock | null => {
  const b = (meta as Record<string, unknown> | null | undefined)?.[META_UI] as UiBlock | undefined;
  return b && typeof b === 'object' && typeof b.id === 'string' && typeof b.kind === 'string' ? b : null;
};

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
  let ensured: { root: string; sid: string } | null = null;
  let ensuring: Promise<EnsureResult> | null = null;
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
      if (path && s.kind === 'hull' && o.settings) { const n = await o.settings.needs(env); if (n) info.needs = n; }
      else if (path && s.needsEnv && !s.needsEnv.any.some((k) => env[k])) info.needs = s.needsEnv.hint;
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
        // A card rides in _meta of a chunk that usually has no text.
        const ui = u.sessionUpdate === 'agent_message_chunk' ? uiOf((u as { _meta?: unknown })._meta) : null;
        if (u.content.type === 'text' && u.content.text === '' && ui) { o.emit({ type: 'ui', sid: s.sid, block: ui }); return; }
        if (u.content.type !== 'text') { if (ui) o.emit({ type: 'ui', sid: s.sid, block: ui }); return; }
        const role = u.sessionUpdate === 'agent_message_chunk' ? 'agent' : u.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'user';
        o.emit({ type: 'message', sid: s.sid, role, text: u.content.text });
        if (ui) o.emit({ type: 'ui', sid: s.sid, block: ui });
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

    // Hull's own agent gets the key from the app's settings; other agents keep their own sign-in and get the plain environment.
    const base = spec.kind === 'hull' && o.settings ? await o.settings.env(env) : env;
    // Hull's agent is this program run as Node (Electron in the app); other agents are their own programs.
    const childEnv = { ...(spec.kind === 'hull' ? nodeChildEnv(base) : base), PATH: searchPath(env).join(delimiter) } as NodeJS.ProcessEnv;
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
        const ui = uiOf((params.toolCall as { _meta?: unknown })._meta);
        const options: PermissionOption[] = params.options.map((x) => ({ id: x.optionId, name: x.name, kind: x.kind }));
        const answer = new Promise<string | null>((res) => s.perms.set(reqId, res));
        // A card that waits (ask, approve) is drawn as that card; any other request is the plain permission prompt.
        if (ui) o.emit({ type: 'ui', sid: s.sid, block: ui, reqId });
        else o.emit({ type: 'permission', sid: s.sid, reqId, tool: view(s, params.toolCall), options });
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
        ? { type: 'http', name: 'hull', url: project.mcp.url, headers: [{ name: 'x-hull-author', value: spec.name }, ...(project.mcp.token ? [{ name: 'authorization', value: `Bearer ${project.mcp.token}` }] : [])] }
        : { name: 'hull', command: process.execPath, args: [project.mcp.launcher, project.root], env: [{ name: 'HULL_MCP_AUTHOR', value: spec.name }, { name: 'ELECTRON_RUN_AS_NODE', value: '1' }] };
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
    async prompt(sid, text, opts) {
      const s = get(sid);
      if (s.running) throw new Error('The agent is still working. Cancel it first.');
      s.running = true; s.tools.clear();
      o.emit({ type: 'status', sid, state: 'running' });
      // Streams to the panel as events; the promise here is only the end of the run.
      void s.conn.agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: promptBlocks(text, opts), ...(promptMeta(opts) ? { _meta: promptMeta(opts) } : {}) }).then(
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
    async ensure() {
      const project = o.project();
      if (!project) throw new Error('Open a project first.');
      if (ensured && ensured.root === project.root && sessions.has(ensured.sid)) return { sid: ensured.sid };
      if (ensuring) return ensuring;
      ensuring = (async (): Promise<EnsureResult> => {
        const id = env['HULL_ENSURE_AGENT'] || 'hull';
        if (id === 'hull') {
          const needs = o.settings ? await o.settings.needs(env) : (KEY_ENV.some((k) => env[k]) ? null : NEEDS_KEY);
          if (needs) return { needs };
        }
        const sid = await start(id);
        ensured = { root: project.root, sid };
        return { sid };
      })().finally(() => { ensuring = null; });
      return ensuring;
    },
    async stopEnsured() {
      const e = ensured; ensured = null;
      if (e) { const s = sessions.get(e.sid); if (s) { for (const r of s.perms.values()) r(null); s.child.kill(); } }
    },
    async closeAll() { for (const s of [...sessions.values()]) { for (const r of s.perms.values()) r(null); s.child.kill(); } sessions.clear(); },
  };
}
