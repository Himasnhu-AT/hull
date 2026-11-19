// THE GREATWOOD (x in [-700,420], z in [180,1000] + FS, beyond the wide plain): ~300 giant trees, light shafts, a
// green-grey haze under the canopy, and an Outriders' supply platform built around one tree near the edge.
import * as THREE from 'hull/three';
import { Builder } from './geo';
import { Rng, clamp, lerp, smoothstep } from './rng';
import { SUN_DIR } from './common';
import type { WorldCtx } from './common';
import { groundHeight, roadX, ROAD_END, FS, FX1 } from './terrain';
import { TreeBatch, addTree, finishBatch } from './trees';
import type { TreeSpec } from './trees';
import { makeDepot } from './props';

const V3 = THREE.Vector3;

export function buildForest(ctx: WorldCtx): { trees: number } {
  const rng = new Rng(3003);
  const X0 = -700, X1 = FX1, Z0 = 188 + FS, Z1 = 1010 + FS;
  const NX = 4, NZ = 3;
  const batches: TreeBatch[] = [];
  for (let i = 0; i < NX * NZ; i++) batches.push(new TreeBatch());
  const chunkOf = (x: number, z: number) => clamp(Math.floor((x - X0) / ((X1 - X0) / NX)), 0, NX - 1) + NX * clamp(Math.floor((z - Z0) / 290), 0, NZ - 1);

  // ---- Poisson-ish placement with spacing growing with depth ----
  interface Spot { x: number; z: number; d: number; platform?: boolean }
  const placed: Spot[] = [];
  const cell = 80, grid = new Map<string, Spot[]>();
  const key = (x: number, z: number) => Math.floor(x / cell) + ',' + Math.floor(z / cell);
  const minD = (z: number) => (z < 478 + FS ? 40 : z < 768 + FS ? 54 : 74);
  const free = (x: number, z: number, d: number) => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const arr = grid.get((cx + i) + ',' + (cz + j)); if (!arr) continue;
      for (const p of arr) { const dd = Math.max(d, p.d) * 0.5 + Math.min(d, p.d) * 0.5; if (Math.hypot(p.x - x, p.z - z) < dd) return false; }
    }
    return true;
  };
  const put = (x: number, z: number, d: number, extra: { platform?: boolean } = {}) => { const p: Spot = { x, z, d, ...extra }; placed.push(p); const k = key(x, z); (grid.get(k) || grid.set(k, []).get(k)!).push(p); return p; };

  // the platform tree first, close to the forest edge next to the road
  const PLAT = { x: 46, z: 206 + FS };
  put(PLAT.x, PLAT.z, 40, { platform: true });
  for (let n = 0; n < 90000; n++) {
    const x = rng.range(X0, X1), z = rng.range(Z0, Z1);
    // ragged forest edge: fewer trees right at the border
    const edge = Math.min(smoothstep(0, 60, z - Z0) + 0.15, 1) * Math.min(smoothstep(0, 50, Math.min(x - X0, X1 - x)) + 0.2, 1);
    if (rng.next() > edge) continue;
    const d = minD(z) * rng.range(0.92, 1.1);
    if (z < ROAD_END + 20 && Math.abs(x - roadX(z)) < 13 + d * 0.15) continue;   // the wagon road stays clear
    if (free(x, z, d)) put(x, z, d);
  }

  // ---- build trees ----
  let platformInfo: { x: number; z: number; gy: number; r0: number } | null = null;
  for (const p of placed) {
    const z = p.z;
    const lod = clamp(Math.floor((z - Z0) / 290), 0, 2);
    const H = p.platform ? 96 : rng.range(72, 110);
    const r0 = p.platform ? 4.3 : clamp(2.5 + (H - 72) / 38 * 1.6 + rng.range(-0.3, 0.7), 2.5, 5);
    const spec: TreeSpec = {
      H, r0, lod, branches: lod === 0 ? [5, 7] : lod === 1 ? [4, 6] : [3, 4], branchMin: 18, len: [10, 25], rb: [0.6, 1.4],
      blobR: [7, 13.5], canopyN: lod === 0 ? 8 : lod === 1 ? 6 : 5, canopySpread: 8.5,
      avoidY: p.platform ? [27, 45] : null,
    };
    const b = batches[chunkOf(p.x, p.z)];
    addTree(ctx, b, rng, p.x, p.z, spec);
    if (p.platform) platformInfo = { x: p.x, z: p.z, gy: groundHeight(p.x, p.z), r0 };
  }
  batches.forEach((b, i) => { const row = Math.floor(i / NX); finishBatch(ctx, b, 'forest' + i, { lumps: row === 2 ? 2 : 4 }); });

  // ---- the supply platform ----
  if (platformInfo) {
    const pi = platformInfo;
    const { x, z, gy } = pi, y = gy + 35, S = 20;
    const WD = new Builder(), IR = new Builder();
    const dep = { planks: WD, iron: IR };
    // deck
    WD.box(x, y + 0.35, z, S, 0.7, S, { color: 0xe8e0d4, uTile: 2, vTile: 2, topTile: 2, vBase: y, faces: 'xXzZyY', grad: [0.7, 1] });
    ctx.col.box(x, y + 0.35, z, S / 2, 0.35, S / 2, 'wood');
    // joists under the deck
    for (const o of [-8, -4, 0, 4, 8]) { WD.box(x + o, y - 0.35, z, 0.5, 0.7, S, { color: 0xa8957c, uTile: 1, vTile: 1, faces: 'xXzZY' }); }
    // railings: four sides, posts + rail, one box collider per side
    const rh = 1.15;
    for (const [sx, sz, w, d] of [[0, S / 2 - 0.1, S, 0.2], [0, -S / 2 + 0.1, S, 0.2], [S / 2 - 0.1, 0, 0.2, S], [-S / 2 + 0.1, 0, 0.2, S]]) {
      WD.box(x + sx, y + 0.7 + rh - 0.1, z + sz, w, 0.16, d, { color: 0xc0ac94, uTile: 2, vTile: 1, faces: 'xXzZyY' });
      WD.box(x + sx, y + 0.7 + rh * 0.5, z + sz, w, 0.12, d, { color: 0xc0ac94, uTile: 2, vTile: 1, faces: 'xXzZyY' });
      ctx.col.box(x + sx, y + 0.7 + rh * 0.55, z + sz, w / 2, rh * 0.55, d / 2, 'wood');
    }
    for (let i = -4; i <= 4; i++) for (const [px, pz] of [[i * 2.5, S / 2 - 0.1], [i * 2.5, -S / 2 + 0.1], [S / 2 - 0.1, i * 2.5], [-S / 2 + 0.1, i * 2.5]]) {
      if (Math.abs(i) === 4 && (Math.abs(px) !== S / 2 - 0.1 && Math.abs(pz) !== S / 2 - 0.1)) continue;
      WD.box(x + px, y + 0.7 + rh / 2, z + pz, 0.2, rh, 0.2, { color: 0xa8957c, uTile: 1, vTile: 1, faces: 'xXzZy' });
    }
    // diagonal support struts down to the trunk
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = new V3(x + sx * (pi.r0 * 0.9), y - 8, z + sz * (pi.r0 * 0.9)), b = new V3(x + sx * (S / 2 - 1.2), y - 0.7, z + sz * (S / 2 - 1.2));
      WD.tube([a, a.clone().lerp(b, 0.5), b], () => 0.32, { seg: 6, color: new THREE.Color(0xa8957c), uTile: 2, vTile: 3 });
      ctx.col.cap(a.x, a.y, a.z, b.x, b.y, b.z, 0.32, 'wood');
    }
    makeDepot(ctx, dep, x + 4.5, y + 0.7, z + 6.5, 0, { radius: 10.5, back: -2.6, flagX: 5.6, flagH: 8.5 });
    ctx.flag('outriders', x - S / 2 + 0.6, y + 0.7, z - S / 2 + 0.6, { h: 13, s: 1.6, yaw: 0 });
    const wm = new THREE.Mesh(WD.toGeometry(), ctx.mat.planks); wm.name = 'platformWood'; ctx.add(wm);
    const im = new THREE.Mesh(IR.toGeometry(), ctx.mat.plain); im.name = 'platformIron'; ctx.add(im);
  }

  // ---- light shafts (additive cones, soft edges, fade with distance) ----
  const shaftMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uColor: { value: new THREE.Color(1.0, 0.93, 0.78) }, uOpacity: { value: 0.1 } },
    vertexShader: `varying float vV; varying vec3 vN; varying vec3 vVD; varying float vDist;
      void main(){ vV = uv.y; vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 ); vec4 mv = viewMatrix * wp;
        vN = normalize( mat3( viewMatrix ) * mat3( modelMatrix ) * mat3( instanceMatrix ) * normal ); vVD = normalize( -mv.xyz ); vDist = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying float vV; varying vec3 vN; varying vec3 vVD; varying float vDist;
      void main(){ float f = pow( abs( dot( normalize( vN ), normalize( vVD ) ) ), 1.6 );
        float a = uOpacity * f * smoothstep( 0.0, 0.25, vV ) * ( 0.35 + 0.65 * vV ) * smoothstep( 520.0, 120.0, vDist ) * smoothstep( 25.0, 70.0, vDist );
        gl_FragColor = vec4( uColor * a, 1.0 ); }`,
  });
  const cone = new THREE.CylinderGeometry(2.2, 8.5, 1, 12, 1, true); cone.translate(0, -0.5, 0);
  const NS = 170, shafts = new THREE.InstancedMesh(cone, shaftMat, NS);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), SUN_DIR), pp = new V3(), ss = new V3();
  const srng = new Rng(404);
  for (let i = 0; i < NS; i++) {
    const x = srng.range(-620, FX1 - 70), z = srng.range(205 + FS, 800 + FS), h = srng.range(55, 105), gy = groundHeight(x, z), k = srng.range(0.6, 1.4);
    pp.set(x + SUN_DIR.x * h / SUN_DIR.y, gy + h, z + SUN_DIR.z * h / SUN_DIR.y);
    // the cone's local length runs along SUN_DIR, so scale y by the slant length
    ss.set(k, h / SUN_DIR.y, k);
    m4.compose(pp, q, ss); shafts.setMatrixAt(i, m4);
  }
  shafts.instanceMatrix.needsUpdate = true; shafts.frustumCulled = false; shafts.renderOrder = 5; shafts.name = 'lightShafts';
  ctx.scene.add(shafts);

  // ---- fog goes darker and greener under the canopy ----
  // blends from the current atmosphere (ctx.atmo, set by world.setAtmosphere) to the green haze under the canopy
  const fog = ctx.scene.fog as THREE.Fog, bg = ctx.scene.background as THREE.Color, A = ctx.atmo, deep = new THREE.Color(0x5d6c5e), tmp = new THREE.Color();
  let fk = 0;
  ctx.updaters.push((dt, cam) => {
    const inF = smoothstep(150 + FS, 240 + FS, cam.z) * (1 - smoothstep(700, 800, -cam.x)) * (1 - smoothstep(FX1, FX1 + 100, cam.x)) * (1 - smoothstep(1000 + FS, 1100 + FS, cam.z));
    const low = 1 - smoothstep(60, 115, cam.y - groundHeight(cam.x, cam.z));
    const target = inF * low;
    fk += (target - fk) * Math.min(1, dt * 2.5);
    fog.color.copy(A.fog).lerp(tmp.copy(deep).multiply(A.canopy), fk * 0.8);
    fog.near = lerp(A.near, 25, fk); fog.far = lerp(A.far, 620, fk);
    bg.copy(fog.color);
  });

  // ---- titan spawn zones ----
  for (const [x, z, r] of [[-300, 260, 30], [-60, 300, 30], [180, 280, 30], [330, 380, 30], [-220, 420, 30], [40, 460, 30], [-380, 540, 30], [250, 560, 30], [-60, 590, 30]])
    ctx.titanSpawns.push({ center: new V3(x, groundHeight(x, z + FS), z + FS), radius: r, area: 'forest' });
  return { trees: placed.length };
}
