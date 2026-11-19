// The Titan: procedural rig + AI + animation + hit handling. One instance per titan (see titans.ts for the manager).
// The 60 m giant at the wall (the Behemoth) is a Titan too: kind id 'behemoth' (other systems match on that string).
import * as THREE from 'hull/three';
import { getArchetype, gripGeometry, HAIRS, sizeClass, evapMaterials, skeletonGeometry, bodyMaterial } from './builder';
import type { Archetype, Dims, TitanSpec, SizeClass, EvapMaterials, BoneKey } from './builder';
import { buildRig } from './rig';
import type { Rig, Joints, JointName, RigShape } from './rig';
import { solveArm } from './ik';
import { CFG } from '../config';
import { FS } from '../world/terrain';
import type { Game, Cuttable, HitResult } from '../types';
import type { TitanManager } from './titans';
import type { TitanCollider, TitanCollision, Prey, PreyHook, PreyHorse, Comrade, MaulTarget, Quarry, Temper } from './env';
import { R } from '../sim';
import { titan as TT } from '../tuning';

type Vec3 = THREE.Vector3;

// Math.hypot is variadic and boxes its arguments in hot loops (it was the top source of garbage); this doesn't.
const hypot = (a: number, b: number, c = 0) => Math.sqrt(a * a + b * b + c * c);


const V3 = THREE.Vector3, Q = THREE.Quaternion, EU = THREE.Euler;
const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
const TAU = Math.PI * 2;
const UP = new V3(0, 1, 0);
const ZERO = new V3();
const sm = (x: number) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const wrap = (a: number) => { a %= TAU; if (a > Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU; return a; };
let UID = 0;
/** A new game numbers its titans from 1 again: a titan's seeds come from its number, so the same seed plays the same run. */
export function resetTitanIds(): void { UID = 0; }

/** 'behemoth' is the Behemoth (the id string is shared with the game flow, HUD and comrades). */
export type TitanKind = 'normal' | 'abnormal' | 'behemoth';

export interface TitanOptions {
  kind?: TitanKind;
  height?: number;
  position?: Vec3;
  yaw?: number;
  /** abnormals: crawl on all fours (default: a coin flip) */
  crawler?: boolean;
  /** a fixed design (shifters); otherwise one is drawn from DESIGNS */
  spec?: TitanSpec | null;
}

/** The AI state ('idle', 'wander', 'chase', 'reach', 'grab', ...); subclasses add their own. */
export type TitanState = string;

/** The current action's timeline. Which shape it has depends on the state (see the *Act types below). */
export interface TitanAct { t: number; side?: number; kind?: string; W?: number; [k: string]: unknown }
export interface ReachAct extends TitanAct { side: number; k: number; W: number; E: number; H: number; R: number; pred: Vec3; cur: Vec3; start: Vec3; ally?: Comrade }
export interface GrabAct extends TitanAct { side: number; dur: number; ally?: Comrade; start?: Vec3 }
export interface SwatAct extends TitanAct { side: number; k: number; W: number; S: number; R: number; hit: boolean; p0: Vec3; p1: Vec3; mid: Vec3 }
export interface BiteAct extends TitanAct { W: number; B: number; R: number; hit: boolean }
export interface YankAct extends TitanAct { side: number; hook: number; W: number; R: number; P: number; q: Vec3; start: Vec3; held: boolean }
export interface ShakeAct extends TitanAct { W: number; S: number; flung: boolean }
export interface ChargeAct extends TitanAct { W: number; run: number; hit: boolean }
export interface SlapAct extends TitanAct { kind: 'slap'; side: number; W: number; S: number; R: number; hit: boolean; mid: Vec3 }
export interface HunchAct extends TitanAct { kind: 'hunch'; W: number; H: number }
export interface WhirlAct extends TitanAct { kind: 'whirl'; W: number; T: number }
export type GuardAct = SlapAct | HunchAct | WhirlAct;

export interface LeapState { phase: number; t: number; W: number; T: number; target: Vec3; vx: number; vz: number }
export interface ArmIK { w: number; wT: number; rate: number; tgt: Vec3; pole: Vec3; q1: THREE.Quaternion; q2: THREE.Quaternion }
export interface GripHold { side: number; centre: Vec3; flip: boolean }
interface PlantFoot {
  ball: Vec3; fd: Vec3; from: Vec3; to: Vec3; toBall: Vec3; ankle: Vec3; fdNow: Vec3;
  swing: boolean; timed: boolean; u: number; u0: number; t: number; dur: number; heel: number; pitch: number; fromPitch: number; tRem: number;
}
interface PlantState { init: boolean; drop: number; last: number; feet: PlantFoot[] }

export interface TitanHit { part?: string; damage?: number; point?: Vec3 | null; dir?: Vec3 | null; [k: string]: unknown }
export interface TitanHitResult extends HitResult { covered?: boolean; wound?: number }
export type TitanHitPart = 'nape' | 'eye' | 'ankle' | 'hand' | 'arm' | 'leg' | 'body';
export interface TitanHitTest { titan: Titan; part: TitanHitPart; point: Vec3 }
export type NapeFrame = { center: Vec3; normal: Vec3 };

// ---- keyboard-play tuning (exported for benches / the core): live tunables (tuning.ts, config/tuning/titan.json)
export const TITAN_TUNING = {
  /** s: minimum readable wind-up before every grab reach / swat / bite / leap */
  get WINDUP(): number { return TT.windup; },
  /** m/s: a hand only closes on a player slower than this relative to the hand */
  get GRAB_MAX_REL_SPEED(): number { return TT.grabMaxRelSpeed; },
  /** s: no titan grabs right after the player cuts free */
  get GRAB_BLOCK_AFTER_ESCAPE(): number { return TT.grabBlockAfterEscape; },
  /** s: minimum time between two leaps of one abnormal */
  get LEAP_COOLDOWN(): number { return TT.leapCooldown; },
  /** per second while a leap is possible */
  get LEAP_CHANCE(): number { return TT.leapChance; },
  /** m/s²: titan leaps are heavy */
  get LEAP_G(): number { return TT.leapG; },
};

function mulberry(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['pelvis', 'spine', 'neck', 'head', 'jaw', 'armL', 'foreL', 'armR', 'foreR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'] as const;
/** The posed joints (Euler targets each frame; the hands follow the forearms). */
export type PoseJoint = (typeof NAMES)[number];
export type Euler3 = [number, number, number];

/** A small fixed pool of designs per kind keeps the number of cached archetypes (geometry sets) bounded. */
const DESIGNS: Record<'normal' | 'abnormal', TitanSpec[]> = {
  normal: [
    { build: 'average', skin: 'beige', hair: 0, expr: 'grin' },
    { build: 'average', skin: 'pink', hair: false, expr: 'wide' },
    { build: 'potbelly', skin: 'pink', hair: false, expr: 'grin' },
    { build: 'potbelly', skin: 'tan', hair: 1, expr: 'wide' },
    { build: 'lanky', skin: 'pale', hair: 0, expr: 'grin' },
    { build: 'lanky', skin: 'beige', hair: false, expr: 'wide' },
    { build: 'muscular', skin: 'tan', hair: false, expr: 'grin' },
    { build: 'muscular', skin: 'ruddy', hair: 1, expr: 'wide' },
    { build: 'average', skin: 'tan', hair: 1, expr: 'grin' },
    { build: 'potbelly', skin: 'beige', hair: 0, expr: 'grin' },
  ],
  abnormal: [
    { build: 'gaunt', skin: 'ruddy', hair: 3 % HAIRS.length, expr: 'snarl' },
    { build: 'gaunt', skin: 'pale', hair: false, expr: 'snarl' },
    { build: 'lanky', skin: 'pink', hair: false, expr: 'snarl' },
    { build: 'gaunt', skin: 'beige', hair: 0, expr: 'wide' },
  ],
};

/** Build every titan body (design × size class) up front, so the first spawn of each never hitches mid-fight. */
export function prewarmArchetypes() {
  for (const list of [DESIGNS.normal, DESIGNS.abnormal]) for (const d of list) for (const size of ['S', 'M', 'L'] as const) {
    getArchetype({ ...d, size });
  }
}

export class Titan implements Cuttable {
  readonly mgr: TitanManager;
  readonly game: Game;
  readonly id: number;
  kind: TitanKind;
  /** the Behemoth (kind 'behemoth'): stands at the wall, vents steam, sweeps the wall top */
  isBehemoth: boolean;
  abnormal: boolean;
  height: number;
  /** the AI's own random stream (seeded per titan) */
  rnd: () => number;
  alive = true; dying = false; dead = false;

  // ---- model
  arch: Archetype;
  d: Dims;
  /** this titan's own (tinted) copy of the body material */
  skinMat: THREE.MeshStandardMaterial;
  rig: Rig;
  root: THREE.Group;
  J: Joints;
  /** model scale (world metres per local unit) */
  s: number;
  position: Vec3;
  yaw: number;

  // ---- stats
  napeHp: number; napeDamage = 0;
  runSpeed: number; walkSpeed: number; turnRate: number; noticeRange: number;
  footR: number; armLen: number; shoulderH: number;
  phase0: number; tiltBias: number; mood: number;

  // ---- state
  t = 0;
  state: TitanState = 'idle'; stateT = 0; idleDur: number;
  act: TitanAct | null = null;
  speed = 0; speedTarget = 0; goal: Vec3 | null = null; faceYaw: number | null = null;
  gait: number; _stepIdx = 0;
  home = new V3(); wanderGoal = new V3();
  cdAttack: number; cdGroan: number;
  blindT = 0; crippleT = 0; stunT = 0; flinch = 0; recoil = 0;
  /** s until each forearm (0 = left, 1 = right) grows back; 0 = attached */
  severed = [0, 0];
  /** s until each lower leg (0 = left, 1 = right) grows back; 0 = attached. A titan short of a leg is down (crippleT) */
  sevLeg = [0, 0];
  /** steam timers of the four stumps (arms, then legs) */
  _stumpT = [0, 0, 0, 0];
  /** Down on the ground with a leg gone: 0 standing .. 1 flat, the way it fell (+1 on its chest, -1 on its back),
   *  and whether the thud of landing has been played for this fall. */
  down = 0; downSign = 1; _downHit = false;
  /** not before this (its own clock, s) does it go through another house */
  _smashAt = 0;
  /** each hand: 0 open, 1 fist, 2 closed round a soldier */
  fist = [0, 0];
  grip: GripHold | null = null;
  toP = new V3(); distH = Infinity; dist3 = Infinity; relYaw = 0; hasPlayer = false;
  /** how it thinks (env.ts Temper), drawn at spawn */
  temper: Temper = 'plain';
  /** what it is after: the soldier (onPlayer) or another living thing (quarry); neither = nothing in sight */
  onPlayer = false; quarry: Quarry | null = null;
  /** missions: true keeps the old behaviour (it only ever goes for the player's soldier) */
  fixated = false;
  /** the gate is down and this one is outside: it is heading through the breach into the town */
  march = false;
  /** the Behemoth's errand at the gate (TitanManager.spawn with breach): seconds in, the kick landed, the last flash */
  breach: { t: number; kicked: boolean; flash: boolean } | null = null;
  _qNext = 0; _boredAt = Infinity; _boredUntil = 0;
  /** the temper's own random stream (the AI's sequence stays what it was) */
  rq: () => number = R.sim;
  gy = 0; gp = 0; lookW = 1; lookP = new V3(); _lookOn = false; stepJolt = 0; stepJoltT = 0;
  gazeTarget: Vec3 | null = null;
  stuckT = 0; sideBias = 0; sideT = 0; _lastPos = new V3();
  jawExtra = 0; jawNow: number;
  /** a shifter keeps its mouth shut below this jaw angle unless it means to open it (null: no cap) */
  jawCap: number | null = null;
  vy = 0; airborne = false;
  steaming = false; fadeMats: EvapMaterials | null = null; deathT = 0; fell = false; fallSign = 1;
  rate = 10; legRate = 18; _runK = 0; turnBoost = 1;
  aggroT = 0; cdGuard = 0; guardUrge = 0; napeCover = 0; woundT = 0;
  /** whoever landed the killing cut (set by the player / comrades / missions before applyHit) */
  killedBy: unknown = null;
  /** missions: false freezes the AI; lured titans ignore the escort */
  aiEnabled = true; lured = false;
  /** a mission's target the normal titans are drawn to and maul (else game.escort) */
  drawnTo: MaulTarget | null = null;
  mauling = false; maulT = 0; _escGaze: Vec3 | null = null;
  declare appearT: number | undefined;
  declare plantW: number | undefined;
  _plant: PlantState | null = null;
  declare _evapIdx: number | undefined;
  _evapCol = 0;
  /** set by the game flow / comrades on titans they have seen / paired off on */
  declare _spotted?: boolean;
  declare _squadBy?: number;

  // ---- the Behemoth's vents and sweep
  steamOn = false; steamT = 0; steamDur = 0; steamEmit = 0; steamPush = 0;
  sweepT = -1; sweepCd = 0; sweepSide = 1; sweepHit = false; stepSkip = false;

  // ---- keyboard-play polish (public): ground velocity, hook points, attack threat
  /** world velocity of the root (m/s), smoothed; the player uses it for relative cut speed */
  velocity = new V3();
  /** 0..1: how imminently this titan is attacking the player (1 during a grab/swat/leap wind-up or strike) */
  threat = 0;
  _prevPos = new V3(); _anc = [new V3(), new V3(), new V3(), new V3()];
  _handPrev = [new V3(), new V3()]; _handVel = [new V3(), new V3()]; _handInit = false;
  // abnormals: a crawling gait variant and an occasional leap at the player
  crawler: boolean;
  crawlW: number;
  cdLeap: number;
  leap: LeapState = { phase: 0, t: 0, W: 0.45, T: 1, target: new V3(), vx: 0, vz: 0 };
  // wire grabs, shaking off a soldier hanging on the body, abnormals running down horses
  clingT = 0; cdYank: number; cdCharge: number;

  // ---- pose buffers
  P = {} as Record<PoseJoint, Euler3>;
  tq = {} as Record<PoseJoint, THREE.Quaternion>;
  hipT = new V3(); hipNow = new V3();
  ik: ArmIK[] = [0, 1].map(() => ({ w: 0, wT: 0, rate: 12, tgt: new V3(), pole: new V3(), q1: new Q(), q2: new Q() }));
  colliders: TitanCollider[] = [];

  constructor(mgr: TitanManager, o: TitanOptions) {
    this.mgr = mgr; this.game = mgr.game; this.id = ++UID;
    this.kind = o.kind || 'normal';
    this.isBehemoth = this.kind === 'behemoth';
    this.abnormal = this.kind === 'abnormal';
    this.height = o.height ?? (this.isBehemoth ? 60 : this.abnormal ? 7 : 6);
    const rnd = this.rnd = mulberry(0x9e3779b1 ^ (this.id * 2654435761));

    // ---- model
    let spec: TitanSpec & { size: SizeClass };
    if (this.isBehemoth) spec = { build: 'behemoth', size: 'XL', skin: 'pink', hair: false, expr: 'behemoth' };
    else if (o.spec) spec = { ...o.spec, size: sizeClass(this.height) };
    else {
      const list = this.abnormal ? DESIGNS.abnormal : DESIGNS.normal;
      spec = { ...list[Math.floor(rnd() * list.length)], size: sizeClass(this.height) };
      if (this.height >= 11 && spec.build === 'lanky') spec.build = 'average';
    }
    this.arch = getArchetype(spec);
    this.d = this.arch.dims;
    // a slightly different skin tone per titan (a cosmetic stream, so the AI's random sequence is untouched)
    const cos = mulberry(this.id * 7919 + 13);
    const tk = this.isBehemoth ? 1 : 0.9 + 0.14 * cos(), warm = this.isBehemoth ? 0 : (cos() - 0.5) * 0.09;
    this.skinMat = bodyMaterial(this.isBehemoth, new THREE.Color(tk * (1 + warm), tk, tk * (1 - warm * 1.4)));
    this.rig = buildRig(this.arch, this.height, this.skinMat);
    this.root = this.rig.root; this.J = this.rig.J; this.s = this.rig.scale;
    this.root.rotation.order = 'YXZ';
    this.position = this.root.position;
    this.yaw = o.yaw ?? rnd() * TAU;
    this.root.rotation.y = this.yaw;

    // ---- stats
    const h = this.height;
    this.napeHp = this.isBehemoth ? 2500 : h <= 7 ? 300 : h >= 15 ? 600 : lerp(300, 600, (h - 7) / 8);
    this.runSpeed = 1.4 * Math.sqrt(h) * (this.abnormal ? 2.5 : 1);
    this.walkSpeed = 0.42 * 1.4 * Math.sqrt(h) * (this.abnormal ? 1.3 : 1);
    this.turnRate = (1.7 / Math.sqrt(Math.max(h, 3) / 5)) * (this.abnormal ? 2.2 : 1);
    this.noticeRange = this.abnormal ? 180 : 120;
    this.footR = 0.15 * h;
    this.armLen = (this.d.upperLen + this.d.foreLen) * this.s;
    this.shoulderH = (this.d.hipY + this.d.spineY + this.d.shoulderY) * this.s;
    this.phase0 = rnd() * TAU;
    this.tiltBias = (rnd() - 0.5) * (this.abnormal ? 0.9 : 0.6);
    this.mood = rnd();
    // temperament: its own random stream, so the rest of the AI draws the same numbers it always did
    const rq = this.rq = mulberry(0x51ed270b ^ (this.id * 40503));
    if (this.abnormal) this.temper = 'wild';
    else if (!this.isBehemoth) { const r = rq(); this.temper = r < 0.3 ? 'dull' : r < 0.6 ? 'plain' : r < 0.8 ? 'keen' : 'glutton'; }
    if (this.temper === 'dull') { this.noticeRange *= 0.6; this.runSpeed *= 0.9; this.turnRate *= 0.85; this._boredAt = 9 + rq() * 10; }
    else if (this.temper === 'keen') { this.noticeRange *= 1.35; this.turnRate *= 1.15; this.runSpeed *= 1.08; }

    // ---- state
    this.idleDur = 0.5 + rnd() * 3;
    this.gait = rnd() * TAU;
    this.cdAttack = 1 + rnd(); this.cdGroan = 3 + rnd() * 8;
    this.jawNow = this.arch.jawRest;
    this.crawler = this.abnormal && (o.crawler ?? rnd() < 0.5);
    this.crawlW = this.crawler ? 1 : 0;
    this.cdLeap = this.abnormal ? 3 + rnd() * 5 : Infinity;
    this.cdYank = 2 + rnd() * 3; this.cdCharge = this.abnormal ? 3 + rnd() * 4 : Infinity;

    // ---- pose buffers
    for (const n of NAMES) { this.P[n] = [0, 0, 0]; this.tq[n] = new Q(); }

    // ---- placement
    this.position.copy(o.position || ZERO);
    const gh = this._ground(this.position.x, this.position.z);
    this.position.y = gh;
    this._prevPos.copy(this.position);
    this.home.copy(this.position);
    this.wanderGoal.copy(this.position);
    this._lastPos.copy(this.position);
    this.jawNow = this.arch.jawRest;
    this.J.jaw.rotation.x = this.jawNow;
    this.root.updateMatrixWorld(true);
    this.colliders = [];
    this._registerColliders();
    if (this.isBehemoth) this._initBehemoth();
    this.root.traverse((c) => { if (c instanceof THREE.Mesh) c.userData.titan = this; });
  }

  /** the soldier, seen through the members a titan uses (see env.ts) */
  get _pl(): Prey { return this.game.player as unknown as Prey; }
  /** the collision world, through the members a titan uses */
  get _col(): TitanCollision | null { return (this.game.collision as unknown as TitanCollision) || null; }

  // ====================================================================================== helpers
  _ground(x: number, z: number): number { const c = this._col; return c && c.groundHeight ? c.groundHeight(x, z) : 0; }
  _jpos(name: JointName, out: Vec3): Vec3 { return out.setFromMatrixPosition(this.J[name].matrixWorld); }
  _headWorld(out: Vec3): Vec3 { return this.J.head.localToWorld(out.set(0, this.d.cy, this.d.cz)); }
  _mouthWorld(out: Vec3): Vec3 { return this.J.head.localToWorld(out.copy(this.d.mouthLocal)); }
  /** metres in the titan's yaw frame (x = its left, z = its forward) -> world */
  _fp(x: number, y: number, z: number, out: Vec3): Vec3 { return out.set(x, y, z).applyAxisAngle(UP, this.yaw).add(this.position); }

  _registerColliders(): void { this._addColliders(() => true); }
  _removeColliders(filter?: (c: TitanCollider) => boolean): void {
    const col = this._col;
    if (!col || !col.remove) return;
    const remove = col.remove.bind(col);
    this.colliders = this.colliders.filter((c) => {
      if (filter && !filter(c)) return true;
      remove(c); return false;
    });
  }

  /** Close (on) or open a hand. grip: closed round a soldier (see gripFrame), not an empty fist. */
  _setFist(side: number, on: boolean, grip = false): void {
    const mode = on ? (grip ? 2 : 1) : 0;
    if ((this.fist[side] || 0) === mode) return;
    this.fist[side] = mode;
    const g = this.arch.geo;
    let geo = g[side === 0 ? (on ? 'foreLFist' : 'foreL') : (on ? 'foreRFist' : 'foreR')];
    if (mode === 2) {
      const gg = gripGeometry(this.arch, side === 0 ? 1 : -1, this.s);
      geo = gg;
      this.grip = { side, centre: gg.centre, flip: false };
    } else if (this.grip?.side === side) this.grip = null;
    const m = this.rig.meshes.find((x) => x.key === (side === 0 ? 'foreL' : 'foreR'));
    if (m) m.mesh.geometry = geo.full;
  }

  /**
   * Where a held soldier is (world): `pos` = their waist in the grip, `up` = their body axis out of the thumb side of
   * the fist, `face` = the way they face (out of the palm). False when not gripping anyone.
   */
  gripFrame(pos: Vec3, up: Vec3, face: Vec3): boolean {
    const G = this.grip;
    if (!G) return false;
    const fore = this.J[G.side === 0 ? 'foreL' : 'foreR'];
    pos.copy(G.centre).applyMatrix4(fore.matrixWorld);
    up.set(0, 0, 1).transformDirection(fore.matrixWorld);
    // head out of whichever end of the fist is higher (it only swaps when the fist is near level)
    if (G.flip ? up.y > 0.25 : up.y < -0.25) G.flip = !G.flip;
    if (G.flip) up.negate();
    face.set(G.side === 0 ? -1 : 1, 0, 0).transformDirection(fore.matrixWorld);
    face.addScaledVector(up, -face.dot(up)).normalize();
    return true;
  }

  // ====================================================================================== public API
  /** Hit-test a sphere against this titan's parts. Pushes {titan, part, point} entries into out. */
  hitTest(center: Vec3, radius: number, out: TitanHitTest[]): TitanHitTest[] {
    if (!this.alive) return out;
    const R = this.height * 0.75 + radius + 1;
    if (_t0.copy(this.position).addScaledVector(UP, this.height * 0.5).distanceToSquared(center) > R * R) return out;
    const s = this.s, rl = radius / s;
    const best: Partial<Record<TitanHitPart, { dist: number; point: Vec3 }>> = {};
    for (const sh of this.rig.shapes) {
      if (this._sevPart(sh.joint)) continue;                // (that limb is lying on the ground)
      const p = sh.joint.worldToLocal(_t1.copy(center));
      let dist: number;
      const cp = _t2;
      if (sh.type === 'sphere') { cp.copy(sh.c); dist = p.distanceTo(sh.c) - sh.r; cp.copy(p).sub(sh.c); const l = cp.length(); cp.copy(sh.c); if (l > 1e-6) cp.addScaledVector(_t3.copy(p).sub(sh.c), Math.min(sh.r, l) / l); }
      else if (sh.type === 'capsule') {
        _t3.copy(sh.b).sub(sh.a);
        const tt = clamp(_t4.copy(p).sub(sh.a).dot(_t3) / Math.max(_t3.lengthSq(), 1e-9), 0, 1);
        cp.copy(sh.a).addScaledVector(_t3, tt);
        const l = _t4.copy(p).sub(cp).length();
        dist = l - sh.r; if (l > 1e-6) cp.addScaledVector(_t4.multiplyScalar(Math.min(sh.r, l) / l), 1);
      } else {
        _t3.copy(p).sub(sh.c);
        const cx = clamp(_t3.x, -sh.h.x, sh.h.x), cy = clamp(_t3.y, -sh.h.y, sh.h.y), cz = clamp(_t3.z, -sh.h.z, sh.h.z);
        cp.set(sh.c.x + cx, sh.c.y + cy, sh.c.z + cz);
        dist = hypot(_t3.x - cx, _t3.y - cy, _t3.z - cz);
      }
      if (dist > rl) continue;
      const cat = (sh.part === 'nape' || sh.part === 'eye' || sh.part === 'ankle' || sh.part === 'hand' || sh.part === 'arm') ? sh.part : sh.part === 'leg' || sh.part === 'foot' ? 'leg' : 'body';
      if (!best[cat] || dist < best[cat].dist) best[cat] = { dist, point: sh.joint.localToWorld(cp.clone()) };
    }
    for (const cat of HIT_ORDER) { const b = best[cat]; if (b) out.push({ titan: this, part: cat, point: b.point }); }
    return out;
  }
  _sevPart(joint: THREE.Object3D): boolean {
    const n = joint.name, side = n.endsWith('L') ? 0 : n.endsWith('R') ? 1 : -1;
    if (side < 0) return false;
    if (this.severed[side] > 0 && (n.startsWith('fore') || n.startsWith('hand'))) return true;
    return this.sevLeg[side] > 0 && (n.startsWith('shin') || n.startsWith('foot'));
  }

  napeWorld(): NapeFrame {
    const d = this.d;
    const center = this.J.head.localToWorld(d.napeC.clone());
    const normal = new V3(0, 0.25, -1).normalize().applyQuaternion(this.J.head.getWorldQuaternion(_q0));
    return { center, normal };
  }

  /**
   * Good world-space hook points for auto-targeting: back of the head, both shoulder blades and the upper back
   * just under the nape (where the Outriders anchor to reach it). Pushes 4 Vector3 into out (reused every call:
   * copy them if you keep them). Points sit just inside the torso box / head sphere colliders, so a ray from the
   * player towards one hits this titan's flesh.
   */
  anchors(out: Vec3[] = []): Vec3[] {
    if (!this.alive) return out;
    const d = this.d, A = this._anc, sp = this.J.spine.matrixWorld;
    A[0].set(0, d.cy + 0.15 * d.ry, d.cz - 0.82 * d.rz).applyMatrix4(this.J.head.matrixWorld);
    A[1].set(0.62 * d.shoulderX, d.shoulderY + 0.15, -0.72).applyMatrix4(sp);
    A[2].set(-0.62 * d.shoulderX, d.shoulderY + 0.15, -0.72).applyMatrix4(sp);
    A[3].set(0, d.shoulderY + 0.45, -0.74).applyMatrix4(sp);
    out.push(A[0], A[1], A[2], A[3]);
    return out;
  }

  /** Called when the player cuts itself free of the hand. */
  onGrabEscape(): void {
    this.mgr.grabBlockT = Math.max(this.mgr.grabBlockT || 0, TITAN_TUNING.GRAB_BLOCK_AFTER_ESCAPE);
    if (this.state !== 'grab') { this._releasePlayer(); return; }
    this._setFist(this.act?.side ?? 0, false); this._setFist(1, false); this._setFist(0, false);
    const hp = this._jpos(this.act?.side === 1 ? 'handR' : 'handL', new V3());
    this.game.fx?.blood?.(hp, new V3(0, 1, 0), 1.6);
    this.game.audio?.titanGroan?.(this.position, this.height);
    this.recoil = 1; this.cdAttack = 3.5;
    this.stunT = 1.4;
    this.act = null; this._enter('stun');
  }

  _releasePlayer(): void {
    const al = (this.act as GrabAct | null)?.ally;
    if (al && al.grabbedBy === this) al.freed(this);
    const pl = this._pl;
    if (pl && pl.grabbedBy === this) { if (typeof pl.release === 'function') pl.release(); else pl.grabbedBy = null; }
  }

  applyHit({ part = 'body', damage = 0, point = null, dir = null }: TitanHit = {}): TitanHitResult {
    if (!this.alive) return { killed: false, effect: 'none' };
    this.aggroT = 6;
    const fx = this.game.fx, pt = point ? point.clone() : this._headWorld(new V3());
    const dd = dir ? dir.clone().normalize() : new V3(0, 1, 0);
    if (part === 'head' || part === 'torso' || part === 'pelvis') part = 'body';
    if (part === 'foot') part = 'ankle';
    let effect = 'none', killed = false, covered = false;
    switch (part) {
      case 'nape': {
        damage *= 1 - 0.7 * (this.napeCover || 0);   // hunched: the shoulders come up round the nape
        covered = (this.napeCover || 0) > 0.3;
        if (this.isBehemoth) {
          this.napeDamage += damage;
          if (this.napeDamage >= this.napeHp) { killed = true; effect = 'kill'; } else { effect = 'shallow'; }
        } else if (damage + this.napeDamage >= this.napeHp) { killed = true; effect = 'kill'; }
        else if (damage > 10) {
          // too shallow to kill: it leaves a wound that steams while it closes, and the next cut adds to it
          effect = 'shallow';
          this.napeDamage += damage * CFG.combat.napeWound;
          this.woundT = 1;
          this.game.fx?.steam?.(pt, Math.max(1, this.height * 0.12), 1.2);
          // it knows where you are now: it goes for the back of its neck
          this.guardUrge = Math.max(this.guardUrge || 0, 1);
        } else effect = 'none';
        break;
      }
      case 'eye':
        if (damage >= 25 && !this.isBehemoth) { this.blindT = 6; effect = 'blind'; this._onBlinded(); } else effect = damage > 10 ? 'shallow' : 'none';
        break;
      case 'ankle': case 'leg':
        // through the ankle (easy) or the shin (a real cut): the lower leg comes off and it goes down on that knee
        if (damage >= (part === 'ankle' ? 40 : 110) && !this.isBehemoth) {
          const side = this._legSideOfPoint(pt);
          if (this.sevLeg[side] <= 0) {
            // which way it goes over: a cut from behind pitches it onto its chest, one from in front onto its back
            if (this.down < 0.05) { const f = dd.x * Math.sin(this.yaw) + dd.z * Math.cos(this.yaw); this.downSign = f > 0.15 ? 1 : f < -0.15 ? -1 : this.rq() < 0.6 ? 1 : -1; }
            this.sevLeg[side] = TT.legRegrow; this._onLegSevered(side, dd);
          }
          this.crippleT = Math.max(this.crippleT, this.sevLeg[side]); effect = 'cripple'; this._onCrippled();
        } else effect = damage > 10 ? 'shallow' : 'none';
        break;
      case 'arm': case 'hand':
        if (damage >= 140 && !this.isBehemoth) {
          const side = this._sideOfPoint(pt);
          if (this.severed[side] <= 0) { this.severed[side] = TT.armRegrow; this._onSevered(side, dd); }
          effect = 'sever';
        } else effect = damage > 10 ? 'shallow' : 'none';
        break;
      default: effect = damage > 20 ? 'shallow' : 'none';
    }
    const ga = this.act as GrabAct | null;
    if ((part === 'arm' || part === 'hand') && damage > 25 && this.state === 'grab' && ga?.ally) {
      this._releasePlayer(); this._setFist(ga.side, false); this.act = null; this.stunT = 1.2; this._enter('stun'); effect = effect === 'none' ? 'shallow' : effect;
    }
    if (effect !== 'none') {
      this.flinch = Math.min(1, this.flinch + (effect === 'shallow' ? 0.5 : 1));
      fx?.blood?.(pt, dd, killed ? 3 : effect === 'shallow' ? 1.0 : 1.8);
    }
    if (killed) this._die(pt);
    else if (effect !== 'none' && this.rnd() < 0.35) this.game.audio?.titanGroan?.(this.position, this.height);
    return { killed, effect, covered, wound: part === 'nape' && !killed ? this.napeDamage / this.napeHp : 0 };
  }
  _sideOfPoint(p: Vec3): number {
    const a = this._jpos('handL', _t5).distanceToSquared(p), b = this._jpos('handR', _t6).distanceToSquared(p);
    return a <= b ? 0 : 1;
  }
  _legSideOfPoint(p: Vec3): number {
    const a = this._jpos('footL', _t5).distanceToSquared(p), b = this._jpos('footR', _t6).distanceToSquared(p);
    return a <= b ? 0 : 1;
  }
  /** The lower leg comes off at the knee: the piece falls away (debris.ts) and the stump steams until it regrows. */
  _onLegSevered(side: number, dir: Vec3): void {
    const n = side === 0 ? 'L' : 'R';
    const shin = this.J[`shin${n}`], foot = this.J[`foot${n}`];
    const parts = this.rig.meshes.filter((m) => m.key === `shin${n}` || m.key === `foot${n}`);
    this.mgr.debris.drop(shin, parts.map((m) => ({ mesh: m.mesh, under: m.joint === foot ? foot : null })), this.height, dir, this.velocity);
    for (const m of parts) m.mesh.visible = false;
    shin.scale.setScalar(0.02);
    this._removeColliders((c) => c._shape?.joint === shin || c._shape?.joint === foot);
    const at = this._jpos(`shin${n}`, new V3());
    this.game.fx?.blood?.(at, dir, 2.4);
    this.game.fx?.steam?.(at, this.height * 0.14, 1.8);
    this.game.events?.emit?.('titan:limb', { titan: this, limb: 'leg', side });
  }
  _regrowLeg(side: number): void {
    const n = side === 0 ? 'L' : 'R';
    const shin = this.J[`shin${n}`], foot = this.J[`foot${n}`];
    shin.scale.setScalar(1);
    for (const m of this.rig.meshes) if (m.key === `shin${n}` || m.key === `foot${n}`) m.mesh.visible = true;
    this._addColliders((sh) => sh.joint === shin || sh.joint === foot);
  }
  /** Register the rig shapes `only` picks as colliders (all of them at spawn; a limb's when it has grown back). */
  _addColliders(only: (sh: RigShape) => boolean): void {
    const col = this._col;
    if (!col || !col.addSphere || !col.addCapsule || !col.addBox) return;
    const PART: Record<string, string> = { head: 'body', torso: 'body', pelvis: 'body', leg: 'body', arm: 'arm', hand: 'hand', foot: 'ankle' };
    for (const sh of this.rig.shapes) {
      if (!sh.collide || !only(sh)) continue;
      const userData = { titan: this, part: PART[sh.part] || 'body', sub: sh.part };
      let c: TitanCollider;
      if (sh.type === 'capsule') c = col.addCapsule({ a: sh.a, b: sh.b, radius: sh.r, object3D: sh.joint, dynamic: true, material: 'flesh', userData });
      else if (sh.type === 'sphere') c = col.addSphere({ center: sh.c, radius: sh.r, object3D: sh.joint, dynamic: true, material: 'flesh', userData });
      else c = col.addBox({ center: sh.c, halfExtents: sh.h, object3D: sh.joint, dynamic: true, material: 'flesh', userData });
      c._shape = sh;
      this.colliders.push(c);
    }
  }
  /**
   * A stump, each frame: it steams while it is bare, and for the last TT.grow seconds the new limb pushes out of it
   * inside a cloud of its own steam (the joint swells from nothing to full size).
   */
  _growLimb(slot: number, joint: THREE.Object3D, keys: readonly string[], left: number, dt: number): void {
    const growing = left < TT.grow;
    if (growing) {
      const k = 1 - Math.max(0, left) / TT.grow;
      joint.scale.setScalar(0.05 + 0.95 * k * k * (3 - 2 * k));
      for (const m of this.rig.meshes) if (keys.includes(m.key) && !m.mesh.visible) m.mesh.visible = true;
    }
    if ((this._stumpT[slot] -= dt) > 0) return;
    this._stumpT[slot] = growing ? 0.08 : 0.5;
    const at = joint.getWorldPosition(_t22);
    if (growing) { at.x += (this.rnd() - 0.5) * this.height * 0.08; at.y -= this.rnd() * this.height * 0.1; at.z += (this.rnd() - 0.5) * this.height * 0.08; }
    this.game.fx?.steam?.(at, this.height * (growing ? 0.17 : 0.07), growing ? 1.5 : 0.9);
  }
  _onSevered(side: number, dir: Vec3 = UP): void {
    const j = this.J[side === 0 ? 'foreL' : 'foreR'];
    const hide = this.rig.meshes.find((m) => m.key === (side === 0 ? 'foreL' : 'foreR'));
    // the forearm (hand and all) falls away
    if (hide) this.mgr.debris.drop(j, [{ mesh: hide.mesh, under: null }], this.height, dir, this.velocity);
    this.game.fx?.steam?.(this._jpos(side === 0 ? 'foreL' : 'foreR', new V3()), this.height * 0.12, 1.6);
    this.game.events?.emit?.('titan:limb', { titan: this, limb: 'arm', side });
    j.scale.setScalar(0.02);
    if (hide) hide.mesh.visible = false;
    this._removeColliders((c) => c._shape?.joint === j || c._shape?.joint === this.J[side === 0 ? 'handL' : 'handR']);
    if (this.state === 'grab' && this.act?.side === side) { this._releasePlayer(); this.act = null; this._enter('stun'); this.stunT = 1.2; }
    if (this.state === 'reach' && this.act?.side === side) { this.act = null; this._enter('chase'); }
  }
  _regrow(side: number): void {
    const j = this.J[side === 0 ? 'foreL' : 'foreR'];
    j.scale.setScalar(1);
    const m = this.rig.meshes.find((x) => x.key === (side === 0 ? 'foreL' : 'foreR'));
    if (m) m.mesh.visible = true;
    const hand = this.J[side === 0 ? 'handL' : 'handR'];
    this._addColliders((sh) => sh.joint === j || sh.joint === hand);
  }
  _onBlinded(): void {
    if (this.state === 'grab') this._releasePlayer();
    this.act = null; this._setFist(0, false); this._setFist(1, false);
    this.game.audio?.titanGroan?.(this.position, this.height);
    this._enter('blind');
  }
  _onCrippled(): void {
    if (this.state === 'grab') { /* keeps holding */ } else if (this.state === 'reach' || this.state === 'swat' || this.state === 'bite') { this.act = null; this._enter('chase'); }
    else if (this.state === 'leap' && !this.airborne) { this.cdLeap = TITAN_TUNING.LEAP_COOLDOWN; this._enter('chase'); }
    this.game.audio?.titanGroan?.(this.position, this.height);
    const ft = this._jpos('footL', new V3());
    this.game.fx?.steam?.(ft, this.height * 0.15, 2);
  }

  _die(point?: Vec3 | null): void {
    if (this.dying) return;
    this.alive = false; this.dying = true; this.deathT = 0; this.fell = false;
    this.airborne = false; this.threat = 0; this.velocity.set(0, 0, 0);
    this._releasePlayer();
    this.fist[0] && this._setFist(0, false); this.fist[1] && this._setFist(1, false);
    this.ik[0].wT = this.ik[1].wT = 0;
    this.fallSign = this.isBehemoth ? -1 : (this.rnd() < 0.5 ? 1 : -1);
    // killed where it already lies (a leg gone): it stays down the way it fell, no second topple
    if (this.down > 0.5) { this.fallSign = this.downSign; this.deathT = 1.5; this.fell = true; }
    this.game.events?.emit?.('titan:killed', { titan: this, by: this.killedBy || null, point: point ? point.clone() : this._headWorld(new V3()) });
    this.game.audio?.napeKill?.();
    this.game.fx?.steam?.(point || this._headWorld(new V3()), Math.max(2, this.height * 0.18), 3);
    this._beginFade();
  }

  // ====================================================================================== update
  update(dt: number): void {
    if (this.dead) return;
    dt = Math.min(dt, 0.05);
    if (dt <= 0) return;
    this.t += dt;
    if (this.dying) { this.velocity.set(0, 0, 0); this.threat = 0; this._updateDying(dt); return; }
    if (this.appearT !== undefined && this.appearT < 0.3) { this.appearT += dt; this.root.visible = this.appearT >= 0.25; }
    this._prevPos.copy(this.position);
    this._timers(dt);
    this._sense();
    if (!this.isBehemoth) this._pickQuarry();
    if (this.isBehemoth) this._thinkBehemoth(dt); else this._think(dt);
    if (!this.isBehemoth) this._locomote(dt);
    this._groundSnap();
    this._fallDown(dt);
    this.root.rotation.y = this.yaw;   // the body faces where it walks (it was left at the spawn heading)
    this._buildPose(dt);
    this._applyPose(dt);
    this.root.updateMatrixWorld(true);
    this._plantLegs(dt);
    this._applyArmIK(dt);
    this.root.updateMatrixWorld(true);
    this._post(dt);
    this._updateVelocity(dt);
    this._updateThreat(dt);
  }

  _updateVelocity(dt: number): void {
    const v = _t0.subVectors(this.position, this._prevPos).multiplyScalar(1 / dt);
    if (v.lengthSq() > 90 * 90) v.set(0, 0, 0);          // teleported (spawn / reposition): not a real velocity
    this.velocity.lerp(v, 1 - Math.exp(-40 * dt));
  }

  /** 0..1 danger for the HUD: 1 while a grab reach / swat / bite / leap is winding up or striking. */
  _updateThreat(dt: number): void {
    let th = 0;
    const a = this.act, st = this.state;
    if (this.hasPlayer && this.blindT <= 0) {
      if (this.isBehemoth) {
        const pl = this._pl;
        if (this.sweepT >= 0 && this.sweepT < 3.6 && pl.position.y > 25 && Math.abs(pl.position.z) < 40) th = this.sweepT < 1.4 ? 0.6 + 0.4 * this.sweepT / 1.4 : 1;
        else if (this.steamOn && this.distH < 45) th = 0.6;
      } else if (st === 'reach' && a) { const r = a as ReachAct; th = r.ally ? 0.3 : r.t < r.W + r.E + r.H ? 1 : 0.35; }
      else if (st === 'swat' && a) { const w = a as SwatAct; th = w.t < w.W + w.S + 0.1 ? 1 : 0.3; }
      else if (st === 'bite' && a) { const b = a as BiteAct; th = b.t < b.W + b.B ? 0.9 : 0.3; }
      else if (st === 'grab') th = 1;
      else if (st === 'yank' && a) th = 1;
      else if (st === 'shake' && a) th = a.t < (a as ShakeAct).W + 0.25 ? 1 : 0.4;
      else if (st === 'charge' && a) th = 1;
      else if (st === 'guard' && a) { const g = a as GuardAct; th = g.kind === 'slap' ? (g.t < g.W + g.S ? 1 : 0.3) : g.kind === 'whirl' ? 0.5 : 0.25; }
      else if (st === 'leap') th = this.leap.phase < 2 ? 1 : 0.45;
      else if (st === 'chase') {
        // closing in: up to ~0.45 when inside a couple of arm lengths and facing, more when the attack is ready
        const A = this.armLen;
        const near = clamp(1 - (this.dist3 - A) / (2.5 * A), 0, 1);
        th = 0.45 * near * (Math.abs(this.relYaw) < 1.2 ? 1 : 0.5) * (this.cdAttack < 0.6 ? 1 : 0.6);
      }
    }
    this.threat = th >= this.threat ? th : Math.max(th, this.threat - dt * 2.5);
  }

  /** May this titan close a hand on the player right now? (difficulty easing for keyboard play) */
  _grabAllowed(): boolean {
    const pl = this._pl;
    return !!pl && !pl.grabbedBy && !((this.mgr.grabBlockT || 0) > 0) && !((pl.grabImmune ?? 0) > 0);
  }

  _timers(dt: number): void {
    this.cdAttack = Math.max(0, this.cdAttack - dt);
    if (this.cdLeap > 0) this.cdLeap -= dt;
    this.flinch = Math.max(0, this.flinch - dt * 2.5);
    this.recoil = Math.max(0, this.recoil - dt * 1.5);
    if (this.blindT > 0) { this.blindT -= dt; if (this.blindT <= 0 && this.state === 'blind') { this.blindT = 0; this._enter('chase'); } }
    if (this.crippleT > 0) { this.crippleT -= dt; if (this.crippleT <= 0) this.crippleT = 0; }
    if (this.stunT > 0) { this.stunT -= dt; if (this.stunT <= 0 && this.state === 'stun') this._enter('chase'); }
    for (let i = 0; i < 2; i++) {
      const n = i === 0 ? 'L' : 'R';
      if (this.severed[i] > 0) {
        this.severed[i] -= dt;
        this._growLimb(i, this.J[`fore${n}`], i === 0 ? FORE_L : FORE_R, this.severed[i], dt);
        if (this.severed[i] <= 0) { this.severed[i] = 0; this._regrow(i); }
      }
      if (this.sevLeg[i] > 0) {
        this.sevLeg[i] -= dt;
        this._growLimb(2 + i, this.J[`shin${n}`], i === 0 ? LEG_L : LEG_R, this.sevLeg[i], dt);
        if (this.sevLeg[i] <= 0) { this.sevLeg[i] = 0; this._regrowLeg(i); }
      }
    }
    this.cdGroan -= dt;
    this.cdYank -= dt; this.cdCharge -= dt;
    this.cdGuard = (this.cdGuard || 0) - dt;
    this.aggroT = (this.aggroT || 0) - dt;
    this.guardUrge = Math.max(0, (this.guardUrge || 0) - dt * 0.35);
    // a nape wound closes in about half a minute, steaming while it does
    if (this.napeDamage > 0 && !this.isBehemoth) {
      this.napeDamage = Math.max(0, this.napeDamage - this.napeHp * 0.035 * dt);
      this.woundT = (this.woundT || 0) - dt;
      if (this.woundT <= 0 && this.napeDamage > 0) { this.woundT = 0.45; const nw = this.napeWorld(); this.game.fx?.steam?.(nw.center, Math.max(0.8, this.height * 0.07), 0.8); }
    }
    if (this.state !== 'guard') this.napeCover = Math.max(0, (this.napeCover || 0) - dt * 4);
  }

  _enter(state: TitanState): void { this.state = state; this.stateT = 0; }

  _sense(): void {
    const pl = this._pl;
    this.hasPlayer = !!(pl && pl.alive && pl.position);
    if (!this.hasPlayer) { this.distH = Infinity; this.dist3 = Infinity; return; }
    this.toP.copy(pl.position).sub(this.position);
    this.distH = hypot(this.toP.x, this.toP.z);
    this.dist3 = this.toP.length();
    this.relYaw = wrap(Math.atan2(this.toP.x, this.toP.z) - this.yaw);
  }

  /**
   * What to go for: the nearest living thing in sight, be it the soldier, a comrade, a civilian or a horse
   * (TitanManager.quarries). "Nearest" is the distance over the ground plus a little for how far out of reach
   * overhead it is, bent by the temper: a dull one is easily distracted, a keen one stays on its prey and turns on
   * whoever cut it, a glutton wants what can't fly away, an abnormal follows its whims.
   */
  _pickQuarry(): void {
    const q0 = this.quarry;
    if (q0 && (!q0.alive || q0.catchable === false || (q0.grabbedBy && q0.grabbedBy !== this))) this.quarry = null;
    if (this.onPlayer && !this.hasPlayer) this.onPlayer = false;
    if (this.state === 'reach' || this.state === 'grab' || this.t < this._qNext) return;
    const T = this.temper, rq = this.rq;
    this._qNext = this.t + (T === 'dull' ? 0.8 : 0.45) + rq() * 0.4;
    const chasing = this.state === 'chase';
    // (on its way to the breach it only turns aside for what is right in front of it)
    const range = this.noticeRange * (chasing ? 1.7 : 1) * (this.march ? 0.35 : 1);
    if (this.fixated) { this.quarry = null; this.onPlayer = this.hasPlayer && this.distH < range; return; }
    if (this.t < this._boredUntil) { this.quarry = null; this.onPlayer = false; return; }
    const stick = T === 'keen' ? 0.55 : T === 'dull' ? 0.95 : T === 'wild' ? 1 : 0.8;
    const reachY = this.position.y + this.shoulderH;
    const whim = (): number => (T === 'dull' ? 0.7 + 0.6 * rq() : T === 'wild' ? 0.4 + 1.2 * rq() : 1);
    let best = Infinity, bestQ: Quarry | null = null, player = false;
    if (this.hasPlayer) {
      const pl = this._pl;
      // (on its way into the town it does not stop under a soldier far overhead: on the wall, in the tree tops)
      if (this.distH <= range && !(this.march && pl.position.y > reachY + this.height && this.aggroT <= 0 && this._ropeOnMe() < 0)) {
        let s = (this.distH + Math.max(0, pl.position.y - reachY) * 0.6) * whim();
        const fast = (pl.velocity?.length?.() || 0) > 18;
        if (T === 'glutton' && fast) s *= 1.5;
        if (T === 'keen') s *= 0.85;
        if (this.aggroT > 0) s *= T === 'keen' ? 0.25 : T === 'dull' ? 0.8 : 0.45;   // it cut me
        if (this._ropeOnMe() >= 0) s *= 0.6;
        if (this.onPlayer && chasing) s *= stick;
        best = s; player = true;
      }
    }
    const px = this.position.x, pz = this.position.z, sealed = !!this.game.gateSealed;
    for (const q of this.mgr.quarries) {
      if (!q.alive || q.grabbedBy || q.catchable === false) continue;
      const d = hypot(q.pos.x - px, q.pos.z - pz);
      if (d > range) continue;
      const kind = q.quarryKind || 'ally';
      if (this.march && (kind === 'horse' || q.pos.y > reachY + this.height)) continue;   // (on its way into the town: no time for horses, or for what it cannot reach)
      if (sealed && (q.pos.z < -6) !== (pz < -6) && Math.abs(q.pos.z) > 6 && Math.abs(pz) > 6) continue;   // (the wall stands between them, and the gate is shut)
      let s = (d + Math.max(0, q.pos.y - reachY) * 0.6) * whim();
      if (T === 'glutton') s *= kind === 'civilian' ? 0.55 : kind === 'horse' ? 0.75 : q.vel.lengthSq() > 18 * 18 ? 1.5 : 1;
      else if (T === 'keen') s *= kind === 'horse' ? 2.5 : kind === 'ally' ? 0.85 : 1;
      else if (kind === 'horse') s *= 1.3;                // a horse outruns it: second choice
      if (q === q0 && chasing) s *= stick;
      if (s < best) { best = s; bestQ = q; player = false; }
    }
    this.onPlayer = player; this.quarry = bestQ;
  }

  // ====================================================================================== AI (normal + abnormal)
  _think(dt: number): void {
    const pl = this._pl;
    this.stateT += dt;
    this.speedTarget = 0; this.goal = null; this.faceYaw = null;
    if (this.aiEnabled === false) { this.state = 'idle'; return; }
    const crippled = this.crippleT > 0;
    const blind = this.blindT > 0;
    const k = Math.max(0.7, Math.sqrt(this.height / 7));
    const canMove = !crippled;

    // random groans
    if (this.cdGroan <= 0) { this.cdGroan = 9 + this.rnd() * 12; if (this.hasPlayer && this.dist3 < 220) this.game.audio?.titanGroan?.(this.position, this.height); }

    // a soldier hanging off us on a short rope, not swinging past: counts toward shaking them off
    if (this.hasPlayer) {
      const hk = this._ropeOnMe(), slow = (pl.velocity?.length?.() || 0) < 14;
      this.clingT = hk >= 0 && slow && this.dist3 < this.height * 0.9 ? this.clingT + dt : Math.max(0, this.clingT - dt * 2);
    }
    if ((this.state === 'idle' || this.state === 'wander' || this.state === 'chase' || this.state === 'maul') && this._tryGuard(dt)) return;
    if ((this.drawnTo || this.game.escort) && this._thinkEscort(dt, canMove)) return;
    switch (this.state) {
      case 'guard': this._thinkGuard(dt); break;
      case 'idle':
        if (this._notice()) break;
        if (this._marching(canMove)) break;
        if (this.stateT > this.idleDur) { this._pickWander(); this._enter('wander'); }
        break;
      case 'wander': {
        if (this._notice()) break;
        if (this._marching(canMove)) break;
        this.goal = this.wanderGoal;
        // (far out and drawn to the wall, it comes on at a jog)
        this.speedTarget = canMove ? (this.mgr.advance && this.position.z > 220 ? this.runSpeed * 0.8 : this.walkSpeed * (0.55 + 0.3 * this.mood)) : 0;
        const dx = this.wanderGoal.x - this.position.x, dz = this.wanderGoal.z - this.position.z;
        if (hypot(dx, dz) < 3 + this.footR || this.stateT > 40) { this.idleDur = 2 + this.rnd() * 5; this._enter('idle'); }
        break;
      }
      case 'chase': {
        const q = this.quarry;
        // a dull one loses interest after a while and stands about before something catches its eye again
        if (this.stateT > this._boredAt) {
          this._boredUntil = this.t + 3 + this.rq() * 4; this._boredAt = 9 + this.rq() * 10;
          this.quarry = null; this.onPlayer = false;
          this.home.copy(this.position); this.idleDur = 2 + this.rq() * 3; this._enter('idle'); break;
        }
        if (q) { this._chaseQuarry(dt, q, canMove, k); break; }
        if (!this.onPlayer || !this.hasPlayer) { this.home.copy(this.position); this.idleDur = 1; this._enter('idle'); break; }
        // a soldier up round its head, at its shoulders or behind its neck: it can't keep you in view, so it stands
        // and casts about (it answers with a slap, a hunch or a whirl round instead: _tryGuard)
        if (this.distH < this.height * 0.7 && pl.position.y - this.position.y > this.shoulderH * 0.75 && Math.abs(this.relYaw) > 0.6) {
          this.faceYaw = this.yaw + Math.sin(this.t * 1.3) * 0.25 * dt; this.speedTarget = 0;
          this._tryCounter(dt);   // (it still shakes off a soldier hanging on it, and snatches a wire)
          break;
        }
        this.goal = _g0.copy(pl.position);
        this.speedTarget = canMove ? this.runSpeed : 0;
        // slow down inside arm reach so we do not run through the player
        if (this.distH < this.armLen * 0.8 + this.footR) this.speedTarget = Math.min(this.speedTarget, this.walkSpeed * 0.2);
        if (this.abnormal && canMove && this._tryLeap(dt)) break;
        if (this._tryCounter(dt)) break;
        this._chooseAttack(k);
        break;
      }
      case 'leap': this._thinkLeap(dt); break;
      case 'reach': this._thinkReach(dt, k); break;
      case 'grab': this._thinkGrab(dt); break;
      case 'chew': this.stateT > 1.6 && this._enter(this.hasPlayer ? 'chase' : 'idle'); break;
      case 'swat': this._thinkSwat(dt, k); break;
      case 'bite': this._thinkBite(dt); break;
      case 'yank': this._thinkYank(dt); break;
      case 'shake': this._thinkShake(dt); break;
      case 'charge': this._thinkCharge(dt); break;
      case 'stun':
        if (this.stunT <= 0) this._enter('chase');
        break;
      case 'blind': {
        // stumble about
        if (this.stateT % 1.4 < dt) this.sideBias = (this.rnd() - 0.5) * 2.4;
        this.faceYaw = this.yaw + this.sideBias;
        this.goal = _g0.set(this.position.x + Math.sin(this.yaw + this.sideBias) * 20, 0, this.position.z + Math.cos(this.yaw + this.sideBias) * 20);
        this.speedTarget = canMove ? this.walkSpeed * 0.5 : 0;
        if (this.blindT <= 0) this._enter('chase');
        break;
      }
      default: this._enter('idle');
    }
    if (this.state === 'wander' || this.state === 'idle') this.gazeTarget = this.hasPlayer && this.dist3 < 160 ? pl.position : null;
    else if (this.quarry && (this.state === 'chase' || (this.act as ReachAct | null)?.ally)) this.gazeTarget = this.quarry.pos;
    else this.gazeTarget = this.hasPlayer ? pl.position : null;
    if (blind) this.gazeTarget = null;
  }

  /**
   * After a living thing that isn't the player's soldier: run it down and reach for it. A soldier who gets in its
   * face on the way is still swatted at, and one hanging on its body shaken off.
   */
  _chaseQuarry(dt: number, q: Quarry, canMove: boolean, k: number): void {
    const dx = q.pos.x - this.position.x, dz = q.pos.z - this.position.z, dH = hypot(dx, dz);
    const ry = wrap(Math.atan2(dx, dz) - this.yaw);
    this.goal = _g0.copy(q.pos);
    this.speedTarget = canMove ? this.runSpeed : 0;
    // close enough to reach down for it: stop short and face it (it never walks onto what it means to pick up)
    if (dH < this.armLen * 0.8 + this.footR) this.speedTarget = Math.min(this.speedTarget, this.walkSpeed * 0.2);
    if (dH < this.armLen * 0.5 + this.footR * 0.5) { this.speedTarget = 0; this.goal = null; this.faceYaw = Math.atan2(dx, dz); }
    if (this._tryCounter(dt)) return;
    if (this.hasPlayer && this.dist3 < this.armLen * 1.2) { this._chooseAttack(k); if (this.state !== 'chase') return; }
    if (this.cdAttack > 0 || this.blindT > 0 || this.stunT > 0 || Math.abs(ry) > 1.0) return;
    const kind = q.quarryKind || 'ally';
    if (kind === 'ally' && (this.mgr.allyGrabT || 0) > 0) return;           // one comrade in a hand at a time
    // (a civilian's position is where they stand; a comrade's is the middle of the body)
    const qy = q.pos.y + (kind === 'civilian' ? 0.9 : 0);
    const rel = qy - this.position.y;
    if (rel > this.shoulderH * 1.25) return;                                 // out of reach overhead
    // (a stooping titan drops its shoulders and leans forward for something on the ground: as in _chooseAttack)
    const low = rel < this.shoulderH * 0.95;
    const fx = low ? Math.sin(this.yaw) * 0.22 * this.shoulderH : 0, fz = low ? Math.cos(this.yaw) * 0.22 * this.shoulderH : 0;
    const drop = low ? 0.32 * this.shoulderH : 0;
    let side = -1, best = this.armLen * 1.05 * (this.crippleT > 0 ? 0.8 : 1);
    for (let i = 0; i < 2; i++) {
      if (this.severed[i]) continue;
      const sh = this._jpos(i === 0 ? 'armL' : 'armR', _t7);
      const dd = hypot(sh.x + fx - q.pos.x, sh.y - drop - qy, sh.z + fz - q.pos.z);
      if (dd < best) { best = dd; side = i; }
    }
    if (side < 0) return;
    const a: ReachAct = { side, t: 0, k, W: Math.max(TITAN_TUNING.WINDUP, 0.32 * k), E: 0.45 * k, H: 0.35 * k, R: 0.55 * k, pred: new V3(), cur: new V3(), start: new V3(), ally: q };
    this.act = a;
    this._setFist(side, false); this._enter('reach');
    this.game.events?.emit?.('titan:reachFor', { titan: this, quarry: q, duration: a.W });
  }

  /**
   * Seal the Breach: normal titans are drawn to the shifter's giant from anywhere and maul him (he stops while they
   * do). A soldier who cuts one, or flies right in its face, gets its attention instead for a few seconds.
   */
  _thinkEscort(dt: number, canMove: boolean): boolean {
    const esc: MaulTarget = (this.drawnTo || this.game.escort)!, st = this.state;   // (drawnTo: a mission's target, e.g. the bound Huntress)
    this.mauling = false;
    if (this.abnormal || this.lured || !esc.vulnerable || (st !== 'idle' && st !== 'wander' && st !== 'chase' && st !== 'maul')) {
      if (st === 'maul') this._enter('chase');
      return false;
    }
    const ex = esc.position.x - this.position.x, ez = esc.position.z - this.position.z, dE = hypot(ex, ez);
    const reach = this.armLen * 0.8 + this.footR + esc.footR;
    if ((this.aggroT || 0) > 0 || (this.hasPlayer && this.distH < Math.min(dE - 10, this.armLen * 2.5))) {
      if (st === 'maul') this._enter('chase');
      return false;
    }
    if (st !== 'maul') { this._enter('maul'); this.maulT = 0.8 + this.rnd() * 0.6; }
    this.gazeTarget = esc._headWorld(this._escGaze || (this._escGaze = new V3()));
    if (dE > reach) {
      this.goal = _g0.copy(esc.position);
      this.speedTarget = canMove ? this.runSpeed : 0;
    } else {
      this.faceYaw = Math.atan2(ex, ez);
      this.mauling = true;
      if (Math.abs(wrap(this.faceYaw - this.yaw)) < 0.8 && (this.maulT -= dt) <= 0) {
        this.maulT = 1.3 + this.rnd() * 0.6;
        esc.hurt(0.9 + this.height * 0.18, this);
      }
    }
    if (this._tryCounter(dt)) return true;   // it still snatches a wire and shakes off a soldier hanging on it
    return true;
  }

  /**
   * The gate is down: make for the breach and on into the town (the nav goal routes it through the tunnel). Once
   * inside, a street corner there becomes home and it prowls the town like any other.
   */
  _marching(canMove: boolean): boolean {
    if (!this.march) return false;
    if (this.position.z < -16 || this.game.gateSealed) {
      this.march = false;
      if (this.position.z < -16) {
        const zs = (this.game.world?.titanSpawns || []).filter((z) => z.area === 'town');
        const z = zs.length ? zs[Math.floor(this.rq() * zs.length)] : null;
        this.home.set(z ? z.center.x : 0, 0, z ? z.center.z : -80);
        this._pickWander(); this._enter('wander');
      }
      return false;
    }
    this.goal = _g0.set(clamp(this.position.x * 0.02, -3, 3), 0, -34);
    this.speedTarget = canMove ? this.runSpeed * 0.9 : 0;
    return true;
  }

  _notice(): boolean {
    if (this.onPlayer || this.quarry) {
      this._enter('chase');
      if (this.rnd() < 0.7) this.game.audio?.titanGroan?.(this.position, this.height);
      return true;
    }
    return false;
  }

  _pickWander(): void {
    if (this.mgr.advance && !this.march && this.position.z > 75) {
      // drawn to the wall: each amble takes it nearer the gate (and where it stops is home until the next)
      const p = this.position, tx = clamp(p.x * 0.45, -170, 170) - p.x, tz = 52 - p.z, tl = hypot(tx, tz) || 1;
      const step = Math.min(tl, 40 + this.rq() * 50);
      this.wanderGoal.set(p.x + (tx / tl) * step + (this.rq() - 0.5) * 34, 0, Math.max(6 + this.footR + 4, p.z + (tz / tl) * step));
      this.home.copy(this.wanderGoal);
      return;
    }
    const r = 15 + this.rnd() * 55, a = this.rnd() * TAU;
    const hx = this.home.x, hz = this.home.z;
    let x = hx + Math.sin(a) * r, z = hz + Math.cos(a) * r;
    x = clamp(x, -1000, 1000); z = clamp(z, -600, 1000 + FS);
    // stay on the home side of the wall
    const lim = 6 + this.footR + 4;
    if (hz > 6) z = Math.max(z, lim); else if (hz < -6) z = Math.min(z, -lim);
    this.wanderGoal.set(x, 0, z);
  }

  /** Decide whether to start an attack while chasing. */
  _chooseAttack(k: number): void {
    const pl = this._pl;
    if (!this.hasPlayer || this.cdAttack > 0 || pl.grabbedBy || this.blindT > 0 || this.stunT > 0) return;
    const A = this.armLen, h = this.height;
    const gy = this._ground(this.position.x, this.position.z);
    const rel = pl.position.y - gy;
    const speedP = pl.velocity ? pl.velocity.length() : 0;
    const airborne = rel > 0.12 * h + 1.0 || speedP > 14;
    const facing = Math.abs(this.relYaw) < 1.0;
    const crippled = this.crippleT > 0;
    const reachMul = crippled ? 0.8 : 1;
    // nearest shoulder
    const sL = this._jpos('armL', _t7), sR = this._jpos('armR', _t8);
    const dL = sL.distanceTo(pl.position) + (this.severed[0] ? 1e3 : 0), dR = sR.distanceTo(pl.position) + (this.severed[1] ? 1e3 : 0);
    const side = dL <= dR ? 0 : 1, dS = Math.min(dL, dR);
    const mouth = this._mouthWorld(_t9);
    const dMouth = mouth.distanceTo(pl.position);

    if (facing && dMouth < 0.5 * h + 1.5 && rel > 0.3 * h && this.rnd() < 2 * 0.016 * 60 * 0.02) { this._startBite(); return; }
    if (facing && airborne && dS < A * 1.05 * reachMul && dS < 1e3) { this._startSwat(side, k); return; }
    if (facing && !airborne && rel < this.shoulderH * 0.95 && this._grabAllowed()) {
      // a stooping titan drops its shoulders and leans forward: effective shoulder for ground-level targets
      const fx = Math.sin(this.yaw) * 0.22 * this.shoulderH, fz = Math.cos(this.yaw) * 0.22 * this.shoulderH;
      let bestS = 0, bestD = 1e9;
      for (let i = 0; i < 2; i++) {
        if (this.severed[i]) continue;
        const sh = i === 0 ? sL : sR;
        const dd = hypot(sh.x + fx - pl.position.x, sh.y - 0.32 * this.shoulderH - pl.position.y, sh.z + fz - pl.position.z);
        if (dd < bestD) { bestD = dd; bestS = i; }
      }
      if (bestD < A * 1.0 * reachMul * (crippled ? 0.8 : 1)) { this._startReach(bestS, k); return; }
    }
    // flying low past us at arm's length: swat too
    if (facing && airborne && this.distH < A * 1.15 && rel < this.shoulderH * 1.15 && dS < 1e3) this._startSwat(side, k);
  }

  _startReach(side: number, k: number): void {
    // W: a readable wind-up (lean back, open hand, jaw opens) of at least TITAN_TUNING.WINDUP s, then E: the grab itself
    const a: ReachAct = { side, t: 0, k, W: Math.max(TITAN_TUNING.WINDUP, 0.32 * k), E: 0.5 * k, H: 0.35 * k, R: 0.55 * k, pred: new V3(), cur: new V3(), start: new V3() };
    this.act = a;
    this._setFist(side, false);
    this._enter('reach');
    this._windupEvent('grab', a.W);
  }
  _windupEvent(kind: string, duration: number): void {
    this.game.events?.emit?.('titan:windup', { titan: this, kind, duration });
  }
  _thinkReach(dt: number, _k?: number): void {
    const a = this.act as ReachAct | null, pl = this._pl;
    if (!a) { this._enter('chase'); return; }
    a.t += dt;
    this.faceYaw = this.yaw + this.relYaw * 0.6; this.speedTarget = 0;
    const al = a.ally;
    if (al) {
      if (!al.alive || al.grabbedBy || al.horse || (al as Quarry).catchable === false) { this.act = null; this.cdAttack = 1; this._enter('chase'); return; }
      this.faceYaw = Math.atan2(al.pos.x - this.position.x, al.pos.z - this.position.z);
    } else if (!this.hasPlayer) { this.act = null; this._enter('chase'); return; }
    const tp = al ? al.pos : pl.position, tv = al ? al.vel : pl.velocity;
    const tE = a.W + a.E;
    if (a.t < a.W) { a.pred.copy(tp); }
    else if (a.t < tE) {
      const lead = a.E * 0.7;
      a.pred.copy(tp).addScaledVector(tv || ZERO, lead * 0.9);
    }
    if (al) {
      if (a.t > a.W && a.t < tE + a.H && this._jpos(a.side === 0 ? 'handL' : 'handR', _t10).distanceTo(al.pos) < 1.6 + 0.1 * this.height) { this._catchAlly(a.side, al); return; }
      if (a.t > tE + a.H + a.R) { this.act = null; this.cdAttack = 2 + this.rnd(); this._enter('chase'); }
      return;
    }
    if (a.t > a.W && a.t < a.W + a.E + a.H && this._grabAllowed()) {
      // catch check: palm within reach of the player, and the player is not streaking past the hand
      // (fast tether-gear flyers are hard to catch: relative speed must be under TITAN_TUNING.GRAB_MAX_REL_SPEED)
      const hp = this._jpos(a.side === 0 ? 'handL' : 'handR', _t10);
      if (hp.distanceTo(pl.position) < 0.55 + 0.055 * this.height) {
        const hv = this._handVel[a.side], pv = pl.velocity || ZERO;
        const rel = hypot(pv.x - hv.x, pv.y - hv.y, pv.z - hv.z);
        if (rel < TITAN_TUNING.GRAB_MAX_REL_SPEED && this._catch(a.side)) return;
      }
    }
    if (a.t > a.W + a.E + a.H + a.R) { this.act = null; this.cdAttack = (this.abnormal ? 1.2 : 2.2) + this.rnd(); this._enter('chase'); }
  }
  _catch(side: number): boolean {
    const pl = this._pl;
    if (pl.grab) { if (pl.grab(this, this.J[side === 0 ? 'handL' : 'handR']) === false) return false; }
    else pl.grabbedBy = this;
    this._setFist(side, true, true);
    this.act = { side, t: 0, dur: 2.2 };
    this._enter('grab');
    return true;
  }
  /** Close the fist on a comrade: they get a few seconds for someone to cut the hand or the nape. */
  _catchAlly(side: number, ally: Comrade): void {
    ally.grab(this, this.J[side === 0 ? 'handL' : 'handR']);
    this._setFist(side, true, true);
    this.act = { side, t: 0, dur: 5.5, ally };
    if (((ally as Quarry).quarryKind || 'ally') === 'ally') this.mgr.allyGrabT = 30;
    this._enter('grab');
    this.game.audio?.titanGroan?.(this.position, this.height);
  }
  _thinkGrab(dt: number): void {
    const a = this.act as GrabAct | null, pl = this._pl;
    this.speedTarget = 0; this.faceYaw = null;
    if (!a) { this._enter('chase'); return; }
    a.t += dt;
    if (a.ally) {
      if (a.ally.grabbedBy !== this) { this._setFist(a.side, false); this.act = null; this.cdAttack = 2.5; this._enter('chase'); return; }
      if (a.t >= a.dur) {
        this.game.audio?.titanGroan?.(this.position, this.height);
        a.ally.eaten(this);
        this._setFist(a.side, false);
        this.act = null; this.cdAttack = 3; this._enter('chew');
      }
      return;
    }
    if (pl.grabbedBy !== this && a.t > 0.1) { // player got free some other way
      this._setFist(a.side, false); this.act = null; this.cdAttack = 2.5; this._enter('chase'); return;
    }
    if (a.t >= a.dur) {
      this.game.audio?.titanGroan?.(this.position, this.height);
      if (pl.eaten) pl.eaten(this);
      this._setFist(a.side, false);
      this.act = null; this.cdAttack = 3; this._enter('chew');
    }
  }

  // ------------------------------------------------------------------ counters to tether-gear tactics
  /** Which of the player's hooks is anchored in this titan's body (-1: none). */
  _ropeOnMe(): number {
    const hooks = this._pl?.odm?.hooks;
    if (!hooks) return -1;
    for (let i = 0; i < 2; i++) { const h = hooks[i]; if (h.attached && h.collider?.userData?.titan === this) return i; }
    return -1;
  }
  /** The point on a hook's wire nearest this shoulder (kept off both ends), into `out`; returns the distance. */
  _wirePoint(h: PreyHook, shoulder: Vec3, out: Vec3): number {
    const P = this._pl.position, A = h.anchor;
    const dx = P.x - A.x, dy = P.y - A.y, dz = P.z - A.z, L2 = dx * dx + dy * dy + dz * dz || 1;
    const u = clamp(((shoulder.x - A.x) * dx + (shoulder.y - A.y) * dy + (shoulder.z - A.z) * dz) / L2, Math.min(0.5, 1.5 / Math.sqrt(L2)), 0.85);
    out.set(A.x + dx * u, A.y + dy * u, A.z + dz * u);
    return out.distanceTo(shoulder);
  }
  /** Chasing: answer the soldier's tactics. Abnormals run down a rider; a rope strung in front of us gets grabbed;
   *  a soldier dangling on our body gets shaken off. Returns true when an action started. */
  _tryCounter(dt: number): boolean {
    const pl = this._pl;
    if (!this.hasPlayer || !pl.odm || pl.grabbedBy || this.blindT > 0 || this.stunT > 0) return false;
    if (this.abnormal && pl.riding && this.cdCharge <= 0 && this.crippleT <= 0 && this.distH > 18 && this.distH < 130 && Math.abs(this.relYaw) < 1.4) {
      this.act = { t: 0, W: 0.8, run: 3.4, hit: false };
      this.cdCharge = 11 + this.rnd() * 6; this._enter('charge'); this._windupEvent('charge', 0.8);
      this.game.audio?.titanGroan?.(this.position, this.height * 1.3);
      return true;
    }
    if (!((this.mgr.allyGrabT || 0) > 0) && this.cdAttack <= 0 && this.rnd() < dt * 1.6) {
      for (const al of (this.game.allies || []) as unknown as Comrade[]) {
        if (!al.alive || al.grabbedBy || al.horse || !al.job || al.job.titan !== this) continue;
        const ry = wrap(Math.atan2(al.pos.x - this.position.x, al.pos.z - this.position.z) - this.yaw);
        if (Math.abs(ry) > 1.1) continue;
        const sL = this._jpos('armL', _t7).distanceTo(al.pos), sR = this._jpos('armR', _t8).distanceTo(al.pos);
        const side = this.severed[0] ? 1 : this.severed[1] ? 0 : sL <= sR ? 0 : 1;
        if (Math.min(sL, sR) > this.armLen * 1.05 || this.severed[side]) continue;
        this.act = { side, t: 0, k: 1, W: 0.4, E: 0.4, H: 0.3, R: 0.5, pred: new V3(), cur: new V3(), start: new V3(), ally: al };
        this._setFist(side, false); this._enter('reach');
        return true;
      }
    }
    const hk = this._ropeOnMe();
    if (this.clingT > 0.9 && (this.cdAttack <= 0.5 || this.clingT > 1.5)) {
      this.act = { t: 0, W: 0.35, S: 0.8, flung: false };
      this._enter('shake'); this._windupEvent('shake', 0.35);
      this.game.audio?.titanGroan?.(this.position, this.height);
      return true;
    }
    if (hk >= 0 && this.cdAttack <= 0 && this.cdYank <= 0 && Math.abs(this.relYaw) < 1.1 && this._grabAllowed() && this.rnd() < dt * 2.4) {
      const h = pl.odm!.hooks[hk];
      let side = -1, best = this.armLen * 1.15;
      for (let i = 0; i < 2; i++) {
        if (this.severed[i]) continue;
        const d = this._wirePoint(h, this._jpos(i === 0 ? 'armL' : 'armR', _t7), _t8);
        if (d < best) { best = d; side = i; }
      }
      if (side >= 0 && h.anchor.distanceTo(pl.position) > 6) {
        this.act = { side, hook: hk, t: 0, W: 0.55, R: 0.24, P: 1.5, q: new V3(), start: new V3(), held: false };
        this.cdYank = 7 + this.rnd() * 4;
        this._setFist(side, false); this._enter('yank'); this._windupEvent('yank', 0.55);
        return true;
      }
    }
    return false;
  }
  _endAct(cd: number): void { this.act = null; this.cdAttack = cd + this.rnd(); this._enter('chase'); }

  /** Snatch the wire out of the air and haul the soldier in, hand over fist, toward the mouth. */
  _thinkYank(dt: number): void {
    const a = this.act as YankAct | null, pl = this._pl;
    if (!a) { this._enter('chase'); return; }
    a.t += dt; this.speedTarget = 0; this.faceYaw = this.yaw + this.relYaw * 0.6;
    const h = pl.odm!.hooks[a.hook];
    const hand = a.side === 0 ? 'handL' : 'handR';
    if (!a.held) {
      if (!this.hasPlayer || pl.grabbedBy || !h.attached || h.collider?.userData?.titan !== this) { this._setFist(a.side, false); this._endAct(1.4); return; }
      this._wirePoint(h, this._jpos(a.side === 0 ? 'armL' : 'armR', _t7), a.q);
      if (a.t >= a.W + a.R) {
        a.held = true; h.yank = this; h.yankSide = a.side; h.payout = 0;
        this._setFist(a.side, true); this._jpos(hand, a.start);
        this.game.audio?.titanGroan?.(this.position, this.height);
        this.game.events?.emit?.('player:wireGrabbed', { titan: this });
      }
      return;
    }
    if (h.yank !== this || !h.attached) {            // cut, or let go in time: it hauls on nothing and staggers
      this._setFist(a.side, false); this.recoil = 1; this._endAct(2); return;
    }
    const u = (a.t - a.W - a.R) / a.P;
    const hp = this._jpos(hand, _t10);
    const dir = _t11.subVectors(hp, pl.position);
    const dist = dir.length() || 1; dir.multiplyScalar(1 / dist);
    const sp = 8 + 18 * Math.min(1, u * 2);
    h.length = Math.max(u < 0.4 ? 2.5 : 0.8, Math.min(h.length, dist) - sp * dt);
    const v = pl.velocity, vr = v.dot(dir);
    if (vr < sp) v.addScaledVector(dir, (sp - vr) * Math.min(1, dt * 6));
    // a moment to react (let go / cut) before the other hand can close on you
    if (u > 0.4 && dist < 1.6 + 0.1 * this.height && this._grabAllowed()) { h.yank = null; if (this._catch(a.side)) return; }
    if (u >= 1) { h.yank = null; pl.odm!.release(a.hook); this._setFist(a.side, false); this._endAct(2.2); }
  }
  _poseYank(): void {
    const P = this.P, a = this.act as YankAct, side = a.side, sg = sideSign(side), A = this.armLen;
    const pole = this._pole(side, 0.7, -0.6, -0.2);
    this._fp(sg * (this.d.shoulderX * this.s + 0.35 * A), this.shoulderH + 0.25 * A, -0.45 * A, _tw);   // cocked, hand open
    if (a.t < a.W) {
      const w = sm(a.t / a.W);
      this._arm(side, _tw, pole, 16);
      P.spine[0] += -0.22 * w; P.spine[1] += sg * 0.3 * w; P.head[0] += -0.2 * w; this.jawExtra += 0.4 * w;
    } else if (!a.held) {
      const e = sm(clamp((a.t - a.W) / a.R, 0, 1));
      _tw.lerp(a.q, e);
      this._arm(side, _tw, pole, 28);
      P.spine[0] += -0.22 + 0.42 * e; P.spine[1] += sg * 0.3 * (1 - e); this.jawExtra += 0.4;
    } else {
      // hand over fist: the fist drags back toward the jaw, the body leans back into the pull
      const u = clamp((a.t - a.W - a.R) / a.P, 0, 1), e = sm(Math.min(1, u * 1.5));
      _tw3.copy(a.start).lerp(this._mouthWorld(_tw2), e * 0.85);
      this._arm(side, _tw3, pole, 14);
      P.spine[0] += 0.2 - 0.38 * e; P.spine[1] += sg * 0.28 * e; P.head[0] += -0.18 * e; this.jawExtra += 0.55 * e;
      const o = 1 - side;                             // the other hand comes up, open, ready to take you
      this._fp(sideSign(o) * (this.d.shoulderX * this.s + 0.2 * A), this.shoulderH - 0.05 * A, 0.45 * A, _tw);
      this._arm(o, _tw, this._pole(o, 0.8, -0.6, -0.2), 8);
    }
  }

  /** A soldier hanging off our body: hunch, then thrash the torso until the anchors tear out. */
  _thinkShake(dt: number): void {
    const a = this.act as ShakeAct | null, pl = this._pl;
    if (!a) { this._enter('chase'); return; }
    a.t += dt; this.speedTarget = 0; this.faceYaw = null;
    if (!a.flung && a.t > a.W + 0.2) {
      a.flung = true;
      let n = 0;
      for (const h of pl.odm?.hooks || []) if (h.attached && h.collider?.userData?.titan === this) { pl.odm?.release(h.side); n++; }
      if (n && this.hasPlayer && this.dist3 < this.height * 1.2) {
        const d = _t11.copy(pl.position).sub(this.position).setY(0);
        if (d.lengthSq() < 1e-4) d.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        d.normalize().multiplyScalar(12); d.y = 7;
        pl.applyImpulse?.(d, 6);
        this.game.events?.emit?.('player:shaken', { titan: this });
      }
    }
    if (a.t > a.W + a.S) { this.clingT = 0; this._endAct(1.5); }
  }
  _poseShake(): void {
    const P = this.P, a = this.act as ShakeAct, t = this.t;
    if (a.t < a.W) {
      const w = sm(a.t / a.W);
      P.spine[0] += 0.25 * w; P.head[0] += 0.2 * w; P.armL[2] += -0.2 * w; P.armR[2] += 0.2 * w; this.jawExtra += 0.3 * w;
      return;
    }
    const env = Math.sin(Math.PI * clamp((a.t - a.W) / a.S, 0, 1));
    P.spine[1] += 0.5 * env * Math.sin(t * 24); P.spine[2] += 0.25 * env * Math.sin(t * 17 + 1);
    P.pelvis[1] += -0.2 * env * Math.sin(t * 24); P.head[1] += 0.45 * env * Math.sin(t * 21 + 2); P.head[2] += 0.2 * env * Math.sin(t * 13);
    P.armL[2] += 0.7 * env; P.armR[2] += -0.7 * env; P.armL[0] += -0.3 * env * Math.sin(t * 19); P.armR[0] += -0.3 * env * Math.sin(t * 19 + 2);
    this.jawExtra += 0.6 * env;
  }

  // ------------------------------------------------------------------ guarding the nape
  /**
   * A soldier at the back of our neck (roped on, or swooping round us): it doesn't just stand there. It slaps at
   * the back of its neck, hunches its shoulders up round the nape, or whirls round to face you. Which, and when,
   * varies (abnormals more often; a cut that only wounded makes it frantic), so no two approaches go the same way.
   */
  _tryGuard(dt: number): boolean {
    const pl = this._pl;
    if (!this.hasPlayer || !pl.alive || pl.grabbedBy || this.blindT > 0 || this.stunT > 0 || this.airborne || this.cdGuard > 0) return false;
    if (this.temper === 'dull') return false;              // too slow-witted to mind its neck
    if (this._ropeOnMe() < 0 && pl.prey !== this) return false;
    const nw = this.napeWorld();
    const r = _t11.subVectors(pl.position, nw.center), d = r.length();
    if (d > Math.max(10, this.height * 1.4)) return false;
    const behind = r.dot(nw.normal) / Math.max(d, 1e-3);
    if (behind < -0.4) return false;                       // in front: the usual attacks deal with that
    const rate = (this.abnormal ? 1.2 : this.temper === 'keen' ? 1.3 : 0.7) + 2.5 * this.guardUrge;
    if (this.rnd() > dt * rate) return false;
    const kk = Math.max(0.8, Math.sqrt(this.height / 7));
    const left = _t12.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    let side = _t13.subVectors(pl.position, this.position).dot(left) >= 0 ? 0 : 1;
    if (this.severed[side]) side = 1 - side;
    const r2 = this.rnd();
    const kind = r2 < 0.45 && !this.severed[side] ? 'slap' : r2 < 0.75 ? 'hunch' : 'whirl';
    let ga: GuardAct;
    if (kind === 'slap') ga = { kind, side, t: 0, W: 0.38 * kk, S: 0.2 * kk, R: 0.55 * kk, hit: false, mid: new V3().copy(pl.position) };
    else if (kind === 'hunch') ga = { kind, t: 0, W: 0.22 * kk, H: 1.1 + this.rnd() * 0.8 };
    else ga = { kind, t: 0, W: 0.18, T: 0.8 + this.rnd() * 0.4 };
    this.act = ga;
    this._setFist(0, false); this._setFist(1, false);
    this._enter('guard');
    this._windupEvent(kind === 'slap' ? 'swat' : 'guard', ga.W);
    if (this.rnd() < 0.5) this.game.audio?.titanGroan?.(this.position, this.height);
    return true;
  }
  _thinkGuard(dt: number): void {
    const a = this.act as GuardAct | null, pl = this._pl;
    if (!a) { this._enter('chase'); return; }
    a.t += dt; this.speedTarget = 0;
    this.faceYaw = null;
    if (a.kind === 'slap') {
      if (a.t < a.W && this.hasPlayer) a.mid.copy(pl.position).addScaledVector(pl.velocity || ZERO, Math.max(0, a.W + a.S * 0.5 - a.t) * 0.7);
      if (a.t > a.W && a.t < a.W + a.S + 0.05 && !a.hit && this.hasPlayer && !pl.grabbedBy) {
        const hp = this._jpos(a.side === 0 ? 'handL' : 'handR', _t10);
        if (hp.distanceTo(pl.position) < 1.4 + 0.12 * this.height) {
          a.hit = true;
          // swatted off the back of its neck: the anchors tear out and you're flung clear
          for (const h of pl.odm?.hooks || []) if (h.attached && h.collider?.userData?.titan === this) pl.odm?.release(h.side);
          const nw = this.napeWorld();
          const dd = _t11.subVectors(pl.position, nw.center).setY(0);
          if (dd.lengthSq() < 1e-4) dd.copy(nw.normal).setY(0);
          dd.normalize().multiplyScalar(16 + 0.6 * this.height); dd.y = 6;
          pl.applyImpulse?.(dd, 12 + 0.8 * this.height);
          this.game.fx?.impact?.(hp, UP, 'flesh');
          this.game.audio?.titanStep?.(hp, this.height * 0.5);
          this.game.events?.emit?.('player:slapped', { titan: this });
        }
      }
      if (a.t > a.W + a.S + a.R) this._endGuard();
    } else if (a.kind === 'hunch') {
      const e = Math.min(1, a.t / a.W) * clamp((a.W + a.H - a.t) / 0.3, 0, 1);
      this.napeCover = sm(clamp(e, 0, 1));
      if (a.t > a.W + a.H) this._endGuard();
    } else {
      // whirl round to face you: the nape swings away and you have to come round again
      if (a.t > a.W && this.hasPlayer) this.faceYaw = this.yaw + this.relYaw;
      this.turnBoost = a.t > a.W ? 3.2 : 1;
      if (a.t > a.W + a.T) { this.turnBoost = 1; this._endGuard(); }
    }
  }
  _endGuard(): void {
    this.act = null; this.turnBoost = 1;
    this.cdGuard = (this.abnormal ? 0.9 : 1.6) + this.rnd() * 1.6;
    this._enter('chase');
  }
  _poseGuard(): void {
    const P = this.P, a = this.act as GuardAct, A = this.armLen;
    if (a.kind === 'slap') {
      const side = a.side, sg = sideSign(side), pole = this._pole(side, 0.8, 0.9, -0.2);
      const sh = this._jpos(side === 0 ? 'armL' : 'armR', _t18);
      // hand up over the shoulder, then down hard across the back of the neck
      _tw.copy(sh).add(_t19.set(sg * 0.15 * A, 0.75 * A, -0.1 * A).applyAxisAngle(UP, this.yaw));
      if (a.t < a.W) {
        const w = sm(a.t / a.W);
        this._arm(side, _tw, pole, 12 * w + 2);
        P.spine[1] += sg * 0.25 * w; P.head[0] += 0.25 * w; P.neck[0] += 0.15 * w; this.jawExtra += 0.3 * w;
      } else if (a.t < a.W + a.S) {
        const e = sm((a.t - a.W) / a.S);
        _tw2.copy(a.mid);
        // keep the swing point within reach of the shoulder
        const dd = _t19.subVectors(_tw2, sh), l = dd.length();
        if (l > 0.98 * A) _tw2.copy(sh).addScaledVector(dd, 0.98 * A / l);
        _tw.lerp(_tw2, e);
        this._arm(side, _tw, pole, 30);
        P.spine[1] += sg * 0.25 * (1 - e); P.head[0] += 0.3; P.neck[0] += 0.15;
      } else {
        const r = sm((a.t - a.W - a.S) / a.R);
        _tw.copy(a.mid).lerp(_tw3.copy(sh).add(_t19.set(sg * 0.2 * A, -0.6 * A, 0.1 * A).applyAxisAngle(UP, this.yaw)), r);
        this._arm(side, _tw, pole, 8);
        P.head[0] += 0.3 * (1 - r); P.neck[0] += 0.15 * (1 - r);
      }
    } else if (a.kind === 'hunch') {
      // shoulders up round the ears, head down and in: the nape all but disappears
      const c = this.napeCover || 0;
      P.spine[0] += 0.38 * c; P.neck[0] += 0.55 * c; P.head[0] += 0.45 * c;
      P.armL[2] += -0.45 * c; P.armR[2] += 0.45 * c; P.armL[0] += -0.35 * c; P.armR[0] += -0.35 * c;
      P.foreL[0] += -0.6 * c; P.foreR[0] += -0.6 * c;
      this.jawExtra += 0.25 * c;
    } else {
      // whirl: crouch into the turn, arms flung out
      const w = sm(clamp(a.t / Math.max(a.W, 0.01), 0, 1)) * clamp((a.W + a.T - a.t) / 0.3, 0, 1);
      P.spine[0] += 0.15 * w; P.armL[2] += 0.5 * w; P.armR[2] += -0.5 * w; P.head[0] += -0.15 * w; this.jawExtra += 0.4 * w;
      this.hipT.y += -0.08 * this.d.thighLen * w;
    }
  }

  /** Abnormal: drop low, roar, then sprint straight through a soldier on horseback. */
  _thinkCharge(dt: number): void {
    const a = this.act as ChargeAct | null, pl = this._pl;
    if (!a) { this._enter('chase'); return; }
    a.t += dt;
    if (this.crippleT > 0 || !this.hasPlayer) { this._endAct(1); return; }
    const hz = pl.riding;
    if (a.t < a.W) { this.speedTarget = 0; this.faceYaw = this.yaw + this.relYaw; return; }
    const tgt = hz ? hz.pos : pl.position, tv = hz ? hz.vel : pl.velocity;
    const lead = clamp(this.distH / (this.runSpeed * 2.2), 0, 1.2);
    this.goal = _g0.copy(tgt).addScaledVector(tv, lead);
    this.speedTarget = this.runSpeed * 2.2;
    const reach = this.footR + 2.2 + 0.1 * this.height;
    for (const h of (this.game.herd as unknown as { horses?: PreyHorse[] } | null)?.horses || []) {
      if (!h.rider) continue;
      const dx = h.pos.x - this.position.x, dz = h.pos.z - this.position.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      h.hit(1.4);
      if (h.rider === pl) { h.crashed = Math.max(16, h.speed + 6); this.game.events?.emit?.('player:trampled', { titan: this }); }
      else (h.rider as { dismount?(): void }).dismount?.();
      h.speed = 0; h.yaw += (this.rnd() - 0.5) * 2;
      this.game.fx?.impact?.(h.pos, UP, 'ground');
      this.game.audio?.titanStep?.(h.pos, this.height);
      a.hit = true;
    }
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const ahead = (tgt.x - this.position.x) * fx + (tgt.z - this.position.z) * fz;
    // hit, overshot, lost the rider or out of breath: dig the heels in, skid and stumble
    if (a.hit || a.t > a.W + a.run || (ahead < -3 && this.distH > 6) || (!hz && a.t > a.W + 0.6)) {
      this.act = null; this.cdAttack = 1 + this.rnd(); this.stunT = a.hit ? 0.7 : 1.4; this._enter('stun');
    }
  }
  _poseChargeWindup(): void {
    const a = this.act as ChargeAct, P = this.P, w = sm(a.t / a.W);
    P.pelvis[0] += 0.5 * w; P.thighL[0] += -0.7 * w; P.thighR[0] += -0.7 * w; P.shinL[0] += 0.5 * w; P.shinR[0] += 0.5 * w;
    P.spine[0] += 0.35 * w; P.head[0] += -0.45 * w; this.hipT.y += -0.2 * this.d.thighLen * w; this.jawExtra += 0.8 * w;
    P.armL[2] += 0.4 * w; P.armR[2] += -0.4 * w;
  }

  _startSwat(side: number, k: number): void {
    const a: SwatAct = { side, t: 0, k, W: Math.max(TITAN_TUNING.WINDUP, 0.34 * k), S: 0.22 * k, R: 0.65 * k, hit: false, p0: new V3(), p1: new V3(), mid: new V3() };
    this.act = a;
    this._setFist(side, false);
    this._enter('swat');
    this._windupEvent('swat', a.W);
  }
  _thinkSwat(dt: number, _k?: number): void {
    const a = this.act as SwatAct | null, pl = this._pl;
    if (!a) { this._enter('chase'); return; }
    a.t += dt; this.speedTarget = 0;
    this.faceYaw = this.yaw + this.relYaw * 0.7;
    if (a.t < a.W && this.hasPlayer) {   // aim: keep updating where the player will be
      a.mid.copy(pl.position).addScaledVector(pl.velocity || ZERO, a.W + a.S * 0.5 - a.t);
    }
    if (a.t > a.W && a.t < a.W + a.S + 0.1 && !a.hit && this.hasPlayer) {
      const hp = this._jpos(a.side === 0 ? 'handL' : 'handR', _t10);
      if (hp.distanceTo(pl.position) < 1.3 + 0.1 * this.height) {
        a.hit = true;
        const d = _t11.copy(a.p1).sub(a.p0); d.y = 0; if (d.lengthSq() < 1e-4) d.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); d.normalize();
        d.y = 0.25; d.normalize().multiplyScalar(24 + 0.8 * this.height);
        pl.applyImpulse?.(d, 18 + this.height);
        this.game.fx?.impact?.(hp, UP, 'flesh');
        this.game.audio?.titanStep?.(hp, this.height * 0.6);
      }
    }
    if (a.t > a.W + a.S + a.R) { this.act = null; this.cdAttack = (this.abnormal ? 1.0 : 2.0) + this.rnd(); this._enter('chase'); }
  }

  _startBite(): void { const a: BiteAct = { t: 0, W: TITAN_TUNING.WINDUP, B: 0.18, R: 0.7, hit: false }; this.act = a; this._enter('bite'); this._windupEvent('bite', TITAN_TUNING.WINDUP); }
  _thinkBite(dt: number): void {
    const a = this.act as BiteAct | null, pl = this._pl;
    if (!a) { this._enter('chase'); return; }
    a.t += dt; this.speedTarget = 0; this.faceYaw = this.yaw + this.relYaw * 0.8;
    if (!a.hit && a.t > a.W + a.B * 0.6 && this.hasPlayer) {
      a.hit = true;
      const mw = this._mouthWorld(_t9);
      if (mw.distanceTo(pl.position) < 0.2 * this.height + 2) {
        const d = _t11.copy(pl.position).sub(this.position).setY(0.3).normalize().multiplyScalar(14);
        pl.applyImpulse?.(d, 35);
        this.game.audio?.titanStep?.(mw, this.height * 0.5);
      }
    }
    if (a.t > a.W + a.B + a.R) { this.act = null; this.cdAttack = 2 + this.rnd(); this._enter('chase'); }
  }

  // ---------------------------------------------------------------- abnormal leap
  /** Abnormals pounce at a player on (or near) the ground: ballistic arc, never across the wall, ≥ TITAN_TUNING.LEAP_COOLDOWN apart. */
  _tryLeap(dt: number): boolean {
    if (this.cdLeap > 0 || this.blindT > 0 || this.stunT > 0 || !this.hasPlayer) return false;
    const pl = this._pl, h = this.height, pos = this.position;
    if (pl.grabbedBy || Math.abs(this.relYaw) > 0.55) return false;
    const dMin = Math.max(9, 1.8 * this.armLen), dMax = Math.min(46, 6 + 5 * h);
    if (this.distH < dMin || this.distH > dMax) return false;
    const gp = this._ground(pl.position.x, pl.position.z);
    if (pl.position.y - gp > 0.6 * h + 2) return false;                     // player up on a roof / wall: no pounce
    if (this.rnd() > dt * TITAN_TUNING.LEAP_CHANCE) return false;                         // occasional, not the moment it is possible
    // landing point: just short of where the player will be
    const v = pl.velocity || ZERO, lead = 0.4;
    let tx = pl.position.x + v.x * lead, tz = pl.position.z + v.z * lead;
    const dx = tx - pos.x, dz = tz - pos.z;
    const dist = hypot(dx, dz);
    if (dist < 1e-3) return false;
    const land = clamp(dist - (0.45 * this.armLen + 0.5), dMin * 0.6, dMax);
    tx = pos.x + dx / dist * land; tz = pos.z + dz / dist * land;
    tx = clamp(tx, -1095, 1095); tz = clamp(tz, -645, 1045);
    // never through the wall: both ends clearly on the same side of it (a straight segment then cannot cross it)
    const band = 6 + this.footR + 2;
    if (Math.abs(pos.z) < band || Math.abs(tz) < band || Math.sign(pos.z) !== Math.sign(tz)) return false;
    // landing spot and the apex of the arc must be free of houses / trunks
    const col = this._col, r = this.footR;
    const gl = this._ground(tx, tz);
    const T = clamp(0.55 + 0.016 * land + 0.012 * h, 0.75, 1.35);
    if (col && col.collideSphere) {
      if (this._blocked(col, _c0.set(tx, gl + r + 0.3, tz), r)) return false;
      const apex = TITAN_TUNING.LEAP_G * T * T / 8;
      if (this._blocked(col, _c0.set((pos.x + tx) / 2, (this.position.y + gl) / 2 + apex + r, (pos.z + tz) / 2), r)) return false;
    }
    const L = this.leap;
    L.phase = 0; L.t = 0; L.W = TITAN_TUNING.WINDUP; L.T = T; L.target.set(tx, gl, tz);
    this.act = null;
    this._enter('leap');
    this._windupEvent('leap', L.W);
    return true;
  }
  _blocked(col: TitanCollision, c: Vec3, r: number): boolean {
    const cs = col.collideSphere!(c, r, { dynamic: false });
    for (let i = 0; i < cs.length; i++) {
      const k = cs[i];
      if (k.collider.material === 'ground' || k.collider.type === 'ground' || Math.abs(k.normal.y) > 0.75) continue;
      return true;
    }
    return false;
  }
  _thinkLeap(dt: number): void {
    const L = this.leap, pos = this.position;
    L.t += dt; this.speedTarget = 0;
    this.faceYaw = Math.atan2(L.target.x - pos.x, L.target.z - pos.z);
    if (L.phase === 0) {
      this.speed *= Math.exp(-7 * dt);                     // plant the feet for the crouch
      if (L.t >= L.W) {
        // launch: horizontal speed covers the distance in T, vertical speed returns to the landing height in T
        const dx = L.target.x - pos.x, dz = L.target.z - pos.z;
        L.vx = dx / L.T; L.vz = dz / L.T;
        this.vy = (L.target.y - pos.y) / L.T + 0.5 * TITAN_TUNING.LEAP_G * L.T;
        this.airborne = true; this.speed = 0;
        this.yaw = wrap(Math.atan2(dx, dz));
        L.phase = 1; L.t = 0;
        this.game.audio?.titanGroan?.(pos, this.height);
        this.game.fx?.impact?.(_t20.set(pos.x, pos.y + 0.1, pos.z), UP, 'ground');
      }
    } else if (L.phase === 1 && !this.airborne) { L.phase = 2; L.t = 0; }
    else if (L.phase === 2 && L.t > 0.6) {
      this.cdAttack = Math.max(this.cdAttack, 0.8);
      this._enter('chase');
    }
  }
  /** ballistic step while airborne (leaps); returns true when it handled the movement this frame */
  _flight(dt: number): boolean {
    if (!this.airborne) return false;
    const pos = this.position, L = this.leap;
    const px = pos.x, pz = pos.z;
    pos.x += L.vx * dt; pos.z += L.vz * dt;
    this.vy -= TITAN_TUNING.LEAP_G * dt; pos.y += this.vy * dt;
    this._collide();
    this._wallClamp(px, pz);
    pos.x = clamp(pos.x, -1100, 1100); pos.z = clamp(pos.z, -650, 1050 + FS);
    const gy = this._ground(pos.x, pos.z);
    if (this.vy < 0 && pos.y <= gy) { pos.y = gy; this._land(); }
    this._lastPos.copy(pos);
    return true;
  }
  _land(): void {
    const pos = this.position, h = this.height, pl = this._pl;
    this.airborne = false; this.vy = 0;
    if (this.state === 'leap') { this.leap.phase = 2; this.leap.t = 0; }
    this.cdLeap = TITAN_TUNING.LEAP_COOLDOWN + this.rnd() * 4;
    const p = pos.clone();                                  // event payload (kept by listeners): one per landing
    const fx = this.game.fx;
    if (fx?.impact) {
      fx.impact(p, UP, 'ground');
      for (let i = 0; i < 3; i++) {
        const a = this.rnd() * TAU, r = this.footR * (1 + this.rnd());
        fx.impact(_t20.set(pos.x + Math.sin(a) * r, pos.y + 0.1, pos.z + Math.cos(a) * r), UP, 'ground');
      }
    }
    this.game.audio?.titanStep?.(p, 2 * h);
    this.game.events?.emit?.('titan:step', { position: p, size: 2 * h, titan: this });
    // crushed / knocked flat by the landing
    if (this.hasPlayer && pl.alive && !pl.grabbedBy) {
      const dx = pl.position.x - pos.x, dz = pl.position.z - pos.z, dH = hypot(dx, dz), up = pl.position.y - pos.y;
      if (up < 0.6 * h && dH < 0.25 * h + 2) {
        const d = _t11.set(dx, 0, dz); if (d.lengthSq() < 1e-4) d.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        d.normalize(); d.y = 0.45; d.normalize().multiplyScalar(16 + 0.6 * h);
        pl.applyImpulse?.(d, 15 + 1.5 * h);
      } else if (up < 2.5 && dH < 1.2 * h + 3) {
        const d = _t11.set(dx, 0, dz); if (d.lengthSq() < 1e-4) d.set(0, 0, 1);
        d.normalize(); d.y = 0.6; d.normalize().multiplyScalar(7);
        pl.applyImpulse?.(d, 0);
      }
    }
  }

  // ====================================================================================== movement
  _locomote(dt: number): void {
    if (this._flight(dt)) return;
    const pos = this.position, h = this.height;
    // ----- desired heading / speed
    let wantYaw = this.yaw, wantSpeed = this.speedTarget, goalDirValid = false;
    if (this.goal && wantSpeed > 0) {
      const g = this._navGoal(this.goal, _g1);
      const dx = g.x - pos.x, dz = g.z - pos.z, dist = hypot(dx, dz);
      if (dist > 0.6) {
        _dir.set(dx / dist, 0, dz / dist);
        this._avoid(_dir, wantSpeed);
        wantYaw = Math.atan2(_dir.x, _dir.z); goalDirValid = true;
      } else wantSpeed = 0;
    }
    if (!goalDirValid && this.faceYaw !== null) wantYaw = this.faceYaw;
    const dy = wrap(wantYaw - this.yaw);
    const turn = this.turnRate * (this.crippleT > 0 ? 0.5 : 1) * (1 + 0.5 * clamp(this.speed / Math.max(this.runSpeed, 1), 0, 1)) * (this.turnBoost || 1);
    this.yaw = wrap(this.yaw + clamp(dy, -turn * dt, turn * dt));
    const align = goalDirValid ? clamp(Math.cos(dy) * 1.6 - 0.35, 0, 1) : 0;
    const tgtSp = goalDirValid ? wantSpeed * align : 0;
    const acc = (tgtSp > this.speed ? (this.state === 'charge' ? 2.6 : 0.9) : 2.2) * Math.max(this.runSpeed, 2);
    this.speed += clamp(tgtSp - this.speed, -acc * dt, acc * dt);
    if (this.speed < 0.02) this.speed = 0;
    // ----- integrate
    const px = pos.x, pz = pos.z;
    pos.x += Math.sin(this.yaw) * this.speed * dt;
    pos.z += Math.cos(this.yaw) * this.speed * dt;
    // spread out from other titans
    for (const o of this.mgr.titans) {
      if (o === this || !o.alive) continue;
      const dx = pos.x - o.position.x, dz = pos.z - o.position.z, md = (this.footR + o.footR) * 1.15;
      const d2 = dx * dx + dz * dz;
      if (d2 < md * md && d2 > 1e-6) { const d = Math.sqrt(d2), push = (md - d) * 0.5; pos.x += dx / d * push; pos.z += dz / d * push; }
      else if (d2 <= 1e-6) { pos.x += 0.1; }
    }
    this._collide();
    this._wallClamp(px, pz);
    pos.x = clamp(pos.x, -1100, 1100); pos.z = clamp(pos.z, -650, 1050 + FS);
    // stuck detection (chasing but not getting anywhere)
    if (goalDirValid && this.speedTarget > 1) {
      const moved = hypot(pos.x - this._lastPos.x, pos.z - this._lastPos.z);
      if (moved < this.speedTarget * dt * 0.25) this.stuckT += dt; else this.stuckT = Math.max(0, this.stuckT - dt * 2);
      if (this.stuckT > 1.2) {
        this.sideBias = (this.rnd() < 0.5 ? -1 : 1) * (0.9 + this.rnd() * 0.8); this.sideT = 1.8; this.stuckT = 0;
        // a big one held up by a house does not go round: it goes through (the house comes down)
        // (only the big ones, only when they are after something, and not one house after another)
        if (h >= 9 && this.crippleT <= 0 && this.state === 'chase' && this.t >= this._smashAt) {
          const at = _t22.set(pos.x + Math.sin(this.yaw) * (this.footR + 2.5), 0, pos.z + Math.cos(this.yaw) * (this.footR + 2.5));
          if (this.game.world?.smash?.(at, this.footR + 1.5)) { this._smashAt = this.t + 14 + this.rq() * 10; this.sideBias = 0; this.sideT = 0; this.flinch = Math.min(1, this.flinch + 0.4); this.game.audio?.titanGroan?.(pos, h); }
        }
      }
    }
    if (this.sideT > 0) { this.sideT -= dt; if (this.sideT <= 0) this.sideBias = 0; }
    this._lastPos.copy(pos);
  }

  _navGoal(goal: Vec3, out: Vec3): Vec3 {
    out.copy(goal);
    const pos = this.position, r = this.footR, WH = 6, GATE = 8;
    const side = (z: number) => (z > WH ? 1 : z < -WH ? -1 : 0);
    const sT = side(pos.z), sG = side(goal.z);
    const canPass = this.height < 18 && !this.isBehemoth && !this.game.gateSealed;
    const apY = WH + r + 8;
    if (sT !== 0 && sG !== sT) {
      if (!canPass || sG === 0) { out.set(clamp(goal.x, -1190, 1190), 0, sT * (WH + r + 1.5)); return out; }
      // other side: head for the gate
      if (Math.abs(pos.x) > GATE - r * 0.5 || Math.abs(pos.z) > apY + 3) {
        if (Math.abs(pos.z) > apY - 1 || Math.abs(pos.x) > GATE - r * 0.7) { out.set(0, 0, sT * apY); return out; }
      }
      out.set(0, 0, -sT * apY); return out;
    }
    if (sT === 0) { // inside the gate corridor
      const to = goal.z >= pos.z ? 1 : -1;
      out.set(0, 0, to * (WH + r + 10));
    }
    return out;
  }

  _avoid(dir: Vec3, speed: number): Vec3 {
    const col = this._col;
    if (this.sideBias) { const a = Math.atan2(dir.x, dir.z) + this.sideBias; dir.set(Math.sin(a), 0, Math.cos(a)); }
    if (!col || !col.collideSphere) return dir;
    const pos = this.position, r = this.footR;
    const gy = this._ground(pos.x, pos.z);
    let sx = 0, sz = 0;
    for (let pass = 0; pass < 2; pass++) {
      const dist = r * 1.5 + 1 + (pass ? Math.max(speed, 2) * 1.1 : 0);
      _c0.set(pos.x + dir.x * dist, gy + r * 1.05 + 0.4, pos.z + dir.z * dist);
      const cs = col.collideSphere(_c0, r * 1.1, { dynamic: false });
      for (const c of cs) {
        if (c.collider.material === 'ground' || c.collider.type === 'ground' || Math.abs(c.normal.y) > 0.75) continue;
        const w = clamp(c.depth / r, 0.1, 1.5);
        const nl = hypot(c.normal.x, c.normal.z) || 1;
        sx += c.normal.x / nl * w; sz += c.normal.z / nl * w;
      }
    }
    if (sx || sz) {
      dir.x += sx * 1.4; dir.z += sz * 1.4;
      const l = hypot(dir.x, dir.z) || 1; dir.x /= l; dir.z /= l;
    }
    return dir;
  }

  _collide(): void {
    const col = this._col;
    if (!col || !col.collideSphere) return;
    const pos = this.position, r = this.footR;
    for (let it = 0; it < 2; it++) {
      const gy = this._ground(pos.x, pos.z);
      _c0.set(pos.x, gy + r + 0.3, pos.z);
      const cs = col.collideSphere(_c0, r, { dynamic: false });
      let moved = false;
      for (const c of cs) {
        if (c.collider.material === 'ground' || c.collider.type === 'ground' || Math.abs(c.normal.y) > 0.75) continue;
        const nl = hypot(c.normal.x, c.normal.z); if (nl < 1e-4) continue;
        const dep = Math.min(c.depth, r * 0.6);
        pos.x += c.normal.x / nl * dep; pos.z += c.normal.z / nl * dep; moved = true;
      }
      if (!moved) break;
    }
    // upper body: only pushes out of tall structures (house walls) a little
    const gy = this._ground(pos.x, pos.z);
    _c0.set(pos.x, gy + this.height * 0.55, pos.z);
    const cs = col.collideSphere(_c0, this.height * 0.17, { dynamic: false });
    for (const c of cs) {
      if (c.collider.material === 'ground' || c.collider.type === 'ground' || Math.abs(c.normal.y) > 0.75) continue;
      const nl = hypot(c.normal.x, c.normal.z); if (nl < 1e-4) continue;
      const dep = Math.min(c.depth, this.height * 0.1) * 0.5;
      pos.x += c.normal.x / nl * dep; pos.z += c.normal.z / nl * dep;
    }
  }

  _wallClamp(px: number, pz: number): void {
    const pos = this.position, r = this.footR, WH = 6, GATE = 8;
    const band = WH + r * 0.4;
    if (Math.abs(pos.z) >= band) return;
    const canPass = this.height < 18 && !this.isBehemoth && !this.game.gateSealed;
    if (canPass && Math.abs(pos.x) < GATE - r * 0.5) return;
    // inside the wall: push back to the side it came from
    const side = Math.abs(pz) >= WH ? Math.sign(pz) : (Math.sign(pos.z) || 1);
    pos.z = side * band;
  }

  _groundSnap(): void {
    const pos = this.position;
    if (this.airborne) return;
    pos.y = this._ground(pos.x, pos.z);
  }

  // ====================================================================================== pose
  _buildPose(dt: number): void {
    const P = this.P, d = this.d, t = this.t + this.phase0;
    for (const n of NAMES) { const a = P[n]; a[0] = a[1] = a[2] = 0; }
    this.hipT.set(0, 0, 0);
    this.ik[0].wT = 0; this.ik[1].wT = 0;
    this.jawExtra = 0; this.rate = 10; this.legRate = 18;
    const crippled = this.crippleT > 0;

    // ---- default stance + idle sway
    P.armL[2] += 0.12; P.armR[2] -= 0.12; P.foreL[0] -= 0.25; P.foreR[0] -= 0.25;
    P.armL[0] += 0.05; P.armR[0] += 0.05;
    P.thighL[2] += 0.05; P.thighR[2] -= 0.05; P.footL[2] -= 0.05; P.footR[2] += 0.05;
    const br = Math.sin(t * 1.3);
    P.spine[0] += 0.02 * br + 0.04; P.spine[2] += 0.025 * Math.sin(t * 0.7);
    P.armL[2] += 0.025 * Math.sin(t * 0.9 + 1); P.armR[2] -= 0.025 * Math.sin(t * 0.9 + 2);
    P.armL[0] += 0.04 * Math.sin(t * 0.8); P.armR[0] += 0.04 * Math.sin(t * 0.8 + 1.7);
    this.hipT.y += 0.03 * br;

    // ---- locomotion (not for the Behemoth, which stands its ground)
    if (!this.isBehemoth) {
      if (crippled) { if (this.down > 0.02 || this.sevLeg[0] > 0 || this.sevLeg[1] > 0) this._poseDown(); else this._poseKneel(); } else this._poseGait(dt);
      if (this.crawler) this._poseCrawl(dt);
    }

    // ---- state overlays
    if (this.isBehemoth) this._poseBehemoth(dt);
    else this._poseState(dt);

    // ---- reactions
    const fl = this.flinch, rc = this.recoil;
    P.spine[0] += -0.18 * fl - 0.3 * rc; P.head[0] += -0.2 * fl - 0.25 * rc;
    P.armL[2] += 0.2 * rc; P.armR[2] -= 0.2 * rc; P.armL[0] += -0.3 * rc; P.armR[0] += -0.3 * rc;
    P.spine[2] += 0.08 * fl * Math.sin(t * 40);

    // ---- weight: a heavy titan's body settles onto each footfall (pelvis sinks, torso lurches, head and arms lag)
    if (this.stepJolt > 0.003) {
      const j = this.stepJolt, ph = this.stepJoltT;
      const dip = j * (1 - Math.exp(-ph * 25));          // sinks in fast, recovers as the jolt decays
      this.hipT.y -= 0.075 * d.thighLen * dip;
      P.spine[0] += 0.05 * dip; P.neck[0] += -0.03 * dip; P.head[0] += 0.05 * dip;
      P.armL[2] += 0.05 * dip; P.armR[2] -= 0.05 * dip; P.foreL[0] -= 0.08 * dip; P.foreR[0] -= 0.08 * dip;
      this.jawExtra += 0.04 * dip;
      this.stepJoltT += dt; this.stepJolt *= Math.exp(-5 * dt);
    }

    // ---- gaze: once it has noticed you, the head (and a little of the neck and chest) turns to follow you: slowly,
    // a beat behind, at a capped speed, the blank grin locked on. Blends out while an action poses the head.
    const lean = P.spine[0] + P.pelvis[0];
    const lwT = this.blindT > 0 ? 0 : GAZE_W[this.state] ?? 1;
    this.lookW += (lwT - this.lookW) * (1 - Math.exp(-(lwT > this.lookW ? 1.5 : 7) * dt));
    let gy: number, gp: number;
    if (this.gazeTarget) {
      // the stare lags: it looks where you were a moment ago
      if (!this._lookOn) { this._lookOn = true; this.lookP.copy(this.gazeTarget); }
      this.lookP.lerp(this.gazeTarget, 1 - Math.exp(-(this.isBehemoth ? 1 : 2.8) * dt));
      const hw = this._jpos('head', _t12);
      const vx = this.lookP.x - hw.x, vy = this.lookP.y - hw.y, vz = this.lookP.z - hw.z;
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const xl = vx * cy - vz * sy, zl = vx * sy + vz * cy;
      gy = Math.atan2(xl, zl); gp = Math.atan2(-vy, hypot(xl, zl));
      // you're behind it: it has lost you and the head drifts back to the front (the nape stays where it was)
      if (Math.abs(gy) > 2.2) gy = 0;
    } else { this._lookOn = false; gy = Math.sin(t * 0.33) * 0.55; gp = 0.12 + 0.08 * Math.sin(t * 0.5); }
    const wMax = this.isBehemoth ? 0.45 : 1.4 / Math.sqrt(Math.max(this.height, 3) / 7);   // rad/s: big heads turn slowly
    const gk = 1 - Math.exp(-(this.isBehemoth ? 1.4 : 3) * dt);
    this.gy += clamp((clamp(gy, -1.7, 1.7) - this.gy) * gk, -wMax * dt, wMax * dt);
    this.gp += clamp((clamp(gp, -0.9, 0.8) - this.gp) * gk, -wMax * dt, wMax * dt);
    const lw = this.lookW;
    P.spine[1] += this.gy * 0.18 * lw; P.neck[1] += this.gy * 0.3 * lw; P.head[1] += this.gy * 0.52 * lw;
    P.spine[0] += this.gp * 0.08 * lw; P.neck[0] += this.gp * 0.32 * lw - lean * 0.3; P.head[0] += this.gp * 0.5 * lw - lean * 0.55;
    const tilt = (this.tiltBias + 0.12 * Math.sin(t * 0.55)) * (this.isBehemoth ? 0.3 : 1) * (this.gazeTarget ? 1 : 0.5) * (0.4 + 0.6 * lw);
    P.head[2] += tilt; P.neck[2] += tilt * 0.35;

    // ---- jaw
    let jawT = this.arch.jawRest + this.jawExtra;
    if (!this.isBehemoth && this.gazeTarget && this.state !== 'bite' && this.state !== 'grab') jawT += 0.05 * Math.sin(t * 2.1) + 0.05;
    if (this.jawCap != null) jawT = Math.min(jawT, this.jawCap);   // a shifter keeps its mouth shut unless it means to open it
    P.jaw[0] = jawT;
  }

  /**
   * Step length (world m) at a ground speed, dynamically scaled from a human's: the same curve in leg lengths against
   * the Froude speed v / √(g·leg), so a 15 m titan takes ~6 m strides at a heavy ~1 step a second where a 5 m one
   * takes 2 m steps half again as often. Also how far along the walk → run blend it is (0..1).
   */
  _stepLen(sp = this.speed): number {
    const d = this.d, leg = (d.thighLen + d.shinLen + d.ankleH) * this.s;
    const vh = sp / Math.sqrt(9.8 * leg);
    this._runK = sm((vh - 0.55) / 0.5);
    return Math.max(0.3 * leg, leg * 2.55 * (1 - Math.exp(-0.675 * vh))) * (this.abnormal ? 1.1 : 1) * (1 - 0.3 * this.crawlW);
  }

  _poseGait(dt: number): void {
    const P = this.P, d = this.d, s = this.s, h = this.height;
    const sp = this.speed;
    const m = clamp(sp / 0.8, 0, 1);
    const rf = clamp(sp / this.runSpeed, 0, 1.4);
    if (m <= 0.001) return;
    const legLen = (d.thighLen + d.shinLen) * 0.97 * s;
    const stepLen = this._stepLen(sp);
    this.gait += Math.PI * sp / stepLen * dt;
    const amp = Math.asin(clamp(stepLen * 0.5 / legLen, 0, 0.8)) * m;
    const ph = this.gait;
    for (let i = 0; i < 2; i++) {
      const th = i ? 'thighR' : 'thighL', sh = i ? 'shinR' : 'shinL', ft = i ? 'footR' : 'footL';
      const p = ph + i * Math.PI;
      const sw = -amp * Math.sin(p);
      const kn = m * (0.1 + (0.3 + 0.8 * amp) * Math.pow(Math.max(0, Math.cos(p)), 1.3));
      P[th][0] += sw; P[sh][0] += kn;
      P[ft][0] += -(sw + kn) * 0.85 + 0.3 * m * Math.pow(Math.max(0, -Math.sin(p)), 2);
    }
    const bob = 0.11 * d.thighLen * m * (0.4 + Math.min(rf, 1.2));
    this.hipT.y += bob * (Math.cos(2 * ph) - 1) * 0.5 * (1 - (this.plantW || 0));   // planted feet set the pelvis height
    this.hipT.x += -0.1 * m * (0.5 + 0.5 * rf) * Math.cos(ph);
    P.pelvis[1] += -0.13 * m * (0.6 + rf) * Math.sin(ph); P.spine[1] += 0.12 * m * (0.6 + rf) * Math.sin(ph);
    P.pelvis[2] += 0.04 * m * Math.cos(ph);
    const lean = m * (0.03 + 0.1 * Math.min(rf, 1.2)) * (this.abnormal ? 1.6 : 1);
    P.spine[0] += lean; P.pelvis[0] += lean * 0.25;
    P.head[0] += 0.03 * m * Math.cos(2 * ph + 0.5);
    // arms swing opposite to the legs, hanging heavy
    const aa = m * (0.3 + 0.45 * Math.min(rf, 1.3));
    P.armL[0] += aa * Math.sin(ph); P.armR[0] -= aa * Math.sin(ph);
    P.foreL[0] -= m * (0.12 + 0.35 * rf); P.foreR[0] -= m * (0.12 + 0.35 * rf);
    // abnormals: fast flailing arms, lolling head
    if (this.abnormal) {
      const fl = clamp(rf - 0.35, 0, 1);
      P.armL[0] += fl * 1.3 * Math.sin(ph + 0.3); P.armR[0] -= fl * 1.3 * Math.sin(ph + 0.3);
      P.armL[2] += fl * (0.5 + 0.5 * Math.sin(ph * 2)); P.armR[2] -= fl * (0.5 + 0.5 * Math.sin(ph * 2 + 1.3));
      P.foreL[0] -= fl * 0.5 * (1 + Math.sin(ph * 2)); P.foreR[0] -= fl * 0.5 * (1 + Math.sin(ph * 2 + 1));
      P.head[2] += fl * 0.3 * Math.sin(ph); P.neck[1] += fl * 0.25 * Math.sin(ph * 0.5);
      this.jawExtra += 0.4 * fl;
    }
    // footfalls (planted feet report their own touchdowns, see _plantLegs)
    const idx = Math.floor((ph - Math.PI / 2) / Math.PI);
    if (idx !== this._stepIdx) { this._stepIdx = idx; if (!((this.plantW ?? 0) > 0.5)) this._footfall(idx & 1 ? 'footR' : 'footL'); }
    this.rate = 12;
  }

  /**
   * Planted feet. The gait clock (this.gait: a full cycle per two steps) says which foot is down; a planted foot's ball
   * is pinned to its spot on the ground (zero world velocity, the heel peeling up before toe-off), a swinging foot
   * arcs to the next foothold. The pelvis sinks just enough for both legs to reach, and each leg is solved
   * analytically (hip flexion + abduction, knee, foot pitch) in the pelvis frame. Units: local (unscaled) rig units.
   */
  _plantLegs(dt: number): void {
    const d = this.d, s = this.s, pel = this.J.pelvis;
    const want = !this.airborne && !this.dying && !this.isBehemoth && this.crippleT <= 0 ? 1 : 0;
    this.plantW = (this.plantW ?? want) + (want - (this.plantW ?? want)) * (1 - Math.exp(-8 * dt));
    const w = this.plantW;
    const PL: PlantState = this._plant || (this._plant = {
      init: false, drop: 0, last: 0,
      feet: [0, 1].map(() => ({ ball: new V3(), fd: new V3(), from: new V3(), to: new V3(), toBall: new V3(), ankle: new V3(), fdNow: new V3(),
        swing: false, timed: false, u: 0, u0: 0, t: 0, dur: 0.5, heel: 0, pitch: 0, fromPitch: 0, tRem: 0 })),
    });
    if (w < 0.01) { PL.init = false; PL.drop = 0; return; }
    const L1 = d.thighLen, L2 = d.shinLen, LL = L1 + L2, REACH = 0.985 * LL;
    const BALL = 0.95 * Math.sqrt(d.limb), SOLE = d.ankleH + 0.05;          // the toes (the pivot of a heel-rise) ahead of / sole below the ankle
    const sp = this.speed, stepLen = this._stepLen(sp) / s, run = this._runK;
    const moving = sp > 0.25;
    // pelvis height and the stance the legs can reach from it
    const base = LL * (0.02 + 0.03 * run);
    const H = LL - 0.1 - base, half = Math.sqrt(Math.max(0.01, REACH * REACH - H * H));
    const duty = clamp(Math.min(lerp(0.6, 0.3, run), (1.9 * half + 0.15) / (2 * stepLen)), 0.2, 0.65);
    const stance = duty * 2 * stepLen;
    const cycT = 2 * stepLen * s / Math.max(sp, 0.05);
    // the clock: psi = 0 at the left foot's touchdown (the FK gait has the left thigh furthest forward there)
    const gp = (((this.gait - Math.PI / 2) / TAU) % 1 + 1) % 1;
    const fwd = _t13.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)), lat = _t14.set(fwd.z, 0, -fwd.x);   // lat = its left
    const vel = _t15.set(fwd.x * sp, 0, fwd.z * sp);
    const ground = (out: Vec3) => { out.y = this._ground(out.x, out.z); return out; };
    const thighs = [this.J.thighL, this.J.thighR], shins = [this.J.shinL, this.J.shinR], feet = [this.J.footL, this.J.footR];
    const ankleFromBall = (_f: PlantFoot, ball: Vec3, fd: Vec3, heel: number, out: Vec3) => {
      const c = Math.cos(heel), sn = Math.sin(heel);
      return out.copy(ball).addScaledVector(fd, (-BALL * c + SOLE * sn) * s).addScaledVector(UP, (BALL * sn + SOLE * c) * s);
    };
    if (!PL.init) {
      for (let i = 0; i < 2; i++) {
        const f = PL.feet[i];
        feet[i].getWorldPosition(f.ankle);
        f.fd.copy(fwd);
        f.ball.copy(f.ankle).addScaledVector(fwd, BALL * s); ground(f.ball);
        f.swing = false; f.timed = false; f.heel = 0;
      }
      PL.init = true;
    }
    const foothold = (i: number, tAhead: number, out: Vec3) => {
      const ahead = moving ? stance * lerp(0.48, 0.42, run) : (i ? -0.08 : 0.12) * LL;
      out.copy(this.position).addScaledVector(vel, moving ? tAhead : 0)
        .addScaledVector(fwd, (ahead + BALL * 0.5) * s).addScaledVector(lat, (i ? -1 : 1) * d.hipX * s * 1.05);
      return ground(out);
    };
    const startSwing = (f: PlantFoot, dur: number) => { f.swing = true; f.timed = dur > 0; f.t = 0; f.dur = dur; f.u = 0; f.from.copy(f.ankle); f.fromPitch = f.pitch; };
    for (let i = 0; i < 2; i++) {
      const f = PL.feet[i];
      if (moving && !f.timed) {
        const psi = (gp + 0.5 * i) % 1, inStance = psi < duty, u = (psi - duty) / (1 - duty);
        if (f.swing && inStance && f.u > 0.5) { f.swing = false; f.ball.copy(f.toBall); f.fd.copy(fwd); f.heel = 0; this._footfall(i ? 'footR' : 'footL'); }
        else if (!f.swing && !inStance) { startSwing(f, 0); f.u0 = u; }
        if (f.swing) { f.u = clamp((u - f.u0) / Math.max(1e-3, 1 - f.u0), 0, 1); f.tRem = (1 - u) * (1 - duty) * cycT; }
        if (!f.swing) f.heel = lerp(0.3, 0.5, run) * sm((psi - 0.45 * duty) / (0.55 * duty));
      } else if (f.timed) {
        f.t += dt; f.u = clamp(f.t / f.dur, 0, 1); f.tRem = f.dur - f.t;
        if (f.u >= 1) { f.swing = false; f.timed = false; f.ball.copy(f.toBall); f.fd.copy(fwd); f.heel = 0; this._footfall(i ? 'footR' : 'footL'); }
      } else if (f.swing) { f.timed = true; f.dur = (0.3 + 0.25 * (1 - f.u)) * Math.sqrt(this.height / 5); f.t = f.u * f.dur; }
      else f.heel *= Math.exp(-6 * dt);
    }
    // standing or turning on the spot: a foot left out of place (or pointing the wrong way) steps over
    if (!moving && !PL.feet[0].swing && !PL.feet[1].swing) {
      let worst = -1, we = 0.22 * LL * s;
      for (let i = 0; i < 2; i++) {
        const f = PL.feet[i], tgt = foothold(i, 0, _t16);
        const e = hypot(f.ball.x - tgt.x, f.ball.z - tgt.z) + 0.4 * LL * s * (1 - f.fd.dot(fwd));
        if (e > we) { we = e; worst = i; }
      }
      if (worst >= 0) startSwing(PL.feet[worst], 0.45 * Math.sqrt(this.height / 5));
    }
    const lift = lerp(0.1, 0.24, run) * LL * s;
    for (let i = 0; i < 2; i++) {
      const f = PL.feet[i];
      if (f.swing) {
        foothold(i, f.tRem, f.toBall);
        ankleFromBall(f, f.toBall, fwd, 0, f.to);
        const e = sm(f.u);
        f.ankle.lerpVectors(f.from, f.to, e);
        f.ankle.y += (f.timed ? 0.6 : 1) * lift * Math.sin(Math.PI * Math.pow(f.u, lerp(1, 0.75, run)));
        f.pitch = lerp(f.fromPitch, -0.12, sm((f.u - 0.15) / 0.7)) + 0.35 * run * Math.sin(Math.PI * f.u);
        f.fdNow = fwd;
      } else {
        ankleFromBall(f, f.ball, f.fd, f.heel, f.ankle);
        f.pitch = f.heel; f.fdNow = f.fd;
      }
    }
    // the pelvis sinks until the planted feet are in reach
    let need = base;
    for (let i = 0; i < 2; i++) {
      const f = PL.feet[i];
      if (f.swing && f.u < 0.9) continue;
      const hw = thighs[i].getWorldPosition(_t17);
      const vert = (hw.y - f.ankle.y) / s, horiz = hypot(hw.x - f.ankle.x, hw.z - f.ankle.z) / s;
      const h2 = Math.min(horiz, REACH * 0.97);
      need = Math.max(need, vert - Math.sqrt(REACH * REACH - h2 * h2));
    }
    need = Math.min(need, 0.45 * LL);
    PL.drop = need > PL.drop ? need : PL.drop + (need - PL.drop) * (1 - Math.exp(-8 * dt));
    pel.position.y -= PL.drop * w;
    pel.updateMatrixWorld(true);
    // solve each leg in the pelvis frame (thigh = Rx(hx)·Rz(hz), knee = Rx(kx)), then pitch the foot
    _mi.copy(pel.matrixWorld).invert();
    for (let i = 0; i < 2; i++) {
      const f = PL.feet[i], th = thighs[i], sh = shins[i], ft = feet[i];
      const tl = _t18.copy(f.ankle).applyMatrix4(_mi).sub(th.position);
      const dd = _t19.copy(tl);
      let hx = 0, hz = 0, kx = 0;
      for (let pass = 0; pass < 3; pass++) {
        const D = clamp(dd.length(), 0.3 * LL, REACH);
        const dn0 = Math.sqrt(dd.y * dd.y + dd.z * dd.z) || 1e-4;
        hz = Math.atan2(dd.x, dn0);
        const dn = dd.x * Math.sin(hz) - dd.y * Math.cos(hz);
        const line = Math.atan2(-dd.z, dn);
        const beta = Math.acos(clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1));
        const gamma = Math.acos(clamp((L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2), -1, 1));
        hx = line - beta; kx = Math.PI - gamma;
        if (pass === 2) break;
        const sx = Math.sin(hx), cx = Math.cos(hx), sz = Math.sin(hz), cz = Math.cos(hz), sk = Math.sin(kx), ck = Math.cos(kx);
        const lx = L1 * sz + L2 * ck * sz, ly = -L1 * cz - L2 * ck * cz, lz = -L2 * sk;
        dd.x += tl.x - lx; dd.y += tl.y - (ly * cx - lz * sx); dd.z += tl.z - (ly * sx + lz * cx);
      }
      _q0.setFromEuler(_eu.set(hx, 0, hz, 'YXZ')); th.quaternion.slerp(_q0, w);
      _q0.setFromEuler(_eu.set(kx, 0, 0, 'YXZ')); sh.quaternion.slerp(_q0, w);
      th.updateMatrixWorld(true);
      // foot: pointing along its foothold's heading (not swaying with the hips), toe-down by its pitch
      footQuat(f.fdNow, f.pitch, _q0);
      sh.getWorldQuaternion(_q1).invert();
      ft.quaternion.slerp(_q0.premultiply(_q1), w);
    }
    this.root.updateMatrixWorld(true);
  }

  _footfall(joint: JointName): void {
    if (this.speed < 0.6) return;
    const fp = this._jpos(joint, new V3()); fp.y = this._ground(fp.x, fp.z);
    this.game.audio?.titanStep?.(fp, this.height);
    this.game.events?.emit?.('titan:step', { position: fp, size: this.height, titan: this });
    this._stepWeight(fp);
  }

  /**
   * The weight of a footfall: the camera shakes and a ring of dust kicks out round the foot, both scaled by the
   * titan's height and fading with distance (subtle for a 4 m titan or a far one, strong for a 15 m one close by);
   * big titans also settle heavily onto the step (stepJolt, see _buildPose).
   */
  _stepWeight(fp: Vec3): void {
    const h = this.height, g = this.game;
    const heavy = clamp((h - 4) / 11, 0, 1.4);
    this.stepJolt = Math.min(1.3, this.stepJolt * 0.4 + heavy); this.stepJoltT = 0;
    const pl = this._pl, pp = pl?.render || pl?.position;
    if (pp && pl.cam) {
      const dist = pp.distanceTo(fp), R = 2.2 * h + 6;
      const want = 0.62 * Math.pow(clamp(h / 15, 0, 1.6), 1.6) * Math.exp(-(dist / R) * (dist / R));
      // (the core's titan:step listener adds its own small kick; this only lifts it to the titan's weight)
      if (want > 0.01) pl.cam.trauma = Math.min(1, Math.max(pl.cam.trauma, want));
    }
    const fx = g.fx, cam = g.camera?.position;
    if (!fx?.impact) return;
    const dc = cam ? cam.distanceTo(fp) : 0;
    if (dc > 140 + 8 * h) return;                                        // too far to see
    const n = dc > 70 + 4 * h ? 1 : Math.round(clamp(2 + h / 3, 3, 8));
    const r = n === 1 ? 0 : 0.09 * h + 0.3;
    const a0 = R.fx() * TAU;                                    // (cosmetic: keeps the AI rng sequence untouched)
    for (let i = 0; i < n; i++) {
      const a = a0 + i * TAU / n, ca = Math.cos(a), sa = Math.sin(a);
      _t20.set(fp.x + ca * r, fp.y + 0.05, fp.z + sa * r);
      _t21.set(ca, n === 1 ? 1 : 0.3, sa).normalize();                   // dust rolls outward along the ground
      fx.impact(_t20, _t21, 'ground');
    }
  }

  /**
   * A leg is gone: it cannot stand. It goes over like a felled tree (about its heels, onto its chest or its back,
   * see downSign), lands with a thud that shakes the ground and brings down whatever house is under it, and lies
   * there until the leg has grown back; then it pushes itself up again.
   */
  _fallDown(dt: number): void {
    const legless = Math.max(this.sevLeg[0], this.sevLeg[1]);
    const want = legless > TT.grow * 0.45 ? 1 : 0;
    if (!want && this.down <= 0) { if (this.root.rotation.x !== 0) this.root.rotation.x = 0; return; }
    // falling: under a second, gathering speed. Getting up: slower, a heave
    const before = this.down;
    this.down = clamp(this.down + (want ? dt / 0.85 : -dt / 1.5), 0, 1);
    if (want && !this._downHit && this.down >= 1) {
      this._downHit = true;
      const h = this.height, g = this.game;
      const fx = Math.sin(this.yaw) * this.downSign, fz = Math.cos(this.yaw) * this.downSign;
      for (let i = 1; i <= 4; i++) {
        const at = _t22.set(this.position.x + fx * h * i * 0.24, 0, this.position.z + fz * h * i * 0.24);
        at.y = this._ground(at.x, at.z) + 0.2;
        g.fx?.impact?.(at, UP, 'ground');
        g.world?.smash?.(at, h * 0.2 + 1.5);
      }
      g.audio?.titanFall?.(this.position, h);
      g.events?.emit?.('titan:step', { position: this._headWorld(new V3()), size: h * 2.2, titan: this });
      g.events?.emit?.('titan:down', { titan: this, chest: this.downSign > 0 });
    }
    if (!want && before > 0 && this.down <= 0) this._downHit = false;
    // (about the heels, like the death topple; the body's thickness keeps it on the ground, not in it)
    const k = want ? this.down * this.down : this.down * this.down * (3 - 2 * this.down);
    const ang = this.downSign * (Math.PI / 2) * k;
    this.root.rotation.x = ang;
    this.position.y += 1.15 * this.s * Math.abs(Math.sin(ang));
  }
  /** Lying flat: limbs sprawled, the good leg dragging, the head lifted to see what is coming. */
  _poseDown(): void {
    const P = this.P, k = this.down, sgn = this.downSign, t = this.t;
    P.thighL[0] += -0.15 * k; P.thighR[0] += -0.1 * k; P.shinL[0] += 0.25 * k; P.shinR[0] += 0.2 * k;
    P.thighL[2] += 0.12 * k; P.thighR[2] -= 0.12 * k;
    // on its chest the arms reach out ahead and paw at the ground; on its back they are thrown wide
    if (sgn > 0) {
      P.armL[0] += (-2.2 + 0.25 * Math.sin(t * 1.7)) * k; P.armR[0] += (-2.0 + 0.25 * Math.sin(t * 1.7 + 2)) * k;
      P.armL[2] += 0.45 * k; P.armR[2] -= 0.45 * k; P.foreL[0] += -0.5 * k; P.foreR[0] += -0.6 * k;
      P.head[0] += -0.75 * k; P.neck[0] += -0.35 * k; P.spine[0] += -0.12 * k;
    } else {
      P.armL[2] += 1.15 * k; P.armR[2] -= 1.15 * k; P.armL[0] += (0.3 + 0.2 * Math.sin(t * 1.4)) * k; P.armR[0] += (0.25 + 0.2 * Math.sin(t * 1.4 + 1.6)) * k;
      P.foreL[0] += -0.7 * k; P.foreR[0] += -0.6 * k;
      P.head[0] += 0.5 * k; P.neck[0] += 0.3 * k; P.spine[0] += 0.1 * k;
    }
    this.jawExtra += 0.25 * k;
  }

  _poseKneel(): void {
    const P = this.P, d = this.d;
    P.thighL[0] += -0.2; P.thighR[0] += -0.2; P.shinL[0] += 1.5; P.shinR[0] += 1.5;
    P.footL[0] += -1.25; P.footR[0] += -1.25;
    P.thighL[2] += 0.05; P.thighR[2] -= 0.05;
    this.hipT.y += -(d.shinLen + d.ankleH - 0.55);
    P.spine[0] += 0.22; P.head[0] += -0.1;
    P.armL[0] += -0.35; P.armR[0] += -0.35;
  }

  /**
   * Crawling abnormal: torso pitched nearly flat, hips dropped on bent legs, hands planted on the ground ahead of
   * the shoulders in a trot (left hand with the right foot). Blends out (rears up) for attacks, stuns and blindness.
   */
  _poseCrawl(dt: number): void {
    const st = this.state;
    const want = this.crippleT <= 0 && this.blindT <= 0 && !this.airborne && (st === 'idle' || st === 'wander' || st === 'chase') ? 1 : 0;
    this.crawlW += (want - this.crawlW) * (1 - Math.exp(-7 * dt));
    const w = this.crawlW;
    if (w < 0.01) return;
    const P = this.P, d = this.d, s = this.s;
    // pitch: pelvis + spine; thigh / shin world angles from vertical (negative = forward); feet flat
    const PP = 1.0, SP = 0.32, TA = -0.85, SA = 0.55;
    P.pelvis[0] += PP * w; P.spine[0] += SP * w;
    P.thighL[0] += (TA - PP) * w; P.thighR[0] += (TA - PP) * w;
    P.shinL[0] += (SA - TA) * w; P.shinR[0] += (SA - TA) * w;
    P.footL[0] += -SA * w; P.footR[0] += -SA * w;
    P.thighL[2] += 0.14 * w; P.thighR[2] -= 0.14 * w;
    this.hipT.y -= w * (d.thighLen * (1 - Math.cos(TA)) + d.shinLen * (1 - Math.cos(SA)));
    this.jawExtra += 0.25 * w;
    // hands: ground targets in the titan's yaw frame, swinging with the gait phase
    const m = clamp(this.speed / 0.8, 0, 1), rf = clamp(this.speed / this.runSpeed, 0, 1.4);
    const stepLen = this.height * (0.30 + 0.30 * Math.min(rf, 1.2)) * 1.15 * 0.7;
    const reachZ = (d.spineY + d.shoulderY) * Math.sin(PP + SP) * s + 0.32 * this.armLen;
    const gy = this.position.y + 0.45 * d.handS * s;
    for (let i = 0; i < 2; i++) {
      if (this.severed[i] > 0) continue;
      const pa = this.gait + (i === 0 ? Math.PI : 0);        // left hand pairs with the right foot
      const z = reachZ + 0.5 * stepLen * Math.sin(pa) * m;
      const lift = 0.18 * stepLen * m * Math.max(0, Math.cos(pa));
      this._fp(sideSign(i) * d.shoulderX * s * 1.2, 0, z, _tw);
      _tw.y = gy + lift;
      this._arm(i, _tw, this._pole(i, 0.55, -1, 0.15), 16);
      this.ik[i].wT = w;
    }
  }

  /** arm IK request. targetWorld: Vector3, poleLocal: direction in spine space the elbow should point to */
  _arm(side: number, target: Vec3, pole: Vec3, rate = 14): void {
    const a = this.ik[side];
    a.wT = 1; a.rate = rate; a.tgt.copy(target); a.pole.copy(pole);
  }
  _pole(side: number, x: number, y: number, z: number): Vec3 { return _pl.set((side === 0 ? 1 : -1) * x, y, z); }

  _poseState(_dt: number): void {
    const P = this.P, s = this.s, st = this.state, a = this.act;
    const sgn = (side: number) => (side === 0 ? 1 : -1);
    if (this.blindT > 0 || st === 'blind') {
      // both hands clamped over the eyes, head shaking, stumbling
      const hw = this._headWorld(_t13), t = this.t;
      const f = _t14.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const ax = Math.cos(this.yaw), az = -Math.sin(this.yaw);   // titan-left in world
      for (let i = 0; i < 2; i++) {
        const sg = sgn(i);
        _t15.set(hw.x + f.x * this.d.rz * 0.9 * s * 1.0 + ax * sg * this.d.headR * 0.42 * s, hw.y + this.d.headR * 0.14 * s, hw.z + f.z * this.d.rz * 0.9 * s + az * sg * this.d.headR * 0.42 * s);
        this._arm(i, _t15, this._pole(i, 1.0, 0.1, -0.2), 16);
      }
      P.head[2] += 0.25 * Math.sin(t * 9); P.head[1] += 0.2 * Math.sin(t * 7.3); P.spine[0] += 0.28; P.spine[2] += 0.1 * Math.sin(t * 3.3);
      this.jawExtra += 0.35;
      P.thighL[0] += -0.1; P.thighR[0] += -0.1; P.shinL[0] += 0.2; P.shinR[0] += 0.2;
      this.rate = 14;
      return;
    }
    switch (st) {
      case 'leap': this._poseLeap(); break;
      case 'reach': if (a) this._poseReach(); break;
      case 'grab': if (a) this._poseGrab(); break;
      case 'swat': if (a) this._poseSwat(); break;
      case 'bite': if (a) this._poseBite(); break;
      case 'yank': if (a) this._poseYank(); break;
      case 'shake': if (a) this._poseShake(); break;
      case 'guard': if (a) this._poseGuard(); break;
      case 'charge': if (a && a.t < (a as ChargeAct).W) this._poseChargeWindup(); break;
      case 'maul': if (this.mauling && (this.drawnTo || this.game.escort)) this._poseMaul(); break;
      case 'chew': {
        const t = this.stateT;
        this.jawExtra += 0.22 + 0.22 * Math.sin(t * 11);
        P.head[0] += -0.1 + 0.08 * Math.sin(t * 11); P.spine[0] += -0.05;
        break;
      }
      case 'stun': {
        const t = this.stateT;
        P.spine[0] += -0.2 + 0.06 * Math.sin(t * 8); P.head[0] += -0.3; P.armL[0] += -0.4; P.armR[0] += -0.4;
        P.armL[2] += 0.35; P.armR[2] -= 0.35;
        break;
      }
      default: break;
    }
  }

  /** Clawing and pounding at the target's chest and arms, the hands in turn. */
  _poseMaul(): void {
    const P = this.P, esc: MaulTarget = (this.drawnTo || this.game.escort)!, t = this.stateT;
    const c = esc._jpos('spine', _t13);
    for (let i = 0; i < 2; i++) {
      const ph = Math.sin(t * 4.5 + i * Math.PI), out = 0.5 + 0.5 * ph;
      _t15.copy(c).sub(this.position); _t15.y = 0; const l = _t15.length() || 1;
      const lx = Math.cos(this.yaw) * (i === 0 ? 1 : -1), lz = -Math.sin(this.yaw) * (i === 0 ? 1 : -1);
      _t14.set(c.x - _t15.x / l * esc.footR * (0.4 + 1.2 * out) + lx * 0.15 * this.height, Math.min(c.y, this.position.y + this.shoulderH * 1.05) + out * 0.15 * this.height, c.z - _t15.z / l * esc.footR * (0.4 + 1.2 * out) + lz * 0.15 * this.height);
      this._arm(i, _t14, this._pole(i, 0.8, -0.6, -0.2), 12);
    }
    P.spine[0] += 0.25; P.head[0] += -0.2; this.jawExtra += 0.3 + 0.2 * Math.sin(t * 9);
  }

  _shoulderRel(side: number, out: Vec3): Vec3 { return out.set(sideSign(side) * this.d.shoulderX * this.s, this.shoulderH, 0); }

  _poseReach(): void {
    const P = this.P, a = this.act as ReachAct, A = this.armLen, side = a.side, sg = sideSign(side);
    const tE = a.W + a.E;
    let w: number;
    if (a.t < a.W) {
      w = sm(a.t / a.W);
      // wind up (readable tell): arm cocked back, high and out with the hand open, torso and head lean back, jaw drops
      this._fp(sg * (this.d.shoulderX * this.s + 0.35 * A), this.shoulderH + 0.25 * A, -0.45 * A, _tw);
      this._arm(side, _tw, this._pole(side, 0.8, -0.4, -0.2), 16);
      P.spine[0] += -0.24 * w; P.spine[1] += sg * 0.3 * w;
      P.neck[0] += -0.12 * w; P.head[0] += -0.22 * w;
      this.jawExtra += 0.45 * w;
    } else {
      const u = clamp((a.t - a.W) / a.E, 0, 1);
      const e = a.t < tE ? sm(u) : 1;
      this.jawExtra += 0.45 * (1 - e) + 0.15;
      this._fp(sg * (this.d.shoulderX * this.s + 0.35 * A), this.shoulderH + 0.25 * A, -0.45 * A, _tw);
      _tw2.copy(a.pred);
      if (a.t >= tE && (a.ally || this.hasPlayer)) a.pred.lerp(a.ally ? a.ally.pos : this._pl.position, 0.15);
      _tw.lerp(_tw2, e);
      let retract = 0;
      if (a.t > tE + a.H) retract = sm((a.t - tE - a.H) / a.R);
      if (retract > 0) { this._fp(sg * (this.d.shoulderX * this.s + 0.1 * A), this.shoulderH - 0.4 * A, 0.1 * A, _tw3); _tw.lerp(_tw3, retract); }
      this._arm(side, _tw, this._pole(side, 0.6, -0.8, -0.3), a.t < tE ? 22 : 12);
      P.spine[0] += 0.28 * e * (1 - retract); P.spine[1] += clamp(this.relYaw, -0.7, 0.7) * 0.3 * e;
      // stoop (bend at the hips, knees give) when the target is low
      const gy = this.position.y;
      const need = clamp((this.shoulderH * 0.85 - (a.pred.y - gy)) / (this.shoulderH * 0.7), 0, 1);
      const stp = need * e * (1 - retract);
      P.pelvis[0] += 0.75 * stp; P.thighL[0] += -1.0 * stp; P.thighR[0] += -1.0 * stp;
      P.shinL[0] += 0.5 * stp; P.shinR[0] += 0.5 * stp; P.footL[0] += -0.25 * stp; P.footR[0] += -0.25 * stp;
      P.spine[0] += 0.3 * stp; this.hipT.y += -0.28 * this.d.thighLen * stp;
    }
    this.jawExtra += 0.2;
  }

  _poseGrab(): void {
    const P = this.P, a = this.act as GrabAct, side = a.side;
    const u = sm(a.t / a.dur);
    // from the hand's grab position up in front of the chest (forearm level, elbow down: the fist upright, so the
    // soldier is held upright in it, head and shoulders out of the top), then raised to the mouth
    const mouth = this._mouthWorld(_tw);
    if (!a.start) { a.start = this._jpos(side === 0 ? 'handL' : 'handR', new V3()); }
    const sg = sideSign(side), A = this.armLen;
    this._fp(sg * this.d.shoulderX * this.s * 0.55, this.shoulderH - 0.42 * A, 0.5 * A, _tw3);
    const u1 = sm(a.t / (0.32 * a.dur)), u2 = sm((a.t - 0.42 * a.dur) / (0.58 * a.dur));
    _tw2.copy(a.start).lerp(_tw3, u1).lerp(mouth, u2);
    this._arm(side, _tw2, this._pole(side, 0.35, -1, -0.15), 14);
    // the other hand: held up, clenched
    const o = 1 - side;
    this._fp(sideSign(o) * (this.d.shoulderX * this.s + 0.15 * this.armLen), this.shoulderH - 0.15 * this.armLen, 0.3 * this.armLen, _tw3);
    this._arm(o, _tw3, this._pole(o, 0.8, -0.6, -0.2), 8);
    P.head[0] += -0.38 * u; P.neck[0] += -0.12 * u; P.spine[0] += -0.1 * u;
    this.jawExtra += 0.75 * u;
  }

  _poseSwat(): void {
    const P = this.P, a = this.act as SwatAct, A = this.armLen, side = a.side, sg = sideSign(side);
    const tS = a.W + a.S;
    const mid = a.mid;
    // swing across the player's position from the outside in
    const dirH = _t16.set(mid.x - this.position.x, 0, mid.z - this.position.z);
    if (dirH.lengthSq() < 1e-4) dirH.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    dirH.normalize();
    const perp = _t17.set(dirH.z, 0, -dirH.x).multiplyScalar(sg * 0.75 * A);   // sg>0: from the titan-left side
    a.p0.copy(mid).add(perp); a.p1.copy(mid).sub(perp);
    const sh = this._jpos(side === 0 ? 'armL' : 'armR', _t18);
    // keep path points within a sane reach of the shoulder (the IK clamps the rest)
    if (a.t < a.W) {
      const w = sm(a.t / a.W);
      _tw.copy(a.p0); _tw.y = Math.max(_tw.y, sh.y + 0.15 * A);
      _tw.lerp(_tw3.copy(sh).add(_t19.set(sg * 0.5 * A, 0.3 * A, 0).applyAxisAngle(UP, this.yaw)), 1 - w);
      // wind-up tell: twist away, lean back, head back, jaw open
      P.spine[1] += sg * 0.4 * w; P.spine[0] += -0.2 * w;
      P.neck[0] += -0.1 * w; P.head[0] += -0.18 * w;
      this.jawExtra += 0.45 * w;
    } else if (a.t < tS) {
      const e = sm((a.t - a.W) / a.S);
      _tw.copy(a.p0).lerp(a.p1, e);
      P.spine[1] += sg * 0.35 * (1 - 2 * e); P.spine[0] += 0.12 * e;
    } else {
      const rr = sm((a.t - tS) / a.R);
      _tw.copy(a.p1).lerp(_tw3.copy(sh).add(_t19.set(sg * 0.2 * A, -0.5 * A, 0.1 * A).applyAxisAngle(UP, this.yaw)), rr);
      P.spine[1] += -sg * 0.35 * (1 - rr);
    }
    this._arm(side, _tw, this._pole(side, 0.9, 0.2, -0.3), a.t < tS ? 26 : 10);
  }

  _poseBite(): void {
    const P = this.P, a = this.act as BiteAct;
    let k: number;
    if (a.t < a.W) { k = sm(a.t / a.W); P.head[0] += -0.35 * k; P.spine[0] += -0.15 * k; this.jawExtra += 0.9 * k; }
    else if (a.t < a.W + a.B) { const u = sm((a.t - a.W) / a.B); P.head[0] += lerp(-0.35, 0.4, u); P.neck[0] += 0.3 * u; P.spine[0] += lerp(-0.15, 0.45, u); this.jawExtra += 0.9 * (1 - u); }
    else { const u = sm((a.t - a.W - a.B) / a.R); P.head[0] += 0.4 * (1 - u); P.neck[0] += 0.3 * (1 - u); P.spine[0] += 0.45 * (1 - u); this.jawExtra += 0.1 * (1 - u); }
    this.rate = 22;
  }

  /** leap: deep crouch with arms thrown back (wind-up), arms-first dive (air), heavy squat with hands slammed down (landing) */
  _poseLeap(): void {
    const P = this.P, d = this.d, L = this.leap;
    const crouch = (k: number, lean: number) => {
      // thighs 0.95 rad forward, shins 0.65 back (world), feet flat; pelvis pitched by `lean`
      const TA = -0.95, SA = 0.65;
      P.pelvis[0] += lean * k; P.spine[0] += lean * k;
      P.thighL[0] += (TA - lean) * k; P.thighR[0] += (TA - lean) * k;
      P.shinL[0] += (SA - TA) * k; P.shinR[0] += (SA - TA) * k;
      P.footL[0] += -SA * k; P.footR[0] += -SA * k;
      this.hipT.y -= k * (d.thighLen * (1 - Math.cos(TA)) + d.shinLen * (1 - Math.cos(SA)));
    };
    if (L.phase === 0) {
      const w = sm(L.t / L.W);
      crouch(w, 0.35);
      P.armL[0] += 0.9 * w; P.armR[0] += 0.9 * w; P.armL[2] += 0.25 * w; P.armR[2] -= 0.25 * w;
      P.foreL[0] -= 0.4 * w; P.foreR[0] -= 0.4 * w;
      this.jawExtra += 0.6 * w;
      this.rate = 16; this.legRate = 20;
    } else if (L.phase === 1) {
      const u = clamp(L.t / L.T, 0, 1), tuck = u < 0.65 ? 1 : 1 - sm((u - 0.65) / 0.35);
      P.spine[0] += 0.45; P.pelvis[0] += 0.15;
      P.armL[0] += -2.2; P.armR[0] += -2.2; P.armL[2] += 0.45; P.armR[2] -= 0.45;
      P.foreL[0] -= 0.2; P.foreR[0] -= 0.2;
      // legs trail behind, then swing under for the landing
      P.thighL[0] += lerp(-0.7, 0.35, tuck); P.thighR[0] += lerp(-0.8, 0.5, tuck);
      P.shinL[0] += lerp(0.9, 1.1, tuck); P.shinR[0] += lerp(0.9, 1.2, tuck);
      this.jawExtra += 0.85;
      this.rate = 12; this.legRate = 14;
    } else {
      const v = 1 - sm(L.t / 0.6);
      crouch(1.15 * v, 0.55);
      P.armL[0] += -0.9 * v; P.armR[0] += -0.9 * v; P.armL[2] += 0.3 * v; P.armR[2] -= 0.3 * v;
      this.jawExtra += 0.4 * v;
      this.rate = 18; this.legRate = 24;
    }
  }

  _applyPose(dt: number): void {
    const P = this.P, ra = 1 - Math.exp(-this.rate * dt), la = 1 - Math.exp(-this.legRate * dt);
    for (const n of NAMES) {
      const v = P[n];
      const q = this.tq[n].setFromEuler(_eu.set(v[0], v[1], v[2], 'YXZ'));
      const leg = n.startsWith('thigh') || n.startsWith('shin') || n.startsWith('foot');
      this.J[n].quaternion.slerp(q, leg ? la : ra);
    }
    this.hipNow.lerp(this.hipT, ra);
    this.J.pelvis.position.set(this.hipNow.x, this.d.hipY + this.hipNow.y, this.hipNow.z);
  }

  _applyArmIK(dt: number): void {
    const spine = this.J.spine;
    let inv: THREE.Matrix4 | null = null;
    for (let side = 0; side < 2; side++) {
      const a = this.ik[side];
      a.w += (a.wT - a.w) * (1 - Math.exp(-a.rate * dt));
      if (a.w < 0.003) { a.w = a.wT === 0 ? 0 : a.w; continue; }
      if (!inv) inv = _mi.copy(spine.matrixWorld).invert();
      const arm = this.J[side === 0 ? 'armL' : 'armR'], fore = this.J[side === 0 ? 'foreL' : 'foreR'];
      _il.copy(a.tgt).applyMatrix4(inv);
      solveArm(arm.position, _il, this.d.upperLen, this.d.foreLen, a.pole, a.q1, a.q2);
      const w = a.w >= 0.995 ? 1 : sm(a.w);
      arm.quaternion.slerp(a.q1, w); fore.quaternion.slerp(a.q2, w);
    }
  }

  _post(dt: number): void {
    // pose is final; keep helpers current. Footsteps for huge titans etc. are handled in the gait.
    const ga = this.act as GrabAct | null;
    if (this.state === 'grab' && ga && !ga.start) ga.start = this._jpos(ga.side === 0 ? 'handL' : 'handR', new V3());
    // palm velocities (for the grab's relative-speed check)
    for (let i = 0; i < 2; i++) {
      const hp = this._jpos(i === 0 ? 'handL' : 'handR', _t21), prev = this._handPrev[i];
      if (this._handInit) this._handVel[i].subVectors(hp, prev).multiplyScalar(1 / dt);
      prev.copy(hp);
    }
    this._handInit = true;
  }

  // ====================================================================================== the Behemoth
  _initBehemoth(): void {
    this.appearT = 0; this.root.visible = false;
    this.steamOn = true; this.steamT = 0; this.steamDur = 9; this.steamEmit = 0; this.steamPush = 0; this.steaming = true;
    this.sweepT = -1; this.sweepCd = 7 + this.rnd() * 3; this.sweepSide = 1; this.sweepHit = false;
    this.state = 'behemoth';
    this.stepSkip = true;
  }

  /**
   * The Behemoth at the gate: it rises out of the lightning, draws its leg back, kicks the gate in, and is gone
   * again in its own steam before anyone can reach its neck.
   */
  _thinkBreach(dt: number): void {
    const B = this.breach!, fx = this.game.fx;
    this.gazeTarget = null; this.speedTarget = 0; this.speed = 0; this.faceYaw = null;
    this.steamOn = false; this.steaming = true; this.sweepT = -1;
    if ((this.appearT ?? 1) < 0.25) return;
    B.t += dt;
    const going = B.t > BREACH.vanish;
    this.steamEmit -= dt;
    if (this.steamEmit <= 0) {
      this.steamEmit = going ? 0.035 : 0.3;
      const parts: JointName[] = ['armL', 'armR', 'spine', 'head', 'thighL', 'thighR', 'pelvis', 'foreL', 'foreR', 'shinL', 'shinR'];
      const p = this._jpos(parts[Math.floor(this.rnd() * parts.length)], _t20);
      p.x += (this.rnd() - 0.5) * 9; p.z += (this.rnd() - 0.5) * 9;
      fx?.steam?.(p, going ? 16 + this.rnd() * 14 : 7 + this.rnd() * 6, going ? 3.2 : 3);
    }
    if (!B.kicked && B.t >= BREACH.kick) {
      B.kicked = true;
      this.game.events?.emit?.('gate:breached', { titan: this, position: this._jpos('footR', new V3()) });
    }
    if (going && !B.flash && B.t > BREACH.vanish + 1.2) {
      // gone: a last flash, and only the steam is left standing there
      B.flash = true;
      fx?.lightning?.(this.position.clone(), this.height);
      this.game.audio?.steamHiss?.(this.position, this.height);
      this.root.visible = false;
      this._removeColliders();
    }
    if (B.t > BREACH.vanish + 2.4) {
      this.game.events?.emit?.('behemoth:gone', { titan: this });
      this.dispose();
    }
  }

  /** The cutscene was skipped: the gate goes now if it has not yet, and the Behemoth is gone on its next step. */
  finishBreach(): void {
    const B = this.breach;
    if (!B || this.dead) return;
    if (!B.kicked) { B.kicked = true; this.game.events?.emit?.('gate:breached', { titan: this, position: this._jpos('footR', new V3()) }); }
    B.flash = true; this.root.visible = false; this._removeColliders();
    B.t = BREACH.vanish + 3;
  }

  _thinkBehemoth(dt: number): void {
    if (this.breach) { this._thinkBreach(dt); return; }
    const pl = this._pl, fx = this.game.fx;
    // steam vent cycle: ~9 s of scalding steam, ~6 s of quiet windows in which the nape can be attacked
    this.steamT += dt;
    if (this.steamT >= this.steamDur) {
      this.steamOn = !this.steamOn; this.steamT = 0;
      this.steamDur = this.steamOn ? 8 + this.rnd() * 3 : 6 + this.rnd() * 0.5;
      this.steaming = this.steamOn;
      if (this.steamOn) {
        const c = this.position.clone(); c.y += this.height * 0.6;
        fx?.steam?.(c, 16, 4); this.game.audio?.steamHiss?.(this.position, this.height);
      }
    }
    this.gazeTarget = this.hasPlayer ? pl.position : null;
    this.speedTarget = 0; this.speed = 0;
    this.faceYaw = null;
    if (this.steamOn && (this.appearT ?? 0) >= 0.25) {
      this.steamEmit -= dt;
      if (this.steamEmit <= 0) {
        this.steamEmit = 0.22;
        const p = _t20;
        const parts: JointName[] = ['armL', 'armR', 'spine', 'head', 'thighL', 'thighR', 'pelvis', 'foreL', 'foreR'];
        const nm = parts[Math.floor(this.rnd() * parts.length)];
        this._jpos(nm, p);
        p.x += (this.rnd() - 0.5) * 8; p.z += (this.rnd() - 0.5) * 8;
        fx?.steam?.(p, 7 + this.rnd() * 8, 3.5);
      }
      this.steamPush -= dt;
      if (this.steamPush <= 0) {
        this.steamPush = 0.45;
        if (this.hasPlayer && this.distH < 35 && pl.applyImpulse) {
          const dir = _t21.set(pl.position.x - this.position.x, 0, pl.position.z - this.position.z);
          if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
          dir.normalize(); dir.y = 0.3; dir.normalize().multiplyScalar(25);
          pl.applyImpulse(dir, 10);
          fx?.steam?.(pl.position.clone().addScaledVector(dir, -0.04), 5, 1.5);
        }
      }
    }
    // arm sweep across the wall top
    if (this.sweepT >= 0) {
      this.sweepT += dt;
      if (this.sweepT > 6) { this.sweepT = -1; this.sweepCd = 9 + this.rnd() * 5; }
    } else {
      this.sweepCd -= dt;
      const nearWall = this.hasPlayer && pl.position.y > 25 && Math.abs(pl.position.z) < 25;
      if (this.sweepCd <= 0 || (nearWall && this.sweepCd < 4 && this.rnd() < 0.5 * dt)) {
        this.sweepT = 0; this.sweepHit = false; this.sweepSide = -this.sweepSide;
      }
    }
  }

  _poseBehemoth(_dt: number): void {
    const P = this.P, A = this.armLen;
    this.rate = 6;
    P.spine[0] += 0.06; P.head[0] += 0.0;
    P.armL[2] += 0.12; P.armR[2] -= 0.12;
    if (this.breach) {
      // the kick: the right leg drawn back and bent, then swung through the gate, then set down again
      const t = this.breach.t, K = BREACH;
      let th = 0, sh = 0, lean = 0;
      if (t > K.wind && t < K.back) { const w = sm((t - K.wind) / (K.back - K.wind)); th = 0.6 * w; sh = 1.05 * w; lean = -0.1 * w; }
      else if (t >= K.back && t < K.swing) { const w = sm((t - K.back) / (K.swing - K.back)); th = lerp(0.6, -1.2, w); sh = lerp(1.05, 0.05, w); lean = lerp(-0.1, 0.16, w); }
      else if (t >= K.swing && t < K.down) { const w = sm((t - K.swing) / (K.down - K.swing)); th = lerp(-1.2, 0, w); sh = lerp(0.05, 0, w); lean = lerp(0.16, 0.04, w); }
      P.thighR[0] += th; P.shinR[0] += sh; P.spine[0] += lean; P.pelvis[0] += lean * 0.4;
      P.armL[0] += -th * 0.35; P.armR[0] += th * 0.35;
      return;
    }
    if (this.sweepT < 0) return;
    // sweep: right arm from outside across the wall top (or mirrored)
    const t = this.sweepT, side = this.sweepSide < 0 ? 1 : 0, sg = sideSign(side);
    const T1 = 1.4, T2 = 3.6, T3 = 4.2, T4 = 6;
    const sh = this._jpos(side === 0 ? 'armL' : 'armR', _t18);
    const fwd = _t16.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const left = _t17.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const Rs = 0.93 * A;
    const point = (phi: number, dy: number, out: Vec3) => out.copy(sh).addScaledVector(fwd, Math.cos(phi) * Rs).addScaledVector(left, Math.sin(phi) * Rs * sg).setY(sh.y + dy);
    let phi, dy, w;
    if (t < T1) { w = sm(t / T1); phi = -1.3; dy = lerp(-0.5, 0.15, w) * A; }
    else if (t < T2) { w = sm((t - T1) / (T2 - T1)); phi = lerp(-1.3, 1.1, w); dy = 0.0 * A + 0.1 * A * Math.sin(w * Math.PI); }
    else if (t < T3) { phi = 1.1; dy = 0.05 * A; }
    else { w = sm((t - T3) / (T4 - T3)); phi = lerp(1.1, 0.4, w); dy = lerp(0.05, -0.55, w) * A; }
    point(phi, dy, _tw);
    this._arm(side, _tw, this._pole(side, 1.0, 0.3, -0.2), 5);
    P.spine[1] += sg * clamp(phi, -1.2, 1.2) * -0.25; P.spine[0] += 0.05;
    // the hand sweeping through the player
    if (!this.sweepHit && t > T1 && t < T2 && this.hasPlayer) {
      const hp = this._jpos(side === 0 ? 'handL' : 'handR', _t10);
      const pl = this._pl;
      if (hp.distanceTo(pl.position) < 7 + 0.0 * this.height) {
        this.sweepHit = true;
        const dir = _t11.copy(left).multiplyScalar(-sg).setY(0.35).normalize().multiplyScalar(32);
        pl.applyImpulse?.(dir, 30);
        this.game.fx?.impact?.(hp, UP, 'stone');
        this.game.events?.emit?.('titan:step', { position: hp.clone(), size: this.height * 0.6, titan: this });
      }
    }
  }

  // ====================================================================================== death
  /**
   * The body collapses (knees buckle, it topples), then evaporates: thick steam pours off the whole body in rising
   * columns for several seconds while the flesh chars dark red, the limbs and torso thin down, and a noise erosion
   * eats the flesh away, leaving a charred ribcage-and-skull skeleton that crumbles last.
   * Timeline (s since death, ×1.6 for the Behemoth): char 0.3–2.9, thin 1.6–5.8, flesh erodes 2.6–6.4, bones 6.0–7.6.
   */
  _updateDying(dt: number): void {
    this.deathT += dt;
    const T = this.isBehemoth ? 3.2 : 1.5, tt = this.deathT;
    const P = this.P, fx = this.game.fx, h = this.height, s = this.s, sgn = this.fallSign;
    for (const n of NAMES) { const a = P[n]; a[0] = a[1] = a[2] = 0; }
    // pose: knees buckle, arms flung, head lolls
    const u = clamp(tt / T, 0, 1);
    P.thighL[0] += -0.5 * u; P.thighR[0] += -0.3 * u; P.shinL[0] += 0.9 * u; P.shinR[0] += 0.6 * u;
    P.footL[0] += -0.4 * u; P.footR[0] += -0.2 * u;
    P.armL[0] += -sgn * 0.9 * u; P.armR[0] += -sgn * 0.6 * u; P.armL[2] += 0.8 * u; P.armR[2] -= 0.8 * u;
    P.foreL[0] += -0.3 * u; P.foreR[0] += -0.3 * u;
    P.head[0] += sgn * -0.5 * u; P.neck[0] += sgn * -0.3 * u; P.head[2] += 0.3 * u;
    P.jaw[0] = 0.5 * u + this.arch.jawRest;
    P.spine[0] += sgn * -0.2 * u;
    this.hipT.set(0, -0.8 * u, 0);
    this.rate = 7; this.legRate = 7;
    this._applyPose(dt);
    this.ik[0].wT = this.ik[1].wT = 0;
    for (const a of this.ik) a.w = 0;
    // topple about the heels
    const ang = sgn * (Math.PI / 2) * u * u;
    let extra = 0;
    if (tt > T) { const b = tt - T; extra = sgn * 0.05 * Math.exp(-b * 6) * Math.sin(b * 22); }
    this.root.rotation.x = ang + extra;
    this.position.y = this._ground(this.position.x, this.position.z) + 1.15 * s * Math.abs(Math.sin(clamp(ang, -1.55, 1.55)));
    if (!this.fell && tt >= T) {
      this.fell = true;
      const hp = this._headWorld(new V3()); hp.y = this._ground(hp.x, hp.z) + 0.2;
      fx?.impact?.(hp, UP, 'ground');
      for (let i = 0; i < 3; i++) fx?.impact?.(hp.clone().add(new V3((R.fx() - 0.5) * h * 0.4, 0, (R.fx() - 0.5) * h * 0.4)), UP, 'ground');
      this.game.audio?.titanFall?.(this.position, h);
      this.game.audio?.steamHiss?.(this.position, h);
      this.game.events?.emit?.('titan:step', { position: hp, size: h * 2.5, titan: this });
      // what it lands on does not stand: a house under the body comes down with it
      if (!this.isBehemoth) for (let i = 1; i <= 4; i++) this.game.world?.smash?.(_t22.set(this.position.x + Math.sin(this.yaw) * sgn * h * i * 0.24, 0, this.position.z + Math.cos(this.yaw) * sgn * h * i * 0.24), h * 0.2 + 1.5);
    }
    // ---- evaporation
    const k = this.isBehemoth ? 1.6 : 1, e = tt / k;
    const ev = this.fadeMats;
    if (ev) {
      const thin = sm((e - 1.6) / 4.2);
      ev.uniforms.uDark.value = sm((e - 0.3) / 2.6);
      ev.uniforms.uErode.value = Math.pow(clamp((e - 2.6) / 3.8, 0, 1), 0.85);
      ev.boneUniforms.uErode.value = clamp((e - 6.0) / 1.6, 0, 1);
      // limbs and torso thin down toward their bones (mesh-local x/z: limbs hang along -y; feet point along +z)
      for (const m of this.rig.meshes) {
        const key = m.key, mesh = m.mesh;
        if (key === 'head' || key === 'jaw') continue;
        const w = 1 - thin * (key === 'spine' || key === 'pelvis' ? 0.32 : 0.5);
        if (key.startsWith('foot')) mesh.scale.set(w, 1, 1); else mesh.scale.set(w, 1, w);
      }
      if (!ev.noShadow && ev.uniforms.uErode.value > 0.3) {     // shadows would not show the holes
        ev.noShadow = true;
        for (const m of this.rig.meshes) m.mesh.castShadow = false;
      }
      this.root.scale.setScalar(this.s * (1 - 0.12 * sm((e - 3) / 4)));
    }
    this.root.updateMatrixWorld(true);
    this._evapSteam(dt, e);
    if (e >= 7.7) this._finish();
  }

  /**
   * Steam pours off the whole body: big puffs from joints round the body in turn (one per call, so fx.steam's
   * same-spot thinning never kicks in), ramping up after the fall and tailing off as the skeleton crumbles.
   */
  _evapSteam(dt: number, e: number): void {
    const fx = this.game.fx; if (!fx?.steam) return;
    const I = sm(e / 0.9) * (1 - sm((e - 6.2) / 1.6));
    if (I <= 0.01) return;
    this.steamEmit = (this.steamEmit ?? 0) - dt;
    if (this.steamEmit > 0) return;
    const h = this.height, col = this.isBehemoth;
    // further from the camera: fewer, bigger puffs (keeps several dying titans cheap)
    const cam = this.game.camera?.position;
    const far = cam ? clamp((cam.distanceTo(this.position) - 60 - 3 * h) / 150, 0, 1) : 0;
    this.steamEmit = (col ? 0.11 : 0.085) * (1 + 1.5 * far) / Math.max(0.35, I);
    const names = EVAP_PTS;
    const i = this._evapIdx = ((this._evapIdx ?? Math.floor(this.rnd() * names.length)) + 1) % names.length;
    const p = this._jpos(names[i], _t20);
    p.x += (this.rnd() - 0.5) * h * 0.08; p.z += (this.rnd() - 0.5) * h * 0.08;
    p.y = Math.max(p.y, this._ground(p.x, p.z) + 0.2);
    const size = (col ? h * 0.1 : Math.max(1.1, h * 0.18)) * (0.65 + 0.35 * I) * (1 + 0.4 * far);
    p.y += size * 0.45;                                  // it boils off the top of the body
    fx.steam(p, size, col ? 5.5 : 4);
    // every third puff a tall column billows up off the body: the steam towers over the corpse, not a fog on it
    if ((this._evapCol = (this._evapCol || 0) + 1) % 3 === 0) {
      const q = this._jpos(EVAP_PTS[(i + 5) % EVAP_PTS.length], _t21);
      q.x += (this.rnd() - 0.5) * h * 0.1; q.z += (this.rnd() - 0.5) * h * 0.1;
      q.y = Math.max(q.y, this._ground(q.x, q.z)) + h * (0.25 + 0.35 * this.rnd());
      fx.steam(q, size * 1.7, col ? 6.5 : 5.5);
    }
  }

  /** At death: swap in the evaporation materials and slip the charred skeleton inside the flesh. */
  _beginFade(): void {
    if (this.fadeMats) return;
    const ev = evapMaterials({ behemoth: this.isBehemoth, material: this.skinMat });
    for (const m of this.rig.meshes) m.mesh.material = ev.body;
    const G = skeletonGeometry(this.arch), J = this.J;
    const at: Record<BoneKey, JointName[]> = { pelvis: ['pelvis'], spine: ['spine'], neck: ['neck'], head: ['head'], jaw: ['jaw'], arm: ['armL', 'armR'],
      fore: ['foreL', 'foreR'], thigh: ['thighL', 'thighR'], shin: ['shinL', 'shinR'], foot: ['footL', 'footR'] };
    ev.bonesMeshes = [];
    for (const key of Object.keys(at) as BoneKey[]) for (const jn of at[key]) {
      const b = new THREE.Mesh(G[key], ev.bone);
      b.castShadow = false; b.receiveShadow = true; b.raycast = () => {};
      J[jn].add(b); ev.bonesMeshes.push(b);
    }
    this.fadeMats = ev;
  }
  _disposeFade(): void {
    const ev = this.fadeMats; if (!ev) return;
    for (const b of ev.bonesMeshes) b.removeFromParent();
    ev.body.dispose(); ev.bone.dispose();
    this.fadeMats = null;
  }
  _finish(): void {
    this.dead = true; this.dying = false;
    this._removeColliders();
    this.root.visible = false;
    if (this.root.parent) this.root.parent.remove(this.root);
    this._disposeFade();
    this.skinMat.dispose();
  }
  /** Remove immediately (manager.clear()). */
  dispose(): void {
    this.alive = false; this.dead = true; this.dying = false;
    this._releasePlayer();
    this._removeColliders();
    if (this.root.parent) this.root.parent.remove(this.root);
    this._disposeFade();
    this.skinMat.dispose();
  }
}

// how much of the stare survives each action (the action poses the head itself; a bite / reach / swat still keeps
// half an eye on its target so the mouth and the hand stay aimed)
const GAZE_W: Record<string, number> = { grab: 0, chew: 0, yank: 0, shake: 0, guard: 0, charge: 0, leap: 0, stun: 0, bite: 0.5, reach: 0.6, swat: 0.6 };
/** The Behemoth's kick at the gate, seconds from when it stands there: wind up, leg back, the swing lands (kick), set
 *  down, and from `vanish` it boils away. */
const BREACH = {
  get wind(): number { return TT.breachWind; }, get back(): number { return TT.breachBack; }, get kick(): number { return TT.breachKick; },
  get swing(): number { return TT.breachSwing; }, get down(): number { return TT.breachDown; }, get vanish(): number { return TT.breachVanish; },
};
/** Seconds until a cut-off forearm / lower leg has grown back; the new limb pushes out over the last TT.grow of them. */
const FORE_L = ['foreL'] as const, FORE_R = ['foreR'] as const, LEG_L = ['shinL', 'footL'] as const, LEG_R = ['shinR', 'footR'] as const;
const _t22 = new V3();
const HIT_ORDER: readonly TitanHitPart[] = ['nape', 'eye', 'ankle', 'hand', 'arm', 'leg', 'body'];
const EVAP_PTS: JointName[] = ['head', 'thighL', 'spine', 'shinR', 'armL', 'pelvis', 'foreR', 'neck', 'thighR', 'armR', 'shinL', 'spine', 'foreL', 'pelvis'];

function sideSign(side: number): number { return side === 0 ? 1 : -1; }
/** World orientation of a foot (+z forward, +y up) pointing along horizontal `fd`, toe-down by `pitch`. */
function footQuat(fd: Vec3, pitch: number, out: THREE.Quaternion): THREE.Quaternion {
  const z = _fq0.copy(fd).multiplyScalar(Math.cos(pitch)).addScaledVector(UP, -Math.sin(pitch)).normalize();
  const x = _fq1.crossVectors(UP, z).normalize(), y = _fq2.crossVectors(z, x);
  return out.setFromRotationMatrix(_fqm.makeBasis(x, y, z));
}

// scratch objects
const _t0 = new V3(), _t1 = new V3(), _t2 = new V3(), _t3 = new V3(), _t4 = new V3(), _t5 = new V3(), _t6 = new V3(), _t7 = new V3(), _t8 = new V3(), _t9 = new V3();
const _t10 = new V3(), _t11 = new V3(), _t12 = new V3(), _t13 = new V3(), _t14 = new V3(), _t15 = new V3(), _t16 = new V3(), _t17 = new V3(), _t18 = new V3(), _t19 = new V3(), _t20 = new V3(), _t21 = new V3();
const _tw = new V3(), _tw2 = new V3(), _tw3 = new V3(), _pl = new V3(), _il = new V3(), _g0 = new V3(), _g1 = new V3(), _dir = new V3(), _c0 = new V3();
const _q0 = new Q(), _q1 = new Q(), _eu = new EU(), _mi = new THREE.Matrix4();
const _fq0 = new V3(), _fq1 = new V3(), _fq2 = new V3(), _fqm = new THREE.Matrix4();
