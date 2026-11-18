import { Behaviour, signal, type Node } from '../../core/index.ts';
import { Quaternion, Vector3 } from 'three';
import { physicsOf, type Physics, type QueryFilter } from '../../physics/index.ts';
import { flagsOf, upFrom, type KitFlags } from '../common.ts';
import { kitIO } from '../io.ts';
import { Health } from './health.ts';

const q = new Quaternion();
const origin = new Vector3();
const dir = new Vector3();
const filter: QueryFilter = {};

/**
 * Damage along a line: a bullet (radius 0) or a sweep (a sword, radius 0.5). It fires from the node it sits on,
 * along that node's forward (-Z), `height` metres above it. The first thing hit that has a Health, or sits under one,
 * is hurt, scaled by the tag of the collider that was hit ("head", "nape"). Everything in `mask` blocks the shot.
 */
export class Weapon extends Behaviour {
  /** The input action that fires; held fires at `rate`. */
  action = 'fire';
  damage = 25;
  range = 80;
  /** Shots per second. */
  rate = 5;
  /** 0 is a ray; above 0 a sphere is swept, which forgives aim. */
  radius = 0;
  /** Metres above the node the shot starts. */
  height = 0;
  sound = '';
  mask = -1;
  /** Seconds until the next shot is allowed. */
  cooldown = 0;
  static override state = ['cooldown'];

  /** (target, zone, applied) for every hit that hurt something. */
  readonly hit = signal<[target: Node, zone: string, applied: number]>();
  /** Every shot, whether it hit or not. */
  readonly fired = signal<[]>();
  private phys!: Physics;
  private flags!: KitFlags;
  private self: Health | null = null;

  override ready(): void {
    this.phys = physicsOf(this.world);
    this.flags = flagsOf(this.world);
    this.self = upFrom(this.node, Health) ?? null;
  }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused) return;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.self?.dead) return;
    if (this.cooldown <= 0 && kitIO.input.action(this.action).down) this.fire();
  }

  fire(): void {
    this.cooldown = 1 / this.rate;
    this.node.object3d.getWorldPosition(origin);
    origin.y += this.height;
    this.node.object3d.getWorldQuaternion(q);
    dir.set(0, 0, -1).applyQuaternion(q);
    filter.mask = this.mask;
    const h = this.radius > 0
      ? this.phys.spherecast(origin, dir, this.range, this.radius, filter)
      : this.phys.raycast(origin, dir, this.range, filter);
    this.fired.emit();
    if (this.sound !== '') kitIO.play(this.sound);
    if (!h?.node) return;
    const target = upFrom(h.node, Health);
    if (!target || target === this.self) return;
    const zone = h.tag;
    const applied = target.damage(this.damage, zone, this.node);
    if (applied > 0) this.hit.emit(target.node, zone, applied);
  }
}
