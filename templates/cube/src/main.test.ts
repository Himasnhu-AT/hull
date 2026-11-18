/// <reference types="node" />
import { startGame } from 'hull';
import { describe, expect, it } from 'vitest';
import game from './main.ts';

// The M0 check: same seed, 10,000 steps, same end state, all in under a second.
describe('cube game', () => {
  it('is deterministic and fast', async () => {
    const started = performance.now();
    const sums: string[] = [];
    for (let run = 0; run < 2; run++) {
      const g = await startGame(game, { seed: 7 });
      const before = g.world.checksum();
      g.step(10_000);
      sums.push(g.world.checksum());
      // The cube really turned: the end state is not the start state.
      expect(sums[run]).not.toBe(before);
      g.dispose();
    }
    const ms = performance.now() - started;
    console.log(`cube: 2 × 10,000 steps in ${ms.toFixed(1)} ms, checksum ${sums[0]}`);
    expect(sums[0]).toBe(sums[1]);
    expect(ms).toBeLessThan(1000);
  });
});
