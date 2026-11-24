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
pub mod rigid;
pub mod shapes;
pub mod world;

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

/// Points the header at every array TypeScript reads or writes (they may have moved or grown).
pub fn publish_shapes() {
    unsafe {
        let cap = shapes::SH.cap;
        if world::W.dirty.len() < cap {
            world::W.dirty.resize(cap + 64, 0);
        }
        mem::HDR[h::SF] = shapes::SH.sf.as_ptr() as i32;
        mem::HDR[h::SI] = shapes::SH.si.as_ptr() as i32;
        mem::HDR[h::SCAP] = cap as i32;
        mem::HDR[h::RES] = core::ptr::addr_of!(RES) as i32;
        mem::HDR[h::FILT] = core::ptr::addr_of!(world::FILT) as i32;
        mem::HDR[h::DIRTY] = world::W.dirty.as_ptr() as i32;
        mem::HDR[h::DIRTYCAP] = world::W.dirty.len() as i32;
        mem::HDR[h::OUT] = world::W.out.as_ptr() as i32;
        mem::HDR[h::OUTCAP] = world::W.out.capacity() as i32;
        mem::HDR[h::BF] = rigid::RB.bf.as_ptr() as i32;
        mem::HDR[h::BI] = rigid::RB.bi.as_ptr() as i32;
        mem::HDR[h::BCAP] = (rigid::RB.bi.len() / rigid::BI_STRIDE) as i32;
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
        let d = shapes::Data { kind: shapes::K_MESH, a: t, b: n, f: alloc::vec![0.0; t * 12 + n * 6], i: alloc::vec![0; n * 4], h: alloc::vec::Vec::new() };
        mem::HDR[h::UPF] = d.f.as_ptr() as i32;
        mem::HDR[h::UPI] = d.i.as_ptr() as i32;
        mem::bump_epoch();
        sh.put_data(d) as i32
    }
}

/// Room for a height field: UPF points at 5 f64 (cell, x0, z0, y0, scale), UPH at columns * rows f32 heights.
#[no_mangle]
pub extern "C" fn hk_hf_data(columns: i32, rows: i32) -> i32 {
    unsafe {
        let sh = &mut shapes::SH;
        let d = shapes::Data { kind: shapes::K_HEIGHTFIELD, a: columns as usize, b: rows as usize, f: alloc::vec![0.0; 5], i: alloc::vec::Vec::new(), h: alloc::vec![0.0; (columns * rows) as usize] };
        mem::HDR[h::UPF] = d.f.as_ptr() as i32;
        mem::HDR[h::UPH] = d.h.as_ptr() as i32;
        mem::bump_epoch();
        sh.put_data(d) as i32
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

// ---------------------------------------------------------------- the world (world.ts)

/// Starts the world with its broadphase cell size. One instance, one world.
#[no_mangle]
pub extern "C" fn hk_world_init(cell: f64) {
    unsafe {
        world::W.cell = cell;
        world::W.out.reserve(256);
    }
    publish_shapes();
}

/// Files a shape TypeScript has filled in. Returns 0 (kept as a status so the export need not change).
#[no_mangle]
pub extern "C" fn hk_shape_commit(id: i32) -> i32 {
    unsafe {
        world::W.commit(id as usize);
        publish_shapes();
        0
    }
}

#[no_mangle]
pub extern "C" fn hk_shape_remove(id: i32) {
    unsafe { world::W.remove(id as usize) };
}

/// world.ts `cast`: B seeded from RES, the filter from FILT; the best hit back in RES. Returns 0.
#[no_mangle]
pub extern "C" fn hk_cast(ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64) -> i32 {
    unsafe {
        let w = &mut world::W;
        w.flush();
        let fl = world::read_filter();
        b_in();
        w.cast(ox, oy, oz, dx, dy, dz, r, &fl);
        b_out();
        0
    }
}

fn finish_out() -> i32 {
    publish_shapes();
    unsafe { world::W.out.len() as i32 }
}

/// world.ts `gather`: ids into OUT; returns how many.
#[no_mangle]
pub extern "C" fn hk_gather(x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64) -> i32 {
    unsafe {
        let w = &mut world::W;
        w.flush();
        let fl = world::read_filter();
        w.gather(x0, y0, z0, x1, y1, z1, &fl);
        w.out.clear();
        for j in 0..w.cand.len() { let v = w.cand[j]; w.out.push(v); }
    }
    finish_out()
}

/// world.ts `overlapSphere`: ids into OUT.
#[no_mangle]
pub extern "C" fn hk_overlap_sphere(cx: f64, cy: f64, cz: f64, radius: f64) -> i32 {
    unsafe {
        let w = &mut world::W;
        w.flush();
        let fl = world::read_filter();
        w.gather(cx - radius, cy - radius, cz - radius, cx + radius, cy + radius, cz + radius, &fl);
        w.out.clear();
        for j in 0..w.cand.len() {
            let id = w.cand[j];
            if narrow::closest_on(id as usize, cx, cy, cz) <= radius { w.out.push(id); }
        }
    }
    finish_out()
}

/// world.ts `overlapCapsule`, with `n` (spheres along the axis, less one) worked out by TypeScript.
#[no_mangle]
pub extern "C" fn hk_overlap_capsule(ax: f64, ay: f64, az: f64, bx: f64, by: f64, bz: f64, radius: f64, n: i32) -> i32 {
    use math::{max, min};
    unsafe {
        let w = &mut world::W;
        w.flush();
        let fl = world::read_filter();
        w.gather(min(ax, bx) - radius, min(ay, by) - radius, min(az, bz) - radius, max(ax, bx) + radius, max(ay, by) + radius, max(az, bz) + radius, &fl);
        w.out.clear();
        let rr = radius * 1.03;
        let nf = n as f64;
        for j in 0..w.cand.len() {
            let id = w.cand[j];
            for k in 0..=n {
                let u = k as f64 / nf;
                if narrow::closest_on(id as usize, ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u) <= rr {
                    w.out.push(id);
                    break;
                }
            }
        }
    }
    finish_out()
}

/// world.ts `distanceTo`: the distance, with the direction away in RES[9..12].
#[no_mangle]
pub extern "C" fn hk_closest(id: i32, px: f64, py: f64, pz: f64) -> f64 {
    unsafe { world::W.flush() };
    let d = narrow::closest_on(id as usize, px, py, pz);
    c_out();
    d
}

// ---------------------------------------------------------------- rigid bodies (rigid.ts)

#[no_mangle]
pub extern "C" fn hk_body_add(shape: i32) -> i32 {
    let b = unsafe { rigid::RB.add(shape as usize) };
    publish_shapes();
    b as i32
}

#[no_mangle]
pub extern "C" fn hk_body_remove(b: i32) {
    unsafe { rigid::RB.remove(b as usize) };
}

/// One step of the rigid solver, after TypeScript has written the bodies in. Returns 0.
#[no_mangle]
pub extern "C" fn hk_rigid_step(dt: f64, gx: f64, gy: f64, gz: f64, iters: i32) -> i32 {
    unsafe {
        world::W.flush();
        rigid::RB.step(dt, gx, gy, gz, iters);
        0
    }
}

/// Files the shapes TypeScript has moved now, when its dirty list is full before a query comes.
#[no_mangle]
pub extern "C" fn hk_flush() {
    unsafe { world::W.flush() };
}
