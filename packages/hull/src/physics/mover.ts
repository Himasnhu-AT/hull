// Character mover: collide-and-slide with swept spheres. The character is an upright capsule, handled as a column
// of spheres half a radius apart (a single sphere when it is round). Every sweep is continuous, so nothing
// tunnels however fast it goes; a hit slides the rest of the move along the surface.
//
// A move runs in three parts: the horizontal part (slides along walls, climbs walkable slopes, steps up ledges),
// the vertical part (lands on walkable ground and stops there, slides down steep ground), then a ground probe
// that snaps a walker back onto the ground and says whether it is standing.
import { B, beginSweep } from './narrow.ts';
import type { Physics } from './world.ts';
import type { Contact, MoveOptions, MoveResult, QueryFilter, Vec3Like } from './types.ts';

const filter: { mask?: number; ignoreShape?: import('./shape.ts').Shape | null; ignoreNode?: import('../core/index.ts').Node | null } = {};

// Working state of the move in progress. A module-level record keeps the hot path free of allocations.
const M = {
  phys: null as unknown as Physics,
  out: null as unknown as MoveResult,
  x: 0, y: 0, z: 0,
  y0: 0, y1: 0, r: 0,
  skin: 0.01,
  cosSlope: 0.64,
  f: filter as QueryFilter,
  // Velocity with the parts into surfaces removed so far.
  cvx: 0, cvy: 0, cvz: 0,
  // Origin of the sample sphere that made the last best hit.
  hx: 0, hy: 0, hz: 0,
};

function sweep(dx: number, dy: number, dz: number, dist: number): boolean {
  const p = M.phys;
  beginSweep(dist);
  const span = M.y1 - M.y0;
  const n = span > 1e-9 ? Math.max(1, Math.ceil(span / (M.r * 0.5))) : 0;
  let hit = false;
  for (let i = 0; i <= n; i++) {
    const oy = M.y + M.y0 + (n === 0 ? 0 : span * i / n);
    const before = B.t, was = B.shape;
    p.cast(M.x, oy, M.z, dx, dy, dz, M.r, M.f);
    if (B.shape !== was || B.t !== before) { M.hx = M.x; M.hy = oy; M.hz = M.z; hit = true; }
  }
  return hit && B.shape !== null;
}

function contact(): Contact {
  const out = M.out;
  const idx = out.count < 8 ? out.count : 7;
  let c = out.contacts[idx];
  if (c === undefined) {
    c = { nx: 0, ny: 1, nz: 0, x: 0, y: 0, z: 0, speed: 0, shape: null, node: null, tag: '', walkable: false };
    out.contacts[idx] = c;
  }
  if (out.count < 8) out.count++;
  return c;
}

/** Records the contact in B and takes its normal's share out of the working velocity. */
function record(): void {
  const c = contact();
  const nx = B.nx, ny = B.ny, nz = B.nz;
  c.nx = nx; c.ny = ny; c.nz = nz;
  // The sweep origin is where the sphere started; the contact point is on the sphere at the moment of impact.
  c.x = M.hx + dirX * B.t - nx * M.r;
  c.y = M.hy + dirY * B.t - ny * M.r;
  c.z = M.hz + dirZ * B.t - nz * M.r;
  const vn = M.cvx * nx + M.cvy * ny + M.cvz * nz;
  c.speed = vn < 0 ? -vn : 0;
  if (c.speed > M.out.maxSpeed) M.out.maxSpeed = c.speed;
  if (ny >= M.cosSlope) {
    // Walkable ground only stops the fall: a walker keeps its horizontal speed up and down slopes.
    if (M.cvy < 0) M.cvy = 0;
  } else if (vn < 0) {
    M.cvx -= nx * vn; M.cvy -= ny * vn; M.cvz -= nz * vn;
  }
  c.shape = B.shape;
  c.node = B.shape ? B.shape.node : null;
  c.tag = B.shape ? B.shape.tag : '';
  c.walkable = ny >= M.cosSlope;
}
let dirX = 0, dirY = 0, dirZ = 0;

/** Raises, moves along `rx, rz`, and comes down. True when that ends on walkable ground higher than before. */
function stepUp(stepHeight: number, rx: number, rz: number): boolean {
  const sx = M.x, sy = M.y, sz = M.z;
  const skin = M.skin;
  let up = stepHeight;
  dirX = 0; dirY = 1; dirZ = 0;
  if (sweep(0, 1, 0, stepHeight + skin)) up = Math.max(0, B.t - skin);
  if (up < skin) return false;
  M.y = sy + up;
  const len = Math.sqrt(rx * rx + rz * rz);
  if (len < 1e-9) { M.y = sy; return false; }
  const dx = rx / len, dz = rz / len;
  dirX = dx; dirY = 0; dirZ = dz;
  // Go a little further than asked, so the capsule ends up over the ledge and not balanced on its edge.
  const want = Math.max(len, M.r * 0.5);
  let adv = want;
  if (sweep(dx, 0, dz, want + skin)) adv = Math.max(0, B.t - skin);
  if (adv <= skin) { M.y = sy; return false; }
  M.x = sx + dx * adv;
  M.z = sz + dz * adv;
  dirX = 0; dirY = -1; dirZ = 0;
  if (!sweep(0, -1, 0, up + skin * 2) || B.inside || B.ny < M.cosSlope) {
    M.x = sx; M.y = sy; M.z = sz;
    return false;
  }
  const down = Math.max(0, B.t - skin);
  const ny = sy + up - down;
  if (ny < sy + 0.02) {
    M.x = sx; M.y = sy; M.z = sz;
    return false;
  }
  M.y = ny;
  return true;
}

function slide(rx: number, ry: number, rz: number, vertical: boolean, stepHeight: number, canStep: boolean): void {
  const skin = M.skin;
  let px = 0, py = 0, pz = 0;
  let have = false;
  let stepped = false;
  for (let it = 0; it < 6; it++) {
    const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (len < 1e-9) return;
    const dx = rx / len, dy = ry / len, dz = rz / len;
    dirX = dx; dirY = dy; dirZ = dz;
    if (!sweep(dx, dy, dz, len + skin)) {
      M.x += rx; M.y += ry; M.z += rz;
      return;
    }
    const t = B.t;
    const nx = B.nx, ny = B.ny, nz = B.nz;
    if (B.inside) {
      // Started inside something (a platform moved into us, a teleport): push out along its normal and go on.
      const push = Math.min(B.depth + skin * 0.5, M.r);
      M.x += nx * push; M.y += ny * push; M.z += nz * push;
      record();
      continue;
    }
    const adv = Math.max(0, t - skin);
    M.x += dx * adv; M.y += dy * adv; M.z += dz * adv;
    record();
    const left = len - adv;
    if (left <= 1e-9) return;
    let qx = dx * left, qy = dy * left, qz = dz * left;
    const walkable = ny >= M.cosSlope;

    if (!vertical) {
      if (walkable) {
        // Keep the speed along the slope: project onto it, and put the length back.
        const d = qx * nx + qy * ny + qz * nz;
        let ex = qx - nx * d, ey = qy - ny * d, ez = qz - nz * d;
        const l2 = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (l2 > 1e-9) { const k = left / l2; ex *= k; ey *= k; ez *= k; }
        qx = ex; qy = ey; qz = ez;
      } else {
        if (canStep && !stepped && stepHeight > 0 && ny < 0.5 && stepUp(stepHeight, qx, qz)) {
          stepped = true;
          M.out.stepped = true;
          rx = 0; ry = 0; rz = 0;
          return;
        }
        // A wall: only its horizontal push matters, so a leaning wall never lifts or sinks the character.
        let hx = nx, hz = nz;
        const hl = Math.sqrt(hx * hx + hz * hz);
        if (hl > 1e-6) { hx /= hl; hz /= hl; const d = qx * hx + qz * hz; qx -= hx * d; qz -= hz * d; }
        else { const d = qx * nx + qy * ny + qz * nz; qx -= nx * d; qy -= ny * d; qz -= nz * d; }
        qy = 0;
      }
    } else {
      if (walkable && ry < 0) return; // landed: stop, do not slide down the slope
      const d = qx * nx + qy * ny + qz * nz;
      qx -= nx * d; qy -= ny * d; qz -= nz * d;
    }
    // Two surfaces at once: go along the crease between them.
    if (have && qx * px + qy * py + qz * pz < -1e-9) {
      let cx = ny * pz - nz * py, cy = nz * px - nx * pz, cz = nx * py - ny * px;
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (cl > 1e-6) {
        cx /= cl; cy /= cl; cz /= cl;
        const d = qx * cx + qy * cy + qz * cz;
        qx = cx * d; qy = cy * d; qz = cz * d;
        if (!vertical) qy = 0;
      } else { qx = 0; qy = 0; qz = 0; }
    }
    px = nx; py = ny; pz = nz; have = true;
    rx = qx; ry = qy; rz = qz;
  }
}

/**
 * Moves an upright capsule whose feet are at `pos` by `vel * dt`. `y0` and `y1` are the heights of the lowest and
 * highest sphere centres above `pos` (equal for a sphere), `r` the radius. Updates `pos`, fills `out`.
 * Pass the same `out` every call: `out.grounded` from the last move tells the next one whether a step up is allowed.
 */
export function slideMove(
  phys: Physics, pos: Vec3Like, y0: number, y1: number, r: number, vel: Vec3Like, dt: number,
  opts: MoveOptions | undefined, out: MoveResult,
): MoveResult {
  const wasGrounded = out.grounded;
  out.count = 0;
  out.maxSpeed = 0;
  out.stepped = false;
  out.grounded = false;
  out.groundShape = null;
  out.groundNx = 0; out.groundNy = 1; out.groundNz = 0;

  filter.mask = opts?.mask;
  filter.ignoreShape = opts?.ignoreShape ?? null;
  filter.ignoreNode = opts?.ignoreNode ?? null;
  M.phys = phys;
  M.out = out;
  M.x = pos.x; M.y = pos.y; M.z = pos.z;
  M.y0 = y0; M.y1 = y1; M.r = r;
  M.skin = opts?.skin ?? 0.01;
  M.cosSlope = Math.cos((opts?.slopeLimit ?? 50) * Math.PI / 180);
  M.cvx = vel.x; M.cvy = vel.y; M.cvz = vel.z;
  const stepHeight = opts?.stepHeight ?? 0;
  const snap = opts?.snap ?? 0.1;
  const sx = pos.x, sy = pos.y, sz = pos.z;

  slide(vel.x * dt, 0, vel.z * dt, false, stepHeight, wasGrounded);
  slide(0, vel.y * dt, 0, true, 0, false);

  // Ground probe: standing, and following the ground down.
  if (M.cvy <= 1e-6) {
    const reach = Math.max(snap, M.skin * 2.5);
    dirX = 0; dirY = -1; dirZ = 0;
    if (sweep(0, -1, 0, reach) && B.ny >= M.cosSlope) {
      out.grounded = true;
      out.groundNx = B.nx; out.groundNy = B.ny; out.groundNz = B.nz;
      out.groundShape = B.shape;
      if (M.cvy < 0 || out.count === 0) record();
      if (!B.inside && snap > 0) M.y -= Math.max(0, B.t - M.skin);
      if (M.cvy < 0) M.cvy = 0;
    }
  }

  pos.x = M.x; pos.y = M.y; pos.z = M.z;
  out.vx = M.cvx; out.vy = M.cvy; out.vz = M.cvz;
  out.moved = Math.sqrt((M.x - sx) ** 2 + (M.y - sy) ** 2 + (M.z - sz) ** 2);
  return out;
}
