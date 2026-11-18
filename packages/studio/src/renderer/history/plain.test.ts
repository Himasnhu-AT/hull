import { describe, expect, it } from 'vitest';
import type { ChangeDelta, ExpInfo, HistoryChange } from 'hull/dev/protocol';
import { ago, authorLabel, layout, plain, say, words } from './plain.ts';

const delta = (o: Partial<ChangeDelta>): ChangeDelta => ({ file: 'src/tuning.ts', kind: 'tunable', op: 'set', target: 'tunables:player', path: 'jumpHeight', from: 2.2, to: 2.6, text: '', ...o });
const ch = (id: string, line: string, kind: HistoryChange['kind'] = 'change', parents: string[] = []): HistoryChange => ({ id, short: id, at: '2026-01-01T00:00:00Z', by: 'you', line, kind, message: id, details: [], parents, checkpoints: [] });
const exp = (name: string, from: string, createdAt: string): ExpInfo => ({ name, status: 'active', from, tip: from, changes: 1, createdAt, by: 'you' });

describe('plain words', () => {
  it('turns names and values into words', () => {
    expect(words('jumpHeight')).toBe('jump height');
    expect(say(true)).toBe('on');
    expect(say(2.60001)).toBe('2.6');
  });
  it('writes a tunable change as one line', () => {
    expect(plain(delta({})).text).toBe('jump height 2.2 → 2.6');
    expect(plain(delta({})).scope).toBe('player');
  });
  it('writes a config change with its pointer in words', () => {
    const p = plain(delta({ kind: 'json', target: 'tuning/jump', path: '/wallHeight', file: 'config/tuning/jump.json' }));
    expect(p.what).toBe('wall height');
    expect(p.text).toBe('wall height 2.2 → 2.6');
  });
  it('says what an added or removed value was', () => {
    expect(plain(delta({ op: 'add', from: undefined })).text).toBe('jump height added: 2.6');
    expect(plain(delta({ op: 'remove', to: undefined })).text).toBe('jump height removed (was 2.2)');
  });
  it('labels authors', () => {
    expect(authorLabel('you')).toBe('you');
    expect(authorLabel('ai:test')).toBe('ai · test');
  });
  it('says how long ago', () => {
    expect(ago('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:05:00Z'))).toBe('5 min ago');
  });
});

describe('timeline lanes', () => {
  // newest first: merge of a into main, b's change, a's change, main change, start
  const rows = [ch('m2', 'main', 'merge', ['m1', 'a1']), ch('b1', 'b'), ch('a1', 'a'), ch('m1', 'main'), ch('m0', 'main', 'start')];
  const { rows: laid, lanes } = layout(rows, [exp('a', 'm1', '2026-01-01T01:00:00Z'), exp('b', 'm1', '2026-01-01T02:00:00Z')]);
  it('gives each experiment its own lane in start order', () => { expect(lanes).toEqual(['main', 'a', 'b']); });
  it('puts each change on its line', () => { expect(laid.map((r) => r.lane)).toEqual([0, 2, 1, 0, 0]); });
  it('marks the fork and the merge', () => {
    expect([...laid[3]!.forkFrom].sort()).toEqual([1, 2]);
    expect(laid[0]!.mergeFrom).toEqual([1]);
  });
  it('runs a lane from its newest change to the fork', () => {
    expect(laid[1]!.lines.filter((l) => l.lane === 2)).toEqual([{ lane: 2, part: 'bottom' }]);
    expect(laid[2]!.lines.some((l) => l.lane === 1)).toBe(true);
  });
});
