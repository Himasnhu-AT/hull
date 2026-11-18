// Static triangle mesh: triangles baked to world space, with a bounding-volume hierarchy built once.
// Triangles are stored in leaf order so a leaf is a contiguous run.

const LEAF = 4;

export class MeshData {
  tris = 0;
  /** 9 numbers per triangle (three vertices). */
  v!: Float64Array;
  /** 3 per triangle: unit normal, or zeros for a degenerate triangle (those are skipped). */
  n!: Float64Array;
  nodes = 0;
  /** 6 per node: min xyz, max xyz. */
  bb!: Float64Array;
  /** Child node indices, or -1 for a leaf. */
  left!: Int32Array;
  right!: Int32Array;
  /** Leaf: first triangle and how many. */
  first!: Int32Array;
  count!: Int32Array;
  minx = Infinity; miny = Infinity; minz = Infinity;
  maxx = -Infinity; maxy = -Infinity; maxz = -Infinity;
}

/** `m` is a column-major 4x4 that takes mesh space to world space. */
export function buildMesh(positions: ArrayLike<number>, indices: ArrayLike<number> | undefined, m: ArrayLike<number>): MeshData {
  const vertCount = Math.floor(positions.length / 3);
  const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(vertCount / 3);
  const world = new Float64Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    world[i * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    world[i * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    world[i * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  }
  const idx = new Int32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) {
    const k = indices ? indices[i]! : i;
    if (!(k >= 0 && k < vertCount)) throw new Error(`mesh: index ${i} is ${k}, outside the ${vertCount} vertices`);
    idx[i] = k;
  }
  const centroid = new Float64Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let a = 0; a < 3; a++) {
      centroid[t * 3 + a] =
        (world[idx[t * 3]! * 3 + a]! + world[idx[t * 3 + 1]! * 3 + a]! + world[idx[t * 3 + 2]! * 3 + a]!) / 3;
    }
  }
  const order = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) order[i] = i;

  const md = new MeshData();
  md.tris = triCount;
  const maxNodes = Math.max(1, triCount * 2);
  md.bb = new Float64Array(maxNodes * 6);
  md.left = new Int32Array(maxNodes).fill(-1);
  md.right = new Int32Array(maxNodes).fill(-1);
  md.first = new Int32Array(maxNodes);
  md.count = new Int32Array(maxNodes);
  md.v = new Float64Array(triCount * 9);
  md.n = new Float64Array(triCount * 3);

  // Triangles go into their final order first, so node ranges index md.v directly.
  const build = (lo: number, hi: number): number => {
    const node = md.nodes++;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const t = order[i]!;
      for (let k = 0; k < 3; k++) {
        const vi = idx[t * 3 + k]! * 3;
        const x = world[vi]!, y = world[vi + 1]!, z = world[vi + 2]!;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const cx = centroid[t * 3]!, cy = centroid[t * 3 + 1]!, cz = centroid[t * 3 + 2]!;
      if (cx < cx0) cx0 = cx; if (cx > cx1) cx1 = cx;
      if (cy < cy0) cy0 = cy; if (cy > cy1) cy1 = cy;
      if (cz < cz0) cz0 = cz; if (cz > cz1) cz1 = cz;
    }
    const o = node * 6;
    md.bb[o] = x0; md.bb[o + 1] = y0; md.bb[o + 2] = z0;
    md.bb[o + 3] = x1; md.bb[o + 4] = y1; md.bb[o + 5] = z1;
    if (hi - lo <= LEAF) {
      md.first[node] = lo;
      md.count[node] = hi - lo;
      return node;
    }
    const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    // Sort the range by centroid on the widest axis; ties by triangle index so the tree never depends on sort internals.
    const part = Array.from(order.subarray(lo, hi)).sort((a, b) => centroid[a * 3 + axis]! - centroid[b * 3 + axis]! || a - b);
    for (let i = 0; i < part.length; i++) order[lo + i] = part[i]!;
    const mid = (lo + hi) >> 1;
    const l = build(lo, mid);
    const r = build(mid, hi);
    md.left[node] = l;
    md.right[node] = r;
    return node;
  };
  if (triCount > 0) build(0, triCount);

  for (let i = 0; i < triCount; i++) {
    const t = order[i]!;
    for (let k = 0; k < 3; k++) {
      const vi = idx[t * 3 + k]! * 3;
      md.v[i * 9 + k * 3] = world[vi]!;
      md.v[i * 9 + k * 3 + 1] = world[vi + 1]!;
      md.v[i * 9 + k * 3 + 2] = world[vi + 2]!;
    }
    const v = md.v;
    const o = i * 9;
    const e1x = v[o + 3]! - v[o]!, e1y = v[o + 4]! - v[o + 1]!, e1z = v[o + 5]! - v[o + 2]!;
    const e2x = v[o + 6]! - v[o]!, e2y = v[o + 7]! - v[o + 1]!, e2z = v[o + 8]! - v[o + 2]!;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 1e-12) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 0; nz = 0; }
    md.n[i * 3] = nx; md.n[i * 3 + 1] = ny; md.n[i * 3 + 2] = nz;
  }
  if (md.nodes > 0) {
    md.minx = md.bb[0]!; md.miny = md.bb[1]!; md.minz = md.bb[2]!;
    md.maxx = md.bb[3]!; md.maxy = md.bb[4]!; md.maxz = md.bb[5]!;
  }
  return md;
}
