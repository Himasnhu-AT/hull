// Ironleaf: a swordswoman on the island of Hoshiro. The world and its people are phase 1; the fight (Aya's stances,
// the raiders' patterns, the duel) is phase 2 on Hull's combat kit.
import { defineGame } from 'hull';
import { mountVfx } from 'hull/vfx';
import { PauseMenu } from 'hull/kits';
import { Atmosphere, Footing } from './atmosphere';
import { spawnAya } from './player';
import { Aya } from './player/aya';
import { encounters, enemyHooks, spawnEncounters } from './enemies';
import { dressFighter, isKind } from './models';
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
    // The raiders are dressed in their modelled bodies as they spawn.
    enemyHooks.dress = (n, kind) => { if (isKind(kind)) dressFighter(n, kind); };
    spawnEncounters(w);
    // The camp starts with a standoff: Aya's attack button lets go of the blade.
    aya.get(Aya)!.standoffOf = () => encounters(w)?.standoff ?? null;
    w.spawn('atmosphere').add(Atmosphere);
  },
});
