// Builds the joint hierarchy + meshes for one titan from a shared archetype, and describes its hit/collider shapes.
import * as THREE from 'hull/three';
import type { Archetype, PartGeo } from './builder';

const V3 = THREE.Vector3;

export type JointName =
  | 'pelvis' | 'spine' | 'neck' | 'head' | 'jaw'
  | 'armL' | 'foreL' | 'handL' | 'armR' | 'foreR' | 'handR'
  | 'thighL' | 'shinL' | 'footL' | 'thighR' | 'shinR' | 'footR';
export type Joints = Record<JointName, THREE.Object3D>;

/** The mesh slots of a rig (each one joint's merged geometry). */
export type MeshKey = 'pelvis' | 'spine' | 'head' | 'jaw' | 'armL' | 'armR' | 'foreL' | 'foreR' | 'thighL' | 'thighR' | 'shinL' | 'shinR' | 'footL' | 'footR';
export interface RigMesh { mesh: THREE.Mesh; joint: THREE.Object3D; key: MeshKey }

/** Hit / collider shape in joint-local, unscaled units. */
export type ShapePart = 'head' | 'torso' | 'pelvis' | 'arm' | 'hand' | 'leg' | 'foot' | 'ankle' | 'eye' | 'nape';
export type ShapeGroup = 'body' | 'arm' | 'hand' | 'ankle' | 'eye' | 'nape';
interface ShapeBase { part: ShapePart; joint: THREE.Object3D; collide: boolean; group: ShapeGroup }
export interface CapsuleShape extends ShapeBase { type: 'capsule'; a: THREE.Vector3; b: THREE.Vector3; r: number }
export interface SphereShape extends ShapeBase { type: 'sphere'; c: THREE.Vector3; r: number }
export interface BoxShape extends ShapeBase { type: 'box'; c: THREE.Vector3; h: THREE.Vector3 }
export type RigShape = CapsuleShape | SphereShape | BoxShape;

export interface Rig {
  root: THREE.Group;
  J: Joints;
  meshes: RigMesh[];
  shapes: RigShape[];
  scale: number;
}

type V3T = readonly [number, number, number];

/** `material`: the titan's own (tinted) body material; defaults to the archetype's shared one. */
export function buildRig(arch: Archetype, height: number, material: THREE.Material = arch.material): Rig {
  const d = arch.dims, geo = arch.geo;
  const root = new THREE.Group();
  root.name = 'titan';
  const J = {} as Joints;
  const mk = (name: JointName, parent: THREE.Object3D, x: number, y: number, z: number) => {
    const g = new THREE.Object3D(); g.name = name; g.position.set(x, y, z); parent.add(g); J[name] = g; return g;
  };
  mk('pelvis', root, 0, d.hipY, 0);
  mk('spine', J.pelvis, 0, d.spineY, 0);
  mk('neck', J.spine, 0, d.neckY, 0.05);
  mk('head', J.neck, 0, d.neckLen, 0.05);
  mk('jaw', J.head, d.jawPivot.x, d.jawPivot.y, d.jawPivot.z);
  for (const [n, s] of [['L', 1], ['R', -1]] as const) {
    mk(`arm${n}`, J.spine, s * d.shoulderX, d.shoulderY, 0);
    mk(`fore${n}`, J[`arm${n}`], 0, -d.upperLen, 0);
    mk(`hand${n}`, J[`fore${n}`], 0, -d.foreLen, 0);
    mk(`thigh${n}`, J.pelvis, s * d.hipX, -0.05, 0);
    mk(`shin${n}`, J[`thigh${n}`], 0, -d.thighLen, 0);
    mk(`foot${n}`, J[`shin${n}`], 0, -d.shinLen, 0);
  }
  const meshes: RigMesh[] = [];
  const attach = (joint: THREE.Object3D, g: PartGeo, key: MeshKey) => {
    const m = new THREE.Mesh(g.full, material);
    m.castShadow = true; m.receiveShadow = true; m.name = key;
    joint.add(m);
    meshes.push({ mesh: m, joint, key });
    return m;
  };
  attach(J.pelvis, geo.pelvis, 'pelvis');
  attach(J.spine, geo.spine, 'spine');
  attach(J.head, geo.head, 'head');
  attach(J.jaw, geo.jaw, 'jaw');
  attach(J.armL, geo.arm, 'armL'); attach(J.armR, geo.arm, 'armR');
  attach(J.foreL, geo.foreL, 'foreL'); attach(J.foreR, geo.foreR, 'foreR');
  attach(J.thighL, geo.thigh, 'thighL'); attach(J.thighR, geo.thigh, 'thighR');
  attach(J.shinL, geo.shin, 'shinL'); attach(J.shinR, geo.shin, 'shinR');
  attach(J.footL, geo.foot, 'footL'); attach(J.footR, geo.foot, 'footR');
  // jaw hinge: geometry is built in jaw-local space already (origin = hinge)

  const scale = height / d.total;
  root.scale.setScalar(scale);

  // ------------------------------------------------------------------ hit / collider shapes (joint-local, unscaled units)
  const lm = d.limb, tw = d.B.torsoW, th = d.B.torsoH, R = d.headR;
  const shapes: RigShape[] = [];
  const v = (t: V3T) => new V3(t[0], t[1], t[2]);
  const cap = (part: ShapePart, joint: THREE.Object3D, a: V3T, b: V3T, r: number, group: ShapeGroup, collide = true) => shapes.push({ part, joint, type: 'capsule', a: v(a), b: v(b), r, collide, group });
  const sph = (part: ShapePart, joint: THREE.Object3D, c: V3T, r: number, group: ShapeGroup, collide = true) => shapes.push({ part, joint, type: 'sphere', c: v(c), r, collide, group });
  const box = (part: ShapePart, joint: THREE.Object3D, c: V3T, h: V3T, group: ShapeGroup, collide = true) => shapes.push({ part, joint, type: 'box', c: v(c), h: v(h), collide, group });

  // body
  sph('head', J.head, [0, d.cy, d.cz + 0.02], R * 0.98 * Math.max(d.B.faceW, 0.9), 'body');
  box('torso', J.spine, [0, 1.45 * th, 0], [1.15 * tw, 1.5 * th, 0.82], 'body');
  box('pelvis', J.pelvis, [0, 0.2, 0], [0.88 * tw, 0.62, 0.66 + 0.4 * d.B.belly], 'body');
  for (const n of ['L', 'R'] as const) {
    cap('arm', J[`arm${n}`], [0, 0, 0], [0, -d.upperLen, 0], 0.5 * lm + 0.05, 'arm');
    cap('arm', J[`fore${n}`], [0, 0, 0], [0, -d.foreLen + 0.5 * d.handS, 0], 0.4 * lm + 0.05, 'arm');
    sph('hand', J[`hand${n}`], [0, -0.05, 0], 0.5 * d.handS + 0.1, 'hand');
    cap('leg', J[`thigh${n}`], [0, 0, 0], [0, -d.thighLen, 0], 0.62 * lm + 0.04, 'body');
    cap('leg', J[`shin${n}`], [0, 0, 0], [0, -d.shinLen, 0], 0.4 * lm + 0.03, 'body');
    cap('foot', J[`foot${n}`], [0, -0.1, 0.12], [0, -0.1, 0.9], 0.27 * Math.sqrt(lm) + 0.1, 'body');
    // hit-test-only extras
    sph('ankle', J[`foot${n}`], [0, 0.1, -0.05], 0.4 + 0.1 * lm, 'ankle', false);
  }
  // eyes (hit-test only)
  const eyeX = 0.43 * d.rx, eyeY = d.cy + 0.1 * R * d.B.faceH;
  const eyeZ = d.cz + d.rz * Math.sqrt(Math.max(0.04, 1 - (eyeX / d.rx) ** 2 - ((eyeY - d.cy) / d.ry) ** 2));
  for (const s of [-1, 1]) sph('eye', J.head, [s * eyeX, eyeY, eyeZ], Math.max(0.3, arch.st.eye * R * 1.5), 'eye', false);
  // nape (hit-test only): scale generosity for small titans
  const gen = 1 + 0.6 * (1 - Math.min(1, height / 10));
  const nh = d.napeHalf.clone().multiplyScalar(gen * (d.size === 'XL' ? 1.15 : 1));
  shapes.push({ part: 'nape', joint: J.head, type: 'box', c: d.napeC.clone(), h: nh, collide: false, group: 'nape' });

  return { root, J, meshes, shapes, scale };
}
