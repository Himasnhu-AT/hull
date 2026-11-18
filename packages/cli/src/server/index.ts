// The project server: one HTTP port that serves the game's dev page (Vite) and, on the same port, the JSON-RPC
// WebSocket of dev/protocol.ts. The app's front end and every running game connect here; nothing outside this process
// touches the project's files (CLAUDE.md: the Studio never touches the disk).
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative, resolve } from 'node:path';
import type { ConfigSource, Problem } from 'hull';
import type { Author, Change, GameControl, LibraryItem, MethodName, Methods, ProjectInfo, PushName, Pushes, TunableWire, WriteResult } from 'hull/dev/protocol';
import { createServer, type ViteDevServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { loadManifest, readConfigFiles, readManifest, writeIds } from '../tools/config.ts';
import { tools } from '../tools/index.ts';
import { BOOT_ID, bootSource, DEV_PAGE } from './boot.ts';
import { setJsonPointer, valueAtPointer } from './jsonEdit.ts';
import { appendChange, readJournal } from './journal.ts';
import { findTunables, rewriteTunable, type FoundTunable } from './tsTunables.ts';
import { engineAliases, hullResolve, virtualModule } from './vitePlugins.ts';

export { createProject, listTemplates } from './templates.ts';
export { buildProject } from './build.ts';

export interface ProjectServer {
  /** ws:// URL of the protocol. */
  url: string;
  /** http:// URL of the game's dev page. */
  gameUrl: string;
  close(): Promise<void>;
}

interface Client { ws: WebSocket; role: 'studio' | 'game'; id: string }
type Handler<M extends MethodName> = (params: Methods[M]['params']) => Promise<Methods[M]['result']> | Methods[M]['result'];

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

const MANIFEST = 'hull.json';
const norm = (p: string): string => p.replace(/\\/g, '/');

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return out; }
  for (const n of names) {
    if (n === 'node_modules' || n === '.hull') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, accept, out); else if (accept(n)) out.push(p);
  }
  return out;
}

const isLoopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

export async function startProjectServer(opts: { root: string; port?: number; log?: (line: string) => void }): Promise<ProjectServer> {
  const root = resolve(opts.root);
  const log = opts.log ?? (() => {});
  const manifestInfo = await loadManifest(root);
  if (!manifestInfo.value) throw new Error(manifestInfo.problems.map((p) => `${p.file}#${p.pointer ?? ''}: ${p.message}`).join('\n') || 'invalid hull.json');
  const { createRegistry } = await import('hull');
  const { kinds, manifestSchema } = await import('hull/schema');

  const clients = new Set<Client>();
  // The text of every config file as the server last knew it, so a disk event that carries nothing new is ignored.
  const texts = new Map<string, string>();
  // The text this server itself wrote to a .ts file. Its write is already live in the game, so it must not reload it.
  const wroteTs = new Map<string, string>();
  // writeFileSync truncates before it writes, so a watcher can read the file half-written. That read matched neither
  // the old nor the new text, so the server's own tunable write was taken for a hand edit and Vite reloaded the
  // page. Writing beside .hull and renaming into place means a reader only ever sees a whole file.
  let tmpN = 0;
  const writeWhole = (abs: string, text: string): void => {
    const dir = join(root, '.hull', 'tmp');
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `write-${process.pid}-${tmpN++}`);
    writeFileSync(tmp, text);
    renameSync(tmp, abs);
  };
  let problems: Problem[] = [];

  const pushTo = (role: Client['role'] | 'all', method: PushName, params: unknown): void => {
    const data = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const c of clients) if ((role === 'all' || c.role === role) && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  };
  const push = <K extends PushName>(method: K, params: Pushes[K], role: Client['role'] | 'all' = 'all'): void => pushTo(role, method, params);

  const configFiles = (): ConfigSource[] => {
    const m = readManifest(root);
    return [...(m ? [m] : []), ...readConfigFiles(root)];
  };

  /** Validates everything (a fresh registry each time: it is cheap, and it keeps the answers free of old state). */
  const revalidate = (): void => {
    const files = configFiles();
    texts.clear();
    for (const f of files) texts.set(f.path, f.text);
    const registry = createRegistry();
    const r = registry.load(files);
    writeIds(root, registry.idsModule());
    const before = JSON.stringify(problems);
    problems = r.problems;
    if (JSON.stringify(problems) !== before) push('problems', { problems }, 'studio');
  };
  revalidate();

  // ---- Vite: the game's dev page --------------------------------------------------------------------------------
  let urls = { http: '', ws: '' };
  const vite: ViteDevServer = await createServer({
    root,
    configFile: false,
    logLevel: 'warn',
    appType: 'custom',
    // Anything Hull keeps for itself goes under .hull/.
    cacheDir: join(root, '.hull', 'cache', 'vite'),
    plugins: [
      hullResolve(),
      virtualModule(BOOT_ID, () => bootSource({ entry: manifestInfo.value!.entry, sources: configFiles(), devUrl: urls.ws, features: (JSON.parse(readManifest(root)!.text) as { features?: string[] }).features })),
      {
        name: 'hull-project-server',
        // A tunable write is already applied to the running game through `tunable.changed`. Letting Vite hot-update the
        // module would reload the page and throw that state away, so the one write the server made itself is dropped
        // from HMR. Its module is still invalidated by Vite before this hook, so the next reload reads the new file.
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
    // The engine's own dependencies live beside it, not in the project, so they are aliased to their files in the engine's folder. Pre-bundling them
    // up front means the first page load never discovers one late and reloads itself. Ajv is CommonJS and typebox is
    // hundreds of small files; neither can be served as it is.
    optimizeDeps: { noDiscovery: true, include: ['ajv/dist/2020.js', 'three', 'typebox'] },
    resolve: { alias: engineAliases() },
    server: {
      port: opts.port ?? 0,
      strictPort: opts.port !== undefined,
      host: '127.0.0.1',
      fs: { allow: [root, resolve(import.meta.dirname, '../../../..')] },
      watch: { ignored: ['**/.hull/**', '**/dist/**', '**/node_modules/**'] },
    },
  });
  await vite.listen();
  const addr = vite.httpServer!.address() as AddressInfo;
  urls = { http: `http://127.0.0.1:${addr.port}/`, ws: `ws://127.0.0.1:${addr.port}/` };

  const invalidateBoot = (): void => {
    const mod = vite.moduleGraph.getModuleById(`\0${BOOT_ID}`);
    if (mod) vite.moduleGraph.invalidateModule(mod);
  };

  // ---- Config -----------------------------------------------------------------------------------------------------
  const pathOf = (id: string): string => {
    if (id === MANIFEST) return MANIFEST;
    if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)+$/.test(id) || id.includes('..')) throw new RpcError(-32602, `"${id}" is not a config id like 'sound/sword/hit'`);
    return `config/${id}.json`;
  };
  const idOf = (path: string): string => (path === MANIFEST ? MANIFEST : path.slice('config/'.length, -'.json'.length));
  const kindOfPath = (path: string): string => (path === MANIFEST ? 'game' : path.split('/')[1] ?? '');
  const readText = (path: string): string => {
    try { return readFileSync(join(root, path), 'utf8'); } catch { throw new RpcError(-32001, `${path} does not exist`); }
  };
  const key = (p: Problem): string => `${p.file}|${p.pointer ?? ''}|${p.rule}|${p.message}`;

  /** The problems a file would have if it held `text`, without touching the live state. */
  const problemsWith = (path: string, text: string): Problem[] => {
    const files = configFiles().filter((f) => f.path !== path);
    files.push({ path, text });
    return createRegistry().load(files).problems.filter((p) => p.file === path);
  };

  const setConfig: Handler<'config.set'> = (p) => {
    const path = pathOf(p.id);
    const old = readText(path);
    const edited = setJsonPointer(old, p.pointer, p.value);
    if (!edited.ok) return { ok: false, problems: [{ file: path, pointer: p.pointer, rule: 'edit', message: edited.message }] };
    // A write may not add a problem. A file that was already broken elsewhere can still be fixed one field at a time.
    const known = new Set(problems.filter((x) => x.file === path).map(key));
    const added = problemsWith(path, edited.text).filter((x) => !known.has(key(x)));
    if (added.length) return { ok: false, problems: added };

    let from: unknown;
    try { from = valueAtPointer(JSON.parse(old), p.pointer); } catch { /* the old file did not parse */ }
    writeWhole(join(root, path), edited.text);
    texts.set(path, edited.text);
    invalidateBoot();
    journal({ target: idOf(path), path: p.pointer, from, to: p.value, by: p.author ?? 'you' });
    revalidate();
    push('config.changed', { id: idOf(path), path, text: edited.text });
    return { ok: true, problems: [] };
  };

  const journal = (c: { target: string; path: string; from: unknown; to: unknown; by: Author }): void => {
    // A drag ends by sending the value it already set; a write that changes nothing is not a change.
    if (JSON.stringify(c.from) === JSON.stringify(c.to)) return;
    const change: Change = { at: new Date().toISOString(), by: c.by, target: c.target, path: c.path, from: c.from, to: c.to };
    appendChange(root, change);
    push('journal.added', change);
  };

  // ---- Tunables ---------------------------------------------------------------------------------------------------
  const scanTunables = (): (FoundTunable & { file: string })[] => {
    const out: (FoundTunable & { file: string })[] = [];
    for (const abs of walk(join(root, 'src'), (n) => n.endsWith('.ts') && !n.endsWith('.d.ts') && !n.endsWith('.test.ts'))) {
      const file = norm(relative(root, abs));
      let text: string;
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      if (!text.includes('tunables')) continue;
      for (const b of findTunables(file, text)) for (const t of b.tunables) out.push({ ...t, file });
    }
    return out;
  };

  const setTunableValue: Handler<'tunables.set'> = (p) => {
    const t = scanTunables().find((x) => x.block === p.block && x.key === p.key);
    if (!t) return { ok: false, problems: [{ file: 'src', rule: 'tunable', message: `there is no literal tunable "${p.block}.${p.key}" in src/` }] };
    const abs = join(root, t.file);
    const r = rewriteTunable(t.file, readFileSync(abs, 'utf8'), p.block, p.key, p.value);
    if (!r.ok) return { ok: false, problems: [{ file: t.file, pointer: `/${p.block}/${p.key}`, line: r.line ?? t.line, col: r.col ?? t.col, rule: 'tunable', message: r.message }] };
    wroteTs.set(abs, r.text);
    writeWhole(abs, r.text);
    journal({ target: `tunables:${p.block}`, path: p.key, from: t.value, to: p.value, by: p.author ?? 'you' });
    push('tunable.changed', { block: p.block, key: p.key, value: p.value }, 'game');
    return { ok: true, problems: [] };
  };

  const tunableWires = (): TunableWire[] =>
    scanTunables().map((t) => ({ block: t.block, key: t.key, kind: t.kind, value: t.value, opts: t.opts, file: t.file, line: t.line, col: t.col }));

  // ---- Methods ----------------------------------------------------------------------------------------------------
  const methods: { [M in MethodName]: Handler<M> } = {
    'project.info': (): ProjectInfo => {
      const m = readManifest(root)!;
      let manifest: unknown;
      try { manifest = JSON.parse(m.text); } catch { /* shown as a problem */ }
      return { root, title: (manifest as { title?: string } | undefined)?.title ?? 'Untitled', gameUrl: urls.http, manifest };
    },
    'library.list': (): LibraryItem[] => {
      const items: LibraryItem[] = [];
      for (const [path, text] of texts) {
        let v: Record<string, unknown> = {};
        try { v = JSON.parse(text) as Record<string, unknown>; } catch { /* listed with its problems */ }
        const id = idOf(path);
        items.push({
          id, kind: kindOfPath(path), path,
          title: typeof v['title'] === 'string' ? v['title'] : id,
          ...(typeof v['note'] === 'string' ? { note: v['note'] } : {}),
          problems: problems.filter((x) => x.file === path).length,
        });
      }
      const seen = new Set<string>();
      for (const t of scanTunables()) {
        if (seen.has(t.block)) continue;
        seen.add(t.block);
        items.push({ id: `tunables:${t.block}`, kind: 'tunables', path: t.file, title: t.block, problems: 0 });
      }
      return items;
    },
    'config.read': (p) => {
      const path = pathOf(p.id);
      const text = readText(path);
      let value: unknown;
      try { value = JSON.parse(text); } catch { /* problems say why */ }
      const kind = kindOfPath(path);
      const schema = kind === 'game' ? manifestSchema : kinds[kind];
      return { id: p.id, path, text, value, schema: schema ? JSON.parse(JSON.stringify(schema)) : null, problems: problems.filter((x) => x.file === path) };
    },
    'config.set': setConfig,
    'tunables.list': tunableWires,
    'tunables.set': setTunableValue,
    'journal.list': (p) => readJournal(root, p.limit),
    'game.control': (p: GameControl) => { push('game.control', p, 'game'); return {}; },
    'tool.call': async (p) => {
      const tool = tools.find((t) => t.name === p.name && t.name !== 'dev');
      if (!tool) throw new RpcError(-32602, `there is no tool "${p.name}" (have: ${tools.filter((t) => t.name !== 'dev').map((t) => t.name).join(', ')})`);
      const out = await tool.run({ root, author: 'you', log: (line) => push('log', { level: 'info', message: line, source: 'tool' }, 'studio'), signal: new AbortController().signal }, p.input ?? {});
      const probs = (out as { problems?: Problem[] } | null)?.problems ?? [];
      return { ok: (out as { ok?: boolean } | null)?.ok ?? probs.length === 0, output: out, problems: probs };
    },
  };

  // ---- The socket -------------------------------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  vite.httpServer!.on('upgrade', (req: IncomingMessage, socket, head) => {
    // Vite's own hot-reload socket announces its protocol; everything else with a role is ours.
    if (String(req.headers['sec-websocket-protocol'] ?? '').includes('vite-')) return;
    const url = new URL(req.url ?? '/', 'http://x');
    const role = url.searchParams.get('role');
    // Any web page can open a socket to localhost, and this one can write files. Only the app's own origins get in.
    const origin = req.headers.origin;
    let allowed = origin === undefined || origin === 'null' || origin.startsWith('file:') || origin.startsWith('app:');
    if (!allowed && origin) { try { allowed = isLoopback(new URL(origin).hostname === '::1' ? '[::1]' : new URL(origin).hostname); } catch { allowed = false; } }
    if (!allowed || (role !== 'studio' && role !== 'game')) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, role, id: url.searchParams.get('client') ?? Math.random().toString(36).slice(2, 8) };
      clients.add(client);
      ws.on('close', () => clients.delete(client));
      ws.on('message', (data) => void onMessage(client, String(data)));
    });
  });

  const onMessage = async (client: Client, raw: string): Promise<void> => {
    let msg: { id?: number | string; method?: string; params?: unknown };
    try { msg = JSON.parse(raw) as typeof msg; } catch { client.ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })); return; }
    if (client.role === 'game') {
      // Games only talk; their reports and logs go to the studios.
      if (msg.method === 'game.report') push('game.report', { ...(msg.params as Pushes['game.report']), client: client.id }, 'studio');
      else if (msg.method === 'log') push('log', msg.params as Pushes['log'], 'studio');
      return;
    }
    if (msg.id === undefined) return;
    const reply = (body: object): void => { if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body })); };
    const handler = methods[msg.method as MethodName] as ((p: unknown) => unknown) | undefined;
    if (!handler) { reply({ error: { code: -32601, message: `unknown method "${msg.method}"` } }); return; }
    try { reply({ result: await handler(msg.params ?? {}) }); } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError(-32000, e instanceof Error ? e.message : String(e));
      reply({ error: { code: err.code, message: err.message } });
    }
  };

  // ---- Files changing on disk (an editor, an agent, git) ------------------------------------------------------------
  const onDisk = (event: 'change' | 'add' | 'unlink', abs: string): void => {
    const rel = norm(relative(root, abs));
    if (rel === MANIFEST || (rel.startsWith('config/') && rel.endsWith('.json'))) {
      if (event === 'unlink') {
        texts.delete(rel); invalidateBoot(); revalidate();
        push('config.removed', { id: idOf(rel), path: rel });
        return;
      }
      let text: string;
      try { text = readFileSync(abs, 'utf8'); } catch { return; }
      if (texts.get(rel) === text) return;
      invalidateBoot();
      revalidate();
      // A file with problems is reported, not pushed: the running game keeps its last good value.
      if (problems.some((x) => x.file === rel)) log(`${rel} has problems; the game keeps the last good value`);
      else push('config.changed', { id: idOf(rel), path: rel, text });
    } else if (rel.startsWith('src/') && rel.endsWith('.ts')) {
      let text: string | undefined;
      try { text = readFileSync(abs, 'utf8'); } catch { /* deleted */ }
      if (text !== undefined && wroteTs.get(abs) === text) return;
      wroteTs.delete(abs);
      push('source.changed', { path: rel });
    }
  };
  vite.watcher.on('change', (f) => onDisk('change', f)).on('add', (f) => onDisk('add', f)).on('unlink', (f) => onDisk('unlink', f));
  // Directories that did not exist at start (a new project's first config/ folder) are picked up too.
  vite.watcher.add([join(root, 'config'), join(root, 'src'), join(root, MANIFEST)]);
  mkdirSync(join(root, '.hull'), { recursive: true });
  log(`project server for ${root}: ${urls.http}`);

  return {
    url: urls.ws,
    gameUrl: urls.http,
    async close() {
      for (const c of clients) c.ws.close();
      wss.close();
      await vite.close();
    },
  };
}
