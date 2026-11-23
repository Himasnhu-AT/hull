import { Behaviour, signal, type Node, type World } from '../../core/index.ts';
import { Quaternion, Vector3 } from 'three';
import { num, tunables } from '../../config/index.ts';
import { Mesh, teleported } from '../../render/index.ts';
import { physicsOf, type Physics, type QueryFilter, type Vec3Like } from '../../physics/index.ts';
import { flagsOf, LAYER, upFrom, type KitFlags } from '../common.ts';
import { Health } from '../health/health.ts';
import { kitIO } from '../io.ts';

export const projectileTuning = tunables('projectile', {
  speed: num(60, { min: 1, max: 600, step: 1, unit: 'm/s', widget: 'dial', help: 'Speed of a shot that does not give its own.' }),
  damage: num(20, { min: 0, max: 1000, step: 1, help: 'Damage of a shot that does not give its own.' }),
  radius: num(0.08, { min: 0, max: 2, step: 0.01, unit: 'm', help: 'Size of the swept ball. Above 0 forgives aim.' }),
  life: num(4, { min: 0.1, max: 30, step: 0.1, unit: 's', help: 'A shot that hits nothing is freed after this long.' }),
  gravity: num(0, { min: -30, max: 60, step: 0.5, unit: 'm/s²', help: 'Downward pull on a shot; 0 flies straight.' }),
});

/** What `fire` takes. Every field is optional; missing ones come from the `projectile` tunables. */
export interface FireOpts {
  speed?: number;
  gravity?: number;
  damage?: number;
  radius?: number;
  life?: number;
  /** Who shot. Its Health is never hurt by this shot, and the `from` of the damage. */
  from?: Node | null;
  /** Layers the shot stops on. Default: world, player and enemy. */
  mask?: number;
  /** Sound when it hits something. */
  hitSound?: string;
}

const DEFAULT_MASK = LAYER.world | LAYER.player | LAYER.enemy;
const MAX_SKIPS = 4;
const filter: QueryFilter = {};
const at = { x: 0, y: 0, z: 0 };
const sweep = { x: 0, y: 0, z: 0 };

/** What every shot of one world shares: the pool and the `hit` signal. */
export class ProjectilePool {
  /** Every shot that ended on something: (what it hit or null for the world, where, damage dealt). */
  readonly hit = signal<[target: Node | null, x: number, y: number, z: number, applied: number]>();
  readonly all: Projectile[] = [];
  private readonly free: Projectile[] = [];
  constructor(private readonly world: World) {}

  /** Shots in flight. */
  get live(): number { return this.all.length - this.free.length; }

  /** @internal */
  take(): Projectile {
    const p = this.free.pop();
    if (p) return p;
    const n = this.world.spawn(`projectile${this.all.length}`);
    n.add(Mesh, { shape: 'sphere', material: 'material/projectile', castShadow: false });
    const b = n.add(Projectile);
    b.pool = this;
    this.all.push(b);
    return b;
  }

  /** @internal */
  release(p: Projectile): void { this.free.push(p); }
}

const pools = new WeakMap<World, ProjectilePool>();
/** The world's shot pool, made on first use. */
export function projectilesOf(world: World): ProjectilePool {
  let p = pools.get(world);
  if (!p) { p = new ProjectilePool(world); pools.set(world, p); }
  return p;
}

/**
 * Fires one shot from `origin` along `dir` (any length) and returns the shot's node. The shot lives in a pool: after
 * the first few shots a fire allocates nothing. Each fixed step it sweeps a ball from where it was to where it goes,
 * so a fast shot cannot pass through a thin wall; the first thing it meets ends it, and a Health there is hurt once.
 */
export function fire(world: World, origin: Vec3Like, dir: Vec3Like, opts: FireOpts = {}): Node {
  const l = Math.hypot(dir.x, dir.y, dir.z);
  if (!(l > 0)) throw new Error('projectile: fire needs a direction that is not zero');
  const p = projectilesOf(world).take();
  const speed = opts.speed ?? projectileTuning.speed;
  p.vx = (dir.x / l) * speed;
  p.vy = (dir.y / l) * speed;
  p.vz = (dir.z / l) * speed;
  p.gravity = opts.gravity ?? projectileTuning.gravity;
  p.damage = opts.damage ?? projectileTuning.damage;
  p.radius = opts.radius ?? projectileTuning.radius;
  p.life = opts.life ?? projectileTuning.life;
  p.from = opts.from ?? null;
  p.mask = opts.mask ?? DEFAULT_MASK;
  p.hitSound = opts.hitSound ?? '';
  p.start(origin);
  return p.node;
}

/**
 * Fires a shot along this node's forward (-Z) on an input action, `rate` times a second while held. Put it on the
 * node that aims (the first-person eye, a turret). Fields mirror `FireOpts`; `from` is the owner found by walking
 * up from this node to its Health.
 */
export class Launcher extends Behaviour {
  static override state = ['cooldown'];
  action = 'fire';
  rate = 4;
  /** Metres above the node that shots start. */
  height = 0;
  /** Metres in front of the node that shots start, so they clear the shooter's own body. */
  muzzle = 0.4;
  speed = -1;
  damage = -1;
  gravity = -1;
  radius = -1;
  life = -1;
  mask = DEFAULT_MASK;
  sound = '';
  hitSound = '';
  cooldown = 0;
  readonly fired = signal<[shot: Node]>();
  private flags!: KitFlags;
  private readonly o = new Vector3();
  private readonly d = new Vector3();
  private readonly qt = new Quaternion();
  private readonly opts: FireOpts = {};

  override ready(): void { this.flags = flagsOf(this.world); }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused) return;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.cooldown > 0 || !kitIO.input.action(this.action).down) return;
    this.shoot();
  }

  /** One shot now, whatever the cooldown. */
  shoot(): Node {
    this.cooldown = 1 / this.rate;
    this.node.object3d.getWorldPosition(this.o);
    this.node.object3d.getWorldQuaternion(this.qt);
    this.d.set(0, 0, -1).applyQuaternion(this.qt);
    this.o.addScaledVector(this.d, this.muzzle);
    this.o.y += this.height;
    const op = this.opts;
    op.speed = this.speed >= 0 ? this.speed : undefined;
    op.damage = this.damage >= 0 ? this.damage : undefined;
    op.gravity = this.gravity >= 0 ? this.gravity : undefined;
    op.radius = this.radius >= 0 ? this.radius : undefined;
    op.life = this.life >= 0 ? this.life : undefined;
    op.mask = this.mask;
    op.hitSound = this.hitSound;
    op.from = this.node;
    const n = fire(this.world, this.o, this.d, op);
    if (this.sound !== '') kitIO.play(this.sound);
    this.fired.emit(n);
    return n;
  }
}

/** One shot. Made and reused by the pool; game code calls `fire`, not this. */
export class Projectile extends Behaviour {
  static override state = ['active', 'life', 'vx', 'vy', 'vz'];
  active = false;
  life = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  gravity = 0;
  damage = 0;
  radius = 0;
  from: Node | null = null;
  mask = DEFAULT_MASK;
  hitSound = '';
  pool!: ProjectilePool;
  private phys!: Physics;
  private flags!: KitFlags;
  private owner: Health | null = null;

  override ready(): void {
    this.phys = physicsOf(this.world);
    this.flags = flagsOf(this.world);
    this.show(false);
  }

  /** @internal */
  start(origin: Vec3Like): void {
    this.node.position.set(origin.x, origin.y, origin.z);
    teleported(this.node);
    this.owner = this.from ? upFrom(this.from, Health) ?? null : null;
    this.active = true;
    this.show(true);
  }

  private show(on: boolean): void { this.node.object3d.visible = on; }

  private end(): void {
    this.active = false;
    this.show(false);
    this.pool.release(this);
  }

  override fixedUpdate(dt: number): void {
    if (!this.active || this.flags.paused) return;
    this.life -= dt;
    this.vy -= this.gravity * dt;
    const p = this.node.position;
    let dx = this.vx * dt;
    let dy = this.vy * dt;
    let dz = this.vz * dt;
    let left = Math.hypot(dx, dy, dz);
    if (left > 0) {
      filter.mask = this.mask;
      filter.ignoreNode = this.from;
      for (let skip = 0; skip <= MAX_SKIPS && left > 0; skip++) {
        sweep.x = dx; sweep.y = dy; sweep.z = dz;
        const h = this.phys.spherecast(p, sweep, left, this.radius, filter);
        if (h === null) break;
        const target = h.node ? upFrom(h.node, Health) : undefined;
        if (target !== undefined && target === this.owner) {
          // Our own body: carry on from just past it so the shooter's hit boxes never stop their own shot.
          const adv = Math.min(left, h.distance + this.radius + 0.01);
          const k = adv / left;
          p.x += dx * k; p.y += dy * k; p.z += dz * k;
          dx *= 1 - k; dy *= 1 - k; dz *= 1 - k;
          left -= adv;
          continue;
        }
        // Rest on the surface so effects land where it struck.
        at.x = h.x; at.y = h.y; at.z = h.z;
        p.set(h.x + h.nx * this.radius, h.y + h.ny * this.radius, h.z + h.nz * this.radius);
        const applied = target !== undefined ? target.damage(this.damage, h.tag, this.from) : 0;
        if (this.hitSound !== '') kitIO.play(this.hitSound);
        this.end();
        this.pool.hit.emit(target?.node ?? null, at.x, at.y, at.z, applied);
        return;
      }
    }
    if (left > 0) p.set(p.x + dx, p.y + dy, p.z + dz);
    if (this.life <= 0) this.end();
  }
}
