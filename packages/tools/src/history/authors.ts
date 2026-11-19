// Who last set each value (ARCHITECTURE section 7, "Authorship per value"). Config and tunables are compared by path, so
// every change says which values it set and who set them. The record lives in .hull/authors.json and is only a cache of
// the history: when it is missing or does not match the newest change, it is rebuilt by walking the history again.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Problem } from 'hull';
import type { ChangeDelta, HistoryAuthor } from 'hull/dev/protocol';
import { diffFiles, showValue } from './diff.ts';
import { Store, type CommitInfo } from './store.ts';

export interface AuthorEntry {
  by: HistoryAuthor;
  at: string;
  commit: string;
  file: string;
  target: string;
  path: string;
  value?: unknown;
  /** Set when an AI change replaced a value `you` had set. Cleared when you set the value again. */
  over?: { by: 'you'; value: unknown; commit: string };
}
export type Entries = Record<string, AuthorEntry>;
interface BookFile { head: string | null; entries: Entries }

export const isAi = (by: string): boolean => by.startsWith('ai:') || by.startsWith('marl:');
const keyOf = (target: string, path: string): string => `${target}#${path}`;
const esc = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** The leaves of a value as [path, value]: a changed object is many values set at once. */
function leaves(v: unknown, path: string, out: [string, unknown][] = []): [string, unknown][] {
  if (v !== null && typeof v === 'object' && Object.keys(v).length > 0) {
    for (const [k, x] of Object.entries(v)) leaves(x, `${path}/${Array.isArray(v) ? k : esc(k)}`, out);
  } else out.push([path, v]);
  return out;
}

/** Applies one change's deltas. Only config and tunable values have authors; lines and assets do not. */
export function applyDeltas(entries: Entries, deltas: readonly ChangeDelta[], by: (d: ChangeDelta) => HistoryAuthor, at: string, commit: string): void {
  for (const d of deltas) {
    if (d.kind !== 'json' && d.kind !== 'tunable') continue;
    const author = by(d);
    const related = (k: AuthorEntry): boolean => k.target === d.target && (k.path === d.path || k.path.startsWith(`${d.path}/`) || d.path.startsWith(`${k.path}/`));
    const prior = Object.values(entries).filter(related);
    if (d.op === 'remove') { for (const k of prior) delete entries[keyOf(k.target, k.path)]; continue; }
    const youSet = prior.find((k) => k.by === 'you');
    const earlier = prior.find((k) => k.over);
    for (const k of prior) if (k.path === d.path || k.path.startsWith(`${d.path}/`)) delete entries[keyOf(k.target, k.path)];
    for (const [p, value] of d.kind === 'json' ? leaves(d.to, d.path) : [[d.path, d.to] as [string, unknown]]) {
      const entry: AuthorEntry = { by: author, at, commit, file: d.file, target: d.target, path: p, value };
      if (isAi(author)) {
        if (youSet) entry.over = { by: 'you', value: youSet.value, commit: youSet.commit };
        else if (earlier?.over) entry.over = earlier.over;
      }
      entries[keyOf(d.target, p)] = entry;
    }
  }
}

/** AI changes that overwrote a value you set, as problems naming file#pointer. */
export function authorshipProblems(entries: Entries): Problem[] {
  const out: Problem[] = [];
  for (const e of Object.values(entries)) {
    if (!e.over || !isAi(e.by)) continue;
    const pointer = e.target.startsWith('tunables:') ? `/${e.target.slice('tunables:'.length)}/${e.path}` : e.path;
    out.push({
      file: e.file, pointer, rule: 'authorship',
      message: `${e.by} changed ${e.target.startsWith('tunables:') ? `${e.target.slice(9)}.${e.path}` : `${e.target}#${e.path}`} from ${showValue(e.over.value)} (set by you) to ${showValue(e.value)}`,
    });
  }
  return out;
}

/**
 * The deltas a commit contributed and who each belongs to. A merge (an adopted experiment) contributes what it brought
 * into the main line, and each value is credited to whoever last set it inside the experiment.
 */
export async function contribution(store: Store, c: CommitInfo): Promise<{ deltas: ChangeDelta[]; by: (d: ChangeDelta) => HistoryAuthor } | undefined> {
  const parent = c.parents[0];
  if (!parent) return undefined;
  const after = await store.filesAt(c.id);
  const deltas = diffFiles(await store.filesAt(parent), after);
  if (c.parents.length < 2) return { deltas, by: () => c.by };
  const theirs = c.parents[1]!;
  const base = await store.mergeBase(parent, theirs);
  const last = new Map<string, HistoryAuthor>();
  for (const x of (await store.chainFrom(theirs, new Set(base ? [base] : []))).reverse()) {
    const p = x.parents[0];
    if (!p) continue;
    for (const d of diffFiles(await store.filesAt(p), await store.filesAt(x.id))) last.set(keyOf(d.target, d.path), x.by);
  }
  return { deltas, by: (d) => last.get(keyOf(d.target, d.path)) ?? c.by };
}

export async function rebuild(store: Store, tip: string | undefined): Promise<Entries> {
  const entries: Entries = {};
  for (const c of (await store.chainFrom(tip)).reverse()) {
    const r = await contribution(store, c);
    if (r) applyDeltas(entries, r.deltas, r.by, c.at, c.id);
  }
  return entries;
}

const bookPath = (root: string): string => join(root, '.hull', 'authors.json');

export function saveBook(root: string, head: string | undefined, entries: Entries): void {
  mkdirSync(join(root, '.hull'), { recursive: true });
  writeFileSync(bookPath(root), `${JSON.stringify({ head: head ?? null, entries } satisfies BookFile, null, 2)}\n`);
}

/** authors.json, trusted only while it matches the newest change on the main line; otherwise rebuilt from history. */
export async function loadBook(root: string, store: Store, tip: string | undefined): Promise<Entries> {
  try {
    const f = JSON.parse(readFileSync(bookPath(root), 'utf8')) as BookFile;
    if (f.head === (tip ?? null) && f.entries && typeof f.entries === 'object') return f.entries;
  } catch { /* lost or damaged: rebuilt below */ }
  const entries = await rebuild(store, tip);
  saveBook(root, tip, entries);
  return entries;
}

/** For the check tool: no history yet means nothing to flag. */
export async function checkAuthorship(root: string): Promise<Problem[]> {
  const store = new Store(root);
  if (!store.exists()) return [];
  const tip = await store.resolve('refs/heads/main');
  if (!tip) return [];
  return authorshipProblems(await loadBook(root, store, tip));
}
