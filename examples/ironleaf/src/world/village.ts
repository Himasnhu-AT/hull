// The hill village of Kitsugi and the shrine above it: houses, a plaza with a well, a torii gate, stone lanterns, fences,
// drying racks, the shrine steps. Every house is an axis-aligned box so its collider is a box too. The walls and roofs are
// one vertex-coloured mesh; the lit windows and lantern flames are a second, unlit mesh so they glow at night.
import * as THREE from 'hull/three';
import { Geo } from './geo';
import { GATE, SHRINE, VILLAGE, groundHeight } from './map';

export interface Block { x: number; y: number; z: number; sx: number; sy: number; sz: number }

interface House { dx: number; dz: number; w: number; d: number; h: number; thatch: boolean; big?: boolean }

// Offsets from the village centre. The plaza is left clear, the gate is to the south-west.
const HOUSES: House[] = [
  { dx: -15, dz: -8, w: 8, d: 6, h: 3.2, thatch: true },
  { dx: -14, dz: 8, w: 7, d: 6, h: 3.0, thatch: false },
  { dx: 2, dz: -17, w: 9, d: 7, h: 3.6, thatch: false, big: true },
  { dx: 17, dz: -10, w: 7, d: 6, h: 3.0, thatch: true },
  { dx: 17, dz: 7, w: 8, d: 6, h: 3.2, thatch: true },
  { dx: 3, dz: 16, w: 7, d: 6, h: 3.0, thatch: false },
  { dx: -6, dz: 18, w: 5, d: 5, h: 2.6, thatch: true },
];

export interface VillageParts { group: THREE.Group; blocks: Block[]; lights: { x: number; y: number; z: number }[] }

export function buildVillage(): VillageParts {
  const solid = new Geo();
  const glow = new Geo();
  glow.jitter = 0;
  const blocks: Block[] = [];
  const lights: { x: number; y: number; z: number }[] = [];
  const ground = (x: number, z: number): number => groundHeight(x, z);

  for (const hs of HOUSES) {
    const x = VILLAGE.x + hs.dx, z = VILLAGE.z + hs.dz;
    const y = ground(x, z);
    // plinth, walls, posts, roof
    solid.box(x, y + 0.2, z, hs.w + 0.3, 0.5, hs.d + 0.3, '#807a70');
    solid.box(x, y + 0.45 + hs.h / 2, z, hs.w, hs.h, hs.d, hs.big ? '#d3c7ab' : '#d9cfb8');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) solid.box(x + (sx * hs.w) / 2, y + 0.45 + hs.h / 2, z + (sz * hs.d) / 2, 0.22, hs.h + 0.05, 0.22, '#3d2b20');
    solid.box(x, y + 0.45 + hs.h, z, hs.w + 0.1, 0.2, hs.d + 0.1, '#3d2b20');
    solid.hipRoof(x, y + 0.55 + hs.h, z, hs.w + 1.6, hs.d + 1.6, 1.8 + hs.h * 0.25, hs.w * 0.5, hs.thatch ? '#8d7648' : '#3b3b44', hs.thatch ? '#7a653c' : '#34343c');
    // a door on the plaza side and two windows
    const toX = Math.sign(-hs.dx) || 1, toZ = Math.sign(-hs.dz) || 1;
    const faceZ = Math.abs(hs.dz) >= Math.abs(hs.dx);
    if (faceZ) {
      solid.box(x, y + 1.5, z + (toZ * hs.d) / 2, 1.3, 2.2, 0.1, '#46301f');
      glow.box(x - hs.w * 0.3, y + 2.0, z + (toZ * hs.d) / 2, 0.8, 0.8, 0.06, '#ffc873');
      glow.box(x + hs.w * 0.3, y + 2.0, z + (toZ * hs.d) / 2, 0.8, 0.8, 0.06, '#ffc873');
      lights.push({ x, y: y + 2, z: z + toZ * (hs.d / 2 + 1) });
    } else {
      solid.box(x + (toX * hs.w) / 2, y + 1.5, z, 0.1, 2.2, 1.3, '#46301f');
      glow.box(x + (toX * hs.w) / 2, y + 2.0, z - hs.d * 0.3, 0.06, 0.8, 0.8, '#ffc873');
      glow.box(x + (toX * hs.w) / 2, y + 2.0, z + hs.d * 0.3, 0.06, 0.8, 0.8, '#ffc873');
      lights.push({ x: x + toX * (hs.w / 2 + 1), y: y + 2, z });
    }
    blocks.push({ x, y: y + (0.45 + hs.h) / 2, z, sx: hs.w + 0.3, sy: 0.45 + hs.h + 1, sz: hs.d + 0.3 });
  }

  // the well in the plaza: a stone ring, two posts and a little roof
  {
    const x = VILLAGE.x, z = VILLAGE.z, y = ground(x, z);
    solid.cyl(x, y, z, 1.0, 1.0, 0.8, 10, '#8a857b');
    solid.box(x - 0.9, y + 1.5, z, 0.14, 1.6, 0.14, '#3d2b20'); solid.box(x + 0.9, y + 1.5, z, 0.14, 1.6, 0.14, '#3d2b20');
    solid.hipRoof(x, y + 2.3, z, 2.6, 1.8, 0.8, 1.4, '#3b3b44');
    blocks.push({ x, y: y + 0.4, z, sx: 2.1, sy: 0.9, sz: 2.1 });
  }

  // the torii gate at the foot of the village
  {
    const x = GATE.x, z = GATE.z, y = ground(x, z);
    solid.yaw = -0.35;
    solid.ox = x; solid.oz = z; solid.oy = y;
    for (const s of [-1, 1]) solid.cyl(s * 2.4, 0, 0, 0.32, 0.26, 5.2, 8, '#a6261d');
    solid.box(0, 4.7, 0, 7.4, 0.28, 0.4, '#a6261d');
    solid.box(0, 5.35, 0, 8.4, 0.34, 0.5, '#1d1a1a');
    solid.box(0, 5.65, 0, 8.8, 0.14, 0.6, '#1d1a1a');
    solid.yaw = 0; solid.ox = solid.oy = solid.oz = 0;
  }

  // stone lanterns along the path to the shrine and at the plaza
  const lanterns: [number, number][] = [[56, -25], [66, -26], [70, -31], [76, -39], [80, -45], [86, -55], [40, -9], [48, -16], [58, -13]];
  for (const [lx, lz] of lanterns) {
    const y = ground(lx, lz);
    solid.cyl(lx, y, lz, 0.28, 0.22, 0.9, 6, '#8a857b');
    solid.box(lx, y + 1.15, lz, 0.5, 0.45, 0.5, '#7d786f');
    glow.box(lx, y + 1.15, lz, 0.32, 0.28, 0.32, '#ffb85a');
    solid.hipRoof(lx, y + 1.38, lz, 0.9, 0.9, 0.35, 0.3, '#6e6a62');
    lights.push({ x: lx, y: y + 1.2, z: lz });
  }

  // fences round the houses' yards and drying racks with hanging cloth
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const x = VILLAGE.x + Math.cos(a) * 27, z = VILLAGE.z + Math.sin(a) * 27;
    if (Math.hypot(x - GATE.x, z - GATE.z) < 9 || Math.hypot(x - 74, z + 34) < 6) continue;
    const y = ground(x, z);
    solid.box(x, y + 0.6, z, 0.12, 1.2, 0.12, '#5c4631');
    solid.yaw = -a + Math.PI / 2;
    solid.ox = x; solid.oz = z; solid.oy = y;
    solid.box(0, 0.5, 0, 0.06, 0.08, 3.3, '#5c4631'); solid.box(0, 0.95, 0, 0.06, 0.08, 3.3, '#5c4631');
    solid.yaw = 0; solid.ox = solid.oy = solid.oz = 0;
  }
  for (const [rx, rz, ry] of [[48, -28, 0.4], [76, -4, 2.2], [40, 2, 1.1]] as [number, number, number][]) {
    const y = ground(rx, rz);
    solid.yaw = ry; solid.ox = rx; solid.oz = rz; solid.oy = y;
    solid.box(-1.4, 1.1, 0, 0.12, 2.2, 0.12, '#5c4631'); solid.box(1.4, 1.1, 0, 0.12, 2.2, 0.12, '#5c4631');
    solid.box(0, 2.15, 0, 3.0, 0.1, 0.1, '#5c4631');
    for (let k = 0; k < 4; k++) solid.box(-1.0 + k * 0.7, 1.55, 0, 0.5, 1.0, 0.03, k % 2 ? '#c9b98c' : '#8aa0ad');
    solid.yaw = 0; solid.ox = solid.oy = solid.oz = 0;
  }

  // the shrine: steps up the hill, a platform, a small hall with a red-framed roof, a stone fox on each side
  {
    const top = ground(SHRINE.x, SHRINE.z);
    const sx = SHRINE.x, sz = SHRINE.z;
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      const x = 84 + (sx - 84) * t, z = -50 + (sz + 50) * t;
      const y = ground(x, z);
      solid.yaw = Math.atan2(sx - 84, -(sz + 50)) * -1;
      solid.ox = x; solid.oz = z; solid.oy = y;
      solid.box(0, 0.12, 0, 3.4, 0.4, 1.3, '#8d887d');
      solid.yaw = 0; solid.ox = solid.oy = solid.oz = 0;
    }
    solid.box(sx, top + 0.3, sz, 12, 0.6, 10, '#8d887d');
    solid.box(sx, top + 2.0, sz - 1, 6.4, 3.0, 4.6, '#c9b999');
    for (const px of [-3.2, 3.2]) for (const pz of [-3.3, 1.3]) solid.box(sx + px, top + 2.0, sz + pz, 0.3, 3.2, 0.3, '#a6261d');
    solid.hipRoof(sx, top + 3.5, sz - 1, 9, 7.4, 2.6, 4, '#2f2f38', '#2a2a32');
    glow.box(sx, top + 2.0, sz + 1.35, 2.2, 1.8, 0.06, '#ffc873');
    lights.push({ x: sx, y: top + 2, z: sz + 3 });
    for (const px of [-4, 4]) {
      solid.box(sx + px, top + 1.1, sz + 3.6, 0.9, 1.0, 0.9, '#9a958a');
      solid.box(sx + px, top + 1.85, sz + 3.6, 0.55, 0.55, 0.55, '#a6a196');
    }
    blocks.push({ x: sx, y: top + 1.5, z: sz - 1, sx: 6.6, sy: 3.5, sz: 4.8 });
  }

  const group = new THREE.Group();
  const sm = new THREE.Mesh(solid.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide }));
  sm.castShadow = true; sm.receiveShadow = true;
  group.add(sm);
  const gm = new THREE.Mesh(glow.build(), new THREE.MeshBasicMaterial({ vertexColors: true }));
  group.add(gm);
  return { group, blocks, lights };
}
