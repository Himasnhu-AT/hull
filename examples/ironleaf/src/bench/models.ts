// The bodies Ironleaf draws, registered for the Studio's character bench (hull.json "models"). The bench plays a character's
// clips and state graph on its skeleton; these builders put the game's real model (src/models) on that skeleton, so the
// bench shows Aya and the Band as the game does: same parts, same weapons, same spring bones.
import * as THREE from 'hull/three';
import type { BenchModel, BenchModelBuilder, RegisterBenchModel } from 'hull/anim';
import { Body, KINDS, type Kind } from '../models';

const make = (kind: Kind): BenchModelBuilder => () => {
  // The bench faces +Z and the config faces -Z: turn the whole body half a circle, and copy the pose on unturned.
  const root = new THREE.Group();
  const flip = new THREE.Group();
  flip.rotation.y = Math.PI;
  root.add(flip);
  const bones: Record<string, THREE.Object3D> = {};
  let body: Body | null = null;
  const model: BenchModel = {
    object: root,
    bones,
    turned: false,
    offsets: true,
    update(_dt, view) {
      if (body) return;
      // The first frame has the skeleton: make a bone for each, in the skeleton's tree, then draw the body on them.
      const sk = view.animator.skeleton;
      sk.names.forEach((n, i) => {
        const o = new THREE.Object3D();
        o.name = n;
        o.position.set(sk.rest[i * 3]!, sk.rest[i * 3 + 1]!, sk.rest[i * 3 + 2]!);
        const p = sk.parent[i]!;
        (p < 0 ? flip : bones[sk.names[p]!]!).add(o);
        bones[n] = o;
      });
      body = new Body(kind, sk, (n) => bones[n]);
    },
    dispose() { body?.dispose(); },
  };
  return model;
};

export default function register(reg: RegisterBenchModel): void {
  for (const k of KINDS) reg(k, make(k));
}
