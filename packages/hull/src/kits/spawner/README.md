# spawner kit

Waves of enemies, a stand-in enemy, and a game-over screen.

- **Behaviours**: `Spawner` (waves; signals `waveStarted`, `waveCleared`, `spawned`, `killed`; `reset()`), `Chaser`
  (walks at the nearest player and bites; a body zone and a `head` zone), `WaveHud`, `GameOver` (press `jump` to restart).
  `spawnGrunt(world, x, z, wave)` is the default `factory`; give the Spawner your own to spawn something else.
- **Tunables**: `spawner` block: `firstDelay`, `wavePause`, `firstCount`, `countGrowth`, `maxAlive`, `interval`,
  `minDistance`. `enemy` block: `speed`, `speedPerWave`, `health`, `damage`, `reach`, `attackInterval`, `accel`.
- **Config**: `material/enemy`, `material/enemy-head`. Random stream: `spawner`.
- **Bench**: `bench.ts`. **Test**: `spawner.test.ts`.
- An enemy must be in the `enemy` group and have a `Health`; the spawner counts them by group.
- **Wave clock without enemies** (`waves.ts`): for a game that builds its own enemies. `stepWaves(state, dt, alive, queued, hold, rules)`
  returns `WAVE_NEXT`, `WAVE_CLEARED`, `WAVE_TRICKLE` or `WAVE_NONE`; `beginWave`, `waveScale`, `waveCap`, `waveClock`.
  `state` is any object with `wave`, `waveClear`, `waveT`, `trickleT`; `rules` (`WaveRules`) can be a tunables block, read live.
  AOTT's Holdout uses it over its `waves` block. Test: `waves.test.ts`.
