import { describe, expect, it } from 'vitest';
import { damp, followDistance, followFov, Reach, smoothstep } from './glide.ts';

describe('chase camera maths', () => {
  it('pulls back with speed up to a cap, and opens the lens smoothly', () => {
    expect(followDistance(4.4, 0, 0.028, 90, 0)).toBe(4.4);
    expect(followDistance(4.4, 200, 0.028, 90, 1)).toBeCloseTo(4.4 + 2.52 + 1);
    expect(smoothstep(12, 12, 85)).toBe(0);
    expect(smoothstep(100, 12, 85)).toBe(1);
    expect(followFov(70, 98, 48.5, 12, 85)).toBeCloseTo(84, 0);
    expect(damp(3, 0)).toBe(0);
    expect(damp(3, 100)).toBeCloseTo(1);
  });

  it('glides in toward a wall and back out, never past the wanted distance', () => {
    const r = new Reach();
    expect(r.update(5, 5, 0.01, 12, 4)).toBe(false);
    expect(r.value).toBe(5);
    let inward = true;
    for (let i = 0; i < 100; i++) inward = r.update(5, 1, 0.01, 12, 4) && inward;
    expect(inward).toBe(true);
    expect(r.value).toBeLessThan(2);
    expect(r.value).toBeGreaterThan(1);
    for (let i = 0; i < 1000; i++) r.update(5, 50, 0.01, 12, 4);
    expect(r.value).toBeCloseTo(5, 1);
    expect(r.value).toBeLessThanOrEqual(5);
    // the wanted distance shrinks: the reach follows it down at once
    r.update(3, 50, 0.01, 12, 4);
    expect(r.value).toBeLessThanOrEqual(3.1);
  });
});
