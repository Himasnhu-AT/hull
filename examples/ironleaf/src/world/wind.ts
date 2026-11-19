// One wind for the whole island. The pampas, the bamboo and the trees bend in the vertex shader from these uniforms, so
// the CPU only writes four numbers a frame. The Atmosphere behaviour sets strength and direction from the look and the clock.
import * as THREE from 'hull/three';

export const windU = {
  uTime: { value: 0 },
  uWind: { value: 0.4 },
  uSpeed: { value: 1.3 },
  uDir: { value: new THREE.Vector2(0.82, 0.57) },
};

/**
 * Where the camera, Aya and the enemy she fights are, for the tall grass: a blade near the line from the camera to either of
 * them, or near a fight, is cut down in the vertex shader so the fight can be seen (the camera is behind her, the grass is
 * as tall as she is). Written each frame by the Atmosphere.
 */
export const clearU = {
  uCamPos: { value: new THREE.Vector3(0, 100, 0) },
  uFocus: { value: new THREE.Vector3(0, -100, 0) },
  uFoe: { value: new THREE.Vector3(0, -100, 0) },
  uFoeOn: { value: 0 },
  /** Half-width of the cleared lane along each line of sight, in metres. */
  uLane: { value: 1.3 },
  /** Radius around Aya inside which the grass is low. */
  uFightR: { value: 3.2 },
};

/** Adds a bend to a material's vertex shader: the higher a vertex is on its mesh, the further the gust pushes it. */
export function windify<M extends THREE.Material>(m: M, o: { bendH: number; amp: number; clear?: boolean }): M {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, windU);
    if (o.clear) Object.assign(sh.uniforms, clearU);
    sh.uniforms['uBendH'] = { value: o.bendH };
    sh.uniforms['uAmp'] = { value: o.amp };
    sh.vertexShader =
      'uniform float uTime; uniform float uWind; uniform float uSpeed; uniform float uBendH; uniform float uAmp; uniform vec2 uDir;\n' +
      (o.clear ? CLEAR_DECL : '') +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec3 iP = vec3( instanceMatrix[3] ); mat3 iM = mat3( instanceMatrix );
          #else
            vec3 iP = vec3( 0.0 ); mat3 iM = mat3( 1.0 );
          #endif
          float b = pow( clamp( position.y / uBendH, 0.0, 1.0 ), 1.7 );
          float w = sin( uTime * uSpeed + dot( iP.xz, uDir ) * 0.085 ) * 0.55 + sin( uTime * uSpeed * 2.7 + iP.x * 0.7 + iP.z * 0.5 + position.y * 1.3 ) * 0.18 + 0.45;
          vec3 d = transpose( iM ) * vec3( uDir.x, 0.0, uDir.y ) / max( dot( iM[0], iM[0] ), 1e-4 );
          transformed += d * ( w * uWind * uAmp * b );
          ${o.clear ? CLEAR_BODY : ''}
        }`,
      );
  };
  m.customProgramCacheKey = () => (o.clear ? 'ironleaf-wind-clear' : 'ironleaf-wind');
  return m;
}

const CLEAR_DECL = 'uniform vec3 uCamPos; uniform vec3 uFocus; uniform vec3 uFoe; uniform float uFoeOn; uniform float uLane; uniform float uFightR;\n' +
  'float laneDist( vec2 p, vec2 a, vec2 b ) { vec2 ab = b - a; float t = clamp( dot( p - a, ab ) / max( dot( ab, ab ), 1e-4 ), 0.0, 1.0 ); return length( p - ( a + ab * t ) ); }\n';

// Low near the lines of sight and around the fight, full height elsewhere. The blade shrinks about its own root, wider
// ones faster, so the grass looks trampled rather than missing.
const CLEAR_BODY = `
          float dL = laneDist( iP.xz, uCamPos.xz, uFocus.xz );
          if ( uFoeOn > 0.5 ) dL = min( dL, laneDist( iP.xz, uCamPos.xz, uFoe.xz ) );
          float kLane = smoothstep( uLane * 0.6, uLane * 1.7, dL );
          float kFight = smoothstep( uFightR * 0.55, uFightR, length( iP.xz - uFocus.xz ) );
          float kk = min( kLane, kFight );
          transformed *= vec3( mix( 0.55, 1.0, kk ), mix( 0.16, 1.0, kk ), mix( 0.55, 1.0, kk ) );`;
