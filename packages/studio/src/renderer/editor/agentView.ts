// The agent panel's transcript as data: events in, a list of things to draw out. Kept free of React so it can be tested.

import type { AgentEvent, PermissionOption, PlanEntry, ToolView } from '../../shared/agentApi.ts';

export type Item =
  | { k: 'user'; text: string }
  | { k: 'agent'; text: string }
  | { k: 'thought'; text: string }
  | { k: 'plan'; entries: PlanEntry[] }
  | { k: 'tool'; tool: ToolView }
  | { k: 'perm'; reqId: string; tool: ToolView; options: PermissionOption[]; answer?: { optionId: string | null; name: string } }
  | { k: 'end'; stopReason: string }
  | { k: 'note'; text: string; error?: boolean };

/** Folds one event into the transcript. Text chunks join the message before them; a tool or the plan is updated where it stands. */
export function reduce(items: readonly Item[], e: AgentEvent): Item[] {
  switch (e.type) {
    case 'message': {
      const last = items[items.length - 1];
      if (last && last.k === e.role) return [...items.slice(0, -1), { k: e.role, text: last.text + e.text }];
      return [...items, { k: e.role, text: e.text }];
    }
    case 'plan': {
      const at = items.findIndex((i) => i.k === 'plan');
      const plan: Item = { k: 'plan', entries: e.entries };
      return at < 0 ? [...items, plan] : items.map((i, n) => (n === at ? plan : i));
    }
    case 'tool': {
      const at = items.findIndex((i) => i.k === 'tool' && i.tool.id === e.tool.id);
      const t: Item = { k: 'tool', tool: e.tool };
      return at < 0 ? [...items, t] : items.map((i, n) => (n === at ? t : i));
    }
    case 'permission': return [...items, { k: 'perm', reqId: e.reqId, tool: e.tool, options: e.options }];
    case 'permission-done':
      return items.map((i) => (i.k === 'perm' && i.reqId === e.reqId
        ? { ...i, answer: { optionId: e.optionId, name: i.options.find((o) => o.id === e.optionId)?.name ?? 'Cancelled' } } : i));
    case 'done': return [...items, { k: 'end', stopReason: e.stopReason }];
    case 'status':
      return e.state === 'error' || (e.state === 'closed' && e.message) ? [...items, { k: 'note', text: e.message ?? 'The agent stopped.', error: e.state === 'error' }] : [...items];
    default: return [...items];
  }
}

export interface PlanProgress { done: number; total: number }
export const planProgress = (entries: readonly PlanEntry[]): PlanProgress => ({ done: entries.filter((x) => x.status === 'completed').length, total: entries.length });

export interface DiffLine { t: ' ' | '+' | '-' | '…'; s: string }

/** A line diff of old against new, with three lines of context around each change and "…" where unchanged lines were left out. */
export function lineDiff(oldText: string | null, newText: string, context = 3): DiffLine[] {
  const a = oldText === null || oldText === '' ? [] : oldText.split('\n');
  const b = newText.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const mid: DiffLine[] = [];
  if (am.length * bm.length > 2_000_000) {
    for (const s of am) mid.push({ t: '-', s });
    for (const s of bm) mid.push({ t: '+', s });
  } else {
    // Longest common subsequence of the changed middle: small in practice, since the edit tools change a few lines.
    const w = bm.length + 1;
    const l = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) for (let j = bm.length - 1; j >= 0; j--) l[i * w + j] = am[i] === bm[j] ? l[(i + 1) * w + j + 1]! + 1 : Math.max(l[(i + 1) * w + j]!, l[i * w + j + 1]!);
    let i = 0; let j = 0;
    while (i < am.length || j < bm.length) {
      if (i < am.length && j < bm.length && am[i] === bm[j]) { mid.push({ t: ' ', s: am[i]! }); i++; j++; }
      else if (i < am.length && (j === bm.length || l[(i + 1) * w + j]! >= l[i * w + j + 1]!)) { mid.push({ t: '-', s: am[i]! }); i++; }
      else { mid.push({ t: '+', s: bm[j]! }); j++; }
    }
  }
  const all: DiffLine[] = [...a.slice(Math.max(0, head - context), head).map((s): DiffLine => ({ t: ' ', s })), ...mid, ...a.slice(a.length - tail, a.length - tail + context).map((s): DiffLine => ({ t: ' ', s }))];
  const out: DiffLine[] = [];
  if (head > context) out.push({ t: '…', s: `${head - context} unchanged lines` });
  out.push(...all);
  if (tail > context) out.push({ t: '…', s: `${tail - context} unchanged lines` });
  return out;
}

export const diffStat = (d: readonly DiffLine[]): { added: number; removed: number } => ({ added: d.filter((x) => x.t === '+').length, removed: d.filter((x) => x.t === '-').length });

/** What a tool kind is called on the card. */
export const toolWord = (kind: string): string => ({ read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search', execute: 'Run', think: 'Think', fetch: 'Fetch' } as Record<string, string>)[kind] ?? 'Tool';
