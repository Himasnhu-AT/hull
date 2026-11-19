import { describe, expect, it } from 'vitest';
import type { RecentEvent } from 'hull/dev/protocol';
import { chips, clock, frameUrl, mergeRecent, piecesOf } from './recentStrip.ts';

const ev = (at: number, id: string, kind: RecentEvent['kind'] = 'sound'): RecentEvent => ({ at, kind, id, label: id.split('/').pop()! });

describe('Just now strip', () => {
  it('shows at most five chips, newest first', () => {
    let s: RecentEvent[] = [];
    for (let i = 0; i < 8; i++) s = mergeRecent(s, [ev(i, `sound/s${i}`)]);
    expect(chips(s).map((c) => c.event.at)).toEqual([7, 6, 5, 4, 3]);
  });
  it('makes one chip per kind and id, with a count when it repeated', () => {
    let s: RecentEvent[] = [];
    for (let i = 0; i < 3; i++) s = mergeRecent(s, [ev(i, 'sound/thud')]);
    s = mergeRecent(s, [ev(3, 'vfx/dust', 'vfx'), ev(4, 'sound/thud'), ev(2.5, 'anim/x', 'anim')]);
    const c = chips(s);
    expect(c.map((x) => [x.event.id, x.count])).toEqual([['sound/thud', 4], ['vfx/dust', 1], ['anim/x', 1]]);
    expect(c[0]!.event.at).toBe(4);
  });
  it('keeps a repeated piece from pushing the others out of the five', () => {
    let s: RecentEvent[] = [];
    for (let i = 0; i < 4; i++) s = mergeRecent(s, [ev(i, `sound/s${i}`)]);
    for (let i = 4; i < 20; i++) s = mergeRecent(s, [ev(i, 'sound/thud')]);
    expect(chips(s)).toHaveLength(5);
    expect(chips(s)[0]).toMatchObject({ count: 16 });
  });
  it('puts the frame id on the game address, keeping its query', () => {
    expect(frameUrl('http://a/b', 'app1')).toBe('http://a/b?hull-client=app1');
    expect(frameUrl('http://a/b?x=1', 'app1')).toBe('http://a/b?x=1&hull-client=app1');
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
