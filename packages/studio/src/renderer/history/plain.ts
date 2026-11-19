// The History panel's words and shapes: plain-language lines for deltas, author labels, and the branch lanes of the timeline.
// No React here, so it is unit-tested in Node.

import type { ChangeDelta, ExpInfo, HistoryAuthor, HistoryChange } from 'hull/dev/protocol';
import { unescapePointer } from '../lib/math.ts';

/** 'jumpHeight' -> 'jump height'; 'wall_height' -> 'wall height'. */
export const words = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();

/** A value as a person says it: 2.6, on, "hello", [1, 2]. */
export function say(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') return String(Math.round(v * 10000) / 10000);
  if (typeof v === 'string') return v.length > 28 ? `"${v.slice(0, 26)}..."` : `"${v}"`;
  const s = JSON.stringify(v);
  return s.length > 34 ? `${s.slice(0, 32)}...` : s;
}

export interface PlainDelta {
  /** Where it lives, as a quiet prefix: 'player', 'tuning/jump', 'src/tuning.ts'. */
  scope: string;
  /** What it is, in words: 'jump height'. */
  what: string;
  op: ChangeDelta['op'];
  from: string;
  to: string;
  /** The whole line as text. */
  text: string;
  /** Stable key for lists and for matching two sides of a compare. */
  key: string;
}

export function plain(d: ChangeDelta): PlainDelta {
  const key = `${d.target}#${d.path}`;
  let scope: string;
  let what: string;
  if (d.kind === 'tunable') { scope = d.target.replace(/^tunables:/, ''); what = words(d.path); }
  else if (d.kind === 'json') {
    scope = d.target;
    what = d.path === '' ? 'whole file' : d.path.split('/').slice(1).map((p) => words(unescapePointer(p))).join(' ');
  } else {
    scope = d.target;
    what = d.kind === 'lines' ? `${d.added ?? 0} lines added, ${d.removed ?? 0} removed` : d.op === 'add' ? 'added' : d.op === 'remove' ? 'removed' : 'changed';
  }
  const from = d.op === 'add' ? '' : say(d.from);
  const to = d.op === 'remove' ? '' : say(d.to);
  const tail = d.kind === 'lines' || d.kind === 'asset' || d.kind === 'file' ? '' : d.op === 'add' ? ` added: ${to}` : d.op === 'remove' ? ` removed (was ${from})` : ` ${from} → ${to}`;
  return { scope, what, op: d.op, from, to, text: `${what}${tail}`, key };
}

export const isAi = (by: string): boolean => by.startsWith('ai:') || by.startsWith('marl:');

/** The chip text for an author: 'you', 'ai · test', 'marl · tuner', 'disk'. */
export function authorLabel(by: HistoryAuthor): string {
  if (by === 'you' || by === 'disk') return by;
  return by.replace(/^(ai|marl):/, '$1 · ');
}
export const authorClass = (by: HistoryAuthor): string => (isAi(by) ? 'ai' : by === 'disk' ? 'disk' : 'you');

/** 'just now', '5 min ago', 'yesterday', or the date. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(iso).toLocaleDateString();
}

// ---- timeline lanes ---------------------------------------------------------------------------------------------------------

export interface LaneRow {
  change: HistoryChange;
  /** Lane of this change's own dot: 0 is main. */
  lane: number;
  /** Lanes whose line passes through this row: 'top' ends here (comes from above), 'bottom' starts here, 'full' passes. */
  lines: { lane: number; part: 'full' | 'top' | 'bottom' }[];
  /** A branch rejoins main here (the fork point): draw a curve from this lane into main. */
  forkFrom: number[];
  /** A merge brings this lane into main on this row. */
  mergeFrom: number[];
}

/**
 * Lays the timeline out as branches, newest first. Main is lane 0, each experiment gets the next lane in the order it
 * started. A lane's line runs from the experiment's newest change (or the merge that adopted it) down to where it forked.
 */
export function layout(changes: readonly HistoryChange[], exps: readonly ExpInfo[]): { rows: LaneRow[]; lanes: string[] } {
  const names = ['main', ...[...exps].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((e) => e.name)];
  for (const c of changes) if (!names.includes(c.line)) names.push(c.line);
  const laneOf = (line: string): number => Math.max(0, names.indexOf(line));
  const index = new Map(changes.map((c, i) => [c.id, i]));
  const rows: LaneRow[] = changes.map((change) => ({ change, lane: laneOf(change.line), lines: [], forkFrom: [], mergeFrom: [] }));
  const last = changes.length - 1;

  // Main's line runs from its newest change to the oldest row.
  const mainTop = Math.max(0, changes.findIndex((c) => c.line === 'main'));
  for (let i = mainTop; i <= last; i++) rows[i]!.lines.push({ lane: 0, part: mainTop === last ? 'full' : i === mainTop ? 'bottom' : i === last ? 'top' : 'full' });

  names.forEach((name, lane) => {
    if (lane === 0) return;
    let top = Infinity;
    let bottom = -1;
    const exp = exps.find((e) => e.name === name);
    changes.forEach((c, i) => { if (c.line === name) { top = Math.min(top, i); bottom = Math.max(bottom, i); } });
    // The merge that adopted it sits on main and has the experiment's tip as its second parent.
    changes.forEach((c, i) => {
      if (c.kind === 'merge' && c.parents.length > 1 && changes.some((x) => x.line === name && x.id === c.parents[1])) { top = Math.min(top, i); rows[i]!.mergeFrom.push(lane); }
    });
    const forkRow = exp ? index.get(exp.from) : undefined;
    if (!Number.isFinite(top)) { if (forkRow === undefined) return; top = forkRow; }
    bottom = Math.max(bottom, forkRow ?? last);
    for (let i = top; i <= bottom && i < rows.length; i++) {
      const part = top === bottom ? 'full' : i === top ? 'bottom' : i === bottom ? 'top' : 'full';
      rows[i]!.lines.push({ lane, part });
    }
    if (forkRow !== undefined) rows[forkRow]!.forkFrom.push(lane);
  });
  return { rows, lanes: names };
}

/** The colour of a lane: main is the accent, the others cycle through a few more hues. */
export const LANE_COLORS = ['var(--accent)', '#7457c9', 'var(--ok)', 'var(--warn)', '#1f8a9c', '#c44d86'];
export const laneColor = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length]!;
