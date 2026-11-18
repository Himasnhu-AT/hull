import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { ArenaLevel } from '../level/level.ts';
import { spawnFirstPerson } from './fps.ts';

/** Bench scene: the first-person body in an arena with nothing else, to feel speed, jump and look. */
export default defineGame({
  ready(g) {
    usePhysics(g.world);
    g.world.spawn('level').add(ArenaLevel);
    spawnFirstPerson(g.world);
  },
});
