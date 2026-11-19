// A tiny kit for building a character out of low-poly parts. Every part is made in the space of the bone it rides on
// (metres, the character's frame: it faces -Z, +X is its right), tagged with a material id from config/material, and
// merged with the other parts of the same bone and material, so a whole person is a few dozen draw calls. Nothing here
// touches the world: it builds three.js objects, so a body builds the same in a test, on the bench and in the game.
import * as THREE from 'hull/three';
import { config } from 'hull';

export type V3 = [number, number, number];

// ---------------------------------------------------------------- materials

interface MatEntry { material: THREE.MeshStandardMaterial; unwatch: (() => void) | null; refs: number }
const mats = new Map<string, MatEntry>();

function paint(m: THREE.MeshStandardMaterial, def: { color: string; roughness?: number; metalness?: number }): void {
  m.color.set(def.color);
  m.roughness = def.roughness ?? 0.8;
  m.metalness = def.metalness ?? 0;
}

/** A shared material by config id ("steel" is config/material/steel). It follows the file live and is flat shaded. */
export function takeMaterial(id: string): THREE.MeshStandardMaterial {
  let e = mats.get(id);
  if (!e) {
    const material = new THREE.MeshStandardMaterial({ flatShading: true });
    e = { material, unwatch: null, refs: 0 };
    try {
      paint(material, config.lookup('material', id));
      e.unwatch = config.watch('material/' + id, (now) => paint(material, now as { color: string }));
    } catch {
      material.color.set('#c0407f');
      console.warn('[ironleaf] material/' + id + ' does not exist; drawing magenta.');
    }
    mats.set(id, e);
  }
  e.refs++;
  return e.material;
}

export function dropMaterial(id: string): void {
  const e = mats.get(id);
  if (!e || --e.refs > 0) return;
  e.unwatch?.();
  e.material.dispose();
  mats.delete(id);
}

// ---------------------------------------------------------------- shapes (each returns a geometry in bone space)

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _e = new THREE.Euler();

function finish(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  return out;
}

/** A tube from p0 to p1 whose cross-section is an ellipse: x and z radii at each end. seg 4 is a diamond, 6 a hex. */
export function ell(p0: V3, p1: V3, x0: number, z0: number, x1: number, z1: number, seg = 8, cap = true): THREE.BufferGeometry {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const len = Math.hypot(dx, dy, dz) || 1e-6;
  const g = new THREE.CylinderGeometry(1, 1, len, seg, 1, !cap);
  const pos = g.attributes['position'] as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / len + 0.5;
    pos.setX(i, pos.getX(i) * (x0 + (x1 - x0) * t));
    pos.setZ(i, pos.getZ(i) * (z0 + (z1 - z0) * t));
  }
  _dir.set(dx / len, dy / len, dz / len);
  _q.setFromUnitVectors(_up, _dir);
  _p.set((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2);
  g.applyMatrix4(_m.compose(_p, _q, _s));
  return finish(g);
}

/** A round tube from p0 (radius r0) to p1 (radius r1). */
export const tube = (p0: V3, p1: V3, r0: number, r1 = r0, seg = 8): THREE.BufferGeometry => ell(p0, p1, r0, r0, r1, r1, seg);

/** A cone from a base to a tip. */
export const cone = (base: V3, tip: V3, r: number, seg = 8): THREE.BufferGeometry => ell(base, tip, r, r, 0.001, 0.001, seg);

/** A box centred at c with full size s, turned by Euler angles (x, y, z in radians). */
export function slab(c: V3, s: V3, rot: V3 = [0, 0, 0]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(s[0], s[1], s[2]);
  _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
  _p.set(c[0], c[1], c[2]);
  g.applyMatrix4(_m.compose(_p, _q, _s));
  return finish(g);
}

/** An ellipsoid with radii r at c. */
export function ball(c: V3, r: V3 | number, w = 8, h = 6): THREE.BufferGeometry {
  const rr: V3 = typeof r === 'number' ? [r, r, r] : r;
  const g = new THREE.SphereGeometry(1, w, h);
  g.scale(rr[0], rr[1], rr[2]);
  g.translate(c[0], c[1], c[2]);
  return finish(g);
}

/** Part of a ring (a bow limb, a hoop): radius R, tube r, from angle a0 to a1 in the plane whose normal is the Euler-turned Z axis. */
export function arc(c: V3, R: number, r: number, a0: number, a1: number, rot: V3 = [0, 0, 0], seg = 14): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(R, r, 4, seg, a1 - a0);
  g.rotateZ(a0);
  _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
  _p.set(c[0], c[1], c[2]);
  g.applyMatrix4(_m.compose(_p, _q, _s));
  return finish(g);
}

// ---------------------------------------------------------------- the builder

interface Group { target: THREE.Object3D; mat: string; geoms: THREE.BufferGeometry[] }

/** Collects parts by (target, material), then merges each group into one mesh under its target. */
export class Builder {
  private readonly groups = new Map<string, Group>();
  private readonly made: THREE.Mesh[] = [];
  private readonly used = new Set<string>();

  constructor(private readonly boneOf: (name: string) => THREE.Object3D | undefined, private readonly flag: string) {}

  /** Adds a part. `to` is a bone name or any Object3D (a sword group). */
  add(to: string | THREE.Object3D, mat: string, ...geoms: THREE.BufferGeometry[]): void {
    const target = typeof to === 'string' ? this.boneOf(to) : to;
    if (!target) { for (const g of geoms) g.dispose(); return; }
    const key = target.uuid + '|' + mat;
    let grp = this.groups.get(key);
    if (!grp) { grp = { target, mat, geoms: [] }; this.groups.set(key, grp); }
    grp.geoms.push(...geoms);
  }

  /** Mirrors a part builder over both sides: `f(sx)` is called with -1 (left) and +1 (right). */
  both(f: (sx: number, side: 'L' | 'R') => void): void { f(-1, 'L'); f(1, 'R'); }

  build(): void {
    for (const grp of this.groups.values()) {
      const merged = grp.geoms.length === 1 ? grp.geoms[0]! : THREE.mergeGeometries(grp.geoms, false);
      if (grp.geoms.length > 1) for (const g of grp.geoms) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, takeMaterial(grp.mat));
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.userData[this.flag] = true;
      this.used.add(grp.mat);
      grp.target.add(mesh);
      this.made.push(mesh);
    }
    this.groups.clear();
  }

  dispose(): void {
    for (const m of this.made) { m.removeFromParent(); m.geometry.dispose(); }
    this.made.length = 0;
    for (const id of this.used) dropMaterial(id);
    this.used.clear();
  }
}
