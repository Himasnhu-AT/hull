import { describe, expect, it } from 'vitest';
import type { ChangeDelta, HistoryChange } from 'hull/dev/protocol';
import { entryOf, mainLine, putBackOf, putBackRows, whoLabel } from './changesList.ts';

const ch = (id: string, at: string, extra: Partial<HistoryChange> = {}): HistoryChange => ({ id, short: id.slice(0, 7), at, by: 'you', line: 'main', kind: 'change', message: 'tuning/jump: height 2.2 to 2.6', details: ['height 2.2 to 2.6'], parents: [], checkpoints: [], ...extra });

describe('whoLabel', () => {
  it('says who in words', () => {
    expect(whoLabel('you')).toBe('You');
    expect(whoLabel('ai:hull')).toBe('Builder');
    expect(whoLabel('marl:tuner')).toBe('Builder');
    expect(whoLabel('disk')).toBe('A file edit');
  });
});

describe('mainLine', () => {
  it('keeps the main line, newest first', () => {
    const list = mainLine([ch('a', '2026-11-19T10:00:00Z'), ch('x', '2026-11-19T12:00:00Z', { line: 'try' }), ch('b', '2026-11-19T11:00:00Z')]);
    expect(list.map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('entryOf', () => {
  it('cuts the details and says how many more', () => {
    const e = entryOf(ch('a', '2026-11-19T10:00:00Z', { details: ['1', '2', '3', '4', '5', '6'] }), Date.parse('2026-11-19T10:05:00Z'));
    expect(e.lines).toHaveLength(4);
    expect(e.more).toBe(2);
    expect(e.when).toBe('5 min ago');
    expect(e.who).toBe('You');
  });
  it('names the start of the project', () => {
    expect(entryOf(ch('a', '2026-11-19T10:00:00Z', { kind: 'start', message: 'initial', details: [] })).title).toBe('Project started');
  });
});

describe('plain words', () => {
  it('names the piece and the field and keeps the raw text for the tooltip', () => {
    const e = entryOf(ch('a', '2026-11-19T10:00:00Z', { by: 'ai:hull', message: 'player.jumpHeight 2 → 1.6', details: ['player.jumpHeight 2 → 1.6', 'sound/thud: level 0.8 → 0.5'] }));
    expect(e.title).toBe('Player: jump height 2 → 1.6');
    expect(e.titleRaw).toBe('player.jumpHeight 2 → 1.6');
    expect(e.lines).toEqual(['Thud sound: level 0.8 → 0.5']);
    expect(e.linesRaw[0]).toBe('sound/thud: level 0.8 → 0.5');
    expect(e.who).toBe('Builder');
  });
  it('titles a put-back and finds it', () => {
    const a = ch('a', '2026-11-19T10:00:00Z', { by: 'ai:hull', message: 'player.jumpHeight 2 → 1.6', details: ['player.jumpHeight 2 → 1.6'] });
    const b = ch('b', '2026-11-19T10:05:00Z', { message: 'player.jumpHeight 1.6 → 2', details: ['player.jumpHeight 1.6 → 2'] });
    const list = mainLine([a, b]);
    const backs = putBackOf(list);
    expect([...backs.keys()]).toEqual(['b']);
    const e = entryOf(b, Date.parse('2026-11-19T10:06:00Z'), backs.get('b'));
    expect(e.title).toBe('Put back: Player: jump height 2 → 1.6');
    expect(e.lines).toEqual([]);
    expect(entryOf(a).title).toBe('Player: jump height 2 → 1.6');
  });
});

describe('putBackRows', () => {
  const d = (path: string, from: unknown, to: unknown): ChangeDelta => ({ file: 'config/tuning/jump.json', kind: 'json', op: 'set', target: 'tuning/jump', path, from, to, text: '' });
  it('puts each field back to its old value', () => {
    const rows = putBackRows([d('/height', 2.2, 2.6), d('/speed', 5, 6)]);
    expect(rows.map((r) => r.revert)).toEqual(expect.arrayContaining([
      { via: 'config.set', id: 'tuning/jump', pointer: '/height', value: 2.2 },
      { via: 'config.set', id: 'tuning/jump', pointer: '/speed', value: 5 },
    ]));
  });
});
