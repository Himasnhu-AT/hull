import { defineGame } from '../../core/index.ts';
import { Hud } from './hud.ts';

/** Bench scene: every slot filled, with a countdown and a few messages in a row. */
export default defineGame({
  ready(g) {
    let score = 0;
    const hud = g.world.spawn('hud').add(Hud);
    hud.score(() => score);
    hud.timer(() => 90 - g.world.tick / 60, { countDown: true });
    hud.objective('Reach the tower');
    hud.bar('Stamina', () => 60 + 40 * Math.sin(g.world.tick / 60), 100);
    hud.prompt('E to open');
    hud.message('Welcome', 2);
    hud.message('Find the tower', 3);
    g.world.every(1, () => { score += 10; });
  },
});
