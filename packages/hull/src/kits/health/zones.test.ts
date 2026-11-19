import { describe, expect, it } from 'vitest';
import { coveredDamage, regenerate, zoneEffect, ZONE_CUT, ZONE_NONE, ZONE_SHALLOW } from './zones.ts';

describe('hit zones', () => {
  it('cuts at the threshold, wounds above the shallow line, otherwise nothing', () => {
    expect(zoneEffect(140, 140, 10)).toBe(ZONE_CUT);
    expect(zoneEffect(139, 140, 10)).toBe(ZONE_SHALLOW);
    expect(zoneEffect(10, 140, 10)).toBe(ZONE_NONE);
    expect(zoneEffect(1e5, 0, 20)).toBe(ZONE_SHALLOW);
    expect(zoneEffect(20, 0, 20)).toBe(ZONE_NONE);
  });

  it('takes cover off the damage', () => {
    expect(coveredDamage(100, 0, 0.7)).toBe(100);
    expect(coveredDamage(100, 1, 0.7)).toBeCloseTo(30);
    expect(coveredDamage(100, 0.5, 0.7)).toBeCloseTo(65);
  });

  it('regenerates after a quiet spell and never past full', () => {
    expect(regenerate(0.5, 1, 3, 4, 0.04)).toBe(0.5);
    expect(regenerate(0.5, 1, 5, 4, 0.04)).toBeCloseTo(0.54);
    expect(regenerate(0.99, 1, 5, 4, 0.04)).toBe(1);
  });
});
