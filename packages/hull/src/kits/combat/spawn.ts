import { Animator } from '../../anim/index.ts';
import { config } from '../../config/index.ts';
import type { Node, World } from '../../core/index.ts';
import { Camera } from '../../render/index.ts';
import { GROUP } from '../common.ts';
import { FollowCamera } from '../follow-camera/follow-camera.ts';
import { Health } from '../health/health.ts';
import { EnemyBrain } from './brain.ts';
import { Combatant, combatTuning } from './combatant.ts';
import { FighterInput } from './input.ts';
import { LockOn } from './lockon.ts';

export interface FighterOpts {
  name?: string;
  x?: number;
  z?: number;
  /** Facing, as a yaw: 0 faces -Z. */
  yaw?: number;
  team?: string;
  /** 'character/duelist'. */
  character?: string;
  /** 'move-set/duelist'. */
  moveSet?: string;
  health?: number;
  stance?: string;
}

/** A node with Health, a Combatant, and (with a character) a child "model" that holds the Animator. */
export function spawnFighter(world: World, o: FighterOpts = {}): Node {
  const n = world.spawn(o.name ?? 'fighter');
  n.position.set(o.x ?? 0, 0, o.z ?? 0);
  n.rotation.y = o.yaw ?? 0;
  const hp = o.health ?? 100;
  n.add(Health, { max: hp, hp });
  n.add(Combatant, { team: o.team ?? '', moveSet: o.moveSet ?? '', stance: o.stance ?? '' });
  if (o.character) {
    const model = world.spawn('model', n);
    model.rotation.y = combatTuning.modelYaw;
    model.add(Animator, { character: o.character });
  }
  return n;
}

let counter = 0;

/** An enemy from its config: stats, move-set, character and brain. `target` is the name of the node it fights. */
export function spawnEnemy(world: World, id: string, o: FighterOpts & { target?: string } = {}): Node {
  const bare = id.replace(/^enemy\//, '');
  const def = config.lookup('enemy', bare);
  const n = spawnFighter(world, { name: o.name ?? bare + '-' + ++counter, ...o, team: o.team ?? 'raiders', character: o.character ?? def.character, moveSet: def.moveSet });
  n.addTo(GROUP.enemy);
  n.add(EnemyBrain, { enemy: bare, targetName: o.target ?? 'player' });
  return n;
}

/** The player's fighter: Combatant, buttons and movement from the actions, lock-on, and a follow camera behind. */
export function spawnDuelist(world: World, o: FighterOpts = {}): Node {
  const n = spawnFighter(world, { name: 'player', team: 'player', ...o });
  n.addTo(GROUP.player);
  n.add(FighterInput);
  const cam = world.spawn('camera');
  cam.add(Camera, { fov: 55 });
  cam.add(FollowCamera);
  n.add(LockOn);
  return n;
}
