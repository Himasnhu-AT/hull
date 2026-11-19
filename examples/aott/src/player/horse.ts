// The corps' horses: grazing near the gate, across the field and at the forest edge. Run onto one to mount
// it: you ride seated; hold Shift to stand up on its back, let go to leap off with its speed; Z / X stand and
// fire a rope straight off the running horse. A riderless horse grazes, ambles, and bolts from titans.
import * as THREE from 'hull/three';
import { mergeGeometries } from 'hull/three';
import { FS } from '../world/terrain';
import type { Game } from '../types';
import { grainMaterial, setSurface, SURF, type Surface } from './materials';
import type { FlareColor, SmokeColors } from '../fx/effects';
import { R } from '../sim';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _c = new THREE.Color();
const COATS = [0x5e3d26, 0x3a281c, 0x7a4f2c, 0x2a2320, 0x957c5e, 0x50351f];
const SPEED = { walk: 1.8, trot: 5, gallop: 19 };
const TAU = Math.PI * 2;

type V3 = [number, number, number];
interface PieceOpts { p?: V3; r?: V3; s?: V3 }
// one vertex-coloured piece with its surface, positioned/rotated/scaled, ready to merge
function piece(geo: THREE.BufferGeometry, color: number, { p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1] }: PieceOpts = {}, surf: Surface = SURF.coat): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.deleteAttribute('uv');
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)), new THREE.Vector3(...s)));
  _c.setHex(color);
  const n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return setSurface(g, surf);
}
let _mat: THREE.MeshStandardMaterial | null = null;
function mesh(parts: THREE.BufferGeometry[], parent: THREE.Object3D): THREE.Mesh {
  const m = new THREE.Mesh(mergeGeometries(parts), _mat || (_mat = grainMaterial()));
  m.castShadow = true;
  parent.add(m);
  return m;
}
/** The titans a horse shies from (TitanManager.titans, read through this one boundary). */
interface TitanNear { alive: boolean; position: THREE.Vector3 }
const titansOf = (game: Game): readonly TitanNear[] => (game.titans as unknown as { titans?: TitanNear[] } | null)?.titans ?? [];
const L = SURF.leather, HAIR = SURF.hair, CLOTH = SURF.cloth, EYE: Surface = { roughness: 0.15, metalness: 0, grain: 0 };

/**
 * Rein a horse into its slot in a moving column. lead: { pos, yaw, speed } (a horse, the player, a formation);
 * slot: { x: metres to the lead's right, z: metres ahead of it }. It aims a little ahead of the slot so the column
 * flows, and matches the lead's speed, galloping harder to catch up and easing off when ahead.
 */
/** A column's leader: a horse, the player, a mission's formation. */
export interface SlotLead { pos: THREE.Vector3; yaw: number; speed?: number; vel?: THREE.Vector3 }
/** A place in a column: metres to the lead's right (x) and ahead (z). */
export interface Slot { x: number; z: number; [k: string]: unknown }
/** Anything reined into a slot (a Horse). */
export interface Reinable { pos: THREE.Vector3; yaw: number; want: { f: number; turn: number }; speedMul: number }
export function steerToSlot(h: Reinable, leadIn: SlotLead | unknown, slotIn: Slot | unknown): number {
  // (player.ts holds its auto-ride slot as unknown: this is the one boundary where it becomes a lead and a slot)
  const lead = leadIn as SlotLead, slot = slotIn as Slot;
  const ly = lead.yaw, fx = Math.sin(ly), fz = Math.cos(ly), rx = -fz, rz = fx;
  const sx = lead.pos.x + rx * slot.x + fx * slot.z, sz = lead.pos.z + rz * slot.x + fz * slot.z;
  const tx = sx + fx * 10 - h.pos.x, tz = sz + fz * 10 - h.pos.z;
  let d = Math.atan2(tx, tz) - h.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
  h.want.turn = THREE.MathUtils.clamp(-d * 2.5, -1, 1);
  const behind = (sx - h.pos.x) * fx + (sz - h.pos.z) * fz;
  const leadSpeed = lead.speed ?? lead.vel?.length() ?? 0;
  const want = Math.max(0, leadSpeed + THREE.MathUtils.clamp(behind * 0.7, -8, 9));
  h.want.f = want > 0.8 ? 1 : -1;   // (-1: rein in; a stopped column stops, it doesn't trot on)
  h.speedMul = THREE.MathUtils.clamp(want / SPEED.gallop, 0.05, 1.35);
  return behind;
}

const sm01 = (x: number): number => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

/** A dummy rider: one merged mesh, plus the right arm (raises the signal gun) and the muzzle to fire from. */
export interface SoldierParts { arm: THREE.Group; gun: THREE.Group; muzzle: THREE.Group }
/**
 * A plain cloaked Outrider (one merged mesh plus a right arm that can raise a signal gun), seated as on a horse.
 * Missions use it for formation riders and for the soldiers they fly through a scene. hood: hood up.
 * userData: { arm, gun, muzzle } (SoldierParts).
 */
export function soldierMesh({ hood = false, hair = 0x2a1c12 }: { hood?: boolean; hair?: number } = {}): THREE.Group {
  const cloak = 0x2b4433, skin = 0xd2a283, trousers = 0xd6cfbe, boots = 0x34251a, jacket = 0x86684a;
  const r = new THREE.Group();
  mesh([
    piece(new THREE.CylinderGeometry(0.19, 0.22, 0.62, 8), jacket, { p: [0, 0.38, 0], r: [-0.12, 0, 0] }, CLOTH),                      // torso
    piece(new THREE.SphereGeometry(0.13, 10, 8), skin, { p: [0, 0.83, 0.03] }, SURF.skin),                                                     // head
    hood ? piece(new THREE.SphereGeometry(0.16, 10, 8), cloak, { p: [0, 0.86, -0.01], s: [1, 1.05, 1.08] }, CLOTH)
      : piece(new THREE.SphereGeometry(0.135, 10, 8), hair, { p: [0, 0.88, -0.01], s: [1.02, 0.8, 1.05] }, HAIR),
    piece(new THREE.ConeGeometry(0.42, 0.95, 9, 1, true), cloak, { p: [0, 0.32, -0.12], r: [-0.42, 0, 0] }, CLOTH),                     // cloak
    piece(new THREE.CylinderGeometry(0.075, 0.07, 0.5, 6), trousers, { p: [0.2, 0.0, 0.1], r: [-1.1, 0, -0.35] }, CLOTH),                 // thighs
    piece(new THREE.CylinderGeometry(0.075, 0.07, 0.5, 6), trousers, { p: [-0.2, 0.0, 0.1], r: [-1.1, 0, 0.35] }, CLOTH),
    piece(new THREE.CylinderGeometry(0.065, 0.06, 0.5, 6), boots, { p: [0.33, -0.3, 0.2], r: [0.2, 0, -0.12] }, L),                   // boots
    piece(new THREE.CylinderGeometry(0.065, 0.06, 0.5, 6), boots, { p: [-0.33, -0.3, 0.2], r: [0.2, 0, 0.12] }, L),
    piece(new THREE.CylinderGeometry(0.05, 0.045, 0.5, 6), jacket, { p: [0.17, 0.42, 0.22], r: [-1.2, 0, 0.2] }, CLOTH),                 // left arm on the reins
    piece(new THREE.BoxGeometry(0.34, 0.16, 0.2), 0x6d727a, { p: [0, 0.12, -0.18] }, SURF.steel),                                             // gear box
  ], r);
  // the right arm, from the shoulder: on the reins (rotation.x -1.2) or raised with the gun (-2.95)
  const arm = new THREE.Group(); arm.position.set(-0.19, 0.64, 0.02); arm.rotation.x = -1.2; r.add(arm);
  mesh([piece(new THREE.CylinderGeometry(0.05, 0.045, 0.5, 6), jacket, { p: [0, -0.25, 0] }, CLOTH), piece(new THREE.SphereGeometry(0.05, 6, 5), skin, { p: [0, -0.52, 0] }, SURF.skin)], arm);
  const gun = new THREE.Group(); gun.position.set(0, -0.52, 0); gun.visible = false; arm.add(gun);
  mesh([
    piece(new THREE.CylinderGeometry(0.045, 0.05, 0.32, 8), 0x3a3d42, { p: [0, -0.18, 0.02] }, SURF.darkSteel),                                    // the wide barrel
    piece(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 8), 0xb08a3e, { p: [0, -0.33, 0.02] }, SURF.brass),                                   // brass muzzle ring
    piece(new THREE.BoxGeometry(0.05, 0.14, 0.07), 0x4a2e1a, { p: [0, -0.02, 0.06], r: [0.5, 0, 0] }, L),                            // grip
  ], gun);
  const muzzle = new THREE.Group(); muzzle.position.set(0, -0.38, 0.02); gun.add(muzzle);
  r.userData = { arm, gun, muzzle };
  return r;
}

/** One leg for the hoof solver: hip and knee joints, segment lengths / rest angles, and its planted hoof. */
interface HorseLeg {
  hip: THREE.Group; knee: THREE.Group; front: number; side: number; rest: THREE.Vector3;
  L1: number; r1: number; L2: number; r2: number;
  plant: THREE.Vector3; from: THREE.Vector3; to: THREE.Vector3; cur: THREE.Vector3;
  swing: boolean; u: number; u0: number; init: boolean;
}
/** Whoever rides or calls a horse: the player, a comrade. */
export interface HorseRider { pos: THREE.Vector3; [k: string]: any }
/** A signal round fired by a dummy rider. */
export interface HorseFlare { t: number; color: FlareColor | string | SmokeColors; dir: THREE.Vector3 | null; fired: boolean }

export class Horse {
  game: Game;
  pos: THREE.Vector3; home: THREE.Vector3; vel: THREE.Vector3;
  yaw: number; speed: number;
  /** gait phase (cycles) and the body's rise and fall */
  phase: number; bob: number;
  /** the trunk's pitch along the slope, and its bank into a turn */
  pitch: number | undefined = undefined; lean = 0;
  rider: HorseRider | null; want: { f: number; turn: number };
  state: 'graze' | 'walk' | 'flee'; t: number; mountCd: number; crashed: number;
  /** a column to keep a slot in (a mission's riderless formation horse), or one the player rides in hands-off */
  follow: { lead: SlotLead; slot: Slot } | null = null;
  autoSlot: { lead: SlotLead; slot: Slot } | null = null;
  handsOff = false;
  speedMul = 1;
  /** whistled for: who to run to and how long to keep trying */
  caller: HorseRider | null = null; callT = 0;
  gallop = 0; _cadence = 0; turnS = 0; turnRate = 0;
  /** a rider landing on its back: the give (1 → 0) and how hard */
  jolt = 0; joltAmp = 1;
  /** how far the trunk sank to keep the planted hooves in reach */
  legDrop = 0;
  _tt = 0;
  root: THREE.Group; trunk: THREE.Group; neck: THREE.Group; head: THREE.Group; tail: THREE.Group;
  mane: THREE.Group[]; tailSegs: THREE.Group[]; legs: HorseLeg[];
  /** the dummy rider (addDummyRider) and its signal round */
  dummy: THREE.Group | null = null;
  flareA: HorseFlare | null = null;

  constructor(game: Game, pos: THREE.Vector3, yaw: number, seed: number) {
    this.game = game;
    this.pos = pos.clone(); this.home = pos.clone();
    this.vel = new THREE.Vector3();
    this.yaw = yaw; this.speed = 0; this.phase = seed * 7; this.bob = 0;
    this.rider = null; this.want = { f: 0, turn: 0 };
    this.state = 'graze'; this.t = seed * 3; this.mountCd = 0; this.crashed = 0;
    const coat = COATS[Math.floor(seed * 97) % COATS.length];
    const dark = 0x1c1511, leather = 0x4a2e1a, hoof = 0x1a1612, sock = Math.floor(seed * 13) % 3 === 0 ? 0xe8e0d0 : coat;
    const g = this.root = new THREE.Group();

    // body: barrel, deep chest, rounded rump (higher), withers, saddle and pad
    this.trunk = new THREE.Group(); this.trunk.position.y = 1.32; g.add(this.trunk);
    mesh([
      piece(new THREE.CapsuleGeometry(0.4, 1.05, 6, 14), coat, { r: [Math.PI / 2, 0, 0], s: [0.92, 1.12, 1] }),
      piece(new THREE.SphereGeometry(0.46, 14, 10), coat, { p: [0, 0.05, 0.62], s: [0.9, 1.08, 0.95] }),        // chest
      piece(new THREE.SphereGeometry(0.47, 14, 10), coat, { p: [0, 0.1, -0.68], s: [0.95, 1.0, 1.0] }),          // rump
      piece(new THREE.SphereGeometry(0.22, 10, 8), coat, { p: [0, 0.42, 0.55], s: [0.8, 0.8, 1.4] }),           // withers
      piece(new THREE.BoxGeometry(0.66, 0.06, 0.78), 0x2e4a2e, { p: [0, 0.47, -0.02] }, CLOTH),                          // green saddle pad
      piece(new THREE.CylinderGeometry(0.3, 0.32, 0.62, 12, 1, false, 0, Math.PI), leather, { p: [0, 0.48, -0.04], r: [Math.PI / 2, 0, Math.PI / 2], s: [1, 1, 0.45] }, L),
      piece(new THREE.BoxGeometry(0.08, 0.2, 0.12), leather, { p: [0, 0.6, 0.24] }, L),                              // pommel
      piece(new THREE.BoxGeometry(0.06, 0.62, 0.06), leather, { p: [0.36, 0.12, 0], r: [0, 0, 0.05] }, L),          // girth L
      piece(new THREE.BoxGeometry(0.06, 0.62, 0.06), leather, { p: [-0.36, 0.12, 0], r: [0, 0, -0.05] }, L),        // girth R
    ], this.trunk);

    // neck (arched, thick at the base) + head with a long muzzle, ears, mane, forelock, bridle
    this.neck = new THREE.Group(); this.neck.position.set(0, 0.3, 0.78); this.neck.rotation.x = 0.72; this.trunk.add(this.neck);
    mesh([
      piece(new THREE.CylinderGeometry(0.17, 0.33, 0.95, 12), coat, { p: [0, 0.42, 0], s: [0.8, 1, 1.15] }),
    ], this.neck);
    // mane: tufts along the crest that stream and bounce with the gait
    this.mane = [];
    for (let i = 0; i < 6; i++) {
      const tuft = new THREE.Group(); tuft.position.set(0, 0.08 + i * 0.15, -0.2 + i * 0.012); this.neck.add(tuft);
      mesh([piece(new THREE.ConeGeometry(0.06, 0.26, 5), dark, { p: [0, 0, -0.12], r: [-1.35, 0, 0], s: [0.55, 1, 1] }, HAIR)], tuft);
      this.mane.push(tuft);
    }
    this.head = new THREE.Group(); this.head.position.set(0, 0.88, 0.02); this.neck.add(this.head);
    mesh([
      // the face runs forward-down from the poll (head frame is tilted 0.72 rad with the neck)
      piece(new THREE.CylinderGeometry(0.15, 0.095, 0.62, 10), coat, { p: [0, -0.02, 0.29], r: [1.64, 0, 0], s: [1, 1, 1.15] }),  // face
      piece(new THREE.SphereGeometry(0.16, 10, 8), coat, { p: [0, 0, 0.02], s: [0.95, 1, 1.1] }),                   // jowl
      piece(new THREE.SphereGeometry(0.105, 8, 6), coat, { p: [0, -0.06, 0.6], s: [1, 0.85, 1.15] }),               // muzzle
      piece(new THREE.ConeGeometry(0.045, 0.17, 5), coat, { p: [0.07, 0.16, -0.06], r: [-0.72, 0, -0.2] }),          // ears
      piece(new THREE.ConeGeometry(0.045, 0.17, 5), coat, { p: [-0.07, 0.16, -0.06], r: [-0.72, 0, 0.2] }),
      piece(new THREE.BoxGeometry(0.05, 0.1, 0.12), dark, { p: [0, 0.12, 0.06] }, HAIR),                                  // forelock
      piece(new THREE.SphereGeometry(0.03, 6, 4), 0x0c0a08, { p: [0.12, 0.02, 0.12] }, EYE),                             // eyes
      piece(new THREE.SphereGeometry(0.03, 6, 4), 0x0c0a08, { p: [-0.12, 0.02, 0.12] }, EYE),
      piece(new THREE.TorusGeometry(0.115, 0.012, 4, 12), leather, { p: [0, -0.05, 0.47] }, L),                         // noseband
    ], this.head);

    // tail: a dock and a chain of hair segments that hang, stream back with speed and swish, each lagging the last
    this.tail = new THREE.Group(); this.tail.position.set(0, 0.3, -1.08); this.trunk.add(this.tail);
    mesh([piece(new THREE.CylinderGeometry(0.075, 0.05, 0.26, 7), coat, { p: [0, -0.1, -0.03], r: [0.35, 0, 0] })], this.tail);
    this.tailSegs = [];
    let parent: THREE.Group = this.tail, y = -0.22;
    for (let i = 0; i < 4; i++) {
      const seg = new THREE.Group(); seg.position.set(0, y, i ? 0 : -0.06); parent.add(seg);
      const r0 = 0.1 - i * 0.012, r1 = 0.11 - (i + 1) * 0.02, len = 0.24;
      mesh([piece(new THREE.CylinderGeometry(r0, Math.max(0.025, r1), len, 7), dark, { p: [0, -len / 2, 0], s: [1, 1, 0.75] }, HAIR)], seg);
      this.tailSegs.push(seg); parent = seg; y = -len * 0.92;
    }

    // legs: forearm/gaskin + cannon, knee/hock, fetlock and hoof; hind legs carry the backward hock angle. They hang
    // from the trunk, so they rise, fall and pitch with the body; each hoof is planted by _legs()
    this.legs = [];
    for (const [x, z, front] of [[-0.24, 0.62, 1], [0.24, 0.62, 1], [-0.25, -0.72, 0], [0.25, -0.72, 0]] as const) {
      const hip = new THREE.Group(); hip.position.set(x, (front ? 1.1 : 1.26) - 1.32, z); this.trunk.add(hip);
      mesh([
        piece(new THREE.CylinderGeometry(front ? 0.1 : 0.15, 0.075, front ? 0.55 : 0.62, 8), coat, { p: [0, front ? -0.27 : -0.3, front ? 0 : 0.06], r: [front ? 0 : -0.25, 0, 0] }),
      ], hip);
      const knee = new THREE.Group(); knee.position.set(0, front ? -0.55 : -0.6, front ? 0 : 0.14); hip.add(knee);
      mesh([
        piece(new THREE.CylinderGeometry(0.055, 0.05, 0.5, 7), sock, { p: [0, -0.25, 0], r: [front ? 0 : 0.18, 0, 0] }),
        piece(new THREE.SphereGeometry(0.065, 7, 5), sock, { p: [0, -0.5, front ? 0 : -0.09] }),                    // fetlock
        piece(new THREE.CylinderGeometry(0.06, 0.08, 0.1, 8), hoof, { p: [0, -0.58, front ? 0.02 : -0.07] }, SURF.hoof),
      ], knee);
      // segment lengths and rest angles (from straight down, + = backward) for the solver; the hoof's sole is the
      // planted point: hip → knee, knee → sole
      const k0 = knee.position, sole = new THREE.Vector3(0, -0.63, front ? 0.02 : -0.07);
      this.legs.push({ hip, knee, front, side: x < 0 ? 0 : 1, rest: new THREE.Vector3(x, 0, z),
        L1: Math.hypot(k0.y, k0.z), r1: Math.atan2(-k0.z, -k0.y), L2: Math.hypot(sole.y, sole.z), r2: Math.atan2(-sole.z, -sole.y),
        plant: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), cur: new THREE.Vector3(),
        swing: false, u: 0, u0: 0, init: false });
    }
    game.scene.add(g);
  }

  /** The rider's collision-centre position: seated in the saddle (stand = 0) or standing on it (stand = 1). */
  saddle(out: THREE.Vector3, stand = 0): THREE.Vector3 {
    return out.set(0, 1.5 + this.bob - this._dip() - this.legDrop + stand * 0.86, -0.08)
      .applyAxisAngle(_w.set(1, 0, 0), -(this.pitch || 0))      // and with the slope it's on
      .applyAxisAngle(_w.set(0, 0, 1), this.lean || 0)          // the saddle tilts with the horse's bank
      .applyAxisAngle(_w.set(0, 1, 0), this.yaw).add(this.pos);
  }
  /** How far the back sinks under a rider dropping onto it: a quick give, then it springs back. */
  _dip(): number { const j = this.jolt; return j > 0 ? Math.sin(j * Math.PI) * 0.16 * this.joltAmp : 0; }
  /** A rider landed on it: the back gives, it stumbles a step and loses a little speed. */
  hit(strength = 1): void { this.jolt = 1; this.joltAmp = Math.min(1.4, 0.5 + strength); this.speed *= 1 - 0.15 * Math.min(1, strength); }
  /**
   * A plain cloaked Outrider in the saddle (missions fill a formation with these: no gear, no AI).
   * hood: the cloak's hood up. Returns the group; hide it when the rider falls. fireFlare() makes them draw the
   * signal gun, raise it and fire.
   */
  addDummyRider({ hood = false, hair = 0x2a1c12 }: { hood?: boolean; hair?: number } = {}): THREE.Group {
    const r = soldierMesh({ hood, hair });
    r.position.set(0, 0.5, -0.06); this.trunk.add(r);
    this.dummy = r;
    return r;
  }
  /** The dummy rider fires a signal round: colour a key of fx FLARE (or [start, end] colours); dir tilts it. */
  fireFlare(color: FlareColor | string | SmokeColors, dir: THREE.Vector3 | null = null): void { this.flareA = { t: 0, color, dir: dir ? dir.clone() : null, fired: false }; }
  /** Draw, raise and fire (runs even while the horse is out of sight, so a far wing's smoke still goes up). */
  _flareTick(dt: number, seen: boolean): void {
    const A = this.flareA, d = this.dummy, parts = d?.userData as SoldierParts | undefined;
    if (!A) return;
    A.t += dt;
    const up = sm01(A.t / 0.45) * (1 - sm01((A.t - 1.6) / 0.5));
    if (parts?.arm) { parts.arm.rotation.x = -1.2 - 1.75 * up; parts.gun.visible = up > 0.25; }
    if (!A.fired && A.t > 0.55) {
      A.fired = true;
      const m = parts?.muzzle;
      if (seen && m && d?.visible) { m.updateWorldMatrix(true, false); _v.setFromMatrixPosition(m.matrixWorld); } else _v.copy(this.pos).setY(this.pos.y + 3);
      if (d?.visible !== false) {
        this.game.fx?.flare?.(_v, A.color, A.dir);
        this.game.fx?.sparks?.(_v, _w.set(0, 1, 0), 8);
        this.game.audio?.hookFire?.(1);
      }
    }
    if (A.t > 2.2) this.flareA = null;
  }

  /** Whistled for: gallop to the caller and stop beside them. */
  call(who: HorseRider): void { this.caller = who; this.callT = 25; this.state = 'walk'; }

  /** The horse's up vector (banked), for the rider. */
  up(out: THREE.Vector3): THREE.Vector3 { return out.set(0, 1, 0).applyAxisAngle(_w.set(1, 0, 0), -(this.pitch || 0)).applyAxisAngle(_w.set(0, 0, 1), this.lean).applyAxisAngle(_w.set(0, 1, 0), this.yaw); }

  fixedUpdate(dt: number): void {
    const col = this.game.collision;
    this.t += dt; this.mountCd -= dt;
    if (this.jolt > 0) this.jolt = Math.max(0, this.jolt - dt * 3.2);
    let target = 0, turn = 0;
    // a riderless horse kept in a column (a mission's formation riders): it reins itself into its slot
    if (!this.rider && this.follow) steerToSlot(this, this.follow.lead, this.follow.slot);
    if (this.rider || this.follow) {
      target = this.want.f > 0 ? SPEED.gallop * (this.speedMul || 1) : this.want.f < 0 ? 0 : Math.max(this.speed - 3 * dt, Math.min(this.speed, SPEED.trot));
      turn = this.want.turn;
    } else if (this.caller && (this.callT -= dt) > 0) {
      // answering a whistle: run to the caller's side (aiming a few metres off them so it pulls up alongside)
      const c = this.caller.pos, dx = c.x - this.pos.x, dz = c.z - this.pos.z, d = Math.sqrt(dx * dx + dz * dz);
      const dir = Math.atan2(dx, dz);
      turn = THREE.MathUtils.clamp(-Math.sin(dir - this.yaw) * 3, -1, 1);
      target = d > 40 ? SPEED.gallop : d > 7 ? Math.max(3, Math.min(SPEED.gallop, (d - 5) * 0.9)) : 0;
      if (Math.cos(dir - this.yaw) < 0.3 && d < 12) target = Math.min(target, 2);   // swing round rather than overshoot
      if (d < 6.5) { this.caller = null; this.state = 'graze'; this.t = 0; }
    } else {
      this.caller = null;
      let threat: { position: THREE.Vector3 } | null = null, td = 45;
      for (const t of titansOf(this.game)) {
        if (!t.alive) continue;
        const d = t.position.distanceTo(this.pos); if (d < td) { td = d; threat = t; }
      }
      if (threat) {
        const away = Math.atan2(this.pos.x - threat.position.x, this.pos.z - threat.position.z);
        turn = -Math.sign(Math.sin(away - this.yaw)); target = SPEED.gallop * 0.8; this.state = 'flee';
      } else {
        if (this.state === 'flee' || this.speed > 3) target = 0;
        if (this.t > 6) { this.t = 0; this.state = R.sim() < 0.45 ? 'walk' : 'graze'; }
        if (this.state === 'walk') {
          target = SPEED.walk;
          const home = Math.atan2(this.home.x - this.pos.x, this.home.z - this.pos.z);
          if (this.pos.distanceTo(this.home) > 25) turn = -Math.sign(Math.sin(home - this.yaw)) * 0.6;
        }
      }
    }
    const accel = target > this.speed ? 6 : 9;
    this.speed += THREE.MathUtils.clamp(target - this.speed, -accel * dt, accel * dt);
    // ease into and out of turns (reins, not a switch); → turns right, the same convention as the player's heading
    this.turnS += (turn - this.turnS) * Math.min(1, dt * 5);
    this.turnRate = -this.turnS * (1.9 - this.speed * 0.035);
    this.yaw += this.turnRate * dt;
    // bank into the turn like a real horse at speed (centripetal lean), eased
    const leanT = THREE.MathUtils.clamp(-this.turnRate * this.speed * 0.011, -0.2, 0.2);
    this.lean += (leanT - this.lean) * Math.min(1, dt * 4);
    this.vel.set(Math.sin(this.yaw) * this.speed, 0, Math.cos(this.yaw) * this.speed);
    this.pos.addScaledVector(this.vel, dt);
    _v.copy(this.pos); _v.y = col.groundHeight(this.pos.x, this.pos.z) + 1.2;
    for (const c of col.collideSphere(_v, 1.0, { dynamic: false })) {
      if (c.collider.type === 'ground' || c.depth <= 0) continue;
      this.pos.x += c.normal.x * c.depth; this.pos.z += c.normal.z * c.depth;
      const head = -(c.normal.x * Math.sin(this.yaw) + c.normal.z * Math.cos(this.yaw));
      if (this.rider && !this.handsOff && head > 0.7 && this.speed > 12) this.crashed = this.speed;   // (a formation horse finds its own way round)
      if (this.speed > 6) this.speed *= head > 0.7 ? 0.3 : 0.9;
    }
    this.pos.y = col.groundHeight(this.pos.x, this.pos.z);
    // the body lies along the slope: the ground under the forehand vs under the hindquarters
    {
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const gF = col.groundHeight(this.pos.x + fx * 0.67, this.pos.z + fz * 0.67), gH = col.groundHeight(this.pos.x - fx * 0.72, this.pos.z - fz * 0.72);
      const pt = Math.atan2(gF - gH, 1.39);
      this.pitch = (this.pitch ?? pt) + (pt - (this.pitch ?? pt)) * Math.min(1, dt * 10);
      this.pos.y = Math.min(this.pos.y, (gF + gH) * 0.5 + 0.02);
    }
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -1050, 1050);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -620, 1020 + FS);
    if (this.pos.z > -7 && this.pos.z < 7 && Math.abs(this.pos.x) > 7) this.pos.z = this.pos.z < 0 ? -7 : 7;   // the wall
    // gait phase and the body's rise and fall (the rider moves with it)
    const s = this.speed;
    this.gallop = THREE.MathUtils.smoothstep(s, 6, 12);
    this._cadence = s < 0.2 ? 0 : s < 6 ? 0.55 + s * 0.22 : 1.9 + s * 0.035;    // strides per second
    this.phase += dt * this._cadence;
    const P = this.phase * TAU;
    this.bob = this.gallop * 0.11 * Math.sin(P * 1) + (1 - this.gallop) * Math.min(1, s / 4) * 0.035 * Math.sin(P * 2);
  }

  update(dt: number): void {
    const g = this.root, s = this.speed, ga = this.gallop;
    g.position.copy(this.pos);
    g.rotation.y = this.yaw;
    const P = this.phase * TAU;
    // gallop: a transverse four-beat (hind L, hind R, fore L, fore R) with a gathered suspension phase;
    // walk/trot: diagonal pairs
    const dip = this._dip();
    this.trunk.position.y = 1.32 + this.bob - dip - this.legDrop;
    // rocking (forehand up, then hindquarters up) on top of the slope it stands on
    this.trunk.rotation.x = ga * 0.07 * Math.sin(P + 1.2) + dip * 0.35 - (this.pitch || 0);
    g.rotation.z = this.lean;   // banked into the turn
    horseLegs.call(this, dt);
    const graze = this.state === 'graze' && s < 0.4 && !this.rider;
    const nodT = graze ? 1.85 : 0.72 + ga * (0.18 + 0.12 * Math.sin(P + 2.2)) + (1 - ga) * 0.04 * Math.sin(P * 2);
    this.neck.rotation.x += (nodT - this.neck.rotation.x) * Math.min(1, dt * (graze ? 1.5 : 8));
    this.head.rotation.x = (graze ? -0.3 : 0.05 - ga * 0.12) - this._dip() * 2.4;   // tosses its head when you land on it
    this.tail.rotation.x = 0.25 + ga * 0.6 + Math.sin(this.phase * 3.1) * 0.08;
    this.tail.rotation.z = Math.sin(this.phase * 1.7) * 0.12 * (0.4 + ga);
    // the hair: lifted by the run, a swish travelling down it (an idle flick at the flies when standing)
    const tt = (this._tt += dt);
    const flick = s < 0.5 ? Math.max(0, Math.sin(tt * 0.9)) ** 8 : 0;
    this.tailSegs.forEach((seg, i) => {
      seg.rotation.x = Math.min(1, s / 12) * 0.22 + Math.sin(P * 2 - i * 0.9) * (0.05 + 0.1 * ga);
      seg.rotation.z = Math.sin(tt * 2.1 - i * 0.7) * (0.06 + 0.08 * ga) + flick * Math.sin(tt * 9 - i) * 0.35;
    });
    // mane streams back with speed and ripples down the crest
    const stream = Math.min(1, s / 15);
    this.mane.forEach((m, i) => {
      m.rotation.x = -0.35 * stream + Math.sin(P * 2 - i * 0.7) * (0.08 + 0.18 * ga);
      m.rotation.z = Math.sin(this.phase * 2.3 + i) * 0.1 * stream;
    });
  }
}

// gait footfall timing per leg [fore L, fore R, hind L, hind R]: walk / trot in diagonal pairs, the gallop a
// transverse four-beat (hind L, hind R, fore L, fore R) with a gathered suspension
const OFFS_W = [0.5, 0.0, 0.0, 0.5], OFFS_G = [0.42, 0.52, 0.0, 0.1];
const _lp = new THREE.Vector3(), _lq = new THREE.Vector3(), _lm = new THREE.Matrix4();
const sstep = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Planted hooves. The gait clock (this.phase, a cycle per stride) gives each leg its stance; a hoof in stance stays
 * pinned to its spot on the ground (zero world velocity), a swinging hoof folds up and arcs to its next foothold,
 * placed under its hip where the body will be at touchdown. Each leg is then a two-bone solve in the trunk frame
 * (fore knees fold back, hind hocks forward). The trunk sinks a little if a planted hoof would be out of reach.
 */
function horseLegs(this: Horse, dt: number): void {
  const s = this.speed, ga = this.gallop, col = this.game.collision;
  const stride = s / Math.max(0.05, this._cadence || 1);
  // ground covered by a planted hoof: a long stance walking, a short one at the gallop
  const duty = s < 0.2 ? 1 : THREE.MathUtils.clamp(Math.min(THREE.MathUtils.lerp(0.65, 0.42, sstep(1.8, 5, s)), 1.15 / Math.max(stride, 0.1)), 0.14, 0.7);
  const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
  const moving = s > 0.2;
  this.root.updateMatrixWorld(true);
  const ground = (v: THREE.Vector3): THREE.Vector3 => { v.y = col.groundHeight(v.x, v.z); return v; };
  // where a leg's hoof should come down: under its hip, a share of the stance ahead, where the body will be
  const foothold = (l: HorseLeg, tAhead: number, out: THREE.Vector3): THREE.Vector3 => {
    const ahead = moving ? duty * stride * 0.45 : 0;
    out.set(l.rest.x, 0, l.rest.z + ahead).applyAxisAngle(_lq.set(0, 1, 0), this.yaw).add(this.pos);
    out.x += fx * s * tAhead; out.z += fz * s * tAhead;
    return ground(out);
  };
  const cyc = 1 / Math.max(0.05, this._cadence || 1);
  const lift = THREE.MathUtils.lerp(0.12, 0.3, sstep(2, 10, s));
  let need = 0.03;
  for (let i = 0; i < 4; i++) {
    const l = this.legs[i];
    if (!l.init) { foothold(l, 0, l.plant); l.cur.copy(l.plant); l.init = true; }
    const off = THREE.MathUtils.lerp(OFFS_W[i], OFFS_G[i], ga);
    const psi = (((this.phase + off - 0.25) % 1) + 1) % 1;
    if (moving) {
      const inStance = psi < duty, u = (psi - duty) / (1 - duty);
      if (l.swing && inStance && l.u > 0.5) { l.swing = false; l.plant.copy(l.to); }
      else if (!l.swing && !inStance) { l.swing = true; l.from.copy(l.cur); l.u0 = u; }
      if (l.swing) {
        l.u = THREE.MathUtils.clamp((u - l.u0) / Math.max(1e-3, 1 - l.u0), 0, 1);
        foothold(l, (1 - u) * (1 - duty) * cyc, l.to);
      }
    } else if (l.swing) {
      // pulled up mid-stride: finish the step
      l.u = Math.min(1, l.u + dt / 0.25); foothold(l, 0, l.to);
      if (l.u >= 1) { l.swing = false; l.plant.copy(l.to); }
    } else if (foothold(l, 0, _lp).distanceTo(l.plant) > 0.35) { l.swing = true; l.from.copy(l.cur); l.u = 0; l.u0 = 0; }
    if (l.swing) {
      const e = sstep(0, 1, l.u);
      l.cur.lerpVectors(l.from, l.to, e);
      l.cur.y += lift * Math.sin(Math.PI * Math.pow(l.u, 0.8)) * (l.front ? 1 : 0.85);
    } else l.cur.copy(l.plant);
  }
  // solve each leg in the trunk frame (hip: flexion x, abduction z; knee: x), and see how far the trunk must sink to
  // keep the planted hooves in reach. The abduction keeps a hoof planted while the body turns over it.
  _lm.copy(this.trunk.matrixWorld).invert();
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 4; i++) {
      const l = this.legs[i];
      const tl = _lp.copy(l.cur).applyMatrix4(_lm).sub(l.hip.position);
      const Lmax = (l.L1 + l.L2) * 0.995;
      if (pass === 0) { if (!l.swing) need = Math.max(need, Math.hypot(tl.y, tl.z) - Lmax); continue; }
      const d = _lq.copy(tl);
      for (let it = 0; it < 3; it++) {
        const yz = Math.hypot(d.y, d.z) || 1e-4;
        const hz = Math.atan2(d.x, yz);
        const D = THREE.MathUtils.clamp(Math.hypot(d.x, d.y, d.z), Math.abs(l.L1 - l.L2) + 0.1, Lmax);
        const dn = d.x * Math.sin(hz) - d.y * Math.cos(hz);
        const line = Math.atan2(-d.z, dn);
        const beta = Math.acos(THREE.MathUtils.clamp((l.L1 * l.L1 + D * D - l.L2 * l.L2) / (2 * l.L1 * D), -1, 1));
        const gamma = Math.acos(THREE.MathUtils.clamp((l.L1 * l.L1 + l.L2 * l.L2 - D * D) / (2 * l.L1 * l.L2), -1, 1));
        const bend = l.front ? 1 : -1;                   // fore: knee folds back (upper ahead of the line); hind: hock forward
        const up = line - bend * beta, low = up + bend * (Math.PI - gamma);
        const hx = up - l.r1, kx = low - up - l.r2 + l.r1;
        l.hip.rotation.set(hx, 0, hz); l.knee.rotation.set(kx, 0, 0);
        if (it === 2) break;
        // where that actually puts the sole (hip = Rx·Rz, then the knee's Rx), and aim off by the miss
        const sz = Math.sin(hz), cz = Math.cos(hz), sk = Math.sin(kx + l.r2), ck = Math.cos(kx + l.r2), s1 = Math.sin(l.r1), c1 = Math.cos(l.r1);
        const lx = (l.L1 * c1 + l.L2 * ck) * sz, ly = -(l.L1 * c1 + l.L2 * ck) * cz, lz = -(l.L1 * s1 + l.L2 * sk);
        const sx = Math.sin(hx), cx = Math.cos(hx);
        d.x += tl.x - lx; d.y += tl.y - (ly * cx - lz * sx); d.z += tl.z - (ly * sx + lz * cx);
      }
    }
    if (pass === 0) {
      need = Math.min(0.35, need);
      this.legDrop = need > this.legDrop ? need : this.legDrop + (need - this.legDrop) * Math.min(1, dt * 6);
      this.trunk.position.y = 1.32 + this.bob - this._dip() - this.legDrop;
      this.trunk.updateMatrixWorld(true);
      _lm.copy(this.trunk.matrixWorld).invert();
    }
  }
}

/** A few horses near the gate (the Expedition's mounts) and scattered over the field and the forest edge. */
export class Herd {
  game: Game;
  horses: Horse[];
  constructor(game: Game) {
    this.game = game;
    const spots = [[-14, 22], [14, 26], [0, 34], [-60, 70], [70, 95], [-120, 140], [130, 150], [20, 175]];
    this.horses = spots.map(([x, z], i) => new Horse(game, new THREE.Vector3(x, game.collision.groundHeight(x, z), z), (i * 2.4) % TAU, (i + 1) * 0.137));
  }
  fixedUpdate(dt: number): void { for (const h of this.horses) h.fixedUpdate(dt); }
  update(dt: number): void {
    const cam = this.game.camera.position;
    for (const h of this.horses) {
      const vis = h.pos.distanceToSquared(cam) < 450 * 450;
      h.root.visible = vis;
      if (vis) h.update(dt);
      if (h.flareA) h._flareTick(dt, vis);
    }
  }
}
