// The Huntress: the shifter who stalks the Twelfth Sortie. A 14 m giant that thinks: she sprints as fast as a
// galloping horse, slaps soldiers off the back of her neck, kicks, grabs, and grows a crystal shell over her skin, so a
// blade that reaches her nape shatters on it. Cut her eyes and she sits back with both hands over her nape until one
// eye heals; cut her arms and they hang limp for a while. Her scream calls every titan near to her. The mission
// (src/missions/scout.ts) drives her: `mode` is what she does when she is free ('hold', 'run' to `runTo`, 'fight' the
// player), and strike() / bind() / scream() / brawl() script the story. The same class, built on the shifter's design
// and without the crystal, is the shifter's giant that brawls her in the last act.
import * as THREE from 'hull/three';
import { Titan } from './titan';
import type { TitanManager } from './titans';
import { GIANT } from '../brand';
import type { TitanSpec } from './builder';

const V3 = THREE.Vector3;
const clamp = THREE.MathUtils.clamp;
const sm = (x: number): number => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const UP = new V3(0, 1, 0);
/** Her builder design. */
const HUNTRESS_SPEC: TitanSpec = { build: 'female', skin: 'pale', hair: 5, expr: 'huntress' };
// states the base Titan runs for her (its attacks, grabs and guards); when they end she goes back to her mode
const BASE = new Set(['reach', 'grab', 'chew', 'swat', 'bite', 'stun', 'guard', 'yank', 'shake', 'blind']);
const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3();

let _crystalMat: THREE.MeshPhysicalMaterial | null = null;
/** The hardened shell: clear, faintly blue crystal with sharp facets and a glassy coat. */
const crystalMat = (): THREE.MeshPhysicalMaterial => _crystalMat || (_crystalMat = new THREE.MeshPhysicalMaterial({
  color: 0xd2e6ef, roughness: 0.14, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04,
  emissive: 0x16303d, emissiveIntensity: 0.6, transparent: true, opacity: 0.86, flatShading: true,
}));

/** What she does when the story leaves her to herself. */
export type HuntressMode = 'hold' | 'run' | 'fight' | 'brawl';
/** A scripted blow (see strike()). */
export type StrikeKind = 'hand' | 'punch' | 'kick' | 'stomp' | 'bite';
export interface StrikeOptions {
  /** 0 left, 1 right; default: the side the target is on */
  side?: 0 | 1 | null;
  /** lands at the strike's midpoint whatever happens (the story's deaths) */
  sure?: boolean;
  /** wind-up time override (s) */
  W?: number | null;
  /** she keeps running at the target while she swings */
  run?: boolean;
}
interface Blow {
  kind: StrikeKind; side: 0 | 1; t: number; W: number; S: number; R: number;
  get: () => THREE.Vector3; onHit?: (point: THREE.Vector3) => void;
  sure: boolean; run: boolean; hit: boolean; pt: THREE.Vector3;
}
export interface HuntressOptions {
  position: THREE.Vector3;
  yaw?: number;
  /** another shifter on the same moves (the shifter's giant brawls her with them); it does not harden */
  spec?: TitanSpec | null;
  height?: number;
}
/** A crystal piece: its full-size scale is kept here. */
type Crystal = THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshPhysicalMaterial> & { userData: { s: THREE.Vector3 } };

export class Huntress extends Titan {
  /** she, not the shifter's giant that shares her moves */
  isHuntress: boolean;
  hardens: boolean;
  name: string;
  mode: HuntressMode = 'hold';
  runTo = new V3();
  faceTo: THREE.Vector3 | null = null;
  paceMul = 1;
  /** s a blinded eye takes to heal */
  eyeHeal = 14;
  /** s each arm hangs limp after its muscles are cut */
  limp: [number, number] = [0, 0];
  hard = { nape: 0, napeT: 0, fist: [0, 0] as [number, number], always: false };
  screamT = 0;
  cdKick = 2;
  /** how much the titans her scream called have still to eat of her (while bound) */
  eatenHp = 160;
  crystal: { nape: Crystal; fist: [Crystal, Crystal] };
  /** the scripted blow in progress (state 'strike') */
  blow: Blow | null = null;
  bound = false;
  foe: Huntress | null = null;
  /** reached her run target */
  arrived = false;
  kickW = 0;
  kickLeg: 0 | 1 = 0;
  sitting = false;
  /** the mission makes her look at someone */
  lookAt: THREE.Vector3 | null = null;
  /** stooped, one hand reaching down to this point */
  reachTo: THREE.Vector3 | null = null;
  /** the shifter held in her jaws */
  carrying = false;
  /** a cut across her jaw frees him (huntress:mouth) */
  mouthOpenable = false;

  constructor(mgr: TitanManager, { position, yaw = 0, spec = null, height = 14 }: HuntressOptions) {
    super(mgr, { kind: 'normal', height, position, yaw, spec: spec || HUNTRESS_SPEC });
    this.isHuntress = !spec;
    this.hardens = !spec;
    this.name = spec ? GIANT.shifterGiant : GIANT.huntress;
    this.napeHp = Infinity;                 // nobody cuts this nape: it hardens first
    this.runSpeed = 15.5; this.walkSpeed = 3.4; this.turnRate = 2.4; this.noticeRange = 400;
    this.tiltBias = 0;                      // no dull titan head-tilt: a level, steady stare
    this.jawCap = 0.03;                     // mouth shut; opened only to bite, scream, or with the shifter in it (_poseState)
    this._squadBy = 99;                     // comrades' AI pairs never pick her: the mission scripts the squad
    // crystal: the nape and both fists harden over (pale blue-white, faceted)
    const ico = new THREE.IcosahedronGeometry(1, 0);
    const hs = 0.62 * this.d.handS;
    this.crystal = {
      nape: this._crystal(ico, this.J.head, this.d.napeC, [0.62, 0.62, 0.46]),
      fist: [this._crystal(ico, this.J.handL, new V3(0, -0.1, 0), [hs, hs, hs]), this._crystal(ico, this.J.handR, new V3(0, -0.1, 0), [hs, hs, hs])],
    };
  }

  _crystal(geo: THREE.IcosahedronGeometry, parent: THREE.Object3D, at: THREE.Vector3, scl: [number, number, number]): Crystal {
    const m = new THREE.Mesh(geo, crystalMat()) as Crystal;
    m.position.copy(at); m.userData.s = new V3(...scl); m.scale.setScalar(0.001); m.visible = false;
    m.castShadow = false; m.raycast = () => {};
    parent.add(m);
    return m;
  }

  // ------------------------------------------------------------------ the mission's handles
  setMode(mode: HuntressMode): void { this.mode = mode; if (!BASE.has(this.state) && this.state !== 'strike' && this.state !== 'bound' && this.state !== 'cover') this._enter(mode); }
  /** Held fast by the harpoons of the trap: standing, both hands over the hardened nape. */
  bind(on = true): void { this.bound = on; this.act = null; this.blow = null; this._releasePlayer(); this.hard.always = on; this._enter(on ? 'bound' : this.mode); }
  scream(dur = 4.5): void {
    this.screamT = dur;
    this.game.audio?.titanGroan?.(this.position, 60);
    this.game.events?.emit?.('huntress:scream', { titan: this });
  }
  /**
   * A scripted blow: kind 'hand' (a swipe), 'punch' (a hardened fist), 'kick' (a roundhouse), 'stomp' or 'bite'.
   * get() → the world point it goes for (followed through the wind-up); onHit(point) when it lands (sure: it
   * always lands at the strike's midpoint, for the story's deaths). Returns false while she is busy.
   */
  strike(kind: StrikeKind, get: () => THREE.Vector3, onHit?: (point: THREE.Vector3) => void, { side = null, sure = false, W = null, run = false }: StrikeOptions = {}): boolean {
    if (this.state === 'strike' || this.state === 'bound' || this.dying || !this.alive) return false;
    const pt = get().clone();
    const left = _a.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const s: 0 | 1 = side ?? (_b.subVectors(pt, this.position).dot(left) >= 0 ? 0 : 1);
    const k = kind === 'kick' || kind === 'stomp' ? { W: 0.36, S: 0.3, R: 0.55 } : kind === 'bite' ? { W: 0.45, S: 0.22, R: 0.7 } : { W: 0.3, S: 0.24, R: 0.5 };
    this.blow = { kind, side: s, t: 0, W: W ?? k.W, S: k.S, R: k.R, get, onHit, sure, run, hit: false, pt };
    this._enter('strike');
    if (kind === 'punch' && this.hardens) this.hard.fist[s] = 1;
    this._windupEvent(kind === 'kick' || kind === 'stomp' ? 'swat' : kind, this.blow.W);
    return true;
  }
  /** Bound, the titans her scream called can get at her (Titan._thinkEscort: they maul a `drawnTo` target). */
  get vulnerable(): boolean { return this.bound && this.alive; }
  hurt(damage: number): void {
    if (!this.vulnerable) return;
    this.eatenHp -= damage;
    if (this.rnd() < 0.4) this.game.fx?.blood?.(this._jpos('spine', _a), _b.set(0, 1, 0), 1.6);
    this.game.events?.emit?.('huntress:eaten', { titan: this, left: this.eatenHp });
  }
  /** Face another giant and trade blows (the shifter's); the mission calls strike('punch' | 'kick') on her. */
  brawl(foe: Huntress | null): void { this.foe = foe; this.mode = 'brawl'; if (this.state !== 'strike') this._enter('brawl'); }

  // ------------------------------------------------------------------ hits
  override applyHit(o: { part?: string; damage?: number; point?: THREE.Vector3 | null; dir?: THREE.Vector3 | null; [k: string]: unknown } = {}) {
    if (!this.alive) return { killed: false, effect: 'none' };
    const pt = o.point || this._headWorld(new V3());
    const part = o.part;
    // a cut across her jaw: the mission frees the shifter from her mouth with it
    if ((part === 'head' || part === 'body' || part === 'eye' || part === 'torso') && this.mouthOpenable && this._mouthWorld(_a).distanceTo(pt) < 0.22 * this.height) {
      this.game.events?.emit?.('huntress:mouth', { titan: this, damage: o.damage });
      this.game.fx?.blood?.(pt, _b.set(0, 1, 0), 1.6);
      this.flinch = 1;
      return { killed: false, effect: 'mouth' };
    }
    if (part === 'nape' && this.hardens) {
      // hardened: the steel shatters on crystal (a reflex: it closes over the nape as the blade comes)
      this.hard.nape = 1; this.hard.napeT = 5;
      this.crystal.nape.visible = true;
      this.game.fx?.sparks?.(pt, _b.set(0, 1, 0), 22);
      this.game.audio?.bladeBreak?.();
      this.game.events?.emit?.('huntress:hardened', { titan: this, point: pt });
      return { killed: false, effect: 'hardened', shatter: true };
    }
    if ((part === 'arm' || part === 'hand') && (o.damage || 0) >= 40) {
      const side: 0 | 1 = this._sideOfPoint(pt) === 0 ? 0 : 1;
      this.limp[side] = 16;
      this.flinch = 1;
      this.game.fx?.blood?.(pt, o.dir || _b.set(0, 1, 0), 1.8);
      this.game.fx?.steam?.(pt, 2, 3);
      if (this.state === 'grab' && this.act?.side === side) { this._releasePlayer(); this._setFist(side, false); this.act = null; this._enter(this.mode); }
      if (this.state === 'strike' && this.blow?.side === side && (this.blow.kind === 'hand' || this.blow.kind === 'punch')) { this.blow = null; this._enter(this.mode); }
      this.game.events?.emit?.('huntress:hit', { titan: this, part: 'arm', effect: 'limp', side });
      return { killed: false, effect: 'limp' };
    }
    const r = super.applyHit({ ...o, part });
    if (r.effect === 'blind') this.blindT = this.eyeHeal;
    if (r.effect !== 'none') this.game.events?.emit?.('huntress:hit', { titan: this, part, effect: r.effect });
    return r;
  }

  /** Blinded: she sits back (against a tree if one is there) with both hands over her nape until an eye heals. */
  override _onBlinded(): void {
    if (this.state === 'grab') this._releasePlayer();
    this._setFist(0, false); this._setFist(1, false);
    this.game.audio?.titanGroan?.(this.position, this.height);
    if (this.state === 'bound') return;
    this.act = null; this.blow = null;
    this._enter('cover');
  }

  // ------------------------------------------------------------------ AI
  override _timers(dt: number): void {
    super._timers(dt);
    const b = this.blow;
    for (const i of [0, 1] as const) {
      if (this.limp[i] > 0 && (this.limp[i] -= dt) <= 0) { this.limp[i] = 0; this.game.fx?.steam?.(this._jpos(i ? 'armR' : 'armL', _a), 2.5, 2); }
      if (!(this.state === 'strike' && b?.kind === 'punch' && b.side === i)) this.hard.fist[i] = Math.max(0, this.hard.fist[i] - dt * 1.5);
    }
    this.cdKick -= dt;
    if (this.screamT > 0) this.screamT -= dt;
    // the nape hardens as a soldier closes in behind it, and stays hard a few seconds after
    const pl = this.game.player, H = this.hard;
    let want = H.always;
    if (!want && pl?.alive && this.hardens) {
      const nw = this.napeWorld(), r = _a.subVectors(pl.position, nw.center), d = r.length();
      if (d < 10 && r.dot(nw.normal) > -0.2 * d) want = true;
    }
    if (want) H.napeT = 4;
    H.napeT -= dt;
    const tgt = H.napeT > 0 ? 1 : 0;
    H.nape += (tgt - H.nape) * Math.min(1, dt * (tgt ? 9 : 1.2));
    const show = (m: Crystal, k: number) => {
      m.visible = k > 0.02;
      if (m.visible) m.scale.copy(m.userData.s).multiplyScalar(0.3 + 0.7 * k);
    };
    show(this.crystal.nape, H.nape); show(this.crystal.fist[0], H.fist[0]); show(this.crystal.fist[1], H.fist[1]);
  }

  override _think(dt: number): void {
    const pl = this.game.player;
    if (BASE.has(this.state)) {
      super._think(dt);
      if (this.state === 'chase' || this.state === 'idle' || this.state === 'wander') this._enter(this.mode);
      return;
    }
    this.stateT += dt;
    this.speedTarget = 0; this.goal = null; this.faceYaw = null;
    this.gazeTarget = this.hasPlayer && this.dist3 < 150 ? pl.position : null;
    if (this.lookAt) this.gazeTarget = this.lookAt;      // the mission makes her look at someone (a face under a hood)
    switch (this.state) {
      case 'strike': this._thinkStrike(dt); break;
      case 'bound':
        this.gazeTarget = this.screamT > 0 ? null : this.gazeTarget;
        break;
      case 'cover':
        // blind, sat back with her hands over the nape, until an eye heals
        this.gazeTarget = null;
        if (this.blindT <= 0) { this._enter(this.mode); this.game.events?.emit?.('huntress:sees', { titan: this }); }
        break;
      case 'brawl': {
        const f = this.foe;
        if (!f) { this._enter('hold'); break; }
        this.faceYaw = Math.atan2(f.position.x - this.position.x, f.position.z - this.position.z);
        this.gazeTarget = f._headWorld(_d);
        const dist = f.position.distanceTo(this.position);
        if (dist > this.footR + f.footR + 9) { this.goal = f.position; this.speedTarget = this.walkSpeed * 1.6; }
        break;
      }
      case 'run': {
        this.goal = this.runTo;
        this.speedTarget = this.crippleT > 0 ? 0 : this.runSpeed * this.paceMul;
        const dx = this.runTo.x - this.position.x, dz = this.runTo.z - this.position.z;
        this.arrived = dx * dx + dz * dz < 64;
        if (this.arrived) this.speedTarget = 0;
        this._defend(dt);
        break;
      }
      case 'fight': {
        if (this.hasPlayer) {
          this.goal = pl.position;
          this.speedTarget = this.crippleT > 0 ? 0 : this.distH > this.armLen * 1.4 ? this.runSpeed * 0.7 * this.paceMul : this.walkSpeed * 0.3;
        }
        this._defend(dt);
        break;
      }
      case 'hold':
        if (this.faceTo) this.faceYaw = Math.atan2(this.faceTo.x - this.position.x, this.faceTo.z - this.position.z);
        if (this.hasPlayer && this.dist3 < this.height * 1.6) this._defend(dt);
        break;
      default: this._enter(this.mode);   // (her first frame: the base Titan starts 'idle')
    }
  }

  /** Answer a soldier close to her: guard the nape, kick one at her legs, swat or grab one in front. */
  _defend(dt: number): boolean {
    const pl = this.game.player;
    if (!this.hasPlayer || pl.grabbedBy || this.blindT > 0) return false;
    if (this._tryGuard(dt)) return true;
    // a roundhouse at a soldier low beside or in front of her (on horseback, or on the ground)
    const rel = pl.position.y - this.position.y;
    if (this.cdKick <= 0 && this.distH < this.armLen * 1.15 && rel < this.shoulderH * 0.6 && Math.abs(this.relYaw) < 1.9 && this.rnd() < dt * 2.5) {
      this.cdKick = 3.5 + this.rnd() * 2;
      return this.strike('kick', () => pl.position, (p) => this._kickPlayer(p));
    }
    this._chooseAttack(Math.max(0.7, Math.sqrt(this.height / 7)));
    return this.state !== 'run' && this.state !== 'fight' && this.state !== 'hold';
  }
  _kickPlayer(foot: THREE.Vector3): void {
    const pl = this.game.player;
    if (!pl.alive || pl.grabbedBy || foot.distanceTo(pl.position) > 3.2) return;
    const d = _a.subVectors(pl.position, this.position).setY(0);
    if (d.lengthSq() < 1e-4) d.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    d.normalize().multiplyScalar(30); d.y = 9;
    for (const h of pl.odm?.hooks || []) if (h.attached) pl.odm.release(h.side);
    if (pl.riding) pl.riding.crashed = Math.max(16, pl.riding.speed + 6);
    pl.applyImpulse?.(d, 45);
    this.game.fx?.impact?.(foot, UP, 'flesh');
    this.game.audio?.titanStep?.(foot, this.height * 0.7);
    this.game.events?.emit?.('player:kicked', { titan: this });
  }

  _thinkStrike(dt: number): void {
    const a = this.blow;
    if (!a) { this._enter(this.mode); return; }
    a.t += dt;
    if (a.t < a.W) a.pt.copy(a.get());
    this.faceYaw = Math.atan2(a.pt.x - this.position.x, a.pt.z - this.position.z);
    if (a.kind === 'kick') this.faceYaw += (a.side === 0 ? -1 : 1) * 0.5;   // a roundhouse comes round from the side
    this.gazeTarget = a.pt;
    if (a.run) { this.goal = a.pt; this.speedTarget = this.runSpeed * 0.6; }
    if (!a.hit && a.t > a.W) {
      const eff = this._effector(a, _b);
      if (eff.distanceTo(a.pt) < 0.2 * this.height + 1.5 || (a.sure && a.t > a.W + a.S * 0.6)) {
        a.hit = true;
        a.onHit?.(a.sure ? a.pt.clone() : eff.clone());
      }
    }
    if (a.t > a.W + a.S + a.R) { this.blow = null; this.kickW = 0; this.cdAttack = 1 + this.rnd(); this._enter(this.mode); }
  }
  /** The part of her that lands the blow (world). */
  _effector(a: Blow, out: THREE.Vector3): THREE.Vector3 {
    if (a.kind === 'kick' || a.kind === 'stomp') return this._jpos(a.side ? 'footR' : 'footL', out);
    if (a.kind === 'bite') return this._mouthWorld(out);
    return this._jpos(a.side ? 'handR' : 'handL', out);
  }

  // ------------------------------------------------------------------ pose
  override _poseState(dt: number): void {
    const P = this.P, st = this.state, sgn = (i: number) => (i === 0 ? 1 : -1);
    this.kickW = 0; this.sitting = false;
    if (this.carrying) this.jawExtra += 0.16;   // the shifter in her mouth
    this.jawCap = this.carrying || this.screamT > 0 || this.mouthOpenable || (st === 'strike' && this.blow?.kind === 'bite') || BASE.has(st) ? null : 0.03;
    if (this.screamT > 0) {
      // head thrown back, jaw wide, arms out: the scream that calls the titans
      const k = sm(Math.min(this.screamT, 0.6) / 0.6);
      P.head[0] -= 0.75 * k; P.neck[0] -= 0.35 * k; P.spine[0] -= 0.12 * k; this.jawExtra += 0.95 * k;
    }
    switch (st) {
      case 'strike': this._poseStrike(); break;
      case 'bound': this._poseCover(1, 0.15); break;
      case 'cover': this._poseCover(1, 1); break;
      case 'brawl': // fists up, guard high, weight on the back foot: her fighter's stance
        P.spine[0] += 0.08;
        for (let i = 0; i < 2; i++) {
          const sh = this._jpos(i ? 'armR' : 'armL', _a), f = _c.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
          _b.copy(sh).addScaledVector(f, this.armLen * (i ? 0.45 : 0.6)).addScaledVector(UP, this.armLen * 0.25)
            .addScaledVector(_d.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)), sgn(i) * -0.2 * this.armLen);
          this._arm(i, _b, this._pole(i, 0.7, -0.8, 0), 12);
        }
        P.thighL[0] -= 0.25; P.shinL[0] += 0.3; P.thighR[0] += 0.15;
        break;
      case 'hold':
        if (this.reachTo) {
          // stooped low over a soldier on the ground, one hand reaching down to them (lifting a hood)
          P.spine[0] += 0.55; P.neck[0] += 0.3; P.head[0] += 0.2;
          P.thighL[0] -= 0.35; P.thighR[0] -= 0.35; P.shinL[0] += 0.6; P.shinR[0] += 0.6; this.hipT.y -= this.d.hipY * 0.12;
          this._arm(1, this.reachTo, this._pole(1, 0.8, -0.4, -0.3), 5);
          break;
        }
        super._poseState(dt);
        break;
      default:
        if (st === 'run' && this.speed > 8) { P.foreL[0] -= 1.0; P.foreR[0] -= 1.0; P.spine[0] += 0.06; }   // sprinting: elbows bent, arms pumping
        super._poseState(dt);
    }
    // arms whose muscles were cut hang down at her sides
    for (const i of [0, 1] as const) if (this.limp[i] > 0) {
      this.ik[i].wT = 0;
      const n = i ? 'R' : 'L';
      const arm = P[`arm${n}` as const];
      arm[0] = 0.1; arm[1] = 0; arm[2] = sgn(i) * 0.12; P[`fore${n}` as const][0] = -0.05;
      if (this.fist[i]) this._setFist(i, false);
    }
  }

  /** Both hands clamped over the back of her neck (the hardened nape under them). sit: 0 standing … 1 sat back. */
  _poseCover(cover: number, sit: number): void {
    const P = this.P;
    const nw = this.napeWorld();
    for (let i = 0; i < 2; i++) {
      if (this.limp[i] > 0) continue;
      _b.copy(nw.center).addScaledVector(nw.normal, 0.06 * this.height)
        .addScaledVector(_a.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)), (i ? -1 : 1) * 0.05 * this.height);
      this._arm(i, _b, this._pole(i, 1, 0.3, 0.5), 10);
    }
    P.head[0] += 0.35 * cover; P.neck[0] += 0.2 * cover; P.spine[0] += 0.12 * cover;
    if (sit > 0) {
      // sat back on her heels, the knees up
      P.thighL[0] -= 1.2 * sit; P.thighR[0] -= 1.2 * sit; P.shinL[0] += 1.9 * sit; P.shinR[0] += 1.9 * sit;
      P.footL[0] -= 0.4 * sit; P.footR[0] -= 0.4 * sit;
      this.hipT.y -= this.d.hipY * 0.55 * sit;
    }
    this.sitting = sit > 0;
  }

  _poseStrike(): void {
    const P = this.P, a = this.blow;
    if (!a) return;
    const i = a.side, sg = i === 0 ? 1 : -1, A = this.armLen;
    const wind = sm(a.t / a.W), hitK = sm((a.t - a.W) / a.S), back = sm((a.t - a.W - a.S) / a.R);
    const out = hitK * (1 - back);
    if (a.kind === 'hand' || a.kind === 'punch') {
      const sh = this._jpos(i ? 'armR' : 'armL', _a);
      const f = _c.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      // cocked back and up, then driven at the point (clamped to her reach)
      _b.copy(sh).addScaledVector(f, -0.35 * A).addScaledVector(UP, 0.3 * A);
      _d.subVectors(a.pt, sh); const l = _d.length(); if (l > 0.98 * A) _d.multiplyScalar(0.98 * A / l);
      _d.add(sh);
      _b.lerp(_d, a.t < a.W ? 0 : out);
      this._arm(i, _b, this._pole(i, 0.8, -0.4, -0.3), a.t < a.W ? 10 : 26);
      P.spine[1] += sg * (0.35 * wind - 0.7 * out); P.spine[0] += 0.15 * out;
      if (a.kind === 'punch') this._setFist(i, true);
      if (back > 0.9 && this.fist[i]) this._setFist(i, false);
      return;
    }
    if (a.kind === 'bite') {
      const k = wind * (1 - back);
      P.spine[0] += 0.55 * k; P.neck[0] += 0.4 * k; P.head[0] += 0.2 * k;
      this.jawExtra += a.t < a.W ? 0.9 * wind : 0.9 * (1 - hitK);
      return;
    }
    // kick / stomp: the leg is freed from the foot planting (see _plantLegs) and swung round
    const n = i ? 'R' : 'L';
    this.kickLeg = i;
    this.kickW = sm(a.t / (a.W * 0.6)) * (1 - back);
    if (a.kind === 'kick') {
      // the roundhouse: chamber the knee, pivot on the standing foot, snap the shin round at the head of the swing
      P[`thigh${n}` as const][0] -= 1.15 * wind + 0.35 * out;
      P[`thigh${n}` as const][2] += sg * (0.55 * wind + 0.5 * out);
      P[`shin${n}` as const][0] += 1.6 * wind * (1 - out) + 0.15;
      P.pelvis[1] += -sg * 0.9 * out; P.spine[1] += sg * 0.5 * out;
      P.spine[2] += sg * 0.35 * this.kickW;
      P.armL[2] += 0.5 * this.kickW; P.armR[2] -= 0.5 * this.kickW;
    } else {
      // stomp: knee high, then the sole driven down
      P[`thigh${n}` as const][0] -= 1.4 * wind * (1 - hitK) + 0.5 * out;
      P[`shin${n}` as const][0] += 1.7 * wind * (1 - hitK) + 0.2;
      P.spine[0] += 0.15 * out;
    }
  }

  /** The kicking leg keeps its swing; the other stays planted. */
  override _plantLegs(dt: number): void {
    const k = this.kickW, n = this.kickLeg ? 'R' : 'L';
    const th = this.J[`thigh${n}` as const], sh = this.J[`shin${n}` as const], ft = this.J[`foot${n}` as const];
    let s0: THREE.Quaternion | null = null, s1: THREE.Quaternion | null = null, s2: THREE.Quaternion | null = null;
    if (k > 0.01) { s0 = th.quaternion.clone(); s1 = sh.quaternion.clone(); s2 = ft.quaternion.clone(); }
    // sat back on her heels, the legs keep the pose: the planting only runs on its feet (it reads crippleT for that)
    const cr = this.crippleT;
    if (this.sitting) this.crippleT = 1;
    super._plantLegs(dt);
    this.crippleT = cr;
    if (s0 && s1 && s2) {
      th.quaternion.slerp(s0, k); sh.quaternion.slerp(s1, k); ft.quaternion.slerp(s2, k);
      this.root.updateMatrixWorld(true);
    }
  }

  override _updateThreat(dt: number): void {
    super._updateThreat(dt);
    const b = this.blow;
    if (this.state === 'strike' && b) this.threat = Math.max(this.threat, b.t < b.W + b.S ? 0.9 : 0.3);
  }

  override dispose(): void {
    super.dispose();
    this.foe = null;
  }
}

/** Spawn her into the titan list (ropes, cuts, the HUD's threat markers all see her). */
export function spawnHuntress(mgr: TitanManager, position: THREE.Vector3, yaw: number, o: Partial<HuntressOptions> = {}): Huntress {
  const t = new Huntress(mgr, { position, yaw, ...o });
  mgr.titans.push(t);
  mgr.group.add(t.root);
  return t;
}
