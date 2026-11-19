// Web dev mode: the app's renderer in a normal browser, without Electron.
//   pnpm --filter @hull/studio web -- --project <dir> [--port 5305]
// Runs the project server in Node (the same host code Electron's main process uses) and serves the renderer with Vite.
// Without --project the launcher shows, and templates are created in a scratch folder.
// With --electron it also starts the Electron window pointed at that Vite server (the `app` script).

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { createHost } from '../main/host.ts';
import type { OpenedProject } from '../shared/appApi.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (n: string): boolean => args.includes(`--${n}`);

const port = Number(flag('port') ?? 5305);
const dataDir = await mkdtemp(join(tmpdir(), 'hull-web-'));
const scratch = join(dataDir, 'projects');
await mkdir(scratch, { recursive: true });
const host = createHost({ dataDir, log: (l) => console.log(`[hull] ${l}`) });

let initial: OpenedProject | null = null;
const project = flag('project');
// pnpm runs this script inside packages/studio, so a relative --project is taken from where the command was typed.
if (project) initial = await host.openProject(resolve(process.env.INIT_CWD ?? process.cwd(), project));

const api: Record<string, (arg: never) => unknown> = {
  listTemplates: () => host.listTemplates(),
  scratchDir: () => scratch,
  createProject: (o: { template: string; title: string; parentDir: string }) => host.createProject(o),
  openProject: (root: string) => host.openProject(root),
  closeProject: () => host.closeProject(),
  recents: () => host.recents(),
  forgetRecent: (root: string) => host.forgetRecent(root),
  reveal: (path: string) => { console.log(`[hull] reveal ${path}`); },
  initialProject: () => { const p = initial; initial = null; return p; },
};

const server = await createServer({
  configFile: join(here, '../../vite.config.ts'),
  server: { port, strictPort: true, host: '127.0.0.1' },
  plugins: [{
    name: 'hull-web-api',
    configureServer(s) {
      s.middlewares.use('/__hull', (req, res) => {
        const name = (req.url ?? '').replace(/^\//, '').split('?')[0]!;
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          res.setHeader('content-type', 'application/json');
          try {
            const fn = api[name];
            if (!fn) throw new Error(`unknown call ${name}`);
            res.end(JSON.stringify({ result: (await fn((body ? JSON.parse(body) : null) as never)) ?? null }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        });
      });
    },
  }],
});
await server.listen();
const url = `http://127.0.0.1:${port}/`;
console.log(`[hull] renderer at ${url} (project server: ${await host.serverKind()})`);

if (has('electron')) {
  const electron = createRequire(import.meta.url)('electron') as string;
  const child = spawn(electron, [join(here, '../main/main.ts')], { stdio: 'inherit', env: { ...process.env, HULL_APP_URL: url, NODE_OPTIONS: '--import tsx' }, cwd: join(here, '../..') });
  child.on('exit', async () => { await host.closeProject(); await server.close(); process.exit(0); });
}

const stop = async (): Promise<void> => { await host.closeProject(); await server.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
