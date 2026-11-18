// What the render bridge tells the rest of the engine about the running backend. The particle system lives outside
// the bridge and must draw differently on each backend, and may only use compute when the backend has it; this is
// the one place it asks. Games never read it.
import type { BackendName } from './pick.ts';

export interface RenderRuntime {
  readonly backend: BackendName;
  /** True when the backend can run compute shaders (WebGPU only). */
  readonly compute: boolean;
  /** The backend's renderer object. Typed loosely on purpose: only the matching backend's own code casts it. */
  readonly renderer: unknown;
}

let current: RenderRuntime | null = null;
const listeners = new Set<() => void>();

/** The backend now drawing, or null before one has started (or after it is disposed). */
export function renderRuntime(): RenderRuntime | null {
  return current;
}

export function setRenderRuntime(r: RenderRuntime | null): void {
  current = r;
  for (const l of [...listeners]) l();
}

/** Called when the backend changes (it starts, or is disposed). Returns the way to stop listening. */
export function onRenderRuntime(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// The WebGPU particle module, handed over by the WebGPU backend once it is loaded. The particle system is outside the
// render bridge and must not import three/webgpu itself (a WebGL2 game would then ship it), so it asks here.
let wgVfx: unknown = null;
export function registerWebgpuVfx(mod: unknown): void { wgVfx = mod; }
export function webgpuVfx(): unknown { return wgVfx; }
