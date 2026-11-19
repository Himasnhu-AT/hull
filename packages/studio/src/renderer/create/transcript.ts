// The builder's conversation as data: events in, a list of things to draw out. No React, so it is tested in Node.
// The model is editor/agentView.ts; this one knows the cards (UiBlock), keeps streamed text growing in one item, replaces a
// card in place when it is sent again with the same id, and folds the tool calls of a run into one quiet "working" line.

import type { UiBlock } from 'hull/dev/protocol';
import type { AgentEvent, PermissionOption, ToolView } from '../../shared/agentApi.ts';

export type Item =
  | { k: 'user'; key: string; text: string; chips: string[] }
  | { k: 'agent'; key: string; text: string; live: boolean; chunks: number }
  /** A card. `reqId` is present when the builder waits on it; `answer` fills in when it was answered. `sent` counts how often it was sent. */
  | { k: 'ui'; key: string; block: UiBlock; reqId?: string; answer?: { optionId: string | null; name: string }; sent: number }
  | { k: 'working'; key: string; tools: ToolView[] }
  | { k: 'perm'; key: string; reqId: string; tool: ToolView; options: PermissionOption[]; answer?: { optionId: string | null; name: string } }
  | { k: 'note'; key: string; text: string; error: boolean };

export interface Transcript { items: Item[]; running: boolean; seq: number }
export const emptyTranscript = (): Transcript => ({ items: [], running: false, seq: 0 });

/** What the person did, as an event of their own: they sent a note. */
export type TranscriptEvent = AgentEvent | { type: 'sent'; text: string; chips?: string[] };

const stop = (items: Item[]): Item[] => items.map((i) => (i.k === 'agent' && i.live ? { ...i, live: false } : i));

/** Which choice an answer was, in words. A cancelled card was answered in the person's own words. */
export function answerName(block: UiBlock, optionId: string | null, options?: readonly PermissionOption[]): string {
  if (optionId === null) return 'Answered in words';
  if (block.kind === 'ask') return block.options[Number(optionId)] ?? options?.find((o) => o.id === optionId)?.name ?? optionId;
  if (block.kind === 'approve') return optionId === 'yes' ? block.yes : block.no;
  return optionId;
}

export function reduce(t: Transcript, e: TranscriptEvent): Transcript {
  const key = (): string => `i${t.seq}`;
  const next = (items: Item[], more: Partial<Transcript> = {}): Transcript => ({ ...t, items, seq: t.seq + 1, ...more });
  switch (e.type) {
    case 'sent': return next([...stop(t.items), { k: 'user', key: key(), text: e.text, chips: e.chips ?? [] }], { running: true });
    case 'message': {
      if (e.role !== 'agent') return t;
      const last = t.items[t.items.length - 1];
      if (last && last.k === 'agent' && last.live) return { ...t, items: [...t.items.slice(0, -1), { ...last, text: last.text + e.text, chunks: last.chunks + 1 }] };
      if (e.text === '') return t;
      return next([...stop(t.items), { k: 'agent', key: key(), text: e.text, live: true, chunks: 1 }], { running: true });
    }
    case 'ui': {
      const at = t.items.findIndex((i) => i.k === 'ui' && i.block.id === e.block.id);
      if (at >= 0) {
        const prev = t.items[at] as Extract<Item, { k: 'ui' }>;
        // A card sent again keeps where it stands and what was answered; a new request replaces the old answer.
        const item: Item = { ...prev, block: e.block, sent: prev.sent + 1, ...(e.reqId ? { reqId: e.reqId } : {}) };
        if (e.reqId) delete (item as { answer?: unknown }).answer;
        return { ...t, items: t.items.map((i, n) => (n === at ? item : i)) };
      }
      return next([...stop(t.items), { k: 'ui', key: key(), block: e.block, sent: 1, ...(e.reqId ? { reqId: e.reqId } : {}) }], { running: true });
    }
    case 'tool': {
      const at = t.items.findIndex((i) => i.k === 'working' && i.tools.some((x) => x.id === e.tool.id));
      if (at >= 0) return { ...t, items: t.items.map((i, n) => (n === at && i.k === 'working' ? { ...i, tools: i.tools.map((x) => (x.id === e.tool.id ? e.tool : x)) } : i)) };
      const last = t.items[t.items.length - 1];
      if (last && last.k === 'working') return { ...t, items: [...t.items.slice(0, -1), { ...last, tools: [...last.tools, e.tool] }] };
      return next([...stop(t.items), { k: 'working', key: key(), tools: [e.tool] }], { running: true });
    }
    case 'permission': return next([...stop(t.items), { k: 'perm', key: key(), reqId: e.reqId, tool: e.tool, options: e.options }], { running: true });
    case 'permission-done':
      return { ...t, items: t.items.map((i) => {
        if (i.k === 'perm' && i.reqId === e.reqId) return { ...i, answer: { optionId: e.optionId, name: i.options.find((o) => o.id === e.optionId)?.name ?? 'Cancelled' } };
        if (i.k === 'ui' && i.reqId === e.reqId) return { ...i, answer: { optionId: e.optionId, name: answerName(i.block, e.optionId) } };
        return i;
      }) };
    case 'done': return { ...t, items: stop(t.items), running: false };
    case 'status':
      if (e.state === 'running') return { ...t, running: true };
      if (e.state === 'ready') return { ...t, items: stop(t.items), running: false };
      if (e.state === 'error' || (e.state === 'closed' && e.message)) return next([...stop(t.items), { k: 'note', key: key(), text: e.message ?? 'The builder stopped.', error: e.state === 'error' }], { running: false });
      return t;
    default: return t;
  }
}

/** The cards the builder is waiting on. */
export const waiting = (t: Transcript): Extract<Item, { k: 'ui' }>[] => t.items.filter((i): i is Extract<Item, { k: 'ui' }> => i.k === 'ui' && i.reqId !== undefined && i.answer === undefined);

/** The tool calls of a working line, as a count and whether any is still going. */
export function workingSummary(tools: readonly ToolView[]): { total: number; done: number; busy: boolean; failed: number; line: string } {
  const done = tools.filter((x) => x.status === 'completed' || x.status === 'failed').length;
  const failed = tools.filter((x) => x.status === 'failed').length;
  const busy = done < tools.length;
  const last = tools[tools.length - 1];
  const line = busy ? (last?.title ? `Working: ${last.title}` : 'Working') : `Worked on ${tools.length} step${tools.length === 1 ? '' : 's'}`;
  return { total: tools.length, done, busy, failed, line };
}

/** The event behind an item, for "Show what the builder sends": small, mono, honest about the wire. */
export function eventOf(i: Item): string {
  switch (i.k) {
    case 'user': return 'session/prompt';
    case 'agent': return `agent_message_chunk x${i.chunks}`;
    case 'ui': {
      const waits = i.reqId !== undefined;
      const head = waits ? 'session/request_permission' : 'agent_message_chunk';
      return `${head}  _meta["hull.ui"] = ${i.block.kind} "${i.block.id}"${i.sent > 1 ? ` (sent ${i.sent} times)` : ''}`;
    }
    case 'working': return `tool_call x${i.tools.length}`;
    case 'perm': return 'session/request_permission';
    case 'note': return 'status';
  }
}
