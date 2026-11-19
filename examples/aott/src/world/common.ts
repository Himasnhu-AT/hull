// Shared world-building context: textures, PBR materials, collider helper, flag registry, noise.
import * as THREE from 'hull/three';
import { ImprovedNoise } from 'hull/three';
import type { Game, SurfaceMaterial, WorldHandle } from '../types';
import * as T from './tex';
import type { TexSet } from './tex';

const V3 = THREE.Vector3, Q = THREE.Quaternion;
export const UP = new V3(0, 1, 0);

export const SUN_DIR = new V3(-0.55, 0.62, 0.35).normalize();   // direction from the scene towards the sun
/** Horizon haze: the fog colour and the bottom of the sky dome, so distant land melts into the sky. */
export const FOG_COLOR = 0xc3cdd3;

const _noise = new ImprovedNoise();
/** Smooth deterministic noise in [-1,1]. */
export const noise2 = (x: number, y: number): number => _noise.noise(x, y, 3.7);
export const noise3 = (x: number, y: number, z: number): number => _noise.noise(x, y, z);

export type FlagKind = 'outriders' | 'wallguard';
export interface FlagSpec { kind: FlagKind; x: number; y: number; z: number; yaw: number; h: number; s: number; pole: boolean }
export type Updater = (dt: number, camPos: THREE.Vector3) => void;

/** Surface materials of the world (lazy: built on first use, then shared). */
export interface WorldMaterials {
  readonly stone: THREE.MeshStandardMaterial; readonly paving: THREE.MeshStandardMaterial; readonly hq: THREE.MeshStandardMaterial;
  readonly hqwall: THREE.MeshStandardMaterial; readonly cobbles: THREE.MeshStandardMaterial; readonly dirt: THREE.MeshStandardMaterial;
  readonly grass: THREE.MeshStandardMaterial; readonly bark: THREE.MeshStandardMaterial; readonly clay: THREE.MeshStandardMaterial;
  readonly slate: THREE.MeshStandardMaterial; readonly plaster0: THREE.MeshStandardMaterial; readonly plaster1: THREE.MeshStandardMaterial;
  readonly planks: THREE.MeshStandardMaterial; readonly plain: THREE.MeshStandardMaterial; readonly rock: THREE.MeshStandardMaterial;
  flag(kind: FlagKind): THREE.MeshStandardMaterial;
  plainColor(hex: number, opts?: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial;
}

export interface WorldColliders {
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, material?: SurfaceMaterial, quaternion?: THREE.Quaternion | null, hookable?: boolean): unknown;
  cyl(x: number, z: number, y0: number, y1: number, radius: number, material?: SurfaceMaterial, hookable?: boolean): unknown;
  cap(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number, material?: SurfaceMaterial, hookable?: boolean): unknown;
  sph(cx: number, cy: number, cz: number, radius: number, material?: SurfaceMaterial, hookable?: boolean): unknown;
}

export interface FoliageIndex {
  add(x: number, y: number, z: number, rx: number, ry: number, rz: number): void;
  test(p: THREE.Vector3): boolean;
}

/** Everything the district builders share while the world is being built. */
export interface WorldCtx {
  game: Game;
  scene: THREE.Scene;
  /** Seconds since the world was built (shader uniform). */
  time: { value: number };
  flags: FlagSpec[];
  updaters: Updater[];
  depots: WorldHandle['supplyDepots'];
  titanSpawns: WorldHandle['titanSpawns'];
  stats: { box: number; cyl: number; cap: number; sph: number };
  mat: WorldMaterials;
  col: WorldColliders;
  foliage: FoliageIndex;
  /** The current atmosphere's fog (world.setAtmosphere writes it; the forest blends from it). */
  atmo: { fog: THREE.Color; near: number; far: number; canopy: THREE.Color };
  town?: { xb: number[]; zb: number[] };
  /** The Ashwall's gate (wall.ts): breached (open, the default) or shut. */
  gate?: { readonly open: boolean; set(open: boolean): void; burst(): void };
  /** Bring down the houses within `radius` of `at` (town.ts); returns how many. rebuild() stands them all up again. */
  smash?: (at: THREE.Vector3, radius: number) => number;
  rebuild?: () => void;
  add<O extends THREE.Object3D>(obj: O, cast?: boolean, receive?: boolean): O;
  flag(kind: FlagKind, x: number, y: number, z: number, o?: { yaw?: number; h?: number; s?: number; pole?: boolean }): void;
}

/** A physically based surface: no metals (the world has no environment map), roughness per surface. */
export function pbr(o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, ...o });
}
const fromSet = (s: TexSet, o: THREE.MeshStandardMaterialParameters & { normalStrength?: number } = {}) => {
  const { normalStrength = 1, ...rest } = o;
  return pbr({ map: s.map, normalMap: s.normal ?? null, normalScale: new THREE.Vector2(normalStrength, normalStrength), vertexColors: true, ...rest });
};

export function createContext(game: Game): WorldCtx {
  const timeU = { value: 0 };

  // ---------- textures & materials (lazy) ----------
  const cache: Record<string, TexSet> = {};
  const lazy = (k: string, fn: () => TexSet) => () => (cache[k] ??= fn());
  const tex = {
    stone: lazy('stone', T.makeWallStone), paving: lazy('paving', T.makePaving), hq: lazy('hq', T.makeHQStone),
    cobbles: lazy('cobbles', T.makeCobbles), dirt: lazy('dirt', T.makeDirt), grass: lazy('grass', T.makeGrass),
    bark: lazy('bark', T.makeBark), clay: lazy('clay', () => T.makeRoof('clay')), slate: lazy('slate', () => T.makeRoof('slate')),
    plaster0: lazy('p0', () => T.makePlaster(0, '#4b5a49')), plaster1: lazy('p1', () => T.makePlaster(1, '#4a5868')),
    planks: lazy('planks', T.makePlanks), hqwall: lazy('hqwall', T.makeHQWall), rock: lazy('rock', T.makeRockTex),
    flagOutriders: lazy('fs', () => T.makeFlag('outriders')), flagWallguard: lazy('fg', () => T.makeFlag('wallguard')),
  };
  const mcache: Record<string, THREE.MeshStandardMaterial> = {};
  const mat = (k: string, fn: () => THREE.MeshStandardMaterial) => (mcache[k] ??= fn());
  const mats: WorldMaterials = {
    get stone() { return mat('stone', () => weathering(fromSet(tex.stone(), { roughness: 0.95, normalStrength: 0.9 }), { key: 'stone', macro: 0.3, streaks: 0.45 })); },
    get paving() { return mat('paving', () => weathering(fromSet(tex.paving(), { roughness: 0.92, normalStrength: 0.8 }), { key: 'paving', macro: 0.3 })); },
    get hq() { return mat('hq', () => weathering(fromSet(tex.hq(), { roughness: 0.92, normalStrength: 0.8 }), { key: 'hq', macro: 0.14, streaks: 0.15 })); },
    get hqwall() { return mat('hqwall', () => weathering(fromSet(tex.hqwall(), { roughness: 0.92, normalStrength: 0.8 }), { key: 'hqwall', macro: 0.14, streaks: 0.22 })); },
    get cobbles() { return mat('cobbles', () => weathering(fromSet(tex.cobbles(), { roughness: 0.88, normalStrength: 1 }), { key: 'cobbles', macro: 0.25 })); },
    get dirt() { return mat('dirt', () => weathering(fromSet(tex.dirt(), { roughness: 1, normalStrength: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), { key: 'dirt', macro: 0.18 })); },
    get grass() { return mat('grass', () => fromSet(tex.grass(), { roughness: 1, normalStrength: 0.6 })); },
    get bark() { return mat('bark', () => weathering(fromSet(tex.bark(), { roughness: 0.95, normalStrength: 1.2 }), { key: 'bark', macro: 0.16, moss: 0.75, dampBase: 0.4 })); },
    get clay() { return mat('clay', () => weathering(fromSet(tex.clay(), { roughness: 0.82, normalStrength: 1, side: THREE.DoubleSide }), { key: 'clay', macro: 0.22 })); },
    get slate() { return mat('slate', () => weathering(fromSet(tex.slate(), { roughness: 0.7, normalStrength: 1, side: THREE.DoubleSide }), { key: 'slate', macro: 0.15 })); },
    get plaster0() { return mat('p0', () => weathering(fromSet(tex.plaster0(), { roughness: 0.93, normalStrength: 0.6 }), { key: 'p0', macro: 0.1, streaks: 0.12 })); },
    get plaster1() { return mat('p1', () => weathering(fromSet(tex.plaster1(), { roughness: 0.93, normalStrength: 0.6 }), { key: 'p1', macro: 0.1, streaks: 0.12 })); },
    get planks() { return mat('planks', () => fromSet(tex.planks(), { roughness: 0.85, normalStrength: 0.7 })); },
    get plain() { return mat('plain', () => pbr({ vertexColors: true, roughness: 0.8 })); },
    get rock() { return mat('rock', () => weathering(fromSet(tex.rock(), { roughness: 0.95, normalStrength: 1 }), { key: 'rock', macro: 0.2, moss: 0.35 })); },
    flag(kind) {
      return mat('flag' + kind, () => {
        const m = pbr({ map: (kind === 'outriders' ? tex.flagOutriders() : tex.flagWallguard()).map, side: THREE.DoubleSide, roughness: 0.92 });
        m.onBeforeCompile = (sh) => {
          sh.uniforms.uTime = timeU;
          sh.vertexShader = 'uniform float uTime;\nvarying float vShade;\n' + sh.vertexShader.replace('#include <begin_vertex>', `
            vec3 transformed = vec3( position );
            #ifdef USE_INSTANCING
              float ph = instanceMatrix[3].x * 0.31 + instanceMatrix[3].z * 0.17;
            #else
              float ph = 0.0;
            #endif
            float k = clamp( position.x / 3.0, 0.0, 1.0 );
            float a = position.x * 2.4 - uTime * 5.5 + ph;
            transformed.z += ( sin( a ) * 0.34 + sin( position.x * 4.7 - uTime * 9.0 + ph * 1.7 + position.y * 1.9 ) * 0.1 ) * k;
            transformed.y += sin( position.x * 1.7 - uTime * 4.0 + ph ) * 0.07 * k;
            vShade = 0.86 + cos( a ) * 0.2 * k;`);
          sh.fragmentShader = 'varying float vShade;\n' + sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n diffuseColor.rgb *= vShade;');
        };
        m.customProgramCacheKey = () => 'flagwave';
        return m;
      });
    },
    plainColor(hex, opts = {}) { return mat('pc' + hex + JSON.stringify(opts), () => pbr({ color: hex, roughness: 0.85, ...opts })); },
  };

  // ---------- colliders ----------
  const col = game.collision;
  const S = { box: 0, cyl: 0, cap: 0, sph: 0 };
  const colliders: WorldColliders = {
    /** axis-aligned or rotated box, centre + half extents. */
    box(cx, cy, cz, hx, hy, hz, material = 'stone', quaternion = null, hookable = true) {
      S.box++;
      return col.addBox({ center: new V3(cx, cy, cz), halfExtents: new V3(hx, hy, hz), quaternion: quaternion || undefined, material, hookable });
    },
    cyl(x, z, y0, y1, radius, material = 'bark', hookable = true) {
      S.cyl++;
      return col.addCylinder({ x, z, y0, y1, radius, material, hookable });
    },
    cap(ax, ay, az, bx, by, bz, radius, material = 'bark', hookable = true) {
      S.cap++;
      return col.addCapsule({ a: new V3(ax, ay, az), b: new V3(bx, by, bz), radius, material, hookable });
    },
    sph(cx, cy, cz, radius, material = 'stone', hookable = true) {
      S.sph++;
      return col.addSphere({ center: new V3(cx, cy, cz), radius, material, hookable });
    },
  };

  // ---------- foliage index (canopy masses are collider-free; the core asks inFoliage(pos) to spawn leaves) ----------
  interface Ell { x: number; y: number; z: number; ix: number; iy: number; iz: number }
  const FC = 24, fmap = new Map<number, Ell[]>();
  const foliage: FoliageIndex = {
    add(x, y, z, rx, ry, rz) {
      const b = { x, y, z, ix: 1 / (rx * 0.92), iy: 1 / (ry * 0.92), iz: 1 / (rz * 0.92) };
      const r = Math.max(rx, rz);
      for (let i = Math.floor((x - r) / FC); i <= Math.floor((x + r) / FC); i++) for (let k = Math.floor((z - r) / FC); k <= Math.floor((z + r) / FC); k++) {
        const key = i * 73856093 ^ k * 19349663; let a = fmap.get(key); if (!a) fmap.set(key, a = []); a.push(b);
      }
    },
    test(p) {
      const a = fmap.get(Math.floor(p.x / FC) * 73856093 ^ Math.floor(p.z / FC) * 19349663);
      if (!a) return false;
      for (const b of a) { const dx = (p.x - b.x) * b.ix, dy = (p.y - b.y) * b.iy, dz = (p.z - b.z) * b.iz; if (dx * dx + dy * dy + dz * dz < 1) return true; }
      return false;
    },
  };

  const ctx: WorldCtx = {
    game, scene: game.scene, time: timeU, flags: [], updaters: [], depots: [], titanSpawns: [], stats: S,
    mat: mats, col: colliders, foliage,
    atmo: { fog: new THREE.Color(FOG_COLOR), near: 120, far: 1400, canopy: new THREE.Color(1, 1, 1) },
    /** Add a mesh to the scene with shadow flags. */
    add(obj, cast = true, receive = true) {
      obj.castShadow = cast; obj.receiveShadow = receive;
      ctx.scene.add(obj);
      return obj;
    },
    flag(kind, x, y, z, o = {}) { ctx.flags.push({ kind, x, y, z, yaw: o.yaw ?? 0, h: o.h ?? 7, s: o.s ?? 1, pole: o.pole ?? true }); },
  };
  return ctx;
}

/** Yaw (about Y) quaternion helper. */
export function qYaw(a: number, out = new Q()): THREE.Quaternion { return out.setFromAxisAngle(UP, a); }
export function qAxis(ax: number, ay: number, az: number, ang: number, out = new Q()): THREE.Quaternion { return out.setFromAxisAngle(_tmpAx.set(ax, ay, az), ang); }
const _tmpAx = new V3();

/** 3D value noise in GLSL ([0,1]), shared by the world's shader patches. */
export const NOISE_GLSL = /* glsl */`
float wHash( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
float wNoise( vec3 x ) {
  vec3 i = floor( x ), f = fract( x ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( wHash( i ), wHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( wHash( i + vec3( 0, 1, 0 ) ), wHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
              mix( mix( wHash( i + vec3( 0, 0, 1 ) ), wHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( wHash( i + vec3( 0, 1, 1 ) ), wHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
`;

interface WeatherOpts { key: string; macro?: number; streaks?: number; moss?: number; dampBase?: number }
/**
 * World-space weathering on top of a tiled texture, so big surfaces never show the repeat: broad light/dark blotches
 * (macro), dark rain streaks running down vertical faces (streaks), moss on upward faces (moss) and a damp, darker
 * foot near the ground (dampBase).
 */
function weathering(m: THREE.MeshStandardMaterial, o: WeatherOpts): THREE.MeshStandardMaterial {
  const macro = (o.macro ?? 0).toFixed(3), streaks = (o.streaks ?? 0).toFixed(3), moss = (o.moss ?? 0).toFixed(3), damp = (o.dampBase ?? 0).toFixed(3);
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vWthW; varying vec3 vWthN;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      vWthW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
      vWthN = normalize( mat3( modelMatrix ) * objectNormal );`);
    sh.fragmentShader = 'varying vec3 vWthW; varying vec3 vWthN;\n' + NOISE_GLSL + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec3 wn = normalize( vWthN );
        float mb = wNoise( vWthW * 0.045 ) * 0.6 + wNoise( vWthW * 0.17 + 3.1 ) * 0.4;
        diffuseColor.rgb *= 1.0 + ( mb - 0.5 ) * 2.0 * ${macro};
        float side = 1.0 - abs( wn.y );
        float st = wNoise( vec3( ( vWthW.x + vWthW.z ) * 0.7, vWthW.y * 0.035, 1.7 ) );
        float st2 = wNoise( vec3( ( vWthW.x - vWthW.z ) * 2.3, vWthW.y * 0.08, 5.3 ) );
        diffuseColor.rgb *= 1.0 - ${streaks} * side * smoothstep( 0.5, 0.85, st ) * ( 0.6 + 0.4 * st2 );
        float base = 1.0 - smoothstep( 0.0, 6.0, vWthW.y );
        diffuseColor.rgb *= 1.0 - ${damp} * base * ( 0.6 + 0.4 * mb );
        float mp = wNoise( vWthW * 0.35 + 7.0 );
        float mz = smoothstep( 0.45, 0.85, wn.y ) * smoothstep( 0.35, 0.7, mp ) * ${moss};
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.11, 0.135, 0.055 ) * ( 0.8 + 0.4 * mb ), mz );
      }`);
  };
  m.customProgramCacheKey = () => 'weather-' + o.key;
  return m;
}
