// Natural grass: the ground shader (broad colour patches of green, olive and straw, tiling broken up) and
// camera-following grass tufts that sway in the wind, flatten under the gas wash and get pressed down where titans step.
//
//   paintGroundMaterial(material)       patches the field ground's material (common.ts ctx.mat.grass)
//   buildGrass(ctx) -> { press(pos, radius, strength, lasting), update(dt, camPos), mesh }
//
// Everything about where a tuft stands is computed in the vertex shader from a world-space grid snapped to the
// camera, so the CPU only uploads a small 'press' texture (when something is flattening grass) and a few uniforms.
import * as THREE from 'hull/three';
import { groundHeight, FS, FX1 } from './terrain';
import { smoothstep } from './rng';
import type { WorldCtx } from './common';

// ---------------------------------------------------------------------------------------------------------------
// Shared GLSL: hashing, value noise, the field palette, forest mask.
const PAINT_GLSL = /* glsl */`
uint gPcg( uint v ) { uint s = v * 747796405u + 2891336453u; uint w = ( ( s >> ( ( s >> 28u ) + 4u ) ) ^ s ) * 277803737u; return ( w >> 22u ) ^ w; }
float gHash( vec2 i ) { uvec2 q = uvec2( ivec2( floor( i ) ) + 65536 ); return float( gPcg( q.x + gPcg( q.y ) ) ) * ( 1.0 / 4294967295.0 ); }
float gNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ), u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( gHash( i ), gHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( gHash( i + vec2( 0.0, 1.0 ) ), gHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float gForest( vec2 xz ) {
  return smoothstep( ${150 + FS}.0, ${250 + FS}.0, xz.y ) * ( 1.0 - smoothstep( 700.0, 860.0, -xz.x ) ) * ( 1.0 - smoothstep( ${FX1}.0, ${FX1 + 160}.0, xz.x ) ) * ( 1.0 - smoothstep( ${1050 + FS}.0, ${1250 + FS}.0, xz.y ) );
}
// Field albedo (linear): dull blue-green in the hollows, mid green, sunlit olive swells, patches of dry straw and a
// little bare soil. Muted on purpose: real meadow is far greyer than it feels.
// dryOut: how dry the spot is (tufts are a bit taller and paler there).
vec3 gFieldPaint( vec2 xz, out float dryOut ) {
  float big = gNoise( xz * ( 1.0 / 74.0 ) + vec2( 17.3, -4.1 ) ) * 0.62 + gNoise( xz * ( 1.0 / 29.0 ) + vec2( -3.7, 9.2 ) ) * 0.38;
  float mid = gNoise( xz * ( 1.0 / 9.0 ) + vec2( 5.0, 71.0 ) );
  float streak = gNoise( vec2( xz.x * 0.045 + xz.y * 0.018, xz.y * 0.13 - xz.x * 0.05 ) );
  float k = smoothstep( 0.3, 0.7, big + ( streak - 0.5 ) * 0.16 + ( mid - 0.5 ) * 0.1 );
  vec3 shade = vec3( 0.048, 0.078, 0.036 ), midG = vec3( 0.082, 0.118, 0.04 ), sun = vec3( 0.145, 0.16, 0.058 );
  vec3 c = mix( mix( shade, midG, smoothstep( 0.0, 0.55, k ) ), sun, smoothstep( 0.45, 1.0, k ) );
  float dry = smoothstep( 0.62, 0.82, gNoise( xz * ( 1.0 / 43.0 ) + vec2( 41.0, 13.0 ) ) + ( mid - 0.5 ) * 0.22 );
  dryOut = dry;
  c = mix( c, vec3( 0.16, 0.14, 0.07 ), dry * 0.55 );
  float soil = smoothstep( 0.72, 0.86, gNoise( xz * ( 1.0 / 6.5 ) + vec2( -19.0, 3.0 ) ) ) * ( 0.4 + 0.6 * dry );
  c = mix( c, vec3( 0.13, 0.1, 0.07 ), soil * 0.55 );
  return c * ( 0.92 + 0.16 * mid );
}
`;

// ---------------------------------------------------------------------------------------------------------------
// Press map uniforms, shared by the ground (pale flattened patches) and the tufts. Filled in by buildGrass.
const pressU: { uPress: THREE.IUniform<THREE.Texture | null>; uPressSize: THREE.IUniform<number>; uPressCam: THREE.IUniform<THREE.Vector3> } = {
  uPress: { value: null }, uPressSize: { value: 96 }, uPressCam: { value: new THREE.Vector3(0, -1e4, 0) },
};

/** Field ground: replaces the tiled grass texture look with world-space colour patches + a faint detail. */
export function paintGroundMaterial(m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const mean = ((m.map?.userData.meanLuma as number | undefined) ?? 0.1).toFixed(4);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, pressU);
    sh.vertexShader = 'varying vec3 vGW;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vGW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
    sh.fragmentShader = 'varying vec3 vGW;\nuniform sampler2D uPress; uniform float uPressSize; uniform vec3 uPressCam;\n' + PAINT_GLSL + sh.fragmentShader
      .replace('#include <map_fragment>', `
      {
        vec2 xz = vGW.xz;
        float vd = length( vViewPosition );
        // the brush-blade texture as a soft luminance detail, two scales / rotations blended by noise (no tiling)
        vec3 tA = texture2D( map, xz * 0.125 ).rgb;
        vec3 tB = texture2D( map, mat2( 0.8, -0.6, 0.6, 0.8 ) * xz * ( 1.0 / 5.7 ) + 0.37 ).rgb;
        vec3 tx = mix( tA, tB, smoothstep( 0.3, 0.7, gNoise( xz * ( 1.0 / 13.0 ) ) ) );
        float det = dot( tx, vec3( 0.2126, 0.7152, 0.0722 ) ) / ${mean};
        float dry;
        vec3 field = gFieldPaint( xz, dry );
        float fd = mix( 1.0, det, 0.6 * ( 1.0 - smoothstep( 25.0, 160.0, vd ) ) );
        // forest floor: moss, leaf litter and bare earth in broad pools under the giant trees
        float litter = smoothstep( 0.35, 0.7, gNoise( xz * ( 1.0 / 23.0 ) + 31.0 ) * 0.7 + gNoise( xz * ( 1.0 / 5.0 ) ) * 0.3 );
        vec3 forestBase = mix( vec3( 0.058, 0.07, 0.036 ), vec3( 0.11, 0.085, 0.056 ), litter );
        vec3 forestC = vColor.rgb * forestBase * mix( 1.0, det, 0.6 ) * ( 0.82 + 0.3 * gNoise( xz * ( 1.0 / 37.0 ) + 9.0 ) );
        float fk = gForest( xz );
        diffuseColor.rgb = mix( field * fd, forestC, fk );
        // flattened grass (gas wash, footprints) shows paler; the press map wraps every uPressSize m, so only near the camera
        if ( uPressSize > 0.0 ) {
          vec2 pp = texture2D( uPress, xz / uPressSize ).rg;
          float P = max( pp.r, pp.g ) * ( 1.0 - smoothstep( 34.0, 44.0, distance( xz, uPressCam.xz ) ) ) * ( 1.0 - fk * 0.5 );
          diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.25, 1.18, 0.8 ) + vec3( 0.03, 0.03, 0.0 ), P * 0.7 );
        }
      }`)
      .replace('#include <color_fragment>', '');
  };
  m.customProgramCacheKey = () => 'field-ground-v2';
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Height map matching the ground mesh exactly (terrain.js grid: x = -1100..1100 step 11, z = 30..1100 + FS step 10,
// quads split along the (x1,z0)-(x0,z1) diagonal), so tufts stand on the rendered surface.
const HX0 = -1100, HDX = 11, HNX = 201, HZ0 = 30, HDZ = 10, HNZ = 108 + FS / 10;
function heightTexture(): THREE.DataTexture {
  const data = new Float32Array(HNX * HNZ);
  for (let j = 0; j < HNZ; j++) for (let i = 0; i < HNX; i++) data[j * HNX + i] = groundHeight(HX0 + i * HDX, HZ0 + j * HDZ);
  const t = new THREE.DataTexture(data, HNX, HNZ, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}

// Tuft geometry: K blades in a loose star, each a 2-segment tapered strip (aH = 0 root .. 1 tip). Normals are up
// so the tufts light exactly like the ground they grow from.
function tuftGeometry(K = 5): THREE.InstancedBufferGeometry {
  const pos: number[] = [], nrm: number[] = [], ah: number[] = [], idx: number[] = [];
  let s = 11; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < K; k++) {
    const a = (k / K) * Math.PI * 2 + rnd() * 0.8, ca = Math.cos(a), sa = Math.sin(a);
    const r0 = 0.03 + rnd() * 0.08, h = 0.38 + rnd() * 0.3, w = 0.05 + rnd() * 0.03, lean = 0.1 + rnd() * 0.12;
    const tx = -sa, tz = ca;                       // blade faces across the radial direction
    const base = pos.length / 3;
    const ring = (f: number, wf: number, y: number) => {
      const cx = ca * (r0 + lean * f * f), cz = sa * (r0 + lean * f * f);
      for (const sd of [-1, 1]) { pos.push(cx + tx * w * wf * sd, y, cz + tz * w * wf * sd); nrm.push(0, 1, 0); ah.push(f); }
    };
    ring(0, 1, 0); ring(0.55, 0.62, h * 0.55);
    pos.push(ca * (r0 + lean), h, sa * (r0 + lean)); nrm.push(0, 1, 0); ah.push(1);
    idx.push(base, base + 1, base + 3, base, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aH', new THREE.Float32BufferAttribute(ah, 1));
  g.setIndex(idx);
  return g;
}

const PRESS_N = 128, PRESS_TEXEL = 0.75, PRESS_SIZE = PRESS_N * PRESS_TEXEL;   // 96 m, wraps in world space

/** What buildGrass returns (world.grass). */
export interface GrassHandle {
  press(pos: THREE.Vector3, radius?: number, strength?: number, lasting?: boolean): void;
  update(dt: number, camPos?: THREE.Vector3): void;
  mesh: THREE.Mesh;
  pressTexture: THREE.DataTexture;
  instances: number;
}

/** Something that washes the grass: the soldier, an ally (duck-typed; they differ in field names). */
interface Washer { pos?: THREE.Vector3; position?: THREE.Vector3; vel?: THREE.Vector3; speed?: number }
// the few fields of the soldier, allies and horses the grass reads (read duck-typed, owned by the player module)
interface SoldierLike extends Washer { alive?: boolean; riding?: { pos?: THREE.Vector3 } | null; boosting?: boolean; boostLevel?: number }
interface AllyLike extends Washer { alive?: boolean; boost?: number }
interface HerdLike { horses?: { pos?: THREE.Vector3; speed: number }[] }

export function buildGrass(ctx: WorldCtx, { radius = 34, cell = 0.8 } = {}): GrassHandle {
  const cam = ctx.game.camera;
  // ---- instances: every grid cell within the radius around the camera's cell ----
  const R = Math.ceil(radius / cell) + 1, cells: [number, number][] = [];
  for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) if (i * i + j * j <= R * R) cells.push([i, j]);
  cells.sort((a, b) => a[0] * a[0] + a[1] * a[1] - b[0] * b[0] - b[1] * b[1]);   // nearest first: instanceCount = radius
  const cellsOf = (r: number) => { const rr = (r / cell + 1) ** 2; let n = 0; while (n < cells.length && cells[n][0] ** 2 + cells[n][1] ** 2 <= rr) n++; return n; };
  const geo = tuftGeometry(4);
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(cells.flat()), 2));
  geo.instanceCount = cells.length;

  // ---- press map (R: gas wash / footsteps, quick to spring back; G: titan footprints, slow) ----
  const pr = new Float32Array(PRESS_N * PRESS_N), pg = new Float32Array(PRESS_N * PRESS_N);
  const pdata = new Uint8Array(PRESS_N * PRESS_N * 2);
  const pressTex = new THREE.DataTexture(pdata, PRESS_N, PRESS_N, THREE.RGFormat, THREE.UnsignedByteType);
  pressTex.wrapS = pressTex.wrapT = THREE.RepeatWrapping;
  pressTex.minFilter = pressTex.magFilter = THREE.LinearFilter; pressTex.generateMipmaps = false; pressTex.needsUpdate = true;
  let pressActive = false;
  const rowActive = new Uint8Array(PRESS_N);                 // rows holding non-zero texels (decay only those)

  const U = {
    uCenter: { value: new THREE.Vector2() }, uCam: { value: new THREE.Vector3() }, uCell: { value: cell }, uRadius: { value: radius },
    uTime: ctx.time, uHeight: { value: heightTexture() }, uPress: { value: pressTex }, uPressSize: { value: PRESS_SIZE },
  };
  pressU.uPress.value = pressTex; pressU.uPressSize.value = PRESS_SIZE;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = `
      uniform vec2 uCenter; uniform vec3 uCam; uniform float uCell, uRadius, uTime, uPressSize;
      uniform sampler2D uHeight, uPress;
      attribute vec2 aCell; attribute float aH;
      varying vec3 vTuft;
      ${PAINT_GLSL}
      float gHt( int i, int j ) { return texelFetch( uHeight, ivec2( clamp( i, 0, ${HNX - 1} ), clamp( j, 0, ${HNZ - 1} ) ), 0 ).r; }
      float gGround( vec2 xz ) {
        vec2 g = ( xz - vec2( ${HX0}.0, ${HZ0}.0 ) ) / vec2( ${HDX}.0, ${HDZ}.0 );
        g = max( g, vec2( 0.0 ) );
        ivec2 c = ivec2( floor( g ) ); vec2 f = fract( g );
        float a = gHt( c.x, c.y ), b = gHt( c.x + 1, c.y ), d = gHt( c.x, c.y + 1 ), e = gHt( c.x + 1, c.y + 1 );
        return f.x + f.y < 1.0 ? a + ( b - a ) * f.x + ( d - a ) * f.y : e + ( d - e ) * ( 1.0 - f.x ) + ( b - e ) * ( 1.0 - f.y );
      }
      float gPress( vec2 xz ) { vec2 p = texture2D( uPress, xz / uPressSize ).rg; return max( p.r, p.g ); }
    ` + sh.vertexShader.replace('#include <begin_vertex>', `
      vec2 cellI = uCenter + aCell;
      vec2 jit = vec2( gHash( cellI + vec2( 0.5, 101.0 ) ), gHash( cellI + vec2( 57.0, 13.0 ) ) );
      float hr = gHash( cellI + vec2( -31.0, 7.0 ) ), hs = gHash( cellI + vec2( 3.0, -91.0 ) ), hd = gHash( cellI + vec2( 77.0, 29.0 ) );
      vec2 root = ( cellI + jit ) * uCell;
      vec3 rp = vec3( root.x, gGround( root ), root.y );
      // where tufts grow: not on the road, not in the town / gate yard, thin under the giant trees, clumpy
      float forest = gForest( root );
      float roadX = 20.0 * sin( root.y / 62.0 ) * smoothstep( 18.0, 70.0, root.y );
      float road = root.y > 940.0 ? 1.0 : smoothstep( 5.0, 6.6, abs( root.x - roadX ) );
      float clump = gNoise( root * ( 1.0 / 7.0 ) + 3.0 );
      float dens = mix( 0.72 + 0.5 * clump, 0.2 * clump, forest );
      float grow = step( hd, dens ) * road * smoothstep( 9.0, 12.0, root.y ) * step( abs( root.x ), 1090.0 );
      float dist = distance( rp, uCam );
      float fade = 1.0 - smoothstep( uRadius * 0.55, uRadius, dist );
      float dry;
      vec3 paint = gFieldPaint( root, dry );
      float sc = ( 0.7 + 0.55 * hs + 0.35 * dry ) * mix( 0.55, 1.0, fade ) * grow * step( 0.001, fade );
      vec3 p = position * vec3( 1.0, sc, 1.0 ) * mix( 1.0, sc, 0.6 );
      float ca = cos( hr * 6.2832 ), sa = sin( hr * 6.2832 );
      p.xz = mat2( ca, -sa, sa, ca ) * p.xz;
      // wind: gusts roll across the field as broad waves, plus a little per-tuft flutter
      vec2 W = vec2( 0.87, 0.49 );
      float gust = 0.5 + 0.5 * sin( dot( root, W ) * 0.21 - uTime * 2.3 + gNoise( root * 0.035 + W * uTime * 0.25 ) * 4.0 );
      gust = gust * gust;
      vec2 bend = W * ( 0.12 + 0.62 * gust ) + vec2( sin( uTime * 3.3 + hr * 40.0 ), cos( uTime * 2.9 + hs * 30.0 ) ) * 0.07;
      // flattening: bend away from the middle of the pressed spot (down the press gradient)
      vec2 pp = texture2D( uPress, root / uPressSize ).rg;
      float P = max( pp.r, pp.g );
      if ( P > 0.004 ) {
        vec2 grad = vec2( gPress( root + vec2( 0.8, 0.0 ) ) - gPress( root - vec2( 0.8, 0.0 ) ), gPress( root + vec2( 0.0, 0.8 ) ) - gPress( root - vec2( 0.0, 0.8 ) ) );
        vec2 out2 = dot( grad, grad ) > 1e-5 ? -normalize( grad ) : normalize( vec2( jit.x - 0.5, jit.y - 0.5 ) + 1e-3 );
        float flat2 = smoothstep( 0.0, 0.85, P );
        bend = mix( bend, out2 * 1.5, flat2 ) + vec2( -out2.y, out2.x ) * sin( uTime * 31.0 + hr * 50.0 ) * 0.3 * pp.r * ( 1.0 - pp.r );
      }
      float th = min( length( bend ), 1.5 );
      vec2 bdir = bend / max( length( bend ), 1e-4 );
      float t = th * ( 0.35 + 0.65 * aH );
      p.xz += bdir * p.y * sin( t );
      p.y *= cos( t );
      vec3 transformed = rp + p;
      // colour: the ground's paint at the root, dark at the base, light at the tip; gust sheen; pressed blades
      // show their paler sides
      vec3 fc = vec3( 0.05, 0.075, 0.03 );
      vec3 base = mix( paint, fc, forest );
      // each tuft a little off the ground's hue: some greener, some more straw
      vec3 hueJ = mix( vec3( 0.92, 1.06, 0.9 ), vec3( 1.12, 1.0, 0.82 ), hs );
      vec3 col = base * hueJ * mix( 0.55, 1.2, aH ) * ( 1.0 + 0.3 * P ) + vec3( 0.03, 0.032, 0.008 ) * aH * ( 0.6 * gust + 1.2 * P ) * ( 1.0 - forest * 0.7 );
      vTuft = mix( base, col, fade );
    `);
    sh.fragmentShader = 'varying vec3 vTuft;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', 'diffuseColor.rgb = vTuft;')
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize( vNormal );');
  };
  mat.customProgramCacheKey = () => 'grass-tufts-v2';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'grassTufts'; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true;
  mesh.raycast = () => {};
  ctx.scene.add(mesh);

  // ---- pressing ----
  /** Flatten grass round pos (Vector3-like, world) out to radius m. strength 0..1; lasting = slow to recover. */
  function press(pos: THREE.Vector3, radius = 1.5, strength = 1, lasting = false): void {
    const arr = lasting ? pg : pr, s = Math.min(1, strength) * (lasting ? 1.8 : 1);   // footprints hold flat a while
    if (!(s > 0) || !(radius > 0)) return;
    const r = Math.min(radius, 20), i0 = Math.floor((pos.x - r) / PRESS_TEXEL), i1 = Math.floor((pos.x + r) / PRESS_TEXEL);
    const j0 = Math.floor((pos.z - r) / PRESS_TEXEL), j1 = Math.floor((pos.z + r) / PRESS_TEXEL);
    for (let j = j0; j <= j1; j++) {
      const jr = ((j % PRESS_N) + PRESS_N) % PRESS_N, dz = (j + 0.5) * PRESS_TEXEL - pos.z, row = jr * PRESS_N;
      rowActive[jr] = 1;
      for (let i = i0; i <= i1; i++) {
        const dx = (i + 0.5) * PRESS_TEXEL - pos.x, q = (dx * dx + dz * dz) / (r * r);
        if (q >= 1) continue;
        const v = s * (1 - q * q), k = row + ((i % PRESS_N) + PRESS_N) % PRESS_N;
        if (v > arr[k]) arr[k] = v;
      }
    }
    pressActive = true;
  }

  // ---- who flattens grass (read from the game, no hooks into other modules) ----
  ctx.game.events?.on?.('titan:step', (e: { position?: THREE.Vector3; size?: number } | undefined) => {
    if (!e?.position) return;
    const h = e.size || 8;
    press(e.position, Math.max(1.8, h * 0.2), 1, true);
  });
  const _g = new THREE.Vector3();
  function washFrom(o: Washer, boost: number): void {
    const p = o.pos || o.position; if (!p) return;
    const gy = groundHeight(p.x, p.z), hAbove = p.y - gy;
    if (hAbove > 9 || hAbove < -1) return;
    const sp = o.vel ? o.vel.length() : (o.speed || 0);
    _g.set(p.x, gy, p.z);
    if (hAbove < 1.2) press(_g, 0.75, 0.9);                                  // feet (also running / landing)
    // gas jet blasting the ground: wide when boosting low, a slipstream when skimming fast
    const wash = Math.max(boost * (1 - smoothstep(1.5, 9, hAbove)), smoothstep(12, 30, sp) * (1 - smoothstep(0.8, 3.5, hAbove)) * 0.7);
    if (wash > 0.05) press(_g, 2 + 4.5 * wash * (0.6 + 0.4 * smoothstep(0, 6, hAbove)), wash);
  }

  const center = U.uCenter.value;
  function update(dt: number, camPos?: THREE.Vector3): void {
    const c = camPos || cam.position, g = ctx.game;
    // tufts only matter near the ground of the field / forest
    // lower quality levels (main.js game.quality 2/1/0) draw the tufts in a smaller circle
    const q = g.quality ?? 2, r = radius * (q >= 2 ? 1 : q === 1 ? 0.75 : 0.5);
    if (r !== U.uRadius.value) { U.uRadius.value = r; geo.instanceCount = cellsOf(r); }
    const above = c.y - groundHeight(c.x, c.z);
    mesh.visible = above < r && c.z > -20;
    const pl = g.player as unknown as SoldierLike | undefined;
    if (pl && pl.alive !== false && !pl.riding) washFrom(pl, pl.boosting ? Math.max(0.6, pl.boostLevel || 1) : 0);
    if (pl?.riding && pl.riding.pos) press(pl.riding.pos, 1.0, 0.8);
    for (const a of (g.allies || []) as unknown as AllyLike[]) {
      const ap = a && (a.pos || a.position);
      if (ap && a.alive !== false && ap.distanceToSquared(c) < 3600) washFrom(a, (a.boost ?? 0) > 0 ? 1 : 0);
    }
    for (const h of (g.herd as unknown as HerdLike | null)?.horses || []) if (h.pos && h.speed > 1 && h.pos.distanceToSquared(c) < 3600) press(h.pos, 0.9, 0.7);
    if (pressActive) {
      // spring back: gas wash in ~1.5 s, titan footprints over ~10 s
      const dr = dt * 0.7, dg = dt * 0.1;
      let any = false;
      for (let j = 0; j < PRESS_N; j++) {
        if (!rowActive[j]) continue;
        let rowAny = false;
        for (let k = j * PRESS_N, n = k + PRESS_N; k < n; k++) {
          let a = pr[k], b = pg[k];
          if (a > 0) { a = a > dr ? a - dr : 0; pr[k] = a; rowAny = true; }
          if (b > 0) { b = b > dg ? b - dg : 0; pg[k] = b; rowAny = true; }
          pdata[k * 2] = a * 255; pdata[k * 2 + 1] = Math.min(1, b) * 255;
        }
        rowActive[j] = rowAny ? 1 : 0; any ||= rowAny;
      }
      pressTex.needsUpdate = true;
      pressActive = any;
    }
    pressU.uPressCam.value.copy(c);
    if (!mesh.visible) return;
    center.set(Math.floor(c.x / cell), Math.floor(c.z / cell));
    U.uCam.value.copy(c);
  }
  ctx.updaters.push(update);
  return { press, update, mesh, pressTexture: pressTex, instances: geo.instanceCount };
}
