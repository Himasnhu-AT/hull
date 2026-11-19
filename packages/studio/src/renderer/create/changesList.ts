// Changes: the main line of the history as a plain list. No React here, so it is unit-tested in Node.
// The words come from the history's own messages; who made a change is said as a person would.

import type { ChangeDelta, HistoryAuthor, HistoryChange } from 'hull/dev/protocol';
import { ago } from '../history/plain.ts';
import { authorName, plainLine, undoneBy } from './plainNames.ts';
import { describe, revertOrder, type ChangeRow } from '../history/changesView.ts';

export interface ChangeEntry {
  id: string;
  /** What changed, in words. */
  title: string;
  /** The details under it, a few lines. */
  lines: string[];
  /** The text the title and lines were made from, for the tooltip that keeps the raw ids reachable. */
  titleRaw: string;
  linesRaw: string[];
  /** How many more lines there were than shown. */
  more: number;
  who: string;
  when: string;
  /** The change is the start of the project: nothing to put back. */
  start: boolean;
  /** A change that put another back. */
  restore: boolean;
}

/** 'you' -> You; any agent -> Builder; 'disk' -> A file edit. */
export const whoLabel = (by: HistoryAuthor | string): string => authorName(by);

/**
 * The changes that only put another change back, by id, each with the lines of the change it put back: the person's own
 * change whose every value is an older change's value turned round. The list is newest first, as mainLine gives it.
 */
export function putBackOf(list: readonly HistoryChange[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  list.forEach((c, i) => {
    if (c.by !== 'you' || c.kind === 'start') return;
    const now = c.details.length > 0 ? c.details : [c.message];
    for (let j = i + 1; j < list.length; j++) {
      const p = list[j]!;
      const undone = undoneBy(now, p.details.length > 0 ? p.details : [p.message]);
      if (undone) { out.set(c.id, undone); return; }
    }
  });
  return out;
}

const MAX_LINES = 4;

/** `undone`: the lines of the older change this one only put back (see putBackOf); its title says "Put back" and names that change. */
export function entryOf(c: HistoryChange, now = Date.now(), undone?: readonly string[]): ChangeEntry {
  const putBack = undone !== undefined && undone.length > 0;
  const details = c.details.filter((d) => d && d !== c.message);
  const titleRaw = c.kind === 'start' ? 'Project started' : c.message || 'A change';
  // A put-back is titled by the change it put back; its own details would only say the same turned round.
  const first = putBack ? undone[0]! : '';
  const shown = putBack ? undone.slice(1) : details;
  return {
    id: c.id,
    title: putBack ? `Put back: ${plainLine(first)}` : c.kind === 'start' ? titleRaw : plainLine(titleRaw),
    titleRaw: putBack ? first : titleRaw,
    lines: shown.slice(0, MAX_LINES).map(plainLine),
    linesRaw: shown.slice(0, MAX_LINES),
    more: Math.max(0, shown.length - MAX_LINES),
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
