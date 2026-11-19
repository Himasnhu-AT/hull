// Builds the joint hierarchy + meshes for one titan from a shared archetype, and describes its hit/collider shapes.
import * as THREE from 'hull/three';
import { config } from 'hull';
import type { Character, CharacterHit } from 'hull/schema';
import type { Archetype, Dims, PartGeo } from './builder';

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
  /** The titan's height in metres, and its expression's eye size: what the shapes are finished with. */
  height: number;
  eyeFactor: number;
}

type V3T = readonly [number, number, number];


const FLIP = (n: number): number => (n === 0 ? 0 : -n);
/** The config's character body faces -Z with the right hand on +X; the titans of AOTT face +Z with their left on +X. Rest data crosses the line by turning half a circle about Y: x and z change sign, names stay. */
const toConfig = (t: V3T): [number, number, number] => [FLIP(t[0]), t[1], FLIP(t[2])];
const fromConfig = (t: readonly number[]): V3T => [FLIP(t[0]!), t[1]!, FLIP(t[2]!)];

/** AOTT's joint names are the engine's humanoid names except these three. */
const BONE: Partial<Record<JointName, string>> = { pelvis: 'hips', foreL: 'forearmL', foreR: 'forearmR', thighL: 'legL', thighR: 'legR' };
const JOINT_OF: Record<string, JointName> = {};
export const JOINT_NAMES: JointName[] = ['pelvis', 'spine', 'neck', 'head', 'jaw', 'armL', 'foreL', 'handL', 'armR', 'foreR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];
for (const j of JOINT_NAMES) JOINT_OF[BONE[j] ?? j] = j;
const boneOf = (j: JointName): string => BONE[j] ?? j;

/** One hit / collider shape, unscaled, in AOTT's frame, as the rig keeps it. */
export interface ShapeData { part: ShapePart; joint: JointName; group: ShapeGroup; collide: boolean; type: 'capsule' | 'sphere' | 'box'; a?: V3T; b?: V3T; c?: V3T; r?: number; h?: V3T }
/** Everything about a titan's skeleton that is data: where each joint sits in its parent, and the hit shapes. */
export interface RigData { joints: Record<JointName, V3T>; parent: Record<JointName, JointName | null>; shapes: ShapeData[] }

const PARENT: Record<JointName, JointName | null> = {
  pelvis: null, spine: 'pelvis', neck: 'spine', head: 'neck', jaw: 'head',
  armL: 'spine', foreL: 'armL', handL: 'foreL', armR: 'spine', foreR: 'armR', handR: 'foreR',
  thighL: 'pelvis', shinL: 'thighL', footL: 'shinL', thighR: 'pelvis', shinR: 'thighR', footR: 'shinR',
};

/**
 * The rig as numbers, worked out from a build's dimensions: what config/character/titan-<build>-<size>.json holds
 * (the file is this, written down, so editing the file is how a person changes it). Eye shapes carry the smallest
 * radius they may have (the expression's eyes widen them); the nape box is the unscaled one (a small titan's nape is
 * made more generous in buildRig).
 */
export function rigDataOf(d: Dims): RigData {
  const joints = {} as Record<JointName, V3T>;
  joints.pelvis = [0, d.hipY, 0]; joints.spine = [0, d.spineY, 0]; joints.neck = [0, d.neckY, 0.05]; joints.head = [0, d.neckLen, 0.05];
  joints.jaw = [d.jawPivot.x, d.jawPivot.y, d.jawPivot.z];
  for (const [n, s] of [['L', 1], ['R', -1]] as const) {
    joints[`arm${n}`] = [s * d.shoulderX, d.shoulderY, 0];
    joints[`fore${n}`] = [0, -d.upperLen, 0];
    joints[`hand${n}`] = [0, -d.foreLen, 0];
    joints[`thigh${n}`] = [s * d.hipX, -0.05, 0];
    joints[`shin${n}`] = [0, -d.thighLen, 0];
    joints[`foot${n}`] = [0, -d.shinLen, 0];
  }
  const lm = d.limb, tw = d.B.torsoW, th = d.B.torsoH, R = d.headR;
  const shapes: ShapeData[] = [];
  const cap = (part: ShapePart, joint: JointName, a: V3T, b: V3T, r: number, group: ShapeGroup, collide = true): void => { shapes.push({ part, joint, type: 'capsule', a, b, r, collide, group }); };
  const sph = (part: ShapePart, joint: JointName, c: V3T, r: number, group: ShapeGroup, collide = true): void => { shapes.push({ part, joint, type: 'sphere', c, r, collide, group }); };
  const box = (part: ShapePart, joint: JointName, c: V3T, h: V3T, group: ShapeGroup, collide = true): void => { shapes.push({ part, joint, type: 'box', c, h, collide, group }); };
  sph('head', 'head', [0, d.cy, d.cz + 0.02], R * 0.98 * Math.max(d.B.faceW, 0.9), 'body');
  box('torso', 'spine', [0, 1.45 * th, 0], [1.15 * tw, 1.5 * th, 0.82], 'body');
  box('pelvis', 'pelvis', [0, 0.2, 0], [0.88 * tw, 0.62, 0.66 + 0.4 * d.B.belly], 'body');
  for (const n of ['L', 'R'] as const) {
    cap('arm', `arm${n}`, [0, 0, 0], [0, -d.upperLen, 0], 0.5 * lm + 0.05, 'arm');
    cap('arm', `fore${n}`, [0, 0, 0], [0, -d.foreLen + 0.5 * d.handS, 0], 0.4 * lm + 0.05, 'arm');
    sph('hand', `hand${n}`, [0, -0.05, 0], 0.5 * d.handS + 0.1, 'hand');
    cap('leg', `thigh${n}`, [0, 0, 0], [0, -d.thighLen, 0], 0.62 * lm + 0.04, 'body');
    cap('leg', `shin${n}`, [0, 0, 0], [0, -d.shinLen, 0], 0.4 * lm + 0.03, 'body');
    cap('foot', `foot${n}`, [0, -0.1, 0.12], [0, -0.1, 0.9], 0.27 * Math.sqrt(lm) + 0.1, 'body');
    sph('ankle', `foot${n}`, [0, 0.1, -0.05], 0.4 + 0.1 * lm, 'ankle', false);
  }
  const eyeX = 0.43 * d.rx, eyeY = d.cy + 0.1 * R * d.B.faceH;
  const eyeZ = d.cz + d.rz * Math.sqrt(Math.max(0.04, 1 - (eyeX / d.rx) ** 2 - ((eyeY - d.cy) / d.ry) ** 2));
  for (const s of [-1, 1]) sph('eye', 'head', [s * eyeX, eyeY, eyeZ], 0.3, 'eye', false);
  box('nape', 'head', [d.napeC.x, d.napeC.y, d.napeC.z], [d.napeHalf.x, d.napeHalf.y, d.napeHalf.z], 'nape', false);
  return { joints, parent: PARENT, shapes };
}

/** The character config of a titan (Hull's frame, rigid parts for the bench), from its rig data. */
export function characterOf(d: Dims, data: RigData = rigDataOf(d)): Character {
  const bones = JOINT_NAMES.map((j) => ({ name: boneOf(j), ...(PARENT[j] ? { parent: boneOf(PARENT[j]!) } : {}), offset: toConfig(data.joints[j]) }));
  const parts: NonNullable<Character['body']['parts']> = [];
  const hits: CharacterHit[] = [];
  const mat = d.B.behemoth ? 'behemoth' : 'skin';
  for (const s of data.shapes) {
    const bone = boneOf(s.joint);
    hits.push({
      bone, shape: s.type, part: s.part, group: s.group, ...(s.collide ? {} : { collide: false }),
      ...(s.a ? { a: toConfig(s.a) } : {}), ...(s.b ? { b: toConfig(s.b) } : {}), ...(s.c ? { c: toConfig(s.c) } : {}),
      ...(s.r !== undefined ? { r: s.r } : {}), ...(s.h ? { h: [...s.h] as [number, number, number] } : {}),
    });
    if (!s.collide || s.group === 'nape' || s.group === 'eye') continue;
    if (s.type === 'capsule') parts.push({ bone, shape: 'limb', material: mat, from: toConfig(s.a!), to: toConfig(s.b!), radius: s.r! });
    else if (s.type === 'sphere') parts.push({ bone, shape: 'sphere', material: mat, center: toConfig(s.c!), radius: s.r! });
    else parts.push({ bone, shape: 'box', material: mat, center: toConfig(s.c!), size: [2 * s.h![0], 2 * s.h![1], 2 * s.h![2]] });
  }
  return {
    kind: 'character',
    note: `A ${d.build} titan, size class ${d.size}: the skeleton and hit shapes AOTT's rig is built from, in the engine's frame (facing -Z) and unscaled units. The parts are a rigid stand-in for the bench; the game draws its own modelled body on these bones.`,
    body: { type: 'generated', recipe: 'custom', bones, parts },
    materials: { skin: 'material/titan-skin', behemoth: 'material/titan-behemoth' },
    hits,
    animSet: 'anim-set/humanoid',
    animGraph: 'anim-graph/titan',
  };
}

export const rigConfigId = (d: Dims): string => `titan-${d.build}-${d.size}`;

/** The rig data a project's config/character file gives for these dimensions, or the computed default if it has none. */
export function rigDataFor(d: Dims): RigData {
  const id = `character/${rigConfigId(d)}`;
  if (!config.has(id)) return rigDataOf(d);
  return fromCharacter(config.lookup('character', rigConfigId(d)), id, d);
}

function fromCharacter(c: Character, at: string, d: Dims): RigData {
  const base = rigDataOf(d);
  const joints = { ...base.joints };
  const seen = new Set<JointName>();
  for (const b of c.body.bones ?? []) {
    const j = JOINT_OF[b.name];
    if (!j) throw new Error(`${at}#/body/bones: "${b.name}" is not a titan bone`);
    joints[j] = fromConfig(b.offset); seen.add(j);
  }
  for (const j of JOINT_NAMES) if (!seen.has(j)) throw new Error(`${at}#/body/bones: the titan needs a bone "${boneOf(j)}"`);
  const shapes: ShapeData[] = [];
  (c.hits ?? []).forEach((h, i) => {
    const joint = JOINT_OF[h.bone];
    if (!joint) throw new Error(`${at}#/hits/${i}/bone: "${h.bone}" is not a titan bone`);
    const s: ShapeData = { part: h.part as ShapePart, joint, group: h.group as ShapeGroup, collide: h.collide !== false, type: h.shape };
    if (h.shape === 'capsule') { if (!h.a || !h.b || h.r === undefined) throw new Error(`${at}#/hits/${i}: a capsule needs a, b and r`); s.a = fromConfig(h.a); s.b = fromConfig(h.b); s.r = h.r; }
    else if (h.shape === 'sphere') { if (!h.c || h.r === undefined) throw new Error(`${at}#/hits/${i}: a sphere needs c and r`); s.c = fromConfig(h.c); s.r = h.r; }
    else { if (!h.c || !h.h) throw new Error(`${at}#/hits/${i}: a box needs c and h`); s.c = fromConfig(h.c); s.h = [h.h[0], h.h[1], h.h[2]]; }
    shapes.push(s);
  });
  return { joints, parent: PARENT, shapes };
}

// Rigs follow their config file while the game runs: one watcher per file, holding its rigs weakly.
const live = new Map<string, { rigs: Set<WeakRef<Rig>>; dims: Dims }>();
function follow(rig: Rig, d: Dims): void {
  const id = `character/${rigConfigId(d)}`;
  let e = live.get(id);
  if (!e) {
    const entry = { rigs: new Set<WeakRef<Rig>>(), dims: d };
    e = entry;
    live.set(id, entry);
    config.watch(id, () => {
      let data: RigData;
      try { data = rigDataFor(entry.dims); } catch (err) { console.warn(String(err)); return; }
      for (const ref of [...entry.rigs]) {
        const r = ref.deref();
        if (!r) { entry.rigs.delete(ref); continue; }
        applyData(r, data, entry.dims);
      }
    });
  }
  e.rigs.add(new WeakRef(rig));
}

/** Writes joint offsets and shapes into a rig; the shape list keeps its identity so readers see the change at once. */
function applyData(rig: Rig, data: RigData, d: Dims): void {
  for (const j of JOINT_NAMES) rig.J[j].position.set(...data.joints[j]);
  rig.shapes.length = 0;
  const v = (t: V3T): THREE.Vector3 => new V3(t[0], t[1], t[2]);
  const gen = 1 + 0.6 * (1 - Math.min(1, rig.height / 10));
  const R = d.headR;
  for (const s of data.shapes) {
    const base = { part: s.part, joint: rig.J[s.joint], collide: s.collide, group: s.group };
    if (s.type === 'capsule') rig.shapes.push({ ...base, type: 'capsule', a: v(s.a!), b: v(s.b!), r: s.r! });
    else if (s.type === 'sphere') rig.shapes.push({ ...base, type: 'sphere', c: v(s.c!), r: s.part === 'eye' ? Math.max(s.r!, (rig.eyeFactor ?? 0) * R * 1.5) : s.r! });
    else rig.shapes.push({ ...base, type: 'box', c: v(s.c!), h: s.part === 'nape' ? v(s.h!).multiplyScalar(gen * (d.size === 'XL' ? 1.15 : 1)) : v(s.h!) });
  }
}

/** `material`: the titan's own (tinted) body material; defaults to the archetype's shared one. */
export function buildRig(arch: Archetype, height: number, material: THREE.Material = arch.material): Rig {
  const d = arch.dims, geo = arch.geo;
  const root = new THREE.Group();
  root.name = 'titan';
  const J = {} as Joints;
  for (const name of JOINT_NAMES) {
    const g = new THREE.Object3D(); g.name = name; J[name] = g;
  }
  for (const name of JOINT_NAMES) { const p = PARENT[name]; (p ? J[p] : root).add(J[name]); }
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
  const rig: Rig = { root, J, meshes, shapes: [], scale, height, eyeFactor: arch.st.eye };
  applyData(rig, rigDataFor(d), d);
  follow(rig, d);
  return rig;
}
