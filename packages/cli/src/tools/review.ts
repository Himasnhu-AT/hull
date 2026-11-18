import type { ReviewEntry, ReviewState } from 'hull/dev/protocol';
import type { Problem } from 'hull';
import { listReview, noteReview, REVIEW_STATES, setReview, type ReviewResult } from '../review/store.ts';
import { defineTool } from '../tool.ts';

const line = (e: ReviewEntry): string => `${e.key}  ${e.stale ? `unreviewed (changed since ${e.was})` : e.state}${e.note ? `  "${e.note}"` : ''}`;

export const reviewList = defineTool<{ open?: boolean }, { ok: boolean; problems: Problem[]; entries: ReviewEntry[] }>({
  name: 'review.list',
  summary: 'Review notes: what has been checked and what needs a change.',
  input: { type: 'object', properties: { open: { type: 'boolean', description: 'Only notes that still need attention (needs-change, changed since review, or a note on an unreviewed piece).' } }, additionalProperties: false },
  output: { type: 'object', required: ['entries'] },
  cli: { options: [{ name: 'open', flags: '--open', description: 'Only open notes' }] },
  format: (o) => (o.entries.length ? o.entries.map(line) : ['no review notes']),
  async run(ctx, input) { return { ok: true, problems: [], entries: listReview(ctx.root, input.open === true) }; },
});

const result = (r: ReviewResult): { ok: boolean; problems: Problem[]; entry?: ReviewEntry } => r;

export const reviewSet = defineTool<{ key: string; state: ReviewState; note?: string }, ReviewResult>({
  name: 'review.set',
  summary: 'Set the review state of a config id or tunables block.',
  input: {
    type: 'object',
    properties: {
      key: { type: 'string', description: "A config id ('sound/sword/hit') or 'tunables:<block>', optionally with '#part'." },
      state: { type: 'string', enum: [...REVIEW_STATES] },
      note: { type: 'string' },
    },
    required: ['key', 'state'],
    additionalProperties: false,
  },
  output: { type: 'object', required: ['ok'] },
  cli: { args: [{ name: 'key', description: 'config id or tunables:<block>' }, { name: 'state', description: REVIEW_STATES.join(' | ') }], options: [{ name: 'note', flags: '--note <text>', description: 'A note to keep with it' }] },
  format: (o) => (o.entry ? [line(o.entry)] : []),
  async run(ctx, input) { return result(setReview(ctx.root, { ...input, author: ctx.author as never })); },
});

export const reviewNote = defineTool<{ key: string; note: string }, ReviewResult>({
  name: 'review.note',
  summary: 'Write a note on a piece without changing its review state (empty text clears it).',
  input: {
    type: 'object',
    properties: { key: { type: 'string' }, note: { type: 'string' } },
    required: ['key', 'note'],
    additionalProperties: false,
  },
  output: { type: 'object', required: ['ok'] },
  cli: { args: [{ name: 'key', description: 'config id or tunables:<block>' }, { name: 'note', description: 'the note' }] },
  format: (o) => (o.entry ? [line(o.entry)] : []),
  async run(ctx, input) { return result(noteReview(ctx.root, { ...input, author: ctx.author as never })); },
});
