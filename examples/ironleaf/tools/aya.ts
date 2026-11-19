// Aya's moves. Times follow GAME.md section 5 (active = the blade sweep). Everything is a key on top of the stance
// pose; a key only moves the fields it names. Eases name how the way INTO a key travels: 'in' lands hard, 'out' settles.
// Coordinates are [right, up, forward] from the hips joint for the hands, from the ground for the feet.
import type { ClipSpec } from './bake.ts';
import type { Rig, Frame, Key, V3, Ease } from './rig.ts';

export type Stance = 'stone' | 'water' | 'wind';
export interface Authored { base: Frame; spec: ClipSpec }

export function ayaStances(rig: Rig): Record<Stance, Frame> {
  const h = rig.dims.footH ?? 0.075;
  return {
    // Planted: wide, low, point at the throat, right foot forward.
    stone: rig.stand({
      hips: [0, -0.07, 0], hipsR: [0.02, 0.1, 0], spine: [0.05, 0, 0], chest: [0.03, 0.05, 0], head: [-0.04, -0.1, 0],
      hand: [0.04, 0.28, 0.46], blade: [0, 0.28, 0.96],
      footR: [0.13, h, 0.3], footL: [-0.17, h, -0.22], footTurnL: -0.55, footTurnR: 0.05,
    }),
    // Flowing: sword low at the hip, point down toward the enemy's knees, weight on a bent back leg.
    water: rig.stand({
      hips: [0, -0.1, -0.03], hipsR: [0.03, 0.35, 0], spine: [0.08, 0.15, 0], chest: [0.04, 0.2, 0], head: [-0.08, -0.4, 0],
      hand: [0.3, 0.1, 0.34], blade: [-0.2, -0.12, 0.97],
      footR: [0.2, h, 0.34], footL: [-0.14, h, -0.2], footTurnL: -0.9, footTurnR: 0.3,
    }),
    // Light: sword raised by the right shoulder, point back, narrow feet, up on the front foot.
    wind: rig.stand({
      hips: [0, -0.04, 0], hipsR: [0.0, 0.25, 0], spine: [0.02, 0.1, 0], chest: [0.0, 0.2, 0], head: [-0.02, -0.3, 0],
      hand: [0.24, 0.5, 0.12], blade: [0.1, 0.75, -0.65],
      footR: [0.1, h, 0.2], footL: [-0.12, h, -0.26], footTurnL: -0.7, footTurnR: 0.2, footPitchL: 0.18,
    }),
  };
}

type Pose = Partial<Frame>;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** Body twist split over hips, spine and chest, the head looks the other way to keep its eyes on the target. */
export const torso = (turn: number, lean = 0, roll = 0): Pose => ({
  hipsR: [lean * 0.3, turn * 0.3, roll * 0.3], spine: [lean * 0.3, turn * 0.3, roll * 0.3], chest: [lean * 0.4, turn * 0.4, roll * 0.4], head: [-lean * 0.5, -turn * 0.85, 0],
});
const K = (t: number, ease: Ease | undefined, o: Pose): Key => ({ t, ease, ...o });
const sorted = (ks: Key[]): Key[] => ks.slice().sort((a, b) => a.t - b.t);

/** A step of the feet that carries the stance forward by d between t0 and t1: front foot first, back foot follows. */
export function advance(b: Frame, d: number, t0: number, t1: number, lift = 0.1): Key[] {
  const h = b.footR[1], m = t0 + (t1 - t0) * 0.5;
  return [
    K(m, 'out', { footR: [b.footR[0], h + lift, b.footR[2] + d * 0.7] }),
    K(t0 + (t1 - t0) * 0.7, 'in', { footR: [b.footR[0], h, b.footR[2] + d] }),
    K(m + (t1 - m) * 0.4, 'out', { footL: [b.footL[0], h + lift * 0.5, b.footL[2] + d * 0.5] }),
    K(t1, 'in', { footL: [b.footL[0], h, b.footL[2] + d] }),
  ];
}
/** Back to the stance (hips carry the travel d). */
export const home = (b: Frame, t: number, d = 0, ease: Ease = 'smooth'): Key =>
  K(t, ease, { hand: b.hand, blade: b.blade, hips: add(b.hips, [0, 0, d]), hipsR: b.hipsR, spine: b.spine, chest: b.chest, neck: b.neck, head: b.head, roll: 0 });
/** The hips travel d over [t0, t1], with a dip. */
const travel = (b: Frame, d: number, t0: number, t1: number, dip = 0.04, ease: Ease = 'in'): Key[] => [
  K(t0, 'smooth', { hips: add(b.hips, [0, -dip, 0]) }),
  K(t1, ease, { hips: add(b.hips, [0, -dip * 1.5, d]) }),
];
const mk = (b: Frame, length: number, keys: Key[], win: ClipSpec['windows'], extra: Partial<ClipSpec> = {}): Authored => ({ base: b, spec: { length, root: true, keys: sorted(keys), windows: win, ...extra } });

/** A horizontal spin: the blade goes all the way round at radius r, hips and feet turning with it. */
function spin(b: Frame, t0: number, t1: number, n: number, turns: number, hu: number, bu: number, r = 0.4, f0 = 0.15): Key[] {
  const out: Key[] = [];
  for (let i = 1; i <= n; i++) {
    const a = turns * 2 * Math.PI * (i / n);
    const sa = Math.sin(a), ca = Math.cos(a);
    out.push(K(t0 + ((t1 - t0) * i) / n, i === 1 ? 'in' : 'linear', {
      hand: [r * sa + 0.0, hu, r * ca * 0.8 + f0], blade: [sa, bu, ca], hipsR: [0.05, a * 0.5, 0], spine: [0.1, a * 0.25, 0], chest: [0.1, a * 0.25, 0], head: [0, -a * 0.3, 0],
      footTurnL: b.footTurnL + a, footTurnR: b.footTurnR + a,
    }));
  }
  return out;
}

export function ayaClips(rig: Rig): Record<string, Authored> {
  const S = ayaStances(rig);
  const o: Record<string, Authored> = {};
  const st = S.stone, wa = S.water, wi = S.wind;
  const h = rig.dims.footH ?? 0.075;

  // ---- Stone: planted, one step per cut ----
  o['stone-1'] = mk(st, 0.46, [
    K(0.09, 'out', { hand: [0.2, 0.66, 0.1], blade: [0.3, 0.8, -0.5], ...torso(0.9, 0.0) }),
    K(0.2, 'in', { hand: [-0.08, 0.1, 0.42], blade: [-0.5, -0.3, 0.8], ...torso(-0.8, 0.5) }),
    K(0.27, 'out', { hand: [-0.16, 0.04, 0.44], blade: [-0.55, -0.45, 0.7] }),
    ...travel(st, 0.3, 0.04, 0.2), ...advance(st, 0.3, 0.02, 0.3), home(st, 0.46, 0.3),
  ], { trace: [0.09, 0.2], cancel: [0.3, 0.46] }, { events: { hit: 0.15 } });
  o['stone-2'] = mk(st, 0.44, [
    K(0.09, 'out', { hand: [0.3, 0.0, 0.4], blade: [0.45, -0.4, 0.8], ...torso(0.8, 0.4) }),
    K(0.19, 'in', { hand: [-0.12, 0.7, 0.28], blade: [-0.45, 0.75, 0.5], ...torso(-0.7, 0.0) }),
    K(0.26, 'out', { hand: [-0.2, 0.74, 0.18], blade: [-0.5, 0.82, 0.2] }),
    ...travel(st, 0.25, 0.04, 0.19), ...advance(st, 0.25, 0.02, 0.3), home(st, 0.44, 0.25),
  ], { trace: [0.09, 0.19], cancel: [0.3, 0.44] }, { events: { hit: 0.14 } });
  o['stone-3'] = mk(st, 0.8, [
    K(0.12, 'out', { hand: [0.06, 0.8, 0.1], blade: [0.0, 0.95, -0.3], ...torso(0.2, -0.3), hips: [0, -0.04, 0] }),
    K(0.28, 'smooth', { hand: [0.06, 0.86, 0.04], blade: [0.0, 0.95, -0.4], hips: [0, -0.03, 0.05] }),
    K(0.42, 'in', { hand: [0.04, 0.12, 0.55], blade: [0.0, -0.35, 0.94], ...torso(0, 0.55), hips: [0, -0.2, 0.3] }),
    K(0.5, 'out', { hand: [0.04, 0.06, 0.55], blade: [0.0, -0.45, 0.9] }),
    ...advance(st, 0.4, 0.14, 0.4, 0.14), home(st, 0.8, 0.4),
  ], { trace: [0.3, 0.42], cancel: [0.58, 0.8] }, { events: { hit: 0.37 } });
  o['stone-heavy'] = mk(st, 0.85, [
    K(0.1, 'out', { hand: [0.2, 0.7, -0.05], blade: [0.2, 0.9, -0.5], ...torso(0.7, -0.2) }),
    K(0.3, 'smooth', { hand: [0.12, 0.88, -0.08], blade: [0.1, 0.98, -0.45], ...torso(0.45, -0.4), hips: [0, -0.1, -0.06] }),
    K(0.46, 'in', { hand: [0.02, 0.1, 0.58], blade: [0.0, -0.4, 0.92], ...torso(-0.1, 0.65), hips: [0, -0.24, 0.3] }),
    K(0.55, 'out', { hand: [0.02, 0.02, 0.56], blade: [0.0, -0.55, 0.85] }),
    ...advance(st, 0.4, 0.14, 0.42, 0.14), home(st, 0.85, 0.4),
  ], { trace: [0.32, 0.46], cancel: [0.64, 0.85] }, { events: { hit: 0.4 } });
  o['stone-charge'] = mk(st, 1.1, [
    K(0.25, 'out', { hand: [0.3, 0.45, -0.25], blade: [0.35, 0.5, -0.8], ...torso(0.9, -0.1), hips: [0, -0.2, -0.12], footR: [0.13, h, 0.3] }),
    K(0.45, 'smooth', { hand: [0.34, 0.5, -0.28], blade: [0.4, 0.55, -0.75], hips: [0, -0.22, -0.14] }),
    K(0.58, 'smooth', { hand: [0.12, 0.92, -0.1], blade: [0.05, 0.98, -0.3], ...torso(0.3, -0.45), hips: [0, -0.1, -0.05] }),
    K(0.78, 'in', { hand: [0.0, 0.08, 0.6], blade: [0.0, -0.3, 0.95], ...torso(-0.15, 0.75), hips: [0, -0.3, 0.65] }),
    K(0.88, 'out', { hand: [0.0, 0.0, 0.6], blade: [0.0, -0.5, 0.86] }),
    K(0.1, 'out', { footL: [st.footL[0], h, st.footL[2] - 0.1] }),
    ...advance(st, 0.7, 0.58, 0.8, 0.14), home(st, 1.1, 0.7),
  ], { charge: [0.15, 0.58], trace: [0.62, 0.78], cancel: [0.9, 1.1] }, { events: { hit: 0.7 } });

  // ---- Water: four flowing cuts, a rising heavy, a spin ----
  const wcut = (len: number, from: [V3, V3], to: [V3, V3], turnA: number, turnB: number, d: number, extra: Key[] = []): Authored =>
    mk(wa, len, [
      K(0.08, 'out', { hand: from[0], blade: from[1], ...torso(turnA, 0.1) }),
      K(0.17, 'in', { hand: to[0], blade: to[1], ...torso(turnB, 0.2) }),
      K(0.24, 'out', { hand: add(to[0], [to[0][0] * 0.3, 0, 0]), blade: [to[1][0] * 1.1, to[1][1], to[1][2] * 0.9] }),
      ...travel(wa, d, 0.02, 0.17, 0.03), ...advance(wa, d, 0.02, 0.26, 0.08), ...extra, home(wa, len, d),
    ], { trace: [0.08, 0.17], cancel: [0.26, len] }, { events: { hit: 0.13 } });
  o['water-1'] = wcut(0.4, [[0.38, 0.2, 0.3], [0.8, 0.05, 0.6]], [[-0.32, 0.2, 0.42], [-0.85, 0.0, 0.52]], 0.8, -0.8, 0.14);
  o['water-2'] = wcut(0.4, [[-0.34, 0.24, 0.35], [-0.8, 0.1, 0.58]], [[0.4, 0.22, 0.34], [0.85, -0.05, 0.52]], -0.7, 0.9, 0.14);
  o['water-3'] = wcut(0.4, [[0.34, 0.0, 0.36], [0.5, -0.5, 0.7]], [[-0.2, 0.6, 0.35], [-0.5, 0.65, 0.55]], 0.7, -0.6, 0.14);
  o['water-4'] = wcut(0.4, [[-0.3, 0.1, 0.3], [-0.85, -0.2, 0.45]], [[0.45, -0.18, 0.55], [0.9, -0.4, 0.2]], -0.9, 1.0, 0.2, [
    K(0.1, 'out', { hips: [0, -0.28, 0.05] }), K(0.2, 'smooth', { hips: [0, -0.34, 0.2] }),
  ]);
  o['water-heavy'] = mk(wa, 0.7, [
    K(0.12, 'out', { hand: [0.34, -0.1, 0.28], blade: [0.5, -0.7, 0.55], ...torso(0.9, 0.35), hips: [0, -0.28, 0.0] }),
    K(0.22, 'in', { hand: [-0.1, 0.78, 0.34], blade: [-0.45, 0.8, 0.4], ...torso(-0.6, 0.0), hips: [0, -0.1, 0.18] }),
    K(0.34, 'out', { hand: [-0.2, 0.84, 0.2], blade: [-0.4, 0.9, 0.0] }),
    ...advance(wa, 0.35, 0.1, 0.34, 0.08), home(wa, 0.7, 0.35),
  ], { trace: [0.22, 0.34], cancel: [0.5, 0.7] }, { events: { hit: 0.28 } });
  o['water-charge'] = (() => {
    const keys: Key[] = [
      K(0.2, 'out', { hand: [0.3, 0.2, -0.2], blade: [0.4, -0.1, -0.9], ...torso(1.0, 0.1), hips: [0, -0.3, -0.05] }),
      K(0.5, 'smooth', { hand: [0.34, 0.22, -0.24], blade: [0.5, -0.05, -0.85], hips: [0, -0.32, -0.06] }),
      ...spin(wa, 0.55, 0.8, 8, 1.15, 0.2, -0.02, 0.45, 0.1),
      K(0.84, 'out', { hand: [0.3, 0.2, 0.3], blade: [0.5, 0.0, 0.85] }),
      home(wa, 1.0, 0),
    ];
    return mk(wa, 1.0, keys, { charge: [0.1, 0.55], trace: [0.55, 0.8], cancel: [0.85, 1.0] }, { events: { hit: 0.62 } });
  })();

  // ---- Wind: light, circles and cuts the legs ----
  const wind1 = mk(wi, 0.36, [
    K(0.07, 'out', { hand: [0.28, 0.66, 0.0], blade: [0.2, 0.85, -0.55], ...torso(0.9, 0.0) }),
    K(0.16, 'in', { hand: [-0.12, 0.08, 0.44], blade: [-0.55, -0.25, 0.8], ...torso(-0.7, 0.45) }),
    K(0.22, 'out', { hand: [-0.2, 0.02, 0.4], blade: [-0.6, -0.4, 0.65] }),
    ...travel(wi, 0.25, 0.02, 0.16, 0.02), ...advance(wi, 0.25, 0.0, 0.22, 0.12), home(wi, 0.36, 0.25),
  ], { trace: [0.07, 0.16], cancel: [0.24, 0.36] }, { events: { hit: 0.12 } });
  o['wind-1'] = wind1;
  o['wind-2'] = mk(wi, 0.36, [
    K(0.07, 'out', { hand: [-0.2, 0.05, 0.4], blade: [-0.6, -0.35, 0.7], ...torso(-0.8, 0.4) }),
    K(0.16, 'in', { hand: [0.26, 0.66, 0.1], blade: [0.3, 0.8, -0.4], ...torso(0.8, 0.0) }),
    K(0.22, 'out', { hand: [0.26, 0.64, 0.02], blade: [0.2, 0.82, -0.5] }),
    ...travel(wi, 0.25, 0.02, 0.16, 0.02), ...advance(wi, 0.25, 0.0, 0.22, 0.12), home(wi, 0.36, 0.25),
  ], { trace: [0.07, 0.16], cancel: [0.24, 0.36] }, { events: { hit: 0.12 } });
  o['wind-heavy'] = mk(wi, 0.6, [
    K(0.1, 'out', { hand: [0.2, 0.34, -0.15], blade: [0.2, 0.15, -0.95], ...torso(1.0, 0.1), hips: [0, -0.22, -0.1] }),
    K(0.18, 'smooth', { hand: [0.2, 0.34, -0.2], blade: [0.2, 0.18, -0.95], hips: [0, -0.24, -0.1] }),
    K(0.3, 'in', { hand: [0.06, 0.38, 0.64], blade: [0.02, 0.02, 1.0], ...torso(-0.2, 0.35), hips: [0, -0.26, 0.7] }),
    K(0.4, 'out', { hand: [0.06, 0.36, 0.62], blade: [0.0, -0.05, 1.0] }),
    ...advance(wi, 0.8, 0.12, 0.34, 0.1), home(wi, 0.6, 0.8),
  ], { trace: [0.18, 0.3], cancel: [0.44, 0.6] }, { events: { hit: 0.24 } });
  o['wind-charge'] = (() => {
    const air = (y: number): Key => K(0, 'smooth', { hips: [0, y, 0] });
    return mk(wi, 1.0, [
      K(0.25, 'out', { hand: [0.3, 0.3, -0.2], blade: [0.3, 0.5, -0.85], ...torso(1.0, 0.2), hips: [0, -0.34, -0.1] }),
      K(0.42, 'smooth', { hips: [0, -0.38, -0.12] }),
      // up and over: hips rise and travel, feet tuck, the blade comes over the head
      K(0.52, 'out', { hips: [0, 0.4, 0.6], hand: [0.1, 0.95, 0.05], blade: [0.05, 0.98, -0.2], ...torso(0.3, -0.35), footR: [0.2, 0.55, 0.7], footL: [-0.15, 0.4, 0.4], kneeR: [0.2, 0, 0.5], kneeL: [-0.2, 0, 0.5] }),
      K(0.62, 'smooth', { hips: [0, 0.28, 1.0], hand: [0.05, 0.95, 0.15], blade: [0.0, 0.9, 0.4] }),
      K(0.7, 'in', { hips: [0, -0.2, 1.3], hand: [0.04, 0.1, 0.55], blade: [0.0, -0.4, 0.9], ...torso(-0.1, 0.6), footR: [0.13, h, 1.4], footL: [-0.17, h, 1.0], kneeR: [0.12, -0.1, 0.6], kneeL: [-0.12, -0.1, 0.6] }),
      K(0.78, 'out', { hips: [0, -0.22, 1.3], hand: [0.04, 0.02, 0.55], blade: [0.0, -0.5, 0.86] }),
      K(0.58, 'smooth', { footR: [0.3, 0.45, 0.9], footL: [-0.2, 0.3, 0.7] }),
      K(0.78, 'smooth', { footR: [wi.footR[0], h, wi.footR[2] + 1.3], footL: [wi.footL[0], h, wi.footL[2] + 1.3] }),
      home(wi, 1.0, 1.3),
    ], { charge: [0.1, 0.5], trace: [0.52, 0.7], cancel: [0.82, 1.0] }, { events: { hit: 0.64 } });
  })();
  void air0;
  return o;
}
const air0 = 0;
