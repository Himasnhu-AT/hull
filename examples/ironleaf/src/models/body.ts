// The common body every raider and Kagari wears under their gear: tapered tubes for the torso, neck, arms and legs, an
// ellipsoid head, boots. Sizes follow the character's own humanoid dimensions (the skeleton's), so a clip's reach
// lands on the model. Each character then adds its own layers on top.
import type { HumanoidDims } from 'hull/anim';
import { ball, ell, slab, tube, type Builder, type V3 } from './kit';

export interface Style {
  skin: string;
  torso: string;
  arms: string;
  legs: string;
  boots: string;
  /** Belly and chest thickness multipliers. */
  belly?: number;
  chest?: number;
  /** Radius multiplier on the limbs. */
  limb?: number;
  /** Colour of the forearm below the elbow (bare skin, wraps). */
  forearm?: string;
}

/** The size of the head: radii of its ellipsoid. */
export const headRadii = (d: HumanoidDims): V3 => [d.head * 0.39, d.head * 0.5, d.head * 0.45];

export function base(b: Builder, d: HumanoidDims, s: Style): void {
  const H = d.height, B = d.build, belly = s.belly ?? 1, chest = s.chest ?? 1, L = s.limb ?? 1;
  // Hips and torso: one rounded column from the crotch to the collarbone.
  b.add('hips', s.legs, ell([0, -0.05 * H, 0], [0, 0.012, 0], 0.088 * H * B, 0.06 * H * B, 0.082 * H * B, 0.056 * H * B, 10));
  b.add('spine', s.torso, ell([0, -0.012, 0], [0, d.spineLen + 0.01, 0], 0.075 * H * B * belly, 0.056 * H * B * belly, 0.085 * H * B * chest, 0.058 * H * B * chest, 10));
  b.add('chest', s.torso, ell([0, -0.01, 0], [0, d.chestLen, 0], d.shoulders * 0.4 * chest, 0.062 * H * B * chest, d.shoulders * 0.36 * chest, 0.05 * H * B * chest, 10));
  b.add('neck', s.skin, tube([0, -0.012 * H, 0], [0, d.neckLen + 0.012 * H, 0], 0.03 * H * B, 0.027 * H * B, 7));
  const hr = headRadii(d);
  b.add('head', s.skin, ball([0, d.head * 0.5, 0], hr, 10, 8));
  b.both((sx, side) => {
    const arm = 'arm' + side, fore = 'forearm' + side, hand = 'hand' + side;
    b.add(arm, s.arms, ball([0, 0, 0], 0.044 * H * B * L, 8, 6), tube([0, 0, 0], [0, -d.upperArm, 0], 0.033 * H * B * L, 0.027 * H * B * L, 8));
    b.add(fore, s.forearm ?? s.arms, ball([0, 0, 0], 0.028 * H * B * L, 7, 5), tube([0, 0, 0], [0, -d.foreArm, 0], 0.027 * H * B * L, 0.021 * H * B * L, 8));
    b.add(hand, s.skin, ball([0, -d.hand * 0.42, 0], [0.026 * H, d.hand * 0.58, 0.032 * H], 7, 5));
    const leg = 'leg' + side, shin = 'shin' + side, foot = 'foot' + side;
    b.add(leg, s.legs, ball([0, 0, 0], 0.052 * H * B * L, 8, 6), tube([0, 0, 0], [0, -d.thigh, 0], 0.049 * H * B * L, 0.035 * H * B * L, 8));
    b.add(shin, s.legs, ball([0, 0, 0], 0.036 * H * B * L, 7, 5), tube([0, 0, 0], [0, -d.shin, 0], 0.035 * H * B * L, 0.025 * H * B * L, 8));
    b.add(foot, s.boots, slab([0, -d.footH * 0.5, -d.footLen * 0.28], [0.066 * H * B, d.footH, d.footLen]),
      slab([0, -d.footH * 0.9, -d.footLen * 0.33], [0.07 * H * B, d.footH * 0.22, d.footLen * 1.04]));
    void sx;
  });
}

/** A strip of cloth that hangs from a bone down to the next bone of its chain. Torn at the end. */
export function ragStrip(b: Builder, bone: string, rest: V3 | undefined, w: number, mat: string, tip = 0.05): void {
  const len = rest ? Math.hypot(rest[0], rest[1], rest[2]) : 0.12;
  const th = 0.008;
  b.add(bone, mat, slab([0, -len / 2, 0], [w, len, th]), ell([0, -len, 0], [0, -len - tip, 0], w / 2, th / 2, 0.002, 0.002, 4));
}
