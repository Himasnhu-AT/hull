// The line between the game's node tree and a renderer. Games never see a backend: they add Mesh, Camera and
// Light behaviours and `mountRender` drives the backend. WebGL2 and WebGPU both sit behind it.
import type { Node, World } from '../core/index.ts';
import type { Look } from '../schema/look.ts';
import type { PostFx } from './postfx.ts';

export type Quality = 'low' | 'medium' | 'high';

/** Things a game may ask a backend whether it can do, so it can choose a cheaper path instead of failing. */
export type Capability = 'shadows' | 'instancing' | 'post' | 'compute' | 'msaa';

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  /** CPU milliseconds spent in the last draw. */
  ms: number;
  /** Smoothed frames per second, from the time between draws. */
  fps: number;
  /** GPU milliseconds of the last frame, when the backend can time the GPU (WebGPU with `timestamp-query`); else absent. */
  gpuMs?: number;
}

export interface Backend {
  readonly name: 'webgl2' | 'webgpu';
  /** Set by `mountRender`: where a problem that comes up while running (a lost device) is reported. */
  onProblem?: ((message: string) => void) | undefined;
  /**
   * Throws (or rejects), naming the reason, when the device cannot be used; `mountRender` then tries the next backend.
   * WebGL2 starts at once; WebGPU has to ask the browser for an adapter and device, so it returns a promise.
   */
  init(canvas: HTMLCanvasElement, quality: Quality): void | Promise<void>;
  can(cap: Capability): boolean;
  /** Puts every node's transform between its last two fixed steps (`alpha` is 0 to 1) and adopts the world's tree. */
  sync(world: World, alpha: number): void;
  /** Draws through the node's Camera behaviour, then gives the nodes their real transforms back. A null node draws no scene. */
  draw(cameraNode: Node | null): void;
  /** Applies a `look` config value (sky, fog, ambient, sun, exposure, tone mapping). Undefined restores the default. */
  setLook(look: Look | undefined): void;
  /** The per-frame post state (speed cue, impact pulse); called by `mountRender` before each draw. */
  setFx(fx: PostFx): void;
  /** Switches the quality tier while running: low drops post and shadows. */
  setQuality(quality: Quality): void;
  resize(width: number, height: number, dpr: number): void;
  stats(): RenderStats;
  /** The last frame as a PNG. */
  shot(): Promise<Blob>;
  dispose(): void;
}
