//! Incident rules over the frame and memory streams (ported from ashlar-trace, same constants):
//! a run of long frames, a stall, and steady memory growth. Each rule fires at most once per
//! one-second window; repeats in the window only raise its count and worst figure.
//!
//! The frame path is one compare when the frame is under budget. Memory and thread count are
//! read once a second (two cheap syscalls), never per frame.
//!
//! Output: a session-log event per fired rule
//! (`{"kind":"event","event":"incident","rule":"stall","value":412.0,"count":1}`; `value` is ms for
//! the frame rules, MB for `memory_growth`), running totals in [`Incidents`] (`metrics.dump`
//! carries `incidents`), and the keys `frame.long`, `mem.peak_mb`, `proc.threads`.

use std::collections::{BTreeMap, VecDeque};

use ashlar_trace_proto::{IncidentRule, LONG_FRAMES_RUN, LONG_FRAMES_SPAN_MS, MEMORY_FLOORS, MEMORY_GROWTH_MIB, MEMORY_GROWTH_PCT, STALL_US};
use bevy::prelude::*;
use serde_json::{Value, json};

use super::metrics::Metrics;
use super::session_log::SessionLog;

const MIB: u64 = 1024 * 1024;
const MINUTE_S: f64 = 60.0;
/// A frame is long when it takes more than this share of the target frame time (vsync jitter
/// stays under it).
pub const BUDGET_SLACK: f64 = 1.25;

/// What one rule did in a window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fired {
    pub rule: IncidentRule,
    /// Times it fired in the window (at least 1).
    pub count: u32,
    /// Worst figure: microseconds for the frame rules, MiB for memory growth.
    pub value: u64,
}

/// The rules' state. Time is seconds on any steady clock.
#[derive(Debug, Default)]
pub struct Detector {
    long: VecDeque<(f64, u32)>,
    minute: Option<(f64, u64)>,
    floors: VecDeque<u64>,
    fired: Vec<Fired>,
}

impl Detector {
    /// A frame of `us` microseconds ending at `now`, against `budget_us`.
    #[inline]
    pub fn frame(&mut self, now: f64, us: u32, budget_us: u32) {
        if us <= budget_us {
            return;
        }
        self.long_frame(now, us);
    }

    #[cold]
    fn long_frame(&mut self, now: f64, us: u32) {
        if us >= STALL_US {
            self.fire(IncidentRule::Stall, u64::from(us));
        }
        let span = LONG_FRAMES_SPAN_MS as f64 / 1000.0;
        while self.long.front().is_some_and(|&(at, _)| now - at > span) {
            self.long.pop_front();
        }
        self.long.push_back((now, us));
        if self.long.len() >= LONG_FRAMES_RUN {
            let worst = self.long.iter().map(|&(_, us)| us).max().unwrap_or(us);
            self.long.clear();
            self.fire(IncidentRule::LongFrames, u64::from(worst));
        }
    }

    /// A memory sample (bytes) at `now`.
    pub fn memory(&mut self, now: f64, bytes: u64) {
        let Some((start, floor)) = self.minute else {
            self.minute = Some((now, bytes));
            return;
        };
        if now - start < MINUTE_S {
            self.minute = Some((start, floor.min(bytes)));
            return;
        }
        self.minute = Some((now, bytes));
        if self.floors.len() >= MEMORY_FLOORS {
            self.floors.pop_front();
        }
        self.floors.push_back(floor);
        if let Some(growth) = self.growth() {
            self.fire(IncidentRule::MemoryGrowth, growth / MIB);
        }
    }

    fn growth(&self) -> Option<u64> {
        if self.floors.len() < MEMORY_FLOORS {
            return None;
        }
        let rising = self.floors.iter().zip(self.floors.iter().skip(1)).all(|(a, b)| b > a);
        let (first, last) = (*self.floors.front()?, *self.floors.back()?);
        let growth = last.checked_sub(first)?;
        let enough = growth >= MEMORY_GROWTH_MIB * MIB && growth.saturating_mul(100) >= first.saturating_mul(MEMORY_GROWTH_PCT);
        (rising && enough).then_some(growth)
    }

    fn fire(&mut self, rule: IncidentRule, value: u64) {
        if let Some(f) = self.fired.iter_mut().find(|f| f.rule == rule) {
            f.count = f.count.saturating_add(1);
            f.value = f.value.max(value);
        } else {
            self.fired.push(Fired { rule, count: 1, value });
        }
    }

    /// What fired since the last call; starts the next window. Stream history carries over.
    pub fn take(&mut self) -> Vec<Fired> {
        std::mem::take(&mut self.fired)
    }
}

/// Running totals per rule for this run.
#[derive(Resource, Default, Debug, Clone)]
pub struct Incidents {
    totals: BTreeMap<&'static str, Total>,
}

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct Total {
    /// Windows in which the rule fired.
    pub windows: u64,
    /// Times it fired in all.
    pub count: u64,
    /// Worst figure, in ms for the frame rules and MiB for memory growth.
    pub worst: u64,
}

/// Value in the unit the log shows: ms for frame rules, MB for memory.
pub fn display_value(rule: IncidentRule, value: u64) -> u64 {
    match rule {
        IncidentRule::MemoryGrowth => value,
        _ => value / 1000,
    }
}

impl Incidents {
    pub fn record(&mut self, f: &Fired) {
        let t = self.totals.entry(f.rule.name()).or_default();
        t.windows += 1;
        t.count += u64::from(f.count);
        t.worst = t.worst.max(display_value(f.rule, f.value));
    }

    pub fn is_empty(&self) -> bool {
        self.totals.is_empty()
    }

    pub fn total(&self, rule: &str) -> Option<Total> {
        self.totals.get(rule).copied()
    }

    /// Times each rule fired (what the runs history stores).
    pub fn counts(&self) -> BTreeMap<String, u64> {
        self.totals.iter().map(|(k, t)| (k.to_string(), t.count)).collect()
    }

    /// `{rule: {windows, count, worst}}`.
    pub fn json(&self) -> Value {
        Value::Object(self.totals.iter().map(|(k, t)| (k.to_string(), json!({"windows": t.windows, "count": t.count, "worst": t.worst}))).collect())
    }
}

pub(super) fn build(app: &mut App) {
    app.init_resource::<Incidents>().add_systems(Last, detect.after(super::metrics::record_engine));
}

#[derive(Default)]
struct State {
    det: Detector,
    next: f64,
    long: u32,
    peak: u64,
}

fn detect(
    time: Res<Time<Real>>,
    mut m: ResMut<Metrics>,
    mut inc: ResMut<Incidents>,
    log: Option<Res<SessionLog>>,
    governor: Option<Res<crate::render_budget::QualityGovernor>>,
    mut st: Local<State>,
) {
    let now = time.elapsed_secs_f64();
    let us = time.delta().as_micros().min(u128::from(u32::MAX)) as u32;
    if now >= m.warmup {
        let target = governor.as_ref().map_or(60.0, |g| f64::from(g.target_fps)).max(1.0);
        let budget = (1e6 / target * BUDGET_SLACK) as u32;
        if us > budget {
            st.long += 1;
        }
        st.det.frame(now, us, budget);
    }
    if now < st.next {
        return;
    }
    st.next = now + 1.0;
    if now >= m.warmup {
        m.record("frame.long", f64::from(std::mem::take(&mut st.long)));
    }
    if let Some(mem) = ashlar_native::memory::process_memory() {
        st.peak = st.peak.max(mem.footprint).max(mem.peak.unwrap_or(0));
        m.record("mem.peak_mb", st.peak as f64 / MIB as f64);
        st.det.memory(now, mem.footprint);
    }
    if let Some(n) = ashlar_native::memory::thread_count() {
        m.record("proc.threads", n as f64);
    }
    for f in st.det.take() {
        inc.record(&f);
        if let Some(l) = &log {
            l.event(
                "incident",
                json!({"rule": f.rule.name(), "value": display_value(f.rule, f.value) as f64 + frac(&f), "count": f.count}),
            );
        }
    }
}

/// Sub-ms part for frame rules so a 412.4 ms stall logs as 412.4.
fn frac(f: &Fired) -> f64 {
    match f.rule {
        IncidentRule::MemoryGrowth => 0.0,
        _ => (f.value % 1000) as f64 / 1000.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const B: u32 = 20_833;

    fn frames(d: &mut Detector, fs: &[(f64, u32)]) -> Vec<(IncidentRule, u32, u64)> {
        for &(at, ms) in fs {
            d.frame(at, ms * 1000, B);
        }
        d.take().iter().map(|f| (f.rule, f.count, f.value)).collect()
    }

    fn minutes(d: &mut Detector, from: u64, mib: &[&[u64]]) -> Vec<(IncidentRule, u32, u64)> {
        for (m, samples) in mib.iter().enumerate() {
            for (s, v) in samples.iter().enumerate() {
                d.memory(((from + m as u64) * 60 + s as u64 * 10) as f64, v * MIB);
            }
        }
        d.take().iter().map(|f| (f.rule, f.count, f.value)).collect()
    }

    #[test]
    fn under_budget_never_fires() {
        let mut d = Detector::default();
        let fs: Vec<(f64, u32)> = (0..600).map(|i| (i as f64 * 0.016, 20)).collect();
        assert!(frames(&mut d, &fs).is_empty());
        d.frame(10.0, B, B); // exactly the budget is within it
        assert!(d.take().is_empty());
    }

    #[test]
    fn three_long_frames_in_a_second_fire_once() {
        let mut d = Detector::default();
        let fired = frames(&mut d, &[(0.0, 30), (0.4, 40), (0.9, 35)]);
        assert_eq!(fired, vec![(IncidentRule::LongFrames, 1, 40_000)]);
    }

    #[test]
    fn spread_out_long_frames_do_not_fire() {
        let mut d = Detector::default();
        assert!(frames(&mut d, &[(0.0, 30), (0.6, 30), (1.2, 30), (1.9, 30)]).is_empty());
    }

    #[test]
    fn a_burst_is_one_entry_per_window() {
        let mut d = Detector::default();
        let burst: Vec<(f64, u32)> = (0..30).map(|i| (i as f64 * 0.03, 30)).collect();
        assert_eq!(frames(&mut d, &burst), vec![(IncidentRule::LongFrames, 10, 30_000)]);
        assert!(frames(&mut d, &[]).is_empty(), "nothing is reported twice");
    }

    #[test]
    fn a_stall_fires_on_one_frame_and_keeps_the_worst() {
        let mut d = Detector::default();
        d.frame(0.0, 249_000, B);
        assert_eq!(d.take().iter().filter(|f| f.rule == IncidentRule::Stall).count(), 0);
        let fired = frames(&mut d, &[(5.0, 250), (9.0, 600)]);
        assert_eq!(fired, vec![(IncidentRule::Stall, 2, 600_000)]);
    }

    #[test]
    fn memory_growth_fires_once_and_needs_rising_floors() {
        let mut d = Detector::default();
        let up: [&[u64]; 6] = [&[200, 900, 210, 205, 200, 260], &[220; 6], &[240; 6], &[260; 6], &[280; 6], &[300]];
        assert_eq!(minutes(&mut d, 0, &up), vec![(IncidentRule::MemoryGrowth, 1, 80)]);
        let mut d = Detector::default();
        let dip: [&[u64]; 6] = [&[200; 6], &[260; 6], &[250; 6], &[290; 6], &[330; 6], &[330]];
        assert!(minutes(&mut d, 0, &dip).is_empty());
        let mut d = Detector::default();
        let small: [&[u64]; 6] = [&[200; 6], &[210; 6], &[220; 6], &[230; 6], &[240; 6], &[240]];
        assert!(minutes(&mut d, 0, &small).is_empty());
    }

    #[test]
    fn totals_and_json() {
        let mut i = Incidents::default();
        i.record(&Fired { rule: IncidentRule::Stall, count: 2, value: 412_000 });
        i.record(&Fired { rule: IncidentRule::Stall, count: 1, value: 300_000 });
        i.record(&Fired { rule: IncidentRule::MemoryGrowth, count: 1, value: 180 });
        assert_eq!(i.total("stall"), Some(Total { windows: 2, count: 3, worst: 412 }));
        assert_eq!(i.counts()["memory_growth"], 1);
        assert_eq!(i.json()["stall"]["worst"], 412);
    }
}
