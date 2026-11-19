// VARN: half-timbered houses on an irregular street grid, central plaza with chapel + bell tower, the Wallguard HQ
// with a supply depot on its roof. Everything is merged into a handful of meshes.
import * as THREE from 'hull/three';
import { Builder } from './geo';
import type { ColorLike } from './geo';
import { Rng } from './rng';
import type { WorldCtx } from './common';
import type { SurfaceMaterial } from '../types';
import { makeDepot } from './props';
import type { DepotBuilders } from './props';
import { R } from '../sim';

const V3 = THREE.Vector3, Q = THREE.Quaternion, M4 = THREE.Matrix4;
/** Plaster and stone dust (fx.steam's colours). */
const DUST = [new THREE.Color(0xd2c9ba), new THREE.Color(0xb5ac9c), new THREE.Color(0x8e877b)];

/**
 * Masonry in the air: a pool of tumbling blocks (plaster-pale stone and roof-dark ones) that a falling house throws
 * up. Each flies, bounces on the street, lies a few seconds and shrinks away. One instanced mesh.
 */
function makeChunks(ctx: WorldCtx): { burst(at: THREE.Vector3, spread: number, height: number): void; update(dt: number): void; clear(): void } {
  const N = 160, LIFE = 7;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), N);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3).fill(1), 3);
  mesh.castShadow = true; mesh.frustumCulled = false; mesh.visible = false;
  ctx.scene.add(mesh);
  interface Chunk { p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; ax: THREE.Vector3; w: number; s: THREE.Vector3; t: number; rest: boolean }
  const list: Chunk[] = [];
  for (let i = 0; i < N; i++) list.push({ p: new V3(), v: new V3(), q: new Q(), ax: new V3(1, 0, 0), w: 0, s: new V3(), t: LIFE, rest: true });
  const M = new M4(), dq = new Q(), sc = new V3(), ZERO = new V3(0, 0, 0), c = new THREE.Color();
  let next = 0, live = 0;
  for (let i = 0; i < N; i++) mesh.setMatrixAt(i, M.compose(ZERO, dq, ZERO));
  return {
    burst(at, spread, height) {
      for (let k = 0; k < 46; k++) {
        const i = next; next = (next + 1) % N;
        const ch = list[i];
        const a = R.fx() * 6.283, r = Math.sqrt(R.fx()) * spread;
        ch.p.set(at.x + Math.cos(a) * r, 0.5 + R.fx() * height, at.z + Math.sin(a) * r);
        ch.v.set(Math.cos(a) * (2 + R.fx() * 9), 2 + R.fx() * 9, Math.sin(a) * (2 + R.fx() * 9));
        ch.q.setFromAxisAngle(ch.ax.set(R.fx() - 0.5, R.fx() - 0.5, R.fx() - 0.5).normalize(), R.fx() * 6);
        ch.w = (R.fx() - 0.5) * 12;
        const roof = R.fx() < 0.3;
        ch.s.set(0.5 + R.fx() * 1.6, roof ? 0.12 + R.fx() * 0.15 : 0.4 + R.fx() * 1.1, 0.5 + R.fx() * 1.8);
        ch.t = 0; ch.rest = false;
        mesh.setColorAt(i, roof ? c.setRGB(0.45, 0.24, 0.18) : c.setRGB(0.8, 0.77, 0.7).multiplyScalar(0.75 + R.fx() * 0.3));
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.visible = true; live = LIFE;
    },
    update(dt) {
      if (live <= 0) { if (mesh.visible) mesh.visible = false; return; }
      live -= dt;
      for (let i = 0; i < N; i++) {
        const ch = list[i];
        if (ch.t >= LIFE) continue;
        ch.t += dt;
        if (!ch.rest) {
          ch.v.y -= 16 * dt;
          ch.p.addScaledVector(ch.v, dt);
          ch.q.premultiply(dq.setFromAxisAngle(ch.ax, ch.w * dt));
          const floor = Math.min(ch.s.x, ch.s.y, ch.s.z) * 0.5;
          if (ch.p.y < floor) {
            ch.p.y = floor;
            if (ch.v.y < -3) { ch.v.y *= -0.28; ch.v.x *= 0.55; ch.v.z *= 0.55; ch.w *= 0.5; }
            else { ch.rest = true; }
          }
        }
        const k = ch.t >= LIFE ? 0 : Math.min(1, (LIFE - ch.t) / 1.5);
        mesh.setMatrixAt(i, M.compose(ch.p, ch.q, sc.copy(ch.s).multiplyScalar(k)));
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    clear() { for (const ch of list) ch.t = LIFE; for (let i = 0; i < N; i++) mesh.setMatrixAt(i, M.compose(ZERO, dq, ZERO)); mesh.instanceMatrix.needsUpdate = true; mesh.visible = false; live = 0; },
  };
}
const UP = new V3(0, 1, 0), X_AXIS = new V3(1, 0, 0), Z_AXIS = new V3(0, 0, 1);
const STOREY = 3.8;

/** One ordinary house, as it can be brought down: where it stands, the stretch of each merged mesh that is its
 *  geometry (a = first float, b = one past the last), and its colliders. */
interface House {
  cx: number; cz: number; yaw: number; W: number; D: number; top: number;
  parts: { geo: THREE.BufferGeometry | null; B: Builder; a: number; b: number; keep: Float32Array | null }[];
  cols: unknown[]; down: boolean; floor: unknown;
}

export function buildTown(ctx: WorldCtx): void {
  const rng = new Rng(2002);
  const P0 = new Builder(), P1 = new Builder();           // plaster walls (two texture variants)
  const RC = new Builder(), RS = new Builder();           // clay roofs, slate roofs
  const HW = new Builder();                               // stone walls with windows (HQ, church, towers)
  const BR = new Builder();                               // brick chimneys (tinted stone)
  const PL = new Builder();                               // plain colour: doors, fountain, water, steps
  const WD = new Builder();                               // wood: stalls
  const PV = new Builder();                               // plaza paving
  const IR = new Builder();
  const depotB: DepotBuilders = { planks: new Builder(), iron: IR };
  // ---- houses that can come down (see house() and smash() below)
  const houses: House[] = [];
  const ALL = [P0, P1, RC, RS, HW, BR, PL, WD, PV, IR];
  let rec: unknown[] | null = null;
  {
    // while a house is being built, note the colliders it makes
    const col = ctx.col;
    for (const k of ['box', 'cyl', 'cap', 'sph'] as const) {
      const f = col[k] as (...a: unknown[]) => unknown;
      (col as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => { const c = f.apply(col, a); rec?.push(c); return c; };
    }
  }

  // limewash tints (multiplying an off-white plaster texture): whites, creams, a few faded ochres and greys
  const PLASTER = [0xffffff, 0xf6f2ea, 0xf2e6cc, 0xeadbc2, 0xe4e4e0, 0xf0e2c0, 0xe6d8c4, 0xfaf4ea, 0xe8d0bc];
  // roof tints: weathering, not colour
  const ROOFT = [0xffffff, 0xf2e8e2, 0xe6dad2, 0xd8ccc4, 0xc8bcb4, 0xf6e6da];
  const col = (c: ColorLike) => new THREE.Color(c as THREE.ColorRepresentation);

  // ---------------------------------------------------------------- street grid
  const xb = [-350, -310, -235, -160, -80, 0, 80, 160, 235, 310, 350];
  const xw = xb.map((x, i) => (i === 0 || i === xb.length - 1 ? 0 : x === 0 ? 14 : rng.range(10, 12.5)));
  for (let i = 1; i < xb.length - 1; i++) if (xb[i] !== 0) xb[i] += rng.range(-7, 7);
  const zb = [-14, -40, -105, -168, -245, -310, -375, -440];
  const zw = zb.map((z, i) => (i === 0 ? 0 : i === zb.length - 1 ? 0 : rng.range(10, 12.5)));
  for (let i = 2; i < zb.length - 1; i++) zb[i] += rng.range(-5, 5);
  ctx.town = { xb, zb };

  const PLAZA = { cx: 0, cz: -206 };
  const reserved = new Set<string>();   // "i,j" blocks handled by hand
  for (let i = 0; i < xb.length - 1; i++) for (let j = 0; j < zb.length - 1; j++) {
    const mx = (xb[i] + xb[i + 1]) / 2, mz = (zb[j] + zb[j + 1]) / 2;
    if (Math.abs(mx) < 90 && Math.abs(mz - PLAZA.cz) < 40) reserved.add(i + ',' + j);   // plaza row, centre columns
    if (Math.abs(mx + 40) < 45 && Math.abs(mz + 72) < 32) reserved.add(i + ',' + j);   // Wallguard HQ
  }

  // ---------------------------------------------------------------- helpers
  const tmpV = new V3(), tmpQ = new Q();
  /** wall face from A to B (xz, given in the builder's local frame), y0..y1; u snapped to whole tiles. */
  function wallFace(B: Builder, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, color: ColorLike, tileU: number, tileV: number, grad = [0.82, 1]) {
    const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / tileU));
    const c0 = col(color).multiplyScalar(grad[0]), c1 = col(color).multiplyScalar(grad[1]);
    B.quad([[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]], [[0, y0 / tileV], [n, y0 / tileV], [n, y1 / tileV], [0, y1 / tileV]], [c0, c0, c1, c1]);
    return n;
  }
  function wallBox(B: Builder, W: number, D: number, y0: number, y1: number, color: ColorLike, tileU: number, tileV: number, faces = 'ZzXx') {
    const hw = W / 2, hd = D / 2;
    if (faces.includes('Z')) wallFace(B, -hw, hd, hw, hd, y0, y1, color, tileU, tileV);
    if (faces.includes('z')) wallFace(B, hw, -hd, -hw, -hd, y0, y1, color, tileU, tileV);
    if (faces.includes('X')) wallFace(B, hw, hd, hw, -hd, y0, y1, color, tileU, tileV);
    if (faces.includes('x')) wallFace(B, -hw, -hd, -hw, hd, y0, y1, color, tileU, tileV);
  }
  interface Frame { M: THREE.Matrix4; q: THREE.Quaternion }
  const frame = (cx: number, cy: number, cz: number, yaw: number, extra = 0): Frame => {
    const M = new M4().makeRotationY(yaw + extra).setPosition(cx, cy, cz);
    const q = new Q().setFromAxisAngle(UP, yaw + extra);
    return { M, q };
  };
  const wpt = (F: Frame, x: number, y: number, z: number) => tmpV.set(x, y, z).applyMatrix4(F.M).clone();

  /**
   * Gable roof (ridge along frame-x) incl. gable triangles on the walls and slab / wedge colliders.
   * Wall builder Bw gets the triangles (tile sizes tu/tv must match the wall below).
   */
  function gableRoof(F: Frame, W: number, D: number, H: number, R: number, ov: number, Br: Builder, rcol: ColorLike, Bw: Builder, wcol: ColorLike, tu: number, tv: number, material: SurfaceMaterial = 'roof') {
    const Z = D / 2 + ov, X = W / 2 + ov, tanp = R / (D / 2), dy = R + ov * tanp, yE = H - ov * tanp, yR = H + R;
    const L = Math.hypot(Z, dy), c = col(rcol), c2 = c.clone().multiplyScalar(0.86);
    Br.setTransform(F.M);
    Br.quad([[-X, yE, Z], [X, yE, Z], [X, yR, 0], [-X, yR, 0]], [[-X / 3, 0], [X / 3, 0], [X / 3, L / 3], [-X / 3, L / 3]], [c2, c2, c, c]);
    Br.quad([[X, yE, -Z], [-X, yE, -Z], [-X, yR, 0], [X, yR, 0]], [[X / 3, 0], [-X / 3, 0], [-X / 3, L / 3], [X / 3, L / 3]], [c2, c2, c, c]);
    // ridge cap
    Br.setTransform(null);
    // gable triangles (plaster / stone)
    Bw.setTransform(F.M);
    const n = Math.max(1, Math.round(D / tu)), wc = col(wcol), wc2 = wc.clone().multiplyScalar(0.9);
    Bw.tri([W / 2, H, D / 2], [W / 2, H, -D / 2], [W / 2, yR, 0], [0, H / tv], [n, H / tv], [n / 2, yR / tv], wc2, wc2, wc);
    Bw.tri([-W / 2, H, -D / 2], [-W / 2, H, D / 2], [-W / 2, yR, 0], [0, H / tv], [n, H / tv], [n / 2, yR / tv], wc2, wc2, wc);
    Bw.setTransform(null);
    // colliders: two thin slabs (outer face flush with the visual roof) + stepped wedge under the ridge
    const p = Math.atan2(dy, Z), cp = Math.cos(p), sp = Math.sin(p), th = 0.15;
    for (const s of [1, -1]) {
      const ql = new Q().setFromAxisAngle(X_AXIS, s * p);
      const cl = new V3(0, (yE + yR) / 2 - th * cp, s * (Z / 2 - th * sp));
      const cw = cl.applyMatrix4(F.M), qw = F.q.clone().multiply(ql);
      ctx.col.box(cw.x, cw.y, cw.z, X, th, L / 2, material, qw);
    }
    if (R > 2.4) for (let k = 0; k < 2; k++) {
      const hy = R / 6, hz = (D / 2) * (1 - (k + 1) / 3);
      const cw = wpt(F, 0, H + R / 3 * k + R / 6, 0);
      ctx.col.box(cw.x, cw.y, cw.z, W / 2, hy, hz, 'roof', F.q);
    }
    return { yR };
  }

  function chimney(F: Frame, lx: number, lz: number, topY: number, baseY: number) {
    const s = 1.15, c = col(rng.pick([0xa88878, 0x9c8070, 0xb49888]));
    BR.setTransform(F.M);
    BR.box(lx, (baseY + topY) / 2, lz, s, topY - baseY, s, { color: c, uTile: 2, vTile: 2, vBase: baseY, faces: 'xXzZy', grad: [0.85, 1] });
    BR.box(lx, topY + 0.1, lz, s + 0.3, 0.25, s + 0.3, { color: 0x6a665e, uTile: 2, vTile: 2, faces: 'xXzZy' });
    BR.setTransform(null);
    const w = wpt(F, lx, (baseY + topY) / 2, lz);
    ctx.col.box(w.x, w.y, w.z, s / 2 + 0.1, (topY - baseY) / 2 + 0.1, s / 2 + 0.1, 'stone', F.q);
  }

  function door(F: Frame, W: number, D: number, color = 0x3a2c22) {
    const dx = rng.range(-W * 0.25, W * 0.25);
    PL.setTransform(F.M);
    PL.box(dx, 1.4, D / 2 + 0.05, 1.7, 2.8, 0.14, { color, faces: 'xXzZy' });
    PL.box(dx, 1.45, D / 2 + 0.02, 2.1, 3.0, 0.08, { color: 0x9e968a, faces: 'xXzZy' });
    PL.setTransform(null);
  }

  // ---------------------------------------------------------------- a normal house
  function house(cx: number, cz: number, yaw: number, W: number, D: number, n: number, opt: { wall?: number; roof?: number; gableFront?: boolean } = {}) {
    const from = ALL.map((B) => B.pos.length);
    rec = [];
    const top = houseBody(cx, cz, yaw, W, D, n, opt);
    houses.push({ cx, cz, yaw, W, D, top, parts: ALL.map((B, i) => ({ geo: null, B, a: from[i], b: B.pos.length, keep: null })).filter((p) => p.b > p.a), cols: rec, down: false, floor: null });
    rec = null;
    return top;
  }
  function houseBody(cx: number, cz: number, yaw: number, W: number, D: number, n: number, opt: { wall?: number; roof?: number; gableFront?: boolean } = {}) {
    const H = n * STOREY, F = frame(cx, 0, cz, yaw);
    const variant = rng.chance(0.5) ? 0 : 1, Bp = variant ? P1 : P0;
    const wcol = opt.wall ?? rng.pick(PLASTER), rcol = opt.roof ?? rng.pick(ROOFT);
    Bp.setTransform(F.M); wallBox(Bp, W, D, 0, H, wcol, 6, STOREY); Bp.setTransform(null);
    ctx.col.box(cx, H / 2, cz, W / 2, H / 2, D / 2, 'stone', F.q);
    const gableFront = opt.gableFront ?? rng.chance(0.4);
    let pitch = rng.range(36, 48) * Math.PI / 180;
    let Wr = W, Dr = D, FR = F;
    if (gableFront) { Wr = D; Dr = W; FR = frame(cx, 0, cz, yaw, Math.PI / 2); }
    let R = (Dr / 2) * Math.tan(pitch);
    if (R > 7) R = 7;
    if (R < 2.6) R = 2.6;
    gableRoof(FR, Wr, Dr, H, R, 0.7, RC, rcol, Bp, wcol, 6, STOREY);
    if (rng.chance(0.55)) chimney(FR, rng.range(-Wr * 0.32, Wr * 0.32), rng.chance(0.5) ? 0 : 0, H + R + 1.7, H + R - 1.1);
    door(F, W, D);
    return H + R;
  }

  // ---------------------------------------------------------------- fill blocks with rows of houses
  const nearPlaza = (x: number, z: number) => Math.hypot(x - PLAZA.cx, z - PLAZA.cz);
  function row(x0: number, x1: number, zEdge: number, dir: number, depth: number) {   // dir +1: row extends towards -z from zEdge (front faces +z); -1: towards +z (front faces -z)
    let x = x0 + rng.range(0, 1.5);
    const yaw = dir > 0 ? 0 : Math.PI;
    while (x < x1 - 8) {
      let w = rng.range(10, 20);
      if (x + w > x1 - 0.5 || x1 - (x + w) < 9) w = x1 - x - 0.3;
      if (w < 8) break;
      const d = depth + rng.range(-1.5, 1.5);
      const zc = dir > 0 ? zEdge - d / 2 : zEdge + d / 2, xc = x + w / 2;
      const dist = nearPlaza(xc, zc);
      const nmax = dist < 110 ? 4 : dist < 220 ? 4 : 3;
      let n = rng.int(2, nmax); if (dist < 120 && rng.chance(0.25)) n = Math.min(5, n + 1);
      house(xc, zc, yaw, w, d, n);
      x += w + (rng.chance(0.55) ? 0.5 : rng.range(2.5, 5));
    }
  }

  for (let i = 0; i < xb.length - 1; i++) for (let j = 0; j < zb.length - 1; j++) {
    if (reserved.has(i + ',' + j)) continue;
    const x0 = xb[i] + (i === 0 ? 6 : xw[i] / 2), x1 = xb[i + 1] - (i === xb.length - 2 ? 6 : xw[i + 1] / 2);
    const zN = zb[j] - (j === 0 ? 0 : zw[j] / 2), zS = zb[j + 1] + zw[j + 1] / 2;   // zN > zS
    if (zN - zS < 30) continue;
    if (j !== 0) row(x0, x1, zN, +1, rng.range(13, 18));       // north row, front faces the street at +z
    row(x0, x1, zS, -1, rng.range(13, 18));                     // south row, front faces -z
    // Interior of deep blocks gets a middle row of low houses facing a courtyard
    if (zN - zS > 62 && j > 0) row(x0 + 8, x1 - 8, (zN + zS) / 2 + 7, +1, 12);
  }

  // ---------------------------------------------------------------- Wallguard HQ
  const HQ = { cx: -40, cz: -69, W: 56, D: 34, H: 20 };
  {
    const { cx, cz, W, D, H } = HQ, F = frame(cx, 0, cz, 0);
    HW.setTransform(F.M); wallBox(HW, W, D, 0, H, 0xf2eee6, 6, 5); HW.setTransform(null);
    ctx.col.box(cx, H / 2, cz, W / 2, H / 2, D / 2, 'stone');
    // roof deck + parapet
    PV.setTransform(null);
    PV.quad([[cx - W / 2, H + 0.02, cz - D / 2], [cx - W / 2, H + 0.02, cz + D / 2], [cx + W / 2, H + 0.02, cz + D / 2], [cx + W / 2, H + 0.02, cz - D / 2]], [[0, 0], [0, D / 4], [W / 4, D / 4], [W / 4, 0]], col(0xd8d2c6));
    const pt = 0.9, ph = 1.3;
    const par = (px: number, pz: number, sx: number, sz: number) => { HW.box(px, H + ph / 2, pz, sx, ph, sz, { color: 0xf2eee6, uTile: 4, vTile: 4, vBase: H, faces: 'xXzZy', topTile: 2 }); ctx.col.box(px, H + ph / 2, pz, sx / 2, ph / 2, sz / 2, 'stone'); };
    par(cx, cz + D / 2 - pt / 2, W, pt); par(cx, cz - D / 2 + pt / 2, W, pt);
    par(cx - W / 2 + pt / 2, cz, pt, D - 2 * pt); par(cx + W / 2 - pt / 2, cz, pt, D - 2 * pt);
    // corner turrets
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const tx = cx + sx * (W / 2 - 1.2), tz = cz + sz * (D / 2 - 1.2), tr = 3.4;
      const pts = [0, 1].map((k) => new V3(tx, H + k * 8, tz)), pts2 = [new V3(tx, 0, tz), new V3(tx, H + 8, tz)];
      HW.tube([new V3(tx, 0, tz), new V3(tx, H + 4, tz), new V3(tx, H + 8, tz)], () => tr, { seg: 14, color: col(0xf2eee6), uTile: 6, vTile: 5 });
      ctx.col.cyl(tx, tz, 0, H + 8, tr, 'stone');
      // conical slate cap
      RS.tube([new V3(tx, H + 8, tz), new V3(tx, H + 10.5, tz), new V3(tx, H + 14, tz)], (i) => [tr + 0.8, tr * 0.6, 0.05][i], { seg: 14, color: col(0x9aa2ac), uTile: 3, vTile: 3 });
      ctx.col.cyl(tx, tz, H + 8, H + 10, tr * 0.75, 'roof'); ctx.col.cyl(tx, tz, H + 10, H + 12, tr * 0.38, 'roof');
      ctx.flag('wallguard', tx, H + 14, tz, { pole: true, h: 5, s: 1.0, yaw: 0 });
    }
    // central keep
    const kx = cx + 4, kz = cz - 6, kW = 20, kD = 14, kH = 31;
    const FK = frame(kx, 0, kz, 0);
    HW.setTransform(FK.M); wallBox(HW, kW, kD, H, kH, 0xf2eee6, 6, 5); HW.setTransform(null);
    ctx.col.box(kx, (H + kH) / 2, kz, kW / 2, (kH - H) / 2, kD / 2, 'stone');
    gableRoof(FK, kW, kD, kH, 5.5, 0.8, RS, 0xa8b0ba, HW, 0xf2eee6, 6, 5, 'roof');
    ctx.flag('wallguard', kx, kH + 5.5, kz, { pole: true, h: 6, s: 1.4 });
    // portal + steps
    PL.box(cx - 8, 2.4, cz + D / 2 + 0.1, 3.6, 4.8, 0.3, { color: 0x3a2c22, faces: 'xXzZy' });
    PL.box(cx - 8, 2.5, cz + D / 2 + 0.06, 4.6, 5.2, 0.2, { color: 0x9e968a, faces: 'xXzZy' });
    HW.box(cx - 8, 0.3, cz + D / 2 + 1.6, 9, 0.6, 3.2, { color: 0xe2dcd0, uTile: 4, vTile: 4, vBase: 0, faces: 'xXZy' });
    ctx.col.box(cx - 8, 0.3, cz + D / 2 + 1.6, 4.5, 0.3, 1.6, 'stone');
    makeDepot(ctx, depotB, cx - 15, H + 0.02, cz + 8, 0, { radius: 7.5, back: -3.0, flagH: 7 });
  }

  // ---------------------------------------------------------------- plaza: church, bell tower, fountain, stalls
  const plazaPave = { x0: -76, x1: 76, z0: -240, z1: -173 };
  PV.quad([[plazaPave.x0, 0.075, plazaPave.z1], [plazaPave.x1, 0.075, plazaPave.z1], [plazaPave.x1, 0.075, plazaPave.z0], [plazaPave.x0, 0.075, plazaPave.z0]],
    [[plazaPave.x0 / 4, -plazaPave.z1 / 4], [plazaPave.x1 / 4, -plazaPave.z1 / 4], [plazaPave.x1 / 4, -plazaPave.z0 / 4], [plazaPave.x0 / 4, -plazaPave.z0 / 4]], col(0xf4efe6));
  // Chapel nave (gable roof along z) + west tower with spire
  {
    const cx = -46, cz = -209, W = 24, D = 48, H = 17;
    const F = frame(cx, 0, cz, 0), FR = frame(cx, 0, cz, 0, Math.PI / 2);
    HW.setTransform(F.M); wallBox(HW, W, D, 0, H, 0xeee8dc, 6, 5.67); HW.setTransform(null);
    ctx.col.box(cx, H / 2, cz, W / 2, H / 2, D / 2, 'stone');
    gableRoof(FR, D, W, H, 9.5, 0.8, RS, 0xa0a8b2, HW, 0xeee8dc, 6, 5.67, 'roof');
    // buttress pillars along the nave (visual + collider)
    for (const sx of [-1, 1]) for (let k = 0; k < 5; k++) {
      const bz = cz - D / 2 + 5 + k * 9.5, bx = cx + sx * (W / 2 + 0.7);
      HW.box(bx, 6.5, bz, 1.4, 13, 1.2, { color: 0xe6e0d4, uTile: 4, vTile: 4, vBase: 0, faces: 'xXzZy' });
      ctx.col.box(bx, 6.5, bz, 0.7, 6.5, 0.6, 'stone');
    }
    // tower
    const tx = cx, tz = cz + D / 2 + 5, tW = 11, tH = 29;
    const FT = frame(tx, 0, tz, 0);
    HW.setTransform(FT.M); wallBox(HW, tW, tW, 0, tH, 0xeee8dc, 5.5, 5.8); HW.setTransform(null);
    ctx.col.box(tx, tH / 2, tz, tW / 2, tH / 2, tW / 2, 'stone');
    // belfry
    const bW = 9, bH = 4;
    HW.setTransform(FT.M); wallBox(HW, bW, bW, tH, tH + bH, 0xdcd4c6, 4.5, 4); HW.setTransform(null);
    ctx.col.box(tx, tH + bH / 2, tz, bW / 2, bH / 2, bW / 2, 'stone');
    for (const [dx, dz, ry] of [[0, bW / 2 + 0.05, 0], [0, -bW / 2 - 0.05, Math.PI], [bW / 2 + 0.05, 0, Math.PI / 2], [-bW / 2 - 0.05, 0, -Math.PI / 2]]) {
      PL.setTransform(new M4().makeRotationY(ry).setPosition(tx + dx, tH + 2, tz + dz));
      PL.box(0, 0, 0, 2.4, 2.8, 0.1, { color: 0x16181b, faces: 'Z' });
      PL.setTransform(null);
    }
    // spire: 4-sided pyramid (slate), stepped box colliders
    const sy0 = tH + bH, sH = 14, sB = 5.8;
    const c1 = col(0x949ca6), c2 = c1.clone().multiplyScalar(0.8), tip = [tx, sy0 + sH, tz];
    const cs = [[-sB, -sB], [sB, -sB], [sB, sB], [-sB, sB]];
    for (let k = 0; k < 4; k++) {
      const a = cs[k], b = cs[(k + 1) % 4], L = Math.hypot(sB * 2, sH);
      RS.tri([tx + a[0], sy0 - 0.2, tz + a[1]], [tx + b[0], sy0 - 0.2, tz + b[1]], tip, [0, 0], [sB * 2 / 3, 0], [sB / 3, L / 3], c2, c2, c1);
      // reverse for normals: ensure outward by using DoubleSide material
    }
    for (let k = 0; k < 4; k++) {
      const hw = sB * (1 - (k + 0.5) / 4);
      ctx.col.box(tx, sy0 + sH / 4 * k + sH / 8, tz, hw, sH / 8, hw, 'roof');
    }
    ctx.col.box(tx, sy0 + sH * 0.875 + 0.5, tz, 0.6, 1.2, 0.6, 'roof');
    // cross on top
    PL.box(tx, sy0 + sH + 1.4, tz, 0.3, 3.0, 0.3, { color: 0x8a7a58 }); PL.box(tx, sy0 + sH + 2.2, tz, 1.6, 0.3, 0.3, { color: 0x8a7a58 });
    ctx.col.cap(tx, sy0 + sH, tz, tx, sy0 + sH + 2.8, tz, 0.4, 'metal');
    // front door of the chapel (at tower)
    PL.box(tx, 2.2, tz + tW / 2 + 0.06, 3.0, 4.4, 0.14, { color: 0x3a2c22, faces: 'xXzZy' });
    PL.box(tx, 2.4, tz + tW / 2 + 0.03, 3.8, 4.8, 0.08, { color: 0x9e968a, faces: 'xXzZy' });
  }
  // Bell tower on the east side of the plaza
  {
    const tx = 48, tz = -205, tW = 10, tH = 22, bW = 8.4, bH = 5.5;
    const FT = frame(tx, 0, tz, 0);
    HW.setTransform(FT.M); wallBox(HW, tW, tW, 0, tH, 0xece4d6, 5, 5.5); HW.setTransform(null);
    ctx.col.box(tx, tH / 2, tz, tW / 2, tH / 2, tW / 2, 'stone');
    // open belfry: four corner pillars + dark interior block + bell
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      HW.box(tx + sx * (bW / 2 - 0.5), tH + bH / 2, tz + sz * (bW / 2 - 0.5), 1.0, bH, 1.0, { color: 0xdad2c2, uTile: 2, vTile: 2, vBase: tH, faces: 'xXzZy' });
      ctx.col.box(tx + sx * (bW / 2 - 0.5), tH + bH / 2, tz + sz * (bW / 2 - 0.5), 0.5, bH / 2, 0.5, 'stone');
    }
    PL.box(tx, tH + bH / 2, tz, bW - 1.6, bH - 0.4, bW - 1.6, { color: 0x14161a });
    PL.box(tx, tH + 2.4, tz, 1.8, 1.8, 1.8, { color: 0x7a6440 });
    HW.box(tx, tH + bH + 0.4, tz, bW + 1.2, 0.8, bW + 1.2, { color: 0xdad2c2, uTile: 4, vTile: 4, vBase: 0, faces: 'xXzZy', topTile: 4 });
    ctx.col.box(tx, tH + bH + 0.4, tz, (bW + 1.2) / 2, 0.4, (bW + 1.2) / 2, 'stone');
    // hip roof: pyramid, stepped colliders
    const sy0 = tH + bH + 0.8, sH = 9, sB = 5.8, tip = [tx, sy0 + sH, tz];
    const c1 = col(0xc8a090), c2 = c1.clone().multiplyScalar(0.8), cs = [[-sB, -sB], [sB, -sB], [sB, sB], [-sB, sB]];
    for (let k = 0; k < 4; k++) { const a = cs[k], b = cs[(k + 1) % 4], L = Math.hypot(sB * 2, sH); RC.tri([tx + a[0], sy0, tz + a[1]], [tx + b[0], sy0, tz + b[1]], tip, [0, 0], [sB * 2 / 3, 0], [sB / 3, L / 3], c2, c2, c1); }
    for (let k = 0; k < 3; k++) { const hw = sB * (1 - (k + 0.5) / 3); ctx.col.box(tx, sy0 + sH / 3 * k + sH / 6, tz, hw, sH / 6, hw, 'roof'); }
    PL.box(tx, sy0 + sH + 1, tz, 0.25, 2.2, 0.25, { color: 0x8a7a58 });
    ctx.col.cap(tx, sy0 + sH, tz, tx, sy0 + sH + 2.2, tz, 0.3, 'metal');
  }
  // Fountain at the plaza centre
  {
    const fx = 0, fz = -206 + 4;
    const pts = [0, 0.35, 0.7, 1.0].map((y) => new V3(fx, y, fz));
    PL.tube([new V3(fx, 0, fz), new V3(fx, 0.5, fz), new V3(fx, 1.0, fz), new V3(fx, 1.0, fz)], (i) => [6.4, 6.4, 6.0, 0.01][i], { seg: 20, color: col(0xa8a296), uTile: 4, vTile: 4 });
    PL.quad([[fx - 5.6, 0.92, fz + 5.6], [fx + 5.6, 0.92, fz + 5.6], [fx + 5.6, 0.92, fz - 5.6], [fx - 5.6, 0.92, fz - 5.6]], [[0, 0], [1, 0], [1, 1], [0, 1]], col(0x2c3a3e));
    PL.tube([new V3(fx, 0.9, fz), new V3(fx, 2.5, fz), new V3(fx, 4.8, fz)], (i) => [1.1, 0.7, 0.5][i], { seg: 12, color: col(0xa8a296), uTile: 3, vTile: 3 });
    PL.tube([new V3(fx, 4.4, fz), new V3(fx, 5.0, fz), new V3(fx, 5.7, fz), new V3(fx, 5.9, fz)], (i) => [0.2, 1.8, 1.4, 0.01][i], { seg: 14, color: col(0x9c968a), uTile: 3, vTile: 3 });
    ctx.col.cyl(fx, fz, 0, 1.0, 6.2, 'stone');
    ctx.col.cyl(fx, fz, 1.0, 5.0, 0.7, 'stone');
    ctx.col.cyl(fx, fz, 4.8, 5.9, 1.4, 'stone');
  }
  // Market stalls
  for (let k = 0; k < 8; k++) {
    const sx = (k % 4 - 1.5) * 24 + rng.range(-3, 3), sz = -190 + Math.floor(k / 4) * -34 - 6 + rng.range(-3, 3);
    if (Math.abs(sx - 0) < 11 || Math.abs(sx + 46) < 17 || Math.abs(sx - 48) < 10) continue;
    const yaw = rng.range(-0.3, 0.3), M = new M4().makeRotationY(yaw).setPosition(sx, 0, sz);
    WD.setTransform(M);
    WD.box(0, 0.55, 0, 3.2, 1.1, 1.5, { color: 0xd0bca4, uTile: 1.2, vTile: 1.2, vBase: 0, faces: 'xXzZy' });
    for (const [px, pz] of [[-1.5, -0.7], [1.5, -0.7], [-1.5, 0.7], [1.5, 0.7]]) WD.box(px, 1.5, pz, 0.14, 3.0, 0.14, { color: 0xa8957c, uTile: 1, vTile: 1, faces: 'xXzZy' });
    WD.box(0, 3.05, 0, 3.8, 0.12, 2.0, { color: rng.pick([0xd9472f, 0xe8b13c, 0x3d78b8, 0xeee8dc]), uTile: 1, vTile: 1, faces: 'xXzZyY' });
    WD.setTransform(null);
    ctx.col.box(sx, 0.55, sz, 1.6, 0.55, 0.75, 'wood', new Q().setFromAxisAngle(UP, yaw));
    for (const [px, pz] of [[-1.5, -0.7], [1.5, -0.7], [-1.5, 0.7], [1.5, 0.7]]) { const wv = new V3(px, 0, pz).applyMatrix4(M); ctx.col.cyl(wv.x, wv.z, 0, 3.1, 0.12, 'wood'); }
    ctx.col.box(sx, 3.05, sz, 1.9, 0.06, 1.0, 'wood', new Q().setFromAxisAngle(UP, yaw));
  }

  // ---------------------------------------------------------------- meshes
  const mk = (B: Builder, mat: THREE.Material, name: string) => {
    if (!B.pos.length) return null;
    const m = new THREE.Mesh(B.toGeometry(), mat); m.name = name; ctx.add(m, true, true);
    for (const h of houses) for (const p of h.parts) if (p.B === B) p.geo = m.geometry;
    return m;
  };
  mk(P0, ctx.mat.plaster0, 'townWalls0'); mk(P1, ctx.mat.plaster1, 'townWalls1');
  mk(HW, ctx.mat.hqwall, 'townStone');
  mk(RC, ctx.mat.clay, 'townRoofsClay'); mk(RS, ctx.mat.slate, 'townRoofsSlate');
  mk(BR, ctx.mat.hq, 'townChimneys'); mk(PL, ctx.mat.plain, 'townDetail');
  mk(WD, ctx.mat.planks, 'townWood'); mk(PV, ctx.mat.paving, 'townPaving');
  mk(depotB.planks, ctx.mat.planks, 'townDepotWood'); mk(IR, ctx.mat.plain, 'townIron');

  // ---------------------------------------------------------------- houses come down
  // A titan falling on a house, or a big one that will not go round it, brings it down: its walls and roof drop
  // into a low heap of rubble where it stood (its own geometry, flattened and jumbled), its colliders go, and a
  // burst of masonry and dust goes up. The street grid, the chapel, the towers and the Wallguard HQ stand.
  const world = ctx.game.collision as unknown as { remove(c: unknown): void; _register(c: unknown): unknown; addBox(o: { center: THREE.Vector3; halfExtents: THREE.Vector3; quaternion?: THREE.Quaternion; material: string; hookable?: boolean }): unknown };
  const chunks = makeChunks(ctx);
  ctx.updaters.push((dt) => chunks.update(dt));
  const hash = (x: number, y: number, z: number): number => { const v = Math.sin(x * 12.9898 + y * 37.719 + z * 78.233) * 43758.5453; return v - Math.floor(v); };
  const bringDown = (h: House): void => {
    h.down = true;
    for (const p of h.parts) {
      const at = p.geo?.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!at) continue;
      const arr = at.array as Float32Array;
      p.keep = arr.slice(p.a, p.b);
      for (let i = p.a; i < p.b; i += 3) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2], r1 = hash(x, y, z), r2 = hash(z, x, y);
        arr[i] = x + (r1 - 0.5) * 2.2; arr[i + 2] = z + (r2 - 0.5) * 2.2;
        arr[i + 1] = 0.06 + (y / h.top) * (0.35 + 1.1 * r1);
      }
      at.needsUpdate = true;
    }
    for (const c of h.cols) { world.remove(c); (c as { removed?: boolean }).removed = true; }
    // (the heap is something to stand on, low enough that a titan walks over it)
    h.floor = world.addBox({ center: new V3(h.cx, 0.22, h.cz), halfExtents: new V3(h.W / 2, 0.22, h.D / 2), quaternion: new Q().setFromAxisAngle(UP, h.yaw), material: 'stone', hookable: false });
    const g = ctx.game, at = new V3(h.cx, 0, h.cz);
    chunks.burst(at, Math.max(h.W, h.D) * 0.5, h.top);
    for (let i = 0; i < 9; i++) g.fx?.steam?.(new V3(h.cx + (R.fx() - 0.5) * h.W, 1 + R.fx() * h.top * 0.7, h.cz + (R.fx() - 0.5) * h.D), 7 + R.fx() * 7, 3.5 + R.fx() * 2.5, DUST);
    g.audio?.titanFall?.(at, 18); g.audio?.impact?.(0.8);
    g.events.emit('titan:step', { position: at.clone(), size: 26 });
    g.events.emit('house:down', { position: at.clone() });
  };
  /** Bring down every standing house within `radius` of `at` (x, z). Returns how many came down. */
  ctx.smash = (at, radius) => {
    let n = 0;
    for (const h of houses) {
      if (h.down) continue;
      const dx = at.x - h.cx, dz = at.z - h.cz;
      if (Math.abs(dx) > 40 || Math.abs(dz) > 40) continue;
      const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) < h.W / 2 + radius && Math.abs(lz) < h.D / 2 + radius) { bringDown(h); n++; }
    }
    return n;
  };
  /** Stand every house up again (a new run). */
  ctx.rebuild = () => {
    for (const h of houses) {
      if (!h.down) continue;
      h.down = false;
      for (const p of h.parts) {
        const at = p.geo?.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (at && p.keep) { (at.array as Float32Array).set(p.keep, p.a); at.needsUpdate = true; }
        p.keep = null;
      }
      for (const c of h.cols) { (c as { removed?: boolean }).removed = false; world._register(c); }
      if (h.floor) { world.remove(h.floor); h.floor = null; }
    }
    chunks.clear();
  };

  // titan spawn zones inside the gate (street intersections)
  const sx = [xb[5], xb[4], xb[6], xb[3], xb[7]], sz = [zb[1], zb[2], zb[3]];
  ctx.titanSpawns.push({ center: new V3(0, 0, -30), radius: 10, area: 'town' });
  for (const z of sz) for (const x of [sx[0], sx[1], sx[2]]) ctx.titanSpawns.push({ center: new V3(x, 0, z), radius: 7, area: 'town' });
  ctx.titanSpawns.push({ center: new V3(sx[3], 0, zb[1]), radius: 7, area: 'town' }, { center: new V3(sx[4], 0, zb[2]), radius: 7, area: 'town' });
}
