// M1 history: an append-only list of changes in .hull/journal.jsonl, one JSON object per line. M2 replays it into the
// history store, so the line format is the protocol's `Change` and nothing else.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Change } from 'hull/dev/protocol';

export function journalPath(root: string): string {
  return join(root, '.hull', 'journal.jsonl');
}

export function appendChange(root: string, change: Change): void {
  mkdirSync(join(root, '.hull'), { recursive: true });
  appendFileSync(journalPath(root), `${JSON.stringify(change)}\n`);
}

/** The newest `limit` changes, newest last. A damaged line is skipped, never fatal. */
export function readJournal(root: string, limit = 200): Change[] {
  let text: string;
  try { text = readFileSync(journalPath(root), 'utf8'); } catch { return []; }
  const out: Change[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Change); } catch { /* skip */ }
  }
  return out.slice(-limit);
}
