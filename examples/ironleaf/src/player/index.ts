// Aya as the player: the combat kit's Combatant, her controller, the HUD and the feel layer.
import { type Node, type World } from 'hull';
import { Collider } from 'hull/physics';
import { Camera } from 'hull/render';
import { Combatant, FollowCamera, GROUP, Health, LAYER, LockOn, tpTuning } from 'hull/kits';
import { Animator } from 'hull/anim';
import { Dress } from '../models';
import { groundHeight, STARTS } from '../world/map';
import { Aya } from './aya';
import { AyaHud } from './hud';
import { Feel } from './feel';

export { Aya, STANCES, STANCE_TIME, CHARGE_TIME, FINISH_RANGE } from './aya';
export { AyaHud } from './hud';
export { Feel } from './feel';

export interface AyaOpts { x?: number; z?: number; yaw?: number; start?: string; hud?: boolean }

/** Aya, her camera, lock-on and HUD. A node named 'player' with a Combatant of team 'player'. */
export function spawnAya(world: World, o: AyaOpts = {}): Node {
  const loc = (globalThis as { location?: { search: string } }).location;
  const pick = o.start ?? new URLSearchParams(loc?.search ?? '').get('start') ?? 'landing';
  const [sx, sz, syaw] = STARTS[pick] ?? STARTS['landing']!;
  const x = o.x ?? sx, z = o.z ?? sz, yaw = o.yaw ?? syaw;
  const me = world.spawn('player');
  me.addTo(GROUP.player);
  me.position.set(x, groundHeight(x, z), z);
  me.rotation.y = yaw;
  me.add(Health, { max: 100, hp: 100, invulnAfterHit: 0 });
  // Her posture (GAME.md section 5): 100, back at 18 a second after 1.2 s out of combat, staggered for 1 s at zero.
  me.add(Combatant, { team: 'player', moveSet: 'move-set/aya', stance: 'stone', maxPosture: 100, postureRecover: 18, postureDelay: 1.2, brokenSeconds: 1.0 });
  me.add(Collider, { shape: { type: 'capsule', radius: tpTuning.radius, height: tpTuning.height, center: [0, tpTuning.height / 2, 0] }, layer: LAYER.player });
  const model = world.spawn('model', me);
  model.add(Animator, { character: 'character/aya', ground: groundHeight });
  model.add(Dress, { kind: 'aya' });
  const cam = world.spawn('camera');
  cam.add(Camera, { fov: 60 });
  cam.add(FollowCamera, { yaw });
  me.add(Aya, { facing: yaw });
  me.add(LockOn);
  if (o.hud !== false) me.add(AyaHud);
  me.add(Feel);
  return me;
}
