import { Behaviour } from '../../core/index.ts';
import { num, tunables } from '../../config/index.ts';
import { flagsOf, fwdX, fwdZ, type KitFlags } from '../common.ts';
import { FollowCamera } from '../follow-camera/follow-camera.ts';
import { kitIO } from '../io.ts';
import { turnToward } from './brain.ts';
import { Combatant } from './combatant.ts';
import { LockOn } from './lockon.ts';

export const fighterTuning = tunables('fighter', {
  moveSpeed: num(3.6, { min: 0.5, max: 12, step: 0.1, unit: 'm/s', widget: 'dial' }),
  guardSpeed: num(1.6, { min: 0, max: 8, step: 0.1, unit: 'm/s', help: 'Walking speed while the guard is up.' }),
  turnRate: num(12, { min: 1, max: 40, step: 0.5, unit: 'rad/s' }),
  chargeTime: num(0.45, { min: 0.1, max: 2, step: 0.05, unit: 's', help: 'Heavy held this long and let go is the charged move.' }),
});

const mv = { x: 0, y: 0 };

/**
 * The player's side of a Combatant: reads the actions and calls the same methods an enemy brain does. Actions:
 * `move` (axis2, relative to the camera), `attack` (light), `heavy` (tap, or hold and let go for the charged move; a
 * broken enemy in reach makes it the finisher), `guard` (held), `dodge`, `stance1` .. `stance3` and `stanceNext`.
 * Moves the node itself unless the game gives the Combatant a `mover`.
 */
export class FighterInput extends Behaviour {
  static override state = ['heldFor', 'facing'];
  cameraName = 'camera';
  /** Move and face with the actions. Off: a game that moves the body itself (ThirdPerson) only wants the buttons. */
  drive = true;
  heldFor = -1;
  facing = 0;
  private c!: Combatant;
  private cam: FollowCamera | null = null;
  private lock: LockOn | null = null;
  private flags!: KitFlags;

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.c = this.node.get(Combatant)!;
    this.facing = this.node.rotation.y;
  }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused || this.c.state === 'dead') return;
    const input = kitIO.input;
    const c = this.c;
    this.cam ??= this.world.find(this.cameraName)?.get(FollowCamera) ?? null;
    this.lock ??= this.node.get(LockOn) ?? null;
    const yaw = this.cam?.yaw ?? 0;

    if (input.action('attack').pressed) c.press('light');
    const heavy = input.action('heavy');
    if (heavy.pressed) this.heldFor = 0;
    else if (this.heldFor >= 0 && heavy.down) this.heldFor += dt;
    if (this.heldFor >= 0 && !heavy.down) {
      const long = this.heldFor >= fighterTuning.chargeTime;
      this.heldFor = -1;
      if (!(c.brokenInReach(2.5) && c.press('finisher'))) c.press(long ? 'charged' : 'heavy');
    }
    c.guard(input.action('guard').down);
    input.vec2('move', mv);
    const len = Math.hypot(mv.x, mv.y);
    const k = len > 1 ? 1 / len : 1;
    const f = -mv.y * k, r = mv.x * k;
    const wx = r * Math.cos(yaw) - f * Math.sin(yaw);
    const wz = -r * Math.sin(yaw) - f * Math.cos(yaw);
    if (input.action('dodge').pressed) c.dodge(len > 0.1 ? wx : 0, len > 0.1 ? wz : 0);

    const set = c.set;
    const stances = set?.stances;
    if (stances) {
      for (let i = 0; i < stances.length && i < 3; i++) if (input.action('stance' + (i + 1)).pressed) c.setStance(stances[i]!);
      if (input.action('stanceNext').pressed) c.setStance(stances[(Math.max(0, stances.indexOf(c.stance)) + 1) % stances.length]!);
    }

    if (!this.drive) return;
    const animator = c.animator;
    let speed = 0;
    if (c.state === 'free') {
      const top = c.guarding ? fighterTuning.guardSpeed : fighterTuning.moveSpeed;
      const t = this.lock?.target;
      if (t) this.facing = turnToward(this.facing, Math.atan2(-(t.position.x - this.node.position.x), -(t.position.z - this.node.position.z)), fighterTuning.turnRate, dt);
      else if (len > 0.1) this.facing = turnToward(this.facing, Math.atan2(-wx, -wz), fighterTuning.turnRate, dt);
      if (len > 0.1) { c.drive(wx * top * dt, wz * top * dt); speed = top * Math.min(1, len); }
      this.node.rotation.y = this.facing;
    }
    animator?.set('speed', speed);
    void fwdX; void fwdZ;
  }
}
