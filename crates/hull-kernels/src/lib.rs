//! Hull's kernels (plan-rust.md): the whole physics world of `hull/physics` as one WebAssembly module.
//!
//! TypeScript keeps the API, the `Shape` objects and their poses, and writes the numbers here through typed-array
//! views over this module's memory; queries and the rigid solver run here. Every answer is the one the TypeScript
//! implementation gives, bit for bit: the same arithmetic in the same order (math.rs), the same candidate order, the
//! same tie rule. The TypeScript implementation stays as the fallback and as the oracle the parity tests use.
//!
//! One instance serves one physics world, so the state in each module below is that world's.
#![no_std]
#![feature(wasm_numeric_instr)]
#![allow(static_mut_refs)]
#![allow(clippy::too_many_arguments)]

extern crate alloc;

pub mod dda;
pub mod math;
pub mod mem;
pub mod narrow;
pub mod shapes;

#[global_allocator]
static ALLOC: mem::Bump = mem::Bump;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    // A trap reaches TypeScript as a WebAssembly.RuntimeError: the world drops the kernel and carries on in TypeScript.
    core::arch::wasm32::unreachable()
}

/// Bumped whenever an export or the layout changes; the TypeScript side refuses a module it does not know.
const ABI: i32 = 2;

#[no_mangle]
pub extern "C" fn hk_abi() -> i32 {
    ABI
}

#[no_mangle]
pub extern "C" fn hk_hdr() -> i32 {
    core::ptr::addr_of!(mem::HDR) as i32
}

// ---------------------------------------------------------------- the header, results and uploads

/// Header slots (`mem::HDR`), the same numbers as `H` in packages/hull/src/physics/kernel.ts.
pub mod h {
    pub const EPOCH: usize = 0;
    pub const SF: usize = 1;
    pub const SI: usize = 2;
    pub const SCAP: usize = 3;
    pub const RES: usize = 4;
    pub const FILT: usize = 5;
    pub const OUT: usize = 6;
    pub const OUTCAP: usize = 7;
    pub const UPF: usize = 8;
    pub const UPI: usize = 9;
    pub const UPH: usize = 10;
    pub const DIRTY: usize = 11;
    pub const NDIRTY: usize = 12;
    pub const DIRTYCAP: usize = 13;
    pub const BF: usize = 14;
    pub const BI: usize = 15;
    pub const BCAP: usize = 16;
}

/// Results TypeScript reads and seeds: 0..7 the sweep's best (t, nx, ny, nz, shape id, inside, depth),
/// 8..12 the closest point (dist, nx, ny, nz). Fixed in the data segment.
pub static mut RES: [f64; 16] = [0.0; 16];
pub const R_T: usize = 0;
pub const R_SHAPE: usize = 4;
pub const R_INSIDE: usize = 5;
pub const R_DEPTH: usize = 6;
pub const R_DIST: usize = 8;

/// Seeds narrow::B from RES (TypeScript's B before a cast).
pub fn b_in() {
    unsafe {
        let b = &mut narrow::B;
        b.t = RES[0];
        b.nx = RES[1];
        b.ny = RES[2];
        b.nz = RES[3];
        b.shape = RES[4] as i32;
        b.inside = RES[5] != 0.0;
        b.depth = RES[6];
    }
}

/// Writes narrow::B back to RES.
pub fn b_out() {
    unsafe {
        let b = &narrow::B;
        RES[0] = b.t;
        RES[1] = b.nx;
        RES[2] = b.ny;
        RES[3] = b.nz;
        RES[4] = b.shape as f64;
        RES[5] = if b.inside { 1.0 } else { 0.0 };
        RES[6] = b.depth;
    }
}

pub fn c_out() {
    unsafe {
        let c = &narrow::C;
        RES[8] = c.dist;
        RES[9] = c.nx;
        RES[10] = c.ny;
        RES[11] = c.nz;
    }
}

/// Points the header at the shape tables again (they may have moved).
pub fn publish_shapes() {
    unsafe {
        mem::HDR[h::SF] = shapes::SH.sf.as_ptr() as i32;
        mem::HDR[h::SI] = shapes::SH.si.as_ptr() as i32;
        mem::HDR[h::SCAP] = shapes::SH.cap as i32;
        mem::HDR[h::RES] = core::ptr::addr_of!(RES) as i32;
    }
}

/// A new shape of `kind`: its id. TypeScript then writes its fields and calls `hk_shape_commit`.
#[no_mangle]
pub extern "C" fn hk_shape_new(kind: i32) -> i32 {
    use shapes as s;
    let id = unsafe { s::SH.alloc() };
    unsafe {
        let sf = &mut s::SH.sf[id * s::SF_STRIDE..(id + 1) * s::SF_STRIDE];
        for v in sf.iter_mut() {
            *v = 0.0;
        }
        let si = &mut s::SH.si[id * s::SI_STRIDE..(id + 1) * s::SI_STRIDE];
        for v in si.iter_mut() {
            *v = 0;
        }
    }
    s::set_i(id, s::KIND, kind);
    s::set_i(id, s::DATA, -1);
    s::set_i(id, s::RB, -1);
    s::set_i(id, s::SLOT, -1);
    s::set_i(id, s::WHERE, s::WHERE_PENDING);
    publish_shapes();
    id as i32
}

/// Room for a mesh's numbers; the header's UPF and UPI point where TypeScript writes them (f64: v, n, bb;
/// i32: left, right, first, count). Returns the data index for the shape's DATA field.
#[no_mangle]
pub extern "C" fn hk_mesh_data(tris: i32, nodes: i32) -> i32 {
    unsafe {
        let sh = &mut shapes::SH;
        let (t, n) = (tris as usize, nodes as usize);
        let f = sh.fdata.len();
        let i = sh.idata.len();
        sh.fdata.resize(f + t * 12 + n * 6, 0.0);
        sh.idata.resize(i + n * 4, 0);
        sh.data.push(shapes::Data { kind: shapes::K_MESH, a: t, b: n, f, i, h: 0 });
        mem::bump_epoch();
        mem::HDR[h::UPF] = sh.fdata.as_ptr().add(f) as i32;
        mem::HDR[h::UPI] = sh.idata.as_ptr().add(i) as i32;
        (sh.data.len() - 1) as i32
    }
}

/// Room for a height field: UPF points at 5 f64 (cell, x0, z0, y0, scale), UPH at columns * rows f32 heights.
#[no_mangle]
pub extern "C" fn hk_hf_data(columns: i32, rows: i32) -> i32 {
    unsafe {
        let sh = &mut shapes::SH;
        let f = sh.fdata.len();
        let hh = sh.hdata.len();
        sh.fdata.resize(f + 5, 0.0);
        sh.hdata.resize(hh + (columns * rows) as usize, 0.0);
        sh.data.push(shapes::Data { kind: shapes::K_HEIGHTFIELD, a: columns as usize, b: rows as usize, f, i: 0, h: hh });
        mem::bump_epoch();
        mem::HDR[h::UPF] = sh.fdata.as_ptr().add(f) as i32;
        mem::HDR[h::UPH] = sh.hdata.as_ptr().add(hh) as i32;
        (sh.data.len() - 1) as i32
    }
}

// ---------------------------------------------------------------- narrow phase, one shape at a time (for tests)

/// narrow.ts `sweepShape` on one shape, with B seeded from RES and written back to it.
#[no_mangle]
pub extern "C" fn hk_t_sweep(id: i32, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64) {
    b_in();
    narrow::sweep_shape(id as usize, ox, oy, oz, dx, dy, dz, r);
    b_out();
}

/// narrow.ts `closestOn` on one shape; C goes to RES[8..12].
#[no_mangle]
pub extern "C" fn hk_t_closest(id: i32, px: f64, py: f64, pz: f64) -> f64 {
    let d = narrow::closest_on(id as usize, px, py, pz);
    c_out();
    d
}

/// narrow.ts `rayAabb`.
#[no_mangle]
pub extern "C" fn hk_t_ray_aabb(ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64, tmax: f64) -> i32 {
    narrow::ray_aabb(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1, tmax) as i32
}
