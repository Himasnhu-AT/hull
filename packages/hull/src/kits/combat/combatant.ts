import { Animator } from '../../anim/index.ts';
import { config, num, tunables } from '../../config/index.ts';
import { Behaviour, signal, type Node, type Signal } from '../../core/index.ts';
import type { Character } from '../../schema/character.ts';
import type { Move, MoveSet } from '../../schema/index.ts';
import { flagsOf, fwdX, fwdZ, type KitFlags } from '../common.ts';
import { Health } from '../health/health.ts';
import { kitIO } from '../io.ts';
import { combatHub, HitInfo, type CombatHub, type Outcome } from './hub.ts';
import { fireShot } from './projectile.ts';
import { Blade, HurtShapes, segSegDistSq, sweepBlade } from './trace.ts';

export const FIGHTERS = 'fighter';

export const combatTuning = tunables('swordfight', {
  perfectWindow: num(0.12, { min: 0.02, max: 0.5, step: 0.01, unit: 's', widget: 'dial', help: 'A guard raised this long or less before the blow lands is a perfect deflect.' }),
  deflectWindow: num(0.3, { min: 0.05, max: 1, step: 0.01, unit: 's', widget: 'dial', help: 'A guard raised this long or less before the blow is a deflect: cheap on posture, no stagger.' }),
  guardArc: num(150, { min: 30, max: 360, step: 5, unit: 'deg', help: 'A guard only stops what comes from inside this arc in front.' }),
  blockPosture: num(1, { min: 0, max: 4, step: 0.05, widget: 'dial', help: 'Share of a blow\'s posture damage a plain block takes.' }),
  deflectPosture: num(0.35, { min: 0, max: 4, step: 0.05, widget: 'dial', help: 'Share a deflect takes.' }),
  hitPosture: num(0.5, { min: 0, max: 4, step: 0.05, widget: 'dial', help: 'Share a clean hit adds on top of the hit points.' }),
  perfectDrain: num(1.5, { min: 0, max: 6, step: 0.1, widget: 'dial', help: 'The attacker of a perfect deflect loses this times the blow\'s posture damage.' }),
  perfectFlat: num(8, { min: 0, max: 60, step: 1, help: 'And this much more.' }),
  perfectStagger: num(0.9, { min: 0, max: 3, step: 0.05, unit: 's', widget: 'dial', help: 'How long a perfect deflect staggers the attacker.' }),
  hitStagger: num(0.35, { min: 0, max: 3, step: 0.05, unit: 's', help: 'Default stagger of a clean hit.' }),
  brokenSeconds: num(2.4, { min: 0.3, max: 10, step: 0.1, unit: 's', help: 'How long a broken posture stays open to a finisher (an enemy\'s own file overrides it).' }),
  brokenDamage: num(1.5, { min: 1, max: 6, step: 0.1, help: 'Damage multiplier against a broken posture.' }),
  weakBonus: num(1.5, { min: 1, max: 4, step: 0.05, help: 'Posture multiplier when the attacker\'s stance is what the target is weak to.' }),
  dodgeTime: num(0.45, { min: 0.1, max: 1.5, step: 0.01, unit: 's' }),
  dodgeIframeStart: num(0.04, { min: 0, max: 0.5, step: 0.01, unit: 's', help: 'Seconds into a dodge before nothing can hurt.' }),
  dodgeIframe: num(0.26, { min: 0, max: 1, step: 0.01, unit: 's', widget: 'dial', help: 'How long nothing can hurt during a dodge.' }),
  dodgeDistance: num(2.6, { min: 0, max: 8, step: 0.1, unit: 'm' }),
  inputBuffer: num(0.2, { min: 0, max: 0.6, step: 0.01, unit: 's', help: 'A press during a move is remembered this long and used the moment the move allows it.' }),
  hitStopLight: num(0.05, { min: 0, max: 0.3, step: 0.005, unit: 's', help: 'Both fighters freeze this long on a clean hit.' }),
  hitStopHeavy: num(0.09, { min: 0, max: 0.3, step: 0.005, unit: 's', help: 'Freeze on a hit by a move with damage over 25.' }),
  hitStopBlock: num(0.04, { min: 0, max: 0.3, step: 0.005, unit: 's', help: 'Freeze on a plain block: short, so a block feels heavy but not like a hit.' }),
  hitStopDeflect: num(0.06, { min: 0, max: 0.3, step: 0.005, unit: 's', help: 'Freeze on a deflect.' }),
  hitStopPerfect: num(0.11, { min: 0, max: 0.4, step: 0.005, unit: 's', help: 'Freeze on a perfect deflect: the longest of the guards, so it reads as the reward.' }),
  shakeBlock: num(0.15, { min: 0, max: 1, step: 0.05, help: 'Camera shake of a plain block.' }),
  shakeDeflect: num(0.2, { min: 0, max: 1, step: 0.05, help: 'Camera shake of a deflect.' }),
  shakePerfect: num(0.35, { min: 0, max: 1, step: 0.05, help: 'Camera shake of a perfect deflect.' }),
  shakeHit: num(0.35, { min: 0, max: 1, step: 0.05, help: 'Camera shake of a clean hit.' }),
  bodyRadius: num(0.3, { min: 0.1, max: 1.5, step: 0.05, unit: 'm', help: 'A fighter without hit shapes is a capsule this wide and 1.7 m tall.' }),
  zoneDamage: num(1, { min: 0, max: 1, step: 0.05, help: 'How much of the Health hit-zone multipliers (head 2x, nape 3x, limb 0.5x) a blow takes: 1 all of it, 0 none, so a move always does its listed damage.' }),
  blockChip: num(0.15, { min: 0, max: 1, step: 0.01, widget: 'dial', help: 'Share of a blow\'s damage that gets through a plain block (a deflect stops all of it).' }),
  resistMult: num(0.7, { min: 0, max: 1, step: 0.05, help: 'Posture multiplier when the attacker\'s stance is what the target resists (the wrong stance).' }),
  fightRange: num(10, { min: 1, max: 40, step: 1, unit: 'm', help: 'A living enemy this close puts a fighter "in combat": its posture comes back at the in-combat rate.' }),
  postureRecover: num(10, { min: 0, max: 60, step: 1, unit: '/s', help: 'Posture regained each second (an enemy\'s own file overrides it).' }),
  postureDelay: num(1.5, { min: 0, max: 6, step: 0.1, unit: 's', help: 'Quiet seconds before posture starts to come back.' }),
  modelYaw: num(0, { min: -3.15, max: 3.15, step: 0.05, unit: 'rad', help: 'Turns a fighter\'s model so its front faces where the fighter faces.' }),
});

export type CombatState = 'free' | 'attack' | 'dodge' | 'stagger' | 'broken' | 'dead';

/** One blow on its way to a fighter. */
export interface Attack {
  attacker: Combatant | null;
  move: string;
  damage: number;
  posture: number;
  zone: string;
  unblockable: boolean;
  guardBreak: number;
  stagger: number;
  knockback: number;
  hitStop: number;
  heavy: boolean;
  finisher: boolean;
  stance: string;
  /** Where the blow comes from and where it lands, in the world. */
  fromX: number; fromZ: number;
  x: number; y: number; z: number;
}

export function newAttack(): Attack {
  return { attacker: null, move: '', damage: 0, posture: 0, zone: '', unblockable: false, guardBreak: 1, stagger: -1, knockback: 0, hitStop: -1, heavy: false, finisher: false, stance: '', fromX: 0, fromZ: 0, x: 0, y: 0, z: 0 };
}

const bare = (kind: string, id: string): string => (id.startsWith(`${kind}/`) ? id.slice(kind.length + 1) : id);

function findAnimator(n: Node): Animator | null {
  const a = n.get(Animator);
  if (a) return a;
  for (const c of n.children) { const r = findAnimator(c); if (r) return r; }
  return null;
}

/** Whether t is inside a window: a [from, to] pair or a list of pairs. */
export function inWindow(w: readonly number[] | readonly (readonly number[])[] | undefined, t: number): boolean {
  if (!w || w.length === 0) return false;
  if (typeof w[0] === 'number') return t >= (w as readonly number[])[0]! && t < (w as readonly number[])[1]!;
  for (const r of w as readonly (readonly number[])[]) if (t >= r[0]! && t < r[1]!) return true;
  return false;
}

/**
 * A fighter: posture next to the Health on its node, a guard with timed deflects, a dodge with i-frames, moves from a
 * move-set whose blade is traced against other fighters' hurt shapes, stagger, a posture break that opens a finisher,
 * and death. It knows nothing about who drives it: the player's `FighterInput` and an enemy's `EnemyBrain` call the
 * same `press`, `guard`, `dodge` and `attack`.
 *
 * The node is the fighter's feet and faces where its `rotation.y` says (forward is -Z at 0). The Animator may sit on
 * the node or on a child.
 */
export class Combatant extends Behaviour {
  static override state = ['state', 'stateT', 'moveName', 'moveT', 'posture', 'postureIdle', 'guarding', 'guardWanted', 'guardAge', 'stance', 'frozen', 'iframe', 'told', 'buffer', 'bufferT', 'brokenT', 'staggerT', 'dodgeX', 'dodgeZ', 'dead'];

  /** Fighters of one team do not hurt each other. */
  team = '';
  /** Config id of the move-set ("move-set/duelist" or "duelist"). */
  moveSet = '';
  animator: Animator | null = null;
  stance = '';
  maxPosture = 100;
  /** Negative: the combat tuning. */
  postureRecover = -1;
  postureDelay = -1;
  brokenSeconds = -1;
  /** The stance that deals extra posture damage to this fighter. */
  weakTo = '';
  /** The stance that deals less posture damage to this fighter (the wrong one). */
  resists = '';
  /** Posture regained each second while an enemy is within `fightRange`. Negative: same as `postureRecover`. */
  postureRecoverFight = -1;
  /** Fraction of full health a finisher takes. */
  finisherDamage = 1;
  /** Called to move the node (a game with physics or a navmesh). Default: the node's position changes. */
  mover: ((dx: number, dz: number) => void) | null = null;

  state: CombatState = 'free';
  stateT = 0;
  moveName = '';
  moveT = 0;
  posture = 0;
  postureIdle = 0;
  guarding = false;
  guardWanted = false;
  guardAge = 0;
  frozen = 0;
  iframe = 0;
  told = false;
  buffer = '';
  bufferT = 0;
  brokenT = 0;
  staggerT = 0;
  dodgeX = 0;
  dodgeZ = 0;
  dead = false;

  health!: Health;
  /** Blows this fighter landed, for tests and stats. */
  landed = 0;

  readonly hit: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  readonly blocked: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  readonly deflected: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  readonly perfectDeflect: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  readonly postureBroken: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  readonly killed: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  readonly dodged: Signal<[info: HitInfo]> = signal<[HitInfo]>();
  /** (move name, completed): completed is false when the move was cut short. */
  readonly moveEnded: Signal<[move: string, completed: boolean]> = signal<[string, boolean]>();

  readonly info = new HitInfo();
  private readonly atk = newAttack();
  private flags!: KitFlags;
  private hub!: CombatHub;
  private setDef: MoveSet | null = null;
  private setId = '';
  private unwatch: (() => void) | null = null;
  private blade: Blade | null = null;
  private shapes: HurtShapes | null = null;
  private shapesFor: Animator | null = null;
  private struck: Combatant[] = [];
  private warned = false;
  private lastTick = -1;

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.hub = combatHub(this.world);
    this.node.addTo(FIGHTERS);
    const h = this.node.get(Health) ?? this.node.add(Health, {});
    h.invulnAfterHit = 0;
    this.health = h;
    const first = this.set?.stances?.[0];
    if (this.stance === '' && first) this.stance = first;
  }

  override dispose(): void { this.unwatch?.(); }

  // ---- data ----

  /** The move-set, read from config (and read again when its file changes). Null when it does not exist. */
  get set(): MoveSet | null {
    if (this.moveSet === '') return null;
    if (this.setDef && this.setId === this.moveSet) return this.setDef;
    this.unwatch?.();
    this.setDef = null;
    this.setId = this.moveSet;
    const id = bare('move-set', this.moveSet);
    try {
      this.setDef = config.lookup('move-set', id);
      this.unwatch = config.watch(`move-set/${id}`, (v) => { this.setDef = v as MoveSet; this.blade = null; });
    } catch {
      if (!this.warned) { this.warned = true; console.warn(`[hull] combat: move-set/${id} does not exist (used by "${this.node.name}").`); }
    }
    return this.setDef;
  }

  /** The move being played, or null. */
  get move(): Move | null { return this.state === 'attack' ? (this.set?.moves[this.moveName] ?? null) : null; }

  moveDef(name: string): Move | undefined { return this.set?.moves[name]; }

  get free(): boolean { return this.state === 'free'; }
  get isBroken(): boolean { return this.state === 'broken'; }
  /** A finisher can be started on this fighter. */
  get finisherReady(): boolean { return this.state === 'broken'; }
  get isDead(): boolean { return this.state === 'dead'; }
  get postureFraction(): number { return this.maxPosture > 0 ? this.posture / this.maxPosture : 0; }
  get yaw(): number { return this.node.rotation.y; }

  private bindAnimator(): Animator | null {
    if (!this.animator) this.animator = findAnimator(this.node);
    return this.animator;
  }

  /** Whether a named window of the current move is open now. */
  windowOpen(name: string): boolean {
    const m = this.move;
    if (!m) return false;
    const own = m.windows?.[name];
    // 'clip' reads the animation's windows; 'auto' reads them only for names the move-set does not list.
    if (m.windowsFrom === 'clip' || (m.windowsFrom === 'auto' && own === undefined)) {
      const a = this.bindAnimator();
      if (a && typeof a.inWindow === 'function') return a.inWindow(name);
    }
    return inWindow(own, this.moveT);
  }

  /** Seconds of the current move until its window `name` opens, or -1 when it has none ahead. */
  untilWindow(name: string): number {
    const w = this.move?.windows?.[name];
    if (!w) return -1;
    const list = (typeof w[0] === 'number' ? [w] : w) as readonly (readonly number[])[];
    for (const r of list) if (this.moveT < r[1]!) return Math.max(0, r[0]! - this.moveT);
    return -1;
  }

  // ---- what a driver can ask ----

  /** Starts a move by name. False when it cannot start now (busy, wrong stance, or a finisher with nobody broken). */
  attack(name: string): boolean {
    const m = this.set?.moves[name];
    if (!m || this.state === 'dead') return false;
    if (!this.canAct()) return false;
    return this.startMove(name, m);
  }

  private canAct(): boolean {
    if (this.state === 'free') return true;
    return this.state === 'attack' && this.windowOpen('cancel');
  }

  /**
   * A button: starts the move this input means from rest, or cuts into the next one of a string when the move's cancel
   * window is open. A press that comes too early is kept for `inputBuffer` seconds. Returns whether a move started.
   */
  press(input: string): boolean {
    if (this.state === 'dead') return false;
    if (this.tryPress(input)) return true;
    if (this.state === 'free' || this.state === 'attack') { this.buffer = input; this.bufferT = combatTuning.inputBuffer; }
    return false;
  }

  private tryPress(input: string): boolean {
    const set = this.set;
    if (!set) return false;
    if (this.state === 'free') {
      for (const name in set.moves) {
        const m = set.moves[name]!;
        if (m.input === input && m.start !== false && this.stanceOk(m) && this.finisherOk(m)) return this.startMove(name, m);
      }
      return false;
    }
    if (this.state === 'attack' && this.windowOpen('cancel')) {
      const cur = this.move;
      for (const name of cur?.cancelsInto ?? []) {
        const m = set.moves[name];
        if (m && m.input === input && this.stanceOk(m) && this.finisherOk(m)) return this.startMove(name, m);
      }
    }
    return false;
  }

  private stanceOk(m: Move): boolean { return !m.stance || m.stance === this.stance; }

  /** A finisher needs a broken fighter in reach. */
  private finisherOk(m: Move): boolean { return !m.finisher || this.brokenInReach(m.reach ?? 2.5) !== null; }

  /** The nearest broken fighter of another team within `range` metres, in front. */
  brokenInReach(range: number): Combatant | null {
    let best: Combatant | null = null, bd = range * range;
    const g = this.world.group(FIGHTERS);
    const p = this.node.position;
    for (let i = 0; i < g.length; i++) {
      const c = g[i]!.get(Combatant);
      if (!c || c === this || c.state !== 'broken' || (c.team === this.team && this.team !== '')) continue;
      const d = (c.node.position.x - p.x) ** 2 + (c.node.position.z - p.z) ** 2;
      if (d < bd && this.faces(c.node.position.x, c.node.position.z, 120)) { bd = d; best = c; }
    }
    return best;
  }

  setStance(name: string): void { this.stance = name; }

  /** Holds or lets go of the guard. A guard held while busy starts when the fighter is free again. */
  guard(on: boolean): void {
    this.guardWanted = on;
    if (!on) this.guarding = false;
    else if (this.state === 'free' && !this.guarding) this.beginGuard();
  }

  private beginGuard(): void {
    this.guarding = true;
    this.guardAge = 0;
    this.bindAnimator()?.set('guarding', true);
  }

  /** A dodge toward (dx, dz) in the world; with no direction, a step back. Allowed from rest or a move's cancel window. */
  dodge(dx = 0, dz = 0): boolean {
    if (!this.canAct()) return false;
    let l = Math.hypot(dx, dz);
    if (l < 1e-6) { dx = -fwdX(this.yaw); dz = -fwdZ(this.yaw); l = 1; }
    this.endMove(false);
    this.setGuardOff();
    this.dodgeX = dx / l; this.dodgeZ = dz / l;
    this.state = 'dodge';
    this.stateT = 0;
    this.iframe = 0;
    this.bindAnimator()?.trigger('dodge');
    return true;
  }

  /** Cuts the current move short (a feint). */
  cancelMove(): void { if (this.state === 'attack') this.endMove(false); }

  /** Freezes this fighter's clock for `seconds` (hit-stop). */
  freeze(seconds: number): void {
    if (seconds <= this.frozen) return;
    this.frozen = seconds;
    this.timeScale(0);
  }

  private timeScale(v: number): void {
    const a = this.animator as unknown as { timeScale?: number } | null;
    if (a && 'timeScale' in a) a.timeScale = v;
  }

  stagger(seconds: number): void {
    if (this.state === 'dead' || this.state === 'broken') return;
    this.endMove(false);
    this.setGuardOff();
    this.state = 'stagger';
    this.staggerT = seconds;
    this.stateT = 0;
    this.bindAnimator()?.trigger('stagger');
  }

  /** Fills posture by `amount` (scaled up when `stance` is what this fighter is weak to). Breaks it when full. */
  addPosture(amount: number, stance = '', info?: HitInfo, by: Combatant | null = null): void {
    if (this.state === 'dead' || amount <= 0) return;
    if (this.weakTo !== '' && stance === this.weakTo) amount *= combatTuning.weakBonus;
    else if (this.resists !== '' && stance === this.resists) amount *= combatTuning.resistMult;
    this.posture = Math.min(this.maxPosture, this.posture + amount);
    this.postureIdle = 0;
    if (this.posture >= this.maxPosture && this.state !== 'broken') this.breakPosture(info, by);
  }

  breakPosture(info?: HitInfo, by: Combatant | null = null): void {
    if (this.state === 'dead' || this.state === 'broken') return;
    this.endMove(false);
    this.setGuardOff();
    this.posture = this.maxPosture;
    this.state = 'broken';
    this.brokenT = this.brokenSeconds >= 0 ? this.brokenSeconds : combatTuning.brokenSeconds;
    this.stateT = 0;
    this.bindAnimator()?.set('broken', true);
    const i = info ?? this.info;
    if (!info) { i.attacker = by; i.defender = this; i.outcome = 'ignored'; i.move = ''; i.damage = 0; i.posture = 0; i.zone = ''; i.unblockable = false; }
    this.postureBroken.emit(i);
    this.hub.postureBroken.emit(i);
    this.hub.shake.emit(0.3, 0.25);
    kitIO.play('sound/posture-break');
  }

  private setGuardOff(): void {
    if (this.guarding) { this.guarding = false; this.bindAnimator()?.set('guarding', false); }
  }

  // ---- being hit ----

  /** Whether the world point is inside the arc in front of this fighter (`arc` degrees). */
  faces(x: number, z: number, arc = combatTuning.guardArc): boolean {
    const dx = x - this.node.position.x, dz = z - this.node.position.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) return true;
    return (dx * fwdX(this.yaw) + dz * fwdZ(this.yaw)) / l >= Math.cos((arc * Math.PI) / 360);
  }

  /** Nothing hurts: inside a dodge's i-frames, inside a move's iframe window, or while an i-frame timer from the game runs. */
  get iframes(): boolean {
    if (this.iframe > 0) return true;
    if (this.state === 'dodge') return this.stateT >= combatTuning.dodgeIframeStart && this.stateT < combatTuning.dodgeIframeStart + combatTuning.dodgeIframe;
    return this.state === 'attack' && this.windowOpen('iframe');
  }

  /**
   * A blow arrives. Decides the outcome in this order: nothing hurts during an i-frame; a guard held in front stops
   * what is blockable (a guard raised within `perfectWindow` seconds is a perfect deflect, within `deflectWindow` a
   * deflect, otherwise a block); everything else is a clean hit. Returns what happened.
   */
  receive(a: Attack): Outcome {
    if (this.state === 'dead') return 'ignored';
    const info = this.info;
    const att = a.attacker;
    info.attacker = att; info.defender = this; info.move = a.move; info.zone = a.zone;
    info.damage = 0; info.posture = 0; info.x = a.x; info.y = a.y; info.z = a.z;
    info.unblockable = a.unblockable; info.heavy = a.heavy;

    if (a.finisher) {
      if (this.state !== 'broken') { info.outcome = 'ignored'; return 'ignored'; }
      return this.takeFinisher(a);
    }
    if (this.iframes) {
      info.outcome = 'dodged';
      this.dodged.emit(info);
      this.hub.dodged.emit(info);
      return 'dodged';
    }
    if (this.guarding && this.state === 'free' && !a.unblockable && this.faces(a.fromX, a.fromZ)) {
      const age = this.guardAge;
      if (age <= combatTuning.perfectWindow) return this.perfect(a, att);
      const deflect = age <= combatTuning.deflectWindow;
      const share = deflect ? combatTuning.deflectPosture : combatTuning.blockPosture * a.guardBreak;
      info.outcome = deflect ? 'deflected' : 'blocked';
      info.posture = a.posture * share;
      kitIO.play(deflect ? 'sound/deflect' : 'sound/clash');
      this.freezePair(att, deflect ? combatTuning.hitStopDeflect : combatTuning.hitStopBlock);
      // A plain block lets a little through; a deflect none. The chip is never a hit: no stagger, no blood.
      if (!deflect && combatTuning.blockChip > 0 && a.damage > 0) {
        this.health.damage(this.zoned(a.damage * combatTuning.blockChip, a.zone), a.zone, att?.node ?? null);
        info.damage = a.damage * combatTuning.blockChip;
        if (this.health.dead) { this.die(); return info.outcome; }
      }
      if (deflect) { this.deflected.emit(info); this.hub.deflected.emit(info); }
      else { this.blocked.emit(info); this.hub.blocked.emit(info); }
      this.hub.shake.emit(deflect ? combatTuning.shakeDeflect : combatTuning.shakeBlock, 0.12);
      if (a.knockback > 0) this.push(a, a.knockback * 0.3);
      this.addPosture(info.posture, a.stance, info);
      return info.outcome;
    }
    return this.takeHit(a, att);
  }

  private perfect(a: Attack, att: Combatant | null): Outcome {
    const info = this.info;
    info.outcome = 'perfect';
    info.posture = a.posture * combatTuning.perfectDrain + combatTuning.perfectFlat;
    kitIO.play('sound/deflect', { pitch: 1.25 });
    this.freezePair(att, combatTuning.hitStopPerfect);
    this.perfectDeflect.emit(info);
    this.hub.perfectDeflect.emit(info);
    this.hub.shake.emit(combatTuning.shakePerfect, 0.18);
    if (att) {
      att.stagger(combatTuning.perfectStagger);
      att.addPosture(info.posture, this.stance, undefined, this);
    }
    return 'perfect';
  }

  /** `amount` rescaled so that Health's zone multiplier lands at the share `zoneDamage` allows. */
  private zoned(amount: number, zone: string): number {
    const m = this.health.multiplier(zone);
    return m === 1 || combatTuning.zoneDamage >= 1 ? amount : (amount * (1 + (m - 1) * combatTuning.zoneDamage)) / m;
  }

  private takeHit(a: Attack, att: Combatant | null): Outcome {
    const info = this.info;
    let amount = a.damage;
    if (this.state === 'broken') amount *= combatTuning.brokenDamage;
    const applied = this.health.damage(this.zoned(amount, a.zone), a.zone, att?.node ?? null);
    info.damage = applied;
    info.posture = a.posture * combatTuning.hitPosture;
    info.outcome = 'hit';
    const stop = a.hitStop >= 0 ? a.hitStop : a.heavy ? combatTuning.hitStopHeavy : combatTuning.hitStopLight;
    this.freezePair(att, stop);
    this.hub.hitStop.emit(stop);
    kitIO.play('sound/hit');
    this.hit.emit(info);
    this.hub.hit.emit(info);
    this.hub.shake.emit(combatTuning.shakeHit * (a.heavy ? 1.4 : 1), 0.2);
    if (att) att.landed++;
    if (this.health.dead) { this.die(); return 'hit'; }
    if (a.knockback > 0) this.push(a, a.knockback);
    this.stagger(a.stagger >= 0 ? a.stagger : combatTuning.hitStagger);
    this.addPosture(info.posture, a.stance, info);
    return 'hit';
  }

  private takeFinisher(a: Attack): Outcome {
    const info = this.info;
    const amount = this.health.max * this.finisherDamage;
    info.damage = this.health.damage(Math.max(amount, 1e-6), '', a.attacker?.node ?? null);
    info.outcome = 'finisher';
    this.freezePair(a.attacker, combatTuning.hitStopHeavy * 1.5);
    this.hub.hitStop.emit(combatTuning.hitStopHeavy * 1.5);
    kitIO.play('sound/hit', { pitch: 0.8 });
    this.hit.emit(info);
    this.hub.hit.emit(info);
    this.hub.shake.emit(0.6, 0.3);
    if (a.attacker) a.attacker.landed++;
    if (this.health.dead) { this.die(); return 'finisher'; }
    // A fighter that survives one (a boss) gets up with its posture empty.
    this.posture = 0;
    this.state = 'free';
    this.bindAnimator()?.set('broken', false);
    this.stagger(0.8);
    return 'finisher';
  }

  private push(a: Attack, metres: number): void {
    const dx = this.node.position.x - a.fromX, dz = this.node.position.z - a.fromZ;
    const l = Math.hypot(dx, dz) || 1;
    this.drive((dx / l) * metres, (dz / l) * metres);
  }

  private freezePair(att: Combatant | null, seconds: number): void {
    if (seconds <= 0) return;
    this.freeze(seconds);
    att?.freeze(seconds);
  }

  /** Death from outside a blow (a standoff): the same end as a kill. */
  killedByStandoff(): void { if (this.state !== 'dead') this.die(); }

  private die(): void {
    this.endMove(false);
    this.setGuardOff();
    this.state = 'dead';
    this.dead = true;
    const a = this.bindAnimator();
    a?.set('dead', true);
    this.killed.emit(this.info);
    this.hub.killed.emit(this.info);
  }

  // ---- moves ----

  private startMove(name: string, m: Move): boolean {
    if (!this.stanceOk(m) || !this.finisherOk(m)) return false;
    this.setGuardOff();
    this.moveName = name;
    this.moveT = 0;
    this.state = 'attack';
    this.stateT = 0;
    this.told = false;
    this.buffer = '';
    this.bufferT = 0;
    this.struck.length = 0;
    this.blade?.disarm();
    this.bindAnimator()?.trigger(m.trigger ?? m.clip ?? name);
    if (m.sound) kitIO.play(m.sound);
    this.hub.moveStarted.emit(this, name);
    return true;
  }

  /** Marks the move's unblockable flag for this swing only (an enemy pattern's red flash). */
  unblockableOverride: boolean | null = null;

  private endMove(completed: boolean): void {
    if (this.state !== 'attack') return;
    const name = this.moveName;
    this.state = 'free';
    this.moveName = '';
    this.moveT = 0;
    this.unblockableOverride = null;
    if (!completed) this.bindAnimator()?.trigger('cancel');
    this.moveEnded.emit(name, completed);
    if (this.guardWanted) this.beginGuard();
  }

  /** Moves the node: through the game's `mover` when it has one. */
  drive(dx: number, dz: number): void {
    if (this.mover) this.mover(dx, dz);
    else { this.node.position.x += dx; this.node.position.z += dz; }
  }

  // ---- the step ----

  override fixedUpdate(dt: number): void {
    if (this.flags.paused || this.state === 'dead') return;
    if (this.frozen > 0) {
      this.frozen -= dt;
      if (this.frozen <= 0) { this.frozen = 0; this.timeScale(1); }
      return;
    }
    this.bindAnimator();
    if (this.iframe > 0) this.iframe = Math.max(0, this.iframe - dt);
    this.stepPosture(dt);
    switch (this.state) {
      case 'free': this.stepFree(dt); break;
      case 'attack': this.stepAttack(dt); break;
      case 'dodge': this.stepDodge(dt); break;
      case 'stagger':
        this.stateT += dt;
        if (this.stateT >= this.staggerT) { this.state = 'free'; if (this.guardWanted) this.beginGuard(); }
        break;
      case 'broken':
        this.brokenT -= dt;
        if (this.brokenT <= 0) {
          this.state = 'free';
          this.posture = this.maxPosture * 0.3;
          this.bindAnimator()?.set('broken', false);
        }
        break;
    }
    if (this.bufferT > 0) {
      this.bufferT -= dt;
      if (this.bufferT <= 0) this.buffer = '';
      else if (this.tryPress(this.buffer)) { this.buffer = ''; this.bufferT = 0; }
    }
  }

  private stepPosture(dt: number): void {
    if (this.state === 'broken' || this.posture <= 0) return;
    this.postureIdle += dt;
    const delay = this.postureDelay >= 0 ? this.postureDelay : combatTuning.postureDelay;
    if (this.postureIdle < delay) return;
    let rate = this.postureRecover >= 0 ? this.postureRecover : combatTuning.postureRecover;
    if (this.postureRecoverFight >= 0 && this.enemyNear()) rate = this.postureRecoverFight;
    this.posture = Math.max(0, this.posture - rate * dt);
  }

  /** A living fighter of another team within `fightRange`. */
  private enemyNear(): boolean {
    const g = this.world.group(FIGHTERS);
    const p = this.node.position, r2 = combatTuning.fightRange ** 2;
    for (let i = 0; i < g.length; i++) {
      const c = g[i]!.get(Combatant);
      if (!c || c === this || c.state === 'dead' || (this.team !== '' && c.team === this.team)) continue;
      const dx = c.node.position.x - p.x, dz = c.node.position.z - p.z;
      if (dx * dx + dz * dz <= r2) return true;
    }
    return false;
  }

  private stepFree(dt: number): void {
    if (this.guarding) this.guardAge += dt;
    else if (this.guardWanted) this.beginGuard();
  }

  private stepDodge(dt: number): void {
    const before = this.stateT;
    this.stateT += dt;
    const T = combatTuning.dodgeTime;
    const speed = combatTuning.dodgeDistance / T;
    const run = Math.min(this.stateT, T) - Math.min(before, T);
    this.drive(this.dodgeX * speed * run, this.dodgeZ * speed * run);
    if (this.stateT >= T) { this.state = 'free'; if (this.guardWanted) this.beginGuard(); }
  }

  private stepAttack(dt: number): void {
    const m = this.move;
    if (!m) { this.state = 'free'; return; }
    const t0 = this.moveT;
    this.moveT += dt;
    const lg = m.lunge;
    if (lg && lg.to > lg.from) {
      const a = Math.max(t0, lg.from), b = Math.min(this.moveT, lg.to);
      if (b > a) {
        const k = ((b - a) / (lg.to - lg.from)) * lg.distance;
        this.drive(fwdX(this.yaw) * k, fwdZ(this.yaw) * k);
      }
    }
    if (!this.told && m.windows?.['telegraph'] && this.windowOpen('telegraph')) {
      this.told = true;
      this.hub.tell.emit(this, (this.unblockableOverride ?? m.unblockable) ? 'unblockable' : 'glint');
    }
    if (m.shoot && t0 < m.shoot.at && this.moveT >= m.shoot.at) fireShot(this, this.moveName, m);
    this.traceStep(m);
    if (this.moveT >= m.length) this.endMove(true);
  }

  private bladeNow(): Blade | null {
    if (this.blade) return this.blade;
    const s = this.set, a = this.bindAnimator();
    if (!s || !a) return null;
    this.blade = new Blade(s.weapon.socket, s.weapon.base, s.weapon.tip, s.weapon.radius ?? 0.04);
    this.blade.bind(a);
    return this.blade;
  }

  /** Takes the blade's sample for this step and, in the trace window, sweeps it against everyone else. */
  private traceStep(m: Move): void {
    const blade = this.bladeNow();
    if (!blade) return;
    const tick = this.world.tick;
    if (!blade.sample(tick)) return;
    const live = this.windowOpen('trace');
    if (live) this.sweepFighters(m, blade, tick);
    blade.armed = true;
    // A new trace window starts with no one struck yet.
    if (!live && this.struck.length) this.struck.length = 0;
  }

  private sweepFighters(m: Move, blade: Blade, tick: number): void {
    const group = this.world.group(FIGHTERS);
    const p = this.node.position;
    const range = blade.length + 3;
    for (let i = 0; i < group.length; i++) {
      const n = group[i]!;
      if (n === this.node) continue;
      const other = n.get(Combatant);
      if (!other || other.state === 'dead' || (this.team !== '' && other.team === this.team)) continue;
      if (this.struck.indexOf(other) >= 0) continue;
      if (m.finisher === true && other.state !== 'broken') continue;
      const dx = n.position.x - p.x, dz = n.position.z - p.z;
      if (dx * dx + dz * dz > range * range) continue;
      // A finisher is not aimed: it lands on the broken fighter in reach once its window opens.
      const zone = m.finisher === true ? this.finisherContact(other) : other.hurtTest(blade, tick, this.atk);
      if (zone === null) continue;
      this.struck.push(other);
      this.deliver(m, other, zone);
    }
  }

  private finisherContact(other: Combatant): string | null {
    if (this.brokenInReach(this.move?.reach ?? 2.5) !== other) return null;
    this.atk.x = other.node.position.x; this.atk.y = other.node.position.y + 1.2; this.atk.z = other.node.position.z;
    return '';
  }

  private deliver(m: Move, other: Combatant, zone: string): void {
    const a = this.atk;
    a.attacker = this;
    a.move = this.moveName;
    a.damage = m.damage;
    a.posture = m.posture ?? 10;
    a.zone = zone;
    a.unblockable = this.unblockableOverride ?? m.unblockable ?? false;
    a.guardBreak = m.guardBreak ?? 1;
    a.stagger = m.stagger ?? -1;
    a.knockback = m.knockback ?? 0;
    a.hitStop = m.hitStop ?? -1;
    a.heavy = m.damage > 25;
    a.finisher = m.finisher === true;
    a.stance = this.stance;
    a.fromX = this.node.position.x; a.fromZ = this.node.position.z;
    other.receive(a);
  }

  /**
   * Tests a blade against this fighter's hurt shapes (or a plain capsule when its character has none). Returns the
   * part that was hit ("" for a plain capsule) and writes the contact into `out`; null when the blade missed.
   */
  hurtTest(blade: Blade, tick: number, out: Attack): string | null {
    const a = this.bindAnimator();
    if (a && this.shapesFor !== a) { this.shapes = this.makeShapes(a); this.shapesFor = a; }
    const sh = this.shapes;
    if (sh) {
      sh.refresh(tick);
      const i = sweepBlade(blade, sh);
      if (i < 0) return null;
      out.x = sh.cx; out.y = sh.cy; out.z = sh.cz;
      return sh.parts[i]!;
    }
    // Fallback: a vertical capsule at the feet, swept the same way.
    const q = this.node.position, r = combatTuning.bodyRadius + blade.radius;
    const prev = blade.prev, cur = blade.cur;
    const travel = Math.max(Math.hypot(cur[0]! - prev[0]!, cur[1]! - prev[1]!, cur[2]! - prev[2]!), Math.hypot(cur[3]! - prev[3]!, cur[4]! - prev[4]!, cur[5]! - prev[5]!));
    const n = Math.min(12, Math.max(1, Math.ceil(travel / Math.max(0.05, blade.radius * 2))));
    for (let k = blade.armed ? 1 : n; k <= n; k++) {
      const u = blade.armed ? k / n : 1;
      const ax = prev[0]! + (cur[0]! - prev[0]!) * u, ay = prev[1]! + (cur[1]! - prev[1]!) * u, az = prev[2]! + (cur[2]! - prev[2]!) * u;
      const bx = prev[3]! + (cur[3]! - prev[3]!) * u, by = prev[4]! + (cur[4]! - prev[4]!) * u, bz = prev[5]! + (cur[5]! - prev[5]!) * u;
      const d2 = segSegDistSq(ax, ay, az, bx, by, bz, q.x, q.y + 0.3, q.z, q.x, q.y + 1.5, q.z);
      if (d2 <= r * r) { out.x = (ax + bx) / 2; out.y = (ay + by) / 2; out.z = (az + bz) / 2; return ''; }
    }
    return null;
  }

  private makeShapes(a: Animator): HurtShapes | null {
    const ref = a.character;
    let def: Character | undefined;
    try { def = typeof ref === 'string' ? config.lookup('character', bare('character', ref)) : ref; } catch { return null; }
    if (!def?.hits || def.hits.length === 0) return null;
    const s = new HurtShapes(def, typeof ref === 'string' ? ref : 'character');
    s.bind(a);
    return s;
  }

  /** The hurt shapes, once the first trace has looked for them (tests and the debug draw). */
  get hurtShapes(): HurtShapes | null {
    const a = this.bindAnimator();
    if (a && this.shapesFor !== a) { this.shapes = this.makeShapes(a); this.shapesFor = a; }
    return this.shapes;
  }

  /** The blade, once the animator and move-set are there (tests and the debug draw). */
  get bladeView(): Blade | null { return this.bladeNow(); }
}
