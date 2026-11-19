import { describe, expect, it } from 'vitest';
import type { LibraryItem, ReviewEntry } from 'hull/dev/protocol';
import { buildShelves, countNew, plainName, shelfOf, tagOf } from './shelves.ts';

const item = (id: string, kind: string, title = id, extra: Partial<LibraryItem> = {}): LibraryItem => ({ id, kind, path: `config/${id}.json`, title, problems: 0, ...extra });

describe('shelfOf', () => {
  it('places the named kinds', () => {
    expect(shelfOf('character')).toBe('actors');
    expect(shelfOf('anim-graph')).toBe('animations');
    expect(shelfOf('mixer')).toBe('sounds');
    expect(shelfOf('level')).toBe('world');
    expect(shelfOf('vfx')).toBe('effects');
    expect(shelfOf('input-map')).toBe('screens');
    expect(shelfOf('tuning')).toBe('rules');
    expect(shelfOf('tunables')).toBe('rules');
    expect(shelfOf('game')).toBe('rules');
  });
  it('sends unknown kinds to the nearest shelf or Other', () => {
    expect(shelfOf('music-track')).toBe('sounds');
    expect(shelfOf('terrain-height')).toBe('world');
    expect(shelfOf('zzz')).toBe('other');
  });
});

describe('plainName', () => {
  it('uses a real title, and words from the id otherwise', () => {
    expect(plainName(item('sound/sword/hit', 'sound', 'Sword hit'))).toBe('Sword hit');
    expect(plainName(item('sound/sword/hit', 'sound', 'sound/sword/hit'))).toBe('Hit');
    expect(plainName(item('character/aya_the_blade', 'character', ''))).toBe('Aya the blade');
    expect(plainName(item('tunables:jumpHeight', 'tunables', 'jumpHeight'))).toBe('Jump height');
  });
});

describe('tagOf', () => {
  const e = (state: ReviewEntry['state'], stale?: boolean): ReviewEntry => ({ key: 'k', state, hash: 'h', ...(stale ? { stale } : {}) });
  it('reads the review state', () => {
    expect(tagOf(undefined)).toBe('new');
    expect(tagOf(e('approved'))).toBe('approved');
    expect(tagOf(e('needs-change'))).toBe('note');
    expect(tagOf(e('unreviewed'))).toBe('new');
    expect(tagOf(e('approved', true))).toBe('new');
  });
});

describe('buildShelves', () => {
  const items = [item('sound/b', 'sound', 'Boom'), item('sound/a', 'sound', 'Alarm'), item('character/aya', 'character', 'Aya'), item('x/y', 'weird', 'Odd')];
  const shelves = buildShelves(items, [{ key: 'sound/a', state: 'approved', hash: 'h' }]);
  it('groups in shelf order, hides empty shelves, sorts by name', () => {
    expect(shelves.map((s) => s.id)).toEqual(['actors', 'sounds', 'other']);
    expect(shelves[1]!.cards.map((c) => c.name)).toEqual(['Alarm', 'Boom']);
  });
  it('tags the cards and counts the new ones', () => {
    expect(shelves[1]!.cards[0]!.tag).toBe('approved');
    expect(countNew(shelves)).toBe(3);
  });
});
