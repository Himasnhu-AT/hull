//! What the metrics viewer concludes from a run: per-key stats, a one-word verdict, the issues
//! worth looking at and the headline numbers. Pure data in, plain structs out (no Bevy, no
//! egui), so it is unit-tested and the view only draws it.
//!
//! The analysis covers the whole run when it has ended and the last [`LIVE_SCOPE`] seconds while
//! it is live (a live run's "now" is what matters). The first [`SKIP_WARMUP`] seconds are left
//! out of the stats on runs longer than [`SKIP_AFTER`] seconds (start-up spikes).

use std::collections::{BTreeMap, HashMap};

use super::metrics::{Better, Metrics, Threshold, better, default_threshold};
use super::metrics_history::{SessionSummary, delta};
use super::metrics_viewer::{EventKind, ViewEvent};

/// Seconds of a live run the headline numbers and verdict cover.
pub const LIVE_SCOPE: f64 = 60.0;
const SKIP_WARMUP: f64 = 3.0;
const SKIP_AFTER: f64 = 10.0;
/// A change of this much (fraction) from the previous comparable run counts as a regression.
pub const REGRESSION: f64 = 0.10;
/// Frame budget the verdict measures against (60 fps).
pub const BUDGET_MS: f64 = 1000.0 / 60.0;

/// Group order in the lists; others follow alphabetically.
pub const GROUP_ORDER: [&str; 10] = ["frame", "cpu", "gpu", "mem", "render", "span", "resources", "ecs", "perf", "misc"];

/// Row order inside groups: what matters first.
const ROW_ORDER: [&str; 33] = [
    "frame.fps",
    "frame.ms",
    "frame.p50_ms",
    "frame.p95_ms",
    "frame.p99_ms",
    "frame.max_ms",
    "frame.hitches",
    "frame.long",
    "cpu.machine_pct",
    "cpu.cores",
    "cpu.process_pct",
    "cpu.main_ms",
    "cpu.render_ms",
    "cpu.main_pct",
    "cpu.render_pct",
    "cpu.compute_pool_pct",
    "cpu.async_pool_pct",
    "gpu.process_pct",
    "gpu.frame_ms",
    "gpu.alloc_mb",
    "gpu.alloc_pct",
    "gpu.working_set_mb",
    "gpu.pct",
    "gpu.renderer_pct",
    "gpu.tiler_pct",
    "gpu.mem_mb",
    "mem.system_pct",
    "mem.system_used_mb",
    "mem.footprint_mb",
    "mem.peak_mb",
    "mem.pressure",
    "mem.swap_mb",
    "proc.threads",
];

/// Statistics of one key over the analysed span.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Stats {
    pub n: usize,
    pub min: f64,
    pub avg: f64,
    pub p05: f64,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
}

impl Stats {
    pub fn of(mut v: Vec<f64>) -> Stats {
        v.retain(|x| x.is_finite());
        if v.is_empty() {
            return Stats::default();
        }
        v.sort_unstable_by(f64::total_cmp);
        let q = |p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
        Stats { n: v.len(), min: v[0], avg: v.iter().sum::<f64>() / v.len() as f64, p05: q(0.05), p50: q(0.5), p95: q(0.95), max: v[v.len() - 1] }
    }

    pub fn get(&self, stat: &str) -> f64 {
        match stat {
            "min" => self.min,
            "p05" => self.p05,
            "p50" => self.p50,
            "p95" => self.p95,
            "max" => self.max,
            _ => self.avg,
        }
    }
}

/// One key of the run with everything a row needs.
#[derive(Clone, Debug)]
pub struct KeyInfo {
    pub key: &'static str,
    pub label: String,
    pub group: String,
    pub th: Option<Threshold>,
    pub stats: Stats,
    /// Last value.
    pub now: f64,
    pub now_level: u8,
    /// Level of the run's bad side (p95, or p05 for higher-is-better keys): 0 fine, 1 amber, 2 red.
    pub level: u8,
    /// Share of samples at amber-or-worse and at red.
    pub amber_frac: f32,
    pub red_frac: f32,
    /// Which stat the regression check compares.
    pub cmp_stat: &'static str,
    /// Change of `cmp_stat` from the previous comparable run: `(fraction, +1 better / -1 worse / 0)`.
    pub delta: Option<(f64, i8)>,
    pub prev: Option<f64>,
}

impl KeyInfo {
    pub fn cur(&self) -> f64 {
        self.stats.get(self.cmp_stat)
    }

    /// How much the key regressed (0 when it did not): sorts "worst first".
    pub fn regression(&self) -> f64 {
        match self.delta {
            Some((d, -1)) => d.abs(),
            _ => 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Sev {
    Red,
    Amber,
    Info,
}

/// Where an issue leads when clicked.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Target {
    Key(&'static str),
    /// A moment in the run (seconds): the Events tab, highlighted on charts.
    Time(f64),
}

#[derive(Clone, Debug)]
pub struct Issue {
    pub sev: Sev,
    pub title: String,
    pub detail: String,
    pub target: Option<Target>,
    /// Sorts within a severity (bigger first).
    pub score: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    NoData,
    Smooth,
    Hitching,
    CpuBound,
    GpuBound,
    Slow,
    MemoryGrowing,
}

impl Verdict {
    pub fn word(self) -> &'static str {
        match self {
            Verdict::NoData => "No data",
            Verdict::Smooth => "Smooth",
            Verdict::Hitching => "Hitching",
            Verdict::CpuBound => "CPU-bound",
            Verdict::GpuBound => "GPU-bound",
            Verdict::Slow => "Slow",
            Verdict::MemoryGrowing => "Memory growing",
        }
    }
}

/// One big number of the health header.
#[derive(Clone, Debug)]
pub struct HeadStat {
    pub id: &'static str,
    pub title: &'static str,
    /// Chart key the tile opens.
    pub key: Option<&'static str>,
    pub text: String,
    pub value: f64,
    /// 0 fine, 1 amber, 2 red, 3 no colour.
    pub level: u8,
    pub sub: String,
    pub delta: Option<(f64, i8)>,
}

#[derive(Clone, Debug)]
pub struct Analysis {
    /// Every key in group order.
    pub keys: Vec<KeyInfo>,
    pub index: HashMap<&'static str, usize>,
    pub verdict: Verdict,
    pub reason: String,
    pub issues: Vec<Issue>,
    pub head: Vec<HeadStat>,
    /// The analysed span in seconds: `(from, to)`.
    pub span: (f64, f64),
    pub live_scope: bool,
    pub prev_id: Option<String>,
}

impl Analysis {
    pub fn key(&self, k: &str) -> Option<&KeyInfo> {
        self.index.get(k).and_then(|i| self.keys.get(*i))
    }

    /// Issue counts `(red, amber)`.
    pub fn counts(&self) -> (usize, usize) {
        let n = |s| self.issues.iter().filter(|i| i.sev == s).count();
        (n(Sev::Red), n(Sev::Amber))
    }
}

pub fn group_of(key: &str) -> &str {
    match key {
        "gpu.textures" | "gpu.texture_views" | "gpu.buffers" | "gpu.bind_groups" | "gpu.samplers" | "gpu.render_pipelines" | "gpu.compute_pipelines" => "resources",
        _ => key.split_once('.').map_or("misc", |(g, _)| g),
    }
}

/// Sort key of a metric key: group rank, headline rows first, then alphabetical.
pub fn sort_key(key: &str) -> (usize, usize, String) {
    let rank = GROUP_ORDER.iter().position(|o| *o == group_of(key)).unwrap_or(GROUP_ORDER.len());
    let row = ROW_ORDER.iter().position(|o| *o == key).unwrap_or(ROW_ORDER.len());
    (rank, row, key.to_string())
}

/// The summary stat a regression check compares for `key`.
pub fn compare_stat(key: &str) -> &'static str {
    if key.ends_with("ms") { "p95" } else if key.ends_with("_mb") { "max" } else { "avg" }
}

/// What the analysis needs besides the samples.
pub struct Input<'a> {
    pub m: &'a Metrics,
    pub events: &'a [ViewEvent],
    pub live: bool,
    /// The run's own finished summary (`ended`).
    pub ended: Option<&'a str>,
    /// The previous comparable run.
    pub prev: Option<&'a SessionSummary>,
}

pub fn analyze(inp: &Input) -> Analysis {
    let m = inp.m;
    let now = m.now();
    let from = if inp.live {
        (now - LIVE_SCOPE).max(0.0)
    } else if now > SKIP_AFTER {
        SKIP_WARMUP
    } else {
        0.0
    };
    let mut keys: Vec<KeyInfo> = Vec::new();
    for k in m.keys() {
        let Some(samples) = m.recent_samples(k) else { continue };
        let vals: Vec<f64> = samples.iter().filter(|(t, _)| *t as f64 >= from).map(|(_, v)| *v as f64).collect();
        if vals.is_empty() {
            continue;
        }
        let th = m.threshold(k);
        let (mut amber, mut red) = (0usize, 0usize);
        if let Some(th) = th {
            for v in &vals {
                match th.level(*v) {
                    2 => {
                        red += 1;
                        amber += 1;
                    }
                    1 => amber += 1,
                    _ => {}
                }
            }
        }
        let stats = Stats::of(vals.clone());
        let last = samples.back().map_or(0.0, |(_, v)| *v as f64);
        let level = th.map_or(0, |t| if t.amber > t.red { t.level(stats.p05) } else { t.level(stats.p95) });
        let cmp_stat = compare_stat(k);
        let prev = inp.prev.and_then(|p| p.keys.get(k)).map(|s| s.get(cmp_stat).unwrap_or(s.avg)).filter(|_| inp.prev.is_some());
        let cur = stats.get(cmp_stat);
        let d = prev.and_then(|p| delta(k, cur, p));
        keys.push(KeyInfo {
            key: k,
            label: label(k),
            group: group_of(k).to_string(),
            th,
            stats,
            now: last,
            now_level: th.map_or(0, |t| t.level(last)),
            level,
            amber_frac: amber as f32 / vals.len() as f32,
            red_frac: red as f32 / vals.len() as f32,
            cmp_stat,
            delta: d,
            prev,
        });
    }
    keys.sort_by_key(|k| sort_key(k.key));
    let index: HashMap<&'static str, usize> = keys.iter().enumerate().map(|(i, k)| (k.key, i)).collect();

    let mut a = Analysis {
        keys,
        index,
        verdict: Verdict::NoData,
        reason: String::new(),
        issues: Vec::new(),
        head: Vec::new(),
        span: (from, now),
        live_scope: inp.live,
        prev_id: inp.prev.map(|p| p.id.clone()),
    };
    a.head = head_stats(&a);
    verdict(&mut a, inp);
    a.issues = issues(&a, inp);
    a
}

fn head_stats(a: &Analysis) -> Vec<HeadStat> {
    let k = |key: &str| a.key(key);
    let mut out = Vec::new();

    // FPS.
    let fps = k("frame.fps").map(|i| (i.stats.avg, Some(i))).or_else(|| k("frame.ms").filter(|i| i.stats.avg > 0.0).map(|i| (1000.0 / i.stats.avg, None)));
    out.push(match fps {
        Some((v, info)) => HeadStat {
            id: "fps",
            title: "FPS",
            key: Some(if info.is_some() { "frame.fps" } else { "frame.ms" }),
            text: format!("{v:.0}"),
            value: v,
            level: default_threshold("frame.fps").map_or(3, |t| t.level(v)),
            sub: info.map_or(String::new(), |i| format!("low {:.0} · high {:.0}", i.stats.p05, i.stats.max)),
            delta: info.and_then(|i| i.prev.and_then(|p| delta("frame.fps", i.stats.avg, p))),
        },
        None => none_stat("fps", "FPS"),
    });

    // Frame time p95.
    let p95 = k("frame.p95_ms").map(|i| (i, i.stats.avg)).or_else(|| k("frame.ms").map(|i| (i, i.stats.p95)));
    out.push(match p95 {
        Some((i, v)) => HeadStat {
            id: "frame",
            title: "Frame p95",
            key: Some(i.key),
            text: format!("{} ms", super::metrics_analysis::num(v)),
            value: v,
            level: default_threshold("frame.p95_ms").map_or(3, |t| t.level(v)),
            sub: format!("budget {BUDGET_MS:.1} ms · worst {:.0} ms", k("frame.max_ms").map_or(i.stats.max, |m| m.stats.max)),
            delta: i.delta,
        },
        None => none_stat("frame", "Frame p95"),
    });

    // CPU.
    let cpu = match (k("cpu.main_ms"), k("cpu.render_ms")) {
        (Some(a), Some(b)) => Some((if a.stats.avg >= b.stats.avg { a } else { b }, format!("main {:.1} · render {:.1} ms", a.stats.avg, b.stats.avg))),
        (Some(a), None) => Some((a, "main thread".to_string())),
        (None, Some(b)) => Some((b, "render thread".to_string())),
        _ => None,
    };
    out.push(match cpu {
        Some((i, sub)) => HeadStat {
            id: "cpu",
            title: "CPU",
            key: Some(i.key),
            text: format!("{} ms", num(i.stats.avg)),
            value: i.stats.avg,
            level: i.th.map_or(3, |t| t.level(i.stats.avg)),
            sub,
            delta: i.prev.and_then(|p| delta(i.key, i.stats.avg, p)),
        },
        None => match k("cpu.process_pct") {
            Some(i) => HeadStat {
                id: "cpu",
                title: "CPU",
                key: Some(i.key),
                text: format!("{}%", num(i.stats.avg)),
                value: i.stats.avg,
                level: i.th.map_or(3, |t| t.level(i.stats.avg)),
                sub: format!("{:.1} cores", i.stats.avg / 100.0),
                delta: i.prev.and_then(|p| delta(i.key, i.stats.avg, p)),
            },
            None => none_stat("cpu", "CPU"),
        },
    });

    // GPU.
    out.push(match k("gpu.frame_ms").or_else(|| k("gpu.process_pct")) {
        Some(i) => {
            let ms = i.key.ends_with("ms");
            HeadStat {
                id: "gpu",
                title: "GPU",
                key: Some(i.key),
                text: if ms { format!("{} ms", num(i.stats.avg)) } else { format!("{}%", num(i.stats.avg)) },
                value: i.stats.avg,
                level: i.th.map_or(3, |t| t.level(i.stats.avg)),
                sub: k("gpu.process_pct").filter(|_| ms).map_or(String::new(), |p| format!("{:.0}% busy", p.stats.avg)),
                delta: i.prev.and_then(|p| delta(i.key, i.stats.avg, p)),
            }
        }
        None => none_stat("gpu", "GPU"),
    });

    // Memory.
    out.push(match k("mem.footprint_mb").or_else(|| k("mem.rss_mb")) {
        Some(i) => {
            let peak = k("mem.peak_mb").map_or(i.stats.max, |p| p.stats.max.max(i.stats.max));
            let v = if a.live_scope { i.now } else { i.stats.max };
            HeadStat {
                id: "mem",
                title: "Memory",
                key: Some(i.key),
                text: size(v),
                value: v,
                level: i.th.map_or(3, |t| t.level(v)),
                sub: format!("peak {}", size(peak)),
                delta: i.prev.and_then(|p| delta(i.key, i.stats.max, p)),
            }
        }
        None => none_stat("mem", "Memory"),
    });
    out
}

fn none_stat(id: &'static str, title: &'static str) -> HeadStat {
    HeadStat { id, title, key: None, text: "—".into(), value: 0.0, level: 3, sub: "no data".into(), delta: None }
}

/// Least-squares slope of `(t seconds, v)` in units per minute.
fn slope_per_min(samples: impl Iterator<Item = (f64, f64)>) -> Option<(f64, f64)> {
    let pts: Vec<(f64, f64)> = samples.collect();
    let n = pts.len() as f64;
    if pts.len() < 20 {
        return None;
    }
    let (sx, sy) = pts.iter().fold((0.0, 0.0), |a, p| (a.0 + p.0, a.1 + p.1));
    let (mx, my) = (sx / n, sy / n);
    let (mut num, mut den) = (0.0, 0.0);
    for (x, y) in &pts {
        num += (x - mx) * (y - my);
        den += (x - mx) * (x - mx);
    }
    if den < 1e-9 {
        return None;
    }
    let span = pts.last()?.0 - pts.first()?.0;
    Some((num / den * 60.0, span))
}

/// Memory growth `(MB per minute, total MB over the span)` when it is a real trend.
pub fn memory_growth(m: &Metrics, from: f64) -> Option<(f64, f64)> {
    let key = ["mem.footprint_mb", "mem.rss_mb"].into_iter().find(|k| m.recent_samples(k).is_some())?;
    let s = m.recent_samples(key)?;
    let (per_min, span) = slope_per_min(s.iter().filter(|(t, _)| *t as f64 >= from).map(|(t, v)| (*t as f64, *v as f64)))?;
    let first = s.iter().find(|(t, _)| *t as f64 >= from).map(|(_, v)| *v as f64)?;
    let total = per_min * span / 60.0;
    (span >= 60.0 && per_min >= 5.0 && total >= 50.0 && total >= first * 0.08).then_some((per_min, total))
}

fn verdict(a: &mut Analysis, inp: &Input) {
    let k = |key: &str| a.key(key).map(|i| i.stats);
    let frame_avg = k("frame.ms").map(|s| s.avg).or_else(|| k("frame.fps").filter(|s| s.avg > 0.0).map(|s| 1000.0 / s.avg));
    let p95 = k("frame.p95_ms").map(|s| s.avg).or_else(|| k("frame.ms").map(|s| s.p95));
    let Some(frame) = frame_avg else {
        a.verdict = Verdict::NoData;
        a.reason = "no frame data yet".into();
        return;
    };
    let over = p95.unwrap_or(frame).max(frame) > BUDGET_MS * 1.05 || frame > BUDGET_MS * 1.05;
    let gpu = k("gpu.frame_ms").map(|s| s.avg);
    let busy = k("gpu.process_pct").map(|s| s.avg / 100.0);
    let main = k("cpu.main_ms").map(|s| s.avg);
    let render = k("cpu.render_ms").map(|s| s.avg);
    let hitches = k("frame.hitches").map_or(0.0, |s| s.avg * s.n as f64);
    let long = k("frame.long").map_or(0.0, |s| s.avg * s.n as f64);
    let incidents = inp.events.iter().filter(|e| e.kind == EventKind::Incident && matches!(e.field("rule"), Some("long_frames" | "stall"))).count();
    let hitching = hitches >= 1.0 || long >= 1.0 || incidents > 0;
    let growth = memory_growth(inp.m, a.span.0);
    let incident_growth = inp.events.iter().any(|e| e.kind == EventKind::Incident && e.field("rule") == Some("memory_growth"));
    let p95v = p95.unwrap_or(frame);

    if over {
        let main_render = main.into_iter().chain(render).fold(0.0f64, f64::max);
        let gpu_heavy = busy.is_some_and(|b| b > 0.8) || gpu.is_some_and(|g| g >= frame * 0.8);
        let (v, why) = if gpu_heavy && gpu.is_some_and(|g| g >= main_render) {
            (Verdict::GpuBound, format!("GPU {:.1} ms of a {:.1} ms frame", gpu.unwrap_or(0.0), frame))
        } else if main_render >= frame * 0.6 {
            (Verdict::CpuBound, format!("CPU {main_render:.1} ms of a {frame:.1} ms frame"))
        } else if gpu_heavy {
            (Verdict::GpuBound, format!("GPU busy {:.0}%", busy.unwrap_or(0.0) * 100.0))
        } else {
            (Verdict::Slow, format!("frame {frame:.1} ms, p95 {p95v:.1} ms vs {BUDGET_MS:.1} ms budget"))
        };
        a.verdict = v;
        a.reason = why;
    } else if hitching {
        a.verdict = Verdict::Hitching;
        a.reason = if incidents > 0 { format!("{incidents} incident(s): long frames or stalls") } else { format!("{} hitch(es) over 50 ms", (hitches + long) as u64) };
    } else if growth.is_some() || incident_growth {
        a.verdict = Verdict::MemoryGrowing;
        a.reason = growth.map_or("memory growth incident".to_string(), |(pm, tot)| format!("+{pm:.0} MB/min, +{tot:.0} MB over the run"));
    } else {
        a.verdict = Verdict::Smooth;
        a.reason = format!("p95 {p95v:.1} ms, budget {BUDGET_MS:.1} ms");
    }
}

fn issues(a: &Analysis, inp: &Input) -> Vec<Issue> {
    let mut out: Vec<Issue> = Vec::new();
    let mut by_key: HashMap<&'static str, usize> = HashMap::new();
    let prev_note = |k: &KeyInfo| {
        k.delta.filter(|(d, s)| *s == -1 && d.abs() >= REGRESSION).map(|(d, _)| format!(" · {} vs previous run", pct(d)))
    };
    for k in &a.keys {
        let Some(th) = k.th else { continue };
        if k.level == 0 {
            continue;
        }
        let limit = if k.level == 2 { th.red } else { th.amber };
        let side = if th.amber > th.red { "low" } else { "p95" };
        let stat = if th.amber > th.red { k.stats.p05 } else { k.stats.p95 };
        let frac = if k.level == 2 { k.red_frac } else { k.amber_frac };
        let mut detail = format!("{side} {} (limit {}) · {} for {:.0}% of the {}", with_unit(k.key, stat), num(limit), if k.level == 2 { "red" } else { "amber" }, frac * 100.0, if a.live_scope { "last minute" } else { "run" });
        if let Some(n) = prev_note(k) {
            detail += &n;
        }
        by_key.insert(k.key, out.len());
        out.push(Issue {
            sev: if k.level == 2 { Sev::Red } else { Sev::Amber },
            title: k.label.clone(),
            detail,
            target: Some(Target::Key(k.key)),
            score: frac as f64 + k.regression(),
        });
    }
    for k in &a.keys {
        let Some((d, -1)) = k.delta else { continue };
        if d.abs() < REGRESSION || by_key.contains_key(k.key) || k.cur().abs() < 1e-6 {
            continue;
        }
        let prev = k.prev.unwrap_or(0.0);
        out.push(Issue {
            sev: Sev::Amber,
            title: format!("{} regressed {}", k.label, pct(d)),
            detail: format!("{} {} vs {} in the previous run", k.cmp_stat, with_unit(k.key, k.cur()), with_unit(k.key, prev)),
            target: Some(Target::Key(k.key)),
            score: d.abs(),
        });
    }

    // Incidents grouped by rule.
    let mut rules: BTreeMap<String, (usize, f64, f64)> = BTreeMap::new();
    for e in inp.events.iter().filter(|e| e.kind == EventKind::Incident) {
        let rule = e.field("rule").unwrap_or("incident").to_string();
        let v = e.field("value").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        let r = rules.entry(rule).or_insert((0, f64::MIN, e.t));
        r.0 += e.field("count").and_then(|c| c.parse::<usize>().ok()).unwrap_or(1).max(1);
        r.1 = r.1.max(v);
    }
    for (rule, (n, worst, first)) in rules {
        let (title, unit) = match rule.as_str() {
            "long_frames" => ("Long frames", " ms"),
            "stall" => ("Stalls", " ms"),
            "memory_growth" => ("Memory growth", " MB"),
            _ => ("Incidents", ""),
        };
        out.push(Issue {
            sev: Sev::Red,
            title: format!("{title} ×{n}"),
            detail: format!("rule {rule}{} · first at {}", if worst > f64::MIN && worst != 0.0 { format!(" · worst {}{unit}", num(worst)) } else { String::new() }, clock(first)),
            target: Some(Target::Time(first)),
            score: n as f64,
        });
    }

    // Hitch events.
    let hitches: Vec<&ViewEvent> = inp.events.iter().filter(|e| e.kind == EventKind::Hitch).collect();
    if !hitches.is_empty() {
        let worst = hitches.iter().filter_map(|e| e.field("ms").and_then(|v| v.parse::<f64>().ok())).fold(0.0, f64::max);
        out.push(Issue {
            sev: Sev::Amber,
            title: format!("{} hitch{}", hitches.len(), if hitches.len() == 1 { "" } else { "es" }),
            detail: format!("frames over 50 ms · worst {} ms · first at {}", num(worst), clock(hitches[0].t)),
            target: Some(Target::Time(hitches[0].t)),
            score: hitches.len() as f64,
        });
    }

    if let Some((pm, tot)) = memory_growth(inp.m, a.span.0) {
        out.push(Issue {
            sev: Sev::Amber,
            title: "Memory growing".into(),
            detail: format!("+{pm:.0} MB per minute, +{tot:.0} MB over the run"),
            target: ["mem.footprint_mb", "mem.rss_mb"].into_iter().find(|k| a.key(k).is_some()).and_then(|k| a.key(k)).map(|k| Target::Key(k.key)),
            score: pm,
        });
    }
    if let Some(e) = inp.ended.filter(|e| matches!(*e, "killed" | "crash" | "crashed")) {
        out.push(Issue { sev: Sev::Red, title: "Run ended abnormally".into(), detail: format!("ended: {e}"), target: None, score: 1000.0 });
    }
    out.sort_by(|x, y| x.sev.cmp(&y.sev).then(y.score.total_cmp(&x.score)).then(x.title.cmp(&y.title)));
    out
}

/// `1:23` for seconds into the run.
pub fn clock(t: f64) -> String {
    let s = t.max(0.0) as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// `+12%`, `−8%`, `+3.4x`.
pub fn pct(d: f64) -> String {
    let p = d * 100.0;
    if p.abs() < 0.5 {
        "±0%".to_string()
    } else if p.abs() >= 999.5 {
        format!("{:+.0}x", d + 1.0)
    } else {
        format!("{}{:.0}%", if p >= 0.0 { "+" } else { "−" }, p.abs())
    }
}

/// Whether a threshold means "higher is better".
pub fn higher_better(key: &str) -> bool {
    better(key) == Better::Higher
}

/// `3s`, `12m`, `5h`, `2d`.
pub fn age(secs: u64) -> String {
    match secs {
        0..60 => format!("{secs}s ago"),
        60..3600 => format!("{}m ago", secs / 60),
        3600..86_400 => format!("{}h ago", secs / 3600),
        _ => format!("{}d ago", secs / 86_400),
    }
}

/// Compact number: 12345, 123, 12.3, 1.23.
pub fn num(v: f64) -> String {
    let a = v.abs();
    if a >= 100.0 || (v == v.trunc() && a < 1e6) {
        format!("{v:.0}")
    } else if a >= 10.0 {
        format!("{v:.1}")
    } else {
        format!("{v:.2}")
    }
}

/// `812 MB` / `1.4 GB`.
pub fn size(mb: f64) -> String {
    if mb >= 1024.0 { format!("{:.2} GB", mb / 1024.0) } else { format!("{mb:.0} MB") }
}

/// Value with the unit its key implies (`frame.ms` → `8.31 ms`).
pub fn with_unit(key: &str, v: f64) -> String {
    let n = num(v);
    match key {
        "cpu.process_pct" => return format!("{n}% ({:.1} cores)", v / 100.0),
        "cpu.cores" => return format!("{v:.1} cores"),
        "frame.fps" => return format!("{n} fps"),
        "mem.pressure" => {
            return match v as u8 {
                2 => "critical".into(),
                1 => "warning".into(),
                _ => "normal".into(),
            };
        }
        _ => {}
    }
    if key.ends_with("_mb") && v >= 1024.0 {
        return format!("{:.2} GB", v / 1024.0);
    }
    if key.ends_with("ms") {
        format!("{n} ms")
    } else if key.ends_with("_pct") || key == "gpu.pct" {
        format!("{n}%")
    } else if key.ends_with("_mb") {
        format!("{n} MB")
    } else if key.ends_with("_us") {
        format!("{n} µs")
    } else {
        n
    }
}

/// Plain name for a metric row (units come with the value).
pub fn label(key: &str) -> String {
    let known = match key {
        "frame.fps" => "Frame rate",
        "frame.ms" => "Frame time",
        "frame.p50_ms" => "Frame time, median",
        "frame.p95_ms" => "Frame time, slowest 5%",
        "frame.p99_ms" => "Frame time, slowest 1%",
        "frame.max_ms" => "Slowest frame",
        "frame.hitches" => "Hitches (> 50 ms)",
        "frame.long" => "Long frames",
        "cpu.machine_pct" => "CPU, share of the whole machine",
        "cpu.process_pct" => "CPU, this game (100% = 1 core)",
        "cpu.cores" => "Cores busy",
        "cpu.main_pct" => "Main thread (% of a core)",
        "cpu.render_pct" => "Render thread (% of a core)",
        "cpu.main_ms" => "Main thread per frame",
        "cpu.render_ms" => "Render thread per frame",
        "cpu.compute_pool_pct" => "Compute pool (100% = 1 core)",
        "cpu.async_pool_pct" => "Async pool (100% = 1 core)",
        "cpu.io_pool_pct" => "IO pool (100% = 1 core)",
        "gpu.process_pct" => "GPU busy, this game",
        "gpu.frame_ms" => "GPU time per frame",
        "gpu.pct" => "GPU busy, all apps",
        "gpu.renderer_pct" => "GPU pixel work, all apps",
        "gpu.tiler_pct" => "GPU geometry work, all apps",
        "gpu.alloc_mb" => "GPU memory, this game",
        "gpu.working_set_mb" => "GPU memory limit (Metal working set)",
        "gpu.alloc_pct" => "GPU memory, share of limit",
        "gpu.mem_mb" => "GPU memory, all apps",
        "gpu.passes_ms" => "GPU passes per frame",
        "gpu.textures" => "Textures",
        "gpu.texture_views" => "Texture views",
        "gpu.buffers" => "Buffers",
        "gpu.bind_groups" => "Bind groups",
        "gpu.samplers" => "Samplers",
        "gpu.render_pipelines" => "Render pipelines",
        "gpu.compute_pipelines" => "Compute pipelines",
        "mem.footprint_mb" => "Memory, this game",
        "mem.peak_mb" => "Memory, peak of this game",
        "mem.rss_mb" => "Resident memory, this game",
        "mem.system_used_mb" => "System memory in use",
        "mem.system_total_mb" => "System memory installed",
        "mem.system_pct" => "System memory in use, share",
        "mem.swap_mb" => "Swap in use",
        "mem.pressure" => "Memory pressure",
        "proc.threads" => "Threads",
        "ecs.entities" => "Entities",
        _ => "",
    };
    if !known.is_empty() {
        return known.into();
    }
    // Fallback: the part after the group, without its unit suffix, words spaced.
    let name = key.split_once('.').map_or(key, |(_, n)| n);
    let name = ["_ms", "_pct", "_mb", "_us"].iter().fold(name, |n, suf| n.strip_suffix(suf).unwrap_or(n));
    let mut out = name.replace('_', " ");
    if let Some(c) = out.get(0..1) {
        out = c.to_uppercase() + &out[1..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devtools::metrics::Summary;

    fn run(f: impl Fn(f64) -> Vec<(&'static str, f64)>, secs: usize) -> Metrics {
        let mut m = Metrics::default();
        m.window = f32::MAX;
        m.window_cap = 100_000;
        for s in 0..secs {
            let t = s as f64;
            m.next_frame(t);
            for (k, v) in f(t) {
                m.record(k, v);
            }
        }
        m.next_frame(secs as f64);
        m
    }

    fn input<'a>(m: &'a Metrics, events: &'a [ViewEvent], prev: Option<&'a SessionSummary>) -> Input<'a> {
        Input { m, events, live: false, ended: Some("exit"), prev }
    }

    #[test]
    fn smooth_run_has_no_issues() {
        let m = run(|_| vec![("frame.ms", 8.0), ("frame.fps", 120.0), ("frame.p95_ms", 9.0), ("gpu.frame_ms", 4.0), ("cpu.main_ms", 3.0), ("mem.footprint_mb", 500.0)], 60);
        let a = analyze(&input(&m, &[], None));
        assert_eq!(a.verdict, Verdict::Smooth, "{}", a.reason);
        assert!(a.issues.is_empty(), "{:?}", a.issues);
        assert_eq!(a.head.len(), 5);
        assert_eq!(a.head[0].text, "120");
    }

    #[test]
    fn gpu_bound_and_cpu_bound() {
        let gpu = run(|_| vec![("frame.ms", 25.0), ("frame.p95_ms", 30.0), ("gpu.frame_ms", 22.0), ("cpu.main_ms", 5.0), ("gpu.process_pct", 95.0)], 30);
        let a = analyze(&input(&gpu, &[], None));
        assert_eq!(a.verdict, Verdict::GpuBound, "{}", a.reason);
        assert!(a.issues.iter().any(|i| i.sev == Sev::Red || i.sev == Sev::Amber));
        let cpu = run(|_| vec![("frame.ms", 25.0), ("frame.p95_ms", 30.0), ("gpu.frame_ms", 6.0), ("cpu.main_ms", 22.0)], 30);
        assert_eq!(analyze(&input(&cpu, &[], None)).verdict, Verdict::CpuBound);
    }

    #[test]
    fn hitches_and_incidents_are_issues() {
        let m = run(|_| vec![("frame.ms", 8.0), ("frame.p95_ms", 9.0)], 30);
        let events = vec![
            ViewEvent::new(5.0, "perf.hitch", "ms=80"),
            ViewEvent::new(9.0, "incident", "rule=stall  value=2300  count=1"),
            ViewEvent::new(12.0, "incident", "rule=stall  value=900  count=2"),
        ];
        let a = analyze(&input(&m, &events, None));
        assert_eq!(a.verdict, Verdict::Hitching);
        assert_eq!(a.issues[0].sev, Sev::Red);
        assert!(a.issues[0].title.starts_with("Stalls ×3"), "{}", a.issues[0].title);
        assert!(a.issues.iter().any(|i| i.title == "1 hitch"));
        assert_eq!(a.issues[0].target, Some(Target::Time(9.0)));
    }

    #[test]
    fn regression_vs_previous_run() {
        let m = run(|_| vec![("frame.ms", 10.0), ("ecs.entities", 130.0)], 30);
        let prev = SessionSummary {
            id: "old".into(),
            keys: [
                ("frame.ms".to_string(), Summary { n: 30, avg: 8.0, p95: 8.0, max: 8.0, ..Default::default() }),
                ("ecs.entities".to_string(), Summary { n: 30, avg: 100.0, p95: 100.0, max: 100.0, ..Default::default() }),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        };
        let a = analyze(&input(&m, &[], Some(&prev)));
        let ft = a.key("frame.ms").unwrap();
        assert_eq!(ft.delta.map(|d| d.1), Some(-1));
        assert!(a.issues.iter().any(|i| i.title.contains("regressed +25%")), "{:?}", a.issues);
        // Entities: neutral, not an issue.
        assert!(!a.issues.iter().any(|i| i.title.contains("Entities")));
    }

    #[test]
    fn memory_growth_detected() {
        let m = run(|t| vec![("frame.ms", 8.0), ("mem.footprint_mb", 500.0 + t * 4.0)], 180);
        let a = analyze(&input(&m, &[], None));
        assert_eq!(a.verdict, Verdict::MemoryGrowing, "{}", a.reason);
        assert!(a.issues.iter().any(|i| i.title == "Memory growing"));
        let flat = run(|_| vec![("frame.ms", 8.0), ("mem.footprint_mb", 500.0)], 180);
        assert_eq!(analyze(&input(&flat, &[], None)).verdict, Verdict::Smooth);
    }

    #[test]
    fn threshold_issue_sorted_red_first() {
        let m = run(|_| vec![("frame.ms", 40.0), ("frame.p95_ms", 45.0), ("gpu.pct", 75.0)], 30);
        let a = analyze(&input(&m, &[], None));
        assert_eq!(a.issues[0].sev, Sev::Red);
        assert!(a.issues.windows(2).all(|w| w[0].sev <= w[1].sev));
    }

    #[test]
    fn numbers_and_units() {
        assert_eq!(num(12345.6), "12346");
        assert_eq!(num(12.34), "12.3");
        assert_eq!(num(1.234), "1.23");
        assert_eq!(with_unit("frame.ms", 8.314), "8.31 ms");
        assert_eq!(with_unit("gpu.pct", 55.5), "55.5%");
        assert_eq!(with_unit("mem.footprint_mb", 812.0), "812 MB");
        assert_eq!(age(7200), "2h ago");
        assert_eq!(pct(0.1234), "+12%");
        assert_eq!(pct(-0.5), "−50%");
        assert_eq!(clock(83.4), "1:23");
    }

    #[test]
    fn groups_and_order() {
        assert_eq!(group_of("gpu.textures"), "resources");
        assert_eq!(group_of("frame.ms"), "frame");
        assert_eq!(group_of("nodot"), "misc");
        let mut keys = ["span.x", "gpu.pct", "frame.ms", "frame.fps", "ai.think_ms"];
        keys.sort_by_key(|k| sort_key(k));
        assert_eq!(keys, ["frame.fps", "frame.ms", "gpu.pct", "span.x", "ai.think_ms"]);
        assert_eq!(label("ai.think_ms"), "Think");
    }
}
