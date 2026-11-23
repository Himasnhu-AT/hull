//! narrow.ts in Rust, operation for operation: the same arithmetic in the same order, so every answer has the same bits
//! (math.rs gives JavaScript's sqrt, floor, ceil, abs). Shapes are ids into the shape table (shapes.rs); the shape
//! in B is an id, -1 for none. The scratch of the TypeScript (T, CP, the stack, the box locals) is static or a local
//! array here, so nothing allocates.
use crate::dda::Dda;
use crate::math::{abs, ceil, floor, sqrt};
use crate::shapes::{
    f, flag, hf, kind, mesh, HfRef, AX, AY, AZ, BX, BY, BZ, CX, CY, CZ, F_AA, HX, HY, HZ, K_BOX, K_CAPSULE, K_HEIGHTFIELD, K_MESH, K_PLANE,
    K_SPHERE, PLANE_Y, R, U,
};

/// The best hit of the sweep in progress (narrow.ts `B`). `shape` is a shape id, -1 for none.
pub struct Best {
    pub t: f64,
    pub nx: f64,
    pub ny: f64,
    pub nz: f64,
    pub shape: i32,
    pub inside: bool,
    pub depth: f64,
}

/// The closest-point result (narrow.ts `C`).
pub struct Closest {
    pub dist: f64,
    pub nx: f64,
    pub ny: f64,
    pub nz: f64,
}

struct Tres {
    t: f64,
    nx: f64,
    ny: f64,
    nz: f64,
    inside: bool,
    depth: f64,
}

pub static mut B: Best = Best { t: 0.0, nx: 0.0, ny: 0.0, nz: 0.0, shape: -1, inside: false, depth: 0.0 };
pub static mut C: Closest = Closest { dist: 0.0, nx: 0.0, ny: 1.0, nz: 0.0 };
static mut T: Tres = Tres { t: 0.0, nx: 0.0, ny: 0.0, nz: 0.0, inside: false, depth: 0.0 };
/// Closest point on a triangle (narrow.ts CP).
static mut CP: [f64; 3] = [0.0; 3];
static mut STACK: [i32; 128] = [0; 128];
static mut HV: [f64; 9] = [0.0; 9];
static mut HN: [f64; 3] = [0.0; 3];
static mut HF_DDA: Dda = Dda::new();

#[inline(always)]
fn b() -> &'static mut Best {
    unsafe { &mut B }
}
#[inline(always)]
fn c() -> &'static mut Closest {
    unsafe { &mut C }
}
#[inline(always)]
fn t() -> &'static mut Tres {
    unsafe { &mut T }
}
#[inline(always)]
fn rd(p: *const f64, k: usize) -> f64 {
    unsafe { *p.add(k) }
}

pub fn begin_sweep(max_t: f64) {
    let b = b();
    b.t = max_t;
    b.shape = -1;
    b.inside = false;
    b.depth = 0.0;
}

fn offer(tt: f64, nx: f64, ny: f64, nz: f64, sid: i32, inside: bool, depth: f64) {
    let b = b();
    if tt < b.t || (b.shape == -1 && tt <= b.t) {
        b.t = tt;
        b.nx = nx;
        b.ny = ny;
        b.nz = nz;
        b.shape = sid;
        b.inside = inside;
        b.depth = depth;
    }
}

fn offer_t(sid: i32) {
    let t = t();
    offer(t.t, t.nx, t.ny, t.nz, sid, t.inside, t.depth);
}

/// Ray against an axis-aligned box, only the parameter range [0, tmax].
pub fn ray_aabb(ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64, tmax: f64) -> bool {
    let mut t0 = 0.0;
    let mut t1 = tmax;
    if dx > 1e-12 || dx < -1e-12 {
        let mut a = (x0 - ox) / dx;
        let mut b = (x1 - ox) / dx;
        if a > b {
            let c = a;
            a = b;
            b = c;
        }
        if a > t0 {
            t0 = a;
        }
        if b < t1 {
            t1 = b;
        }
        if t0 > t1 {
            return false;
        }
    } else if ox < x0 || ox > x1 {
        return false;
    }
    if dy > 1e-12 || dy < -1e-12 {
        let mut a = (y0 - oy) / dy;
        let mut b = (y1 - oy) / dy;
        if a > b {
            let c = a;
            a = b;
            b = c;
        }
        if a > t0 {
            t0 = a;
        }
        if b < t1 {
            t1 = b;
        }
        if t0 > t1 {
            return false;
        }
    } else if oy < y0 || oy > y1 {
        return false;
    }
    if dz > 1e-12 || dz < -1e-12 {
        let mut a = (z0 - oz) / dz;
        let mut b = (z1 - oz) / dz;
        if a > b {
            let c = a;
            a = b;
            b = c;
        }
        if a > t0 {
            t0 = a;
        }
        if b < t1 {
            t1 = b;
        }
        if t0 > t1 {
            return false;
        }
    } else if oz < z0 || oz > z1 {
        return false;
    }
    true
}

// ---- primitives: write T and return true on a hit ----

/// Sphere (centre c, radius rr) hit by a ray from o along d.
fn sphere_p(ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, cx: f64, cy: f64, cz: f64, rr: f64) -> bool {
    let mx = ox - cx;
    let my = oy - cy;
    let mz = oz - cz;
    let bb = mx * dx + my * dy + mz * dz;
    let cc = mx * mx + my * my + mz * mz - rr * rr;
    if cc > 0.0 && bb > 0.0 {
        return false;
    }
    let disc = bb * bb - cc;
    if disc < 0.0 {
        return false;
    }
    let t = t();
    if cc <= 0.0 {
        let l = sqrt(mx * mx + my * my + mz * mz);
        t.t = 0.0;
        if l > 1e-12 {
            t.nx = mx / l;
            t.ny = my / l;
            t.nz = mz / l;
        } else {
            t.nx = -dx;
            t.ny = -dy;
            t.nz = -dz;
        }
        t.inside = true;
        t.depth = rr - l;
        return true;
    }
    let tt = -bb - sqrt(disc);
    t.t = tt;
    t.nx = (mx + dx * tt) / rr;
    t.ny = (my + dy * tt) / rr;
    t.nz = (mz + dz * tt) / rr;
    t.inside = false;
    t.depth = 0.0;
    true
}

/// Side of a cylinder: axis from a along unit e for length l, radius rr. The end caps are left to spheres.
fn cyl_p(ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, ax: f64, ay: f64, az: f64, ex: f64, ey: f64, ez: f64, l: f64, rr: f64) -> bool {
    let aox = ox - ax;
    let aoy = oy - ay;
    let aoz = oz - az;
    let od = aox * ex + aoy * ey + aoz * ez;
    let dd = dx * ex + dy * ey + dz * ez;
    let px = aox - od * ex;
    let py = aoy - od * ey;
    let pz = aoz - od * ez;
    let qx = dx - dd * ex;
    let qy = dy - dd * ey;
    let qz = dz - dd * ez;
    let a = qx * qx + qy * qy + qz * qz;
    if a < 1e-14 {
        return false;
    }
    let bq = px * qx + py * qy + pz * qz;
    let cq = px * px + py * py + pz * pz - rr * rr;
    if cq > 0.0 && bq >= 0.0 {
        return false;
    }
    let disc = bq * bq - a * cq;
    if disc < 0.0 {
        return false;
    }
    let tt = (-bq - sqrt(disc)) / a;
    if tt < 0.0 {
        return false;
    }
    let h = od + dd * tt;
    if h < 0.0 || h > l {
        return false;
    }
    let t = t();
    t.t = tt;
    t.nx = (px + qx * tt) / rr;
    t.ny = (py + qy * tt) / rr;
    t.nz = (pz + qz * tt) / rr;
    t.inside = false;
    t.depth = 0.0;
    true
}

// ---- sphere shape ----

fn sweep_sphere_shape(id: usize, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64) {
    if sphere_p(ox, oy, oz, dx, dy, dz, f(id, CX), f(id, CY), f(id, CZ), f(id, R) + r) {
        offer_t(id as i32);
    }
}

// ---- capsule shape ----

fn sweep_capsule_shape(id: usize, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64) {
    let sid = id as i32;
    let (sax, say, saz) = (f(id, AX), f(id, AY), f(id, AZ));
    let (sbx, sby, sbz) = (f(id, BX), f(id, BY), f(id, BZ));
    let abx = sbx - sax;
    let aby = sby - say;
    let abz = sbz - saz;
    let l2 = abx * abx + aby * aby + abz * abz;
    let rr = f(id, R) + r;
    let mut u = if l2 > 1e-18 { ((ox - sax) * abx + (oy - say) * aby + (oz - saz) * abz) / l2 } else { 0.0 };
    if u < 0.0 {
        u = 0.0;
    } else if u > 1.0 {
        u = 1.0;
    }
    let px = ox - (sax + abx * u);
    let py = oy - (say + aby * u);
    let pz = oz - (saz + abz * u);
    let d2 = px * px + py * py + pz * pz;
    if d2 < rr * rr {
        let l = sqrt(d2);
        if l > 1e-12 {
            offer(0.0, px / l, py / l, pz / l, sid, true, rr - l);
        } else {
            offer(0.0, -dx, -dy, -dz, sid, true, rr);
        }
        return;
    }
    if l2 > 1e-18 {
        let l = sqrt(l2);
        if cyl_p(ox, oy, oz, dx, dy, dz, sax, say, saz, abx / l, aby / l, abz / l, l, rr) {
            offer_t(sid);
        }
    }
    if sphere_p(ox, oy, oz, dx, dy, dz, sax, say, saz, rr) {
        offer_t(sid);
    }
    if l2 > 1e-18 && sphere_p(ox, oy, oz, dx, dy, dz, sbx, sby, sbz, rr) {
        offer_t(sid);
    }
}

// ---- box shape ----

fn offer_box(id: usize, aa: bool, tt: f64, nl0: f64, nl1: f64, nl2: f64, inside: bool, depth: f64) {
    let bs = b();
    if !(tt < bs.t || (bs.shape == -1 && tt <= bs.t)) {
        return;
    }
    if aa {
        offer(tt, nl0, nl1, nl2, id as i32, inside, depth);
    } else {
        offer(
            tt,
            nl0 * f(id, U) + nl1 * f(id, U + 3) + nl2 * f(id, U + 6),
            nl0 * f(id, U + 1) + nl1 * f(id, U + 4) + nl2 * f(id, U + 7),
            nl0 * f(id, U + 2) + nl1 * f(id, U + 5) + nl2 * f(id, U + 8),
            id as i32,
            inside,
            depth,
        );
    }
}

fn sweep_box_shape(id: usize, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64) {
    let aa = flag(id, F_AA);
    let mut lx = ox - f(id, CX);
    let mut ly = oy - f(id, CY);
    let mut lz = oz - f(id, CZ);
    let mut ldx = dx;
    let mut ldy = dy;
    let mut ldz = dz;
    if !aa {
        let u = |k: usize| f(id, U + k);
        let rx = lx;
        let ry = ly;
        let rz = lz;
        lx = rx * u(0) + ry * u(1) + rz * u(2);
        ly = rx * u(3) + ry * u(4) + rz * u(5);
        lz = rx * u(6) + ry * u(7) + rz * u(8);
        ldx = dx * u(0) + dy * u(1) + dz * u(2);
        ldy = dx * u(3) + dy * u(4) + dz * u(5);
        ldz = dx * u(6) + dy * u(7) + dz * u(8);
    }
    let hx = f(id, HX);
    let hy = f(id, HY);
    let hz = f(id, HZ);
    let ax = abs(lx);
    let ay = abs(ly);
    let az = abs(lz);

    // Starting strictly inside the box: push out through the nearest face.
    if ax < hx && ay < hy && az < hz {
        let px = hx - ax;
        let py = hy - ay;
        let pz = hz - az;
        if px <= py && px <= pz {
            offer_box(id, aa, 0.0, if lx < 0.0 { -1.0 } else { 1.0 }, 0.0, 0.0, true, px + r);
        } else if py <= pz {
            offer_box(id, aa, 0.0, 0.0, if ly < 0.0 { -1.0 } else { 1.0 }, 0.0, true, py + r);
        } else {
            offer_box(id, aa, 0.0, 0.0, 0.0, if lz < 0.0 { -1.0 } else { 1.0 }, true, pz + r);
        }
        return;
    }
    if r > 0.0 {
        let qx = if lx < -hx { lx + hx } else if lx > hx { lx - hx } else { 0.0 };
        let qy = if ly < -hy { ly + hy } else if ly > hy { ly - hy } else { 0.0 };
        let qz = if lz < -hz { lz + hz } else if lz > hz { lz - hz } else { 0.0 };
        let d2 = qx * qx + qy * qy + qz * qz;
        if d2 < r * r {
            let l = sqrt(d2);
            if l > 1e-12 {
                offer_box(id, aa, 0.0, qx / l, qy / l, qz / l, true, r - l);
            } else {
                // On the surface itself: use the face being touched.
                let fx = ax / hx;
                let fy = ay / hy;
                let fz = az / hz;
                if fx >= fy && fx >= fz {
                    offer_box(id, aa, 0.0, if lx < 0.0 { -1.0 } else { 1.0 }, 0.0, 0.0, true, r);
                } else if fy >= fz {
                    offer_box(id, aa, 0.0, 0.0, if ly < 0.0 { -1.0 } else { 1.0 }, 0.0, true, r);
                } else {
                    offer_box(id, aa, 0.0, 0.0, 0.0, if lz < 0.0 { -1.0 } else { 1.0 }, true, r);
                }
            }
            return;
        }
    }

    // Quick reject against the box grown by r.
    if !ray_aabb(lx, ly, lz, ldx, ldy, ldz, -hx - r, -hy - r, -hz - r, hx + r, hy + r, hz + r, b().t) {
        return;
    }

    let lo = [lx, ly, lz];
    let ld = [ldx, ldy, ldz];
    let lh = [hx, hy, hz];

    // Faces, moved out by r. The hit has to land inside the face's own rectangle.
    for i in 0..3usize {
        let di = ld[i];
        if di > -1e-12 && di < 1e-12 {
            continue;
        }
        let side = if di > 0.0 { -1.0 } else { 1.0 };
        let tt = (side * (lh[i] + r) - lo[i]) / di;
        if tt < 0.0 || tt > b().t {
            continue;
        }
        let j = if i == 0 { 1 } else { 0 };
        let k = if i == 2 { 1 } else { 2 };
        let pj = lo[j] + ld[j] * tt;
        let pk = lo[k] + ld[k] * tt;
        if pj < -lh[j] - 1e-9 || pj > lh[j] + 1e-9 || pk < -lh[k] - 1e-9 || pk > lh[k] + 1e-9 {
            continue;
        }
        let n0 = if i == 0 { side } else { 0.0 };
        let n1 = if i == 1 { side } else { 0.0 };
        let n2 = if i == 2 { side } else { 0.0 };
        offer_box(id, aa, tt, n0, n1, n2, false, 0.0);
    }
    if r <= 0.0 {
        return;
    }

    // Edges (cylinders of radius r) and corners (spheres of radius r).
    const SIGNS: [f64; 2] = [-1.0, 1.0];
    for k in 0..3usize {
        let i = (k + 1) % 3;
        let j = (k + 2) % 3;
        for si in SIGNS {
            for sj in SIGNS {
                // Edge start: coordinate k at -h, i and j at their signed extents.
                let mut cs = [0.0f64; 3];
                cs[k] = -lh[k];
                cs[i] = si * lh[i];
                cs[j] = sj * lh[j];
                let (px, py, pz) = (cs[0], cs[1], cs[2]);
                let ex = if k == 0 { 1.0 } else { 0.0 };
                let ey = if k == 1 { 1.0 } else { 0.0 };
                let ez = if k == 2 { 1.0 } else { 0.0 };
                if cyl_p(lx, ly, lz, ldx, ldy, ldz, px, py, pz, ex, ey, ez, 2.0 * lh[k], r) {
                    let t = t();
                    offer_box(id, aa, t.t, t.nx, t.ny, t.nz, false, 0.0);
                }
            }
        }
    }
    for sx in SIGNS {
        for sy in SIGNS {
            for sz in SIGNS {
                if sphere_p(lx, ly, lz, ldx, ldy, ldz, sx * hx, sy * hy, sz * hz, r) {
                    let t = t();
                    offer_box(id, aa, t.t, t.nx, t.ny, t.nz, false, 0.0);
                }
            }
        }
    }
}

// ---- triangles ----

/// Closest point on triangle (a, b, c) to p, into CP. Returns squared distance.
fn closest_tri(px: f64, py: f64, pz: f64, v: *const f64, o: usize) -> f64 {
    let ax = rd(v, o);
    let ay = rd(v, o + 1);
    let az = rd(v, o + 2);
    let bx = rd(v, o + 3);
    let by = rd(v, o + 4);
    let bz = rd(v, o + 5);
    let cx = rd(v, o + 6);
    let cy = rd(v, o + 7);
    let cz = rd(v, o + 8);
    let abx = bx - ax;
    let aby = by - ay;
    let abz = bz - az;
    let acx = cx - ax;
    let acy = cy - ay;
    let acz = cz - az;
    let apx = px - ax;
    let apy = py - ay;
    let apz = pz - az;
    let d1 = abx * apx + aby * apy + abz * apz;
    let d2 = acx * apx + acy * apy + acz * apz;
    let rx: f64;
    let ry: f64;
    let rz: f64;
    if d1 <= 0.0 && d2 <= 0.0 {
        rx = ax;
        ry = ay;
        rz = az;
    } else {
        let bpx = px - bx;
        let bpy = py - by;
        let bpz = pz - bz;
        let d3 = abx * bpx + aby * bpy + abz * bpz;
        let d4 = acx * bpx + acy * bpy + acz * bpz;
        if d3 >= 0.0 && d4 <= d3 {
            rx = bx;
            ry = by;
            rz = bz;
        } else {
            let vc = d1 * d4 - d3 * d2;
            if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
                let w = d1 / (d1 - d3);
                rx = ax + abx * w;
                ry = ay + aby * w;
                rz = az + abz * w;
            } else {
                let cpx = px - cx;
                let cpy = py - cy;
                let cpz = pz - cz;
                let d5 = abx * cpx + aby * cpy + abz * cpz;
                let d6 = acx * cpx + acy * cpy + acz * cpz;
                if d6 >= 0.0 && d5 <= d6 {
                    rx = cx;
                    ry = cy;
                    rz = cz;
                } else {
                    let vb = d5 * d2 - d1 * d6;
                    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
                        let w = d2 / (d2 - d6);
                        rx = ax + acx * w;
                        ry = ay + acy * w;
                        rz = az + acz * w;
                    } else {
                        let va = d3 * d6 - d5 * d4;
                        if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
                            let w = (d4 - d3) / (d4 - d3 + (d5 - d6));
                            rx = bx + (cx - bx) * w;
                            ry = by + (cy - by) * w;
                            rz = bz + (cz - bz) * w;
                        } else {
                            let den = 1.0 / (va + vb + vc);
                            let vv = vb * den;
                            let ww = vc * den;
                            rx = ax + abx * vv + acx * ww;
                            ry = ay + aby * vv + acy * ww;
                            rz = az + abz * vv + acz * ww;
                        }
                    }
                }
            }
        }
    }
    unsafe {
        CP[0] = rx;
        CP[1] = ry;
        CP[2] = rz;
    }
    let ex = px - rx;
    let ey = py - ry;
    let ez = pz - rz;
    ex * ex + ey * ey + ez * ez
}

/// A sphere sweep against one triangle (two-sided). `v` holds the vertices at `vo`, `n` the unit normal at `no`.
fn tri_sweep(sid: i32, v: *const f64, vo: usize, n: *const f64, no: usize, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64) {
    let nx = rd(n, no);
    let ny = rd(n, no + 1);
    let nz = rd(n, no + 2);
    if nx == 0.0 && ny == 0.0 && nz == 0.0 {
        return;
    }
    let ax = rd(v, vo);
    let ay = rd(v, vo + 1);
    let az = rd(v, vo + 2);
    if r > 0.0 {
        let d2 = closest_tri(ox, oy, oz, v, vo);
        if d2 < r * r {
            let l = sqrt(d2);
            let cp = unsafe { CP };
            if l > 1e-12 {
                offer(0.0, (ox - cp[0]) / l, (oy - cp[1]) / l, (oz - cp[2]) / l, sid, true, r - l);
            } else {
                let side = if (ox - ax) * nx + (oy - ay) * ny + (oz - az) * nz >= 0.0 { 1.0 } else { -1.0 };
                offer(0.0, nx * side, ny * side, nz * side, sid, true, r);
            }
            return;
        }
    }
    let sd = (ox - ax) * nx + (oy - ay) * ny + (oz - az) * nz;
    let side = if sd >= 0.0 { 1.0 } else { -1.0 };
    let dn = dx * nx + dy * ny + dz * nz;
    if side * dn < 0.0 {
        let tt = (side * r - sd) / dn;
        if tt >= 0.0 && tt <= b().t {
            let px = ox + dx * tt - side * r * nx;
            let py = oy + dy * tt - side * r * ny;
            let pz = oz + dz * tt - side * r * nz;
            if point_in_tri(px, py, pz, v, vo, nx, ny, nz) {
                offer(tt, nx * side, ny * side, nz * side, sid, false, 0.0);
            }
        }
    }
    if r <= 0.0 {
        return;
    }
    let bx = rd(v, vo + 3);
    let by = rd(v, vo + 4);
    let bz = rd(v, vo + 5);
    let cx = rd(v, vo + 6);
    let cy = rd(v, vo + 7);
    let cz = rd(v, vo + 8);
    edge_cyl(sid, ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r);
    edge_cyl(sid, ox, oy, oz, dx, dy, dz, bx, by, bz, cx, cy, cz, r);
    edge_cyl(sid, ox, oy, oz, dx, dy, dz, cx, cy, cz, ax, ay, az, r);
    if sphere_p(ox, oy, oz, dx, dy, dz, ax, ay, az, r) {
        offer_t(sid);
    }
    if sphere_p(ox, oy, oz, dx, dy, dz, bx, by, bz, r) {
        offer_t(sid);
    }
    if sphere_p(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
        offer_t(sid);
    }
}

fn edge_cyl(sid: i32, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, ax: f64, ay: f64, az: f64, bx: f64, by: f64, bz: f64, r: f64) {
    let ex = bx - ax;
    let ey = by - ay;
    let ez = bz - az;
    let l = sqrt(ex * ex + ey * ey + ez * ez);
    if l < 1e-12 {
        return;
    }
    if cyl_p(ox, oy, oz, dx, dy, dz, ax, ay, az, ex / l, ey / l, ez / l, l, r) {
        offer_t(sid);
    }
}

fn point_in_tri(px: f64, py: f64, pz: f64, v: *const f64, o: usize, nx: f64, ny: f64, nz: f64) -> bool {
    // Same-side test against each edge, with a small tolerance so shared edges leave no cracks.
    let eps = -1e-9;
    for k in 0..3usize {
        let i = o + k * 3;
        let j = o + ((k + 1) % 3) * 3;
        let ex = rd(v, j) - rd(v, i);
        let ey = rd(v, j + 1) - rd(v, i + 1);
        let ez = rd(v, j + 2) - rd(v, i + 2);
        let qx = px - rd(v, i);
        let qy = py - rd(v, i + 1);
        let qz = pz - rd(v, i + 2);
        let cx = ey * qz - ez * qy;
        let cy = ez * qx - ex * qz;
        let cz = ex * qy - ey * qx;
        let el = ex * ex + ey * ey + ez * ez;
        if cx * nx + cy * ny + cz * nz < eps * sqrt(el) {
            return false;
        }
    }
    true
}

// ---- mesh ----

fn sweep_mesh_shape(id: usize, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64) {
    let m = mesh(id);
    if m.nodes == 0 {
        return;
    }
    let sid = id as i32;
    let stack = unsafe { &mut STACK };
    let mut sp = 0usize;
    stack[sp] = 0;
    sp += 1;
    let bb = m.bb;
    while sp > 0 {
        sp -= 1;
        let node = stack[sp] as usize;
        let o = node * 6;
        if !ray_aabb(ox, oy, oz, dx, dy, dz, rd(bb, o) - r, rd(bb, o + 1) - r, rd(bb, o + 2) - r, rd(bb, o + 3) + r, rd(bb, o + 4) + r, rd(bb, o + 5) + r, b().t) {
            continue;
        }
        let l = unsafe { *m.left.add(node) };
        if l < 0 {
            let fi = unsafe { *m.first.add(node) };
            let e = fi + unsafe { *m.count.add(node) };
            let mut i = fi;
            while i < e {
                tri_sweep(sid, m.v, i as usize * 9, m.n, i as usize * 3, ox, oy, oz, dx, dy, dz, r);
                i += 1;
            }
        } else {
            stack[sp] = unsafe { *m.right.add(node) };
            sp += 1;
            stack[sp] = l;
            sp += 1;
        }
    }
}

// ---- plane ----

fn sweep_plane_shape(id: usize, oy: f64, dy: f64, r: f64) {
    let sd = oy - f(id, PLANE_Y);
    if sd < r {
        offer(0.0, 0.0, 1.0, 0.0, id as i32, true, r - sd);
        return;
    }
    if dy < 0.0 {
        offer((sd - r) / -dy, 0.0, 1.0, 0.0, id as i32, false, 0.0);
    }
}

// ---- heightfield ----

#[inline(always)]
fn hh(h: &HfRef, k: f64) -> f64 {
    unsafe { *h.h.add(k as usize) as f64 }
}

/// HeightField.heightAt: world height at (x, z) on the two-triangle split the sweeps use; NaN outside the field.
fn height_at(h: &HfRef, x: f64, z: f64) -> f64 {
    let fx = (x - h.x0) / h.cell;
    let fz = (z - h.z0) / h.cell;
    let cols = h.columns as f64;
    let rows = h.rows as f64;
    if !(fx >= 0.0 && fz >= 0.0 && fx <= cols - 1.0 && fz <= rows - 1.0) {
        return f64::NAN;
    }
    let mut i = floor(fx);
    let mut j = floor(fz);
    if i >= cols - 1.0 {
        i = cols - 2.0;
    }
    if j >= rows - 1.0 {
        j = rows - 2.0;
    }
    let u = fx - i;
    let v = fz - j;
    let c = cols;
    let h00 = hh(h, j * c + i);
    let h10 = hh(h, j * c + i + 1.0);
    let h01 = hh(h, (j + 1.0) * c + i);
    let h11 = hh(h, (j + 1.0) * c + i + 1.0);
    let y = if u + v <= 1.0 { h00 + u * (h10 - h00) + v * (h01 - h00) } else { h11 + (1.0 - u) * (h01 - h11) + (1.0 - v) * (h10 - h11) };
    h.y0 + y * h.scale
}

fn hf_tri(sid: i32, h: &HfRef, i0: f64, j0: f64, i1: f64, j1: f64, i2: f64, j2: f64, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64) {
    let c = h.columns as f64;
    let hv = unsafe { &mut HV };
    hv[0] = h.x0 + i0 * h.cell;
    hv[1] = h.y0 + hh(h, j0 * c + i0) * h.scale;
    hv[2] = h.z0 + j0 * h.cell;
    hv[3] = h.x0 + i1 * h.cell;
    hv[4] = h.y0 + hh(h, j1 * c + i1) * h.scale;
    hv[5] = h.z0 + j1 * h.cell;
    hv[6] = h.x0 + i2 * h.cell;
    hv[7] = h.y0 + hh(h, j2 * c + i2) * h.scale;
    hv[8] = h.z0 + j2 * h.cell;
    let e1x = hv[3] - hv[0];
    let e1y = hv[4] - hv[1];
    let e1z = hv[5] - hv[2];
    let e2x = hv[6] - hv[0];
    let e2y = hv[7] - hv[1];
    let e2z = hv[8] - hv[2];
    let mut nx = e1y * e2z - e1z * e2y;
    let mut ny = e1z * e2x - e1x * e2z;
    let mut nz = e1x * e2y - e1y * e2x;
    let l = sqrt(nx * nx + ny * ny + nz * nz);
    if l < 1e-12 {
        return;
    }
    nx /= l;
    ny /= l;
    nz /= l;
    let hn = unsafe { &mut HN };
    hn[0] = nx;
    hn[1] = ny;
    hn[2] = nz;
    tri_sweep(sid, hv.as_ptr(), 0, hn.as_ptr(), 0, ox, oy, oz, dx, dy, dz, r);
}

fn hf_cell(sid: i32, h: &HfRef, i: f64, j: f64, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64) {
    hf_tri(sid, h, i, j, i, j + 1.0, i + 1.0, j, ox, oy, oz, dx, dy, dz, r);
    hf_tri(sid, h, i + 1.0, j, i, j + 1.0, i + 1.0, j + 1.0, ox, oy, oz, dx, dy, dz, r);
}

fn sweep_heightfield_shape(id: usize, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64) {
    let sid = id as i32;
    let h = hf(id);
    let h0 = height_at(&h, ox, oz);
    if h0 == h0 && oy < h0 {
        offer(0.0, 0.0, 1.0, 0.0, sid, true, h0 - oy + r);
        return;
    }
    let k = if r > 0.0 { ceil(r / h.cell) } else { 0.0 };
    let cmax = h.columns as f64 - 2.0;
    let rmax = h.rows as f64 - 2.0;
    let dda = unsafe { &mut HF_DDA };
    dda.init(ox - h.x0, oz - h.z0, dx, dz, b().t, h.cell);
    loop {
        let ci = dda.ix;
        let cj = dda.iz;
        if ci >= -k && ci <= cmax + k && cj >= -k && cj <= rmax + k {
            let mut j = cj - k;
            while j <= cj + k {
                if j < 0.0 || j > rmax {
                    j += 1.0;
                    continue;
                }
                let mut i = ci - k;
                while i <= ci + k {
                    if i < 0.0 || i > cmax {
                        i += 1.0;
                        continue;
                    }
                    hf_cell(sid, &h, i, j, ox, oy, oz, dx, dy, dz, r);
                    i += 1.0;
                }
                j += 1.0;
            }
        } else if (dda.step_x > 0.0 && ci > cmax + k) || (dda.step_x < 0.0 && ci < -k) || (dda.step_z > 0.0 && cj > rmax + k) || (dda.step_z < 0.0 && cj < -k) {
            break;
        }
        if k == 0.0 && b().t <= dda.t_exit() {
            break;
        }
        if !dda.advance() {
            break;
        }
    }
}

/// Sweeps a sphere of radius r from o along unit d against shape `id`, offering its hit to B.
pub fn sweep_shape(id: usize, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64) {
    match kind(id) {
        K_SPHERE => sweep_sphere_shape(id, ox, oy, oz, dx, dy, dz, r),
        K_CAPSULE => sweep_capsule_shape(id, ox, oy, oz, dx, dy, dz, r),
        K_BOX => sweep_box_shape(id, ox, oy, oz, dx, dy, dz, r),
        K_MESH => sweep_mesh_shape(id, ox, oy, oz, dx, dy, dz, r),
        K_PLANE => sweep_plane_shape(id, oy, dy, r),
        K_HEIGHTFIELD => sweep_heightfield_shape(id, ox, oy, oz, dx, dy, dz, r),
        _ => {}
    }
}

// ---- closest point ----

fn box_local(id: usize, px: f64, py: f64, pz: f64) {
    // Result: signed distance in C.dist, local normal in C.n*, converted to world below.
    let aa = flag(id, F_AA);
    let c = c();
    let mut lx = px - f(id, CX);
    let mut ly = py - f(id, CY);
    let mut lz = pz - f(id, CZ);
    if !aa {
        let u = |k: usize| f(id, U + k);
        let rx = lx;
        let ry = ly;
        let rz = lz;
        lx = rx * u(0) + ry * u(1) + rz * u(2);
        ly = rx * u(3) + ry * u(4) + rz * u(5);
        lz = rx * u(6) + ry * u(7) + rz * u(8);
    }
    let hx = f(id, HX);
    let hy = f(id, HY);
    let hz = f(id, HZ);
    let ax = abs(lx);
    let ay = abs(ly);
    let az = abs(lz);
    let nx: f64;
    let ny: f64;
    let nz: f64;
    if ax < hx && ay < hy && az < hz {
        let qx = hx - ax;
        let qy = hy - ay;
        let qz = hz - az;
        if qx <= qy && qx <= qz {
            c.dist = -qx;
            nx = if lx < 0.0 { -1.0 } else { 1.0 };
            ny = 0.0;
            nz = 0.0;
        } else if qy <= qz {
            c.dist = -qy;
            nx = 0.0;
            ny = if ly < 0.0 { -1.0 } else { 1.0 };
            nz = 0.0;
        } else {
            c.dist = -qz;
            nx = 0.0;
            ny = 0.0;
            nz = if lz < 0.0 { -1.0 } else { 1.0 };
        }
    } else {
        let qx = if lx < -hx { lx + hx } else if lx > hx { lx - hx } else { 0.0 };
        let qy = if ly < -hy { ly + hy } else if ly > hy { ly - hy } else { 0.0 };
        let qz = if lz < -hz { lz + hz } else if lz > hz { lz - hz } else { 0.0 };
        let l = sqrt(qx * qx + qy * qy + qz * qz);
        c.dist = l;
        if l > 1e-12 {
            nx = qx / l;
            ny = qy / l;
            nz = qz / l;
        } else {
            nx = if lx < 0.0 { -1.0 } else { 1.0 };
            ny = 0.0;
            nz = 0.0;
        }
    }
    if aa {
        c.nx = nx;
        c.ny = ny;
        c.nz = nz;
    } else {
        let u = |k: usize| f(id, U + k);
        c.nx = nx * u(0) + ny * u(3) + nz * u(6);
        c.ny = nx * u(1) + ny * u(4) + nz * u(7);
        c.nz = nx * u(2) + ny * u(5) + nz * u(8);
    }
}

fn closest_mesh(id: usize, px: f64, py: f64, pz: f64) {
    let m = mesh(id);
    let c = c();
    c.dist = f64::INFINITY;
    c.nx = 0.0;
    c.ny = 1.0;
    c.nz = 0.0;
    if m.nodes == 0 {
        return;
    }
    let mut best = f64::INFINITY;
    let mut bx = 0.0;
    let mut by = 1.0;
    let mut bz = 0.0;
    let stack = unsafe { &mut STACK };
    let mut sp = 0usize;
    stack[sp] = 0;
    sp += 1;
    let bb = m.bb;
    while sp > 0 {
        sp -= 1;
        let node = stack[sp] as usize;
        let o = node * 6;
        let ex = if px < rd(bb, o) { rd(bb, o) - px } else if px > rd(bb, o + 3) { px - rd(bb, o + 3) } else { 0.0 };
        let ey = if py < rd(bb, o + 1) { rd(bb, o + 1) - py } else if py > rd(bb, o + 4) { py - rd(bb, o + 4) } else { 0.0 };
        let ez = if pz < rd(bb, o + 2) { rd(bb, o + 2) - pz } else if pz > rd(bb, o + 5) { pz - rd(bb, o + 5) } else { 0.0 };
        if ex * ex + ey * ey + ez * ez >= best {
            continue;
        }
        let l = unsafe { *m.left.add(node) };
        if l < 0 {
            let fi = unsafe { *m.first.add(node) };
            let e = fi + unsafe { *m.count.add(node) };
            let mut ti = fi;
            while ti < e {
                let i = ti as usize;
                ti += 1;
                if rd(m.n, i * 3) == 0.0 && rd(m.n, i * 3 + 1) == 0.0 && rd(m.n, i * 3 + 2) == 0.0 {
                    continue;
                }
                let d2 = closest_tri(px, py, pz, m.v, i * 9);
                if d2 < best {
                    best = d2;
                    let d = sqrt(d2);
                    if d > 1e-12 {
                        let cp = unsafe { CP };
                        bx = (px - cp[0]) / d;
                        by = (py - cp[1]) / d;
                        bz = (pz - cp[2]) / d;
                    } else {
                        let side = if (px - rd(m.v, i * 9)) * rd(m.n, i * 3) + (py - rd(m.v, i * 9 + 1)) * rd(m.n, i * 3 + 1) + (pz - rd(m.v, i * 9 + 2)) * rd(m.n, i * 3 + 2) >= 0.0 { 1.0 } else { -1.0 };
                        bx = rd(m.n, i * 3) * side;
                        by = rd(m.n, i * 3 + 1) * side;
                        bz = rd(m.n, i * 3 + 2) * side;
                    }
                }
            }
        } else {
            stack[sp] = unsafe { *m.right.add(node) };
            sp += 1;
            stack[sp] = l;
            sp += 1;
        }
    }
    c.dist = sqrt(best);
    c.nx = bx;
    c.ny = by;
    c.nz = bz;
}

fn closest_heightfield(id: usize, px: f64, py: f64, pz: f64) {
    let h = hf(id);
    let c = c();
    let hgt = height_at(&h, px, pz);
    if hgt != hgt {
        c.dist = f64::INFINITY;
        c.nx = 0.0;
        c.ny = 1.0;
        c.nz = 0.0;
        return;
    }
    // Normal of the triangle under the point, from the same split height_at uses.
    let fx = (px - h.x0) / h.cell;
    let fz = (pz - h.z0) / h.cell;
    let mut i = floor(fx);
    let mut j = floor(fz);
    let cols = h.columns as f64;
    let rows = h.rows as f64;
    if i >= cols - 1.0 {
        i = cols - 2.0;
    }
    if j >= rows - 1.0 {
        j = rows - 2.0;
    }
    let cc = cols;
    let h00 = hh(&h, j * cc + i);
    let h10 = hh(&h, j * cc + i + 1.0);
    let h01 = hh(&h, (j + 1.0) * cc + i);
    let h11 = hh(&h, (j + 1.0) * cc + i + 1.0);
    let lower = (fx - i) + (fz - j) <= 1.0;
    // Slope along x and z within the triangle, per metre.
    let sx = (if lower { h10 - h00 } else { h11 - h01 }) * h.scale / h.cell;
    let sz = (if lower { h01 - h00 } else { h11 - h10 }) * h.scale / h.cell;
    let l = sqrt(sx * sx + 1.0 + sz * sz);
    c.nx = -sx / l;
    c.ny = 1.0 / l;
    c.nz = -sz / l;
    c.dist = (py - hgt) * c.ny;
}

/// Signed distance from p to shape `id` (negative inside) and the unit direction away from it, in C.
pub fn closest_on(id: usize, px: f64, py: f64, pz: f64) -> f64 {
    match kind(id) {
        K_SPHERE => {
            let x = px - f(id, CX);
            let y = py - f(id, CY);
            let z = pz - f(id, CZ);
            let l = sqrt(x * x + y * y + z * z);
            let c = c();
            c.dist = l - f(id, R);
            if l > 1e-12 {
                c.nx = x / l;
                c.ny = y / l;
                c.nz = z / l;
            } else {
                c.nx = 0.0;
                c.ny = 1.0;
                c.nz = 0.0;
            }
        }
        K_CAPSULE => {
            let (sax, say, saz) = (f(id, AX), f(id, AY), f(id, AZ));
            let abx = f(id, BX) - sax;
            let aby = f(id, BY) - say;
            let abz = f(id, BZ) - saz;
            let l2 = abx * abx + aby * aby + abz * abz;
            let mut u = if l2 > 1e-18 { ((px - sax) * abx + (py - say) * aby + (pz - saz) * abz) / l2 } else { 0.0 };
            if u < 0.0 {
                u = 0.0;
            } else if u > 1.0 {
                u = 1.0;
            }
            let x = px - (sax + abx * u);
            let y = py - (say + aby * u);
            let z = pz - (saz + abz * u);
            let l = sqrt(x * x + y * y + z * z);
            let c = c();
            c.dist = l - f(id, R);
            if l > 1e-12 {
                c.nx = x / l;
                c.ny = y / l;
                c.nz = z / l;
            } else {
                c.nx = 0.0;
                c.ny = 1.0;
                c.nz = 0.0;
            }
        }
        K_BOX => box_local(id, px, py, pz),
        K_MESH => closest_mesh(id, px, py, pz),
        K_PLANE => {
            let c = c();
            c.dist = py - f(id, PLANE_Y);
            c.nx = 0.0;
            c.ny = 1.0;
            c.nz = 0.0;
        }
        K_HEIGHTFIELD => closest_heightfield(id, px, py, pz),
        _ => {}
    }
    c().dist
}
