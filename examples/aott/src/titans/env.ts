// The parts of the rest of the game a titan touches, described by what it calls. These are duck-typed boundaries
// (the soldier, comrades, horses, the escort, the collision world): the titan code checks for optional methods at
// runtime, so it only relies on the members listed here.
import type * as THREE from 'hull/three';
import type { RigShape } from './rig';

/** A collision shape as the titan registers / reads it (core/collision.ts). */
export interface TitanCollider {
  type?: string;
  material?: string;
  userData: { titan?: unknown; part?: string; sub?: string; [k: string]: unknown };
  /** the rig shape this collider was made from (set by Titan._registerColliders) */
  _shape?: RigShape;
}

export interface Contact { normal: THREE.Vector3; depth: number; collider: { type?: string; material?: string } }

interface ShapeOpts { object3D: THREE.Object3D; dynamic: boolean; material: string; userData: TitanCollider['userData'] }

export interface TitanCollision {
  groundHeight?(x: number, z: number): number;
  addCapsule?(o: ShapeOpts & { a: THREE.Vector3; b: THREE.Vector3; radius: number }): TitanCollider;
  addSphere?(o: ShapeOpts & { center: THREE.Vector3; radius: number }): TitanCollider;
  addBox?(o: ShapeOpts & { center: THREE.Vector3; halfExtents: THREE.Vector3 }): TitanCollider;
  remove?(c: TitanCollider): void;
  collideSphere?(center: THREE.Vector3, radius: number, opts?: { dynamic?: boolean }): Contact[];
}

/** One of the soldier's two grapple wires (player/odm.ts Hook). */
export interface PreyHook {
  side: number;
  attached: boolean;
  anchor: THREE.Vector3;
  length: number;
  collider?: { userData?: { titan?: unknown } } | null;
  /** the titan hauling on this wire, and with which hand */
  yank?: unknown;
  yankSide?: number;
  payout?: number;
}

export interface PreyHorse {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  speed: number;
  crashed: number;
  rider: { dismount?(): void } | null;
  hit(strength?: number): void;
}

/** The player's soldier, as a titan sees it (player/player.ts). */
export interface Prey {
  alive: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  render?: THREE.Vector3;
  grabbedBy: unknown;
  grabImmune?: number;
  /** the target the soldier is swooping on */
  prey?: unknown;
  riding?: PreyHorse | null;
  odm?: { hooks: PreyHook[]; release(side: number): void };
  cam?: { trauma: number };
  grab?(titan: unknown, hand: THREE.Object3D): boolean;
  release?(): void;
  eaten?(titan: unknown): void;
  /** damage on a 0-100 scale */
  applyImpulse?(v: THREE.Vector3, damage?: number): void;
}

/** An AI comrade (player/ally.ts). */
export interface Comrade {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  grabbedBy: unknown;
  horse: unknown;
  job: { titan?: unknown } | null;
  grab(titan: unknown, hand: THREE.Object3D): void;
  freed(titan: unknown): void;
  eaten(titan: unknown): void;
}

/** What a quarry is, to a titan's taste. */
export type QuarryKind = 'ally' | 'civilian' | 'horse';

/**
 * Any living thing a titan may go for besides the player's soldier: a comrade, a civilian (npc/civilians.ts), a
 * horse. It is caught through the same reach-and-grab a comrade is (grab / freed / eaten).
 */
export interface Quarry extends Comrade {
  /** unset: a comrade */
  quarryKind?: QuarryKind;
  /** false: out of a titan's reach for now (carried by a soldier, already safe) */
  catchable?: boolean;
}

/**
 * A titan's temperament. dull: slow-witted, short-sighted, easily distracted, loses interest and never guards its
 * nape; plain: goes for the nearest living thing; keen: sharp-eyed, sticks to its prey, turns on whoever cut it and
 * covers its nape; glutton: wants the easy meal on the ground (civilians, horses) and ignores fast flyers; wild:
 * an abnormal's whims.
 */
export type Temper = 'dull' | 'plain' | 'keen' | 'glutton' | 'wild';

/** Something normal titans are drawn to and maul (the escorted shifter, or a bound shifter in a mission). */
export interface MaulTarget {
  position: THREE.Vector3;
  footR: number;
  vulnerable: boolean;
  hurt(damage: number, by: unknown): void;
  _headWorld(out: THREE.Vector3): THREE.Vector3;
  _jpos(name: string, out: THREE.Vector3): THREE.Vector3;
}
