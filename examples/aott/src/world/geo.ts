// Geometry builder: accumulates non-indexed triangles with normals, metre-based UVs and vertex colours,
// so a whole district can be merged into a handful of BufferGeometries.
import * as THREE from 'hull/three';

/** A point as [x, y, z]; a texture coordinate as [u, v]. */
export type P3 = readonly number[];
export type UV = readonly number[];
export type ColorLike = THREE.Color | number;

/** Options for Builder.box (see there). */
export interface BoxOpts {
  color?: ColorLike; uTile?: number; vTile?: number; snap?: boolean; vBase?: number; grad?: readonly [number, number];
  faces?: string; topTile?: number; topTileV?: number;
}
/** Options for Builder.tube (see there). */
export interface TubeOpts {
  seg?: number; uTile?: number; vTile?: number; color?: ColorLike; colFn?: (i: number, j: number) => ColorLike;
}

const _cc = new Map<number, THREE.Color>();
export function toColor(c: ColorLike): THREE.Color {
  if (c instanceof THREE.Color) return c;
  let v = _cc.get(c);
  if (!v) { v = new THREE.Color(c); _cc.set(c, v); }
  return v;
}
const _v = new THREE.Vector3(), _n = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

export class Builder {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; col: number[] = [];
  private m: THREE.Matrix4 | null = null;
  private nm: THREE.Matrix3 | null = null;
  get triCount(): number { return this.pos.length / 9; }
  setTransform(m: THREE.Matrix4 | null): void { this.m = m || null; this.nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null; }
  private _push(p: P3, n: THREE.Vector3, uv: UV, c: THREE.Color): void {
    let x = p[0], y = p[1], z = p[2], nx = n.x, ny = n.y, nz = n.z;
    if (this.m && this.nm) {
      _v.set(x, y, z).applyMatrix4(this.m); x = _v.x; y = _v.y; z = _v.z;
      _n.set(nx, ny, nz).applyMatrix3(this.nm).normalize(); nx = _n.x; ny = _n.y; nz = _n.z;
    }
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.uv.push(uv[0], uv[1]); this.col.push(c.r, c.g, c.b);
  }
  /** Triangle with flat normal (or smooth normals ns = [n0,n1,n2]). */
  tri(p0: P3, p1: P3, p2: P3, uv0: UV, uv1: UV, uv2: UV, c0: ColorLike, c1: ColorLike = c0, c2: ColorLike = c0, ns: THREE.Vector3[] | null = null): void {
    if (!ns) {
      _a.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      _b.set(p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]);
      _c.crossVectors(_a, _b).normalize();
      const n = _c.clone();
      ns = [n, n, n];
    }
    this._push(p0, ns[0], uv0, toColor(c0)); this._push(p1, ns[1], uv1, toColor(c1)); this._push(p2, ns[2], uv2, toColor(c2));
  }
  /** Quad a,b,c,d counter-clockwise seen from outside (normal = (b-a)x(d-a)). uv/colour arrays of 4 (or single colour). */
  quad(P: readonly P3[], UV: readonly UV[], C: ColorLike | readonly ColorLike[]): void {
    const cs: readonly ColorLike[] = Array.isArray(C) ? C : [C as ColorLike, C as ColorLike, C as ColorLike, C as ColorLike];
    this.tri(P[0], P[1], P[2], UV[0], UV[1], UV[2], cs[0], cs[1], cs[2]);
    this.tri(P[0], P[2], P[3], UV[0], UV[2], UV[3], cs[0], cs[2], cs[3]);
  }
  /**
   * Axis-aligned box with metre UVs. opts: color, uTile, vTile (metres per texture repeat), snap (round u repeats to
   * an integer per face), vBase (y that maps to v=0; default bottom), grad [bottomMul, topMul], faces (string of
   * 'pP nN' chars subset of 'xXzZyY' lowercase=negative; default all but bottom), topUV tile size.
   */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, o: BoxOpts = {}): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const base = toColor(o.color ?? 0xffffff);
    const uT = o.uTile ?? 4, vT = o.vTile ?? 4, vB = o.vBase ?? y0;
    const g0 = o.grad ? o.grad[0] : 1, g1 = o.grad ? o.grad[1] : 1;
    const cB = base.clone().multiplyScalar(g0), cT = base.clone().multiplyScalar(g1);
    const faces = o.faces ?? 'xXzZy';
    const sideUV = (len: number) => { const n = o.snap ? Math.max(1, Math.round(len / uT)) : len / uT; return n; };
    const vv0 = (y0 - vB) / vT, vv1 = (y1 - vB) / vT;
    if (faces.includes('Z')) { const n = sideUV(sx); this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [[0, vv0], [n, vv0], [n, vv1], [0, vv1]], [cB, cB, cT, cT]); }
    if (faces.includes('z')) { const n = sideUV(sx); this.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [[0, vv0], [n, vv0], [n, vv1], [0, vv1]], [cB, cB, cT, cT]); }
    if (faces.includes('X')) { const n = sideUV(sz); this.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [[0, vv0], [n, vv0], [n, vv1], [0, vv1]], [cB, cB, cT, cT]); }
    if (faces.includes('x')) { const n = sideUV(sz); this.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [[0, vv0], [n, vv0], [n, vv1], [0, vv1]], [cB, cB, cT, cT]); }
    if (faces.includes('y')) { const tu = o.topTile ?? uT, tv = o.topTileV ?? tu; this.quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [[x0 / tu, z0 / tv], [x0 / tu, z1 / tv], [x1 / tu, z1 / tv], [x1 / tu, z0 / tv]], cT); }
    if (faces.includes('Y')) { this.quad([[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], [[0, 0], [0, 1], [1, 1], [1, 0]], cB); }
  }
  /** Subdivided quad patch (origin + u*uVec + v*vVec), normal = uVec x vVec. colorFn(u01, v01, x, y, z). */
  patch(origin: THREE.Vector3, uVec: THREE.Vector3, vVec: THREE.Vector3, nu: number, nv: number, uvFn: (p: P3) => UV,
    colorFn?: (u: number, v: number, x: number, y: number, z: number) => ColorLike): void {
    const n = new THREE.Vector3().crossVectors(uVec, vVec).normalize();
    const pt = (i: number, j: number): P3 => { const u = i / nu, v = j / nv; return [origin.x + uVec.x * u + vVec.x * v, origin.y + uVec.y * u + vVec.y * v, origin.z + uVec.z * u + vVec.z * v]; };
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const P = [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)];
      const idx = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      const UV = P.map((p) => uvFn(p));
      const C = idx.map(([a, b], k) => colorFn ? toColor(colorFn(a / nu, b / nv, P[k][0], P[k][1], P[k][2])).clone() : toColor(0xffffff));
      this.tri(P[0], P[1], P[2], UV[0], UV[1], UV[2], C[0], C[1], C[2], [n, n, n]);
      this.tri(P[0], P[2], P[3], UV[0], UV[2], UV[3], C[0], C[2], C[3], [n, n, n]);
    }
  }
  /**
   * Smooth-shaded grid surface. P[i][j] = [x,y,z]; rows i along the axis, columns j around (closed -> wraps).
   * Orientation convention: normal = d/di x d/dj (rings built with e2 = e1 x axis give outward normals).
   */
  surface(P: P3[][], closed: boolean, uvFn: (i: number, j: number) => UV, colFn: ((i: number, j: number) => ColorLike) | null, flip = false): void {
    const R = P.length, S = P[0].length;
    const N: THREE.Vector3[][] = [];
    const get = (i: number, j: number) => P[Math.max(0, Math.min(R - 1, i))][closed ? ((j % S) + S) % S : Math.max(0, Math.min(S - 1, j))];
    for (let i = 0; i < R; i++) {
      N.push([]);
      for (let j = 0; j < S; j++) {
        const pi1 = get(i + 1, j), pi0 = get(i - 1, j), pj1 = get(i, j + 1), pj0 = get(i, j - 1);
        _a.set(pi1[0] - pi0[0], pi1[1] - pi0[1], pi1[2] - pi0[2]);
        _b.set(pj1[0] - pj0[0], pj1[1] - pj0[1], pj1[2] - pj0[2]);
        const n = new THREE.Vector3().crossVectors(_a, _b);
        if (n.lengthSq() < 1e-12) n.set(0, 1, 0); else n.normalize();
        if (flip) n.negate();
        N[i].push(n);
      }
    }
    const Jn = closed ? S : S - 1;
    for (let i = 0; i < R - 1; i++) for (let j = 0; j < Jn; j++) {
      const j1 = (j + 1) % S;
      const ids = [[i, j], [i + 1, j], [i, j1 === 0 && closed ? S : j + 1], [i + 1, j1 === 0 && closed ? S : j + 1]];
      const pts = [P[i][j], P[i + 1][j], P[i][j1], P[i + 1][j1]];
      const nrm = [N[i][j], N[i + 1][j], N[i][j1], N[i + 1][j1]];
      const uv = ids.map(([a, b]) => uvFn(a, b));
      const cc = ids.map(([a, b], k) => toColor(colFn ? colFn(a, b % S) : 0xffffff));
      if (!flip) {
        this.tri(pts[0], pts[1], pts[2], uv[0], uv[1], uv[2], cc[0], cc[1], cc[2], [nrm[0], nrm[1], nrm[2]]);
        this.tri(pts[2], pts[1], pts[3], uv[2], uv[1], uv[3], cc[2], cc[1], cc[3], [nrm[2], nrm[1], nrm[3]]);
      } else {
        this.tri(pts[0], pts[2], pts[1], uv[0], uv[2], uv[1], cc[0], cc[2], cc[1], [nrm[0], nrm[2], nrm[1]]);
        this.tri(pts[2], pts[3], pts[1], uv[2], uv[3], uv[1], cc[2], cc[3], cc[1], [nrm[2], nrm[3], nrm[1]]);
      }
    }
  }
  /**
   * Tapered tube along a polyline. radius(i, theta) -> metres. opts: seg, color (Color | fn(i,j)), uTile, vTile, closeEnd.
   * Uses parallel transport so branches in any direction get consistent rings.
   */
  tube(pts: THREE.Vector3[], radius: (i: number, theta: number) => number, o: TubeOpts = {}): void {
    const seg = o.seg ?? 8, n = pts.length;
    const t = pts.map((p, i) => new THREE.Vector3().subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize());
    let e1 = Math.abs(t[0].y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0).cross(t[0]).normalize();
    // make e1 perpendicular to t[0]
    e1.sub(t[0].clone().multiplyScalar(e1.dot(t[0]))).normalize();
    const P: P3[][] = []; const lens = [0];
    for (let i = 0; i < n; i++) {
      if (i > 0) { e1.sub(t[i].clone().multiplyScalar(e1.dot(t[i]))).normalize(); lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1])); }
      const e2 = new THREE.Vector3().crossVectors(e1, t[i]);
      const row: P3[] = [];
      for (let j = 0; j < seg; j++) {
        const th = (j / seg) * Math.PI * 2, r = radius(i, th);
        row.push([pts[i].x + (Math.cos(th) * e1.x + Math.sin(th) * e2.x) * r, pts[i].y + (Math.cos(th) * e1.y + Math.sin(th) * e2.y) * r, pts[i].z + (Math.cos(th) * e1.z + Math.sin(th) * e2.z) * r]);
      }
      P.push(row);
    }
    const r0 = radius(0, 0), uT = o.uTile ?? 4, vT = o.vTile ?? 4;
    const nU = Math.max(1, Math.round(Math.PI * 2 * r0 / uT));
    const color = o.color;
    this.surface(P, true, (i, j) => [(j / seg) * nU, lens[Math.min(i, n - 1)] / vT], o.colFn || (color !== undefined ? () => color : null));
  }
  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}
