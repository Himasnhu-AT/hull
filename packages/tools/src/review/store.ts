// Review notes: the record of what a person has checked (SCHEMAS section 13). It lives in .hull/review.json, not in
// the project's folders. A piece is identified by its content hash at review time: when the piece changes, its state
// falls back to unreviewed and the old note stays beside it until someone clears it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Problem } from 'hull';
import type { Author, ReviewEntry, ReviewState } from 'hull/dev/protocol';
import { explainHash } from '../create/explain.ts';
import { findTunables } from '../server/tsTunables.ts';

interface Stored { state: ReviewState; note?: string; at?: string; by?: Author; hash: string }
interface File { items: Record<string, Stored> }

export const REVIEW_STATES: readonly ReviewState[] = ['unreviewed', 'approved', 'needs-change'];
const FILE = '.hull/review.json';
const sha = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 6);

function walkTs(dir: string, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (n.endsWith('.ts') && !n.endsWith('.d.ts') && !n.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** The content hash of the piece a key names, or null when there is no such piece. `#part` is ignored: the whole piece is hashed. */
export function hashOf(root: string, key: string): string | null {
  const base = key.split('#')[0]!;
  if (base.startsWith('tunables:')) {
    const block = base.slice('tunables:'.length);
    for (const abs of walkTs(join(root, 'src'))) {
      const text = readFileSync(abs, 'utf8');
      if (!text.includes('tunables')) continue;
      const found = findTunables(abs, text).find((b) => b.block === block);
      if (found) return sha(JSON.stringify(found.tunables.map((t) => [t.key, t.value])));
    }
    return null;
  }
  if (base.startsWith('explain:')) return explainHash(root, base.slice('explain:'.length));
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)+$/.test(base) || base.includes('..')) return null;
  try { return sha(readFileSync(join(root, 'config', `${base}.json`), 'utf8')); } catch { return null; }
}

function read(root: string): File {
  try {
    const v = JSON.parse(readFileSync(join(root, FILE), 'utf8')) as File;
    if (v && typeof v.items === 'object' && v.items) return v;
  } catch { /* none yet, or unreadable: start empty */ }
  return { items: {} };
}

function write(root: string, f: File): void {
  mkdirSync(join(root, '.hull'), { recursive: true });
  const tmp = join(root, '.hull', `review.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`);
  renameSync(tmp, join(root, FILE));
}

function entryOf(key: string, s: Stored, current: string | null): ReviewEntry {
  const stale = current !== null && s.hash !== current && s.state !== 'unreviewed';
  const e: ReviewEntry = { key, state: stale ? 'unreviewed' : s.state, hash: current ?? s.hash };
  if (s.note !== undefined) e.note = s.note;
  if (s.at) e.at = s.at;
  if (s.by) e.by = s.by;
  if (stale) { e.stale = true; e.was = s.state; }
  return e;
}

/** Every note, oldest key first. `open` keeps the ones that still need attention: needs-change, stale, or unreviewed with a note. */
export function listReview(root: string, open = false): ReviewEntry[] {
  const f = read(root);
  const all = Object.keys(f.items).sort().map((k) => entryOf(k, f.items[k]!, hashOf(root, k)));
  return open ? all.filter((e) => e.state === 'needs-change' || e.stale || (e.state === 'unreviewed' && e.note)) : all;
}

export type ReviewResult = { ok: boolean; problems: Problem[]; entry?: ReviewEntry };
const bad = (message: string): ReviewResult => ({ ok: false, problems: [{ file: FILE, rule: 'review', message }] });

/** Sets a state (and optionally the note). A note is kept when a later call sets only the state. */
export function setReview(root: string, a: { key: string; state: ReviewState; note?: string; author: Author }): ReviewResult {
  if (!REVIEW_STATES.includes(a.state)) return bad(`state must be one of ${REVIEW_STATES.join(', ')}, got "${String(a.state)}"`);
  const hash = hashOf(root, a.key);
  if (hash === null) return bad(`"${a.key}" is not a config id like 'sound/sword/hit', a tunables block like 'tunables:player' or an explain document like 'explain:enemy-guard' that exists in this project`);
  const f = read(root);
  const old = f.items[a.key];
  const s: Stored = { state: a.state, at: new Date().toISOString(), by: a.author, hash };
  const note = a.note ?? old?.note;
  if (note !== undefined && note !== '') s.note = note;
  f.items[a.key] = s;
  write(root, f);
  return { ok: true, problems: [], entry: entryOf(a.key, s, hash) };
}

/** Writes a note without changing the review state (a stale piece stays stale until it is reviewed again). */
export function noteReview(root: string, a: { key: string; note: string; author: Author }): ReviewResult {
  const hash = hashOf(root, a.key);
  if (hash === null) return bad(`"${a.key}" is not a config id or tunables block that exists in this project`);
  const f = read(root);
  const old = f.items[a.key] ?? { state: 'unreviewed' as ReviewState, hash };
  const s: Stored = { ...old, at: new Date().toISOString(), by: a.author };
  if (a.note === '') delete s.note; else s.note = a.note;
  f.items[a.key] = s;
  write(root, f);
  return { ok: true, problems: [], entry: entryOf(a.key, s, hash) };
}

export const reviewFileExists = (root: string): boolean => existsSync(join(root, FILE));
