// An experiment's own game page: a small Vite dev server rooted at the experiment's working copy, so two experiments (and
// the project itself) can run side by side. Its game connects to the project server's socket with `?exp=<name>`, and the
// project server sends it only that experiment's edits.
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { readConfigFiles, readManifest } from '../tools/config.ts';
import { BOOT_ID, bootSource, DEV_PAGE } from '../server/boot.ts';
import { engineAliases, hullResolve, virtualModule } from '../server/vitePlugins.ts';
import type { ExpGames } from './history.ts';

export interface ExpGameServer {
  url: string;
  /** Text this process wrote to a .ts file: Vite must not hot-reload the page for it (the game already has the value). */
  wroteTs: Map<string, string>;
  invalidateBoot(): void;
  close(): Promise<void>;
}

export async function startExpGame(o: { root: string; dir: string; name: string; devUrl: string }): Promise<ExpGameServer> {
  const wroteTs = new Map<string, string>();
  const sources = () => [...(readManifest(o.dir) ? [readManifest(o.dir)!] : []), ...readConfigFiles(o.dir)];
  const manifest = (): { entry: string; features?: string[] } => JSON.parse(readManifest(o.dir)!.text) as { entry: string; features?: string[] };
  const vite: ViteDevServer = await createServer({
    root: o.dir,
    configFile: false,
    logLevel: 'warn',
    appType: 'custom',
    cacheDir: join(o.root, '.hull', 'cache', `vite-exp-${o.name}`),
    plugins: [
      hullResolve(),
      virtualModule(BOOT_ID, () => bootSource({ entry: manifest().entry, sources: sources(), devUrl: o.devUrl, features: manifest().features })),
      {
        name: 'hull-exp-server',
        async handleHotUpdate(ctx) {
          const mine = wroteTs.get(ctx.file);
          if (mine === undefined) return undefined;
          return (await ctx.read()) === mine ? [] : undefined;
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url !== '/' && req.url?.split('?')[0] !== '/index.html') return next();
            res.setHeader('content-type', 'text/html');
            res.setHeader('cache-control', 'no-store');
            res.end(await server.transformIndexHtml('/', DEV_PAGE));
          });
        },
      },
    ],
    optimizeDeps: { noDiscovery: true, include: ['ajv/dist/2020.js', 'three', 'typebox'] },
    resolve: { alias: engineAliases() },
    server: {
      port: 0,
      host: '127.0.0.1',
      fs: { allow: [o.dir, resolve(import.meta.dirname, '../../../..')] },
      // The copy lives under .hull/, which the project's own watcher ignores; this one must not.
      watch: { ignored: ['**/dist/**', '**/node_modules/**'] },
    },
  });
  await vite.listen();
  const addr = vite.httpServer!.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    wroteTs,
    invalidateBoot() {
      const mod = vite.moduleGraph.getModuleById(`\0${BOOT_ID}`);
      if (mod) vite.moduleGraph.invalidateModule(mod);
    },
    close: () => vite.close(),
  };
}

/** The set of running experiment pages, in the shape History wants. */
export function expGames(root: string, devUrl: () => string): ExpGames & { get(name: string): ExpGameServer | undefined; closeAll(): Promise<void> } {
  const running = new Map<string, ExpGameServer>();
  return {
    async start(name, dir) {
      const have = running.get(name);
      if (have) return have.url;
      const s = await startExpGame({ root, dir, name, devUrl: `${devUrl()}?exp=${encodeURIComponent(name)}` });
      running.set(name, s);
      return s.url;
    },
    async stop(name) {
      const s = running.get(name);
      running.delete(name);
      await s?.close();
    },
    url: (name) => running.get(name)?.url,
    get: (name) => running.get(name),
    async closeAll() { await Promise.all([...running.keys()].map((n) => this.stop(n))); },
  };
}
