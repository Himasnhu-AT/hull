//! The module's memory: an allocator for `alloc` (Vec) that frees, and the header TypeScript reads to find its views.
//!
//! TypeScript holds typed-array views over arrays that live here. Whenever one of them may have appeared, moved or
//! changed size (any allocation, or the memory growing, which detaches the old ArrayBuffer), `EPOCH` goes up, and the
//! TypeScript side makes its views again before it next writes.
//!
//! Blocks come from a bump pointer and, once freed, go on a free list for their size class and are handed out again,
//! so a world that adds and removes shapes (a mesh's arrays, a grid cell's list) reuses its memory instead of
//! growing without end. Sizes are rounded up to a quarter step of a power of two (at most 25% waste), which is why
//! a freed block of one size fits any later request of the same class. The memory itself never shrinks: the module
//! cannot hand pages back, so what is kept is the most the world has held at once.
use core::alloc::{GlobalAlloc, Layout};
use core::arch::wasm32::{memory_grow, memory_size};
use core::ptr::{addr_of, null_mut};

extern "C" {
    static __heap_base: u8;
}

pub struct Bump;

static mut NEXT: usize = 0;
/// Head of the free list of each size class (0 for none). A free block holds the next block's address in its first word.
static mut FREE: [usize; CLASSES] = [0; CLASSES];

/// Blocks are multiples of this and aligned to it, which covers every type the kernel allocates.
const GRAIN: usize = 16;
const CLASSES: usize = 128;

/// Header slots TypeScript reads (`hk_hdr` gives its address). Fixed in the data segment, so it never moves.
pub static mut HDR: [i32; 64] = [0; 64];
pub const H_EPOCH: usize = 0;

/// The class of a request and the size of every block in it. Up to 64 bytes a class is one grain wide; above that
/// each doubling is cut into four.
fn class_of(size: usize) -> (usize, usize) {
    if size <= 64 {
        let n = if size == 0 { 1 } else { (size + GRAIN - 1) / GRAIN };
        return (n - 1, n * GRAIN);
    }
    let m = size - 1;
    let e = 31 - (m as u32).leading_zeros() as usize;
    let step = e - 2;
    let top = m >> step;
    (4 + (e - 6) * 4 + (top & 3), (top + 1) << step)
}

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
        if l.align() > GRAIN {
            return null_mut();
        }
        let (class, size) = class_of(l.size());
        // A first allocation can be a new array TypeScript holds a view of (an empty Vec has none yet), so it counts.
        bump_epoch();
        let head = FREE[class];
        if head != 0 {
            FREE[class] = *(head as *const usize);
            return head as *mut u8;
        }
        if NEXT == 0 {
            NEXT = (addr_of!(__heap_base) as usize + GRAIN - 1) & !(GRAIN - 1);
        }
        let start = NEXT;
        if !ensure(start + size) {
            return null_mut();
        }
        NEXT = start + size;
        start as *mut u8
    }

    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        let (class, _) = class_of(l.size());
        *(p as *mut usize) = FREE[class];
        FREE[class] = p as usize;
    }

    unsafe fn realloc(&self, p: *mut u8, l: Layout, new_size: usize) -> *mut u8 {
        // Any change of size or place is something TypeScript's views must hear about.
        bump_epoch();
        let (c0, s0) = class_of(l.size());
        let (c1, s1) = class_of(new_size);
        if c0 == c1 {
            return p;
        }
        // The newest block grows in place: a Vec doubling at the end of the heap leaves no copy behind.
        if p as usize + s0 == NEXT {
            if !ensure(p as usize + s1) {
                return null_mut();
            }
            NEXT = p as usize + s1;
            return p;
        }
        let q = self.alloc(Layout::from_size_align_unchecked(new_size, l.align()));
        if !q.is_null() {
            core::ptr::copy_nonoverlapping(p, q, if l.size() < new_size { l.size() } else { new_size });
            self.dealloc(p, l);
        }
        q
    }
}
