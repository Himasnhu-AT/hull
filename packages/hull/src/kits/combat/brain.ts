import { Behaviour, signal, type Node, type Signal, type World } from '../../core/index.ts';
import { config, num, tunables } from '../../config/index.ts';
import type { Enemy, EnemyPattern } from '../../schema/index.ts';
import { flagsOf, fwdX, fwdZ, type KitFlags } from '../common.ts';
import { Combatant, FIGHTERS } from './combatant.ts';
import { combatHub, type CombatHub } from './hub.ts';

export const brainTuning = tunables('enemyBrain', {
  maxAttackers: num(2, { min: 1, max: 6, step: 1, widget: 'dial', help: 'How many enemies may be in an attack at once; the rest circle and wait.' }),
  circleFlip: num(2.4, { min: 0.5, max: 10, step: 0.1, unit: 's', help: 'Average time before a circling enemy changes direction.' }),
  separation: num(1.1, { min: 0, max: 4, step: 0.1, unit: 'm', help: 'Enemies closer than this push each other apart.' }),
});

/** Who may attack right now. One per world; an enemy takes a place before it starts a pattern and gives it back after. */
export class AttackTokens {
  private readonly holders: Node[] = [];
  /** Does the node hold a place. */
  has(n: Node): boolean { return this.holders.indexOf(n) >= 0; }
  get count(): number { return this.holders.length; }
  /** Whether a place is free for a node that has none. */
  free(): boolean { this.sweep(); return this.holders.length < brainTuning.maxAttackers; }
  acquire(n: Node): boolean {
    if (this.has(n)) return true;
    if (!this.free()) return false;
    this.holders.push(n);
    return true;
  }
  release(n: Node): void {
    const i = this.holders.indexOf(n);
    if (i >= 0) this.holders.splice(i, 1);
  }
  private sweep(): void {
    for (let i = this.holders.length - 1; i >= 0; i--) if (this.holders[i]!.destroyed) this.holders.splice(i, 1);
  }
}

const tokens = new WeakMap<World, AttackTokens>();
export function attackTokens(world: World): AttackTokens {
  let t = tokens.get(world);
  if (!t) { t = new AttackTokens(); tokens.set(world, t); }
  return t;
}

type Mode = 'spacing' | 'tell' | 'travel' | 'strike' | 'gap';

const TAU = Math.PI * 2;
export function turnToward(from: number, to: number, rate: number, dt: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  const step = rate * dt;
  return from + (Math.abs(d) <= step ? d : Math.sign(d) * step);
}

/**
 * Runs an enemy from its enemy config. Out of an attack it keeps its distance band to the target and circles; when
 * it thinks it picks a pattern the conditions allow (by weight, from the 'brain' random stream), takes a place in the
 * attack queue, shows the tell for the step's telegraph seconds, then starts the move through its Combatant. A
 * stagger or a broken posture drops the pattern and the place. Every number that decides anything is game time.
 */
export class EnemyBrain extends Behaviour {
  static override state = ['mode', 'modeT', 'patternIdx', 'stepIdx', 'cooldown', 'thinkT', 'circleDir', 'circleT', 'phase', 'dormant', 'travelTo'];
  /** Config id of the enemy ("enemy/swordsman" or "swordsman"). */
  enemy = '';
  /** The node to fight, by name. */
  targetName = 'player';
  mode: Mode = 'spacing';
  modeT = 0;
  patternIdx = -1;
  stepIdx = 0;
  cooldown = 0.8;
  thinkT = 0;
  circleDir = 1;
  circleT = 0;
  phase = 0;
  /** A dormant enemy stands and does nothing until `wake()` (an encounter that has not started, a standoff). */
  dormant = false;
  /** Distance to the target a travel step stops at. */
  travelTo = 0;
  /** Seconds a travel step has run, so a blocked enemy gives up. */
  private travelT = 0;

  /** Ends dormancy. */
  wake(): void { this.dormant = false; this.cooldown = Math.max(this.cooldown, 0.4); }
  readonly phaseChanged: Signal<[phase: number]> = signal<[number]>();
  /** (pattern name) each time a pattern starts. */
  readonly patternStarted: Signal<[name: string]> = signal<[string]>();

  combatant!: Combatant;
  private def: Enemy | null = null;
  private flags!: KitFlags;
  private hub!: CombatHub;
  private target: Node | null = null;
  private unwatch: (() => void) | null = null;
  private readonly eligible: number[] = [];

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.hub = combatHub(this.world);
    this.combatant = this.node.get(Combatant)!;
    const id = this.enemy.replace(/^enemy\//, '');
    this.def = config.lookup('enemy', id);
    this.unwatch = config.watch('enemy/' + id, (v) => { this.def = v as Enemy; });
    this.apply();
    this.circleDir = this.world.random('brain').chance(0.5) ? 1 : -1;
    this.circleT = brainTuning.circleFlip * (0.5 + this.world.random('brain').next());
    this.thinkT = this.world.random('brain').range(0, this.def.think ?? 0.3);
  }

  override dispose(): void {
    this.unwatch?.();
    attackTokens(this.world).release(this.node);
  }

  /** Copies the enemy's stats into its Combatant and Health. */
  private apply(): void {
    const d = this.def!, c = this.combatant;
    c.moveSet = d.moveSet;
    c.health.max = d.health;
    c.health.hp = d.health;
    if (d.posture) {
      c.maxPosture = d.posture.max;
      c.postureRecover = d.posture.recover;
      c.postureDelay = d.posture.delay;
      c.brokenSeconds = d.posture.broken;
    }
    c.weakTo = d.weakTo ?? '';
    c.finisherDamage = d.finisherDamage ?? 1;
  }

  private abort(): void {
    attackTokens(this.world).release(this.node);
    this.mode = 'spacing';
    this.patternIdx = -1;
    this.combatant.unblockableOverride = null;
    this.cooldown = Math.max(this.cooldown, 0.5);
  }

  override fixedUpdate(dt: number): void {
    const d = this.def, c = this.combatant;
    if (!d || this.flags.paused) return;
    if (c.state === 'dead') { attackTokens(this.world).release(this.node); return; }
    if (c.frozen > 0) return;
    if (this.dormant) { c.animator?.set('speed', 0); return; }
    if (c.state !== 'free' && c.state !== 'attack') { if (this.mode !== 'spacing' || this.patternIdx >= 0) this.abort(); return; }
    if (!this.target || this.target.destroyed) this.target = this.world.find(this.targetName) ?? null;
    const t = this.target;
    if (!t) return;
    const p = this.node.position;
    const dx = t.position.x - p.x, dz = t.position.z - p.z;
    const dist = Math.hypot(dx, dz);
    this.updatePhase(c);

    // Face the target except while a blow is in the air.
    if (c.state === 'free') this.node.rotation.y = turnToward(this.node.rotation.y, Math.atan2(-dx, -dz), d.speed?.turn ?? 6, dt);

    switch (this.mode) {
      case 'spacing': this.stepSpacing(d, c, dx, dz, dist, dt); break;
      case 'tell':
        this.modeT -= dt;
        if (this.modeT <= 0) this.beginMove(d, c);
        break;
      case 'travel': this.stepTravel(d, c, dx, dz, dist, dt); break;
      case 'strike': {
        const st = this.patternOf(d)?.steps[this.stepIdx];
        if (st?.feint && c.state === 'attack' && c.moveT >= st.feint) { c.cancelMove(); this.finishStep(d); break; }
        if (c.state !== 'attack') this.finishStep(d);
        break;
      }
      case 'gap':
        this.modeT -= dt;
        if (this.modeT <= 0) this.beginStep(d);
        break;
    }
  }

  private updatePhase(c: Combatant): void {
    const th = this.def!.phases;
    if (!th) return;
    const f = c.health.fraction;
    let ph = 0;
    for (let i = 0; i < th.length; i++) if (f <= th[i]!) ph = i + 1;
    if (ph !== this.phase) { this.phase = ph; this.cooldown = Math.max(this.cooldown, 0.6); this.phaseChanged.emit(ph); }
  }

  private patternOf(d: Enemy): EnemyPattern | undefined { return this.patternIdx >= 0 ? d.patterns[this.patternIdx] : undefined; }

  private stepSpacing(d: Enemy, c: Combatant, dx: number, dz: number, dist: number, dt: number): void {
    if (c.state !== 'free') return;
    const tk = attackTokens(this.world);
    const waiting = !(tk.has(this.node) || tk.free()) && d.spacing?.wait !== undefined;
    const lo = waiting ? d.spacing!.wait![0] : (d.spacing?.min ?? 1.6), hi = waiting ? d.spacing!.wait![1] : (d.spacing?.max ?? 3);
    const walk = dist > hi + 1.5 && d.speed?.run ? d.speed.run : (d.speed?.walk ?? 2.4), circle = d.speed?.circle ?? 1.4;
    const nx = dist > 1e-6 ? dx / dist : 0, nz = dist > 1e-6 ? dz / dist : -1;
    let mx = 0, mz = 0;
    if (dist > hi) { mx = nx * walk; mz = nz * walk; }
    else if (dist < lo) { mx = -nx * walk * 0.7; mz = -nz * walk * 0.7; }
    else {
      this.circleT -= dt;
      if (this.circleT <= 0) {
        const r = this.world.random('brain');
        if (r.chance(0.5)) this.circleDir = -this.circleDir;
        this.circleT = brainTuning.circleFlip * (0.5 + r.next());
      }
      mx = -nz * circle * this.circleDir; mz = nx * circle * this.circleDir;
    }
    // Enemies keep a little room from each other.
    const sep = brainTuning.separation;
    if (sep > 0) {
      const g = this.world.group(FIGHTERS);
      for (let i = 0; i < g.length; i++) {
        const o = g[i]!;
        if (o === this.node || o === this.target) continue;
        const ox = this.node.position.x - o.position.x, oz = this.node.position.z - o.position.z;
        const l = Math.hypot(ox, oz);
        if (l < sep && l > 1e-6) { mx += (ox / l) * (sep - l) * 2; mz += (oz / l) * (sep - l) * 2; }
      }
    }
    c.drive(mx * dt, mz * dt);
    c.animator?.set('speed', Math.hypot(mx, mz));

    this.cooldown -= dt;
    this.thinkT -= dt;
    if (this.cooldown <= 0 && this.thinkT <= 0) {
      this.thinkT = d.think ?? 0.3;
      this.consider(d, c, dist);
    }
  }

  private consider(d: Enemy, c: Combatant, dist: number): void {
    const tk = attackTokens(this.world);
    const hold = tk.has(this.node) || tk.free();
    const frac = c.health.fraction;
    const el = this.eligible;
    el.length = 0;
    let total = 0;
    for (let i = 0; i < d.patterns.length; i++) {
      const p = d.patterns[i]!;
      if (p.weight <= 0) continue;
      if (p.token !== false && !hold) continue;
      const w = p.when;
      const first = c.moveDef(p.steps.find((s) => s.move)?.move ?? '');
      const dr = w?.distance ?? [0, (first?.reach ?? 2) + 0.8];
      if (w?.stance && !w.stance.includes(this.targetStance())) continue;
      if (w?.clear !== undefined && this.friendNearTarget(w.clear)) continue;
      if (dist < dr[0] || dist > dr[1]) continue;
      if (w?.health && (frac < w.health[0] || frac > w.health[1])) continue;
      if (w?.phase && (this.phase < w.phase[0] || this.phase > w.phase[1])) continue;
      el.push(i);
      total += this.weightOf(p);
    }
    if (el.length === 0) return;
    let r = this.world.random('brain').next() * total;
    let pick = el[el.length - 1]!;
    for (let k = 0; k < el.length; k++) {
      r -= this.weightOf(d.patterns[el[k]!]!);
      if (r < 0) { pick = el[k]!; break; }
    }
    const pat = d.patterns[pick]!;
    if (pat.token !== false && !tk.acquire(this.node)) return;
    this.patternIdx = pick;
    this.stepIdx = 0;
    this.patternStarted.emit(pat.name);
    this.beginStep(d);
  }

  private beginStep(d: Enemy): void {
    const pat = this.patternOf(d)!;
    const st = pat.steps[this.stepIdx]!;
    this.mode = 'tell';
    this.modeT = st.telegraph;
    const m = st.move ? this.combatant.moveDef(st.move) : undefined;
    if (st.move) this.hub.tell.emit(this.combatant, (st.unblockable ?? m?.unblockable) ? 'unblockable' : 'glint');
    if (st.telegraph <= 0) this.beginMove(d, this.combatant);
  }

  /** Ends the tell: runs the step's travel first when it has one, then the move. */
  private beginMove(d: Enemy, c: Combatant): void {
    const st = this.patternOf(d)!.steps[this.stepIdx]!;
    const tr = st.travel;
    if (tr && this.target) {
      const dist = Math.hypot(this.target.position.x - this.node.position.x, this.target.position.z - this.node.position.z);
      this.travelTo = tr.to ?? Math.max(0.5, dist - (tr.by ?? 0));
      this.travelT = 0;
      this.mode = 'travel';
      if (this.travelTo > dist + 0.5) c.animator?.trigger('backstep');
      return;
    }
    this.startStepMove(d, c);
  }

  private startStepMove(d: Enemy, c: Combatant): void {
    const st = this.patternOf(d)!.steps[this.stepIdx]!;
    if (!st.move) { this.finishStep(d); return; }
    c.unblockableOverride = st.unblockable ?? null;
    if (!c.attack(st.move)) { this.abort(); return; }
    this.mode = 'strike';
  }

  private stepTravel(d: Enemy, c: Combatant, dx: number, dz: number, dist: number, dt: number): void {
    const tr = this.patternOf(d)!.steps[this.stepIdx]!.travel!;
    const speed = tr.speed ?? 5;
    this.travelT += dt;
    const need = dist - this.travelTo;
    if (Math.abs(need) < 0.08 || this.travelT > 2.5) { c.animator?.set('speed', 0); this.startStepMove(d, c); return; }
    const k = Math.min(Math.abs(need), speed * dt) * Math.sign(need);
    const l = dist > 1e-6 ? dist : 1;
    c.drive((dx / l) * k, (dz / l) * k);
    c.animator?.set('speed', speed);
  }

  private weightOf(p: EnemyPattern): number {
    const k = p.answers?.[this.targetStance()];
    return k === undefined ? p.weight : p.weight * k;
  }

  /** The stance the target fights in now ('' when it has none). */
  private targetStance(): string { return this.target?.get(Combatant)?.stance ?? ''; }

  private friendNearTarget(r: number): boolean {
    const t = this.target;
    if (!t) return false;
    const g = this.world.group(FIGHTERS);
    for (let i = 0; i < g.length; i++) {
      const o = g[i]!;
      if (o === this.node || o === t || o.destroyed) continue;
      const oc = o.get(Combatant);
      if (!oc || oc.state === 'dead' || oc.team !== this.combatant.team) continue;
      if (Math.hypot(o.position.x - t.position.x, o.position.z - t.position.z) < r) return true;
    }
    return false;
  }

  private finishStep(d: Enemy): void {
    const pat = this.patternOf(d)!;
    const st = pat.steps[this.stepIdx]!;
    this.stepIdx++;
    this.combatant.unblockableOverride = null;
    this.combatant.animator?.set('speed', 0);
    if (this.stepIdx >= pat.steps.length) {
      attackTokens(this.world).release(this.node);
      this.mode = 'spacing';
      this.patternIdx = -1;
      this.cooldown = pat.recover ?? 0.8;
      return;
    }
    this.mode = 'gap';
    this.modeT = st.gap ?? 0;
    if (this.modeT <= 0) this.beginStep(d);
  }

  /** Forward of the enemy, for tests. */
  get forward(): { x: number; z: number } { return { x: fwdX(this.node.rotation.y), z: fwdZ(this.node.rotation.y) }; }
}
