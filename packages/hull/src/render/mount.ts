// mountRender: picks a backend, owns the canvas and the requestAnimationFrame loop, and keeps the look in step
// with its config file. A backend that fails to start is reported once and skipped; if none starts, the game
// still runs, just without a picture.
import { config } from '../config/index.ts';
import type { Game } from '../core/index.ts';
import type { Look } from '../schema/look.ts';
import type { Backend, Quality, RenderStats } from './backend.ts';
import { activeCamera } from './behaviours.ts';
import { WebGL2Backend } from './webgl2.ts';

export interface RenderOptions {
  backend?: 'auto' | 'webgl2';
  /** A `look/*` id to start with. */
  look?: string;
  quality?: Quality;
  /** Called once per problem (a backend that would not start, a lost GPU context). Defaults to console.error. */
  onProblem?: (message: string) => void;
}

export interface RenderView {
  /** 'none' when no backend could start. */
  readonly backend: 'webgl2' | 'webgpu' | 'none';
  stats(): RenderStats;
  shot(): Promise<Blob>;
  /** 'look/day' or 'day'. */
  setLook(id: string): void;
  /** Low drops post effects and shadows; medium and high keep them (high adds grain and FXAA). */
  setQuality(quality: Quality): void;
  dispose(): void;
}

// WebGPU arrives at M7 and is added here; 'auto' will then try it first.
const factories: Record<string, () => Backend> = {
  webgl2: () => new WebGL2Backend(),
};

export function mountRender(game: Game, el: HTMLElement, opts: RenderOptions = {}): RenderView {
  const problem = opts.onProblem ?? ((m: string) => console.error(`[hull] ${m}`));
  const quality = opts.quality ?? 'medium';
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  el.appendChild(canvas);

  const order = opts.backend === 'webgl2' ? ['webgl2'] : ['webgpu', 'webgl2'];
  let backend: Backend | null = null;
  for (const name of order) {
    const make = factories[name];
    if (!make) continue;
    const candidate = make();
    try {
      candidate.init(canvas, quality);
      backend = candidate;
      break;
    } catch (e) {
      problem(`render: backend "${name}" failed to start: ${e instanceof Error ? e.message : String(e)}`);
      try { candidate.dispose(); } catch { /* it never started */ }
    }
  }
  if (!backend) problem('render: no backend could start; the game runs without a picture.');
  const be = backend;

  // Look, live: the id is watched so an edit in the Inspector shows on the next frame.
  let unwatch: (() => void) | null = null;
  const setLook = (id: string): void => {
    unwatch?.();
    unwatch = null;
    if (!be) return;
    const full = id.startsWith('look/') ? id : `look/${id}`;
    try {
      be.setLook(config.lookup('look', full.slice('look/'.length)));
    } catch {
      console.warn(`[hull] render: look "${full}" does not exist; keeping the current look.`);
      return;
    }
    unwatch = config.watch(full, (now) => be.setLook(now as Look));
  };
  if (opts.look) setLook(opts.look);

  let lost = false;
  const onLost = (ev: Event) => {
    ev.preventDefault();
    if (!lost) problem('render: the GPU context was lost; drawing resumes if it comes back.');
    lost = true;
  };
  const onRestored = () => { lost = false; };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  const world = game.world;
  const resize = () => be?.resize(el.clientWidth, el.clientHeight, globalThis.devicePixelRatio || 1);
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(el);

  // Drawing happens in the game's frame callback, which is where the loop hands over the blend factor.
  const offFrame = game.onFrame((alpha) => {
    if (!be || lost) return;
    be.sync(world, alpha);
    be.draw(activeCamera(world.root));
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
    backend: be ? be.name : 'none',
    stats: () => be?.stats() ?? { drawCalls: 0, triangles: 0, ms: 0, fps: 0 },
    shot: () => (be ? be.shot() : Promise.reject(new Error('render: no backend is running, so there is nothing to capture'))),
    setLook,
    setQuality: (q) => be?.setQuality(q),
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      offFrame();
      unwatch?.();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      be?.dispose();
      canvas.remove();
    },
  };
}
