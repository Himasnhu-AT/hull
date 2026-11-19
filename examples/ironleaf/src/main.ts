// Ironleaf: a swordswoman on the island of Hoshiro. Phase 1 is the world and its people with a placeholder swing; the
// combat itself (stances, posture, deflects, duels) is designed in GAME.md and built in phase 2.
import { defineGame } from 'hull';
import { mountVfx } from 'hull/vfx';
import { PauseMenu } from 'hull/kits';
import { Atmosphere, Footing } from './atmosphere';
import { spawnAya, spawnRaiders } from './cast';
import { spawnIsland } from './world/island';

export default defineGame({
  stepRate: 60,
  ready(game) {
    const w = game.world;
    // Effects are Hull's: configs under config/vfx, played by name. They are mounted here so the game can ask for them.
    mountVfx(game);
    // Spawn order is step order: the pause menu first so a step sees the pause flag, then the world, Aya, the raiders.
    w.spawn('pause').add(PauseMenu);
    spawnIsland(w);
    const aya = spawnAya(w);
    aya.add(Footing);
    spawnRaiders(w);
    w.spawn('atmosphere').add(Atmosphere);
  },
});
