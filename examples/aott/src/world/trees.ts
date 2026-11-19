// Procedural trees: tapered ribbed trunks with buttress roots, near-horizontal capsule-collided branches,
// visual-only twigs and collider-free foliage masses (instanced). Shared by the Greatwood and the lone field trees.
import * as THREE from 'hull/three';
import { mergeVertices } from 'hull/three';
import { Builder } from './geo';
import { Rng, clamp, lerp, smoothstep } from './rng';
import { groundHeight } from './terrain';
import { noise3, NOISE_GLSL } from './common';
import type { WorldCtx } from './common';

const V3 = THREE.Vector3;
const BARK_TINTS = [0xffffff, 0xebe5dc, 0xdcd5cb, 0xf2ede6, 0xcfc8bd];
// leaf colours (sRGB): olive and blue-green, never saturated; the sun and the shader do the rest
const LEAF_DARK = [0x3c5028, 0x41562f, 0x3a522e, 0x485634];
const LEAF_MID = [0x566c34, 0x5f7238, 0x52693c, 0x627440];
const LEAF_LIGHT = [0x76884a, 0x80904e, 0x6e844c];

/**
 * A foliage mass: a few overlapping lumpy sub-clumps (one big core, smaller ones round its upper half) merged into one
 * geometry with a flattened underside. Normals are blended towards the whole mass so it lights as one crown with
 * bumps, and the vertex colour carries the self-shadowing: dark in the crevices between clumps and underneath.
 * Cheap: each lump is a detail-0 icosahedron, 20 triangles.
 */
const _masses: Record<string, THREE.BufferGeometry> = {};
export function foliageGeometry(lumps = 4, detail = 0): THREE.BufferGeometry {
  const key = lumps + ':' + detail;
  if (_masses[key]) return _masses[key];
  const rng = new Rng(9001 + lumps * 7 + detail);
  const parts: { c: THREE.Vector3; r: number }[] = [{ c: new V3(0, 0.02, 0), r: 0.7 }];
  const a0 = rng.range(0, 6.28);
  for (let i = 1; i < lumps; i++) {
    const az = a0 + (i / (lumps - 1)) * Math.PI * 2 + rng.range(-0.4, 0.4), el = rng.range(0.1, 0.65), d = rng.range(0.42, 0.52);
    parts.push({ c: new V3(Math.cos(az) * Math.cos(el) * d, Math.sin(el) * d * 0.8 + 0.05, Math.sin(az) * Math.cos(el) * d), r: rng.range(0.42, 0.56) });
  }
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  const v = new V3(), n = new V3(), m = new V3();
  let maxR = 0;
  const lumpsGeo = parts.map((pt, li) => {
    const g = mergeVertices((() => { const ig = new THREE.IcosahedronGeometry(1, detail); ig.deleteAttribute('uv'); ig.deleteAttribute('normal'); return ig; })(), 1e-4);
    const pa = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i);
      const h = 1 + noise3(v.x * 1.9 + li * 3.1, v.y * 1.9, v.z * 1.9 - li) * 0.22;
      v.multiplyScalar(pt.r * h).add(pt.c);
      if (v.y < 0) v.y *= 0.6;
      pa.setXYZ(i, v.x, v.y, v.z);
      maxR = Math.max(maxR, v.length());
    }
    g.computeVertexNormals();
    return g;
  });
  for (const g of lumpsGeo) {
    const nonIdx = g.toNonIndexed();
    const pa = nonIdx.attributes.position as THREE.BufferAttribute, na = nonIdx.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i); n.fromBufferAttribute(na, i);
      m.copy(v).normalize();
      n.lerp(m, 0.72).normalize();
      // self-shadowing: crevices (vertices near the middle of the mass) and the underside are darker
      const outer = smoothstep(0.35, 0.95, v.length() / maxR);
      const under = smoothstep(-0.7, 0.5, n.y);
      const ao = (0.5 + 0.5 * outer) * (0.68 + 0.32 * under);
      pos.push(v.x, v.y, v.z); nor.push(n.x, n.y, n.z); col.push(ao, ao, ao);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return (_masses[key] = out);
}

interface Blob { x: number; y: number; z: number; r: number; c: THREE.Color }
export class TreeBatch {
  wood = new Builder();
  blobs: Blob[] = [];
}

/** Tree spec: see addTree. */
export interface TreeSpec {
  H: number; r0: number; lod: number; branches: [number, number]; branchMin: number; len: [number, number]; rb: [number, number];
  avoidY?: [number, number] | null; blobR: [number, number]; canopyN: number; canopySpread: number; small?: boolean;
}

/**
 * Add a tree. spec: { H, r0, lod (0 full,1 mid,2 far), branches:[min,max], branchMin (m above ground), len:[a,b], rb:[a,b],
 * avoidY?:[lo,hi], blobR:[a,b], canopyN, canopySpread, small? }. Returns { gy, H, r0 }.
 */
export function addTree(ctx: WorldCtx, batch: TreeBatch, rng: Rng, x: number, z: number, spec: TreeSpec): { gy: number; H: number; r0: number } {
  const gy = groundHeight(x, z), { H, r0, lod } = spec;
  const W = batch.wood;
  const nL = rng.int(5, 7), ph = rng.range(0, 6.28), ph2 = rng.range(0, 6.28), A = spec.small ? 0.5 : rng.range(0.8, 1.25), hr = spec.small ? 1.4 : rng.range(4.5, 7);
  const tint = new THREE.Color(rng.pick(BARK_TINTS));
  const seg = lod === 0 ? (spec.small ? 12 : 18) : lod === 1 ? 12 : 8;
  // ring heights
  const ys = [-1.2, 0];
  const dense = spec.small ? [0.6, 1.4, 2.6, 4.5, 8] : lod === 0 ? [1, 2.3, 4, 6.5, 10, 16, 24] : lod === 1 ? [2.5, 6, 13, 24] : [4, 14];
  for (const y of dense) if (y < H * 0.6) ys.push(y);
  const stepY = lod === 0 ? 17 : lod === 1 ? 26 : 40;
  for (let y = ys[ys.length - 1] + stepY; y < H - 2; y += stepY) ys.push(y);
  ys.push(H, H + 3.5);
  const pts = ys.map((y) => new V3(x, gy + y, z));
  const trunkR = (y: number, th: number) => {
    const yy = Math.max(0, y), t = clamp(yy / H, 0, 1.05);
    const taper = 1 - 0.36 * Math.pow(Math.min(t, 1), 0.9);
    const lobe = Math.pow(Math.max(0, Math.cos(nL * th + ph)), 3);
    const flare = 1 + (A * lobe + 0.28 * A) * Math.exp(-yy / hr);
    const ribs = 1 + 0.035 * Math.sin(9 * th + ph2 + yy * 0.04) + 0.02 * Math.sin(17 * th + yy * 0.11);
    return r0 * taper * flare * ribs;
  };
  W.tube(pts, (i, th) => (i === ys.length - 1 ? 0.06 * r0 : trunkR(ys[i], th)), {
    seg, uTile: 4, vTile: 8,
    colFn: (i) => { const t = clamp(ys[i] / H, 0, 1); return tint.clone().multiplyScalar(0.7 + 0.35 * Math.min(1, t * 3)); },
  });
  // trunk colliders (two stacked cylinders + a squat base for the roots)
  const rAt = (y0: number, y1: number) => { let s = 0, n = 0; for (let k = 0; k <= 4; k++) { const y = lerp(y0, y1, k / 4); for (let a = 0; a < 6; a++) { s += trunkR(y, a); n++; } } return s / n; };
  if (!spec.small) {
    ctx.col.cyl(x, z, gy - 2, gy + 5, rAt(0.5, 5) * 0.97, 'bark');
    if (lod < 2) { ctx.col.cyl(x, z, gy + 5, gy + H * 0.5, rAt(5, H * 0.5) * 0.97, 'bark'); ctx.col.cyl(x, z, gy + H * 0.5, gy + H, rAt(H * 0.5, H) * 0.97, 'bark'); }
    else ctx.col.cyl(x, z, gy + 5, gy + H, rAt(5, H) * 0.97, 'bark');
  } else {
    ctx.col.cyl(x, z, gy - 2, gy + H, rAt(0.5, H) * 0.97, 'bark');
  }

  // branches
  const nb = rng.int(spec.branches[0], spec.branches[1]);
  const y0 = spec.branchMin, y1 = H * (spec.small ? 0.8 : 0.84);
  const a0 = rng.range(0, 6.28);
  let made = 0;
  const tips: { start: THREE.Vector3; end: THREE.Vector3; d: THREE.Vector3; rb: number; L: number }[] = [];
  for (let k = 0; k < nb * 3 && made < nb; k++) {
    const f = (made + rng.range(0.1, 0.9)) / nb;
    const by = lerp(y0, y1, Math.pow(f, 0.9));
    if (spec.avoidY && by > spec.avoidY[0] && by < spec.avoidY[1]) continue;
    made++;
    const az = a0 + made * 2.399 + rng.range(-0.35, 0.35);
    const lenScale = lerp(1.0, 0.62, (by - y0) / Math.max(1, y1 - y0));
    const L = rng.range(spec.len[0], spec.len[1]) * lenScale;
    const rt = trunkR(by, az) , rb = clamp(rng.range(spec.rb[0], spec.rb[1]) * (spec.small ? 1 : lerp(1.15, 0.8, (by - y0) / Math.max(1, y1 - y0))), spec.rb[0] * 0.7, spec.rb[1]);
    const slope = rng.range(0.08, 0.34);
    const d = new V3(Math.cos(az), slope, Math.sin(az)).normalize();
    const start = new V3(x + Math.cos(az) * rt * 0.45, gy + by, z + Math.sin(az) * rt * 0.45);
    const end = start.clone().addScaledVector(d, L + rt * 0.5);
    const mid = start.clone().lerp(end, 0.5);
    const radii = [rb * 1.2, rb * 0.9, rb * 0.62];
    const m3 = lod === 0 || spec.small ? [start, mid, end] : [start, end];
    const rr = lod === 0 || spec.small ? radii : [rb * 1.1, rb * 0.62];
    W.tube(m3, (i) => rr[i], { seg: lod === 0 ? 7 : 5, uTile: 4, vTile: 6, colFn: (i) => tint.clone().multiplyScalar(0.85 + i * 0.05) });
    const sa = start.clone().addScaledVector(d, rt * 0.75);
    ctx.col.cap(sa.x, sa.y, sa.z, end.x, end.y, end.z, rb * 0.9, 'bark');
    tips.push({ start, end, d, rb, L });
    // twigs (visual only)
    if (lod < 2) {
      const nt = lod === 0 ? rng.int(2, 3) : 1;
      for (let t = 0; t < nt; t++) {
        const u = rng.range(0.45, 0.95), p0 = start.clone().lerp(end, u);
        const td = d.clone().multiplyScalar(0.6).add(new V3(rng.range(-1, 1), rng.range(0.1, 0.8), rng.range(-1, 1))).normalize();
        const tl = rng.range(3, 6.5) * (spec.small ? 0.5 : 1);
        const p1 = p0.clone().addScaledVector(td, tl);
        W.tube([p0, p1], (i) => [0.2 * rb + 0.06, 0.05][i], { seg: 4, uTile: 2, vTile: 3, color: tint.clone().multiplyScalar(0.9) });
        if ((lod === 0 && rng.chance(0.3)) || spec.small) batch.blobs.push({ x: p1.x, y: p1.y + 0.5, z: p1.z, r: rng.range(2.4, 4.0) * (spec.small ? 0.6 : 1), c: pickLeaf(rng, 0.55 + rng.range(-0.2, 0.2)) });
      }
    }
  }
  // blobs at branch tips
  for (const t of tips) batch.blobs.push({ x: t.end.x + t.d.x * 1.2, y: t.end.y + 1.2, z: t.end.z + t.d.z * 1.2, r: rng.range(spec.blobR[0] * 0.5, spec.blobR[1] * 0.55) * (spec.small ? 1 : 0.9), c: pickLeaf(rng, rng.range(0.3, 0.8)) });
  // top canopy cluster
  const n = spec.canopyN;
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, 6.28), rad = Math.abs(rng.gauss()) * spec.canopySpread * (i === 0 ? 0 : 1);
    let yy = gy + H * (spec.small ? rng.range(0.78, 1.02) : rng.range(0.8, 1.04)) + (i === 0 ? 2 : rng.range(-3, 3));
    if (i === 0) yy = Math.max(yy, gy + H + 1.5);     // the crown's top mass hides the trunk's tip
    const hgt = clamp((yy - gy) / H, 0, 1.05);
    batch.blobs.push({ x: x + Math.cos(a) * rad, y: yy, z: z + Math.sin(a) * rad, r: rng.range(spec.blobR[0], spec.blobR[1]), c: pickLeaf(rng, 0.45 + (hgt - 0.8) * 1.4 + rng.range(-0.2, 0.25)) });
  }
  return { gy, H, r0 };
}

/**
 * Canopy shading on top of PBR lighting: a world-space leaf-clump pattern darkens the gaps between clumps (the dark
 * interior showing through), the clumps also tilt the normal a little so the sun picks them out, and at the
 * silhouette the mass breaks up into ragged leaf edges (alpha-tested, fading out with distance so it never shimmers).
 * Shared by every foliage instance.
 */
let _foliageMat: THREE.MeshStandardMaterial | null = null;
// leaves between the camera and the soldier thin out to a screen-door dither, so flying past (or through) a crown
// never fills the view with a wall of green: `focus` is the soldier, `fade` 0..1 switches it on
export const foliageFade = { focus: { value: new THREE.Vector3() }, fade: { value: 0 } };
function foliageMaterial(): THREE.MeshStandardMaterial {
  if (_foliageMat) return _foliageMat;
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uFolFocus = foliageFade.focus; sh.uniforms.uFolFade = foliageFade.fade;
    sh.vertexShader = 'varying vec3 vFolW;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      vFolW = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;`);
    sh.fragmentShader = 'varying vec3 vFolW; uniform vec3 uFolFocus; uniform float uFolFade;\n' + NOISE_GLSL + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
      float folDist = length( vViewPosition );
      // nearer the camera than the soldier (or right at the lens): keep only a sparse dither of it
      if ( uFolFade > 0.0 ) {
        float dCam = distance( vFolW, cameraPosition ), dFocus = distance( uFolFocus, cameraPosition );
        float near = max( 1.0 - smoothstep( dFocus - 1.5, dFocus + 0.5, dCam ), 1.0 - smoothstep( 2.0, 4.0, dCam ) ) * uFolFade;
        float ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
        if ( ign < near * 0.72 ) discard;
      }
      // leaf clumps (two octaves of world-space value noise)
      float folN = wNoise( vFolW * 0.55 ) * 0.62 + wNoise( vFolW * 1.7 + 11.0 ) * 0.38;
      float folClump = smoothstep( 0.32, 0.68, folN );
      // ragged edge at the silhouette of the mass: leafy bites at two scales eat into the outline
      float folRim = 1.0 - abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) );
      float folBite = wNoise( vFolW * 0.9 + 5.0 ) * 0.6 + wNoise( vFolW * 2.4 + 17.0 ) * 0.4;
      if ( folBite < ( folRim - 0.38 ) * 1.9 * ( 1.0 - smoothstep( 110.0, 300.0, folDist ) ) ) discard;
      diffuseColor.rgb *= mix( 0.6, 1.06, folClump );
      // individual leaves catching light, close up only
      if ( folDist < 90.0 ) diffuseColor.rgb *= mix( 1.0, mix( 0.72, 1.14, wNoise( vFolW * 4.3 ) ), 1.0 - smoothstep( 25.0, 90.0, folDist ) );
      diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.06, 1.08, 0.86 ), smoothstep( 0.6, 0.9, folN ) );   // sun-bleached outer leaves`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
      {
        // the clumps tilt the normal (screen-space bump of the clump noise, no extra noise lookups)
        vec3 fdx = dFdx( -vViewPosition ), fdy = dFdy( -vViewPosition );
        float fhx = dFdx( folN ), fhy = dFdy( folN );
        vec3 fr1 = cross( fdy, normal ), fr2 = cross( normal, fdx );
        float fdet = dot( fdx, fr1 );
        vec3 fgrad = sign( fdet ) * ( fhx * fr1 + fhy * fr2 );
        normal = normalize( abs( fdet ) * normal - fgrad * 1.6 );
      }`);
  };
  m.customProgramCacheKey = () => 'foliage-pbr-v2';
  return (_foliageMat = m);
}

const _c = new THREE.Color();
function pickLeaf(rng: Rng, t: number): THREE.Color {
  t = clamp(t, 0, 1);
  const a = t < 0.5 ? LEAF_DARK : LEAF_MID, b = t < 0.5 ? LEAF_MID : LEAF_LIGHT, k = (t < 0.5 ? t : t - 0.5) * 2;
  const c = new THREE.Color(rng.pick(a)).lerp(_c.set(rng.pick(b)), k);
  return c;
}

/** Turn a batch into scene meshes: merged wood and instanced foliage masses. */
export function finishBatch(ctx: WorldCtx, batch: TreeBatch, name: string, { cast = true, lumps = 4 }: { cast?: boolean; lumps?: number } = {}): { wood?: THREE.Mesh; foliage?: THREE.InstancedMesh } {
  const out: { wood?: THREE.Mesh; foliage?: THREE.InstancedMesh } = {};
  if (batch.wood.pos.length) {
    const g = batch.wood.toGeometry();
    const m = new THREE.Mesh(g, ctx.mat.bark); m.name = name + 'Wood'; ctx.add(m, cast, true);
    out.wood = m;
  }
  if (batch.blobs.length) {
    const mat = foliageMaterial();
    const im = new THREE.InstancedMesh(foliageGeometry(lumps), mat, batch.blobs.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    batch.blobs.forEach((b, i) => {
      // every mass turned and tipped a little differently, so the one shape never repeats visibly
      e.set(((i * 0.37) % 0.5) - 0.25, (i * 1.7) % 6.28, ((i * 0.61) % 0.44) - 0.22); q.setFromEuler(e);
      // scaled up a little: the bitten silhouette eats some of the volume
      const r = b.r * 1.12;
      s.set(r * (0.95 + (i % 3) * 0.08), r * (0.82 + (i % 4) * 0.05), r * (1.05 - (i % 5) * 0.04));
      m4.compose(p.set(b.x, b.y, b.z), q, s); im.setMatrixAt(i, m4); im.setColorAt(i, b.c);
      ctx.foliage.add(b.x, b.y, b.z, s.x, s.y, s.z);
    });
    im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    im.name = name + 'Foliage'; ctx.add(im, cast, true);
    out.foliage = im;
  }
  return out;
}
