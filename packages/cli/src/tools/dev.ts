import { createServer, type Plugin } from 'vite';
import { defineTool } from '../tool.ts';
import { BOOT_ID, bootSource, DEV_PAGE as PAGE } from '../server/boot.ts';
import { loadManifest, readConfigFiles, writeIds } from './config.ts';

const RESOLVED_BOOT = `\0${BOOT_ID}`;

/** The page the dev server serves. There is no index.html on disk: the manifest says where the game starts. */
export function bootModule(entry: string, sources: { path: string; text: string }[], opts: { devUrl?: string; features?: readonly string[] } = {}): string {
  return bootSource({ entry, sources, ...opts });
}

export interface DevInput { port?: number }
export interface DevOutput { url: string; ok: boolean; problems: [] }

export const dev = defineTool<DevInput, DevOutput>({
  name: 'dev',
  summary: 'Serves the game in a browser; reloads on code and config changes.',
  input: { type: 'object', properties: { port: { type: 'number' } } },
  output: { type: 'object', required: ['url'] },
  cli: { options: [{ name: 'port', flags: '--port <n>', description: 'Port to listen on' }] },
  format: (o) => [`Hull dev server: ${o.url}`],
  async run(ctx, input) {
    const manifest = await loadManifest(ctx.root);
    if (!manifest.value) throw new Error(manifest.problems.map((p) => `${p.file}#${p.pointer ?? ''}: ${p.message}`).join('\n') || 'invalid hull.json');
    const entry = manifest.value.entry;

    const refresh = async () => {
      const { createRegistry } = await import('hull');
      const registry = createRegistry();
      const r = registry.load(readConfigFiles(ctx.root));
      writeIds(ctx.root, registry.idsModule());
      for (const p of r.problems) ctx.log(`${p.file}#${p.pointer ?? ''}: ${p.message}`);
    };
    await refresh();

    const plugin: Plugin = {
      name: 'hull-dev',
      resolveId: (id) => (id === BOOT_ID ? RESOLVED_BOOT : undefined),
      load: (id) => (id === RESOLVED_BOOT ? bootModule(entry, readConfigFiles(ctx.root)) : undefined),
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== '/' && req.url !== '/index.html') return next();
          res.setHeader('content-type', 'text/html');
          res.end(await server.transformIndexHtml('/', PAGE));
        });
        // M0: any config change is a full reload. Live value updates come with the Studio.
        const onConfig = (file: string) => {
          if (!file.includes('/config/') || !file.endsWith('.json')) return;
          void refresh().then(() => {
            const mod = server.moduleGraph.getModuleById(RESOLVED_BOOT);
            if (mod) server.moduleGraph.invalidateModule(mod);
            server.ws.send({ type: 'full-reload' });
          });
        };
        server.watcher.on('change', onConfig).on('add', onConfig).on('unlink', onConfig);
      },
    };

    const server = await createServer({
      root: ctx.root,
      configFile: false,
      logLevel: 'warn',
      plugins: [plugin],
      server: { port: input.port, strictPort: false },
    });
    await server.listen();
    ctx.signal.addEventListener('abort', () => void server.close());
    const url = server.resolvedUrls?.local[0] ?? `http://localhost:${server.config.server.port}/`;
    return { url, ok: true, problems: [] };
  },
});
