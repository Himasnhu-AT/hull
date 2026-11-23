//! Arithmetic with JavaScript's exact semantics, so every function here gives the bits V8 gives. sqrt, floor and
//! ceil are single WebAssembly instructions (IEEE 754 exact, as Math's are); min and max are written out, because
//! Math.min/max propagate NaN and order -0 below +0 while Rust's f64::min/max do neither. Nothing is fused or
//! reordered: Rust does neither without being asked.
//!
//! The three instructions sit behind the unstable `wasm_numeric_instr` feature, so the crate is built with
//! RUSTC_BOOTSTRAP=1 (`pnpm kernels:build` sets it). The alternative, sqrt in software, is the same bits and far slower.
use core::arch::wasm32 as w;

#[inline(always)]
pub fn sqrt(x: f64) -> f64 { w::f64_sqrt(x) }
#[inline(always)]
pub fn floor(x: f64) -> f64 { w::f64_floor(x) }
#[inline(always)]
pub fn ceil(x: f64) -> f64 { w::f64_ceil(x) }
#[inline(always)]
pub fn abs(x: f64) -> f64 { x.abs() }

/// `Math.max(a, b)`: NaN if either is NaN; of two zeros, +0 unless both are -0.
#[inline(always)]
pub fn max(a: f64, b: f64) -> f64 {
    if a != a || b != b {
        return f64::NAN;
    }
    if a > b {
        a
    } else if b > a {
        b
    } else if a == 0.0 && a.is_sign_negative() {
        b
    } else {
        a
    }
}

/// `Math.min(a, b)`: NaN if either is NaN; of two zeros, -0 if either is -0.
#[inline(always)]
pub fn min(a: f64, b: f64) -> f64 {
    if a != a || b != b {
        return f64::NAN;
    }
    if a < b {
        a
    } else if b < a {
        b
    } else if a == 0.0 && b.is_sign_negative() {
        b
    } else {
        a
    }
}

/// `Math.min(a, b, c)`: the same as two in a row, NaN and signed zero included.
#[inline(always)]
pub fn min3(a: f64, b: f64, c: f64) -> f64 { min(min(a, b), c) }
#[inline(always)]
pub fn max3(a: f64, b: f64, c: f64) -> f64 { max(max(a, b), c) }
pub const INF: f64 = f64::INFINITY;
