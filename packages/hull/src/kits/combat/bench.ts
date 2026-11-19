import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { ArenaLevel } from '../level/level.ts';
import { CombatDebug } from './debug.ts';
import { DuelDemo } from './demo.ts';
import { spawnDuelist, spawnEnemy } from './spawn.ts';

/**
 * Bench scene: a duel. The player (scripted by DuelDemo, and still answering your keys) against a raider that runs its
 * patterns from config/enemy/duelist. Hurt shapes are cyan, the blade is white and turns red inside its trace window,
 * and above each head a timeline shows the move: red trace, yellow tell, green cancel, blue i-frames, orange posture.
 */
export default defineGame({
  ready(g) {
    usePhysics(g.world);
    g.world.spawn('level').add(ArenaLevel);
    const me = spawnDuelist(g.world, { x: 0, z: 2, yaw: 0, character: 'character/duelist', moveSet: 'move-set/duelist', health: 100 });
    me.add(DuelDemo);
    spawnEnemy(g.world, 'enemy/duelist', { name: 'raider', x: 0, z: -0.4, yaw: Math.PI });
    g.world.spawn('debug').add(CombatDebug);
  },
});
