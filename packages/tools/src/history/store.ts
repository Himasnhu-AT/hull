// The history store: a private git repository at .hull/history, written through isomorphic-git so no git install is
// needed and the project's own .git is never touched. The repository has no index and no work tree of its own: a state of
// the project is read from disk into a FileMap, written as blobs and trees, and committed directly. That is what lets the
// project folder and each experiment's folder share one repository.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import git from 'isomorphic-git';
import * as nodeFs from 'node:fs';
import type { HistoryAuthor } from 'hull/dev/protocol';
import type { FileMap } from './diff.ts';

const fs = nodeFs;
const TOP = ['src', 'config', 'assets'];
const MANIFEST = 'hull.json';
const SKIP = new Set(['node_modules', '.hull', 'dist', '.DS_Store']);

export const isTracked = (rel: string): boolean => rel === MANIFEST || TOP.some((t) => rel.startsWith(`${t}/`));

/** The project's tracked files (src/, config/, assets/, hull.json; never .hull or dist). */
export function readTracked(dir: string): FileMap {
  const out: FileMap = new Map();
  const walk = (rel: string): void => {
    let names: string[];
    try { names = readdirSync(join(dir, rel)).sort(); } catch { return; }
    for (const n of names) {
      if (SKIP.has(n)) continue;
      const r = `${rel}/${n}`;
      const abs = join(dir, r);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(r); else out.set(r, readFileSync(abs));
    }
  };
  try { out.set(MANIFEST, readFileSync(join(dir, MANIFEST))); } catch { /* no manifest */ }
  for (const t of TOP) walk(t);
  return out;
}

/** Makes the tracked files of `dir` equal `files`: writes what differs, removes what is not in the map. */
export function writeTracked(dir: string, files: FileMap): { written: string[]; removed: string[] } {
  const current = readTracked(dir);
  const written: string[] = [];
  const removed: string[] = [];
  for (const [p, data] of files) {
    const c = current.get(p);
    if (c && c.equals(data)) continue;
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), data);
    written.push(p);
  }
  for (const p of current.keys()) if (!files.has(p)) { rmSync(join(dir, p), { force: true }); removed.push(p); }
  return { written, removed };
}

export interface CommitInfo {
  id: string;
  parents: string[];
  by: HistoryAuthor;
  at: string;
  message: string;
  details: string[];
  kind: 'start' | 'change' | 'restore' | 'merge';
}

const MODE_FILE = '100644';
const MODE_TREE = '040000';

export class Store {
  readonly gitdir: string;
  private chain: Promise<unknown> = Promise.resolve();
  private blobCache = new Map<string, { data: Buffer; oid: string }>();
  private fileCache = new Map<string, FileMap>();

  constructor(readonly root: string) { this.gitdir = join(root, '.hull', 'history'); }

  /** Runs `fn` after everything queued before it: every write to the repository goes through here. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  exists(): boolean { return existsSync(join(this.gitdir, 'HEAD')); }

  async init(): Promise<void> {
    mkdirSync(this.gitdir, { recursive: true });
    await git.init({ fs, gitdir: this.gitdir, bare: true, defaultBranch: 'main' });
  }

  async resolve(ref: string): Promise<string | undefined> {
    try { return await git.resolveRef({ fs, gitdir: this.gitdir, ref }); } catch { return undefined; }
  }

  async setRef(ref: string, oid: string): Promise<void> {
    await git.writeRef({ fs, gitdir: this.gitdir, ref, value: oid, force: true });
  }

  async deleteRef(ref: string): Promise<void> {
    await git.deleteRef({ fs, gitdir: this.gitdir, ref });
  }

  async branches(): Promise<string[]> { return git.listBranches({ fs, gitdir: this.gitdir }); }
  async tags(): Promise<{ name: string; oid: string }[]> {
    const names = await git.listTags({ fs, gitdir: this.gitdir });
    const out: { name: string; oid: string }[] = [];
    for (const name of names) { const oid = await this.resolve(`refs/tags/${name}`); if (oid) out.push({ name, oid }); }
    return out;
  }

  async expand(oid: string): Promise<string | undefined> {
    if (/^[0-9a-f]{40}$/.test(oid)) return oid;
    try { return await git.expandOid({ fs, gitdir: this.gitdir, oid }); } catch { return undefined; }
  }

  private async blobOid(path: string, data: Buffer): Promise<string> {
    const hit = this.blobCache.get(path);
    if (hit && hit.data.equals(data)) return hit.oid;
    const oid = await git.writeBlob({ fs, gitdir: this.gitdir, blob: data });
    this.blobCache.set(path, { data, oid });
    return oid;
  }

  /** Writes a state as blobs and trees and returns the root tree's id. */
  async writeState(files: FileMap): Promise<string> {
    const build = async (prefix: string, paths: string[]): Promise<string> => {
      const direct: { name: string; path: string }[] = [];
      const groups = new Map<string, string[]>();
      for (const p of paths) {
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) direct.push({ name: rest, path: p });
        else { const d = rest.slice(0, slash); (groups.get(d) ?? groups.set(d, []).get(d)!).push(p); }
      }
      const entries: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
      for (const f of direct) entries.push({ mode: MODE_FILE, path: f.name, oid: await this.blobOid(f.path, files.get(f.path)!), type: 'blob' });
      for (const [d, sub] of groups) entries.push({ mode: MODE_TREE, path: d, oid: await build(`${prefix}${d}/`, sub), type: 'tree' });
      entries.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      return git.writeTree({ fs, gitdir: this.gitdir, tree: entries });
    };
    return build('', [...files.keys()]);
  }

  private commits = new Map<string, CommitInfo>();

  async commitOf(oid: string): Promise<CommitInfo> {
    const known = this.commits.get(oid);
    if (known) return known;
    const info = await this.readCommit(oid);
    this.commits.set(oid, info);
    return info;
  }

  private async readCommit(oid: string): Promise<CommitInfo> {
    const { commit } = await git.readCommit({ fs, gitdir: this.gitdir, oid });
    const parts = commit.message.split('\n\n');
    const subject = parts[0]!.trim();
    const trailerBlock = parts.length > 1 && /^Hull-/.test(parts[parts.length - 1]!) ? parts.pop()! : '';
    const trailers = new Map(trailerBlock.split('\n').filter(Boolean).map((l) => { const i = l.indexOf(': '); return [l.slice(0, i), l.slice(i + 2)] as const; }));
    const details = parts.slice(1).join('\n\n').split('\n').map((l) => l.trim()).filter(Boolean);
    return {
      id: oid,
      parents: commit.parent,
      by: commit.author.name as HistoryAuthor,
      at: trailers.get('Hull-At') ?? new Date(commit.author.timestamp * 1000).toISOString(),
      message: subject,
      details,
      kind: (trailers.get('Hull-Kind') as CommitInfo['kind'] | undefined) ?? 'change',
    };
  }

  async treeOf(oid: string): Promise<string> {
    return (await git.readCommit({ fs, gitdir: this.gitdir, oid })).commit.tree;
  }

  /** The files of a commit. */
  async filesAt(oid: string): Promise<FileMap> {
    const cached = this.fileCache.get(oid);
    if (cached) return new Map(cached);
    const out: FileMap = new Map();
    const walk = async (treeOid: string, prefix: string): Promise<void> => {
      const { tree } = await git.readTree({ fs, gitdir: this.gitdir, oid: treeOid });
      for (const e of tree) {
        if (e.type === 'tree') await walk(e.oid, `${prefix}${e.path}/`);
        else if (e.type === 'blob') out.set(`${prefix}${e.path}`, Buffer.from((await git.readBlob({ fs, gitdir: this.gitdir, oid: e.oid })).blob));
      }
    };
    await walk(await this.treeOf(oid), '');
    if (this.fileCache.size > 64) this.fileCache.clear();
    this.fileCache.set(oid, out);
    return new Map(out);
  }

  /**
   * Commits a state on `ref` (a full ref name). Returns undefined when the state equals the ref's newest change, so
   * "nothing changed" never makes a record. `parents` defaults to the ref's current tip.
   */
  async commit(ref: string, files: FileMap, o: { by: HistoryAuthor; message: string; details?: string[]; kind?: CommitInfo['kind']; at?: Date; parents?: string[]; force?: boolean }): Promise<string | undefined> {
    const tip = await this.resolve(ref);
    const tree = await this.writeState(files);
    if (tip && !o.force && (await this.treeOf(tip)) === tree) return undefined;
    const at = o.at ?? new Date();
    const message = `${o.message}\n\n${(o.details ?? []).join('\n')}\n\nHull-Kind: ${o.kind ?? 'change'}\nHull-At: ${at.toISOString()}\n`;
    const who = { name: o.by, email: `${o.by.replace(/[^a-z0-9]+/gi, '-')}@hull.local`, timestamp: Math.floor(at.getTime() / 1000), timezoneOffset: 0 };
    const oid = await git.writeCommit({ fs, gitdir: this.gitdir, commit: { message, tree, parent: o.parents ?? (tip ? [tip] : []), author: who, committer: who } });
    await this.setRef(ref, oid);
    this.fileCache.set(oid, new Map(files));
    return oid;
  }

  /** The first-parent chain from `oid`, newest first, stopping before any id in `stop`. */
  async chainFrom(oid: string | undefined, stop: ReadonlySet<string> = new Set(), limit = 5000): Promise<CommitInfo[]> {
    const out: CommitInfo[] = [];
    let cur = oid;
    while (cur && !stop.has(cur) && out.length < limit) {
      const c = await this.commitOf(cur);
      out.push(c);
      cur = c.parents[0];
    }
    return out;
  }

  async mergeBase(a: string, b: string): Promise<string | undefined> {
    try { return (await git.findMergeBase({ fs, gitdir: this.gitdir, oids: [a, b] }))[0]; } catch { return undefined; }
  }
}
