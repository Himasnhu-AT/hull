// Civilians to save: the townsfolk of Varn, and carters caught outside when the titans came. They go about the
// streets (or wait where they are stranded: a roof, the ruined village in the Reach) and call for help; on open
// ground they run from a titan that comes close. Fly through one and you scoop them up onto your back; set them
// down somewhere a titan cannot reach (a refuge: the top of the Ashwall, the Wallguard roof, a rooftop lookout) and
// they are safe. Your comrades do the same on their own. A titan after the nearest living thing will take one that
// nobody reaches: cut the hand or the nape while it holds them and they drop free.
//
// To a titan a civilian is a Quarry (titans/env.ts): it is caught through the same reach-and-grab as a comrade.
import * as THREE from 'hull/three';
import { litMaterial } from '../core/style';
import { FS } from '../world/terrain';
import type { Game } from '../types';
import type { Quarry } from '../titans/env';
import { collisionOf } from '../player/odm';
import { R as RND } from '../sim';

export type CivilianState = 'wait' | 'flee' | 'held' | 'carried' | 'fall' | 'safe' | 'lost';
type Area = 'field' | 'town' | 'forest';

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const DOWN = new THREE.Vector3(0, -1, 0);
const hypot = (a: number, b: number): number => Math.sqrt(a * a + b * b);
const turnTo = (yaw: number, want: number, k: number): number => yaw + Math.atan2(Math.sin(want - yaw), Math.cos(want - yaw)) * Math.min(1, k);

/** Who they are (the feed and the HUD name them by trade). */
const TRADES = ['a carter', 'a mason', 'a miller', 'a weaver', 'a farmhand', 'a smith', 'a baker', 'a shepherd', 'a tanner', 'a cooper'];
const TUNICS = [0x8a5a3c, 0x5f6f86, 0x7c6a4a, 0x94433a, 0x56705a, 0xa08a5c, 0x6d5a7a, 0x9a8f80];
const LEGS = [0x4a3f36, 0x3a4250, 0x5a5044, 0x2f2a26];
const SKIN = [0xe2b896, 0xc99874, 0xf0cdb0, 0xa87754];
const HAIR = [0x2a1c12, 0x5a3a1e, 0x8a6a3a, 0x1a1512, 0x9a9488];

// one set of shapes shared by everyone
const G = {
  torso: new THREE.CylinderGeometry(0.2, 0.26, 0.62, 8),
  skirt: new THREE.CylinderGeometry(0.26, 0.34, 0.34, 8),
  head: new THREE.SphereGeometry(0.15, 10, 8),
  hair: new THREE.SphereGeometry(0.162, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
  limb: new THREE.CapsuleGeometry(0.065, 0.5, 2, 6),
  leg: new THREE.CapsuleGeometry(0.08, 0.56, 2, 6),
};
G.limb.translate(0, -0.3, 0); G.leg.translate(0, -0.34, 0);

/** Settings a mode starts the rescues with: where people get stranded, how many at most, and how many townsfolk
 *  are about in Varn from the start. */
export interface RescueOptions { areas: Area[]; max: number; townsfolk?: number }

/** Whoever has a civilian on their back: the player's soldier or a comrade (their live vectors). */
export interface Carrier { owner: unknown; render: THREE.Vector3; forward: THREE.Vector3; up: THREE.Vector3; vel: THREE.Vector3 }
/** A comrade, as the rescues see one (player/ally.ts). */
export interface Rescuer {
  name: string; alive: boolean; grabbedBy: unknown; horse: unknown; job: unknown; rescue: unknown;
  pos: THREE.Vector3; render: THREE.Vector3; forward: THREE.Vector3; up: THREE.Vector3; vel: THREE.Vector3;
  startRescue(c: Civilian): void;
}

/** Somewhere a titan cannot reach. kind 'wall' is the whole top of the Ashwall (pos is then its middle). */
export interface Refuge { pos: THREE.Vector3; r: number; kind: 'roof' | 'wall' | 'post'; name: string }

export class Civilian implements Quarry {
  readonly quarryKind = 'civilian' as const;
  alive = true;
  catchable = true;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  grabbedBy: unknown = null;
  grabHand: THREE.Object3D | null = null;
  horse: unknown = null;
  job: { titan?: unknown } | null = null;
  state: CivilianState = 'wait';
  trade: string;
  root = new THREE.Group();
  yaw = 0;
  /** seconds in this state; the run / wave cycle; seconds to the next cry */
  t = 0; phase: number; cryT: number;
  /** on a roof or a branch: nowhere to run */
  stuck = false;
  /** fade-out (1..0) once `leaving` is set */
  fade = 1; leaving = false;
  /** who is carrying them, and the comrade on the way to fetch them */
  carrier: Carrier | null = null; rescuer: Rescuer | null = null;
  /** seconds until the next look at whether there is still something under their feet (a roof can come down) */
  floorT = 0.5;
  /** seconds the squad leaves them be (a comrade could not get to them: they are yours to fetch) */
  skipT = 0;
  /** strolling about the streets: where to, seconds until the next idea */
  private walkTo: THREE.Vector3 | null = null; private walkT: number;
  private armL: THREE.Mesh; private armR: THREE.Mesh; private legL: THREE.Mesh; private legR: THREE.Mesh; private body: THREE.Group;
  private mats: THREE.MeshStandardMaterial[] = [];
  private readonly mgr: Civilians;

  constructor(mgr: Civilians, seed: number) {
    this.mgr = mgr;
    const pick = <T>(list: readonly T[], k: number): T => list[Math.floor(((seed * k) % 1 + 1) % 1 * list.length)];
    this.trade = pick(TRADES, 7.31);
    this.phase = seed * 6.28; this.cryT = 1 + (seed * 3.7) % 3; this.walkT = 1 + (seed * 5.3) % 4;
    const mat = (c: number, rough = 0.9): THREE.MeshStandardMaterial => { const m = litMaterial(c, { roughness: rough }); this.mats.push(m); return m; };
    const tunic = mat(pick(TUNICS, 3.17)), legs = mat(pick(LEGS, 5.71)), skin = mat(pick(SKIN, 9.13), 0.65), hair = mat(pick(HAIR, 2.39));
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D, cast = false): THREE.Mesh => {
      const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = cast; parent.add(o); return o;
    };
    const body = this.body = new THREE.Group();
    this.root.add(body);
    add(G.torso, tunic, 0, 1.12, 0, body, true);
    if ((seed * 4.9) % 1 > 0.5) add(G.skirt, tunic, 0, 0.76, 0, body);
    add(G.head, skin, 0, 1.6, 0, body, true);
    add(G.hair, hair, 0, 1.62, -0.01, body);
    this.armL = add(G.limb, tunic, 0.27, 1.38, 0, body); this.armR = add(G.limb, tunic, -0.27, 1.38, 0, body);
    this.legL = add(G.leg, legs, 0.11, 0.84, 0, body, true); this.legR = add(G.leg, legs, -0.11, 0.84, 0, body, true);
    const s = 0.94 + ((seed * 8.3) % 1) * 0.14;
    this.root.scale.setScalar(s);
    mgr.game.scene.add(this.root);
  }

  // ---------------------------------------------------------------- caught by a titan (the Quarry contract)
  grab(titan: unknown, hand: THREE.Object3D): void {
    this.grabbedBy = titan; this.grabHand = hand; this.catchable = false; this.rescuer = null;
    this._enter('held');
    this.mgr.game.events.emit('civilian:grabbed', { civilian: this, titan });
  }
  freed(): void {
    if (!this.grabbedBy) return;
    this.grabbedBy = null; this.grabHand = null;
    this.vel.set(0, 1.5, 0);
    this._enter('fall');
    this.catchable = false;                   // (falling: nothing can catch them but you)
    this.mgr.game.events.emit('civilian:freed', { civilian: this });
  }
  eaten(): void {
    this.grabbedBy = null; this.grabHand = null;
    this.alive = false; this.catchable = false;
    this._enter('lost');
    this.root.visible = false;
    this.mgr.game.events.emit('civilian:lost', { civilian: this });
  }

  _enter(s: CivilianState): void { this.state = s; this.t = 0; }

  /** Feet on something under this point? Sets pos.y to stand on it. */
  _stand(maxDrop = 3): boolean {
    const col = collisionOf(this.mgr.game);
    const hit = col.raycast(_a.copy(this.pos).setY(this.pos.y + 1.2), DOWN, maxDrop + 1.2, { dynamic: false });
    if (!hit || hit.normal.y < 0.5) return false;
    this.pos.y = hit.point.y;
    return true;
  }

  /** Walk (or run) a step along (dx, dz) at `speed`, round the corners of what is in the way; keeps to the ground. */
  private _step(dx: number, dz: number, speed: number, dt: number): void {
    const col = collisionOf(this.mgr.game);
    this.vel.set(dx * speed, 0, dz * speed);
    this.pos.x += dx * speed * dt; this.pos.z += dz * speed * dt;
    for (const k of col.collideSphere(_a.copy(this.pos).setY(this.pos.y + 0.6), 0.45, { dynamic: false })) {
      if (k.depth > 0 && Math.abs(k.normal.y) < 0.6) { this.pos.x += k.normal.x * k.depth; this.pos.z += k.normal.z * k.depth; }
    }
    if (!this._stand(2.5)) this.pos.y = col.groundHeight(this.pos.x, this.pos.z);
    this.yaw = turnTo(this.yaw, Math.atan2(dx, dz), dt * 8);
  }

  update(dt: number, threat: { x: number; z: number; d: number } | null, playerD: number): void {
    const g = this.mgr.game;
    this.t += dt; this.phase += dt;
    const col = collisionOf(g);
    let wave = 0, run = 0, flail = 0, curl = 0, pace = 13;
    switch (this.state) {
      case 'wait': {
        this.vel.set(0, 0, 0);
        const p = g.player.render;
        const danger = !!threat && threat.d < 70;
        // someone who might help is near: face them and wave. Otherwise, with no titan about, go about the street
        if (playerD < (danger ? 90 : 26) && (danger || this.stuck)) {
          this.yaw = turnTo(this.yaw, Math.atan2(p.x - this.pos.x, p.z - this.pos.z), dt * 4); wave = 1; this.walkTo = null;
        } else if (!this.stuck && !danger) {
          if ((this.walkT -= dt) <= 0) {
            this.walkT = 3 + RND.sim() * 7;
            if (RND.sim() < 0.7) { const a = RND.sim() * 6.28, r = 4 + RND.sim() * 10; this.walkTo = (this.walkTo || new THREE.Vector3()).set(this.pos.x + Math.sin(a) * r, 0, this.pos.z + Math.cos(a) * r); }
            else this.walkTo = null;
          }
          const w = this.walkTo;
          if (w) {
            const dx = w.x - this.pos.x, dz = w.z - this.pos.z, dl = hypot(dx, dz);
            if (dl < 0.6) this.walkTo = null;
            else { this._step(dx / dl, dz / dl, 1.4, dt); run = 0.45; pace = 6; }
          }
        } else if (danger) wave = playerD < 120 ? 1 : 0;
        if (threat && threat.d < 34 && !this.stuck) this._enter('flee');
        break;
      }
      case 'flee': {
        if (!threat || threat.d > 55) { this._enter('wait'); break; }
        // away from it; outside the wall, bending toward the gate when that is not past the titan
        let dx = this.pos.x - threat.x, dz = this.pos.z - threat.z;
        const dl = hypot(dx, dz) || 1; dx /= dl; dz /= dl;
        const gx = -this.pos.x, gz = 4 - this.pos.z, gl = hypot(gx, gz) || 1;
        if (this.pos.z > 8 && (gx * dx + gz * dz) / gl > -0.2) { dx += (gx / gl) * 0.8; dz += (gz / gl) * 0.8; }
        const l = hypot(dx, dz) || 1;
        this._step(dx / l, dz / l, 5.2, dt);
        run = 1;
        // outside, reaching the gate while it still stands: the postern takes them in
        if (this.pos.z > 4 && Math.abs(this.pos.x) < 8 && this.pos.z < 8 && !g.world?.gateOpen) this.mgr._selfSaved(this);
        break;
      }
      case 'held': {
        const h = this.grabHand;
        if (h) { h.getWorldPosition(this.pos); this.pos.y -= 0.6; }
        flail = 1;
        break;
      }
      case 'fall': {
        this.vel.y -= 14.5 * dt;
        this.pos.addScaledVector(this.vel, dt);
        const hit = col.raycast(_a.copy(this.pos).setY(this.pos.y + 1), DOWN, 1 + Math.max(0.1, -this.vel.y * dt) + 0.05, { dynamic: false });
        if (hit && hit.normal.y > 0.5 && this.vel.y <= 0) {
          this.pos.y = hit.point.y; this.vel.set(0, 0, 0);
          this.stuck = hit.collider.type !== 'ground';
          this.catchable = true;
          this._enter('wait');
          g.fx?.impact?.(this.pos, UP, hit.collider.material || 'ground');
        }
        flail = 0.7;
        break;
      }
      case 'carried': {
        // on a soldier's back, arms round their shoulders
        const C = this.carrier;
        if (C) { this.pos.copy(C.render).addScaledVector(C.forward, -0.34).addScaledVector(C.up, -0.42); this.vel.copy(C.vel); }
        curl = 1;
        break;
      }
      case 'safe': {
        this.vel.set(0, 0, 0);
        // out of reach: a wave of thanks, then they watch the street below (and wave again when you come by)
        wave = this.t < 2.4 || (playerD < 14 && Math.sin(this.phase * 0.7) > 0.2) ? 1 : 0;
        if (wave) this.yaw = turnTo(this.yaw, Math.atan2(g.player.render.x - this.pos.x, g.player.render.z - this.pos.z), dt * 3);
        if (this.leaving) this.fade = Math.max(0, this.fade - dt * 1.2);
        break;
      }
      default: break;
    }

    // ---- the figure
    const r = this.root;
    if (!r.visible) return;
    r.position.copy(this.pos);
    const C = this.carrier;
    if (this.state === 'carried' && C) {
      _c.crossVectors(C.up, C.forward).normalize();
      _m.makeBasis(_c, C.up, C.forward);
      r.quaternion.setFromRotationMatrix(_m);
    } else {
      r.quaternion.setFromAxisAngle(UP, this.yaw);
      if (this.state === 'held') r.quaternion.multiply(_q.setFromAxisAngle(_a.set(1, 0, 0), Math.sin(this.phase * 9) * 0.35));
    }
    const ph = this.phase;
    const sw = run ? Math.sin(ph * pace) : 0;
    this.legL.rotation.x = sw * 0.9 * run + flail * Math.sin(ph * 11) * 0.8 + curl * 1.1;
    this.legR.rotation.x = -sw * 0.9 * run + flail * Math.sin(ph * 11 + 2) * 0.8 + curl * 1.1;
    // arms: swing on the run, both up and waving for help, thrashing in a hand, wrapped round the soldier
    const up = wave * (2.55 + Math.sin(ph * 7) * 0.3);
    this.armL.rotation.set(-sw * 0.8 * run - curl * 1.9, 0, up + flail * (2 + Math.sin(ph * 12) * 0.7) + curl * 0.3);
    this.armR.rotation.set(sw * 0.8 * run - curl * 1.9, 0, -(wave * (2.55 + Math.sin(ph * 7 + 1.4) * 0.3)) - flail * (2 + Math.sin(ph * 12 + 1) * 0.7) - curl * 0.3);
    this.body.position.y = run ? Math.abs(sw) * 0.05 * run : 0;
    this.body.rotation.x = run > 0.6 ? 0.18 : 0;
    if (this.fade < 1) {
      for (const m of this.mats) { m.transparent = true; m.opacity = this.fade; }
      if (this.fade <= 0) r.visible = false;
    }
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    for (const m of this.mats) m.dispose();
  }
}

interface Marker { node: HTMLElement; label: HTMLElement; on: boolean }

/** Every civilian in the run, who is carrying whom, the refuges, the HUD markers and the tally. */
export class Civilians {
  readonly game: Game;
  list: Civilian[] = [];
  /** the one on the player's back */
  carried: Civilian | null = null;
  /** carried to a refuge by you / by the squad; taken by a titan; got to the gate on their own */
  saved = 0; squadSaved = 0; lost = 0; escaped = 0;
  active = false;
  opts: RescueOptions = { areas: ['field'], max: 5 };
  refuges: Refuge[] = [];
  private seed = 1;
  private layer: HTMLElement | null = null;
  private marks: Marker[] = [];
  private beacons: THREE.Mesh[] = [];
  private beaconMat: THREE.ShaderMaterial;
  private told = { first: false, carry: false };
  private assignT = 0;
  /** titans are in the town (or it is a mission in the town): comrades fetch people. Before that the streets are at peace */
  alarm = false;
  private playerCarrier: Carrier | null = null;
  private wallPoint = new THREE.Vector3();

  constructor(game: Game) {
    this.game = game;
    this._buildRefuges();
    // a soft pillar of light over each refuge while you carry someone, so you can find it from across the town
    this.beaconMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uT: { value: 0 }, uK: { value: 0 } },
      vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform float uT, uK; varying vec2 vUv;
        void main() {
          float rise = fract(vUv.y * 3.0 - uT * 0.6);
          float a = (1.0 - vUv.y) * (0.35 + 0.25 * smoothstep(0.0, 0.3, rise) * smoothstep(1.0, 0.5, rise)) * uK;
          gl_FragColor = vec4(vec3(1.0, 0.78, 0.36) * a * 1.6, a);
        }`,
    });
    const geo = new THREE.CylinderGeometry(2.2, 2.6, 90, 20, 1, true);
    geo.translate(0, 45, 0);
    const pillars = this.refuges.filter((r) => r.kind !== 'wall').map((r) => r.pos);
    for (const d of game.world?.supplyDepots || []) if (d.position.y > 45 && Math.abs(d.position.z) < 8) pillars.push(d.position);   // the wall top, by the gate
    for (const at of pillars) {
      const b = new THREE.Mesh(geo, this.beaconMat);
      b.position.copy(at); b.renderOrder = 3; b.visible = false; b.frustumCulled = false;
      game.scene.add(b); this.beacons.push(b);
    }
    const ev = game.events;
    ev.on('civilian:grabbed', (e: { civilian: Civilian }) => {
      game.hud?.message?.(`IT HAS ${e.civilian.trade.toUpperCase()} — CUT THE HAND OR THE NAPE!`, 2.6, 'warn');
      game.audio?.civilianCry?.(e.civilian.pos, 1);
    });
    ev.on('civilian:freed', () => game.hud?.message?.('PULLED FROM ITS HAND — CATCH THEM!', 1.8, 'info'));
    ev.on('civilian:lost', (e: { civilian: Civilian }) => {
      this.lost++;
      game.hud?.feed?.(`${cap(e.civilian.trade)} was taken.`, 'warn');
      game.hud?.message?.('A CIVILIAN WAS LOST', 2, 'warn');
      game.audio?.civilianLost?.();
    });
  }

  // ---------------------------------------------------------------- refuges: where a titan cannot reach
  /**
   * The top of the Ashwall (all of it), the Wallguard roof in Varn, the post in the Greatwood, and three timber
   * lookouts this builds on the highest roofs round the near town, each under an amber banner.
   */
  private _buildRefuges(): void {
    const g = this.game, col = collisionOf(g);
    this.refuges.push({ pos: new THREE.Vector3(0, 50, 0), r: 0, kind: 'wall', name: 'the wall' });
    for (const d of g.world?.supplyDepots || []) {
      if (d.position.z < -8 && d.position.y > 12) this.refuges.push({ pos: d.position.clone(), r: 11, kind: 'roof', name: 'the Wallguard roof' });
      else if (d.position.z > 60) this.refuges.push({ pos: d.position.clone(), r: d.radius, kind: 'post', name: 'the forest post' });
    }
    const wood = litMaterial(0x7d6444, { roughness: 0.85 }), dark = litMaterial(0x4d3f2e, { roughness: 0.9 });
    const cloth = litMaterial(0xf0a43a, { roughness: 0.8, side: THREE.DoubleSide, emissive: 0x4a2c06 });
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D): THREE.Mesh => {
      const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; parent.add(o); return o;
    };
    const world = g.collision as unknown as { addBox(o: { center: THREE.Vector3; halfExtents: THREE.Vector3; material: string }): unknown };
    for (const [tx, tz] of [[98, -72], [-118, -138], [58, -152]]) {
      // the highest point of the roofs round here: the lookout stands on it (never lower than a titan can reach)
      let top = 0, bx = tx, bz = tz;
      for (let i = -3; i <= 3; i++) for (let k = -3; k <= 3; k++) {
        const h = col.raycast(_a.set(tx + i * 4, 80, tz + k * 4), DOWN, 85, { dynamic: false });
        if (h && h.collider.type !== 'ground' && h.point.y > top && h.point.y < 40) { top = h.point.y; bx = tx + i * 4; bz = tz + k * 4; }
      }
      const y = Math.max(top + 0.9, 19), S = 8.5;
      const grp = new THREE.Group(); grp.position.set(bx, y, bz);
      box(S, 0.36, S, wood, 0, -0.18, 0, grp);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.36, y - 1, 0.36, dark, sx * (S / 2 - 0.4), -(y - 1) / 2 - 0.3, sz * (S / 2 - 0.4), grp);
      for (const s of [-1, 1]) { box(S, 0.14, 0.14, dark, 0, 1.0, s * (S / 2 - 0.1), grp); box(0.14, 0.14, S, dark, s * (S / 2 - 0.1), 1.0, 0, grp); }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.16, 1.05, 0.16, dark, sx * (S / 2 - 0.1), 0.5, sz * (S / 2 - 0.1), grp);
      box(0.16, 6, 0.16, dark, S / 2 - 0.5, 3, S / 2 - 0.5, grp);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.5), cloth); flag.position.set(S / 2 - 1.85, 5.1, S / 2 - 0.5); grp.add(flag);
      g.scene.add(grp);
      world.addBox({ center: new THREE.Vector3(bx, y - 0.18, bz), halfExtents: new THREE.Vector3(S / 2, 0.18, S / 2), material: 'wood' });
      this.refuges.push({ pos: new THREE.Vector3(bx, y, bz), r: S / 2 - 0.4, kind: 'roof', name: 'a lookout' });
    }
  }

  /** The nearest safe place to `from`, as a point to make for (on the wall: the nearest stretch of its top). */
  nearestRefuge(from: THREE.Vector3, out: THREE.Vector3): { refuge: Refuge; dist: number } {
    let best = this.refuges[0], bd = 1e9;
    for (const r of this.refuges) {
      const p = r.kind === 'wall' ? this.wallPoint.set(THREE.MathUtils.clamp(from.x, -600, 600), 50, 0) : r.pos;
      const d = from.distanceTo(p);
      if (d < bd) { bd = d; best = r; out.copy(p); }
    }
    return { refuge: best, dist: bd };
  }
  /** Is this spot (someone standing there) out of a titan's reach? Returns the refuge, or null. */
  refugeAt(p: THREE.Vector3): Refuge | null {
    for (const r of this.refuges) {
      if (r.kind === 'wall') { if (p.y > 49.3 && p.y < 54 && Math.abs(p.z) < 6.9) return r; }
      else if (hypot(p.x - r.pos.x, p.z - r.pos.z) < r.r && p.y > r.pos.y - 0.6 && p.y < r.pos.y + 3.2) return r;
    }
    return null;
  }

  /** Start (or stop: null) the rescues for a mode. */
  begin(opts: RescueOptions | null): void {
    this.clear();
    this.active = !!opts;
    this.alarm = !!opts && !opts.townsfolk;
    if (opts) {
      this.opts = { ...opts };
      // the people of Varn, about their day
      if (opts.townsfolk) this._strand(opts.townsfolk, ['town'], true);
    }
  }

  /** The gate is down: from now on it is the town's people who need you, and more of them are caught out. */
  panic(): void {
    if (!this.active) return;
    this.alarm = true;
    this.opts.areas = ['town']; this.opts.max = Math.max(this.opts.max, 11);
    const n = this._strand(5, ['town'], true);
    if (n) this.game.hud?.feed?.('People are in the streets of the town: get them onto the roofs', 'warn');
  }

  clear(): void {
    for (const c of this.list) c.dispose();
    this.list.length = 0;
    this.carried = null; this.saved = 0; this.squadSaved = 0; this.lost = 0; this.escaped = 0;
    if (this.game.player) this.game.player.carrying = null;
    for (const b of this.beacons) b.visible = false;
    for (const m of this.marks) { m.node.style.display = 'none'; m.on = false; }
  }

  /** How many are still out there to be saved. */
  get stranded(): number { let n = 0; for (const c of this.list) if (c.alive && c.state !== 'safe') n++; return n; }

  /** Strand `count` more people (up to the mode's cap), in the given areas, and say so. */
  spawn(count: number, areas: Area[] = this.opts.areas): number {
    if (!this.active) return 0;
    const made = this._strand(count, areas, false);
    if (made && !this.told.first) {
      this.told.first = true;
      this.game.hud?.message?.('PEOPLE ARE CUT OFF OUT THERE: fly through one to pick them up, set them down on the wall or a lookout roof', 5, 'info');
    } else if (made) this.game.hud?.feed?.(made > 1 ? `${made} more people are cut off out there` : 'Someone else is cut off out there', 'info');
    return made;
  }
  private _strand(count: number, areas: Area[], quiet: boolean): number {
    let made = 0;
    const cap0 = quiet ? Math.max(this.opts.max, count + this.stranded) : this.opts.max;
    for (let i = 0; i < count && this.stranded < cap0; i++) {
      const spot = this._findSpot(areas[(RND.sim() * areas.length) | 0]);
      if (!spot) continue;
      const c = new Civilian(this, (this.seed++ * 0.6180339887) % 1 + 0.01);
      c.pos.copy(spot.pos); c.stuck = spot.stuck; c.yaw = RND.sim() * 6.28;
      c.update(0, null, 1e9);
      this.list.push(c); made++;
    }
    return made;
  }

  /** A place to stand in an area: open ground, a street, a low flat roof, a low branch (never a refuge). */
  _findSpot(area: Area): { pos: THREE.Vector3; stuck: boolean } | null {
    const col = collisionOf(this.game);
    const box = area === 'town' ? [-165, 165, -175, -24] : area === 'forest' ? [-170, 170, FS + 200, FS + 330] : [-170, 170, 42, 175];
    for (let tries = 0; tries < 24; tries++) {
      const x = box[0] + RND.sim() * (box[1] - box[0]), z = box[2] + RND.sim() * (box[3] - box[2]);
      const gy = col.groundHeight(x, z);
      const hit = col.raycast(_a.set(x, gy + 15, z), DOWN, 19, { dynamic: false });
      if (!hit || hit.normal.y < 0.85) continue;
      const stuck = hit.collider.type !== 'ground';
      // room to stand, and not under a titan's feet, on top of another civilian or already somewhere safe
      if (col.collideSphere(_b.copy(hit.point).setY(hit.point.y + 0.9), 0.5, { dynamic: false }).some((k) => k.depth > 0.05 && k.collider !== hit.collider)) continue;
      if (this.refugeAt(_b.copy(hit.point).setY(hit.point.y + 0.5))) continue;
      let ok = true;
      for (const t of this.game.titans?.titans || []) if (t.alive && hypot(t.position.x - x, t.position.z - z) < 30) { ok = false; break; }
      for (const c of this.list) if (c.alive && hypot(c.pos.x - x, c.pos.z - z) < 10) { ok = false; break; }
      if (!ok) continue;
      return { pos: hit.point.clone(), stuck };
    }
    return null;
  }

  _selfSaved(c: Civilian): void {
    c.catchable = false; c.rescuer = null; c._enter('safe'); c.leaving = true; this.escaped++;
    this.game.hud?.feed?.(`${cap(c.trade)} made it to the gate`, 'info');
  }

  // ---------------------------------------------------------------- carrying
  /** Up onto someone's back: yours (by null) or a comrade's. */
  pickUp(c: Civilian, by: Rescuer | null, caught = false): void {
    const g = this.game, p = g.player;
    c.catchable = false; c.rescuer = by; c._enter('carried');
    if (by) { c.carrier = { owner: by, render: by.render, forward: by.forward, up: by.up, vel: by.vel }; return; }
    c.carrier = this.playerCarrier || (this.playerCarrier = { owner: p, render: p.render, forward: p.forward, up: p.bodyUp, vel: p.vel });
    this.carried = c; p.carrying = c;
    g.audio?.rescuePickup?.();
    g.hud?.message?.(caught ? `CAUGHT ${c.trade.toUpperCase()}!  +150` : `YOU HAVE ${c.trade.toUpperCase()} — UP TO THE WALL OR A LOOKOUT`, 2.2, 'info');
    if (caught) g.flow.score += 150;
    if (!this.told.carry) { this.told.carry = true; g.hud?.feed?.('Follow the amber light: set them down where no titan can reach', 'info'); }
    g.events.emit('civilian:picked', { civilian: c, caught });
  }

  /** Set down out of reach: saved. They stay up there. */
  deliver(c: Civilian, at: THREE.Vector3, where: Refuge, by: Rescuer | null): void {
    const g = this.game, p = g.player;
    const spread = where.kind === 'wall' ? 2.5 : Math.min(where.r * 0.7, 5);
    const a = RND.sim() * 6.28, r = Math.sqrt(RND.sim()) * spread;
    c.pos.set((where.kind === 'wall' ? at.x : where.pos.x) + Math.sin(a) * r, at.y + 0.6, where.kind === 'wall' ? THREE.MathUtils.clamp(at.z + Math.cos(a) * 1.5, -4.5, 3.5) : where.pos.z + Math.cos(a) * r);
    if (!c._stand(5)) c.pos.y = where.pos.y;
    c.carrier = null; c.rescuer = null; c.stuck = true; c.yaw = RND.sim() * 6.28;
    c._enter('safe');
    // (the roofs only hold so many: the first up go inside)
    const up = this.list.filter((x) => x.state === 'safe' && !x.leaving);
    for (let i = 0; i < up.length - 10; i++) up[i].leaving = true;
    if (by) {
      this.squadSaved++;
      g.hud?.feed?.(`${by.name} carried ${c.trade} up to ${where.name}`, 'radio');
      g.events.emit('civilian:saved', { civilian: c, total: this.saved + this.squadSaved, by });
      return;
    }
    this.carried = null; p.carrying = null;
    this.saved++;
    const bonus = 400 * Math.max(1, g.flow.combo);
    g.flow.score += bonus;
    if (!p.infiniteGas) p.odm.gas = Math.min(1, p.odm.gas + 0.25);
    g.audio?.rescueDeliver?.();
    g.hud?.message?.(`${c.trade.toUpperCase()} IS SAFE ON ${where.name.toUpperCase()}  +${bonus}`, 2.4, 'info');
    g.hud?.feed?.(`You carried ${c.trade} up to ${where.name}`, 'kill');
    g.events.emit('civilian:saved', { civilian: c, total: this.saved + this.squadSaved, by: null });
  }

  /** Whoever was carrying them went down or was caught: they are on their own again. */
  drop(c: Civilian): void {
    if (c.carrier?.owner === this.game.player) { this.carried = null; this.game.player.carrying = null; }
    c.carrier = null; c.rescuer = null;
    c.vel.set(0, 0, 0); c._enter('fall'); c.catchable = false;
  }

  /** Send free comrades for people in the streets (two at a time: the rest of the squad fights). */
  private _assign(): void {
    const allies = (this.game.allies || []) as unknown as Rescuer[];
    let busy = 0;
    for (const a of allies) if (a.rescue) busy++;
    if (busy >= 2) return;
    const pr = this.game.player.render;
    for (const c of this.list) {
      if (busy >= 2) break;
      if (!c.alive || c.rescuer || !c.catchable || c.skipT > 0 || (c.state !== 'wait' && c.state !== 'flee')) continue;
      if (c.pos.z > 8 || pr.distanceTo(c.pos) < 22) continue;          // (the ones outside the wall, and the one you are going for, are yours)
      let best: Rescuer | null = null, bd = 190;
      for (const a of allies) {
        if (!a.alive || a.grabbedBy || a.horse || a.job || a.rescue) continue;
        const d = a.pos.distanceTo(c.pos);
        if (d < bd) { bd = d; best = a; }
      }
      if (!best) continue;
      c.rescuer = best; best.startRescue(c); busy++;
    }
  }

  update(dt: number): void {
    const g = this.game, p = g.player;
    if (!this.active && !this.list.length) return;
    const titans = g.titans?.titans || [];
    const pr = p.render;
    const canCarry = p.alive && !p.grabbedBy && !this.carried;
    if (this.carried && (!p.alive || p.grabbedBy)) this.drop(this.carried);
    // (comrades go for people once titans are in the town; before that the streets are quiet)
    if ((this.assignT -= dt) <= 0) { this.assignT = 1.1; if (this.alarm) this._assign(); }
    const threat = { x: 0, z: 0, d: 1e9 };
    for (let i = this.list.length - 1; i >= 0; i--) {
      const c = this.list[i];
      if (!c.alive || (c.leaving && c.fade <= 0)) { c.dispose(); this.list.splice(i, 1); continue; }
      // a comrade who was carrying them went down, or one on the way gave up
      const R = c.rescuer;
      if (R && (!R.alive || R.grabbedBy)) { if (c.state === 'carried') this.drop(c); else c.rescuer = null; }
      else if (R && c.state !== 'carried' && R.rescue === null) c.rescuer = null;
      // the nearest titan, for running from and for how loudly they call
      threat.d = 1e9;
      for (const t of titans) {
        if (!t.alive) continue;
        const d = hypot(t.position.x - c.pos.x, t.position.z - c.pos.z);
        if (d < threat.d) { threat.d = d; threat.x = t.position.x; threat.z = t.position.z; }
      }
      const pd = pr.distanceTo(_a.copy(c.pos).setY(c.pos.y + 0.9));
      if (c.skipT > 0) c.skipT -= dt;
      // (the roof they stood on came down under them)
      if (c.stuck && c.state === 'wait' && (c.floorT -= dt) <= 0) {
        c.floorT = 0.4 + RND.sim() * 0.3;
        const y0 = c.pos.y;
        if (!c._stand(1.2) || c.pos.y < y0 - 0.6) { c.pos.y = y0; c.stuck = false; c.vel.set(0, 0, 0); c._enter('fall'); c.catchable = false; }
      }
      c.update(dt, threat.d < 1e8 ? threat : null, pd);
      if (c.state === 'wait' || c.state === 'flee' || c.state === 'fall') {
        // fly (or run, or ride) through them: up they come
        if (canCarry && !this.carried && pd < 2.5 + Math.min(1.6, p.speed * 0.03)) { this.pickUp(c, null, c.state === 'fall'); continue; }
        // calling for help: more often and more desperately the closer a titan is (in peace they keep quiet)
        c.cryT -= dt;
        if (c.cryT <= 0 && c.state !== 'fall') {
          const urgency = THREE.MathUtils.clamp(1 - (threat.d - 15) / 70, 0, 1);
          c.cryT = 3.5 + RND.sim() * 4 - urgency * 2;
          if (pd < 170 && (urgency > 0.05 || c.stuck)) g.audio?.civilianCry?.(c.pos, Math.max(0.15, urgency));
        }
      }
    }
    // you, standing somewhere out of reach with one on your back: set them down
    if (this.carried && p.grounded && !p.riding && p.speed < 30) {
      const at = this.refugeAt(_a.copy(p.pos).setY(p.pos.y - 0.4));
      if (at) this.deliver(this.carried, p.pos, at, null);
    }
    this.beaconMat.uniforms.uT.value += dt;
    const bk = this.beaconMat.uniforms.uK;
    bk.value += ((this.carried ? 1 : 0) - bk.value) * Math.min(1, dt * 3);
    for (const b of this.beacons) b.visible = bk.value > 0.02;
    this._markers();
  }

  // ---------------------------------------------------------------- HUD markers (their own small layer)
  private _mark(i: number): Marker {
    if (!this.layer) {
      const host = document.querySelector('.aott-game') || document.body;
      this.layer = document.createElement('div');
      this.layer.className = 'aott-civs';
      const st = document.createElement('style');
      st.textContent = `.aott-civs{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.aott-root.cine .aott-civs{opacity:0}
.aott-civ{position:absolute;left:0;top:0;width:0;height:0;will-change:transform;display:none}
.aott-civ i{position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%;border:2px solid var(--amber,#f0a43a);background:rgba(240,164,58,.18);box-shadow:0 0 0 1px rgba(0,0,0,.55)}
.aott-civ i::after{content:"";position:absolute;left:3px;top:3px;width:4px;height:4px;border-radius:50%;background:var(--amber,#f0a43a)}
.aott-civ b{position:absolute;left:13px;top:-8px;padding:1px 5px;font:700 9.5px/14px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#e6e1d6;white-space:nowrap;background:rgba(14,16,18,.72);border:1px solid rgba(230,225,214,.14)}
.aott-civ[data-k="far"] i{width:8px;height:8px;left:-4px;top:-4px;border-width:1.5px;opacity:.75}
.aott-civ[data-k="far"] i::after{display:none}
.aott-civ[data-k="far"] b{display:none}
.aott-civ[data-k="held"] i{border-color:var(--blood,#c4372b);background:rgba(196,55,43,.25);animation:aott-civ-p .4s ease-in-out infinite alternate}
.aott-civ[data-k="held"] i::after{background:var(--blood,#c4372b)}
.aott-civ[data-k="refuge"] i{border-radius:2px;transform:rotate(45deg);border-color:#e6e1d6;background:rgba(230,225,214,.2)}
.aott-civ[data-k="refuge"] i::after{background:#e6e1d6}
.aott-civ[data-edge="1"] b{left:auto;right:13px}
@keyframes aott-civ-p{from{transform:scale(1)}to{transform:scale(1.35)}}`;
      document.head.appendChild(st);
      host.appendChild(this.layer);
    }
    while (this.marks.length <= i) {
      const node = document.createElement('div'); node.className = 'aott-civ';
      node.innerHTML = '<i></i><b></b>';
      this.layer.appendChild(node);
      this.marks.push({ node, label: node.lastElementChild as HTMLElement, on: false });
    }
    return this.marks[i];
  }

  private _place(m: Marker, world: THREE.Vector3, kind: string, text: string): void {
    const cam = this.game.camera;
    _b.copy(world).project(cam);
    let x = (_b.x * 0.5 + 0.5) * innerWidth, y = (-_b.y * 0.5 + 0.5) * innerHeight;
    const behind = _b.z > 1;
    // off screen (or behind you): pin it to the edge of the view, pointing the way
    // (kept clear of the panels in the corners: the objective bar on top, the status and speed panels below)
    const pad = 36, top = 84, bottom = Math.max(top + 40, innerHeight - 178);
    let edge = false;
    if (behind) { x = innerWidth - x; y = bottom; edge = true; }
    if (x < pad || x > innerWidth - pad || y < top || y > bottom) {
      x = Math.max(pad, Math.min(innerWidth - pad, x)); y = Math.max(top, Math.min(bottom, y)); edge = true;
    }
    // (the small rings of people who are in no danger only show where they stand, not along the edge)
    m.on = true;
    if (kind === 'far' && edge) { m.node.style.display = 'none'; return; }
    m.node.style.display = 'block';
    m.node.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    m.node.dataset.k = kind;
    m.node.dataset.edge = edge && x > innerWidth * 0.6 ? '1' : '0';
    if (m.label.textContent !== text) m.label.textContent = text;
  }

  private _markers(): void {
    const g = this.game, pr = g.player.render;
    let n = 0;
    // the markers are a DOM layer: a headless run has none, the people are simulated all the same
    const show = typeof document !== 'undefined' && g.mode !== 'menu' && g.player.alive && !g.killCam;
    if (show) {
      for (const c of this.list) {
        if (!c.alive || c.state === 'safe' || c.state === 'carried' || c.state === 'lost') continue;
        const d = pr.distanceTo(c.pos);
        if (d > 420) continue;
        // in a hand, in danger or close by: the full marker. The rest of the town: a small ring
        const held = c.state === 'held';
        const full = held || c.state === 'flee' || c.stuck || d < 70;
        this._place(this._mark(n++), _a.copy(c.pos).setY(c.pos.y + 2.3), held ? 'held' : full ? 'wait' : 'far', held ? `in its hand · ${Math.round(d)} m` : `${c.trade.replace(/^a /, '')} · ${Math.round(d)} m`);
      }
      if (this.carried) {
        const { refuge, dist } = this.nearestRefuge(pr, _c);
        this._place(this._mark(n++), _a.copy(_c).setY(_c.y + 3), 'refuge', `${refuge.name.replace(/^(the|a) /, '')} · ${Math.round(dist)} m`);
      }
    }
    for (let i = n; i < this.marks.length; i++) if (this.marks[i].on) { this.marks[i].node.style.display = 'none'; this.marks[i].on = false; }
  }

  /** One line for the objective bar. */
  summary(): string {
    if (!this.active) return '';
    if (this.carried) return ` · CARRYING ${this.carried.trade.toUpperCase()} → THE WALL OR A LOOKOUT`;
    const n = this.stranded, s = this.saved + this.squadSaved;
    return n || s ? ` · People: ${n} in danger, ${s} safe${this.lost ? `, ${this.lost} lost` : ''}` : '';
  }
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
