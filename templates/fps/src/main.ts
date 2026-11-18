import { defineGame } from 'hull';
import { ArenaLevel, GameOver, PauseMenu, SaveSlots, Spawner, WaveHud, scatterPickups, spawnFirstPerson } from 'hull/kits';

// A game made only of kits. What each piece does is in packages/hull/src/kits/<kit>/README.md; the numbers are the
// kits' tunables (Inspector) and the files in config/. The order of spawns is the order of fixed updates: the pause
// menu first, so a step sees the pause flag before anything acts on it; then the world, the player, the enemies.
export default defineGame({
  ready(game) {
    const w = game.world;
    w.spawn('pause').add(PauseMenu);
    w.spawn('saves').add(SaveSlots);
    const level = w.spawn('level').add(ArenaLevel);
    spawnFirstPerson(w);
    scatterPickups(w, level, 'health', 5, { amount: 30, respawn: 20 });
    const waves = w.spawn('spawner');
    waves.add(Spawner, { level });
    waves.add(WaveHud);
    waves.add(GameOver);
  },
});
