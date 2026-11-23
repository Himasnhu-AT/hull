//! The physics world in the kernel: which shapes are where, the static grid, the moving-shape index, filters, and
//! every query. A line-for-line mirror of packages/hull/src/physics/world.ts and moving.ts, so candidates are offered
//! in the same order and every answer is the same bits.
use crate::dda::Dda;
use crate::math::{abs, ceil, floor};
use crate::narrow::{self, B};
use crate::shapes::{self as s, f, flag, i, set_i};
use alloc::vec::Vec;

/// A static shape wider than this many cells goes to the short list (world.ts MAX_CELLS).
const MAX_STATIC_CELLS: f64 = 256.0;
/// A sphere cast whose bounds cover at most this many cells visits them all; longer ones walk the line.
const BOX_CELLS: f64 = 64.0;
/// The dense static grid stops here; a world wider than this stays on TypeScript (the world reports it).
const MAX_GRID: f64 = 4_194_304.0;

/// What a query lets through: QueryFilter, as TypeScript writes it into FILT before the call.
#[derive(Clone, Copy)]
pub struct Filter {
    /// 0: no filter at all (world.ts `f === undefined`).
    pub has: bool,
    pub has_mask: bool,
    pub mask: i32,
    pub triggers: bool,
    pub ignore_shape: i32,
    pub ignore_node: i32,
    /// 0 none, 1 exact tag id, 2 prefix (a bit set over tag ids in FILT from FILT_TAGS).
    pub tag_mode: i32,
    pub tag: i32,
}

pub const NO_FILTER: Filter = Filter { has: false, has_mask: false, mask: 0, triggers: false, ignore_shape: -1, ignore_node: 0, tag_mode: 0, tag: 0 };

/// FILT: i32 words TypeScript fills before a query (the same numbers as kernel.ts).
pub static mut FILT: [i32; 264] = [0; 264];
pub const FILT_TAGS: usize = 8;

pub fn read_filter() -> Filter {
    unsafe {
        Filter {
            has: FILT[0] != 0,
            has_mask: FILT[1] != 0,
            mask: FILT[2],
            triggers: FILT[3] != 0,
            ignore_shape: FILT[4],
            ignore_node: FILT[5],
            tag_mode: FILT[6],
            tag: FILT[7],
        }
    }
}

/// world.ts `pass`.
#[inline(always)]
pub fn pass(id: usize, fl: &Filter) -> bool {
    let flags = i(id, s::FLAGS);
    if flags & s::F_ENABLED == 0 {
        return false;
    }
    let trigger = flags & s::F_TRIGGER != 0;
    if !fl.has {
        return !trigger;
    }
    if trigger && !fl.triggers {
        return false;
    }
    if fl.has_mask && (fl.mask & i(id, s::LAYER)) == 0 {
        return false;
    }
    if fl.ignore_shape == id as i32 {
        return false;
    }
    if fl.ignore_node > 0 && i(id, s::NODE) == fl.ignore_node {
        return false;
    }
    match fl.tag_mode {
        1 => i(id, s::TAG) == fl.tag,
        2 => {
            let t = i(id, s::TAG) as usize;
            let words = fl.tag as usize;
            t < words * 32 && unsafe { (FILT[FILT_TAGS + (t >> 5)] >> (t & 31)) & 1 != 0 }
        }
        _ => true,
    }
}

// ---------------------------------------------------------------- the moving-shape index (moving.ts)

const MI_MAX_CELLS: f64 = 16384.0;
const MI_MAX_SPAN: f64 = 16.0;
const FAR: f64 = 1e12;
const GRID: i32 = 0;
const WIDE: i32 = 1;
const LOOSE: i32 = 2;

pub struct MovingIndex {
    pub n: usize,
    built: bool,
    limit: usize,
    aabb: Vec<f64>,
    range: Vec<i32>,
    state: Vec<i32>,
    over: Vec<i32>,
    n_over: usize,
    loose: Vec<i32>,
    n_loose: usize,
    start: Vec<i32>,
    cursor: Vec<i32>,
    items: Vec<i32>,
    seen: Vec<i32>,
    stamp: i32,
    pub found: Vec<i32>,
    cs: f64,
    fi0: f64,
    fk0: f64,
    ni: usize,
    nk: usize,
}

impl MovingIndex {
    pub const fn new() -> Self {
        MovingIndex {
            n: 0, built: false, limit: 0, aabb: Vec::new(), range: Vec::new(), state: Vec::new(), over: Vec::new(), n_over: 0,
            loose: Vec::new(), n_loose: 0, start: Vec::new(), cursor: Vec::new(), items: Vec::new(), seen: Vec::new(), stamp: 0,
            found: Vec::new(), cs: 0.0, fi0: 0.0, fk0: 0.0, ni: 0, nk: 0,
        }
    }

    fn write(&mut self, slot: usize, id: usize) {
        let o = slot * 6;
        self.aabb[o] = f(id, s::MINX);
        self.aabb[o + 1] = f(id, s::MINY);
        self.aabb[o + 2] = f(id, s::MINZ);
        self.aabb[o + 3] = f(id, s::MAXX);
        self.aabb[o + 4] = f(id, s::MAXY);
        self.aabb[o + 5] = f(id, s::MAXZ);
    }

    pub fn add(&mut self, id: usize) -> usize {
        let slot = self.n;
        self.n += 1;
        if self.aabb.len() < self.n * 6 {
            let cap = if self.n > 128 { self.n * 2 } else { 256 };
            self.aabb.resize(cap * 6, 0.0);
            self.range.resize(cap * 4, 0);
            self.state.resize(cap, 0);
            self.over.resize(cap, 0);
            self.loose.resize(cap, 0);
            self.seen.resize(cap, 0);
            self.found.resize(cap, 0);
            self.items.resize(cap * MI_MAX_SPAN as usize, 0);
            if self.start.is_empty() {
                self.start.resize(MI_MAX_CELLS as usize + 1, 0);
                self.cursor.resize(MI_MAX_CELLS as usize, 0);
            }
        }
        self.write(slot, id);
        self.built = false;
        slot
    }

    /// Frees slot k; later slots move down one (the caller renumbers their shapes).
    pub fn remove(&mut self, k: usize) {
        self.aabb.copy_within((k + 1) * 6..self.n * 6, k * 6);
        self.n -= 1;
        self.built = false;
    }

    /// moving.ts `touch`.
    pub fn touch(&mut self, slot: usize, id: usize) {
        self.write(slot, id);
        if !self.built || self.state[slot] != GRID {
            return;
        }
        let (x0, z0, x1, z1) = (f(id, s::MINX), f(id, s::MINZ), f(id, s::MAXX), f(id, s::MAXZ));
        let (cs, fi0, fk0) = (self.cs, self.fi0, self.fk0);
        let r = slot * 4;
        let rg = &self.range;
        if floor(x0 / cs) - fi0 >= rg[r] as f64 && floor(x1 / cs) - fi0 <= rg[r + 1] as f64
            && floor(z0 / cs) - fk0 >= rg[r + 2] as f64 && floor(z1 / cs) - fk0 <= rg[r + 3] as f64 {
            return;
        }
        self.state[slot] = LOOSE;
        self.loose[self.n_loose] = slot as i32;
        self.n_loose += 1;
    }

    /// moving.ts `buildGrid`.
    fn build(&mut self, cell: f64) {
        let n = self.n;
        let a = &self.aabb;
        let (mut lox, mut hix, mut loz, mut hiz) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for k in 0..n {
            let o = k * 6;
            let (x0, z0, x1, z1) = (a[o], a[o + 2], a[o + 3], a[o + 5]);
            if x0 >= -FAR && x1 <= FAR && z0 >= -FAR && z1 <= FAR && x1 >= x0 && z1 >= z0 {
                self.state[k] = GRID;
                if x0 < lox { lox = x0; }
                if x1 > hix { hix = x1; }
                if z0 < loz { loz = z0; }
                if z1 > hiz { hiz = z1; }
            } else {
                self.state[k] = WIDE;
            }
        }
        let (mut cs, mut fi0, mut fk0, mut ni, mut nk) = (cell, 0.0, 0.0, 0usize, 0usize);
        if lox <= hix {
            loop {
                fi0 = floor(lox / cs);
                fk0 = floor(loz / cs);
                let w = floor(hix / cs) - fi0 + 1.0;
                let d = floor(hiz / cs) - fk0 + 1.0;
                if w * d <= MI_MAX_CELLS {
                    ni = w as usize;
                    nk = d as usize;
                    break;
                }
                cs *= 2.0;
            }
        }
        let cells = ni * nk;
        for c in 0..=cells {
            self.start[c] = 0;
        }
        let mut n_over = 0;
        for k in 0..n {
            if self.state[k] != GRID {
                self.over[n_over] = k as i32;
                n_over += 1;
                continue;
            }
            let o = k * 6;
            let a0 = floor(a[o] / cs) - fi0;
            let a1 = floor(a[o + 3] / cs) - fi0;
            let c0 = floor(a[o + 2] / cs) - fk0;
            let c1 = floor(a[o + 5] / cs) - fk0;
            if (a1 - a0 + 1.0) * (c1 - c0 + 1.0) > MI_MAX_SPAN {
                self.state[k] = WIDE;
                self.over[n_over] = k as i32;
                n_over += 1;
                continue;
            }
            let r = k * 4;
            let (a0, a1, c0, c1) = (a0 as i32, a1 as i32, c0 as i32, c1 as i32);
            self.range[r] = a0;
            self.range[r + 1] = a1;
            self.range[r + 2] = c0;
            self.range[r + 3] = c1;
            for x in a0..=a1 {
                for z in c0..=c1 {
                    self.start[x as usize * nk + z as usize + 1] += 1;
                }
            }
        }
        for c in 0..cells {
            self.start[c + 1] += self.start[c];
            self.cursor[c] = self.start[c];
        }
        for k in 0..n {
            if self.state[k] != GRID {
                continue;
            }
            let r = k * 4;
            for x in self.range[r]..=self.range[r + 1] {
                for z in self.range[r + 2]..=self.range[r + 3] {
                    let c = x as usize * nk + z as usize;
                    self.items[self.cursor[c] as usize] = k as i32;
                    self.cursor[c] += 1;
                }
            }
        }
        self.cs = cs;
        self.fi0 = fi0;
        self.fk0 = fk0;
        self.ni = ni;
        self.nk = nk;
        self.n_over = n_over;
        self.n_loose = 0;
    }

    pub fn prepare(&mut self, cell: f64) {
        if !self.built || self.n_loose > self.limit {
            self.build(cell);
            self.built = true;
            self.limit = 16 + (self.n >> 3);
        }
    }

    #[inline(always)]
    fn outside(&self, k: usize, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64) -> bool {
        let a = &self.aabb;
        let o = k * 6;
        a[o] > x1 || a[o + 3] < x0 || a[o + 1] > y1 || a[o + 4] < y0 || a[o + 2] > z1 || a[o + 5] < z0
    }

    fn linear(&mut self, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64) -> usize {
        let mut m = 0;
        for k in 0..self.n {
            if self.outside(k, x0, y0, z0, x1, y1, z1) {
                continue;
            }
            self.found[m] = k as i32;
            m += 1;
        }
        m
    }

    /// moving.ts `box`: slots whose bounds meet the box, rising, into `found`.
    pub fn query(&mut self, cell: f64, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64) -> usize {
        let n = self.n;
        if n == 0 {
            return 0;
        }
        self.prepare(cell);
        if x0 != x0 || x1 != x1 || z0 != z0 || z1 != z1 {
            return self.linear(x0, y0, z0, x1, y1, z1);
        }
        let (cs, ni, nk) = (self.cs, self.ni as f64, self.nk);
        let mut a0 = floor(x0 / cs) - self.fi0;
        let mut a1 = floor(x1 / cs) - self.fi0;
        let mut c0 = floor(z0 / cs) - self.fk0;
        let mut c1 = floor(z1 / cs) - self.fk0;
        if a0 < 0.0 { a0 = 0.0; }
        if c0 < 0.0 { c0 = 0.0; }
        if a1 > ni - 1.0 { a1 = ni - 1.0; }
        if c1 > nk as f64 - 1.0 { c1 = nk as f64 - 1.0; }
        if a1 >= a0 && c1 >= c0 && (a1 - a0 + 1.0) * (c1 - c0 + 1.0) > n as f64 {
            return self.linear(x0, y0, z0, x1, y1, z1);
        }
        if self.stamp == i32::MAX {
            for v in self.seen.iter_mut() { *v = 0; }
            self.stamp = 0;
        }
        self.stamp += 1;
        let stamp = self.stamp;
        let mut m = 0;
        if a1 >= a0 && c1 >= c0 {
            for x in a0 as usize..=a1 as usize {
                for z in c0 as usize..=c1 as usize {
                    let c = x * nk + z;
                    for j in self.start[c] as usize..self.start[c + 1] as usize {
                        let k = self.items[j] as usize;
                        if self.seen[k] == stamp { continue; }
                        self.seen[k] = stamp;
                        if self.outside(k, x0, y0, z0, x1, y1, z1) { continue; }
                        self.found[m] = k as i32;
                        m += 1;
                    }
                }
            }
        }
        for j in 0..self.n_over {
            let k = self.over[j] as usize;
            if self.outside(k, x0, y0, z0, x1, y1, z1) { continue; }
            self.found[m] = k as i32;
            m += 1;
        }
        for j in 0..self.n_loose {
            let k = self.loose[j] as usize;
            if self.seen[k] == stamp || self.outside(k, x0, y0, z0, x1, y1, z1) { continue; }
            self.found[m] = k as i32;
            m += 1;
        }
        // Back into rising order: the order shapes were added, which settles ties.
        let fd = &mut self.found[..m];
        if m > 48 {
            fd.sort_unstable();
        } else {
            for j in 1..m {
                let v = fd[j];
                let mut k = j;
                while k > 0 && fd[k - 1] > v {
                    fd[k] = fd[k - 1];
                    k -= 1;
                }
                fd[k] = v;
            }
        }
        m
    }
}

// ---------------------------------------------------------------- the world

pub struct World {
    pub cell: f64,
    /// Static shapes in the grid, in the order added (world.ts `statics`).
    pub statics: Vec<i32>,
    /// Static shapes too wide for the grid, and planes (world.ts `bigs`).
    pub bigs: Vec<i32>,
    /// Moving shapes by slot (world.ts `moving`).
    pub moving: Vec<i32>,
    /// Cell range each static shape was filed under when it was added: i0, i1, k0, k1, by shape id.
    srange: Vec<f64>,
    sg_dirty: bool,
    sg_i0: f64,
    sg_k0: f64,
    sg_ni: usize,
    sg_nk: usize,
    sg_start: Vec<i32>,
    sg_items: Vec<i32>,
    stamp: i32,
    pub mi: MovingIndex,
    dda: Dda,
    pub cand: Vec<i32>,
    pub out: Vec<i32>,
    pub dirty: Vec<i32>,
    /// Set when the world cannot be held here (the static grid would be too large); TypeScript then drops the kernel.
    pub failed: i32,
}

pub static mut W: World = World {
    cell: 16.0, statics: Vec::new(), bigs: Vec::new(), moving: Vec::new(), srange: Vec::new(), sg_dirty: false, sg_i0: 0.0,
    sg_k0: 0.0, sg_ni: 0, sg_nk: 0, sg_start: Vec::new(), sg_items: Vec::new(), stamp: 0, mi: MovingIndex::new(),
    dda: Dda::new(), cand: Vec::new(), out: Vec::new(), dirty: Vec::new(), failed: 0,
};

impl World {
    fn next_stamp(&mut self) -> i32 {
        if self.stamp == i32::MAX {
            let cap = unsafe { s::SH.cap };
            for id in 0..cap { set_i(id, s::STAMP, 0); }
            self.stamp = 0;
        }
        self.stamp += 1;
        self.stamp
    }

    /// world.ts `add` after the Shape is made: a static shape to the grid or the short list, a moving one to the index.
    pub fn commit(&mut self, id: usize) {
        if self.srange.len() < unsafe { s::SH.cap } * 4 {
            self.srange.resize(unsafe { s::SH.cap } * 4 + 64, 0.0);
        }
        if flag(id, s::F_STATIC) {
            let c = self.cell;
            let i0 = floor(f(id, s::MINX) / c);
            let i1 = floor(f(id, s::MAXX) / c);
            let k0 = floor(f(id, s::MINZ) / c);
            let k1 = floor(f(id, s::MAXZ) / c);
            if s::kind(id) == s::K_PLANE || (i1 - i0 + 1.0) * (k1 - k0 + 1.0) > MAX_STATIC_CELLS {
                set_i(id, s::WHERE, s::WHERE_BIG);
                self.bigs.push(id as i32);
                return;
            }
            let o = id * 4;
            self.srange[o] = i0;
            self.srange[o + 1] = i1;
            self.srange[o + 2] = k0;
            self.srange[o + 3] = k1;
            set_i(id, s::WHERE, s::WHERE_GRID);
            self.statics.push(id as i32);
            self.sg_dirty = true;
        } else {
            set_i(id, s::WHERE, s::WHERE_MOVING);
            self.moving.push(id as i32);
            let slot = self.mi.add(id);
            set_i(id, s::SLOT, slot as i32);
        }
    }

    pub fn remove(&mut self, id: usize) {
        match i(id, s::WHERE) {
            s::WHERE_GRID => {
                if let Some(k) = self.statics.iter().position(|&x| x == id as i32) { self.statics.remove(k); }
                self.sg_dirty = true;
            }
            s::WHERE_BIG => {
                if let Some(k) = self.bigs.iter().position(|&x| x == id as i32) { self.bigs.remove(k); }
            }
            s::WHERE_MOVING => {
                let k = i(id, s::SLOT) as usize;
                self.moving.remove(k);
                self.mi.remove(k);
                for j in k..self.moving.len() { set_i(self.moving[j] as usize, s::SLOT, j as i32); }
            }
            _ => {}
        }
        set_i(id, s::WHERE, s::WHERE_FREE);
        set_i(id, s::SLOT, -1);
        set_i(id, s::FLAGS, 0);
        unsafe { s::SH.free.push(id as i32) };
    }

    /// Shapes TypeScript moved since the last query: their new bounds into the index.
    pub fn flush(&mut self) {
        unsafe {
            let n = crate::mem::HDR[crate::h::NDIRTY] as usize;
            for j in 0..n {
                let id = self.dirty[j] as usize;
                set_i(id, s::FLAGS, i(id, s::FLAGS) & !s::F_DIRTY);
                if i(id, s::WHERE) == s::WHERE_MOVING {
                    self.mi.touch(i(id, s::SLOT) as usize, id);
                }
            }
            crate::mem::HDR[crate::h::NDIRTY] = 0;
        }
    }

    /// Dense CSR over the static shapes' cells, filled in the order they were added, as world.ts's Map of lists is.
    fn build_static(&mut self) {
        self.sg_dirty = false;
        if self.statics.is_empty() {
            self.sg_ni = 0;
            self.sg_nk = 0;
            self.sg_items.clear();
            return;
        }
        let (mut i0, mut i1, mut k0, mut k1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for &id in self.statics.iter() {
            let o = id as usize * 4;
            let r = &self.srange[o..o + 4];
            if r[0] < i0 { i0 = r[0]; }
            if r[1] > i1 { i1 = r[1]; }
            if r[2] < k0 { k0 = r[2]; }
            if r[3] > k1 { k1 = r[3]; }
        }
        let ni = i1 - i0 + 1.0;
        let nk = k1 - k0 + 1.0;
        if !(ni * nk <= MAX_GRID) {
            self.failed = 1;
            return;
        }
        let (ni, nk) = (ni as usize, nk as usize);
        self.sg_i0 = i0;
        self.sg_k0 = k0;
        self.sg_ni = ni;
        self.sg_nk = nk;
        let cells = ni * nk;
        self.sg_start.clear();
        self.sg_start.resize(cells + 1, 0);
        for &id in self.statics.iter() {
            let o = id as usize * 4;
            let (a0, a1, c0, c1) = ((self.srange[o] - i0) as usize, (self.srange[o + 1] - i0) as usize, (self.srange[o + 2] - k0) as usize, (self.srange[o + 3] - k0) as usize);
            for x in a0..=a1 { for z in c0..=c1 { self.sg_start[x * nk + z + 1] += 1; } }
        }
        for c in 0..cells { self.sg_start[c + 1] += self.sg_start[c]; }
        let total = self.sg_start[cells] as usize;
        self.sg_items.clear();
        self.sg_items.resize(total, 0);
        let mut cur: Vec<i32> = self.sg_start[..cells].to_vec();
        for &id in self.statics.iter() {
            let o = id as usize * 4;
            let (a0, a1, c0, c1) = ((self.srange[o] - i0) as usize, (self.srange[o + 1] - i0) as usize, (self.srange[o + 2] - k0) as usize, (self.srange[o + 3] - k0) as usize);
            for x in a0..=a1 {
                for z in c0..=c1 {
                    let c = x * nk + z;
                    self.sg_items[cur[c] as usize] = id;
                    cur[c] += 1;
                }
            }
        }
    }

    #[inline(always)]
    fn ready(&mut self) {
        if self.sg_dirty { self.build_static(); }
    }

    /// The static shapes in cell (i, k), as a range of sg_items; empty outside the grid.
    #[inline(always)]
    fn cell_range(&self, i: f64, k: f64) -> (usize, usize) {
        let a = i - self.sg_i0;
        let b = k - self.sg_k0;
        if !(a >= 0.0 && b >= 0.0 && a < self.sg_ni as f64 && b < self.sg_nk as f64) {
            return (0, 0);
        }
        let c = a as usize * self.sg_nk + b as usize;
        (self.sg_start[c] as usize, self.sg_start[c + 1] as usize)
    }

    fn test_cell(&mut self, ci: f64, ck: f64, stamp: i32, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64, fl: &Filter) {
        let (a, b) = self.cell_range(ci, ck);
        for j in a..b {
            let id = self.sg_items[j] as usize;
            if i(id, s::STAMP) == stamp { continue; }
            set_i(id, s::STAMP, stamp);
            if !pass(id, fl) { continue; }
            narrow::sweep_shape(id, ox, oy, oz, dx, dy, dz, r);
        }
    }

    /// world.ts `cast`: sweeps a sphere from o along unit d up to B.t; the best hit is left in B.
    pub fn cast(&mut self, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, r: f64, fl: &Filter) {
        self.ready();
        let max_t = unsafe { B.t };
        let stamp = self.next_stamp();
        let c = self.cell;
        if !self.sg_items.is_empty() {
            let mut box_mode = false;
            let (mut i0, mut i1, mut k0, mut k1) = (0.0, 0.0, 0.0, 0.0);
            if r > 0.0 {
                let ex = ox + dx * max_t;
                let ez = oz + dz * max_t;
                i0 = floor((crate::math::min(ox, ex) - r) / c);
                i1 = floor((crate::math::max(ox, ex) + r) / c);
                k0 = floor((crate::math::min(oz, ez) - r) / c);
                k1 = floor((crate::math::max(oz, ez) + r) / c);
                box_mode = (i1 - i0 + 1.0) * (k1 - k0 + 1.0) <= BOX_CELLS;
            }
            if box_mode {
                let mut i = i0;
                while i <= i1 {
                    let mut k = k0;
                    while k <= k1 {
                        self.test_cell(i, k, stamp, ox, oy, oz, dx, dy, dz, r, fl);
                        k += 1.0;
                    }
                    i += 1.0;
                }
            } else {
                let ring = if r > 0.0 { ceil(r / c) } else { 0.0 };
                self.dda.init(ox, oz, dx, dz, max_t, c);
                let mut n = 0;
                while n < 100000 {
                    if ring == 0.0 {
                        let (ix, iz) = (self.dda.ix, self.dda.iz);
                        self.test_cell(ix, iz, stamp, ox, oy, oz, dx, dy, dz, r, fl);
                        if unsafe { B.shape } != -1 && unsafe { B.t } <= self.dda.t_exit() { break; }
                    } else {
                        let mut i = self.dda.ix - ring;
                        while i <= self.dda.ix + ring {
                            let mut k = self.dda.iz - ring;
                            while k <= self.dda.iz + ring {
                                self.test_cell(i, k, stamp, ox, oy, oz, dx, dy, dz, r, fl);
                                k += 1.0;
                            }
                            i += 1.0;
                        }
                    }
                    if !self.dda.advance() { break; }
                    n += 1;
                }
            }
        }
        for j in 0..self.bigs.len() {
            let id = self.bigs[j] as usize;
            if !pass(id, fl) { continue; }
            if !narrow::ray_aabb(ox, oy, oz, dx, dy, dz, f(id, s::MINX) - r, f(id, s::MINY) - r, f(id, s::MINZ) - r, f(id, s::MAXX) + r, f(id, s::MAXY) + r, f(id, s::MAXZ) + r, unsafe { B.t }) { continue; }
            narrow::sweep_shape(id, ox, oy, oz, dx, dy, dz, r);
        }
        // Moving shapes near what is left of the sweep, padded so rounding can only add one (world.ts says why).
        let bt = unsafe { B.t };
        let (tx, ty, tz) = (ox + dx * bt, oy + dy * bt, oz + dz * bt);
        let pad = r + 1e-3 + 1e-9 * (abs(ox) + abs(oy) + abs(oz) + abs(tx) + abs(ty) + abs(tz));
        let m = self.mi.query(c,
            (if ox < tx { ox } else { tx }) - pad, (if oy < ty { oy } else { ty }) - pad, (if oz < tz { oz } else { tz }) - pad,
            (if ox > tx { ox } else { tx }) + pad, (if oy > ty { oy } else { ty }) + pad, (if oz > tz { oz } else { tz }) + pad);
        for j in 0..m {
            let id = self.moving[self.mi.found[j] as usize] as usize;
            if !pass(id, fl) { continue; }
            if !narrow::ray_aabb(ox, oy, oz, dx, dy, dz, f(id, s::MINX) - r, f(id, s::MINY) - r, f(id, s::MINZ) - r, f(id, s::MAXX) + r, f(id, s::MAXY) + r, f(id, s::MAXZ) + r, unsafe { B.t }) { continue; }
            narrow::sweep_shape(id, ox, oy, oz, dx, dy, dz, r);
        }
    }

    #[inline(always)]
    fn take(&mut self, id: usize, stamp: i32, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64, fl: &Filter) {
        if i(id, s::STAMP) == stamp { return; }
        set_i(id, s::STAMP, stamp);
        if f(id, s::MINX) > x1 || f(id, s::MAXX) < x0 || f(id, s::MINY) > y1 || f(id, s::MAXY) < y0 || f(id, s::MINZ) > z1 || f(id, s::MAXZ) < z0 { return; }
        if !pass(id, fl) { return; }
        self.cand.push(id as i32);
    }

    /// world.ts `gather`: shapes whose bounds meet the box and pass the filter, into `cand`.
    pub fn gather(&mut self, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64, fl: &Filter) {
        self.ready();
        self.cand.clear();
        let stamp = self.next_stamp();
        let c = self.cell;
        let (i0, i1, k0, k1) = (floor(x0 / c), floor(x1 / c), floor(z0 / c), floor(z1 / c));
        if (i1 - i0 + 1.0) * (k1 - k0 + 1.0) > 4096.0 {
            for j in 0..self.statics.len() {
                let id = self.statics[j] as usize;
                self.take(id, stamp, x0, y0, z0, x1, y1, z1, fl);
            }
        } else {
            let mut i = i0;
            while i <= i1 {
                let mut k = k0;
                while k <= k1 {
                    let (a, b) = self.cell_range(i, k);
                    for j in a..b {
                        let id = self.sg_items[j] as usize;
                        self.take(id, stamp, x0, y0, z0, x1, y1, z1, fl);
                    }
                    k += 1.0;
                }
                i += 1.0;
            }
        }
        for j in 0..self.bigs.len() {
            let id = self.bigs[j] as usize;
            self.take(id, stamp, x0, y0, z0, x1, y1, z1, fl);
        }
        let m = self.mi.query(c, x0, y0, z0, x1, y1, z1);
        for j in 0..m {
            let id = self.moving[self.mi.found[j] as usize] as usize;
            if pass(id, fl) { self.cand.push(id as i32); }
        }
    }
}
