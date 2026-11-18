// Quaternion and vector helpers on flat Float64Arrays: a skeleton's pose is one array per quantity, so a frame
// allocates nothing. Quaternions are [x, y, z, w].

export type Arr = Float64Array;

export function qSet(q: Arr, o: number, x: number, y: number, z: number, w: number): void {
  q[o] = x; q[o + 1] = y; q[o + 2] = z; q[o + 3] = w;
}

export function qIdentity(q: Arr, o: number): void {
  q[o] = 0; q[o + 1] = 0; q[o + 2] = 0; q[o + 3] = 1;
}

export function qCopy(dst: Arr, d: number, src: Arr, s: number): void {
  dst[d] = src[s]!; dst[d + 1] = src[s + 1]!; dst[d + 2] = src[s + 2]!; dst[d + 3] = src[s + 3]!;
}

/** Euler XYZ (three's default order) in radians. */
export function qFromEuler(q: Arr, o: number, x: number, y: number, z: number): void {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  q[o] = s1 * c2 * c3 + c1 * s2 * s3;
  q[o + 1] = c1 * s2 * c3 - s1 * c2 * s3;
  q[o + 2] = c1 * c2 * s3 + s1 * s2 * c3;
  q[o + 3] = c1 * c2 * c3 - s1 * s2 * s3;
}

/** out = a * b. `out` may be the same slot as a or b. */
export function qMul(out: Arr, oo: number, a: Arr, ao: number, b: Arr, bo: number): void {
  const ax = a[ao]!, ay = a[ao + 1]!, az = a[ao + 2]!, aw = a[ao + 3]!;
  const bx = b[bo]!, by = b[bo + 1]!, bz = b[bo + 2]!, bw = b[bo + 3]!;
  out[oo] = ax * bw + aw * bx + ay * bz - az * by;
  out[oo + 1] = ay * bw + aw * by + az * bx - ax * bz;
  out[oo + 2] = az * bw + aw * bz + ax * by - ay * bx;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** out = conjugate(a) * b: the rotation that takes frame a to frame b. */
export function qMulInv(out: Arr, oo: number, a: Arr, ao: number, b: Arr, bo: number): void {
  const ax = -a[ao]!, ay = -a[ao + 1]!, az = -a[ao + 2]!, aw = a[ao + 3]!;
  const bx = b[bo]!, by = b[bo + 1]!, bz = b[bo + 2]!, bw = b[bo + 3]!;
  out[oo] = ax * bw + aw * bx + ay * bz - az * by;
  out[oo + 1] = ay * bw + aw * by + az * bx - ax * bz;
  out[oo + 2] = az * bw + aw * bz + ax * by - ay * bx;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

export function qNormalize(q: Arr, o: number): void {
  const x = q[o]!, y = q[o + 1]!, z = q[o + 2]!, w = q[o + 3]!;
  const n = Math.hypot(x, y, z, w);
  if (n < 1e-12) { qIdentity(q, o); return; }
  q[o] = x / n; q[o + 1] = y / n; q[o + 2] = z / n; q[o + 3] = w / n;
}

/** Normalised lerp on the short arc: out = nlerp(a, b, t). Cheap, and indistinguishable from slerp for small steps. */
export function qNlerp(out: Arr, oo: number, a: Arr, ao: number, b: Arr, bo: number, t: number): void {
  const ax = a[ao]!, ay = a[ao + 1]!, az = a[ao + 2]!, aw = a[ao + 3]!;
  let bx = b[bo]!, by = b[bo + 1]!, bz = b[bo + 2]!, bw = b[bo + 3]!;
  if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
  out[oo] = ax + (bx - ax) * t;
  out[oo + 1] = ay + (by - ay) * t;
  out[oo + 2] = az + (bz - az) * t;
  out[oo + 3] = aw + (bw - aw) * t;
  qNormalize(out, oo);
}

/** Rotates the vector (x, y, z) by q; writes to v[vo..vo+2]. */
export function qRotate(q: Arr, qo: number, x: number, y: number, z: number, v: Arr, vo: number): void {
  const qx = q[qo]!, qy = q[qo + 1]!, qz = q[qo + 2]!, qw = q[qo + 3]!;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  v[vo] = x + qw * tx + (qy * tz - qz * ty);
  v[vo + 1] = y + qw * ty + (qz * tx - qx * tz);
  v[vo + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/** Shortest rotation taking unit vector u to unit vector v. */
export function qFromTo(q: Arr, o: number, ux: number, uy: number, uz: number, vx: number, vy: number, vz: number): void {
  const d = ux * vx + uy * vy + uz * vz;
  if (d > 0.999999) { qIdentity(q, o); return; }
  if (d < -0.999999) {
    // Opposite: turn half a circle about any axis perpendicular to u.
    let ax = 0, ay = -uz, az = uy;
    if (Math.abs(uy) < 1e-6 && Math.abs(uz) < 1e-6) { ax = -uz; ay = 0; az = ux; }
    const n = Math.hypot(ax, ay, az) || 1;
    qSet(q, o, ax / n, ay / n, az / n, 0);
    return;
  }
  qSet(q, o, uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx, 1 + d);
  qNormalize(q, o);
}

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
