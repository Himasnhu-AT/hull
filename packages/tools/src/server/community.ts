// The community catalog: games anyone can open to play and to try the editor on a real project.
// It comes from the Hull backend (backend/, GET /api/community) when a server is given, each game with versions; without
// one, or when the server cannot be reached, from the repository's examples/ folder (offline work and tests).
//
// Opening never touches the published game: the first open puts a copy in the person's projects folder
// (<projectsDir>/community/<id>), later opens reuse it, and `reset` (or `update`, to the newest version) replaces it.
// The copy records which version it is in .hull/community.json, so the launcher can offer an update.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyProject, repoRoot } from './templates.ts';

export interface CommunityGame {
  id: string;
  title: string;
  note: string;
  /** The cover: an http(s) URL from the server, a data: URL for a local game, or null. */
  cover: string | null;
  /** The newest published version, or null when the game has none. */
  version: string | null;
  /** Where this person's copy lives (it may not exist yet), whether it does, and which version it is. */
  copy: { root: string; exists: boolean; version: string | null };
  /** A newer version than the copy's, when there is one. */
  update: string | null;
  /** 'server' when it came from the Hull backend, 'local' from examples/. */
  source: 'server' | 'local';
}

export interface CommunityOptions {
  projectsDir: string;
  /** The Hull backend, like http://127.0.0.1:8787. Without it, examples/ is the catalog. */
  server?: string | undefined;
  /** Stand-in for fetch (tests). */
  fetch?: typeof fetch;
}

interface Remote { id: string; title: string; note: string; version: string; sha256: string; cover_url: string | null; download_url: string; versions?: string[] }
interface Local { id: string; title: string; note: string; dir: string; coverFile: string | null; version: string | null }

const COVERS: [string, string][] = [['cover.webp', 'image/webp'], ['cover.jpg', 'image/jpeg'], ['cover.png', 'image/png']];
export const examplesDir = join(repoRoot, 'examples');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** 1 when a is newer than b, -1 when older, 0 when the same or either is not MAJOR.MINOR.PATCH. */
export function compareVersions(a: string | null, b: string | null): number {
  const x = a ? SEMVER.exec(a) : null, y = b ? SEMVER.exec(b) : null;
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

/** The games in examples/ (the catalog without a server). */
export function localCatalog(): Local[] {
  let names: string[];
  try { names = readdirSync(examplesDir).sort(); } catch { return []; }
  const out: Local[] = [];
  for (const id of names) {
    const dir = join(examplesDir, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const m = JSON.parse(readFileSync(join(dir, 'hull.json'), 'utf8')) as { kind?: string; title?: string; note?: string; version?: string };
      if (m.kind !== 'game') continue;
      const cover = COVERS.find(([f]) => existsSync(join(dir, f)));
      // A game without a cover is not listed: the launcher shows a picture for every game.
      if (!cover) continue;
      out.push({ id, title: m.title ?? id, note: m.note ?? '', dir, coverFile: cover[0], version: typeof m.version === 'string' ? m.version : null });
    } catch { /* not a game */ }
  }
  return out;
}

const copyRoot = (projectsDir: string, id: string): string => join(projectsDir, 'community', id);
const isProject = (dir: string): boolean => existsSync(join(dir, 'hull.json'));
const ID = /^[a-z0-9-]{1,40}$/;

/** Which version a copy is: .hull/community.json, else the copy's own hull.json "version". */
function copyVersion(root: string): string | null {
  try { const v = (JSON.parse(readFileSync(join(root, '.hull', 'community.json'), 'utf8')) as { version?: unknown }).version; if (typeof v === 'string') return v; } catch { /* none recorded */ }
  try { const v = (JSON.parse(readFileSync(join(root, 'hull.json'), 'utf8')) as { version?: unknown }).version; if (typeof v === 'string') return v; } catch { /* not a copy */ }
  return null;
}
const recordVersion = (root: string, id: string, version: string | null, sha256: string | null): void => {
  mkdirSync(join(root, '.hull'), { recursive: true });
  writeFileSync(join(root, '.hull', 'community.json'), JSON.stringify({ id, version, sha256, at: new Date().toISOString() }, null, 2) + '\n');
};

async function remoteCatalog(o: CommunityOptions): Promise<Remote[]> {
  const f = o.fetch ?? fetch;
  const server = o.server!.replace(/\/+$/, '');
  const r = await f(`${server}/api/community`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`the community server answered ${r.status} (${server}/api/community)`);
  const games = ((await r.json()) as { games?: Remote[] }).games;
  if (!Array.isArray(games)) throw new Error(`the community server sent no games list (${server}/api/community)`);
  return games.filter((g) => g && ID.test(g.id) && typeof g.download_url === 'string');
}

/** The games, from the server when one is given and answers, else from examples/. */
export async function listCommunity(o: CommunityOptions): Promise<CommunityGame[]> {
  if (o.server) {
    try {
      return (await remoteCatalog(o)).map((g) => {
        const root = copyRoot(o.projectsDir, g.id), exists = isProject(root), mine = exists ? copyVersion(root) : null;
        return { id: g.id, title: g.title || g.id, note: g.note ?? '', cover: g.cover_url, version: g.version ?? null, copy: { root, exists, version: mine },
          update: exists && compareVersions(g.version, mine) > 0 ? g.version : null, source: 'server' as const };
      });
    } catch { /* offline, or no backend running: the local catalog still lets the person play */ }
  }
  return localCatalog().map((e) => {
    const mime = COVERS.find(([f]) => f === e.coverFile)![1];
    const cover = `data:${mime};base64,${readFileSync(join(e.dir, e.coverFile!)).toString('base64')}`;
    const root = copyRoot(o.projectsDir, e.id), exists = isProject(root), mine = exists ? copyVersion(root) : null;
    return { id: e.id, title: e.title, note: e.note, cover, version: e.version, copy: { root, exists, version: mine },
      update: exists && compareVersions(e.version, mine) > 0 ? e.version : null, source: 'local' as const };
  });
}

/**
 * Makes sure the person's copy exists and returns its folder. `reset` replaces an existing copy with the published one,
 * `update` does the same only when a newer version is out. The copy is built beside the target and moved in, so a
 * failure part way never leaves a half copy that later opens would trust.
 */
export async function openCommunity(o: CommunityOptions & { id: string; reset?: boolean; update?: boolean }): Promise<{ root: string; created: boolean; version: string | null }> {
  if (!ID.test(o.id)) throw new Error(`'${o.id}' is not a community game id`);
  const root = copyRoot(o.projectsDir, o.id);
  const parent = join(o.projectsDir, 'community');
  const staging = join(parent, `.${o.id}.new`);
  const place = (version: string | null, sha: string | null): { root: string; created: boolean; version: string | null } => {
    if (!isProject(staging)) throw new Error(`the download of '${o.id}' has no hull.json`);
    recordVersion(staging, o.id, version, sha);
    rmSync(root, { recursive: true, force: true });
    renameSync(staging, root);
    return { root, created: true, version };
  };

  let remote: Remote | undefined;
  if (o.server) { try { remote = (await remoteCatalog(o)).find((g) => g.id === o.id); } catch { /* fall back to the local catalog */ } }
  if (remote) {
    const want = isProject(root) && !o.reset && !(o.update && compareVersions(remote.version, copyVersion(root)) > 0);
    if (want) return { root, created: false, version: copyVersion(root) };
    mkdirSync(parent, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    const r = await (o.fetch ?? fetch)(remote.download_url, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`could not download '${o.id}' ${remote.version}: the server answered ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (remote.sha256 && sha !== remote.sha256) throw new Error(`the download of '${o.id}' ${remote.version} is damaged (checksum differs); try again`);
    mkdirSync(staging, { recursive: true });
    const archive = join(parent, `.${o.id}.tar.gz`);
    writeFileSync(archive, bytes);
    try {
      // The system tar (macOS, Linux, Windows 10+) unpacks it; the archive's paths are relative, made by the backend.
      const t = spawnSync('tar', ['-xzf', archive, '-C', staging], { encoding: 'utf8' });
      if (t.status !== 0) throw new Error(`could not unpack '${o.id}': ${(t.stderr || t.error?.message || '').trim()}`);
    } finally { rmSync(archive, { force: true }); }
    return place(remote.version, sha);
  }

  const entry = localCatalog().find((e) => e.id === o.id);
  if (!entry) throw new Error(`no community game '${o.id}' (have: ${localCatalog().map((e) => e.id).join(', ') || 'none'})`);
  if (isProject(root) && !o.reset && !(o.update && compareVersions(entry.version, copyVersion(root)) > 0)) return { root, created: false, version: copyVersion(root) };
  mkdirSync(parent, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  copyProject({ from: entry.dir, dir: staging });
  return place(entry.version, null);
}
