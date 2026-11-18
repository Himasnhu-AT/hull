// The benches run the real engine inside the app's renderer: hull core, render, anim and vfx are imported here, the
// project's config files are read over the protocol into hull's own registry, and every config.changed push is
// handed to config.update, so an edit (Inspector, agent, editor on disk) reaches the bench through the same push the
// game gets. Modules load on first use so the launcher does not pay for them.

import type { Game } from 'hull';
import type { RenderView } from 'hull/render';
import type { RpcClient } from '../lib/rpc.ts';

export interface Engine {
  hull: typeof import('hull');
  render: typeof import('hull/render');
  anim: typeof import('hull/anim');
  vfx: typeof import('hull/vfx');
}

let engine: Promise<Engine> | null = null;

export function loadEngine(): Promise<Engine> {
  engine ??= Promise.all([import('hull'), import('hull/render'), import('hull/anim'), import('hull/vfx')])
    .then(([hull, render, anim, vfx]) => ({ hull, render, anim, vfx }));
  return engine;
}

const synced = new WeakMap<RpcClient, Promise<string[]>>();

/** Reads every config file of the project into the registry once per connection, then keeps it current from pushes. Resolves to the load problems. */
export function syncConfig(rpc: RpcClient, eng: Engine): Promise<string[]> {
  let p = synced.get(rpc);
  if (!p) {
    p = (async () => {
      const items = (await rpc.call('library.list', {})).filter((i) => i.kind !== 'tunables');
      const docs = await Promise.all(items.map((i) => rpc.call('config.read', { id: i.id }).catch(() => null)));
      const res = eng.hull.config.load(docs.filter((d) => d !== null).map((d) => ({ path: d.path, text: d.text })));
      rpc.on('config.changed', (c) => { eng.hull.config.update({ path: c.path, text: c.text }); });
      rpc.on('config.removed', (c) => { eng.hull.config.remove(c.path); });
      return res.problems.map((x) => `${x.file}${x.pointer ?? ''}: ${x.message}`);
    })();
    synced.set(rpc, p);
  }
  return p;
}

export interface Stage<T = void> {
  game: Game;
  /** What the scene builder returned: handles the bench drives. */
  scene: T;
  view: RenderView;
  dispose(): void;
}

/** A game of its own in `el`: the scene `build` makes, drawn by mountRender, running in real time. Dispose it when the bench closes. */
export async function createStage<T>(eng: Engine, el: HTMLElement, build: (game: Game) => T, opts: { look?: string | undefined; vfx?: boolean } = {}): Promise<Stage<T>> {
  const { hull, render, vfx } = eng;
  let scene!: T;
  const game = await hull.startGame(hull.defineGame({ ready(g) { scene = build(g); } }), { seed: 1 });
  // Its own container, so a stage that finishes starting after its bench closed cannot clear a newer one.
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;inset:0';
  el.appendChild(box);
  const view = render.mountRender(game, box, { backend: 'webgl2', ...(opts.look ? { look: opts.look } : {}), quality: 'high' });
  const mounted = opts.vfx ? vfx.mountVfx(game) : null;
  return {
    game, view, scene,
    dispose() {
      mounted?.dispose();
      view.dispose();
      game.dispose();
      box.remove();
    },
  };
}
