//! rigid.ts in the kernel: sequential impulses over contact points, the same arithmetic in the same order. Bodies
//! live in two flat arrays TypeScript reads and writes (`BF` numbers, `BI` integers, in the order bodies were added):
//! before a step it writes what game code may have changed, after it reads the state back. Field numbers are the
//! same in packages/hull/src/physics/kernel.ts.
use crate::math::{max, min, min3, sqrt};
use crate::narrow::{self, B, C};
use crate::shapes::{self as s, i, set_i};
use crate::world::{Filter, NO_FILTER, W};
use alloc::vec::Vec;

const CONTACT_SKIN: f64 = 0.004;
const SLOP: f64 = 0.003;
const MAX_ANGULAR: f64 = 60.0;

pub const BF_STRIDE: usize = 64;
pub const PX: usize = 0;
pub const PY: usize = 1;
pub const PZ: usize = 2;
pub const QX: usize = 3;
pub const QY: usize = 4;
pub const QZ: usize = 5;
pub const QW: usize = 6;
pub const VX: usize = 7;
pub const VY: usize = 8;
pub const VZ: usize = 9;
pub const WX: usize = 10;
pub const WY: usize = 11;
pub const WZ: usize = 12;
pub const INV_MASS: usize = 13;
pub const RESTITUTION: usize = 14;
pub const FRICTION: usize = 15;
pub const LIN_DAMP: usize = 16;
pub const ANG_DAMP: usize = 17;
pub const GRAV: usize = 18;
pub const ROLL: usize = 19;
pub const IIX: usize = 20;
pub const IIY: usize = 21;
pub const IIZ: usize = 22;
pub const PT_R: usize = 23;
pub const INNER: usize = 24;
pub const OUTER: usize = 25;
pub const SLEEP_TIME: usize = 26;
/// World inverse inertia, 9 numbers, row-major.
pub const IW: usize = 27;
/// Contact points in the body's frame, 3 each: 1 for a sphere, 8 for a box.
pub const PTS: usize = 36;

pub const BI_STRIDE: usize = 4;
pub const SHAPE: usize = 0;
pub const SLEEPING: usize = 1;
pub const TOUCHING: usize = 2;
pub const NPTS: usize = 3;

#[derive(Clone, Copy, Default)]
struct Con {
    a: usize,
    /// -1 for a static shape.
    b: i32,
    nx: f64, ny: f64, nz: f64,
    depth: f64,
    rax: f64, ray: f64, raz: f64,
    rbx: f64, rby: f64, rbz: f64,
    mu: f64,
    e: f64,
    target: f64,
    jn: f64,
    jt1: f64,
}

pub struct Rigid {
    pub bf: Vec<f64>,
    pub bi: Vec<i32>,
    pub n: usize,
    cons: Vec<Con>,
}

pub static mut RB: Rigid = Rigid { bf: Vec::new(), bi: Vec::new(), n: 0, cons: Vec::new() };

static mut RX: f64 = 0.0;
static mut RY: f64 = 0.0;
static mut RZ: f64 = 0.0;

impl Rigid {
    #[inline(always)]
    fn g(&self, b: usize, k: usize) -> f64 { self.bf[b * BF_STRIDE + k] }
    #[inline(always)]
    fn s(&mut self, b: usize, k: usize, v: f64) { self.bf[b * BF_STRIDE + k] = v; }
    #[inline(always)]
    fn gi(&self, b: usize, k: usize) -> i32 { self.bi[b * BI_STRIDE + k] }
    #[inline(always)]
    fn si(&mut self, b: usize, k: usize, v: i32) { self.bi[b * BI_STRIDE + k] = v; }
    #[inline(always)]
    fn sleeping(&self, b: usize) -> bool { self.gi(b, SLEEPING) != 0 }

    /// A body for shape `id`; TypeScript fills its numbers. Returns its index.
    pub fn add(&mut self, id: usize) -> usize {
        let b = self.n;
        self.n += 1;
        if self.bf.len() < self.n * BF_STRIDE {
            self.bf.resize(self.n * 2 * BF_STRIDE, 0.0);
            self.bi.resize(self.n * 2 * BI_STRIDE, 0);
        }
        for k in 0..BF_STRIDE { self.s(b, k, 0.0); }
        for k in 0..BI_STRIDE { self.si(b, k, 0); }
        self.si(b, SHAPE, id as i32);
        set_i(id, s::RB, b as i32);
        b
    }

    /// rigid.ts `remove`: later bodies move down one.
    pub fn remove(&mut self, b: usize) {
        let id = self.gi(b, SHAPE) as usize;
        set_i(id, s::RB, -1);
        self.bf.copy_within((b + 1) * BF_STRIDE..self.n * BF_STRIDE, b * BF_STRIDE);
        self.bi.copy_within((b + 1) * BI_STRIDE..self.n * BI_STRIDE, b * BI_STRIDE);
        self.n -= 1;
        for k in b..self.n {
            let sid = self.gi(k, SHAPE) as usize;
            set_i(sid, s::RB, k as i32);
        }
    }

    /// Rotates a body-frame vector into the world by the body's orientation, into RX, RY, RZ.
    fn rot(&self, b: usize, x: f64, y: f64, z: f64) {
        let (qx, qy, qz, qw) = (self.g(b, QX), self.g(b, QY), self.g(b, QZ), self.g(b, QW));
        let tx = 2.0 * (qy * z - qz * y);
        let ty = 2.0 * (qz * x - qx * z);
        let tz = 2.0 * (qx * y - qy * x);
        unsafe {
            RX = x + qw * tx + (qy * tz - qz * ty);
            RY = y + qw * ty + (qz * tx - qx * tz);
            RZ = z + qw * tz + (qx * ty - qy * tx);
        }
    }

    fn set_pose(&self, b: usize) {
        let id = self.gi(b, SHAPE) as usize;
        let mut e = [0.0; 16];
        s::from_pose(self.g(b, PX), self.g(b, PY), self.g(b, PZ), self.g(b, QX), self.g(b, QY), self.g(b, QZ), self.g(b, QW), &mut e);
        s::set_matrix(id, &e);
        unsafe {
            if i(id, s::WHERE) == s::WHERE_MOVING { W.mi.touch(i(id, s::SLOT) as usize, id); }
        }
    }

    fn wake(&mut self, b: usize) {
        self.si(b, SLEEPING, 0);
        self.s(b, SLEEP_TIME, 0.0);
    }

    pub fn step(&mut self, dt: f64, gx: f64, gy: f64, gz: f64, iters: i32) {
        let n = self.n;
        if n == 0 { return; }

        // 1. Velocities, then positions, with a sweep of each contact point so a fast body cannot pass through a wall.
        for b in 0..n {
            if self.sleeping(b) { continue; }
            let gs = self.g(b, GRAV) * dt;
            self.s(b, VX, self.g(b, VX) + gx * gs);
            self.s(b, VY, self.g(b, VY) + gy * gs);
            self.s(b, VZ, self.g(b, VZ) + gz * gs);
            let rest = if self.gi(b, TOUCHING) != 0 { self.g(b, ROLL) } else { 0.0 };
            let ld = 1.0 / (1.0 + (self.g(b, LIN_DAMP) + rest * 0.1) * dt);
            let ad = 1.0 / (1.0 + (self.g(b, ANG_DAMP) + rest) * dt);
            self.s(b, VX, self.g(b, VX) * ld);
            self.s(b, VY, self.g(b, VY) * ld);
            self.s(b, VZ, self.g(b, VZ) * ld);
            self.s(b, WX, self.g(b, WX) * ad);
            self.s(b, WY, self.g(b, WY) * ad);
            self.s(b, WZ, self.g(b, WZ) * ad);
            self.advance(b, dt);
        }

        // 2. Contacts at the new poses.
        self.cons.clear();
        for b in 0..n {
            self.si(b, TOUCHING, 0);
            if self.sleeping(b) { continue; }
            self.collect(b);
        }
        let nc = self.cons.len();

        // 3. Impulses.
        for b in 0..n {
            if !self.sleeping(b) { self.inertia(b); }
        }
        for k in 0..nc {
            let mut c = self.cons[k];
            c.jn = 0.0;
            c.jt1 = 0.0;
            let vn = self.rel_normal(&c);
            c.target = if vn < -1.0 { -c.e * vn } else { 0.0 };
            self.cons[k] = c;
        }
        for _ in 0..iters {
            for k in 0..nc {
                let mut c = self.cons[k];
                self.solve(&mut c);
                self.cons[k] = c;
            }
        }

        // 4. Push the bodies apart where they still overlap.
        for k in 0..nc {
            let c = self.cons[k];
            let over = c.depth - SLOP;
            if over <= 0.0 { continue; }
            let ima = if self.sleeping(c.a) { 0.0 } else { self.g(c.a, INV_MASS) };
            let imb = if c.b < 0 || self.sleeping(c.b as usize) { 0.0 } else { self.g(c.b as usize, INV_MASS) };
            let tot = ima + imb;
            if tot == 0.0 { continue; }
            let corr = min(over, 0.2) * 0.8 / tot;
            self.s(c.a, PX, self.g(c.a, PX) + c.nx * corr * ima);
            self.s(c.a, PY, self.g(c.a, PY) + c.ny * corr * ima);
            self.s(c.a, PZ, self.g(c.a, PZ) + c.nz * corr * ima);
            if c.b >= 0 && imb > 0.0 {
                let bb = c.b as usize;
                self.s(bb, PX, self.g(bb, PX) - c.nx * corr * imb);
                self.s(bb, PY, self.g(bb, PY) - c.ny * corr * imb);
                self.s(bb, PZ, self.g(bb, PZ) - c.nz * corr * imb);
            }
        }

        // 5. Sleep, and pose the shapes (TypeScript writes the nodes).
        for b in 0..n {
            if !self.sleeping(b) {
                let (vx, vy, vz, wx, wy, wz) = (self.g(b, VX), self.g(b, VY), self.g(b, VZ), self.g(b, WX), self.g(b, WY), self.g(b, WZ));
                let lin = vx * vx + vy * vy + vz * vz;
                let outer = self.g(b, OUTER);
                let ang = (wx * wx + wy * wy + wz * wz) * outer * outer;
                if self.gi(b, TOUCHING) != 0 && lin + ang < 0.05 * 0.05 {
                    self.s(b, SLEEP_TIME, self.g(b, SLEEP_TIME) + dt);
                    if self.g(b, SLEEP_TIME) > 0.5 {
                        self.si(b, SLEEPING, 1);
                        for k in [VX, VY, VZ, WX, WY, WZ] { self.s(b, k, 0.0); }
                    }
                } else {
                    self.s(b, SLEEP_TIME, 0.0);
                }
                self.set_pose(b);
            }
        }
    }

    fn advance(&mut self, b: usize, dt: f64) {
        let mut mx = self.g(b, VX) * dt;
        let mut my = self.g(b, VY) * dt;
        let mut mz = self.g(b, VZ) * dt;
        let dist = sqrt(mx * mx + my * my + mz * mz);
        if dist > self.g(b, INNER) * 0.25 {
            let (dx, dy, dz) = (mx / dist, my / dist, mz / dist);
            let fl = Filter { has: true, ignore_shape: self.gi(b, SHAPE), ..NO_FILTER };
            let mut best = dist;
            let np = self.gi(b, NPTS) as usize;
            for k in 0..np {
                let o = PTS + k * 3;
                self.rot(b, self.g(b, o), self.g(b, o + 1), self.g(b, o + 2));
                narrow::begin_sweep(best);
                unsafe {
                    W.cast(self.g(b, PX) + RX, self.g(b, PY) + RY, self.g(b, PZ) + RZ, dx, dy, dz, self.g(b, PT_R), &fl);
                    if B.shape != -1 && B.t < best && !B.inside { best = max(0.0, B.t - 0.002); }
                }
            }
            if best < dist { let sc = best / dist; mx *= sc; my *= sc; mz *= sc; }
        }
        self.s(b, PX, self.g(b, PX) + mx);
        self.s(b, PY, self.g(b, PY) + my);
        self.s(b, PZ, self.g(b, PZ) + mz);
        let mut wl = sqrt(self.g(b, WX) * self.g(b, WX) + self.g(b, WY) * self.g(b, WY) + self.g(b, WZ) * self.g(b, WZ));
        if wl > MAX_ANGULAR {
            let sc = MAX_ANGULAR / wl;
            self.s(b, WX, self.g(b, WX) * sc);
            self.s(b, WY, self.g(b, WY) * sc);
            self.s(b, WZ, self.g(b, WZ) * sc);
            wl = MAX_ANGULAR;
        }
        let _ = wl;
        let hx = 0.5 * dt * self.g(b, WX);
        let hy = 0.5 * dt * self.g(b, WY);
        let hz = 0.5 * dt * self.g(b, WZ);
        let (qx, qy, qz, qw) = (self.g(b, QX), self.g(b, QY), self.g(b, QZ), self.g(b, QW));
        let mut nx = qx + hx * qw + hy * qz - hz * qy;
        let mut ny = qy + hy * qw + hz * qx - hx * qz;
        let mut nz = qz + hz * qw + hx * qy - hy * qx;
        let mut nw = qw - hx * qx - hy * qy - hz * qz;
        let l = 1.0 / sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
        nx *= l;
        ny *= l;
        nz *= l;
        nw *= l;
        self.s(b, QX, nx);
        self.s(b, QY, ny);
        self.s(b, QZ, nz);
        self.s(b, QW, nw);
        self.set_pose(b);
    }

    fn collect(&mut self, b: usize) {
        let me = self.gi(b, SHAPE) as usize;
        let reach = self.g(b, PT_R) + CONTACT_SKIN;
        let np = self.gi(b, NPTS) as usize;
        for k in 0..np {
            let o = PTS + k * 3;
            self.rot(b, self.g(b, o), self.g(b, o + 1), self.g(b, o + 2));
            let (wx, wy, wz) = unsafe { (self.g(b, PX) + RX, self.g(b, PY) + RY, self.g(b, PZ) + RZ) };
            let w = unsafe { &mut W };
            w.gather(wx - reach, wy - reach, wz - reach, wx + reach, wy + reach, wz + reach, &NO_FILTER);
            for j in 0..w.cand.len() {
                let sid = w.cand[j] as usize;
                if sid == me { continue; }
                if (i(me, s::MASK) & i(sid, s::LAYER)) == 0 || (i(sid, s::MASK) & i(me, s::LAYER)) == 0 { continue; }
                let d = narrow::closest_on(sid, wx, wy, wz);
                if d >= reach { continue; }
                let other = i(sid, s::RB);
                let (cnx, cny, cnz) = unsafe { (C.nx, C.ny, C.nz) };
                let mut c = Con { a: b, b: other, nx: cnx, ny: cny, nz: cnz, ..Con::default() };
                c.depth = self.g(b, PT_R) - d;
                let px = wx - cnx * d;
                let py = wy - cny * d;
                let pz = wz - cnz * d;
                c.rax = px - self.g(b, PX);
                c.ray = py - self.g(b, PY);
                c.raz = pz - self.g(b, PZ);
                if other >= 0 {
                    let ob = other as usize;
                    c.rbx = px - self.g(ob, PX);
                    c.rby = py - self.g(ob, PY);
                    c.rbz = pz - self.g(ob, PZ);
                    if self.sleeping(ob) { self.wake(ob); }
                    c.mu = sqrt(self.g(b, FRICTION) * self.g(ob, FRICTION));
                    c.e = max(self.g(b, RESTITUTION), self.g(ob, RESTITUTION));
                } else {
                    c.mu = self.g(b, FRICTION);
                    c.e = self.g(b, RESTITUTION);
                }
                self.cons.push(c);
                self.si(b, TOUCHING, 1);
            }
        }
    }

    /// World inverse inertia: R diag(i) R^T.
    fn inertia(&mut self, b: usize) {
        let (x, y, z, w) = (self.g(b, QX), self.g(b, QY), self.g(b, QZ), self.g(b, QW));
        let r00 = 1.0 - 2.0 * (y * y + z * z);
        let r01 = 2.0 * (x * y - z * w);
        let r02 = 2.0 * (x * z + y * w);
        let r10 = 2.0 * (x * y + z * w);
        let r11 = 1.0 - 2.0 * (x * x + z * z);
        let r12 = 2.0 * (y * z - x * w);
        let r20 = 2.0 * (x * z - y * w);
        let r21 = 2.0 * (y * z + x * w);
        let r22 = 1.0 - 2.0 * (x * x + y * y);
        let (a, c, d) = (self.g(b, IIX), self.g(b, IIY), self.g(b, IIZ));
        let m0 = r00 * r00 * a + r01 * r01 * c + r02 * r02 * d;
        let m1 = r00 * r10 * a + r01 * r11 * c + r02 * r12 * d;
        let m2 = r00 * r20 * a + r01 * r21 * c + r02 * r22 * d;
        let m4 = r10 * r10 * a + r11 * r11 * c + r12 * r12 * d;
        let m5 = r10 * r20 * a + r11 * r21 * c + r12 * r22 * d;
        let m8 = r20 * r20 * a + r21 * r21 * c + r22 * r22 * d;
        let m = [m0, m1, m2, m1, m4, m5, m2, m5, m8];
        for k in 0..9 { self.s(b, IW + k, m[k]); }
    }

    fn rel_v(&self, c: &Con) -> (f64, f64, f64) {
        let a = c.a;
        let mut rvx = self.g(a, VX) + self.g(a, WY) * c.raz - self.g(a, WZ) * c.ray;
        let mut rvy = self.g(a, VY) + self.g(a, WZ) * c.rax - self.g(a, WX) * c.raz;
        let mut rvz = self.g(a, VZ) + self.g(a, WX) * c.ray - self.g(a, WY) * c.rax;
        if c.b >= 0 {
            let b = c.b as usize;
            rvx -= self.g(b, VX) + self.g(b, WY) * c.rbz - self.g(b, WZ) * c.rby;
            rvy -= self.g(b, VY) + self.g(b, WZ) * c.rbx - self.g(b, WX) * c.rbz;
            rvz -= self.g(b, VZ) + self.g(b, WX) * c.rby - self.g(b, WY) * c.rbx;
        }
        (rvx, rvy, rvz)
    }

    fn rel_normal(&self, c: &Con) -> f64 {
        let (rvx, rvy, rvz) = self.rel_v(c);
        rvx * c.nx + rvy * c.ny + rvz * c.nz
    }

    fn inertia_term(&self, b: usize, rx: f64, ry: f64, rz: f64, ux: f64, uy: f64, uz: f64) -> f64 {
        let cx = ry * uz - rz * uy;
        let cy = rz * ux - rx * uz;
        let cz = rx * uy - ry * ux;
        let m = |k: usize| self.g(b, IW + k);
        let ix = m(0) * cx + m(1) * cy + m(2) * cz;
        let iy = m(3) * cx + m(4) * cy + m(5) * cz;
        let iz = m(6) * cx + m(7) * cy + m(8) * cz;
        let ex = iy * rz - iz * ry;
        let ey = iz * rx - ix * rz;
        let ez = ix * ry - iy * rx;
        ex * ux + ey * uy + ez * uz
    }

    fn eff_mass(&self, c: &Con, ux: f64, uy: f64, uz: f64) -> f64 {
        let a = c.a;
        let mut k = if self.sleeping(a) { 0.0 } else { self.g(a, INV_MASS) };
        if !self.sleeping(a) { k += self.inertia_term(a, c.rax, c.ray, c.raz, ux, uy, uz); }
        if c.b >= 0 && !self.sleeping(c.b as usize) {
            let b = c.b as usize;
            k += self.g(b, INV_MASS) + self.inertia_term(b, c.rbx, c.rby, c.rbz, ux, uy, uz);
        }
        k
    }

    fn angular(&mut self, b: usize, rx: f64, ry: f64, rz: f64, jx: f64, jy: f64, jz: f64, sign: f64) {
        let cx = (ry * jz - rz * jy) * sign;
        let cy = (rz * jx - rx * jz) * sign;
        let cz = (rx * jy - ry * jx) * sign;
        let m = |k: usize| self.g(b, IW + k);
        let dwx = m(0) * cx + m(1) * cy + m(2) * cz;
        let dwy = m(3) * cx + m(4) * cy + m(5) * cz;
        let dwz = m(6) * cx + m(7) * cy + m(8) * cz;
        self.s(b, WX, self.g(b, WX) + dwx);
        self.s(b, WY, self.g(b, WY) + dwy);
        self.s(b, WZ, self.g(b, WZ) + dwz);
    }

    fn apply(&mut self, c: &Con, jx: f64, jy: f64, jz: f64) {
        let a = c.a;
        let ima = self.g(a, INV_MASS);
        self.s(a, VX, self.g(a, VX) + jx * ima);
        self.s(a, VY, self.g(a, VY) + jy * ima);
        self.s(a, VZ, self.g(a, VZ) + jz * ima);
        self.angular(a, c.rax, c.ray, c.raz, jx, jy, jz, 1.0);
        if c.b >= 0 && !self.sleeping(c.b as usize) {
            let b = c.b as usize;
            let imb = self.g(b, INV_MASS);
            self.s(b, VX, self.g(b, VX) - jx * imb);
            self.s(b, VY, self.g(b, VY) - jy * imb);
            self.s(b, VZ, self.g(b, VZ) - jz * imb);
            self.angular(b, c.rbx, c.rby, c.rbz, jx, jy, jz, -1.0);
        }
    }

    fn solve(&mut self, c: &mut Con) {
        let (rvx, rvy, rvz) = self.rel_v(c);
        let vn = rvx * c.nx + rvy * c.ny + rvz * c.nz;
        let kn = self.eff_mass(c, c.nx, c.ny, c.nz);
        if kn > 0.0 {
            let mut j = (c.target - vn) / kn;
            let old = c.jn;
            c.jn = max(0.0, old + j);
            j = c.jn - old;
            self.apply(c, c.nx * j, c.ny * j, c.nz * j);
        }
        let (rvx, rvy, rvz) = self.rel_v(c);
        let vn2 = rvx * c.nx + rvy * c.ny + rvz * c.nz;
        let tx = rvx - c.nx * vn2;
        let ty = rvy - c.ny * vn2;
        let tz = rvz - c.nz * vn2;
        let tl = sqrt(tx * tx + ty * ty + tz * tz);
        if tl > 1e-9 {
            let (ux, uy, uz) = (tx / tl, ty / tl, tz / tl);
            let kt = self.eff_mass(c, ux, uy, uz);
            if kt > 0.0 {
                let mut j = -tl / kt;
                let lim = c.mu * c.jn;
                let old = c.jt1;
                c.jt1 = max(-lim, min(lim, old + j));
                j = c.jt1 - old;
                self.apply(c, ux * j, uy * j, uz * j);
            }
        }
    }
}

/// Unused here but kept beside the others so the import list reads like rigid.ts's.
#[allow(dead_code)]
fn _min3(a: f64, b: f64, c: f64) -> f64 { min3(a, b, c) }
