// Failure paths of the kernel mirror found by the audit of 25 Nov 2026: a trap in a call that game code makes
// (a pose, a property), memory growing under a view, a shape handed to the wrong world, and a height field whose
// size is not a whole number. Each is a case the parity tests cannot reach, because nothing goes wrong in them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineGame, startGame, type Game } from '../core/index.ts';
import { Body, Hit, usePhysics, type Physics, type Shape } from './index.ts';

afterEach(() => { vi.restoreAllMocks(); });
const v = (x: number, y: number, z: number) => ({ x, y, z });

async function world(kernels: 'on' | 'off', build?: (g: Game, p: Physics) => void): Promise<{ game: Game; phys: Physics }> {
  let phys!: Physics;
  const game = await startGame(defineGame({ ready(g) { phys = usePhysics(g.world); build?.(g, phys); } }), { seed: 3, stepRate: 120, kernels });
  return { game, phys };
}
/** The kernel's exports, to stand in for a module that traps or grows its memory at a chosen moment. */
const exportsOf = (p: Physics): Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory } =>
  (p._kw as unknown as { k: Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory } }).k;
function replaceExports(p: Physics, patch: (real: ReturnType<typeof exportsOf>) => Record<string, unknown>): void {
  const kw = p._kw as unknown as { k: unknown };
  const real = exportsOf(p);
  // The module's export object is frozen, so the stand-in is a new object over the same functions and memory.
  const copy: Record<string, unknown> = {};
  for (const k of Object.keys(real)) copy[k] = (real as Record<string, unknown>)[k];
  kw.k = Object.assign(copy, patch(real));
}

describe('the kernel mirror when something goes wrong', () => {
  it('a trap while a shape is posed drops the kernel once and never reaches game code', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await world('on'), b = await world('off');
    const mk = (p: Physics) => [p.addBox(v(0, 0, 0), v(4, 4, 4)), p.addSphere(v(8, 2, 0), 1, { static: false })] as Shape[];
    const sa = mk(a.phys), sb = mk(b.phys);
    expect(a.phys.backend).toBe('kernel');
    // A query files every shape moved so far, so the pose below is the first since and has to join the list.
    a.phys.raycast(v(20, 2, 0), v(-1, 0, 0), 100); b.phys.raycast(v(20, 2, 0), v(-1, 0, 0), 100);
    replaceExports(a.phys, () => ({ hk_flush: () => { throw new WebAssembly.RuntimeError('unreachable'); }, hk_cast: () => { throw new WebAssembly.RuntimeError('unreachable'); } }));
    // Fill the dirty list so the next pose has to flush, as a busy frame does.
    const kw = a.phys._kw as unknown as { hdr: Int32Array; dirty: Int32Array };
    kw.hdr[12] = kw.dirty.length;
    expect(() => { sa[1]!.setPose(6, 2, 0, 0, 0, 0, 1); sb[1]!.setPose(6, 2, 0, 0, 0, 0, 1); }).not.toThrow();
    expect(a.phys.backend).toBe('typescript');
    expect(() => { sa[1]!.enabled = false; sa[1]!.enabled = true; }).not.toThrow();
    const ha = new Hit(), hb = new Hit();
    const ray = (p: Physics, h: Hit) => { const r = p.raycast(v(20, 2, 0), v(-1, 0, 0), 100, undefined, h); return r && [r.distance, r.shape === (p === a.phys ? sa[1] : sb[1])]; };
    expect(ray(a.phys, ha)).toEqual(ray(b.phys, hb));
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]![0])).toMatch(/carries on in TypeScript/);
  });

  it('memory that grows during a flush loses no flag and no body', async () => {
    const build = (g: Game, p: Physics) => {
      p.addGround(0);
      for (let i = 0; i < 6; i++) {
        const n = g.world.spawn('b' + i);
        n.position.set(i * 2 - 5, 3 + i, 0);
        n.rotation.set(0.3 * i, 0.2, 0.1);
        n.add(Body, { shape: { type: 'box', size: [0.8, 0.6, 0.5] } });
      }
    };
    const a = await world('on', build), b = await world('off', build);
    const kw = a.phys._kw as unknown as { hdr: Int32Array; dirty: Int32Array };
    const hdrAt = kw.hdr.byteOffset;
    let flushes = 0;
    /** Makes the next pose find the dirty list full, as it is in a frame that moved many shapes. */
    const fill = (): void => { new Int32Array(exportsOf(a.phys).memory.buffer, hdrAt, 64)[12] = kw.dirty.length; };
    // Every flush is followed by a growth of the module's memory, which detaches every view made before it; and the
    // solver leaves the list full, so the first body posed after a step flushes while the others are still unread.
    replaceExports(a.phys, (real) => ({
      hk_flush: () => { real.hk_flush!(); real.memory.grow(1); flushes++; return 0; },
      hk_rigid_step: (...args: number[]) => { const r = real.hk_rigid_step!(...args); fill(); return r; },
    }));
    for (let s = 0; s < 40; s++) { a.game.step(1); b.game.step(1); }
    expect(flushes).toBeGreaterThanOrEqual(40);
    expect(a.phys.backend).toBe('kernel');
    expect(a.phys.state()).toEqual(b.phys.state());
    // A rotated box posed across a growth still answers as a rotated box (its axis-aligned flag was written).
    const mk = (p: Physics) => p.add({ type: 'box', size: [6, 1, 1] }, { static: false, position: v(30, 5, 0) });
    const ba = mk(a.phys), bb = mk(b.phys);
    const q = { x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) };
    const d = (p: Physics) => p.raycast(v(31.5, 20, 0), v(0, -1, 0), 100, undefined, new Hit())?.distance;
    // A query first, so the box is filed and its next pose has to join the (full) list and flush.
    expect(d(a.phys)).toBe(d(b.phys));
    const before = flushes;
    fill();
    ba.setPose(30, 5, 0, q.x, q.y, q.z, q.w); bb.setPose(30, 5, 0, q.x, q.y, q.z, q.w);
    expect(flushes).toBe(before + 1);
    expect(d(a.phys)).toBe(d(b.phys));
    expect(d(b.phys)).toBeLessThan(14);
  });

  it('a shape of another world is not mistaken for the one with the same number here', async () => {
    const seen: Record<string, unknown> = {};
    for (const kernels of ['on', 'off'] as const) {
      const one = await world(kernels), two = await world(kernels);
      const near = one.phys.addSphere(v(0, 0, 0), 1, { userData: 'one-near' });
      one.phys.addSphere(v(200, 0, 0), 1, { userData: 'one-far' });
      const foreign = two.phys.addSphere(v(100, 0, 0), 1, { userData: 'two-first' });
      // The foreign shape has the first id of its world, as `near` has here.
      expect(one.phys.distanceTo(foreign, v(0, 0, 0))).toBe(99);
      const hit = one.phys.raycast(v(-10, 0, 0), v(1, 0, 0), 50, { ignoreShape: foreign }, new Hit());
      expect(hit?.shape).toBe(near);
      // Removing a shape from the wrong world is the caller's mistake. It must not take out the shape that has the
      // same number in that world, and both implementations must leave the same state behind.
      two.phys.remove(near);
      expect(two.phys.raycast(v(90, 0, 0), v(1, 0, 0), 50, undefined, new Hit())?.shape).toBe(foreign);
      seen[kernels] = one.phys.raycast(v(-10, 0, 0), v(1, 0, 0), 500, undefined, new Hit())?.shape?.userData ?? null;
    }
    expect(seen.on).toEqual(seen.off);
  });

  it('refuses a height field whose columns or rows are not whole numbers, on both implementations', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const kernels of ['on', 'off'] as const) {
      const w = await world(kernels);
      const heights = new Array(100).fill(1);
      expect(() => w.phys.addHeightfield(heights, 4, 2.5, 1)).toThrow(/whole numbers of columns and rows/);
      expect(() => w.phys.addHeightfield(heights, NaN, 4, 1)).toThrow(/whole numbers/);
      expect(w.phys.backend).toBe(kernels === 'on' ? 'kernel' : 'typescript');
    }
    expect(said).not.toHaveBeenCalled();
  });
});
