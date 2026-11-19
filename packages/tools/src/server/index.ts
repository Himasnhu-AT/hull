// The project server: one HTTP port that serves the game's dev page (Vite) and, on the same port, the JSON-RPC
// WebSocket of dev/protocol.ts. The app's front end and every running game connect here; nothing outside this process
// touches the project's files (CLAUDE.md: the Studio never touches the disk).
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
import { expGames } from '../history/expServer.ts';
import { History } from '../history/history.ts';
import { removeServerFile, writeServerFile } from './link.ts';
import { appendChange, readJournal } from './journal.ts';
import { listReview, noteReview, setReview } from '../review/store.ts';
import { findTunables, rewriteTunable, type FoundTunable } from './tsTunables.ts';
import { kitImports, kitTunables } from './kitTunables.ts';
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

/** `exp` is set for a game page that belongs to an experiment: it hears only that experiment's edits. */
interface Client { ws: WebSocket; role: 'studio' | 'game'; id: string; exp?: string }
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

/** Line and column (1-based) of `"key"` in a JSON text, for a problem about its value. */
function locateKey(text: string, key: string): { line: number; col: number } | Record<string, never> {
  const at = text.indexOf(`"${key}"`);
  if (at < 0) return {};
  const before = text.slice(0, at);
  const line = before.split('\n').length;
  return { line, col: at - before.lastIndexOf('\n') };
}

const isLoopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

export async function startProjectServer(opts: { root: string; port?: number; log?: (line: string) => void; /** Quiet time before edits are recorded in the history (default 2000 ms; tests use 0). */ historyQuietMs?: number }): Promise<ProjectServer> {
  // The real path: Vite and the file watcher report real paths (on macOS /var is /private/var), and the server's
  // record of its own writes is keyed by path, so a symlinked root made every tunable write look like a hand edit
  // and reload the game.
  const root = realpathSync(resolve(opts.root));
  const log = opts.log ?? (() => {});
  const manifestInfo = await loadManifest(root);
  if (!manifestInfo.value) throw new Error(manifestInfo.problems.map((p) => `${p.file}#${p.pointer ?? ''}: ${p.message}`).join('\n') || 'invalid hull.json');
  const { createRegistry, tuningIdOf, tunableProblem } = await import('hull');
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
  // AI changes over values the person set (history/authors.ts). Kept apart from `problems`: a config file's own
  // problems must not change when history does, and config.set judges a write only against the file's own problems.
  let authorship: Problem[] = [];
  let pushedProblems = '';
  const allProblems = (): Problem[] => [...problems, ...authorship];
  const pushProblems = (): void => {
    const now = JSON.stringify(allProblems());
    if (now === pushedProblems) return;
    pushedProblems = now;
    push('problems', { problems: allProblems() }, 'studio');
  };

  // `exp` picks which games hear a push: the project's own (undefined), one experiment's, or every game ('*').
  const pushTo = (role: Client['role'] | 'all', method: PushName, params: unknown, exp?: string): void => {
    const data = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const c of clients) {
      if (!(role === 'all' || c.role === role) || c.ws.readyState !== WebSocket.OPEN) continue;
      if (c.role === 'game' && exp !== '*' && c.exp !== exp) continue;
      c.ws.send(data);
    }
  };
  const push = <K extends PushName>(method: K, params: Pushes[K], role: Client['role'] | 'all' = 'all', exp?: string): void => pushTo(role, method, params, exp);

  const configFilesIn = (dir: string): ConfigSource[] => {
    const m = readManifest(dir);
    return [...(m ? [m] : []), ...readConfigFiles(dir)];
  };
  const configFiles = (): ConfigSource[] => configFilesIn(root);

  let hist!: History;
  let urls = { http: '', ws: '' };
  const games = expGames(root, () => urls.ws);

  /** Validates everything (a fresh registry each time: it is cheap, and it keeps the answers free of old state). */
  // Set once the kit scan below exists; judges tuning files against the kit tunables they name.
  let kitProblems: (files: readonly ConfigSource[]) => Problem[] = () => [];
  const revalidate = (): void => {
    const files = configFiles();
    texts.clear();
    for (const f of files) texts.set(f.path, f.text);
    const registry = createRegistry();
    const r = registry.load(files);
    writeIds(root, registry.idsModule());
    problems = [...r.problems, ...kitProblems(files)];
    pushProblems();
  };
  revalidate();

  // ---- Vite: the game's dev page --------------------------------------------------------------------------------
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
            // The path only: a query like ?hull-paused (the play tool's) still gets the page.
            const path = req.url?.split('?')[0];
            if (path !== '/' && path !== '/index.html') return next();
            res.setHeader('content-type', 'text/html');
            res.setHeader('cache-control', 'no-store');
            res.end(await server.transformIndexHtml('/', DEV_PAGE));
          });
        },
      },
    ],
    // The engine's own dependencies live beside it, not in the project, so they are aliased to their files in the engine's folder. Pre-bundling them
    // up front means the first page load never discovers one late and reloads itself. Ajv is CommonJS and typebox is
    // hundreds of small files; neither can be served as it is. three is not pre-bundled: three.module.js and
    // three.webgpu.js both import three.core.js, so served as they are the page gets one copy of three. Pre-bundling
    // `three` alone gave the WebGPU backend a second copy ("Multiple instances of Three.js").
    optimizeDeps: { noDiscovery: true, include: ['ajv/dist/2020.js', 'typebox'] },
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

  // The history store: changes are recorded after a burst of edits goes quiet; experiments get their own pages.
  hist = await History.open({
    root, quietMs: opts.historyQuietMs, log, games,
    onAdded: (c) => {
      push('history.added', c, 'studio');
      // A change may add or clear an authorship problem; the app learns it from the problem state, not by running `check`.
      void hist.authorshipProblems().then((a) => { authorship = a; pushProblems(); }).catch((e) => log(`authorship: ${(e as Error).message}`));
    },
    onExp: (name, change, exp) => push('exp.changed', { name, change, exp }, 'studio'),
  });

  authorship = await hist.authorshipProblems().catch(() => []);
  pushedProblems = JSON.stringify(allProblems());

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
  const readText = (path: string, dir = root): string => {
    try { return readFileSync(join(dir, path), 'utf8'); } catch { throw new RpcError(-32001, `${path} does not exist`); }
  };
  const key = (p: Problem): string => `${p.file}|${p.pointer ?? ''}|${p.rule}|${p.message}`;

  /** The problems a file would have if it held `text`, without touching the live state. */
  const problemsWith = (path: string, text: string, dir = root): Problem[] => {
    const files = configFilesIn(dir).filter((f) => f.path !== path);
    files.push({ path, text });
    return createRegistry().load(files).problems.filter((p) => p.file === path);
  };

  /** The folder an edit targets: the project, or one experiment's working copy. */
  const targetDir = (exp: string | undefined): string => {
    try { return exp ? hist.expDirOf(exp) : root; } catch (e) { throw new RpcError(-32602, (e as Error).message); }
  };

  const setConfig: Handler<'config.set'> = async (p) => {
    const dir = targetDir(p.exp);
    const by = p.author ?? 'you';
    const path = pathOf(p.id);
    const old = readText(path, dir);
    const edited = setJsonPointer(old, p.pointer, p.value);
    if (!edited.ok) return { ok: false, problems: [{ file: path, pointer: p.pointer, rule: 'edit', message: edited.message }] };
    // A write may not add a problem. A file that was already broken elsewhere can still be fixed one field at a time.
    const known = new Set((p.exp ? createRegistry().load(configFilesIn(dir)).problems : problems).filter((x) => x.file === path).map(key));
    const added = problemsWith(path, edited.text, dir).filter((x) => !known.has(key(x)));
    if (added.length) return { ok: false, problems: added };

    // Edits still waiting from another author are recorded first, so each change has one author.
    await hist.settle(by, p.exp ?? 'main');
    if (p.exp) {
      writeWhole(join(dir, path), edited.text);
      games.get(p.exp)?.invalidateBoot();
      push('config.changed', { id: idOf(path), path, text: edited.text }, 'game', p.exp);
      hist.touch(by, p.exp);
      return { ok: true, problems: [] };
    }
    let from: unknown;
    try { from = valueAtPointer(JSON.parse(old), p.pointer); } catch { /* the old file did not parse */ }
    writeWhole(join(root, path), edited.text);
    hist.touch(by);
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
  const scanTunables = (dir = root): (FoundTunable & { file: string })[] => {
    const out: (FoundTunable & { file: string })[] = [];
    for (const abs of walk(join(dir, 'src'), (n) => n.endsWith('.ts') && !n.endsWith('.d.ts') && !n.endsWith('.test.ts'))) {
      const file = norm(relative(dir, abs));
      let text: string;
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      if (!text.includes('tunables')) continue;
      for (const b of findTunables(file, text)) for (const t of b.tunables) out.push({ ...t, file });
    }
    return out;
  };

  // Kit blocks: the tunables of the kits the project imports, with the project's own values from config/tuning/<block>.json.
  type KitWire = TunableWire & { tuningId: string; initial: unknown };
  const kitWires = (dir = root, files?: readonly ConfigSource[]): KitWire[] => {
    const names: string[] = [];
    for (const abs of walk(join(dir, 'src'), (n) => n.endsWith('.ts') && !n.endsWith('.d.ts') && !n.endsWith('.test.ts'))) {
      try { names.push(...kitImports(abs, readFileSync(abs, 'utf8'))); } catch { /* unreadable files are skipped */ }
    }
    const own = new Set(scanTunables(dir).map((t) => t.block));
    const src = files ?? configFilesIn(dir);
    return kitTunables(names).filter((t) => !own.has(t.block)).map((t) => {
      const tuningId = tuningIdOf(t.block);
      const text = src.find((f) => f.path === `config/tuning/${tuningId}.json`)?.text;
      let given: Record<string, unknown> = {};
      try { if (text) given = JSON.parse(text) as Record<string, unknown>; } catch { /* the problem list says why */ }
      const set = Object.prototype.hasOwnProperty.call(given, t.key) && !tunableProblem(t.kind, t.key, t.opts, given[t.key]);
      return { block: t.block, key: t.key, kind: t.kind, value: set ? given[t.key] : t.value, initial: t.value, opts: t.opts, file: t.file, line: t.line, col: t.col, source: 'kit' as const, overrides: `config/tuning/${tuningId}.json`, tuningId };
    });
  };

  /** A tuning file's values judged against the kit tunables they name; the registry cannot, it does not know the code. */
  const kitFileProblems = (files: readonly ConfigSource[]): Problem[] => {
    const out: Problem[] = [];
    const wires = kitWires(root, files);
    for (const f of files) {
      if (!f.path.startsWith('config/tuning/')) continue;
      const mine = wires.filter((w) => w.overrides === f.path);
      if (mine.length === 0) continue;
      let given: Record<string, unknown>;
      try { given = JSON.parse(f.text) as Record<string, unknown>; } catch { continue; }
      for (const w of mine) {
        if (!Object.prototype.hasOwnProperty.call(given, w.key)) continue;
        const bad = tunableProblem(w.kind, w.key, w.opts, given[w.key]);
        if (bad) {
          const at = locateKey(f.text, w.key);
          out.push({ file: f.path, pointer: `/${w.key}`, ...at, rule: 'tunable', message: bad });
        }
      }
    }
    return out;
  };

  kitProblems = kitFileProblems;
  revalidate();

  /** Writes one kit tunable into config/tuning/<block>.json: creates the file, validates, keeps only keys that differ from the code. */
  const setKitTunable = async (w: KitWire, p: Methods['tunables.set']['params']): Promise<WriteResult> => {
    const dir = targetDir(p.exp);
    const by = p.author ?? 'you';
    const path = w.overrides!;
    const bad = tunableProblem(w.kind, w.key, w.opts, p.value);
    if (bad) return { ok: false, problems: [{ file: path, pointer: `/${w.key}`, rule: 'tunable', message: bad }] };
    if (w.kind !== 'num') return { ok: false, problems: [{ file: path, pointer: `/${w.key}`, rule: 'tunable', message: `${w.block}.${w.key} is a ${w.kind}; tuning files hold numbers only, so it can only be changed in the kit's code` }] };
    let old: string | undefined;
    try { old = readFileSync(join(dir, path), 'utf8'); } catch { /* created below */ }
    let doc: Record<string, unknown> = { kind: 'tuning' };
    if (old !== undefined) {
      try { doc = JSON.parse(old) as Record<string, unknown>; } catch { return { ok: false, problems: [{ file: path, rule: 'parse', message: 'invalid JSON; fix the file before tuning it from here' }] }; }
    }
    const from = Object.prototype.hasOwnProperty.call(doc, w.key) ? doc[w.key] : w.initial;
    let text: string;
    if (JSON.stringify(p.value) === JSON.stringify(w.initial)) {
      // Back at the kit's own value: the file stops saying anything about this key.
      if (old === undefined || !Object.prototype.hasOwnProperty.call(doc, w.key)) return { ok: true, problems: [] };
      const { [w.key]: _gone, ...rest } = doc;
      text = `${JSON.stringify(rest, null, 2)}\n`;
    } else if (old !== undefined) {
      const edited = setJsonPointer(old, `/${w.key}`, p.value);
      if (!edited.ok) return { ok: false, problems: [{ file: path, pointer: `/${w.key}`, rule: 'edit', message: edited.message }] };
      text = edited.text;
    } else {
      text = `${JSON.stringify({ ...doc, [w.key]: p.value }, null, 2)}\n`;
    }
    await hist.settle(by, p.exp ?? 'main');
    mkdirSync(join(dir, 'config', 'tuning'), { recursive: true });
    writeWhole(join(dir, path), text);
    if (p.exp) {
      games.get(p.exp)?.invalidateBoot();
      push('config.changed', { id: idOf(path), path, text }, 'game', p.exp);
      hist.touch(by, p.exp);
      return { ok: true, problems: [] };
    }
    hist.touch(by);
    texts.set(path, text);
    invalidateBoot();
    journal({ target: idOf(path), path: `/${w.key}`, from, to: p.value, by });
    revalidate();
    push('config.changed', { id: idOf(path), path, text });
    push('tunable.changed', { block: w.block, key: w.key, value: p.value }, 'studio');
    return { ok: true, problems: [] };
  };

  const setTunableValue: Handler<'tunables.set'> = async (p) => {
    const dir = targetDir(p.exp);
    const by = p.author ?? 'you';
    const t = scanTunables(dir).find((x) => x.block === p.block && x.key === p.key);
    if (!t) {
      const k = kitWires(dir).find((x) => x.block === p.block && x.key === p.key);
      if (k) return setKitTunable(k, p);
    }
    if (!t) return { ok: false, problems: [{ file: 'src', rule: 'tunable', message: `there is no literal tunable "${p.block}.${p.key}" in src/` }] };
    const abs = join(dir, t.file);
    const r = rewriteTunable(t.file, readFileSync(abs, 'utf8'), p.block, p.key, p.value);
    if (!r.ok) return { ok: false, problems: [{ file: t.file, pointer: `/${p.block}/${p.key}`, line: r.line ?? t.line, col: r.col ?? t.col, rule: 'tunable', message: r.message }] };
    await hist.settle(by, p.exp ?? 'main');
    if (p.exp) {
      games.get(p.exp)?.wroteTs.set(abs, r.text);
      writeWhole(abs, r.text);
      push('tunable.changed', { block: p.block, key: p.key, value: p.value }, 'game', p.exp);
      hist.touch(by, p.exp);
      return { ok: true, problems: [] };
    }
    wroteTs.set(abs, r.text);
    writeWhole(abs, r.text);
    hist.touch(by);
    journal({ target: `tunables:${p.block}`, path: p.key, from: t.value, to: p.value, by: p.author ?? 'you' });
    // Studios hear it too: an edit by an agent over MCP must move the Inspector's dial, not only the running game.
    push('tunable.changed', { block: p.block, key: p.key, value: p.value }, 'all');
    return { ok: true, problems: [] };
  };

  const tunableWires = (): TunableWire[] => [
    ...scanTunables().map((t): TunableWire => ({ block: t.block, key: t.key, kind: t.kind, value: t.value, opts: t.opts, file: t.file, line: t.line, col: t.col, source: 'code' })),
    ...kitWires().map(({ tuningId: _id, ...w }): TunableWire => w),
  ];

  // Control ops waiting for a game's answer (the control port: `game.run` out, `game.result` back).
  let rpcN = 0;
  const rpcWait = new Map<number, { ok(v: never): void; fail(e: Error): void }>();

  const runOnGame: Handler<'game.run'> = (p) => new Promise((ok, fail) => {
    const candidates = [...clients].filter((c) => c.role === 'game' && c.ws.readyState === WebSocket.OPEN && (p.client ? c.id === p.client : c.exp === undefined));
    const target = candidates[0];
    if (!target) { fail(new RpcError(-32002, p.client ? `no game "${p.client}" is connected` : 'no game is connected; open the dev page first')); return; }
    const id = ++rpcN;
    const timer = setTimeout(() => { rpcWait.delete(id); fail(new RpcError(-32003, `the game did not answer ${p.control.op} within 30 s`)); }, 30_000);
    rpcWait.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
    target.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.rpc', params: { id, control: p.control } satisfies Pushes['game.rpc'] }));
  });

  const reviewed = <R extends { entry?: Methods['review.list']['result'][number] }>(r: R): R => {
    if (r.entry) push('review.changed', { entry: r.entry }, 'studio');
    return r;
  };

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
        items.push({ id: `tunables:${t.block}`, kind: 'tunables', path: t.file, title: t.block, problems: 0, source: 'code' });
      }
      for (const t of kitWires()) {
        if (seen.has(t.block)) continue;
        seen.add(t.block);
        items.push({ id: `tunables:${t.block}`, kind: 'tunables', path: t.overrides!, title: t.block, problems: problems.filter((x) => x.file === t.overrides).length, source: 'kit' });
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
    'history.list': (p) => hist.list(p),
    'history.diff': (p) => hist.diff(p),
    'history.restore': (p) => hist.restore(p.id, p.author ?? 'you'),
    'history.checkpoint': (p) => hist.checkpoint(p.name, p.id),
    'exp.start': (p) => hist.expStart(p.name, p.from, p.author ?? 'you'),
    'exp.list': () => hist.expList(),
    'exp.compare': (p) => hist.expCompare(p.a, p.b),
    'exp.adopt': (p) => hist.expAdopt(p.name, p.author ?? 'you', p.resolve),
    'exp.discard': (p) => hist.expDiscard(p.name),
    'game.run': runOnGame,
    'review.list': (p) => listReview(root, p.open === true),
    'review.set': (p) => reviewed(setReview(root, { ...p, author: p.author ?? 'you' })),
    'review.note': (p) => reviewed(noteReview(root, { ...p, author: p.author ?? 'you' })),
    'game.control': (p: GameControl) => { push('game.control', p, 'game', '*'); return {}; },
    'problems.list': () => allProblems(),
    'tool.call': async (p) => {
      // Checks read the history's authorship record, so what is waiting is recorded first.
      await hist.flush();
      const tool = tools.find((t) => t.name === p.name && t.name !== 'dev');
      if (!tool) throw new RpcError(-32602, `there is no tool "${p.name}" (have: ${tools.filter((t) => t.name !== 'dev').map((t) => t.name).join(', ')})`);
      const out = await tool.run({ root, author: 'you', project: { call: (m, params) => Promise.resolve((methods[m as MethodName] as (x: unknown) => unknown)(params)) }, server: { url: urls.ws, gameUrl: urls.http }, log: (line) => push('log', { level: 'info', message: line, source: 'tool' }, 'studio'), signal: new AbortController().signal }, p.input ?? {});
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
      const exp = role === 'game' ? url.searchParams.get('exp') ?? undefined : undefined;
      const id = url.searchParams.get('client') ?? Math.random().toString(36).slice(2, 8);
      const client: Client = { ws, role, id: exp ? `${exp}/${id}` : id, ...(exp ? { exp } : {}) };
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
      else if (msg.method === 'game.result') {
        const r = msg.params as { id: number; ok: boolean; result?: never; error?: string };
        const w = rpcWait.get(r.id);
        rpcWait.delete(r.id);
        if (r.ok) w?.ok(r.result as never); else w?.fail(new RpcError(-32004, r.error ?? 'the game failed the control op'));
      } else if (msg.method === 'log') push('log', msg.params as Pushes['log'], 'studio');
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
        hist.touch('disk');
        return;
      }
      let text: string;
      try { text = readFileSync(abs, 'utf8'); } catch { return; }
      if (texts.get(rel) === text) return;
      hist.touch('disk');
      invalidateBoot();
      revalidate();
      // A file with problems is reported, not pushed: the running game keeps its last good value. A tuning value a kit
      // refuses is the exception: the game skips just that key (and says so), so it matches what a restart would do.
      if (problems.some((x) => x.file === rel && x.rule !== 'tunable')) log(`${rel} has problems; the game keeps the last good value`);
      else push('config.changed', { id: idOf(rel), path: rel, text });
    } else if (rel.startsWith('src/') && rel.endsWith('.ts')) {
      let text: string | undefined;
      try { text = readFileSync(abs, 'utf8'); } catch { /* deleted */ }
      if (text !== undefined && wroteTs.get(abs) === text) return;
      wroteTs.delete(abs);
      hist.touch('disk');
      push('source.changed', { path: rel });
    } else if (rel.startsWith('src/') || rel.startsWith('assets/')) {
      hist.touch('disk');
    }
  };
  vite.watcher.on('change', (f) => onDisk('change', f)).on('add', (f) => onDisk('add', f)).on('unlink', (f) => onDisk('unlink', f));
  // Directories that did not exist at start (a new project's first config/ folder) are picked up too.
  vite.watcher.add([join(root, 'config'), join(root, 'src'), join(root, 'assets'), join(root, MANIFEST)]);
  mkdirSync(join(root, '.hull'), { recursive: true });
  log(`project server for ${root}: ${urls.http}`);
  // Anything else that wants this project (mcp, the command line, a second app window) attaches to this server
  // rather than starting another: two servers would fight over writes and watchers.
  writeServerFile(root, { url: urls.ws, gameUrl: urls.http, pid: process.pid });

  return {
    url: urls.ws,
    gameUrl: urls.http,
    async close() {
      removeServerFile(root, process.pid);
      for (const c of clients) c.ws.close();
      wss.close();
      await hist.close();
      await games.closeAll();
      await vite.close();
    },
  };
}
