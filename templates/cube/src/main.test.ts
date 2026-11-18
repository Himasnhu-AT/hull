/// <reference types="node" />
import { describe, expect, it } from 'vitest';

// The M0 check: same seed, 10,000 steps, same end state, all in under a second. Needs the real core, so the
// orchestrator runs it after the merge (HULL_E2E=1). Imports are inside the test so a skipped run loads nothing.
describe.skipIf(!process.env.HULL_E2E)('cube game', () => {
  it('is deterministic and fast', async () => {
    const { startGame } = await import('hull');
    const { default: game } = await import('./main.ts');
    const started = performance.now();
    const sums: string[] = [];
    for (let run = 0; run < 2; run++) {
      const g = await startGame(game, { seed: 7 });
      g.step(10_000);
      sums.push(g.world.checksum());
      g.dispose();
    }
    const ms = performance.now() - started;
    expect(sums[0]).toBe(sums[1]);
    expect(ms).toBeLessThan(1000);
  });
});
