// Aya's body and hands: the combat kit's Combatant fights, this behaviour is the player's side of it. It reads the
// game's actions (GAME.md section 3), moves the capsule, turns toward the lock-on target, holds the stance and answers
// the buttons with moves of config/move-set/aya. Everything runs on the fixed step and game time.
import { Behaviour, type Node } from 'hull';
import { Vector3 } from 'hull/three';
import { Animator } from 'hull/anim';
import { Collider } from 'hull/physics';
import { Combatant, FollowCamera, LockOn, LAYER, flagsOf, footsteps, kitIO, newWalk, tpTuning, turnToward, walk, type KitFlags, type Standoff, type WalkState } from 'hull/kits';

export const STANCES = ['stone', 'water', 'wind'] as const;

/** Seconds a stance change takes before the next cut can start (GAME.md section 4). */
export const STANCE_TIME = 0.25;
/** A heavy held this long and let go is the charged heavy. */
export const CHARGE_TIME = 0.6;
/** A finisher takes an attack press on a broken enemy this close. */
export const FINISH_RANGE = 2.0;
/** Seconds after a perfect deflect that a light attack is the riposte. */
const RIPOSTE_WINDOW = 1.0;

const mv = { x: 0, y: 0 };

export class Aya extends Behaviour {
  static override state = ['facing', 'walk', 'held', 'stanceT', 'riposteT', 'queued', 'queuedT', 'standing', 'dodgeDir', 'lastPress', 'stanceBlend'];
  facing = 0;
  walk: WalkState = newWalk();
  /** Seconds the heavy button has been down, or -1. */
  held = -1;
  stanceT = 0;
  riposteT = 0;
  queued = '';
  queuedT = 0;
  standing = false;
  dodgeDir = 0;
  /** The stance number the animator sees: eased toward the stance's index so the idle poses crossfade. */
  stanceBlend = 0;
  /** Tick of the last attack press that started a move, and the ticks it took (for the feel test). */
  lastPress = -1;
  swingLatency = -1;
  cameraName = 'camera';
  stepSound = 'sound/step/grass';
  /** Gives the standoff the game is in, or null. Set by the game's wiring. */
  standoffOf: (() => Standoff | null) | null = null;
  animator: Animator | null = null;
  c!: Combatant;
  lock: LockOn | null = null;
  private readonly home = new Vector3();
  private homeYaw = 0;
  private col!: Collider;
  private cam: FollowCamera | null = null;
  private flags!: KitFlags;
  private px = 0;
  private pz = 0;
  private pressedAt = -1;

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.c = this.node.get(Combatant)!;
    this.col = this.node.get(Collider)!;
    this.c.mover = (dx, dz) => { this.px += dx; this.pz += dz; };
    this.node.rotation.y = this.facing;
    const c = this.c;
    c.moveEnded.connect(() => { /* the move is over: the next press starts from rest */ }, this.node);
    c.hit.connect((i) => { this.animator?.set('hitHeavy', i.heavy); }, this.node);
    c.deflected.connect(() => this.animator?.trigger('deflect'), this.node);
    c.perfectDeflect.connect(() => { this.animator?.trigger('deflect'); this.riposteT = RIPOSTE_WINDOW; }, this.node);
    c.dodged.connect(() => { /* a blow went through the i-frames: the feel layer plays the cue */ }, this.node);
    c.hit.connect(() => { this.held = -1; this.animator?.set('charging', false); }, this.node);
    this.node.rotation.y = this.facing;
    this.home.set(this.node.position.x, this.node.position.y, this.node.position.z);
    this.homeYaw = this.facing;
    // A fallen Aya gets up at her start after a pause (game time, so a replay does the same).
    c.killed.connect(() => { this.world.after(3, () => this.respawn()); }, this.node);
  }

  /** Stands Aya up at her start with full health and an empty posture, and lets go of the lock-on. */
  respawn(): void {
    const c = this.c;
    this.node.position.set(this.home.x, this.home.y, this.home.z);
    this.face(this.homeYaw);
    this.walk.vx = 0; this.walk.vz = 0; this.walk.vy = 0;
    c.health.revive();
    c.dead = false;
    c.state = 'free';
    c.posture = 0;
    c.guarding = false;
    this.lock?.release();
    this.anim()?.set('dead', false);
    this.anim()?.set('broken', false);
    this.anim()?.trigger('cancel');
  }

  private anim(): Animator | null {
    if (!this.animator) this.animator = findAnimator(this.node);
    return this.animator;
  }

  /** The stance's index in STANCES, for the animator. */
  get stanceIndex(): number { return Math.max(0, STANCES.indexOf(this.c.stance as (typeof STANCES)[number])); }

  /** Starts a press now, or remembers it until the stance change is done. */
  private press(input: string): void {
    if (this.stanceT > 0) { this.queued = input; this.queuedT = 0.4; return; }
    this.pressedAt = this.world.tick;
    if (this.c.press(input) && this.c.state === 'attack') this.swingLatency = (this.world.tick - this.pressedAt) * this.world.dt;
  }

  private face(to: number): void { this.facing = to; this.node.rotation.y = to; }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused) return;
    const c = this.c;
    const a = this.anim();
    const input = kitIO.input;
    this.cam ??= this.world.find(this.cameraName)?.get(FollowCamera) ?? null;
    this.lock ??= this.node.get(LockOn) ?? null;
    const yaw = this.cam?.yaw ?? 0;
    const dead = c.state === 'dead';

    // Where the stick points, in the world.
    input.vec2('move', mv);
    const len = Math.hypot(mv.x, mv.y);
    const k = len > 1 ? 1 / len : 1;
    const f = -mv.y * k, r = mv.x * k;
    const wx = r * Math.cos(yaw) - f * Math.sin(yaw);
    const wz = -r * Math.sin(yaw) - f * Math.cos(yaw);
    const stick = len > 0.1;

    // A standoff takes the buttons: a press of attack lets go of the blade.
    const so = this.standoffOf ? this.standoffOf() : null;
    const standing = !!so && so.active;
    if (standing !== this.standing) {
      this.standing = standing;
      a?.set('standoff', standing);
      if (!standing && so && so.result === 'win') a?.trigger('quickdraw');
    }

    if (!dead && this.c.frozen <= 0) {
      if (this.riposteT > 0) this.riposteT = Math.max(0, this.riposteT - dt);
      if (this.stanceT > 0) {
        this.stanceT = Math.max(0, this.stanceT - dt);
        if (this.stanceT === 0 && this.queued !== '') { const q = this.queued; this.queued = ''; this.press(q); }
      }
      if (this.queuedT > 0) { this.queuedT -= dt; if (this.queuedT <= 0) this.queued = ''; }

      if (input.action('lockOn').pressed) this.lock?.toggle();
      if (input.action('lockNext').pressed && this.lock?.target) this.lock.cycle();

      if (standing) {
        if (input.action('attack').pressed) so!.release();
      } else {
        this.buttons(dt, stick, wx, wz);
      }
    }

    // Locomotion: free to walk only when nothing else holds the body. Moves, dodges and recoveries move it themselves.
    let top = 0;
    let wantX = 0, wantZ = 0;
    const tgt = this.lock?.target ?? null;
    if (!dead && c.state === 'free' && c.frozen <= 0 && !standing) {
      top = c.guarding ? 1.8 : input.action('sprint').down ? tpTuning.sprintSpeed : tpTuning.runSpeed;
      if (tgt) this.face(turnToward(this.facing, Math.atan2(-(tgt.position.x - this.node.position.x), -(tgt.position.z - this.node.position.z)), tpTuning.turnRate, dt));
      else if (stick) this.face(turnToward(this.facing, Math.atan2(-wx, -wz), tpTuning.turnRate, dt));
      if (stick) { wantX = wx; wantZ = wz; }
    }
    const driven = this.px !== 0 || this.pz !== 0;
    if (driven) { this.walk.vx = this.px / dt; this.walk.vz = this.pz / dt; }
    const impact = walk(this.col, this.walk, wantX, wantZ, top, driven ? 0 : tpTuning.accel, false, LAYER.world | LAYER.enemy, tpTuning, dt);
    if (driven) { this.walk.vx = 0; this.walk.vz = 0; this.px = 0; this.pz = 0; }
    void impact;
    footsteps(this.walk, dt, tpTuning.strideLength, this.stepSound);
    if (a) {
      a.set('speed', Math.hypot(this.walk.vx, this.walk.vz));
      const to = this.stanceIndex, step = 10 * dt;
      this.stanceBlend += Math.abs(to - this.stanceBlend) <= step ? to - this.stanceBlend : Math.sign(to - this.stanceBlend) * step;
      a.set('stance', this.stanceBlend);
    }
  }

  private buttons(dt: number, stick: boolean, wx: number, wz: number): void {
    const c = this.c;
    const input = kitIO.input;
    const a = this.anim();
    const tgt = this.lock?.target ?? null;
    const aim = (): void => {
      if (tgt) this.face(Math.atan2(-(tgt.position.x - this.node.position.x), -(tgt.position.z - this.node.position.z)));
      else if (stick) this.face(Math.atan2(-wx, -wz));
    };

    if (input.action('stance').pressed && (c.state === 'free' || (c.state === 'attack' && c.windowOpen('cancel')))) this.nextStance();

    if (input.action('attack').pressed) {
      if (c.state === 'free' || c.state === 'attack') aim();
      if (this.riposteT > 0) { this.riposteT = 0; this.press('riposte'); }
      else if (c.brokenInReach(FINISH_RANGE)) this.press('finisher');
      else this.press('light');
    }

    const heavy = input.action('heavy');
    if (heavy.pressed) this.held = 0;
    else if (this.held >= 0 && heavy.down) {
      this.held += dt;
      if (this.held >= 0.15) a?.set('charging', true);
    }
    if (this.held >= 0 && !heavy.down) {
      const long = this.held >= CHARGE_TIME;
      this.held = -1;
      a?.set('charging', false);
      if (c.state === 'free' || c.state === 'attack') aim();
      if (c.brokenInReach(FINISH_RANGE)) this.press('finisher');
      else this.press(long ? 'charged' : 'heavy');
    }

    c.guard(input.action('block').down);

    if (input.action('dodge').pressed) {
      let dx = 0, dz = 0, dir = 3;
      if (stick) {
        dx = wx; dz = wz;
        const fx = -Math.sin(this.facing), fz = -Math.cos(this.facing);
        const dot = wx * fx + wz * fz;
        const cross = fx * wz - fz * wx;
        dir = dot > 0.5 ? 0 : dot < -0.5 ? 3 : cross > 0 ? 2 : 1;
        // A free-running dodge turns the body where it goes; a locked one keeps facing the enemy.
        if (!tgt && dir === 0) this.face(Math.atan2(-wx, -wz));
      }
      this.dodgeDir = dir;
      a?.set('dodgeDir', dir);
      c.dodge(dx, dz);
    }
  }

  nextStance(): void {
    const c = this.c;
    c.setStance(STANCES[(this.stanceIndex + 1) % STANCES.length]!);
    this.stanceT = STANCE_TIME;
    kitIO.play('sound/sword/draw', { volume: 0.5, pitch: 1.3 });
  }
}

function findAnimator(n: Node): Animator | null {
  const a = n.get(Animator);
  if (a) return a;
  for (const c of n.children) { const r = findAnimator(c); if (r) return r; }
  return null;
}
