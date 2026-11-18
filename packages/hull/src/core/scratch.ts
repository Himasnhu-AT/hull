// Pooled maths objects. Handed out in order and taken back all at once when a step ends, so code that needs a
// temporary vector in a hot path allocates nothing after the pool has grown to its working size.
import { Matrix4, Quaternion, Vector3 } from 'three';

const vs: Vector3[] = [];
const qs: Quaternion[] = [];
const ms: Matrix4[] = [];
let vi = 0;
let qi = 0;
let mi = 0;

export const scratch = {
  /** Zeroed. Valid until the end of the current step. */
  v3(): Vector3 {
    let v = vs[vi];
    if (v === undefined) { v = new Vector3(); vs[vi] = v; }
    vi++;
    return v.set(0, 0, 0);
  },
  /** Identity. */
  q(): Quaternion {
    let q = qs[qi];
    if (q === undefined) { q = new Quaternion(); qs[qi] = q; }
    qi++;
    return q.identity();
  },
  /** Identity. */
  m4(): Matrix4 {
    let m = ms[mi];
    if (m === undefined) { m = new Matrix4(); ms[mi] = m; }
    mi++;
    return m.identity();
  },
};

export function resetScratch(): void {
  vi = 0;
  qi = 0;
  mi = 0;
}
