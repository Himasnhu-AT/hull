// Collision and physics: shapes, a broadphase, raycasts and sphere casts, overlaps, a character mover, rope
// constraints and simple rigid bodies. Runs in Node: no DOM, no real time, no Math.random.
export { Collider, Body, usePhysics, physicsOf } from './behaviours.ts';
export { Physics } from './world.ts';
export type { PhysicsOptions } from './world.ts';
export { Rope } from './rope.ts';
export { Shape } from './shape.ts';
export { Hit, MoveResult, LAYER_ALL } from './types.ts';
export type { ShapeDesc, ShapeOptions, QueryFilter, MoveOptions, Contact, Vec3Like, Vec3Tuple } from './types.ts';
export { slideMove } from './mover.ts';
export { debugShapes } from './debug.ts';
