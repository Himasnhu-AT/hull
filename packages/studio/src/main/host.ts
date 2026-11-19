// What the app does besides drawing: start a project server per open project, create projects from templates,
// remember recent projects. Shared by Electron's main process and the web dev mode, so both behave the same.
// Nothing here imports electron.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub, type Hub } from './agents.ts';
import { createSettingsStore, type KeyCrypto } from './agentSettings.ts';
import { createTerminals, type Terminals } from './terminal.ts';
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
  /** Agents (ACP) and the Claude Code terminal, working on the open project. */
  agents: Hub;
  terminals: Terminals;
  /** The builder's model and key (the key itself never leaves the main process). */
  agentSettings(): Promise<AgentSettings>;
  setAgentSettings(s: AgentSettingsInput): Promise<AgentSettings>;
  /** Subscribes to agent and terminal events; returns the unsubscribe. */
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
  /** The server module in use, for tests and the banner. */
  serverKind(): Promise<'real'>;
}

const MAX_RECENTS = 10;

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

    recents: readRecents,

    async forgetRecent(root) {
      const next = (await readRecents()).filter((r) => r.root !== root);
      await mkdir(opts.dataDir, { recursive: true });
      await writeFile(recentsFile, JSON.stringify(next, null, 2) + '\n');
    },

    async serverKind() { return (await load()).kind; },
  };
  return host;
}
