// One wind for the whole island. The pampas, the bamboo and the trees bend in the vertex shader from these uniforms, so
// the CPU only writes four numbers a frame. The Atmosphere behaviour sets strength and direction from the look and the clock.
import * as THREE from 'hull/three';

export const windU = {
  uTime: { value: 0 },
  uWind: { value: 0.4 },
  uSpeed: { value: 1.3 },
  uDir: { value: new THREE.Vector2(0.82, 0.57) },
};

/** Adds a bend to a material's vertex shader: the higher a vertex is on its mesh, the further the gust pushes it. */
export function windify<M extends THREE.Material>(m: M, o: { bendH: number; amp: number }): M {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, windU);
    sh.uniforms['uBendH'] = { value: o.bendH };
    sh.uniforms['uAmp'] = { value: o.amp };
    sh.vertexShader =
      'uniform float uTime; uniform float uWind; uniform float uSpeed; uniform float uBendH; uniform float uAmp; uniform vec2 uDir;\n' +
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
        }`,
      );
  };
  m.customProgramCacheKey = () => 'ironleaf-wind';
  return m;
}
