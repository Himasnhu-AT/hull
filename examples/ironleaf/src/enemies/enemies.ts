// The Ashfall Band as fighters: each kind is an enemy config (config/enemy) run by the combat kit's EnemyBrain. This file
// places them, keeps them still until their encounter starts, runs the camp and the duel standoffs, and wires what they
// tell (glint, red flash) and shoot (arrows) to effects. The patterns themselves are data: read GAME.md section 6.
import { Behaviour, signal, type Node, type Signal, type World } from 'hull';
import { Animator } from 'hull/anim';
import { vfx } from 'hull/vfx';
import { Mesh } from 'hull/render';
import { Combatant, combatHub, EnemyBrain, GROUP, kitIO, spawnEnemy, Standoff } from 'hull/kits';
import { dressFighter, type Kind } from '../models';
import { CAST, groundHeight } from '../world/map';

/** Which cast ids stand together, how far away the player starts it, and whether it opens with a standoff. */
export interface EncounterDef { name: string; match: (id: string) => boolean; wake: number; standoff?: boolean; sting?: string }

export const ENCOUNTERS: EncounterDef[] = [
  { name: 'camp', match: (id) => id.startsWith('camp-'), wake: 17, standoff: true, sting: 'sound/music/sting-start' },
  { name: 'gate', match: (id) => id.startsWith('gate-'), wake: 15, sting: 'sound/music/sting-start' },
  { name: 'rock', match: (id) => id.startsWith('rock-'), wake: 34 },
  { name: 'duel', match: (id) => id.startsWith('stairs-'), wake: 13, standoff: true, sting: 'sound/music/sting-duel' },
];

/**
 * The archer's aim line: a thin red line from the bow to the target while it draws (the tell) and until the arrow is
 * loosed, so a shot can be read and answered (GAME.md section 6). Shown on the fixed step so it follows the interpolated body.
 */
export class AimLine extends Behaviour {
  private line: Node | null = null;
  private c!: Combatant;
  private brain!: EnemyBrain;
  private target: Node | null = null;

  override ready(): void {
    this.c = this.node.get(Combatant)!;
    this.brain = this.node.get(EnemyBrain)!;
    const l = this.world.spawn('aim-line');
    l.add(Mesh, { shape: 'box', color: '#ff2a1c', castShadow: false, receiveShadow: false });
    l.rotation.order = 'YXZ';
    l.object3d.visible = false;
    this.line = l;
  }

  override dispose(): void { this.line?.destroy(); this.line = null; }

  override fixedUpdate(): void {
    const l = this.line, c = this.c;
    if (!l) return;
    const m = c.move;
    const drawing = (this.brain.mode === 'tell' && this.brain.patternIdx >= 0) || (c.state === 'attack' && !!m?.shoot && c.moveT < m.shoot.at);
    if (!drawing || c.isDead || this.brain.dormant) { l.object3d.visible = false; return; }
    if (!this.target || this.target.destroyed) this.target = this.world.find(this.brain.targetName) ?? null;
    const t = this.target;
    if (!t) { l.object3d.visible = false; return; }
    const p = this.node.position, q = t.position;
    const ax = p.x, ay = p.y + 1.3, az = p.z, bx = q.x, by = q.y + 1.1, bz = q.z;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const hd = Math.hypot(dx, dz), len = Math.hypot(hd, dy);
    l.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    l.rotation.set(Math.atan2(dy, hd), Math.atan2(-dx, -dz), 0);
    l.scale.set(0.03, 0.03, len);
    l.object3d.visible = true;
  }
}

/** Keeps a fighter's feet on the island's ground. */
export class Grounded extends Behaviour {
  override fixedUpdate(): void {
    const p = this.node.position;
    p.y = groundHeight(p.x, p.z);
  }
}

export interface Raider { node: Node; kind: string; id: string; encounter: string; combatant: Combatant; brain: EnemyBrain }

export class Encounter {
  started = false;
  cleared = false;
  constructor(readonly def: EncounterDef, readonly members: Raider[]) {}
  get alive(): Raider[] { return this.members.filter((r) => !r.combatant.isDead); }
  get centre(): { x: number; z: number } {
    let x = 0, z = 0;
    for (const m of this.members) { x += m.node.position.x; z += m.node.position.z; }
    const n = Math.max(1, this.members.length);
    return { x: x / n, z: z / n };
  }
}

/**
 * Places the raiders and runs their encounters. A group is dormant until the player comes within its wake distance;
 * the camp and the duel open with a standoff (the player's release is `director.standoff.release()`), and the group wakes
 * when that resolves. Add it after the player is spawned.
 */
export class EncounterDirector extends Behaviour {
  raiders: Raider[] = [];
  encounters: Encounter[] = [];
  standoffs = true;
  /** The standoff in progress, or null. */
  standoff: Standoff | null = null;
  private standing: Encounter | null = null;
  readonly started: Signal<[name: string]> = signal<[string]>();
  readonly cleared: Signal<[name: string]> = signal<[string]>();
  /** (kind, phase) a boss changed phase. */
  readonly phase: Signal<[kind: string, phase: number]> = signal<[string, number]>();

  override ready(): void {
    const w = this.world;
    for (const c of CAST) this.raiders.push(this.place(w, c.id, c.kind, c.x, c.z, c.yaw));
    for (const def of ENCOUNTERS) {
      const e = new Encounter(def, this.raiders.filter((r) => r.encounter === def.name));
      if (e.members.length) this.encounters.push(e);
    }
    combatHub(w).tell.connect((who, kind) => tellEffect(who, kind), this.node);
    combatHub(w).shot.connect((_who, shot) => arrowLook(shot), this.node);
    this.standoff = this.node.add(Standoff);
  }

  private place(w: World, id: string, kind: string, x: number, z: number, yaw: number): Raider {
    const n = spawnEnemy(w, kind, { name: id, x, z, yaw, target: 'player' });
    n.position.y = groundHeight(x, z);
    n.add(Grounded);
    const model = n.children.find((c) => c.name === 'model');
    const an = model?.get(Animator);
    if (an) an.ground = groundHeight;
    dressFighter(n, kind as Kind);
    if (kind === 'ashkite') n.add(AimLine);
    const brain = n.get(EnemyBrain)!;
    brain.dormant = true;
    const combatant = n.get(Combatant)!;
    combatant.killed.connect(() => {
      // The body lies there a while, then is gone: game time, so a replay does the same.
      w.after(6, () => { if (!n.destroyed) n.destroy(); });
    }, n);
    if (kind === 'kagari') brain.phaseChanged.connect((p) => {
      this.phase.emit(kind, p);
      combatant.animator?.trigger('duel-phase');
      kitIO.play('sound/music/sting-duel');
      const q = n.position;
      vfx.burst('embers', { x: q.x, y: q.y + 1, z: q.z });
    }, n);
    const enc = ENCOUNTERS.find((d) => d.match(id))?.name ?? 'camp';
    return { node: n, kind, id, encounter: enc, combatant, brain };
  }

  /** Every raider of a kind still standing (tests, the HUD). */
  alive(kind?: string): Raider[] { return this.raiders.filter((r) => !r.node.destroyed && !r.combatant.isDead && (!kind || r.kind === kind)); }

  /** Wakes an encounter's raiders now. */
  wake(e: Encounter): void {
    if (e.started) return;
    e.started = true;
    for (const r of e.members) if (!r.node.destroyed) r.brain.wake();
    if (e.def.sting) kitIO.play(e.def.sting);
    this.started.emit(e.def.name);
  }

  override fixedUpdate(): void {
    const me = this.world.find('player');
    if (!me) return;
    const mc = me.get(Combatant);
    const so = this.standoff;
    if (this.standing && so && !so.active) {
      // The standoff is over (won, lost, or cut short): the group fights.
      const e = this.standing;
      this.standing = null;
      this.wake(e);
    }
    for (const e of this.encounters) {
      if (!e.cleared && e.started && e.alive.length === 0) { e.cleared = true; this.cleared.emit(e.def.name); }
      if (e.started || e === this.standing || e.alive.length === 0) continue;
      const c = e.centre;
      if (Math.hypot(me.position.x - c.x, me.position.z - c.z) > e.def.wake) continue;
      if (e.def.standoff && this.standoffs && mc && so && !this.standing) {
        // The nearest raider of the group is the one who waits for the player's move.
        let lead: Raider | null = null, best = 1e9;
        for (const r of e.alive) {
          const d = Math.hypot(me.position.x - r.node.position.x, me.position.z - r.node.position.z);
          if (d < best) { best = d; lead = r; }
        }
        if (lead) { this.standing = e; so.begin(mc, lead.combatant); continue; }
      }
      this.wake(e);
    }
  }
}

/** The tell: a glint on the blade tip, or a red flash around the body for what only a dodge can avoid. */
function tellEffect(who: Combatant, kind: string): void {
  const p = who.node.position;
  if (kind === 'unblockable') { vfx.burst('tell-red', { x: p.x, y: p.y + 1.1, z: p.z }); return; }
  const b = who.bladeView;
  if (b && b.cur[3] !== 0) vfx.burst('tell-glint', { x: b.cur[3]!, y: b.cur[4]!, z: b.cur[5]! });
  else vfx.burst('tell-glint', { x: p.x, y: p.y + 1.3, z: p.z });
}

/** The look of an arrow: a thin pale shaft along its flight. */
function arrowLook(shot: Node): void {
  shot.scale.set(0.035, 0.035, 0.9);
  shot.add(Mesh, { shape: 'box', color: '#e6d9b8', castShadow: false });
}

/** Spawns the cast. The node it returns holds the director; `encounters(world)` finds it again. */
export function spawnEncounters(world: World, opts: { standoffs?: boolean } = {}): EncounterDirector {
  const n = world.spawn('encounters');
  const d = n.add(EncounterDirector);
  d.standoffs = opts.standoffs ?? true;
  return d;
}

export function encounters(world: World): EncounterDirector | null {
  return world.find('encounters')?.get(EncounterDirector) ?? null;
}

void GROUP;
