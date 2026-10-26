//! CPU scope timers: `profile_scope!("pathfind")` times the rest of the enclosing block.
//!
//! - Each call site owns a `static` [`ScopeStat`] (atomics only): entering costs one
//!   `Instant::now()`, leaving one `Instant::now()` + three relaxed atomic ops. No allocation
//!   after the first call (which registers the scope once).
//! - Once per frame (`Last`) [`ScopeReport`] folds the counters into per-frame stats: ms per
//!   frame (EMA + max over the last second), calls per frame. Shown as the `scopes` row in the
//!   perf overlay / `perf.stats` (`DebugLines`), as `span.<name>_ms` metrics, and by the
//!   `devkit.scopes` control command.
//! - With the `profile` feature (`bevy/trace_tracy`) every scope is also a Tracy span. Bevy's
//!   own system spans come with that feature too: run `tracy` and connect.
//! - Systems as a whole: `engine::devtools::PerfAppExt::perf_span(schedule, set, label)`.
//!   GPU pass timings: `perf.stats` → `perf.gpu.passes` (`--gpu-passes` on macOS).
//!
//! No scope used → the fold system returns at once.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use bevy::prelude::*;
use serde::Serialize;

/// Tracy spans compiled in (feature `profile`).
pub const TRACY: bool = cfg!(feature = "profile");

static SCOPES: Mutex<Vec<&'static ScopeStat>> = Mutex::new(Vec::new());

/// Counters of one scope call site (see [`profile_scope!`](crate::profile_scope)).
pub struct ScopeStat {
    pub name: &'static str,
    ns: AtomicU64,
    calls: AtomicU64,
    max_ns: AtomicU64,
    registered: AtomicBool,
}

impl ScopeStat {
    pub const fn new(name: &'static str) -> Self {
        ScopeStat { name, ns: AtomicU64::new(0), calls: AtomicU64::new(0), max_ns: AtomicU64::new(0), registered: AtomicBool::new(false) }
    }

    #[inline]
    pub fn enter(&'static self) -> ScopeGuard {
        if !self.registered.load(Ordering::Relaxed)
            && !self.registered.swap(true, Ordering::AcqRel)
            && let Ok(mut v) = SCOPES.lock()
        {
            v.push(self);
        }
        ScopeGuard { stat: self, start: Instant::now() }
    }

    /// Adds one timed call (also usable without the guard, e.g. for measured durations).
    #[inline]
    pub fn record_ns(&self, ns: u64) {
        self.ns.fetch_add(ns, Ordering::Relaxed);
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.max_ns.fetch_max(ns, Ordering::Relaxed);
    }

    fn take(&self) -> (u64, u64, u64) {
        (self.ns.swap(0, Ordering::Relaxed), self.calls.swap(0, Ordering::Relaxed), self.max_ns.swap(0, Ordering::Relaxed))
    }
}

/// Ends the scope on drop.
pub struct ScopeGuard {
    stat: &'static ScopeStat,
    start: Instant,
}

impl Drop for ScopeGuard {
    #[inline]
    fn drop(&mut self) {
        self.stat.record_ns(self.start.elapsed().as_nanos() as u64);
    }
}

/// Times the rest of the enclosing block under `name` (a string literal).
///
/// ```ignore
/// fn think(..) {
///     engine::profile_scope!("ai.think");
///     ...
/// }
/// ```
#[macro_export]
macro_rules! profile_scope {
    ($name:literal) => {
        static __ENGINE_SCOPE: $crate::devkit::profile::ScopeStat = $crate::devkit::profile::ScopeStat::new($name);
        let _engine_scope_guard = __ENGINE_SCOPE.enter();
        let _engine_tracy_span = if $crate::devkit::profile::TRACY {
            Some($crate::bevy::log::info_span!($name).entered())
        } else {
            None
        };
    };
}

/// One scope's per-frame numbers.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ScopeRow {
    pub name: &'static str,
    /// Smoothed ms per frame (EMA, α = 0.1).
    pub ms: f64,
    /// Last frame's ms.
    pub last_ms: f64,
    /// Worst frame ms in the last second-ish window (decays).
    pub max_ms: f64,
    /// Longest single call, ms, last frame.
    pub max_call_ms: f64,
    pub calls: u64,
}

/// Per-frame scope stats (folded in `Last`).
#[derive(Resource, Default, Debug, Serialize)]
pub struct ScopeReport {
    pub rows: Vec<ScopeRow>,
    #[serde(skip)]
    frames: u64,
    /// Reused overlay text buffer (devtools).
    #[serde(skip)]
    #[cfg_attr(not(feature = "devtools"), allow(dead_code))]
    line: String,
}

impl ScopeReport {
    pub fn get(&self, name: &str) -> Option<&ScopeRow> {
        self.rows.iter().find(|r| r.name == name)
    }
}

pub(super) struct ProfilePlugin;

impl Plugin for ProfilePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ScopeReport>().add_systems(Last, fold_scopes);
        #[cfg(feature = "devtools")]
        {
            use crate::devtools::{AddControlCommand, params};
            app.add_control_command("devkit.scopes", "profile_scope! timings (ms per frame, calls)", params(&[]), |w, _| {
                serde_json::to_value(w.resource::<ScopeReport>()).map_err(|e| e.to_string())
            });
        }
    }
}

fn fold_scopes(
    mut report: ResMut<ScopeReport>,
    #[cfg(feature = "devtools")] metrics: Option<ResMut<crate::devtools::Metrics>>,
    #[cfg(feature = "devtools")] lines: Option<ResMut<crate::devtools::DebugLines>>,
) {
    let Ok(scopes) = SCOPES.lock() else { return };
    if scopes.is_empty() {
        return;
    }
    let report = &mut *report;
    report.frames += 1;
    for s in scopes.iter() {
        let (ns, calls, max_ns) = s.take();
        let ms = ns as f64 / 1e6;
        let row = match report.rows.iter().position(|r| r.name == s.name) {
            Some(i) => &mut report.rows[i],
            None => {
                report.rows.push(ScopeRow { name: s.name, ms, ..default() });
                report.rows.last_mut().expect("just pushed")
            }
        };
        row.ms += 0.1 * (ms - row.ms);
        row.last_ms = ms;
        row.max_ms = (row.max_ms * 0.98).max(ms);
        row.max_call_ms = max_ns as f64 / 1e6;
        row.calls = calls;
    }
    #[cfg(feature = "devtools")]
    {
        if let Some(mut m) = metrics {
            let mut key = String::with_capacity(48);
            for r in &report.rows {
                key.clear();
                key.push_str("span.");
                key.push_str(r.name);
                key.push_str("_ms");
                m.record_dyn(&key, r.last_ms);
            }
        }
        // Overlay row twice a second (formatting allocates).
        if let Some(mut lines) = lines
            && report.frames % 30 == 1
        {
            use std::fmt::Write as _;
            let mut rows: Vec<&ScopeRow> = report.rows.iter().collect();
            rows.sort_by(|a, b| b.ms.total_cmp(&a.ms));
            let mut line = std::mem::take(&mut report.line);
            line.clear();
            for r in rows.iter().take(4) {
                let _ = write!(line, "{} {:.3}ms  ", r.name, r.ms);
            }
            lines.set("scopes", line.trim_end().to_string());
            report.line = line;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_counts_calls() {
        let mut app = App::new();
        app.add_plugins(ProfilePlugin);
        for _ in 0..3 {
            crate::profile_scope!("unit.scope");
            std::hint::black_box(0);
        }
        app.update();
        let r = app.world().resource::<ScopeReport>();
        let row = r.get("unit.scope").expect("scope row");
        assert_eq!(row.calls, 3);
        assert!(row.last_ms >= 0.0);
    }
}
