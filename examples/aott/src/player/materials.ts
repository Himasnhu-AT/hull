// Surfaces for the soldiers and horses: physically based (MeshStandardMaterial), driven per vertex so a whole baked
// character stays one draw call. Each vertex carries its colour, its surface (roughness, metalness, grain) and an
// emissive term; a cheap procedural grain (value noise in the mesh's own space, so it rides with each limb) breaks
// up flat colour: woven cloth, scuffed leather, skin, brushed steel.
import * as THREE from 'hull/three';
import { makeCanvas } from '../canvas';

/** One modelling part's surface: roughness, metalness, how much grain (0 = clean, 1 = coarse cloth). */
export interface Surface { roughness: number; metalness: number; grain: number }

/** The kit's surfaces: cloth 0.9, skin 0.6, leather 0.7, steel 0.35 with metalness. */
export const SURF = {
  cloth: { roughness: 0.9, metalness: 0, grain: 0.55 },
  wool: { roughness: 0.95, metalness: 0, grain: 0.7 },
  leather: { roughness: 0.7, metalness: 0, grain: 0.35 },
  skin: { roughness: 0.6, metalness: 0, grain: 0.12 },
  hair: { roughness: 0.55, metalness: 0, grain: 0.5 },
  steel: { roughness: 0.35, metalness: 1, grain: 0.18 },
  darkSteel: { roughness: 0.5, metalness: 0.85, grain: 0.25 },
  blade: { roughness: 0.22, metalness: 1, grain: 0.1 },
  brass: { roughness: 0.4, metalness: 1, grain: 0.2 },
  hoof: { roughness: 0.6, metalness: 0, grain: 0.3 },
  coat: { roughness: 0.75, metalness: 0, grain: 0.3 },
} satisfies Record<string, Surface>;

const GRAIN_GLSL = /* glsl */`
varying vec3 vSurf;
varying vec3 vGrainP;
float gHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float gNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gHash(i), gHash(i + vec3(1, 0, 0)), f.x), mix(gHash(i + vec3(0, 1, 0)), gHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(gHash(i + vec3(0, 0, 1)), gHash(i + vec3(1, 0, 1)), f.x), mix(gHash(i + vec3(0, 1, 1)), gHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// fine weave + mottling, centred on 0 (about ±0.5)
float gGrain(vec3 p) { return gNoise(p * 160.0) * 0.55 + gNoise(p * 38.0) * 0.3 + gNoise(p * 9.0) * 0.15 - 0.5; }
`;

export interface GrainOptions {
  /** per-vertex emissive (vec4 aEmis: rgb + a weight for the shared flash colour) */
  emissive?: boolean;
  /** colour added where aEmis.a = 1 (the blade shine), as a shared uniform the owner animates */
  flash?: THREE.ColorRepresentation;
  side?: THREE.Side;
}

/**
 * MeshStandardMaterial driven by vertex colour + aSurf (roughness, metalness, grain) [+ aEmis]. Geometries without
 * aSurf must not use it. userData.flash (THREE.Color) is the live flash colour when opts.flash is given.
 */
export function grainMaterial(opts: GrainOptions = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, metalness: 0, side: opts.side ?? THREE.FrontSide });
  const flash = { value: new THREE.Color(opts.flash ?? 0x000000) };
  m.userData.flash = flash.value;
  const emis = !!opts.emissive;
  m.onBeforeCompile = (sh) => {
    if (emis) sh.uniforms.uFlash = flash;
    sh.vertexShader = `attribute vec3 aSurf;\nvarying vec3 vSurf;\nvarying vec3 vGrainP;\n${emis ? 'attribute vec4 aEmis;\nvarying vec4 vEmis;\n' : ''}` +
      sh.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>\n\tvSurf = aSurf; vGrainP = position;${emis ? ' vEmis = aEmis;' : ''}`);
    let fs = GRAIN_GLSL + (emis ? 'uniform vec3 uFlash;\nvarying vec4 vEmis;\n' : '') + sh.fragmentShader;
    fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n\tfloat gr = gGrain(vGrainP) * vSurf.z;\n\tdiffuseColor.rgb *= 1.0 + 0.55 * gr;');
    fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = clamp(vSurf.x * (1.0 + 0.35 * gr), 0.04, 1.0);');
    fs = fs.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = vSurf.y;');
    if (emis) fs = fs.replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vEmis.rgb + vEmis.a * uFlash;');
    sh.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => (emis ? 'aott-grain-emis' : 'aott-grain');
  return m;
}

/** Fill a geometry's aSurf attribute with one surface (for merged pieces). */
export function setSurface(g: THREE.BufferGeometry, s: Surface): THREE.BufferGeometry {
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = s.roughness; a[i * 3 + 1] = s.metalness; a[i * 3 + 2] = s.grain; }
  g.setAttribute('aSurf', new THREE.BufferAttribute(a, 3));
  return g;
}

/** A small seamless value-noise canvas (grey around 128) for cloth: weave + slubs + mottling. */
export function clothGrainCanvas(size = 256, seed = 1): HTMLCanvasElement {
  const cv = makeCanvas(); cv.width = cv.height = size;
  const c = cv.getContext('2d')!;
  const img = c.createImageData(size, size), d = img.data;
  let s = seed * 9301 + 49297;
  const rnd = (): number => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const blot = new Float32Array(16 * 16).map(rnd);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // twill weave: diagonal ribs, threads alternating every 2 px
    const weave = ((x + y) >> 1) & 1 ? 1 : -1, warp = (x & 1) ? 0.5 : -0.5;
    const bx = (x / size) * 16, by = (y / size) * 16, ix = Math.floor(bx) & 15, iy = Math.floor(by) & 15;
    const mott = blot[iy * 16 + ix] - 0.5;
    const v = 128 + weave * 7 + warp * 4 + mott * 22 + (rnd() - 0.5) * 14;
    const o = (y * size + x) * 4;
    d[o] = d[o + 1] = d[o + 2] = Math.max(0, Math.min(255, v)); d[o + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return cv;
}
