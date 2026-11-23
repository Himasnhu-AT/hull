// The project server: one HTTP port that serves the game's dev page (Vite) and, on the same port, the JSON-RPC
// WebSocket of dev/protocol.ts. The app's front end and every running game connect here; nothing outside this process
// touches the project's files (CLAUDE.md: the Studio never touches the disk).
import { cleanLaunchQuery } from './launch.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import type { ConfigSource, Problem } from 'hull';
import type { AssetResult, Author, BriefDoc, Change, ControlErrors, GameControl, GameEvents, GameMoment, RecentEvent, LibraryItem, MethodName, Methods, ProjectInfo, PushName, Pushes, TunableWire, WriteResult } from 'hull/dev/protocol';
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
import { buildBenchAudio, buildBenchModels } from './bench.ts';
import { listKits, planKitAdd } from './kits.ts';
import { findRefs, FOLDER_RE, ID_RE, planDelete, planDuplicate, planMoves, planNew, STARTERS, usesOf, type Plan, type Sources } from './assets.ts';
import { thumbOf } from './thumbs.ts';
import { createStackMapper, type MappedStack } from './stackmap.ts';
import { applyEdit, importersOf, listCode, MAX_BYTES, resolveCodePath, searchCode } from './code.ts';
import { runTsc } from '../tools/types.ts';
import { readBrief, writeSection } from '../create/brief.ts';
import { listDocs, notBuiltKinds, readDoc, searchDocs } from '../create/docs.ts';
import { listExplain, writeExplain } from '../create/explain.ts';
import { readCreate, setCreate } from '../create/state.ts';

export { createProject, listTemplates } from './templates.ts';
export { listCommunity, openCommunity } from './community.ts';
export type { CommunityGame } from './community.ts';
export { buildProject } from './build.ts';

export interface ProjectServer {
  /** ws:// URL of the protocol, with the studio token in its query (`?token=`); add `&role=studio` to connect. */
  url: string;
  /** The same URL for a game page (`?gt=`, the game token); add `&role=game`. Game sockets can only send the game's own notifications. */
  gameWsUrl: string;
  /** The token studio sockets and the MCP-over-HTTP front present. Also in .hull/server.json (mode 0600). */
  token: string;
  /** http:// URL of the game's dev page. */
  gameUrl: string;
  close(): Promise<void>;
}

/** `exp` is set for a game page that belongs to an experiment: it hears only that experiment's edits. */
interface Client { ws: WebSocket; role: 'studio' | 'game'; id: string; exp?: string; /** A page a tool opened because no app was around; never preferred to a game in a frame. */ headless?: boolean }
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
  // One random token per run for studio sockets, another for game pages: the page that runs the game can only report,
  // so a game's code (or a page that learned its token) never gets the tools' write access.
  const token = randomBytes(24).toString('hex');
  const gameToken = randomBytes(24).toString('hex');
  const gameWs = (): string => `${urls.ws}?gt=${gameToken}`;
  const studioWs = (): string => `${urls.ws}?token=${token}`;
  const same = (a: string | null, b: string): boolean => a !== null && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const games = expGames(root, gameWs);

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

  // ---- The sound bench's engine: the game's code generators, bundled (bench.ts). Rebuilt after the next change to src/ or hull.json.
  const BENCH_AUDIO = '/__hull/bench/audio.js';
  let benchAudio: Promise<string> | null = null;
  const serveBenchAudio = async (res: import('node:http').ServerResponse): Promise<void> => {
    // The Studio's page is another origin and may be a file:// page, so any origin may read this one file.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'no-store');
    const generators = (JSON.parse(readManifest(root)!.text) as { generators?: string }).generators;
    if (!generators) { res.statusCode = 404; res.end('hull.json has no "generators"'); return; }
    try {
      benchAudio ??= buildBenchAudio(root, generators);
      const code = await benchAudio;
      res.setHeader('content-type', 'text/javascript');
      res.end(code);
    } catch (e) {
      benchAudio = null;
      res.statusCode = 500;
      res.end(`The generators module ${generators} did not bundle: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---- The character bench's models: the game's own body builders (hull.json "models"), bundled (bench.ts).
  const BENCH_MODELS = '/__hull/bench/models.js';
  let benchModels: Promise<string> | null = null;
  const serveBenchModels = async (res: import('node:http').ServerResponse): Promise<void> => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'no-store');
    const models = (JSON.parse(readManifest(root)!.text) as { models?: string }).models;
    if (!models) { res.statusCode = 404; res.end('hull.json has no "models"'); return; }
    try {
      benchModels ??= buildBenchModels(root, models);
      const code = await benchModels;
      res.setHeader('content-type', 'text/javascript');
      res.end(code);
    } catch (e) {
      benchModels = null;
      res.statusCode = 500;
      res.end(`The models module ${models} did not bundle: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

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
      virtualModule(BOOT_ID, () => bootSource({ entry: manifestInfo.value!.entry, sources: configFiles(), devUrl: gameWs(), features: (JSON.parse(readManifest(root)!.text) as { features?: string[] }).features })),
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
            if (path === BENCH_AUDIO) return void (await serveBenchAudio(res));
            if (path === BENCH_MODELS) return void (await serveBenchModels(res));
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
      // .hull/ holds the studio token (server.json) and the history: the page that runs the game must not be able to fetch
      // them, or a game's own code could take the token and write to the project. Setting deny replaces Vite's defaults,
      // so they are repeated here.
      fs: { allow: [root, resolve(import.meta.dirname, '../../../..')], deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.hull/**'] },
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
      // (A change found while the history opens arrives before `hist` is set; the problems are read right after, below.)
      if (hist === undefined) return;
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
    // "game" is the id agents guess for the manifest (its kind is 'game'); a real config id always has a folder, so it cannot clash.
    if (id === MANIFEST || id === 'game') return MANIFEST;
    if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)+$/.test(id) || id.includes('..')) throw new RpcError(-32602, `"${id}" is not a config id like 'sound/sword/hit' (use "game" or "hull.json" for the game manifest)`);
    return `config/${id}.json`;
  };
  const idOf = (path: string): string => (path === MANIFEST ? MANIFEST : path.slice('config/'.length, -'.json'.length));
  const kindOfPath = (path: string): string => (path === MANIFEST ? 'game' : path.split('/')[1] ?? '');
  /** What to say about a config file that is not there: the call that makes it. A level or a prefab cannot be written by code.write (that is src/ only). */
  const missingConfig = (path: string): string => {
    if (path === MANIFEST) return 'hull.json does not exist: is this a Hull project?';
    const id = idOf(path);
    return `${path} does not exist. Create it with asset.new {"kind":"${kindOfPath(path)}","id":"${id}"} (a starter document that passes check), then set its fields with config.set. library.list shows the configs that exist.`;
  };
  const readText = (path: string, dir = root): string => {
    try { return readFileSync(join(dir, path), 'utf8'); } catch { throw new RpcError(-32001, missingConfig(path)); }
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

  // ---- Code: the agent's way into src/ (ARCHITECTURE section 9) ---------------------------------------------------------
  const refuse = (file: string, message: string, extra: Partial<Methods['code.edit']['result']> = {}): Methods['code.edit']['result'] => ({ ok: false, written: false, problems: [{ file, rule: 'code', message }], ...extra });
  /** The type problems of the files just changed. The whole project is checked (incrementally), but only these files are reported, plus a count for the rest. */
  const typeProblems = async (files: string[]): Promise<{ problems: Problem[]; elsewhere: number }> => {
    const all = await runTsc(root, { fast: true });
    const mine = all.filter((p) => files.includes(norm(p.file)));
    return { problems: mine, elsewhere: all.length - mine.length };
  };
  /** One write to src/: atomic, recorded under its author, and left for Vite to reload the page from (no wroteTs entry: this is code, so the game reloads). */
  const writeCode = async (rel: string, abs: string, text: string, by: Author, typecheck: boolean | undefined, extra: Partial<Methods['code.edit']['result']>): Promise<Methods['code.edit']['result']> => {
    await hist.settle(by, 'main');
    mkdirSync(dirname(abs), { recursive: true });
    writeWhole(abs, text);
    hist.touch(by);
    if (typecheck === false) return { ok: true, written: true, problems: [], ...extra };
    const t = await typeProblems([rel]);
    return { ok: t.problems.length === 0, written: true, problems: t.problems, ...(t.elsewhere ? { elsewhere: t.elsewhere } : {}), ...extra };
  };
  const codeMethods = {
    'code.list': () => ({ ok: true, problems: [], items: listCode(root) }),
    'code.read': (p: Methods['code.read']['params']): Methods['code.read']['result'] => {
      const r = resolveCodePath(root, p.path);
      if (!r.ok) return { ok: false, problems: [{ file: String(p.path), rule: 'code', message: r.message }] };
      let text: string;
      try { if (statSync(r.abs).size > MAX_BYTES) return { ok: false, problems: [{ file: r.rel, rule: 'code', message: 'the file is over 512 KB: read a line range with from and to' }] }; text = readFileSync(r.abs, 'utf8'); } catch { return { ok: false, problems: [{ file: r.rel, rule: 'code', message: `${r.rel} does not exist (code_list shows the files)` }] }; }
      const lines = text.split('\n');
      if (p.from === undefined && p.to === undefined) return { ok: true, problems: [], path: r.rel, text, from: 1, to: lines.length, total: lines.length };
      const from = Math.max(1, Math.floor(p.from ?? 1));
      const to = Math.min(lines.length, Math.floor(p.to ?? lines.length));
      if (from > lines.length || to < from) return { ok: false, problems: [{ file: r.rel, rule: 'code', message: `no lines ${p.from ?? 1}-${p.to ?? 'end'}: the file has ${lines.length}` }] };
      return { ok: true, problems: [], path: r.rel, text: lines.slice(from - 1, to).join('\n'), from, to, total: lines.length };
    },
    'code.search': (p: Methods['code.search']['params']): Methods['code.search']['result'] => {
      if (typeof p.pattern !== 'string' || p.pattern === '') return { ok: false, problems: [{ file: 'src', rule: 'code', message: 'pattern is empty' }], matches: [], truncated: false };
      if (p.path !== undefined) { const r = resolveCodePath(root, p.path); if (!r.ok) return { ok: false, problems: [{ file: p.path, rule: 'code', message: r.message }], matches: [], truncated: false }; }
      const r = searchCode(root, p.pattern, p);
      return 'error' in r ? { ok: false, problems: [{ file: 'src', rule: 'code', message: r.error }], matches: [], truncated: false } : { ok: true, problems: [], ...r };
    },
    'code.edit': async (p: Methods['code.edit']['params']): Promise<Methods['code.edit']['result']> => {
      const r = resolveCodePath(root, p.path, { file: true });
      if (!r.ok) return refuse(String(p.path), r.message);
      let old: string;
      try { old = readFileSync(r.abs, 'utf8'); } catch { return refuse(r.rel, `${r.rel} does not exist: create it with code_write`); }
      const e = applyEdit(old, p.old, p.new, p.all === true);
      if (!e.ok) return refuse(r.rel, e.message);
      if (Buffer.byteLength(e.text) > MAX_BYTES) return refuse(r.rel, 'the result would be over 512 KB');
      return writeCode(r.rel, r.abs, e.text, p.author ?? 'you', p.typecheck, { line: e.line, replaced: p.all ? old.split(p.old).length - 1 : 1 });
    },
    'code.write': async (p: Methods['code.write']['params']): Promise<Methods['code.write']['result']> => {
      const r = resolveCodePath(root, p.path, { file: true });
      if (!r.ok) return refuse(String(p.path), r.message);
      if (typeof p.text !== 'string') return refuse(r.rel, 'text must be a string');
      if (Buffer.byteLength(p.text) > MAX_BYTES) return refuse(r.rel, 'the text is over 512 KB');
      if (existsSync(r.abs) && statSync(r.abs).isDirectory()) return refuse(r.rel, `${r.rel} is a folder`);
      return writeCode(r.rel, r.abs, p.text, p.author ?? 'you', p.typecheck, { created: !existsSync(r.abs) });
    },
    'code.delete': async (p: Methods['code.delete']['params']): Promise<Methods['code.delete']['result']> => {
      const r = resolveCodePath(root, p.path, { file: true });
      if (!r.ok) return refuse(String(p.path), r.message);
      if (!existsSync(r.abs) || !statSync(r.abs).isFile()) return refuse(r.rel, `${r.rel} does not exist`);
      const importers = importersOf(root, r.rel);
      const manifest = readManifest(root)?.text ?? '';
      const named = manifest.includes(r.rel) || manifest.includes(r.rel.replace(/^src\//, './src/'));
      if (importers.length || named) {
        return { ok: false, written: false, importers, problems: [...importers.map((i) => ({ file: i.file, line: i.line, col: i.col, rule: 'code', message: `imports ${r.rel} ("${i.specifier}"): change or remove the import first` })), ...(named ? [{ file: MANIFEST, rule: 'code', message: `hull.json names ${r.rel}` }] : [])] };
      }
      const by = p.author ?? 'you';
      await hist.settle(by, 'main');
      unlinkSync(r.abs);
      hist.touch(by);
      push('source.changed', { path: r.rel });
      return { ok: true, written: true, problems: [] };
    },
  };

  const tunableWires = (): TunableWire[] => [
    ...scanTunables().map((t): TunableWire => ({ block: t.block, key: t.key, kind: t.kind, value: t.value, opts: t.opts, file: t.file, line: t.line, col: t.col, source: 'code' })),
    ...kitWires().map(({ tuningId: _id, ...w }): TunableWire => w),
  ];

  // Control ops waiting for a game's answer (the control port: `game.run` out, `game.result` back).
  let rpcN = 0;
  const rpcWait = new Map<number, { ok(v: never): void; fail(e: Error): void; owner?: Client }>();

  /**
   * The game a method aims at: the named one, else the first connected game of the project's own (not an experiment's), a game in
   * a frame before a headless page a tool opened. Without the preference "Something is off" froze the headless game, not the
   * one the person was looking at.
   */
  const pickGame = (client?: string): Client | undefined => {
    const open = [...clients].filter((c) => c.role === 'game' && c.ws.readyState === WebSocket.OPEN);
    if (client) return open.find((c) => c.id === client);
    const own = open.filter((c) => c.exp === undefined);
    return own.find((c) => !c.headless) ?? own[0];
  };

  // A code write reloads the game page: its socket closes and a new one opens a moment later (same client id when the page
  // was opened with one). These track that, so game.run can wait through a reload instead of failing in the gap.
  const RELOAD_WAIT_MS = 10_000;
  let gameConnects = 0;
  let lastGameGone = 0;
  const seenGameIds = new Set<string>();
  /** Fails a control op whose game closed before answering; runOnGame turns it into a wait and a retry. */
  class GameGone extends Error {}

  // The page's stacks name lines of Vite's output; this maps them back to the project's own TypeScript (stackmap.ts).
  const stacks = createStackMapper({ root, origin: () => urls.http });
  const RESTART_WAIT_MS = 20_000;
  const PART_STEPPED = 'The world may be part-stepped: run {op:"restart"} before trusting state.';
  /** What a failed control op says: the place first ("src/player.ts:40:5: Error: boom"), the mapped stack, then the warning. */
  const failureText = async (r: { error?: string; stack?: string; partStepped?: boolean }): Promise<string> => {
    const head = r.error ?? 'the game failed the control op';
    let mapped: MappedStack | undefined;
    if (r.stack) { try { mapped = await stacks.map(r.stack); } catch { /* an unmapped stack is still worth showing */ } }
    const lines = [mapped?.place ? `${mapped.place.file}:${mapped.place.line}:${mapped.place.col}: ${head}` : head];
    for (const f of mapped?.frames ?? []) lines.push(`  at ${f.text}`);
    if (r.partStepped) lines.push(PART_STEPPED);
    return lines.join('\n');
  };
  /** The ring the game kept, with each stack mapped to file:line:col in the original source and cut to six project-relative frames. */
  const mapErrors = async (res: ControlErrors): Promise<ControlErrors> => ({
    items: await Promise.all(res.items.map(async (it) => {
      if (typeof it.stack !== 'string') return it;
      const m = await stacks.map(it.stack);
      const { stack: _raw, ...rest } = it;
      return { ...rest, ...(m.place ? { file: m.place.file, line: m.place.line, col: m.place.col } : {}), ...(m.frames.length ? { stack: m.frames.map((f) => f.text) } : {}) };
    })),
  });

  const sendToGame = (target: Client, p: Methods['game.run']['params']): Promise<unknown> => new Promise((ok, fail) => {
    const id = ++rpcN;
    const timer = setTimeout(() => { rpcWait.delete(id); fail(new RpcError(-32003, `the game did not answer ${p.control.op} within 30 s`)); }, 30_000);
    rpcWait.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); }, owner: target });
    target.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.rpc', params: { id, control: p.control } satisfies Pushes['game.rpc'] }));
  });

  /** The game to run an op on, waiting up to RELOAD_WAIT_MS when one has just gone (a reload) and is expected back. */
  const gameAfterReload = async (p: Methods['game.run']['params']): Promise<Client | undefined> => {
    const expected = (): boolean => (p.client ? seenGameIds.has(p.client) : lastGameGone > 0) && Date.now() - lastGameGone < RELOAD_WAIT_MS + 5_000;
    for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 50))) {
      const g = pickGame(p.client);
      if (g) return g;
      if (!expected() || Date.now() - t0 > RELOAD_WAIT_MS) return undefined;
    }
  };

  /**
   * `restart`: the game answers and reloads its page, which runs `ready` again with the same seed. Wait for a game to be back
   * (the same client id when the page named itself, else any other game) and answer with its state, so the caller reads a
   * tick-0 state, not the old one.
   */
  const restartGame = async (p: Methods['game.run']['params']): Promise<Methods['game.run']['result']> => {
    const target = pickGame(p.client) ?? await gameAfterReload(p);
    if (!target) throw new RpcError(-32002, p.client ? `no game "${p.client}" is connected` : 'no game is connected; open the dev page first');
    await sendToGame(target, p);
    for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 50))) {
      const back = [...clients].find((c) => c.role === 'game' && c.ws.readyState === WebSocket.OPEN && c !== target && (c.id === target.id || (!p.client && c.exp === undefined)));
      if (back) {
        // The new page answers once its modules have loaded; the first state it gives is the tick-0 one.
        for (;;) {
          try { return (await sendToGame(back, { control: { op: 'state' }, client: back.id })) as Methods['game.run']['result']; } catch (e) {
            if (Date.now() - t0 > RESTART_WAIT_MS) throw e;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      }
      if (Date.now() - t0 > RESTART_WAIT_MS) throw new RpcError(-32003, 'the game did not come back within 20 s of the restart');
    }
  };

  const runOnGame: Handler<'game.run'> = async (p): Promise<Methods['game.run']['result']> => {
    if (p.control.op === 'restart') return restartGame(p);
    const connectsAtStart = gameConnects;
    let retried = false;
    for (;;) {
      const target = pickGame(p.client) ?? await gameAfterReload(p);
      if (!target) throw new RpcError(-32002, p.client ? `no game "${p.client}" is connected` : 'no game is connected; open the dev page first');
      try {
        let result = (await sendToGame(target, p)) as Methods['game.run']['result'];
        if (p.control.op === 'errors') result = await mapErrors(result as ControlErrors);
        // A game that connected while the op ran means a reload happened: say so, so a reset tick is not read as a normal answer.
        const reloaded = retried || gameConnects !== connectsAtStart;
        return (reloaded && result && typeof result === 'object' && !Array.isArray(result) ? { ...result, reloaded: true } : result) as Methods['game.run']['result'];
      } catch (e) {
        if (!(e instanceof GameGone) || retried) throw e instanceof GameGone ? new RpcError(-32002, 'the game reloaded again while the op ran; try again') : e;
        retried = true;
      }
    }
  };

  const reviewed = <R extends { entry?: Methods['review.list']['result'][number] }>(r: R): R => {
    if (r.entry) push('review.changed', { entry: r.entry }, 'studio');
    return r;
  };

  // ---- Assets: the Content Browser's operations (assets.ts plans them; this applies, validates and records) -----------------
  const assetSources = (): Sources => ({
    configs: configFiles().map((f) => ({ path: f.path, text: f.text })),
    code: walk(join(root, 'src'), (n) => /\.tsx?$/.test(n)).map((abs) => ({ path: norm(relative(root, abs)), text: readFileSync(abs, 'utf8') })),
  });
  const assetIds = (): string[] => [...texts.keys()].filter((p) => p.startsWith('config/') && p.endsWith('.json')).map(idOf);
  const pruneEmpty = (abs: string): void => {
    try { for (const n of readdirSync(abs)) pruneEmpty(join(abs, n)); } catch { return; }
    try { rmdirSync(abs); } catch { /* not empty, or gone */ }
  };

  /** Applies a plan: validates the result (an operation may not add a problem), writes, records, tells the game and the Studio. */
  const applyPlan = async (plan: Plan, by: Author, opts: { dropFolders?: string[]; moved?: { from: string; to: string }[] } = {}): Promise<AssetResult> => {
    if (!plan.ok) return { ok: false, problems: plan.problems, refs: plan.refs };
    const before = new Map<string, string>(configFiles().map((f) => [f.path, f.text]));
    const after = new Map(before);
    for (const r of plan.removes) after.delete(r);
    for (const w of plan.writes) if (w.path.startsWith('config/') || w.path === MANIFEST) after.set(w.path, w.text);
    const known = new Set(problems.map((p) => p.rule + '|' + p.message));
    const added = createRegistry().load([...after].map(([path, text]) => ({ path, text }))).problems.filter((p) => !known.has(p.rule + '|' + p.message));
    if (added.length) return { ok: false, problems: added };

    await hist.settle(by);
    for (const d of plan.mkdirs) mkdirSync(join(root, d), { recursive: true });
    for (const w of plan.writes) { mkdirSync(dirname(join(root, w.path)), { recursive: true }); writeWhole(join(root, w.path), w.text); }
    for (const r of plan.removes) { try { unlinkSync(join(root, r)); } catch { /* already gone */ } texts.delete(r); }
    for (const d of opts.dropFolders ?? []) pruneEmpty(join(root, 'config', d));
    hist.touch(by);
    invalidateBoot();
    revalidate();
    const movedTo = new Set(plan.created);
    for (const id of plan.gone) if (!movedTo.has(id)) push('config.removed', { id, path: `config/${id}.json` });
    for (const w of plan.writes) if (w.path.startsWith('config/')) push('config.changed', { id: idOf(w.path), path: w.path, text: w.text });
    const now = new Date().toISOString();
    const log = (c: Omit<Change, 'at' | 'by'>): void => { appendChange(root, { at: now, by, ...c }); push('journal.added', { at: now, by, ...c }); };
    if (opts.moved) for (const m of opts.moved) log({ target: m.to, path: '(id)', from: m.from, to: m.to });
    else {
      for (const id of plan.created) log({ target: id, path: '(asset)', from: null, to: 'created' });
      for (const id of plan.gone) log({ target: id, path: '(asset)', from: 'existed', to: null });
    }
    return { ok: true, problems: [], refs: plan.refs, created: plan.created, gone: plan.gone };
  };

  const assetMoves = (entries: string[], to: (e: string) => string): { from: string; to: string }[] | string => {
    const all = assetIds();
    const out: { from: string; to: string }[] = [];
    for (const e of entries) {
      if (all.includes(e)) out.push({ from: e, to: to(e) });
      else {
        const inside = all.filter((a) => a.startsWith(e + '/'));
        if (inside.length === 0) return e + ' is neither an asset nor a folder with assets';
        for (const a of inside) out.push({ from: a, to: to(e) + a.slice(e.length) });
      }
    }
    return out;
  };
  const isFolder = (e: string): boolean => !assetIds().includes(e);
  const badAsset = (file: string, message: string): AssetResult => ({ ok: false, problems: [{ file, rule: 'asset', message }] });

  const contentList: Handler<'content.list'> = () => {
    const folders: string[] = [];
    const dirs = (rel: string): void => {
      let names: string[];
      try { names = readdirSync(join(root, 'config', rel)).sort(); } catch { return; }
      for (const n of names) {
        const sub = rel ? rel + '/' + n : n;
        if (statSync(join(root, 'config', sub)).isDirectory()) { folders.push(sub); dirs(sub); }
      }
    };
    dirs('');
    const code = walk(join(root, 'src'), (n) => /\.tsx?$/.test(n)).map((abs) => ({ path: norm(relative(root, abs)), bytes: statSync(abs).size }));
    const parsed = new Map<string, unknown>();
    const valueOf = (id: string): unknown => {
      if (!parsed.has(id)) { try { parsed.set(id, JSON.parse(texts.get(`config/${id}.json`) ?? 'null')); } catch { parsed.set(id, null); } }
      return parsed.get(id);
    };
    const thumbs: Record<string, ReturnType<typeof thumbOf> & object> = {};
    for (const id of assetIds()) { const t = thumbOf(id, valueOf(id), valueOf); if (t) thumbs[id] = t; }
    return { folders, code, creatable: Object.keys(STARTERS), thumbs };
  };

  // ---- The "Just now" feed ----------------------------------------------------------------------------------------
  // Each game sends its newest events in batches (dev/runtime.ts); the server keeps the last few hundred per game, in game time,
  // and forwards each batch to the studios. A game that connects again starts a new run, so its old events go.
  const RECENT_KEEP = 256;
  const feeds = new Map<string, { events: RecentEvent[]; time: number }>();
  const feedOf = (id: string): { events: RecentEvent[]; time: number } => {
    let f = feeds.get(id);
    if (!f) { f = { events: [], time: 0 }; feeds.set(id, f); }
    return f;
  };
  const recentOf = (client: string | undefined, seconds: number): RecentEvent[] => {
    const g = pickGame(client);
    if (!g) return [];
    const f = feedOf(g.id);
    const latest = Math.max(f.time, f.events.at(-1)?.at ?? 0);
    const out: RecentEvent[] = [];
    for (let i = f.events.length - 1; i >= 0; i--) {
      const e = f.events[i]!;
      if (e.at < latest - seconds) break;
      out.push(e);
    }
    return out;
  };
  const isRecent = (items: unknown): items is RecentEvent[] => Array.isArray(items) && items.every((e) => e && typeof e === 'object' && typeof (e as RecentEvent).at === 'number' && typeof (e as RecentEvent).id === 'string');

  // ---- The brief (GAME.md) ----------------------------------------------------------------------------------------
  const BRIEF = 'GAME.md';
  const briefText = (): string | null => { try { return readFileSync(join(root, BRIEF), 'utf8'); } catch { return null; } };
  let briefSeen = briefText();
  const writeBrief: Handler<'brief.write'> = async (p) => {
    const by = p.author ?? 'you';
    const file = (message: string): { ok: false; problems: Problem[] } => ({ ok: false, problems: [{ file: BRIEF, rule: 'brief', message }] });
    let text: string;
    if (p.text !== undefined) {
      if (typeof p.text !== 'string' || p.text.trim() === '') return file('text is empty: write the whole brief, or pass one section');
      text = p.text.endsWith('\n') ? p.text : p.text + '\n';
    } else if (p.section) {
      let title = 'Untitled';
      try { title = (JSON.parse(readText(MANIFEST)) as { title?: string }).title ?? title; } catch { /* the manifest's problems are reported elsewhere */ }
      const r = writeSection(briefText(), p.section, title);
      if (!r.ok) return file(r.message);
      text = r.text;
    } else return file('pass text (the whole brief) or section ({ id, text })');
    // Edits still waiting from another author are recorded first, so the brief's change has one author.
    await hist.settle(by, 'main');
    writeWhole(join(root, BRIEF), text);
    briefSeen = text;
    hist.touch(by);
    const doc = readBrief(text);
    push('brief.changed', doc, 'studio');
    return { ok: true, problems: [], doc };
  };

  // ---- Methods ----------------------------------------------------------------------------------------------------
  const methods: { [M in MethodName]: Handler<M> } = {
    'project.info': (): ProjectInfo => {
      const m = readManifest(root)!;
      let manifest: unknown;
      try { manifest = JSON.parse(m.text); } catch { /* shown as a problem */ }
      return { root, title: (manifest as { title?: string } | undefined)?.title ?? 'Untitled', gameUrl: urls.http, manifest };
    },
    'project.launch': (p): { query: string; url: string } => {
      const file = join(root, '.hull', 'launch.json');
      let query = '';
      if (p.query !== undefined) {
        query = cleanLaunchQuery(p.query);
        mkdirSync(join(root, '.hull'), { recursive: true });
        writeFileSync(file, JSON.stringify({ query }, null, 2) + '\n');
      } else {
        try { query = cleanLaunchQuery((JSON.parse(readFileSync(file, 'utf8')) as { query?: string }).query ?? ''); } catch { /* none kept yet */ }
      }
      return { query, url: query ? `${urls.http}?${query}` : urls.http };
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
    'content.list': contentList,
    'asset.refs': (p) => {
      if (!ID_RE.test(p.id)) return { ok: false, problems: [{ file: p.id, rule: 'asset', message: p.id + ' is not an asset id' }], referencedBy: [], uses: [] };
      const src = assetSources();
      const refs = findRefs(src, new Set([p.id])).get(p.id) ?? [];
      return { ok: true, problems: [], referencedBy: refs.filter((r) => r.id !== p.id), uses: usesOf(src, p.id) };
    },
    'asset.new': (p) => applyPlan(planNew(assetSources(), p.kind, p.id), p.author ?? 'you'),
    'kit.list': () => ({ ok: true, problems: [], items: listKits() }),
    'kit.add': async (p) => {
      const plan = planKitAdd(String(p.kit), new Set(assetIds()));
      if (!plan.ok) return badAsset('config/', plan.message);
      const r = await applyPlan({ ok: true, problems: [], writes: plan.writes, removes: [], mkdirs: [...new Set(plan.writes.map((w) => w.path.split('/').slice(0, -1).join('/')))], refs: [], created: plan.created, gone: [] }, p.author ?? 'you');
      return r.ok ? { ...r, kept: plan.kept } : r;
    },
    'asset.duplicate': (p) => applyPlan(planDuplicate(assetSources(), p.id, p.to), p.author ?? 'you'),
    'asset.rename': (p) => {
      const folder = isFolder(p.id);
      if (folder && !FOLDER_RE.test(p.to)) return badAsset(p.id, p.to + ' is not a folder path like sound/combat');
      const moves = assetMoves([p.id], () => p.to);
      if (typeof moves === 'string') return badAsset(p.id, moves);
      return applyPlan(planMoves(assetSources(), moves), p.author ?? 'you', { moved: moves, dropFolders: folder ? [p.id] : [] });
    },
    'asset.move': (p) => {
      if (!FOLDER_RE.test(p.folder)) return badAsset(p.folder, p.folder + ' is not a folder path like sound/combat');
      const moves = assetMoves(p.ids, (e) => p.folder + '/' + e.split('/').at(-1)!);
      if (typeof moves === 'string') return badAsset(p.ids[0] ?? '', moves);
      return applyPlan(planMoves(assetSources(), moves), p.author ?? 'you', { moved: moves.filter((m) => m.from !== m.to), dropFolders: p.ids.filter(isFolder) });
    },
    'asset.delete': (p) => {
      const targets: string[] = [];
      for (const e of p.ids) {
        const all = assetIds();
        if (all.includes(e)) targets.push(e);
        else targets.push(...all.filter((a) => a.startsWith(e + '/')));
      }
      return applyPlan(planDelete(assetSources(), targets), p.author ?? 'you', { dropFolders: p.ids.filter(isFolder) });
    },
    'folder.new': (p) => {
      if (!FOLDER_RE.test(p.path) || !kinds[p.path.split('/')[0]!]) return badAsset('config/' + p.path, p.path + ' is not a folder path inside a config kind, like sound/combat');
      mkdirSync(join(root, 'config', p.path), { recursive: true });
      return { ok: true, problems: [] };
    },
    ...codeMethods,
    'tunables.list': tunableWires,
    'tunables.set': setTunableValue,
    'journal.list': (p) => readJournal(root, p.limit),
    'history.list': (p) => hist.list(p),
    'history.diff': (p) => hist.diff(p),
    'history.restore': (p) => hist.restore(p.id, p.author ?? 'you'),
    'history.patch': (p) => hist.patch(p),
    'history.revert': (p) => hist.revert(p.from, p.file, p.author ?? 'you', p.pointer),
    'history.checkpoint': (p) => hist.checkpoint(p.name, p.id),
    'exp.start': (p) => hist.expStart(p.name, p.from, p.author ?? 'you'),
    'exp.list': () => hist.expList(),
    'exp.compare': (p) => hist.expCompare(p.a, p.b),
    'exp.adopt': (p) => hist.expAdopt(p.name, p.author ?? 'you', p.resolve),
    'exp.discard': (p) => hist.expDiscard(p.name),
    'game.run': runOnGame,
    'game.recent': (p) => ({ items: recentOf(p.client, typeof p.seconds === 'number' && p.seconds > 0 ? p.seconds : 4) }),
    'game.moment': async (p): Promise<GameMoment> => {
      const g = pickGame(p.client);
      if (!g) throw new RpcError(-32002, p.client ? `no game "${p.client}" is connected` : 'no game is connected; open the dev page first');
      // Pause first (the control message and the ops below travel the same socket, in order), then read the frozen frame.
      g.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.control', params: { paused: true } satisfies GameControl }));
      const state = (await runOnGame({ client: g.id, control: { op: 'state' } })) as { tick: number; time: number };
      const shot = (await runOnGame({ client: g.id, control: { op: 'screenshot' } })) as { png: string; width: number; height: number };
      return { tick: state.tick, time: state.time, png: shot.png, width: shot.width, height: shot.height, recent: recentOf(g.id, 4) };
    },
    'brief.read': (): BriefDoc => readBrief(briefText()),
    'brief.write': writeBrief,
    'docs.list': () => ({ items: listDocs(), notBuilt: notBuiltKinds() }),
    'docs.read': (p) => {
      const d = typeof p.id === 'string' ? readDoc(p.id, p.section) : null;
      if (!d) return { ok: false, problems: [{ file: String(p.id), rule: 'docs', message: `there is no document "${String(p.id)}" (docs.list shows the ids)` }] };
      if (d.missing) return { ok: false, problems: [{ file: d.id, rule: 'docs', message: `there is no section "${String(p.section)}" in ${d.id} (sections: ${d.sections?.join(', ') || 'none'})` }] };
      return { ok: true, problems: [], id: d.id, title: d.title, text: d.text, ...(d.sections?.length ? { sections: d.sections } : {}) };
    },
    'docs.search': (p) => ({ items: searchDocs(p.query) }),
    'explain.list': () => ({ items: listExplain(root) }),
    'explain.write': async (p) => {
      const r = writeExplain(root, p.doc, p.author ?? 'you');
      if (r.ok) push('explain.changed', { id: p.doc.id }, 'studio');
      return r;
    },
    'create.get': () => readCreate(root),
    'create.set': (p) => {
      const s = setCreate(root, p);
      push('create.changed', s, 'studio');
      return s;
    },
    'review.list': (p) => listReview(root, p.open === true),
    'review.set': (p) => reviewed(setReview(root, { ...p, author: p.author ?? 'you' })),
    'review.note': (p) => reviewed(noteReview(root, { ...p, author: p.author ?? 'you' })),
    'game.control': (p: GameControl) => {
      if (!p.client) { push('game.control', p, 'game', '*'); return {}; }
      const { client: id, ...op } = p;
      const g = pickGame(id);
      if (g) g.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.control', params: op }));
      return {};
    },
    // The place people already look also shows what the running game threw and has not been read yet (rule "runtime").
    'problems.list': async () => {
      const out = allProblems();
      const game = pickGame();
      if (!game) return out;
      try {
        const asked = sendToGame(game, { control: { op: 'errors', unread: true } });
        const res = await Promise.race([asked, new Promise<never>((_, no) => setTimeout(() => no(new Error('slow')), 2_000))]);
        const mapped = await mapErrors(res as ControlErrors);
        for (const e of mapped.items) {
          out.push({ file: e.file ?? 'game', ...(e.line ? { line: e.line } : {}), ...(e.col ? { col: e.col } : {}), rule: 'runtime', message: `${e.level} at tick ${e.tick}${e.count > 1 ? ` (x${e.count})` : ''}: ${e.message}` });
        }
      } catch { /* a game that does not answer adds nothing */ }
      return out;
    },
    'tool.call': async (p) => {
      // Checks read the history's authorship record, so what is waiting is recorded first.
      await hist.flush();
      const tool = tools.find((t) => t.name === p.name && t.name !== 'dev');
      if (!tool) throw new RpcError(-32602, `there is no tool "${p.name}" (have: ${tools.filter((t) => t.name !== 'dev').map((t) => t.name).join(', ')})`);
      const out = await tool.run({ root, author: 'you', project: { call: (m, params) => Promise.resolve((methods[m as MethodName] as (x: unknown) => unknown)(params)) }, server: { url: studioWs(), gameUrl: urls.http }, log: (line) => push('log', { level: 'info', message: line, source: 'tool' }, 'studio'), signal: new AbortController().signal }, p.input ?? {});
      const probs = (out as { problems?: Problem[] } | null)?.problems ?? [];
      return { ok: (out as { ok?: boolean } | null)?.ok ?? probs.length === 0, output: out, problems: probs };
    },
  };

  // ---- The socket -------------------------------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  vite.httpServer!.on('upgrade', (req: IncomingMessage, socket, head) => {
    // Vite's own hot-reload socket announces its protocol; everything else with a role is ours.
    if (String(req.headers['sec-websocket-protocol'] ?? '').includes('vite-')) return;
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://x'); } catch { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
    const role = url.searchParams.get('role');
    // Any web page can open a socket to localhost, and this one can write files. Two checks: the origin must be the app's
    // own or loopback (Origin "null" is a sandboxed iframe or a data: page, so it gets nothing special), and the socket
    // must present its token, which only a process that can read .hull/server.json or the dev page knows.
    const origin = req.headers.origin;
    let allowed = origin === undefined || origin.startsWith('file:') || origin.startsWith('app:');
    if (!allowed && origin) { try { allowed = isLoopback(new URL(origin).hostname === '::1' ? '[::1]' : new URL(origin).hostname); } catch { allowed = false; } }
    const tokenOk = role === 'studio' ? same(url.searchParams.get('token'), token) : role === 'game' ? same(url.searchParams.get('gt'), gameToken) : false;
    if (!allowed || !tokenOk || (role !== 'studio' && role !== 'game')) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const exp = role === 'game' ? url.searchParams.get('exp') ?? undefined : undefined;
      const id = url.searchParams.get('client') ?? Math.random().toString(36).slice(2, 8);
      const client: Client = { ws, role, id: exp ? `${exp}/${id}` : id, ...(exp ? { exp } : {}), ...(role === 'game' && url.searchParams.has('headless') ? { headless: true } : {}) };
      clients.add(client);
      if (role === 'game') { feeds.delete(client.id); gameConnects++; seenGameIds.add(client.id); }
      ws.on('close', () => {
        clients.delete(client);
        feeds.delete(client.id);
        if (role !== 'game') return;
        lastGameGone = Date.now();
        for (const [n, w] of rpcWait) if (w.owner === client) { rpcWait.delete(n); w.fail(new GameGone('the game closed')); }
      });
      ws.on('message', (data) => void onMessage(client, String(data)));
    });
  });

  const onMessage = async (client: Client, raw: string): Promise<void> => {
    let msg: { id?: number | string; method?: string; params?: unknown };
    try { msg = JSON.parse(raw) as typeof msg; } catch { client.ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })); return; }
    if (client.role === 'game') {
      // Games only talk; their reports and logs go to the studios.
      if (msg.method === 'game.report') {
        const r = msg.params as Pushes['game.report'];
        feedOf(client.id).time = r.time;
        push('game.report', { ...r, client: client.id }, 'studio');
      } else if (msg.method === 'game.events') {
        const items = (msg.params as GameEvents | undefined)?.items;
        if (!isRecent(items) || items.length === 0) return;
        const f = feedOf(client.id);
        f.events.push(...items);
        if (f.events.length > RECENT_KEEP) f.events.splice(0, f.events.length - RECENT_KEEP);
        push('game.recent', { items, client: client.id }, 'studio');
      }
      else if (msg.method === 'game.result') {
        const r = msg.params as Pushes['game.result'] & { result?: never };
        const w = rpcWait.get(r.id);
        rpcWait.delete(r.id);
        if (r.ok) w?.ok(r.result as never); else w?.fail(new RpcError(-32004, await failureText(r)));
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
    if (rel === BRIEF) {
      const text = briefText();
      if (text === briefSeen) return;
      briefSeen = text;
      hist.touch('disk');
      push('brief.changed', readBrief(text), 'studio');
      return;
    }
    if (rel === MANIFEST || (rel.startsWith('config/') && rel.endsWith('.json'))) {
      if (event === 'unlink') {
        // A removal this server made itself was announced and recorded by applyPlan.
        if (!texts.has(rel)) return;
        texts.delete(rel); invalidateBoot(); revalidate();
        push('config.removed', { id: idOf(rel), path: rel });
        hist.touch('disk');
        return;
      }
      let text: string;
      try { text = readFileSync(abs, 'utf8'); } catch { return; }
      if (texts.get(rel) === text) return;
      hist.touch('disk');
      if (rel === MANIFEST) { benchAudio = null; benchModels = null; }
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
      benchAudio = null;
      benchModels = null;
      push('source.changed', { path: rel });
    } else if (rel.startsWith('src/') || rel.startsWith('assets/')) {
      hist.touch('disk');
    }
  };
  vite.watcher.on('change', (f) => onDisk('change', f)).on('add', (f) => onDisk('add', f)).on('unlink', (f) => onDisk('unlink', f));
  // Directories that did not exist at start (a new project's first config/ folder) are picked up too.
  vite.watcher.add([join(root, BRIEF), join(root, 'config'), join(root, 'src'), join(root, 'assets'), join(root, MANIFEST)]);
  mkdirSync(join(root, '.hull'), { recursive: true });
  log(`project server for ${root}: ${urls.http}`);
  // Anything else that wants this project (mcp, the command line, a second app window) attaches to this server
  // rather than starting another: two servers would fight over writes and watchers.
  writeServerFile(root, { url: urls.ws, gameUrl: urls.http, pid: process.pid, token });

  return {
    url: studioWs(),
    gameWsUrl: gameWs(),
    token,
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
