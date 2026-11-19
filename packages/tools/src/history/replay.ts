// Turns the M1 journal (.hull/journal.jsonl) into the first commits of the history store. The project on disk is the
// state after every journal entry, so the entries are undone in memory (newest first) to find where history starts, then
// replayed forward one commit each, with the journal's author and time.
import type { Change } from 'hull/dev/protocol';
import { setJsonPointer } from '../server/jsonEdit.ts';
import { rewriteTunable } from '../server/tsTunables.ts';
import { diffFiles, isTsSource, summarize, tunablesOf, type FileMap } from './diff.ts';
import type { Store } from './store.ts';

/** Sets one journal entry's value in a state. Returns false when it cannot (the file or the value is gone). */
export function applyChange(files: FileMap, c: Change, value: unknown): boolean {
  if (value === undefined) return false;
  if (c.target.startsWith('tunables:')) {
    const block = c.target.slice('tunables:'.length);
    for (const [p, d] of files) {
      if (!isTsSource(p)) continue;
      const text = d.toString('utf8');
      if (!tunablesOf(p, text).has(`${block}.${c.path}`)) continue;
      const r = rewriteTunable(p, text, block, c.path, value);
      if (!r.ok) return false;
      files.set(p, Buffer.from(r.text));
      return true;
    }
    return false;
  }
  const path = c.target === 'hull.json' ? 'hull.json' : `config/${c.target}.json`;
  const cur = files.get(path);
  if (!cur) return false;
  const r = setJsonPointer(cur.toString('utf8'), c.path, value);
  if (!r.ok) return false;
  files.set(path, Buffer.from(r.text));
  return true;
}

/**
 * Creates `refs/heads/main` from the project's current files and the journal. Entries that cannot be undone (a value
 * that did not exist before) are left out of the replay: the state they led to is still in the first commit.
 */
export async function replayJournal(store: Store, current: FileMap, journal: readonly Change[]): Promise<number> {
  const files: FileMap = new Map(current);
  const usable: Change[] = [];
  for (let i = journal.length - 1; i >= 0; i--) {
    const c = journal[i]!;
    if (applyChange(files, c, c.from)) usable.unshift(c);
  }
  const firstAt = usable[0] ? new Date(usable[0].at).getTime() - 1000 : Date.now();
  await store.commit('refs/heads/main', files, { by: 'you', message: 'start of history', kind: 'start', at: new Date(Number.isFinite(firstAt) ? firstAt : Date.now()), force: true });
  let n = 0;
  for (const c of usable) {
    const before = new Map(files);
    if (!applyChange(files, c, c.to)) continue;
    const deltas = diffFiles(before, files);
    const at = new Date(c.at);
    const id = await store.commit('refs/heads/main', files, { by: c.by, message: summarize(deltas), details: deltas.map((d) => d.text), at: Number.isNaN(at.getTime()) ? new Date() : at });
    if (id) n++;
  }
  return n;
}
