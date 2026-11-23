// The whole physics suite again with the kernels off, so both implementations pass the same file (plan-rust.md: the
// TypeScript one is the fallback and must stay right). physics.test.ts itself runs with the kernels on.
import { describe, expect, it } from 'vitest';
import { beforeStart, defineGame, startGame } from '../core/index.ts';
import { loadKernels } from '../kernel/index.ts';
import { usePhysics, type Physics } from './index.ts';

// Registered after hull/kernel's own loader, so it has the last word: every game in this file starts with them off.
beforeStart(() => loadKernels('off'));

describe('this file', () => {
  it('runs physics on the TypeScript broadphase', async () => {
    let phys!: Physics;
    await startGame(defineGame({ ready(g) { phys = usePhysics(g.world); } }));
    expect(phys.backend).toBe('typescript');
  });
});

await import('./physics.test.ts');
