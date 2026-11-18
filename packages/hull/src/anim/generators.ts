// Generators that ship with the engine: humanoid idle, walk and run, and two additive helpers (breathing, sway).
// Lengths are authored for a 1.78 m body and scale with the skeleton: strides with its height, cycle times with the
// square root of it, so a 15 m giant takes long slow steps instead of a blur of tiny fast ones.
import { registerGenerator, type Generated, type GeneratorFactory } from './clip.ts';
import type { Pose, Skeleton } from './skeleton.ts';

const TAU = Math.PI * 2;

/** Writes a rotation only if the skeleton has the bone, so the humanoid generators do not crash on a custom body. */
function rot(pose: Pose, i: number, x: number, y: number, z: number): void {
  if (i >= 0) pose.setEuler(i, x, y, z);
}

interface Bones {
  hips: number; spine: number; chest: number; neck: number; head: number;
  arm: [number, number]; fore: [number, number]; hand: [number, number];
  leg: [number, number]; shin: [number, number]; foot: [number, number];
}

function bonesOf(s: Skeleton): Bones {
  const i = (n: string): number => s.index(n);
  return {
    hips: i('hips'), spine: i('spine'), chest: i('chest'), neck: i('neck'), head: i('head'),
    arm: [i('armL'), i('armR')], fore: [i('forearmL'), i('forearmR')], hand: [i('handL'), i('handR')],
    leg: [i('legL'), i('legR')], shin: [i('shinL'), i('shinR')], foot: [i('footL'), i('footR')],
  };
}

const k = (knobs: Readonly<Record<string, number>>, name: string, fallback: number): number => knobs[name] ?? fallback;

const idle: GeneratorFactory = (skel, knobs): Generated => {
  const b = bonesOf(skel);
  const breath = k(knobs, 'breath', 0.02);
  const sway = k(knobs, 'sway', 0.015);
  const s = skel.scale;
  return {
    length: 4 * Math.sqrt(s),
    travel: 0,
    sample(ph, pose) {
      const a = ph * TAU;
      const br = Math.sin(a);
      const sw = Math.sin(a * 0.5);
      for (let side = 0; side < 2; side++) {
        const out = side === 0 ? -1 : 1;
        rot(pose, b.arm[side]!, 0.03 - breath * 0.6 * br, 0, out * (0.07 + breath * 0.8 * br));
        rot(pose, b.fore[side]!, 0.2, 0, 0);
        rot(pose, b.hand[side]!, 0, 0, 0);
        rot(pose, b.leg[side]!, 0.04, 0, out * 0.03);
        rot(pose, b.shin[side]!, -0.08, 0, 0);
        rot(pose, b.foot[side]!, 0.04, 0, 0);
      }
      rot(pose, b.spine, -breath * 0.5 * br, 0.4 * sway * sw, sway * 2 * sw);
      rot(pose, b.chest, -breath * 2.2 * br, 0, 0);
      rot(pose, b.neck, breath * 0.8 * br, 0, 0);
      rot(pose, b.head, 0, -0.3 * sway * sw, -sway * sw);
      if (b.hips >= 0) {
        // Weight shifts a little from foot to foot; the knees are slightly bent, so the hips sit a touch lower.
        pose.setOffset(b.hips, sway * 1.2 * s * sw, -0.012 * s, 0);
        pose.setEuler(b.hips, 0, 0, -sway * 1.5 * sw);
      }
    },
  };
};

function gait(run: boolean): GeneratorFactory {
  return (skel, knobs): Generated => {
    const b = bonesOf(skel);
    const s = skel.scale;
    const d = skel.dims;
    const legLen = d ? d.thigh + d.shin : 0.85 * s;
    const stride = k(knobs, 'stride', run ? 1.5 : 0.72) * s;
    const armSwing = k(knobs, 'armSwing', run ? 0.8 : 0.6);
    const lean = k(knobs, 'lean', run ? 0.16 : 0.03);
    const bounce = k(knobs, 'bounce', run ? 0.05 : 0.0) * s;
    const sway = k(knobs, 'sway', run ? 0.01 : 0.02) * s;
    const length = (run ? 0.56 : 1.0) * Math.sqrt(s);
    // Step length is how far apart the feet land. A straight leg of length L that swings +-A puts them 2 L sin(A) apart.
    const amp = Math.min(Math.asin(Math.min(stride / (2 * legLen), 0.95)), run ? 0.95 : 0.7);
    const kneeBase = run ? 0.3 : 0.07;
    const kneeSwing = run ? 1.5 : 0.85;
    const elbow = run ? 1.35 : 0.3;
    return {
      length,
      travel: (2 * stride) / length,
      sample(phase, pose) {
        const a = phase * TAU;
        const sa = Math.sin(a);
        for (let side = 0; side < 2; side++) {
          const ph = a + side * Math.PI;
          const sp = Math.sin(ph);
          const swing = Math.max(0, Math.cos(ph));
          const thigh = amp * sp;
          const knee = -(kneeBase + kneeSwing * swing * swing);
          rot(pose, b.leg[side]!, thigh, 0, 0);
          rot(pose, b.shin[side]!, knee, 0, 0);
          // Keep the sole flat to the ground, with a little toe-off when the leg trails behind.
          rot(pose, b.foot[side]!, -(thigh + knee) * 0.85 + 0.25 * Math.max(0, -sp) * (run ? 1.3 : 0.6), 0, 0);
          const out = side === 0 ? -1 : 1;
          rot(pose, b.arm[side]!, -armSwing * amp * 0.95 * sp, 0, out * (run ? 0.12 : 0.06));
          rot(pose, b.fore[side]!, elbow + 0.25 * Math.max(0, -sp) * armSwing, 0, 0);
          rot(pose, b.hand[side]!, 0, 0, 0);
        }
        // Shoulders turn against the hips; the head stays level and looks ahead.
        rot(pose, b.spine, -lean * 0.6, 0.1 * amp * sa, 0);
        rot(pose, b.chest, -lean * 0.4, 0.22 * amp * sa, 0.03 * Math.cos(a));
        rot(pose, b.neck, lean * 0.3, -0.2 * amp * sa, 0);
        rot(pose, b.head, lean * 0.5, 0, 0);
        if (b.hips >= 0) {
          // A straight leg swung by A lifts the foot by L(1 - cos A), so the hips drop that much at full spread.
          const drop = legLen * (1 - Math.cos(amp * Math.abs(sa)));
          const hop = run ? -bounce * Math.cos(2 * a) : 0;
          pose.setOffset(b.hips, sway * sa, -drop + hop, 0);
          pose.setEuler(b.hips, 0, -0.18 * amp * sa, 0.03 * sa);
        }
      },
    };
  };
}

// Additive helpers: deltas for an additive layer, so a breathing chest rides on top of whatever the body is doing.
const breathe: GeneratorFactory = (skel, knobs): Generated => {
  const b = bonesOf(skel);
  const amount = k(knobs, 'amount', 0.025);
  return {
    length: 3.6 * Math.sqrt(skel.scale),
    travel: 0,
    sample(ph, pose) {
      const x = Math.sin(ph * TAU);
      rot(pose, b.chest, -amount * 2 * x, 0, 0);
      rot(pose, b.spine, -amount * 0.6 * x, 0, 0);
      rot(pose, b.neck, amount * 0.8 * x, 0, 0);
      rot(pose, b.arm[0]!, 0, 0, -amount * 1.5 * x);
      rot(pose, b.arm[1]!, 0, 0, amount * 1.5 * x);
    },
  };
};

const swayGen: GeneratorFactory = (skel, knobs): Generated => {
  const b = bonesOf(skel);
  const amount = k(knobs, 'amount', 0.02);
  const s = skel.scale;
  return {
    length: 5 * Math.sqrt(s),
    travel: 0,
    sample(ph, pose) {
      const x = Math.sin(ph * TAU);
      rot(pose, b.spine, 0, 0.5 * amount * x, amount * 1.5 * x);
      rot(pose, b.head, 0, -0.4 * amount * x, -amount * x);
      if (b.hips >= 0) pose.setOffset(b.hips, amount * s * x, 0, 0);
    },
  };
};

let installed = false;
export function installGenerators(): void {
  if (installed) return;
  installed = true;
  registerGenerator('humanoid/idle', idle);
  registerGenerator('humanoid/walk', gait(false));
  registerGenerator('humanoid/run', gait(true));
  registerGenerator('procedural/breathe', breathe);
  registerGenerator('procedural/sway', swayGen);
}
installGenerators();
