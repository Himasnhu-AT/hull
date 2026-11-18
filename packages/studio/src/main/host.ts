// What the app does besides drawing: start a project server per open project, create projects from templates,
// remember recent projects. Shared by Electron's main process and the web dev mode, so both behave the same.
// Nothing here imports electron.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { OpenedProject, RecentProject, TemplateInfo } from '../shared/appApi.ts';

interface ProjectServer { url: string; gameUrl: string; close(): Promise<void> }
interface ServerModule {
  startProjectServer(opts: { root: string; port?: number; log?: (line: string) => void }): Promise<ProjectServer>;
  listTemplates(): TemplateInfo[];
  createProject(opts: { template: string; dir: string; title: string }): Promise<{ root: string }>;
}

export interface HostOptions {
  /** Where recents live (Electron's userData). */
  dataDir: string;
  log?: (line: string) => void;
}

export interface Host {
  listTemplates(): Promise<TemplateInfo[]>;
  createProject(opts: { template: string; title: string; parentDir: string }): Promise<OpenedProject>;
  openProject(root: string): Promise<OpenedProject>;
  closeProject(): Promise<void>;
  recents(): Promise<RecentProject[]>;
  forgetRecent(root: string): Promise<void>;
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
  const recentsFile = join(opts.dataDir, 'recents.json');
  let loaded: { mod: ServerModule; kind: 'real' } | null = null;
  let running: { root: string; server: ProjectServer } | null = null;

  async function load(): Promise<{ mod: ServerModule; kind: 'real' }> {
    if (loaded) return loaded;
    return (loaded = { mod: (await import('@hull/cli/server')) as ServerModule, kind: 'real' });
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
    async listTemplates() { return (await load()).mod.listTemplates(); },

    async createProject({ template, title, parentDir }) {
      const { mod } = await load();
      const { root } = await mod.createProject({ template, title, dir: join(parentDir, slug(title)) });
      return host.openProject(root);
    },

    async openProject(root) {
      await host.closeProject();
      const { mod } = await load();
      const server = await mod.startProjectServer({ root, log });
      running = { root, server };
      const opened: OpenedProject = { root, title: await titleOf(root), url: server.url, gameUrl: server.gameUrl };
      await remember(opened);
      return opened;
    },

    async closeProject() {
      const r = running;
      running = null;
      if (r) await r.server.close();
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
