// The Twelfth Sortie: the Outriders ride out past the Greatwood, as one mission in four acts. Each act is a
// checkpoint: die, and you start again from the last one.
//  0 Ride Out: at dawn the corps rides out of the gate in a column and opens into the Wide Line across the plain.
//    Wing scouts fire coloured smoke at what they see (red a titan, black an abnormal); the commander fires green for
//    a new course. You pass each one on (T). An abnormal comes for the right wing.
//  1 The Right Flank: the Huntress comes out of the trees with no smoke ahead of her. She snatches one rider out of
//    the saddle, kicks the other down, throws Tobin and stoops to lift his hood. Brandt and Matthis hood up with you
//    to slow her; Tobin's bluff stops her cold; she catches Brandt, who cuts his way out, and she runs for the centre.
//  2 The Greatwood (after a cut): only the centre column goes in. You ride with the captain's squad; she runs them
//    down the road, killing the soldiers behind, and the captain only says to ride. She runs into the commander's
//    trap; her nape turns to crystal; she screams, the titans come to eat her, the corps defends her, and she slips
//    away in the steam.
//  3 The Captain's Squad: she comes back for Kael. The squad dies one by one; Kael changes and loses; she tears him
//    out of his nape and runs; Wren and the captain catch her, and you cut Kael out of her mouth.
// Scenes are told with the director (game.cine: set shots in letterbox, or the view turning to look at something
// while you ride on) and subtitles.
import * as THREE from 'hull/three';
import { Horse } from '../player/horse';
import type { Ally } from '../player/ally';
import { spawnHuntress, type Huntress } from '../titans/female';
import type { Titan } from '../titans/titan';
import type { JointName } from '../titans/rig';
import { SHIFTER_SPEC } from '../titans/carrier';
import { roadX, FS } from '../world/terrain';
import * as keys from '../keys';
import { CAST, GIANT, MISSION, ORG, PLACE } from '../brand';
import type { Game as Flow } from '../game';
import type { Game } from '../types';
import { R, afterMs } from '../sim';

type V3 = THREE.Vector3;
const V3 = THREE.Vector3;
const clamp = THREE.MathUtils.clamp;
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const fwd = (yaw: number, out = new V3()): V3 => out.set(Math.sin(yaw), 0, Math.cos(yaw));
const rgt = (yaw: number, out = new V3()): V3 => out.set(-Math.cos(yaw), 0, Math.sin(yaw));   // the rider's right (steerToSlot)
const beyond = (a: V3, b: V3): V3 => a.clone().multiplyScalar(2).sub(b);                      // the far side of a, seen from b
const up = (s: string): string => s.toUpperCase();
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const _a = new V3(), _b = new V3(), _c = new V3();
const TRAP_Z = 590 + FS;   // the trap in the forest, on the road
const RELAY_T = 8;         // s to relay a signal before the next rider does it for you

// the cast, by role
const SHIFTER = CAST.shifter, ACE = CAST.ace, FRIEND = CAST.strategist, SHIELD = CAST.shield, RIVAL = CAST.rival;
const JOKER = CAST.joker;
/** The cadet who brings up the spare horses. (Not in brand.ts's CAST yet: see the port report.) */
const HORSES = CAST.cadet;
const COMMANDER = CAST.commanderShort, CAPTAIN = CAST.captainShort, RESEARCHER = CAST.researcher;
const SQ_A = CAST.squadA, SQ_B = CAST.squadB, SQ_C = CAST.squadC, SQ_D = CAST.squadD;
const RIDER_A = CAST.riderA, RIDER_B = CAST.riderB;
const HUNTRESS = GIANT.huntress;
// the allies take these names in the act (in order)
const CADETS = [FRIEND, SHIELD, RIVAL, JOKER, HORSES];
const SQUAD = [SQ_A, SQ_B, SQ_C, SQ_D, SHIFTER];

export const ACTS = ['Ride Out', 'The Right Flank', cap(PLACE.forest), 'The Captain\'s Squad'];
export const CHAPTERS = [
  { title: MISSION.sortie, eps: 'Four acts', desc: `${cap(MISSION.formation)}, ${HUNTRESS}, the trap in ${PLACE.forest} and the captain's squad. One mission, with checkpoints.` },
];

type Phase = 'none' | 'cut' | 'won' | 'lost'
  | 'gate' | 'ride' | 'abnormal' | 'rejoin'                                              // act 0
  | 'rider1' | 'rider2' | 'thrown' | 'look' | 'harass' | 'bluff' | 'caught' | 'gone'     // act 1
  | 'trap' | 'defend' | 'escaped'                                                        // act 2
  | 'regroup' | 'squad' | 'kills' | 'shifter' | 'chase' | 'mouth' | 'freed';             // act 3

/** The point the formation rides on: the commander (or the captain in the forest) on a path of waypoints. */
interface Lead { pos: V3; yaw: number; speed: number; want: number; path: V3[]; i: number }
/** A place in the formation: metres to the lead's right (x) and ahead (z). */
interface Slot { x: number; z: number }
/** A comrade's slot on horseback (Ally.mount): `base` is where it sits once the line has opened out. */
interface AllySlot extends Slot { lead: Lead; stay: boolean; base?: [number, number] | null }
interface Rider { name: string; h: Horse; slot: Slot; base: Slot; alive: boolean; head: () => V3 }
type SmokeColor = 'red' | 'green' | 'black' | 'yellow';
interface Signal { color: SmokeColor; t: number; dir: V3 | null }
type Say = [number, string | null, string];

export class ScoutMission {
  flow: Flow;
  g: Game;
  phase: Phase = 'none';
  done = false;
  title = '';
  /** act (chapter) */
  ch = 0;
  /** the act's clock, and the phase's */
  t = 0; pt = 0;
  /** the director's clock (runs through cuts) */
  clock = 0;
  horses: Horse[] = [];
  borrowed: { h: Horse; pos: V3; yaw: number }[] = [];
  riders: Rider[] = [];
  /** the player's place in the formation (their borrowed horse keeps it) */
  playerSlot: Slot | null = null;
  pins = new Map<Ally, V3>();
  lead: Lead | null = null;
  lines = new Set<string>();
  subQ: [string | null, string][] = [];
  subT = 0;
  cut: { t: number; n: number; done: boolean } | null = null;
  kills = 0;
  hits = 0;
  step = 0;
  stepT = 0;
  want: Signal | null = null;
  waitForYou = false;
  spreadAt = 99;
  shotEnd = 0;
  focusEnd = 0;
  _shotT = 0;
  _sigAt = 0;
  _flareAt = -9;
  ev0: { red?: boolean; green?: boolean; black?: boolean } = {};
  support: Titan | null = null;
  abnormal: Titan | null = null;
  huntress: Huntress | null = null;
  /** the shifter's giant in the last act's brawl */
  giant: Huntress | null = null;
  harpoons: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  harpoonAt: { from: V3; j: JointName }[] = [];
  blindAt = 0;
  pursuers = 0;

  constructor(flow: Flow) {
    this.flow = flow; this.g = flow.g;
    const ev = this.g.events;
    const on = (n: string, f: (e: any) => void) => ev.on(n, (e) => { if (this.g.mode === 'scout' && this.phase !== 'none') f(e); });
    on('player:hit', (e: { titan?: Titan & { isHuntress?: boolean }; result?: { effect?: string } }) => this._onPlayerHit(e));
    on('huntress:mouth', () => this._freeShifter(false));
    on('huntress:sees', () => this._sees());
    on('titan:killed', (e: { by?: unknown }) => { if (!e.by) this.kills++; });
    on('player:kicked', () => this.g.hud?.message?.('KICKED!', 1.2, 'warn'));
    on('huntress:scream', () => { this.g.player.cam.trauma = 1; });
  }

  /** The sky: dawn on the plain; full day by the time the centre column reaches the forest. */
  atmosphere(ch: number): 'dawn' | 'day' { return ch < 2 ? 'dawn' : 'day'; }

  /** Where the player starts an act (Game resets them there; the act puts them in the saddle). */
  spawn(ch: number): { position: V3; yaw: number } {
    const y = (x: number, z: number) => this.g.collision.groundHeight(x, z);
    const spots: [number, number, number][] = [[-9, 59, 0], [735, 550, 0], [roadX(505), 505, 0], [roadX(TRAP_Z + 30) + 3, TRAP_Z + 30, Math.PI]];
    const at = spots[ch] || spots[0];
    return { position: new V3(at[0], y(at[0], at[1]), at[1]), yaw: at[2] };
  }

  // ---------------------------------------------------------------- setup
  start(ch: number): void {
    this.done = false; this.lines = new Set(); this.subQ = []; this.subT = 0; this.cut = null; this.kills = 0;
    this.g.cine = { shot: null, focus: null, bars: false };
    this._enterAct(ch, true);
  }

  /** Begin act n. fresh: from a checkpoint (or the start), with nothing of the act before it left in the world. */
  _enterAct(n: number, fresh: boolean): void {
    const g = this.g;
    this.ch = n; this.flow.chapter = n; this.t = 0; this.pt = 0; this.want = null; this.hits = 0; this.step = 0; this.stepT = 0;
    if (fresh) { this._clearCast(); this.huntress = null; this.giant = null; }
    const names = n < 2 ? CADETS : SQUAD;
    (g.allies || []).forEach((a, i) => { a._baseName = a._baseName || a.name; a.name = names[i] || a._baseName; if (fresh) a.revive(); });
    [this._ride0, this._flank1, this._forest2, this._squad3][n].call(this, fresh);
    if (!fresh) g.hud?.message?.(`CHECKPOINT · ${up(ACTS[n])}`, 2, 'info');
    g.audio?.setMusic?.(n === 0 ? 0.35 : 0.55);
  }

  /** Take the act's riders, borrowed horses, harpoons and pinned comrades out of the world. */
  _clearCast(): void {
    const g = this.g, p = g.player;
    for (const h of this.horses) {
      if (h.rider === p) { p.riding = null; h.rider = null; }
      h.root.removeFromParent();
      const i = g.herd ? g.herd.horses.indexOf(h) : -1;
      if (i >= 0) g.herd?.horses.splice(i, 1);
    }
    for (const b of this.borrowed) {
      const h = b.h; h.follow = null; h.autoSlot = null;
      if (h.rider === p) { p.riding = null; } else if (h.rider && h.rider.horse === h) h.rider.dismount?.(true);
      h.rider = null; h.pos.copy(b.pos); h.home.copy(b.pos); h.yaw = b.yaw; h.speed = 0;
    }
    this.horses = []; this.borrowed = []; this.riders = []; this.pins.clear(); this.lead = null;
    if (this.harpoons) { this.harpoons.removeFromParent(); this.harpoons.geometry.dispose(); this.harpoons.material.dispose(); this.harpoons = null; }
  }

  dispose(): void {
    const g = this.g;
    this._clearCast();
    for (const a of g.allies || []) if (a._baseName) a.name = a._baseName;
    this.huntress = null; this.giant = null; this.cut = null;
    g.cine = null; g.hud?.hideSubtitle?.(); g.hud?.fade?.(false);
    this.phase = 'none';
  }

  // ---------------------------------------------------------------- the director: subtitles, shots, cuts
  _say(who: string, text: string, key = who + text): void {
    if (this.lines.has(key)) return;
    this.lines.add(key);
    const ally = (this.g.allies || []).find((a) => a.name === who);
    if (ally && !ally.alive) return;     // the dead don't speak
    this.subQ.push([who, text]);
  }
  _narrate(text: string): void { if (!this.lines.has(text)) { this.lines.add(text); this.subQ.push([null, text]); } }
  /** Lines on a clock: [[t, who, text], …], said once each as `t` passes (who null: the narrator). */
  _script(t: number, list: Say[]): void { for (const [at, who, text] of list) if (t >= at) (who ? this._say(who, text) : this._narrate(text)); }
  _subs(dt: number): void {
    if ((this.subT -= dt) > 0 || !this.subQ.length) return;
    const next = this.subQ.shift();
    if (!next) return;
    const [who, text] = next;
    this.subT = clamp(1.3 + text.length * 0.05, 2.2, 5.5) / (1 + 0.35 * this.subQ.length);
    this.g.hud?.subtitle?.(who, text, this.subT + 0.15);
  }
  /** A set shot for `dur` s (letterboxed): the camera at pos(), looking at look(). */
  _shot(dur: number, pos: (out: V3) => V3, look: (out: V3) => V3, fov = 50): void {
    if (this.g.cine) this.g.cine.shot = { pos, look, fov };
    this.shotEnd = this.clock + dur;
  }
  /**
   * A shot of center(): from the side of `from()` (or at world angle `yaw`, turning `spin` rad/s), `dist` m off and
   * `h` m up, looking at look() (default the centre). Points are functions, so the shot follows what it frames.
   */
  _shotAt(dur: number, center: () => V3, { from = null, yaw = 0, dist = 20, h = 4, spin = 0, fov = 50, look = null }:
    { from?: (() => V3) | null; yaw?: number; dist?: number; h?: number; spin?: number; fov?: number; look?: (() => V3) | null } = {}): void {
    const t0 = this.clock, dir = new V3(), cc = new V3(), col = this.g.collision;
    this._shot(dur, (out) => {
      cc.copy(center());
      if (from) { dir.subVectors(from(), cc).setY(0); if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1); dir.normalize(); }
      else { const a = yaw + spin * (this.clock - t0); dir.set(Math.sin(a), 0, Math.cos(a)); }
      out.copy(cc).addScaledVector(dir, dist); out.y += h;
      out.y = Math.max(out.y, col.groundHeight(out.x, out.z) + 1.2);
      return out;
    }, (out) => out.copy(look ? look() : center()), fov);
  }
  /** The view turns to look at at() for `dur` s while you ride on (the head turning to a titan). */
  _focus(dur: number, at: (out: V3) => V3): void { if (this.g.cine) this.g.cine.focus = at; this.focusEnd = this.clock + dur; }
  _director(): void {
    const c = this.g.cine;
    if (!c) return;
    if (c.shot && this.clock > this.shotEnd) c.shot = null;
    if (c.focus && this.clock > this.focusEnd) c.focus = null;
    c.bars = !!c.shot || !!this.cut;
  }
  /** Fade to black, the narrator's line over it, and the next act set up behind the black. */
  _cutTo(n: number, line: string | null): void {
    this.cut = { t: 0, n, done: false };
    this.g.hud?.fade?.(true);
    this.subQ.length = 0; this.subT = 0;
    if (line) this._narrate(line);
    this.phase = 'cut';
  }
  _cutStep(dt: number): void {
    const C = this.cut, g = this.g;
    if (!C) return;
    C.t += dt;
    if (!C.done && C.t > 0.9) {
      C.done = true;
      g.titans?.clear?.();
      const sp = this.spawn(C.n);
      this._clearCast();
      g.player.reset(sp.position.clone().add(new V3(0, 0.6, 0)), sp.yaw);
      g.world?.setAtmosphere?.(this.atmosphere(C.n));
      this._enterAct(C.n, true);
      g.hud?.message?.(`CHECKPOINT · ${up(ACTS[C.n])}`, 2, 'info');
      this.t = -2.2;   // (the act's clock starts when the picture comes back)
    }
    if (C.t > 3) { g.hud?.fade?.(false); this.cut = null; }
  }

  // ---------------------------------------------------------------- helpers
  _ally(name: string): Ally | undefined { return (this.g.allies || []).find((a) => a.name === name); }
  _place(a: Ally, at: V3): void { a.gear.releaseAll(true); a.land = null; a.rest = null; a.job = null; a.pos.copy(at); a.prev.copy(at); a.render.copy(at); a.vel.set(0, 0, 0); }
  _hide(a: Ally): void { a.alive = false; a.gear.releaseAll(true); if (a.model?.root) a.model.root.visible = false; this.pins.delete(a); }
  /** A comrade dies (no 'eaten' event: the story's deaths are told on the radio). */
  _killAlly(a: Ally | undefined, at: V3 | null, line: string | null): void {
    if (!a || !a.alive) return;
    if (a.horse) a.dismount(true);
    this.g.fx?.blood?.(at || a.pos, _a.set(0, 1, 0), 2.2);
    this._hide(a);
    if (line) this.g.hud?.feed?.(line, 'warn');
  }
  _ground(x: number, z: number): number { return this.g.collision.groundHeight(x, z); }

  /** The formation's lead (the commander, or the captain in the forest): a point that rides a path of waypoints. */
  _makeLead(at: V3, yaw: number, path: [number, number][], speed: number): Lead {
    return this.lead = { pos: new V3(at.x, this._ground(at.x, at.z), at.z), yaw, speed: speed * 0.5, want: speed, path: path.map(([x, z]) => new V3(x, 0, z)), i: 0 };
  }
  _moveLead(dt: number): void {
    const L = this.lead;
    if (!L) return;
    const tgt = L.path[L.i];
    let want = L.want;
    if (tgt) {
      const d = Math.hypot(tgt.x - L.pos.x, tgt.z - L.pos.z);
      if (d < 18 && L.i < L.path.length - 1) L.i++;
      const turn = wrap(Math.atan2(tgt.x - L.pos.x, tgt.z - L.pos.z) - L.yaw);
      L.yaw += clamp(turn, -0.4 * dt, 0.4 * dt);
      if (L.i === L.path.length - 1 && d < 25) want = 0;
    } else want = 0;
    // it waits for a soldier who has fallen far behind (the formation can't lose its relays)
    const p = this.g.player.pos, back = Math.hypot(p.x - L.pos.x, p.z - L.pos.z);
    if (this.waitForYou) want *= clamp(1 - (back - 140) / 260, 0.25, 1);
    L.speed += clamp(want - L.speed, -6 * dt, 4 * dt);
    L.pos.addScaledVector(fwd(L.yaw, _a), L.speed * dt);
    L.pos.y = this._ground(L.pos.x, L.pos.z);
  }
  _slotAt(L: Lead, slot: Slot, out = new V3()): V3 {
    out.copy(L.pos).addScaledVector(rgt(L.yaw, _b), slot.x).addScaledVector(fwd(L.yaw, _c), slot.z);
    out.y = this._ground(out.x, out.z);
    return out;
  }
  /** A cloaked rider of the formation on a horse that keeps its slot. */
  _rider(L: Lead, name: string, x: number, z: number, { hood = false } = {}): Rider {
    const g = this.g, slot = { x, z };
    const h = new Horse(g, this._slotAt(L, slot), L.yaw, 0.11 + this.horses.length * 0.173);
    h.speed = L.want * 0.6; h.mountCd = 1e9;
    h.follow = { lead: L, slot };
    h.addDummyRider({ hood });
    g.herd?.horses.push(h);
    this.horses.push(h);
    const r: Rider = { name, h, slot, base: { x, z }, alive: true, head: () => h.pos.clone().setY(h.pos.y + 2.3) };
    this.riders.push(r);
    return r;
  }
  _riderNamed(n: string): Rider | undefined { return this.riders.find((r) => r.name === n); }
  /** A rider is killed: the saddle empties and the horse bolts (and can be caught: it's a spare now). */
  _killRider(r: Rider | undefined, line: string | null): void {
    if (!r || !r.alive) return;
    r.alive = false; if (r.h.dummy) r.h.dummy.visible = false; r.h.follow = null; r.h.mountCd = 0; r.h.crashed = 0;
    this.g.fx?.blood?.(r.h.pos.clone().setY(r.h.pos.y + 2.2), _a.set(0, 1, 0), 2.4);
    if (line) this.g.hud?.feed?.(line, 'warn');
  }
  /** The player in the saddle at their slot (hands off the reins: the horse keeps it), the comrades in theirs. */
  _mountUp(L: Lead, playerSlot: [number, number], allySlots: [number, number][]): void {
    const g = this.g, p = g.player, herd: Horse[] = g.herd?.horses || [];
    const free = herd.filter((h) => !this.horses.includes(h) && !this.borrowed.some((b) => b.h === h));
    const take = (): Horse | undefined => { const h = free.shift(); if (h) this.borrowed.push({ h, pos: h.home.clone(), yaw: h.yaw }); return h; };
    const h = take();
    if (h) {
      const slot = { x: playerSlot[0], z: playerSlot[1] };
      h.pos.copy(this._slotAt(L, slot)); h.yaw = L.yaw; h.speed = L.want * 0.6; h.home.copy(h.pos);
      h.autoSlot = { lead: L, slot }; this.playerSlot = slot;
      h.rider = p; p.riding = h; p.yaw = L.yaw; h.saddle(p.pos); p.prev.copy(p.pos); p.render.copy(p.pos);
    }
    (g.allies || []).forEach((a, i) => {
      const s = allySlots[i];
      if (!s || !a.alive) return;
      const hh = take();
      if (!hh) return;
      const slot: AllySlot = { x: s[0], z: s[1], lead: L, stay: true };
      hh.pos.copy(this._slotAt(L, slot)); hh.yaw = L.yaw; hh.speed = L.want * 0.6; hh.home.copy(hh.pos);
      a.dismount?.(true);
      a.mount?.(hh, slot);
    });
  }
  _spawn(pos: V3, height: number, { kind = 'normal', yaw, then }: { kind?: 'normal' | 'abnormal'; yaw?: number; then?: (t: Titan | null) => void } = {}): void {
    pos.y = this._ground(pos.x, pos.z);
    this.flow._spawnQ.push({ kind, height, position: pos, yaw: yaw ?? R.sim() * Math.PI * 2, then });
  }
  /** Keep a comrade fixed in the air (a scripted moment: in her hand, at her eyes). */
  _pin(a: Ally | undefined, at: V3): void { if (a?.alive) this.pins.set(a, at.clone()); }
  _holdPins(): void {
    for (const [a, at] of this.pins) {
      if (!a.alive) { this.pins.delete(a); continue; }
      if (a.horse) a.dismount(true);
      a.gear.releaseAll(true);
      a.pos.copy(at); a.prev.copy(at); a.vel.set(0, 0, 0);
    }
  }

  // ---------------------------------------------------------------- signals
  /** A rider draws the signal gun and fires; the camera turns to watch; the player should relay it (T). */
  _signal(r: Rider | undefined, color: SmokeColor, dir: V3 | null = null, look = true): void {
    if (!r?.alive) return;
    r.h.fireFlare(color, dir);
    if (look) this._focus(3, () => r.h.pos.clone().setY(r.h.pos.y + 4 + 10 * Math.min(1, this.clock - this._sigAt)));
    this._sigAt = this.clock;
    this.want = { color, t: RELAY_T, dir: dir ? dir.clone() : null };
    this.g.hud?.message?.(keys.fill(`${up(color)} SMOKE · pass it on: {flare}`), 3, 'info');
  }
  _flareKey(): void {
    const g = this.g, p = g.player;
    if (!g.input?.actHit?.('flare') || !p.alive || (g.time - this._flareAt) < 1.2) return;
    this._flareAt = g.time;
    const w = this.want;
    p.fireFlare(w?.color || 'red', w?.dir || null);
    if (w) {
      this.want = null;
      this.flow.score += 250;
      g.hud?.message?.('SIGNAL RELAYED  +250', 1.6, 'info');
    }
  }
  _relayTimeout(dt: number): void {
    const w = this.want;
    if (!w || (w.t -= dt) > 0) return;
    this.want = null;
    const r = this.riders.find((x) => x.alive && x.name.startsWith('scout'));
    r?.h.fireFlare(w.color, w.dir);
    this.g.hud?.feed?.('You let that one sit. Someone else passed it on. Watch the sky!', 'radio', RESEARCHER);
  }

  // ---------------------------------------------------------------- the Huntress
  _spawnHuntress(at: V3, yaw: number): Huntress | null {
    if (!this.g.titans) return null;
    const f = this.huntress = spawnHuntress(this.g.titans, at, yaw);
    f.home.copy(f.position);
    return f;
  }
  _transform(at: V3, big = 1): void {
    const g = this.g, y = this._ground(at.x, at.z);
    g.fx?.lightning?.(new V3(at.x, y, at.z), 60 * big);
    g.fx?.steam?.(new V3(at.x, y + 6, at.z), 14 * big, 4);
    g.events.emit('titan:step', { position: new V3(at.x, y, at.z), size: 50 });
    g.player.cam.trauma = 1;
  }
  _onPlayerHit(e: { titan?: Titan & { isHuntress?: boolean }; result?: { effect?: string } }): void {
    if (!e.titan?.isHuntress) return;
    const fx = e.result?.effect;
    if (fx === 'hardened') { this.g.hud?.message?.('CRYSTAL! YOUR BLADES SHATTERED ON HER NAPE', 2.4, 'warn'); return; }
    if (fx && fx !== 'none') this.hits++;
    if (fx === 'limp') { this.flow.score += 400; this.g.hud?.message?.('ARM CUT: IT HANGS LIMP', 1.4, 'info'); }
    if (fx === 'cripple') { this.flow.score += 400; this.g.hud?.message?.('ANKLE CUT: SHE\'S DOWN', 1.4, 'info'); }
    if (fx === 'blind') { this.flow.score += 300; this.g.hud?.message?.('EYES CUT: SHE COVERS HER NAPE', 1.4, 'info'); }
  }
  /** Her strike at a comrade held in place (the story's deaths land: sure), with a shot of it. */
  _strikeAt(f: Huntress, kind: 'hand' | 'kick' | 'stomp' | 'bite', a: Ally | undefined, at: V3, onHit: (pt: V3) => void): boolean {
    this._pin(a, at);
    this._shotAt(2.4, () => at.clone(), { from: () => beyond(at, f.position), dist: 11, h: 1.5, look: () => f._headWorld(new V3()).lerp(at, 0.45), fov: 55 });
    return f.strike(kind, () => (a?.alive ? a.pos : at), (pt) => onHit(pt), { sure: true });
  }
  /** Her blow at a formation rider, with a cut to it. */
  _strikeRider(f: Huntress, kind: 'hand' | 'kick', r: Rider, line: string): boolean {
    if (!f.strike(kind, () => r.head(), () => this._killRider(r, line), { sure: true, run: true })) return false;
    this._shotAt(2.3, () => r.head(), { from: () => beyond(r.head(), f.position), dist: 13, h: 1, look: () => f._headWorld(new V3()).lerp(r.head(), 0.5), fov: 56 });
    return true;
  }

  // ================================================================ act 0: Ride Out
  /** The whole formation on lead L (rider slots: metres to the lead's right, ahead). */
  _formation(L: Lead, spread: number): void {
    const R: [string, number, number, boolean?][] = [
      ['commander', 0, 0], ['researcher', -6, -14], ['aide', 6, -14],                           // command
      ['scout R1', 95, 40, true], ['scout R2', 140, 5, true], ['scout R3', 120, -40, true],      // right wing
      ['scout L1', -95, 40, true], ['scout L2', -140, 5, true], ['scout L3', -120, -40, true],   // left wing
      ['wagon 1', 0, -36], ['wagon 2', 0, -52],
    ];
    for (const [n, x, z, hood] of R) this._rider(L, n, x, z, { hood: !!hood });
    this._spread(spread);
    this._mountUp(L, [45, -10], [[52, -18], [38, -22], [60, -28], [30, -16], [22, -40]]);
  }
  /** 0: a tight column out of the gate; 1: the Wide Line fully open. */
  _spread(k: number): void {
    const e = k * k * (3 - 2 * k);
    for (const r of this.riders) { r.slot.x = THREE.MathUtils.lerp(r.base.x * 0.07, r.base.x, e); r.slot.z = THREE.MathUtils.lerp(r.base.z * 0.5 - 6, r.base.z, e); }
    for (const a of this.g.allies || []) { const s = a.slot as AllySlot | null | undefined; if (s?.base) s.x = THREE.MathUtils.lerp(s.base[0] * 0.14, s.base[0], e); }
    const ph = this.playerSlot;
    if (ph && this.g.player.riding?.autoSlot?.slot === ph) ph.x = THREE.MathUtils.lerp(6, 45, e);
  }
  _ride0(fresh: boolean): void {
    const g = this.g;
    this.phase = 'gate'; this.waitForYou = true; this.spreadAt = 99;
    this.ev0 = {}; this.abnormal = null; this.support = null;   // (a replay from the gate gets its signals again)
    if (fresh) {
      // out of the gate, north up the road through the ruined village, then north-east across the plain toward
      // the open land past the forest's east edge (the trees on the right)
      const L = this._makeLead(new V3(0, 0, 70), 0, [[roadX(150), 150], [roadX(235), 235], [480, 380], [600, 470]], 11);
      this._formation(L, 0);
      for (const a of g.allies || []) { const s = a.slot as AllySlot | null | undefined; if (s) s.base = [s.x, s.z]; }
      this._spread(0);
      this._spawn(new V3(-70, 0, 55), 9, { yaw: 1.2, then: (t) => { this.support = t; } });
    }
    // opening shots: the column streams out of the gate toward the camera; then the crane over the formation
    this._shot(4.6, (o) => o.set(14, this._ground(14, 125) + 2.4, 125), (o) => o.set(0, 7, 45), 46);
    this._narrate(`The north gate of ${PLACE.innerWall}, first light. ${cap(ORG.scouts)} ride out for the twelfth time.`);
    this._shotT = 4.6;
  }
  _update0(dt: number): void {
    const L = this.lead, t = this.t;
    if (!L) return;
    if (this._shotT && t > this._shotT) {
      this._shotT = 0;
      this._shotAt(4, () => L.pos.clone().addScaledVector(fwd(L.yaw, new V3()), 20), { yaw: L.yaw + Math.PI + 0.7, dist: 75, h: 48, fov: 52 });
    }
    this._script(t, [
      [1.6, COMMANDER, 'Open the gate. The Twelfth Sortie rides!'],
      [4.8, null, `On paper they ride to mark a road to ${PLACE.homeTown}. Only a handful know the real errand: to flush out the giant hiding behind the walls.`],
      [this.spreadAt + 0.3, COMMANDER, `${cap(MISSION.formation)}! Open out!`],
      [this.spreadAt + 3, FRIEND, 'Red smoke: a titan. Black: an abnormal. Green: the commander changes course. Whatever you see, fire it on down the line.'],
    ]);
    if (t > 5 && this.support?.alive) { const s = this.support; s.killedBy = { name: 'The escort riders' }; s.applyHit({ part: 'nape', damage: 1e5, point: s.napeWorld().center }); }
    if (this.spreadAt === 99 && L.pos.z > 245) this.spreadAt = t;
    if (t > this.spreadAt && t < this.spreadAt + 9) this._spread(clamp((t - this.spreadAt) / 8, 0, 1));
    const T0 = this.spreadAt - 9.5;   // (the signals keep their places after the spread)
    this._relayTimeout(dt);
    const ev = this.ev0;
    if (t > T0 + 17 && !ev.red) {
      ev.red = true; this.phase = 'ride';
      this._signal(this._riderNamed('scout R1'), 'red');
      this._say(JOKER, 'Red on the right! One of them out there!');
      const at = L.pos.clone().addScaledVector(fwd(L.yaw, _a), 200).addScaledVector(rgt(L.yaw, _b), 80);
      this._spawn(at, 11, { yaw: L.yaw + Math.PI });
    }
    if (t > T0 + 26 && !ev.green) {
      ev.green = true;
      // the commander bears the formation left, away from it, and on north past the forest
      const dir = fwd(L.yaw + 0.4, new V3());
      L.path = [L.pos.clone().addScaledVector(dir, 120), new V3(780, 0, 560), new V3(780, 0, 1290)]; L.i = 0;
      this._signal(this._riderNamed('commander'), 'green', dir);
      this._say(RIVAL, 'Green from the centre. We\'re turning!');
    }
    if (t > T0 + 38 && !ev.black) {
      ev.black = true;
      this._signal(this._riderNamed('scout R3'), 'black');
      this._say(SHIELD, 'Black smoke! An abnormal on the right, and it\'s making straight for our riders!');
      const at = L.pos.clone().addScaledVector(rgt(L.yaw, _a), 260).addScaledVector(fwd(L.yaw, _b), 40);
      this._spawn(at, 9, { kind: 'abnormal', then: (a) => { this.abnormal = a; if (a) { a.noticeRange = 400; this._focus(3, () => a._headWorld(new V3())); } } });
      this.phase = 'abnormal'; this.pt = 0;
    }
    if (this.phase === 'abnormal') {
      this.pt += dt;
      const a = this.abnormal;
      if (a && !a.alive) {
        this.phase = 'rejoin'; this.pt = 0;
        this.flow.score += 1000;
        this._say(COMMANDER, 'Well done. Take your place in the line again.');
      } else if (a?.alive) {
        // it goes for the right wing if you leave it to them
        const r = this._riderNamed('scout R3');
        if (r?.alive && r.h.pos.distanceTo(a.position) < a.footR + a.armLen) this._killRider(r, 'The abnormal took a rider off the right wing.');
        if (this.pt > 50) this._fail('THE ABNORMAL BROKE THE RIGHT WING');
      }
    }
    if (this.phase === 'rejoin' && (this.pt += dt) > 4) this._enterAct(1, false);
  }

  // ================================================================ act 1: The Right Flank
  _flank1(fresh: boolean): void {
    this.phase = 'ride'; this.waitForYou = true;   // (the formation can't lose a relay; whistle ({whistle}) if you lose your horse)
    if (fresh) {
      const L = this._makeLead(new V3(780, 0, 560), 0, [[780, 1290]], 10);
      this._formation(L, 1);
    }
    const r = this.riders.filter((x) => x.alive && x.name.startsWith('scout R'));
    if (r[0]) r[0].name = RIDER_A;
    if (r[1]) r[1].name = RIDER_B;
    const c = this._ally(HORSES), s = c?.slot as AllySlot | null | undefined;
    if (c?.horse && s) { s.x = 0; s.z = -90; }   // she rides with the spare horses at the back
  }
  _update1(dt: number): void {
    const g = this.g, L = this.lead, t = this.t, f = this.huntress;
    if (!L) return;
    const friend = this._ally(FRIEND), shield = this._ally(SHIELD), rival = this._ally(RIVAL);
    this.pt += dt;
    this._relayTimeout(dt);
    this._script(t, [
      [1, FRIEND, 'That smoke on the right... red, but so thin. Something\'s gone wrong out there.'],
      [4, RIDER_B, 'They\'re coming out of the trees and nobody fired a warning! A whole crowd of them!'],
    ]);
    const ph = this.phase;
    if (ph === 'ride' && t > 6) {
      // she comes out of the trees on the right, running as fast as the horses
      const at = L.pos.clone().addScaledVector(rgt(L.yaw, _a), 220).addScaledVector(fwd(L.yaw, _b), 80);
      const fe = this._spawnHuntress(at, L.yaw + Math.PI * 0.8);
      if (!fe) return;
      fe.setMode('run'); fe.paceMul = 1;
      for (const k of [-1, 1]) this._spawn(at.clone().addScaledVector(fwd(L.yaw, _a), 40 * k).addScaledVector(rgt(L.yaw, _b), 25), 8 + R.sim() * 5, { yaw: L.yaw + Math.PI });
      this.phase = 'rider1'; this.pt = 0;
      this._focus(5, () => fe._headWorld(new V3()));
      g.hud?.message?.('A 14-METRE ABNORMAL', 2.4, 'warn');
      this._say(RIDER_B, `An abnormal! ${RIDER_A}, ride with me, we lead it away from the line!`);
      return;
    }
    if (!f) return;
    if (ph === 'rider1' || ph === 'rider2') {
      const r = this._riderNamed(ph === 'rider1' ? RIDER_A : RIDER_B);
      if (r?.alive) {
        f.setMode('run'); f.runTo.copy(r.h.pos);
        if (f.position.distanceTo(r.h.pos) < 13 && f.state !== 'strike') {
          if (ph === 'rider1') this._strikeRider(f, 'hand', r, `She plucked ${RIDER_A} out of the saddle and flung him away.`);
          else this._strikeRider(f, 'kick', r, `One kick, and ${RIDER_B} and his horse went down together.`);
        }
      } else if (f.state !== 'strike') {
        this.phase = ph === 'rider1' ? 'rider2' : 'thrown'; this.pt = 0;
        if (ph === 'rider2') { this._say(FRIEND, 'That\'s no ordinary abnormal. It\'s picking its targets.'); this._focus(3, () => f._headWorld(new V3())); }
      }
    }
    if (ph === 'thrown' && friend) {
      f.setMode('run'); f.runTo.copy(friend.pos);
      if (f.position.distanceTo(friend.pos) < 13 && f.state !== 'strike') {
        f.strike('hand', () => friend.pos, () => {
          if (friend.horse) { const h = friend.horse; friend.dismount(true); h.crashed = 20; }
          g.fx?.impact?.(friend.pos, _a.set(0, 1, 0), 'ground');
          const at = friend.pos.clone(); at.y = this._ground(at.x, at.z) + 0.9;
          this._pin(friend, at);
          this.phase = 'look'; this.pt = 0;
          // she stoops over him and lifts his hood with one finger, looking into his face
          f.setMode('hold'); f.faceTo = at; f.lookAt = at; f.reachTo = at.clone().add(new V3(0, 0.8, 0));
          this._shotAt(4.2, () => at.clone(), { from: () => beyond(at, f.position), dist: 4.5, h: 0.6, look: () => f._headWorld(new V3()), fov: 58 });
        }, { sure: true });
      }
    }
    if (ph === 'look') {
      this._say(FRIEND, 'She turned back my hood to see my face... She\'s hunting for one of us!');
      if (this.pt > 4.2) {
        this.phase = 'harass'; this.pt = 0; this.hits = 0;
        if (friend) this.pins.delete(friend);
        f.faceTo = null; f.lookAt = null; f.reachTo = null; f.setMode('run'); f.paceMul = 1;
        for (const [a, x] of [[shield, 48], [rival, 54]] as const) {
          const s = a?.slot as AllySlot | null | undefined;
          if (a?.horse && s) { s.x = x; s.z = -18; s.base = null; }
        }
        rival?.fireFlare('red');
        this._say(RIVAL, `${FRIEND}, up behind me, now! Hoods on, all of you. If she can't see faces, she can't pick.`);
        this._say(SHIELD, 'We can\'t let her reach the centre. We hold her up right here.');
        g.hud?.message?.('HOOD UP · SLOW HER DOWN: cut her legs and arms', 3, 'big');
      }
    }
    if (ph === 'harass') {
      f.runTo.copy(L.pos).addScaledVector(fwd(L.yaw, _b), -20);
      // gaining a little on the formation all the time (about half a minute to reach the centre rear unless cut)
      f.paceMul = clamp((L.speed * 0.92 + 0.5) / f.runSpeed, 0.2, 1.2);
      if (f.position.distanceTo(f.runTo) < 14) { this._fail('SHE REACHED THE CENTRE OF THE LINE'); return; }
      if (this.pt > 6 && this.pt < 9) this._focus(0.2, () => f._headWorld(new V3()));
      if (this.hits >= 3) {
        this.phase = 'bluff'; this.pt = 0;
        f.setMode('hold'); f.faceTo = friend?.pos || g.player.pos;
        this._shotAt(3.6, () => f._headWorld(new V3()), { from: () => (friend?.pos || g.player.pos).clone(), dist: 16, h: -3, fov: 45 });
        this._say(FRIEND, `You're too late! The one you want died back at the wall. ${SHIFTER} is gone, so turn around!`);
      }
    }
    if (ph === 'bluff' && this.pt > 3.6 && shield) {
      this.phase = 'caught'; this.pt = 0;
      const at = f._jpos('armR', new V3()).addScaledVector(fwd(f.yaw, _a), 6);
      this._strikeAt(f, 'hand', shield, at, () => this._say(SHIELD, 'She\'s got me in her fist!'));
    }
    if (ph === 'caught') {
      if (this.pt > 0.9 && this.pt < 2.6 && shield?.alive) this._pin(shield, f._jpos('handR', _a));
      if (this.pt > 2.6 && shield && this.pins.has(shield)) {
        this.pins.delete(shield);
        shield.vel.set(0, 12, 0);
        f.applyHit({ part: 'hand', damage: 200, point: f._jpos('handR', new V3()) });
        this._say(SHIELD, 'Not today. I cut my way out through her fingers!');
      }
      if (this.pt > 4) {
        this.phase = 'gone'; this.pt = 0;
        f.setMode('run'); f.paceMul = 1.5;
        this._focus(3.5, () => f._headWorld(new V3()));
        this._say(FRIEND, 'She\'s breaking away... toward the middle of the line!');
      }
    }
    if (ph === 'gone') {
      f.runTo.copy(L.pos).addScaledVector(fwd(L.yaw, _a), 400);
      if (this.pt > 3) this._say(HORSES, `${FRIEND}! I've got spare horses here! Everyone, get on!`);
      if (this.pt > 8) this._cutTo(2, `An hour later the commander steered the corps into ${PLACE.forest}. Only the centre column rode in under the trees.`);
    }
  }

  // ================================================================ act 2: The Greatwood
  _forest2(): void {
    this.phase = 'ride'; this.waitForYou = false;
    const path: [number, number][] = [];
    for (let z = 530; z <= TRAP_Z + 130; z += 25) path.push([roadX(z), z]);
    const L = this._makeLead(new V3(roadX(512), 0, 512), 0, path, 15);
    this._rider(L, 'captain', 0, 4);
    this._mountUp(L, [0, -16], [[-4, -4], [4, -4], [-4, -11], [4, -11], [0, -8]]);
    // the column rides in under the trees, toward the camera
    this._shotAt(4.5, () => L.pos.clone(), { yaw: L.yaw, dist: 55, h: 3, fov: 48, look: () => L.pos.clone().setY(L.pos.y + 6) });
  }
  _update2(dt: number): void {
    const g = this.g, L = this.lead, t = this.t, p = g.player;
    if (!L) return;
    let f = this.huntress;
    this.pt += dt;
    this._script(t, [
      [0.5, SQ_A, 'Into the trees, and just the centre column... What are we doing in here?'],
      [2.5, CAPTAIN, 'Ride.'],
    ]);
    if (this.phase === 'ride') {
      if (!f && t > 4) {
        const z0 = L.pos.z - 85;
        f = this._spawnHuntress(new V3(roadX(z0), 0, z0), 0);
        if (!f) return;
        const fe = f;
        fe.setMode('run');
        this._focus(4, () => fe._headWorld(new V3()));
        this._say(SQ_D, `On our tail! It's ${HUNTRESS}, she followed us into the forest!`);
      }
      if (!f) return;
      const fe = f;
      // she runs the road behind them, closing in; the soldiers in the trees fly at her and die
      const gap = L.pos.z - fe.position.z, target = Math.max(20, 60 - t * 1.6);
      fe.paceMul = clamp((L.speed + (gap - target) * 0.6) / fe.runSpeed, 0.3, 1.7);
      fe.runTo.set(roadX(fe.position.z + 40), 0, fe.position.z + 40);
      this._script(t, [
        [7, SQ_C, 'The rearguard in the branches... they\'re going for her neck!'],
        [12, SHIFTER, 'Captain, they\'re being slaughtered back there! Let us turn and fight!'],
        [15.5, CAPTAIN, 'Look ahead.'],
        [19, SQ_A, 'Captain, please, give us an order!'],
        [23, SHIFTER, 'Then I\'ll do it myself. I can change right now!'],
        [25.5, SQ_A, `${SHIFTER}, no! Stay with us. Have faith in him!`],
        [28, CAPTAIN, `Your call, ${SHIFTER}. Back yourself, or back this squad. I can't tell you which one turns out right. Nobody can.`],
        [33, SHIFTER, '...I\'m riding.'],
      ]);
      for (const at of [9, 15.5, 22]) if (t > at && !this.lines.has('pursuer' + at)) {
        this.lines.add('pursuer' + at);
        const pt = fe._headWorld(new V3()).add(rgt(fe.yaw, _a).multiplyScalar(at % 2 ? 4 : -4));
        fe.strike('hand', () => pt, (q) => g.fx?.blood?.(q, _a.set(0, 1, 0), 2.2), { sure: true, run: true });
        g.fx?.gas?.(pt, _b.set(0, -1, 0), 1);
        this._focus(2.6, () => fe._headWorld(new V3()));
        g.hud?.feed?.(['She swept him off the trunk and never broke stride.', 'Another one gone. She barely turned her head.', 'She batted him out of the air like a fly.'][(this.pursuers = this.pursuers + 1) % 3], 'warn');
      }
      if (t > 17 && !this.lines.has('grenade')) {
        this.lines.add('grenade');
        const cr = this._riderNamed('captain');
        cr?.h.fireFlare([new THREE.Color(0xf2efe6), new THREE.Color(0xb9b4aa)]);
        g.audio?.titanStep?.(L.pos, 30);
        p.cam.trauma = Math.min(1, p.cam.trauma + 0.4);
        g.hud?.message?.(`${up(CAPTAIN)} FIRES A SCREAMER ROUND`, 2, 'info');
      }
      if (!p.riding && fe.position.distanceTo(p.pos) < 90) this._say(CAPTAIN, 'Did I say you could leave your horse? Back in the saddle.');
      if (fe.position.distanceTo(p.pos) < 14 && fe.state !== 'strike') fe.strike('hand', () => p.pos, (q) => { if (q.distanceTo(p.pos) < 5) p.hurt(1, 'struck'); }, { run: true });
      if (fe.position.z > TRAP_Z) this._trap(fe);
      return;
    }
    if (!f) return;
    if (this.phase === 'trap') {
      this._updateHarpoons();
      this._script(this.pt, [
        [1.5, COMMANDER, 'Second volley! Loose!'],
        [4.6, CAPTAIN, `Squad, stay with the horses. That means you too, ${SHIFTER}.`],
        [6.5, SQ_A, 'So this was the plan all along... and the captain knew.'],
        [9.5, CAPTAIN, 'Her neck turned to crystal under my blades. Both of them snapped.'],
        [12, COMMANDER, 'Bring the charges. Blast her hands off the back of her neck.'],
        [18, CAPTAIN, 'You in there. I\'m going to cut you out. Arms and legs come back for your kind, don\'t they?'],
      ]);
      if (this.pt > 3 && L.want) {
        L.want = 0;
        for (const a of g.allies || []) { const s = a.slot as AllySlot | null | undefined; if (s) s.stay = false; }
      }
      if (this.pt > 9 && !this.lines.has('nape')) {
        this.lines.add('nape');
        const nw = f.napeWorld(), fe = f;
        this._shotAt(2.6, () => fe.napeWorld().center, { from: () => nw.center.clone().addScaledVector(nw.normal, 5), dist: 7, h: 1.5, fov: 50 });
        f.applyHit({ part: 'nape', damage: 300, point: nw.center });
      }
      if (this.pt > 13 && !this.lines.has('boom')) {
        this.lines.add('boom');
        for (let i = 0; i < 6; i++) { const c = f.napeWorld().center.add(new V3((R.fx() - 0.5) * 3, R.fx() * 2, (R.fx() - 0.5) * 3)); g.fx?.impact?.(c, _a.set(0, 1, 0), 'stone'); g.fx?.steam?.(c, 3, 2, null); }
        g.audio?.titanFall?.(f.position, 20);
        p.cam.trauma = Math.min(1, p.cam.trauma + 0.5);
        g.hud?.message?.('THE CHARGES DON\'T EVEN SCRATCH THE CRYSTAL', 2.4, 'warn');
      }
      if (this.pt > 22) this._scream(f);
      return;
    }
    if (this.phase === 'defend') {
      this._updateHarpoons();
      this._script(this.pt, [
        [4, COMMANDER, 'Every soldier, into the fight! Nothing gets its teeth into her!'],
        [8, CAPTAIN, 'She rang the dinner bell on herself. Tch.'],
        [20, SQ_A, 'There\'s too many of them! They\'re tearing into her!'],
      ]);
      if (f.eatenHp <= 0) { this._fail(`THE TITANS ATE ${up(HUNTRESS)} · THE CAPTURE HAS FAILED`); return; }
      if (this.pt > 42) this._escape(f);
      return;
    }
    if (this.phase === 'escaped' && this.pt > 4.5) this._enterAct(3, false);
  }
  _trap(f: Huntress): void {
    const g = this.g;
    this.phase = 'trap'; this.pt = 0;
    f.bind(true); f.speed = 0;
    // the restraining harpoons: fired from the trees round her into every limb
    const N = 18, pos = new Float32Array(N * 6);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.harpoons = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2a2624 }));
    this.harpoons.frustumCulled = false;
    const J: JointName[] = ['spine', 'armL', 'armR', 'foreL', 'foreR', 'thighL', 'thighR', 'shinL', 'shinR', 'neck', 'pelvis'];
    this.harpoonAt = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + R.sim() * 0.3, r = 28 + R.sim() * 14;
      this.harpoonAt.push({ from: new V3(f.position.x + Math.cos(a) * r, f.position.y + 12 + R.sim() * 26, f.position.z + Math.sin(a) * r), j: J[i % J.length] });
    }
    g.scene.add(this.harpoons);
    this._updateHarpoons();
    for (const h of this.harpoonAt) g.fx?.steam?.(h.from, 2, 1.5, null);
    g.audio?.titanFall?.(f.position, 25);
    g.player.cam.trauma = 1;
    g.hud?.message?.('THE TRAP · SHE IS PINNED', 3, 'big');
    // round her, slowly, the wires coming in from the trees
    this._shotAt(4.5, () => f._jpos('spine', new V3()), { yaw: f.yaw + 0.6, spin: 0.22, dist: 34, h: 6, fov: 55 });
    this.flow.score += 1500;
  }
  _updateHarpoons(): void {
    const H = this.harpoons, f = this.huntress;
    if (!H || !f) return;
    const a = H.geometry.attributes.position as THREE.BufferAttribute;
    this.harpoonAt.forEach((h, i) => { a.setXYZ(i * 2, h.from.x, h.from.y, h.from.z); const j = f._jpos(h.j, _a); a.setXYZ(i * 2 + 1, j.x, j.y, j.z); });
    a.needsUpdate = true;
  }
  _scream(f: Huntress): void {
    const g = this.g;
    this.phase = 'defend'; this.pt = 0;
    f.scream(5);
    this._shotAt(3.8, () => f._headWorld(new V3()), { yaw: f.yaw, dist: 18, h: -7, fov: 44 });
    g.hud?.message?.('SHE SCREAMED · THE TITANS ARE COMING', 3.5, 'big');
    g.audio?.setMusic?.(1);
    // from every side, out of the trees, all of them for her
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + R.sim() * 0.4, r = 75 + R.sim() * 40;
      this._spawn(new V3(f.position.x + Math.cos(a) * r, 0, f.position.z + Math.sin(a) * r), 7 + R.sim() * 7,
        { kind: i === 5 ? 'abnormal' : 'normal', then: (t) => { if (t && !t.abnormal) { t.drawnTo = f; t.noticeRange = 60; } } });
    }
  }
  _escape(f: Huntress): void {
    const g = this.g;
    this.phase = 'escaped'; this.pt = 0;
    const c = f._jpos('spine', new V3());
    for (let i = 0; i < 6; i++) g.fx?.steam?.(c.clone().add(new V3((R.fx() - 0.5) * 8, R.fx() * 10, (R.fx() - 0.5) * 8)), 16, 6);
    this._shotAt(3.5, () => c.clone(), { yaw: f.yaw + 2, dist: 45, h: 8, fov: 52 });
    for (const t of (g.titans?.titans || []) as Titan[]) if (t.drawnTo === f) t.drawnTo = null;
    f.dispose(); this.huntress = null;
    if (this.harpoons) { this.harpoons.removeFromParent(); this.harpoons.geometry.dispose(); this.harpoons.material.dispose(); this.harpoons = null; }
    g.hud?.message?.('SHE GOT AWAY IN THE STEAM', 3, 'big');
    this._say(COMMANDER, 'There\'s nothing left in that husk. She walked out under the steam in a green cloak like ours. Fire the signal to fall back.');
    (this._ally(SQ_A) || g.player).fireFlare('green');
  }

  // ================================================================ act 3: The Captain's Squad
  _squad3(fresh: boolean): void {
    const g = this.g, p = g.player;
    this.phase = 'regroup'; this.waitForYou = false;
    if (!fresh) {
      // the captain has gone for gas; the column breaks up
      for (const r of this.riders) { r.h.follow = null; if (r.name === 'captain' && r.h.dummy) r.h.dummy.visible = false; }
      for (const b of this.borrowed) b.h.autoSlot = null;
      this.lead = null;
    }
    (g.allies || []).forEach((a, i) => {
      if (!a.alive) return;
      const ang = (i / 5) * Math.PI * 2;
      _a.set(p.pos.x + Math.cos(ang) * 6, 0, p.pos.z + Math.sin(ang) * 6); _a.y = this._ground(_a.x, _a.z) + 1;
      a.dismount?.(true); this._place(a, _a);
    });
  }
  _update3(dt: number): void {
    const g = this.g, p = g.player, t = this.t, ph = this.phase;
    const f = this.huntress;
    this.pt += dt;
    if (ph === 'regroup') {
      this._script(t, [
        [1, SQ_C, 'The captain went back for gas. We make for the horses and wait for him there.'],
        [4, SQ_B, `Hah. Mighty ${HUNTRESS}, trussed up like a hog by the captain's plan. I saw it coming from the start.`],
        [6.8, SQ_A, 'A flare, up ahead in the trees... is that one of ours?'],
      ]);
      if (t > 6.2 && !this.lines.has('flare')) {
        this.lines.add('flare');
        const at = p.pos.clone().add(new V3(-30, 20, -80));
        g.fx?.flare?.(at, 'green');
        this._focus(2.6, () => at.clone().setY(at.y + 30));
      }
      if (t > 9.5 && !this.lines.has('ambush')) {
        this.lines.add('ambush');
        const gu = this._ally(SQ_D);
        if (gu?.alive) this._shotAt(2.2, () => gu.pos.clone(), { from: () => p.pos.clone(), dist: 6, h: 1.5, fov: 55 });
        this._killAlly(gu, null, `Someone in a hood dropped from the branches and opened ${SQ_D}'s throat.`);
        this._say(SQ_C, `${up(SQ_D)}!`);
        this._say(SQ_A, 'Who\'s up there?! Come out!');
      }
      if (t > 13) {
        this.phase = 'squad'; this.pt = 0;
        const at = p.pos.clone().addScaledVector(fwd(p.yaw + Math.PI, _a), 55);
        this._transform(at, 0.6);
        const fem = this._spawnHuntress(at, Math.atan2(p.pos.x - at.x, p.pos.z - at.z));
        if (!fem) return;
        fem.setMode('fight');
        // out of the lightning: low, looking up at her
        this._shotAt(3.4, () => fem._headWorld(new V3()), { from: () => p.pos.clone(), dist: 30, h: -10, fov: 50 });
        g.hud?.message?.(up(HUNTRESS), 3, 'big');
        this._say(SQ_C, `${SHIFTER}, keep riding! The four of us have her. Trust us!`);
        g.audio?.setMusic?.(0.9);
      }
      return;
    }
    if (!f) { if (ph === 'freed' && this.pt > 3.5) this._complete(`${up(SHIFTER)} IS BACK WITH US`); return; }
    if (ph === 'squad') {
      const c = this._ally(SQ_C), a = this._ally(SQ_A), b = this._ally(SQ_B);
      if (this.pt > 3.5 && !this.lines.has('blind')) {
        this.lines.add('blind');
        const hw = f._headWorld(new V3()).addScaledVector(fwd(f.yaw, _a), 3);
        if (c) this._place(c, hw.clone().addScaledVector(rgt(f.yaw, _b), 2));
        if (a) this._place(a, hw.clone().addScaledVector(rgt(f.yaw, _b), -2));
        f.applyHit({ part: 'eye', damage: 100, point: hw });
        this._shotAt(2.4, () => f._headWorld(new V3()), { yaw: f.yaw + 0.5, dist: 14, h: 1, fov: 50 });
        this._say(SQ_C, 'Both eyes cut! She\'s blind!');
        this._say(SQ_B, 'Now the shoulders! Cut them so she can\'t cover her neck!');
        this.blindAt = this.pt;
      }
      // the squad cuts too: an arm every few seconds if you don't
      if (this.blindAt && this.pt - this.blindAt > 5 && f.limp[0] <= 0) f.applyHit({ part: 'arm', damage: 100, point: f._jpos('armL', new V3()) });
      if (this.blindAt && this.pt - this.blindAt > 8 && f.limp[1] <= 0) f.applyHit({ part: 'arm', damage: 100, point: f._jpos('armR', new V3()) });
      if (this.blindAt && this.pt - this.blindAt > 9.5 && !this.lines.has('crystal')) {
        this.lines.add('crystal');
        if (b) this._place(b, f.napeWorld().center.addScaledVector(f.napeWorld().normal, 3));
        f.applyHit({ part: 'nape', damage: 300, point: f.napeWorld().center });
        this._say(SQ_B, 'What the... my blades! Her neck\'s gone hard as glass!');
      }
      return;
    }
    if (ph === 'kills') {
      const order: [string, 'bite' | 'stomp' | 'kick', string, (fe: Huntress) => V3][] = [
        [SQ_C, 'bite', `One eye had already healed. She caught ${SQ_C} in her teeth in mid-air.`, (fe) => fe._headWorld(new V3()).addScaledVector(fwd(fe.yaw, _a), 5)],
        [SQ_A, 'stomp', `She drove ${SQ_A} into the roots of a tree with her heel.`, (fe) => fe.position.clone().addScaledVector(fwd(fe.yaw, _a), 6).setY(fe.position.y + 1.5)],
        [SQ_B, 'kick', `${SQ_B}'s steel broke on the crystal. Her kick threw him against a trunk.`, (fe) => fe.position.clone().addScaledVector(rgt(fe.yaw, _a), 5).setY(fe.position.y + 5)],
      ];
      const k = order[this.step];
      if (k && this.pt > 1.4 + this.step * 2.8 && f.state !== 'strike') {
        const [name, kind, line, where] = k, a = this._ally(name);
        this.step++;
        if (a?.alive) this._strikeAt(f, kind, a, where(f), (pt) => this._killAlly(a, pt, line));
      }
      if (this.step >= 3 && this.pt > 11) this._shifterChanges(f);
      return;
    }
    if (ph === 'shifter') {
      const e = this.giant;
      if (!e) return;
      this._script(this.pt, [[1, SHIFTER, 'You\'re dead! I\'ll tear you apart!'], [4, SHIFTER, 'I should never have run. I should have fought you at the start!']]);
      if (f.state !== 'strike' && e.state !== 'strike' && this.pt > 3 && (this.stepT -= dt) <= 0) {
        this.stepT = 1.7;
        const n = this.step++;
        if (n < 7) {
          const [att, def] = n % 2 === 0 ? [e, f] : [f, e];
          att.strike(n % 4 === 1 ? 'kick' : 'punch', () => def._headWorld(_c), (q) => { def.flinch = 1; g.fx?.impact?.(q, _a.set(0, 1, 0), 'flesh'); g.audio?.titanStep?.(q, 40); g.events.emit('titan:step', { position: q, size: 40 }); }, { sure: true });
          if (n === 3) this._focus(3, () => e._headWorld(new V3()).lerp(f._headWorld(new V3()), 0.5));
        } else if (n === 7) {
          // she drops into a fighter's stance he knows from the training yard; then the crystal fist
          this._shotAt(2.6, () => f._jpos('spine', new V3()), { from: () => e.position.clone(), dist: 22, h: 2, fov: 46 });
          this._say(SHIFTER, `...I know that stance. I sparred against it. ${CAST.huntressHuman}?!`);
          f.strike('punch', () => e._headWorld(_c), (q) => { g.fx?.impact?.(q, _a.set(0, 1, 0), 'stone'); g.fx?.steam?.(q, 8, 3); e.stunT = 3; g.player.cam.trauma = 1; }, { sure: true, W: 0.6 });
        } else if (n === 8) {
          this._shotAt(3, () => e.napeWorld().center, { yaw: f.yaw + 1.6, dist: 20, h: 2, fov: 50 });
          f.strike('bite', () => e.napeWorld().center, (q) => {
            g.fx?.blood?.(q, _a.set(0, 1, 0), 3); g.fx?.steam?.(q, 12, 5);
            for (let i = 0; i < 4; i++) g.fx?.steam?.(e._jpos('spine', new V3()).add(new V3(0, i * 3, 0)), 10, 6);
            e.dispose(); this.giant = null;
            f.brawl(null); f.setMode('run'); f.paceMul = 0.72; f.carrying = true; f.runTo.set(roadX(1230), 0, 1230);
            this.phase = 'chase'; this.pt = 0;
            const m = this._ally(SQ_D);
            if (m) { m.name = ACE; m.revive(); this._place(m, p.pos.clone().add(new V3(3, 2, 0))); }
            g.hud?.message?.(`SHE TORE ${up(SHIFTER)} OUT OF HIS NAPE`, 3, 'big');
          }, { sure: true });
        }
      }
      return;
    }
    if (ph === 'chase') {
      this._script(this.pt, [
        [1.5, ACE, `She's carrying ${SHIFTER} off in her mouth! I'm going after her!`],
        [5, CAPTAIN, `${ACE}. Keep your head. We get him back; we don't settle scores.`],
      ]);
      if (this.pt > 8 && f.position.distanceTo(p.pos) < 50) this._captain(f);
      else if (f.position.z > 1235 || f.position.distanceTo(p.pos) > 280) this._fail(`SHE GOT AWAY WITH ${up(SHIFTER)}`);
      return;
    }
    if (ph === 'mouth') {
      this._script(this.pt, [[3, CAPTAIN, 'She can\'t move. Go on, cut him out of her jaw.']]);
      if (this.pt > 45) this._fail(`SHE RECOVERED AND GOT AWAY WITH ${up(SHIFTER)}`);
      return;
    }
    if (ph === 'freed' && this.pt > 3.5) this._complete(`${up(SHIFTER)} IS BACK WITH US`);
  }
  /** Her one eye has healed: she stands up and kills the squad. */
  _sees(): void {
    if (this.ch !== 3 || this.phase !== 'squad') return;
    this.phase = 'kills'; this.pt = 0; this.step = 0;
    this._say(SQ_A, 'Wait... she\'s looking at us. One eye\'s already grown back—');
  }
  _shifterChanges(f: Huntress): void {
    const g = this.g, er = this._ally(SHIFTER);
    this.phase = 'shifter'; this.pt = 0; this.step = 0; this.stepT = 0;
    if (!g.titans) return;
    const from = er?.alive ? er.pos.clone() : g.player.pos.clone();
    const at = f.position.clone().addScaledVector(_a.subVectors(from, f.position).setY(0).normalize(), 22);
    if (er) { this._hide(er); er.name = SHIFTER + '​'; }   // (his giant speaks for him now)
    this._transform(at, 1);
    const e = this.giant = spawnHuntress(g.titans, at, Math.atan2(f.position.x - at.x, f.position.z - at.z), { spec: SHIFTER_SPEC, height: 15 });
    e.brawl(f); f.brawl(e); f.setMode('brawl');
    // the two of them, side on
    this._shotAt(3.2, () => e.position.clone().lerp(f.position, 0.5).setY(e.position.y + 8), { yaw: Math.atan2(f.position.x - at.x, f.position.z - at.z) + Math.PI / 2, dist: 48, h: 2, fov: 52 });
    g.hud?.message?.(`${up(SHIFTER)} CHANGES`, 2.5, 'big');
  }
  /** The captain catches up with her: eyes, both arms and an ankle in one pass, and she's down. */
  _captain(f: Huntress): void {
    const g = this.g;
    this.phase = 'mouth'; this.pt = 0;
    const cut = (pt: V3, sz: number) => { g.fx?.slashArc?.(pt, f.root.quaternion, sz); g.fx?.blood?.(pt, _a.set(0, 1, 0), 1.6); };
    // he spirals down her body faster than anyone else can fly: eyes, both arms, the ankle
    cut(f._headWorld(new V3()), 3); f.applyHit({ part: 'eye', damage: 100, point: f._headWorld(new V3()) });
    for (const j of ['armL', 'armR'] as const) { const q = f._jpos(j, new V3()); cut(q, 3); f.applyHit({ part: 'arm', damage: 100, point: q }); }
    const ft = f._jpos('footL', new V3()); cut(ft, 2); f.applyHit({ part: 'ankle', damage: 100, point: ft });
    f.crippleT = 60; f.blindT = 60; f.limp = [60, 60]; f.mouthOpenable = true; f.setMode('hold');
    this._shotAt(3.5, () => f._jpos('spine', new V3()), { yaw: f.yaw + 0.8, spin: 0.5, dist: 26, h: 4, fov: 52 });
    g.hud?.message?.(up(CAST.captain), 3, 'big');
    this._say(CAPTAIN, `Pull back, ${ACE}. You're too angry to fly straight.`);
    this._say(ACE, 'Captain, your leg... you hurt it covering me.');
    g.hud?.message?.(`CUT ${up(SHIFTER)} OUT OF HER MOUTH: strike her jaw`, 3.5, 'info');
  }
  _freeShifter(byCaptain: boolean): void {
    const g = this.g, f = this.huntress;
    if (this.ch !== 3 || this.phase !== 'mouth' || !f) return;
    this.phase = 'freed'; this.pt = 0;
    f.mouthOpenable = false; f.carrying = false;
    const m = f._mouthWorld(new V3());
    g.fx?.blood?.(m, _a.set(0, 1, 0), 3); g.fx?.steam?.(m, 6, 3);
    this._shotAt(3.5, () => f._headWorld(new V3()), { yaw: f.yaw + 0.4, dist: 15, h: 0.5, fov: 48 });
    if (!byCaptain) this.flow.score += 3000;
    this._say(CAPTAIN, byCaptain ? 'Tch. Fine, I\'ll do it.' : 'Got him. Slimy, but breathing.');
    this._say(CAPTAIN, 'We\'re leaving. Now.');
    g.hud?.message?.(`${up(SHIFTER)} IS FREE`, 3, 'big');
    f.mode = 'hold';   // she slumps against the tree, weeping, and lets them go
  }

  // ---------------------------------------------------------------- flow
  /** The act is lost: the result screen offers the act's checkpoint again. */
  _fail(cause: string): void {
    if (this.done) return;
    this.done = true; this.phase = 'lost'; this.title = cause;
    const g = this.g, flow = this.flow, ch = this.ch, run = flow.run;
    g.hud?.message?.(cause, 3.5, 'big');
    g.audio?.setMusic?.(0.1);
    afterMs(() => {
      if (flow.run !== run) return;
      g.input.unlock?.();
      g.hud?.showDeath?.({ cause, kills: g.player.stats.kills, score: flow.score, time: Math.round(g.time - (flow.startTime || 0)), retryLabel: 'FROM THE CHECKPOINT' },
        () => flow.start('scout', { chapter: ch }), () => flow.toMenu());
    }, 3000);
  }
  _complete(title: string): void {
    if (this.done) return;
    this.done = true; this.phase = 'won'; this.title = title;
    this.flow.score += 5000;
    this.flow.chapter = 0;   // PLAY AGAIN starts from the gate
    this.g.audio?.setMusic?.(0.25);
    this.g.hud?.message?.(title, 3.2, 'big');
    this.flow.chapterDone('scout', { title, delay: 3500 });
  }

  update(dt: number): void {
    if (this.phase === 'none') return;
    this.clock += dt;
    this._subs(dt);
    this._director();
    this._moveLead(dt);
    if (this.phase === 'won' || this.phase === 'lost') return;
    if (this.cut) { this._cutStep(dt); if (this.cut) return; }
    this.t += dt;
    this._flareKey();
    [this._update0, this._update1, this._update2, this._update3][this.ch].call(this, dt);
    this._holdPins();
  }

  // ---------------------------------------------------------------- HUD
  objective(): string {
    const f = this.huntress, p = this.g.player, ph = this.phase;
    if (ph === 'won' || ph === 'lost') return this.title;
    if (ph === 'cut') return '';
    const relay = this.want ? keys.fill(` · PASS ON ${up(this.want.color)}: {flare}`) : '';
    const dist = (o: { position: V3 } | null) => (o ? `${Math.round(o.position.distanceTo(p.pos))} m` : '');
    const act = `${up(ACTS[this.ch])} · `;
    switch (this.ch) {
      case 0:
        if (ph === 'gate') return `${up(MISSION.sortie)} · ride with the formation (let go of the reins and your horse keeps its place)`;
        if (ph === 'abnormal') return `${act}BLACK SMOKE · kill the abnormal before it breaks the right wing ${this.abnormal?.alive ? dist(this.abnormal) + ' · ' + Math.max(0, Math.ceil(50 - this.pt)) + ' s' : ''}${relay}`;
        if (ph === 'rejoin') return `${act}back to your place in the formation`;
        return `${act}${up(MISSION.formation)} · watch the sky for smoke${relay}`;
      case 1:
        if (ph === 'ride') return `${act}the right wing · something is coming out of the trees${relay}`;
        if (ph === 'harass') return `${act}SLOW HER DOWN · cut her legs and arms (${this.hits}/3) · ${f ? Math.round(f.position.distanceTo(f.runTo)) : 0} m from the centre`;
        if (ph === 'gone') return `${act}SHE IS RUNNING FOR THE CENTRE`;
        return `${act}${up(HUNTRESS)} · ${dist(f)} · stay alive`;
      case 2:
        if (ph === 'ride') return `${act}RIDE · stay on your horse, ${CAPTAIN}'s order: do not fight · she's ${f && this.lead ? Math.max(0, Math.round(this.lead.pos.z - f.position.z)) + ' m behind' : 'coming'}`;
        if (ph === 'trap') return `${act}SHE IS PINNED · try her nape yourself`;
        if (ph === 'defend') return `${act}DEFEND ${up(HUNTRESS)} · kill the titans eating her · ${Math.max(0, Math.round((f?.eatenHp || 0) / 1.6))}% of her left · hold ${Math.max(0, Math.ceil(42 - this.pt))} s`;
        return `${act}SHE ESCAPED`;
      default:
        if (ph === 'regroup') return `${act}head for the horses`;
        if (ph === 'squad') return f && f.blindT > 0 ? `${act}SHE IS BLIND · cut her arms so she can't guard (${f.limp.filter((x) => x > 0).length}/2)` : `${act}FIGHT BESIDE THE SQUAD`;
        if (ph === 'kills') return `${act}SHE CAN SEE AGAIN`;
        if (ph === 'shifter') return `${act}${up(SHIFTER)} FIGHTS HER · cut her ankles and arms to help him`;
        if (ph === 'chase') return `${act}CATCH HER · she has ${SHIFTER} in her mouth · ${dist(f)}`;
        if (ph === 'mouth') return `${act}CUT ${up(SHIFTER)} OUT OF HER MOUTH · strike her jaw · ${Math.max(0, Math.ceil(45 - this.pt))} s before she recovers`;
        return `${up(SHIFTER)} IS SAFE`;
    }
  }
}
