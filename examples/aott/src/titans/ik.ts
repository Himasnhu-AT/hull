// Analytic two-bone IK for the titan arms. Works in the local space of the arm's parent (spine).
import * as THREE from 'hull/three';

const V3 = THREE.Vector3;
const _d = new V3(), _p = new V3(), _u = new V3(), _f = new V3(), _x = new V3(), _y = new V3(), _z = new V3();
const _m = new THREE.Matrix4();
const X_AXIS = new V3(1, 0, 0);
const clamp = THREE.MathUtils.clamp;

/**
 * S: shoulder position, T: target position for the palm (both in the parent's space).
 * L1/L2: upper / lower bone lengths, pole: direction the elbow should point to (parent space).
 * Writes the upper-arm joint quaternion (relative to parent, rest = hanging along -y) into q1 and the
 * forearm joint quaternion (relative to the upper arm) into q2. Returns the clamped reach fraction.
 */
export function solveArm(S: THREE.Vector3, T: THREE.Vector3, L1: number, L2: number, pole: THREE.Vector3, q1: THREE.Quaternion, q2: THREE.Quaternion): number {
  _d.subVectors(T, S);
  let dist = _d.length();
  const maxR = (L1 + L2) * 0.998, minR = Math.abs(L1 - L2) * 1.02 + 0.08 * Math.min(L1, L2);
  if (dist < 1e-5) _d.set(0, -1, 0); else _d.divideScalar(dist);
  dist = clamp(dist, minR, maxR);
  const cosA = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist);
  const A = Math.acos(clamp(cosA, -1, 1));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-6) { _p.set(1, 0, 0).addScaledVector(_d, -_d.x); if (_p.lengthSq() < 1e-6) _p.set(0, 0, 1); }
  _p.normalize();
  _u.copy(_d).multiplyScalar(Math.cos(A)).addScaledVector(_p, Math.sin(A));       // upper arm direction
  _f.copy(_d).multiplyScalar(dist).addScaledVector(_u, -L1).normalize();           // elbow -> target
  _y.copy(_u).negate();
  const dotuf = clamp(_u.dot(_f), -1, 1);
  _z.copy(_f).addScaledVector(_u, -dotuf);
  if (_z.lengthSq() < 1e-8) _z.copy(_p).negate();
  _z.normalize().negate();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  q1.setFromRotationMatrix(_m);
  q2.setFromAxisAngle(X_AXIS, Math.acos(dotuf));
  return dist / (L1 + L2);
}
