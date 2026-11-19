import { afterEach, describe, expect, it } from 'vitest';
import { isTracing, setTraceSink, trace } from '../core/trace.ts';
import type { RecentEvent } from './protocol.ts';
import { createRecentFeed, lastPart, RING } from './recent.ts';

afterEach(() => setTraceSink(null));

const feedWith = (sent: RecentEvent[][], time: () => number = () => 0) =>
  createRecentFeed({ time, title: (_k, id) => (id === 'sound/sword/hit' ? 'Clash' : undefined), send: (i) => sent.push(i) });

describe('trace', () => {
  it('does nothing and costs nothing with no listener', () => {
    expect(isTracing()).toBe(false);
    expect(() => trace('sound', 'sound/x')).not.toThrow();
  });
  it('reaches the one listener, and goes quiet again when it is removed', () => {
    const heard: string[] = [];
    setTraceSink((k, id, node) => heard.push(`${k}:${id}:${node ?? ''}`));
    trace('actor', 'character/aya', 'Aya');
    setTraceSink(null);
    trace('sound', 'sound/x');
    expect(heard).toEqual(['actor:character/aya:Aya']);
  });
});

describe('the recent ring', () => {
  it('labels from the title, else a readable form of the id', () => {
    expect(lastPart('sound/sword/hit')).toBe('hit');
    expect(lastPart('anim-graph/hero#attack')).toBe('attack');
    const sent: RecentEvent[][] = [];
    const feed = feedWith(sent);
    feed.add('sound', 'sound/sword/hit');
    feed.add('vfx', 'vfx/clash-sparks', 'Blade');
    feed.flush();
    expect(sent[0]!.map((e) => e.label)).toEqual(['Clash', 'Clash sparks']);
    expect(sent[0]![1]).toMatchObject({ kind: 'vfx', node: 'Blade' });
    expect('node' in sent[0]![0]!).toBe(false);
  });
  it('stamps game time and sends each event once; nothing when empty', () => {
    let t = 0;
    const sent: RecentEvent[][] = [];
    const feed = feedWith(sent, () => t);
    expect(feed.flush()).toBe(0);
    t = 1.5; feed.add('sound', 'sound/a');
    t = 2; feed.add('sound', 'sound/b');
    feed.flush();
    feed.flush();
    t = 3; feed.add('sound', 'sound/c');
    feed.flush();
    expect(sent.map((b) => b.map((e) => e.at))).toEqual([[1.5, 2], [3]]);
  });
  it('keeps only the newest ' + RING + ' when a burst outruns the flush', () => {
    const sent: RecentEvent[][] = [];
    const feed = feedWith(sent);
    for (let i = 0; i < RING + 10; i++) feed.add('sound', `sound/s${i}`);
    expect(feed.snapshot()).toHaveLength(RING);
    feed.flush();
    expect(sent[0]).toHaveLength(RING);
    expect(sent[0]![0]!.id).toBe('sound/s10');
    expect(sent[0]!.at(-1)!.id).toBe(`sound/s${RING + 9}`);
  });
  it('forgets on clear', () => {
    const sent: RecentEvent[][] = [];
    const feed = feedWith(sent);
    feed.add('sound', 'sound/a');
    feed.clear();
    expect(feed.flush()).toBe(0);
  });
});
