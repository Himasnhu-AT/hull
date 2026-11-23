import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { ArenaLevel } from './level.ts';
import { Level } from './built.ts';

/** Bench scene: the arena alone, to look at the layout and tune its size and crates. */
export default defineGame({
  ready(g) {
    usePhysics(g.world);
    g.world.spawn('level').add(ArenaLevel);
  },
});

/** Bench scene for the config-driven level: config/level/yard.json with its ramp, prefab things, markers and rocks. */
export const yard = defineGame({
  ready(g) {
    usePhysics(g.world);
    g.world.spawn('level').add(Level, { level: 'yard' });
  },
});
