// Natural sky: a gradient dome with horizon haze, forward-scattering glow and a sun disc; soft, self-shadowed cumulus
// billboards; and three mountain ranges fading into the haze with distance (aerial perspective). Everything is
// rendered at the far plane (xyww trick) so it never depends on camera.far and never needs to follow the camera.
import * as THREE from 'hull/three';
import { Rng, smoothstep } from './rng';
import { SUN_DIR, FOG_COLOR, noise2 } from './common';
import type { WorldCtx } from './common';
import { makeCanvas } from '../canvas';

const FAR_VS = (extra = '') => `
  ${extra}
  void main() {
    vec4 lp = vec4( position, 1.0 );
    #ifdef USE_INSTANCING
      lp = instanceMatrix * lp;
    #endif
    vec3 vp = mat3( modelViewMatrix ) * lp.xyz;
    gl_Position = ( projectionMatrix * vec4( vp, 1.0 ) ).xyww;
    VARYINGS
  }`;

/** Uniforms of the sky dome, written by world.setAtmosphere. */
export interface DomeUniforms {
  [k: string]: THREE.IUniform;
  uSun: THREE.IUniform<THREE.Vector3>;
  cHorizon: THREE.IUniform<THREE.Color>;
  cMid: THREE.IUniform<THREE.Color>;
  cZenith: THREE.IUniform<THREE.Color>;
  cSun: THREE.IUniform<THREE.Color>;
}

function domeMaterial(u: DomeUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    uniforms: u,
    vertexShader: 'varying vec3 vDir;\n' + FAR_VS().replace('VARYINGS', 'vDir = position;'),
    fragmentShader: `
      varying vec3 vDir; uniform vec3 uSun, cHorizon, cMid, cZenith, cSun;
      void main() {
        vec3 d = normalize( vDir ); float h = d.y, hp = max( h, 0.0 );
        // a thick bright haze at the horizon, clearing quickly into blue, deepening towards the zenith
        vec3 col = mix( cHorizon, cMid, 1.0 - exp( -hp * 9.0 ) );
        col = mix( col, cZenith, smoothstep( 0.12, 0.95, hp ) );
        float sd = max( dot( d, uSun ), 0.0 );
        // forward scattering round the sun, stronger in the low haze
        col += cSun * ( pow( sd, 5.0 ) * 0.12 + pow( sd, 40.0 ) * 0.3 + pow( sd, 600.0 ) * 0.8 ) * ( 0.45 + 0.55 * exp( -hp * 3.0 ) );
        // the disc (bright enough to clip to white through the tone mapper)
        col += cSun * smoothstep( 0.99984, 0.99992, sd ) * 14.0;
        // below the horizon: the fog colour
        col = mix( col, cHorizon, smoothstep( 0.0, -0.05, h ) );
        col += ( fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5 ) / 255.0;
        gl_FragColor = vec4( col, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * One mountain range: a ring of ridged peaks. Vertex colour r = how much of the mountain's own colour shows (the rest
 * is horizon haze), g = rock shade variation.
 */
function mountainRing(radius: number, base: number, peak: number, solid: number, seed: number, nSeg: number): THREE.BufferGeometry {
  const rng = new Rng(seed), pos: number[] = [], col: number[] = [], idx: number[] = [];
  const rows = 5, hs: number[] = [];
  for (let i = 0; i <= nSeg; i++) {
    const a = (i / nSeg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    // broad massifs, then ridged peaks on top, then fine jaggedness
    const massif = 0.5 + 0.5 * noise2(ca * 1.6 + seed, sa * 1.6);
    const ridge = 1 - Math.abs(noise2(ca * 5.3 + seed * 2.1, sa * 5.3));
    const jag = noise2(ca * 17 + seed, sa * 17 - seed) * 0.5 + rng.range(-0.06, 0.06);
    hs.push(peak * Math.max(0.12, massif * 0.75 + 0.1) * (0.55 + 0.45 * ridge + 0.12 * jag));
  }
  // light the slopes: the face seen from inside the ring leans towards or away from the sun along the ridge line
  const sun = new THREE.Vector3(SUN_DIR.x, 0, SUN_DIR.z).normalize(), n = new THREE.Vector3();
  const ds = (Math.PI * 2 * radius) / nSeg;
  for (let i = 0; i <= nSeg; i++) {
    const a = (i / nSeg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    const slope = (hs[Math.min(nSeg, i + 1)] - hs[Math.max(0, i - 1)]) / (2 * ds);
    // inward normal, tipped along the tangent by the slope and up by the general steepness
    n.set(-ca, 0, -sa).addScaledVector(new THREE.Vector3(-sa, 0, ca), -slope * 2.5).normalize();
    const lit = 0.72 + 0.5 * Math.max(0, n.dot(sun)) - 0.15 * Math.max(0, -n.dot(sun));
    const tex = 0.92 + 0.16 * (0.5 + 0.5 * noise2(ca * 31 + seed, sa * 31));
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      pos.push(ca * radius, base + (hs[i] - base) * t, sa * radius);
      // lower slopes darker (forest), the summits paler (bare rock)
      col.push(solid * Math.pow(t, 0.7), lit * tex * (0.85 + 0.25 * t), 0);
    }
  }
  for (let i = 0; i < nSeg; i++) for (let r = 0; r < rows - 1; r++) {
    const a = i * rows + r, b = (i + 1) * rows + r;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/**
 * A soft cumulus: a density field of overlapping puffs (flat base, domed top) roughened by noise; lit from above by
 * marching the density towards the light, so the tops are bright and the bellies grey-blue.
 */
function cloudTexture(seed: number): THREE.CanvasTexture {
  const rng = new Rng(seed), W = 640, H = 256;
  const D = new Float32Array(W * H);
  const base = H * 0.78, n = rng.int(16, 26);
  const puff = (cx: number, cy: number, r: number, k: number) => {
    const x0 = Math.max(0, Math.floor(cx - r * 2)), x1 = Math.min(W - 1, Math.ceil(cx + r * 2));
    const y0 = Math.max(0, Math.floor(cy - r * 2)), y1 = Math.min(H - 1, Math.ceil(cy + r * 2));
    const i2 = 1 / (r * r);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy, q = (dx * dx + dy * dy) * i2;
      if (q < 4) D[y * W + x] += k * Math.exp(-q * 1.6);
    }
  };
  for (let i = 0; i < n; i++) {
    const u = (i + rng.range(-0.4, 0.4)) / (n - 1), mid = 1 - Math.abs(u - 0.5) * 2;
    const r = (18 + mid * 46) * rng.range(0.7, 1.2);
    puff(60 + u * (W - 120), base - r * rng.range(0.3, 0.8) - mid * rng.range(10, 55), r, rng.range(0.7, 1.1));
  }
  for (let i = 0; i < 8; i++) puff(W * rng.range(0.25, 0.75), base - rng.range(50, 110), rng.range(24, 46), rng.range(0.5, 0.9));
  for (let i = 0; i < 30; i++) puff(W * rng.range(0.08, 0.92), base - rng.range(0, 30), rng.range(8, 18), rng.range(0.3, 0.6));
  // roughen: multiply by a noise so the edges break into wisps
  const nz = (x: number, y: number) => 0.5 + 0.5 * noise2(x * 0.035 + seed, y * 0.035) * 0.7 + 0.5 * noise2(x * 0.11 - seed, y * 0.11) * 0.3;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    D[i] *= (0.55 + 0.75 * nz(x, y)) * smoothstep(base + 4, base - 14, y);
  }
  const c = makeCanvas(); c.width = W; c.height = H;
  const ctx = c.getContext('2d')!, img = ctx.createImageData(W, H), d = img.data;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : D[y * W + x]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dn = D[y * W + x], a = smoothstep(0.18, 0.75, dn);
    if (a <= 0) continue;
    let od = 0; for (let s = 1; s <= 5; s++) od += at(x - s * 3, y - s * 6);
    const lit = Math.exp(-od * 0.42);
    const belly = smoothstep(base - 40, base, y);
    const k = Math.min(1, lit * (1 - 0.35 * belly));
    const i = (y * W + x) * 4;
    // shadowed grey-blue to sunlit warm white
    d[i] = 150 + 105 * k; d[i + 1] = 158 + 95 * k; d[i + 2] = 174 + 72 * k; d[i + 3] = a * 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export interface SkyRefs { sky: THREE.Group; clouds: THREE.Group; dome: DomeUniforms; tint: THREE.Color }

export function buildSky(ctx: WorldCtx): SkyRefs {
  const scene = ctx.scene;
  // reuse the scene's fog and background objects: other systems hold references to them
  if (scene.background instanceof THREE.Color) scene.background.set(FOG_COLOR); else scene.background = new THREE.Color(FOG_COLOR);
  if (scene.fog instanceof THREE.Fog) { scene.fog.color.set(FOG_COLOR); scene.fog.near = 120; scene.fog.far = 1400; }
  else scene.fog = new THREE.Fog(FOG_COLOR, 120, 1400);

  const sky = new THREE.Group(); sky.name = 'sky'; scene.add(sky);
  // world.setAtmosphere() tints the mountains and clouds (smoke haze, dawn light) through this one shared uniform
  const tint = { value: new THREE.Color(1, 1, 1) };
  const domeU: DomeUniforms = {
    uSun: { value: SUN_DIR.clone() },
    cHorizon: { value: new THREE.Color(FOG_COLOR) },
    cMid: { value: new THREE.Color(0x8fb2d6) },
    cZenith: { value: new THREE.Color(0x3d6aa8) },
    cSun: { value: new THREE.Color(0xfff0d8) },
  };
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 20), domeMaterial(domeU));
  dome.renderOrder = -1000; dome.frustumCulled = false; sky.add(dome);

  // mountains: three ranges, the farthest almost lost in the haze
  const cMount = { value: new THREE.Color(0x5a6672) };
  const mkMat = () => new THREE.ShaderMaterial({
    vertexColors: true, side: THREE.DoubleSide, depthWrite: false, depthTest: true, fog: false,
    uniforms: { uTint: tint, cHorizon: domeU.cHorizon, cMount },
    vertexShader: 'varying vec3 vC;\n' + FAR_VS().replace('VARYINGS', 'vC = color;'),
    fragmentShader: `varying vec3 vC; uniform vec3 uTint, cHorizon, cMount;
      void main() {
        vec3 col = mix( cHorizon, cMount * uTint * vC.g, vC.r );
        gl_FragColor = vec4( col, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const rings = [
    mountainRing(1800, -250, 400, 0.4, 7, 240),
    mountainRing(1650, -250, 330, 0.55, 13, 220),
    mountainRing(1500, -250, 230, 0.7, 21, 200),
  ];
  rings.forEach((g, i) => { const m = new THREE.Mesh(g, mkMat()); m.renderOrder = -900 + i; m.frustumCulled = false; sky.add(m); });

  // soft cumulus billboards on the sky sphere (drift slowly), hazier near the horizon
  const clouds = new THREE.Group(); clouds.name = 'clouds'; scene.add(clouds);
  const rng = new Rng(77);
  const cmat = (tex: THREE.Texture) => new THREE.ShaderMaterial({
    transparent: true, side: THREE.DoubleSide, depthWrite: false, depthTest: true, fog: false,
    uniforms: { map: { value: tex }, uTint: tint, cHorizon: domeU.cHorizon },
    vertexShader: 'varying vec2 vUv; varying float vH;\n' + FAR_VS().replace('VARYINGS', 'vUv = uv; vH = normalize( lp.xyz ).y;'),
    fragmentShader: `varying vec2 vUv; varying float vH; uniform sampler2D map; uniform vec3 uTint, cHorizon;
      void main() {
        vec4 t = texture2D( map, vUv );
        if ( t.a < 0.01 ) discard;
        vec3 col = t.rgb * uTint * 1.25;
        float haze = 1.0 - smoothstep( 0.02, 0.3, vH );
        col = mix( col, cHorizon, haze * 0.65 );
        gl_FragColor = vec4( col, t.a * ( 1.0 - haze * 0.35 ) );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const plane = new THREE.PlaneGeometry(1, 0.4);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), origin = new THREE.Vector3();
  for (let k = 0; k < 3; k++) {
    const count = 7, im = new THREE.InstancedMesh(plane, cmat(cloudTexture(100 + k * 17)), count);
    for (let i = 0; i < count; i++) {
      const az = ((i + k / 3) / count) * Math.PI * 2 + rng.range(-0.25, 0.25), el = rng.range(0.05, 0.36) + (i % 2) * 0.08;
      p.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).multiplyScalar(1500);
      m4.lookAt(origin, p, up); q.setFromRotationMatrix(m4);
      const w = rng.range(480, 1050); s.set(w, w * rng.range(0.85, 1.1), 1);
      m4.compose(p, q, s); im.setMatrixAt(i, m4);
    }
    im.renderOrder = -800 + k; im.frustumCulled = false; clouds.add(im);
  }
  ctx.updaters.push((dt) => { clouds.rotation.y += dt * 0.0035; });
  return { sky, clouds, dome: domeU, tint: tint.value };
}
