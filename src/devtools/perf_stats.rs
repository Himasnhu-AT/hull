//! Pure smoothing and summary helpers for the perf monitor (no Bevy, no OS calls).
//!
//! - [`Track`]: one metric sampled at 1 Hz → [`Stat`] (latest, EMA, min/max over the last
//!   [`WINDOW`] samples) plus the history the overlay's sparklines draw.
//! - [`Report`]: every 1 Hz sample of the session per metric → min/avg/p95/max for `perf.report`.

use std::collections::{BTreeMap, VecDeque};

use serde::Serialize;
use serde_json::{Value, json};

/// Samples kept for min/max and sparklines (1 Hz → 60 s).
pub const WINDOW: usize = 60;
/// EMA weight of a new 1 Hz sample (time constant ≈ 2.8 s).
pub const ALPHA: f32 = 0.3;

/// A smoothed metric.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct Stat {
    /// Latest 1 s sample.
    pub now: f32,
    /// Exponential moving average (what the overlay shows).
    pub ema: f32,
    /// Min / max over the last [`WINDOW`] samples.
    pub min: f32,
    pub max: f32,
}

#[derive(Clone, Debug, Default)]
pub struct Track {
    ema: Option<f32>,
    hist: VecDeque<f32>,
}

impl Track {
    /// Adds a sample (non-finite samples are dropped) and returns the updated stat.
    pub fn push(&mut self, v: f32) -> Stat {
        if v.is_finite() {
            self.ema = Some(self.ema.map_or(v, |e| e + ALPHA * (v - e)));
            if self.hist.len() == WINDOW {
                self.hist.pop_front();
            }
            self.hist.push_back(v);
        }
        self.stat()
    }

    pub fn stat(&self) -> Stat {
        let (min, max) = self
            .hist
            .iter()
            .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &x| (lo.min(x), hi.max(x)));
        if self.hist.is_empty() {
            return Stat::default();
        }
        Stat { now: *self.hist.back().unwrap_or(&0.0), ema: self.ema.unwrap_or(0.0), min, max }
    }

    /// Oldest first.
    pub fn history(&self) -> Vec<f32> {
        self.hist.iter().copied().collect()
    }
}

/// Every sample of the session, per metric.
#[derive(Default, Debug)]
pub struct Report {
    series: BTreeMap<&'static str, Vec<f32>>,
    pub seconds: u32,
}

impl Report {
    pub fn add(&mut self, metric: &'static str, v: Option<f32>) {
        if let Some(v) = v.filter(|v| v.is_finite()) {
            self.series.entry(metric).or_default().push(v);
        }
    }

    /// `{metric: {min, avg, p95, max, n}}` over the whole session.
    pub fn summary(&self) -> Value {
        let mut out = serde_json::Map::new();
        for (k, v) in &self.series {
            if v.is_empty() {
                continue;
            }
            let mut s = v.clone();
            s.sort_unstable_by(f32::total_cmp);
            let avg = s.iter().map(|&x| x as f64).sum::<f64>() / s.len() as f64;
            let p95 = s[((s.len() - 1) as f32 * 0.95).round() as usize];
            let r = |x: f64| (x * 100.0).round() / 100.0;
            out.insert(
                (*k).to_string(),
                json!({"min": r(s[0] as f64), "avg": r(avg), "p95": r(p95 as f64), "max": r(s[s.len() - 1] as f64), "n": s.len()}),
            );
        }
        Value::Object(out)
    }
}

/// Bevy thread names → short labels (`Compute Task Pool (3)` → `compute 3`).
pub fn thread_label(name: &str, gcd: bool) -> String {
    let pool = |prefix: &str, short: &str| {
        name.strip_prefix(prefix)
            .and_then(|r| r.strip_prefix(" ("))
            .and_then(|r| r.strip_suffix(')'))
            .map(|n| format!("{short} {n}"))
    };
    if let Some(s) = pool("Async Compute Task Pool", "async")
        .or_else(|| pool("Compute Task Pool", "compute"))
        .or_else(|| pool("IO Task Pool", "io"))
    {
        return s;
    }
    let lower = name.to_ascii_lowercase();
    match name {
        "" if gcd => "gcd worker".into(),
        "" => "unnamed".into(),
        "perf-sampler" => "perf sampler".into(),
        "perf-log" => "perf log".into(),
        _ if lower.contains("audio") || lower.contains("cpal") => "audio".into(),
        _ if lower.contains("metal") => "metal".into(),
        _ => name.into(),
    }
}

/// Pool a thread label belongs to (`compute 3` → `compute pool`), for per-pool sums.
pub fn pool_of(label: &str) -> String {
    match label.rsplit_once(' ') {
        Some((base, n)) if n.chars().all(|c| c.is_ascii_digit()) => format!("{base} pool"),
        _ => label.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ema_smooths_and_window_tracks_extremes() {
        let mut t = Track::default();
        assert_eq!(t.push(10.0).ema, 10.0);
        let s = t.push(20.0);
        assert!((s.ema - 13.0).abs() < 1e-4);
        assert_eq!((s.min, s.max, s.now), (10.0, 20.0, 20.0));
        assert_eq!(t.push(f32::NAN), s, "NaN is dropped");
        for _ in 0..WINDOW {
            t.push(5.0);
        }
        let s = t.stat();
        assert_eq!((s.min, s.max), (5.0, 5.0), "old extremes leave the window");
        assert_eq!(t.history().len(), WINDOW);
    }

    #[test]
    fn report_summary() {
        let mut r = Report::default();
        for i in 1..=100 {
            r.add("x", Some(i as f32));
        }
        r.add("x", None);
        let s = r.summary();
        assert_eq!(s["x"]["min"], 1.0);
        assert_eq!(s["x"]["max"], 100.0);
        assert_eq!(s["x"]["avg"], 50.5);
        assert_eq!(s["x"]["p95"], 95.0);
        assert_eq!(s["x"]["n"], 100);
    }

    #[test]
    fn labels() {
        assert_eq!(thread_label("Compute Task Pool (3)", false), "compute 3");
        assert_eq!(thread_label("Async Compute Task Pool (0)", false), "async 0");
        assert_eq!(thread_label("IO Task Pool (1)", false), "io 1");
        assert_eq!(thread_label("com.apple.audio.IOThread.client", false), "audio");
        assert_eq!(thread_label("", true), "gcd worker");
        assert_eq!(pool_of("compute 3"), "compute pool");
        assert_eq!(pool_of("main"), "main");
    }
}
