import { Behaviour, type Node, type World } from '../../core/index.ts';
import { num, tunables } from '../../config/index.ts';
import { Animator } from '../../anim/index.ts';
import { Collider } from '../../physics/index.ts';
import { Camera, Mesh, teleported } from '../../render/index.ts';
import { ensurePhysics, flagsOf, GROUP, LAYER, type KitFlags } from '../common.ts';
import { FollowCamera } from '../follow-camera/follow-camera.ts';
import { Health, HealthHud, healthTuning } from '../health/health.ts';
import { Weapon } from '../health/weapon.ts';
import { kitIO } from '../io.ts';
import { Stock, StockHud } from '../pickups/pickups.ts';
import { footsteps, newWalk, walk, type WalkState } from '../walker.ts';

export const tpTuning = tunables('thirdPerson', {
  runSpeed: num(7, { min: 1, max: 30, step: 0.5, unit: 'm/s', widget: 'dial', help: 'Top speed on foot.' }),
  sprintSpeed: num(11, { min: 1, max: 40, step: 0.5, unit: 'm/s', widget: 'dial', help: 'Top speed while sprint is held.' }),
  boostSpeed: num(22, { min: 1, max: 80, step: 1, unit: 'm/s', widget: 'dial', help: 'Top speed while boost is held and there is gas.' }),
  boostDrain: num(12, { min: 0, max: 100, step: 1, unit: 'gas/s', help: 'Gas spent per second of boost.' }),
  accel: num(60, { min: 5, max: 300, step: 5, unit: 'm/s²', widget: 'dial' }),
  boostAccel: num(35, { min: 5, max: 300, step: 5, unit: 'm/s²', help: 'Acceleration while boosting.' }),
  airControl: num(0.5, { min: 0, max: 1, step: 0.05, widget: 'slider' }),
  jumpHeight: num(1.6, { min: 0.2, max: 6, step: 0.1, unit: 'm', widget: 'dial' }),
  gravity: num(28, { min: 5, max: 80, step: 1, unit: 'm/s²', widget: 'dial' }),
  coyoteTime: num(0.12, { min: 0, max: 0.4, step: 0.01, unit: 's', widget: 'slider' }),
  turnRate: num(14, { min: 1, max: 60, step: 1, unit: 'rad/s', widget: 'slider', help: 'How fast the body swings to face where it runs.' }),
  radius: num(0.4, { min: 0.2, max: 1, step: 0.05, unit: 'm' }),
  height: num(1.8, { min: 1, max: 3, step: 0.05, unit: 'm' }),
  modelYaw: num(Math.PI, { min: -3.15, max: 3.15, step: 0.05, unit: 'rad', help: 'Turns the model so its front faces forward.' }),
  strideLength: num(2.2, { min: 0.5, max: 5, step: 0.1, unit: 'm' }),
});

const mv = { x: 0, y: 0 };
const TAU = Math.PI * 2;

/**
 * A third-person body. Moves relative to the follow camera's yaw (`cameraName`), turns to face its motion, and has
 * three gears: run, sprint, and boost, which is fast and costs the Stock "gas" if the node has one (free if not).
 * The node is the feet. A `model` child shows the character with its Animator, fed `speed`, `grounded`, `jump`,
 * `dead`, `hit` and `attack`; a game without a character gets a capsule. Reads `move`, `jump`, `sprint`, `boost`.
 */
export class ThirdPerson extends Behaviour {
  static override state = ['facing', 'walk', 'boosting'];
  facing = 0;
  walk: WalkState = newWalk();
  boosting = false;
  cameraName = 'camera';
  /** 'character/soldier'; '' uses a capsule. */
  character = '';
  stepSound = 'sound/footstep';
  landSound = 'sound/thud';
  model!: Node;
  animator: Animator | null = null;
  private col!: Collider;
  private cam: FollowCamera | null = null;
  private health: Health | null = null;
  private stock: Stock | null = null;
  private flags!: KitFlags;

  override ready(): void {
    this.flags = flagsOf(this.world);
    ensurePhysics(this.world);
    this.node.addTo(GROUP.player).addTo(GROUP.save);
    this.health = this.node.get(Health) ?? null;
    this.stock = this.node.get(Stock) ?? null;
    this.col = this.node.add(Collider, {
      shape: { type: 'capsule', radius: tpTuning.radius, height: tpTuning.height, center: [0, tpTuning.height / 2, 0] },
      layer: LAYER.player,
    });
    this.model = this.world.spawn('model', this.node);
    if (this.character) this.animator = this.model.add(Animator, { character: this.character });
    else {
      const look = this.world.spawn('capsule', this.model);
      look.position.y = tpTuning.height / 2;
      look.scale.set(tpTuning.radius / 0.25, tpTuning.height, tpTuning.radius / 0.25);
      look.add(Mesh, { shape: 'capsule', material: 'material/player' });
    }
    this.health?.damaged.connect(() => this.animator?.trigger('hit'), this.node);
    this.model.rotation.y = this.facing + tpTuning.modelYaw;
    teleported(this.node);
  }

  get speed(): number { return Math.hypot(this.walk.vx, this.walk.vz); }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused) return;
    this.cam ??= this.world.find(this.cameraName)?.get(FollowCamera) ?? null;
    const input = kitIO.input;
    const alive = this.health === null || !this.health.dead;
    let wx = 0;
    let wz = 0;
    let jump = false;
    let top = tpTuning.runSpeed;
    let accel = tpTuning.accel;
    this.boosting = false;
    if (alive) {
      input.vec2('move', mv);
      const len = Math.hypot(mv.x, mv.y);
      const k = len > 1 ? 1 / len : 1;
      const yaw = this.cam?.yaw ?? 0;
      const f = -mv.y * k;
      const r = mv.x * k;
      wx = r * Math.cos(yaw) - f * Math.sin(yaw);
      wz = -r * Math.sin(yaw) - f * Math.cos(yaw);
      jump = input.action('jump').pressed;
      if (input.action('sprint').down) top = tpTuning.sprintSpeed;
      if (input.action('boost').down && len > 0.1) {
        const gas = this.stock;
        // With a Stock the gas pays for it; without one, boost is free.
        if (!gas || !gas.has('gas') || gas.drain('gas', tpTuning.boostDrain * dt) > 0) {
          this.boosting = true;
          top = tpTuning.boostSpeed;
          accel = tpTuning.boostAccel;
        }
      }
      if (len > 0.1) this.turn(Math.atan2(-wx, -wz), dt);
    }
    const impact = walk(this.col, this.walk, wx, wz, top, accel, jump, LAYER.world | LAYER.enemy, tpTuning, dt);
    if (jump && !this.walk.grounded) this.animator?.trigger('jump');
    if (impact > 4 && this.landSound !== '') kitIO.play(this.landSound, { volume: Math.min(1, 0.25 + impact / 16) });
    footsteps(this.walk, dt, tpTuning.strideLength, this.stepSound);

    this.model.rotation.y = this.facing + tpTuning.modelYaw;
    const a = this.animator;
    if (a) {
      a.set('speed', this.speed);
      a.set('grounded', this.walk.grounded);
      a.set('dead', !alive);
    }
  }

  private turn(to: number, dt: number): void {
    let d = (to - this.facing) % TAU;
    if (d > Math.PI) d -= TAU;
    else if (d < -Math.PI) d += TAU;
    const step = tpTuning.turnRate * dt;
    this.facing += Math.abs(d) <= step ? d : Math.sign(d) * step;
  }
}

/**
 * The whole third-person player in one call: body with a character, health, a melee swing on the `attack` action,
 * the follow camera, and the HUD. Returns the player node. Add it after the level and the pause menu.
 */
export function spawnThirdPerson(world: World, at: { x: number; z: number } = { x: 0, z: 0 }, character = 'character/soldier'): Node {
  const me = world.spawn('player');
  me.position.set(at.x, 0, at.z);
  me.add(Health, { max: healthTuning.playerMax, hp: healthTuning.playerMax });
  me.add(Stock, { caps: { gas: 100 }, values: { gas: 100 } });
  const cam = world.spawn('camera');
  // Order of steps: the body moves first, then the camera follows where it ended up.
  const tp = me.add(ThirdPerson, { character });
  cam.add(Camera, { fov: 60 });
  cam.add(FollowCamera);
  me.add(HealthHud);
  me.add(StockHud, { names: ['gas'] });
  // The swing starts at the chest and goes where the body faces; `model` faces its front along +Z turned by
  // `modelYaw`, so an empty child holds the exact forward.
  const aim = world.spawn('aim', me);
  aim.add(AimFollow, { source: tp });
  aim.add(Weapon, { action: 'attack', damage: 40, range: 2.4, rate: 2.5, radius: 0.7, height: 1.1, sound: 'sound/swing', mask: LAYER.world | LAYER.enemy });
  const w = aim.get(Weapon)!;
  w.fired.connect(() => tp.animator?.trigger('attack'), aim);
  return me;
}

/** Keeps its node turned the way the body faces, so a Weapon on it fires along the body's forward. */
export class AimFollow extends Behaviour {
  source!: ThirdPerson;
  override fixedUpdate(): void { this.node.rotation.y = this.source.facing; }
}
