// TitanManager: owns every Titan, spawns / updates / removes them and answers blade hit tests.
// See ARCHITECTURE.md ("Titans"). Model: builder.ts + rig.ts, behaviour: titan.ts.
import * as THREE from 'hull/three';
import { Titan, TITAN_TUNING, prewarmArchetypes, resetTitanIds } from './titan';
import type { TitanHitTest } from './titan';
import { evapMaterials, bodyMaterial } from './builder';
import type { Game, SpawnRequest } from '../types';
import type { Quarry } from './env';
import { LimbDebris } from './debris';
import { R } from '../sim';

export { Titan, TITAN_TUNING };

/**
 * What spawn() takes: a SpawnRequest, everything optional (kind 'normal' at the origin by default). height defaults
 * to 60 m for the Behemoth ('behemoth'), 7 m for abnormals and 3-12 m for normal titans. (`then` is the caller's.)
 */
export type SpawnOptions = Partial<SpawnRequest>;

/** A horse as a titan's quarry: it can be run after and swiped at (it shies and bolts), never held. */
interface HorseLike { pos: THREE.Vector3; vel: THREE.Vector3; rider: unknown; hit(strength?: number): void }
const _horseQ = new WeakMap<object, Quarry>();
function horseQuarry(h: HorseLike): Quarry {
  let q = _horseQ.get(h);
  if (!q) {
    q = { alive: true, pos: h.pos, vel: h.vel, grabbedBy: null, horse: null, job: null, quarryKind: 'horse', grab: () => h.hit(1.4), freed: () => {}, eaten: () => {} };
    _horseQ.set(h, q);
  }
  return q;
}

export class TitanManager {
  readonly game: Game;
  titans: Titan[] = [];
  /** ms spent building every titan body up front */
  prewarmMs: number;
  /** s left during which no titan may grab (set when the player gets free of a hand) */
  grabBlockT = 0;
  /** s left during which no titan reaches for a comrade (one comrade in a hand at a time) */
  allyGrabT = 0;
  _grabbedPrev: unknown = null;
  /** The gate is down: titans outside the wall head for it and into the town (setMarch). */
  marching = false;
  /** Holdout: the wall draws them. Titans out in the Reach and the Greatwood amble toward the gate instead of
   *  staying where they rose, so the fight comes to the wall. */
  advance = false;
  /** Every living thing besides the player's soldier a titan may go for this frame: comrades on foot or in the
   *  air, civilians, horses (Titan._pickQuarry). */
  quarries: Quarry[] = [];
  readonly group: THREE.Group;
  /** cut-off limbs lying about, boiling away */
  readonly debris: LimbDebris;

  constructor(game: Game) {
    this.game = game;
    resetTitanIds();
    prewarmArchetypes(); this.prewarmMs = 0;
    this.debris = new LimbDebris(game);
    this.group = new THREE.Group();
    this.group.name = 'titans';
    game.scene?.add(this.group);
    this._warmShaders();
  }

  /**
   * A titan wears its own tinted copy of the body material, and a dying one switches to the evaporation shaders
   * (builder.evapMaterials). Park one degenerate (zero-area) triangle per shader under the ground so main.ts's
   * renderer.compile() builds them up front and keeps them alive between titans: the first spawn and the first
   * kill never hitch on a shader compile.
   */
  _warmShaders(): void {
    const g = new THREE.BufferGeometry();
    const z = (n: number) => new THREE.Float32BufferAttribute(new Float32Array(3 * n), n);
    g.setAttribute('position', z(3)); g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('color', z(3)); g.setAttribute('uv', z(2));
    const mats: THREE.Material[] = [];
    for (const behemoth of [false, true]) {
      const live = bodyMaterial(behemoth);
      const ev = evapMaterials({ behemoth, material: live });
      mats.push(live, ev.body); if (!behemoth) mats.push(ev.bone);
    }
    for (const m of mats) {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(0, -500, 0); mesh.castShadow = true; mesh.receiveShadow = true; mesh.raycast = () => {};
      this.group.add(mesh);
    }
  }

  /** Spawns a titan ('behemoth' = the Behemoth). */
  spawn({ kind = 'normal', height, position, yaw, crawler, breach }: SpawnOptions = {}): Titan {
    if (height === undefined) height = kind === 'behemoth' ? 60 : kind === 'abnormal' ? 7 : 3 + R.sim() * 9;
    const t = new Titan(this, { kind, height, position: position || new THREE.Vector3(), yaw, crawler });
    if (breach && kind === 'behemoth') t.breach = { t: 0, kicked: false, flash: false };
    if (this.marching && kind !== 'behemoth' && t.position.z > -14) t.march = true;
    t.fixated = this.game.mode === 'scout';   // the Sortie is scripted round the player: its titans keep to the soldier
    this.titans.push(t);
    this.group.add(t.root);
    if (kind === 'behemoth') this._behemothAppear(t);
    return t;
  }

  _behemothAppear(t: Titan): void {
    const g = this.game, p = t.position;
    g.fx?.lightning?.(p.clone(), 60);
    for (let i = 0; i < 7; i++) {
      g.fx?.steam?.(new THREE.Vector3(p.x + (R.fx() - 0.5) * 30, p.y + R.fx() * 55, p.z + (R.fx() - 0.5) * 20), 22 + R.fx() * 14, 5);
    }
    // (the event and sound ids keep the 'behemoth' name: the game flow, HUD and audio listen for them)
    g.events?.emit?.('behemoth:appear', { titan: t });
    g.audio?.behemothAppear?.();
  }

  update(dt: number): void {
    // the player just got out of a hand (cut free, or the titan let go): give them a moment before the next grab
    const pl = this.game.player as unknown as { grabbedBy?: unknown; alive?: boolean } | null;
    const held = (pl && pl.grabbedBy) || null;
    if (this._grabbedPrev && !held && pl?.alive) this.grabBlockT = Math.max(this.grabBlockT, TITAN_TUNING.GRAB_BLOCK_AFTER_ESCAPE);
    this._grabbedPrev = held;
    if (this.grabBlockT > 0) this.grabBlockT = Math.max(0, this.grabBlockT - dt);
    if (this.allyGrabT > 0) this.allyGrabT -= dt;
    this._gatherQuarries();
    const list = this.titans;
    for (let i = 0; i < list.length; i++) list[i].update(dt);
    for (let i = list.length - 1; i >= 0; i--) if (list[i].dead) list.splice(i, 1);
    this.debris.update(dt);
    this.game.escort?.update(dt);   // Seal the Breach: the shifter's giant (carrier.ts), not one of this.titans
  }

  /** The gate is breached (true): every titan outside the wall, and every one that comes after, heads into the town. */
  setMarch(on: boolean): void {
    this.marching = on;
    for (const t of this.titans) t.march = on && t.alive && !t.isBehemoth && t.position.z > -14;
  }

  _gatherQuarries(): void {
    const g = this.game, out = this.quarries;
    out.length = 0;
    for (const a of (g.allies || []) as unknown as Quarry[]) if (a.alive && !a.grabbedBy && !a.horse) out.push(a);
    for (const c of g.civilians?.list || []) if (c.alive && c.catchable && !c.grabbedBy) out.push(c);
    const pl = g.player as unknown;
    for (const h of (g.herd?.horses || []) as unknown as HorseLike[]) if (h.rider !== pl) out.push(horseQuarry(h));
  }

  clear(): void {
    for (const t of this.titans) t.dispose();
    this.titans.length = 0;
    this.debris.clear();
    this.grabBlockT = 0; this._grabbedPrev = null; this.allyGrabT = 20; this.marching = false; this.advance = false;
  }

  remove(t: Titan): void {
    const i = this.titans.indexOf(t);
    if (i >= 0) this.titans.splice(i, 1);
    t.dispose();
  }

  /** sphere vs titan parts -> [{ titan, part: 'nape'|'eye'|'ankle'|'arm'|'hand'|'body', point }] (per titan, most specific first) */
  hitTest(center: THREE.Vector3, radius: number): TitanHitTest[] {
    const out: TitanHitTest[] = [];
    for (const t of this.titans) if (t.alive) t.hitTest(center, radius, out);
    return out;
  }

  /** living titans only */
  get alive(): Titan[] { return this.titans.filter((t) => t.alive); }
}

export default TitanManager;
