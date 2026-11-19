import { describe, expect, it } from 'vitest';
import { parseDetail, plainTitle, summarize } from './changes.ts';
import { checkUiBlock, CONVERSATION_TOOLS, toolsFor } from './modes.ts';
import type { ToolSpec } from './types.ts';

const spec = (name: string): ToolSpec => ({ name, description: name, schema: {} });
const HULL = ['project_info', 'library_list', 'config_set', 'code_write', 'game_run', 'check', 'brief_read', 'brief_write', 'docs_list', 'docs_read', 'create_get', 'create_set', 'explain_write', 'history_revert'].map(spec);
const names = (t: ToolSpec[]): string[] => t.map((x) => x.name);

describe('the tool list of each mode', () => {
  it('brief: reads, the brief, the docs, the flow state and the conversation tools; no code or config writes', () => {
    const n = names(toolsFor('brief', HULL));
    expect(n).toEqual(expect.arrayContaining(['project_info', 'library_list', 'brief_read', 'brief_write', 'docs_list', 'docs_read', 'create_get', 'create_set', 'ui_show', 'ui_ask', 'ui_approve', 'update_plan']));
    for (const no of ['config_set', 'code_write', 'game_run', 'check', 'explain_write', 'history_revert']) expect(n).not.toContain(no);
  });
  it('build: everything, and may show cards, but never waits on a question', () => {
    const n = names(toolsFor('build', HULL));
    expect(n).toEqual(expect.arrayContaining(HULL.map((t) => t.name)));
    expect(n).toContain('ui_show');
    expect(n).not.toContain('ui_ask');
    expect(n).not.toContain('ui_approve');
  });
  it('fix: everything', () => {
    expect(names(toolsFor('fix', HULL))).toEqual([...HULL.map((t) => t.name), ...CONVERSATION_TOOLS.map((t) => t.name)]);
  });
});

describe('ui_show blocks', () => {
  it('accepts the cards that do not wait and says what is wrong with the rest', () => {
    expect(checkUiBlock({ id: 'brief', kind: 'brief', title: 'T', sections: [] }).ok).toBe(true);
    expect(checkUiBlock({ id: 's', kind: 'stages', stages: [] }).ok).toBe(true);
    expect(checkUiBlock({ id: 'p', kind: 'pieces', stage: 'world', keys: [] }).ok).toBe(true);
    expect(checkUiBlock({ id: 'c', kind: 'change', title: 't', piece: 'p', lines: [] }).ok).toBe(true);
    expect(checkUiBlock({ id: 'a', kind: 'ask', question: 'q', options: [] })).toMatchObject({ ok: false, reason: expect.stringContaining('ui_ask') });
    expect(checkUiBlock({ kind: 'brief' })).toMatchObject({ ok: false });
    expect(checkUiBlock({ id: 'x', kind: 'brief', title: 'T' })).toMatchObject({ ok: false, reason: 'block.sections must be an array' });
    expect(checkUiBlock(undefined)).toMatchObject({ ok: false });
  });
});

describe('reading a change back from the history', () => {
  const kinds = new Set(['tuning', 'sound', 'vfx', 'character']);
  it('parses config values, tunables and code, and leaves the brief alone', () => {
    expect(parseDetail('tuning/arena: crateCount 14 → 20', kinds)).toEqual({ piece: 'tuning/arena', line: { label: 'crateCount', from: '14', to: '20' } });
    expect(parseDetail('player.runSpeed 7 → 8', kinds)).toEqual({ piece: 'tunables:player', line: { label: 'runSpeed', from: '7', to: '8' } });
    expect(parseDetail('src/x.ts added (1 lines)', kinds)).toEqual({ line: { label: 'src/x.ts', from: '', to: '+1 lines' } });
    expect(parseDetail('src/main.ts changed (+3 -1 lines)', kinds)).toEqual({ line: { label: 'src/main.ts', from: '', to: '+3 -1 lines' } });
    expect(parseDetail('sound/new added', kinds)).toEqual({ piece: 'sound/new', line: { label: 'sound/new', from: '', to: 'added' } });
    expect(parseDetail('GAME.md added (5 lines)', kinds)).toBeUndefined();
    expect(parseDetail('something else entirely', kinds)).toBeUndefined();
  });
  it('summarises several changes oldest first, each piece once, with the newest id', () => {
    const c = summarize([
      { id: 'n2', details: ['sound/thud: level -5 → -6', 'GAME.md added (2 lines)'] },
      { id: 'n1', details: ['tuning/arena: crateCount 14 → 16', 'tuning/arena: size 40 → 44', 'player.runSpeed 7 → 8'] },
    ], kinds);
    expect(c.pieces).toEqual(['tuning/arena', 'tunables:player', 'sound/thud']);
    expect(c.lines.map((l) => l.label)).toEqual(['crateCount', 'size', 'runSpeed', 'level']);
    expect(c.newest).toBe('n2');
  });
  it('makes a plain title from the first sentence, or falls back to the piece', () => {
    expect(plainTitle('I made the scout faster. It now runs at 8 m/s.', 'tunables:player')).toBe('I made the scout faster');
    expect(plainTitle('', 'sound/thud')).toBe('Changed sound/thud');
    expect(plainTitle('x'.repeat(200), 'p')).toBe('Changed p');
  });
});
