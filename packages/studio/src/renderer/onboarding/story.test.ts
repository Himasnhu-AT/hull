import { describe, expect, it } from 'vitest';
import { CHAPTERS } from './story.ts';

describe('the tour story', () => {
  it('has four chapters of short, distinct steps', () => {
    expect(CHAPTERS.map((c) => c.title)).toEqual(['Your idea', 'The plan', 'The build', 'Play, fix, share']);
    const steps = CHAPTERS.flatMap((c) => c.steps);
    expect(new Set(steps.map((s) => s.scene)).size).toBe(steps.length);
    for (const s of steps) { expect(s.title.length).toBeLessThan(40); expect(s.say.split(/[.!?]\s/).length).toBeLessThanOrEqual(3); }
  });
});
