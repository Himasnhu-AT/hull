import { describe, expect, it } from 'vitest';
import type { AgentEvent, ToolView } from '../../shared/agentApi.ts';
import { diffStat, lineDiff, planProgress, reduce, type Item } from './agentView.ts';

const tool = (o: Partial<ToolView> = {}): ToolView => ({ id: 't1', title: 'config.set', toolKind: 'edit', status: 'pending', content: [], paths: [], ...o });
const run = (events: AgentEvent[]): Item[] => events.reduce<Item[]>((items, e) => reduce(items, e), []);

describe('transcript', () => {
  it('joins streamed text into one message and starts a new one when the speaker changes', () => {
    const items = run([
      { type: 'message', sid: 's', role: 'agent', text: 'Raising ' }, { type: 'message', sid: 's', role: 'agent', text: 'the jump.' },
      { type: 'message', sid: 's', role: 'thought', text: 'hm' }, { type: 'message', sid: 's', role: 'agent', text: 'Done.' },
    ]);
    expect(items).toEqual([{ k: 'agent', text: 'Raising the jump.' }, { k: 'thought', text: 'hm' }, { k: 'agent', text: 'Done.' }]);
  });
  it('keeps one plan and one card per tool call, updated in place', () => {
    const items = run([
      { type: 'plan', sid: 's', entries: [{ content: 'check', status: 'pending', priority: 'high' }] },
      { type: 'tool', sid: 's', tool: tool() },
      { type: 'plan', sid: 's', entries: [{ content: 'check', status: 'completed', priority: 'high' }] },
      { type: 'tool', sid: 's', tool: tool({ status: 'completed' }) },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ k: 'plan', entries: [{ status: 'completed' }] });
    expect(items[1]).toMatchObject({ k: 'tool', tool: { status: 'completed' } });
    expect(planProgress([{ content: 'check', status: 'completed', priority: 'high' }])).toEqual({ done: 1, total: 1 });
  });
  it('shows a permission request and then the answer that was given', () => {
    const opts = [{ id: 'a', name: 'Allow', kind: 'allow_once' as const }, { id: 'r', name: 'Deny', kind: 'reject_once' as const }];
    const items = run([{ type: 'permission', sid: 's', reqId: 'p1', tool: tool(), options: opts }, { type: 'permission-done', sid: 's', reqId: 'p1', optionId: 'r' }]);
    expect(items[0]).toMatchObject({ k: 'perm', answer: { optionId: 'r', name: 'Deny' } });
  });
  it('says so when the agent fails', () => {
    expect(run([{ type: 'status', sid: 's', state: 'error', message: 'boom' }])).toEqual([{ k: 'note', text: 'boom', error: true }]);
    expect(run([{ type: 'status', sid: 's', state: 'running' }])).toEqual([]);
  });
});

describe('line diff', () => {
  it('marks added and removed lines and trims unchanged ones', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const next = old.replace('line 10', 'line ten');
    const d = lineDiff(old, next);
    expect(diffStat(d)).toEqual({ added: 1, removed: 1 });
    expect(d.filter((x) => x.t === '…')).toHaveLength(2);
    expect(d.find((x) => x.t === '-')?.s).toBe('line 10');
    expect(d.find((x) => x.t === '+')?.s).toBe('line ten');
  });
  it('treats a new file as all added', () => {
    expect(lineDiff(null, 'a\nb')).toEqual([{ t: '+', s: 'a' }, { t: '+', s: 'b' }]);
  });
  it('finds a deletion in the middle', () => {
    expect(lineDiff('a\nb\nc', 'a\nc')).toEqual([{ t: ' ', s: 'a' }, { t: '-', s: 'b' }, { t: ' ', s: 'c' }]);
  });
});
