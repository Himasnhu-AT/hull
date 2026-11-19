// The island's ground: one coloured mesh, a sea plane, and the same heights as a physics heightfield, so what Aya stands on
// is what is drawn. The colours say what the ground is (grass, pampas straw, trodden dirt, sand, rock) without a texture.
import * as THREE from 'hull/three';
import { fbm, smoothstep } from './rng';
import { SEA, VILLAGE, bambooAmount, groundHeight, pampasAmount, pathDistance } from './map';

export const CELL = 1.2;
export const COLS = 257;
export const HALF = ((COLS - 1) * CELL) / 2;

export interface TerrainData { heights: Float32Array; cols: number; rows: number; cell: number; origin: [number, number] }

export function terrainData(): TerrainData {
  const heights = new Float32Array(COLS * COLS);
  for (let j = 0; j < COLS; j++) for (let i = 0; i < COLS; i++) heights[j * COLS + i] = groundHeight(-HALF + i * CELL, -HALF + j * CELL);
  return { heights, cols: COLS, rows: COLS, cell: CELL, origin: [-HALF, -HALF] };
}

const col = new THREE.Color();
const tmp = new THREE.Color();
const lerpHex = (out: THREE.Color, a: string, b: string, t: number): THREE.Color => out.set(a).lerp(tmp.set(b), t);

/** The ground colour at a point and a height. */
function paint(out: THREE.Color, x: number, z: number, h: number, slope: number): void {
  const n = fbm(x * 0.09, z * 0.09, 5);
  // Two noise scales: broad hue patches (lush, dry, olive) and fine speckle, so the meadow is never one green.
  const grass = lerpHex(out, '#7a9a40', '#a3ad4e', n);
  grass.lerp(lerpHex(col, '#5e8a3c', '#b9b256', fbm(x * 0.035 + 40, z * 0.035 - 17, 3)), 0.45);
  grass.multiplyScalar(0.92 + 0.16 * fbm(x * 0.6, z * 0.6, 21));
  // pampas straw under the grass fields
  lerpHex(col, '#c8a65a', '#e2c47a', fbm(x * 0.2, z * 0.2, 12));
  grass.lerp(col, pampasAmount(x, z) * 0.75);
  // bamboo floor: leaf litter and moss
  grass.lerp(lerpHex(col, '#59623a', '#6f6a3f', n), bambooAmount(x, z) * 0.9);
  // village ground and paths
  grass.lerp(lerpHex(col, '#cdb98e', '#b9a474', n), (1 - smoothstep(VILLAGE.r * 0.55, VILLAGE.r * 0.8, Math.hypot(x - VILLAGE.x, z - VILLAGE.z))) * 0.85);
  grass.lerp(lerpHex(col, '#d0b988', '#bba575', n), 1 - smoothstep(0.9, 2.2, pathDistance(x, z)));
  // sand by the water and rock on the steep
  grass.lerp(lerpHex(col, '#d4c08e', '#c1ad7c', n), 1 - smoothstep(0.6, 1.4, h));
  grass.lerp(lerpHex(col, '#7c786f', '#66625a', n), smoothstep(0.55, 0.95, slope));
}

/** The island and its sea, as one Group under whatever node holds it. */
export function buildTerrain(t: TerrainData): THREE.Group {
  const g = new THREE.Group();
  const n = t.cols;
  const pos = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      pos[k * 3] = t.origin[0] + i * t.cell;
      pos[k * 3 + 1] = t.heights[k]!;
      pos[k * 3 + 2] = t.origin[1] + j * t.cell;
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const hx = t.heights[j * n + Math.min(n - 1, i + 1)]! - t.heights[j * n + Math.max(0, i - 1)]!;
      const hz = t.heights[Math.min(n - 1, j + 1) * n + i]! - t.heights[Math.max(0, j - 1) * n + i]!;
      const slope = Math.hypot(hx, hz) / (2 * t.cell);
      paint(col, pos[k * 3]!, pos[k * 3 + 2]!, pos[k * 3 + 1]!, slope);
      colors[k * 3] = col.r; colors[k * 3 + 1] = col.g; colors[k * 3 + 2] = col.b;
    }
  }
  let w = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[w++] = a; idx[w++] = c; idx[w++] = b;
      idx[w++] = b; idx[w++] = c; idx[w++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const land = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
  land.receiveShadow = true;
  land.castShadow = false;
  g.add(land);

  // The sea: a big flat plane a little under the shore, glossy so the sky shows in it.
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshStandardMaterial({ color: '#2d5a6b', roughness: 0.12, metalness: 0.05 }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = SEA - 0.25;
  sea.receiveShadow = true;
  g.add(sea);
  return g;
}
