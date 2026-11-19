// The people of Hoshiro: the heroine and the raiders standing in the world. Phase 1 has no combat, only placeholders: the
// raiders stand their ground, turn to watch Aya when she comes near, flinch when the placeholder swing lands, and fall.
import { Behaviour, type Node, type World } from 'hull';
import { Animator } from 'hull/anim';
import { Collider } from 'hull/physics';
import { Health, ThirdPerson, FollowCamera, HealthHud, Weapon, AimFollow, LAYER, GROUP, kitIO } from 'hull/kits';
import { Camera } from 'hull/render';
import { groundHeight, STARTS, CAST } from './world/map';

/** Hit points by kind: what the placeholder swing (40 a hit) has to get through. */
const HP: Record<string, number> = { ashblade: 80, ashpike: 90, hulk: 240, ashkite: 60, kagari: 400 };
const HEIGHT: Record<string, number> = { ashblade: 1.74, ashpike: 1.82, hulk: 2.15, ashkite: 1.7, kagari: 1.86 };
const RADIUS: Record<string, number> = { ashblade: 0.34, ashpike: 0.34, hulk: 0.5, ashkite: 0.32, kagari: 0.36 };

const TAU = Math.PI * 2;

/** A raider that stands, watches and reacts. Phase 2 replaces this with the combat kit's brain. */
export class Stander extends Behaviour {
  static override state = ['facing', 'fallen'];
  kind = 'ashblade';
  facing = 0;
  fallen = false;
  watchRange = 16;
  turnRate = 3;
  private model!: Node;
  private animator!: Animator;
  private health!: Health;
  private target: Node | null = null;

  override ready(): void {
    this.node.addTo(GROUP.enemy);
    this.health = this.node.get(Health)!;
    this.model = this.world.spawn('model', this.node);
    this.model.rotation.y = this.facing;
    this.animator = this.model.add(Animator, { character: `character/${this.kind}`, ground: groundHeight });
    this.health.damaged.connect(() => this.animator.trigger('hit'), this.node);
    this.health.died.connect(() => {
      this.fallen = true;
      this.animator.set('dead', true);
      // The body lies there a while, then is gone: game time, so a replay does the same.
      this.world.after(6, () => { if (!this.node.destroyed) this.node.destroy(); });
    }, this.node);
  }

  override fixedUpdate(dt: number): void {
    if (this.fallen) return;
    this.target ??= this.world.find('player') ?? null;
    const p = this.target;
    if (!p) return;
    const dx = p.position.x - this.node.position.x, dz = p.position.z - this.node.position.z;
    if (Math.hypot(dx, dz) > this.watchRange) return;
    let d = (Math.atan2(-dx, -dz) - this.facing) % TAU;
    if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
    const step = this.turnRate * dt;
    this.facing += Math.abs(d) <= step ? d : Math.sign(d) * step;
    this.model.rotation.y = this.facing;
  }
}

export function spawnRaider(world: World, id: string, kind: string, x: number, z: number, yaw: number): Node {
  const n = world.spawn(id);
  n.position.set(x, groundHeight(x, z), z);
  n.add(Health, { max: HP[kind] ?? 80, hp: HP[kind] ?? 80, invulnAfterHit: 0.15 });
  const h = HEIGHT[kind] ?? 1.75, r = RADIUS[kind] ?? 0.34;
  n.add(Collider, { shape: { type: 'capsule', radius: r, height: h, center: [0, h / 2, 0] }, layer: LAYER.enemy, static: true });
  n.add(Stander, { kind, facing: yaw });
  return n;
}

export function spawnRaiders(world: World): Node[] {
  return CAST.map((c) => spawnRaider(world, c.id, c.kind, c.x, c.z, c.yaw));
}

/** Aya, her camera and her HUD: the third-person kit's body with the placeholder swing. */
export function spawnAya(world: World): Node {
  const me = world.spawn('player');
  const loc = (globalThis as { location?: { search: string } }).location;
  const pick = new URLSearchParams(loc?.search ?? '').get('start') ?? 'landing';
  const [sx, sz, syaw] = STARTS[pick] ?? STARTS['landing']!;
  me.position.set(sx, groundHeight(sx, sz), sz);
  me.add(Health, { max: 100, hp: 100 });
  const cam = world.spawn('camera');
  const tp = me.add(ThirdPerson, { character: 'character/aya', facing: syaw });
  cam.add(Camera, { fov: 60 });
  cam.add(FollowCamera, { yaw: syaw });
  me.add(HealthHud);
  // The swing starts at the chest and goes where the body faces. Phase 2 swaps it for the combat kit's blade trace.
  const aim = world.spawn('aim', me);
  aim.add(AimFollow, { source: tp });
  aim.add(Weapon, { action: 'attack', damage: 40, range: 2.3, rate: 2.4, radius: 0.7, height: 1.1, sound: 'sound/swing/light', mask: LAYER.world | LAYER.enemy });
  const w = aim.get(Weapon)!;
  w.fired.connect(() => tp.animator?.trigger('attack'), aim);
  w.hit.connect((_t, _z, _a) => kitIO.play('sound/hit/flesh'), aim);
  tp.stepSound = 'sound/step/grass';
  return me;
}
