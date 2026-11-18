// hull/kits: ready gameplay pieces. A game composes them, and talks to them through their signals, public methods and
// tunables. Each folder has its own README; start with the two templates (fps, third-person) to see them together.
export { kitIO } from './io.ts';
export type { PlayOpts } from './io.ts';
export { LAYER, GROUP, flagsOf, ensurePhysics, upFrom, KitUi, lockPointerOnClick } from './common.ts';
export type { KitFlags } from './common.ts';
export { walk, footsteps, newWalk } from './walker.ts';
export type { WalkState, WalkTuning } from './walker.ts';

export { ArenaLevel, levelTuning } from './level/level.ts';
export type { Block } from './level/level.ts';
export { Health, HealthHud, healthTuning } from './health/health.ts';
export { Weapon } from './health/weapon.ts';
export { Stock, Pickup, StockHud, scatterPickups, pickupTuning } from './pickups/pickups.ts';
export { Spawner, Chaser, WaveHud, GameOver, spawnGrunt, spawnerTuning, enemyTuning } from './spawner/spawner.ts';
export { FirstPerson, Crosshair, spawnFirstPerson, fpsTuning } from './fps/fps.ts';
export { FollowCamera, followTuning } from './follow-camera/follow-camera.ts';
export { ThirdPerson, AimFollow, spawnThirdPerson, tpTuning } from './third-person/third-person.ts';
export { PauseMenu } from './pause/pause.ts';
export { SaveSlots } from './saves/saves.ts';
export type { SaveData } from './saves/saves.ts';
