// hull:optional-actions: the actions read here do nothing until the game's input map defines them, so check does not demand them.
import { Behaviour, type Node } from '../../core/index.ts';
import { num, tunables } from '../../config/index.ts';
import { flagsOf, fwdX, fwdZ, type KitFlags } from '../common.ts';
import { FollowCamera } from '../follow-camera/follow-camera.ts';
import { kitIO } from '../io.ts';
import { Combatant, FIGHTERS } from './combatant.ts';
import { combatHub } from './hub.ts';

export const lockTuning = tunables('lockOn', {
  range: num(14, { min: 3, max: 60, step: 1, unit: 'm', help: 'Farthest a target can be picked.' }),
  breakRange: num(20, { min: 3, max: 80, step: 1, unit: 'm', help: 'A locked target farther than this is let go.' }),
  arc: num(200, { min: 30, max: 360, step: 5, unit: 'deg', help: 'Targets must be inside this arc of where the view looks.' }),
});

/**
 * Picks the best lock-on target: the nearest candidate inside the arc, with a pull toward the middle of the view.
 * Candidates are x, z pairs; the view looks along (fx, fz). Returns an index into the list or -1. `skip` is an index to
 * pass over (cycling to the next one).
 */
export function pickLockTarget(px: number, pz: number, fx: number, fz: number, xs: ArrayLike<number>, zs: ArrayLike<number>, n: number, range: number, arcDeg: number, skip = -1): number {
  const cos = Math.cos((arcDeg * Math.PI) / 360);
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < n; i++) {
    if (i === skip) continue;
    const dx = xs[i]! - px, dz = zs[i]! - pz;
    const d = Math.hypot(dx, dz);
    if (d > range || d < 1e-6) continue;
    const c = (dx * fx + dz * fz) / d;
    if (c < cos) continue;
    // Distance counts for most; the target nearer the middle of the view gets up to 30% off.
    const score = d * (1.3 - 0.3 * c);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

const xs: number[] = [];
const zs: number[] = [];
const nodes: Node[] = [];

/**
 * Lock-on for the player: `toggle()` picks the target nearest the view's middle, `cycle()` moves to the next one, and
 * the camera keeps the target in front while it lives and stays in range. Drives the `lock` action (press) if the game
 * maps one. The camera's shake is wired here too: the combat hub's shake signal reaches the FollowCamera.
 */
export class LockOn extends Behaviour {
  static override state = ['lockedName'];
  cameraName = 'camera';
  lockedName = '';
  target: Node | null = null;
  private cam: FollowCamera | null = null;
  private flags!: KitFlags;
  private wired = false;

  override ready(): void { this.flags = flagsOf(this.world); }

  private camera(): FollowCamera | null {
    if (!this.cam) {
      this.cam = this.world.find(this.cameraName)?.get(FollowCamera) ?? null;
      if (this.cam && !this.wired) {
        this.wired = true;
        const cam = this.cam;
        combatHub(this.world).shake.connect((a, s) => cam.shake(a, s), this.node);
      }
    }
    return this.cam;
  }

  toggle(): Node | null {
    if (this.target) { this.release(); return null; }
    return this.pick(-1);
  }

  /** Locks the next best target after the current one (or the best, when none is locked). */
  cycle(): Node | null { return this.pick(this.target ? nodes.indexOf(this.target) : -1); }

  release(): void {
    this.target = null;
    this.lockedName = '';
    const c = this.camera();
    if (c) c.lockTarget = null;
  }

  private pick(skipNode: number): Node | null {
    const cam = this.camera();
    const me = this.node.get(Combatant);
    xs.length = 0; zs.length = 0; nodes.length = 0;
    const g = this.world.group(FIGHTERS);
    for (let i = 0; i < g.length; i++) {
      const n = g[i]!;
      const c = n.get(Combatant);
      if (n === this.node || !c || c.state === 'dead' || (me && me.team !== '' && c.team === me.team)) continue;
      xs.push(n.position.x); zs.push(n.position.z); nodes.push(n);
    }
    const yaw = cam ? cam.yaw : this.node.rotation.y;
    // The view looks away from where the camera sits: forward is (-sin, -cos).
    const i = pickLockTarget(this.node.position.x, this.node.position.z, fwdX(yaw), fwdZ(yaw), xs, zs, nodes.length, lockTuning.range, lockTuning.arc, skipNode);
    const t = i >= 0 ? nodes[i]! : null;
    this.target = t;
    this.lockedName = t ? t.name : '';
    if (cam) cam.lockTarget = t;
    return t;
  }

  override fixedUpdate(): void {
    if (this.flags.paused) return;
    this.camera();
    if (kitIO.input.action('lock').pressed) this.toggle();
    if (kitIO.input.action('lockNext').pressed) this.cycle();
    const t = this.target;
    if (!t) return;
    const c = t.get(Combatant);
    const d = Math.hypot(t.position.x - this.node.position.x, t.position.z - this.node.position.z);
    if (t.destroyed || !c || c.state === 'dead' || d > lockTuning.breakRange) this.pick(-1);
  }
}
