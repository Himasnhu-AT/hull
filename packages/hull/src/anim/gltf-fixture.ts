// Test helper: small glTF binaries written by hand (no exporter, no files). `armGlb` is a rigged arm: three joints
// (rig:Shoulder > rig:Elbow > rig:Wrist, the elbow with a rest rotation so rest-relative maths is exercised), a box
// mesh skinned to them and one animation "Wave" that bends the elbow. `cubeGlb` is a static green cube.
const f32 = (a: number[]): Uint8Array => new Uint8Array(new Float32Array(a).buffer);
const u16 = (a: number[]): Uint8Array => new Uint8Array(new Uint16Array(a).buffer);
const u8 = (a: number[]): Uint8Array => new Uint8Array(a);

function pack(json: object, chunks: Uint8Array[]): ArrayBuffer {
  const views: object[] = [];
  let off = 0;
  const parts: Uint8Array[] = [];
  for (const c of chunks) {
    const pad = (4 - (c.length % 4)) % 4;
    views.push({ offset: off, length: c.length });
    const p = new Uint8Array(c.length + pad);
    p.set(c);
    parts.push(p);
    off += p.length;
  }
  const bin = new Uint8Array(off);
  let o = 0;
  for (const p of parts) { bin.set(p, o); o += p.length; }
  const text = JSON.stringify({ ...json, asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }], bufferViews: views.map((v) => ({ buffer: 0, byteOffset: (v as { offset: number }).offset, byteLength: (v as { length: number }).length })) });
  const j = new TextEncoder().encode(text + ' '.repeat((4 - (text.length % 4)) % 4));
  const total = 12 + 8 + j.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, j.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(j, 20);
  const b0 = 20 + j.length;
  dv.setUint32(b0, bin.length, true); dv.setUint32(b0 + 4, 0x004e4942, true); out.set(bin, b0 + 8);
  return out.buffer;
}

const box = (y0: number, y1: number, half: number): number[] => [-half, y0, -half, half, y0, -half, half, y0, half, -half, y0, half, -half, y1, -half, half, y1, -half, half, y1, half, -half, y1, half];

/** Rotation about X by 30 degrees: the elbow's rest. */
export const ELBOW_REST = [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)] as const;
/** The bend "Wave" reaches at 0.5 s, about Z, in the elbow's own frame (the file stores rest * bend). */
export const WAVE_BEND = Math.PI / 2;

const qmul = (a: readonly number[], b: readonly number[]): number[] => [
  a[0]! * b[3]! + a[3]! * b[0]! + a[1]! * b[2]! - a[2]! * b[1]!,
  a[1]! * b[3]! + a[3]! * b[1]! + a[2]! * b[0]! - a[0]! * b[2]!,
  a[2]! * b[3]! + a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]!,
  a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!,
];

export function armGlb(): ArrayBuffer {
  // Three stacked rings (y = 0, 1, 2) of 4 corners, one ring per joint, joined by side faces.
  const pos = [...box(0, 0, 0.1).slice(0, 12), ...box(1, 1, 0.1).slice(0, 12), ...box(2, 2, 0.1).slice(0, 12)];
  const joints: number[] = [], weights: number[] = [];
  for (let ring = 0; ring < 3; ring++) for (let k = 0; k < 4; k++) { joints.push(ring, 0, 0, 0); weights.push(1, 0, 0, 0); }
  const idx: number[] = [];
  for (let ring = 0; ring < 2; ring++) for (let k = 0; k < 4; k++) {
    const a = ring * 4 + k, b = ring * 4 + ((k + 1) % 4), c = a + 4, d = b + 4;
    idx.push(a, b, c, b, d, c);
  }
  const ibm = [...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1], ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2, 0, 1]];
  const bend = (r: number): number[] => qmul(ELBOW_REST, [0, 0, Math.sin(r / 2), Math.cos(r / 2)]);
  const rotKeys = [...bend(0), ...bend(WAVE_BEND), ...bend(0)];
  const chunks = [f32(pos), u8(joints), f32(weights), u16(idx), f32(ibm), f32([0, 0.5, 1]), f32(rotKeys)];
  return pack(
    {
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [
        { name: 'Armature', children: [1, 4] },
        { name: 'rig:Shoulder', children: [2] },
        { name: 'rig:Elbow', translation: [0, 1, 0], rotation: [...ELBOW_REST], children: [3] },
        { name: 'rig:Wrist', translation: [0, 1, 0] },
        { name: 'ArmMesh', mesh: 0, skin: 0 },
      ],
      skins: [{ joints: [1, 2, 3], inverseBindMatrices: 4, skeleton: 1 }],
      meshes: [{ name: 'Arm', primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, indices: 3, material: 0 }] }],
      materials: [{ name: 'red', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.1, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
      animations: [{ name: 'Wave', samplers: [{ input: 5, output: 6, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 12, type: 'VEC3', min: [-0.1, 0, -0.1], max: [0.1, 2, 0.1] },
        { bufferView: 1, componentType: 5121, count: 12, type: 'VEC4' },
        { bufferView: 2, componentType: 5126, count: 12, type: 'VEC4' },
        { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' },
        { bufferView: 4, componentType: 5126, count: 3, type: 'MAT4' },
        { bufferView: 5, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [1] },
        { bufferView: 6, componentType: 5126, count: 3, type: 'VEC4' },
      ],
    },
    chunks,
  );
}

export function cubeGlb(): ArrayBuffer {
  const p = [-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5];
  const i = [0, 1, 2, 0, 2, 3, 5, 4, 7, 5, 7, 6, 4, 0, 3, 4, 3, 7, 1, 5, 6, 1, 6, 2, 3, 2, 6, 3, 6, 7, 4, 5, 1, 4, 1, 0];
  return pack(
    {
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Cube', mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      materials: [{ name: 'green', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.7, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
        { bufferView: 1, componentType: 5123, count: i.length, type: 'SCALAR' },
      ],
    },
    [f32(p), u16(i)],
  );
}
