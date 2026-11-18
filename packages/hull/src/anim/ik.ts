// Inverse kinematics on a posed skeleton, in model space. Both solvers edit the pose's local rotations and keep
// the model-space arrays (`mq`, `mp`) in step, so the caller can chain them: feet, then look, then hands.
import { clamp, qFromTo, qIdentity, qMul, qMulInv, qNlerp, qRotate, type Arr } from './math.ts';
import type { Pose, Skeleton } from './skeleton.ts';

const q1 = new Float64Array(4);
const q2 = new Float64Array(4);
const v1 = new Float64Array(3);

/** Sets bone i's model rotation to the value in q1 and writes the matching local rotation into the pose. */
function commit(sk: Skeleton, pose: Pose, mq: Arr, i: number): void {
  for (let k = 0; k < 4; k++) mq[i * 4 + k] = q1[k]!;
  const p = sk.parent[i]!;
  if (p < 0) for (let k = 0; k < 4; k++) pose.rot[i * 4 + k] = q1[k]!;
  else qMulInv(pose.rot, i * 4, mq, p * 4, mq, i * 4);
}

export interface TwoBoneResult {
  /** False when the target was out of reach and the limb is stretched straight toward it. */
  reached: boolean;
}
const result: TwoBoneResult = { reached: true };

/**
 * Bends the chain a -> b -> c (upper, lower, end bone; the end is the c joint's position) so c meets the target.
 * `pole` says which way the middle joint bends (a knee forward, an elbow back). A target out of reach stretches the
 * limb straight toward it; one too close folds it as far as it goes. `weight` 0..1 blends from the animated pose.
 * The returned object is shared: read it before the next call.
 */
export function twoBone(
  sk: Skeleton, pose: Pose, mq: Arr, mp: Arr,
  a: number, b: number, c: number,
  tx: number, ty: number, tz: number,
  px: number, py: number, pz: number,
  weight = 1,
): TwoBoneResult {
  result.reached = true;
  if (weight <= 0) return result;
  const ax = mp[a * 3]!, ay = mp[a * 3 + 1]!, az = mp[a * 3 + 2]!;
  const bx = mp[b * 3]!, by = mp[b * 3 + 1]!, bz = mp[b * 3 + 2]!;
  const cx = mp[c * 3]!, cy = mp[c * 3 + 1]!, cz = mp[c * 3 + 2]!;
  const l1 = Math.hypot(bx - ax, by - ay, bz - az);
  const l2 = Math.hypot(cx - bx, cy - by, cz - bz);
  if (l1 < 1e-9 || l2 < 1e-9) return result;

  const gx = cx + (tx - cx) * weight, gy = cy + (ty - cy) * weight, gz = cz + (tz - cz) * weight;
  let dx = gx - ax, dy = gy - ay, dz = gz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist > 1e-9) { dx /= dist; dy /= dist; dz /= dist; } else {
    dx = cx - ax; dy = cy - ay; dz = cz - az;
    const n = Math.hypot(dx, dy, dz) || 1;
    dx /= n; dy /= n; dz /= n;
  }
  const lo = Math.abs(l1 - l2) + 1e-6, hi = l1 + l2 - 1e-6;
  result.reached = dist <= hi && dist >= lo;
  const dc = clamp(dist, lo, hi);

  // Law of cosines: the angle at the top joint between the line to the target and the upper bone.
  const cosA = clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);

  // Bend direction: the pole's side of the line from top to target.
  let ex = px - ax, ey = py - ay, ez = pz - az;
  let dot = ex * dx + ey * dy + ez * dz;
  ex -= dx * dot; ey -= dy * dot; ez -= dz * dot;
  let en = Math.hypot(ex, ey, ez);
  if (en < 1e-6) {
    // The pole is on the line: keep the bend the pose already has.
    ex = bx - ax; ey = by - ay; ez = bz - az;
    dot = ex * dx + ey * dy + ez * dz;
    ex -= dx * dot; ey -= dy * dot; ez -= dz * dot;
    en = Math.hypot(ex, ey, ez);
    if (en < 1e-6) { ex = dy; ey = -dx; ez = 0; en = Math.hypot(ex, ey) || (ex = 1, 1); }
  }
  ex /= en; ey /= en; ez /= en;

  const nbx = ax + dx * l1 * cosA + ex * l1 * sinA;
  const nby = ay + dy * l1 * cosA + ey * l1 * sinA;
  const nbz = az + dz * l1 * cosA + ez * l1 * sinA;
  const ncx = ax + dx * dc, ncy = ay + dy * dc, ncz = az + dz * dc;

  // Upper bone: turn it from where the middle joint is to where it should be.
  let ux = bx - ax, uy = by - ay, uz = bz - az;
  let un = Math.hypot(ux, uy, uz);
  ux /= un; uy /= un; uz /= un;
  let wx = nbx - ax, wy = nby - ay, wz = nbz - az;
  let wn = Math.hypot(wx, wy, wz);
  wx /= wn; wy /= wn; wz /= wn;
  qFromTo(q2, 0, ux, uy, uz, wx, wy, wz);
  qMul(q1, 0, q2, 0, mq, a * 4);
  commit(sk, pose, mq, a);
  sk.fk(pose, mq, mp, a);

  // Lower bone: turn it from where the end is now to the target, about the middle joint.
  const mx = mp[b * 3]!, my = mp[b * 3 + 1]!, mz = mp[b * 3 + 2]!;
  ux = mp[c * 3]! - mx; uy = mp[c * 3 + 1]! - my; uz = mp[c * 3 + 2]! - mz;
  un = Math.hypot(ux, uy, uz);
  ux /= un; uy /= un; uz /= un;
  wx = ncx - mx; wy = ncy - my; wz = ncz - mz;
  wn = Math.hypot(wx, wy, wz) || 1;
  wx /= wn; wy /= wn; wz /= wn;
  qFromTo(q2, 0, ux, uy, uz, wx, wy, wz);
  qMul(q1, 0, q2, 0, mq, b * 4);
  commit(sk, pose, mq, b);
  sk.fk(pose, mq, mp, b);
  return result;
}

/**
 * Turns a chain of bones (base to tip, usually spine, chest, neck, head) so the tip's forward (-Z) faces the target,
 * within `yawMax` and `pitchMax` of the body's own forward (radians). Each bone takes its share `weights[j]` of the
 * remaining turn, so a head that cannot turn far alone is helped by the neck and chest. `strength` 0..1 fades it in.
 */
export function lookAt(
  sk: Skeleton, pose: Pose, mq: Arr, mp: Arr,
  chain: Int16Array, weights: Float64Array,
  tx: number, ty: number, tz: number,
  yawMax: number, pitchMax: number, strength: number,
): void {
  const n = chain.length;
  if (n === 0 || strength <= 0) return;
  const tip = chain[n - 1]!;
  const vx = tx - mp[tip * 3]!, vy = ty - mp[tip * 3 + 1]!, vz = tz - mp[tip * 3 + 2]!;
  if (Math.hypot(vx, vy, vz) < 1e-9) return;
  const yaw = clamp(Math.atan2(vx, -vz), -yawMax, yawMax);
  const pitch = clamp(Math.atan2(vy, Math.hypot(vx, vz)), -pitchMax, pitchMax);
  const cp = Math.cos(pitch);
  const dx = Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
  let remaining = 0;
  for (let j = 0; j < n; j++) remaining += weights[j]!;
  for (let j = 0; j < n; j++) {
    const w = weights[j]!;
    if (w <= 0 || remaining <= 1e-9) continue;
    const bone = chain[j]!;
    qRotate(mq, bone * 4, 0, 0, -1, v1, 0);
    qFromTo(q2, 0, v1[0]!, v1[1]!, v1[2]!, dx, dy, dz);
    qIdentity(q1, 0);
    qNlerp(q2, 0, q1, 0, q2, 0, Math.min(1, (w / remaining) * strength));
    qMul(q1, 0, q2, 0, mq, bone * 4);
    commit(sk, pose, mq, bone);
    sk.fk(pose, mq, mp, bone);
    remaining -= w;
  }
}
