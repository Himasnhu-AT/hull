// How a process finds the project's server. One server per project: the app (or the first tool to need one) starts it
// and writes .hull/server.json; everyone after attaches. Two servers would fight over writes and file watchers.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { MethodName, Methods } from 'hull/dev/protocol';
import { connectProject, type ProjectClient } from '../control/client.ts';

const exec = promisify(execFile);

export interface ServerFile { url: string; gameUrl: string; pid: number }

const fileOf = (root: string): string => join(root, '.hull', 'server.json');

export function writeServerFile(root: string, info: ServerFile): void {
  mkdirSync(join(root, '.hull'), { recursive: true });
  writeFileSync(fileOf(root), `${JSON.stringify(info, null, 2)}\n`);
}

/** Only the process that wrote the file removes it: a newer server's file must survive an older one closing late. */
export function removeServerFile(root: string, pid: number): void {
  try {
    const f = JSON.parse(readFileSync(fileOf(root), 'utf8')) as Partial<ServerFile>;
    if (f.pid === pid) rmSync(fileOf(root), { force: true });
  } catch { /* already gone */ }
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * The running server's record, or undefined. A record is stale when its process is gone (a crash leaves the file
 * behind) or when nothing answers at its address (the pid was reused); a stale file is removed.
 */
export async function findServer(root: string): Promise<ServerFile | undefined> {
  let f: ServerFile;
  try { f = JSON.parse(readFileSync(fileOf(root), 'utf8')) as ServerFile; } catch { return undefined; }
  if (typeof f.url !== 'string' || typeof f.pid !== 'number') { rmSync(fileOf(root), { force: true }); return undefined; }
  if (alive(f.pid)) {
    try { (await connectProject(f.url, 3000)).close(); return f; } catch { /* nothing answers there */ }
  }
  rmSync(fileOf(root), { force: true });
  return undefined;
}

export interface ProjectLink {
  call(method: string, params: unknown): Promise<unknown>;
  /** True when the app (or another process) already had the project open and this link attached to it. */
  attached: boolean;
  url: string;
  gameUrl: string;
  close(): Promise<void>;
}

export interface LinkOptions {
  root: string;
  log?: (line: string) => void;
  /** The agent-browser executable used to open a headless game when `game.run` finds none connected. */
  browser?: string;
}

/** Attach to the project's server, or start one in this process. */
export async function openProject(o: LinkOptions): Promise<ProjectLink> {
  const log = o.log ?? (() => {});
  let own: { close(): Promise<void> } | undefined;
  let found = await findServer(o.root);
  let attached = true;
  if (!found) {
    const { startProjectServer } = await import('./index.ts');
    const s = await startProjectServer({ root: o.root, port: 0, log });
    own = s;
    found = { url: s.url, gameUrl: s.gameUrl, pid: process.pid };
    attached = false;
  }
  const server = found;
  const client: ProjectClient = await connectProject(server.url);
  const session = `hull-link-${process.pid}`;
  const browser = o.browser ?? 'agent-browser';
  let launching: Promise<void> | undefined;
  let launched = false;
  let gameId: string | undefined;

  // The game runs in a page. When nobody has one open (no app), open a headless one, once.
  const launchGame = (): Promise<void> => (launching ??= (async () => {
    const id = `link${process.pid}`;
    await exec(browser, ['--session', session, 'set', 'viewport', '640', '360'], { timeout: 60_000 });
    await exec(browser, ['--session', session, 'open', `${server.gameUrl}?hull-paused&hull-client=${id}`], { timeout: 60_000 });
    launched = true;
    for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 200))) {
      try { await client.call('game.run', { control: { op: 'state' }, client: id }); break; } catch (e) {
        if (Date.now() - t0 > 60_000) throw new Error(`the game did not connect within 60 s (${(e as Error).message})`);
      }
    }
    gameId = id;
  })());

  return {
    attached, url: server.url, gameUrl: server.gameUrl,
    async call(method, params) {
      const m = method as MethodName;
      if (m === 'game.run') {
        const p = params as Methods['game.run']['params'];
        try { return await client.call(m, p); } catch (e) {
          if (p.client || !/no game is connected/.test((e as Error).message)) throw e;
          log('no game is connected; opening a headless one');
          await launchGame();
          return client.call(m, { ...p, client: gameId });
        }
      }
      return client.call(m, params as never);
    },
    async close() {
      client.close();
      if (launched) await exec(browser, ['--session', session, 'close'], { timeout: 20_000 }).catch(() => {});
      await own?.close();
    },
  };
}
