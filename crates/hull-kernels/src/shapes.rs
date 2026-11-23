//! The shape table: every shape of the world, static or moving, by id. TypeScript computes a shape's pose (its
//! `Shape.setMatrix`) and writes the numbers here; the kernel reads them for queries, and writes them itself only
//! for rigid bodies it moves (`set_pose`). Field numbers are the same in `packages/hull/src/physics/kernel.ts`.
use alloc::vec::Vec;

/// f64 fields of a shape, `SF_STRIDE` a shape.
pub const SF_STRIDE: usize = 48;
pub const CX: usize = 0;
pub const CY: usize = 1;
pub const CZ: usize = 2;
pub const AX: usize = 3;
pub const AY: usize = 4;
pub const AZ: usize = 5;
pub const BX: usize = 6;
pub const BY: usize = 7;
pub const BZ: usize = 8;
pub const R: usize = 9;
pub const HX: usize = 10;
pub const HY: usize = 11;
pub const HZ: usize = 12;
/// Box axes in world space, 9 numbers from here: U..U+3 local X, U+3..U+6 local Y, U+6..U+9 local Z.
pub const U: usize = 13;
pub const PLANE_Y: usize = 22;
pub const MINX: usize = 23;
pub const MINY: usize = 24;
pub const MINZ: usize = 25;
pub const MAXX: usize = 26;
pub const MAXY: usize = 27;
pub const MAXZ: usize = 28;
pub const LCX: usize = 29;
pub const LCY: usize = 30;
pub const LCZ: usize = 31;
pub const LAX: usize = 32;
pub const LAY: usize = 33;
pub const LAZ: usize = 34;
pub const LBX: usize = 35;
pub const LBY: usize = 36;
pub const LBZ: usize = 37;
pub const LR: usize = 38;
pub const LHX: usize = 39;
pub const LHY: usize = 40;
pub const LHZ: usize = 41;

/// i32 fields of a shape, `SI_STRIDE` a shape.
pub const SI_STRIDE: usize = 12;
pub const KIND: usize = 0;
pub const LAYER: usize = 1;
pub const MASK: usize = 2;
pub const FLAGS: usize = 3;
/// Interned tag string (TypeScript keeps the strings); 0 is ''.
pub const TAG: usize = 4;
/// Interned node, 0 for none.
pub const NODE: usize = 5;
/// Index into the data table (mesh or heightfield), -1 for none.
pub const DATA: usize = 6;
/// Rigid body index, -1 for none.
pub const RB: usize = 7;
/// Slot in the moving index, -1 for a static shape.
pub const SLOT: usize = 8;
pub const STAMP: usize = 9;
/// Where the shape lives: `WHERE_FREE`, `WHERE_GRID`, `WHERE_BIG` or `WHERE_MOVING`.
pub const WHERE: usize = 10;

pub const F_ENABLED: i32 = 1;
pub const F_TRIGGER: i32 = 2;
pub const F_STATIC: i32 = 4;
pub const F_AA: i32 = 8;
pub const F_DIRTY: i32 = 16;

pub const WHERE_FREE: i32 = 0;
pub const WHERE_GRID: i32 = 1;
pub const WHERE_BIG: i32 = 2;
pub const WHERE_MOVING: i32 = 3;
pub const WHERE_PENDING: i32 = 4;

/// Shape kinds, as `K` in shape.ts.
pub const K_SPHERE: i32 = 0;
pub const K_CAPSULE: i32 = 1;
pub const K_BOX: i32 = 2;
pub const K_MESH: i32 = 3;
pub const K_PLANE: i32 = 4;
pub const K_HEIGHTFIELD: i32 = 5;

/// A static mesh or height field's numbers, in the world's data arenas.
#[derive(Clone, Copy)]
pub struct Data {
    pub kind: i32,
    /// Mesh: triangles and BVH nodes. Height field: columns and rows.
    pub a: usize,
    pub b: usize,
    /// Offsets into `fdata` (f64), `idata` (i32) and `hdata` (f32).
    pub f: usize,
    pub i: usize,
    pub h: usize,
}

/// A mesh's arrays (mesh.ts `MeshData`): v 9 a triangle, n 3 a triangle, bb 6 a node; left, right, first, count.
#[derive(Clone, Copy)]
pub struct MeshRef {
    pub tris: usize,
    pub nodes: usize,
    pub v: *const f64,
    pub n: *const f64,
    pub bb: *const f64,
    pub left: *const i32,
    pub right: *const i32,
    pub first: *const i32,
    pub count: *const i32,
}

/// A height field (shape.ts `HeightField`): heights are f32, read as f64 as JavaScript reads a Float32Array.
#[derive(Clone, Copy)]
pub struct HfRef {
    pub h: *const f32,
    pub columns: i32,
    pub rows: i32,
    pub cell: f64,
    pub x0: f64,
    pub z0: f64,
    pub y0: f64,
    pub scale: f64,
}

pub struct Shapes {
    pub sf: Vec<f64>,
    pub si: Vec<i32>,
    pub cap: usize,
    pub free: Vec<i32>,
    pub data: Vec<Data>,
    pub fdata: Vec<f64>,
    pub idata: Vec<i32>,
    pub hdata: Vec<f32>,
}

impl Shapes {
    pub const fn new() -> Self {
        Shapes { sf: Vec::new(), si: Vec::new(), cap: 0, free: Vec::new(), data: Vec::new(), fdata: Vec::new(), idata: Vec::new(), hdata: Vec::new() }
    }

    /// A free id, the tables grown when there is none.
    pub fn alloc(&mut self) -> usize {
        if let Some(id) = self.free.pop() {
            return id as usize;
        }
        let id = self.cap;
        self.cap += 1;
        self.sf.resize(self.cap * SF_STRIDE, 0.0);
        self.si.resize(self.cap * SI_STRIDE, 0);
        crate::mem::bump_epoch();
        id
    }
}

pub static mut SH: Shapes = Shapes::new();

#[inline(always)]
pub fn f(id: usize, field: usize) -> f64 {
    unsafe { *SH.sf.get_unchecked(id * SF_STRIDE + field) }
}
#[inline(always)]
pub fn set_f(id: usize, field: usize, v: f64) {
    unsafe { *SH.sf.get_unchecked_mut(id * SF_STRIDE + field) = v }
}
#[inline(always)]
pub fn i(id: usize, field: usize) -> i32 {
    unsafe { *SH.si.get_unchecked(id * SI_STRIDE + field) }
}
#[inline(always)]
pub fn set_i(id: usize, field: usize, v: i32) {
    unsafe { *SH.si.get_unchecked_mut(id * SI_STRIDE + field) = v }
}
#[inline(always)]
pub fn kind(id: usize) -> i32 {
    i(id, KIND)
}
#[inline(always)]
pub fn flag(id: usize, bit: i32) -> bool {
    i(id, FLAGS) & bit != 0
}

pub fn mesh(id: usize) -> MeshRef {
    unsafe {
        let d = SH.data[i(id, DATA) as usize];
        let (t, n) = (d.a, d.b);
        let fp = SH.fdata.as_ptr().add(d.f);
        let ip = SH.idata.as_ptr().add(d.i);
        MeshRef { tris: t, nodes: n, v: fp, n: fp.add(t * 9), bb: fp.add(t * 12), left: ip, right: ip.add(n), first: ip.add(2 * n), count: ip.add(3 * n) }
    }
}

pub fn hf(id: usize) -> HfRef {
    unsafe {
        let d = SH.data[i(id, DATA) as usize];
        let fp = SH.fdata.as_ptr().add(d.f);
        HfRef { h: SH.hdata.as_ptr().add(d.h), columns: d.a as i32, rows: d.b as i32, cell: *fp, x0: *fp.add(1), z0: *fp.add(2), y0: *fp.add(3), scale: *fp.add(4) }
    }
}

/// Column-major 4x4 from a position and a unit quaternion: shape.ts `fromPose`.
pub fn from_pose(px: f64, py: f64, pz: f64, qx: f64, qy: f64, qz: f64, qw: f64, e: &mut [f64; 16]) {
    let x2 = qx + qx;
    let y2 = qy + qy;
    let z2 = qz + qz;
    let xx = qx * x2;
    let xy = qx * y2;
    let xz = qx * z2;
    let yy = qy * y2;
    let yz = qy * z2;
    let zz = qz * z2;
    let wx = qw * x2;
    let wy = qw * y2;
    let wz = qw * z2;
    e[0] = 1.0 - (yy + zz);
    e[1] = xy + wz;
    e[2] = xz - wy;
    e[3] = 0.0;
    e[4] = xy - wz;
    e[5] = 1.0 - (xx + zz);
    e[6] = yz + wx;
    e[7] = 0.0;
    e[8] = xz + wy;
    e[9] = yz - wx;
    e[10] = 1.0 - (xx + yy);
    e[11] = 0.0;
    e[12] = px;
    e[13] = py;
    e[14] = pz;
    e[15] = 1.0;
}

/// shape.ts `setMatrix` for the kinds a rigid body can be (sphere and box), and a capsule for completeness.
pub fn set_matrix(id: usize, e: &[f64; 16]) {
    use crate::math::{abs, max3, min, max, sqrt};
    let sx = sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
    let sy = sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
    let sz = sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
    match kind(id) {
        K_SPHERE => {
            let (lx, ly, lz) = (f(id, LCX), f(id, LCY), f(id, LCZ));
            let cx = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
            let cy = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
            let cz = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
            let r = f(id, LR) * max3(sx, sy, sz);
            set_f(id, CX, cx);
            set_f(id, CY, cy);
            set_f(id, CZ, cz);
            set_f(id, R, r);
            set_f(id, MINX, cx - r);
            set_f(id, MAXX, cx + r);
            set_f(id, MINY, cy - r);
            set_f(id, MAXY, cy + r);
            set_f(id, MINZ, cz - r);
            set_f(id, MAXZ, cz + r);
        }
        K_CAPSULE => {
            let (lax, lay, laz, lbx, lby, lbz) = (f(id, LAX), f(id, LAY), f(id, LAZ), f(id, LBX), f(id, LBY), f(id, LBZ));
            let ax = e[0] * lax + e[4] * lay + e[8] * laz + e[12];
            let ay = e[1] * lax + e[5] * lay + e[9] * laz + e[13];
            let az = e[2] * lax + e[6] * lay + e[10] * laz + e[14];
            let bx = e[0] * lbx + e[4] * lby + e[8] * lbz + e[12];
            let by = e[1] * lbx + e[5] * lby + e[9] * lbz + e[13];
            let bz = e[2] * lbx + e[6] * lby + e[10] * lbz + e[14];
            let r = f(id, LR) * max3(sx, sy, sz);
            set_f(id, AX, ax);
            set_f(id, AY, ay);
            set_f(id, AZ, az);
            set_f(id, BX, bx);
            set_f(id, BY, by);
            set_f(id, BZ, bz);
            set_f(id, R, r);
            set_f(id, MINX, min(ax, bx) - r);
            set_f(id, MAXX, max(ax, bx) + r);
            set_f(id, MINY, min(ay, by) - r);
            set_f(id, MAXY, max(ay, by) + r);
            set_f(id, MINZ, min(az, bz) - r);
            set_f(id, MAXZ, max(az, bz) + r);
        }
        K_BOX => {
            let (lx, ly, lz) = (f(id, LCX), f(id, LCY), f(id, LCZ));
            let cx = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
            let cy = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
            let cz = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
            let hx = f(id, LHX) * sx;
            let hy = f(id, LHY) * sy;
            let hz = f(id, LHZ) * sz;
            set_f(id, CX, cx);
            set_f(id, CY, cy);
            set_f(id, CZ, cz);
            set_f(id, HX, hx);
            set_f(id, HY, hy);
            set_f(id, HZ, hz);
            let u = [e[0] / sx, e[1] / sx, e[2] / sx, e[4] / sy, e[5] / sy, e[6] / sy, e[8] / sz, e[9] / sz, e[10] / sz];
            for k in 0..9 {
                set_f(id, U + k, u[k]);
            }
            let aa = abs(u[0]) > 1.0 - 1e-9 && abs(u[4]) > 1.0 - 1e-9 && abs(u[8]) > 1.0 - 1e-9;
            let fl = i(id, FLAGS);
            set_i(id, FLAGS, if aa { fl | F_AA } else { fl & !F_AA });
            let ex = if aa { hx } else { abs(u[0]) * hx + abs(u[3]) * hy + abs(u[6]) * hz };
            let ey = if aa { hy } else { abs(u[1]) * hx + abs(u[4]) * hy + abs(u[7]) * hz };
            let ez = if aa { hz } else { abs(u[2]) * hx + abs(u[5]) * hy + abs(u[8]) * hz };
            set_f(id, MINX, cx - ex);
            set_f(id, MAXX, cx + ex);
            set_f(id, MINY, cy - ey);
            set_f(id, MAXY, cy + ey);
            set_f(id, MINZ, cz - ez);
            set_f(id, MAXZ, cz + ez);
        }
        _ => {}
    }
}
