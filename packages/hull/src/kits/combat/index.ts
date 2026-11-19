// The combat kit: fighters with posture and timed guards, weapon traces against hurt shapes, enemies that run patterns
// from config, lock-on, standoffs. See README.md.
export { Combatant, combatTuning, FIGHTERS, inWindow, newAttack } from './combatant.ts';
export type { Attack, CombatState } from './combatant.ts';
export { CombatHub, HitInfo, combatHub } from './hub.ts';
export type { Outcome } from './hub.ts';
export { EnemyBrain, AttackTokens, attackTokens, brainTuning, turnToward } from './brain.ts';
export { FighterInput, fighterTuning } from './input.ts';
export { LockOn, lockTuning, pickLockTarget } from './lockon.ts';
export { Standoff } from './standoff.ts';
export type { StandoffResult } from './standoff.ts';
export { Blade, HurtShapes, poseNow, segSegDistSq, segmentHitsBox, sweepBlade } from './trace.ts';
export { spawnFighter, spawnEnemy, spawnDuelist } from './spawn.ts';
export type { FighterOpts } from './spawn.ts';
export { CombatDebug } from './debug.ts';
export { DuelDemo } from './demo.ts';
export { checkMoveSet, checkEnemy } from './check.ts';
