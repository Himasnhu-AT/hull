// Changes: the main line of the history as a plain list. No React here, so it is unit-tested in Node.
// The words come from the history's own messages; who made a change is said as a person would.

import type { ChangeDelta, HistoryAuthor, HistoryChange } from 'hull/dev/protocol';
import { ago } from '../history/plain.ts';
import { describe, revertOrder, type ChangeRow } from '../history/changesView.ts';

export interface ChangeEntry {
  id: string;
  /** What changed, in words. */
  title: string;
  /** The details under it, a few lines. */
  lines: string[];
  /** How many more lines there were than shown. */
  more: number;
  who: string;
  when: string;
  /** The change is the start of the project: nothing to put back. */
  start: boolean;
  /** A change that put another back. */
  restore: boolean;
}

/** 'you' -> You; 'ai:hull' -> Hull builder; 'ai:test' -> Test builder; 'disk' -> A file edit. */
export function whoLabel(by: HistoryAuthor | string): string {
  if (by === 'you') return 'You';
  if (by === 'disk') return 'A file edit';
  const name = by.replace(/^(ai|marl):/, '');
  return name ? `${name[0]!.toUpperCase()}${name.slice(1)} builder` : 'The builder';
}

const MAX_LINES = 4;

export function entryOf(c: HistoryChange, now = Date.now()): ChangeEntry {
  const details = c.details.filter((d) => d && d !== c.message);
  return {
    id: c.id,
    title: c.kind === 'start' ? 'Project started' : c.message || 'A change',
    lines: details.slice(0, MAX_LINES),
    more: Math.max(0, details.length - MAX_LINES),
    who: whoLabel(c.by),
    when: ago(c.at, now),
    start: c.kind === 'start',
    restore: c.kind === 'restore',
  };
}

/** The main line, newest first. The server lists newest first already; the sort keeps it so whatever the order. */
export function mainLine(changes: readonly HistoryChange[]): HistoryChange[] {
  return changes.filter((c) => c.line === 'main').map((c, i) => ({ c, i })).sort((a, b) => (Date.parse(b.c.at) - Date.parse(a.c.at)) || a.i - b.i).map((x) => x.c);
}

/**
 * The actions that undo one change: each field goes back to what it was before, the way the Changes tab does it
 * (field reverts back to front so array rows keep their indexes). History.revert reads the file from the change's parent.
 */
export function putBackRows(deltas: readonly ChangeDelta[]): ChangeRow[] {
  return revertOrder(deltas.map((d) => describe(d, () => undefined)));
}
