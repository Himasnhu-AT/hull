import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { spawnFirstPerson } from '../fps/fps.ts';
import { ArenaLevel } from '../level/level.ts';
import { SaveSlots } from '../saves/saves.ts';
import { PauseMenu } from './pause.ts';

/** Bench scene: press Esc to open the menu and see what stops while it is open. */
export default defineGame({
  ready(g) {
    usePhysics(g.world);
    g.world.spawn('pause').add(PauseMenu);
    g.world.spawn('saves').add(SaveSlots);
    g.world.spawn('level').add(ArenaLevel);
    spawnFirstPerson(g.world);
  },
});
