// Aya of the Sedge Hall: a short indigo kimono over ivory and wide hakama, a red obi with two sash tails and a scarf tail
// that swing on springs, hair tied back in a ponytail that swings too, a lacquered scabbard on her left hip and the
// ironleaf katana (a leaf-vein on the blade, a leaf-shaped brass guard, a wrapped hilt). The katana is its own group so
// it can go from her hand to the scabbard and back (draw and sheathe).
import * as THREE from 'hull/three';
import type { HumanoidDims } from 'hull/anim';
import { ball, ell, slab, tube, cone, Builder, type V3 } from './kit';
import { headRadii } from './body';
import type { Built, Ctx } from './index';

/** The katana, made along -Y from the hand: hilt +0.16 to -0.12, guard at -0.14, blade to -0.91. Shared with Kagari's long blade. */
export function katana(b: Builder, g: THREE.Object3D, o: { guard: string; bladeEnd: number; wrap: string; band: string; leaf?: boolean }): void {
  const end = o.bladeEnd;
  // Hilt: ray-skin core, wrap, and a ring of cord diamonds.
  b.add(g, o.wrap, tube([0, 0.15, 0], [0, -0.125, 0], 0.0185, 0.0175, 6));
  for (let y = 0.12; y > -0.115; y -= 0.05) b.add(g, o.band, tube([0, y, 0], [0, y - 0.012, 0], 0.0205, 0.0205, 6));
  b.add(g, 'brass', ball([0, 0.165, 0], [0.021, 0.014, 0.019], 7, 5), tube([0, -0.12, 0], [0, -0.132, 0], 0.022, 0.022, 6));
  // Guard.
  if (o.leaf) b.add(g, 'brass', ell([0, -0.133, 0], [0, -0.146, 0], 0.052, 0.034, 0.052, 0.034, 10), ell([0, -0.146, 0], [0, -0.152, 0], 0.025, 0.02, 0.025, 0.02, 8));
  else b.add(g, 'iron', slab([0, -0.14, 0], [0.085, 0.014, 0.085], [0, Math.PI / 4, 0]), slab([0, -0.15, 0], [0.03, 0.02, 0.03]));
  // Blade: a thin diamond that narrows to a point, steel with a darker vein line down each face.
  const tipAt = -end;
  b.add(g, 'steel', ell([0, -0.152, 0], [0, tipAt + 0.04, 0], 0.016, 0.0052, 0.012, 0.0036, 4, true), ell([0, tipAt + 0.04, 0], [0, tipAt, 0], 0.012, 0.0036, 0.0015, 0.001, 4));
  if (o.leaf) {
    for (const z of [-0.0054, 0.0054]) {
      b.add(g, 'indigo-dark', slab([0, (-0.2 + tipAt) / 2 - 0.02, z], [0.0035, Math.abs(tipAt + 0.2) * 0.9, 0.0016]));
      for (let i = 0; i < 5; i++) {
        const y = -0.28 - i * 0.12;
        for (const sx of [-1, 1]) b.add(g, 'indigo-dark', slab([sx * 0.0045, y, z], [0.012, 0.0035, 0.0016], [0, 0, sx * 0.7]));
      }
    }
  }
}

export function build(c: Ctx): Built {
  const { b, d, rest } = c;
  const H = d.height;
  const h = d.head;
  const hr = headRadii(d);

  // ---- feet and legs: ivory tabi, straw-and-black sandals, wide indigo hakama.
  b.both((sx, s) => {
    b.add('leg' + s, 'indigo-dark', ell([0, 0.03, 0], [0, -d.thigh, 0], 0.088, 0.085, 0.108, 0.104, 10), ball([0, 0, 0], 0.075, 8, 6));
    b.add('shin' + s, 'indigo-dark', ell([0, 0, 0], [0, -d.shin + 0.06, 0], 0.108, 0.104, 0.094, 0.09, 10));
    // Leg wraps (kyahan) and the ankle.
    b.add('shin' + s, 'wrap-white', tube([0, -d.shin + 0.07, 0], [0, -d.shin + 0.005, 0], 0.052, 0.042, 8));
    b.add('foot' + s, 'wrap-white', slab([0, -d.footH * 0.55, -d.footLen * 0.3], [0.068, d.footH * 0.9, d.footLen * 0.92]));
    b.add('foot' + s, 'lacquer-black', slab([0, -d.footH * 0.95, -d.footLen * 0.3], [0.076, 0.016, d.footLen * 1.05]),
      slab([0, -d.footH * 0.3, -d.footLen * 0.5], [0.07, 0.012, 0.02]));
    b.add('foot' + s, 'sash-red', slab([0, -d.footH * 0.55, -d.footLen * 0.42], [0.072, 0.012, 0.018]));
    void sx;
  });

  // ---- hips: the hakama koshi-ita at the back, the short kimono's flared hem (indigo outside, ivory inside), the sword hanger.
  b.add('hips', 'indigo-dark', ell([0, -0.09, 0], [0, 0.04, 0], 0.15, 0.115, 0.118, 0.092, 10), slab([0, 0.0, 0.1], [0.12, 0.13, 0.022], [0.25, 0, 0]));
  b.add('hips', 'indigo', ell([0, -0.235, 0], [0, 0.03, 0], 0.205, 0.165, 0.128, 0.1, 12, false));
  b.add('hips', 'cloth-ivory', ell([0, -0.245, 0], [0, -0.225, 0], 0.212, 0.172, 0.208, 0.168, 12, false));
  // A front-opening seam of the kimono: a dark vertical tuck either side of centre.
  for (const x of [-0.035, 0.035]) b.add('hips', 'indigo-dark', slab([x, -0.1, -0.137], [0.01, 0.2, 0.01], [0, 0, x * 1.4]));

  // ---- waist and the red obi with its knot at the back.
  b.add('spine', 'sash-red', ell([0, 0.012, 0], [0, 0.112, 0], 0.132, 0.106, 0.128, 0.102, 12));
  b.add('spine', 'sash-red', slab([0, 0.06, 0.113], [0.17, 0.115, 0.05]), ball([0, 0.06, 0.145], [0.045, 0.045, 0.03], 7, 5));
  b.add('spine', 'lacquer-red', slab([0, 0.115, -0.108], [0.04, 0.025, 0.012]));
  // Waist above the obi, a tuck of ivory.
  b.add('spine', 'cloth-ivory', ell([0, 0.108, 0], [0, d.spineLen + 0.01, 0], 0.118, 0.094, 0.13, 0.1, 12));

  // ---- chest: indigo outer kimono, ivory cross-collar (left over right: a V) and the shoulder line.
  b.add('chest', 'indigo', ell([0, -0.01, 0], [0, d.chestLen, 0], 0.132, 0.098, 0.152, 0.092, 12));
  b.add('chest', 'cloth-ivory', slab([-0.045, d.chestLen * 0.62, -0.1], [0.028, d.chestLen * 0.82, 0.012], [0, 0, -0.34]), slab([0.045, d.chestLen * 0.62, -0.101], [0.028, d.chestLen * 0.82, 0.012], [0, 0, 0.34]));
  b.add('chest', 'indigo-dark', slab([0, d.chestLen * 0.42, -0.104], [0.06, 0.028, 0.008]));
  b.add('chest', 'lacquer-red', ell([0, d.chestLen - 0.03, 0], [0, d.chestLen + 0.012, 0], 0.075, 0.07, 0.065, 0.06, 10));
  // The harness cord that holds the sword on her back: a diagonal across the chest.
  b.add('chest', 'sash-red', slab([0, d.chestLen * 0.5, -0.1], [0.012, d.chestLen * 1.15, 0.01], [0, 0, 0.62]));

  // ---- neck and the scarf: a red wrap and one tail on a spring chain.
  b.add('neck', 'skin', tube([0, -0.02, 0], [0, d.neckLen + 0.01, 0], 0.03, 0.027, 7));
  b.add('neck', 'sash-red', ell([0, -0.02, 0], [0, 0.04, 0], 0.074, 0.07, 0.058, 0.054, 10), slab([0.04, 0.0, -0.045], [0.07, 0.05, 0.03], [0.3, 0.4, 0.3]));
  const scarf = ['scarf1', 'scarf2', 'scarf3'];
  scarf.forEach((n, i) => {
    const r = rest(scarf[i + 1] ?? ''), len = r ? Math.hypot(r[0], r[1], r[2]) : 0.15;
    b.add(n, 'sash-red', slab([0, -len / 2, 0], [0.065 - i * 0.012, len, 0.012]), ...(i === 2 ? [ell([0, -len, 0], [0, -len - 0.06, 0], 0.026, 0.006, 0.002, 0.002, 4)] : []));
  });

  // ---- arms: ivory under-sleeve, a wide indigo hanging sleeve with an ivory lining, bare hands.
  b.both((sx, s) => {
    b.add('arm' + s, 'indigo', ball([0, 0, 0], 0.056, 8, 6), tube([0, 0, 0], [0, -d.upperArm, 0], 0.058, 0.07, 9));
    b.add('forearm' + s, 'indigo', ell([0, 0.015, 0], [0, -d.foreArm * 0.88, 0], 0.07, 0.066, 0.092, 0.075, 9, false));
    b.add('forearm' + s, 'cloth-ivory', tube([0, 0, 0], [0, -d.foreArm * 0.9, 0], 0.04, 0.034, 8), ell([0, -d.foreArm * 0.88, 0], [0, -d.foreArm * 0.84, 0], 0.094, 0.077, 0.088, 0.072, 9));
    b.add('hand' + s, 'skin', ball([0, -d.hand * 0.4, 0], [0.027, d.hand * 0.6, 0.033], 7, 5), slab([sx * 0.0, -d.hand * 0.1, -0.025], [0.014, 0.05, 0.014], [0.3, 0, 0]));
    // Wrist bracer wrap.
    b.add('forearm' + s, 'wrap-white', tube([0, -d.foreArm * 0.94, 0], [0, -d.foreArm * 1.02, 0], 0.036, 0.034, 7));
  });

  // ---- head: skin, a tied-back crown of black hair with a fringe, eyes, brows, a red tie, and the ponytail chain.
  const hy = h * 0.5;
  b.add('head', 'skin', ball([0, hy, 0], hr, 10, 8));
  b.add('head', 'hair-black', ball([0, hy + h * 0.045, h * 0.12], [hr[0] * 1.12, hr[1] * 1.04, hr[2] * 1.08], 10, 8),
    slab([0, h * 0.9, -hr[2] * 0.8], [hr[0] * 1.7, h * 0.16, hr[2] * 0.3], [0.7, 0, 0]),
    slab([-hr[0] * 0.98, h * 0.52, -hr[2] * 0.35], [hr[0] * 0.14, h * 0.42, hr[2] * 0.72]), slab([hr[0] * 0.98, h * 0.52, -hr[2] * 0.35], [hr[0] * 0.14, h * 0.42, hr[2] * 0.72]),
    // The knot where the hair is gathered.
    ball([0, h * 0.84, hr[2] * 0.82], [h * 0.11, h * 0.1, h * 0.1], 7, 5));
  // Eyes at low-poly scale need three things to read from the camera: a pale white to set the dark iris against,
  // a brow heavy enough to carry an expression, and a nose that catches the key light so the face has a front.
  b.add('head', 'cloth-ivory', slab([-h * 0.17, hy - h * 0.01, -hr[2] * 0.97], [h * 0.13, h * 0.07, h * 0.02]), slab([h * 0.17, hy - h * 0.01, -hr[2] * 0.97], [h * 0.13, h * 0.07, h * 0.02]));
  b.add('head', 'eye', slab([-h * 0.17, hy - h * 0.01, -hr[2] * 1.0], [h * 0.065, h * 0.075, h * 0.02]), slab([h * 0.17, hy - h * 0.01, -hr[2] * 1.0], [h * 0.065, h * 0.075, h * 0.02]));
  b.add('head', 'hair-black', slab([-h * 0.17, hy + h * 0.095, -hr[2] * 0.99], [h * 0.17, h * 0.035, h * 0.025], [0, 0, 0.14]), slab([h * 0.17, hy + h * 0.095, -hr[2] * 0.99], [h * 0.17, h * 0.035, h * 0.025], [0, 0, -0.14]));
  b.add('head', 'skin', ball([0, hy - h * 0.1, -hr[2] * 1.0], [h * 0.05, h * 0.07, h * 0.06], 6, 4));
  b.add('head', 'sash-red', slab([0, hy - h * 0.24, -hr[2] * 0.97], [h * 0.07, h * 0.025, h * 0.02]), tube([0, h * 0.8, hr[2] * 0.95], [0, h * 0.9, hr[2] * 0.96], h * 0.13, h * 0.13, 8));
  const pony = ['pony1', 'pony2', 'pony3'];
  pony.forEach((n, i) => {
    const r = rest(pony[i + 1] ?? ''), len = r ? Math.hypot(r[0], r[1], r[2]) : 0.17;
    const r0 = [0.04, 0.036, 0.028][i]!, r1 = [0.036, 0.028, 0.004][i]!;
    b.add(n, 'hair-black', tube([0, 0.0, 0], [0, -len - (i === 2 ? 0.0 : 0.01), 0], r0, r1, 7));
  });

  // ---- the scabbard on her left hip (the "hip" socket) and the hanger cord.
  const p0: V3 = [-0.18, 0.03, -0.2], p1: V3 = [-0.235, -0.17, 0.62];
  const dir = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]).normalize();
  const sStart: V3 = [p0[0] + dir.x * 0.06, p0[1] + dir.y * 0.06, p0[2] + dir.z * 0.06];
  const sEnd: V3 = [p0[0] + dir.x * 0.86, p0[1] + dir.y * 0.86, p0[2] + dir.z * 0.86];
  b.add('hips', 'lacquer-black', ell(sStart, sEnd, 0.027, 0.02, 0.022, 0.018, 8));
  b.add('hips', 'brass', tube(sStart, [sStart[0] + dir.x * 0.025, sStart[1] + dir.y * 0.025, sStart[2] + dir.z * 0.025], 0.03, 0.03, 8), ball(sEnd, 0.022, 7, 5));
  b.add('hips', 'sash-red', tube([sStart[0] + dir.x * 0.17, sStart[1] + dir.y * 0.17, sStart[2] + dir.z * 0.17], [sStart[0] + dir.x * 0.22, sStart[1] + dir.y * 0.22, sStart[2] + dir.z * 0.22], 0.03, 0.03, 8),
    slab([-0.15, 0.0, -0.1], [0.012, 0.04, 0.3], [0, 0.2, 0]));

  // ---- sash tails on the obi knot (two on springs, one each side).
  for (const s of ['L', 'R']) {
    const ch = [1, 2, 3].map((i) => 'sash' + s + i);
    ch.forEach((n, i) => {
      const r = rest(ch[i + 1] ?? ''), len = r ? Math.hypot(r[0], r[1], r[2]) : 0.15;
      b.add(n, 'sash-red', slab([0, -len / 2, 0], [0.065 - i * 0.008, len, 0.011]), ...(i === 2 ? [ell([0, -len, 0], [0, -len - 0.05, 0], 0.028, 0.005, 0.002, 0.002, 4)] : []));
    });
  }

  // ---- the sword.
  const sword = new THREE.Group();
  sword.name = 'katana';
  katana(b, sword, { guard: 'brass', bladeEnd: 0.91, wrap: 'wrap-white', band: 'sash-red', leaf: true });
  // Carried in the sheath, hilt forward at the hip: the sword's -Y runs back along the scabbard, the base 6 cm into it.
  const sheathedQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
  const sheathedP = new THREE.Vector3(p0[0], p0[1], p0[2]).addScaledVector(dir, 0.06 - 0.152);
  return { sword, hand: 'handR', hip: 'hips', sheathedQ, sheathedP };
}

export type { HumanoidDims };
