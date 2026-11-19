// Kagari, the Band's duelist: a long crimson coat (back panels swing on springs), one sleeve crimson and one charcoal, a
// tall stiff collar, a white lacquer mask with red marks, a tall black cap, a long tied tail of hair, and a long blade
// with a square brass guard. A silhouette nobody else in the Band has: tall, narrow at the shoulder, long at the hem.
import * as THREE from 'hull/three';
import { ball, cone, ell, slab, tube, type V3 } from './kit';
import { base, headRadii } from './body';
import { katana } from './aya';
import type { Built, Ctx } from './index';

export function kagari(c: Ctx): Built {
  const { b, d, rest } = c;
  const H = d.height, h = d.head, hr = headRadii(d);
  base(b, d, { skin: 'skin', torso: 'crimson', arms: 'crimson', legs: 'charcoal', boots: 'lacquer-black', forearm: 'crimson', limb: 0.95 });
  // Coat: the chest and waist in crimson, a pale cross-collar, a dark obi, front panels on the thighs, back panels on springs.
  b.add('chest', 'crimson', ell([0, -0.01, 0], [0, d.chestLen, 0], 0.158, 0.1, 0.17, 0.095, 12));
  b.add('chest', 'bone', slab([-0.05, d.chestLen * 0.6, -0.098], [0.045, d.chestLen * 0.9, 0.012], [0, 0, -0.32]), slab([0.05, d.chestLen * 0.6, -0.099], [0.045, d.chestLen * 0.9, 0.012], [0, 0, 0.32]));
  b.add('neck', 'crimson-dark', ell([0, -0.06, 0], [0, 0.12, 0], 0.115, 0.1, 0.095, 0.085, 10, false), ell([0, 0.115, 0], [0, 0.125, 0], 0.095, 0.085, 0.07, 0.065, 10));
  b.add('spine', 'crimson', ell([0, -0.012, 0], [0, d.spineLen + 0.01, 0], 0.115, 0.09, 0.14, 0.096, 12));
  b.add('spine', 'crimson-dark', ell([0, 0.0, 0], [0, 0.12, 0], 0.13, 0.1, 0.125, 0.098, 12), slab([0, 0.06, 0.1], [0.1, 0.12, 0.03]));
  b.add('spine', 'bone', ell([0, 0.12, 0], [0, 0.135, 0], 0.128, 0.099, 0.126, 0.098, 12));
  b.both((sx, s) => {
    // Front skirts: a flared crimson cloth to the knee on each thigh, with a pale hem and a dark inside.
    b.add('leg' + s, 'crimson', ell([sx * 0.0, 0.04, -0.01], [sx * 0.03, -d.thigh * 1.18, -0.02], 0.115, 0.092, 0.14, 0.11, 9, false));
    b.add('leg' + s, 'bone', ell([sx * 0.03, -d.thigh * 1.18, -0.02], [sx * 0.032, -d.thigh * 1.2, -0.02], 0.14, 0.11, 0.142, 0.112, 9));
    // Tall black boots and charcoal trousers wrapped at the shin.
    b.add('shin' + s, 'lacquer-black', ell([0, -d.shin * 0.35, 0], [0, -d.shin * 0.97, 0], 0.05, 0.048, 0.04, 0.038, 8));
    b.add('foot' + s, 'lacquer-black', slab([0, -d.footH * 0.5, -d.footLen * 0.3], [0.07, d.footH, d.footLen]));
    b.add('arm' + s, s === 'L' ? 'crimson-dark' : 'charcoal', ball([0, 0, 0], 0.056, 8, 6), tube([0, 0, 0], [0, -d.upperArm, 0], 0.052, 0.058, 8));
    // Long sleeves ending in a pale cuff.
    b.add('forearm' + s, s === 'L' ? 'crimson' : 'charcoal', ell([0, 0.01, 0], [0, -d.foreArm * 0.9, 0], 0.05, 0.048, 0.075, 0.065, 8, false));
    b.add('forearm' + s, 'bone', tube([0, -d.foreArm * 0.9, 0], [0, -d.foreArm * 1.0, 0], 0.062, 0.05, 8));
  });
  // A white lacquer mask with red marks and eye slits, a hood of black hair under a tall cap.
  b.add('head', 'mask-white', ell([0, h * 0.03, -hr[2] * 0.25], [0, h * 0.97, -hr[2] * 0.25], hr[0] * 0.9, hr[2] * 1.12, hr[0] * 0.98, hr[2] * 1.08, 10, false));
  b.add('head', 'lacquer-red', slab([-h * 0.2, h * 0.6, -hr[2] * 1.05], [h * 0.17, h * 0.03, h * 0.02], [0, 0, 0.35]), slab([h * 0.2, h * 0.6, -hr[2] * 1.05], [h * 0.17, h * 0.03, h * 0.02], [0, 0, -0.35]),
    slab([0, h * 0.86, -hr[2] * 1.03], [h * 0.04, h * 0.18, h * 0.02]), slab([-h * 0.1, h * 0.28, -hr[2] * 1.07], [h * 0.03, h * 0.14, h * 0.02]), slab([h * 0.1, h * 0.28, -hr[2] * 1.07], [h * 0.03, h * 0.14, h * 0.02]));
  b.add('head', 'eye', slab([-h * 0.15, h * 0.52, -hr[2] * 1.07], [h * 0.12, h * 0.025, h * 0.02], [0, 0, 0.2]), slab([h * 0.15, h * 0.52, -hr[2] * 1.07], [h * 0.12, h * 0.025, h * 0.02], [0, 0, -0.2]));
  b.add('head', 'hair-black', ball([0, h * 0.58, hr[2] * 0.35], [hr[0] * 1.18, hr[1] * 1.1, hr[2] * 1.05], 9, 7));
  b.add('head', 'lacquer-black', ell([0, h * 0.92, hr[2] * 0.1], [0, h * 1.6, hr[2] * 0.7], hr[0] * 0.92, hr[2] * 0.92, hr[0] * 0.5, hr[2] * 0.5, 8), tube([0, h * 0.86, 0], [0, h * 0.95, 0], hr[0] * 1.16, hr[0] * 1.16, 10));
  b.add('head', 'crimson', tube([0, h * 0.9, 0], [0, h * 0.93, 0], hr[0] * 1.19, hr[0] * 1.19, 10));
  // The tail of hair, tied with a white ribbon, on three spring bones.
  const pony = ['pony1', 'pony2', 'pony3'];
  pony.forEach((n, i) => {
    const r = rest(pony[i + 1] ?? ''), len = r ? Math.hypot(r[0], r[1], r[2]) : 0.2;
    b.add(n, 'hair-black', tube([0, 0, 0], [0, -len - (i === 2 ? 0.02 : 0), 0], [0.035, 0.03, 0.022][i]!, [0.03, 0.022, 0.003][i]!, 6));
  });
  b.add('pony1', 'bone', tube([0, 0.015, 0], [0, -0.02, 0], 0.043, 0.043, 7));
  // The back panels of the coat: left and right, three bones each, dark inside, a white hem.
  for (const s of ['L', 'R']) {
    const ch = [1, 2, 3].map((i) => 'coat' + s + i);
    ch.forEach((n, i) => {
      const r = rest(ch[i + 1] ?? ''), len = r ? Math.hypot(r[0], r[1], r[2]) : 0.24;
      const w = 0.17 + i * 0.015;
      b.add(n, i === 1 ? 'crimson-dark' : 'crimson', slab([0, -len / 2, 0], [w, len, 0.014]));
      if (i === 2) b.add(n, 'bone', slab([0, -len, 0], [w, 0.03, 0.016]), ell([0, -len - 0.03, 0], [0, -len - 0.09, 0], w / 2, 0.006, 0.004, 0.002, 4));
    });
  }
  // The blade: long, a square brass guard, black wrap with red bands. Along -Y from the right hand to -1.3.
  const sword = new THREE.Group();
  sword.name = 'blade';
  katana(b, sword, { guard: 'brass', bladeEnd: 1.3, wrap: 'lacquer-black', band: 'lacquer-red' });
  // The scabbard on the left hip, empty, tip back, with a tassel.
  const dir = new THREE.Vector3(-0.07, -0.2, 0.97).normalize();
  const a: V3 = [-0.18, 0.02, -0.18];
  b.add('hips', 'lacquer-black', ell(a, [a[0] + dir.x * 1.05, a[1] + dir.y * 1.05, a[2] + dir.z * 1.05], 0.03, 0.022, 0.024, 0.02, 8));
  b.add('hips', 'brass', ball([a[0] + dir.x * 1.05, a[1] + dir.y * 1.05, a[2] + dir.z * 1.05], 0.024, 7, 5));
  b.add('hips', 'lacquer-red', slab([a[0] + dir.x * 0.2, a[1] + dir.y * 0.2 - 0.06, a[2] + dir.z * 0.2], [0.02, 0.14, 0.02]));
  void cone;
  return { sword, hand: 'handR' };
}
