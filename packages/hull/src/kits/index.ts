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
export { damp, followDistance, followFov, smoothstep, Reach } from './follow-camera/glide.ts';
export { zoneEffect, coveredDamage, regenerate, ZONE_NONE, ZONE_SHALLOW, ZONE_CUT } from './health/zones.ts';
export { newDepotState, stepDepot, fillTo } from './pickups/depot.ts';
export type { DepotRules, DepotState } from './pickups/depot.ts';
export { newWaveState, resetWaves, beginWave, stepWaves, waveCap, waveClock, waveScale, WAVE_NONE, WAVE_NEXT, WAVE_CLEARED, WAVE_TRICKLE } from './spawner/waves.ts';
export type { WaveRules, WaveState } from './spawner/waves.ts';
export { ThirdPerson, AimFollow, spawnThirdPerson, tpTuning } from './third-person/third-person.ts';
export * from './combat/index.ts';
export { NavGrid, NavPath, newFollower, followPath, navTuning } from './nav/nav.ts';
export type { NavBounds, PathFollower, FollowOut } from './nav/nav.ts';
export { PauseMenu } from './pause/pause.ts';
export { SaveSlots } from './saves/saves.ts';
export type { SaveData } from './saves/saves.ts';
