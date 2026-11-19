// Instanced flag poles + waving flags (vertex-shader animation) for everything registered through ctx.flag():
// the Outriders' emblem ('outriders') and the Wallguard's tower and spears ('wallguard').
import * as THREE from 'hull/three';
import { pbr } from './common';
import type { WorldCtx, FlagKind } from './common';

export function buildFlags(ctx: WorldCtx): void {
  const list = ctx.flags;
  if (!list.length) return;
  // poles: dark weathered wood
  const pg = new THREE.CylinderGeometry(0.07, 0.11, 1, 6); pg.translate(0, 0.5, 0);
  const poleList = list.filter((f) => f.pole);
  const poles = new THREE.InstancedMesh(pg, pbr({ color: 0x3b3128, roughness: 0.8 }), poleList.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  poleList.forEach((f, i) => {
    m.compose(p.set(f.x, f.y, f.z), q.identity(), s.set(1, f.h, 1)); poles.setMatrixAt(i, m);
    ctx.col.cap(f.x, f.y, f.z, f.x, f.y + f.h, f.z, 0.1, 'wood');
  });
  poles.instanceMatrix.needsUpdate = true; poles.name = 'flagPoles';
  ctx.add(poles, true, false);

  for (const kind of ['outriders', 'wallguard'] as FlagKind[]) {
    const fl = list.filter((f) => f.kind === kind);
    if (!fl.length) continue;
    const g = new THREE.PlaneGeometry(3, 2, 14, 6); g.translate(1.5, -1.05, 0);
    const mesh = new THREE.InstancedMesh(g, ctx.mat.flag(kind), fl.length);
    fl.forEach((f, i) => { q.setFromAxisAngle(up, f.yaw); m.compose(p.set(f.x + 0.1, f.y + f.h - 0.1, f.z), q, s.set(f.s, f.s, f.s)); mesh.setMatrixAt(i, m); });
    mesh.instanceMatrix.needsUpdate = true; mesh.frustumCulled = false; mesh.name = 'flags_' + kind;
    ctx.add(mesh, false, false);
  }
}
