import { describe, expect, it } from 'vitest';
import type { Vfx } from '../schema/vfx.ts';
import { compile } from './emitter.ts';
import { GpuParticles, structureKey } from './webgpu.ts';

// The GPU simulation's CPU side runs in Node: the node graphs are only built when a renderer compiles them, so with a
// fake renderer these tests check what the CPU decides: what runs, in which order, and how many to draw.
const config: Vfx = {
  kind: 'vfx',
  emit: { count: [100, 100], shape: { sphere: 1 } },
  particle: { life: [1, 2], speed: [1, 2], direction: { outward: true }, color: [[0, '#ffffff']], alpha: [[0, 1]] },
  budget: { max: 5000 },
};

function fake() {
  const calls: string[] = [];
  const renderer = {
    compute(kernel: { name: string; count: number | null }) {
      calls.push(kernel.name === 'hull.vfx.spawn' ? `spawn:${kernel.count}` : 'update');
    },
  };
  return { calls, renderer: renderer as never };
}

describe('GPU particle scheduling', () => {
  it('runs a spawn before the step it belongs to, and each fixed step as one update', () => {
    const g = new GpuParticles(compile(config));
    const { calls, renderer } = fake();
    g.spawn(100, 0, 0, 0, undefined, 1); // during tick 0
    g.endTick(1 / 60);
    g.endTick(1 / 60); // tick 1 had no spawn
    g.spawn(50, 0, 0, 0, undefined, 2); // during tick 2
    g.endTick(1 / 60);
    g.frame(renderer, 1 / 60, 0.25);
    expect(calls).toEqual(['spawn:100', 'update', 'update', 'spawn:50', 'update']);
    g.dispose();
  });

  it('draws only the slots that have been written, up to the budget, and wraps the ring', () => {
    const g = new GpuParticles(compile(config));
    const { renderer } = fake();
    g.spawn(3000, 0, 0, 0, undefined, 1);
    g.endTick(1 / 60);
    g.frame(renderer, 1 / 60, 0);
    expect(g.geometry.instanceCount).toBe(3000);
    g.spawn(3000, 0, 0, 0, undefined, 2); // past the 5000 budget: the ring overwrites the oldest
    g.endTick(1 / 60);
    g.frame(renderer, 1 / 60, 0);
    expect(g.geometry.instanceCount).toBe(5000);
    expect(g.spawned).toBe(6000);
    g.clear();
    expect(g.geometry.instanceCount).toBe(0);
    expect(g.mesh.visible).toBe(false);
    g.dispose();
  });

  it('estimates live particles from when they were spawned and how long they live', () => {
    const g = new GpuParticles(compile(config));
    g.spawn(1000, 0, 0, 0, undefined, 1);
    g.endTick(0.5); // half a second old: inside the shortest life (1 s)
    expect(g.liveEstimate()).toBe(1000);
    g.endTick(1); // 1.5 s old: halfway through the 1 to 2 s range
    expect(g.liveEstimate()).toBe(500);
    g.endTick(1); // 2.5 s old: all gone
    expect(g.liveEstimate()).toBe(0);
    g.dispose();
  });

  it('folds a huge number of steps (a test stepping thousands at once) into a bounded number of updates', () => {
    const g = new GpuParticles(compile(config));
    const { calls, renderer } = fake();
    g.spawn(10, 0, 0, 0, undefined, 1);
    for (let i = 0; i < 10_000; i++) g.endTick(1 / 60);
    g.frame(renderer, 1 / 60, 0);
    expect(calls.filter((c) => c === 'update').length).toBeLessThanOrEqual(600);
    expect(calls.filter((c) => c.startsWith('spawn')).length).toBe(1);
    g.dispose();
  });

  it('rebuilds the shader only when its structure changes', () => {
    const a = compile(config);
    const faster = compile({ ...config, particle: { ...config.particle, speed: [5, 9], gravity: -3 } });
    const disc = compile({ ...config, emit: { ...config.emit, shape: { disc: 1 } } });
    const additive = compile({ ...config, particle: { ...config.particle, blend: 'additive' } });
    expect(structureKey(faster)).toBe(structureKey(a));
    expect(structureKey(disc)).not.toBe(structureKey(a));
    expect(structureKey(additive)).not.toBe(structureKey(a));
  });
});
