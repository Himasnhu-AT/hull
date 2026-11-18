import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { ArenaLevel } from './level.ts';

/** Bench scene: the arena alone, to look at the layout and tune its size and crates. */
export default defineGame({
  ready(g) {
    usePhysics(g.world);
    g.world.spawn('level').add(ArenaLevel);
  },
});
