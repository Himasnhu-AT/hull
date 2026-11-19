// Ground: gentle hills in the field/forest (flat near the wall and in town), meadow, dirt road, cobbled town floor.
import * as THREE from 'hull/three';
import { Builder } from './geo';
import { noise2 } from './common';
import type { WorldCtx } from './common';
import { smoothstep, clamp } from './rng';

/** Terrain height. Flat for z < 30 (wall, gate yard, town); rolling hills (+-3 m) beyond. */
export function groundHeight(x: number, z: number): number {
  const t = smoothstep(30, 75, z);
  if (t <= 0) return 0;
  const h = noise2(x * 0.011, z * 0.011) * 2.1 + noise2(x * 0.027 + 11.3, z * 0.027) * 0.8 + noise2(x * 0.07, z * 0.07 + 5.1) * 0.25;
  return h * t;
}

/** The Greatwood starts this far beyond the field it once bordered (z ≈ 188 + FS): a wide plain lies between the
 * Ashwall and the trees, for the expedition's ride out. Everything placed in the forest is shifted by it. */
export const FS = 300;
/** The forest's east edge (x): east of it open land runs north past the forest (the expedition's route; riding
 * north, the trees are on the formation's right, which is -x). */
export const FX1 = 420;
/** The road runs from the gate to here (z) through the forest. */
export const ROAD_END = 940 + FS;
export const roadX = (z: number): number => 20 * Math.sin((z - FS) / 62) * smoothstep(18, 70, z);

const cB = new THREE.Color();
// vertex tints (multiply the ground shader's own colours): only the forest floor and the town edge use them
const FIELD = new THREE.Color(0xf4f4ee), FIELD_DRY = new THREE.Color(0xfff6e4), FOREST = new THREE.Color(0xf2f0e6), FOREST_DARK = new THREE.Color(0xa8aaa0), TOWNOUT = new THREE.Color(0xd8d8cc);
export function groundTint(x: number, z: number, out = new THREE.Color()): THREE.Color {
  const n = noise2(x * 0.02 + 3, z * 0.02 - 4), n2 = noise2(x * 0.06, z * 0.06);
  const forest = smoothstep(150 + FS, 250 + FS, z) * (1 - smoothstep(700, 860, -x)) * (1 - smoothstep(FX1, FX1 + 160, x)) * (1 - smoothstep(1050 + FS, 1250 + FS, z));
  if (z < 0) out.copy(TOWNOUT).multiplyScalar(0.92 + n * 0.1);
  else {
    out.copy(FIELD).lerp(FIELD_DRY, clamp(n * 0.9 + 0.1, 0, 1) * 0.55);
    out.multiplyScalar(0.92 + n2 * 0.08);
    cB.copy(FOREST).lerp(FOREST_DARK, clamp(0.5 + n * 0.9, 0, 1)).multiplyScalar(0.92 + n2 * 0.1);
    out.lerp(cB, forest);
  }
  return out;
}

export function buildGround(ctx: WorldCtx): { ground: THREE.Mesh } {
  ctx.game.collision.setGround(groundHeight);

  // irregular grid: fine where the hills are
  const xs = [-1700, -1400, -1250];
  for (let x = -1100; x <= 1100; x += 11) xs.push(x);
  xs.push(1250, 1400, 1700);
  const zs = [-1000, -520, -200, -40, 0, 30];
  for (let z = 40; z <= 1100 + FS; z += 10) zs.push(z);
  zs.push(1250 + FS, 1500 + FS, 1800 + FS);
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
  const c = new THREE.Color();
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const k = i * nz + j, x = xs[i], z = zs[j];
    pos[k * 3] = x; pos[k * 3 + 1] = groundHeight(x, z); pos[k * 3 + 2] = z;
    groundTint(x, z, c); col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    uv[k * 2] = x / 8; uv[k * 2 + 1] = z / 8;
  }
  const idx: number[] = [];
  for (let i = 0; i < nx - 1; i++) for (let j = 0; j < nz - 1; j++) {
    const a = i * nz + j, b = (i + 1) * nz + j, d = i * nz + j + 1, e = (i + 1) * nz + j + 1;
    idx.push(a, d, b, b, d, e);   // normal +y
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  const ground = new THREE.Mesh(g, ctx.mat.grass);
  ground.name = 'ground'; ctx.add(ground, false, true);

  // dirt road from the gate across the field and on through the Greatwood (the wagon road the Outriders' centre
  // column takes on the expedition)
  const b = new Builder();
  const rc = new THREE.Color(1, 1, 1);
  for (let z0 = 6; z0 < ROAD_END; z0 += 3) {
    const z1 = z0 + 3, x0 = roadX(z0), x1 = roadX(z1);
    const w0 = 4.6 + noise2(z0 * 0.1, 1) * 0.6, w1 = 4.6 + noise2(z1 * 0.1, 1) * 0.6;
    const y = (x: number, z: number) => groundHeight(x, z) + 0.07;
    const L0 = [x0 - w0, y(x0 - w0, z0), z0], R0 = [x0 + w0, y(x0 + w0, z0), z0], R1 = [x1 + w1, y(x1 + w1, z1), z1], L1 = [x1 - w1, y(x1 - w1, z1), z1];
    b.quad([L0, L1, R1, R0], [[0, z0 / 9], [0, z1 / 9], [1, z1 / 9], [1, z0 / 9]], rc);   // one repeat across the road
  }
  const rm = new THREE.Mesh(b.toGeometry(), ctx.mat.dirt);
  rm.name = 'road'; ctx.add(rm, false, true);

  // cobbled floor of the whole of Varn (plus the gate yard)
  const f = new Builder();
  const x0 = -372, x1 = 372, z0 = -468, z1 = -6;
  f.quad([[x0, 0.04, z1], [x1, 0.04, z1], [x1, 0.04, z0], [x0, 0.04, z0]], [[x0 / 4, -z1 / 4], [x1 / 4, -z1 / 4], [x1 / 4, -z0 / 4], [x0 / 4, -z0 / 4]], new THREE.Color(1, 1, 1));
  const floor = new THREE.Mesh(f.toGeometry(), ctx.mat.cobbles);
  floor.name = 'townFloor'; ctx.add(floor, false, true);
  return { ground };
}
