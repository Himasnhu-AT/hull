// glTF bodies: a skinned model whose bones the Animator drives. The engine's skeleton is the model's skin (every joint,
// parents first); a joint the character's `joints` table names takes the engine's name ("hips"), the others keep the
// model's. A pose is a change on top of the bone's rest, so a keyframe clip written for the engine's joints plays on a
// model, and a model's own animation is turned into the same kind of change (its rotation times the inverse of the
// bone's rest) and blends with everything else.
import { Object3D, Box3, Vector3, type AnimationClip, type KeyframeTrack } from 'three';
import type { Character } from '../schema/character.ts';
import { instantiate, loadedModel } from '../render/gltf.ts';
import type { BodyView, Branch } from './body.ts';
import { qMul, qNlerp } from './math.ts';
import { REF_HEIGHT, Skeleton, type Pose } from './skeleton.ts';

/** Thrown by a build when the model has not been read yet; the caller loads it and builds again. */
export class ModelPending extends Error {
  constructor(readonly file: string) {
    super(`the model "${file}" is still loading`);
  }
}

/** What the Animator needs of a glTF body besides the skeleton. */
export interface GltfBody {
  readonly file: string;
  readonly skeleton: Skeleton;
  /** The cloned scene: put it under the character's node. */
  readonly root: Object3D;
  /** One Object3D per skeleton bone, in skeleton order. */
  readonly bones: Object3D[];
  /** Each bone's name as the model's animation tracks write it (three's cleaned-up node name). */
  readonly trackNames: readonly string[];
  readonly animations: readonly AnimationClip[];
}

const nameOf = (o: Object3D): string => (o.userData['name'] as string | undefined) ?? o.name;

/** Builds the skeleton and the scene copy. Throws a sentence naming `at` (a place like 'character/hero#/body') for a bad file or joints table. */
export function buildGltfBody(body: Character['body'], at: string): GltfBody {
  const file = body.file;
  if (file === undefined || file === '') throw new Error(`${at}/file: a glTF body needs \`file\`, a path inside assets/`);
  const model = loadedModel(file);
  if (!model) throw new ModelPending(file);
  const root = instantiate(model);
  root.updateWorldMatrix(true, true);

  // The bones: every joint of every skin, in scene order (parents come before children).
  const isBone = new Set<Object3D>();
  root.traverse((o) => {
    const sm = o as unknown as { isSkinnedMesh?: boolean; skeleton?: { bones: Object3D[] } };
    if (sm.isSkinnedMesh && sm.skeleton) for (const b of sm.skeleton.bones) isBone.add(b);
  });
  if (isBone.size === 0) throw new Error(`${at}/file: "${file}" has no skin (no joints), so it cannot be a character body; use a Model for a static model`);
  const bones: Object3D[] = [];
  root.traverse((o) => { if (isBone.has(o)) bones.push(o); });

  // Meshes follow bones that move; the bind-pose bounds would cut them off.
  root.traverse((o) => { if ((o as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) o.frustumCulled = false; });

  const byModelName = new Map<string, number>();
  bones.forEach((b, i) => { byModelName.set(nameOf(b), i); byModelName.set(b.name, i); });
  const names = bones.map((b) => nameOf(b));
  const taken = new Map<string, string>();
  for (const [engine, modelName] of Object.entries(body.joints ?? {})) {
    const i = byModelName.get(modelName);
    if (i === undefined) {
      const have = bones.map(nameOf);
      throw new Error(`${at}/joints/${engine}: the model "${file}" has no joint "${modelName}" (its joints: ${have.slice(0, 10).join(', ')}${have.length > 10 ? ', ...' : ''})`);
    }
    const prior = taken.get(modelName);
    if (prior !== undefined) throw new Error(`${at}/joints/${engine}: the model joint "${modelName}" is already "${prior}"; a joint has one engine name`);
    taken.set(modelName, engine);
    names[i] = engine;
  }
  const seen = new Set<string>();
  names.forEach((n, i) => {
    if (seen.has(n)) throw new Error(`${at}/joints: two joints are called "${n}" (model joint "${nameOf(bones[i]!)}"); rename the mapping so each name is used once`);
    seen.add(n);
  });

  const index = new Map<Object3D, number>();
  bones.forEach((b, i) => index.set(b, i));
  const parent = bones.map((b) => {
    for (let p = b.parent; p; p = p.parent) { const k = index.get(p); if (k !== undefined) return k; }
    return -1;
  });
  const rest: number[] = [];
  for (const b of bones) rest.push(b.position.x, b.position.y, b.position.z);

  // Clip offsets are written for a 1.78 m body; scale them by the model's height (in its own units).
  const box = new Box3().setFromObject(root, true);
  const size = box.getSize(new Vector3());
  const height = size.y > 1e-6 ? size.y : REF_HEIGHT;
  const sk = new Skeleton(names, parent, rest, height / REF_HEIGHT, null);
  const rq = new Float64Array(bones.length * 4);
  bones.forEach((b, i) => { rq[i * 4] = b.quaternion.x; rq[i * 4 + 1] = b.quaternion.y; rq[i * 4 + 2] = b.quaternion.z; rq[i * 4 + 3] = b.quaternion.w; });
  sk.restRot = rq;
  root.scale.multiplyScalar(body.scale ?? 1);
  return { file, skeleton: sk, root, bones, trackNames: bones.map((b) => b.name), animations: model.animations };
}

/** Draws a glTF body: writes the pose into the model's own bones. */
export class GltfBodyView implements BodyView {
  readonly bones: Object3D[];
  /** Nothing of a skinned model is cut off. */
  readonly gone: Uint8Array;
  private readonly sk: Skeleton;
  private readonly q = new Float64Array(4);

  constructor(readonly parent: Object3D, private readonly data: GltfBody) {
    this.bones = data.bones;
    this.sk = data.skeleton;
    this.gone = new Uint8Array(this.sk.n);
    parent.add(data.root);
  }

  apply(pose: Pose): void {
    const sk = this.sk, rq = sk.restRot!, q = this.q;
    for (let i = 0; i < sk.n; i++) {
      const o = this.bones[i]!;
      o.position.set(sk.rest[i * 3]! + pose.off[i * 3]!, sk.rest[i * 3 + 1]! + pose.off[i * 3 + 1]!, sk.rest[i * 3 + 2]! + pose.off[i * 3 + 2]!);
      qMul(q, 0, rq, i * 4, pose.rot, i * 4);
      o.quaternion.set(q[0]!, q[1]!, q[2]!, q[3]!);
    }
  }

  /** A skinned mesh is one piece of cloth over all its bones; there is nothing to cut off. */
  cut(_bone: number): Branch | null {
    return null;
  }

  dispose(): void {
    this.data.root.removeFromParent();
  }
}

// ---- clips ----

interface GTrack {
  bone: number;
  /** Key times in seconds. */
  t: Float64Array;
  /** Rotation keys (change from rest, x y z w) or position keys (change from rest, x y z). */
  v: Float64Array;
  step: boolean;
}

export interface GltfClipData {
  length: number;
  rot: GTrack[];
  pos: GTrack[];
  /** How many tracks of the animation drove a joint of the body. */
  matched: number;
  /** How many drove something else (the armature node, morph targets, scale). */
  ignored: number;
}

const _iq = new Float64Array(4);
const _kq = new Float64Array(4);

/** Reads one of the model's animations into tracks over the body's bones. Rotation keys become changes from rest. */
export function readGltfClip(anim: AnimationClip, body: GltfBody): GltfClipData {
  const sk = body.skeleton;
  const byTrack = new Map<string, number>();
  body.trackNames.forEach((n, i) => byTrack.set(n, i));
  const out: GltfClipData = { length: anim.duration, rot: [], pos: [], matched: 0, ignored: 0 };
  for (const tr of anim.tracks as KeyframeTrack[]) {
    const dot = tr.name.lastIndexOf('.');
    const node = dot < 0 ? tr.name : tr.name.slice(0, dot);
    const prop = dot < 0 ? '' : tr.name.slice(dot + 1);
    const bone = byTrack.get(node);
    if (bone === undefined || (prop !== 'quaternion' && prop !== 'position')) { out.ignored++; continue; }
    const width = prop === 'quaternion' ? 4 : 3;
    const cubic = (tr as unknown as { createInterpolant?: { isInterpolantFactoryMethodGLTFCubicSpline?: boolean } }).createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline === true;
    const n = tr.times.length;
    const t = new Float64Array(n), v = new Float64Array(n * width);
    for (let k = 0; k < n; k++) {
      t[k] = tr.times[k]!;
      // A cubic-spline track holds an in-tangent, the value and an out-tangent per key; the curve is read through its values.
      const at = (cubic ? k * 3 + 1 : k) * width;
      if (prop === 'quaternion') {
        _kq[0] = tr.values[at]!; _kq[1] = tr.values[at + 1]!; _kq[2] = tr.values[at + 2]!; _kq[3] = tr.values[at + 3]!;
        _iq[0] = -sk.restRot![bone * 4]!; _iq[1] = -sk.restRot![bone * 4 + 1]!; _iq[2] = -sk.restRot![bone * 4 + 2]!; _iq[3] = sk.restRot![bone * 4 + 3]!;
        qMul(v, k * 4, _iq, 0, _kq, 0);
      } else {
        v[k * 3] = tr.values[at]! - sk.rest[bone * 3]!;
        v[k * 3 + 1] = tr.values[at + 1]! - sk.rest[bone * 3 + 1]!;
        v[k * 3 + 2] = tr.values[at + 2]! - sk.rest[bone * 3 + 2]!;
      }
    }
    const g: GTrack = { bone, t, v, step: tr.getInterpolation() === 2300 };
    (prop === 'quaternion' ? out.rot : out.pos).push(g);
    out.matched++;
  }
  return out;
}

/** Index i such that t[i] <= x < t[i + 1], clamped to the ends. */
function seg(t: Float64Array, x: number): number {
  let lo = 0, hi = t.length - 1;
  if (x <= t[0]!) return 0;
  if (x >= t[hi]!) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! <= x) lo = mid; else hi = mid;
  }
  return lo;
}

/** Writes the clip at time tt (already wrapped or clamped) into a pose. Allocates nothing. */
export function sampleGltfClip(d: GltfClipData, tt: number, pose: Pose): void {
  for (let i = 0; i < d.rot.length; i++) {
    const tr = d.rot[i]!;
    const n = tr.t.length;
    if (n === 0) continue;
    const a = seg(tr.t, tt);
    const b = a + 1 < n ? a + 1 : a;
    const span = tr.t[b]! - tr.t[a]!;
    const f = tr.step || span <= 0 ? 0 : Math.min(1, Math.max(0, (tt - tr.t[a]!) / span));
    qNlerp(pose.rot, tr.bone * 4, tr.v, a * 4, tr.v, b * 4, f);
    pose.cov[tr.bone] = 1;
  }
  for (let i = 0; i < d.pos.length; i++) {
    const tr = d.pos[i]!;
    const n = tr.t.length;
    if (n === 0) continue;
    const a = seg(tr.t, tt);
    const b = a + 1 < n ? a + 1 : a;
    const span = tr.t[b]! - tr.t[a]!;
    const f = tr.step || span <= 0 ? 0 : Math.min(1, Math.max(0, (tt - tr.t[a]!) / span));
    for (let k = 0; k < 3; k++) pose.off[tr.bone * 3 + k] = tr.v[a * 3 + k]! + (tr.v[b * 3 + k]! - tr.v[a * 3 + k]!) * f;
    pose.cov[tr.bone] = 1;
  }
}
