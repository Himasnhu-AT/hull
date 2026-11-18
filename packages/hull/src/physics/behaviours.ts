// The behaviours games add to nodes, and `usePhysics`, which installs the system on a world.
import { Behaviour } from '../core/index.ts';
import type { World } from '../core/index.ts';
import { slideMove } from './mover.ts';
import { RigidBody } from './rigid.ts';
import type { Shape } from './shape.ts';
import { K } from './shape.ts';
import type { MoveOptions, ShapeDesc } from './types.ts';
import { LAYER_ALL, MoveResult } from './types.ts';
import { Physics } from './world.ts';
import type { PhysicsOptions } from './world.ts';

const worlds = new WeakMap<World, Physics>();

/** Installs physics on a world: a `physics` system that steps rigid bodies each fixed step. Call it once, in `ready`. */
export function usePhysics(world: World, opts: PhysicsOptions = {}): Physics {
  const existing = worlds.get(world);
  if (existing !== undefined) throw new Error('physics: usePhysics(world) was already called for this world');
  const p = new Physics(world, opts);
  worlds.set(world, p);
  world.system('physics', { fixedUpdate: (dt) => p.step(dt) });
  return p;
}

/** The world's physics, from `usePhysics`. */
export function physicsOf(world: World): Physics {
  const p = worlds.get(world);
  if (p === undefined) throw new Error('physics: call usePhysics(world) in ready() before adding Collider or Body');
  return p;
}

/**
 * A collision shape on a node. It moves with the node (a bone of an animated character works), or, with
 * `static = true`, is placed once and never again, which is the cheap way to add a building.
 */
export class Collider extends Behaviour {
  shape: ShapeDesc = { type: 'sphere', radius: 0.5 };
  layer = 1;
  mask = LAYER_ALL;
  /** 'nape', 'limb:left-arm'. */
  tag = '';
  trigger = false;
  static = false;
  userData: unknown = undefined;
  /** The shape in the physics world: read `tag`, `layer`, `enabled`; query with it as `ignoreShape`. */
  solid!: Shape;
  /** Filled by `move`; reuse it between calls. */
  readonly result = new MoveResult();
  private phys!: Physics;

  override ready(): void {
    this.phys = physicsOf(this.world);
    this.solid = this.phys.add(this.shape, {
      layer: this.layer, mask: this.mask, tag: this.tag, trigger: this.trigger,
      static: this.static, follow: this.node.object3d, node: this.node, userData: this.userData,
    });
  }

  get enabled(): boolean {
    return this.solid.enabled;
  }
  set enabled(v: boolean) {
    this.solid.enabled = v;
  }

  /**
   * Slides this node by `velocity * dt` against the world and writes the new position to the node. The collider
   * must be a sphere or a vertical capsule, and the node a child of the root (its position is the world
   * position). Returns the Collider's own result (also in `this.result`): contacts, grounded, slid velocity.
   */
  move(velocity: { x: number; y: number; z: number }, dt: number, opts?: MoveOptions): MoveResult {
    const s = this.solid;
    let y0: number, y1: number, r: number;
    if (s.kind === K.sphere) { y0 = y1 = s.lcy; r = s.lr; }
    else if (s.kind === K.capsule) { y0 = Math.min(s.lay, s.lby); y1 = Math.max(s.lay, s.lby); r = s.lr; }
    else throw new Error(`physics: move needs a sphere or capsule collider on node "${this.node.name}"`);
    const o = opts ?? {};
    // A mover never collides with itself.
    const own: MoveOptions = o.ignoreShape === undefined ? { ...o, ignoreShape: s } : o;
    slideMove(this.phys, this.node.position, y0, y1, r, velocity, dt, own, this.result);
    s.syncFollow();
    return this.result;
  }

  override dispose(): void {
    this.phys.remove(this.solid);
  }
}

/**
 * A rigid body: falls, tumbles and settles. The node must be a child of the root. Its Collider (a sphere or a
 * box) is made from `shape` if the node has none. Move a body with `teleport`, not by setting the node's position.
 */
export class Body extends Behaviour {
  static override state = ['vx', 'vy', 'vz', 'wx', 'wy', 'wz', 'sleeping'];
  shape: ShapeDesc | undefined = undefined;
  mass = 1;
  restitution = 0.3;
  friction = 0.5;
  linearDamping = 0.01;
  angularDamping = 0.05;
  gravityScale = 1;
  rollingResistance = 1.5;
  layer = 1;
  mask = LAYER_ALL;
  tag = '';
  rb!: RigidBody;
  private phys!: Physics;

  override ready(): void {
    this.phys = physicsOf(this.world);
    let c = this.node.get(Collider);
    if (c === undefined) {
      if (this.shape === undefined) throw new Error(`physics: Body on node "${this.node.name}" needs a Collider or a shape`);
      c = this.node.add(Collider, { shape: this.shape, layer: this.layer, mask: this.mask, tag: this.tag });
    }
    this.rb = new RigidBody(c.solid, {
      mass: this.mass, restitution: this.restitution, friction: this.friction,
      linearDamping: this.linearDamping, angularDamping: this.angularDamping, gravityScale: this.gravityScale, rollingResistance: this.rollingResistance,
      node: this.node,
    });
    const q = this.node.object3d.quaternion;
    this.rb.setPose(this.node.position.x, this.node.position.y, this.node.position.z, q.x, q.y, q.z, q.w);
    this.phys.solver.add(this.rb);
  }

  get vx(): number { return this.rb.vx; }
  set vx(v: number) { this.rb.vx = v; }
  get vy(): number { return this.rb.vy; }
  set vy(v: number) { this.rb.vy = v; }
  get vz(): number { return this.rb.vz; }
  set vz(v: number) { this.rb.vz = v; }
  get wx(): number { return this.rb.wx; }
  set wx(v: number) { this.rb.wx = v; }
  get wy(): number { return this.rb.wy; }
  set wy(v: number) { this.rb.wy = v; }
  get wz(): number { return this.rb.wz; }
  set wz(v: number) { this.rb.wz = v; }
  get sleeping(): boolean { return this.rb.sleeping; }

  setVelocity(x: number, y: number, z: number): void {
    this.rb.vx = x; this.rb.vy = y; this.rb.vz = z;
    this.rb.wake();
  }

  applyImpulse(x: number, y: number, z: number): void {
    this.rb.applyImpulse(x, y, z);
  }

  teleport(x: number, y: number, z: number): void {
    const b = this.rb;
    b.setPose(x, y, z, b.qx, b.qy, b.qz, b.qw);
    this.node.position.set(x, y, z);
    b.wake();
  }

  override dispose(): void {
    this.phys.solver.remove(this.rb);
  }
}
