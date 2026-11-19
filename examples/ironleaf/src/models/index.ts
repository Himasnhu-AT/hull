// The modelled bodies of Ironleaf. A body is built out of low-poly parts (see kit.ts) that ride the bones of the
// character's skeleton, so the clips and the state graph that drive the config's own stand-in drive this too. Two ways
// in: `Dress` (a behaviour on the node that holds the Animator, for the game) and `dressOn` (any Object3D bones, for the
// Studio's character bench and for tests). Bodies are built from the skeleton's own dimensions, so each one fits its
// character config, and every weapon lies where the config's sockets say.
import * as THREE from 'hull/three';
import { Behaviour, type Node } from 'hull';
import { Animator } from 'hull/anim';
import type { HumanoidDims, Skeleton } from 'hull/anim';
import { Builder, type V3 } from './kit';
import { build as aya } from './aya';
import { ashblade, ashpike, hulk, ashkite } from './raiders';
import { kagari } from './kagari';

export const KINDS = ['aya', 'ashblade', 'ashpike', 'hulk', 'ashkite', 'kagari'] as const;
export type Kind = (typeof KINDS)[number];

/** What a body builder is given. */
export interface Ctx {
  b: Builder;
  d: HumanoidDims;
  /** Rest offset of a bone from its parent (undefined if the skeleton has no such bone). */
  rest(name: string): V3 | undefined;
}

/** What a body builder hands back: the thing held in the hand (its own group so it can be swapped) and where it goes. */
export interface Built {
  sword: THREE.Object3D;
  hand: string;
  /** Aya only: where the sword rides when it is sheathed (a bone and a transform in that bone's space). */
  hip?: string;
  sheathedQ?: THREE.Quaternion;
  sheathedP?: THREE.Vector3;
  /** Other things that ride a bone (the archer's arrow). */
  extra?: { obj: THREE.Object3D; bone: string; pos: V3 }[];
}

const BUILDERS: Record<Kind, (c: Ctx) => Built> = { aya, ashblade, ashpike, hulk, ashkite, kagari };

export const isKind = (s: string): s is Kind => (KINDS as readonly string[]).includes(s);

/** 'character/ashblade' or 'ashblade' to the kind, or undefined for a character this module does not model. */
export function kindOf(character: string): Kind | undefined {
  const id = character.replace(/^character\//, '');
  return isKind(id) ? id : undefined;
}

/** A modelled body on a set of bones. Dispose it to take it off. */
export class Body {
  readonly sword: THREE.Object3D;
  private readonly built: Built;
  private readonly builder: Builder;
  private readonly boneOf: (n: string) => THREE.Object3D | undefined;
  private _sheathed = false;
  /** Number of meshes this body made (draw calls, before shadows). */
  meshes = 0;

  constructor(readonly kind: Kind, skeleton: Skeleton, boneOf: (n: string) => THREE.Object3D | undefined) {
    const d = skeleton.dims;
    if (!d) throw new Error('a modelled body needs a humanoid skeleton');
    this.boneOf = boneOf;
    this.builder = new Builder(boneOf, 'ironleafBody');
    const rest = (n: string): V3 | undefined => {
      const i = skeleton.index(n);
      return i < 0 ? undefined : [skeleton.rest[i * 3]!, skeleton.rest[i * 3 + 1]!, skeleton.rest[i * 3 + 2]!];
    };
    this.built = BUILDERS[kind]({ b: this.builder, d, rest });
    this.sword = this.built.sword;
    this.builder.build();
    boneOf(this.built.hand)?.add(this.sword);
    for (const x of this.built.extra ?? []) { x.obj.position.set(x.pos[0], x.pos[1], x.pos[2]); boneOf(x.bone)?.add(x.obj); }
    this.count();
  }

  private count(): void {
    let n = 0;
    const seen = new Set<THREE.Object3D>();
    const walk = (o: THREE.Object3D | undefined): void => { if (!o || seen.has(o)) return; seen.add(o); o.traverse((c) => { if ((c as THREE.Mesh).isMesh && c.userData['ironleafBody']) n++; }); };
    for (const k of ['hips']) walk(this.boneOf(k));
    this.meshes = n;
  }

  /** Aya's katana in the scabbard (true) or in her hand (false). Other bodies ignore it. */
  get sheathed(): boolean { return this._sheathed; }
  set sheathed(v: boolean) {
    const b = this.built;
    if (!b.hip || !b.sheathedQ || !b.sheathedP || v === this._sheathed) return;
    this._sheathed = v;
    const to = this.boneOf(v ? b.hip : b.hand);
    if (!to) return;
    to.add(this.sword);
    if (v) { this.sword.position.copy(b.sheathedP); this.sword.quaternion.copy(b.sheathedQ); } else { this.sword.position.set(0, 0, 0); this.sword.quaternion.identity(); }
  }

  dispose(): void {
    this.sword.removeFromParent();
    for (const x of this.built.extra ?? []) x.obj.removeFromParent();
    this.builder.dispose();
  }
}

/**
 * Draws the modelled body of `kind` on the animator's bones and hides its rigid stand-in. It follows the animator when its
 * files change (the bones are rebuilt then). Put it on the same node as the Animator, after it.
 */
export class Dress extends Behaviour {
  kind = '';
  /** Aya's katana: true puts it in the scabbard. */
  sheathed = false;
  private body: Body | null = null;
  private seen: THREE.Object3D | undefined;
  private animator: Animator | undefined;

  override ready(): void {
    this.animator = this.node.get(Animator) ?? undefined;
    this.refresh();
  }

  override update(): void {
    this.refresh();
    if (this.body) this.body.sheathed = this.sheathed;
  }

  override dispose(): void {
    this.body?.dispose();
    this.body = null;
  }

  /** The body this behaviour draws, once the animator has built its skeleton. */
  get current(): Body | null { return this.body; }

  private refresh(): void {
    const a = this.animator;
    if (!a || !a.skeleton || !isKind(this.kind)) return;
    const root = a.bone('hips');
    if (!root) return;
    if (root === this.seen && this.body) return;
    this.body?.dispose();
    this.seen = root;
    // The animator rebuilt its bones: draw again, and keep its stand-in out of sight.
    for (const n of a.skeleton.names) for (const c of a.bone(n)?.children ?? []) if ((c as THREE.Mesh).isMesh && !c.userData['ironleafBody']) c.visible = false;
    this.body = new Body(this.kind, a.skeleton, (n) => a.bone(n));
  }
}

/** Dresses the 'model' child of a fighter node (the one the combat kit's spawn makes) as `kind`. */
export function dressFighter(fighter: Node, kind: Kind): Dress | undefined {
  const model = fighter.children.find((c) => c.name === 'model');
  return model ? model.add(Dress, { kind }) : undefined;
}
