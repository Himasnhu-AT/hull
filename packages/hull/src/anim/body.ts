// The drawn body: one Object3D per bone (parented in the skeleton's tree under the character's node) and, under
// each, the shaped parts that bone carries. Parts are rigid, not skinned: a limb is a tapered capsule that turns with
// its bone, which is what a stylised procedural body needs and is cheap enough for crowds.
import { BoxGeometry, LatheGeometry, Mesh as ThreeMesh, Object3D, SphereGeometry, Vector2, Vector3, type BufferGeometry, type Material } from 'three';
import type { Character, CharacterPart } from '../schema/character.ts';
import { acquireMaterial, releaseMaterial, type MaterialSpec } from '../render/materials.ts';
import type { Pose, Skeleton } from './skeleton.ts';

const ROLE_COLOURS: Record<string, string> = { skin: '#d9b99b', cloth: '#5b6b4f', metal: '#8c9199', boots: '#3b3029' };

interface GeoEntry { geometry: BufferGeometry; refs: number }
const geos = new Map<string, GeoEntry>();

function acquireGeo(key: string, make: () => BufferGeometry): BufferGeometry {
  let e = geos.get(key);
  if (!e) { e = { geometry: make(), refs: 0 }; geos.set(key, e); }
  e.refs++;
  return e.geometry;
}
function releaseGeo(key: string): void {
  const e = geos.get(key);
  if (!e || --e.refs > 0) return;
  e.geometry.dispose();
  geos.delete(key);
}

/** A capsule that is r0 wide at y = 0 and r1 wide at y = len, with round ends, built by spinning a profile around Y. */
function limbGeometry(len: number, r0: number, r1: number): BufferGeometry {
  const pts: Vector2[] = [];
  const steps = 5;
  pts.push(new Vector2(0, -r0));
  for (let i = 1; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * (Math.PI / 2);
    pts.push(new Vector2(r0 * Math.cos(a), r0 * Math.sin(a)));
  }
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    pts.push(new Vector2(r1 * Math.cos(a), len + r1 * Math.sin(a)));
  }
  return new LatheGeometry(pts, 14);
}

const f = (n: number): string => n.toFixed(4);

interface PartRec { bone: number; mesh: ThreeMesh; release: () => void }

/** What a cut-off branch hands to the node that carries it: the objects and the way to let go of what they share. */
export interface Branch { object: Object3D; release: (() => void)[] }

/** What the Animator needs of a drawn body: rigid parts on generated bones (Body) or a skinned model (GltfBodyView). */
export interface BodyView {
  readonly bones: Object3D[];
  /** 1 for a bone whose Object3D now belongs to a cut-off branch. */
  readonly gone: Uint8Array;
  apply(pose: Pose): void;
  cut(bone: number): Branch | null;
  dispose(): void;
}

export class Body implements BodyView {
  readonly bones: Object3D[] = [];
  /** 1 for a bone whose Object3D now belongs to a cut-off branch. */
  readonly gone: Uint8Array;
  private readonly parts: PartRec[] = [];

  constructor(readonly parent: Object3D, readonly skeleton: Skeleton, parts: readonly CharacterPart[], mats: Character['materials'], severed: ReadonlySet<string>) {
    const sk = skeleton;
    this.gone = new Uint8Array(sk.n);
    const cut = new Uint8Array(sk.n);
    for (const nm of severed) sk.subtree(nm, cut);
    for (let i = 0; i < sk.n; i++) {
      const o = new Object3D();
      o.name = sk.names[i]!;
      o.position.set(sk.rest[i * 3]!, sk.rest[i * 3 + 1]!, sk.rest[i * 3 + 2]!);
      const p = sk.parent[i]!;
      (p < 0 ? parent : this.bones[p]!).add(o);
      this.bones.push(o);
    }
    for (const part of parts) {
      const bi = sk.index(part.bone);
      if (bi < 0 || cut[bi] === 1) continue;
      this.parts.push(this.makePart(bi, part, mats));
    }
  }

  private makePart(bone: number, p: CharacterPart, mats: Character['materials']): PartRec {
    const key = p.material;
    const id = key !== undefined ? mats?.[key] : undefined;
    const spec: MaterialSpec = id ? { material: id } : { color: p.color ?? (key !== undefined ? ROLE_COLOURS[key] : undefined) ?? '#cccccc' };
    const material: Material = acquireMaterial(spec);
    let gk: string;
    let geometry: BufferGeometry;
    let mesh: ThreeMesh;
    if (p.shape === 'limb') {
      const from = p.from ?? [0, 0, 0], to = p.to ?? [0, -0.3, 0];
      const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
      const len = Math.hypot(dx, dy, dz);
      const r0 = p.radius ?? 0.05, r1 = p.radiusEnd ?? r0;
      gk = `limb:${f(len)}:${f(r0)}:${f(r1)}`;
      geometry = acquireGeo(gk, () => limbGeometry(len, r0, r1));
      mesh = new ThreeMesh(geometry, material);
      mesh.position.set(from[0], from[1], from[2]);
      // The profile runs along +Y; turn it to run from `from` to `to`.
      const ux = dx / (len || 1), uy = dy / (len || 1), uz = dz / (len || 1);
      mesh.quaternion.setFromUnitVectors(_up.set(0, 1, 0), _dir.set(ux, uy, uz));
    } else if (p.shape === 'box') {
      gk = 'box';
      geometry = acquireGeo(gk, () => new BoxGeometry(1, 1, 1));
      mesh = new ThreeMesh(geometry, material);
      const c = p.center ?? [0, 0, 0], s = p.size ?? [0.1, 0.1, 0.1];
      mesh.position.set(c[0], c[1], c[2]);
      mesh.scale.set(s[0], s[1], s[2]);
    } else {
      gk = 'sphere';
      geometry = acquireGeo(gk, () => new SphereGeometry(0.5, 20, 14));
      mesh = new ThreeMesh(geometry, material);
      const c = p.center ?? [0, 0, 0];
      const r = p.radius !== undefined ? p.radius * 2 : undefined;
      const s = p.size ?? [r ?? 0.1, r ?? 0.1, r ?? 0.1];
      mesh.position.set(c[0], c[1], c[2]);
      mesh.scale.set(s[0], s[1], s[2]);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.bones[bone]!.add(mesh);
    return { bone, mesh, release: () => { releaseGeo(gk); releaseMaterial(spec); } };
  }

  /** Writes a pose into the bone objects. */
  apply(pose: Pose): void {
    const sk = this.skeleton;
    for (let i = 0; i < sk.n; i++) {
      if (this.gone[i] === 1) continue;
      const o = this.bones[i]!;
      o.position.set(sk.rest[i * 3]! + pose.off[i * 3]!, sk.rest[i * 3 + 1]! + pose.off[i * 3 + 1]!, sk.rest[i * 3 + 2]! + pose.off[i * 3 + 2]!);
      o.quaternion.set(pose.rot[i * 4]!, pose.rot[i * 4 + 1]!, pose.rot[i * 4 + 2]!, pose.rot[i * 4 + 3]!);
    }
  }

  /**
   * Takes a bone and everything below it out of the body. The branch's Object3D keeps its current look; the caller
   * puts it on a node, sets that node's transform from `world`, and owns the release functions from then on.
   */
  cut(bone: number): Branch | null {
    if (this.gone[bone] === 1) return null;
    const sk = this.skeleton;
    const mask = sk.subtree(sk.names[bone]!);
    const release: (() => void)[] = [];
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const rec = this.parts[i]!;
      if (mask[rec.bone] === 1) { release.push(rec.release); this.parts.splice(i, 1); }
    }
    for (let i = 0; i < sk.n; i++) if (mask[i] === 1) this.gone[i] = 1;
    const object = this.bones[bone]!;
    object.removeFromParent();
    return { object, release };
  }

  dispose(): void {
    for (const rec of this.parts) { rec.mesh.removeFromParent(); rec.release(); }
    this.parts.length = 0;
    // Bones that were cut off belong to their branch now.
    for (let i = 0; i < this.skeleton.n; i++) if (this.gone[i] === 0 && this.skeleton.parent[i]! < 0) this.bones[i]!.removeFromParent();
  }
}

const _up = new Vector3();
const _dir = new Vector3();
