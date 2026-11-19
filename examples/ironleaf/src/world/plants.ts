// Pampas grass, bamboo, cedars and maples, all placed from the map by a seeded generator and drawn as a few instanced
// meshes. They bend in the wind in the vertex shader (wind.ts).
import * as THREE from 'hull/three';
import { Geo } from './geo';
import { GROVES, VILLAGE, bambooAmount, groundHeight, pampasAmount, pathDistance } from './map';
import { mulberry } from './rng';
import { windify } from './wind';

export interface Placed { x: number; y: number; z: number; yaw: number; s: number; tint: number }

/** One pampas clump: a fan of long blades that arch over, with a pale feathery plume at the tip. */
function pampasGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  g.jitter = 0.08;
  const r = mulberry(5);
  const blades = 7;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + r() * 0.6;
    const len = 0.8 + r() * 0.7;
    const lean = 0.25 + r() * 0.35;
    const base: [number, number, number] = [Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05];
    const mid: [number, number, number] = [Math.cos(a) * (0.05 + lean * 0.4), len * 0.55, Math.sin(a) * (0.05 + lean * 0.4)];
    const tip: [number, number, number] = [Math.cos(a) * (0.05 + lean), len, Math.sin(a) * (0.05 + lean)];
    g.leaf(base, mid, 0.07, '#6d7d35', '#9a9a48');
    g.leaf(mid, tip, 0.05, '#a39a4c', '#d9c47c');
  }
  // plumes: a few tall stalks topped with a cream tuft
  for (let p = 0; p < 3; p++) {
    const a = r() * Math.PI * 2, lean = 0.1 + r() * 0.25, len = 1.35 + r() * 0.35;
    const base: [number, number, number] = [0, 0, 0];
    const tip: [number, number, number] = [Math.cos(a) * lean, len, Math.sin(a) * lean];
    g.leaf(base, tip, 0.03, '#a89a58', '#e6d9a8');
    g.leaf([tip[0], tip[1] - 0.28, tip[2]], [tip[0] + Math.cos(a) * 0.05, tip[1] + 0.12, tip[2] + Math.sin(a) * 0.05], 0.16, '#d9c98f', '#f2e9c8');
  }
  return g.build();
}

/** A bamboo stalk with its nodes, and the crown of leaves on top. 9 m tall at scale 1. */
function bambooGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  g.jitter = 0.1;
  const H = 9, seg = 10;
  for (let i = 0; i < seg; i++) {
    const y = (H * i) / seg;
    const r0 = 0.06 - 0.025 * (i / seg), r1 = 0.06 - 0.025 * ((i + 1) / seg);
    g.cyl(0, y, 0, r0, r1, H / seg, 6, i % 2 ? '#7da443' : '#86ad4a', false);
    g.cyl(0, y + H / seg - 0.03, 0, r1 * 1.25, r1 * 1.25, 0.04, 6, '#566d2c', false);
  }
  const r = mulberry(11);
  for (let tier = 0; tier < 6; tier++) {
    const y = 4.6 + tier * 0.8;
    for (let k = 0; k < 7; k++) {
      const a = r() * Math.PI * 2, out = 0.5 + r() * 0.55;
      g.leaf([0, y, 0], [Math.cos(a) * out, y - 0.2 - r() * 0.3, Math.sin(a) * out], 0.1, '#5f9033', '#9dc455');
    }
  }
  return g.build();
}

/** A cedar: a trunk and four tiers of dark cones. 14 m tall. */
function cedarGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  g.jitter = 0.1;
  g.cyl(0, 0, 0, 0.34, 0.2, 14, 7, '#4b3a2c', false);
  const tiers = 5;
  for (let t = 0; t < tiers; t++) {
    const y = 3.5 + t * 2.1;
    const r = 2.1 - t * 0.33;
    g.cyl(0, y, 0, r, 0.06, 3.4, 8, t % 2 ? '#2c4a2b' : '#335432');
  }
  return g.build();
}

/** A maple: a short trunk under a few lumps of red or gold leaves. */
function mapleGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  g.jitter = 0.18;
  g.cyl(0, 0, 0, 0.22, 0.14, 3.2, 6, '#4d3a2c', false);
  const r = mulberry(3);
  for (let i = 0; i < 7; i++) {
    const a = r() * Math.PI * 2, d = r() * 1.5, y = 3.3 + r() * 1.7, s = 1.0 + r() * 0.7;
    g.ox = Math.cos(a) * d; g.oy = y; g.oz = Math.sin(a) * d;
    const col = i % 3 === 0 ? '#c4552b' : i % 3 === 1 ? '#d98a35' : '#b03a2a';
    // a squat octahedron reads as a clump of leaves
    const t = s;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      g.tri([sx * t, 0, 0], [0, 0, sz * t], [0, t * 0.8, 0], col);
      g.tri([0, 0, sz * t], [sx * t, 0, 0], [0, -t * 0.6, 0], col);
    }
  }
  g.ox = g.oy = g.oz = 0;
  return g.build();
}

function boulderGeometry(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 1).toNonIndexed();
  const p = ico.getAttribute('position') as THREE.BufferAttribute;
  const r = mulberry(8);
  const jit = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const key = p.getX(i).toFixed(3) + p.getY(i).toFixed(3) + p.getZ(i).toFixed(3);
    let k = jit.get(key);
    if (k === undefined) { k = 0.8 + r() * 0.4; jit.set(key, k); }
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.7, p.getZ(i) * k);
  }
  ico.computeVertexNormals();
  const c = new Float32Array(p.count * 3);
  const col = new THREE.Color('#7b786f');
  for (let i = 0; i < p.count; i++) { const j = 0.9 + ((i / 3) | 0) % 5 * 0.04; c[i * 3] = col.r * j; c[i * 3 + 1] = col.g * j; c[i * 3 + 2] = col.b * j; }
  ico.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return ico;
}

function scatter(geo: THREE.BufferGeometry, mat: THREE.Material, items: Placed[], cast: boolean, tints: [string, string]): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
  const mm = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const a = new THREE.Color(tints[0]), b = new THREE.Color(tints[1]), c = new THREE.Color();
  items.forEach((it, i) => {
    e.set(0, it.yaw, 0);
    q.setFromEuler(e);
    p.set(it.x, it.y, it.z);
    s.set(it.s, it.s, it.s);
    mm.compose(p, q, s);
    m.setMatrixAt(i, mm);
    m.setColorAt(i, c.copy(a).lerp(b, it.tint));
  });
  m.count = items.length;
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  m.frustumCulled = false;
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}

export interface Plants { group: THREE.Group; counts: Record<string, number> }

/** Places every plant on the map (the same every time) and builds the instanced meshes. */
export function buildPlants(): Plants {
  const group = new THREE.Group();
  const counts: Record<string, number> = {};

  // pampas: a jittered grid, kept where the map says the fields are
  const r = mulberry(101);
  const pampas: Placed[] = [];
  const step = 1.7;
  for (let gx = -125; gx < 125; gx += step) {
    for (let gz = -125; gz < 125; gz += step) {
      const x = gx + (r() - 0.5) * step, z = gz + (r() - 0.5) * step;
      const m = pampasAmount(x, z);
      if (m <= 0.12 || r() > m * 1.1) continue;
      pampas.push({ x, y: groundHeight(x, z) - 0.02, z, yaw: r() * 6.28, s: 1.0 + r() * 0.7 * (0.6 + m), tint: r() });
    }
  }
  const pm = windify(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 }), { bendH: 1.4, amp: 1.0 });
  group.add(scatter(pampasGeometry(), pm, pampas, false, ['#cfc7ae', '#ffffff']));
  counts['pampas'] = pampas.length;

  // bamboo
  const bamboo: Placed[] = [];
  for (const s of GROVES) {
    for (let gx = s.x - s.r; gx < s.x + s.r; gx += 1.15) {
      for (let gz = s.z - s.r; gz < s.z + s.r; gz += 1.15) {
        const x = gx + (r() - 0.5) * 1.1, z = gz + (r() - 0.5) * 1.1;
        const m = bambooAmount(x, z);
        if (m < 0.25 || r() > m) continue;
        bamboo.push({ x, y: groundHeight(x, z) - 0.05, z, yaw: r() * 6.28, s: 0.75 + r() * 0.55, tint: r() });
      }
    }
  }
  const bm = windify(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 }), { bendH: 9, amp: 1.9 });
  group.add(scatter(bambooGeometry(), bm, bamboo, true, ['#e8f0d8', '#ffffff']));
  counts['bamboo'] = bamboo.length;

  // cedars on the shrine hill and round the village edge, maples in the village
  const cedars: Placed[] = [], maples: Placed[] = [], rocks: Placed[] = [];
  for (let i = 0; i < 400 && cedars.length < 90; i++) {
    const x = (r() - 0.5) * 240, z = (r() - 0.5) * 240;
    const h = groundHeight(x, z);
    if (h < 1.2 || pathDistance(x, z) < 4 || pampasAmount(x, z) > 0.1 || bambooAmount(x, z) > 0.05) continue;
    if (Math.hypot(x - VILLAGE.x, z - VILLAGE.z) < 22) continue;
    cedars.push({ x, y: h - 0.1, z, yaw: r() * 6.28, s: 0.7 + r() * 0.7, tint: r() });
  }
  for (let i = 0; i < 300 && maples.length < 22; i++) {
    const a = r() * 6.28, d = 16 + r() * 16;
    const x = VILLAGE.x + Math.cos(a) * d, z = VILLAGE.z + Math.sin(a) * d;
    if (pathDistance(x, z) < 3.5) continue;
    maples.push({ x, y: groundHeight(x, z) - 0.1, z, yaw: r() * 6.28, s: 0.8 + r() * 0.5, tint: r() });
  }
  for (let i = 0; i < 600 && rocks.length < 70; i++) {
    const x = (r() - 0.5) * 240, z = (r() - 0.5) * 240;
    const h = groundHeight(x, z);
    if (h < -0.3 || pathDistance(x, z) < 2.5 || Math.hypot(x - VILLAGE.x, z - VILLAGE.z) < 20) continue;
    rocks.push({ x, y: h + 0.1, z, yaw: r() * 6.28, s: 0.4 + r() * r() * 2.2, tint: r() });
  }
  group.add(scatter(cedarGeometry(), windify(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), { bendH: 14, amp: 0.5 }), cedars, true, ['#ffffff', '#cfd8c8']));
  group.add(scatter(mapleGeometry(), windify(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 }), { bendH: 5, amp: 0.5 }), maples, true, ['#ffffff', '#ffe0c0']));
  group.add(scatter(boulderGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), rocks, true, ['#ffffff', '#d8d4c8']));
  counts['cedars'] = cedars.length; counts['maples'] = maples.length; counts['rocks'] = rocks.length;
  return { group, counts };
}
