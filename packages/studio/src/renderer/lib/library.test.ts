import { describe, expect, it } from 'vitest';
import type { LibraryItem } from 'hull/dev/protocol';
import { domainOf, groupLibrary, splitId } from './library.ts';

const item = (id: string, kind: string, problems = 0, extra: Partial<LibraryItem> = {}): LibraryItem => ({ id, kind, path: `config/${id}.json`, title: id.split('/').slice(1).join('/'), problems, ...extra });

const items = [
  item('sound/sword/hit', 'sound'),
  item('sound/sword/miss', 'sound', 1),
  item('sound/ui/click', 'sound'),
  item('tuning/cube-look', 'tuning'),
  item('input-map/default', 'input-map'),
  item('mystery/x', 'mystery'),
  { id: 'tunables:player', kind: 'tunables', path: 'src/player/tuning.ts', title: 'player', problems: 0 },
];

describe('domains', () => {
  it('maps kinds to what a designer looks for', () => {
    expect(domainOf('sound')).toBe('Audio');
    expect(domainOf('tunables')).toBe('Gameplay');
    expect(domainOf('ui-theme')).toBe('Interface');
    expect(domainOf('input-map')).toBe('Input');
    expect(domainOf('material')).toBe('World');
    expect(domainOf('character')).toBe('Characters');
    expect(domainOf('mystery')).toBe('Other');
  });
});

describe('splitId', () => {
  it('splits folders from names and leaves code blocks alone', () => {
    expect(splitId(items[0]!)).toEqual({ folder: 'sword', short: 'hit' });
    expect(splitId(items[3]!)).toEqual({ folder: '', short: 'cube-look' });
    expect(splitId(items[6]!)).toEqual({ folder: '', short: 'player' });
  });
});

describe('groupLibrary', () => {
  const none = new Set<string>();
  it('orders domains, adds folder headers and counts', () => {
    const g = groupLibrary(items, { query: '', filter: 'all', changed: none });
    expect(g.map((x) => x.domain)).toEqual(['Gameplay', 'Audio', 'Input', 'Other']);
    const audio = g.find((x) => x.domain === 'Audio')!;
    expect(audio.count).toBe(3);
    expect(audio.attention).toBe(true);
    expect(audio.rows.map((r) => (r.type === 'sub' ? `#${r.label}` : r.short))).toEqual(['#sword', 'hit', 'miss', '#ui', 'click']);
  });
  it('searches ids, kinds and notes', () => {
    expect(groupLibrary(items, { query: 'CLICK', filter: 'all', changed: none }).flatMap((g) => g.rows).filter((r) => r.type === 'row')).toHaveLength(1);
    expect(groupLibrary(items, { query: 'tunables', filter: 'all', changed: none })[0]!.domain).toBe('Gameplay');
    expect(groupLibrary(items, { query: 'zzz', filter: 'all', changed: none })).toEqual([]);
  });
  it('filters to problems and to changed files', () => {
    const p = groupLibrary(items, { query: '', filter: 'problems', changed: none });
    expect(p).toHaveLength(1);
    expect(p[0]!.count).toBe(1);
    const c = groupLibrary(items, { query: '', filter: 'changed', changed: new Set(['tuning/cube-look']) });
    expect(c.map((x) => x.domain)).toEqual(['Gameplay']);
  });
});
