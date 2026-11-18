// Public types of the physics module. Plain data only: nothing here allocates per call.
import type { Object3D } from 'three';
import type { Node } from '../core/index.ts';
import type { Shape } from './shape.ts';

export interface Vec3Like { x: number; y: number; z: number }
export type Vec3Tuple = readonly [number, number, number];

/** Layers are bits: a shape is in `layer` (one or more bits) and a query hits shapes whose layer meets its `mask`. */
export const LAYER_ALL = 0xffffffff | 0;

export type ShapeDesc =
  | { type: 'sphere'; radius: number; center?: Vec3Tuple }
  /** Upright (local Y) when given `height`: the whole capsule is `height` tall. Or give the two end-cap centres `a` and `b`. */
  | { type: 'capsule'; radius: number; height?: number; center?: Vec3Tuple; a?: Vec3Tuple; b?: Vec3Tuple }
  /** `size` is the full extent on each local axis. Oriented by the owner's rotation. */
  | { type: 'box'; size: Vec3Tuple; center?: Vec3Tuple }
  /** Static only. Triangles are baked into world space when added. */
  | { type: 'mesh'; positions: ArrayLike<number>; indices?: ArrayLike<number> }
  /** Infinite flat ground: solid below `height`. */
  | { type: 'plane'; height: number }
  /** Static only. `heights` is rows x columns samples, x fastest; the field spans (columns-1)*cell by (rows-1)*cell from `origin`. */
  | { type: 'heightfield'; heights: ArrayLike<number>; columns: number; rows: number; cell: number; origin?: readonly [number, number]; baseY?: number; scale?: number };

export interface ShapeOptions {
  layer?: number;
  /** Layers this shape collides with when it moves or is a body. Default: all. */
  mask?: number;
  /** 'nape', 'limb:left-arm'. Queries can ask for one tag, or a prefix with a trailing `*`. */
  tag?: string;
  /** A trigger is only found by queries that ask for triggers. Movers pass through it. */
  trigger?: boolean;
  /** Static shapes are baked into the broadphase once. Default: static unless `follow` is given. */
  static?: boolean;
  /** The Object3D whose world matrix places this shape (a Node's `object3d`, or a bone). */
  follow?: Object3D;
  node?: Node;
  position?: Vec3Like;
  quaternion?: { x: number; y: number; z: number; w: number };
  userData?: unknown;
}

export interface QueryFilter {
  /** Hit shapes whose layer meets this. Default: all. */
  mask?: number;
  /** Exact tag, or a prefix when it ends in `*`. */
  tag?: string;
  ignoreShape?: Shape | null;
  ignoreNode?: Node | null;
  /** Also hit triggers. */
  triggers?: boolean;
}

/** What a cast fills in. The one the world owns is reused: copy what you need before the next query. */
export class Hit {
  distance = 0;
  /** Contact point on the surface hit. */
  x = 0; y = 0; z = 0;
  /** Unit surface normal, facing the caster. */
  nx = 0; ny = 0; nz = 0;
  shape: Shape | null = null;
  node: Node | null = null;
  tag = '';
  /** The cast started inside (or touching, for a sphere) the shape: distance is 0 and `depth` says how far in. */
  inside = false;
  depth = 0;
}

export interface Contact {
  nx: number; ny: number; nz: number;
  x: number; y: number; z: number;
  /** How fast the character was moving into the surface, m/s, before it was removed from the velocity. */
  speed: number;
  shape: Shape | null;
  node: Node | null;
  tag: string;
  /** The surface is walkable (within the slope limit). */
  walkable: boolean;
}

export interface MoveOptions {
  /** Layers the mover collides with. Default: all. */
  mask?: number;
  ignoreShape?: Shape | null;
  ignoreNode?: Node | null;
  /** Steepest walkable slope, degrees. Default 50. */
  slopeLimit?: number;
  /** Highest ledge walked up without a jump, m. Default 0 (off). */
  stepHeight?: number;
  /** How far to follow the ground down so a walker does not hop off slopes, m. Default 0.1. 0 turns snapping off. */
  snap?: number;
  /** Gap kept to surfaces, m. Default 0.01. */
  skin?: number;
}

export class MoveResult {
  /** Velocity left after sliding: the parts pushing into surfaces are gone. */
  vx = 0; vy = 0; vz = 0;
  grounded = false;
  groundNx = 0; groundNy = 1; groundNz = 0;
  groundShape: Shape | null = null;
  /** Distance travelled, m. */
  moved = 0;
  /** Number of valid entries in `contacts`. Pooled: valid until the next move with this result. */
  count = 0;
  readonly contacts: Contact[] = [];
  /** Highest `speed` among contacts: the landing or wall-hit strength. */
  maxSpeed = 0;
  /** Set if a step up a ledge was taken this move. */
  stepped = false;
}
