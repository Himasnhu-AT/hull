// Dev drawing for fights: the hurt shapes, the blade and where it swept, and a timeline above each fighter's head with
// the move's windows and a marker for where it is. Benches and the Studio use it; a ship build leaves it out.
import { Behaviour } from '../../core/index.ts';
import { debug } from '../../render/index.ts';
import { Combatant, FIGHTERS } from './combatant.ts';

interface V3 { x: number; y: number; z: number }
const a: V3 = { x: 0, y: 0, z: 0 };
const b: V3 = { x: 0, y: 0, z: 0 };

const line = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): void => {
  a.x = x0; a.y = y0; a.z = z0; b.x = x1; b.y = y1; b.z = z1;
  debug.line(a, b, color);
};

const WINDOW_COLOURS: [string, number, number][] = [['trace', 0xff3b30, 0], ['telegraph', 0xffd60a, 1], ['cancel', 0x34c759, 2], ['iframe', 0x0a84ff, 3]];

/** Draws every fighter in the world. Put it on any node. */
export class CombatDebug extends Behaviour {
  cameraName = 'camera';
  shapes = true;
  blades = true;
  timelines = true;

  override update(): void {
    const g = this.world.group(FIGHTERS);
    const cam = this.world.find(this.cameraName);
    const yaw = cam ? cam.rotation.y : 0;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    for (let i = 0; i < g.length; i++) {
      const c = g[i]!.get(Combatant);
      if (!c || c.state === 'dead' && !c.hurtShapes) continue;
      if (this.shapes) this.drawShapes(c);
      if (this.blades) this.drawBlade(c);
      if (this.timelines) this.drawTimeline(c, rx, rz);
    }
  }

  private drawShapes(c: Combatant): void {
    const s = c.hurtShapes;
    if (!s) {
      const p = c.node.position;
      line(p.x, p.y + 0.3, p.z, p.x, p.y + 1.5, p.z, 0x5ac8fa);
      return;
    }
    s.refresh(c.world.tick);
    const W = s.world;
    for (let k = 0; k < s.n; k++) {
      if (!s.isLive(k)) continue;
      const o = k * 7;
      if (s.isBox(k)) continue;
      const r = W[o + 6]!;
      const col = c.state === 'broken' ? 0xff9f0a : 0x5ac8fa;
      line(W[o]!, W[o + 1]!, W[o + 2]!, W[o + 3]!, W[o + 4]!, W[o + 5]!, col);
      // A cross at each end, as wide as the shape is thick, so the size can be read.
      for (const e of [0, 3]) {
        const x = W[o + e]!, y = W[o + e + 1]!, z = W[o + e + 2]!;
        line(x - r, y, z, x + r, y, z, col);
        line(x, y, z - r, x, y, z + r, col);
        line(x, y - r, z, x, y + r, z, col);
      }
    }
  }

  private drawBlade(c: Combatant): void {
    const bl = c.bladeView;
    if (!bl || !bl.armed) return;
    const live = c.windowOpen('trace');
    const p = bl.prev, q = bl.cur;
    const hot = live ? 0xff3b30 : 0xf2f2f7;
    line(q[0]!, q[1]!, q[2]!, q[3]!, q[4]!, q[5]!, hot);
    if (live) {
      // The swept area: where the blade was a step ago, and the paths of its two ends.
      line(p[0]!, p[1]!, p[2]!, p[3]!, p[4]!, p[5]!, 0xff9f0a);
      line(p[0]!, p[1]!, p[2]!, q[0]!, q[1]!, q[2]!, 0xff9f0a);
      line(p[3]!, p[4]!, p[5]!, q[3]!, q[4]!, q[5]!, 0xff9f0a);
    }
  }

  private drawTimeline(c: Combatant, rx: number, rz: number): void {
    const p = c.node.position;
    const L = 1.4;
    const x0 = p.x - rx * L / 2, z0 = p.z - rz * L / 2, y0 = p.y + 2.25;
    const at = (u: number): [number, number] => [x0 + rx * L * u, z0 + rz * L * u];
    // Posture, under the bar: fills toward the right.
    const pf = c.postureFraction;
    const [px0, pz0] = at(0), [px1, pz1] = at(pf);
    line(px0, y0 - 0.1, pz0, px1, y0 - 0.1, pz1, pf > 0.8 ? 0xff3b30 : 0xff9f0a);
    const m = c.move;
    if (!m) {
      const [ex, ez] = at(1);
      line(px0, y0, pz0, ex, y0, ez, 0x48484a);
      return;
    }
    const [sx, sz] = at(0), [ex, ez] = at(1);
    line(sx, y0, sz, ex, y0, ez, 0x636366);
    for (const [name, colour, row] of WINDOW_COLOURS) {
      const w = m.windows?.[name];
      if (!w) continue;
      const list = (typeof w[0] === 'number' ? [w] : w) as readonly (readonly number[])[];
      for (const r of list) {
        const [wx0, wz0] = at(Math.min(1, r[0]! / m.length)), [wx1, wz1] = at(Math.min(1, r[1]! / m.length));
        const y = y0 + 0.04 * (row + 1);
        line(wx0, y, wz0, wx1, y, wz1, colour);
        line(wx0, y + 0.01, wz0, wx1, y + 0.01, wz1, colour);
      }
    }
    const [mx, mz] = at(Math.min(1, c.moveT / m.length));
    line(mx, y0 - 0.06, mz, mx, y0 + 0.22, mz, 0xffffff);
  }
}
