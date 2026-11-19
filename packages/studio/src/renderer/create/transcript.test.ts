import { describe, expect, it } from 'vitest';
import type { AgentEvent, ToolView } from '../../shared/agentApi.ts';
import { answerName, emptyTranscript, eventOf, reduce, waiting, workingSummary, type Transcript } from './transcript.ts';

const run = (events: Parameters<typeof reduce>[1][], from: Transcript = emptyTranscript()): Transcript => events.reduce(reduce, from);
const msg = (text: string): AgentEvent => ({ type: 'message', sid: 's', role: 'agent', text });
const tool = (id: string, status: ToolView['status'], title = 'check'): AgentEvent => ({ type: 'tool', sid: 's', tool: { id, title, toolKind: 'read', status, content: [], paths: [] } });
const brief = (n: number): AgentEvent => ({ type: 'ui', sid: 's', block: { id: 'brief', kind: 'brief', title: 'Game', sections: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `S${i}`, text: 'x', status: 'done' as const })) } });

describe('transcript', () => {
  it('text grows in one item while it streams, and stops being live when the run ends', () => {
    let t = run([{ type: 'sent', text: 'an idea' }, msg('Hel'), msg('lo '), msg('there')]);
    expect(t.items.map((i) => i.k)).toEqual(['user', 'agent']);
    expect(t.items[1]).toMatchObject({ text: 'Hello there', live: true, chunks: 3 });
    expect(t.running).toBe(true);
    t = reduce(t, { type: 'done', sid: 's', stopReason: 'end_turn' });
    expect(t.items[1]).toMatchObject({ live: false });
    expect(t.running).toBe(false);
  });

  it('a card sent again with the same id is replaced where it stands', () => {
    const t = run([msg('a'), brief(1), msg('b'), brief(3)]);
    expect(t.items.map((i) => i.k)).toEqual(['agent', 'ui', 'agent']);
    const card = t.items[1] as Extract<(typeof t.items)[number], { k: 'ui' }>;
    expect(card.block.kind === 'brief' && card.block.sections).toHaveLength(3);
    expect(card.sent).toBe(2);
    expect(eventOf(card)).toContain('sent 2 times');
  });

  it('a waiting card is answered by permission-done, and the answer is the choice in words', () => {
    const ask: AgentEvent = { type: 'ui', sid: 's', reqId: 'p1', block: { id: 'q', kind: 'ask', question: 'Who?', options: ['A', 'B'] } };
    let t = run([ask]);
    expect(waiting(t)).toHaveLength(1);
    expect(eventOf(t.items[0]!)).toContain('session/request_permission');
    t = reduce(t, { type: 'permission-done', sid: 's', reqId: 'p1', optionId: '1' });
    expect(waiting(t)).toHaveLength(0);
    expect(t.items[0]).toMatchObject({ answer: { optionId: '1', name: 'B' } });
  });

  it('a cancelled card says it was answered in words; an approve answers with its own wording', () => {
    const block = { id: 'ok', kind: 'approve', question: 'Right?', yes: 'Build it', no: 'Not yet' } as const;
    expect(answerName(block, null)).toBe('Answered in words');
    expect(answerName(block, 'yes')).toBe('Build it');
    expect(answerName(block, 'no')).toBe('Not yet');
  });

  it('tool calls fold into one working line, updated by id', () => {
    const t = run([tool('a', 'in_progress'), tool('b', 'pending', 'build'), tool('a', 'completed')]);
    expect(t.items).toHaveLength(1);
    const w = t.items[0] as Extract<(typeof t.items)[number], { k: 'working' }>;
    expect(w.tools.map((x) => x.status)).toEqual(['completed', 'pending']);
    expect(workingSummary(w.tools)).toMatchObject({ total: 2, done: 1, busy: true, line: 'Working: build' });
    expect(workingSummary(w.tools.map((x) => ({ ...x, status: 'completed' as const }))).line).toBe('Worked on 2 steps');
  });

  it('text after tools starts a new working group later, not a merge across the text', () => {
    const t = run([tool('a', 'completed'), msg('Now this'), tool('b', 'completed')]);
    expect(t.items.map((i) => i.k)).toEqual(['working', 'agent', 'working']);
  });

  it('an error becomes a note and ends the run', () => {
    const t = run([msg('x'), { type: 'status', sid: 's', state: 'error', message: 'No key' }]);
    expect(t.items.at(-1)).toMatchObject({ k: 'note', text: 'No key', error: true });
    expect(t.running).toBe(false);
  });
});
