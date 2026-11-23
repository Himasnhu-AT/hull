// The engine's WebAssembly kernels (plan-rust.md, ARCHITECTURE section 11): one module built from crates/hull-kernels,
// carried in the bundle as base64 and started before a game's `ready`. A kernel is batch arithmetic over flat arrays
// behind a TypeScript API that does not change; the TypeScript implementation of the same work stays, as the fallback
// and as the oracle the kernel is tested against. So everything here may fail without the game noticing: a module
// that does not compile or start is reported once and the TypeScript path runs.
//
// Only a module that has a kernel imports this file (today: hull/physics), so a game that uses none carries no
// WebAssembly. Runs in Node and the browser alike.
import { beforeStart } from '../core/index.ts';
import { KERNEL_BASE64, KERNEL_BYTES, KERNEL_STAMP } from './wasm.ts';

/** The layout and exports this engine was written against; a module that reports another is refused. */
export const KERNEL_ABI = 2;

/** What the module exports (crates/hull-kernels/src/lib.rs). Numbers and offsets only. */
export interface KernelExports {
  readonly memory: WebAssembly.Memory;
  hk_abi(): number;
  /** Address of the header (lib.rs `mod h`) that says where every shared array is. */
  hk_hdr(): number;
  hk_world_init(cell: number): void;
  hk_shape_new(kind: number): number;
  hk_shape_commit(id: number): number;
  hk_shape_remove(id: number): void;
  hk_mesh_data(tris: number, nodes: number): number;
  hk_hf_data(columns: number, rows: number): number;
  hk_cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): number;
  hk_gather(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number;
  hk_overlap_sphere(x: number, y: number, z: number, radius: number): number;
  hk_overlap_capsule(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number, n: number): number;
  hk_closest(id: number, x: number, y: number, z: number): number;
  hk_body_add(shape: number): number;
  hk_body_remove(index: number): void;
  hk_rigid_step(dt: number, gx: number, gy: number, gz: number, iterations: number): number;
  hk_flush(): void;
  /** One shape at a time, for the narrow-phase parity test. */
  hk_t_sweep(id: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): void;
  hk_t_closest(id: number, x: number, y: number, z: number): number;
  hk_t_ray_aabb(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tmax: number): number;
}

export type KernelMode = 'on' | 'off' | 'fail';

export interface KernelStatus {
  /** 'unloaded' until a game has started; 'off' when forced off; 'failed' when the module did not start. */
  state: 'unloaded' | 'ready' | 'off' | 'failed';
  /** Why it failed. */
  reason?: string;
  /** Size of the module, as it is carried (before base64). */
  bytes: number;
  /** The source stamp the module was built from. */
  stamp: string;
}

let mode: KernelMode = 'on';
let compiled: WebAssembly.Module | null = null;
let failure: string | null = null;
let reported = false;
/** The instance made for the game that is starting, until a subsystem takes it. */
let waiting: KernelExports | null = null;

function moduleBytes(): Uint8Array<ArrayBuffer> {
  const text = atob(KERNEL_BASE64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function checked(instance: WebAssembly.Instance): KernelExports {
  const k = instance.exports as unknown as KernelExports;
  if (typeof k.hk_abi !== 'function' || k.hk_abi() !== KERNEL_ABI) throw new Error(`the module's ABI is not ${KERNEL_ABI}: rebuild it with pnpm kernels:build`);
  return k;
}

/**
 * Compiles the module (once) and starts an instance for the game about to start. `startGame` calls this through
 * `beforeStart`; a test may call it directly. Never throws: a failure is reported once and leaves the kernels off.
 */
export async function loadKernels(want: KernelMode = 'on'): Promise<void> {
  mode = want;
  waiting = null;
  if (want === 'off') return;
  try {
    if (want === 'fail') {
      // The fallback under test: the same bytes with the magic number spoiled, so the real compile path fails.
      const broken = moduleBytes();
      broken[0] = 1;
      await WebAssembly.compile(broken);
    }
    compiled ??= await WebAssembly.compile(moduleBytes());
    waiting = checked(await WebAssembly.instantiate(compiled, {}));
    failure = null;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    if (!reported) {
      reported = true;
      console.error('kernels failed to start and were skipped (the TypeScript implementations run instead): ' + failure);
    }
  }
}

/**
 * An instance of the module for one subsystem of one world, or null when the kernels are off, failed, or were never
 * loaded (a world made outside `startGame`): the caller then runs its TypeScript implementation.
 */
export function takeKernel(): KernelExports | null {
  if (mode !== 'on' || failure !== null) return null;
  if (waiting !== null) {
    const k = waiting;
    waiting = null;
    return k;
  }
  if (compiled === null) return null;
  // A second world in the same game. A browser may refuse to start a module synchronously; that is a fallback, not an error.
  try { return checked(new WebAssembly.Instance(compiled, {})); } catch { return null; }
}

export function kernelStatus(): KernelStatus {
  const state = mode === 'off' ? 'off' : failure !== null ? 'failed' : compiled !== null ? 'ready' : 'unloaded';
  const s: KernelStatus = { state, bytes: KERNEL_BYTES, stamp: KERNEL_STAMP };
  if (failure !== null && state === 'failed') s.reason = failure;
  return s;
}

/** The start of the module as it appears inside a bundle: the build looks for this to say whether game.js carries it. */
export const KERNEL_MARKER = KERNEL_BASE64.slice(0, 96);
export { KERNEL_BYTES, KERNEL_STAMP };

beforeStart((opts) => loadKernels(opts.kernels ?? 'on'));
