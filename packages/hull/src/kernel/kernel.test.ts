// The kernel module as a thing that is shipped and loaded: the committed build matches the source it claims to come
// from, it loads in Node, and every way it can be absent (forced off, failing to compile) leaves a game running on
// TypeScript. What a kernel computes is tested beside the subsystem it serves (physics/moving.parity.test.ts).
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineGame, startGame } from '../core/index.ts';
import { usePhysics, type Physics } from '../physics/index.ts';
import { KERNEL_ABI, KERNEL_BYTES, KERNEL_MARKER, KERNEL_STAMP, kernelStatus, loadKernels, takeKernel } from './index.ts';
import { kernelSourceStamp } from './stamp.ts';
import { KERNEL_BASE64 } from './wasm.ts';

const repo = join(import.meta.dirname, '..', '..', '..', '..');

afterEach(() => { vi.restoreAllMocks(); });

async function physicsOfNewGame(kernels?: 'on' | 'off' | 'fail'): Promise<Physics> {
  let phys!: Physics;
  const game = await startGame(defineGame({ ready(g) { phys = usePhysics(g.world); } }), kernels ? { seed: 1, kernels } : { seed: 1 });
  phys.add({ type: 'sphere', radius: 1 }, { static: false, position: { x: 0, y: 5, z: 0 } });
  game.step(3);
  expect(phys.raycast({ x: 0, y: 20, z: 0 }, { x: 0, y: -1, z: 0 }, 100)?.distance).toBeCloseTo(14, 9);
  return phys;
}

describe('the committed kernel module', () => {
  it('was built from the crate as it is now (run pnpm kernels:build after changing crates/hull-kernels)', () => {
    expect(KERNEL_STAMP).toBe(kernelSourceStamp(repo));
  });

  it('is the size it says, imports nothing and exports the ABI the engine expects', () => {
    const bytes = Buffer.from(KERNEL_BASE64, 'base64');
    expect(bytes.length).toBe(KERNEL_BYTES);
    expect(KERNEL_BASE64.startsWith(KERNEL_MARKER)).toBe(true);
    const module = new WebAssembly.Module(bytes);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const k = new WebAssembly.Instance(module, {}).exports as unknown as { hk_abi(): number };
    expect(k.hk_abi()).toBe(KERNEL_ABI);
    // Small enough that no bundle budget notices it; a jump here means the standard library got in.
    expect(KERNEL_BYTES).toBeLessThan(16 * 1024);
  });
});

describe('loading', () => {
  it('on: a game gets an instance, a second world gets its own', async () => {
    await loadKernels('on');
    expect(kernelStatus().state).toBe('ready');
    const a = takeKernel(), b = takeKernel();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.memory).not.toBe(b!.memory);
  });

  it('off: nothing is handed out', async () => {
    await loadKernels('off');
    expect(kernelStatus().state).toBe('off');
    expect(takeKernel()).toBeNull();
  });

  it('failing to compile is reported once, and then nothing is handed out', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    await loadKernels('fail');
    await loadKernels('fail');
    expect(kernelStatus().state).toBe('failed');
    expect(kernelStatus().reason).toMatch(/magic/);
    expect(takeKernel()).toBeNull();
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]![0])).toMatch(/kernels failed to start and were skipped/);
    // And it recovers: the next game that asks for them gets them.
    await loadKernels('on');
    expect(kernelStatus().state).toBe('ready');
    expect(takeKernel()).not.toBeNull();
  });
});

describe('a game', () => {
  it('runs its physics on the kernel by default', async () => {
    expect((await physicsOfNewGame()).backend).toBe('kernel');
  });

  it('runs on TypeScript when the kernels are forced off', async () => {
    expect((await physicsOfNewGame('off')).backend).toBe('typescript');
  });

  it('keeps running on TypeScript when the module fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await physicsOfNewGame('fail')).backend).toBe('typescript');
  });

  it('made outside startGame, before any kernel was loaded, runs on TypeScript', async () => {
    await loadKernels('off');
    const game = await startGame(defineGame({ ready() {} }), { kernels: 'off' });
    const { Physics: P } = await import('../physics/index.ts');
    expect(new P(game.world).backend).toBe('typescript');
  });
});
