// Ranged blows. A move's `shoot` makes a Projectile: a node that flies straight at where the target was and, near a
// fighter of another team, lands like a blade (the target's `receive`: i-frames, guard, deflect, clean hit). A deflect or a
// perfect deflect turns it around at the shooter; a block or a hit ends it; a dodge lets it fly on. Game time only.
import { Behaviour, type Node } from '../../core/index.ts';
import { poseNow } from './trace.ts';
import { Combatant, FIGHTERS, newAttack, combatTuning } from './combatant.ts';
import type { Move } from '../../schema/index.ts';
import { combatHub } from './hub.ts';

export class Projectile extends Behaviour {
  static override state = ['vx', 'vy', 'vz', 'travelled', 'team', 'returned'];
  vx = 0; vy = 0; vz = 0;
  speed = 24;
  range = 40;
  radius = 0.35;
  travelled = 0;
  team = '';
  returned = false;
  shooter: Combatant | null = null;
  move: Move | null = null;
  moveName = '';
  private readonly atk = newAttack();
  private readonly passed: Combatant[] = [];

  override fixedUpdate(dt: number): void {
    const p = this.node.position;
    const step = this.speed * dt;
    p.x += this.vx * dt; p.y += this.vy * dt; p.z += this.vz * dt;
    this.travelled += step;
    // Point the node along its flight so a mesh reads as an arrow.
    this.node.rotation.y = Math.atan2(-this.vx, -this.vz);
    const g = this.world.group(FIGHTERS);
    for (let i = 0; i < g.length; i++) {
      const c = g[i]!.get(Combatant);
      if (!c || c.state === 'dead' || c.team === this.team || this.passed.indexOf(c) >= 0) continue;
      const q = c.node.position;
      if (p.y < q.y - 0.1 || p.y > q.y + 2) continue;
      if (Math.hypot(p.x - q.x, p.z - q.z) > this.radius + combatTuning.bodyRadius * 0.5) continue;
      if (this.land(c)) return;
    }
    if (this.travelled >= this.range) this.node.destroy();
  }

  /** Returns true when the projectile is spent. */
  private land(c: Combatant): boolean {
    const a = this.atk, m = this.move, p = this.node.position;
    a.attacker = this.shooter; a.move = this.moveName;
    a.damage = m?.damage ?? 10; a.posture = m?.posture ?? 8; a.zone = 'body';
    a.unblockable = m?.unblockable ?? false; a.guardBreak = m?.guardBreak ?? 1;
    a.stagger = m?.stagger ?? -1; a.knockback = m?.knockback ?? 0; a.hitStop = m?.hitStop ?? -1;
    a.heavy = false; a.finisher = false; a.stance = '';
    a.fromX = p.x - this.vx * 0.05; a.fromZ = p.z - this.vz * 0.05;
    a.x = p.x; a.y = p.y; a.z = p.z;
    const out = c.receive(a);
    if (out === 'dodged') { this.passed.push(c); return false; }
    if ((out === 'deflected' || out === 'perfect') && !this.returned && this.shooter && !this.shooter.node.destroyed) {
      // Sent back at the one who shot it, from where it was caught.
      const s = this.shooter.node.position;
      const dx = s.x - p.x, dz = s.z - p.z, dy = s.y + 1.2 - p.y;
      const l = Math.hypot(dx, dy, dz) || 1;
      this.vx = (dx / l) * this.speed * 1.2; this.vy = (dy / l) * this.speed * 1.2; this.vz = (dz / l) * this.speed * 1.2;
      this.team = c.team;
      this.returned = true;
      this.passed.length = 0;
      this.shooter = c;
      this.travelled = 0;
      return false;
    }
    this.node.destroy();
    return true;
  }
}

/** Releases a shot of `move` from `who` at its nearest enemy; null when there is nobody to shoot. */
export function fireShot(who: Combatant, name: string, move: Move): Node | null {
  const sh = move.shoot;
  if (!sh) return null;
  const world = who.world;
  const a = who.animator;
  const p0 = who.node.position;
  let ox = p0.x, oy = p0.y + 1.3, oz = p0.z;
  const sock = a?.socket(sh.socket ?? who.set?.weapon.socket ?? '');
  if (a && sock) {
    poseNow(a, world.tick);
    const e = sock.matrixWorld.elements;
    ox = e[12]!; oy = e[13]!; oz = e[14]!;
  }
  let best: Combatant | null = null, bd = 1e9;
  const g = world.group(FIGHTERS);
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!.get(Combatant);
    if (!c || c === who || c.state === 'dead' || c.team === who.team) continue;
    const d = Math.hypot(c.node.position.x - p0.x, c.node.position.z - p0.z);
    if (d < bd) { bd = d; best = c; }
  }
  if (!best) return null;
  const tx = best.node.position.x, ty = best.node.position.y + 1.1, tz = best.node.position.z;
  const dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const l = Math.hypot(dx, dy, dz) || 1;
  const speed = sh.speed ?? 24;
  const n = world.spawn('shot');
  n.position.set(ox, oy, oz);
  const pr = n.add(Projectile, { speed, range: sh.range ?? 40, radius: sh.radius ?? 0.35, team: who.team, shooter: who, move, moveName: name });
  pr.vx = (dx / l) * speed; pr.vy = (dy / l) * speed; pr.vz = (dz / l) * speed;
  combatHub(world).shot.emit(who, n);
  return n;
}
