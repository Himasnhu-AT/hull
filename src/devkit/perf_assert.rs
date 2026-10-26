//! Perf assertions for tests: frame-time percentiles, entity counts and allocations per frame.
//!
//! Allocation counting needs the counting allocator installed in the *test binary*:
//!
//! ```ignore
//! #[global_allocator]
//! static ALLOC: engine::devkit::CountingAlloc = engine::devkit::CountingAlloc;
//! ```
//!
//! It wraps the system allocator with three relaxed atomic adds per call (all threads), so
//! numbers include Bevy's task pools. Without it, alloc budgets are skipped (reported `null`).

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;

static ALLOCS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);
static FREES: AtomicU64 = AtomicU64::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// Counting global allocator (see the module docs).
pub struct CountingAlloc;

// SAFETY: forwards every call to `System` unchanged; only adds counters.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        if !INSTALLED.load(Ordering::Relaxed) {
            INSTALLED.store(true, Ordering::Relaxed);
        }
        // SAFETY: same contract as the caller's.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        // SAFETY: same contract as the caller's.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        FREES.fetch_add(1, Ordering::Relaxed);
        // SAFETY: same contract as the caller's.
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(new_size as u64, Ordering::Relaxed);
        // SAFETY: same contract as the caller's.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

/// Process-wide allocation counters (all zero unless [`CountingAlloc`] is installed).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct AllocCounts {
    pub allocs: u64,
    pub bytes: u64,
    pub frees: u64,
}

impl AllocCounts {
    pub fn now() -> Self {
        AllocCounts { allocs: ALLOCS.load(Ordering::Relaxed), bytes: BYTES.load(Ordering::Relaxed), frees: FREES.load(Ordering::Relaxed) }
    }
    pub fn since(self, earlier: AllocCounts) -> AllocCounts {
        AllocCounts {
            allocs: self.allocs.wrapping_sub(earlier.allocs),
            bytes: self.bytes.wrapping_sub(earlier.bytes),
            frees: self.frees.wrapping_sub(earlier.frees),
        }
    }
}

/// `true` once [`CountingAlloc`] has served an allocation (i.e. it is the global allocator).
pub fn counting_installed() -> bool {
    if INSTALLED.load(Ordering::Relaxed) {
        return true;
    }
    drop(std::hint::black_box(Box::new(0u64)));
    INSTALLED.load(Ordering::Relaxed)
}

/// `{n, min, avg, p50, p95, p99, max}`: the same stat shape as the metrics history
/// (`sessions.jsonl`), so bench JSON and session JSON compare the same way.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct Summary {
    pub n: usize,
    pub min: f64,
    pub avg: f64,
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
}

impl Summary {
    /// Nearest-rank percentiles of `samples` (sorts a copy).
    pub fn of(samples: &[f64]) -> Summary {
        if samples.is_empty() {
            return Summary::default();
        }
        let mut v = samples.to_vec();
        v.sort_by(f64::total_cmp);
        let pct = |p: f64| v[(((v.len() - 1) as f64) * p).round() as usize];
        Summary {
            n: v.len(),
            min: v[0],
            avg: v.iter().sum::<f64>() / v.len() as f64,
            p50: pct(0.5),
            p95: pct(0.95),
            p99: pct(0.99),
            max: v[v.len() - 1],
        }
    }
}

/// Per-frame samples a [`super::Scenario`] collects while stepping: wall-clock update time
/// and (with [`CountingAlloc`]) allocations. Preallocated; recording never allocates until
/// `capacity` frames.
#[derive(Clone, Debug, Default)]
pub struct FrameTimes {
    pub ms: Vec<f64>,
    pub allocs: Vec<f64>,
}

impl FrameTimes {
    pub fn with_capacity(n: usize) -> Self {
        FrameTimes { ms: Vec::with_capacity(n), allocs: Vec::with_capacity(n) }
    }
    pub fn push(&mut self, dt: Duration, allocs: Option<u64>) {
        self.ms.push(dt.as_secs_f64() * 1000.0);
        if let Some(a) = allocs {
            self.allocs.push(a as f64);
        }
    }
    pub fn clear(&mut self) {
        self.ms.clear();
        self.allocs.clear();
    }
    pub fn frame_ms(&self) -> Summary {
        Summary::of(&self.ms)
    }
    /// `None` without [`CountingAlloc`].
    pub fn allocs_per_frame(&self) -> Option<Summary> {
        (!self.allocs.is_empty()).then(|| Summary::of(&self.allocs))
    }
}

/// Budgets to assert after a scenario. `None` = unchecked. Build with `..default()`.
#[derive(Clone, Debug, Default)]
pub struct PerfBudget {
    /// p95 of the wall-clock `App::update()` time, ms.
    pub p95_frame_ms: Option<f64>,
    /// Worst single frame, ms.
    pub max_frame_ms: Option<f64>,
    /// Entities alive at the end (`World::entities().count_spawned()`).
    pub max_entities: Option<u32>,
    /// p95 allocations per frame (needs [`CountingAlloc`]; skipped otherwise).
    pub p95_allocs_per_frame: Option<f64>,
    /// Frames at the start left out of every statistic (shader/asset warmup, first spawns).
    pub warmup_frames: usize,
}

/// What a budget check measured.
#[derive(Clone, Debug, Serialize)]
pub struct PerfResult {
    pub frames: usize,
    pub frame_ms: Summary,
    pub allocs_per_frame: Option<Summary>,
    pub entities: u32,
    /// Every budget that was exceeded, as readable lines.
    pub violations: Vec<String>,
}

impl PerfBudget {
    pub fn check(&self, times: &FrameTimes, entities: u32) -> PerfResult {
        let skip = self.warmup_frames.min(times.ms.len());
        let ms = Summary::of(&times.ms[skip..]);
        let allocs = (!times.allocs.is_empty()).then(|| Summary::of(&times.allocs[skip.min(times.allocs.len())..]));
        let mut v = Vec::new();
        if let Some(b) = self.p95_frame_ms
            && ms.p95 > b
        {
            v.push(format!("p95 frame {:.3} ms > budget {b:.3} ms", ms.p95));
        }
        if let Some(b) = self.max_frame_ms
            && ms.max > b
        {
            v.push(format!("max frame {:.3} ms > budget {b:.3} ms", ms.max));
        }
        if let Some(b) = self.max_entities
            && entities > b
        {
            v.push(format!("{entities} entities > budget {b}"));
        }
        if let (Some(b), Some(a)) = (self.p95_allocs_per_frame, allocs)
            && a.p95 > b
        {
            v.push(format!("p95 {:.0} allocations/frame > budget {b:.0}", a.p95));
        }
        PerfResult { frames: ms.n, frame_ms: ms, allocs_per_frame: allocs, entities, violations: v }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_percentiles() {
        let s = Summary::of(&(1..=100).map(f64::from).collect::<Vec<_>>());
        assert_eq!((s.n, s.min, s.max), (100, 1.0, 100.0));
        assert_eq!(s.p50, 51.0);
        assert_eq!(s.p95, 95.0);
        assert!((s.avg - 50.5).abs() < 1e-9);
        assert_eq!(Summary::of(&[]).n, 0);
    }

    #[test]
    fn budget_violations() {
        let mut t = FrameTimes::default();
        for i in 0..100 {
            t.push(Duration::from_micros(if i < 5 { 50_000 } else { 1_000 }), Some(10));
        }
        let ok = PerfBudget { p95_frame_ms: Some(2.0), p95_allocs_per_frame: Some(20.0), warmup_frames: 5, ..Default::default() }.check(&t, 10);
        assert!(ok.violations.is_empty(), "{:?}", ok.violations);
        let bad = PerfBudget { max_frame_ms: Some(10.0), max_entities: Some(5), p95_allocs_per_frame: Some(1.0), ..Default::default() }.check(&t, 10);
        assert_eq!(bad.violations.len(), 3, "{:?}", bad.violations);
    }
}
