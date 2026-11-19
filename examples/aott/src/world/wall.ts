// THE ASHWALL: 50 m tall, 12 m thick cut-stone wall with a breached gate, parapet, buttresses, cannons, Wallguard flags.
import * as THREE from 'hull/three';
import { Builder } from './geo';
import type { P3 } from './geo';
import { Rng, smoothstep, clamp } from './rng';
import { noise2 } from './common';
import type { WorldCtx } from './common';
import { addRock, makeDepot } from './props';
import { R } from '../sim';

const V3 = THREE.Vector3;
const HALF = 1200, TOP = 50, THICK = 6, GATE_W = 8, GATE_H = 20;

/**
 * The gate bursting: a few dozen chunks (stone blocks, door planks) that fly inward from the doorway, tumble,
 * bounce on the street and lie a while before they sink away. Two instanced meshes, so it costs two draw calls.
 */
function makeBurst(ctx: WorldCtx): { fire(): void; update(dt: number): void } {
  const N = [30, 26];
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(0.82), 3));
  const meshes = [new THREE.InstancedMesh(geo, ctx.mat.stone, N[0]), new THREE.InstancedMesh(geo, ctx.mat.planks, N[1])];
  interface Chunk { p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; ax: THREE.Vector3; w: number; s: THREE.Vector3; rest: boolean }
  const chunks: Chunk[][] = [[], []];
  for (const m of meshes) { m.visible = false; m.castShadow = true; m.frustumCulled = false; ctx.scene.add(m); }
  const M = new THREE.Matrix4(), dq = new THREE.Quaternion(), sc = new THREE.Vector3();
  let t = -1;
  const LIFE = 16, SINK = 3;
  return {
    fire() {
      t = 0;
      for (let k = 0; k < 2; k++) {
        chunks[k].length = 0;
        for (let i = 0; i < N[k]; i++) {
          const wood = k === 1;
          const s = wood ? new THREE.Vector3(0.4 + R.fx() * 0.9, 0.18 + R.fx() * 0.25, 1.4 + R.fx() * 3.6) : new THREE.Vector3(1, 0.7 + R.fx() * 0.4, 1).multiplyScalar(0.6 + R.fx() * 1.7);
          chunks[k].push({
            p: new THREE.Vector3((R.fx() * 2 - 1) * (GATE_W - 1), 0.6 + R.fx() * (GATE_H - 2), THICK - 1.5 - R.fx() * 2),
            v: new THREE.Vector3((R.fx() - 0.5) * 16, 1 + R.fx() * 11, -(12 + R.fx() * 24)),
            q: new THREE.Quaternion().setFromEuler(new THREE.Euler(R.fx() * 6, R.fx() * 6, R.fx() * 6)),
            ax: new THREE.Vector3(R.fx() - 0.5, R.fx() - 0.5, R.fx() - 0.5).normalize(), w: (R.fx() - 0.5) * 14, s, rest: false,
          });
        }
        meshes[k].visible = true;
      }
    },
    update(dt) {
      if (t < 0) return;
      t += dt;
      if (t > LIFE) { t = -1; for (const m of meshes) m.visible = false; return; }
      const fade = t > LIFE - SINK ? (LIFE - t) / SINK : 1;
      for (let k = 0; k < 2; k++) {
        const list = chunks[k], mesh = meshes[k];
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (!c.rest) {
            c.v.y -= 16 * dt;
            c.p.addScaledVector(c.v, dt);
            c.q.premultiply(dq.setFromAxisAngle(c.ax, c.w * dt));
            // the tunnel walls while it is still inside, then the street
            if (c.p.z > -THICK && Math.abs(c.p.x) > GATE_W - 0.6) { c.p.x = Math.sign(c.p.x) * (GATE_W - 0.6); c.v.x *= -0.4; }
            const floor = Math.min(c.s.x, c.s.y, c.s.z) * 0.5;
            if (c.p.y < floor) {
              c.p.y = floor;
              if (c.v.y < -3) { c.v.y *= -0.3; c.v.x *= 0.6; c.v.z *= 0.6; c.w *= 0.5; }
              else { c.v.y = 0; c.v.x *= 1 - Math.min(1, 4 * dt); c.v.z *= 1 - Math.min(1, 4 * dt); c.w *= 1 - Math.min(1, 5 * dt); if (c.v.lengthSq() < 0.3) c.rest = true; }
            }
          }
          M.compose(c.p, c.q, sc.copy(c.s).multiplyScalar(fade));
          mesh.setMatrixAt(i, M);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}

export function buildWall(ctx: WorldCtx): { stoneMesh: THREE.Mesh } {
  const rng = new Rng(1001);
  const S = new Builder(), PV = new Builder(), WD = new Builder(), IR = new Builder(), RB = new Builder();
  // the gate comes in two states: shut (the doors: DW wood, DI iron) and breached (the wreck: GW, GI, and the rubble RB)
  const DW = new Builder(), DI = new Builder(), GW = new Builder(), GI = new Builder(), GS = new Builder();
  const wreckCols: unknown[] = [], doorCols: unknown[] = [];
  const tc = new THREE.Color();

  // ---- faces ----
  const wallColor = (_u: number, _v: number, x: number, y: number) => {
    const grime = smoothstep(0, 10, y);
    let l = 0.74 + 0.26 * grime;
    l *= 1 + noise2(x * 0.035, y * 0.12) * 0.07 + noise2(x * 0.25, y * 0.015) * 0.06;
    l *= 1 + smoothstep(42, 50, y) * 0.07;
    tc.setRGB(l, l, l);
    const moss = (1 - grime) * clamp(0.5 + noise2(x * 0.09, 3.3) * 0.8, 0, 1);
    tc.r *= 1 - moss * 0.2; tc.b *= 1 - moss * 0.3; tc.g *= 1 - moss * 0.04;
    return tc;
  };
  const UVS = (p: P3) => [p[0] / 12, p[1] / 6];
  const UVZ = (p: P3) => [p[2] / 12, p[1] / 6];
  const nx = (len: number) => Math.max(1, Math.ceil(len / 20));
  const face = (x0: number, x1: number, front: boolean) => {   // long faces
    const len = x1 - x0;
    if (front) S.patch(new V3(x0, 0, THICK), new V3(len, 0, 0), new V3(0, TOP, 0), nx(len), 10, UVS, wallColor);
    else S.patch(new V3(x1, 0, -THICK), new V3(-len, 0, 0), new V3(0, TOP, 0), nx(len), 10, UVS, wallColor);
  };
  face(-HALF, -GATE_W, true); face(GATE_W, HALF, true); face(-HALF, -GATE_W, false); face(GATE_W, HALF, false);
  // lintel faces above the opening
  S.patch(new V3(-GATE_W, GATE_H, THICK), new V3(16, 0, 0), new V3(0, TOP - GATE_H, 0), 2, 6, UVS, wallColor);
  S.patch(new V3(GATE_W, GATE_H, -THICK), new V3(-16, 0, 0), new V3(0, TOP - GATE_H, 0), 2, 6, UVS, wallColor);
  // end caps
  S.patch(new V3(-HALF, 0, -THICK), new V3(0, 0, 12), new V3(0, TOP, 0), 2, 8, UVZ, wallColor);
  S.patch(new V3(HALF, 0, THICK), new V3(0, 0, -12), new V3(0, TOP, 0), 2, 8, UVZ, wallColor);
  // tunnel walls and ceiling
  const tunnelC = (_u: number, _v: number, _x: number, y: number) => { const l = 0.62 + 0.3 * smoothstep(0, 18, y); tc.setRGB(l, l * 0.98, l * 0.94); return tc; };
  S.patch(new V3(-GATE_W, 0, THICK), new V3(0, 0, -12), new V3(0, GATE_H, 0), 4, 6, UVZ, tunnelC);
  S.patch(new V3(GATE_W, 0, -THICK), new V3(0, 0, 12), new V3(0, GATE_H, 0), 4, 6, UVZ, tunnelC);
  S.patch(new V3(-GATE_W, GATE_H, -THICK), new V3(16, 0, 0), new V3(0, 0, 12), 4, 4, (p: P3) => [p[0] / 8, p[2] / 4], () => tc.setRGB(0.55, 0.54, 0.52));
  // walkway paving
  PV.patch(new V3(-HALF, TOP, -THICK), new V3(0, 0, 12), new V3(2 * HALF, 0, 0), 6, 120, (p: P3) => [p[0] / 4, p[2] / 4], (_u: number, _v: number, x: number, _y: number, z: number) => { const l = (0.92 + noise2(x * 0.05, z * 0.3) * 0.06) * (z > 4.6 ? 0.82 : 1) * (z < -5 ? 0.9 : 1); return tc.setRGB(l, l, l); });

  // ---- parapet (outer edge, +z) ----
  S.box(0, TOP + 0.65, 5.55, 2 * HALF, 1.3, 0.9, { uTile: 12, vTile: 6, vBase: 0, faces: 'Zzy', topTile: 4 });
  ctx.col.box(0, TOP + 0.65, 5.55, HALF, 0.65, 0.45, 'stone');

  // ---- solid wall bodies: left part, right part, lintel above the gate (top surface exactly y = 50) ----
  ctx.col.box(-(HALF + GATE_W) / 2, TOP / 2, 0, (HALF - GATE_W) / 2, TOP / 2, THICK, 'stone');
  ctx.col.box((HALF + GATE_W) / 2, TOP / 2, 0, (HALF - GATE_W) / 2, TOP / 2, THICK, 'stone');
  ctx.col.box(0, (GATE_H + TOP) / 2, 0, GATE_W, (TOP - GATE_H) / 2, THICK, 'stone');

  // ---- buttresses (both faces, away from the gate) ----
  for (let k = 0; k < 17; k++) for (const sx of [-1, 1]) {
    const bx = sx * (70 + k * 68 + rng.range(-3, 3));
    for (const side of [-1, 1]) {
      const bz = side * (THICK + 1.4);
      const bw = 5, bh = 46, bd = 2.8;
      S.box(bx, bh / 2, bz, bw, bh, bd, { uTile: 12, vTile: 6, vBase: 0, grad: [0.78, 1], faces: side > 0 ? 'xXZy' : 'xXzy' });
      ctx.col.box(bx, bh / 2, bz, bw / 2, bh / 2, bd / 2, 'stone');
    }
  }

  // ---- cannons on the walkway near the gate ----
  const cannonXs = [20, 60, 100, 140, 180, 225].flatMap((x) => [-x, x]);
  for (const cx of cannonXs) {
    const lx = cx + rng.range(-1.5, 1.5);
    WD.box(lx, TOP + 0.55, 3.3, 1.6, 1.1, 3.0, { color: 0xc4b29a, uTile: 1.5, vTile: 1.5, vBase: TOP, grad: [0.75, 1] });
    ctx.col.box(lx, TOP + 0.55, 3.3, 0.8, 0.55, 1.5, 'wood');
    for (const sx of [-1, 1]) {
      WD.tube([new V3(lx + sx * 0.76, TOP + 0.6, 2.55), new V3(lx + sx * 0.82, TOP + 0.6, 2.55), new V3(lx + sx * 0.95, TOP + 0.6, 2.55), new V3(lx + sx * 1.05, TOP + 0.6, 2.55)], (i) => [0.01, 0.62, 0.62, 0.01][i], { seg: 12, color: new THREE.Color(0x9c8a74), uTile: 2, vTile: 2 });
    }
    const z0 = 1.8, z1 = 6.9, ys = TOP + 1.95;
    const zs = [z0, z0 + 0.12, z0 + 0.5, z0 + 1.6, z0 + 3.4, z1 - 0.5, z1 - 0.15, z1 - 0.02, z1];
    const rr = [0.01, 0.34, 0.4, 0.38, 0.33, 0.3, 0.38, 0.38, 0.01];
    IR.tube(zs.map((z) => new V3(lx, ys, z)), (i) => rr[i], { seg: 12, colFn: (i) => new THREE.Color(i === 6 || i === 7 ? 0x4a4844 : 0x2c2b29), uTile: 4, vTile: 4 });
    ctx.col.cap(lx, ys, z0 + 0.3, lx, ys, z1 - 0.1, 0.34, 'metal');
  }

  // ---- gate: broken door leaves and rubble ----
  const leaf = (px: number, py: number, pz: number, sx: number, sy: number, sz: number, rotAxis: THREE.Vector3, ang: number, color: number) => {
    const m = new THREE.Matrix4().compose(new V3(px, py, pz), new THREE.Quaternion().setFromAxisAngle(rotAxis, ang), new V3(1, 1, 1));
    GW.setTransform(m);
    GW.box(0, 0, 0, sx, sy, sz, { color, uTile: 1.4, vTile: 1.4, vBase: -sy / 2, grad: [0.8, 1], faces: 'xXzZyY' });
    // iron straps
    for (const yy of [-sy * 0.3, sy * 0.3]) GI.setTransform(m), GI.box(0, yy, 0, sx + 0.06, 0.45, sz + 0.12, { color: 0x2c2b29, faces: 'xXzZy' });
    GW.setTransform(null); GI.setTransform(null);
    const q = new THREE.Quaternion().setFromAxisAngle(rotAxis, ang);
    wreckCols.push(ctx.col.box(px, py, pz, sx / 2, sy / 2, sz / 2, 'wood', q));
  };
  // The gate was kicked in from outside: everything went inward.
  // (a splinter of the left leaf still leaning on its jamb)
  leaf(-7.2, 5.6, 4.3, 0.55, 11, 1.7, new V3(0, 0, 1), -0.16, 0xa8947c);
  const rot = new THREE.Quaternion(), eul = new THREE.Euler();
  /** A piece of the wreck: a box at any angle, in wood (with its iron straps) or in wall stone. Visual only. */
  const piece = (kind: 'wood' | 'stone', px: number, py: number, pz: number, sx: number, sy: number, sz: number, rx: number, ry: number, rz: number, shade = 1): void => {
    rot.setFromEuler(eul.set(rx, ry, rz));
    const m = new THREE.Matrix4().compose(new V3(px, py, pz), rot, new V3(1, 1, 1));
    if (kind === 'wood') {
      GW.setTransform(m);
      GW.box(0, 0, 0, sx, sy, sz, { color: new THREE.Color(0xa8947c).multiplyScalar(shade), uTile: 1.4, vTile: 1.4, vBase: -sy / 2, grad: [0.78, 1], faces: 'xXzZyY' });
      GW.setTransform(null);
    } else {
      GS.setTransform(m);
      GS.box(0, 0, 0, sx, sy, sz, { color: new THREE.Color(0xdcd6cc).multiplyScalar(shade), uTile: 6, vTile: 6, vBase: -sy / 2, grad: [0.8, 1], faces: 'xXzZyY' });
      GS.setTransform(null);
    }
  };
  // the lower half of the left leaf, torn half off its hinges and folded back into the tunnel, its top edge splintered
  {
    const hx = -GATE_W + 0.5, hz = THICK - 1.4, ang = 1.12, c = Math.cos(ang), sn = Math.sin(ang);
    const at = (u: number): [number, number] => [hx + c * u, hz - sn * u];           // u metres out along the leaf from the hinge
    const [mx, mz] = at(3.5);
    piece('wood', mx, 4.4, mz, 7, 8.8, 0.9, 0.05, ang, -0.07);
    for (let i = 0; i < 7; i++) { const [sx2, sz2] = at(0.5 + i); const hgt = rng.range(1.2, 4.6) * (i < 2 ? 1.5 : 1); piece('wood', sx2, 8.6 + hgt / 2, sz2, 0.92, hgt, 0.86, 0.05, ang, -0.07 + rng.range(-0.08, 0.08), rng.range(0.82, 1.02)); }
    wreckCols.push(ctx.col.box(mx, 4.4, mz, 3.5, 4.4, 0.6, 'wood', new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), ang)));
    // a strap of the same leaf hanging from the top hinge
    piece('wood', hx + 1.2, 16.6, hz - 0.5, 2.6, 4.4, 0.9, 0.12, 0.5, 0.28, 0.9);
  }
  // the right leaf came off whole: it lies broken in two in the street inside, half on top of the rubble
  piece('wood', 3.6, 0.85, -15.5, 7.4, 0.9, 10.5, 0.1, 0.42, 0.05);
  piece('wood', -1.4, 0.6, -24, 6.6, 0.9, 7.2, -0.06, -0.3, 0.09, 0.93);
  wreckCols.push(ctx.col.box(3.6, 0.6, -15.5, 3.7, 0.55, 5.2, 'wood', new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), 0.42)));
  // shattered planks and the bar, thrown down the tunnel and out into the street
  for (let i = 0; i < 34; i++) {
    const z = rng.range(-34, 5), spread = 3 + (5 - z) * 0.32;
    const len = rng.range(1.4, 5.2);
    piece('wood', rng.range(-spread, spread), rng.range(0.12, 0.5), z, rng.range(0.25, 0.7), rng.range(0.12, 0.3), len, rng.range(-0.12, 0.12), rng.range(0, 3.14), rng.range(-0.3, 0.3), rng.range(0.7, 1.05));
  }
  piece('wood', 5.5, 0.5, -6.5, 0.7, 0.6, 9, 0.05, 0.9, 0.1, 0.8);
  // stone: the blocks the doors hung on, torn out of the jambs and the arch; big ones against the walls, the rest strewn
  for (let i = 0; i < 46; i++) {
    const big = i < 12;
    const z = big ? rng.range(-9, 5) : rng.range(-30, 6);
    const side = rng.sign();
    const x = big ? side * rng.range(4.6, 7.4) : rng.range(-1, 1) * (4 + (6 - z) * 0.34);
    const s0 = big ? rng.range(1.5, 2.9) : rng.range(0.5, 1.5);
    piece('stone', x, s0 * rng.range(0.28, 0.45), z, s0 * rng.range(0.8, 1.3), s0 * rng.range(0.6, 0.9), s0 * rng.range(0.8, 1.4), rng.range(-0.35, 0.35), rng.range(0, 3.14), rng.range(-0.35, 0.35), rng.range(0.72, 1));
    if (big && Math.abs(x) > 5.6) wreckCols.push(ctx.col.sph(x, s0 * 0.4, z, s0 * 0.62, 'stone'));
  }
  // the arch and the jambs themselves: stones hanging loose from the lintel and jutting from the corners, so the
  // opening is ragged instead of square
  for (let i = 0; i < 16; i++) {
    const x = rng.range(-GATE_W + 0.4, GATE_W - 0.4), s0 = rng.range(0.9, 2.3);
    piece('stone', x, GATE_H - s0 * rng.range(0.1, 0.5), rng.range(2.2, THICK + 0.25), s0 * rng.range(0.9, 1.5), s0, s0 * rng.range(0.8, 1.2), rng.range(-0.4, 0.4), rng.range(-0.5, 0.5), rng.range(-0.5, 0.5), rng.range(0.6, 0.92));
  }
  for (const side of [-1, 1]) for (let i = 0; i < 11; i++) {
    const s0 = rng.range(0.7, 1.9), y = rng.range(0.5, GATE_H - 0.5);
    piece('stone', side * (GATE_W - s0 * rng.range(0.05, 0.4)), y, rng.range(3.4, THICK + 0.2), s0, s0 * rng.range(0.8, 1.6), s0 * rng.range(0.8, 1.2), rng.range(-0.3, 0.3), rng.range(-0.4, 0.4), rng.range(-0.3, 0.3), rng.range(0.6, 0.9));
  }

  const rocks: [number, number, number][] = [];
  for (let i = 0; i < 26; i++) {
    const side = rng.sign(), edge = rng.chance(0.7);
    const x = edge ? side * rng.range(GATE_W - 1, GATE_W + 9) : rng.range(-GATE_W + 1.5, GATE_W - 1.5);
    const z = edge ? rng.range(-16, 22) : rng.range(-5, 18);
    const r = rng.range(0.6, edge ? 2.0 : 1.1);
    rocks.push([x, z, r]);
  }
  for (const [x, z, r] of rocks) {
    addRock(RB, x, r * 0.35, z, r, rng, { color: 0xe0d8cc, mossy: false });
    wreckCols.push(ctx.col.sph(x, r * 0.35 + 0.0, z, r * 0.78, 'stone'));
  }

  // ---- gate, shut: two oak leaves across the outer mouth of the tunnel, iron-strapped, a bar across them ----
  const DZ = THICK - 1.3;
  for (const sx of [-1, 1]) {
    DW.box(sx * GATE_W / 2, GATE_H / 2, DZ, GATE_W - 0.12, GATE_H - 0.1, 0.9, { color: 0xa8947c, uTile: 1.4, vTile: 1.4, vBase: 0, grad: [0.72, 1], faces: 'xXzZy' });
    for (const yy of [2.2, 7.2, 12.4, 17.4]) DI.box(sx * GATE_W / 2, yy, DZ, GATE_W - 0.2, 0.55, 1.06, { color: 0x2c2b29, faces: 'xXzZyY' });
    // studs down the meeting edge and the hinge side
    for (let yy = 1.2; yy < GATE_H - 0.6; yy += 1.25) for (const ex of [0.5, GATE_W - 0.6]) DI.box(sx * ex, yy, DZ + 0.5, 0.26, 0.26, 0.16, { color: 0x3a3836, faces: 'xXZyY' });
  }
  DW.box(0, 9.4, DZ + 0.75, GATE_W * 1.7, 0.7, 0.6, { color: 0x8a765e, uTile: 1.4, vTile: 1.4, vBase: 0, grad: [0.8, 1], faces: 'xXzZyY' });   // the bar
  doorCols.push(ctx.col.box(0, GATE_H / 2, DZ, GATE_W, GATE_H / 2, 0.55, 'wood'));

  // ---- flags on the wall top ----
  ctx.flag('wallguard', -GATE_W + 1.5, TOP, 0, { h: 11, s: 1.5, yaw: 0 });
  ctx.flag('wallguard', GATE_W - 1.5, TOP, 0, { h: 11, s: 1.5, yaw: Math.PI * 0.0 });
  for (let k = 1; k <= 14; k++) for (const sx of [-1, 1]) ctx.flag('wallguard', sx * (80 + (k - 1) * 80), TOP, -3.8, { h: 8, s: 1.0, yaw: 0 });

  // ---- supply depots on the wall top ----
  const depotB = { planks: new Builder(), iron: IR };
  makeDepot(ctx, depotB, -40, TOP, 0, 0, { radius: 7.5 });
  makeDepot(ctx, depotB, 40, TOP, 0, 0, { radius: 7.5 });

  // ---- meshes ----
  const stoneMesh = ctx.add(new THREE.Mesh(S.toGeometry(), ctx.mat.stone)); stoneMesh.name = 'wall';
  const pavMesh = ctx.add(new THREE.Mesh(PV.toGeometry(), ctx.mat.paving), false, true); pavMesh.name = 'wallTop';
  const wdMesh = ctx.add(new THREE.Mesh(WD.toGeometry(), ctx.mat.planks)); wdMesh.name = 'wallWood';
  const dpMesh = ctx.add(new THREE.Mesh(depotB.planks.toGeometry(), ctx.mat.planks)); dpMesh.name = 'wallDepotWood';
  const irMesh = ctx.add(new THREE.Mesh(IR.toGeometry(), ctx.mat.plain)); irMesh.name = 'wallIron';
  const rbMesh = ctx.add(new THREE.Mesh(RB.toGeometry(), ctx.mat.rock)); rbMesh.name = 'gateRubble';
  const gwMesh = ctx.add(new THREE.Mesh(GW.toGeometry(), ctx.mat.planks)); gwMesh.name = 'gateWreckWood';
  const gsMesh = ctx.add(new THREE.Mesh(GS.toGeometry(), ctx.mat.stone)); gsMesh.name = 'gateWreckStone';
  const giMesh = ctx.add(new THREE.Mesh(GI.toGeometry(), ctx.mat.plain)); giMesh.name = 'gateWreckIron';
  const dwMesh = ctx.add(new THREE.Mesh(DW.toGeometry(), ctx.mat.planks)); dwMesh.name = 'gateDoorWood';
  const diMesh = ctx.add(new THREE.Mesh(DI.toGeometry(), ctx.mat.plain)); diMesh.name = 'gateDoorIron';

  // the gate's state: breached (the wreck and its colliders) or shut (the doors and theirs). The colliders of the
  // state that isn't showing are taken out of the collision world, so nothing invisible is in the way.
  const world = ctx.game.collision as unknown as { remove(c: unknown): void; _register(c: unknown): unknown };
  let open = true;
  for (const c of doorCols) world.remove(c);
  dwMesh.visible = diMesh.visible = false;
  ctx.gate = {
    get open() { return open; },
    set(next: boolean) {
      if (next === open) return;
      open = next;
      for (const c of open ? doorCols : wreckCols) world.remove(c);
      for (const c of open ? wreckCols : doorCols) world._register(c);
      rbMesh.visible = gwMesh.visible = giMesh.visible = gsMesh.visible = open;
      dwMesh.visible = diMesh.visible = !open;
    },
    burst() { burst.fire(); },
  };

  // ---- the moment it goes: chunks of door and stone thrown down the tunnel and into the street ----
  const burst = makeBurst(ctx);
  ctx.updaters.push((dt) => burst.update(dt));
  return { stoneMesh };
}
