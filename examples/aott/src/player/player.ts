// The soldier: fixed-step body physics (gravity, quadratic drag, tether-gear wires, gas thrust, swept sphere contacts),
// ground running, blades and nape strikes, being grabbed, and the third-person camera.
import * as THREE from 'hull/three';
import { CFG } from '../config';
import * as keys from '../keys';
import { TetherGear, Hook, collisionOf } from './odm';
import type { Collider, CollisionApi, RayHit } from './odm';
import { flareStep } from './model';
import { steerToSlot } from './horse';
import { FS } from '../world/terrain';
import type { Game, Cuttable, HitTestHit, KillCam, Cine, WorldHandle } from '../types';
import { R } from '../sim';
import { depot as DEP, zones as ZN } from '../tuning';
import { damp as kitDamp, followDistance, followFov, Reach, newDepotState, stepDepot, fillTo, regenerate } from 'hull/kits';

// Math.hypot is variadic and boxes its arguments in hot loops (it was the top source of garbage); this doesn't.
const hypot = (a: number, b: number, c = 0): number => Math.sqrt(a * a + b * b + c * c);

// ---------------------------------------------------------------- what the soldier reaches in its neighbours
// Structural shapes for the modules the player drives but does not own. They describe exactly what this file calls,
// so the real classes fit them once typed.

/** The input system (input.ts): actions are rebindable (keys.ts), raw keys/buttons by code. */
export interface InputLike {
  mouseDX: number;
  mouseDY: number;
  act(action: string): boolean;
  actHit(action: string): boolean;
  hit(key: string): boolean;
  held(key: string): boolean;
}

/** Everything the body tells the model each frame (model.ts PlayerModel.update). */
export interface PlayerPose {
  riding: number;
  crouch: number;
  landPrep: number;
  mount: MountPose | null;
  straddle: number;
  horseGallop: number;
  horsePhase: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  grounded: boolean;
  running: number;
  hooks: { attached: boolean; anchor: THREE.Vector3 | null; state: string }[];
  boosting: number;
  slash: number;
  spin: boolean;
  grabbed: boolean;
  blades: boolean;
  speed: number;
  alive: boolean;
  flare: number;
}
/** Climbing onto a horse, for the model: k 0..1 through the move. */
export interface MountPose { k: number; kind: 'run' | 'air'; side: number }

/** The soldier's model (model.ts PlayerModel), as the body drives it. */
export interface PlayerModelLike {
  root?: THREE.Object3D;
  update(dt: number, s: PlayerPose): void;
  hookOrigin?(side: number, out: THREE.Vector3): THREE.Vector3;
  gasNozzle?(outPos: THREE.Vector3, outDir: THREE.Vector3): void;
  flareMuzzlePos?(out: THREE.Vector3): THREE.Vector3;
}

/** A horse (horse.ts Horse), as a rider uses it. */
export interface HorseLike {
  rider: unknown;
  caller: unknown;
  mountCd: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  speed: number;
  speedMul: number;
  crashed: number;
  gallop?: number;
  phase?: number;
  want: { f: number; turn: number };
  handsOff: boolean;
  autoSlot?: { lead: unknown; slot: unknown } | null;
  saddle(out: THREE.Vector3, stand?: number): THREE.Vector3;
  hit(k: number): void;
  up(out: THREE.Vector3): void;
  call(by: unknown): void;
}

/** A titan holding you in its fist (titans/titan.ts). */
export interface GrabberLike {
  alive?: boolean;
  position?: THREE.Vector3;
  height?: number;
  gripFrame?(pos: THREE.Vector3, up: THREE.Vector3, face: THREE.Vector3): boolean;
  onGrabEscape?(): void;
  _headWorld?(out: THREE.Vector3): THREE.Vector3;
  hitTest?(center: THREE.Vector3, radius: number, out: unknown[]): unknown[] | null;
}

/** A titan's nape frame: the centre of the cut and the way out of the back of the neck. */
interface NapeFrame { center: THREE.Vector3; normal?: THREE.Vector3 }

/** The kill cam the nape cut sets up (game.killCam). */
interface CutKillCam extends KillCam { nape: THREE.Vector3; side: THREE.Vector3; toN: THREE.Vector3; size: number }
type CineShot = NonNullable<Cine['shot']> & { roll?: number };

/** What a titan reports back from a cut (applyHit), plus what the blades add to it for the feed. */
interface CutResult { killed?: boolean; shatter?: boolean; angle?: number; speed?: number; timing?: number; [k: string]: unknown }

/** Where the blades are this frame and what they would cut. q / speed are filled in by a timed slash. */
interface BladeProbe { hits: HitTestHit[]; dir: THREE.Vector3; score: number; q: number; speed: number }

/** One rope's auto-targeted anchor (0 = Z / left, 1 = X / right). */
export interface RopeTarget {
  valid: boolean;
  point: THREE.Vector3;
  collider: Collider | null;
  titan: Cuttable | null;
  distance: number;
  age: number;
}

/** The camera rig's state (the beats are added as they first fire). */
export interface CamRig {
  pos: THREE.Vector3;
  roll: number;
  fov: number;
  trauma: number;
  dist: number;
  look: THREE.Vector3;
  punch?: number;
  whipA?: number;
  whipT?: number;
  whip?: number;
  loom?: number;
  reach?: number;
  cw?: number;
  cf?: THREE.Vector3;
}

interface Perch {
  s: THREE.Vector3; e: THREE.Vector3; c: THREE.Vector3; s1: THREE.Vector3;
  wall: THREE.Vector3 | null; t: number; dur: number; mat: string;
}
/** On the side of a trunk or wall. vy: upward speed left from running up it; move: 0..1 how hard you are climbing
 *  (for the pose and the sounds); stride: metres climbed since the last hand-hold. */
interface Cling { n: THREE.Vector3; t: number; vy: number; move: number; stride: number; mat: string }
/** Sprinting along a wall: its normal, the way you run, seconds on it, metres since the last footfall, its surface. */
interface WallRun { n: THREE.Vector3; dir: THREE.Vector3; t: number; stride: number; mat: string }
interface Mounting { t: number; air: boolean; dur: number; off: THREE.Vector3; fall: number; side: number; hit: boolean; sprung?: boolean }
interface Ban { p: THREE.Vector3; t: number }
interface AnchorCand { p: THREE.Vector3; c: Collider | null; t: Cuttable | null; s: number; sx: number }
export interface FlareShot { t: number; color: string; dir: THREE.Vector3 | null; fired: boolean }
export interface PlayerStats { kills: number; damage: number; best: number; start: number; topSpeed: number }


const UP = new THREE.Vector3(0, 1, 0);
const _sk1 = new THREE.Vector3(), _sk2 = new THREE.Vector3();   // skid dust
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _e = new THREE.Vector3(), _f = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const damp = (k: number, dt: number): number => 1 - Math.exp(-k * dt);
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
/** In a mission's column, the reins stay yours this long (s) after you let go before the horse rejoins the line. */
const REINS_FREE = 1.5;

export class Player {
  /** the wall hint has been shown this sitting */
  static _wallTold = false;
  game: Game;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  /** interpolated body centre for drawing */
  render: THREE.Vector3;
  /** public (contract): where the soldier is drawn (the same vector as render) */
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  odm: TetherGear;
  model: PlayerModelLike | null;
  yaw: number;
  pitch: number;
  cam: CamRig;
  forward: THREE.Vector3;
  bodyUp: THREE.Vector3;
  aim: { valid: boolean; point: THREE.Vector3; distance: number; lockTitan: boolean; collider: Collider | null; dir: THREE.Vector3 };
  targets: RopeTarget[];
  _scanSide: number;
  _vp = new THREE.Matrix4(); _vi = new THREE.Matrix4();
  _anchorTmp: THREE.Vector3[];
  _origins: THREE.Vector3[];
  _modelPos: THREE.Vector3;
  _released: Ban[];
  _bans: Ban[];
  _flipF: THREE.Vector3;
  _flipU: THREE.Vector3;
  flipT: number;
  _lastAnchorY: number;

  // set by reset()
  alive!: boolean;
  hp!: number;
  lastHurt!: number;
  grounded!: boolean;
  groundTime!: number;
  airTime!: number;
  groundN!: THREE.Vector3;
  wallN!: THREE.Vector3 | null;
  wallTime!: number;
  blade!: number;
  spares!: number;
  swapT!: number;
  slashT!: number;
  slashHit!: boolean;
  /** the whirlwind cut: Space held at speed in the air */
  spin!: boolean;
  spinT!: number;
  dashCd!: number;
  boosting!: boolean;
  boostLevel!: number;
  spaceHeld!: number;
  stun!: number;
  grabbedBy!: GrabberLike | null;
  grabHand!: THREE.Object3D | null;
  struggle!: number;
  grabImmune!: number;
  reelLevel!: number;
  impactCooldown!: number;
  wishF!: number;
  wishR!: number;
  /** Sidestep (A / D): -1 left .. 1 right. On foot it moves you sideways; in the air it drifts you; on a rope it swings. */
  wishS = 0;
  /** Model facing while you sidestep or back up on foot: the body turns to where it's going. */
  _moveF = new THREE.Vector3(0, 0, 1);
  turn!: number;
  wantBoost!: boolean;
  _dashPuff!: number;
  shiftHeld!: number;
  payout!: boolean;
  mouseT!: number;
  autoSwapT!: number;
  perch!: Perch | null;
  cling!: Cling | null;
  /** sprinting along a wall (see _wallRunStep) */
  wallRun: WallRun | null = null;
  _wr: WallRun = { n: new THREE.Vector3(), dir: new THREE.Vector3(), t: 0, stride: 0, mat: 'stone' };
  _wallRunCd = 0;
  /** the collider of the wall last touched (with wallN) */
  _wallC: Collider | null = null;
  /** the lines are locked: you hang on them (B) */
  hang = false;
  _creakT = 0;
  /** free-hand grip left, 1..0: clinging to a wall with no rope in tires you */
  grip = 1;
  _gripTold = false;
  /** the rush after a kill, seconds left (the reels pull harder) */
  rush = 0;
  /** metres run since the last footfall (for the footstep sounds) */
  _stride = 0;
  /** how close a wall is in front of you on foot (0..1: the view tips up it), and seconds to the next look */
  _wallLook = 0; _wallLookT = 0;
  /** fly-by sounds: seconds to the next look to either side, and which sides had something close last time */
  _passT = 0; _passSide = 0;
  _fast = false;
  /** a civilian on your back (npc/civilians.ts sets and clears it) */
  carrying: unknown = null;
  _climb!: { hook: Hook } | null;
  mountCd!: number;
  rideStand!: number;
  rideStandT!: number;
  crouch!: number;
  riding: HorseLike | null = null;
  mounting!: Mounting | null;
  prey!: Cuttable | null;
  preyDist!: number;
  swooping!: boolean;
  landed!: number;
  stats!: PlayerStats;

  // set by the modes (game.ts) and missions
  infiniteGas = false;
  silent = false;
  /** a signal round being fired (fireFlare; model.ts flareStep runs it) */
  flareA: FlareShot | null = null;

  // per-step state
  _wantL = false;
  _wantR = false;
  _footing = false;
  _landT = 0;
  _slideT = 0;
  _preLandSpeed = 0;
  _hardBrake = 0;
  _hitN = 0;
  _floorNext: Collider | null = null;
  _floorC: Collider | null = null;
  _touchTitan: Cuttable | null = null;
  skidding = false;
  straddle = 0;
  landPrep = 0;
  swoopLeg = 0;
  _swoopSide = 0;
  _swoopAim: THREE.Vector3 | null = null;
  _airLook = 0;
  _skidT = 0;
  _depot = newDepotState();
  _reach = new Reach();
  _lowGasTold = false;
  /** Seconds spent at rest (standing, perched, clinging or in the saddle) with the gear quiet. */
  _restT = 0;
  _emptyTold = false;
  /** Rest time banked toward the next spare pair of blades (see _rest). */
  _bladeRestT = 0;
  lastHorse: HorseLike | null = null;
  _arcShown = false;
  _cutBest: BladeProbe | null = null;
  _cutSpeed = 0;
  _grabCam: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;
  // lazily built scratch
  _cands?: AnchorCand[];
  _camF?: THREE.Vector3;
  _ms?: MountPose;
  _grip?: { on: boolean; up: THREE.Vector3; face: THREE.Vector3 };
  _camAtt?: boolean[];
  _whistleAt?: number;
  /** on horseback: seconds since your hands were last on the reins (arrows or mouse look), and whether you are
   *  turning the horse right now */
  _reinT = 99;
  _reining = false;
  _lastKillCam?: number;

  constructor(game: Game) {
    this.game = game;
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.render = new THREE.Vector3();      // interpolated body centre for drawing
    this.position = this.render;             // public (contract): where the soldier is drawn
    this.velocity = this.vel;
    this.odm = new TetherGear(game, this);
    this.model = null;
    this.yaw = 0; this.pitch = -0.12;
    this.cam = { pos: new THREE.Vector3(), roll: 0, fov: CFG.cam.fov, trauma: 0, dist: CFG.cam.dist, look: new THREE.Vector3() };
    this.forward = new THREE.Vector3(0, 0, 1);
    this.bodyUp = new THREE.Vector3(0, 1, 0);
    this.aim = { valid: false, point: new THREE.Vector3(), distance: 0, lockTitan: false, collider: null, dir: new THREE.Vector3() };
    // auto-targeted anchor for each rope (0 = Z / left, 1 = X / right), rescanned alternately every frame
    this.targets = [0, 1].map((): RopeTarget => ({ valid: false, point: new THREE.Vector3(), collider: null, titan: null, distance: 0, age: 0 }));
    this._scanSide = 0;
    this._anchorTmp = [];
    this._origins = [new THREE.Vector3(), new THREE.Vector3()];
    this._modelPos = new THREE.Vector3();
    this._released = [0, 1].map(() => ({ p: new THREE.Vector3(), t: 0 }));
    this._bans = [];
    this._flipF = new THREE.Vector3(); this._flipU = new THREE.Vector3(); this.flipT = 0; this._lastAnchorY = 0;
    this.reset(new THREE.Vector3(0, 50.6, 0), 0);
  }

  /** The collision world (core/collision.ts) as the soldier uses it. */
  get collision(): CollisionApi { return collisionOf(this.game); }
  /** The herd (horse.ts), as a rider sees it. */
  get herd(): { horses: HorseLike[] } | null { return this.game.herd as unknown as { horses: HorseLike[] } | null; }

  reset(position: THREE.Vector3, yaw = 0): void {
    this.pos.copy(position); this.prev.copy(position); this.render.copy(position);
    this.vel.set(0, 0, 0);
    this.yaw = yaw; this.pitch = -0.15;
    this.alive = true; this.hp = 1; this.lastHurt = -99;
    this.grounded = false; this.groundTime = 0; this.airTime = 0; this.groundN = new THREE.Vector3(0, 1, 0);
    this.wallN = null; this.wallTime = 0;
    this.blade = 1; this.spares = CFG.combat.spares; this.swapT = 0;
    this.slashT = -1; this.slashHit = false; this.spin = false; this.spinT = 0;
    this.dashCd = 0; this.boosting = false; this.boostLevel = 0; this.spaceHeld = 0;
    this.stun = 0; this.grabbedBy = null; this.grabHand = null; this.struggle = 0; this.grabImmune = 0;
    this.reelLevel = 0; this.impactCooldown = 0;
    this.wishF = 0; this.wishR = 0; this.wishS = 0; this.turn = 0; this.wantBoost = false; this._dashPuff = 0;
    this.wallRun = null; this._wallRunCd = 0; this._wallC = null; this.hang = false; this.grip = 1; this.rush = 0; this._stride = 0; this.carrying = null;
    this.shiftHeld = 0; this.payout = false; this.mouseT = 99; this.autoSwapT = 0; this.perch = null; this.cling = null; this._climb = null; this.flipT = 0; this.mountCd = 0; this.rideStand = 0; this.rideStandT = 0; this.crouch = 0; if (this.riding) this.riding.rider = null; this.riding = null; this.mounting = null; this.prey = null; this.preyDist = 1e9; this.swooping = false;
    if (this.targets) for (const t of this.targets) { t.valid = false; t.collider = null; t.titan = null; }
    this.odm.reset();
    this.cam.pos.copy(position).add(new THREE.Vector3(Math.sin(yaw) * -5, 2, Math.cos(yaw) * -5));
    this.landed = 0;
    this.stats = { kills: 0, damage: 0, best: 0, start: this.game.time || 0, topSpeed: 0 };
  }

  get speed(): number { return this.vel.length(); }

  // ---------------------------------------------------------------- input (once per frame)
  // Keyboard-first: W / S go forward and back, A / D sidestep, the arrows (or the mouse) turn. Z / X fire the left /
  // right rope at the auto-targeted anchor, Shift is gas. Space jumps off the ground (or kicks off a trunk, a wall or
  // a branch); in the air, in a titan's hand or in the saddle it cuts. K / Enter / the left mouse button always cut.
  handleInput(input: InputLike, dt: number): void {
    if (!this.alive) return;
    if (input.mouseDX || input.mouseDY) {
      const sens = CFG.cam.sens * (this.game.settings?.sens ?? 1);
      this.yaw -= input.mouseDX * sens;
      this.pitch = THREE.MathUtils.clamp(this.pitch - input.mouseDY * sens * (this.game.settings?.invertY ? -1 : 1), -1.45, 1.45);
      this.mouseT = 0;
    } else this.mouseT += dt;

    // actions, not keys: the player can rebind every one of them (keys.ts)
    const F = input.act('forward') ? 1 : 0, B = input.act('back') ? 1 : 0;
    const L = input.act('left') ? 1 : 0, R = input.act('right') ? 1 : 0;
    const SL = input.act('strafeL') ? 1 : 0, SR = input.act('strafeR') ? 1 : 0;
    // Space: a jump where there's something to push off, otherwise the cut
    const jumpHit = input.actHit('jump');
    const canJump = !this.riding && !this.grabbedBy && (this.grounded || !!this.cling || !!this.perch || (this.wallTime > 0 && !!this.wallN));
    const jump = jumpHit && canJump;
    const cut = input.actHit('cut') || input.hit('Mouse0') || (jumpHit && !canJump);

    if (this.grabbedBy) {
      if (cut) {
        this.struggle += CFG.combat.grabEscapePerPress * (this.blade > 0 ? 1 : 0.55);
        this.game.audio?.slash?.(true);
        this.slashT = 0;
        if (this.struggle >= 1) this._escapeGrab();
      }
      return;
    }

    // on horseback: ↑ gallops, ← → steer, Shift leaps off, Z / X fire a rope straight off the running horse
    if (this.riding) {
      const h = this.riding;
      // the reins: ← → turn the horse; with no arrow held, mouse look turns it toward where you look
      const kl = L || SL, kr = R || SR;   // in the saddle A / D steer too
      const mouseSteer = !kl && !kr && this.mouseT < 1.5;
      const turn = mouseSteer ? THREE.MathUtils.clamp(-wrapAngle(this.yaw - h.yaw) * 2.5, -1, 1) : kr - kl;
      this._reining = !!(kl || kr) || mouseSteer;
      this._reinT = F || B || this._reining ? 0 : this._reinT + dt;
      // a mission's formation (h.autoSlot): let go of the reins and, after a moment, the horse finds its place in
      // the column again. While you steer it keeps the column's pace unless you gallop (↑) or rein in (↓) yourself
      const rejoin = !!h.autoSlot && this._reinT > REINS_FREE;
      if (h.autoSlot && !F && !B) steerToSlot(h, h.autoSlot.lead, h.autoSlot.slot);
      else { h.want.f = F - B; h.speedMul = 1; }
      if (!rejoin) h.want.turn = turn;
      // a column horse you aren't driving on (↑) minds its own footing: it shies round a trunk instead of throwing you
      h.handsOff = !!h.autoSlot && !F;
      this.turn = 0; this.wishF = 0; this.wishR = 0; this.wishS = 0;
      if (this.mounting) return;   // still climbing on: you can already steer, but not leap
      // hold Shift: rise from the saddle and stand on the galloping horse; let go to spring off it
      const shiftHeld = input.act('gas');
      const rope = input.actHit('ropeL') || input.actHit('ropeR') || input.hit('Mouse2');
      this.rideStandT = shiftHeld || rope ? 1 : 0;
      const release = !shiftHeld && this.rideStand > 0.7;
      if (release || rope) this._leapOff(rope ? CFG.horse.ropeLeap : CFG.horse.leap);
      else {
        if (cut && this.swapT <= 0) this._slash();
        return;
      }
    }

    if (input.actHit('whistle')) this._whistle();

    // steering: the arrows turn your heading; the camera rides behind it
    this.turn = R - L;
    const anchored = this.odm.attachedCount();
    // on foot the turn tightens as you slow: a sprint carves a bend (≈1.6 g at most) instead of pivoting on the spot
    const groundRate = Math.min(CFG.keys.turnGround, CFG.ground.maxLateral / Math.max(1, hypot(this.vel.x, this.vel.z)));
    const rate = this.grounded && !anchored ? groundRate : anchored ? CFG.keys.turnRope : CFG.keys.turnAir;
    this.yaw -= this.turn * rate * dt;
    this.wishF = F - B; this.wishR = this.turn; this.wishS = SR - SL;
    this.payout = B > 0 && anchored > 0 && !this.grounded && !this.hang;   // ↓ on a rope: stop the winch, let the wire out
    // B: lock the lines and hang where you are (again, or a burst of gas, lets the reels run)
    if (input.actHit('hang')) this._toggleHang();

    // ropes: Z = left, X = right (Q / E and the mouse buttons still work for mouse players)
    const wantL = input.act('ropeL') || input.held('Mouse2');
    const wantR = input.act('ropeR') || input.held('Mouse2');
    const fireL = input.actHit('ropeL') || input.hit('Mouse2');
    const fireR = input.actHit('ropeR') || input.hit('Mouse2');
    this._wantL = wantL; this._wantR = wantR;
    if ((fireL || fireR) && this.stun <= 0) for (const b of this._bans) b.t = 0;
    if ((fireL || fireR) && (this.cling || this.perch)) { this.cling = null; this.perch = null; }
    if (this.stun <= 0) {
      if (fireL) this._fire(0, wantR);
      if (fireR) this._fire(1, wantL);
    }
    const wasAnchored = anchored;
    for (const h of this.odm.hooks) if (h.attached) this._lastAnchorY = h.anchor.y;
    for (let i = 0; i < 2; i++) {
      const want = i ? wantR : wantL, h = this.odm.hooks[i];
      if (!want && h.attached) { this._released[i].p.copy(h.anchor); this._released[i].t = 1.5; }
      this._released[i].t -= dt;
    }
    if (!wantL) this.odm.release(0);
    if (!wantR) this.odm.release(1);
    // letting go: the release-and-fly. Timed at the bottom of a swing (moving level, anchor overhead)
    // it slings you out with a burst of speed and a forward flip.
    if (wasAnchored && !this.odm.attachedCount() && !this.grounded && this.speed > 14) {
      const sp = this.speed, v = this.vel;
      const level = 1 - Math.min(1, Math.abs(v.y) / (sp * 0.55));
      const overhead = THREE.MathUtils.clamp((this._lastAnchorY - this.pos.y) / 12, 0, 1);
      const q = level * overhead;
      v.y += CFG.keys.releaseLift;
      if (q > 0.35) {
        v.addScaledVector(_e.copy(v).normalize(), CFG.release.boost * q);
        v.y += CFG.release.lift * q;
        this.flipT = CFG.release.flipTime;
        this.cam.trauma = Math.min(1, this.cam.trauma + 0.12);
        this._dashPuff = 0.2;
        this.game.audio?.setGas?.(1);
        if (q > 0.8) this.game.hud?.message?.('PERFECT RELEASE', 0.9, 'info');
      }
    }

    // gas: Shift. Tap on the ground = jump; clinging to a trunk = kick off; held = boost
    const shiftHit = input.actHit('gas') || jump;   // Space jumps / kicks off exactly like a tap of gas
    const shiftHeld = input.act('gas');
    if (shiftHit && this.hang) this._endHang();
    if (shiftHit && this.cling) { this.cling = null; this.wallTime = 0.2; }
    if (jump && this.wallRun) this._wallKick();
    else if (shiftHit && this.wallTime > 0 && this.wallN && !this.grounded && !this.wallRun) {
      this.vel.addScaledVector(this.wallN, 10).y += 7;
      this.odm.releaseAll();
      this.wallTime = 0; this._wallRunCd = 0.2;
      this.game.audio?.kickOff?.(0.6);
      this.game.fx?.impact?.(_e.copy(this.pos).addScaledVector(this.wallN, -CFG.radius), this.wallN, this._wallC?.material || 'stone');
    } else if (shiftHit && this.grounded && this.groundTime < CFG.ground.coyote + 0.01) {
      this.vel.y = Math.max(this.vel.y, CFG.ground.jump);
      if (F) { const f = this._heading(_e); this.vel.addScaledVector(f, 3); }
      this.crouch = Math.max(this.crouch, 0.45);
      this.grounded = false; this.groundTime = 1;
      this.spaceHeld = 0;
    }
    this.spaceHeld = shiftHeld ? this.spaceHeld + dt : 0;
    this.wantBoost = shiftHeld;
    // V: get onto what your rope is in. Reel in and land standing on the branch or roof (or on the side of the
    // trunk or wall), from anywhere along the rope
    if (input.actHit('land') && this.stun <= 0) this._landOnRope();
    // C: the marker isn't on the anchor you want? skip both picks to the next-best ones
    if (input.actHit('skip')) {
      for (const T of this.targets) if (T.valid) {
        const b = this._bans.find((x) => x.t <= 0) || (this._bans.length < 6 ? (this._bans[this._bans.length] = { p: new THREE.Vector3(), t: 0 }) : this._bans[0]);
        b.p.copy(T.point); b.t = CFG.aim.banTime;
      }
      this.game.audio?.bladeSwap?.();
    }
    for (const b of this._bans) b.t -= dt;

    // blades: Space cuts, held at speed in the air = the whirlwind cut (spin); dull blades swap themselves
    if (input.actHit('blades')) this._swapBlades();
    const yh = this.odm.hooks[0].yank ? this.odm.hooks[0] : this.odm.hooks[1].yank ? this.odm.hooks[1] : null;
    if (cut && yh) this._cutWire(yh);                 // a titan has your wire: Space severs it
    else if (cut && this.swapT <= 0) this._slash();   // the cut is yours to time: it swings when you press
    const cutHeld = input.act('cut') || input.held('Mouse0') || (input.act('jump') && !this.grounded);
    this.spin = cutHeld && !this.grounded && this.speed > CFG.combat.spinMinSpeed && this.blade > 0 && this.swapT <= 0 && (this.slashT < 0 || this.slashT > 0.15);
    if (this.blade <= 0 && this.spares > 0 && this.swapT <= 0) {
      this.autoSwapT += dt;
      if (this.autoSwapT > 0.25) { this.autoSwapT = 0; this._swapBlades(); }
    } else this.autoSwapT = 0;
  }

  /** Horizontal heading (unit) into out. */
  _heading(out: THREE.Vector3): THREE.Vector3 { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  /** Heading-right (unit) into out. */
  _right(out: THREE.Vector3): THREE.Vector3 { return out.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw)); }

  _camBasis(): THREE.Vector3 {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    _a.set(sy * cp, sp, cy * cp); // look forward
    return _a;
  }
  /** Horizontal wish direction (unit or zero): along the heading, plus the sidestep, plus a sideways pull while turning in the air. */
  _wish(out: THREE.Vector3): THREE.Vector3 {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const side = this.grounded ? this.wishS : this.wishR * 0.8 + this.wishS * 0.8;
    out.set(sy * this.wishF - cy * side, 0, cy * this.wishF + sy * side);
    const l = out.length();
    return l > 0 ? out.multiplyScalar(1 / l) : out;
  }

  launcher(side: number, out: THREE.Vector3): THREE.Vector3 {
    if (this.model?.hookOrigin) return this.model.hookOrigin(side, out);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    return out.copy(this.render).add(_e.set(cy * (side ? -0.25 : 0.25), -0.1, -sy * (side ? -0.25 : 0.25)));
  }

  _fire(side: number, twin: boolean): void {
    const o = _b.copy(this.pos);
    let T = this.targets[side];
    const O = this.targets[1 - side];
    // only one side has a target (e.g. Z + X with trees on one side): both ropes go there, splayed a little;
    // and with both held, a titan on either side takes both ropes
    if ((!T.valid && twin && O.valid) || (twin && O.valid && O.titan && !T.titan)) T = O;
    // both held with two different titans in view: both ropes take the nearer one
    else if (twin && T.valid && O.valid && T.titan && O.titan && T.titan !== O.titan && O.distance < T.distance) T = O;
    let target: THREE.Vector3 | null = null;
    const dir = this.aim.dir;
    if (T.valid) {
      target = _c.copy(T.point);
      if (T === this.targets[1 - side] && !T.titan) target.addScaledVector(this._right(_d), (side ? 1 : -1) * 1.2);
      dir.subVectors(target, o).normalize();
    } else {
      // nothing in range: fire ahead-and-up on that side anyway (it will miss and wind back)
      this._heading(dir).addScaledVector(this._right(_d), side ? 0.5 : -0.5).setY(0.7).normalize();
      this.game.events.emit('hook:none', { side });
    }
    if (this.odm.fire(side, o, target, dir) && this.game.fx?.gas) {
      this.launcher(side, _e); this.game.fx.gas(_e, dir, 0.3);
    }
  }

  /**
   * Auto-targeting for one rope. Candidate anchor points come straight from the geometry around you (the side
   * of each trunk facing you at a height above you, the nearest stretch of each branch, the nearest face of
   * each building or wall, the shoulders of titans and dummies). Each is scored by distance (sweet spot ~40 m),
   * height above you (a swing needs an anchor overhead), how well it lies along where you are going, and which
   * side it is on; the best few are confirmed by line of sight. The previous pick wins ties, so markers hold still.
   */
  _scan(side: number): void {
    const T = this.targets[side];
    const col = this.collision, p = this.render;
    const sgn = side === 0 ? -1 : 1;
    const fwd = this._heading(_a), right = this._right(_b);
    const v = this.vel, hs = hypot(v.x, v.z);
    // "ahead": where you're going, leaning toward where you face (turn the view and the ropes look there too)
    let ax = hs > 8 ? v.x / hs + fwd.x * 0.8 : fwd.x, az = hs > 8 ? v.z / hs + fwd.z * 0.8 : fwd.z;
    const al = hypot(ax, az) || 1; ax /= al; az /= al;
    const range = CFG.hook.range - 3;
    const gy = col.groundHeight(p.x, p.z);
    // the height we'd like to anchor at: above us, lower when we're already high over the canopy
    const wantY = p.y + (p.y - gy > 80 ? -10 : this.grounded ? 16 : 12 + THREE.MathUtils.clamp(-v.y * 0.3, -6, 10));
    const cands = this._cands || (this._cands = []);
    let n = 0;
    // lead: the anchor lands ~0.2 s from now, so judge candidates from where you'll be
    const lx = p.x + v.x * 0.2, ly = p.y + v.y * 0.2, lz = p.z + v.z * 0.2;
    const sp = v.length(), flying = !this.grounded && sp > 10;
    const other = this.odm.hooks[1 - side];
    const rel = this._released[side];
    // aim where you face: the camera's view direction decides; Z takes the left half of the view, X the right
    const cf = this.game.camera.getWorldDirection(this._camF || (this._camF = new THREE.Vector3()));
    const bans = this._bans;
    // (on your feet at the foot of a wall a short rope up it is still worth having: it lifts you onto it)
    const near = this.grounded || this.cling ? 4 : 6.5;
    // An anchor has to be in the picture: what you can't see, the ropes don't go for (no marker, no target). The
    // view is this frame's camera; anchors on a trunk or a wall are taken where the upper part of the view meets it.
    const cam = this.game.camera;
    cam.updateMatrixWorld();
    const VP = this._vp.multiplyMatrices(cam.projectionMatrix, this._vi.copy(cam.matrixWorld).invert()).elements;
    const camP = cam.position;
    // (on your feet or slow, as high in the view as it goes: the rope has to lift you; flying, nearer the middle)
    const slow = this.grounded || v.length() < 12;
    const upSlope = Math.tan(Math.asin(THREE.MathUtils.clamp(cf.y, -0.9, 0.9)) + Math.atan(Math.tan((cam.fov * Math.PI) / 360) * (slow ? 0.84 : 0.58)));
    const viewY = (x: number, z: number): number => camP.y + upSlope * hypot(x - camP.x, z - camP.z);
    const push = (x: number, y: number, z: number, c: Collider | null, titan: Cuttable | null): void => {
      const dx = x - lx, dy = y - ly, dz = z - lz;
      const d = hypot(dx, dy, dz);
      if (d < (titan ? 2.5 : near + 0.5) || d > range) return;
      const dl = hypot(dx, dz) || 1e-6;
      // (straight overhead, the wall you are clinging to, counts as ahead)
      const ahead = dl < 1.5 ? 1 : (dx * ax + dz * az) / dl;
      if (ahead < -0.35) return;                                        // never behind you
      const lateral = ((dx * right.x + dz * right.z) / dl) * sgn;          // > 0: on this rope's side
      // where it is in the picture (-1..1 across and up); outside the frame it is no target at all
      const w = VP[3] * x + VP[7] * y + VP[11] * z + VP[15];
      if (w < 0.05) return;
      const sx = (VP[0] * x + VP[4] * y + VP[8] * z + VP[12]) / w, sy = (VP[1] * x + VP[5] * y + VP[9] * z + VP[13]) / w;
      const edge = titan ? 0.98 : 0.92;
      if (Math.abs(sx) > edge || sy > edge || sy < -0.8) return;
      // on your feet, a rope into something at your own height only drags you along the ground: look higher
      if (this.grounded && !titan && dy < 2.5) return;
      const sd = 1 - Math.min(1, Math.abs(d - 40) / 60);
      const sh = this.grounded ? THREE.MathUtils.clamp((dy - 3) / 18, 0, 1) : THREE.MathUtils.clamp((dy + 10) / 30, 0, 1);
      // facing: how close to the middle of the view, a little above centre (where the eye rests); this dominates
      const facing = 1 - 2 * Math.min(1, hypot(sx * 0.85, (sy - 0.3) * 0.75));
      // which half of the view: Z wants the left half, X the right (a centred anchor suits either)
      const half = sx * sgn;
      let score = facing * CFG.aim.facingWeight * 0.75 + (half < -0.1 ? -1.4 : Math.min(half, 0.45) * 0.8)
        + sd * 0.7 + sh * 0.9 + (ahead + 1) * 0.25 + THREE.MathUtils.clamp(lateral, 0, 0.6) * 0.3;
      for (const b of bans) if (b.t > 0 && (x - b.p.x) ** 2 + (y - b.p.y) ** 2 + (z - b.p.z) ** 2 < 36) score -= 4;
      // titans (and training dummies) are the point: within reach and roughly ahead they win outright
      if (titan) score += 1.6 + (ahead > 0.5 ? 0.4 : 0);
      if (flying && !titan) {
        // swing quality: the best rope makes ~40-75° with your velocity, from an anchor above you, so the arc
        // carries you forward and up; a rope dead along your velocity is a collision course
        const cosv = (dx * v.x + dy * v.y + dz * v.z) / (d * sp);
        score += (1 - Math.min(1, Math.abs(cosv - 0.5) / 0.6)) * 0.9;
        if (cosv > 0.92 && d < sp * 1.2) score -= 0.8;
        // the lowest point of the swing must clear the ground
        const lowest = y - d;
        if (lowest < col.groundHeight(x, z) + 2) score -= 0.5;
      }
      // chaining: with the other rope anchored, this one reaches for the next anchor, not the same one
      if (other.attached && (x - other.anchor.x) ** 2 + (y - other.anchor.y) ** 2 + (z - other.anchor.z) ** 2 < 100) score -= 0.9;
      // don't grab the anchor you just let go of
      if (rel.t > 0 && (x - rel.p.x) ** 2 + (z - rel.p.z) ** 2 < 64) score -= 1.2;
      if (T.valid && (x - T.point.x) ** 2 + (y - T.point.y) ** 2 + (z - T.point.z) ** 2 < 25) score += 0.35;
      let o = cands[n];
      if (!o) o = cands[n] = { p: new THREE.Vector3(), c: null, t: null, s: 0, sx: 0 };
      o.p.set(x, y, z); o.c = c; o.t = titan; o.s = score; o.sx = sx; n++;
    };
    _c.set(p.x + ax * 12, wantY, p.z + az * 12);   // a point ahead and above: the "ideal" anchor
    for (const c of col.querySphere(p, range)) {
      if (!c.hookable) continue;
      if (c.type === 'cylinder') {
        if (c.y1 - c.y0 < 4 && c.r < 1.5) continue;   // cannons, barrels, posts: useless to swing from
        let dx = p.x - c.x, dz = p.z - c.z; const l = hypot(dx, dz) || 1; dx /= l; dz /= l;
        const y = THREE.MathUtils.clamp(viewY(c.x, c.z), c.y0 + 1.5, c.y1 - 1);
        push(c.x + dx * c.r, y, c.z + dz * c.r, c, null);
      } else if (c.type === 'capsule') {
        _d.subVectors(c.b, c.a);
        const t = THREE.MathUtils.clamp(_e.subVectors(_c, c.a).dot(_d) / Math.max(_d.lengthSq(), 1e-6), 0, 1);
        _e.copy(c.a).addScaledVector(_d, t);
        _d.subVectors(p, _e).normalize();
        push(_e.x + _d.x * c.r, _e.y + _d.y * c.r, _e.z + _d.z * c.r, c, null);
      } else if (c.type === 'box') {
        // closest point of the box to the ideal point, nudged onto the face that looks at you
        // (twice: first to find where along it, then again at the height the view meets it there)
        let px = c.center.x, py = c.center.y, pz = c.center.z;
        _f.copy(_c);
        for (let pass = 0; pass < 3; pass++) {
          _e.subVectors(_f, c.center);
          px = c.center.x; py = c.center.y; pz = c.center.z;
          let inside = true;
          for (let i = 0; i < 3; i++) {
            const ax2 = c.axes[i], h = i === 0 ? c.half.x : i === 1 ? c.half.y : c.half.z;
            const e = _e.dot(ax2), k = THREE.MathUtils.clamp(e, -h, h);
            if (Math.abs(e) >= h - 1e-3) inside = false;
            px += ax2.x * k; py += ax2.y * k; pz += ax2.z * k;
          }
          // (the ideal point fell inside a thick wall you are up against: take its face on your side instead)
          if (pass === 0 && inside) { _f.set(p.x, py, p.z); continue; }
          if (pass === 2) break;
          _f.set(px, viewY(px, pz), pz);
          if (pass === 0) pass = 1;
        }
        if (Math.min(c.half.x, c.half.y, c.half.z) < 0.25 && py < p.y) continue;   // thin slabs below you: skip
        if (c.half.x < 1.2 && c.half.y < 1.2 && c.half.z < 1.2) continue;            // crates and props
        push(px, py, pz, c, null);
      } else if (c.type === 'sphere') {
        _d.subVectors(p, c.center).normalize();
        push(c.center.x + _d.x * c.r, c.center.y + _d.y * c.r, c.center.z + _d.z * c.r, c, null);
      }
    }
    // titans and training dummies: their shoulders / upper back, where the Outriders anchor to reach the nape
    for (const t of this.game.targetList?.() || []) {
      if (!t.alive || !t.position || t.position.distanceToSquared(p) > (range + 25) ** 2) continue;
      const pts = this._anchorTmp; pts.length = 0;
      if (t.anchors) t.anchors(pts);
      else { const nw = t.napeWorld?.(); if (nw?.center) pts.push(nw.center); }
      for (const a of pts) push(a.x, a.y, a.z, null, t);
    }
    // best first; confirm line of sight on the top few
    const list = cands.slice(0, n).sort((x, y) => y.s - x.s);
    let found: { hit: RayHit; titan: Cuttable | null } | null = null;
    for (let i = 0; i < Math.min(list.length, 9); i++) {
      const o = list[i];
      _d.subVectors(o.p, p); const dl = _d.length(); _d.multiplyScalar(1 / dl);
      const hit = col.raycast(p, _d, dl + 2.5, { hookableOnly: true });
      if (!hit || hit.collider.type === 'ground' || hit.distance < (o.t ? 2 : near)) continue;
      const same = o.c ? hit.collider === o.c : (hit.collider.userData?.titan === o.t || hit.collider.userData?.dummy === o.t || hit.point.distanceTo(o.p) < 3);
      if (!same && hit.point.distanceTo(o.p) > 4) {
        // something stands in front of it (a wall in front of the roofs behind it): that is what the rope would
        // bite, and it lies on the same line of sight, so that is the target
        const ht = (hit.collider.userData?.titan || hit.collider.userData?.dummy || null) as Cuttable | null;
        if (o.t) continue;
        // (its own best point if it has one in the list: higher up it than where this sight line happens to cross)
        const own = ht ? null : list.find((q) => q.c === hit.collider && q.sx * sgn > -0.1);
        if (own) {
          _d.subVectors(own.p, p); const ol = _d.length(); _d.multiplyScalar(1 / ol);
          const h2 = col.raycast(p, _d, ol + 2.5, { hookableOnly: true });
          if (h2 && h2.collider === hit.collider && h2.distance >= near) { found = { hit: h2, titan: null }; break; }
        }
        if (hit.distance < near + 1 || (this.grounded && !ht && hit.point.y - p.y < 2.5)) continue;
        // (where the rope would bite has to be in the picture too, and not well over on the other rope's half)
        const hp = hit.point, hw = VP[3] * hp.x + VP[7] * hp.y + VP[11] * hp.z + VP[15];
        if (hw < 0.05) continue;
        const hx = (VP[0] * hp.x + VP[4] * hp.y + VP[8] * hp.z + VP[12]) / hw, hy = (VP[1] * hp.x + VP[5] * hp.y + VP[9] * hp.z + VP[13]) / hw;
        if (Math.abs(hx) > 0.92 || hy > 0.92 || hy < -0.8 || hx * sgn < -0.1) continue;
        found = { hit, titan: ht };
        break;
      }
      found = { hit, titan: o.t || hit.collider.userData?.titan || null };
      break;
    }
    T.age += 1;
    if (found) {
      T.valid = true; T.point.copy(found.hit.point); T.collider = found.hit.collider; T.titan = found.titan;
      T.distance = found.hit.distance; T.age = 0;
    } else if (T.age > 2) { T.valid = false; T.collider = null; T.titan = null; }
  }

  _dash(_input?: InputLike): void {
    if (this.dashCd > 0 || this.grabbedBy || (!this.infiniteGas && this.odm.gas < CFG.gas.dashCost)) return;
    const w = this._wish(_b);
    if (w.lengthSq() === 0) w.copy(this._camBasis());
    else { const look = this._camBasis(); if (this.wishF > 0) w.y = look.y * 0.8; w.normalize(); }
    this.vel.addScaledVector(w, CFG.gas.dashDv);
    if (!this.infiniteGas) this.odm.gas -= CFG.gas.dashCost;
    this.dashCd = CFG.gas.dashCooldown;
    this.game.audio?.setGas?.(1);
    this._dashPuff = 0.18;
    this.cam.trauma = Math.min(1, this.cam.trauma + 0.12);
  }

  // ---------------------------------------------------------------- landing on branches, roofs and trunks
  /** Holding a rope and coming in slowly: arc up onto the branch / roof it hit, or stick to the trunk / wall. */
  _perchCheck(): void {
    const C = this._climb;
    if (C) {
      // V pressed: hauling in on this rope. Land on it once you're close; let go of the rope (or it's gone) to stop
      const h = C.hook;
      if (!h.attached || !(h.side ? this._wantR : this._wantL) || this.stun > 0) { this._climb = null; }
      else if (this.pos.distanceTo(h.anchor) <= CFG.perch.climbReach) {
        const tgt = this._perchTarget(h);
        this._climb = null;
        if (tgt) { this._startPerch(tgt.pos, tgt.wall ? tgt.normal : null, h.collider!.material); return; }
      }
    }
    if (this.grounded || this.swooping || this.stun > 0 || this.hang) return;   // (paying out is how you slow down to land: allowed)
    const p = this.pos, v = this.vel;
    for (const h of this.odm.hooks) {
      if (!h.attached || !h.collider || h.collider.dynamic || h.collider.type === 'ground') continue;
      if (!(h.side ? this._wantR : this._wantL)) continue;
      const d = p.distanceTo(h.anchor);
      _e.subVectors(h.anchor, p).multiplyScalar(1 / Math.max(d, 1e-3));
      const vin = v.dot(_e);
      // coming in slowly: the whole speed counts (flying away from a fresh anchor at speed is no landing)
      // letting the wire out (↓) near your anchor means "set me down here": you land from further off
      const reach = CFG.perch.reach * (this.payout ? 1.7 : 1);
      if (d > reach + Math.max(0, vin) * 0.12 || v.length() > CFG.perch.maxSpeed || vin < -4 * (this.payout ? 3 : 1)) continue;
      const tgt = this._perchTarget(h);
      if (!tgt) continue;
      this._startPerch(tgt.pos, tgt.wall ? tgt.normal : null, h.collider.material);
      return;
    }
  }
  /** V: reel in on the rope (the one in a branch / roof / trunk, nearest first) and land on what it's in. */
  _landOnRope(): void {
    if (this.perch || this.cling || this.grounded && this._footing && !this.odm.attachedCount()) return;
    let best: Hook | null = null, bd = 1e9;
    for (const h of this.odm.hooks) {
      if (!h.attached || !h.collider || h.collider.dynamic || h.collider.type === 'ground') continue;
      const d = this.pos.distanceTo(h.anchor);
      if (d < bd && this._perchTarget(h)) { bd = d; best = h; }
    }
    if (!best) { this.game.hud?.message?.('V lands you on what your rope is in: get a rope into a branch, roof or trunk', 1.6, 'info'); return; }
    // close: straight up and onto it; further off: the reel hauls you in (gas-assisted) and you land as you arrive
    this._endHang(true);
    if (bd <= CFG.perch.climbReach) { const tgt = this._perchTarget(best)!; this._startPerch(tgt.pos, tgt.wall ? tgt.normal : null, best.collider!.material); }
    else { this._climb = { hook: best }; this.grounded = false; this.groundTime = 1; }
    this.game.audio?.setGas?.(0.8);
  }
  _perchTarget(h: Hook): { pos: THREE.Vector3; normal: THREE.Vector3; wall: boolean } | null {
    const c = h.collider!, R = CFG.radius, a = h.anchor, n = h.normal;
    const out = { pos: new THREE.Vector3(), normal: n.clone(), wall: false };
    if (c.type === 'capsule') {
      _a.subVectors(c.b, c.a); const L2 = _a.lengthSq();
      const dirY = Math.abs(_a.y) / Math.sqrt(L2 || 1);
      if (dirY < 0.7) {   // a branch: stand on its top
        const t = THREE.MathUtils.clamp(_b.subVectors(a, c.a).dot(_a) / (L2 || 1), 0.08, 0.92);
        out.pos.copy(c.a).addScaledVector(_a, t); out.pos.y += c.r + R + 0.02;
      } else { out.wall = true; out.normal.set(a.x - c.a.x, 0, a.z - c.a.z).normalize(); out.pos.copy(a).addScaledVector(out.normal, R + 0.05); }
    } else if (n.y > 0.55) {
      out.pos.copy(a).addScaledVector(UP, R + 0.02);
    } else if (Math.abs(n.y) < 0.5) {
      out.normal.set(n.x, 0, n.z).normalize();
      // a wall or rooftop edge just above the anchor: vault up onto the top instead of clinging under the lip
      // (step back from the edge until there's a clear spot: parapets and gutters sit right on the lip)
      let found = false;
      for (const back of [0.9, 1.8, 2.8]) {
        _b.copy(a).addScaledVector(out.normal, -back); _b.y += 3.2;
        const top = this.collision.raycast(_b, _d.set(0, -1, 0), 4.2, { dynamic: false });
        if (!top || top.normal.y < 0.7 || top.collider.type === 'ground') continue;
        out.pos.copy(top.point); out.pos.y += R + 0.02;
        let clear = true;
        for (const k of this.collision.collideSphere(out.pos, R * 0.9, { dynamic: false })) if (k.depth > 0.12 && k.collider !== top.collider) { clear = false; break; }
        if (clear) { found = true; return out; }
      }
      if (!found) { out.wall = true; out.pos.copy(a).addScaledVector(out.normal, R + 0.05); }
    } else return null;
    for (const k of this.collision.collideSphere(out.pos, R * 0.9, { dynamic: false })) if (k.depth > 0.12 && k.collider !== c && k.collider.type !== 'ground') return null;
    return out;
  }
  _startPerch(target: THREE.Vector3, wallN: THREE.Vector3 | null, mat: string): void {
    const d = this.pos.distanceTo(target);
    const dur = THREE.MathUtils.clamp(d / 13, 0.28, 0.75);
    this.perch = {
      s: this.pos.clone(), e: target.clone(), wall: wallN ? wallN.clone() : null, t: 0, dur,
      c: this.pos.clone().lerp(target, 0.5).add(_e.set(0, 1.1 + d * 0.12 + (wallN ? 0 : Math.max(0, target.y - this.pos.y) * 0.3), 0)),
      // leaves along the current velocity (no stop on the first frame), capped so the arc stays near the line
      s1: this.pos.clone().addScaledVector(this.vel, dur / 6),
      mat,
    };
    if (wallN) this.perch.c.addScaledVector(wallN, 1.2);
    _e.subVectors(this.perch.s1, this.perch.s);
    if (_e.length() > 0.25 * d + 0.2) this.perch.s1.copy(this.perch.s).addScaledVector(_e, (0.25 * d + 0.2) / _e.length());
    this.odm.braking = 0.25;
    this.game.audio?.setGas?.(0.7);
  }
  _perchStep(dt: number): void {
    const P = this.perch!;
    P.t += dt;
    // cubic Bezier: start -> over the top -> landing spot, on a time warp that leaves at the current velocity (s1 is
    // a sixth of a flight-time's travel out) and settles onto the spot at zero speed; velocity = its derivative
    const tau = Math.min(1, P.t / P.dur), k = 1 - (1 - tau) * (1 - tau), u = 1 - k;
    this.pos.set(0, 0, 0).addScaledVector(P.s, u * u * u).addScaledVector(P.s1, 3 * u * u * k).addScaledVector(P.c, 3 * u * k * k).addScaledVector(P.e, k * k * k);
    const r = 3 * 2 * (1 - tau) / P.dur;
    this.vel.set(0, 0, 0).addScaledVector(_e.subVectors(P.s1, P.s), r * u * u).addScaledVector(_e.subVectors(P.c, P.s1), 2 * r * u * k)
      .addScaledVector(_e.subVectors(P.e, P.c), r * k * k);
    this.launcher(0, this._origins[0]); this.launcher(1, this._origins[1]);
    this.odm.step(dt, this._origins);
    if (tau >= 1) {
      this.perch = null;
      // the rope stays in while you hold its key: on a wall it holds you there, on a branch it's your safety line
      for (const h of this.odm.hooks) if (h.attached) { h.length = Math.max(CFG.hook.minLen, h.anchor.distanceTo(P.e) + 0.5); h.parked = true; }
      this.pos.copy(P.e);
      this.game.fx?.impact?.(_e.copy(P.e).addScaledVector(P.wall || UP, -CFG.radius), P.wall || UP, P.mat || 'bark');
      this.game.audio?.land?.(0.45);
      this.cam.trauma = Math.min(1, this.cam.trauma + 0.12);
      this.crouch = 0.85;
      if (P.wall) {
        this.cling = { n: P.wall.clone(), t: 0, vy: 0, move: 0, stride: 0, mat: P.mat || 'bark' }; this.vel.set(0, 0, 0);
        if (!Player._wallTold) { Player._wallTold = true; this.game.hud?.message?.(keys.fill('ON THE WALL: {forward} climbs ({gas} faster), {back} slides down, {jump} kicks off'), 4, 'info'); }
      }
      else { this.vel.multiplyScalar(0.12).setY(0); this.grounded = true; this.groundTime = 0; this._landT = 0; }
      this.game.events.emit('player:perched', { wall: !!P.wall });
    }
  }
  /**
   * On the side of a trunk or wall. A rope you hold takes your weight, so you stay as long as you like; with no
   * rope in you hang on by your hands and your grip runs down (CFG.wall.grip s). Forward climbs (gas climbs fast),
   * back slides down, A / D shuffle sideways (round a trunk too), a ledge just overhead is hauled up onto. Coming
   * off a run-up you keep running up the wall until the speed is gone. Jump kicks off.
   */
  _clingStep(dt: number): void {
    const C = this.cling!, W = CFG.wall, R = CFG.radius;
    this.vel.set(0, 0, 0);
    this.wallN = (this.wallN || new THREE.Vector3()).copy(C.n); this.wallTime = 0.2;
    this.grounded = false; this.groundTime = 1;
    this.launcher(0, this._origins[0]); this.launcher(1, this._origins[1]);
    this.odm.step(dt, this._origins);
    const held = this.odm.attachedCount() > 0;
    C.t = held ? 0 : C.t + dt;
    const hasGas = this.infiniteGas || this.odm.gas > 0;
    // how you move on the wall this step
    let up = 0;
    if (C.vy > 0) { up = C.vy; C.vy -= CFG.gravity * 1.15 * dt; }
    if (this.wishF > 0) {
      const gas = this.wantBoost && hasGas;
      up = Math.max(up, gas ? W.climbGas : W.climb);
      if (gas && !this.infiniteGas) this.odm.gas = Math.max(0, this.odm.gas - CFG.gas.boostRate * 0.5 * dt);
    } else if (this.wishF < 0) { up = -W.slide; C.vy = 0; }
    const side = this.wishS;
    let moved = 0;
    if (up || side) {
      // a ledge within reach overhead (a roof edge, the wall top, a balcony): haul up onto it
      if (up > 0) {
        const top = this._mantleTarget(C.n);
        if (top) {
          this.cling = null;
          this._startPerch(top, null, C.mat);
          this.game.audio?.mantle?.();
          return;
        }
      }
      if (up < 0) {
        // sliding down: the ground (or a roof, a branch) under your boots sets you down
        const below = this.collision.raycast(this.pos, _e.set(0, -1, 0), R - up * dt + 0.05, { dynamic: false });
        if (below && below.normal.y > 0.6) { this.cling = null; this.grounded = true; this.groundTime = 0; this.crouch = 0.4; return; }
      }
      // the spot you are moving to, snapped back onto the surface (round a trunk the normal turns with you)
      const tx = C.n.z, tz = -C.n.x;
      const want = _a.copy(this.pos); want.y += up * dt; want.x += tx * side * W.shuffle * dt; want.z += tz * side * W.shuffle * dt;
      const hit = this.collision.raycast(_b.copy(want).addScaledVector(C.n, 0.6), _c.copy(C.n).negate(), R + 1.6, { dynamic: false });
      let ok = !!hit && Math.abs(hit.normal.y) < 0.5;
      if (ok && hit) {
        const n = _d.set(hit.normal.x, 0, hit.normal.z).normalize();
        want.copy(hit.point).addScaledVector(n, R + 0.05);
        // something in the way (a branch overhead, an eave, a buttress)?
        for (const k of this.collision.collideSphere(want, R * 0.9, { dynamic: false })) if (k.depth > 0.12 && k.collider !== hit.collider) { ok = false; break; }
        if (ok) {
          moved = this.pos.distanceTo(want);
          this.vel.subVectors(want, this.pos).multiplyScalar(1 / dt);   // (for the pose and the camera; zeroed next step)
          this.pos.copy(want); C.n.copy(n); C.mat = hit.collider.material || C.mat;
        }
      }
      if (!ok) {
        C.vy = 0;
        // no more wall above you: you are at its top. Over the edge onto it; failing that, a last heave up and in
        if (up > 0 && !hit) {
          const top = this._mantleTarget(C.n, true);
          this.cling = null;
          if (top) { this._startPerch(top, null, C.mat); this.game.audio?.mantle?.(); }
          else { this.vel.set(-C.n.x * 3.5, 6.5, -C.n.z * 3.5); this._wallRunCd = 0.5; this.game.audio?.kickOff?.(0.5); }
          return;
        }
      }
      for (const h of this.odm.hooks) if (h.attached) h.length = Math.max(h.length, h.anchor.distanceTo(this.pos));
    }
    C.move += ((moved > 1e-4 ? Math.min(1, Math.abs(up) / W.climb + Math.abs(side)) : 0) - C.move) * Math.min(1, dt * 10);
    // hand-holds and scuffs
    C.stride += moved;
    if (C.stride > (up < 0 ? 0.9 : 1.5)) {
      C.stride = 0;
      const foot = _e.copy(this.pos).addScaledVector(C.n, -R);
      this.game.fx?.impact?.(foot, C.n, C.mat);
      if (up >= 0) this.game.audio?.climbGrab?.(C.mat, up > W.climb + 0.5 ? 0.8 : 0.5);
    }
    // grip: a held rope carries you; free-hand, climbing tires you faster than hanging on
    if (held) this.grip = Math.min(1, this.grip + dt * 0.5);
    else this.grip -= (dt / W.grip) * (up > 0 ? 1 : 0.6);
    if (!held && this.grip < 0.3 && !this._gripTold) { this._gripTold = true; this.game.hud?.message?.(keys.fill('GRIP SLIPPING: get a rope in ({ropeL} / {ropeR}) or kick off ({jump})'), 2, 'warn'); }
    if (!held && this.grip <= 0) {
      this.grip = 0; this.cling = null; this._wallRunCd = 0.8;
      this.vel.addScaledVector(C.n, 1.5);
    }
  }

  /** A place to stand just above you on the wall you are climbing (its top, a roof edge, a ledge), or null. */
  _mantleTarget(n: THREE.Vector3, over = false): THREE.Vector3 | null {
    const R = CFG.radius, reach = CFG.wall.mantle;
    // straight in over the edge first, then a step to either side of whatever sits on it (a cannon, a chimney).
    // `over`: you have climbed level with the top already, so a place to stand at your feet counts too
    const lowest = this.pos.y + (over ? -1.5 : 0.15);
    const tx = n.z, tz = -n.x;
    for (const side of [0, 1.3, -1.3, 2.6, -2.6]) for (const back of [0.8, 1.5, 2.4, 3.4]) {
      _b.copy(this.pos).addScaledVector(n, -back); _b.x += tx * side; _b.z += tz * side; _b.y += reach;
      const top = this.collision.raycast(_b, _d.set(0, -1, 0), reach + (over ? 1.8 : 0.2), { dynamic: false });
      if (!top || top.normal.y < 0.7 || top.collider.type === 'ground' || top.point.y < lowest || top.distance < 0.02) continue;
      const out = _f.copy(top.point); out.y += R + 0.02;
      let clear = true;
      for (const k of this.collision.collideSphere(out, R * 0.9, { dynamic: false })) if (k.depth > 0.12 && k.collider !== top.collider) { clear = false; break; }
      if (clear) return out;
    }
    return null;
  }

  // ---------------------------------------------------------------- wall running
  /**
   * Touching a wall in the air with forward held and no rope in. Along it: your feet take it and you sprint along
   * the wall. Square on with speed: you run straight up it, then hang on and climb.
   */
  _wallEntry(hsPrev: number): boolean {
    const wn = this.wallN, c = this._wallC;
    if (!wn || !c || c.dynamic || Math.abs(wn.y) > 0.35) return false;
    const n = _a.set(wn.x, 0, wn.z).normalize();
    const f = this._heading(_b), v = this.vel, W = CFG.wall;
    const tx = n.z, tz = -n.x;                              // along the wall (UP × n)
    const vt = v.x * tx + v.z * tz;
    const into = -(f.x * n.x + f.z * n.z);                  // 1: facing square into the wall
    if (Math.abs(vt) >= W.runMin && into < 0.82 && (f.x * tx + f.z * tz) * vt > 0) {
      const s = Math.sign(vt), R = this._wr;
      R.n.copy(n); R.dir.set(tx * s, 0, tz * s); R.t = 0; R.stride = 0; R.mat = c.material || 'stone';
      this.wallRun = R;
      this.cam.trauma = Math.min(1, this.cam.trauma + 0.08);
      this.game.audio?.footstep?.(R.mat, 0.9, true);
      this.game.fx?.impact?.(_e.copy(this.pos).addScaledVector(n, -CFG.radius), n, R.mat);
      this.game.events.emit('player:wallrun', { start: true });
      return true;
    }
    if (into > 0.6 && hsPrev > 6) return this._runUp(n, hsPrev, c.material || 'stone');
    return false;
  }
  /** Hit a wall square on at a run: up it you go (the speed turns upward), then you hang on by your hands. */
  _runUp(n: THREE.Vector3, speed: number, mat: string): boolean {
    if (this.grip < 0.15) return false;
    const W = CFG.wall;
    const vy = Math.min(W.runUpMax, speed * W.runUp + Math.max(0, this.vel.y) * 0.5 + 2);
    this.cling = { n: n.clone(), t: 0, vy, move: 1, stride: 0, mat };
    this.pos.addScaledVector(n, 0.05);
    this.vel.set(0, 0, 0);
    this.grounded = false; this.groundTime = 1;
    this.game.audio?.footstep?.(mat, 0.9, true);
    this.game.events.emit('player:runup', {});
    return true;
  }
  _endWallRun(cd = 0.3): void {
    if (!this.wallRun) return;
    this.wallRun = null; this._wallRunCd = cd;
    this.game.events.emit('player:wallrun', { start: false });
  }
  /** Jump off the wall you are running on: out from it, up, and on along the run. */
  _wallKick(): void {
    const R = this.wallRun, W = CFG.wall, v = this.vel;
    if (!R) return;
    const s = hypot(v.x, v.z) + W.kickAlong;
    v.x = R.dir.x * s + R.n.x * W.kick; v.z = R.dir.z * s + R.n.z * W.kick;
    v.y = Math.max(0, v.y) * 0.4 + W.kickUp;
    this.game.fx?.impact?.(_e.copy(this.pos).addScaledVector(R.n, -CFG.radius), R.n, R.mat);
    this.game.audio?.kickOff?.(0.8);
    this.cam.trauma = Math.min(1, this.cam.trauma + 0.1);
    this.wallTime = 0; this.wallN = null;
    this._endWallRun(0.15);
  }
  /**
   * One step of the wall run. The wall carries your weight for CFG.wall.runTime s (then lets go over runFade): the
   * run holds runSpeed along it (faster if you came in faster; gas pushes it to runBoost) and follows the wall
   * round a bend or a trunk. It ends when you let go of forward, slow down, touch the ground, run out of wall or
   * get a rope in.
   */
  _wallRunStep(dt: number): void {
    const R = this.wallRun!, W = CFG.wall, p = this.pos, v = this.vel, rad = CFG.radius;
    R.t += dt;
    this.launcher(0, this._origins[0]); this.launcher(1, this._origins[1]);
    this.odm.step(dt, this._origins);
    if (this.wishF <= 0 || this.stun > 0 || this.odm.attachedCount() > 0) { this._endWallRun(); return; }
    const hit = this.collision.raycast(p, _a.copy(R.n).negate(), rad + 0.9, { dynamic: false });
    if (!hit || Math.abs(hit.normal.y) > 0.45) {
      // ran off the end of the wall: a hop, and the speed is yours
      v.y = Math.max(v.y, 2.5);
      this._endWallRun(0.2);
      return;
    }
    const n = _b.set(hit.normal.x, 0, hit.normal.z).normalize();
    const sgn = Math.sign(R.dir.x * n.z - R.dir.z * n.x) || 1;
    R.n.copy(n); R.dir.set(n.z * sgn, 0, -n.x * sgn); R.mat = hit.collider.material || R.mat;
    // along the wall
    let s = v.x * R.dir.x + v.z * R.dir.z;
    const gas = this.wantBoost && (this.infiniteGas || this.odm.gas > 0);
    if (gas && !this.infiniteGas) this.odm.gas = Math.max(0, this.odm.gas - CFG.gas.boostRate * 0.6 * dt);
    this.boosting = gas;
    const target = Math.max(gas ? W.runBoost : W.runSpeed, Math.min(s, 60));
    s += THREE.MathUtils.clamp(target - s, -W.runDrag * dt, (gas ? W.runAccel * 1.5 : W.runAccel) * dt);
    if (s < W.runMin) { this._endWallRun(); return; }
    // up and down it: the wall holds you, then lets go
    const hold = 1 - THREE.MathUtils.smoothstep(R.t, W.runTime, W.runTime + W.runFade);
    let vy = v.y - CFG.gravity * (1 - 0.94 * hold) * dt;
    vy -= vy * Math.min(1, 4 * dt) * hold;
    if (R.t < 0.3) vy = Math.max(vy, W.runLift * (1 - R.t / 0.3));
    v.set(R.dir.x * s, vy, R.dir.z * s);
    p.addScaledVector(v, dt);
    p.addScaledVector(n, rad + 0.03 - hit.distance);        // feet on the wall
    this.wallN = null;
    const floor = this._contacts(p, v, dt);
    // a wall across your path (an inside corner, a buttress): the run turns up it
    if (!floor && v.x * R.dir.x + v.z * R.dir.z < s * 0.5) {
      const front = this.collision.raycast(p, R.dir, rad + 0.7, { dynamic: false });
      if (front && Math.abs(front.normal.y) < 0.35) {
        const fn = _c.set(front.normal.x, 0, front.normal.z).normalize(), mat = front.collider.material || R.mat;
        this._endWallRun(0.1);
        this._runUp(fn, Math.max(s, 9), mat);
        return;
      }
    }
    this.wallN = (this.wallN || new THREE.Vector3()).copy(n); this.wallTime = 0.15;
    if (floor) { this.grounded = true; this.groundTime = 0; this._endWallRun(0.1); return; }
    this.grounded = false; this.groundTime = 1; this.airTime = 0;
    if (hold <= 0.02 && vy < -9) { this._endWallRun(0.5); return; }
    // the view comes round with the run (hands off the mouse and the arrows)
    if (this.mouseT > 0.6 && !this.turn) this.yaw += wrapAngle(Math.atan2(R.dir.x, R.dir.z) - this.yaw) * Math.min(1, dt * 2.5);
    // footfalls
    R.stride += s * dt;
    if (R.stride > 2.3) {
      R.stride = 0;
      this.game.audio?.footstep?.(R.mat, 0.5 + Math.min(0.5, s / 50), true);
      this.game.fx?.impact?.(_e.copy(p).addScaledVector(n, -rad).addScaledVector(UP, -0.3), n, R.mat);
    }
    this.dashCd -= dt; this.impactCooldown -= dt; this.grabImmune -= dt; this._wallRunCd -= dt;
    this.stats.topSpeed = Math.max(this.stats.topSpeed, this.speed);
    this._bounds();
  }

  // ---------------------------------------------------------------- hanging on locked lines
  /** B: lock the brake-reels and hang where you are; again to let them run. */
  _toggleHang(): void {
    if (this.hang) { this._endHang(); return; }
    if (!this.odm.attachedCount() || this._footing || this.riding || this.grabbedBy || this.stun > 0 || this.perch || this.cling) {
      this.game.hud?.message?.(keys.fill('{hang} locks your lines so you hang: get a rope in first'), 1.6, 'info');
      return;
    }
    this.hang = true; this.odm.hold = true; this._climb = null; this._creakT = 1.2;
    for (const h of this.odm.hooks) if (h.attached) { h.length = Math.max(CFG.hook.minLen + 0.4, h.anchor.distanceTo(this.pos)); h.parked = false; }
    this.cam.trauma = Math.min(1, this.cam.trauma + 0.08);
    this.game.audio?.reelLock?.(true);
    this.game.events.emit('player:hang', { on: true });
  }
  _endHang(silent = false): void {
    if (!this.hang) return;
    this.hang = false; this.odm.hold = false;
    if (!silent) this.game.audio?.reelLock?.(false);
    this.game.events.emit('player:hang', { on: false });
  }

  /** Run up to a free horse and vault on (hand on the saddle, leg swung over), or drop onto it from the air. */
  _tryMount(): void {
    const herd = this.herd;
    if (!herd || this.mountCd > 0 || this.odm.attachedCount() || this.speed > CFG.horse.maxMountSpeed) return;
    const air = !this.grounded && this.vel.y < -1;
    const r = CFG.horse.mountRadius * (air ? 1.35 : 1);
    for (const h of herd.horses) {
      if (h.rider || h.mountCd > 0) continue;
      h.saddle(_e);
      const dxz = (_e.x - this.pos.x) ** 2 + (_e.z - this.pos.z) ** 2;
      // on foot you run right up to the flank before vaulting; from the air the saddle is a bigger target
      if (_e.distanceToSquared(this.pos) < r * r && (air || (dxz < 1.8 * 1.8 && this.wishF > 0)) && this.vel.y < 2) {
        const hs = hypot(this.vel.x, this.vel.z);
        this.riding = h; h.rider = this; h.caller = null; this.lastHorse = h;
        h.speed = Math.max(h.speed, hs * 0.8);
        const off = new THREE.Vector3().subVectors(this.pos, h.pos);
        const lateral = -off.x * Math.cos(h.yaw) + off.z * Math.sin(h.yaw);       // + = on the horse's right
        this.mounting = { t: 0, air, dur: air ? 0.62 : CFG.horse.mountTime, off, fall: -this.vel.y, side: lateral < 0 ? 1 : -1, hit: false };
        this.rideStand = 0; this.rideStandT = 0;
        if (!air) this.game.audio?.land?.(0.2);
        this.game.events.emit('player:mounted', { horse: h });
        return;
      }
    }
  }
  /** One fixed step of climbing on. The pose is keyed in the model (s.mount); this moves the body along with it.
   *  run: crouch and plant a hand (0-0.2), spring up and over the saddle (0.2-0.75), seat (0.78), sit up.
   *  air: the last metre of the fall into the saddle (0-0.23), the impact folds you forward, then you sit up. */
  _mountStep(dt: number, h: HorseLike): void {
    const M = this.mounting!;
    M.t += dt;
    const q = Math.min(1, M.t / M.dur);
    _d.copy(h.pos).add(M.off);                                   // where you took off from, carried along with the horse
    h.saddle(_e, 0);
    if (!M.air) {
      const e = THREE.MathUtils.smoothstep(q, 0.14, 0.78);
      _a.lerpVectors(_d, _e, 0.75); _a.y = Math.max(_d.y, _e.y) + 0.75;   // up beside the saddle, then over it
      const u = 1 - e;
      this.pos.set(0, 0, 0).addScaledVector(_d, u * u).addScaledVector(_a, 2 * u * e).addScaledVector(_e, e * e);
      if (q > 0.22 && !M.sprung) { M.sprung = true; this.game.audio?.land?.(0.15); }
      if (q >= 0.78 && !M.hit) { M.hit = true; h.hit(0.25); this.game.audio?.land?.(0.3); }
    } else {
      const k = Math.min(1, q / 0.23);
      this.pos.lerpVectors(_d, _e, k * k);
      if (k >= 1 && !M.hit) {
        M.hit = true;
        const s = Math.min(1.3, M.fall / 11);
        h.hit(0.6 + s * 0.6);
        this.game.audio?.land?.(0.45 + s * 0.3);
        this.cam.trauma = Math.min(1, this.cam.trauma + 0.12 + s * 0.15);
      }
    }
    if (q >= 1) { this.mounting = null; this.rideStand = 0; }
  }
  /** Falling toward a free horse with no ropes out: drift onto its back (leading its gallop) and open the legs. */
  _saddleMagnet(dt: number, acc: THREE.Vector3): void {
    this.straddle = 0;
    const herd = this.herd;
    const hs = hypot(this.vel.x, this.vel.z);
    if (!herd || this.grounded || this.odm.attachedCount() || this.vel.y > -1 || this.boosting || this.mountCd > 0 || hs > 22) return;
    let best: HorseLike | null = null, bd = 1e9;
    for (const h of herd.horses) {
      if (h.rider || h.mountCd > 0) continue;
      const dx = h.pos.x - this.pos.x, dz = h.pos.z - this.pos.z, d2 = dx * dx + dz * dz;
      const dy = this.pos.y - (h.pos.y + 1.5);
      if (dy < 0.5 || dy > 12 || d2 > 12 * 12) continue;
      if (hs > 4 && dx * this.vel.x + dz * this.vel.z < 0.5 * Math.sqrt(d2) * hs) continue;   // only a horse you're heading for
      if (d2 < bd) { bd = d2; best = h; }
    }
    if (!best) return;
    // time to fall to saddle height, and where the saddle will be by then
    const dy = this.pos.y - (best.pos.y + 1.5), vy = -this.vel.y, g = CFG.gravity;
    const tf = Math.max(0.12, (-vy + Math.sqrt(vy * vy + 2 * g * dy)) / g);
    best.saddle(_e, 0).addScaledVector(best.vel, tf);
    const wx = (_e.x - this.pos.x) / tf, wz = (_e.z - this.pos.z) / tf;     // horizontal velocity that lands on it
    const ax = THREE.MathUtils.clamp((wx - this.vel.x) * 6, -30, 30), az = THREE.MathUtils.clamp((wz - this.vel.z) * 6, -30, 30);
    const hd = Math.sqrt(bd);
    const w = THREE.MathUtils.clamp(1.3 - hd / 10, 0, 1);
    acc.x += ax * w; acc.z += az * w;
    this.straddle = THREE.MathUtils.clamp(1 - (tf - 0.15) / 0.6, 0, 1) * w;
  }
  _mountS(M: Mounting): MountPose { const o = this._ms || (this._ms = { k: 0, kind: 'run', side: 1 }); o.k = M.t / M.dur; o.kind = M.air ? 'air' : 'run'; o.side = M.side; return o; }
  /** Fingers in mouth: your horse (or the nearest free one) comes galloping. */
  _whistle(): void {
    const herd = this.herd, now = this.game.time || 0;
    if (!herd || now - (this._whistleAt ?? -9) < 1.2) return;
    this._whistleAt = now;
    this.game.audio?.whistle?.();
    let best: HorseLike | null = null, bd = 450 * 450;
    const lh = this.lastHorse;
    if (lh && !lh.rider && lh.pos.distanceToSquared(this.pos) < 700 * 700) best = lh;
    else for (const h of herd.horses) {
      if (h.rider) continue;
      const d = h.pos.distanceToSquared(this.pos);
      if (d < bd) { bd = d; best = h; }
    }
    if (best) { best.call(this); this.game.hud?.message?.('YOUR HORSE IS COMING', 1.6, 'info'); }
    else this.game.hud?.message?.('NO HORSE WITHIN EARSHOT', 1.6, 'warn');
  }
  /** Stand up on the running horse and spring off it: you keep the horse's speed. */
  _leapOff(up: number): void {
    const h = this.riding;
    if (!h) return;
    this.riding = null; this.mounting = null; h.rider = null; h.mountCd = 2; this.mountCd = 1.2;
    h.want.f = 0; h.want.turn = 0;
    this.vel.copy(h.vel).addScaledVector(this._heading(_e), CFG.horse.leapForward);
    this.vel.y = up;
    this.grounded = false; this.groundTime = 1;
    this.game.audio?.land?.(0.3);
  }

  /** Cut your own wire where a titan's fist has it: you drop free, it hauls on nothing. */
  _cutWire(h: Hook): void {
    const at = _a.copy(h.anchor).sub(this.pos);
    const L = at.length();
    at.multiplyScalar(Math.min(2.5, L * 0.3) / (L || 1)).add(this.pos);
    this.game.fx?.sparks?.(at, _b.copy(this.pos).sub(at).normalize(), 18);
    this.odm.release(h.side, true);
    this.game.audio?.slash?.(true);
    this.vel.multiplyScalar(0.55);
    this.cam.trauma = Math.min(1, this.cam.trauma + 0.25);
    this.slashT = 0; this.slashHit = true;
    this.game.events.emit('player:wireCut', {});
  }

  _swapBlades(): void {
    if (this.swapT > 0 || this.spares <= 0 || this.blade >= 0.999) return;
    this.spares--; this.swapT = CFG.combat.swapTime;
    this.game.audio?.bladeSwap?.();
  }

  _slash(): void {
    if (this.slashT >= 0 && this.slashT < CFG.combat.slashTime * 0.7) return;
    this.slashT = 0; this.slashHit = false; this._arcShown = false; this._cutBest = null; this._cutSpeed = 0;
    this.game.audio?.slash?.(false);
  }

  // ---------------------------------------------------------------- fixed-step physics
  fixedUpdate(dt: number): void {
    this.prev.copy(this.pos);
    if (!this.alive) { this.vel.set(0, 0, 0); return; }
    if (this.grabbedBy) { this._followHand(); return; }
    if (this.riding) {
      const h = this.riding;
      // the saddle skips the on-foot timers below, so a blade swap started up here finishes here
      if (this.swapT > 0) { this.swapT -= dt; if (this.swapT <= 0) this.blade = 1; }
      if (h.crashed > 0) {   // ran into a trunk or wall at a gallop: thrown over its head
        // The horse stops dead; you keep your momentum, and its neck pitches you up and over: the same speed,
        // turned upward (no extra shove toward whatever it hit), with a tumble.
        const sp = h.crashed; h.crashed = 0;
        this._leapOff(0);
        const up = 0.62;                                   // ~38° launch
        this.vel.copy(this._heading(_e)).multiplyScalar(sp * Math.sqrt(1 - up * up));
        this.vel.y = sp * up;
        this.flipT = CFG.release.flipTime;
        this.mountCd = 2.5;
        this.cam.trauma = Math.min(1, this.cam.trauma + 0.5);
        return;
      }
      if (this.mounting) this._mountStep(dt, h);
      else {
        this.rideStand += ((this.rideStandT || 0) - this.rideStand) * Math.min(1, dt * 5);
        h.saddle(this.pos, this.rideStand);
      }
      this.vel.copy(h.vel);
      this.grounded = true; this.groundTime = 0; this.airTime = 0;
      // the view rides with the horse; mouse look leads instead (the horse turns after it)
      if (this.mouseT >= 1.5) this.yaw += wrapAngle(h.yaw - this.yaw) * Math.min(1, dt * 9);
      this.launcher(0, this._origins[0]); this.launcher(1, this._origins[1]);
      this.odm.step(dt, this._origins);
      return;
    }
    this._tryMount();
    if (this.perch) { this._perchStep(dt); return; }
    if (this.cling) { this._clingStep(dt); return; }
    if (this.wallRun) { this._wallRunStep(dt); if (this.wallRun) return; }
    this._perchCheck();
    if (this.perch) { this._perchStep(dt); return; }

    const odm = this.odm;
    this.launcher(0, this._origins[0]); this.launcher(1, this._origins[1]);
    // the launcher positions are only for visuals; physics fires from the body centre
    odm.step(dt, this._origins);

    const v = this.vel, p = this.pos;
    const acc = _d.set(0, -CFG.gravity, 0);
    const speed = v.length();

    // quadratic drag (+ a hard ramp above the cap so nothing runs away)
    let k = CFG.drag;
    if (speed > CFG.hardCap) k *= 1 + (speed - CFG.hardCap) * 0.15;
    acc.addScaledVector(v, -k * speed);

    const hasGas = this.infiniteGas || odm.gas > 0;
    const anchored = odm.attachedCount();
    const groundedNow = this.grounded;
    // on your feet with a rope in that isn't pulling (perched on the branch it's tied to): you stand and walk, the
    // rope is only a safety line
    let slack = anchored > 0;
    for (const h of odm.hooks) if (h.attached && !h.parked && p.distanceTo(h.anchor) > Math.max(h.length - 0.05, CFG.hook.minLen + 0.6)) slack = false;
    const footing = groundedNow && (!anchored || slack);
    this._footing = footing;
    // running on the ground (↑) with a rope in that's still pulling (not a safety line you're standing on): after a
    // moment the gear lets it go, so you run where you steer instead of being dragged sideways along the grass
    for (const hk of odm.hooks) {
      const titan = hk.collider?.userData?.titan || hk.collider?.userData?.dummy;
      const drag = hk.attached && !hk.parked && !titan && !this._climb && groundedNow && !footing && this.wishF > 0;
      hk._groundT = drag ? (hk._groundT || 0) + dt : 0;
      if (hk._groundT > 0.6) { odm.release(hk.side); hk._groundT = 0; }
    }
    // a rope biting into something above you while you stand: the gear hops you off your feet, so the reel
    // carries you up and away instead of dragging you along the ground
    for (const hk of odm.hooks) {
      if (!hk.attached || hk.lifted) continue;
      hk.lifted = true;
      if (groundedNow && !hk.parked && hk.anchor.y > p.y + 2 && this.stun <= 0) {
        v.y = Math.max(v.y, CFG.ground.jump * 0.95);
        this.grounded = false; this.groundTime = 1; this.crouch = Math.max(this.crouch, 0.4);
      }
    }
    this._saddleMagnet(dt, acc);
    // the lines are locked (B): you hang on them until you let them run, land, or lose them
    if (this.hang && (!anchored || footing || this.stun > 0)) this._endHang(!anchored);
    const hanging = this.hang;
    odm.surge = this.rush > 0 ? CFG.flow.rushReel : 1;
    this.boosting = this.wantBoost && hasGas && this.stun <= 0 && (!groundedNow || this.spaceHeld > 0.16 || anchored > 0);

    // winch (↓ on a rope stops it and pays the wire out for a longer, lower swing; V hauls you in at full gas)
    const climbing = !!this._climb;
    odm.payout = this.payout && !climbing ? CFG.keys.payout : 0;
    this.reelLevel = (this.payout && !climbing) || this.stun > 0 || hanging ? 0 : odm.reelAccel(p, v, this.boosting || climbing, acc);
    if (hanging) {
      // forward winches you up the wire, back lowers you; A / D set you swinging; hands off, the sway dies down
      const H = CFG.hang;
      const dl = this.wishF > 0 ? -H.winch : this.wishF < 0 ? H.lower : 0;
      if (dl) for (const h of odm.hooks) if (h.attached) h.length = THREE.MathUtils.clamp(h.length + dl * dt, CFG.hook.minLen + 0.4, CFG.hook.range);
      this.reelLevel = dl < 0 ? 0.3 : 0;
      const pdh = odm.pullDir(p, _c);
      if (this.wishS && pdh) {
        const w = this._right(_e).multiplyScalar(this.wishS);
        w.addScaledVector(pdh, -w.dot(pdh));
        acc.addScaledVector(w, H.swing);
      }
      acc.addScaledVector(v, -(this.wishS ? H.dampHeld : H.damp));
    }
    if (climbing) {
      // gas helps: lift against gravity and steer onto the line to the anchor (the other rope goes slack)
      const ch = this._climb!.hook;
      const to = _e.subVectors(ch.anchor, p), dl = to.length();
      if (dl > 1e-3) { to.multiplyScalar(1 / dl); acc.addScaledVector(to, 14).y += CFG.gravity * 0.5; }
    }
    if (anchored && !this.infiniteGas && !hanging) odm.gas -= CFG.gas.reelRate * anchored * dt * (this.boosting ? 2 : 1);

    // roped to a titan: the swoop. The gear swings you out round the side of the neck you pick (← / →; otherwise
    // the side you're on), round behind it, and lines you up on the nape where it last saw it. That's all it does:
    // the titan moves, turns and hunches, so you correct the line (← → slide you across the back of the neck),
    // choose your speed (Shift; big titans need it) and swing the blades yourself as you pass (Space). Ropes on
    // anything else go slack meanwhile so they don't hold you back.
    let prey: Cuttable | null = null;
    const yanked = odm.hooks[0].yank || odm.hooks[1].yank;   // being hauled in: no swoop until you get free
    for (const hk of odm.hooks) {
      const t = hk.attached && !yanked && !hanging ? hk.collider?.userData?.titan || hk.collider?.userData?.dummy : null;
      if (t && t.alive && typeof t.napeWorld === 'function') { prey = t; break; }
    }
    if (prey !== this.prey) { this._swoopSide = 0; this._swoopAim = null; }
    this.swooping = false; this.swoopLeg = 0; this.prey = prey; this.preyDist = 1e9;
    if (prey) {
      const nw = prey.napeWorld() as NapeFrame | null;
      const close = nw?.center && p.distanceTo(nw.center) < CFG.combat.swoopRange;
      // other ropes go slack; the titan's own rope runs free once the swoop takes over (it only steadies you)
      for (const hk of odm.hooks) {
        const mine = hk.collider?.userData?.titan === prey || hk.collider?.userData?.dummy === prey;
        hk.payout = hk.attached && (!mine || close) ? 40 : 0;
      }
      if (close && nw) {
        const nrm = nw.normal || UP;
        // where the gear thinks the nape is: it follows the real one with a lag, so a titan that turns, walks on
        // or hunches pulls the nape off your line
        const A = this._swoopAim || (this._swoopAim = nw.center.clone());
        A.lerp(nw.center, damp(CFG.combat.swoopTrack, dt));
        const dN = p.distanceTo(nw.center);
        this.preyDist = dN; this.swooping = true;
        const rx = p.x - A.x, ry = p.y - A.y, rz = p.z - A.z;
        const along = rx * nrm.x + ry * nrm.y + rz * nrm.z;                 // > 0: behind the neck
        const rt = _a.crossVectors(UP, nrm);
        if (rt.lengthSq() < 1e-4) rt.set(1, 0, 0); rt.normalize();
        // ← / → pick the side of the neck to come round (as you see it); it sticks until you pick the other
        if (this.turn && along < 1.2) this._swoopSide = Math.sign(this._right(_c).dot(rt) * this.turn) || 1;
        if (!this._swoopSide) this._swoopSide = rx * rt.x + rz * rt.z >= 0 ? 1 : -1;
        // three legs: from in front, swing out beside the head; then come round behind the neck; then in through
        // the nape (flying straight at it from the front would only hit the face). The run-in follows the lagged
        // nape (A), not the real one.
        const want = _e;
        const fast = this.boosting ? CFG.combat.swoopBoost : CFG.combat.swoop;
        if (along < 1.2) {
          this.swoopLeg = 1;
          const R = Math.max(3, (prey.height || 8) * 0.35);
          want.copy(nw.center).addScaledVector(rt, this._swoopSide * R).addScaledVector(nrm, 2); want.y += 1.5;
        } else if (dN > 5) {
          this.swoopLeg = 2;
          want.copy(A).addScaledVector(nrm, Math.min(6, dN * 0.4)); want.y += 0.5;
        } else {
          this.swoopLeg = 3;
          want.copy(A).addScaledVector(nrm, -2.5);
        }
        // keep the line off the grass: the swoop never aims you lower than a couple of metres above the ground,
        // and flying low it lifts you clear instead of dragging you along it
        // (unless the nape itself is down there: a crawler)
        const gy = this.collision.groundHeight(p.x, p.z), napeUp = A.y - gy;
        want.y = Math.max(want.y, Math.min(gy + 2, A.y));
        const clear = p.y - CFG.radius - gy;
        if (napeUp > 2.5 && clear < 1.5 && v.y < 2) acc.y += (1.5 - Math.max(0, clear)) * 12 - Math.min(0, v.y) * 4;
        const aim = want.sub(p).normalize().multiplyScalar(fast).sub(v).multiplyScalar(CFG.combat.swoopGain);
        const al = aim.length();
        if (al > CFG.combat.swoopMax) aim.multiplyScalar(CFG.combat.swoopMax / al);
        acc.add(aim);
        acc.y += CFG.gravity * 0.6;   // the wires hold most of your weight through the swoop
        if (this.swoopLeg >= 2 && this.turn) {
          // ← → slide you across the back of the neck, to put the nape back on your line
          const toN = _c.subVectors(nw.center, p).normalize();
          const across = this._right(_a); across.addScaledVector(toN, -across.dot(toN));
          acc.addScaledVector(across, this.turn * CFG.combat.swoopSteer);
          A.addScaledVector(across, this.turn * CFG.combat.swoopSteer * 0.25 * dt);
        }
      }
    } else for (const hk of odm.hooks) hk.payout = climbing && hk.attached && hk !== this._climb!.hook ? 40 : 0;

    // gas thrust
    const wish = this._wish(_b);
    if (this.boosting) {
      // thrust along the heading (a little lift so you don't plough into the ground); on a rope, along the swing
      const dir = _c;
      if (anchored && speed > 8) dir.copy(v).multiplyScalar(1 / speed).addScaledVector(this._heading(_e), 0.6);
      else { this._heading(dir).multiplyScalar(this.wishF < 0 ? -0.4 : 1); dir.y = 0.22 + Math.max(0, this.pitch) * 0.8; }
      if (this.turn) dir.addScaledVector(this._right(_e), this.turn * 0.45);
      dir.normalize();
      acc.addScaledVector(dir, anchored ? CFG.gas.hookedBoostAccel : CFG.gas.boostAccel);
      if (!this.infiniteGas) odm.gas -= CFG.gas.boostRate * dt;
    }
    if (!this.infiniteGas) odm.gas = Math.max(0, odm.gas);

    const fwdSpeed = v.x * Math.sin(this.yaw) + v.z * Math.cos(this.yaw);
    if (footing && this.wishF < 0 && fwdSpeed > 2.5) {
      // back while running forward is a brake: a short skid to a stop; from a walk or standing it steps you back
      const hs = hypot(v.x, v.z), b = CFG.ground.brake * dt;
      if (hs <= b) { v.x = 0; v.z = 0; } else { v.x -= (v.x / hs) * b; v.z -= (v.z / hs) * b; }
      this.skidding = hs > 3;
      acc.addScaledVector(this.groundN, -2);
    } else if (footing) {
      // running: accelerate toward the wish velocity, skid off excess speed
      const n = this.groundN;
      this.skidding = false;
      // backing up and sidestepping are slower than the run
      const gait = this.wishF < 0 ? 0.55 : this.wishF === 0 && this.wishS ? 0.75 : 1;
      const target = _c.copy(wish).multiplyScalar(CFG.ground.run * gait * (this.stun > 0 ? 0.3 : 1));
      const hv = _e.set(v.x, 0, v.z);
      let hs = hv.length();
      // the run swings round with the heading (speed kept), so the body, the camera and where you're going stay
      // lined up through a bend instead of the body sliding sideways over its feet
      // (skidding in faster than a run, from the air, the feet still pull it round, as hard as the grip allows)
      if (this.wishF > 0 && hs > 0.5) {
        const ang = Math.atan2(v.z * wish.x - v.x * wish.z, v.x * wish.x + v.z * wish.z);   // yaw from v round to the wish
        const rate = hs < CFG.ground.run + 0.5 ? CFG.keys.turnGround * 1.6 : Math.min(CFG.keys.turnGround * 1.6, 1.5 * CFG.ground.maxLateral / hs);
        const r = THREE.MathUtils.clamp(ang, -rate * dt, rate * dt);
        const c = Math.cos(r), sn = Math.sin(r), vx = v.x, vz = v.z;
        v.x = vx * c + vz * sn; v.z = -vx * sn + vz * c;
        hv.set(v.x, 0, v.z);
      }
      if (hs > CFG.ground.run + 0.5 && wish.dot(hv) > 0) {
        // carrying momentum from the air: skid
        v.x -= (v.x / hs) * CFG.ground.skid * dt; v.z -= (v.z / hs) * CFG.ground.skid * dt;
      } else {
        const dx = target.x - v.x, dz = target.z - v.z, dl = hypot(dx, dz);
        const maxStep = CFG.ground.accel * dt * (hs > CFG.ground.run + 0.5 ? 0.4 : 1);
        const s = dl > maxStep ? maxStep / dl : 1;
        v.x += dx * s; v.z += dz * s;
      }
      // coming in faster than a run (a landing off the wires): a crouched slide, boots ploughing the grass
      if (hs > CFG.ground.run + 3) this.skidding = true;
      // stick to slopes
      acc.addScaledVector(n, -2);
      this._branchKeep(v, dt);
    } else if (hanging) {
      // (hanging: handled with the winch above)
    } else if (anchored) {
      // pump the swing: ↑ drives along the heading, ← → swing you around the anchor (perpendicular to the wire)
      const pd = odm.pullDir(p, _c);
      const swing = this.turn || this.wishS;
      if (pd && (this.wishF > 0 || swing)) {
        const w = _e.set(0, 0, 0);
        if (this.wishF > 0) this._heading(w);
        if (swing) w.addScaledVector(this._right(_a), THREE.MathUtils.clamp(swing, -1, 1) * 1.2);
        w.addScaledVector(pd, -w.dot(pd));
        acc.addScaledVector(w, CFG.air.pump);
      }
    } else if (!groundedNow && this.wishF >= 0 && this.stun <= 0) {
      // free flight: the path carves round after the way you face (the body twists, the cape and a puff of gas
      // bend it a little; with Shift the gas swings it round hard), speed kept
      const hs = hypot(v.x, v.z);
      if (hs > 3) {
        const hx = Math.sin(this.yaw), hz = Math.cos(this.yaw);
        const ang = Math.atan2(v.x * hz - v.z * hx, v.x * hx + v.z * hz);       // from the path round to the heading
        if (Math.abs(ang) < 2.6) {
          const lat = this.boosting && hasGas ? CFG.air.carveGas : CFG.air.carve;
          const r = THREE.MathUtils.clamp(-ang, -lat / hs * dt, lat / hs * dt);
          const c = Math.cos(r), sn = Math.sin(r), vx = v.x, vz = v.z;
          v.x = vx * c + vz * sn; v.z = -vx * sn + vz * c;
        }
      }
      if (wish.lengthSq() > 0) acc.addScaledVector(wish, CFG.air.control);
    } else if (this.wishF < 0 && !groundedNow) {
      // ↓ in free flight bleeds off your horizontal speed; it never turns you round
      const hs = hypot(v.x, v.z);
      if (hs > 0.3) { const b = Math.min(CFG.air.control, hs / dt); acc.x -= (v.x / hs) * b; acc.z -= (v.z / hs) * b; }
      if (this.wishR) acc.addScaledVector(this._right(_e), this.wishR * CFG.air.control * 0.8);
    } else if (wish.lengthSq() > 0) {
      acc.addScaledVector(wish, CFG.air.control);
    }

    v.addScaledVector(acc, dt);

    // landing assist: about to hit a surface head-on while flying fast (on the wires, on gas, or just carrying
    // speed)? the front vents fire and bleed off the closing speed, so you land on the trunk instead of stopping
    // dead against it
    if ((anchored || this.boosting || v.length() > CFG.reel.arrive + 4) && hasGas && !groundedNow) {
      const sp = v.length();
      if (sp > CFG.reel.arrive) {
        const look = (sp * sp) / (2 * CFG.reel.brake) + 3;
        const hit = this.collision.raycast(p, _c.copy(v).multiplyScalar(1 / sp), look, { dynamic: false });
        const cosI = hit ? -hit.normal.dot(_c) : 0;
        // (just carrying speed, it's trunks and walls the vents save you from; a fall onto the ground is yours)
        if (hit && cosI > 0.35 && (anchored || this.boosting || hit.normal.y < 0.6)) {
          const vn = -v.dot(hit.normal);
          // distance to go along the normal before the body sphere touches
          const dn = Math.max(0.05, hit.distance * cosI - CFG.radius - 0.1);
          const allowed = CFG.reel.arrive + Math.sqrt(2 * CFG.reel.brake * Math.max(0, dn - 0.5));
          if (vn > allowed) {
            // the deceleration it actually takes to arrive at `arrive` speed: gentle when seen early, hard (up to
            // brakeHard) when a trunk swings into view close up, so you never slam in at full speed unbraked
            const need = (vn * vn - CFG.reel.arrive * CFG.reel.arrive) / (2 * dn);
            const b = Math.min(CFG.reel.brakeHard, Math.max(need, Math.min(CFG.reel.brakeMax, (vn - allowed) * 12)));
            v.addScaledVector(hit.normal, Math.min(b * dt, vn - CFG.reel.arrive * 0.5));
            this.odm.braking = 0.15;
            if (b > CFG.reel.brakeMax) this._hardBrake = Math.max(this._hardBrake || 0, b);
          }
        }
      }
    }

    // integrate with swept substeps: never move more than 0.3 m per sub-step
    const travel = v.length() * dt;
    const hs0 = hypot(v.x, v.z);
    const n = Math.min(12, Math.max(1, Math.ceil(travel / 0.3)));
    const h = dt / n;
    this._hitN = 0;
    this._floorNext = null;
    let groundedStep = false;
    this.wallN = null as THREE.Vector3 | null;   // (_contacts sets it)
    for (let i = 0; i < n; i++) {
      p.addScaledVector(v, h);
      odm.constrain(p, v, h);
      if (this._contacts(p, v, dt)) groundedStep = true;
    }
    // auto-vault: running into something waist-high (a parapet, rubble, a cart) hops you over it
    if (groundedStep && this.wallN && this.wishF > 0 && !anchored && this.stun <= 0) {
      const f = this._heading(_c);
      if (this.wallN.dot(f) < -0.5) {
        _e.copy(p).addScaledVector(f, 0.9).y += 1.9;
        const top = this.collision.raycast(_e, _a.set(0, -1, 0), 2.6, { dynamic: false });
        const rise = top ? top.point.y - (p.y - CFG.radius) : 0;
        if (top && top.normal.y > 0.7 && rise > 0.25 && rise < 1.8) {
          v.y = Math.max(v.y, Math.sqrt(2 * CFG.gravity * (rise + 0.45)));
          v.addScaledVector(f, 2.5);
          groundedStep = false; this.grounded = false; this.groundTime = 1;
        } else if (!top && this.wallN.dot(f) < -0.75 && hs0 > 8 && this._wallRunCd <= 0 && this._wallC && !this._wallC.dynamic && Math.abs(this.wallN.y) < 0.35) {
          // a tall wall, hit at a run: straight up it
          if (this._runUp(_a.set(this.wallN.x, 0, this.wallN.z).normalize(), hs0, this._wallC.material || 'stone')) groundedStep = false;
        }
      }
    }
    // in the air, a wall under your boots and forward held: run along it, or up it
    if (!groundedStep && !this.grounded && this.wallN && this.wishF > 0 && !anchored && this.stun <= 0 && this._wallRunCd <= 0 && !this.cling) this._wallEntry(hs0);
    if (groundedStep && this.airTime > 0.35) this._landT = Math.min(1, (this._preLandSpeed || 0) / 30) + 0.001;
    this._preLandSpeed = v.length();
    if (groundedStep) { this.grounded = true; this.groundTime = 0; this._floorC = this._floorNext; }
    else if (!this.grounded) this._floorC = null;
    else { this.groundTime += dt; if (this.groundTime > CFG.ground.coyote) this.grounded = false; }
    if (this.grounded) this.airTime = 0; else this.airTime += dt;

    // timers
    this.dashCd -= dt; this.mountCd -= dt; this.stun -= dt; this.grabImmune -= dt; this.impactCooldown -= dt;
    this._wallRunCd -= dt; this.rush -= dt;
    if (this.grip < 1) { this.grip = Math.min(1, this.grip + dt * (this.grounded ? 0.6 : 0.25)); if (this.grip > 0.6) this._gripTold = false; }
    if (this._dashPuff > 0) this._dashPuff -= dt;
    if (this.swapT > 0) { this.swapT -= dt; if (this.swapT <= 0) this.blade = 1; }
    this.hp = regenerate(this.hp, dt, this.game.time - this.lastHurt, ZN.regenDelay, ZN.regenRate);
    this.stats.topSpeed = Math.max(this.stats.topSpeed, this.speed);

    this._bounds();
  }

  /**
   * Running along a branch: your feet stay on it. Heading anywhere near along it, the run follows the branch (and
   * eases you back onto its top), and you slow to a stop short of the tip instead of running off the end. Turn to
   * face off its side (or jump) to leave it.
   */
  _branchKeep(v: THREE.Vector3, dt: number): void {
    const c = this._floorC;
    if (!c || c.type !== 'capsule' || c.r > 2.5) return;
    const ax = c.b.x - c.a.x, az = c.b.z - c.a.z, Lh = hypot(ax, az);
    if (Lh < 2) return;
    const ux = ax / Lh, uz = az / Lh;
    const facing = Math.sin(this.yaw) * ux + Math.cos(this.yaw) * uz;
    if (Math.abs(facing) < 0.45) return;   // facing off its side
    const p = this.pos;
    const t = THREE.MathUtils.clamp(((p.x - c.a.x) * ux + (p.z - c.a.z) * uz) / Lh, 0, 1);
    // along it only, eased back over its top line
    let along = v.x * ux + v.z * uz;
    const ox = p.x - (c.a.x + ax * t), oz = p.z - (c.a.z + az * t);
    const lat = ox * -uz + oz * ux;                                          // sideways off the top line
    // short of the end you're heading for: no faster than you can stop in (0.6 m short of the tip). Only when you
    // aren't walking on toward it: holding ↑ at the end, you step off the tip (a branch end, a cannon's muzzle)
    const walkingOff = this.wishF > 0 && facing * along > 0;
    const toEnd = (along >= 0 ? 1 - t : t) * Lh - 0.6;
    const vmax = Math.sqrt(2 * CFG.ground.brake * Math.max(0, toEnd));
    if (!walkingOff && Math.abs(along) > vmax) { along = Math.sign(along) * vmax; this.skidding = vmax < 1 && Math.abs(along) > 0.5; }
    const back = THREE.MathUtils.clamp(lat * 4, -2, 2);                     // m/s back toward the top line
    v.x = ux * along + uz * back;
    v.z = uz * along - ux * back;
  }

  /** Push the sphere out of everything it overlaps; returns true if standing on something. */
  _contacts(p: THREE.Vector3, v: THREE.Vector3, dt: number): boolean {
    const R = CFG.radius;
    let grounded = false;
    for (let it = 0; it < 3; it++) {
      const cs = this.collision.collideSphere(p, R);
      if (!cs.length) break;
      let any = false;
      for (const c of cs) {
        if (c.depth <= 1e-5) continue;
        any = true;
        p.addScaledVector(c.normal, c.depth);
        const vn = v.dot(c.normal);
        if (vn < 0) {
          // impact
          if (-vn > CFG.impact.feel && this.impactCooldown <= 0) this._impact(-vn, c);
          v.addScaledVector(c.normal, -vn);
          // surface friction: strong on floors when not anchored, slick on walls (wall-running on a wire)
          const tang = _e.copy(v);
          const ts = tang.length();
          if (ts > 1e-4) {
            const floor = c.normal.y > 0.6;
            // standing (resting contact, no run input) grips, so you don't skate off a round branch; landings and
            // the run controller keep their own feel
            const mu = floor ? (this.odm.attachedCount() && !this._footing ? 0.15 : !this.wishF && -vn < 1.5 ? 0.6 : 0.0) : 0.06;
            const dv = Math.min(ts, -vn * mu);
            v.addScaledVector(tang, -dv / ts);
          }
        }
        if (c.normal.y > 0.6) { grounded = true; this.groundN.copy(c.normal); this._floorNext = c.collider; }
        else if (Math.abs(c.normal.y) < 0.6) { this.wallN = (this.wallN || new THREE.Vector3()).copy(c.normal); this.wallTime = 0.15; this._wallC = c.collider; }
        if (c.collider?.dynamic && c.collider.userData?.titan) this._touchTitan = c.collider.userData.titan;
      }
      if (!any) break;
    }
    return grounded;
  }

  _impact(speed: number, contact: { normal: THREE.Vector3; collider: Collider | null }): void {
    this.impactCooldown = 0.35;
    // felt, never hurt: hitting the ground, a trunk, a wall or a titan's hide doesn't damage you (titans' attacks do)
    const floor = contact.normal.y > 0.6;
    const s = THREE.MathUtils.clamp((speed - CFG.impact.feel) / 40, 0, 1);
    this.cam.trauma = Math.min(1, this.cam.trauma + 0.1 + s * 0.75);
    this.game.audio?.impact?.(Math.max(0.15, s));
    this.game.fx?.impact?.(this.pos.clone().addScaledVector(contact.normal, -CFG.radius), contact.normal, contact.collider?.material || 'ground');
    if (!floor && speed > CFG.impact.wall) this.crouch = Math.max(this.crouch, 0.5);
    if (speed > CFG.impact.stun) { this.stun = 0.45; this.odm.releaseAll(); }
  }

  _bounds(): void {
    const p = this.pos, v = this.vel;
    const push = (val: number, lo: number, hi: number): number => (val < lo ? lo - val : val > hi ? hi - val : 0);
    const bx = push(p.x, -1100, 1100), bz = push(p.z, -650, 1050 + FS);
    if (bx) { v.x += bx * 4 * (1 / 60); if (Math.sign(v.x) !== Math.sign(bx)) v.x *= 0.96; }
    if (bz) { v.z += bz * 4 * (1 / 60); if (Math.sign(v.z) !== Math.sign(bz)) v.z *= 0.96; }
    if (p.y > 420) v.y = Math.min(v.y, 0);
    if (p.y < -50) this.hurt(1, 'fell');
  }

  hurt(amount: number, cause: string): void {
    if (!this.alive || this.game.mode === 'menu' || this.game.cutscene) return;
    if (this.game.mode === 'free') amount *= 0.25;
    this.hp -= amount; this.lastHurt = this.game.time;
    this.game.audio?.hurt?.();
    this.game.events.emit('player:hurt', { amount, cause });
    if (this.hp <= 0) this.die(cause);
  }

  die(cause: string): void {
    if (!this.alive) return;
    this.hp = 0; this.alive = false;
    this.odm.releaseAll(true);
    this.game.events.emit('player:died', { cause });
  }

  // ---------------------------------------------------------------- titan interaction (contract)
  grab(titan: GrabberLike, hand: THREE.Object3D): boolean {
    if (this.game.cutscene) return false;
    if (!this.alive || this.grabbedBy || this.grabImmune > 0) return false;
    if (this.riding) { this.riding.rider = null; this.riding = null; this.mounting = null; }
    this.grabbedBy = titan; this.grabHand = hand; this.struggle = 0;
    this.odm.releaseAll(true);
    this.vel.set(0, 0, 0);
    this.cam.trauma = Math.min(1, this.cam.trauma + 0.6);
    this.game.audio?.grabbed?.();
    this.game.events.emit('player:grabbed', { titan });
    return true;
  }
  _followHand(): void {
    const h = this.grabHand;
    if (!h || !this.grabbedBy || this.grabbedBy.alive === false) { this._release(); return; }
    // held round the waist in the fist: the body runs along the fist, head out of the thumb side
    const G = this._grip || (this._grip = { on: false, up: new THREE.Vector3(), face: new THREE.Vector3() });
    G.on = !!this.grabbedBy.gripFrame?.(this.pos, G.up, G.face);
    if (G.on) this.pos.addScaledVector(G.up, -CFG.modelLift);
    else h.getWorldPosition(this.pos);
    this.vel.set(0, 0, 0);
    this.struggle = Math.max(0, this.struggle - CFG.combat.grabDecay / CFG.physicsHz);
  }
  _escapeGrab(): void {
    const t = this.grabbedBy;
    this._release();
    t?.onGrabEscape?.();
    this.game.fx?.blood?.(this.pos.clone(), new THREE.Vector3(0, 1, 0), 1.2);
    this.game.audio?.slash?.(true);
    const away = _a.subVectors(this.pos, t?.position || this.pos).setY(0);
    if (away.lengthSq() < 1e-4) away.set(0, 0, 1);
    away.normalize();
    this.vel.copy(away).multiplyScalar(14).setY(10);
    this.blade = Math.max(0, this.blade - 0.25);
    this.game.events.emit('player:escaped', {});
  }
  _release(): void { this.grabbedBy = null; this.grabHand = null; this.grabImmune = 1.6; }
  /** Called by a titan that lets go (blinded, arm severed, killed while holding us). */
  release(): void { if (this.grabbedBy) { this._release(); this.vel.set(0, 4, 0); } }
  eaten(_titan?: unknown): void {
    if (!this.alive) return;
    this._release();
    this.game.audio?.eaten?.();
    this.die('eaten');
  }
  /** Fire a signal round (the arm comes up with the gun; the smoke goes up at 0.45 s). dir tilts it (a green course). */
  fireFlare(color: string, dir: THREE.Vector3 | null = null): void { if (!this.flareA && !this.grabbedBy) this.flareA = { t: 0, color, dir: dir ? dir.clone() : null, fired: false }; }
  applyImpulse(dv: THREE.Vector3, damage = 0): void {
    if (!this.alive || this.grabbedBy) return;
    this.vel.add(dv);
    this.cam.trauma = Math.min(1, this.cam.trauma + 0.35);
    if (damage) this.hurt(damage / 100, 'struck');
  }

  // ---------------------------------------------------------------- per-frame (variable dt)
  update(dt: number, alpha: number): void {
    const game = this.game;
    this.render.lerpVectors(this.prev, this.pos, alpha);
    const v = this.vel, speed = v.length();

    // blades & combat
    if (this.slashT >= 0) {
      // the blades are live for most of the sweep, and they bite deepest mid-sweep with the nape square in it: the
      // cut lands at the best moment of the swing (when the nape is closest to the middle of the sweep), so a swing
      // timed to meet it cuts clean, and one that's early or late only catches it on the edge and cuts shallow
      this.slashT += dt;
      const st = CFG.combat.slashTime, u = this.slashT / st;
      if (!this.slashHit && u > 0.15 && u < 0.85) {
        const pr = this._bladeProbe(CFG.combat.reach + speed * 0.025, false, !this._arcShown);
        this._arcShown = true;
        // the blades cut at the speed you carried into the sweep (hitting the neck a moment later doesn't blunt it)
        this._cutSpeed = Math.max(this._cutSpeed || 0, speed);
        if (pr) { pr.q = pr.score * (0.4 + 0.6 * Math.sin(Math.PI * u)); pr.speed = this._cutSpeed; }
        if (pr && (!this._cutBest || pr.q >= this._cutBest.q)) this._cutBest = pr;
        else if (this._cutBest) { this._applyCut(this._cutBest, false, this._cutBest.q); this.slashHit = true; }
      }
      if (!this.slashHit && u >= 0.85 && this._cutBest) { this._applyCut(this._cutBest, false, this._cutBest.q); this.slashHit = true; }
      if (this.slashT > st) { this.slashT = -1; this._cutBest = null; }
    }
    if (this.spin) {
      this.spinT += dt;
      if (this.spinT > CFG.combat.spinInterval) { this.spinT = 0; this._strike(CFG.combat.reach + 1 + speed * 0.02, true); }
    } else this.spinT = CFG.combat.spinInterval;

    // rope auto-targets (one side per frame) and the combined aim summary for the HUD
    this._scanSide ^= 1;
    this._scan(this._scanSide);
    const tL = this.targets[0], tR = this.targets[1];
    const tb = tL.valid && (!tR.valid || tL.distance <= tR.distance) ? tL : tR;
    this.aim.valid = tL.valid || tR.valid;
    if (this.aim.valid) { this.aim.point.copy(tb.point); this.aim.distance = tb.distance; this.aim.collider = tb.collider; }
    this.aim.lockTitan = !!(tL.titan || tR.titan);

    // body orientation for the model
    const anchored = this.odm.attachedCount();
    const tf = _a;
    if (this.grounded && (!anchored || this._footing)) {
      // running: the body faces where you steer (the velocity swings round after it); coasting: where you're sliding
      tf.set(v.x, 0, v.z);
      const hs = tf.length();
      if (tf.lengthSq() < 0.5 || this.wishF !== 0 || this.turn) {
        tf.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        // ...but never more than ~35° off the way you're actually moving: carrying speed in at an angle (a landing,
        // a skid) the body turns into the slide rather than running sideways over its own feet
        if (hs > 3) {
          const ang = Math.atan2(tf.x * v.z - tf.z * v.x, tf.x * v.x + tf.z * v.z);   // from the facing round to v
          const ex = Math.abs(ang) - 0.6;
          if (ex > 0) tf.applyAxisAngle(UP, -Math.sign(ang) * ex * THREE.MathUtils.smoothstep(hs, 3, 6));
        }
      }
    } else if (speed > 2.5) {
      // fly along the velocity, but never a pure vertical dive: keep a heading so the pose stays readable. In free
      // flight the body twists round to face where you're looking (the path carves after it)
      this._airLook = (this._airLook || 0) + ((!anchored && this.turn ? 1 : 0) - (this._airLook || 0)) * damp(this.turn ? 6 : 1.5, dt);
      tf.copy(v).multiplyScalar(1 / speed).addScaledVector(_e.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)), anchored ? 0.25 : 0.55 + 2.2 * this._airLook);
    } else tf.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    if (this.riding) {
      tf.set(Math.sin(this.riding.yaw), 0, Math.cos(this.riding.yaw));
      const M = this.mounting;
      if (M && !M.air) {
        const q = M.t / M.dur, w = 1 - THREE.MathUtils.smoothstep(q, 0.25, 0.75);
        _e.set(-M.off.x, 0, -M.off.z); if (_e.lengthSq() > 1e-4) tf.addScaledVector(_e.normalize(), 0.3 * w);   // a quarter-turn in to the flank, no more
      }
    }
    // coming in to land: swing upright and feet-first before touchdown (never a head-first dive into the ground)
    this.landPrep = 0;
    if (!this.grounded && !anchored && v.y < -2) {
      const below = this.collision.raycast(this.render, _e.set(0, -1, 0), 40, { dynamic: false });
      if (below && below.normal.y > 0.5) {
        const tti = (below.distance - CFG.radius) / -v.y;           // seconds until touchdown
        this.landPrep = THREE.MathUtils.clamp(1 - (tti - 0.15) / 0.55, 0, 1);
      }
    }
    if (this.perch) this.landPrep = 1;
    if (this.landPrep > 0) {
      const hx = v.x, hz = v.z, hl = hypot(hx, hz);
      _e.set(hl > 0.5 ? hx / hl : Math.sin(this.yaw), 0, hl > 0.5 ? hz / hl : Math.cos(this.yaw));
      tf.normalize().lerp(_e, this.landPrep);
    }
    tf.normalize();
    this.forward.lerp(tf, damp(this.riding ? 30 : this.grounded ? 40 : this.landPrep > 0 ? 12 : 7 + 9 * (this._airLook || 0), dt)).normalize();
    const upT = _b.copy(UP);
    const pd = this.odm.pullDir(this.render, _c);
    if (pd && !this.grounded) upT.lerp(pd, 0.55);
    if (this.wallN && this.wallTime > 0 && anchored) upT.copy(this.wallN);
    if (this.riding) this.riding.up(upT);
    if (this.cling && (this.cling.move > 0.08 || !anchored)) {
      // climbing (or hanging on by your hands): chest to the wall, leaning out a little
      upT.copy(UP).addScaledVector(this.cling.n, 0.3);
      this.forward.lerp(_d.copy(this.cling.n).negate(), damp(14, dt)).normalize();
    } else if (this.cling) {
      // standing on the side of the trunk: feet on the bark, body out level, facing along the heading
      upT.copy(this.cling.n);
      const cf = _d.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); cf.addScaledVector(this.cling.n, -cf.dot(this.cling.n));
      if (cf.lengthSq() < 1e-3) cf.set(0, 1, 0);
      this.forward.copy(cf.normalize());
    }
    if (this.wallRun) {
      // sprinting along the wall: feet on it, the body leaning out from it
      upT.copy(UP).multiplyScalar(0.72).addScaledVector(this.wallRun.n, 0.7);
      this.forward.lerp(this.wallRun.dir, damp(18, dt)).normalize();
    }
    if (this.landPrep > 0) upT.lerp(UP, this.landPrep);
    upT.addScaledVector(this.forward, -upT.dot(this.forward));
    if (upT.lengthSq() < 1e-3) upT.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).addScaledVector(this.forward, -0.0);
    upT.normalize();
    this.bodyUp.lerp(upT, damp(this.riding ? 20 : this.landPrep > 0 ? 14 : 6, dt)).normalize();
    this.wallTime -= dt;

    if (this.model) {
      const hooks = this.odm.hooks.map((h) => ({ attached: h.attached, anchor: h.attached ? h.anchor : null, state: h.state }));
      const onWall = !!this.wallRun || (!!this.cling && this.cling.move > 0.08);
      const run = this.riding ? 0 : onWall ? (this.wallRun ? 1 : 0.4 + 0.6 * this.cling!.move) : this.grounded ? Math.min(1, hypot(v.x, v.z) / CFG.ground.run) : (this.wallN && anchored ? 1 : 0);
      const slash = this.slashT >= 0 ? this.slashT / CFG.combat.slashTime : -1;
      this.boostLevel += ((this.boosting || this._dashPuff > 0 ? 1 : 0) - this.boostLevel) * damp(18, dt);
      this.crouch = Math.max(0, this.crouch - dt * 2.6);
      let mf = this.forward, mu = this.bodyUp;
      // on foot, sidestepping or backing up: the body turns to run where it's going (the camera keeps your heading)
      const hsp = hypot(v.x, v.z);
      if (this.grounded && !this.riding && hsp > 1.2 && (this.wishS || this.wishF < 0) && !this.skidding) {
        this._moveF.set(v.x / hsp, 0, v.z / hsp);
        mf = this._moveF;
      }
      if (this.grabbedBy && this._grip?.on) {
        mf = this.forward.copy(this._grip.face); mu = this.bodyUp.copy(this._grip.up);
      } else if (this.flipT > 0) {
        this.flipT -= dt;
        const k = 1 - Math.max(0, this.flipT) / CFG.release.flipTime;
        const ang = (k * k * (3 - 2 * k)) * Math.PI * 2;           // eased full forward somersault
        const ax = _q2.setFromAxisAngle(_a.crossVectors(this.forward, this.bodyUp).normalize(), -ang);
        mf = this._flipF.copy(this.forward).applyQuaternion(ax);
        mu = this._flipU.copy(this.bodyUp).applyQuaternion(ax);
      }
      this.model.update(dt, {
        riding: this.riding ? 1 - this.rideStand : 0, crouch: this.grounded ? this.crouch : 0, landPrep: this.straddle > 0.05 ? 0 : this.landPrep,
        mount: this.mounting ? this._mountS(this.mounting) : null, straddle: this.straddle || 0,
        horseGallop: this.riding?.gallop || 0, horsePhase: this.riding?.phase || 0,
        position: this._modelPos.copy(this.render).addScaledVector(this.bodyUp, CFG.modelLift), velocity: v, forward: mf, up: mu,
        grounded: this.grounded || onWall, running: run, hooks, boosting: this.boostLevel, slash,
        spin: this.spin, grabbed: !!this.grabbedBy, blades: this.blade > 0 && this.swapT <= 0 && !(this.riding && this.rideStand < 0.5), speed,
        alive: this.alive, flare: flareStep(this, dt),
      });
      if (this.model.root) this.model.root.visible = this.alive || !!this.grabbedBy;
    }

    // a wire snapping taut: feel it
    if (this.odm.snap > 0) {
      const k = Math.min(1, this.odm.snap / 25);
      this.cam.trauma = Math.min(1, this.cam.trauma + 0.15 + k * 0.25);
      if (game.audio?.wireSnap) game.audio.wireSnap(k); else game.audio?.impact?.(k * 0.5);
      this.odm.snap = 0;
    }
    // skidding to a stop on ↓: knees bent, heels dug in, dust off the feet
    if (this.skidding && this.grounded) {
      this.crouch = Math.max(this.crouch, 0.4);
      this._skidT = (this._skidT || 0) - dt;
      if (this._skidT <= 0) {
        this._skidT = 0.07;
        const hs = hypot(this.vel.x, this.vel.z);
        _sk1.copy(this.render).addScaledVector(this.groundN, -CFG.radius);
        if (game.fx?.skidDust && hs > 2) game.fx.skidDust(_sk1, _sk2.set(this.vel.x / hs, 0, this.vel.z / hs), hs);
        else game.fx?.impact?.(_sk1, this.groundN, 'ground');
      }
    }
    // landing dust
    if (this._landT > 0) {
      const s = this._landT; this._landT = 0;
      this.crouch = Math.max(this.crouch, 0.35 + s * 0.65);   // knees take the landing
      // a hard, fast landing digs a streak into the ground
      const lhs = hypot(this.vel.x, this.vel.z);
      if (lhs > 9 && game.fx?.skidDust) game.fx.skidDust(_sk1.copy(this.render).addScaledVector(this.groundN, -CFG.radius), _sk2.set(this.vel.x / lhs, 0, this.vel.z / lhs), lhs);
      game.audio?.land?.(s);
      game.fx?.impact?.(_c.copy(this.render).addScaledVector(this.groundN, -CFG.radius), this.groundN, 'ground');
      if (s > 0.4) this.cam.trauma = Math.min(1, this.cam.trauma + s * 0.3);
    }
    // gas brake vents fire forward (an emergency stop in front of a trunk: a full blast, and you feel it)
    if (this._hardBrake > 0) {
      const k = Math.min(1, (this._hardBrake - CFG.reel.brakeMax) / (CFG.reel.brakeHard - CFG.reel.brakeMax));
      this.cam.trauma = Math.min(1, this.cam.trauma + 0.08 + 0.17 * k);
      this.crouch = Math.max(this.crouch, 0.3);
      game.audio?.setGas?.(1);
      this._hardBrake = 0;
    }
    if (this.odm.braking > 0 && game.fx?.gas) game.fx.gas(_c.copy(this.render).addScaledVector(this.forward, 0.35), this.forward, 0.6);
    // gas puffs
    if ((this.boosting || this._dashPuff > 0) && game.fx?.gas) {
      const np = _c, nd = _d;
      if (this.model?.gasNozzle) this.model.gasNozzle(np, nd);
      else { np.copy(this.render).addScaledVector(this.forward, -0.4); nd.copy(this.forward).negate(); }
      game.fx.gas(np, nd, this._dashPuff > 0 ? 1 : 0.7);
    }

    // wires
    this.launcher(0, this._origins[0]); this.launcher(1, this._origins[1]);
    this.odm.render(this._origins, game.camera, game.time);

    // leaves when blasting through canopies (no collider: we just test the world's foliage callback)
    if (speed > 25 && (game.world as (WorldHandle & { inFoliage?(p: THREE.Vector3): boolean }) | undefined)?.inFoliage?.(this.render) && R.fx() < dt * 20) game.fx?.leaves?.(this.render, 4);

    this._camera(dt);
    this._audio(game._frameDt || dt);
    this._supply(dt);
  }

  /** One blade check that cuts whatever it finds (the spinning slash). Returns true if anything was hit. */
  _strike(radius: number, spin: boolean, showArc = true): boolean {
    const pr = this._bladeProbe(radius, spin, showArc);
    if (!pr) return false;
    this._applyCut(pr, spin, pr.score);
    return true;
  }

  /**
   * Where the blades are this frame and what they would cut: { hits, dir, score } or null. score (0..1) is how
   * squarely the best part sits in the sweep: 1 with the nape in the middle of it, falling off toward its edge.
   */
  _bladeProbe(radius: number, spin: boolean, showArc: boolean): BladeProbe | null {
    if (this.blade <= 0 || this.swapT > 0) { if (!spin && showArc) this.game.audio?.bladeBreak?.(); return null; }
    const hitTest = this.game.hitTest;
    if (!hitTest) return null;
    // reach forward along the motion (or the heading), a generous blur of steel
    const look = this._heading(_a);
    const dir = this.speed > 6 ? _b.copy(this.vel).normalize().lerp(look, 0.35).normalize() : _b.copy(look);
    // the blades cut where you are going: no aim assist, the nape has to be in the sweep when you swing
    const center = _c.copy(this.render).addScaledVector(dir, spin ? 0.6 : 1.3);
    if (showArc && this.game.fx?.slashArc && (!spin || R.fx() < 0.5)) {
      _q.copy(this.game.camera.quaternion).multiply(_q2.setFromAxisAngle(_a.set(0, 0, 1), (R.fx() - 0.5) * 1.6));
      this.game.fx.slashArc(_e.copy(this.render).addScaledVector(dir, 1.1), _q, radius * 0.7);
    }
    const hits = hitTest(center, radius);
    if (!hits || !hits.length) return null;
    let score = 0;
    for (const h of hits) {
      const nw = h.part === 'nape' ? h.titan.napeWorld?.() as NapeFrame | null : null;
      const dd = (nw?.center || h.point).distanceTo(center);
      const c = 1 - THREE.MathUtils.clamp((dd - 1.6) / Math.max(0.5, radius - 1.6), 0, 1);
      score = Math.max(score, h.part === 'nape' ? c : 0.5 + 0.5 * c);
    }
    return { hits, dir: dir.clone(), score, q: 0, speed: 0 };
  }

  /** Cut what a probe found. q (0..1): how clean the cut is (timing and the sweep); a mistimed one cuts shallow. */
  _applyCut(pr: BladeProbe, spin: boolean, q: number): void {
    const { hits, dir } = pr;
    // best part: nape > eye > ankle > others
    const rank: Record<string, number> = { nape: 5, eye: 4, ankle: 3, hand: 2, arm: 2, body: 1 };
    const seen = new Set<Cuttable>();
    hits.sort((x, y) => (rank[y.part] || 0) - (rank[x.part] || 0));
    for (const hit of hits) {
      if (seen.has(hit.titan) || !hit.titan.alive) continue;
      // the nape is cut from behind: full depth from straight behind the neck, less from beside it, and from in
      // front the blades only find the face or the neck (the next part down the list)
      const angle = hit.part === 'nape' ? this._napeAngle(hit.titan) : 1;
      if (angle < 0.05) continue;
      seen.add(hit.titan);
      const tv = hit.titan.velocity || _e.set(0, 0, 0);
      const rel = pr.speed ? Math.max(pr.speed - tv.length(), 0) : _d.subVectors(this.vel, tv).length();
      const sharp = 0.55 + 0.45 * this.blade;
      const depth = 0.35 + 0.65 * THREE.MathUtils.clamp(q, 0, 1);
      const damage = Math.round((CFG.combat.dmgBase + rel * CFG.combat.dmgPerMs) * sharp * (spin ? 1.1 : 1) * angle * depth);
      const res = (hit.titan.applyHit({ part: hit.part, damage, point: hit.point.clone(), dir: dir.clone() }) || {}) as CutResult;
      res.angle = angle; res.speed = rel; res.timing = q;
      this.blade = Math.max(0, this.blade - CFG.combat.wear * (hit.part === 'nape' ? 1 : 0.35));
      if (res.shatter) this.blade = 0;   // hardened skin: the blades break on it
      this.game.audio?.slash?.(true);
      if (hit.titan.kind !== 'dummy') this.game.fx?.blood?.(hit.point, dir, res.killed ? 2 : 1);
      this.game.events.emit('player:hit', { titan: hit.titan, part: hit.part, damage, result: res, point: hit.point.clone() });
      this.stats.damage += damage;
      if (this.blade <= 0) { this.game.audio?.bladeBreak?.(); this.game.events.emit('player:bladeBroken', {}); }
      this.cam.trauma = Math.min(1, this.cam.trauma + (res.killed ? 0.5 : 0.2));
      if (res.killed) this._killMoment(hit, dir);
    }
  }

  /** How square-on a nape cut from here is: 1 from behind the neck, CFG.combat.napeAngle.side from beside it,
   *  0 from in front. */
  _napeAngle(t: Cuttable): number {
    const nw = t.napeWorld?.() as NapeFrame | null;
    if (!nw?.center || !nw.normal) return 1;
    const r = _e.subVectors(this.render, nw.center), l = r.length();
    if (l < 0.6) return 1;                            // right on it
    const b = r.dot(nw.normal) / l, side = CFG.combat.napeAngle.side;
    return b >= 0 ? side + (1 - side) * Math.min(1, b / 0.45) : side * Math.max(0, 1 + b / 0.35);
  }

  /** The nape cut: freeze-frame, slow motion, a side-on kill cam, a flash, a crescent of steel, blood and steam. */
  _killMoment(hit: HitTestHit, dir: THREE.Vector3): void {
    const g = this.game;
    g.hitstop = 0.09;
    g.slowmo = CFG.kill.slowmo; g.slowmoDur = CFG.kill.slowmo;
    const nape = hit.point.clone();
    // the impact frame: a couple of frames of stark black & white art with lines bursting from the nape (it ends
    // in the white flash); without it, just the flash
    if (g.impactFrame && g.fx?.impactFrame) g.fx.impactFrame(nape, hit.titan.kind === 'dummy' ? 0.85 : 1);
    else g.flash?.(0.55);
    g.fx?.blood?.(nape, dir, 3);
    g.fx?.steam?.(nape, Math.max(2, (hit.titan.height || 8) * 0.3), 2.5);
    if (g.fx?.slashArc) {
      _q.copy(g.camera.quaternion).multiply(_q2.setFromAxisAngle(_a.set(0, 0, 1), -0.5));
      g.fx.slashArc(nape, _q, 3.5);
    }
    this.cam.trauma = Math.min(1, this.cam.trauma + 0.6);
    if (hit.titan.kind !== 'dummy' && (g.time - (this._lastKillCam ?? -99)) > CFG.kill.camCooldown) {
      this._lastKillCam = g.time;
      // frame the cut from the side the soldier is passing on
      const toN = _e.subVectors(nape, this.render).setY(0);
      if (toN.lengthSq() < 1e-4) toN.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      toN.normalize();
      const side = _b.crossVectors(UP, toN).normalize().multiplyScalar(this.vel.dot(_b) >= 0 ? 1 : -1);
      const kc: CutKillCam = { t: 0, dur: CFG.kill.camTime, nape, side: side.clone(), toN: toN.clone(), size: hit.titan.height || 8 };
      g.killCam = kc;
    }
    g.hud?.clearMessage?.(/^WOUNDED|^IT COVERED|^FROM THE SIDE|^MISTIMED|^TOO SLOW/);   // the kill settles what the last cut got wrong
    g.hud?.message?.(hit.titan.kind === 'dummy' ? 'CUT!' : 'NAPE CUT', 1.1, 'big');
  }

  /**
   * Camera beats on top of the chase camera: a snap-zoom and a quick whip-pan toward a rope the moment it bites, and
   * the low-angle "loom" when a big titan is close (the camera drops and looks up at it).
   */
  _camBeats(dt: number): void {
    const c = this.cam, hooks = this.odm.hooks;
    const was = this._camAtt || (this._camAtt = [false, false]);
    for (let i = 0; i < 2; i++) {
      const h = hooks[i], now = h.attached;
      if (now && !was[i] && !this.grounded && this.mouseT > 1.5) {
        // which way it bit, relative to where the camera is looking
        let dy = Math.atan2(h.anchor.x - this.render.x, h.anchor.z - this.render.z) - this.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        c.punch = 1;
        c.whipA = THREE.MathUtils.clamp(dy, -0.7, 0.7) * 0.28; c.whipT = 0;
      }
      was[i] = now;
    }
    c.punch = Math.max(0, (c.punch || 0) - dt * 3.5);
    if (c.whipT !== undefined && c.whipT < 0.4) {
      c.whipT += dt;
      const k = Math.min(1, c.whipT / 0.4);
      c.whip = c.whipA! * Math.sin(Math.PI * k) * (1 - 0.35 * k);   // out fast, settles back
    } else c.whip = 0;
    // loom: the nearest big titan within a few of its heights, standing over you
    let loom = 0;
    if (!this.swooping && !this.grabbedBy) for (const t of (this.game.titans as unknown as { titans: { alive: boolean; position: THREE.Vector3; height: number }[] } | null)?.titans || []) {
      if (!t.alive || !t.position || (t.height || 0) < 8) continue;
      const h = t.height, d = hypot(t.position.x - this.render.x, t.position.z - this.render.z);
      const above = THREE.MathUtils.clamp((t.position.y + h * 0.8 - this.render.y) / (h * 0.5), 0, 1);
      loom = Math.max(loom, (1 - THREE.MathUtils.smoothstep(d, h * 0.8, h * 3)) * THREE.MathUtils.smoothstep(h, 7, 15) * above);
    }
    c.loom = (c.loom || 0) + (loom - (c.loom || 0)) * damp(1.5, dt);
  }

  _camera(dt: number): void {
    const cam = this.game.camera, c = this.cam;
    const speed = this.speed;
    // keyboard camera: in the air the heading eases toward where you are flying (so after whipping round a
    // trunk the view comes with you); the pitch follows the flight path. Mouse look suspends both for a moment.
    const nwCam = this.swooping && this.prey?.alive ? this.prey.napeWorld?.() as NapeFrame | null : null;
    if (this.mouseT > 1.5 && !this.grabbedBy && nwCam?.center) {
      // swooping on a titan: frame its nape (lock-on), so you see the cut coming
      const dx = nwCam.center.x - this.render.x, dz = nwCam.center.z - this.render.z;
      let dy = Math.atan2(dx, dz) - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw += dy * damp(3.2, dt);
      const el = Math.atan2(nwCam.center.y - this.render.y, hypot(dx, dz));
      this.pitch += (THREE.MathUtils.clamp(el * 0.7, -0.6, 0.45) - this.pitch) * damp(3, dt);
    } else if (this.mouseT > 1.5 && !this.grabbedBy) {
      const v = this.vel, hs = hypot(v.x, v.z);
      if (!this.grounded && hs > 7 && !this.turn) {
        let dy = Math.atan2(v.x, v.z) - this.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        if (Math.abs(dy) < 2.6) this.yaw += dy * damp(CFG.keys.followRate * Math.min(1.6, hs / 30), dt);
      }
      const vp = speed > 5 ? Math.asin(THREE.MathUtils.clamp(this.vel.y / speed, -1, 1)) : 0;
      // a big titan close by: the camera looks up at it (a low-angle shot that makes them loom)
      // (clinging to a wall: the view tips up along it, so you see where to climb and where a rope can bite higher up)
      // on foot at the foot of a wall or a trunk the view lifts too, by how close it is
      if ((this._wallLookT -= dt) <= 0) {
        this._wallLookT = 0.15;
        const ahead = this.grounded && !this.riding ? this.collision.raycast(this.render, this._heading(_e), 14, { dynamic: false }) : null;
        this._wallLook = ahead && Math.abs(ahead.normal.y) < 0.35 && ahead.collider.type !== 'ground' ? 1 - ahead.distance / 14 : 0;
      }
      const pitchT = this.cling ? 0.78 : (this.grounded && !this.odm.attachedCount() ? -0.16 + 0.62 * this._wallLook : THREE.MathUtils.clamp(vp * 0.45 - 0.1, -0.55, 0.3)) + 0.22 * (c.loom || 0);
      this.pitch += (pitchT - this.pitch) * damp(2.2, dt);
    }
    this._camBeats(dt);
    // trauma-based shake
    c.trauma = Math.max(0, c.trauma - dt * 1.4);
    const sh = c.trauma * c.trauma;
    const t = this.game.time;
    const shx = (Math.sin(t * 47.3) + Math.sin(t * 31.1 + 1.3)) * 0.5 * sh, shy = (Math.sin(t * 53.7 + 2.1) + Math.sin(t * 29.3)) * 0.5 * sh;

    if (this.grabbedBy) { this._grabCamera(dt, shx, shy); return; }
    this._grabCam = null;
    // (+ the whip-pan: a quick camera-only swing toward a rope that just bit, and back)
    const yaw = this.yaw + shx * 0.03 + (c.whip || 0), pitch = this.pitch + shy * 0.03;
    const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
    const fwd = _a.set(sy * cp, sp, cy * cp);
    const right = _b.set(-cy, 0, sy);
    // distance, glide off walls, bank and lens are hull/kits' follow-camera maths over the `cam` tunables
    const CM = CFG.cam;
    const targetDist = followDistance(CM.dist, speed, CM.distPerSpeed, CM.distSpeedCap, (this.grabbedBy ? 3 : 0) + CM.loomDist * (c.loom || 0));
    c.dist += (targetDist - c.dist) * kitDamp(CM.distRate, dt);
    // pivot: over the shoulder, a bit higher when standing (lower under a looming titan)
    const pivot = _c.copy(this.render).addScaledVector(UP, CFG.cam.height - CM.loomLower * (c.loom || 0)).addScaledVector(right, CFG.cam.side);
    const want = _d.copy(pivot).addScaledVector(fwd, -c.dist);
    // keep the camera out of walls/trees: cast from the body to the wanted spot. The camera glides in to the
    // clear distance instead of popping there (so a trunk flashing between you and it at speed doesn't pull it
    // in 6 m in one frame and straight back out); it only snaps when it would otherwise end up inside something
    const toCam = _e.subVectors(want, pivot);
    const len = toCam.length();
    toCam.multiplyScalar(1 / len);
    // (titans too: swooping round a neck, an arm or a shoulder between you and the camera must not fill the view)
    const block = this.collision.raycast(pivot, toCam, len + 0.4);
    const clear = block ? Math.max(0.4, block.distance - (block.collider.dynamic ? 0.7 : 0.4)) : len;
    const rc = this._reach;
    if (rc.update(len, clear, dt, CM.clearIn, CM.clearOut)) {
      _f.copy(pivot).addScaledVector(toCam, rc.value);
      if (this.collision.collideSphere(_f, 0.2).some((k) => k.depth > 0.02)) rc.value = clear;
    }
    c.reach = rc.value;
    want.copy(pivot).addScaledVector(toCam, rc.value);
    c.pos.copy(want);
    cam.position.copy(c.pos);
    cam.up.copy(UP);
    c.look.copy(pivot).addScaledVector(fwd, 30);
    cam.lookAt(c.look);
    // bank into hard turns (centripetal acceleration from the wire), the camera riding the swing
    let rollT = 0;
    if (this.odm.attachedCount() && !this.grounded) {
      const pd = this.odm.pullDir(this.render, _e);
      // a Dutch angle that leans harder the faster and wider the swing (the frame tilts on big arcs)
      if (pd) rollT = THREE.MathUtils.clamp(pd.dot(right) * Math.min(speed, 70) * CM.rollPerSpeed, -CM.rollMax, CM.rollMax);
    }
    // on a wall the frame leans away from it
    if (this.wallRun) rollT = THREE.MathUtils.clamp(-this.wallRun.n.dot(right) * CM.wallRollMax, -CM.wallRollMax, CM.wallRollMax);
    c.roll += (rollT - c.roll) * damp(this.wallRun ? 7 : 3, dt);
    cam.rotateZ(-c.roll + shx * 0.02);
    // FOV opens with speed
    // (a rope biting punches the lens in for a beat: a snap-zoom on a catch)
    const fovT = followFov(CM.fov, CM.fovMax, speed, CM.fovSpeedLo, CM.fovSpeedHi) - CM.punchFov * (c.punch || 0) + (this.wallRun ? CM.wallRunFov : 0) + (this.rush > 0 ? CM.rushFov : 0);
    c.fov += (fovT - c.fov) * damp((c.punch || 0) > 0.05 ? 16 : 4, dt);
    if (Math.abs(cam.fov - c.fov) > 0.01) { cam.fov = c.fov; cam.updateProjectionMatrix(); }
    this._cineCamera(dt);
    // kill cam: side-on, framing the soldier and the nape, eased in and out (driven by real time in main)
    const kc = this.game.killCam as CutKillCam | null | undefined;
    if (kc) {
      const w = Math.min(1, kc.t / 0.12) * Math.min(1, (kc.dur - kc.t) / 0.3);
      if (w > 0) {
        const R = 6 + kc.size * 0.45;
        const mid = _a.copy(this.render).lerp(kc.nape, 0.55);
        const kp = _b.copy(mid).addScaledVector(kc.side, R).addScaledVector(kc.toN, -R * 0.35).addScaledVector(UP, 1.5 + kc.size * 0.08);
        // drift slowly round the cut while time crawls
        kp.addScaledVector(kc.toN, kc.t * 2.5);
        _q.copy(cam.quaternion);
        cam.position.lerp(kp, w);
        cam.lookAt(mid);
        _q2.copy(cam.quaternion);
        cam.quaternion.copy(_q).slerp(_q2, w);
      }
    }
  }

  /**
   * A mission's director (game.cine): `shot` cuts to a set camera ({ pos(), look(), fov }), `focus` turns the view to
   * look at something, the soldier still in the foreground, the way a rider's head turns to a titan while the horse
   * gallops on (eased in and out). Both are functions, so a shot can follow what it frames.
   */
  _cineCamera(dt: number): void {
    const cam = this.game.camera, c = this.cam, cd = this.game.cine;
    const shot = cd?.shot as CineShot | null | undefined;
    if (shot) {
      cam.position.copy(shot.pos(_e));
      cam.up.copy(UP);
      cam.lookAt(shot.look(_f));
      if (shot.roll) cam.rotateZ(shot.roll);
      const fov = shot.fov || 50;
      if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
      c.cw = 0;
      return;
    }
    // (turning your horse takes the view back from a mission's look-at)
    const want = cd?.focus && !(this.riding && this._reining) ? 1 : 0;
    c.cw = (c.cw || 0) + (want - (c.cw || 0)) * damp(want ? 2.6 : 3.2, dt);
    if (cd?.focus) (c.cf || (c.cf = new THREE.Vector3())).copy(cd.focus(_e));
    if (c.cw < 0.002 || !c.cf) return;
    const w = c.cw * c.cw * (3 - 2 * c.cw);
    // over the shoulder toward it: behind and beside the soldier, looking at the thing
    const piv = _a.copy(this.render).addScaledVector(UP, 1.7);
    const d = _b.subVectors(c.cf, piv); d.y *= 0.25; d.normalize();
    const side = _c.set(-d.z, 0, d.x);
    const pos = _d.copy(piv).addScaledVector(d, -6.5).addScaledVector(side, 1.6).addScaledVector(UP, 1.4);
    _q.copy(cam.quaternion);
    cam.position.lerp(pos, w);
    cam.up.copy(UP);
    cam.lookAt(_f.copy(c.cf).lerp(piv, 0.15));
    _q2.copy(cam.quaternion);
    cam.quaternion.copy(_q).slerp(_q2, w);
    const fov = cam.fov + (54 - cam.fov) * w;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }

  /**
   * Held in a titan's fist: the camera stands off outside it, a little to the side and above, looking back past you
   * at its face, so you see yourself in the hand and the mouth it's bringing you to.
   */
  _grabCamera(dt: number, shx: number, shy: number): void {
    const cam = this.game.camera, c = this.cam, t = this.grabbedBy!, me = this.render;
    const h = t.height || 8;
    const face = t._headWorld ? t._headWorld(_d) : _d.copy(t.position || me).addScaledVector(UP, h * 0.9);
    // frame you in the fist and the face it's bringing you to: stand off from the pair, out to the side the fist
    // is on and a little above, far enough back to fit both (not up against its thigh or chest)
    const mid = _f.copy(me).lerp(face, 0.4);
    const out = _a.subVectors(me, t.position || face).setY(0);
    if (out.lengthSq() < 1e-4) out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).negate();
    out.normalize();
    const side = _b.set(-out.z, 0, out.x);
    const span = me.distanceTo(face);
    const back = Math.max(2.9 + 0.28 * h, span * 1.4);
    const want = _c.copy(mid).addScaledVector(out, back).addScaledVector(side, 0.35 * back).addScaledVector(UP, 0.25 * back);
    // never inside its body: step further out until clear of it
    for (let i = 0; i < 6 && t.hitTest?.(want, 0.6, [])?.length; i++) want.addScaledVector(out, 0.15 * h + 0.6).y += 0.3;
    // and out of walls and trees
    const toCam = _e.subVectors(want, mid), len = toCam.length();
    toCam.multiplyScalar(1 / len);
    const block = this.collision.raycast(mid, toCam, len + 0.4, { dynamic: false });
    if (block) want.copy(mid).addScaledVector(toCam, Math.max(0.8, block.distance - 0.4));
    if (!this._grabCam) this._grabCam = { pos: cam.position.clone(), look: me.clone() };
    const G = this._grabCam;
    G.pos.lerp(want, damp(4, dt));
    G.look.lerp(_d.copy(me).lerp(face, 0.55), damp(8, dt));
    c.pos.copy(G.pos);
    cam.position.copy(G.pos).addScaledVector(UP, shy * 0.05);
    cam.up.copy(UP);
    cam.lookAt(G.look);
    cam.rotateZ(shx * 0.02);
    c.fov += (CFG.cam.fov - c.fov) * damp(4, dt);
    if (Math.abs(cam.fov - c.fov) > 0.01) { cam.fov = c.fov; cam.updateProjectionMatrix(); }
  }

  _audio(_dt?: number): void {
    const a = this.game.audio;
    if (!a) return;
    a.setReel?.(this.reelLevel);
    a.setGas?.(this.boosting ? 1 : this._dashPuff > 0 ? 0.8 : 0);
    a.setWind?.(this.speed);
    const dt = _dt || 1 / 60, sp = this.speed, hs = hypot(this.vel.x, this.vel.z);
    // boots and gear on stone and bark: a wall run, a skid, a slide down a trunk
    const scrape = this.wallRun ? 0.45 + Math.min(0.55, sp / 45) : this.cling && this.cling.move > 0.1 && this.wishF < 0 ? 0.6 : this.skidding && this.grounded ? Math.min(1, hs / 16) : 0;
    a.setScrape?.(scrape);
    // footfalls on the ground (the wall run and the climb count their own)
    if (this.grounded && this._footing && !this.riding && !this.skidding && hs > 2.5) {
      this._stride += hs * dt;
      if (this._stride > 1.25 + hs * 0.085) { this._stride = 0; a.footstep?.(this._floorC?.material || 'ground', 0.3 + Math.min(0.5, hs / 22), false); }
    } else this._stride = Math.min(this._stride, 1);
    // hanging: the wire sings under your weight now and then
    if (this.hang) { this._creakT -= dt; if (this._creakT <= 0) { this._creakT = 1.4 + R.fx() * 2.2; a.wireCreak?.(0.3 + Math.min(0.7, sp / 12)); } }
    // through the sound of the air at about 60 m/s
    if (!this._fast && sp > 60 && !this.grounded) { this._fast = true; a.speedBurst?.(); } else if (this._fast && sp < 46) this._fast = false;
    a.setHeartbeat?.(this.alive ? THREE.MathUtils.clamp((0.45 - this.hp) / 0.35, 0, 1) : 0);
    // how hot the moment is, for the score: speed, a titan close by, a kill chain running
    let near = 1e9;
    for (const t of this.game.titans?.titans || []) if (t.alive) { const d = t.position.distanceTo(this.render); if (d < near) near = d; }
    a.setAction?.(this.alive ? THREE.MathUtils.clamp(Math.min(1, sp / 75) * 0.55 + THREE.MathUtils.clamp(1 - (near - 15) / 70, 0, 1) * 0.35 + (this.rush > 0 ? 0.2 : 0) + (this.game.flow.combo > 1 ? 0.1 : 0), 0, 1) : 0);
    // a trunk, a wall or a limb flashing past close by at speed: you hear it go
    this._passT -= dt;
    if (this._passT <= 0 && sp > 26 && !this.grounded && !this.wallRun) {
      this._passT = 0.07;
      const right = this._right(_c);
      let side = 0;
      for (const sgn of [-1, 1]) {
        const hit = this.collision.raycast(this.render, _d.copy(right).multiplyScalar(sgn), 6.5);
        if (hit) side |= sgn < 0 ? 1 : 2;
      }
      const fresh = side & ~this._passSide;
      if (fresh) a.whoosh?.(Math.min(1, 0.35 + (sp - 26) / 50), fresh === 3 ? 0 : fresh === 1 ? -0.8 : 0.8);
      this._passSide = side;
    } else if (sp <= 26) this._passSide = 0;
    const cam = this.game.camera;
    a.setListener?.(cam.position, _a.set(0, 0, -1).applyQuaternion(cam.quaternion), _b.set(0, 1, 0).applyQuaternion(cam.quaternion));
  }

  /**
   * Resting recovers the kit: standing still on the ground or a roof, perched on a branch, clinging to a trunk, or
   * riding. After a short settle the gas creeps back (empty to full in about 14 s; twice as fast in the saddle at a
   * walk), and every few seconds of rest you fit a fresh pair of blades from the scabbards' spare stock, up to the
   * full load (a dull pair swaps out at once). Boosting, reeling or a rope in flight stops it.
   */
  _rest(dt: number): void {
    if (this.infiniteGas || !this.alive || this.grabbedBy) { this._restT = 0; return; }
    const odm = this.odm;
    const settled = !!this.perch || !!this.cling || this.hang;   // a rope can stay in what you perch, cling or hang on
    const busy = this.boosting || odm.hooks.some((h) => h.state === 'flying' || (h.state === 'attached' && !settled));
    const still = this.speed < 3.5;
    const resting = !busy && (this.riding ? true : (this.grounded || !!this.perch || !!this.cling || this.hang) && still);
    if (!resting) { this._restT = 0; return; }
    this._restT += dt;
    if (this._restT < 0.6) return;
    const calm = this.riding && this.speed < 6;
    if (odm.gas < 1) odm.gas = Math.min(1, odm.gas + (calm ? 0.14 : 0.07) * dt);
    // blades: one spare pair per 3 s of rest (2 s in the saddle at a walk), until the scabbards are full
    if (this.spares < CFG.combat.spares || this.blade <= 0) {
      this._bladeRestT += dt;
      if (this._bladeRestT >= (calm ? 2 : 3)) {
        this._bladeRestT = 0;
        if (this.spares < CFG.combat.spares) this.spares++;
        this.game.audio?.bladeSwap?.();
      }
    } else this._bladeRestT = 0;
    // a dull pair comes off as soon as there's a spare to fit (in the saddle too, where the auto-swap doesn't run)
    if (this.blade <= 0 && this.spares > 0 && this.swapT <= 0) {
      this._swapBlades();
      this.game.hud?.message?.('Fresh blades fitted', 1.2, 'info');
    }
  }

  _supply(dt: number): void {
    this._rest(dt);
    if (!this.infiniteGas && this.odm.gas <= 0.001 && !this._emptyTold) {
      this._emptyTold = true;
      this.game.hud?.message?.('OUT OF GAS: land, stand still or perch, and the canisters refill', 4, 'warn');
    }
    if (this.odm.gas > 0.2) this._emptyTold = false;
    if (!this.infiniteGas && this.odm.gas < 0.25 && !this._lowGasTold) {
      this._lowGasTold = true;
      this.game.hud?.message?.('GAS LOW: rest on a roof or branch to refill, or fly to a supply depot', 4, 'warn');
    }
    if (this.odm.gas > 0.5) this._lowGasTold = false;
    const depots = this.game.world?.supplyDepots;
    if (!depots || !this.alive) return;
    let inside = false;
    for (const d of depots) if (this.render.distanceTo(d.position) < d.radius) { inside = true; break; }
    const needs = this.odm.gas < 0.98 || this.spares < CFG.combat.spares || this.blade < 0.99 || this.hp < 0.99;
    // the depot's dwell and cooldown are hull/kits' stepDepot over the `depot` tunables
    if (stepDepot(this._depot, dt, inside, needs, DEP)) {
      this.odm.gas = fillTo(this.odm.gas, 1, DEP.gas); this.spares = fillTo(this.spares, CFG.combat.spares, DEP.blades);
      this.blade = 1; this.hp = fillTo(this.hp, 1, DEP.bandages);
      this.game.audio?.refill?.();
      this.game.hud?.message?.('RESUPPLIED — gas, blades and bandages', 2.2, 'info');
    }
  }
}
