// The Ashfall Band's moves. Each raider is solved against its own body; the move-set files hold the same lengths, trace
// windows and lunge distances (the kit moves the node by the lunge, the clip carries the same travel in the hips).
import type { ClipSpec } from './bake.ts';
import { Rig, type Frame, type Key, type V3 } from './rig.ts';
import { advance, home, torso, type Authored } from './aya.ts';

type Pose = Partial<Frame>;
type Ease = Key['ease'];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const K = (t: number, ease: Ease, o: Pose): Key => ({ t, ease, ...o });
const sorted = (ks: Key[]): Key[] => ks.slice().sort((a, b) => a.t - b.t);
const mk = (b: Frame, length: number, keys: Key[], win: ClipSpec['windows'], extra: Partial<ClipSpec> = {}): Authored => ({ base: b, spec: { length, root: true, keys: sorted(keys), windows: win, ...extra } });
/** Hips travel d between t0 and t1 with the feet stepping through: the lunge of the move-set. */
const lunge = (b: Frame, d: number, t0: number, t1: number, dip = 0.05): Key[] => [
  K(t0, 'smooth', { hips: add(b.hips, [0, -dip, 0]) }),
  K(t1, 'in', { hips: add(b.hips, [0, -dip * 1.2, d]) }),
  ...advance(b, d, t0 - 0.03, t1 + 0.04, 0.08),
];

export function raiderClips(dir: string): Record<string, Authored> {
  const o: Record<string, Authored> = {};
  const cfg = (n: string): string => dir + '/character/' + n + '.json';
  const h = 0.075;

  // ---- Ashblade ----
  {
    const rig = new Rig(cfg('ashblade'), 0.96, 0.14, -0.13);
    const b = rig.stand({
      hips: [0, -0.05, 0], hipsR: [0, 0.1, 0], spine: [0.04, 0, 0], head: [-0.03, -0.1, 0], hand: [0.16, 0.22, 0.42], blade: [0.15, 0.3, 0.95],
      footR: [0.12, h, 0.25], footL: [-0.18, h, -0.25], footTurnL: -0.5,
    });
    o['sword-cut'] = { ...mk(b, 0.55, [
      K(0.2, 'out', { hand: [0.12, 0.74, 0.08], blade: [0.12, 0.95, -0.3], ...torso(0.5, -0.15), hips: [0, -0.02, -0.05] }),
      K(0.25, 'smooth', { hand: [0.12, 0.78, 0.04], blade: [0.12, 0.95, -0.35], ...torso(0.55, -0.2) }),
      K(0.37, 'in', { hand: [0.03, 0.2, 0.78], blade: [0.0, -0.2, 0.98], ...torso(-0.1, 0.5) }),
      K(0.44, 'out', { hand: [0.03, 0.12, 0.76], blade: [0.0, -0.4, 0.92] }),
      ...lunge(b, 0.4, 0.15, 0.3), home(b, 0.55, 0.4),
    ], { telegraph: [0.12, 0.25], trace: [0.25, 0.37] }, { events: { telegraph: 0.12, hit: 0.3 } }), base: b, rig } as Authored;
    o['sword-cross'] = { ...mk(b, 0.6, [
      K(0.16, 'out', { hand: [0.42, 0.34, 0.3], blade: [0.8, 0.2, 0.55], ...torso(0.7, 0.05) }),
      K(0.2, 'smooth', { hand: [0.44, 0.34, 0.3], blade: [0.82, 0.2, 0.5] }),
      K(0.32, 'in', { hand: [-0.16, 0.34, 0.8], blade: [-0.5, 0.0, 0.86], ...torso(-0.7, 0.4) }),
      K(0.4, 'out', { hand: [-0.24, 0.3, 0.74], blade: [-0.6, -0.1, 0.8] }),
      ...lunge(b, 0.3, 0.12, 0.26), home(b, 0.6, 0.3),
    ], { telegraph: [0.1, 0.2], trace: [0.2, 0.32] }, { events: { telegraph: 0.1, hit: 0.26 } }), base: b, rig } as Authored;
    o['sword-feint'] = { ...mk(b, 0.5, [
      K(0.2, 'out', { hand: [0.12, 0.74, 0.08], blade: [0.12, 0.95, -0.3], ...torso(0.5, -0.15), hips: [0, -0.02, -0.05] }),
      K(0.26, 'snap', { hand: [0.2, 0.3, 0.38], blade: [0.3, 0.2, 0.9], ...torso(0.1, 0.2), hips: [0, -0.1, -0.1] }),
      home(b, 0.5, 0),
    ], { telegraph: [0.1, 0.2] }, { events: { telegraph: 0.1 } }), base: b, rig } as Authored;
    // Shared small moves, solved on this body.
    o['back-step'] = { ...mk(b, 0.4, [
      K(0.06, 'out', { hips: [0, -0.16, 0.0], ...torso(0.1, 0.25) }),
      K(0.2, 'smooth', { hips: [0, 0.0, -0.6] }),
      K(0.3, 'in', { hips: [0, -0.14, -1.2], ...torso(0, 0.2) }),
      K(0.06, 'out', { footR: [0.12, h + 0.03, 0.25], footL: [-0.18, h + 0.03, -0.25] }),
      K(0.2, 'smooth', { footR: [0.12, 0.3, -0.35], footL: [-0.18, 0.28, -0.85] }),
      K(0.3, 'in', { footR: [0.12, h, 0.25 - 1.2], footL: [-0.18, h, -0.25 - 1.2] }),
      home(b, 0.4, -1.2),
    ], { cancel: [0.3, 0.4] }), base: b, rig } as Authored;
  }

  // ---- Ashpike ----
  {
    const rig = new Rig(cfg('ashpike'), 1.4, 0.3, 0.6);
    const b = rig.stand({
      hips: [0, -0.08, 0], hipsR: [0, 0.35, 0], spine: [0.05, 0.1, 0], chest: [0.02, 0.1, 0], head: [-0.03, -0.45, 0], hand: [0.2, 0.27, 0.1], blade: [0.05, 0.1, 0.99],
      footL: [-0.12, h, 0.3], footR: [0.2, h, -0.2], footTurnR: 0.7, footTurnL: -0.2,
    });
    o['spear-thrust'] = { ...mk(b, 0.7, [
      K(0.28, 'out', { hand: [0.2, 0.3, -0.12], blade: [0.04, 0.1, 0.99], ...torso(0.55, 0.05), hips: [0, -0.16, -0.06] }),
      K(0.33, 'smooth', { hand: [0.2, 0.3, -0.16], hips: [0, -0.17, -0.08] }),
      K(0.45, 'in', { hand: [0.14, 0.28, 0.72], blade: [0.0, 0.08, 1.0], ...torso(-0.1, 0.25) }),
      K(0.52, 'out', { hand: [0.14, 0.27, 0.7] }),
      ...lunge(b, 0.8, 0.28, 0.42, 0.06), home(b, 0.7, 0.8),
    ], { telegraph: [0.15, 0.33], trace: [0.33, 0.45] }, { events: { telegraph: 0.15, hit: 0.38 } }), base: b, rig } as Authored;
    o['spear-sweep'] = { ...mk(b, 0.85, [
      K(0.38, 'out', { hand: [0.5, 0.36, 0.0], blade: [0.95, -0.1, -0.3], ...torso(0.9, 0.05), hips: [0, -0.2, -0.04] }),
      K(0.43, 'smooth', { hand: [0.52, 0.34, 0.05], blade: [0.95, -0.2, 0.15], ...torso(0.95, 0.1) }),
      K(0.505, 'linear', { hand: [0.1, 0.18, 0.55], blade: [0.0, -0.35, 0.94], ...torso(0.0, 0.3) }),
      K(0.58, 'in', { hand: [-0.45, 0.2, 0.3], blade: [-0.95, -0.2, 0.2], ...torso(-0.9, 0.2) }),
      K(0.68, 'out', { hand: [-0.5, 0.25, 0.2], blade: [-0.98, -0.05, 0.1] }),
      ...lunge(b, 0.4, 0.3, 0.5, 0.06), home(b, 0.85, 0.4),
    ], { telegraph: [0.15, 0.43], trace: [0.43, 0.58] }, { events: { telegraph: 0.15, hit: 0.5 } }), base: b, rig } as Authored;
  }

  // ---- Cinder Hulk ----
  {
    const rig = new Rig(cfg('hulk'), 1.3, 0.35, 0.35);
    const b = rig.stand({
      hips: [0, -0.08, 0], hipsR: [0, 0.05, 0], spine: [0.1, 0, 0], head: [0.04, 0, 0], hand: [0.3, 0.5, 0.1], blade: [0.2, 0.8, -0.55],
      footR: [0.2, h, 0.15], footL: [-0.25, h, -0.15], footTurnL: -0.3, footTurnR: 0.2, elbR: [0.5, -0.5, -0.25], elbL: [-0.5, -0.5, -0.25],
    });
    o['hulk-smash'] = { ...mk(b, 1.2, [
      K(0.62, 'out', { hand: [0.16, 0.98, -0.02], blade: [0.0, 1.0, -0.2], ...torso(0.15, -0.3), hips: [0, 0.0, -0.1] }),
      K(0.7, 'smooth', { hand: [0.16, 1.0, -0.04], blade: [0.0, 1.0, -0.3], hips: [0, 0.02, -0.12] }),
      K(0.85, 'in', { hand: [0.1, 0.22, 0.86], blade: [0.0, -0.25, 0.97], ...torso(0, 0.6), hips: [0, -0.35, 0.5] }),
      K(0.95, 'out', { hand: [0.1, 0.12, 0.84], blade: [0.0, -0.4, 0.92] }),
      ...lunge(b, 0.5, 0.55, 0.8, 0.14), home(b, 1.2, 0.5),
    ], { telegraph: [0.1, 0.7], trace: [0.7, 0.85] }, { events: { telegraph: 0.1, hit: 0.77 } }), base: b, rig } as Authored;
    o['hulk-grab'] = { ...mk(b, 1.1, [
      K(0.24, 'out', { hand: [0.7, 0.45, 0.1], blade: [0.9, 0.0, 0.3], left: [-0.7, 0.45, 0.1], leftDir: [-1, 0, 0], ...torso(0.4, 0.0), hips: [0, -0.1, -0.08] }),
      K(0.34, 'smooth', { hand: [0.72, 0.46, 0.12], blade: [0.92, 0.0, 0.3], left: [-0.72, 0.46, 0.12] }),
      K(0.5, 'in', { hand: [-0.1, 0.42, 0.78], blade: [-0.5, 0.05, 0.86], left: [0.2, 0.4, 0.7], ...torso(-0.5, 0.45), hips: [0, -0.18, 0.5] }),
      K(0.62, 'out', { hand: [-0.2, 0.4, 0.7], blade: [-0.6, 0.0, 0.8], left: [0.1, 0.4, 0.68] }),
      ...lunge(b, 0.5, 0.2, 0.4, 0.08), home(b, 1.1, 0.5),
    ], { telegraph: [0.05, 0.35], trace: [0.35, 0.5] }, { events: { telegraph: 0.05, hit: 0.42 } }), base: b, rig } as Authored;
  }

  // ---- Ashkite ----
  {
    const rig = new Rig(cfg('ashkite'), 0.5, 0, 0);
    const b = rig.stand({
      hips: [0, -0.05, 0], hipsR: [0, 0.5, 0], spine: [0, 0.15, 0], chest: [0, 0.2, 0], head: [-0.02, -0.7, 0],
      left: [-0.12, 0.42, 0.5], bow: 0.0, hand: [0.15, 0.35, 0.2], blade: [0, 0, 1],
      footL: [-0.1, h, 0.28], footR: [0.2, h, -0.22], footTurnR: 0.9, footTurnL: -0.2, elbL: [-0.4, -0.3, -0.2],
    });
    o['bow-shoot'] = { ...mk(b, 1.0, [
      K(0.15, 'out', { left: [-0.1, 0.5, 0.52], hand: [0.16, 0.45, 0.28], blade: [-1, 0, 0], ...torso(0.6, 0.0) }),
      K(0.5, 'smooth', { hand: [0.2, 0.52, -0.1], blade: [-1, 0, -0.1], left: [-0.1, 0.55, 0.58], hips: [0, -0.08, -0.04], elbR: [0.7, 0.2, -0.3] }),
      K(0.58, 'smooth', { hand: [0.2, 0.53, -0.12], left: [-0.1, 0.56, 0.58] }),
      K(0.62, 'snap', { hand: [0.35, 0.5, -0.0], blade: [-0.7, 0.1, 0.2], left: [-0.1, 0.56, 0.56], elbR: [0.7, 0.2, -0.3] }),
      K(0.75, 'out', { hand: [0.3, 0.4, 0.15], left: [-0.1, 0.46, 0.5] }),
      home(b, 1.0, 0),
    ], { telegraph: [0.0, 0.6], draw: [0.1, 0.6] }, { events: { draw: 0.1, loose: 0.6 } }), base: b, rig } as Authored;
  }

  // ---- Kagari ----
  {
    const rig = new Rig(cfg('kagari'), 1.3, 0.14, -0.13);
    const b = rig.stand({
      hips: [0, -0.06, 0], hipsR: [0, 0.3, 0], spine: [0.04, 0.1, 0], chest: [0.02, 0.1, 0], head: [-0.02, -0.4, 0], hand: [0.18, 0.24, 0.32], blade: [0.05, 0.05, 1.0],
      footR: [0.15, h, 0.3], footL: [-0.15, h, -0.28], footTurnL: -0.7, footTurnR: 0.3,
    });
    o['duel-cut'] = { ...mk(b, 0.6, [
      K(0.18, 'out', { hand: [0.2, 0.7, 0.05], blade: [0.2, 0.9, -0.4], ...torso(0.6, -0.1) }),
      K(0.2, 'smooth', { hand: [0.2, 0.72, 0.04], blade: [0.2, 0.9, -0.42] }),
      K(0.32, 'in', { hand: [-0.04, 0.2, 0.72], blade: [-0.2, -0.15, 0.97], ...torso(-0.5, 0.5) }),
      K(0.4, 'out', { hand: [-0.08, 0.14, 0.7], blade: [-0.3, -0.35, 0.89] }),
      ...lunge(b, 0.5, 0.1, 0.26), home(b, 0.6, 0.5),
    ], { telegraph: [0.1, 0.2], trace: [0.2, 0.32] }, { events: { telegraph: 0.1, hit: 0.26 } }), base: b, rig } as Authored;
    o['duel-thrust'] = { ...mk(b, 0.65, [
      K(0.23, 'out', { hand: [0.28, 0.32, -0.1], blade: [0.1, 0.1, 1.0], ...torso(0.7, 0.1), hips: [0, -0.14, -0.06] }),
      K(0.25, 'smooth', { hand: [0.28, 0.32, -0.13], hips: [0, -0.15, -0.08] }),
      K(0.37, 'in', { hand: [0.12, 0.3, 0.74], blade: [0.0, 0.05, 1.0], ...torso(-0.1, 0.3) }),
      K(0.46, 'out', { hand: [0.12, 0.29, 0.72] }),
      ...lunge(b, 0.8, 0.15, 0.33, 0.06), home(b, 0.65, 0.8),
    ], { telegraph: [0.1, 0.25], trace: [0.25, 0.37] }, { events: { telegraph: 0.1, hit: 0.31 } }), base: b, rig } as Authored;
    o['duel-sweep'] = { ...mk(b, 0.8, [
      K(0.3, 'out', { hand: [0.5, 0.2, 0.0], blade: [0.95, -0.2, -0.2], ...torso(0.9, 0.2), hips: [0, -0.22, -0.04] }),
      K(0.32, 'smooth', { hand: [0.52, 0.2, 0.05], blade: [0.95, -0.25, 0.1], ...torso(0.95, 0.25) }),
      K(0.39, 'linear', { hand: [0.1, 0.12, 0.6], blade: [0.0, -0.3, 0.95], ...torso(0, 0.35) }),
      K(0.46, 'in', { hand: [-0.45, 0.14, 0.34], blade: [-0.95, -0.25, 0.2], ...torso(-0.9, 0.3) }),
      K(0.58, 'out', { hand: [-0.5, 0.2, 0.2], blade: [-1.0, -0.1, 0.1] }),
      ...lunge(b, 0.6, 0.22, 0.4, 0.06), home(b, 0.8, 0.6),
    ], { telegraph: [0.12, 0.32], trace: [0.32, 0.46] }, { events: { telegraph: 0.12, hit: 0.39 } }), base: b, rig } as Authored;
    o['duel-rush'] = { ...mk(b, 0.9, [
      K(0.4, 'out', { hand: [0.3, 0.3, -0.15], blade: [0.1, 0.1, 1.0], ...torso(0.8, 0.3), hips: [0, -0.25, -0.1] }),
      K(0.5, 'smooth', { hand: [0.3, 0.3, -0.18] }),
      K(0.58, 'in', { hand: [0.12, 0.3, 0.76], blade: [0.0, 0.05, 1.0], ...torso(-0.1, 0.4), hips: [0, -0.28, 0.2] }),
      K(0.68, 'out', { hand: [0.12, 0.29, 0.74] }),
      home(b, 0.9, 0),
    ], { telegraph: [0.0, 0.5], trace: [0.5, 0.62] }, { events: { telegraph: 0.05, hit: 0.55 } }), base: b, rig } as Authored;
    o['duel-phase'] = { ...mk(b, 1.4, [
      K(0.35, 'out', { hand: [0.1, 0.9, 0.05], blade: [0.05, 0.98, -0.2], ...torso(0.3, -0.35), hips: [0, 0.0, 0] }),
      K(0.8, 'smooth', { hand: [0.12, 0.95, 0.1], blade: [0.1, 0.98, 0.0], ...torso(-0.25, -0.4), hips: [0, 0.02, 0] }),
      K(1.0, 'in', { hand: [0.3, 0.3, 0.45], blade: [0.7, -0.2, 0.7], ...torso(0.5, 0.3), hips: [0, -0.2, 0.0] }),
      home(b, 1.4, 0),
    ], { telegraph: [0.0, 0.8] }, { events: { telegraph: 0.0 } }), base: b, rig } as Authored;
  }
  return o;
}
