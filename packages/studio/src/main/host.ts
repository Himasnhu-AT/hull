// What the app does besides drawing: start a project server per open project, create projects from templates,
// remember recent projects. Shared by Electron's main process and the web dev mode, so both behave the same.
// Nothing here imports electron.

import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub, type Hub } from './agents.ts';
import { createSettingsStore, type KeyCrypto } from './agentSettings.ts';
import { createTerminals, type Terminals } from './terminal.ts';
import { createAccounts, type Accounts, type Runner } from './accounts.ts';
import { pickTemplate, titleFromIdea } from './idea.ts';
import type { AgentEvent, AgentSettings, AgentSettingsInput } from '../shared/agentApi.ts';
import type { CommunityGame, OpenedProject, RecentProject, TemplateInfo } from '../shared/appApi.ts';

interface ProjectServer { url: string; gameUrl: string; close(): Promise<void> }
interface McpModule {
  createMcpServer(root: string, o?: { log?: (line: string) => void }): { close(): Promise<void> };
  startMcpHttp(server: unknown, o?: { port?: number }): Promise<{ url: string; close(): Promise<void> }>;
}
interface ServerModule {
  startProjectServer(opts: { root: string; port?: number; log?: (line: string) => void }): Promise<ProjectServer>;
  listTemplates(): TemplateInfo[];
  createProject(opts: { template: string; dir: string; title: string }): Promise<{ root: string }>;
  listCommunity(opts: { projectsDir: string }): CommunityGame[];
  openCommunity(opts: { id: string; projectsDir: string; reset?: boolean }): { root: string; created: boolean };
}

export interface HostOptions {
  /** Where recents live (Electron's userData). */
  dataDir: string;
  log?: (line: string) => void;
  /** Env the agents and the terminal start with (tests); defaults to the process's. */
  env?: NodeJS.ProcessEnv;
  /** Where the builder's key can be kept safely (Electron's safeStorage). Without it the environment decides. */
  crypto?: KeyCrypto;
  /** Moves a folder to the system Trash (Electron's shell.trashItem). Without it, moving to the Trash is refused. */
  trash?: (path: string) => Promise<void>;
  /** Runs a protocol method on a project (config.set for a rename); defaults to @hull/tools' runTool. Tests pass a fake. */
  runTool?: (root: string, name: string, input: unknown) => Promise<unknown>;
  /** Runs Claude Code's and Codex's own commands for Settings (tests pass a fake). */
  run?: Runner;
}

export interface Host {
  listTemplates(): Promise<TemplateInfo[]>;
  listCommunity(): Promise<CommunityGame[]>;
  openCommunity(id: string, reset?: boolean): Promise<OpenedProject>;
  createProject(opts: { template: string; title: string; parentDir: string }): Promise<OpenedProject>;
  /** The idea box: picks the closest template, makes the project in the app's own projects folder and opens it. */
  createFromIdea(idea: string): Promise<OpenedProject & { idea: string }>;
  openProject(root: string): Promise<OpenedProject>;
  closeProject(): Promise<void>;
  recents(): Promise<RecentProject[]>;
  forgetRecent(root: string): Promise<void>;
  renameProject(root: string, title: string): Promise<string>;
  trashProject(root: string): Promise<void>;
  saveThumb(root: string, jpeg: string): Promise<void>;
  openClaude(prompt?: string): Promise<void>;
  /** Agents (ACP) and the Claude Code terminal, working on the open project. */
  agents: Hub;
  terminals: Terminals;
  /** Claude Code and Codex as Settings sees them: installed, signed in, connected to this project. */
  accounts: Accounts;
  /** The builder's model and key (the key itself never leaves the main process). */
  agentSettings(): Promise<AgentSettings>;
  setAgentSettings(s: AgentSettingsInput): Promise<AgentSettings>;
  /** Subscribes to agent and terminal events; returns the unsubscribe. */
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
  /** The server module in use, for tests and the banner. */
  serverKind(): Promise<'real'>;
}

const MAX_RECENTS = 10;
const COVERS: [string, string][] = [['cover.webp', 'image/webp'], ['cover.jpg', 'image/jpeg'], ['cover.png', 'image/png'], ['.hull/thumb.jpg', 'image/jpeg']];
/** Covers above this size are skipped: the launcher shows a dozen at once. */
const MAX_COVER = 1_500_000;

/** A game's picture for the launcher, as a data: URL, or null. */
export async function coverOf(root: string): Promise<string | null> {
  for (const [f, mime] of COVERS) {
    const p = join(root, f);
    try {
      if ((await stat(p)).size > MAX_COVER) continue;
      return `data:${mime};base64,${(await readFile(p)).toString('base64')}`;
    } catch { /* not there: try the next */ }
  }
  return null;
}

/** "My First Game!" -> "my-first-game": a folder name that works everywhere. */
export function slug(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
}

export function createHost(opts: HostOptions): Host {
  const log = opts.log ?? (() => {});
  // Community copies live with the projects the app makes itself, never in the repository.
  const projectsDir = join(opts.dataDir, 'projects');
  const recentsFile = join(opts.dataDir, 'recents.json');
  let loaded: { mod: ServerModule; mcp: McpModule; kind: 'real' } | null = null;
  let running: { root: string; server: ProjectServer; mcp: { url: string; close(): Promise<void> }; mcpServer: { close(): Promise<void> } } | null = null;

  const listeners = new Set<(e: AgentEvent) => void>();
  const emit = (e: AgentEvent): void => { for (const l of listeners) { try { l(e); } catch { /* a dead window must not stop the others */ } } };
  const current = (): { root: string; mcp: { url: string; launcher: string } } | null =>
    running ? { root: running.root, mcp: { url: running.mcp.url, launcher: fileURLToPath(new URL('../../../tools/bin/hull-mcp.js', import.meta.url)) } } : null;
  const settings = createSettingsStore({ dataDir: opts.dataDir, crypto: opts.crypto, env: opts.env });
  const hub = createHub({ project: current, emit, log, settings, ...(opts.env ? { env: opts.env } : {}) });
  const terminals = createTerminals({ project: current, emit, ...(opts.env ? { env: opts.env } : {}) });
  const accounts = createAccounts({ project: current, ...(opts.env ? { env: opts.env } : {}), ...(opts.run ? { run: opts.run } : {}) });

  async function load(): Promise<{ mod: ServerModule; mcp: McpModule; kind: 'real' }> {
    if (loaded) return loaded;
    return (loaded = { mod: (await import('@hull/tools/server')) as ServerModule, mcp: (await import('@hull/tools/mcp')) as McpModule, kind: 'real' });
  }

  async function readRecents(): Promise<RecentProject[]> {
    try {
      const list = JSON.parse(await readFile(recentsFile, 'utf8')) as RecentProject[];
      return Array.isArray(list) ? list.filter((r) => typeof r?.root === 'string') : [];
    } catch { return []; }
  }

  async function remember(p: OpenedProject): Promise<void> {
    const rest = (await readRecents()).filter((r) => r.root !== p.root);
    const next = [{ root: p.root, title: p.title, openedAt: new Date().toISOString() }, ...rest].slice(0, MAX_RECENTS);
    await mkdir(opts.dataDir, { recursive: true });
    await writeFile(recentsFile, JSON.stringify(next, null, 2) + '\n');
  }

  async function titleOf(root: string): Promise<string> {
    try {
      const t = (JSON.parse(await readFile(join(root, 'hull.json'), 'utf8')) as { title?: unknown }).title;
      if (typeof t === 'string' && t) return t;
    } catch { /* a mock project, or a folder that is not a project yet: the folder name will do */ }
    return basename(root);
  }

  const host: Host = {
    agents: hub,
    terminals,
    accounts,
    agentSettings: () => settings.get(),
    async setAgentSettings(s) { const r = await settings.set(s); await hub.stopEnsured(); return r; },
    onAgentEvent(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },

    async listTemplates() { return (await load()).mod.listTemplates(); },

    async listCommunity() { return (await load()).mod.listCommunity({ projectsDir }); },

    async openCommunity(id, reset) {
      const { mod } = await load();
      // A reset replaces the folder under a running server, so the project is closed first.
      if (reset) await host.closeProject();
      const { root } = mod.openCommunity({ id, projectsDir, ...(reset ? { reset: true } : {}) });
      return host.openProject(root);
    },

    async createProject({ template, title, parentDir }) {
      const { mod } = await load();
      const { root } = await mod.createProject({ template, title, dir: join(parentDir, slug(title)) });
      return host.openProject(root);
    },

    async createFromIdea(idea) {
      const text = idea.trim();
      if (!text) throw new Error('Say what game you want to make first.');
      const { mod } = await load();
      const title = titleFromIdea(text);
      // A second game with the same name gets its own folder; the person never chooses one.
      let dir = join(projectsDir, slug(title)), n = 2;
      while (existsSync(dir)) dir = join(projectsDir, `${slug(title)}-${n++}`);
      const { root } = await mod.createProject({ template: pickTemplate(text), title, dir });
      return { ...(await host.openProject(root)), idea: text };
    },

    async openProject(root) {
      await host.closeProject();
      const { mod, mcp: mcpMod } = await load();
      const server = await mod.startProjectServer({ root, log });
      // The app hosts the MCP server for the open project, so a local agent works on the project the person has open.
      // A port that depends on the folder keeps `claude mcp add` valid across restarts; if it is taken, any free one will do.
      const mcpServer = mcpMod.createMcpServer(root, { log });
      let preferred = 0; for (const c of root) preferred = (preferred * 31 + c.charCodeAt(0)) % 100;
      const http = await mcpMod.startMcpHttp(mcpServer, { port: 5400 + preferred }).catch(() => mcpMod.startMcpHttp(mcpServer, { port: 0 }));
      running = { root, server, mcp: http, mcpServer };
      const launcher = fileURLToPath(new URL('../../../tools/bin/hull-mcp.js', import.meta.url));
      log(`MCP for agents: ${http.url}`);
      const opened: OpenedProject = { root, title: await titleOf(root), url: server.url, gameUrl: server.gameUrl, mcp: { url: http.url, launcher } };
      await remember(opened);
      return opened;
    },

    async closeProject() {
      const r = running;
      // Agents and the terminal work on the project that is closing.
      await hub.closeAll(); terminals.closeAll();
      running = null;
      if (r) { await r.mcp.close(); await r.mcpServer.close(); await r.server.close(); }
    },

    async recents() { return Promise.all((await readRecents()).map(async (r) => ({ ...r, cover: await coverOf(r.root) }))); },

    async renameProject(root, title) {
      const t = title.trim().replace(/\s+/g, ' ');
      if (!t) throw new Error('A game needs a name.');
      if (t.length > 80) throw new Error('Keep the name under 80 characters.');
      const list = await readRecents();
      if (!list.some((r) => r.root === root)) throw new Error('That game is not in Recent.');
      // The title lives in hull.json: the same validated write the editor makes, recorded in the history as yours.
      const run = opts.runTool ?? (async (r: string, n: string, i: unknown) => (await import('@hull/tools')).runTool(r, n, i, { author: 'you' }));
      const out = await run(root, 'config.set', { id: 'hull.json', pointer: '/title', value: t, author: 'you' }) as { ok?: boolean; written?: boolean; problems?: { message: string }[] } | null;
      if (!out || out.ok === false || out.written === false || (out.problems?.length ?? 0) > 0) throw new Error(out?.problems?.map((p) => p.message).join('; ') || `The name was not kept (${JSON.stringify(out).slice(0, 200)}).`);
      await mkdir(opts.dataDir, { recursive: true });
      await writeFile(recentsFile, JSON.stringify(list.map((r) => (r.root === root ? { ...r, title: t } : r)), null, 2) + '\n');
      return t;
    },

    async trashProject(root) {
      if (!opts.trash) throw new Error('Moving a game to the Trash works in the Hull app, not in a browser.');
      const list = await readRecents();
      if (!list.some((r) => r.root === root)) throw new Error('That game is not in Recent.');
      if (!existsSync(join(root, 'hull.json'))) throw new Error('That folder is not a Hull game, so it was left alone.');
      if (running?.root === root) await host.closeProject();
      await opts.trash(root);
      await host.forgetRecent(root);
    },

    async openClaude(prompt) {
      if (process.platform !== 'darwin') throw new Error('Opening Terminal for you works on macOS. Run the folder line yourself.');
      if (!running) throw new Error('Open a game first.');
      if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > 8000)) throw new Error('The first message is too long.');
      const claude = (await import('./agents.ts')).which('claude', opts.env ?? process.env);
      if (!claude) throw new Error('Claude Code was not found on this Mac. Install it first: npm install -g @anthropic-ai/claude-code');
      // A .command file is what Terminal opens with a double-click: the person's own claude, unmodified, in its own window (D15).
      const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
      const dir = join(running.root, '.hull', 'tmp');
      await mkdir(dir, { recursive: true });
      const file = join(dir, 'open-claude.command');
      await writeFile(file, `#!/bin/sh\ncd ${q(running.root)} || exit 1\nexec ${q(claude)}${prompt ? ` ${q(prompt)}` : ''}\n`, { mode: 0o755 });
      const { spawn } = await import('node:child_process');
      await new Promise<void>((res, rej) => { const c = spawn('open', ['-a', 'Terminal', file]); c.on('error', rej); c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`Terminal did not open (${code}).`)))); });
    },

    async saveThumb(root, jpeg) {
      const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(jpeg);
      if (!m) throw new Error('A thumbnail is a JPEG data: URL.');
      const bytes = Buffer.from(m[1]!, 'base64');
      if (bytes.length > 400_000) throw new Error('That thumbnail is too big.');
      // Only for the game that is open: a page cannot write pictures into any folder it names.
      if (running?.root !== root) throw new Error('Only the open game keeps a thumbnail.');
      await mkdir(join(root, '.hull'), { recursive: true });
      await writeFile(join(root, '.hull', 'thumb.jpg'), bytes);
    },

    async forgetRecent(root) {
      const next = (await readRecents()).filter((r) => r.root !== root);
      await mkdir(opts.dataDir, { recursive: true });
      await writeFile(recentsFile, JSON.stringify(next, null, 2) + '\n');
    },

    async serverKind() { return (await load()).kind; },
  };
  return host;
}
