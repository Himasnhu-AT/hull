// The bodies AOTT draws, registered for the Studio's character bench (hull.json "models"). The bench plays a character's
// clips and state graph on its skeleton; these builders put the game's real model on that skeleton: the soldier from
// player/model.ts, the titans from titans/builder.ts and rig.ts, the horse from player/horse.ts. Nothing here is a
// copy of those modules: it only calls them the way the game does, with a stand-in for the parts of the game they
// read (a flat ground and no effects).
import * as THREE from 'hull/three';
import type { BenchModel, BenchModelBuilder, RegisterBenchModel } from 'hull/anim';
import type { Game } from '../types';
import { PlayerModel } from '../player/model';
import { Horse } from '../player/horse';
import { getArchetype, bodyMaterial, type BuildKey, type ExprKey, type SizeClass, type SkinKey } from '../titans/builder';
import { buildRig, JOINT_NAMES, type JointName } from '../titans/rig';

/** The little the models read from the game: a scene to hang under, flat ground, no effects, no titans. */
function benchGame(): { game: Game; scene: THREE.Group } {
  const scene = new THREE.Group();
  const collision = { groundHeight: () => 0, raycast: () => null, collideSphere: () => [] };
  return { game: { scene, collision, fx: null, audio: null, titans: null } as unknown as Game, scene };
}

const box = (o: THREE.Object3D): BenchModel['bounds'] => () => {
  const b = new THREE.Box3().setFromObject(o);
  return b.isEmpty() ? null : { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
};

// ---------------------------------------------------------------- the soldier
const soldier: BenchModelBuilder = () => {
  const { game, scene } = benchGame();
  const m = new PlayerModel(game);
  m.autoGas = false;
  scene.remove(m.root);
  const j = m.j;
  const state = { position: new THREE.Vector3(0, 0.9, 0), forward: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), grounded: true, footIK: false, blades: true, speed: 0, running: 0 };
  return {
    object: m.root,
    // The model's L is the soldier's left, as the config's armL is.
    bones: {
      spine: j.spine, chest: j.chest, head: j.head,
      armL: j.armL.sh, forearmL: j.armL.el, handL: j.armL.wr, armR: j.armR.sh, forearmR: j.armR.el, handR: j.armR.wr,
      legL: j.legL.hip, shinL: j.legL.kn, footL: j.legL.an, legR: j.legR.hip, shinR: j.legR.kn, footR: j.legR.an,
    },
    // The model runs its own update (cloak, blades) and the pose of the clips lands on top of it.
    update(dt) { m.update(dt, state); },
    posed() { m.skeleton.update(); m.root.updateMatrixWorld(true); },
    bounds: () => ({ min: [-0.6, 0, -0.5], max: [0.6, 1.85, 0.5] }),
    dispose() { m.dispose(); },
  };
};

// ---------------------------------------------------------------- the titans
const HEIGHT: Record<SizeClass, number> = { S: 4.5, M: 8, L: 15, XL: 40 };

const titan: BenchModelBuilder = (id) => {
  const mt = /^(?:character\/)?titan-([a-z]+)-(S|M|L|XL)$/.exec(id);
  if (!mt) throw new Error(`"${id}" is not a titan id (titan-<build>-<size>)`);
  const build = mt[1] as BuildKey, size = mt[2] as SizeClass;
  const behemoth = build === 'behemoth';
  const skin: SkinKey = behemoth ? 'pink' : 'beige';
  const expr: ExprKey = behemoth ? 'behemoth' : build === 'female' ? 'huntress' : 'grin';
  const arch = getArchetype({ build, size, skin, hair: behemoth ? false : 0, expr });
  const height = behemoth ? 60 : HEIGHT[size];
  const rig = buildRig(arch, height, bodyMaterial(behemoth));
  // The game's rig faces +Z with its left on +X, which is the bench's frame once the pose is turned half a circle.
  const bones: Record<string, THREE.Object3D> = {};
  const name: Partial<Record<JointName, string>> = { pelvis: 'hips', foreL: 'forearmL', foreR: 'forearmR', thighL: 'legL', thighR: 'legR' };
  for (const jn of JOINT_NAMES) bones[name[jn] ?? jn] = rig.J[jn];
  return {
    object: rig.root,
    bones,
    offsets: true,
    posed() { rig.root.updateMatrixWorld(true); },
    bounds: box(rig.root),
  };
};

// ---------------------------------------------------------------- the horse
const GAIT_SPEED: Record<string, number> = { idle: 0, walk: 1.8, trot: 5, gallop: 19 };

const horse: BenchModelBuilder = () => {
  const { game, scene } = benchGame();
  const h = new Horse(game, new THREE.Vector3(), 0, 0.31);
  scene.remove(h.root);
  // The horse walks on the ground, planting hooves as it goes: here it runs in place on a treadmill, the wrapper
  // carrying it back by the distance it has covered.
  const wrap = new THREE.Group();
  wrap.add(h.root);
  return {
    object: wrap,
    update(dt, view) {
      dt = Math.min(dt, 0.05);
      const want = view.clip ? (GAIT_SPEED[view.clip] ?? 0) : view.animator.get('speed');
      h.state = 'graze';
      h.t = 0;
      h.speed = want;
      h.fixedUpdate(dt);
      h.speed = want;
      h.update(dt);
      wrap.position.set(-h.pos.x, 0, -h.pos.z);
    },
    bounds: () => ({ min: [-0.5, 0, -1.2], max: [0.5, 2.5, 1.5] }),
    dispose() { /* the horse's geometry is shared, and dies with the page */ },
  };
};

export default function register(reg: RegisterBenchModel): void {
  reg('soldier', soldier);
  reg('titan-*', titan);
  reg('horse', horse);
}
