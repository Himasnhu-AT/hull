// Outrider comrades: AI soldiers flying on the same tether-gear physics as the player (same wires, winch,
// constraints and contacts), hopping anchor to anchor through the trees and circling titans.
import * as THREE from 'hull/three';
import { CFG } from '../config';
import { TetherGear } from './odm';
import { steerToSlot, type Horse, type SlotLead } from './horse';
import { flareStep, type FlareShot, type PlayerModel } from './model';
import { CAST } from '../brand';
import type { Game } from '../types';
import type { Civilian, Refuge, Rescuer } from '../npc/civilians';

// Math.hypot is variadic and boxes its arguments in hot loops (it was the top source of garbage); this doesn't.
const hypot = (a: number, b: number, c = 0): number => Math.sqrt(a * a + b * b + c * c);


const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _s = new THREE.Vector3(), _f = new THREE.Vector3();
const _acc = new THREE.Vector3();
/** Comrades' radio names (the brand sheet's squad and riders), in squad order. */
const NAMES: readonly string[] = [CAST.squadA, CAST.squadB, CAST.squadC, CAST.squadD, CAST.riderA, CAST.riderB, CAST.joker, CAST.wallguardElite];

/** A titan as a comrade fights it (titans/titan.ts, read through this one boundary). */
export interface SquadTarget {
  alive: boolean; dying?: boolean; kind: string; height: number; position: THREE.Vector3; yaw: number;
  crippleT?: number; napeHp?: number; killedBy?: unknown;
  /** the pair (ally idx >> 1) working on it */
  _squadBy?: number | null;
  _jpos(name: string, out: THREE.Vector3): THREE.Vector3;
  napeWorld(): { center: THREE.Vector3; normal: THREE.Vector3 };
  anchors(out: THREE.Vector3[]): THREE.Vector3[];
  applyHit(hit: { part: string; damage: number; point: THREE.Vector3; dir: THREE.Vector3 }): unknown;
}
const targetsOf = (game: Game): readonly SquadTarget[] => (game.titans as unknown as { titans?: SquadTarget[] } | null)?.titans ?? [];
/** A titan's fist holding a comrade. */
export interface AllyGrabber { alive: boolean; gripFrame?(pos: THREE.Vector3, up: THREE.Vector3, face: THREE.Vector3): boolean }
/** A pair's job on a titan: cut the ankles (the lead) or the nape (the partner, once the ankles go). */
interface SquadJob {
  titan: SquadTarget; role: 'ankle' | 'nape'; t: number; wait: boolean; tries: number; leg?: 'L' | 'R';
  fireT?: number; escape?: number; done?: boolean; nrm?: THREE.Vector3;
}
/** A place in a riding column: metres to the leader's right (x) and ahead (z); lead = a mission's column. */
export interface AllySlot { x: number; z: number; lead?: SlotLead; stay?: boolean; base?: [number, number] | null; }
interface Landing { s: THREE.Vector3; s1: THREE.Vector3; c: THREE.Vector3; e: THREE.Vector3; t: number; dur: number; gather?: boolean }
interface Rest { t: number; dur: number; crouch: number; gather?: boolean; leaving?: boolean }
type Spot = THREE.Vector3 & { branch?: unknown };

export class Ally {
  game: Game;
  pos: THREE.Vector3; prev: THREE.Vector3; render: THREE.Vector3; vel: THREE.Vector3;
  infiniteGas = true; silent = true;
  gear: TetherGear;
  model: PlayerModel | null;
  heading: THREE.Vector3; forward: THREE.Vector3; up: THREE.Vector3;
  t: number; holdT = 0; nextT: number;
  rand: () => number;
  _origins: THREE.Vector3[];
  boost = 0;
  horse: Horse | null = null; _mp = new THREE.Vector3();
  /** squad index (pairs: even cuts the ankles, odd the nape) and radio name; _baseName = the name before a mission renamed it */
  idx: number; name: string; _baseName?: string;
  alive = true; grabbedBy: AllyGrabber | null = null; grabHand: THREE.Object3D | null = null;
  job: SquadJob | null = null; jobCd: number;
  land: Landing | null = null; rest: Rest | null = null; restCd: number;
  slot: AllySlot | null = null; dismountT = -1;
  flareA: FlareShot | null = null; _wf = 0;
  _grip: { on: boolean; up: THREE.Vector3; face: THREE.Vector3 } | null = null;
  _youStillT = 0;
  /** seconds since this comrade was lost (the game flow sends a replacement in Holdout) */
  _backT = 0;
  /** fetching a civilian out of the streets (phase 0: on the way to them; 1: carrying them up to `to`) */
  rescue: { civ: Civilian; phase: number; t: number; to: THREE.Vector3; where: Refuge | null } | null = null;

  constructor(game: Game, model: PlayerModel | null, start: THREE.Vector3, seed: number) {
    this.game = game;
    this.pos = start.clone();
    this.prev = start.clone();
    this.render = start.clone();
    this.vel = new THREE.Vector3(0, 0, 0);
    this.gear = new TetherGear(game, this);
    this.model = model;
    this.heading = new THREE.Vector3(Math.sin(seed), 0, Math.cos(seed));
    this.forward = this.heading.clone();
    this.up = new THREE.Vector3(0, 1, 0);
    this.t = seed * 3;
    this.nextT = 0.3 + (seed % 1);
    this.rand = mulberry(Math.floor(seed * 1000) + 7);
    this._origins = [new THREE.Vector3(), new THREE.Vector3()];
    // cheap comrades: no shadow casting (tiny at range)
    model?.root?.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = false; });
    // squad: pairs of comrades take titans down together, the even one cuts the ankles, the odd one the nape
    this.idx = game.allies?.length || 0;
    this.name = NAMES[this.idx % NAMES.length];
    this.jobCd = 9 + this.rand() * 8;
    this.restCd = 6 + this.rand() * 14;
  }

  /** Back into the run (a new start, or a fresh soldier sent down from the wall): alive, at `at` if given. */
  revive(at?: THREE.Vector3): void {
    if (this.grabbedBy) this.grabbedBy = null;
    this.rescue = null; this.land = null; this.rest = null; this.grabHand = null;
    if (at) { this.pos.copy(at); this.prev.copy(at); this.render.copy(at); this.vel.set(0, 0, 0); this.gear.releaseAll(true); this.nextT = 0.2; }
    this.alive = true; this.job = null; this.jobCd = 9 + this.rand() * 8;
    if (this.model?.root) this.model.root.visible = true;
  }
  partner(): Ally | null { const o = this.game.allies?.[this.idx ^ 1]; return o && o !== this && o.alive && !o.grabbedBy ? o : null; }
  fireFlare(color: string, dir: THREE.Vector3 | null = null): void { this.flareA = { t: 0, color, dir: dir ? dir.clone() : null, fired: false }; }
  radio(text: string): void {
    const g = this.game;
    if ((g.time || 0) - (g._radioAt ?? -9) < 1.4) return;
    g._radioAt = g.time || 0;
    g.hud?.feed?.(text, 'radio', this.name);
  }

  // ---------------------------------------------------------------- caught by a titan
  grab(titan: AllyGrabber, hand: THREE.Object3D): void {
    this.grabbedBy = titan; this.grabHand = hand; this.land = null; this.rest = null; this.rescue = null;
    this.gear.releaseAll(true); this._dropJob();
    this.vel.set(0, 0, 0);
    this.game.events.emit('ally:grabbed', { ally: this, titan });
  }
  freed(): void {
    if (!this.grabbedBy) return;
    this.grabbedBy = null; this.grabHand = null;
    this.vel.set(0, 7, 0); this.nextT = 0.1; this.boost = 0.6;
    this.game.events.emit('ally:freed', { ally: this });
  }
  eaten(): void {
    this.grabbedBy = null; this.grabHand = null; this.alive = false;
    this.gear.releaseAll(true);
    if (this.model?.root) this.model.root.visible = false;
    this.game.events.emit('ally:eaten', { ally: this });
  }

  // ---------------------------------------------------------------- squad tactics
  _dropJob(): void {
    const j = this.job;
    if (!j) return;
    if (j.titan && j.titan._squadBy === (this.idx >> 1)) j.titan._squadBy = null;
    this.job = null;
  }
  // ---------------------------------------------------------------- fetching people out of the streets
  /** npc/civilians.ts sends this comrade for someone. */
  startRescue(c: Civilian): void {
    this._dropJob(); this.land = null;
    if (this.rest) this._takeOff();
    this.gear.releaseAll(true);
    this.rescue = { civ: c, phase: 0, t: 0, to: new THREE.Vector3(), where: null };
    this.radio(this.rand() < 0.5 ? `I see ${c.trade} down there — going in!` : `Someone in the street, I have them!`);
  }
  /** Fly to them on gas, over the roofs and down; take them on your back; carry them up to the nearest refuge and
   *  set them down. Adds steering into acc; false = nothing to fetch. */
  _rescue(dt: number, acc: THREE.Vector3): boolean {
    const R = this.rescue, civs = this.game.civilians;
    if (!R) return false;
    const c = R.civ;
    R.t += dt;
    const ok = !!civs && c.alive && (R.phase === 0 ? (c.state === 'wait' || c.state === 'flee') && c.rescuer === (this as unknown) : c.state === 'carried' && c.carrier?.owner === this);
    if (!ok || R.t > 24) {
      // could not get to them (or get them up): let them be for a while, they are the player's to fetch
      if (civs && c.state === 'carried' && c.carrier?.owner === this) civs.drop(c);
      if (ok) c.skipT = 45;
      this.rescue = null; this.jobCd = 2;
      return false;
    }
    const p = this.pos, v = this.vel;
    const to = R.phase === 0 ? _s.copy(c.pos).setY(c.pos.y + 1.2) : R.to;
    const dh = hypot(to.x - p.x, to.z - p.z), d = p.distanceTo(to);
    // high over the roofs until you are nearly above it, then straight down onto it
    // (and over the top of the Ashwall when it stands between you and them)
    const aim = _c.copy(to);
    const wall = (p.z > 8) !== (to.z > 8) || Math.abs(p.z) < 10;
    if (dh > 9) aim.y = Math.max(to.y + 6, wall ? 62 : 31);
    aim.sub(p);
    const al = aim.length() || 1;
    aim.multiplyScalar(Math.min(27, al * 1.7 + 2.5) / al).sub(v).multiplyScalar(4);
    const k = aim.length(); if (k > 55) aim.multiplyScalar(55 / k);
    acc.add(aim); acc.y += CFG.gravity;          // the gas carries your weight
    this.boost = Math.max(this.boost, 0.1);
    if (R.phase === 0 && d < 2.6) {
      civs!.pickUp(c, this as unknown as Rescuer);
      R.phase = 1; R.t = 0;
      R.where = civs!.nearestRefuge(p, R.to).refuge;
      R.to.y += 1.1;
      this.vel.y = Math.max(this.vel.y, 6);
    } else if (R.phase === 1 && R.where && ((dh < Math.max(2.5, R.where.r * 0.7) && Math.abs(p.y - to.y) < 2.6) || (R.t > 12 && dh < R.where.r + 5 && p.y > to.y - 2))) {
      civs!.deliver(c, _a.copy(to).setY(to.y - 1.1), R.where, this as unknown as Rescuer);
      this.rescue = null; this.jobCd = 4 + this.rand() * 4;
      this.vel.y = 8;
      this.game.events.emit('squad:saved', { by: this });
    }
    return true;
  }

  /**
   * Pick a titan. Every comrade hunts for themselves: the nearest one in the squad's ground (round you, or round
   * where the squad has been sent) that fewer than two soldiers are already on. Alone you take the ankle first,
   * then the nape; joining someone, you take the other end from them.
   */
  _plan(): void {
    const g = this.game, home = g.squadHome || g.player.pos;
    const reach = g.squadHome ? 280 : 150;
    let best: SquadTarget | null = null, bs = 1e9, bestOn = 0, mateRole: SquadJob['role'] | null = null;
    for (const t of targetsOf(g)) {
      if (!t.alive || t.dying || t.kind === 'behemoth') continue;
      const d = t.position.distanceTo(this.pos);
      if (d > 190 || t.position.distanceTo(home) > reach) continue;
      let on = 0, role: SquadJob['role'] | null = null;
      for (const a of g.allies) if (a !== this && a.alive && a.job?.titan === t) { on++; role = a.job.role; }
      if (on >= 2) continue;
      // near ones first; one that is already down on a knee is there for the taking; spread out over the free ones
      const s = d + on * 30 - ((t.crippleT ?? 0) > 0 ? 35 : 0);
      if (s < bs) { bs = s; best = t; bestOn = on; mateRole = role; }
    }
    if (!best) return;
    const hobbled = (best.crippleT ?? 0) > 1.5;
    const role: SquadJob['role'] = hobbled ? 'nape' : bestOn ? (mateRole === 'ankle' ? 'nape' : 'ankle') : this.rand() < 0.6 ? 'ankle' : 'nape';
    // (the nape-cutter of a pair holds off a moment for the ankles to go)
    this.job = { titan: best, role, t: 0, wait: role === 'nape' && mateRole === 'ankle' && !hobbled, tries: 0, leg: this.rand() < 0.5 ? 'L' : 'R' };
    this.radio(role === 'nape' ? (bestOn ? `Nape's mine!` : `Going for the nape on the ${Math.round(best.height)}-metre!`) : `Ankles on the ${Math.round(best.height)}-metre!`);
  }
  /** Where to cut (into _s) and where to throw the hooks (into _a); returns false if the target is gone. */
  _strikePoint(j: SquadJob): boolean {
    const t = j.titan;
    if (!t.alive || t.dying) return false;
    if (j.role === 'ankle') {
      t._jpos('foot' + j.leg, _s); t._jpos('shin' + j.leg, _a);
      _f.set(Math.sin(t.yaw), 0, Math.cos(t.yaw));
      _s.addScaledVector(_f, -0.05 * t.height).y += 0.05 * t.height;    // the tendon behind the heel
      _a.lerp(_s, 0.4);
      return true;
    }
    const nw = t.napeWorld();
    _s.copy(nw.center).addScaledVector(nw.normal, 0.3);
    const an = t.anchors([]);
    _a.copy(an[1 + (this.idx & 1)] || nw.center);
    j.nrm = j.nrm || new THREE.Vector3(); j.nrm.copy(nw.normal);
    return true;
  }
  /** Run the job: throw hooks, swing round behind the target, cut. Adds steering into acc; false = no job now. */
  _squad(dt: number, acc: THREE.Vector3): boolean {
    if (this.rescue) return false;
    if (!this.job) {
      if ((this.jobCd -= dt) <= 0) { this.jobCd = 0.4 + this.rand() * 0.3; this._plan(); }
      if (!this.job) return false;
    }
    const j = this.job, t = j.titan, gear = this.gear, p = this.pos, v = this.vel;
    j.t += dt;
    if (!this._strikePoint(j) || j.t > 16) { this._dropJob(); this.jobCd = 1; return false; }
    if (j.wait) {                              // the nape-cutter hangs back until the ankles go (or the lead stalls)
      if ((t.crippleT ?? 0) > 0 || j.t > 4) { j.wait = false; j.t = 0; } else return false;
    }
    if ((j.escape ?? 0) > 0) {                  // after a cut: let go and carry the speed up and away
      j.escape = (j.escape ?? 0) - dt;
      if (j.escape <= 0) {
        // done with this one: on to the next after a breath. Not done: come round again
        if (j.done) { this._dropJob(); this.jobCd = 1.5 + this.rand() * 2.5; } else { j.t = 0; }
      }
      return false;
    }
    const mine = gear.hooks.some((h) => h.attached && (h.collider?.userData?.titan as unknown) === t);
    if (!mine && gear.hooks.every((h) => h.state !== 'flying') && (j.fireT = (j.fireT || 0) - dt) <= 0) {
      gear.releaseAll(true);
      gear.fire(0, p, _b.copy(_a).addScaledVector(_c.set(this.rand() - 0.5, this.rand() - 0.5, this.rand() - 0.5), 1.2), _c.subVectors(_a, p).normalize());
      gear.fire(1, p, _b.copy(_a).addScaledVector(_c.set(this.rand() - 0.5, this.rand() - 0.5, this.rand() - 0.5), 1.2), _c.subVectors(_a, p).normalize());
      j.fireT = 0.9;
    }
    const dS = p.distanceTo(_s);
    if (dS > 60) {
      // a long way off: straight there on gas, over the roofs and the trees (and over the wall if it is in the way)
      this.heading.lerp(_b.subVectors(_s, p).setY(0).normalize(), 0.1).normalize();
      gear.releaseAll(true);
      const wall = (p.z > 8) !== (_s.z > 8) || Math.abs(p.z) < 10;
      const aim = _c.copy(_s); aim.y = Math.max(_s.y + 14, wall ? 62 : 30);
      aim.sub(p).normalize().multiplyScalar(34).sub(v).multiplyScalar(3);
      const al = aim.length(); if (al > 50) aim.multiplyScalar(50 / al);
      acc.add(aim); acc.y += CFG.gravity;
      this.boost = Math.max(this.boost, 0.1);
      j.t = Math.min(j.t, 4);                  // (the journey does not count against the job)
      return true;
    }
    // the swoop: come round behind the target point, then straight through it
    if (mine || dS < 25) {
      const nrm = j.role === 'nape' && j.nrm ? j.nrm : _f.set(-Math.sin(t.yaw), 0, -Math.cos(t.yaw));
      const rx = p.x - _s.x, ry = p.y - _s.y, rz = p.z - _s.z;
      const along = rx * nrm.x + ry * nrm.y + rz * nrm.z;
      const aim = _c.copy(_s);
      if (along < 1 && dS > 3) {
        const rt = _b.crossVectors(UP, nrm); if (rt.lengthSq() < 1e-4) rt.set(1, 0, 0); rt.normalize();
        const R = Math.max(3, t.height * 0.35);
        aim.addScaledVector(rt, (rx * rt.x + rz * rt.z) >= 0 ? R : -R).addScaledVector(nrm, 2);
      } else if (dS > 5) aim.addScaledVector(nrm, Math.min(6, dS * 0.4));
      else aim.addScaledVector(nrm, -2.5);
      aim.sub(p).normalize().multiplyScalar(31).sub(v).multiplyScalar(4.2);
      const al = aim.length(); if (al > 60) aim.multiplyScalar(60 / al);
      acc.add(aim); acc.y += CFG.gravity * 0.6;
      this.boost = Math.max(this.boost, 0.1);
      for (const h of gear.hooks) h.payout = dS < 14 ? 40 : 0;
    }
    if (dS < (j.role === 'ankle' ? 2.8 : 2.4)) this._cut(j);
    return true;
  }
  _cut(j: SquadJob): void {
    const t = j.titan, g = this.game;
    for (const h of this.gear.hooks) h.payout = 0;
    this.gear.releaseAll(true);
    j.escape = 0.7; this.boost = 0.6;
    this.vel.y += 6;
    const near = this.pos.distanceTo(g.camera.position) < 70;
    if (near) g.audio?.slash?.(true);
    if (j.role === 'ankle') {
      t.applyHit({ part: 'ankle', damage: 60, point: _s.clone(), dir: this.vel.clone() });
      g.events.emit('squad:limb', { by: this });
      // it is down: with nobody else on its neck, come round and take the nape yourself
      const other = g.allies.some((a) => a !== this && a.alive && a.job?.titan === t && a.job.role === 'nape');
      if (other) j.done = true; else { j.role = 'nape'; j.tries = 0; }
      this.radio(other ? (this.rand() < 0.5 ? 'Ankles are down — now!' : `Its legs are gone, take it!`) : `It's down — going for the neck!`);
      return;
    }
    // a clean nape cut more often than not (nearly always when it is on its knees); otherwise come round and try again
    if (this.rand() < ((t.crippleT ?? 0) > 0 ? 0.88 : 0.5)) {
      t.killedBy = this;
      t.applyHit({ part: 'nape', damage: (t.napeHp || 600) + 1, point: _s.clone(), dir: this.vel.clone() });
      j.done = true;
    } else {
      t.applyHit({ part: 'nape', damage: 15, point: _s.clone(), dir: this.vel.clone() });
      if (++j.tries >= 4) j.done = true;
      this.radio(j.done ? 'Too shallow — I need help here!' : 'Too shallow! Coming round again!');
    }
  }

  // ---------------------------------------------------------------- landing and standing about
  /**
   * When nothing's near, comrades come down for a breather: onto a branch, a roof or the ground, arcing in feet
   * first like you do; they stand a few seconds and take off again. Stop and stand still yourself and the ones
   * close by land round you. A titan coming close, or a job, gets them back in the air.
   */
  _restCheck(dt: number): void {
    const g = this.game, pl = g.player;
    this.restCd -= dt;
    // (a squad sent to hold ground of its own does not gather round you, and does not sit down while titans are about)
    const own = !!g.squadHome;
    const gather = !own && this._youStillT > 1.2 && pl.pos.distanceTo(this.pos) < 90;
    if (this.job || this.rescue || this.grabbedBy || this.horse || (!gather && this.restCd > 0)) return;
    if (this._titanNear(own ? 260 : 80)) { this.restCd = 4; return; }
    const spot = gather ? this._spotNear(pl.pos) : this._spotAhead();
    this.restCd = 3 + this.rand() * 4;
    if (!spot) return;
    this._startLanding(spot);
    if (this.land) this.land.gather = gather;
  }
  _titanNear(r: number): boolean {
    for (const t of targetsOf(this.game)) if (t.alive && t.position.distanceToSquared(this.pos) < r * r) return true;
    return false;
  }
  /** Somewhere on the ground round you (a few metres off, each comrade its own side), clear of anything. */
  _spotNear(c: THREE.Vector3): Spot | null {
    for (let i = 0; i < 6; i++) {
      const a = this.idx * 1.3 + i * 0.9 + this.rand() * 0.5, r = 4 + (this.idx % 3) * 2 + this.rand() * 2;
      const x = c.x + Math.sin(a) * r, z = c.z + Math.cos(a) * r;
      const out = this._groundSpot(x, z);
      if (out && Math.abs(out.y - c.y) < 4) return out;
    }
    return null;
  }
  _groundSpot(x: number, z: number): Spot | null {
    const col = this.game.collision;
    const top = col.raycast(_a.set(x, Math.max(this.pos.y, col.groundHeight(x, z)) + 3, z), _b.set(0, -1, 0), 120, { dynamic: false });
    if (!top || top.normal.y < 0.75) return null;
    const out = top.point.clone(); out.y += CFG.radius + 0.02;
    for (const k of col.collideSphere(out, CFG.radius * 0.9, { dynamic: false })) if (k.depth > 0.1) return null;
    return out;
  }
  /** A branch or a roof ahead and below-ish, or failing that the ground ahead. */
  _spotAhead(): Spot | null {
    const col = this.game.collision, p = this.pos, v = this.vel;
    const hs = hypot(v.x, v.z) || 1, fx = v.x / hs, fz = v.z / hs;
    let best: Spot | null = null, bs = -1e9;
    for (const c of col.querySphere(p, 45)) {
      if (c.type !== 'capsule' || c.dynamic) continue;
      _a.subVectors(c.b, c.a); const L = _a.length();
      if (L < 5 || Math.abs(_a.y) / L > 0.35 || c.r < 0.7) continue;           // level-ish branches only
      _b.copy(c.a).addScaledVector(_a, 0.35 + this.rand() * 0.4);
      const dx = _b.x - p.x, dz = _b.z - p.z, dh = hypot(dx, dz);
      if (dh < 8) continue;
      const score = (dx * fx + dz * fz) / dh - Math.abs(dh - 25) / 40 - Math.abs(_b.y - p.y) / 40;
      if (score > bs) { bs = score; best = _b.clone().setY(_b.y + c.r + CFG.radius + 0.02) as Spot; best.branch = c; }
    }
    if (best) {
      let clear = true;
      for (const k of col.collideSphere(best, CFG.radius * 0.9, { dynamic: false })) if (k.depth > 0.12 && k.collider !== best.branch) { clear = false; break; }
      if (clear) return best;
    }
    return this._groundSpot(p.x + fx * 25, p.z + fz * 25);
  }
  /** Arc in feet first onto the spot (leaving along the current velocity, settling onto it at zero speed). */
  _startLanding(e: THREE.Vector3): void {
    const p = this.pos, d = p.distanceTo(e);
    if (d > 70) return;
    this.gear.releaseAll(true);
    const dur = THREE.MathUtils.clamp(d / 14, 0.5, 2.4);
    const s1 = p.clone().addScaledVector(this.vel, dur / 4);
    if (s1.distanceTo(p) > 0.3 * d + 0.5) s1.copy(p).addScaledVector(_a.subVectors(s1, p).normalize(), 0.3 * d + 0.5);
    const c = p.clone().lerp(e, 0.6); c.y = Math.max(c.y, e.y) + 1.5 + d * 0.08;
    // the arc has to be clear (no flying through a trunk or a parapet to get there)
    const col = this.game.collision;
    for (let i = 1; i < 12; i++) {
      const k = i / 12, u = 1 - k;
      _a.set(0, 0, 0).addScaledVector(p, u * u * u).addScaledVector(s1, 3 * u * u * k).addScaledVector(c, 3 * u * k * k).addScaledVector(e, k * k * k);
      if (_a.distanceTo(e) < 1.2) continue;
      for (const hit of col.collideSphere(_a, CFG.radius * 0.8, { dynamic: false })) if (hit.depth > 0.05) return;
    }
    this.land = { s: p.clone(), s1, c, e: e.clone(), t: 0, dur };
  }
  _landStep(dt: number): void {
    const L = this.land;
    if (!L) return;
    L.t += dt;
    const tau = Math.min(1, L.t / L.dur), k = 1 - (1 - tau) * (1 - tau), u = 1 - k;
    this.pos.set(0, 0, 0).addScaledVector(L.s, u * u * u).addScaledVector(L.s1, 3 * u * u * k).addScaledVector(L.c, 3 * u * k * k).addScaledVector(L.e, k * k * k);
    const r = 3 * 2 * (1 - tau) / L.dur;
    this.vel.set(0, 0, 0).addScaledVector(_a.subVectors(L.s1, L.s), r * u * u).addScaledVector(_a.subVectors(L.c, L.s1), 2 * r * u * k).addScaledVector(_a.subVectors(L.e, L.c), r * k * k);
    if (tau >= 1) {
      this.land = null;
      this.pos.copy(L.e); this.vel.set(0, 0, 0);
      this.rest = { t: 0, dur: 2.5 + this.rand() * 4, crouch: 0.8, gather: L.gather };
      if (this.pos.distanceTo(this.game.camera.position) < 40) this.game.audio?.land?.(0.25);
    }
  }
  _restStep(dt: number): void {
    const R = this.rest, pl = this.game.player;
    if (!R) return;
    R.t += dt; R.crouch = Math.max(0, R.crouch - dt * 2.4);
    this.vel.set(0, 0, 0);
    // face you while you're about, otherwise look out the way it came
    const dx = pl.pos.x - this.pos.x, dz = pl.pos.z - this.pos.z;
    if (hypot(dx, dz) < 40) this.heading.lerp(_a.set(dx, 0, dz).normalize(), 1 - Math.exp(-3 * dt)).normalize();
    if ((this.jobCd -= dt) <= 0) { this.jobCd = 0.5; this._plan(); }   // the lead still calls targets from the ground
    const stay = this._youStillT > 0.5 && pl.pos.distanceTo(this.pos) < 60;
    // gathered round you and you're off: follow within a second or so (each in their own time)
    if (R.gather && !stay && !R.leaving) { R.leaving = true; R.dur = Math.min(R.dur, R.t + 0.2 + this.rand() * 1.1); }
    if ((R.t > R.dur && !stay) || this._titanNear(70) || this.job) this._takeOff();
  }
  _takeOff(): void {
    this.rest = null;
    this.vel.set(this.heading.x * 6, 9, this.heading.z * 6);
    this.boost = 0.5; this.nextT = 0.15; this.restCd = 14 + this.rand() * 18;
  }

  _pickAnchor(): THREE.Vector3 | null {
    const col = this.game.collision;
    const r = this.rand;
    // prefer a titan's body if one is near (the corps harass the big ones), else trees ahead and above
    let target: THREE.Vector3 | null = null;
    for (const t of targetsOf(this.game)) {
      if (!t.alive || t.kind === 'behemoth') continue;
      const d = t.position.distanceTo(this.pos);
      if (d < 70 && r() < 0.5) { target = t.napeWorld?.()?.center ?? null; break; }
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const dir = _a;
      if (target && attempt === 0) dir.subVectors(target, this.pos).normalize();
      else {
        const yaw = Math.atan2(this.heading.x, this.heading.z) + (r() - 0.5) * 1.6;
        const pitch = 0.22 + r() * 0.5 + (this.pos.y < 25 ? 0.35 : 0) - (this.pos.y > 95 ? 0.55 : 0);
        dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      }
      const hit = col.raycast(this.pos, dir, CFG.hook.range * 0.85, { hookableOnly: true });
      if (hit && hit.distance > 12 && hit.collider.type !== 'ground') return hit.point;
    }
    return null;
  }

  /** Ride in formation: slot = metres to the leader's right (x) and ahead (z, negative = behind). */
  mount(horse: Horse, slot: AllySlot): void {
    this.horse = horse; horse.rider = this; this.slot = slot; this.land = null; this.rest = null;
    this.gear.releaseAll(true);
    horse.saddle(this.pos); this.prev.copy(this.pos); this.render.copy(this.pos);
    this.dismountT = -1;
  }
  dismount(silent?: boolean): void {
    const h = this.horse;
    if (!h) return;
    this.horse = null; h.rider = null; h.mountCd = 3; h.want.f = 0; h.want.turn = 0;
    this.vel.copy(h.vel); this.vel.y = silent ? 0 : 9.5;
    this.nextT = 0.15; this.boost = silent ? 0 : 0.6;
  }
  _ride(dt: number): void {
    const h = this.horse, g = this.game, p = g.player, slot = this.slot;
    if (!h || !slot) return;
    // in the slot beside the player (on horseback or not), or in a mission's column (slot.lead)
    steerToSlot(h, slot.lead || p.riding || p, slot);
    h.saddle(this.pos); this.vel.copy(h.vel);
    if (slot.stay) return;   // a mission keeps them in the saddle
    // leave the saddle when the leader takes to the air, or when a titan comes close (staggered, not all at once)
    if (this.dismountT < 0) {
      let titanNear = false;
      // (with ground of their own to hold they leave the column as soon as there is something to hunt)
      const see = g.squadHome ? 150 : 70;
      for (const t of targetsOf(g)) if (t.alive && t.position.distanceToSquared(this.pos) < see * see) { titanNear = true; break; }
      if (!p.riding || titanNear) this.dismountT = 0.15 + this.rand() * 0.9;
    } else if ((this.dismountT -= dt) <= 0) this.dismount();
    if (h.crashed > 0) { h.crashed = 0; this.dismount(); }
  }

  fixedUpdate(dt: number): void {
    if (!this.alive) return;
    if (this.horse) { this.prev.copy(this.pos); this._ride(dt); return; }
    this.prev.copy(this.pos);
    if (this.grabbedBy) {                       // in a titan's fist
      if (!this.grabbedBy.alive || !this.grabHand) { this.freed(); return; }
      // held round the waist in the fist (body along it, head out of the top), like the player
      const G = this._grip || (this._grip = { on: false, up: new THREE.Vector3(), face: new THREE.Vector3() });
      G.on = !!this.grabbedBy.gripFrame?.(this.pos, G.up, G.face);
      if (G.on) { this.pos.addScaledVector(G.up, -0.4); this.up.copy(G.up); this.forward.copy(G.face); }
      else this.grabHand.getWorldPosition(this.pos);
      this.vel.set(0, 0, 0);
      return;
    }
    const gear = this.gear, v = this.vel, p = this.pos;
    this.launcher(0, this._origins[0]); this.launcher(1, this._origins[1]);
    gear.step(dt, this._origins);
    this.t += dt;
    // you, standing still on the ground: the squad gathers round you (and follows when you're off again)
    const pl = this.game.player;
    this._youStillT = this.game.mode !== 'menu' && pl.alive && pl.grounded && !pl.riding && pl.speed < 1.5 ? (this._youStillT || 0) + dt : 0;
    if (this.land) { this._landStep(dt); return; }
    if (this.rest) { this._restStep(dt); if (this.rest) return; }
    this._restCheck(dt);
    if (this.land) return;
    this.holdT -= dt;
    this.nextT -= dt;
    const acc = _acc.set(0, -CFG.gravity, 0);
    const busy = this._squad(dt, acc) || this._rescue(dt, acc);
    if (!busy) for (const h of gear.hooks) h.payout = 0;
    const anchored = gear.attachedCount();
    if (!busy && anchored && this.holdT <= 0) gear.releaseAll(true);
    if (!busy && !anchored && this.nextT <= 0 && gear.hooks.every((h) => h.state === 'idle' || h.state === 'retracting')) {
      const pt = this._pickAnchor();
      if (pt) {
        const twin = this.rand() < 0.5;
        gear.fire(0, p, pt, _b.subVectors(pt, p).normalize());
        if (twin) gear.fire(1, p, pt.clone().add(_c.set(this.rand() - 0.5, 0, this.rand() - 0.5).multiplyScalar(3)), _b);
        this.holdT = 1.1 + this.rand() * 1.3;
        this.boost = this.rand() < 0.4 ? 0.7 : 0;
      }
      this.nextT = 0.2 + this.rand() * 0.35;
    }
    const sp = v.length();
    acc.addScaledVector(v, -CFG.drag * sp);
    gear.reelAccel(p, v, this.boost > 0, acc);
    if (this.boost > 0) this.boost -= dt;
    // stay in the playable air: a bit of gas when low, steer back toward the action area
    if (p.y < 8 && v.y < 4) acc.y += 30;
    // stay with the squad leader (you), or where the squad has been sent: drift back when more than ~110 m away
    const lp = this.game.squadHome || this.game.player.pos;
    const home = _b.set(lp.x - p.x, 0, lp.z - p.z);
    if (!busy && this.game.squadHome && (p.z > 8) !== (lp.z > 8)) {
      // the Ashwall stands between you and the squad's ground: up and over it on gas
      gear.releaseAll(true);
      const aim = _c.set(lp.x, 62, lp.z).sub(p).normalize().multiplyScalar(30).sub(v).multiplyScalar(3);
      const al = aim.length(); if (al > 45) aim.multiplyScalar(45 / al);
      acc.add(aim); acc.y += CFG.gravity; this.boost = Math.max(this.boost, 0.1); this.nextT = 0.4;
    } else if (!busy && home.length() > 110) acc.addScaledVector(home.normalize(), 8);
    v.addScaledVector(acc, dt);
    const n = Math.min(10, Math.max(1, Math.ceil((v.length() * dt) / 0.35)));
    for (let i = 0; i < n; i++) {
      p.addScaledVector(v, dt / n);
      gear.constrain(p, v);
      const cs = this.game.collision.collideSphere(p, CFG.radius, { dynamic: false });
      for (const c of cs) {
        if (c.depth <= 0) continue;
        p.addScaledVector(c.normal, c.depth);
        const vn = v.dot(c.normal);
        if (vn < 0) v.addScaledVector(c.normal, -vn * 1.2);
      }
    }
    if (v.lengthSq() > 4) this.heading.lerp(_c.set(v.x, 0, v.z).normalize(), 0.02).normalize();
  }

  launcher(side: number, out: THREE.Vector3): THREE.Vector3 {
    if (this.model?.hookOrigin && this.model.root?.visible) return this.model.hookOrigin(side, out);
    return out.copy(this.render);
  }

  update(dt: number, alpha: number): void {
    if (!this.alive) return;
    this._wf = flareStep(this, dt);
    this.render.lerpVectors(this.prev, this.pos, alpha);
    const sp = this.vel.length();
    const gy = this.game.collision.groundHeight(this.render.x, this.render.z);
    const resting = !!this.rest;
    const landing = !this.horse && !resting && (this.land ? this.land.t / this.land.dur > 0.55 : this.vel.y < -2 && !this.gear.attachedCount() && (this.render.y - gy) / -this.vel.y < 0.7);
    if (this.horse) {
      this.forward.set(Math.sin(this.horse.yaw), 0, Math.cos(this.horse.yaw));
      this.horse.up(this.up);
    } else if (this.grabbedBy && this._grip?.on) {
      // orientation comes from the fist (fixedUpdate)
    } else if (resting) {
      this.forward.lerp(this.heading, 1 - Math.exp(-6 * dt)).normalize();
      this.up.lerp(UP, 1 - Math.exp(-10 * dt)).normalize();
    } else if (landing) {
      const hl = hypot(this.vel.x, this.vel.z) || 1;
      this.forward.lerp(_a.set(this.vel.x / hl, 0, this.vel.z / hl), 1 - Math.exp(-12 * dt)).normalize();
      this.up.lerp(UP, 1 - Math.exp(-14 * dt)).normalize();
    } else if (sp > 2) this.forward.lerp(_a.copy(this.vel).multiplyScalar(1 / sp).addScaledVector(this.heading, 0.4).normalize(), 1 - Math.exp(-6 * dt)).normalize();
    const pd = this.gear.pullDir(this.render, _b);
    const upT = _c.copy(UP);
    if (pd) upT.lerp(pd, 0.5);
    upT.addScaledVector(this.forward, -upT.dot(this.forward));
    if (!this.horse && !landing && !(this.grabbedBy && this._grip?.on) && upT.lengthSq() > 1e-3) this.up.lerp(upT.normalize(), 1 - Math.exp(-5 * dt)).normalize();
    const dist = this.render.distanceTo(this.game.camera.position);
    const visible = dist < (this.game.allyRange || 260);
    // far comrades: a coarser, less frequent cape sim (it's 2/3 of their cost and invisible at range)
    if (this.model?.cape) { const cape = this.model.cape; cape.hz = dist < 12 ? 120 : dist < 80 ? 60 : 30; cape.iters = dist < 12 ? 5 : 3; this.model.capeEvery = dist < 80 ? 1 : dist < 160 ? 2 : 3; }
    if (this.model) {
      this.model.root.visible = visible && this.alive;
      if (visible) this.model.update(dt, {
        landPrep: landing ? 1 : 0, riding: this.horse ? 1 : 0, horseGallop: this.horse?.gallop || 0, horsePhase: this.horse?.phase || 0,
        crouch: this.rest ? this.rest.crouch : 0,
        position: this._mp.copy(this.render).addScaledVector(this.up, 0.4), velocity: this.vel, forward: this.forward, up: this.up, grounded: !!this.horse || resting, running: 0,
        hooks: this.gear.hooks.map((h) => ({ attached: h.attached, anchor: h.attached ? h.anchor : null, state: h.state })),
        boosting: this.boost > 0 ? 1 : 0, slash: -1, spin: false, grabbed: !!this.grabbedBy, blades: !this.horse, speed: sp, alive: true, flare: this._wf,
      });
    }
    this.launcher(0, this._origins[0]); this.launcher(1, this._origins[1]);
    this.gear.render(this._origins, this.game.camera, this.game.time + this.t);
    if (this.boost > 0 && visible && this.model?.gasNozzle) { this.model.gasNozzle(_a, _b); this.game.fx?.gas?.(_a, _b, 0.5); }
  }

  dispose(): void {
    this.model?.root?.parent?.remove(this.model.root);
    for (const w of this.gear.wires) w.mesh.parent?.remove(w.mesh);
  }
}

function mulberry(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
