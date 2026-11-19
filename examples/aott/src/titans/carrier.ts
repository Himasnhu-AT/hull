// Seal the Breach: the shifter's giant and the boulder. A Titan built on the shifter's design that the mission
// (src/missions/gate.ts) takes through its beats: it bursts out of a lightning strike, thrashes blind (one swing at the
// squad, one into its own face), slumps against the boulder, comes round, gets the boulder up onto its shoulders,
// walks it bent double to the breach, drives it into the gate and collapses, steaming. It is not in
// TitanManager.titans, so nothing targets, cuts or spots it; titans in state 'maul' go for it (titan.ts
// _thinkEscort). Its body and the boulder are plain hookable shapes: you can rope onto it and ride along.
import * as THREE from 'hull/three';
import { Titan } from './titan';
import type { TitanManager } from './titans';
import { litMaterial } from '../core/style';
import { CAST } from '../brand';
import type { Game } from '../types';
import type { SphereCollider } from '../core/collision';
import type { TitanSpec } from './builder';

const V3 = THREE.Vector3;
export const BOULDER_R = 7.2;                 // the boulder is as big as he is (~14 m across)
const R = BOULDER_R;
// in the gate's town mouth (the tunnel is x ∈ ±8, y ∈ 0..20, z ∈ ±6): wedged in, ~19 m across
const SEAT = new V3(0, 9.2, -4.6), SEAT_SCALE = 1.32;
const T = { emerge: 1.8, berserk: 4.2, lift: 3.4, heave: 1.9 };
/** The shifter's giant: the builder design it is drawn from. */
export const SHIFTER_SPEC: TitanSpec = { build: 'muscular', skin: 'tan', hair: 0, expr: 'shifter' };
const _t = new V3(), _a = new V3(), _b = new V3(), _q = new THREE.Quaternion(), UP = new V3(0, 1, 0);
const sm = (x: number): number => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

// ------------------------------------------------------------------------------------------------ the boulder
const _c = new THREE.Color(), _c2 = new THREE.Color();
/** Cheap value noise for the rock's colour (no texture fetch: the stone's grain lives in the vertex colours). */
const hash3 = (x: number, y: number, z: number): number => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

/** The boulder: a lumpy weathered block of grey granite with a hookable collider that rides on it. */
export class Boulder {
  game: Game;
  mesh: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshStandardMaterial>;
  col: SphereCollider | null;
  vel: THREE.Vector3;

  constructor(game: Game, position: THREE.Vector3) {
    this.game = game;
    const g = new THREE.IcosahedronGeometry(R, 4);
    const p = g.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(p.count * 3);
    const base = new THREE.Color(0x8c877e), dark = new THREE.Color(0x4f4b45), lichen = new THREE.Color(0x7d8461), dust = new THREE.Color(0xb3a993);
    for (let i = 0; i < p.count; i++) {
      _t.fromBufferAttribute(p, i);
      const n = Math.sin(_t.x * 0.9 + 1.3) * Math.sin(_t.y * 0.7 + 0.4) * Math.sin(_t.z * 0.8 + 2.1);
      const fine = 0.04 * Math.sin(_t.x * 2.3 + _t.z * 1.7) + 0.018 * Math.sin(_t.y * 5.1 + _t.x * 3.7) * Math.sin(_t.z * 4.3);
      _t.multiplyScalar(1 + 0.09 * n + fine);
      _t.y *= 0.92;
      p.setXYZ(i, _t.x, _t.y, _t.z);
      // colour: darker in the hollows, a mottle of grain, lichen on the shaded underside, dust on top
      const grain = hash3(Math.round(_t.x * 3), Math.round(_t.y * 3), Math.round(_t.z * 3));
      _c.copy(base).lerp(dark, THREE.MathUtils.clamp(0.45 - n * 1.6 - fine * 6, 0, 0.75));
      const mottle = 0.5 + 0.5 * Math.sin(_t.x * 1.9 + Math.sin(_t.z * 1.3) * 2) * Math.sin(_t.y * 1.6 + _t.z * 0.7);
      _c.multiplyScalar(0.72 + 0.2 * mottle + 0.22 * grain);
      const up = _t.y / R;
      if (up < -0.1) _c.lerp(_c2.copy(lichen), 0.35 * Math.min(1, -up) * (0.5 + grain));
      if (up > 0.35) _c.lerp(_c2.copy(dust), 0.3 * (up - 0.35));
      colors[i * 3] = _c.r; colors[i * 3 + 1] = _c.g; colors[i * 3 + 2] = _c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    this.mesh = new THREE.Mesh(g, litMaterial(0xffffff, { vertexColors: true, roughness: 0.95, metalness: 0 }));
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    game.titans?.group.add(this.mesh);
    this.mesh.position.copy(position);
    this.mesh.updateMatrixWorld(true);
    this.col = game.collision.addSphere({ center: new V3(), radius: R * 0.95, object3D: this.mesh, dynamic: true, material: 'stone' });
    this.vel = new V3();
  }
  get position(): THREE.Vector3 { return this.mesh.position; }
  /** Seated in the gate for good: a static shape the full size of it. */
  seat(): void {
    const col = this.game.collision;
    if (this.col) col.remove(this.col);
    this.col = col.addSphere({ center: SEAT.clone(), radius: R * SEAT_SCALE * 0.95, material: 'stone' });
  }
  dispose(): void {
    if (this.col) this.game.collision.remove(this.col);
    this.col = null;
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// ------------------------------------------------------------------------------------------------ the giant
export type CarrierPhase = 'emerge' | 'berserk' | 'down' | 'lift' | 'walk' | 'heave' | 'done' | 'fallen';

export interface CarrierOptions {
  position: THREE.Vector3;
  yaw?: number;
  boulder: Boulder;
  /** z of the street where he heaves the boulder in (the gate is at z = 0). */
  goalZ?: number;
}

export class Carrier extends Titan {
  readonly carrier = true;
  name: string;
  hpMax: number;
  hp: number;
  goalZ: number;
  boulder: Boulder;
  rest: THREE.Vector3;
  phase: CarrierPhase;
  phaseT: number;
  /** titans clawing at him right now */
  mauled: number;
  /** a titan stands in his way */
  blocked: boolean;
  /** where his blind swing goes (the squad member in front of him) */
  punchAt: THREE.Vector3;
  roarT = 0;
  /** s to the next puff of steam off his neck (his own timer: Titan.steamT is the death steam) */
  ventT = 0;
  startZ: number | undefined;
  liftFrom: THREE.Vector3 | null = null;
  heaveFrom: THREE.Vector3 | null = null;

  constructor(mgr: TitanManager, o: CarrierOptions) {
    super(mgr, { kind: 'normal', height: 15, position: o.position, yaw: o.yaw ?? 0, spec: SHIFTER_SPEC });
    this.name = CAST.shifter;
    this.hpMax = 100; this.hp = 100;
    this.goalZ = o.goalZ ?? -19;
    this.boulder = o.boulder;
    this.rest = this.boulder.position.clone();
    this.phase = 'emerge'; this.phaseT = 0;
    this.mauled = 0; this.blocked = false;
    this.walkSpeed *= 0.8;                    // heavy: the boulder bends him double
    this.punchAt = new V3();
    for (const c of this.colliders) delete c.userData.titan;   // not a titan as far as ropes are concerned
    this.root.traverse((c: THREE.Object3D) => { if ((c as THREE.Mesh).isMesh) delete c.userData.titan; });
    mgr.group.add(this.root);
  }

  /** Titans can hurt him (and his health matters) in these phases. */
  get vulnerable(): boolean { return this.phase === 'down' || this.phase === 'lift' || this.phase === 'walk' || this.phase === 'done'; }
  /** 0 at the boulder … 1 at the breach. */
  get progress(): number {
    if (this.startZ === undefined) return 0;
    return THREE.MathUtils.clamp((this.position.z - this.startZ) / (this.goalZ - this.startZ), 0, 1);
  }

  setPhase(p: CarrierPhase): void {
    this.phase = p; this.phaseT = 0;
    this.crippleT = p === 'down' || p === 'done' || p === 'fallen' ? 1e6 : 0;   // kneels (titan.ts _poseKneel)
    if (p === 'lift') this.liftFrom = this.boulder.position.clone();
    if (p === 'walk' && this.startZ === undefined) this.startZ = this.position.z;
    if (p === 'heave') this.heaveFrom = this.boulder.position.clone();
    if (p === 'fallen') this.boulder.vel.set(Math.sin(this.yaw) * 5, 3, Math.cos(this.yaw) * 5);
    this.game.events?.emit?.('carrier:' + p, { carrier: this });
  }

  /** A titan's blow (titan.ts 'maul'). */
  hurt(damage: number, by?: Titan): void {
    if (!this.vulnerable) return;
    this.hp = Math.max(0, this.hp - damage);
    this.flinch = 1;
    this.game.fx?.blood?.(this._jpos('spine', _t), _a.set(0, 1, 0), 1.2);
    if (this.rnd() < 0.4) this.game.audio?.titanGroan?.(this.position, this.height);
    this.game.events?.emit?.('carrier:hurt', { carrier: this, by, damage });
    if (this.hp <= 0) this.setPhase('fallen');
  }

  roar(): void {
    this.roarT = 1.6;
    this.game.audio?.titanGroan?.(this.position, 40);
    this.game.events?.emit?.('titan:step', { position: this.position.clone(), size: 26 });
  }

  override _sense(): void { this.hasPlayer = false; this.distH = this.dist3 = Infinity; }
  override _updateThreat(): void { this.threat = 0; }

  override _think(dt: number): void {
    this.stateT += dt; this.phaseT += dt;
    this.speedTarget = 0; this.goal = null; this.faceYaw = null;
    this.state = 'idle';
    this.roarT = Math.max(0, this.roarT - dt);
    this.mauled = 0;
    for (const t of this.mgr.titans) if (t.alive && t.state === 'maul' && t.mauling) this.mauled++;
    this.gazeTarget = null;
    const ph = this.phase;
    if (ph === 'emerge' && this.phaseT > T.emerge) { this.roar(); this.setPhase('berserk'); }
    else if (ph === 'berserk') {
      this.faceYaw = Math.atan2(this.punchAt.x - this.position.x, this.punchAt.z - this.position.z);
      this.gazeTarget = this.punchAt;
      if (this.phaseT > T.berserk) this.setPhase('down');
    } else if (ph === 'lift' && this.phaseT > T.lift) { this.roar(); this.setPhase('walk'); }
    else if (ph === 'walk') {
      if (this.position.z >= this.goalZ) { this.setPhase('heave'); return; }
      // a titan in his way, or on him: he can't push on
      this.blocked = false;
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      for (const t of this.mgr.titans) {
        if (!t.alive) continue;
        const dx = t.position.x - this.position.x, dz = t.position.z - this.position.z, d = Math.hypot(dx, dz);
        if (d < this.footR + t.footR + 7 && (dx * fx + dz * fz) > d * 0.6) { this.blocked = true; break; }
      }
      this.faceYaw = 0;
      if (this.mauled > 0 || this.blocked) return;
      this.goal = _t.set(0, 0, this.goalZ + 5);
      this.speedTarget = this.walkSpeed;
    } else if (ph === 'heave' && this.phaseT > T.heave) {
      this.boulder.seat();
      this.setPhase('done');
      this.game.events?.emit?.('carrier:sealed', { carrier: this });
    }
  }

  override _poseState(): void {
    const P = this.P, ph = this.phase, u = this.phaseT;
    if (this.roarT > 0) { this.jawExtra += 0.55 * Math.min(1, this.roarT * 2); P.head[0] -= 0.35 * Math.min(1, this.roarT * 2); P.spine[0] -= 0.12; }
    if (ph === 'emerge') { P.spine[0] -= 0.15 * sm(u / T.emerge); return; }
    if (ph === 'berserk') {
      // a wild swing at whoever stands in front of him, then his own fist into his face; he reels
      if (u > 0.5 && u < 1.6) {
        const k = sm((u - 0.5) / 0.35) * (1 - sm((u - 1.25) / 0.35));
        this._jpos('armR', _a); _t.lerpVectors(_a, this.punchAt, 0.85 * k + 0.1);
        this._arm(1, _t, this._pole(1, 0.6, -0.3, -0.5), 22);
        P.spine[1] -= 0.45 * k; P.spine[0] += 0.2 * k;
      }
      if (u > 2.3 && u < 3.3) {
        const k = sm((u - 2.3) / 0.2) * (1 - sm((u - 3.0) / 0.3));
        this._headWorld(_t).addScaledVector(_a.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)), this.d.rz * this.s * 1.1);
        this._arm(0, _t, this._pole(0, 0.9, -0.2, 0.2), 26);
        P.head[2] += 0.5 * k; P.head[0] -= 0.3 * k; P.spine[2] += 0.15 * k;
      }
      if (u > 3.0) { const k = sm((u - 3.0) / 1.0); P.spine[0] += 0.4 * k; P.head[0] += 0.4 * k; }
      return;
    }
    if (ph === 'down' || ph === 'fallen') {      // slumped on his knees against the boulder, head hanging
      P.spine[0] += 0.55; P.neck[0] += 0.3; P.head[0] += 0.45; P.armL[2] += 0.25; P.armR[2] -= 0.25;
      return;
    }
    if (ph === 'done') {                          // collapsed forward onto the boulder, spent
      P.spine[0] += 0.75; P.head[0] += 0.3;
      this._hands(0.7, 0.2);
      return;
    }
    // lift / walk / heave: hands on the boulder, bent under it
    const lean = ph === 'lift' ? 0.6 - 0.32 * sm(u / T.lift) : ph === 'heave' ? 0.28 + 0.4 * sm(u / T.heave) : 0.28;
    P.spine[0] += lean; P.head[0] -= lean * 0.6;  // head up: he looks where he's going
    P.thighL[2] += 0.07; P.thighR[2] -= 0.07;
    if (ph === 'walk' && (this.mauled || this.blocked)) P.spine[2] += 0.1 * Math.sin(this.t * 7);
    this._hands(0.82, -0.3);
  }

  /** Both hands on the boulder's sides: `side` of the radius out to each side, `up` of it above/below the centre. */
  _hands(side: number, up: number): void {
    const b = this.boulder.mesh, r = R * b.scale.x;
    const lx = Math.cos(this.yaw), lz = -Math.sin(this.yaw);   // his left in world
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1;
      _t.set(b.position.x + lx * s * r * side + fx * r * 0.3, b.position.y + r * up, b.position.z + lz * s * r * side + fz * r * 0.3);
      this._arm(i, _t, this._pole(i, 1, -0.4, -0.2), 16);
    }
  }

  override update(dt: number): void {
    super.update(dt);
    if (this.dead) return;
    dt = Math.min(dt, 0.05);
    // other titans can't walk through him
    const pos = this.position;
    for (const o of this.mgr.titans) {
      if (!o.alive || o.airborne) continue;
      const dx = o.position.x - pos.x, dz = o.position.z - pos.z, md = (this.footR + o.footR) * 1.3, d2 = dx * dx + dz * dz;
      if (d2 < md * md && d2 > 1e-6) { const d = Math.sqrt(d2); o.position.x += dx / d * (md - d); o.position.z += dz / d * (md - d); }
    }
    if (this.phase === 'emerge' || this.phase === 'done') {
      this.ventT -= dt;
      if (this.ventT <= 0) { this.ventT = 0.35; this.game.fx?.steam?.(this._jpos('neck', _t), this.phase === 'done' ? 5 : 7, 3); }
    }
    this._placeBoulder(dt);
    this.boulder.mesh.updateMatrixWorld(true);
  }

  /** Where the boulder rides on his shoulders: above and behind them, following his lean. */
  _carryPos(out: THREE.Vector3): THREE.Vector3 {
    this._jpos('armL', _a); this._jpos('armR', _b);
    out.addVectors(_a, _b).multiplyScalar(0.5);
    return out.addScaledVector(UP, R * 0.62).addScaledVector(_a.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)), -R * 0.42);
  }

  _placeBoulder(dt: number): void {
    const b = this.boulder.mesh, ph = this.phase, u = this.phaseT;
    if (ph === 'lift' && this.liftFrom) {
      const e = sm(u / T.lift);
      b.position.lerpVectors(this.liftFrom, this._carryPos(_t), e);
      b.quaternion.multiply(_q.setFromAxisAngle(_a.set(1, 0, 0), dt * 0.3));
    } else if (ph === 'walk') {
      b.position.lerp(this._carryPos(_t), 1 - Math.exp(-12 * dt));
    } else if (ph === 'heave' && this.heaveFrom) {
      // forward off his shoulders, down into the breach
      const e = sm(u / T.heave);
      b.position.lerpVectors(this.heaveFrom, SEAT, e);
      b.position.y += Math.sin(e * Math.PI) * 3;
      b.scale.setScalar(1 + (SEAT_SCALE - 1) * e);
      b.quaternion.multiply(_q.setFromAxisAngle(_a.set(1, 0, 0), dt * 0.8));
    } else if (ph === 'fallen' && this.liftFrom) {
      // it rolls off his shoulders and comes to rest in the street
      const bv = this.boulder.vel, gy = this._ground(b.position.x, b.position.z) + R * 0.9;
      if (b.position.y > gy || bv.y > 0) {
        bv.y -= 14.5 * dt;
        b.position.addScaledVector(bv, dt);
        if (b.position.y <= gy) {
          b.position.y = gy; bv.set(0, 0, 0);
          this.game.events?.emit?.('titan:step', { position: b.position.clone(), size: 30 });
          this.game.fx?.impact?.(b.position.clone(), _a.set(0, 1, 0), 'ground');
        }
      }
    }
  }
}
