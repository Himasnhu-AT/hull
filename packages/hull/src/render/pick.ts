// Choosing a backend. Pure: no three.js and no browser, so Node tests cover every branch.
export type BackendName = 'webgl2' | 'webgpu';
export type BackendChoice = 'auto' | BackendName;

/** What the host tells us about the machine. `adapter` is null when `navigator.gpu` is missing or gave no adapter. */
export interface GpuFacts {
  adapter: null | { fallback: boolean; maxStorageBuffers: number; maxStorageBufferBytes: number };
}

/** The most storage buffers one shader stage may bind that the WebGPU backend needs (particles use up to 8). */
export const NEEDS_STORAGE_BUFFERS = 8;

/**
 * Why WebGPU should not be used on this machine, or null when it can be. A software adapter is slower than the
 * WebGL2 path on the same machine, and a device short of storage buffers cannot run the particle kernels.
 */
export function webgpuRefusal(f: GpuFacts): string | null {
  if (f.adapter === null) return 'this browser has no WebGPU adapter';
  if (f.adapter.fallback) return 'the only WebGPU adapter is a software one';
  if (f.adapter.maxStorageBuffers < NEEDS_STORAGE_BUFFERS) return `the adapter allows ${f.adapter.maxStorageBuffers} storage buffers per stage (needs ${NEEDS_STORAGE_BUFFERS})`;
  return null;
}

/**
 * The backends to try, in order. `auto` tries WebGPU when the browser exposes `navigator.gpu` (the adapter itself is
 * checked later, by the backend, which throws a reason when it must be skipped) and always ends with WebGL2.
 * A forced backend is the only one tried: forcing is for tests and for a player who knows better.
 */
export function backendOrder(choice: BackendChoice, hasNavigatorGpu: boolean): BackendName[] {
  if (choice === 'webgl2') return ['webgl2'];
  if (choice === 'webgpu') return ['webgpu'];
  return hasNavigatorGpu ? ['webgpu', 'webgl2'] : ['webgl2'];
}

/** A `?hullBackend=` query value turned into a choice; anything else is `auto`. */
export function choiceFromQuery(search: string): BackendChoice {
  const v = new URLSearchParams(search).get('hullBackend');
  return v === 'webgl2' || v === 'webgpu' ? v : 'auto';
}
