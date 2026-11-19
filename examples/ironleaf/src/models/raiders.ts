// The Ashfall Band: charcoal cloth, rust and iron plates that do not match, grey bandage, torn rags, straw hats, iron
// half-masks. Each kind has its own silhouette: the swordsman's broad hat and one big shoulder plate, the spearman's
// flat iron hat and banner, the brute's horned helm, spiked pauldrons and huge club, the archer's hood, cape and bow.
import * as THREE from 'hull/three';
import { arc, ball, cone, ell, slab, tube, type V3 } from './kit';
import { base, headRadii, ragStrip } from './body';
import { katana } from './aya';
import type { Built, Ctx } from './index';

const rot = (r: V3): V3 => r;

/** An iron half-mask over the lower face: cheek plates, a ridge, and a row of teeth. */
function halfMask(c: Ctx, tusks = 0.03, mat = 'iron'): void {
  const { b, d } = c;
  const h = d.head, hr = headRadii(d);
  b.add('head', mat, ell([0, h * 0.06, -hr[2] * 0.2], [0, h * 0.5, -hr[2] * 0.22], hr[0] * 1.08, hr[2] * 1.12, hr[0] * 1.0, hr[2] * 1.06, 9),
    slab([0, h * 0.3, -hr[2] * 1.12], [hr[0] * 1.5, h * 0.05, h * 0.05], [0.0, 0, 0]));
  b.add('head', 'bone', ...[-2, -1, 0, 1, 2].map((i) => slab([i * h * 0.075, h * 0.2, -hr[2] * 1.12], [h * 0.045, h * 0.1, h * 0.04])));
  b.add('head', 'eye', slab([-h * 0.16, h * 0.56, -hr[2] * 0.97], [h * 0.09, h * 0.04, h * 0.02]), slab([h * 0.16, h * 0.56, -hr[2] * 0.97], [h * 0.09, h * 0.04, h * 0.02]));
  void tusks;
}

/** A hanging torn rag, one or two bones long. */
function rags(c: Ctx, names: string[], w: number, mat: string): void {
  names.forEach((n, i) => ragStrip(c.b, n, c.rest(names[i + 1] ?? ''), w - i * 0.01, mat, i === names.length - 1 ? 0.07 : 0));
}

// -------------------------------------------------------------------------------------------------- Ashblade
export function ashblade(c: Ctx): Built {
  const { b, d } = c;
  const H = d.height, h = d.head, hr = headRadii(d);
  base(c.b, d, { skin: 'skin', torso: 'charcoal', arms: 'charcoal', legs: 'charcoal', boots: 'boots', forearm: 'bandage', chest: 1.06 });
  // Belt of rope and a rust cloth knot; a torn coat hem.
  b.add('spine', 'rust', ell([0, 0.0, 0], [0, 0.07, 0], 0.092 * H * d.build * 1.04, 0.062 * H * d.build, 0.092 * H * d.build, 0.062 * H * d.build, 10));
  b.add('hips', 'charcoal', ell([0, -0.17, 0], [0, 0.0, 0], 0.19, 0.12, 0.125, 0.09, 10, false));
  // Mismatched armour: a stack of rust plates on the left shoulder, a lone iron plate on the right, a chest plate off-centre.
  for (let i = 0; i < 3; i++) b.add('armL', 'rust', slab([-0.02, -0.03 - i * 0.045, 0], [0.19 - i * 0.02, 0.05, 0.15 - i * 0.01], [0, 0, 0.18]));
  b.add('armR', 'iron', slab([0.03, 0.0, -0.01], [0.12, 0.05, 0.12], [0, 0, -0.5]), slab([0.04, 0.03, -0.03], [0.02, 0.03, 0.02]));
  b.add('chest', 'iron', slab([0.06, 0.2, -0.108], [0.19, 0.2, 0.024], [0, 0, 0.1]));
  b.add('chest', 'rust', slab([-0.07, 0.12, -0.11], [0.12, 0.05, 0.02], [0, 0, -0.1]), slab([-0.07, 0.2, -0.11], [0.12, 0.05, 0.02], [0, 0, -0.1]));
  b.add('chest', 'bandage', ell([0, 0.02, 0], [0, 0.34 * d.chestLen, 0], 0.145, 0.108, 0.158, 0.112, 10, false));
  // Bandage wraps on the right forearm and both shins, and bound hands.
  b.add('shinL', 'bandage', tube([0, -d.shin * 0.3, 0], [0, -d.shin * 0.85, 0], 0.044, 0.04, 8));
  b.add('shinR', 'bandage', tube([0, -d.shin * 0.2, 0], [0, -d.shin * 0.7, 0], 0.044, 0.038, 8));
  b.add('forearmL', 'bandage', tube([0, -0.03, 0], [0, -d.foreArm * 0.9, 0], 0.036, 0.03, 8));
  // The hat and the mask.
  b.add('head', 'straw', ell([0, h * 0.7, 0], [0, h * 1.5, 0], h * 1.0, h * 1.0, 0.003, 0.003, 12), tube([0, h * 0.68, 0], [0, h * 0.72, 0], h * 1.0, h * 0.98, 12));
  b.add('head', 'rust', tube([0, h * 0.7, 0], [0, h * 0.78, 0], h * 0.44, h * 0.42, 9), slab([0, h * 0.2, hr[2] * 0.9], [h * 0.02, h * 0.5, h * 0.02]));
  halfMask(c);
  rags(c, ['ragL1', 'ragL2'], 0.11, 'bandage');
  rags(c, ['ragR1', 'ragR2'], 0.1, 'charcoal');
  // The sword: a plain chipped blade, a bandaged hilt and an iron guard. Along -Y from the right hand to the socket at -0.96.
  const sword = new THREE.Group();
  sword.name = 'sword';
  katana(b, sword, { guard: 'iron', bladeEnd: 0.96, wrap: 'bandage', band: 'charcoal' });
  return { sword, hand: 'handR' };
}

// -------------------------------------------------------------------------------------------------- Ashpike
export function ashpike(c: Ctx): Built {
  const { b, d } = c;
  const H = d.height, h = d.head, hr = headRadii(d);
  base(c.b, d, { skin: 'skin', torso: 'charcoal', arms: 'charcoal', legs: 'bandage', boots: 'boots', forearm: 'charcoal', limb: 0.97 });
  // Hip plates hanging like a skirt, rust, with a rope belt.
  b.add('spine', 'rust', ell([0, 0.0, 0], [0, 0.065, 0], 0.088 * H, 0.062 * H, 0.088 * H, 0.062 * H, 10));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.add('hips', 'rust', slab([Math.sin(a) * 0.15, -0.09, Math.cos(a) * 0.12], [0.085, 0.17, 0.014], [0.16 * Math.cos(a), a, 0.16 * Math.sin(a)]));
  }
  // Shin guards and small shoulder guards, iron chest strip.
  b.both((_s, s) => {
    b.add('shin' + s, 'rust', ell([0, -d.shin * 0.12, -0.01], [0, -d.shin * 0.85, -0.012], 0.043, 0.036, 0.035, 0.03, 6));
    b.add('arm' + s, 'iron', slab([0, -0.02, 0], [0.14, 0.04, 0.13], [0, 0, s === 'L' ? 0.4 : -0.4]));
    b.add('forearm' + s, 'iron', ell([0, -0.02, 0], [0, -d.foreArm * 0.55, 0], 0.035, 0.032, 0.03, 0.028, 6));
  });
  for (let i = 0; i < 3; i++) b.add('chest', 'iron', slab([0, 0.1 + i * 0.075, -0.1], [0.24, 0.07, 0.02]));
  b.add('chest', 'sash-red', slab([0, 0.17, -0.112], [0.012, 0.28, 0.01]));
  // A flat iron hat on a wrapped headcloth, and a face guard with a long nose.
  b.add('head', 'iron', ell([0, h * 0.74, 0], [0, h * 1.0, 0], h * 1.2, h * 1.2, h * 0.5, h * 0.5, 12), tube([0, h * 0.99, 0], [0, h * 1.1, 0], h * 0.18, h * 0.12, 8));
  b.add('head', 'rust', tube([0, h * 0.72, 0], [0, h * 0.76, 0], h * 1.2, h * 1.18, 12));
  b.add('head', 'bandage', ell([0, h * 0.4, 0], [0, h * 0.78, 0], hr[0] * 1.05, hr[2] * 1.05, hr[0] * 1.07, hr[2] * 1.07, 9, false));
  halfMask(c, 0.02, 'rust');
  b.add('head', 'rust', cone([0, h * 0.4, -hr[2] * 1.1], [0, h * 0.32, -hr[2] * 1.5], h * 0.05, 4));
  // Back banner: a pole with a torn red cloth on two spring bones.
  b.add('chest', 'wood', tube([0.06, -0.04, 0.12], [0.06, 0.8, 0.12], 0.012, 0.01, 6), ball([0.06, 0.82, 0.12], 0.02, 6, 4));
  b.add('chest', 'iron', slab([0.06, 0.6, 0.11], [0.04, 0.025, 0.04]));
  ragStrip(b, 'flag1', c.rest('flag2'), 0.12, 'sash-red', 0);
  ragStrip(b, 'flag2', undefined, 0.1, 'sash-red', 0.1);
  rags(c, ['ragL1', 'ragL2'], 0.09, 'charcoal');
  // The spear. Along -Y from the right hand: shaft from +0.45 to -1.0 (the socket), head to -1.4, a red tassel under it.
  const spear = new THREE.Group();
  spear.name = 'spear';
  b.add(spear, 'wood', tube([0, 0.45, 0.02], [0, -1.0, 0.02], 0.017, 0.016, 7));
  b.add(spear, 'iron', tube([0, 0.45, 0.02], [0, 0.49, 0.02], 0.02, 0.02, 7), tube([0, -0.95, 0.02], [0, -1.02, 0.02], 0.023, 0.023, 7));
  b.add(spear, 'steel', ell([0, -1.02, 0.02], [0, -1.18, 0.02], 0.014, 0.007, 0.036, 0.011, 4), ell([0, -1.18, 0.02], [0, -1.4, 0.02], 0.036, 0.011, 0.002, 0.002, 4));
  b.add(spear, 'sash-red', ball([0, -0.98, 0.02], [0.03, 0.04, 0.03], 7, 5), slab([0.0, -0.93, 0.02], [0.055, 0.14, 0.012]));
  return { sword: spear, hand: 'handR' };
}

// -------------------------------------------------------------------------------------------------- Cinder Hulk
export function hulk(c: Ctx): Built {
  const { b, d } = c;
  const H = d.height, h = d.head, hr = headRadii(d);
  base(c.b, d, { skin: 'hulk-skin', torso: 'hulk-skin', arms: 'hulk-skin', legs: 'charcoal', boots: 'boots', belly: 1.32, chest: 1.16, limb: 1.0, forearm: 'hulk-skin' });
  // Belly wrap, a huge belt with a skull buckle, hip plates.
  b.add('spine', 'rust', ell([0, 0.0, 0], [0, 0.13, 0], 0.158 * 1.2, 0.2, 0.16 * 1.2, 0.2, 12));
  b.add('spine', 'bone', ball([0, 0.06, -0.205], [0.06, 0.07, 0.03], 7, 5));
  b.add('spine', 'eye', ball([-0.022, 0.07, -0.23], 0.012, 5, 4), ball([0.022, 0.07, -0.23], 0.012, 5, 4));
  b.both((sx, s) => {
    // Spiked pauldrons.
    b.add('arm' + s, 'rust', ball([sx * 0.03, 0.04, 0], [0.2, 0.14, 0.18], 9, 6));
    for (let i = 0; i < 3; i++) {
      const a = -0.5 + i * 0.5;
      b.add('arm' + s, 'iron', cone([sx * (0.1 + Math.cos(a) * 0.06), 0.12, Math.sin(a) * 0.11], [sx * (0.14 + Math.cos(a) * 0.1), 0.3, Math.sin(a) * 0.2], 0.04, 5));
    }
    // Iron bracers.
    b.add('forearm' + s, 'iron', ell([0, -0.03, 0], [0, -d.foreArm * 0.65, 0], 0.095, 0.09, 0.085, 0.08, 8));
    b.add('forearm' + s, 'brass', tube([0, -0.03, 0], [0, -0.05, 0], 0.1, 0.1, 8));
    // Boots with iron toes; pants with rope wraps.
    b.add('foot' + s, 'iron', slab([0, -d.footH * 0.5, -d.footLen * 0.62], [0.17, d.footH * 0.9, 0.08]));
    b.add('shin' + s, 'iron', tube([0, -d.shin * 0.5, 0], [0, -d.shin * 0.6, 0], 0.08, 0.08, 8), tube([0, -d.shin * 0.75, 0], [0, -d.shin * 0.85, 0], 0.07, 0.07, 8));
  });
  // Chest plates riveted over the charcoal vest, a ragged leather mantle at the back.
  b.add('chest', 'iron', slab([0, 0.2, -0.17], [0.4, 0.17, 0.04], [0.08, 0, 0]), slab([0, 0.04, -0.17], [0.3, 0.12, 0.04], [0.1, 0, 0]));
  for (const x of [-0.17, -0.06, 0.06, 0.17]) b.add('chest', 'brass', ball([x, 0.2, -0.195], 0.016, 5, 4));
  // Neck collar and a horned iron helm with an open snarling jaw.
  b.add('neck', 'iron', tube([0, -0.05, 0], [0, 0.0, 0], 0.15, 0.13, 9));
  b.add('head', 'iron', ell([0, h * 0.55, 0], [0, h * 1.0, 0], hr[0] * 1.15, hr[2] * 1.15, hr[0] * 0.5, hr[2] * 0.5, 9), tube([0, h * 0.52, 0], [0, h * 0.6, 0], hr[0] * 1.18, hr[0] * 1.17, 10));
  b.add('head', 'bone', cone([-hr[0] * 0.9, h * 0.82, 0], [-hr[0] * 2.5, h * 1.5, -0.01], 0.034, 6), cone([hr[0] * 0.9, h * 0.82, 0], [hr[0] * 2.5, h * 1.5, -0.01], 0.034, 6));
  halfMask(c, 0.05, 'iron');
  b.add('head', 'bone', ...[-1, 1].map((x) => cone([x * h * 0.13, h * 0.2, -hr[2] * 1.12], [x * h * 0.15, h * 0.4, -hr[2] * 1.22], h * 0.04, 5)));
  // Loincloth.
  rags(c, ['rag1', 'rag2'], 0.2, 'charcoal');
  // The club: handle from +0.12 to -0.8, the studded head down to -1.42 (socket "clubHead" at -1.15).
  const club = new THREE.Group();
  club.name = 'club';
  b.add(club, 'wood', tube([0, 0.12, 0], [0, -0.8, 0], 0.042, 0.05, 8), ell([0, -0.78, 0], [0, -1.22, 0], 0.07, 0.07, 0.18, 0.18, 9), ell([0, -1.22, 0], [0, -1.44, 0], 0.18, 0.18, 0.09, 0.09, 9));
  b.add(club, 'iron', tube([0, -0.98, 0], [0, -1.02, 0], 0.17, 0.17, 9), tube([0, -1.26, 0], [0, -1.31, 0], 0.18, 0.18, 9), tube([0, 0.0, 0], [0, 0.03, 0], 0.048, 0.048, 8));
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + k * 0.45, y = -1.08 - k * 0.16, r0 = 0.17 + k * 0.01;
      b.add(club, 'iron', cone([Math.cos(a) * r0, y, Math.sin(a) * r0], [Math.cos(a) * (r0 + 0.11), y - 0.02, Math.sin(a) * (r0 + 0.11)], 0.028, 5));
    }
  }
  return { sword: club, hand: 'handR' };
}

// -------------------------------------------------------------------------------------------------- Ashkite
export function ashkite(c: Ctx): Built {
  const { b, d } = c;
  const h = d.head, hr = headRadii(d);
  base(c.b, d, { skin: 'skin', torso: 'charcoal', arms: 'charcoal', legs: 'charcoal', boots: 'boots', forearm: 'bandage', limb: 0.92 });
  b.add('spine', 'rust', ell([0, 0.0, 0], [0, 0.06, 0], 0.07 * d.height * d.build, 0.055 * d.height, 0.07 * d.height * d.build, 0.055 * d.height, 10));
  // A hood that rises to a point behind the head, a scarf over the face below the eyes, a leather shoulder cape.
  b.add('head', 'charcoal', ball([0, h * 0.55, hr[2] * 0.12], [hr[0] * 1.22, hr[1] * 1.14, hr[2] * 1.2], 9, 7), cone([0, h * 0.72, hr[2] * 0.7], [0, h * 0.5, hr[2] * 2.9], h * 0.34, 7),
    slab([0, h * 0.95, -hr[2] * 1.0], [hr[0] * 1.8, h * 0.1, h * 0.12], [0.2, 0, 0]));
  b.add('head', 'skin', ball([0, h * 0.47, -hr[2] * 0.55], [hr[0] * 0.84, hr[1] * 0.42, hr[2] * 0.6], 8, 5));
  b.add('head', 'bandage', ell([0, h * 0.0, -hr[2] * 0.2], [0, h * 0.42, -hr[2] * 0.2], hr[0] * 1.12, hr[2] * 1.1, hr[0] * 1.1, hr[2] * 1.08, 9, false));
  b.add('head', 'eye', slab([-h * 0.16, h * 0.5, -hr[2] * 0.97], [h * 0.1, h * 0.04, h * 0.02]), slab([h * 0.16, h * 0.5, -hr[2] * 0.97], [h * 0.1, h * 0.04, h * 0.02]));
  b.add('chest', 'rust', ell([0, d.chestLen * 0.5, 0], [0, d.chestLen + 0.03, 0], 0.17, 0.12, 0.13, 0.1, 9, false), slab([0, 0.18, -0.1], [0.2, 0.1, 0.02]));
  b.both((_s, s) => {
    b.add('arm' + s, 'charcoal', ell([0, 0.04, 0], [0, -d.upperArm * 0.5, 0], 0.062, 0.058, 0.05, 0.048, 8));
    b.add('shin' + s, 'rust', ell([0, -d.shin * 0.18, -0.01], [0, -d.shin * 0.82, -0.01], 0.04, 0.034, 0.032, 0.028, 6));
  });
  b.add('forearmL', 'iron', ell([0, -0.02, 0], [0, -d.foreArm * 0.7, 0], 0.037, 0.034, 0.033, 0.03, 6));
  // Cape on three spring bones; rags at the hip.
  ['cape1', 'cape2', 'cape3'].forEach((n, i, a) => {
    const r = c.rest(a[i + 1] ?? ''), len = r ? Math.hypot(r[0], r[1], r[2]) : 0.2;
    b.add(n, i === 1 ? 'rust' : 'charcoal', slab([0, -len / 2, 0], [0.3 - i * 0.04, len, 0.012]), ...(i === 2 ? [ell([0, -len, 0], [0, -len - 0.07, 0], 0.13, 0.006, 0.01, 0.002, 4)] : []));
  });
  rags(c, ['ragL1', 'ragL2'], 0.09, 'bandage');
  // The quiver on the back, arrows with fletching and a strap across the chest.
  b.add('chest', 'wood', tube([0.07, 0.0, 0.16], [0.02, 0.42, 0.19], 0.045, 0.05, 8), tube([0.07, -0.01, 0.16], [0.065, 0.03, 0.16], 0.055, 0.055, 8));
  b.add('chest', 'rust', slab([0.0, 0.18, -0.1], [0.02, 0.5, 0.01], [0, 0, -0.55]), slab([0.04, 0.3, 0.17], [0.04, 0.12, 0.04], [0, 0, 0.1]));
  for (let i = 0; i < 4; i++) {
    const a = i * 1.6;
    b.add('chest', 'fletch', slab([0.025 + Math.cos(a) * 0.02, 0.45 + (i % 2) * 0.03, 0.19 + Math.sin(a) * 0.02], [0.03, 0.08, 0.008], [0, a, 0.05]));
    b.add('chest', 'wood', tube([0.025 + Math.cos(a) * 0.02, 0.4, 0.19 + Math.sin(a) * 0.02], [0.025 + Math.cos(a) * 0.02, 0.45, 0.19 + Math.sin(a) * 0.02], 0.004, 0.004, 4));
  }
  // The bow in the left hand: a long curved limb and a bowstring, grip wrapped in rust cloth. The hand's Y runs along the arm.
  const bow = new THREE.Group();
  bow.name = 'bow';
  // Limbs run across the arm (the hand's Z), the belly bulges forward along the arm (-Y), the string is on the archer's side.
  bow.rotation.x = -Math.PI / 2;
  const R = 0.78, ang = 0.72;
  b.add(bow, 'wood', arc([0, 0, R], R, 0.016, -ang, ang, [0, Math.PI / 2, 0], 14));
  b.add(bow, 'rust', tube([0, 0, -0.07], [0, 0, 0.07], 0.022, 0.022, 7));
  b.add(bow, 'bone', tube([0, -R * Math.sin(ang), R - R * Math.cos(ang)], [0, R * Math.sin(ang), R - R * Math.cos(ang)], 0.003, 0.003, 3));
  // Arrow on the string, along -Y (the arrow socket).
  const arrow = new THREE.Group();
  arrow.name = 'arrow';
  b.add(arrow, 'wood', tube([0, 0.3, 0], [0, -0.62, 0], 0.006, 0.006, 4));
  b.add(arrow, 'steel', cone([0, -0.62, 0], [0, -0.72, 0], 0.012, 4));
  b.add(arrow, 'fletch', slab([0, 0.25, 0.012], [0.003, 0.1, 0.03]), slab([0.012, 0.25, 0], [0.03, 0.1, 0.003]), slab([-0.012, 0.25, 0], [0.03, 0.1, 0.003]));
  void rot;
  return { sword: bow, hand: 'handL', extra: [{ obj: arrow, bone: 'handL', pos: [0, -0.1, 0.02] }] };
}
