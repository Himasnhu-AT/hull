// mountRender: picks a backend, owns the canvas and the requestAnimationFrame loop, and keeps the look in step
// with its config file. A backend that fails to start is reported once and skipped; if none starts, the game
// still runs, just without a picture.
import { config } from '../config/index.ts';
import type { Game } from '../core/index.ts';
import type { Look } from '../schema/look.ts';
import type { Backend, Capability, Quality, RenderStats } from './backend.ts';
import { activeCamera } from './behaviours.ts';
import { backendOrder, choiceFromQuery, type BackendChoice, type BackendName } from './pick.ts';
import { WebGL2Backend } from './webgl2.ts';

export interface RenderOptions {
  /**
   * 'auto' (the default) tries WebGPU when the browser has it and the machine's adapter is a real GPU, and otherwise
   * (or when WebGPU fails to start) falls back to WebGL2. The two named values force one backend. A page may also
   * force one for a test with `?hullBackend=webgl2|webgpu` (or the same after a `#`, for servers that refuse a query) when this option is left out.
   */
  backend?: BackendChoice;
  /** A `look/*` id to start with. */
  look?: string;
  quality?: Quality;
  /** Called once per problem (a backend that would not start, a lost GPU context). Defaults to console.error. */
  onProblem?: (message: string) => void;
}

export interface RenderView {
  /** The backend that is drawing: 'none' while WebGPU is still starting, and when no backend could start. */
  readonly backend: 'webgl2' | 'webgpu' | 'none';
  /** Settles once the backend is chosen (at once for WebGL2; after the adapter and device are ready for WebGPU). */
  readonly ready: Promise<'webgl2' | 'webgpu' | 'none'>;
  stats(): RenderStats;
  shot(): Promise<Blob>;
  /** 'look/day' or 'day'. */
  setLook(id: string): void;
  /** Low drops post effects and shadows; medium and high keep them (high adds grain and FXAA). */
  setQuality(quality: Quality): void;
  /** Most device pixels per CSS pixel to draw at; the platform's quality presets set it (a 3x phone draws at 1.5x). */
  setPixelRatioCap(cap: number): void;
  /** Whether the running backend can do `cap` (for example `can('compute')` is true on WebGPU only). */
  can(cap: Capability): boolean;
  dispose(): void;
}

// WebGPU is loaded only when it is going to be tried: its code is large and a WebGL2 game never needs it.
const factories: Record<BackendName, () => Backend | Promise<Backend>> = {
  webgl2: () => new WebGL2Backend(),
  webgpu: async () => new (await import('./webgpu.ts')).WebGPUBackend(),
};

export function mountRender(game: Game, el: HTMLElement, opts: RenderOptions = {}): RenderView {
  const problem = opts.onProblem ?? ((m: string) => console.error(`[hull] ${m}`));
  const quality = opts.quality ?? 'medium';
  const choice = opts.backend ?? choiceFromQuery(`${globalThis.location?.search ?? ''}&${(globalThis.location?.hash ?? '').slice(1)}`);
  const order = backendOrder(choice, typeof navigator !== 'undefined' && 'gpu' in navigator);

  let canvas: HTMLCanvasElement | null = null;
  let be: Backend | null = null;
  let disposed = false;
  let lost = false;
  let dprCap = Infinity;
  let unwatch: (() => void) | null = null;
  let lookId: string | null = opts.look ?? null;
  const world = game.world;

  const freshCanvas = (): HTMLCanvasElement => {
    // A canvas keeps the first kind of context it was given, so every attempt gets its own.
    const c = document.createElement('canvas');
    c.style.display = 'block';
    c.style.width = '100%';
    c.style.height = '100%';
    el.appendChild(c);
    return c;
  };
  const onLost = (ev: Event) => {
    ev.preventDefault();
    if (!lost) problem('render: the GPU context was lost; drawing resumes if it comes back.');
    lost = true;
  };
  const onRestored = () => { lost = false; };

  const resize = () => be?.resize(el.clientWidth, el.clientHeight, Math.min(globalThis.devicePixelRatio || 1, dprCap));

  // Look, live: the id is watched so an edit in the Inspector shows on the next frame.
  const applyLook = (id: string): void => {
    unwatch?.();
    unwatch = null;
    const b = be;
    if (!b) return;
    const full = id.startsWith('look/') ? id : `look/${id}`;
    try {
      b.setLook(config.lookup('look', full.slice('look/'.length)));
    } catch {
      console.warn(`[hull] render: look "${full}" does not exist; keeping the current look.`);
      return;
    }
    unwatch = config.watch(full, (now) => b.setLook(now as Look));
  };
  const setLook = (id: string): void => {
    lookId = id;
    applyLook(id);
  };

  const adopt = (candidate: Backend, c: HTMLCanvasElement): void => {
    be = candidate;
    canvas = c;
    c.addEventListener('webglcontextlost', onLost);
    c.addEventListener('webglcontextrestored', onRestored);
    if (lookId) applyLook(lookId);
    resize();
  };

  // Each attempt is reported once and skipped. The first attempt runs synchronously when it can (WebGL2), so a game
  // that forces WebGL2 has its backend the moment `mountRender` returns.
  const ready: Promise<'webgl2' | 'webgpu' | 'none'> = (async () => {
    for (const name of order) {
      if (disposed) return 'none';
      const c = freshCanvas();
      let candidate: Backend | null = null;
      try {
        const made = factories[name]();
        candidate = made instanceof Promise ? await made : made;
        candidate.onProblem = problem;
        const started = candidate.init(c, quality);
        if (started instanceof Promise) await started;
        if (disposed) { candidate.dispose(); c.remove(); return 'none'; }
        adopt(candidate, c);
        return name;
      } catch (e) {
        problem(`render: backend "${name}" failed to start: ${e instanceof Error ? e.message : String(e)}`);
        try { candidate?.dispose(); } catch { /* it never started */ }
        c.remove();
      }
    }
    if (!disposed) problem('render: no backend could start; the game runs without a picture.');
    return 'none';
  })();

  const observer = new ResizeObserver(resize);
  observer.observe(el);

  // Drawing happens in the game's frame callback, which is where the loop hands over the blend factor.
  const offFrame = game.onFrame((alpha) => {
    const b = be;
    if (!b || lost) return;
    b.sync(world, alpha);
    b.draw(activeCamera(world.root));
  });

  let raf = 0;
  let last = -1;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    // rAF hands over its own timestamp in ms; the simulation never reads a clock itself.
    const dt = last < 0 ? 0 : (now - last) / 1000;
    last = now;
    game.frame(dt);
  };
  raf = requestAnimationFrame(loop);

  return {
    get backend() { return be ? be.name : 'none'; },
    ready,
    stats: () => be?.stats() ?? { drawCalls: 0, triangles: 0, ms: 0, fps: 0 },
    shot: async () => {
      await ready;
      if (!be) throw new Error('render: no backend is running, so there is nothing to capture');
      // Draw the state as it is now, then capture it. A paused game driven by step() (the play tool, the control
      // port) may not have had a frame drawn since its last step, or at all: WebGPU starts asynchronously.
      be.sync(world, 1);
      be.draw(activeCamera(world.root));
      return be.shot();
    },
    setLook,
    setQuality: (q) => be?.setQuality(q),
    setPixelRatioCap: (cap) => { dprCap = cap > 0 ? cap : Infinity; resize(); },
    can: (cap) => be?.can(cap) ?? false,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      offFrame();
      unwatch?.();
      canvas?.removeEventListener('webglcontextlost', onLost);
      canvas?.removeEventListener('webglcontextrestored', onRestored);
      be?.dispose();
      be = null;
      canvas?.remove();
    },
  };
}
