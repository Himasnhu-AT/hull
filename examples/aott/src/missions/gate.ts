// Seal the Breach: the last act of the Battle of Varn. The Wallguard's commander sends the main force and the cadets to
// the far corner of the district as bait while an elite squad (Oswin, Wren, Greta, Falk) guards Kael at the boulder.
// He changes, loses himself (swings at Wren, hits his own face) and slumps against it: Greta fires a red flare.
// Oswin holds the squad there until Tobin climbs to the nape and brings him round; the giant lifts the boulder and
// carries it, bent double, to the breach, a titan walking in through it at the end. He drives it home, Greta fires the
// yellow flare, and while the squad cuts him out of the nape two titans close in, until the Outriders' captain arrives.
// Game (src/game.ts) owns one of these per 'gate' run.
import * as THREE from 'hull/three';
import { Carrier, Boulder, BOULDER_R } from '../titans/carrier';
import type { Titan } from '../titans/titan';
import { CAST, GIANT, MISSION, ORG, PLACE } from '../brand';
import type { Game as Flow } from '../game';
import type { Ally } from '../player/ally';
import type { Game } from '../types';
import type { BoxCollider } from '../core/collision';
import { R, afterMs } from '../sim';

const V3 = THREE.Vector3;
const SHIFTER_AT = new V3(0, 0, -137);       // he changes on the boulder's gate side, facing the squad on the roofs
const BOULDER_AT = new V3(0, 0, -150);       // where the boulder lies, in Varn's main street (the gate is at z = 0)
const GOAL_Z = -19;                          // he heaves it in from here
const DECOY = new V3(-300, 0, -40);          // the far corner: the main force are bait on the wall above it
// the elite squad, in the order the allies take the names (the ace is the one he swings at)
const LEADER = CAST.squadLeaderShort, ACE = CAST.ace, FLARES = CAST.flareOfficer, ELITE = CAST.wallguardElite;
const SQUAD = [LEADER, ACE, FLARES, ELITE];
const SHIFTER = CAST.shifter, FRIEND = CAST.strategist, GENERAL = CAST.general, CAPTAIN = CAST.captain;
const WAKE_T = 40;                           // s he lies slumped before his friend reaches the nape and wakes him
const RESCUE_T = 22;                         // s they need to cut him out of the nape before the captain arrives
const MAX_HUNTING = 7;                       // titans after him (not counting the ones at the decoy)
const col = (c: number): THREE.Color => new THREE.Color(c);
const SMOKE = [col(0x3d3936), col(0x8d8782)], CANNON = [col(0xd8d4cc), col(0xa9a49c)];
const FIRES: [number, number][] = [[-48, -96], [64, -58], [-122, -172], [128, -232], [-34, -262], [96, -128]];
const up = (s: string): string => s.toUpperCase();

export type GatePhase = 'none' | 'brief' | 'transform' | 'defend' | 'carry' | 'rescue' | 'captain' | 'won' | 'lost';
type Kind = 'normal' | 'abnormal';

export class GateMission {
  flow: Flow;
  g: Game;
  phase: GatePhase = 'none';
  t = 0;
  done = false;
  /** the yellow flare is up */
  yellow = false;
  /** the ace has been thrown off by his swing */
  flung = false;
  /** the titan that walks in through the breach has come */
  gateTitan = false;
  boulder: Boulder | null = null;
  /** the collider that plugs the tunnel once he has sealed it */
  seal: BoxCollider | null = null;
  /** s to the next wave of titans after him */
  dirT = 6;
  waves = 0;
  cannonT = 2;
  fireT = 0;
  /** lines already said (each is said once) */
  lines = new Set<string>();
  /** s until his friend wakes him */
  wakeT = WAKE_T;
  rescueT = RESCUE_T;
  captainAt = 0;
  /** the squad member in front of him when he changes */
  ace: Ally | undefined;

  constructor(flow: Flow) {
    this.flow = flow; this.g = flow.g;
  }

  /** The shifter's giant (the game's escort) while it is up. */
  get esc(): Carrier | null { return (this.g.escort as Carrier | null | undefined) ?? null; }

  // ---------------------------------------------------------------- setup
  /** Where the player starts: on a roof beside the boulder with the elite squad, looking at it. */
  spawn(): { position: THREE.Vector3; yaw: number } {
    const g = this.g;
    for (const [x, z] of [[17, -130], [-17, -130], [18, -144], [-18, -144], [20, -120]]) {
      const hit = g.collision.raycast(new V3(x, 80, z), new V3(0, -1, 0), 90, { dynamic: false });
      if (hit && hit.collider.type !== 'ground' && hit.point.y > 6) {
        return { position: hit.point.clone().add(new V3(0, 0.3, 0)), yaw: Math.atan2(SHIFTER_AT.x - x, SHIFTER_AT.z - z) };
      }
    }
    return { position: new V3(0, 50.6, 0), yaw: Math.PI };
  }

  start(): void {
    const g = this.g, p = g.player;
    this.phase = 'brief'; this.t = 0; this.done = false; this.yellow = false; this.flung = false; this.gateTitan = false;
    this.boulder = new Boulder(g, new V3(BOULDER_AT.x, g.collision.groundHeight(BOULDER_AT.x, BOULDER_AT.z) + BOULDER_R * 0.88, BOULDER_AT.z));
    this.dirT = 6; this.waves = 0; this.cannonT = 2; this.fireT = 0; this.lines = new Set();
    // the elite squad lands on the roofs round you
    const allies = g.allies || [];
    allies.forEach((a, i) => {
      a._baseName = a._baseName || a.name;
      a.name = SQUAD[i] || a._baseName;
      const ang = (i / Math.max(1, allies.length)) * Math.PI * 2;
      const at = this._roofNear(p.pos.x + Math.cos(ang) * 9, p.pos.z + Math.sin(ang) * 9) || p.pos.clone().add(new V3(Math.cos(ang) * 3, 0, Math.sin(ang) * 3));
      a.gear.releaseAll(true); a.land = null; a.rest = null; a.job = null;
      a.pos.copy(at); a.prev.copy(at); a.render.copy(at); a.vel.set(0, 0, 0);
    });
    // the bait: the main force and the cadets on the wall at the far corner have most of the town's titans round them
    for (let i = 0; i < 5; i++) this._spawn(this._around(DECOY, 45), 6 + R.sim() * 8, { lured: true, home: DECOY });
    g.hud?.message?.(up(MISSION.gateBattle), 3.2, 'big');
    g.audio?.setMusic?.(0.4);
  }

  dispose(): void {
    const g = this.g;
    this.esc?.dispose();
    g.escort = null;
    this.boulder?.dispose();
    this.boulder = null;
    if (this.seal) g.collision.remove(this.seal);
    this.seal = null;
    g.gateSealed = false;
    for (const a of g.allies || []) if (a._baseName) a.name = a._baseName;
    this.phase = 'none';
  }

  // ---------------------------------------------------------------- helpers
  _roofNear(x: number, z: number): THREE.Vector3 | null {
    const hit = this.g.collision.raycast(new V3(x, 80, z), new V3(0, -1, 0), 90, { dynamic: false });
    return hit && hit.collider.type !== 'ground' && hit.point.y > 6 ? hit.point.add(new V3(0, 1, 0)) : null;
  }
  _around(c: THREE.Vector3, r: number): THREE.Vector3 { const a = R.sim() * Math.PI * 2, d = Math.sqrt(R.sim()) * r; return new V3(c.x + Math.cos(a) * d, 0, c.z + Math.sin(a) * d); }
  /** A line on the radio, said once (by `key`); a fallen squad member says nothing. */
  _say(who: string, text: string, key = text): void {
    if (this.lines.has(key)) return;
    this.lines.add(key);
    const ally = (this.g.allies || []).find((a) => a.name === who);
    if (ally && !ally.alive) return;     // the dead don't call it
    this.g.hud?.feed?.(text, 'radio', who);
  }
  _spawn(pos: THREE.Vector3, height: number, { lured = false, home = null, kind = 'normal', yaw }: { lured?: boolean; home?: THREE.Vector3 | null; kind?: Kind; yaw?: number } = {}): void {
    const g = this.g;
    pos.y = g.collision.groundHeight(pos.x, pos.z);
    this.flow._spawnQ.push({
      kind, height, position: pos, yaw: yaw ?? R.sim() * Math.PI * 2,
      then: (t: Titan | null) => { if (!t) return; t.lured = lured; if (home) t.home.copy(home); },
    });
  }
  /** The titans after him (not the bait). */
  hunting(): Titan[] { return ((this.g.titans?.titans || []) as Titan[]).filter((t) => t.alive && !t.lured); }
  /** The titans kept busy at the decoy. */
  _bait(): Titan[] { return ((this.g.titans?.titans || []) as Titan[]).filter((t) => t.alive && t.lured); }
  _flareOfficer(): Ally | undefined { return (this.g.allies || []).find((a) => a.name === FLARES && a.alive); }

  // ---------------------------------------------------------------- the operation
  update(dt: number): void {
    const g = this.g;
    if (this.phase === 'none') return;
    this.t += dt;
    this._atmosphere(dt);
    const esc = this.esc;
    switch (this.phase) {
      case 'brief':
        if (this.t > 1) this._say(GENERAL, `Listen well. Today ${PLACE.town} gets its gate back: ${SHIFTER} lifts the boulder and walks it into the hole.`);
        if (this.t > 4) this._say(GENERAL, `The rest of us keep the titans busy at the west corner. ${LEADER}'s squad stays with the boy, whatever comes.`);
        if (this.t > 6.5) this._say(LEADER, `Blades out, everyone. ${SHIFTER}, go!`);
        if (this.t > 8) this._transform();
        break;
      case 'transform':
        if (esc && esc.phase === 'berserk' && esc.phaseT > 0.9 && !this.flung) {
          this.flung = true;
          const m = this.ace;
          if (m && m.alive && m.pos.distanceTo(esc.punchAt) < 12) { m.gear.releaseAll(true); m.vel.set((m.pos.x - esc.position.x) * 0.6, 9, (m.pos.z - esc.position.z) * 0.6).clampLength(0, 18); }
          g.player.cam.trauma = Math.min(1, g.player.cam.trauma + 0.5);
          this._say(ACE, `${SHIFTER}! That's me you're swinging at. Come back!`);
        }
        break;
      case 'defend':
        if (!esc) break;
        this.wakeT -= dt;
        if (this.wakeT < WAKE_T - 4) this._say(LEADER, 'Nobody runs. We keep them off him until he comes back to himself!');
        if (this.wakeT < 15) this._say(FRIEND, 'Let me try. I\'ll climb up to his neck and talk to him!');
        if (this.wakeT < 2.5) this._say(FRIEND, `${SHIFTER}, the gate is right there! You said you'd carry it. So carry it!`);
        if (this.wakeT <= 0) {
          esc.roar(); esc.setPhase('lift');
          g.hud?.message?.(`${up(SHIFTER)} LIFTS THE BOULDER`, 2.5, 'big');
          this._say(LEADER, 'He\'s up, and he\'s got it! Every blade on this street, keep them off him!');
          this.phase = 'carry'; this.dirT = 5;
          g.audio?.setMusic?.(1);
        }
        this._director(dt);
        break;
      case 'carry':
        if (!esc) break;
        if (esc.progress > 0.3) this._say(ELITE, 'My team, drop to the street and pull them away from him!');
        if (esc.progress > 0.55) this._say(FLARES, `Push, ${SHIFTER}! A few more steps!`);
        if (!this.gateTitan && esc.position.z > GOAL_Z - 42) {
          // as he reaches the breach, one comes in through it, straight at him
          this.gateTitan = true;
          this._spawn(new V3(2, 0, 34), 12.5, { yaw: Math.PI });
          this._say(FLARES, 'Something\'s walking in through the hole! Drop it before it gets to him!');
        }
        this._director(dt);
        break;
      case 'rescue':
        this.rescueT -= dt;
        if (!this.yellow && this.rescueT < RESCUE_T - 1.4) {
          this.yellow = true;
          const fo = this._flareOfficer();
          g.fx?.flare?.(fo ? fo.pos : new V3(10, 52, -2), 'yellow');
          g.audio?.hookFire?.(1);
          g.hud?.message?.('YELLOW FLARE · THE BREACH IS SEALED', 3.5, 'big');
        }
        if (this.rescueT < RESCUE_T - 3) this._say(ACE, 'He\'s grown into the neck! Cover us while we pull him free!');
        if (this.rescueT <= 0) this._captain();
        break;
      case 'captain':
        if (this.t - this.captainAt > 4.5) this._win();
        break;
      default: break;
    }
  }

  _transform(): void {
    const g = this.g;
    this.phase = 'transform';
    const y = g.collision.groundHeight(SHIFTER_AT.x, SHIFTER_AT.z);
    const toSquad = Math.atan2(g.player.pos.x - SHIFTER_AT.x, g.player.pos.z - SHIFTER_AT.z);
    // the lightning strike, and his giant comes out of it
    g.fx?.lightning?.(new V3(SHIFTER_AT.x, y, SHIFTER_AT.z), 70);
    g.fx?.steam?.(new V3(SHIFTER_AT.x, y + 6, SHIFTER_AT.z), 16, 4);
    g.events.emit('titan:step', { position: new V3(SHIFTER_AT.x, y, SHIFTER_AT.z), size: 60 });
    g.player.cam.trauma = 1;
    if (!g.titans || !this.boulder) return;
    const esc = new Carrier(g.titans, { position: new V3(SHIFTER_AT.x, y, SHIFTER_AT.z), yaw: toSquad, boulder: this.boulder, goalZ: GOAL_Z });
    g.escort = esc;
    // he swings at the nearest of the squad: the ace, standing in front of him
    this.ace = (g.allies || []).find((a) => a.name === ACE && a.alive);
    if (this.ace) {
      const at = this._roofNear(SHIFTER_AT.x + Math.sin(toSquad) * 13, SHIFTER_AT.z + Math.cos(toSquad) * 13);
      if (at) { this.ace.pos.copy(at); this.ace.prev.copy(at); this.ace.render.copy(at); this.ace.vel.set(0, 0, 0); }
    }
    esc.punchAt.copy(this.ace ? this.ace.pos : g.player.pos);
    g.hud?.message?.(`${up(SHIFTER)} CHANGES`, 2, 'big');
    g.audio?.setMusic?.(0.6);
  }

  // events from the carrier (Game forwards them)
  onDown(): void {
    const g = this.g;
    if (this.phase !== 'transform') return;
    this.phase = 'defend'; this.wakeT = WAKE_T; this.dirT = 4;
    const fo = this._flareOfficer();
    g.fx?.flare?.(fo ? fo.pos : g.player.pos.clone().add(new V3(4, 0, 0)), 'red');
    g.audio?.hookFire?.(1);
    g.hud?.message?.('RED FLARE · THE OPERATION HAS FAILED', 3.5, 'big');
    this._say(FLARES, `That isn't ${SHIFTER} any more. I'm firing red, we've failed!`);
    // while they argue, the nearest titans in the town are already coming for him, and some of the bait breaks off
    this._fromTown(2);
    this._breakAway(1);
    g.audio?.setMusic?.(0.8);
  }

  onSealed(): void {
    const g = this.g, p = g.player, esc = this.esc;
    if (this.done || !esc) return;
    g.gateSealed = true;
    // the boulder fills the tunnel: nothing walks or flies through it again
    this.seal = g.collision.addBox({ center: new V3(0, 10, 0), halfExtents: new V3(8, 10, 6), material: 'stone' });
    for (const t of (g.titans?.titans || []) as Titan[]) {
      if (Math.abs(t.position.z) < 6 + t.footR && Math.abs(t.position.x) < 8) t.position.z = t.position.z >= 0 ? 6 + t.footR + 2 : -(6 + t.footR + 2);
    }
    for (let i = 0; i < 12; i++) g.fx?.impact?.(new V3((R.fx() - 0.5) * 20, R.fx() * 6, -10 + R.fx() * 6), new V3(0, 1, 0), 'stone');
    g.fx?.steam?.(new V3(0, 6, -12), 18, 4, [col(0xd9d0c0), col(0xa59d90)]);   // the dust of it
    g.events.emit('titan:step', { position: new V3(0, 0, -6), size: 80 });
    g.audio?.titanFall?.(new V3(0, 5, -6), 40);
    p.cam.trauma = 1; g.hitstop = 0.35;
    this.flow.score += 5000 + Math.round(esc.hp) * 40;
    // the commander sends the reinforcements in: the titans not already on him turn back toward the main force, but
    // two come at him while he lies there
    for (const t of this.hunting()) if (t.position.distanceTo(esc.position) > 30) { t.lured = true; t.home.copy(DECOY); if (t.state === 'maul') t._enter('idle'); }
    this.phase = 'rescue'; this.rescueT = RESCUE_T;
    for (const sx of [-1, 1]) this._spawn(new V3(sx * (8 + R.sim() * 6), 0, -95 - R.sim() * 20), 9 + R.sim() * 4, { yaw: 0 });
    g.audio?.setMusic?.(0.7);
  }

  /** The Outriders come home through the gate town: their captain clears every titan near him in one pass. */
  _captain(): void {
    const g = this.g, esc = this.esc;
    this.phase = 'captain'; this.captainAt = this.t;
    if (!esc) return;
    const captain = { name: CAPTAIN };
    for (const t of (g.titans?.titans || []) as Titan[]) {
      if (!t.alive || t.position.distanceTo(esc.position) > 160) continue;
      const nw = t.napeWorld();
      g.fx?.slashArc?.(nw.center, t.root.quaternion, t.height * 0.25);
      g.fx?.blood?.(nw.center, nw.normal, 2);
      t.killedBy = captain;
      t.applyHit({ part: 'nape', damage: 1e5, point: nw.center });
    }
    g.hud?.message?.(`${up(CAPTAIN)} · ${up(ORG.scouts)} ARE BACK`, 3.5, 'big');
    g.hud?.feed?.('Somebody tell me why there\'s a rock in the gate. And who\'s that, steaming in the street?', 'radio', CAPTAIN);
    g.audio?.setMusic?.(0.35);
  }

  _win(): void {
    const g = this.g, p = g.player, flow = this.flow;
    if (this.done) return;
    this.done = true; this.phase = 'won';
    g.hud?.feed?.(`The breach is shut. For the first time, we took ground back from them and held it.`, 'radio', GENERAL);
    const run = flow.run;
    afterMs(() => {
      if (flow.run !== run) return;
      g.input.unlock?.();
      g.hud?.showDeath?.({ cause: `${up(PLACE.town)} HOLDS`, win: true, kills: p.stats.kills, score: flow.score, time: Math.round(g.time - (flow.startTime || 0)) },
        () => flow.start('gate'), () => flow.toMenu());
    }, 2500);
  }

  onFallen(): void {
    const g = this.g, flow = this.flow;
    if (this.done) return;
    this.done = true; this.phase = 'lost';
    g.hud?.message?.(g.gateSealed ? `THEY GOT TO ${up(SHIFTER)}` : `${up(SHIFTER)} IS DOWN. THE BOULDER HAS FALLEN`, 3.5, 'big');
    g.audio?.setMusic?.(0.1);
    const run = flow.run;
    afterMs(() => {
      if (flow.run !== run) return;
      g.input.unlock?.();
      g.hud?.showDeath?.({ cause: g.gateSealed ? `${up(SHIFTER)} WAS EATEN` : `${up(PLACE.town)} IS LOST`, kills: g.player.stats.kills, score: flow.score, time: Math.round(g.time - (flow.startTime || 0)) },
        () => flow.start('gate'), () => flow.toMenu());
    }, 3800);
  }

  // ---------------------------------------------------------------- titans
  /** More come at him: some of the bait breaks off, more come out of the town, and through the breach while it's open. */
  _director(dt: number): void {
    const g = this.g, esc = this.esc;
    if (!esc || (this.dirT -= dt) > 0) return;
    const carry = this.phase === 'carry';
    this.dirT = carry ? 13 - 3 * esc.progress + R.sim() * 3 : 11 + R.sim() * 3;
    if (this.hunting().length + this.flow._spawnQ.length >= MAX_HUNTING) { this.dirT = 2; return; }
    this.waves++;
    this._breakAway(1);
    this._fromTown(1 + (this.waves % 2));
    // and in from the field through the breach
    if (this.waves % 2 === 0 && !(carry && esc.position.z > GOAL_Z - 40)) this._spawn(new V3((R.sim() - 0.5) * 50, 0, 30 + R.sim() * 30), 6 + R.sim() * 8, { kind: this.waves % 3 === 2 ? 'abnormal' : 'normal' });
    // keep the bait round the decoy
    const bait = this._bait().length;
    if (bait < 3) this._spawn(this._around(DECOY, 45), 6 + R.sim() * 8, { lured: true, home: DECOY });
  }

  /** Out of the town's streets nearest him (not right on top of him or of you). */
  _fromTown(n: number): void {
    const g = this.g, esc = this.esc;
    if (!esc) return;
    const at = esc.position;
    const zones = (g.world?.titanSpawns || []).filter((z) => z.area === 'town' && Math.hypot(z.center.x - at.x, z.center.z - at.z) > 30 && z.center.distanceTo(g.player.pos) > 25)
      .sort((a, b) => a.center.distanceTo(at) - b.center.distanceTo(at)).slice(0, 4);
    for (let i = 0; i < n && zones.length; i++) {
      const z = zones[(R.sim() * zones.length) | 0];
      this._spawn(this._around(z.center, z.radius), 5 + R.sim() * 9);
    }
  }

  _breakAway(n: number): void {
    const g = this.g;
    // the ones nearest him break off first
    const at = this.esc?.position || DECOY;
    const bait = this._bait().sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at));
    for (let i = 0; i < n && bait.length; i++) {
      const t = bait.shift();
      if (!t) break;
      t.lured = false;
      if (i === 0) this._say(R.sim() < 0.5 ? FLARES : LEADER, 'One\'s peeled off the decoy! It\'s heading our way!', 'break' + this.waves + '-' + Math.round(this.t));
    }
  }

  // ---------------------------------------------------------------- atmosphere
  /** The gate town burning, and the cannons of the main force booming at the far corner. */
  _atmosphere(dt: number): void {
    const g = this.g, fx = g.fx;
    if (!fx) return;
    if ((this.fireT -= dt) <= 0) {
      this.fireT = 0.9;
      for (const [x, z] of FIRES) fx.steam(new V3(x + (R.fx() - 0.5) * 3, 14, z + (R.fx() - 0.5) * 3), 5.5, 9, SMOKE);
    }
    if ((this.cannonT -= dt) <= 0 && this.phase !== 'won') {
      this.cannonT = 1.6 + R.sim() * 2.6;
      const at = new V3(DECOY.x + (R.sim() - 0.5) * 90, 52, -3.5);
      fx.steam(at, 3, 3, CANNON);
      g.audio?.titanStep?.(at, 18);
      const bait = this._bait();
      const tgt = bait[(R.sim() * bait.length) | 0];
      if (tgt) { const hp = tgt._headWorld(new V3()); fx.impact(hp, new V3(0, 1, 0), 'stone'); fx.steam(hp, 2.5, 2, SMOKE); }
    }
  }

  // ---------------------------------------------------------------- HUD
  objective(): string {
    const esc = this.esc;
    const hp = esc ? ` · ${SHIFTER} ${Math.round(esc.hp)}%` : '';
    const on = this.hunting().filter((t) => t.state === 'maul' && t.mauling).length;
    const onTxt = on ? ` · ${on} titan${on > 1 ? 's' : ''} on him!` : '';
    switch (this.phase) {
      case 'brief': return `${up(MISSION.gate)} · ${SHIFTER} is about to change`;
      case 'transform': return `${up(GIANT.shifterGiant)} IS OUT OF CONTROL · stay clear`;
      case 'defend': return `HOLD THEM OFF ${up(SHIFTER)} · ${FRIEND} is climbing to him: ${Math.max(0, Math.ceil(this.wakeT))} s${hp}${onTxt}`;
      case 'carry': return esc ? `PROTECT ${up(SHIFTER)} · ${Math.max(0, Math.round(esc.goalZ - esc.position.z))} m to the breach${hp}${onTxt || (esc.blocked ? ' · a titan is in his way!' : '')}` : '';
      case 'rescue': return `THEY'RE CUTTING ${up(SHIFTER)} OUT · hold on ${Math.max(0, Math.ceil(this.rescueT))} s${hp}${onTxt}`;
      case 'captain': case 'won': return 'THE BREACH IS SEALED';
      case 'lost': return `${up(PLACE.town)} IS LOST`;
      default: return '';
    }
  }
}
