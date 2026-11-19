// OPEN PLAIN (z in [6, 480]) between the Ashwall and the Greatwood: lone trees and small copses, rocks, a broken
// cart, a small stone ruin, titan spawn zones. The expedition's formation rides out across it.
import * as THREE from 'hull/three';
import { Builder } from './geo';
import { Rng } from './rng';
import type { WorldCtx } from './common';
import { groundHeight, roadX, FS, FX1 } from './terrain';
import { TreeBatch, addTree, finishBatch } from './trees';
import { addRock } from './props';

const V3 = THREE.Vector3, Q = THREE.Quaternion, UP = new V3(0, 1, 0);

export function buildField(ctx: WorldCtx): void {
  const rng = new Rng(4004);
  // lone trees (normal 15-25 m)
  const tb = new TreeBatch();
  const spots: [number, number][] = [[-140, 60], [-70, 120], [95, 80], [150, 140], [-210, 150], [40, 160], [250, 90], [-300, 70], [-30, 170], [190, 40]];
  // further out on the plain: lone trees and a few copses, far apart (somewhere to put a rope, nothing to hide in)
  for (let i = 0; i < 46; i++) {
    const x = rng.range(-950, 950), z = rng.range(185, 160 + FS);
    if (Math.abs(x - roadX(z)) < 25) continue;
    spots.push([x, z]);
    if (i % 6 === 0) for (let k = 0; k < 3; k++) spots.push([x + rng.range(-16, 16), z + rng.range(-16, 16)]);
  }
  // and the open land east of the forest, all the way north (the formation's route)
  for (let i = 0; i < 30; i++) {
    const x = rng.range(FX1 + 90, 1060), z = rng.range(460, 1320);
    spots.push([x, z]);
    if (i % 5 === 0) for (let k = 0; k < 2; k++) spots.push([x + rng.range(-14, 14), z + rng.range(-14, 14)]);
  }
  for (const [x, z] of spots) {
    if (Math.abs(x - roadX(z)) < 12) continue;
    const H = rng.range(15, 25);
    addTree(ctx, tb, rng, x, z, { H, r0: rng.range(0.6, 0.95), lod: 0, small: true, branches: [3, 4], branchMin: H * 0.35, len: [4, 7.5], rb: [0.2, 0.34], blobR: [3.6, 5.6], canopyN: 5, canopySpread: 3 });
  }
  finishBatch(ctx, tb, 'fieldTree');

  // rocks
  const RB = new Builder();
  for (let i = 0; i < 90; i++) {
    const east = i % 3 === 0, x = east ? rng.range(FX1 + 60, 1050) : rng.range(-900, 900), z = east ? rng.range(460, 1320) : rng.range(30, 160 + FS);
    if (Math.abs(x - roadX(z)) < 8) continue;
    const r = rng.range(0.8, i % 7 === 0 ? 3.6 : 2.2), gy = groundHeight(x, z), squash = 0.78;
    addRock(RB, x, gy + r * 0.1, z, r, rng, { squash });
    ctx.col.sph(x, gy + r * 0.1, z, r * 0.8, 'stone');
  }

  // broken cart beside the road
  const WD = new Builder(), cx = roadX(95) + 9, cz = 95, gy = groundHeight(cx, cz), yaw = 0.5;
  const M = new THREE.Matrix4().compose(new V3(cx, gy, cz), new Q().setFromAxisAngle(UP, yaw), new V3(1, 1, 1));
  const qY = new Q().setFromAxisAngle(UP, yaw);
  WD.setTransform(M);
  WD.box(0, 1.15, 0, 3.6, 0.25, 1.9, { color: 0xc8b49c, uTile: 1, vTile: 1, vBase: 0, faces: 'xXzZyY' });
  for (const sz of [-1, 1]) WD.box(0, 1.65, sz * 0.9, 3.6, 0.8, 0.12, { color: 0xb8a48c, uTile: 1, vTile: 1, vBase: 0, faces: 'xXzZy' });
  WD.box(-1.8, 1.65, 0, 0.12, 0.8, 1.9, { color: 0xb8a48c, uTile: 1, vTile: 1, faces: 'xXzZy' });
  WD.tube([new V3(1.8, 1.0, 0), new V3(3.4, 0.9, 0.2), new V3(5.4, 0.6, 0.5)], () => 0.12, { seg: 6, color: new THREE.Color(0xa08c74), uTile: 2, vTile: 2 });
  WD.tube([new V3(0, 0.62, -1.2), new V3(0, 0.62, -1.05), new V3(0, 0.62, -0.9), new V3(0, 0.62, -0.88)], (i) => [0.01, 0.62, 0.62, 0.01][i], { seg: 12, color: new THREE.Color(0x8c7860), uTile: 2, vTile: 2 });
  WD.setTransform(null);
  ctx.col.box(cx, gy + 1.4, cz, 1.8, 0.45, 0.95, 'wood', qY);
  const cw = new V3(0, 0.62, -1.05).applyMatrix4(M);
  ctx.col.sph(cw.x, cw.y, cw.z, 0.6, 'wood');
  const hb = new V3(1.8, 1.0, 0).applyMatrix4(M), he = new V3(5.4, 0.6, 0.5).applyMatrix4(M);
  ctx.col.cap(hb.x, hb.y, hb.z, he.x, he.y, he.z, 0.14, 'wood');

  // stone ruin: broken walls and pillars
  const ST = new Builder(), rx = -150, rz = 100;
  const piece = (dx: number, dz: number, w: number, h: number, d: number, ry = 0) => {
    const x = rx + dx, z = rz + dz, g = groundHeight(x, z), q = new Q().setFromAxisAngle(UP, ry);
    ST.setTransform(new THREE.Matrix4().compose(new V3(x, g, z), q, new V3(1, 1, 1)));
    ST.box(0, h / 2 - 0.3, 0, w, h, d, { uTile: 8, vTile: 4, vBase: -0.3, grad: [0.75, 1], faces: 'xXzZy' });
    ST.setTransform(null);
    ctx.col.box(x, g + h / 2 - 0.3, z, w / 2, h / 2, d / 2, 'stone', q);
  };
  piece(0, 0, 14, 7, 1.6); piece(-7, 5, 1.6, 5, 10); piece(7, 6, 1.6, 9, 8); piece(0, 11, 5, 2.5, 1.6, 0.1); piece(-3, 11.6, 3, 4.5, 1.6, -0.2);
  for (const [px, pz, ph] of [[-5, 3, 9], [5, 3, 6], [0, 7, 11]]) {
    const x = rx + px, z = rz + pz, g = groundHeight(x, z);
    ST.tube([new V3(x, g - 0.3, z), new V3(x, g + ph * 0.5, z), new V3(x, g + ph, z)], (i) => [0.95, 0.85, 0.8][i], { seg: 10, uTile: 3, vTile: 3, color: new THREE.Color(0xe6ddd0) });
    ctx.col.cyl(x, z, g - 0.3, g + ph, 0.87, 'stone');
  }

  // ---- the ruined village outside the gate (abandoned when the Old Wall fell): roofless stone houses along the road,
  // a few still with a sagging plank roof. The formation rides out through it. And lone farmhouses out on the plain.
  const RV = new Builder(), RW = new Builder();
  const house = (cx: number, cz: number, yaw: number, W: number, D: number, H: number, roofed: boolean) => {
    const g = groundHeight(cx, cz), q = new Q().setFromAxisAngle(UP, yaw);
    const F = new THREE.Matrix4().compose(new V3(cx, g, cz), q, new V3(1, 1, 1));
    const wall = (lx: number, lz: number, w: number, d: number, h: number) => {
      RV.setTransform(F);
      RV.box(lx, h / 2 - 0.3, lz, w, h, d, { color: 0xe6ddd0, uTile: 4, vTile: 4, vBase: -0.3, grad: [0.72, 1], faces: 'xXzZy' });
      const c = new V3(lx, h / 2 - 0.3, lz).applyMatrix4(F);
      ctx.col.box(c.x, c.y, c.z, w / 2, h / 2, d / 2, 'stone', q);
    };
    const T = 0.6;
    // front and back walls; a ruin has a gap or a broken top; the side walls run full height
    const hb = roofed ? H : H * rng.range(0.45, 0.85);
    wall(0, D / 2, W, T, H); wall(-W * 0.3, -D / 2, W * 0.4, T, hb); wall(W * 0.32, -D / 2, W * 0.36, T, roofed ? H : hb * 0.6);
    wall(-W / 2, 0, T, D, roofed ? H : H * rng.range(0.6, 1)); wall(W / 2, 0, T, D, H);
    if (!roofed) return;
    // a gable roof of weathered planks, ridge along x
    const R = D * 0.38;
    for (const sd of [-1, 1]) {
      const ang = Math.atan2(R, D / 2), len = Math.hypot(R, D / 2) + 0.6;
      const M = F.clone().multiply(new THREE.Matrix4().compose(new V3(0, H + R / 2 - 0.3, sd * D / 4), new Q().setFromAxisAngle(new V3(1, 0, 0), sd * ang), new V3(1, 1, 1)));
      RW.setTransform(M);
      RW.box(0, 0, 0, W + 1, 0.25, len, { color: 0xbcae9c, uTile: 3, vTile: 3, faces: 'xXzZyY' });
      const c = new V3().applyMatrix4(M);
      ctx.col.box(c.x, c.y, c.z, (W + 1) / 2, 0.15, len / 2, 'wood', new Q().setFromRotationMatrix(M));
    }
  };
  for (let z = 92; z < 232; z += rng.range(13, 20)) for (const sd of [-1, 1]) {
    if (rng.next() < 0.2) continue;
    const off = rng.range(24, 52), x = roadX(z) + sd * off;
    house(x, z, rng.range(-0.25, 0.25) + (rng.next() < 0.5 ? 0 : Math.PI / 2), rng.range(7, 11), rng.range(6, 9), rng.range(4.5, 7.5), rng.next() < 0.3);
  }
  for (const [x, z] of [[-40, 300], [160, 360], [520, 420], [780, 560], [640, 760], [900, 920], [700, 1080], [-520, 260], [300, 250]])
    house(x, z, rng.range(0, Math.PI), rng.range(8, 11), rng.range(6, 8), rng.range(5, 7), rng.next() < 0.6);
  RV.setTransform(null); RW.setTransform(null);

  const addMesh = (B: Builder, mat: THREE.Material, name: string) => { const m = new THREE.Mesh(B.toGeometry(), mat); m.name = name; ctx.add(m); };
  addMesh(RB, ctx.mat.rock, 'fieldRocks'); addMesh(WD, ctx.mat.planks, 'fieldCart'); addMesh(ST, ctx.mat.stone, 'fieldRuin');
  addMesh(RV, ctx.mat.stone, 'villageWalls'); addMesh(RW, ctx.mat.planks, 'villageRoofs');

  // titan spawn zones
  for (const [x, z, r] of [[-150, 55, 25], [0, 70, 25], [140, 60, 25], [-120, 140, 25], [130, 150, 25], [-220, 110, 25], [230, 120, 25], [20, 170, 20], [-400, 300, 30], [380, 260, 30], [-150, 400, 30], [600, 420, 30]])
    ctx.titanSpawns.push({ center: new V3(x, groundHeight(x, z), z), radius: r, area: 'field' });
}
