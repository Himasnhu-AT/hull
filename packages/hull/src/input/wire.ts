// Connects a core to a game's loop. No DOM, so tests use the same wiring as the browser.
import type { Game } from '../core/index.ts';
import type { InputCore } from './core.ts';

/** `beforeSample` runs just before each sample (dom.ts polls the gamepad there). Returns an unwire function. */
export function wireInput(game: Game, core: InputCore, beforeSample?: () => void): () => void {
  const off = game.onBeforeSteps(() => {
    beforeSample?.();
    core.sample();
  });
  // A world system runs after every behaviour, once per fixed step, which is what a recording needs.
  game.world.system('hull.input', { fixedUpdate: () => core.afterStep() });
  return () => {
    off();
    game.world.system('hull.input', {});
  };
}
