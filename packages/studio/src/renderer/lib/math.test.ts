import { describe, expect, it, vi } from 'vitest';
import {
  arcPath, autoStep, clamp, curveAt, curveMove, decimals, dialAngle, dialDrag, dragScale, formatNumber, getAtPointer,
  nearestEnd, rangeMove, sameJson, scrubDelta, setAtPointer, snap, throttle, toFraction,
} from './math.ts';

describe('snap and steps', () => {
  it('rounds float noise and clamps', () => {
    expect(snap(0.1 + 0.2, 0, 1, 0.1)).toBe(0.3);
    expect(snap(7.2, 0, 5, 1)).toBe(5);
    expect(snap(-3, 0, 5, 1)).toBe(0);
  });
  it('anchors the grid at the minimum', () => {
    expect(snap(2.4, 1, 10, 2)).toBe(3);
  });
  it('knows decimals', () => {
    expect(decimals(1)).toBe(0);
    expect(decimals(0.01)).toBe(2);
    expect(decimals(0.5)).toBe(1);
    expect(decimals(1e-7)).toBe(7);
  });
  it('picks a readable automatic step', () => {
    expect(autoStep(0, 1)).toBe(0.005);
    expect(autoStep(0, 10)).toBe(0.05);
    expect(autoStep(-60, 12)).toBe(0.5);
    expect(autoStep(5, 5)).toBe(1);
  });
  it('formats with the step precision', () => {
    expect(formatNumber(1.2, 0.01)).toBe('1.20');
    expect(formatNumber(4, 1)).toBe('4');
  });
});

describe('dial', () => {
  it('maps the 270 degree sweep', () => {
    expect(dialAngle(0)).toBe(-135);
    expect(dialAngle(0.5)).toBe(0);
    expect(dialAngle(1)).toBe(135);
    expect(dialAngle(7)).toBe(135);
  });
  it('draws a closed path only when there is a sweep', () => {
    expect(arcPath(32, 32, 24, -135, -135)).toBe('');
    expect(arcPath(32, 32, 24, -135, 135)).toMatch(/^M.* A24 24 0 1 1 /);
    expect(arcPath(32, 32, 24, -135, 0)).toMatch(/ 0 0 1 /);
  });
  it('drags from the value at pointer-down: up raises, 200px cover the range', () => {
    expect(dialDrag(5, -100, 0, 10, 0.1)).toBe(10);
    expect(dialDrag(5, 100, 0, 10, 0.1)).toBe(0);
    expect(dialDrag(5, -20, 0, 10, 0.1)).toBe(6);
    expect(dialDrag(5, -20, 0, 10, 0.01, 0.1)).toBe(5.1);
    expect(dialDrag(5, -20, 0, 100, 1, 10)).toBe(100);
  });
  it('reads modifier keys', () => {
    expect(dragScale({ shiftKey: true })).toBe(0.1);
    expect(dragScale({ altKey: true })).toBe(10);
    expect(dragScale({})).toBe(1);
  });
});

describe('scrubbing a label', () => {
  it('covers a finite range in 300px', () => {
    expect(scrubDelta(0, 150, 0, 10, 0.1)).toBe(5);
    expect(scrubDelta(0, 900, 0, 10, 0.1)).toBe(10);
  });
  it('takes one step per 4px without a range', () => {
    expect(scrubDelta(10, 40, -Infinity, Infinity, 0.5)).toBe(15);
    expect(scrubDelta(10, -40, -Infinity, Infinity, 1)).toBe(0);
  });
});

describe('dual range', () => {
  it('never lets an end pass the other', () => {
    expect(rangeMove([0.95, 1.05], 0, 2, 0.25, 4, 0.05)).toEqual([1.05, 1.05]);
    expect(rangeMove([0.95, 1.05], 1, 0.5, 0.25, 4, 0.05)).toEqual([0.95, 0.95]);
    expect(rangeMove([0.95, 1.05], 1, 1.4, 0.25, 4, 0.05)).toEqual([0.95, 1.4]);
  });
  it('finds the nearest end', () => {
    expect(nearestEnd([1, 3], 1.5)).toBe(0);
    expect(nearestEnd([1, 3], 2.6)).toBe(1);
  });
});

describe('curve', () => {
  const pts: [number, number][] = [[0, 1], [0.3, 0.6], [0.7, 0.2], [1, 0]];
  it('keeps end times and orders the middle points', () => {
    expect(curveMove(pts, 0, 0.5, 2, 0, 1)[0]).toEqual([0, 1]);
    expect(curveMove(pts, 3, 0.2, -1, 0, 1)[3]).toEqual([1, 0]);
    expect(curveMove(pts, 1, 0.9, 0.5, 0, 1)[1]).toEqual([0.7, 0.5]);
    expect(curveMove(pts, 1, -1, 0.5, 0, 1)[1]).toEqual([0, 0.5]);
  });
  it('does not change the input', () => {
    curveMove(pts, 1, 0.5, 0.5, 0, 1);
    expect(pts[1]).toEqual([0.3, 0.6]);
  });
  it('samples linearly', () => {
    expect(curveAt(pts, 0)).toBe(1);
    expect(curveAt(pts, 0.5)).toBeCloseTo(0.4);
    expect(curveAt(pts, 2)).toBe(0);
    expect(curveAt([], 0.5)).toBe(0);
  });
});

describe('json helpers', () => {
  it('compares deeply', () => {
    expect(sameJson({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(sameJson([1], { 0: 1 })).toBe(false);
    expect(sameJson(null, {})).toBe(false);
  });
  it('reads and writes pointers without touching the original', () => {
    const v = { a: { b: [1, 2, 3] }, 'x/y': 1 };
    expect(getAtPointer(v, '/a/b/1')).toBe(2);
    expect(getAtPointer(v, '/x~1y')).toBe(1);
    expect(getAtPointer(v, '/nope/deeper')).toBeUndefined();
    const w = setAtPointer(v, '/a/b/1', 9) as typeof v;
    expect(w.a.b).toEqual([1, 9, 3]);
    expect(v.a.b).toEqual([1, 2, 3]);
    expect(setAtPointer({}, '/p/q', 1)).toEqual({ p: { q: 1 } });
  });
  it('clamps and fractions', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(toFraction(5, 0, 10)).toBe(0.5);
    expect(toFraction(5, 5, 5)).toBe(0);
  });
});

describe('throttle', () => {
  it('sends the first call at once, then at most one per window with the latest value, and flushes the rest', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t(1);
    t(2);
    t(3);
    expect(fn.mock.calls).toEqual([[1]]);
    vi.advanceTimersByTime(100);
    expect(fn.mock.calls).toEqual([[1], [3]]);
    t(4);
    t.flush();
    expect(fn.mock.calls.at(-1)).toEqual([4]);
    t(5);
    t.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
