import { describe, expect, it } from 'vitest';
import { fillTo, newDepotState, stepDepot } from './depot.ts';

const R = { dwell: 0.8, cooldown: 2 };

describe('depot', () => {
  it('gives supplies after the dwell, then waits out the cooldown', () => {
    const s = newDepotState();
    let given = 0;
    let at = -1;
    for (let i = 0; i < 600; i++) if (stepDepot(s, 0.01, true, true, R)) { given++; if (at < 0) at = i; }
    expect(at).toBeGreaterThanOrEqual(79);
    expect(at).toBeLessThanOrEqual(81);
    // 6 s inside: one fill at 0.8 s, the next after 2 s cooldown plus 0.8 s
    expect(given).toBe(2);
  });

  it('starts over when the player leaves, and does not count while nothing is needed', () => {
    const s = newDepotState();
    for (let i = 0; i < 50; i++) stepDepot(s, 0.01, true, true, R);
    expect(s.t).toBeCloseTo(0.5);
    stepDepot(s, 0.01, false, true, R);
    expect(s.t).toBe(0);
    for (let i = 0; i < 500; i++) expect(stepDepot(s, 0.01, true, false, R)).toBe(false);
    expect(s.t).toBe(0);
  });

  it('fills up to a fraction and never lowers', () => {
    expect(fillTo(0.2, 1, 1)).toBe(1);
    expect(fillTo(0.2, 4, 0.5)).toBe(2);
    expect(fillTo(3, 4, 0.5)).toBe(3);
  });
});
