//! The module's memory: a bump allocator for `alloc` (Vec), and the header TypeScript reads to find its views.
//!
//! TypeScript holds typed-array views over arrays that live here. Whenever one of them may have moved or changed
//! size (any reallocation, or the memory growing, which detaches the old ArrayBuffer), `EPOCH` goes up, and the
//! TypeScript side makes its views again before it next writes. Nothing is freed except the newest block, so a
//! Vec that grows by doubling leaves at most its old copies behind: bounded, and a world's tables only grow.
use core::alloc::{GlobalAlloc, Layout};
use core::arch::wasm32::{memory_grow, memory_size};
use core::ptr::{addr_of, null_mut};

extern "C" {
    static __heap_base: u8;
}

pub struct Bump;

static mut NEXT: usize = 0;
static mut LAST: usize = 0;

/// Header slots TypeScript reads (`hk_hdr` gives its address). Fixed in the data segment, so it never moves.
pub static mut HDR: [i32; 64] = [0; 64];
pub const H_EPOCH: usize = 0;

fn ensure(end: usize) -> bool {
    let have = memory_size(0) * 65536;
    if end > have {
        let pages = (end - have + 65535) / 65536;
        if memory_grow(0, pages) == usize::MAX {
            return false;
        }
        bump_epoch();
    }
    true
}

pub fn bump_epoch() {
    unsafe { HDR[H_EPOCH] = HDR[H_EPOCH].wrapping_add(1) };
}

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if NEXT == 0 {
            NEXT = addr_of!(__heap_base) as usize;
        }
        let start = (NEXT + l.align() - 1) & !(l.align() - 1);
        let end = start + l.size();
        if !ensure(end) {
            return null_mut();
        }
        LAST = start;
        NEXT = end;
        start as *mut u8
    }

    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        if p as usize == LAST && LAST + l.size() == NEXT {
            NEXT = LAST;
            LAST = 0;
        }
    }

    unsafe fn realloc(&self, p: *mut u8, l: Layout, new_size: usize) -> *mut u8 {
        // Any change of size or place is something TypeScript's views must hear about.
        bump_epoch();
        if p as usize == LAST && LAST + l.size() == NEXT {
            if !ensure(LAST + new_size) {
                return null_mut();
            }
            NEXT = LAST + new_size;
            return p;
        }
        let q = self.alloc(Layout::from_size_align_unchecked(new_size, l.align()));
        if !q.is_null() {
            core::ptr::copy_nonoverlapping(p, q, if l.size() < new_size { l.size() } else { new_size });
        }
        q
    }
}
