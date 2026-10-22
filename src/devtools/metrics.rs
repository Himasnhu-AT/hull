//! Metrics registry + debug metrics window. Owner: metrics stream. Contract:
//!
//! Any system records named samples: `metrics.record("render.meshes_visible", n as f64)`.
//! One sample per key per frame (last write wins). Keys are `group.name`; the window groups
//! charts by the part before the dot. History is kept per key (ring buffer) and summarised
//! per session for comparing runs.
//!
//! What it keeps per key:
//! - the last [`HISTORY`] samples ([`Metrics::iter`], [`Metrics::latest`]);
//! - every sample of the last [`WINDOW_SECS`] seconds with its time (the window's charts and
//!   their min/avg/p95/max, [`Metrics::recent`]);
//! - a session accumulator (count, sum, min, max and a 1 %-resolution log histogram for
//!   p50/p95) over samples recorded after [`Metrics::warmup`] seconds ([`Metrics::session`]).
//!   That is what `<data>/metrics/sessions.jsonl` stores per run (see `metrics_history`).
//!
//! The engine feeds `frame.*`, `cpu.*`, `gpu.*`, `mem.*`, `ecs.*`, `span.*` and `perf.*` keys
//! from the perf monitor (see [`record_engine`]); the render stream feeds `render.*`; games add
//! their own with one line: `metrics.record("ai.think_ms", ms)`.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;

use bevy::prelude::*;
use serde::{Deserialize, Serialize};

use super::perf::{PerfShared, PerfSnapshot, Stat};

/// Samples kept per key for [`Metrics::iter`] (about 10 s at 60 fps of raw frames).
pub const HISTORY: usize = 600;
/// Seconds of timed samples kept per key for the window's charts and [`Metrics::recent`].
pub const WINDOW_SECS: f32 = 60.0;
/// Hard cap on timed samples per key (a 500 fps run still keeps the last ~60 s).
const WINDOW_CAP: usize = 30_000;
/// Default seconds ignored at the start of a session (shader compiles, asset loads).
pub const WARMUP_SECS: f64 = 3.0;

/// min / avg / p50 / p95 / max over `n` samples.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Summary {
    pub n: u64,
    pub min: f64,
    pub avg: f64,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
}

impl Summary {
    /// `"min" | "avg" | "p50" | "p95" | "max"` → value.
    pub fn get(&self, stat: &str) -> Option<f64> {
        Some(match stat {
            "min" => self.min,
            "avg" => self.avg,
            "p50" => self.p50,
            "p95" => self.p95,
            "max" => self.max,
            _ => return None,
        })
    }

    /// Summary of some values (sorts a copy).
    pub fn of(values: impl IntoIterator<Item = f64>) -> Summary {
        let mut v: Vec<f64> = values.into_iter().filter(|x| x.is_finite()).collect();
        if v.is_empty() {
            return Summary::default();
        }
        v.sort_unstable_by(f64::total_cmp);
        let q = |p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
        Summary {
            n: v.len() as u64,
            min: v[0],
            avg: v.iter().sum::<f64>() / v.len() as f64,
            p50: q(0.5),
            p95: q(0.95),
            max: v[v.len() - 1],
        }
    }

    /// Same numbers rounded to 4 significant digits (what the session file stores).
    pub fn rounded(&self) -> Summary {
        Summary { n: self.n, min: sig4(self.min), avg: sig4(self.avg), p50: sig4(self.p50), p95: sig4(self.p95), max: sig4(self.max) }
    }
}

fn sig4(x: f64) -> f64 {
    if x == 0.0 || !x.is_finite() {
        return x;
    }
    let mag = 10f64.powi(3 - x.abs().log10().floor() as i32);
    (x * mag).round() / mag
}

/// `Vec` ring that always exposes its last [`HISTORY`] values as one slice: grows to twice
/// that, then drops the older half (amortised O(1), no per-push shifting).
#[derive(Debug, Default)]
struct Ring(Vec<f64>);

impl Ring {
    fn push(&mut self, v: f64) {
        if self.0.len() == 2 * HISTORY {
            self.0.drain(..HISTORY);
        }
        self.0.push(v);
    }
    fn set_last(&mut self, v: f64) {
        if let Some(x) = self.0.last_mut() {
            *x = v;
        }
    }
    fn as_slice(&self) -> &[f64] {
        &self.0[self.0.len().saturating_sub(HISTORY)..]
    }
}

/// Log-bucketed histogram: bucket width ~1 % of the value, so p50/p95 of a whole session cost
/// a few KB per key whatever its length.
#[derive(Debug, Default, Clone)]
struct Hist {
    neg: BTreeMap<i32, u64>,
    zero: u64,
    pos: BTreeMap<i32, u64>,
}

const LN_STEP: f64 = 0.009_950_330_853_168_083; // ln(1.01)

impl Hist {
    fn add(&mut self, v: f64) {
        if v.abs() < 1e-9 {
            self.zero += 1;
            return;
        }
        let k = (v.abs().ln() / LN_STEP).round() as i32;
        *if v > 0.0 { &mut self.pos } else { &mut self.neg }.entry(k).or_default() += 1;
    }

    /// Nearest-rank quantile (`q` in 0..=1) over `n` samples.
    fn quantile(&self, q: f64, n: u64) -> f64 {
        if n == 0 {
            return 0.0;
        }
        let rank = ((n - 1) as f64 * q).round() as u64;
        let mut seen = 0;
        // Ascending order: most negative first, then zero, then positives.
        for (&k, &c) in self.neg.iter().rev() {
            seen += c;
            if seen > rank {
                return -(k as f64 * LN_STEP).exp();
            }
        }
        seen += self.zero;
        if seen > rank {
            return 0.0;
        }
        for (&k, &c) in &self.pos {
            seen += c;
            if seen > rank {
                return (k as f64 * LN_STEP).exp();
            }
        }
        0.0
    }
}

/// Running session statistics for one key.
#[derive(Debug, Default, Clone)]
struct Acc {
    n: u64,
    sum: f64,
    min: f64,
    max: f64,
    hist: Hist,
}

impl Acc {
    fn add(&mut self, v: f64) {
        if self.n == 0 {
            self.min = v;
            self.max = v;
        }
        self.n += 1;
        self.sum += v;
        self.min = self.min.min(v);
        self.max = self.max.max(v);
        self.hist.add(v);
    }

    fn summary(&self) -> Option<Summary> {
        (self.n > 0).then(|| Summary {
            n: self.n,
            min: self.min,
            avg: self.sum / self.n as f64,
            // Quantiles come from 1 % buckets; keep them inside the exact extremes.
            p50: self.hist.quantile(0.5, self.n).clamp(self.min, self.max),
            p95: self.hist.quantile(0.95, self.n).clamp(self.min, self.max),
            max: self.max,
        })
    }
}

#[derive(Debug, Default)]
struct Series {
    ring: Ring,
    /// Frame of the newest sample (0 = recorded outside a driven frame).
    frame: u64,
    /// This frame's value, committed to `recent`/`session` when the frame ends.
    pending: Option<f64>,
    /// `(t, v)`, t in seconds since the registry started, last [`WINDOW_SECS`].
    recent: VecDeque<(f32, f32)>,
    session: Acc,
}

impl Series {
    fn commit(&mut self, t: f64, v: f64, warmup: f64) {
        while self.recent.len() >= WINDOW_CAP || self.recent.front().is_some_and(|&(t0, _)| t0 < t as f32 - WINDOW_SECS) {
            self.recent.pop_front();
        }
        self.recent.push_back((t as f32, v as f32));
        if t >= warmup {
            self.session.add(v);
        }
    }
}

/// Colour levels for a key's value: at or past `amber` → amber, at or past `red` → red.
/// For keys where higher is better, `amber > red` (fps: 55, 30).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Threshold {
    pub amber: f64,
    pub red: f64,
}

impl Threshold {
    /// 0 = fine, 1 = amber, 2 = red.
    pub fn level(&self, v: f64) -> u8 {
        let past = |lim: f64| if self.amber <= self.red { v >= lim } else { v <= lim };
        if past(self.red) {
            2
        } else if past(self.amber) {
            1
        } else {
            0
        }
    }
}

/// The metrics registry. Dev builds only (feature `devtools`).
#[derive(Resource, Debug)]
pub struct Metrics {
    series: BTreeMap<&'static str, Series>,
    interned: HashMap<String, &'static str>,
    frame: u64,
    now: f64,
    frames: u64,
    /// Samples before this many seconds are left out of the session summary.
    pub warmup: f64,
    labels: BTreeMap<String, String>,
    thresholds: HashMap<String, Threshold>,
}

impl Default for Metrics {
    fn default() -> Self {
        Metrics {
            series: BTreeMap::new(),
            interned: HashMap::new(),
            frame: 0,
            now: 0.0,
            frames: 0,
            warmup: WARMUP_SECS,
            labels: BTreeMap::new(),
            thresholds: HashMap::new(),
        }
    }
}

impl Metrics {
    /// Record this frame's value for `key` (`group.name`). Non-finite values are ignored.
    pub fn record(&mut self, key: &'static str, value: f64) {
        if !value.is_finite() {
            return;
        }
        let (frame, now, warmup) = (self.frame, self.now, self.warmup);
        let s = self.series.entry(key).or_default();
        if frame != 0 && s.frame == frame {
            s.ring.set_last(value);
            s.pending = Some(value);
            return;
        }
        s.ring.push(value);
        s.frame = frame;
        if frame == 0 {
            // Not driven by the plugin (unit tests, bare registries): every call is a sample.
            s.commit(now, value, warmup);
        } else {
            s.pending = Some(value);
        }
    }

    /// [`Metrics::record`] for a key built at runtime (`format!("span.{name}_ms")`). Each
    /// distinct key is interned once, so keep the set of names bounded.
    pub fn record_dyn(&mut self, key: &str, value: f64) {
        let k = match self.interned.get(key) {
            Some(k) => *k,
            None => {
                let k: &'static str = Box::leak(key.to_string().into_boxed_str());
                self.interned.insert(key.to_string(), k);
                k
            }
        };
        self.record(k, value);
    }

    /// Every key with its history, oldest first.
    pub fn iter(&self) -> impl Iterator<Item = (&'static str, &[f64])> {
        self.series.iter().map(|(k, v)| (*k, v.ring.as_slice()))
    }

    pub fn latest(&self, key: &str) -> Option<f64> {
        self.series.get(key).and_then(|s| s.ring.as_slice().last().copied())
    }

    /// Every key, sorted.
    pub fn keys(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.series.keys().copied()
    }

    /// Timed samples of the last [`WINDOW_SECS`] (t = seconds since start), oldest first.
    pub fn recent_samples(&self, key: &str) -> Option<&VecDeque<(f32, f32)>> {
        self.series.get(key).map(|s| &s.recent)
    }

    /// min/avg/p50/p95/max of the last [`WINDOW_SECS`] seconds.
    pub fn recent(&self, key: &str) -> Option<Summary> {
        let s = self.series.get(key)?;
        (!s.recent.is_empty()).then(|| Summary::of(s.recent.iter().map(|&(_, v)| v as f64)))
    }

    /// min/avg/p50/p95/max of the session so far (after warm-up).
    pub fn session(&self, key: &str) -> Option<Summary> {
        self.series.get(key).and_then(|s| s.session.summary())
    }

    /// Seconds since the registry started (real time).
    pub fn now(&self) -> f64 {
        self.now
    }

    /// Frames counted so far.
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Label this run for the session history: `set_label("map", "warehouse")`,
    /// `set_label("scenario", "bench-64-bots")`. Comparisons show it next to the commit.
    pub fn set_label(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.labels.insert(key.into(), value.into());
    }

    pub fn labels(&self) -> &BTreeMap<String, String> {
        &self.labels
    }

    /// Colour levels for a key in the window. For keys where higher is better pass
    /// `amber > red` (fps: 55, 30).
    pub fn set_threshold(&mut self, key: &str, amber: f64, red: f64) {
        self.thresholds.insert(key.to_string(), Threshold { amber, red });
    }

    /// The game's threshold for `key`, else the engine default for well-known keys.
    pub fn threshold(&self, key: &str) -> Option<Threshold> {
        self.thresholds.get(key).copied().or_else(|| default_threshold(key))
    }

    /// Ends the current frame (commits its samples) and starts the next at `now` seconds.
    /// The plugin calls this in `First`; tests may call it directly.
    pub fn next_frame(&mut self, now: f64) {
        let (t, warmup) = (self.now, self.warmup);
        for s in self.series.values_mut() {
            if let Some(v) = s.pending.take() {
                s.commit(t, v, warmup);
            }
        }
        self.frame += 1;
        self.frames += 1;
        self.now = now;
    }
}

/// Engine defaults for colour levels.
pub fn default_threshold(key: &str) -> Option<Threshold> {
    let t = |amber, red| Some(Threshold { amber, red });
    match key {
        "frame.fps" => t(55.0, 30.0),
        "gpu.pct" | "gpu.renderer_pct" | "gpu.tiler_pct" | "gpu.process_pct" => t(70.0, 90.0),
        "cpu.machine_pct" => t(50.0, 80.0),
        "mem.footprint_mb" | "mem.rss_mb" => t(2048.0, 4096.0),
        "frame.hitches" => t(1.0, 3.0),
        "perf.overhead_us" => t(200.0, 500.0),
        k if k.starts_with("frame.") && k.ends_with("ms") => t(16.7, 33.3),
        k if k.starts_with("cpu.") && k.ends_with("_pct") => t(100.0, 200.0),
        k if k.starts_with("span.") => t(2.0, 5.0),
        k if k.starts_with("gpu.") && k.ends_with("ms") => t(12.0, 16.7),
        _ => None,
    }
}

/// Which way a key should move after a code change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Better {
    Lower,
    Higher,
    /// Counts and sizes: a change is notable, not good or bad by itself.
    Neutral,
}

pub fn better(key: &str) -> Better {
    if key.ends_with("fps") {
        Better::Higher
    } else if key.ends_with("ms") || key.ends_with("_us") || key.ends_with("_pct") || key.ends_with("_mb") || key.ends_with("hitches") {
        Better::Lower
    } else {
        Better::Neutral
    }
}

pub struct MetricsPlugin;

impl Plugin for MetricsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Metrics>()
            .add_systems(First, begin_frame)
            .add_systems(Last, record_engine);
        super::metrics_history::build(app);
        super::metrics_window::build(app);
    }

    fn finish(&self, app: &mut App) {
        super::metrics_history::finish(app);
        super::metrics_window::finish(app);
    }
}

fn begin_frame(time: Res<Time<Real>>, mut m: ResMut<Metrics>) {
    m.next_frame(time.elapsed_secs_f64());
}

/// Bridges what the engine already measures: `frame.ms` and `ecs.entities` every frame, the
/// perf monitor's 1 Hz snapshot (CPU / GPU / RAM / percentiles / spans) when a new one lands.
pub fn record_engine(
    time: Res<Time<Real>>,
    mut m: ResMut<Metrics>,
    perf: Option<Res<PerfShared>>,
    entities: &bevy::ecs::entity::Entities,
    mut last: Local<Option<Arc<PerfSnapshot>>>,
) {
    let dt = time.delta_secs_f64();
    if dt > 0.0 {
        m.record("frame.ms", dt * 1000.0);
    }
    m.record("ecs.entities", entities.count_spawned() as f64);
    let Some(snap) = perf.and_then(|p| p.latest()) else { return };
    if last.as_ref().is_some_and(|l| Arc::ptr_eq(l, &snap)) {
        return;
    }
    record_snapshot(&mut m, &snap);
    *last = Some(snap);
}

/// One perf snapshot → `frame.*`, `cpu.*`, `gpu.*`, `mem.*`, `span.*`, `perf.*` keys.
/// Stats the platform can't measure (never sampled) are skipped.
pub fn record_snapshot(m: &mut Metrics, s: &PerfSnapshot) {
    let stat = |m: &mut Metrics, key: &'static str, st: &Stat| {
        if *st != Stat::default() {
            m.record(key, st.now as f64);
        }
    };
    stat(m, "frame.fps", &s.fps);
    if s.frame_ms.max > 0.0 {
        m.record("frame.p50_ms", s.frame_ms.p50 as f64);
        m.record("frame.p95_ms", s.frame_ms.p95 as f64);
        m.record("frame.p99_ms", s.frame_ms.p99 as f64);
        m.record("frame.max_ms", s.frame_ms.max as f64);
    }
    m.record("frame.hitches", s.hitches as f64);
    stat(m, "cpu.process_pct", &s.cpu.process);
    if s.cpu.cores > 0 {
        m.record("cpu.machine_pct", s.cpu.machine_pct as f64);
    }
    for t in &s.cpu.threads {
        match t.name.as_str() {
            "main" => m.record("cpu.main_pct", t.cpu_pct as f64),
            "render" => m.record("cpu.render_pct", t.cpu_pct as f64),
            _ => {}
        }
    }
    for p in &s.cpu.pools {
        if p.name.ends_with(" pool") {
            m.record_dyn(&format!("cpu.{}_pct", p.name.replace(' ', "_")), p.cpu_pct as f64);
        }
    }
    stat(m, "gpu.pct", &s.gpu.device);
    stat(m, "gpu.renderer_pct", &s.gpu.renderer);
    stat(m, "gpu.tiler_pct", &s.gpu.tiler);
    stat(m, "gpu.process_pct", &s.gpu.process);
    stat(m, "gpu.frame_ms", &s.gpu.frame_ms);
    stat(m, "gpu.mem_mb", &s.gpu.device_in_use_mb);
    if let Some(v) = s.gpu.process_alloc_mb {
        m.record("gpu.alloc_mb", v as f64);
    }
    if let Some(v) = s.gpu.passes_ms {
        m.record("gpu.passes_ms", v as f64);
    }
    stat(m, "mem.footprint_mb", &s.ram.footprint_mb);
    if let Some(v) = s.ram.rss_mb {
        m.record("mem.rss_mb", v as f64);
    }
    for sp in &s.game.spans {
        m.record_dyn(&format!("span.{}_ms", sp.name), sp.ms as f64);
    }
    m.record("perf.overhead_us", s.overhead_us as f64);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_last_history_contiguous() {
        let mut m = Metrics::default();
        for i in 0..(HISTORY * 3 + 7) {
            m.record("a.b", i as f64);
        }
        let (k, s) = m.iter().next().unwrap();
        assert_eq!(k, "a.b");
        assert_eq!(s.len(), HISTORY);
        assert_eq!(s[0], (HISTORY * 2 + 7) as f64);
        assert_eq!(m.latest("a.b"), Some((HISTORY * 3 + 6) as f64));
    }

    #[test]
    fn one_sample_per_key_per_frame() {
        let mut m = Metrics { warmup: 0.0, ..default() };
        m.next_frame(0.0);
        m.record("x.y", 1.0);
        m.record("x.y", 5.0); // last write wins
        assert_eq!(m.latest("x.y"), Some(5.0));
        m.next_frame(0.1);
        m.record("x.y", 7.0);
        m.next_frame(0.2);
        assert_eq!(m.iter().next().unwrap().1, &[5.0, 7.0]);
        let s = m.session("x.y").unwrap();
        assert_eq!((s.n, s.min, s.max, s.avg), (2, 5.0, 7.0, 6.0));
        assert_eq!(m.recent_samples("x.y").unwrap().len(), 2);
        m.record("x.y", f64::NAN);
        assert_eq!(m.latest("x.y"), Some(7.0), "NaN is dropped");
    }

    #[test]
    fn warmup_and_window() {
        let mut m = Metrics { warmup: 2.0, ..default() };
        for f in 0..2000 {
            let t = f as f64 * 0.05; // 100 s
            m.next_frame(t);
            m.record("frame.ms", if t < 2.0 { 500.0 } else { 10.0 });
        }
        m.next_frame(100.0);
        let s = m.session("frame.ms").unwrap();
        assert_eq!(s.max, 10.0, "warm-up samples are not in the session");
        let r = m.recent_samples("frame.ms").unwrap();
        assert!(r.front().unwrap().0 >= 100.0 - WINDOW_SECS - 0.06, "window keeps ~{WINDOW_SECS} s");
        assert_eq!(m.recent("frame.ms").unwrap().avg, 10.0);
    }

    #[test]
    fn histogram_quantiles_within_one_percent() {
        let mut m = Metrics { warmup: 0.0, ..default() };
        for i in 1..=1000 {
            m.record("q.v", i as f64);
        }
        let s = m.session("q.v").unwrap();
        let exact = Summary::of((1..=1000).map(|i| i as f64));
        assert!((s.p50 - exact.p50).abs() / exact.p50 < 0.01, "{s:?} vs {exact:?}");
        assert!((s.p95 - exact.p95).abs() / exact.p95 < 0.01, "{s:?} vs {exact:?}");
        assert_eq!((s.min, s.max, s.avg), (1.0, 1000.0, 500.5));
        for v in [-3.0, 0.0, 0.0, 2.0] {
            m.record("q.z", v);
        }
        let z = m.session("q.z").unwrap();
        assert_eq!(z.p50, 0.0);
        assert_eq!(z.min, -3.0);
    }

    #[test]
    fn dyn_keys_are_interned_once() {
        let mut m = Metrics::default();
        m.record_dyn(&format!("span.{}_ms", "ai"), 1.0);
        m.record_dyn("span.ai_ms", 2.0);
        assert_eq!(m.keys().collect::<Vec<_>>(), ["span.ai_ms"]);
        assert_eq!(m.latest("span.ai_ms"), Some(2.0));
    }

    #[test]
    fn thresholds_and_direction() {
        let mut m = Metrics::default();
        assert_eq!(m.threshold("frame.ms").unwrap().amber, 16.7);
        assert_eq!(m.threshold("frame.p95_ms").unwrap().red, 33.3);
        assert!(m.threshold("render.meshes_visible").is_none());
        m.set_threshold("ai.think_ms", 2.0, 4.0);
        assert_eq!(m.threshold("ai.think_ms"), Some(Threshold { amber: 2.0, red: 4.0 }));
        assert_eq!(m.threshold("frame.ms").unwrap().level(20.0), 1);
        assert_eq!(m.threshold("frame.fps").unwrap().level(20.0), 2);
        assert_eq!(m.threshold("frame.fps").unwrap().level(60.0), 0);
        assert_eq!(better("frame.ms"), Better::Lower);
        assert_eq!(better("frame.fps"), Better::Higher);
        assert_eq!(better("render.meshes_visible"), Better::Neutral);
        assert_eq!(sig4(12.34567), 12.35);
        assert_eq!(sig4(0.0012345), 0.001235);
    }
}
