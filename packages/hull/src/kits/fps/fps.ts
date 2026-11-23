import { Behaviour, type Node, type World } from '../../core/index.ts';
import { num, tunables } from '../../config/index.ts';
import { Collider } from '../../physics/index.ts';
import { Camera, Mesh, teleported } from '../../render/index.ts';
import type { UiView } from '../../ui/index.ts';
import { ensurePhysics, flagsOf, fwdX, fwdZ, GROUP, KitUi, LAYER, lockPointerOnClick, type KitFlags } from '../common.ts';
import { Health, HealthHud, healthTuning } from '../health/health.ts';
import { Weapon } from '../health/weapon.ts';
import { kitIO } from '../io.ts';
import { footsteps, newWalk, walk, type WalkState } from '../walker.ts';

export const fpsTuning = tunables('fps', {
  walkSpeed: num(6, { min: 1, max: 20, step: 0.5, unit: 'm/s', widget: 'dial', help: 'Top speed on foot.' }),
  sprintSpeed: num(9.5, { min: 1, max: 30, step: 0.5, unit: 'm/s', widget: 'dial', help: 'Top speed while the sprint key is held.' }),
  accel: num(70, { min: 5, max: 300, step: 5, unit: 'm/s²', widget: 'dial', help: 'How quickly the player reaches top speed or stops.' }),
  airControl: num(0.35, { min: 0, max: 1, step: 0.05, widget: 'slider', help: 'Share of acceleration kept in the air.' }),
  jumpHeight: num(1.1, { min: 0.2, max: 4, step: 0.1, unit: 'm', widget: 'dial' }),
  gravity: num(26, { min: 5, max: 80, step: 1, unit: 'm/s²', widget: 'dial' }),
  coyoteTime: num(0.1, { min: 0, max: 0.4, step: 0.01, unit: 's', widget: 'slider', help: 'How long after leaving a ledge a jump still counts.' }),
  eyeHeight: num(1.62, { min: 0.8, max: 2.5, step: 0.02, unit: 'm' }),
  radius: num(0.35, { min: 0.2, max: 1, step: 0.05, unit: 'm' }),
  height: num(1.8, { min: 1, max: 3, step: 0.05, unit: 'm' }),
  mouseSensitivity: num(0.0022, { min: 0.0003, max: 0.01, step: 0.0001, unit: 'rad/px', widget: 'dial', help: 'Look speed with the mouse.' }),
  padLookSpeed: num(2.6, { min: 0.5, max: 8, step: 0.1, unit: 'rad/s', widget: 'slider', help: 'Look speed with the right stick or the arrow keys.' }),
  pitchLimit: num(85, { min: 30, max: 89, step: 1, unit: 'deg', widget: 'slider' }),
  fov: num(75, { min: 40, max: 120, step: 1, unit: 'deg', widget: 'slider' }),
  strideLength: num(2.1, { min: 0.5, max: 5, step: 0.1, unit: 'm', help: 'Distance run between two footsteps.' }),
});

const mv = { x: 0, y: 0 };
const lk = { x: 0, y: 0 };

/**
 * A first-person body. The node is the feet; a child `eye` carries the camera. Mouse look (and the arrow keys or the
 * right stick) turns the node's yaw and the eye's pitch; WASD moves relative to where it looks. The capsule is moved
 * by the physics mover, so it slides along walls and climbs low ledges. It reads the actions `move`, `look`,
 * `lookPad`, `jump` and `sprint`.
 */
export class FirstPerson extends Behaviour {
  static override state = ['yaw', 'pitch', 'walk'];
  yaw = 0;
  pitch = 0;
  walk: WalkState = newWalk();
  /** Meshes or sounds the game can turn off. */
  stepSound = 'sound/footstep';
  landSound = 'sound/thud';
  eye!: Node;
  private col!: Collider;
  private health: Health | null = null;
  private flags!: KitFlags;
  private unlock: (() => void) | null = null;

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.unlock = lockPointerOnClick(this.flags);
    ensurePhysics(this.world);
    this.node.addTo(GROUP.player).addTo(GROUP.save);
    this.health = this.node.get(Health) ?? null;
    this.col = this.node.add(Collider, {
      shape: { type: 'capsule', radius: fpsTuning.radius, height: fpsTuning.height, center: [0, fpsTuning.height / 2, 0] },
      layer: LAYER.player,
    });
    this.eye = this.world.spawn('eye', this.node);
    this.eye.position.y = fpsTuning.eyeHeight;
    this.eye.add(Camera, { fov: fpsTuning.fov });
    this.node.rotation.y = this.yaw;
    teleported(this.node);
  }

  get speed(): number { return Math.hypot(this.walk.vx, this.walk.vz); }

  override dispose(): void { this.unlock?.(); }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused) return;
    const input = kitIO.input;
    const alive = this.health === null || !this.health.dead;
    let wx = 0;
    let wz = 0;
    let jump = false;
    let sprint = false;
    if (alive) {
      input.vec2('look', lk);
      this.yaw -= lk.x * fpsTuning.mouseSensitivity;
      this.pitch -= lk.y * fpsTuning.mouseSensitivity;
      input.vec2('lookPad', lk);
      this.yaw -= lk.x * fpsTuning.padLookSpeed * dt;
      this.pitch -= lk.y * fpsTuning.padLookSpeed * dt;
      const lim = (fpsTuning.pitchLimit * Math.PI) / 180;
      this.pitch = Math.min(Math.max(this.pitch, -lim), lim);

      input.vec2('move', mv);
      const len = Math.hypot(mv.x, mv.y);
      const k = len > 1 ? 1 / len : 1;
      const f = -mv.y * k;
      const r = mv.x * k;
      // Right of a yaw is (cos, -sin); forward is (-sin, -cos).
      wx = r * Math.cos(this.yaw) + f * fwdX(this.yaw);
      wz = -r * Math.sin(this.yaw) + f * fwdZ(this.yaw);
      jump = input.action('jump').pressed;
      sprint = input.action('sprint').down;
    }
    const impact = walk(this.col, this.walk, wx, wz, sprint ? fpsTuning.sprintSpeed : fpsTuning.walkSpeed, fpsTuning.accel, jump, LAYER.world | LAYER.enemy, fpsTuning, dt);
    if (impact > 4 && this.landSound !== '') kitIO.play(this.landSound, { volume: Math.min(1, 0.25 + impact / 16) });
    footsteps(this.walk, dt, fpsTuning.strideLength, this.stepSound);
    this.node.rotation.y = this.yaw;
    this.eye.rotation.x = this.pitch;
  }
}

/** A dot in the middle of the screen. */
export class Crosshair extends KitUi {
  protected build(ui: UiView): void {
    const p = ui.root.panel({ anchor: 'center', label: 'Crosshair', width: 8 });
    p.el.style.cssText += ';padding:0;height:8px;border-radius:50%;background:var(--hull-text,#fff);opacity:.85;border:1px solid rgba(0,0,0,.5)';
  }
}

/**
 * The whole first-person player in one call: body, health, a gun on the eye, health bar and crosshair.
 * Returns the player node. Add it after the level and the pause menu so the order of steps is right.
 * `gun: false` leaves out the Weapon and its mesh, for a game where the player does not shoot (a walking game, a puzzle).
 */
export function spawnFirstPerson(world: World, at: { x?: number; z?: number; yaw?: number; gun?: boolean } = {}): Node {
  const me = world.spawn('player');
  me.position.set(at.x ?? 0, 0, at.z ?? 0);
  me.add(Health, { max: healthTuning.playerMax, hp: healthTuning.playerMax });
  me.add(FirstPerson, { yaw: at.yaw ?? 0 });
  const fp = me.get(FirstPerson)!;
  me.add(HealthHud);
  me.add(Crosshair);
  if (at.gun === false) return me;
  // The gun is the node on the eye: it shoots where the camera looks, and the viewmodel rides with it.
  fp.eye.add(Weapon, { action: 'fire', damage: 25, range: 80, rate: 6, radius: 0, sound: 'sound/shot', mask: LAYER.world | LAYER.enemy });
  const gun = world.spawn('gun', fp.eye);
  gun.position.set(0.2, -0.2, -0.5);
  gun.scale.set(0.05, 0.07, 0.3);
  gun.add(Mesh, { shape: 'box', material: 'material/gun', castShadow: false, receiveShadow: false });
  return me;
}
