import { describe, expect, it } from 'vitest';
import type { RecentEvent } from 'hull/dev/protocol';
import { clock, mergeRecent, piecesOf } from './recentStrip.ts';

const ev = (at: number, id: string, kind: RecentEvent['kind'] = 'sound'): RecentEvent => ({ at, kind, id, label: id.split('/').pop()! });

describe('Just now strip', () => {
  it('keeps the newest five, newest first', () => {
    let s: RecentEvent[] = [];
    for (let i = 0; i < 8; i++) s = mergeRecent(s, [ev(i, `sound/s${i}`)]);
    expect(s.map((e) => e.at)).toEqual([7, 6, 5, 4, 3]);
  });
  it('orders a batch by time and drops events it already has', () => {
    const s = mergeRecent([ev(1, 'sound/a')], [ev(2, 'sound/b'), ev(3, 'sound/c'), ev(1, 'sound/a')]);
    expect(s.map((e) => e.id)).toEqual(['sound/c', 'sound/b', 'sound/a']);
  });
  it('shows time as m:ss and makes one piece per id', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(75.9)).toBe('1:15');
    expect(piecesOf([ev(2, 'sound/clash'), ev(1, 'sound/clash'), ev(1, 'vfx/sparks', 'vfx')])).toEqual([
      { key: 'sound/clash', kind: 'sound', name: 'clash' }, { key: 'vfx/sparks', kind: 'effect', name: 'sparks' },
    ]);
  });
});
