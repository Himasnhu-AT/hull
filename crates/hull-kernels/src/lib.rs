//! Hull's kernels (plan-rust.md): batch arithmetic over flat arrays, as one WebAssembly module.
//!
//! The boundary is flat numbers in, flat numbers out, a handful of calls a step. Nothing here allocates per call,
//! takes a callback or sees an object: TypeScript holds typed-array views over this module's memory, writes its
//! inputs there and reads the results back from the same place. Plain `extern "C"` exports and no wasm-bindgen,
//! because numbers and offsets need no glue. No standard library either: the module is a few hundred bytes of code.
//!
//! One instance serves one physics world, so the state below is that world's.
//!
//! Kernel 1, the moving-shape grid (`hk_mi_*`): the grid over the bounds of a world's moving shapes, built here
//! from the bounds TypeScript writes. `packages/hull/src/physics/moving.ts` holds the same build in TypeScript
//! (`buildGrid`), which is the fallback and the oracle: the two must fill every array with the same bits, and
//! `moving.parity.test.ts` checks that they do. Only add, subtract, multiply, divide, floor and compare on `f64`
//! are used, which IEEE 754 defines exactly, so they agree with JavaScript.
#![no_std]

use core::arch::wasm32::{memory_grow, memory_size};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    // Nothing here can panic (no bounds checks are left to fail), but the language asks for a handler.
    core::arch::wasm32::unreachable()
}

/// Bumped whenever an export or the layout changes; the TypeScript wrapper refuses a module it does not know.
const ABI: i32 = 1;

// The same constants as moving.ts.
const MAX_CELLS: usize = 16384;
const MAX_SPAN: f64 = 16.0;
const FAR: f64 = 1e12;
const GRID: i32 = 0;
const WIDE: i32 = 1;
// headF
const CS: usize = 0;
const FI0: usize = 1;
const FK0: usize = 2;
// headI
const NI: usize = 0;
const NK: usize = 1;
const NITEMS: usize = 2;
const NOVER: usize = 3;
const NLOOSE: usize = 4;

/// The arrays of the moving-shape grid, in the order they lie in memory. The numbers are what `hk_mi_ptr` takes.
const F_HEADF: usize = 0;
const F_HEADI: usize = 1;
const F_AABB: usize = 2;
const F_RANGE: usize = 3;
const F_STATE: usize = 4;
const F_OVER: usize = 5;
const F_LOOSE: usize = 6;
const F_SEEN: usize = 7;
const F_OUT: usize = 8;
const F_CELLSTART: usize = 9;
const F_CURSOR: usize = 10;
const F_ITEMS: usize = 11;
const FIELDS: usize = 12;

extern "C" {
    /// Set by the linker: the first byte past the module's own data and stack.
    static __heap_base: u8;
}

static mut CAP: usize = 0;
static mut STAMP: i32 = 0;

const fn round8(n: usize) -> usize {
    (n + 7) & !7
}

/// Byte size of each array for `cap` slots. The bounds come first after the two heads, so they stay where they are
/// when the capacity grows and need no copying.
fn sizes(cap: usize) -> [usize; FIELDS] {
    [
        4 * 8,
        8 * 4,
        cap * 6 * 8,
        cap * 4 * 4,
        round8(cap * 4),
        round8(cap * 4),
        round8(cap * 4),
        round8(cap * 4),
        round8(cap * 4),
        round8((MAX_CELLS + 1) * 4),
        round8(MAX_CELLS * 4),
        round8(cap * 16 * 4),
    ]
}

fn base() -> usize {
    round8(core::ptr::addr_of!(__heap_base) as usize)
}

fn offset(field: usize, cap: usize) -> usize {
    let s = sizes(cap);
    let mut at = base();
    let mut i = 0;
    while i < field {
        at += s[i];
        i += 1;
    }
    at
}

#[inline(always)]
unsafe fn f64s(field: usize) -> *mut f64 {
    offset(field, CAP) as *mut f64
}

#[inline(always)]
unsafe fn i32s(field: usize) -> *mut i32 {
    offset(field, CAP) as *mut i32
}

/// Not in `core` on every toolchain, and exact either way: the largest whole number not above `x`.
#[inline(always)]
fn floor(x: f64) -> f64 {
    // Past 2^52 every double is whole already (and this also passes infinities and NaN through, as Math.floor does).
    if !(x > -4503599627370496.0 && x < 4503599627370496.0) {
        return x;
    }
    let t = x as i64 as f64;
    if t == x {
        // Already whole: hand back x itself, so that -0 stays -0 as it does in Math.floor.
        x
    } else if t > x {
        t - 1.0
    } else {
        t
    }
}

#[no_mangle]
pub extern "C" fn hk_abi() -> i32 {
    ABI
}

/// Makes room for `cap` slots. Returns 1, or 0 when the memory cannot grow (the caller then stays in TypeScript).
/// The bounds of slots already written stay valid; everything else is rebuilt by the next `hk_mi_build`.
#[no_mangle]
pub extern "C" fn hk_mi_reserve(cap: i32) -> i32 {
    if cap <= 0 {
        return 0;
    }
    let cap = cap as usize;
    let end = offset(FIELDS, cap);
    let have = memory_size(0) * 65536;
    if end > have {
        let pages = (end - have + 65535) / 65536;
        if memory_grow(0, pages) == usize::MAX {
            return 0;
        }
    }
    unsafe {
        CAP = cap;
    }
    1
}

/// Where an array starts, for the capacity last reserved. TypeScript makes its views from these after every reserve.
#[no_mangle]
pub extern "C" fn hk_mi_ptr(field: i32) -> i32 {
    if field < 0 || field as usize >= FIELDS {
        return 0;
    }
    offset(field as usize, unsafe { CAP }) as i32
}

/// Files slots 0 to n - 1 into a grid of `cell`-sized cells. The mirror of `buildGrid` in moving.ts, line for line.
#[no_mangle]
pub extern "C" fn hk_mi_build(n: i32, cell: f64) {
    unsafe {
        let n = n as usize;
        let a = f64s(F_AABB);
        let range = i32s(F_RANGE);
        let state = i32s(F_STATE);
        let over = i32s(F_OVER);
        let start = i32s(F_CELLSTART);
        let cur = i32s(F_CURSOR);
        let items = i32s(F_ITEMS);
        let head_f = f64s(F_HEADF);
        let head_i = i32s(F_HEADI);

        let mut lox = f64::INFINITY;
        let mut hix = f64::NEG_INFINITY;
        let mut loz = f64::INFINITY;
        let mut hiz = f64::NEG_INFINITY;
        for i in 0..n {
            let o = i * 6;
            let x0 = *a.add(o);
            let z0 = *a.add(o + 2);
            let x1 = *a.add(o + 3);
            let z1 = *a.add(o + 5);
            if x0 >= -FAR && x1 <= FAR && z0 >= -FAR && z1 <= FAR && x1 >= x0 && z1 >= z0 {
                *state.add(i) = GRID;
                if x0 < lox {
                    lox = x0;
                }
                if x1 > hix {
                    hix = x1;
                }
                if z0 < loz {
                    loz = z0;
                }
                if z1 > hiz {
                    hiz = z1;
                }
            } else {
                *state.add(i) = WIDE;
            }
        }

        let mut cs = cell;
        let mut fi0 = 0.0;
        let mut fk0 = 0.0;
        let mut ni: usize = 0;
        let mut nk: usize = 0;
        if lox <= hix {
            loop {
                fi0 = floor(lox / cs);
                fk0 = floor(loz / cs);
                let w = floor(hix / cs) - fi0 + 1.0;
                let d = floor(hiz / cs) - fk0 + 1.0;
                if w * d <= MAX_CELLS as f64 {
                    ni = w as usize;
                    nk = d as usize;
                    break;
                }
                cs *= 2.0;
            }
        }
        let cells = ni * nk;
        for c in 0..=cells {
            *start.add(c) = 0;
        }
        let mut n_over = 0usize;
        for i in 0..n {
            if *state.add(i) != GRID {
                *over.add(n_over) = i as i32;
                n_over += 1;
                continue;
            }
            let o = i * 6;
            let a0 = floor(*a.add(o) / cs) - fi0;
            let a1 = floor(*a.add(o + 3) / cs) - fi0;
            let c0 = floor(*a.add(o + 2) / cs) - fk0;
            let c1 = floor(*a.add(o + 5) / cs) - fk0;
            if (a1 - a0 + 1.0) * (c1 - c0 + 1.0) > MAX_SPAN {
                *state.add(i) = WIDE;
                *over.add(n_over) = i as i32;
                n_over += 1;
                continue;
            }
            let r = i * 4;
            let (a0, a1, c0, c1) = (a0 as i32, a1 as i32, c0 as i32, c1 as i32);
            *range.add(r) = a0;
            *range.add(r + 1) = a1;
            *range.add(r + 2) = c0;
            *range.add(r + 3) = c1;
            let mut x = a0;
            while x <= a1 {
                let mut z = c0;
                while z <= c1 {
                    *start.add(x as usize * nk + z as usize + 1) += 1;
                    z += 1;
                }
                x += 1;
            }
        }
        for c in 0..cells {
            *start.add(c + 1) += *start.add(c);
            *cur.add(c) = *start.add(c);
        }
        for i in 0..n {
            if *state.add(i) != GRID {
                continue;
            }
            let r = i * 4;
            let (a0, a1, c0, c1) = (*range.add(r), *range.add(r + 1), *range.add(r + 2), *range.add(r + 3));
            let mut x = a0;
            while x <= a1 {
                let mut z = c0;
                while z <= c1 {
                    let c = x as usize * nk + z as usize;
                    *items.add(*cur.add(c) as usize) = i as i32;
                    *cur.add(c) += 1;
                    z += 1;
                }
                x += 1;
            }
        }
        *head_f.add(CS) = cs;
        *head_f.add(FI0) = fi0;
        *head_f.add(FK0) = fk0;
        *head_i.add(NI) = ni as i32;
        *head_i.add(NK) = nk as i32;
        *head_i.add(NITEMS) = *start.add(cells);
        *head_i.add(NOVER) = n_over as i32;
        *head_i.add(NLOOSE) = 0;
    }
}

#[inline(always)]
unsafe fn outside(a: *const f64, i: usize, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64) -> bool {
    let o = i * 6;
    *a.add(o) > x1 || *a.add(o + 3) < x0 || *a.add(o + 1) > y1 || *a.add(o + 4) < y0 || *a.add(o + 2) > z1 || *a.add(o + 5) < z0
}

/// The slots among 0 to n - 1 whose bounds meet the box, written to `out` in rising order; returns how many.
/// The mirror of `MovingIndex.box` in moving.ts for a grid that is built. A query a call is more calls a step than
/// the boundary allows, so the engine does not use this: it reads the grid from TypeScript. It exists so the bench
/// can time the kernel doing the whole query, and so that answer can be checked against TypeScript too.
#[no_mangle]
pub extern "C" fn hk_mi_query(n: i32, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64) -> i32 {
    unsafe {
        let n = n as usize;
        let a = f64s(F_AABB) as *const f64;
        let out = i32s(F_OUT);
        let mut m = 0usize;
        let linear = |m: &mut usize| {
            for i in 0..n {
                if outside(a, i, x0, y0, z0, x1, y1, z1) {
                    continue;
                }
                *out.add(*m) = i as i32;
                *m += 1;
            }
        };
        if n == 0 {
            return 0;
        }
        if x0 != x0 || x1 != x1 || z0 != z0 || z1 != z1 {
            linear(&mut m);
            return m as i32;
        }
        let head_f = f64s(F_HEADF);
        let head_i = i32s(F_HEADI);
        let cs = *head_f.add(CS);
        let ni = *head_i.add(NI) as f64;
        let nk = *head_i.add(NK) as f64;
        let mut a0 = floor(x0 / cs) - *head_f.add(FI0);
        let mut a1 = floor(x1 / cs) - *head_f.add(FI0);
        let mut c0 = floor(z0 / cs) - *head_f.add(FK0);
        let mut c1 = floor(z1 / cs) - *head_f.add(FK0);
        if a0 < 0.0 {
            a0 = 0.0;
        }
        if c0 < 0.0 {
            c0 = 0.0;
        }
        if a1 > ni - 1.0 {
            a1 = ni - 1.0;
        }
        if c1 > nk - 1.0 {
            c1 = nk - 1.0;
        }
        if a1 >= a0 && c1 >= c0 && (a1 - a0 + 1.0) * (c1 - c0 + 1.0) > n as f64 {
            linear(&mut m);
            return m as i32;
        }
        let seen = i32s(F_SEEN);
        if STAMP == i32::MAX {
            for i in 0..CAP {
                *seen.add(i) = 0;
            }
            STAMP = 0;
        }
        STAMP += 1;
        let stamp = STAMP;
        let start = i32s(F_CELLSTART);
        let items = i32s(F_ITEMS);
        let nk = nk as usize;
        if a1 >= a0 && c1 >= c0 {
            let (a0, a1, c0, c1) = (a0 as usize, a1 as usize, c0 as usize, c1 as usize);
            for x in a0..=a1 {
                for z in c0..=c1 {
                    let c = x * nk + z;
                    let mut j = *start.add(c) as usize;
                    let end = *start.add(c + 1) as usize;
                    while j < end {
                        let i = *items.add(j) as usize;
                        j += 1;
                        if *seen.add(i) == stamp {
                            continue;
                        }
                        *seen.add(i) = stamp;
                        if outside(a, i, x0, y0, z0, x1, y1, z1) {
                            continue;
                        }
                        *out.add(m) = i as i32;
                        m += 1;
                    }
                }
            }
        }
        let over = i32s(F_OVER);
        for j in 0..*head_i.add(NOVER) as usize {
            let i = *over.add(j) as usize;
            if outside(a, i, x0, y0, z0, x1, y1, z1) {
                continue;
            }
            *out.add(m) = i as i32;
            m += 1;
        }
        let loose = i32s(F_LOOSE);
        for j in 0..*head_i.add(NLOOSE) as usize {
            let i = *loose.add(j) as usize;
            if *seen.add(i) == stamp || outside(a, i, x0, y0, z0, x1, y1, z1) {
                continue;
            }
            *out.add(m) = i as i32;
            m += 1;
        }
        // Back into rising order, as moving.ts does it.
        let mut j = 1;
        while j < m {
            let v = *out.add(j);
            let mut k = j;
            while k > 0 && *out.add(k - 1) > v {
                *out.add(k) = *out.add(k - 1);
                k -= 1;
            }
            *out.add(k) = v;
            j += 1;
        }
        m as i32
    }
}
