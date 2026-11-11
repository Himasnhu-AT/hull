//! The metrics viewer's UI: one egui window built from ashlar-ui components, hosted by
//! `bevy_egui` in the viewer process ([`super::metrics_viewer`]).
//!
//! ```text
//! ┌ Runs ────┬ health header: verdict + FPS / frame p95 / CPU / GPU / memory (▲▼ vs previous run)
//! │ sidebar  ├ issues: severity-sorted, click to jump to the chart or the moment
//! │ (runs,   ├ tabs: Overview · All metrics · Events · Runs
//! │ badges)  │   (charts, searchable rows with sparklines, event list, comparison table)
//! └──────────┴ status bar: data folder, followed file, refresh age
//! ```
//!
//! What it concludes (verdict, issues, headline numbers) comes from
//! [`metrics_analysis`](super::metrics_analysis), computed again only when the run's data changed.
//! Keys: ←/→ older/newer run, L latest, `/` search, 1–4 tabs. Mouse: click rows and issues, drag
//! to pan a chart, ctrl-scroll or pinch to zoom, double-click to reset.
//! Preferences (pinned keys, sort) live in `<data>/metrics/viewer.json`.

mod chart;
mod panels;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use ashlar_ui::sidebar::SidebarState;
use ashlar_ui::tokens::{self, ThemeMode, Tokens};
use bevy::prelude::*;
use bevy_egui::{EguiContexts, EguiPlugin, EguiPrimaryContextPass, egui};

use super::metrics::Metrics;
use super::metrics_analysis::{Analysis, Input, Target, analyze};
use super::metrics_history::{MetricsHistory, RunInfo, SessionSummary, current};
use super::metrics_viewer::{EventKind, ViewerState};
use super::metrics_window::{MetricsCompare, MetricsFeatured};
use crate::paths::DataDir;
use chart::ChartState;

/// Tabs, in order.
pub const TABS: [&str; 4] = ["Overview", "All metrics", "Events", "Runs"];

/// Adds the egui host and the view to the viewer app.
pub fn build(app: &mut App, data: &Path) {
    let mut ui = ViewerUi::new(data);
    ui.apply_args();
    app.add_plugins(EguiPlugin::default())
        .init_resource::<MetricsFeatured>()
        .init_resource::<MetricsCompare>()
        .insert_resource(ui)
        .add_systems(Startup, setup)
        .add_systems(EguiPrimaryContextPass, ui_system);
}

/// The egui context sits on its own camera (the viewer draws nothing else).
fn setup(mut commands: Commands, mut egui: ResMut<bevy_egui::EguiGlobalSettings>) {
    egui.auto_create_primary_context = false;
    commands.spawn((Name::new("Metrics UI camera"), bevy_egui::PrimaryEguiContext, Camera2d));
}

/// Everything the view reads from the viewer's state.
pub struct Inputs<'a> {
    pub st: &'a ViewerState,
    pub m: &'a Metrics,
    pub past: &'a [SessionSummary],
    pub info: Option<&'a RunInfo>,
    pub compare: &'a MetricsCompare,
    pub featured: &'a MetricsFeatured,
    pub data: &'a Path,
}

#[allow(clippy::too_many_arguments)]
fn ui_system(
    mut contexts: EguiContexts,
    mut view: ResMut<ViewerUi>,
    mut st: ResMut<ViewerState>,
    m: Res<Metrics>,
    history: Res<MetricsHistory>,
    info: Option<Res<RunInfo>>,
    compare: Res<MetricsCompare>,
    featured: Res<MetricsFeatured>,
    data: Res<DataDir>,
) -> Result {
    let ctx = contexts.ctx_mut()?.clone();
    let pick = {
        let inp = Inputs { st: &st, m: &m, past: &history.past, info: info.as_deref(), compare: &compare, featured: &featured, data: &data.0 };
        view.show(&ctx, &inp)
    };
    if let Some(i) = pick {
        st.select(i);
    }
    Ok(())
}

/// Cached analysis of the shown run.
struct Cache {
    key: (u64, u64, String),
    analysis: Analysis,
    /// The run as a summary (live runs too): the Runs tab and baselines.
    summary: SessionSummary,
}

/// One line of the runs sidebar.
pub(crate) struct RunRow {
    pub idx: usize,
    pub id: String,
    pub label: String,
    pub detail: String,
    pub badge: Option<&'static str>,
}

/// State of the view (what is selected, expanded, searched, zoomed).
#[derive(Resource)]
pub struct ViewerUi {
    pub(crate) tab: usize,
    pub(crate) search: String,
    pub(crate) focus_search: bool,
    pub(crate) sort_worst: bool,
    pub(crate) collapsed: HashSet<String>,
    pub(crate) expanded: Vec<String>,
    pub(crate) scroll_to: Option<String>,
    pub(crate) charts: HashMap<String, ChartState>,
    pub(crate) pinned: Vec<String>,
    pub(crate) highlight: Option<f64>,
    pub(crate) scroll_event: Option<f64>,
    pub(crate) kinds: [bool; 5],
    pub(crate) sidebar: SidebarState,
    pub(crate) baseline: Option<String>,
    pub(crate) issues_all: bool,
    pub(crate) pending_pick: Option<usize>,
    pub(crate) rows: Vec<RunRow>,
    rows_key: (u64, u64),
    rows_at: Option<Instant>,
    cache: Option<Cache>,
    prefs_file: PathBuf,
    prefs_saved: String,
    themed: bool,
    /// Redraw cost of the last frame, ms (shown in the status bar).
    pub(crate) cost_ms: f32,
}

impl ViewerUi {
    pub fn new(data: &Path) -> ViewerUi {
        let prefs_file = data.join("metrics").join("viewer.json");
        let mut ui = ViewerUi {
            tab: 0,
            search: String::new(),
            focus_search: false,
            sort_worst: false,
            collapsed: ["resources", "perf"].iter().map(|s| s.to_string()).collect(),
            expanded: Vec::new(),
            scroll_to: None,
            charts: HashMap::new(),
            pinned: Vec::new(),
            highlight: None,
            scroll_event: None,
            kinds: [true; 5],
            sidebar: SidebarState::new(),
            baseline: None,
            issues_all: false,
            pending_pick: None,
            rows: Vec::new(),
            rows_key: (u64::MAX, 0),
            rows_at: None,
            cache: None,
            prefs_file,
            prefs_saved: String::new(),
            themed: false,
            cost_ms: 0.0,
        };
        ui.load_prefs();
        ui
    }

    /// `--viewer-tab`, `--viewer-expand`, `--viewer-search` (scripted screenshots).
    pub fn apply_args(&mut self) {
        if let Some(t) = crate::cli::dev_value("viewer-tab") {
            let t = t.to_ascii_lowercase();
            if let Some(i) = TABS.iter().position(|n| n.to_ascii_lowercase().starts_with(&t)) {
                self.tab = i;
            }
        }
        if let Some(k) = crate::cli::dev_value("viewer-expand") {
            self.tab = 1;
            self.expanded.push(k.clone());
            self.scroll_to = Some(k);
        }
        if let Some(s) = crate::cli::dev_value("viewer-search") {
            self.tab = 1;
            self.search = s;
        }
    }

    fn load_prefs(&mut self) {
        let Ok(text) = std::fs::read_to_string(&self.prefs_file) else { return };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return };
        if let Some(a) = v.get("pinned").and_then(|p| p.as_array()) {
            self.pinned = a.iter().filter_map(|k| k.as_str().map(String::from)).collect();
        }
        self.sort_worst = v.get("sort_worst").and_then(|b| b.as_bool()).unwrap_or(false);
        self.prefs_saved = self.prefs_json();
    }

    fn prefs_json(&self) -> String {
        serde_json::json!({"pinned": self.pinned, "sort_worst": self.sort_worst}).to_string()
    }

    fn save_prefs(&mut self) {
        let now = self.prefs_json();
        if now != self.prefs_saved {
            if let Some(d) = self.prefs_file.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let _ = std::fs::write(&self.prefs_file, &now);
            self.prefs_saved = now;
        }
    }

    /// An issue or tile was clicked: open the key's chart or the moment in the events.
    pub(crate) fn jump(&mut self, target: Target) {
        match target {
            Target::Key(k) => {
                self.tab = 1;
                self.search.clear();
                if !self.expanded.iter().any(|e| e == k) {
                    self.expanded.push(k.to_string());
                }
                self.collapsed.remove(super::metrics_analysis::group_of(k));
                self.scroll_to = Some(k.to_string());
            }
            Target::Time(t) => {
                self.tab = 2;
                self.highlight = Some(t);
                self.scroll_event = Some(t);
            }
        }
    }

    /// Recomputes the analysis when the data changed.
    fn refresh(&mut self, inp: &Inputs) {
        let run_id = inp.st.current().map(|r| r.id.clone()).unwrap_or_default();
        let key = (inp.st.generation, inp.st.runs_gen, run_id.clone());
        if self.cache.as_ref().is_some_and(|c| c.key == key) {
            return;
        }
        let live = inp.st.current().is_some_and(|r| r.live);
        let quality = inp.st.quality.clone();
        let own = inp.st.summary.clone().or_else(|| inp.info.map(|i| current(inp.m, i, quality, "running")));
        let prev = previous(inp.past, &run_id, own.as_ref());
        let ended = inp.st.summary.as_ref().map(|s| s.ended.as_str());
        let analysis = analyze(&Input { m: inp.m, events: &inp.st.events, live, ended, prev, incidents: inp.st.summary.as_ref().map(|s| &s.incidents) });
        let summary = own.unwrap_or_else(|| pseudo_summary(&run_id, &analysis, inp));
        self.cache = Some(Cache { key, analysis, summary });
    }

    /// One frame. Returns the run (index into `st.runs`, oldest first) the user picked.
    pub fn show(&mut self, ctx: &egui::Context, inp: &Inputs) -> Option<usize> {
        let t0 = Instant::now();
        if !self.themed {
            let big = |mut t: Tokens| {
                t.type_scale.small = 12.0;
                t.type_scale.body = 14.0;
                t.type_scale.button = 14.0;
                t.type_scale.heading = 17.0;
                t.control_height = 26.0;
                t
            };
            tokens::install(ctx, &big(Tokens::dark()), &big(Tokens::dark()), ThemeMode::Dark);
            self.themed = true;
        }
        let t = tokens::current(ctx);
        self.refresh(inp);
        self.build_rows(inp);
        let mut pick = self.keys(ctx, inp);
        let Some(cache) = self.cache.take() else { return pick };

        let mut root = egui::Ui::new(
            ctx.clone(),
            "metrics_root".into(),
            egui::UiBuilder::new().layer_id(egui::LayerId::background()).max_rect(ctx.content_rect()),
        );
        root.painter().rect_filled(ctx.content_rect(), 0.0, t.surface.app);
        self.status_bar(&mut root, inp, &cache);
        if let Some(i) = self.sidebar_ui(&mut root, inp, &t) {
            pick = Some(i);
        }
        egui::CentralPanel::default().frame(egui::Frame::new().fill(t.surface.app).inner_margin(egui::Margin::symmetric(14, 10))).show(&mut root, |ui| {
            self.main_ui(ui, inp, &cache, &t);
        });
        self.cache = Some(cache);
        self.save_prefs();
        pick = pick.or(self.pending_pick.take());
        let ms = t0.elapsed().as_secs_f32() * 1000.0;
        self.cost_ms += 0.2 * (ms - self.cost_ms);
        pick
    }

    /// Keyboard: ←/→ runs, L latest, `/` search, 1–4 tabs.
    fn keys(&mut self, ctx: &egui::Context, inp: &Inputs) -> Option<usize> {
        if ctx.egui_wants_keyboard_input() {
            return None;
        }
        let n = inp.st.runs.len();
        let cur = inp.st.selected.unwrap_or(n.saturating_sub(1));
        let (left, right, last, slash, nums) = ctx.input(|i| {
            let plain = !i.modifiers.any();
            (
                plain && i.key_pressed(egui::Key::ArrowLeft),
                plain && i.key_pressed(egui::Key::ArrowRight),
                plain && (i.key_pressed(egui::Key::L) || i.key_pressed(egui::Key::End)),
                plain && i.key_pressed(egui::Key::Slash),
                [egui::Key::Num1, egui::Key::Num2, egui::Key::Num3, egui::Key::Num4].map(|k| plain && i.key_pressed(k)),
            )
        });
        if let Some(i) = nums.iter().position(|p| *p) {
            self.tab = i;
        }
        if slash {
            self.tab = 1;
            self.focus_search = true;
        }
        if n == 0 {
            return None;
        }
        if left {
            Some(cur.saturating_sub(1))
        } else if right {
            Some((cur + 1).min(n - 1))
        } else if last {
            Some(n - 1)
        } else {
            None
        }
    }

    pub(crate) fn kind_on(&self, k: EventKind) -> bool {
        self.kinds[kind_index(k)]
    }
}

pub(crate) fn kind_index(k: EventKind) -> usize {
    match k {
        EventKind::Incident => 0,
        EventKind::Hitch => 1,
        EventKind::State => 2,
        EventKind::Quality => 3,
        EventKind::Other => 4,
    }
}

pub(crate) const KINDS: [EventKind; 5] = [EventKind::Incident, EventKind::Hitch, EventKind::State, EventKind::Quality, EventKind::Other];

/// The previous comparable run of `id` in the history: the newest older run with the same setup,
/// else the newest older run of the same mode.
pub fn previous<'a>(past: &'a [SessionSummary], id: &str, own: Option<&SessionSummary>) -> Option<&'a SessionSummary> {
    let older = || past.iter().rev().filter(|s| s.id.as_str() < id && s.id != id);
    match own {
        Some(o) => older().find(|s| s.comparable(o)).or_else(|| older().find(|s| s.mode == o.mode && s.profile == o.profile)),
        None => older().next(),
    }
}

/// A summary of the shown run built from the analysis (a live run without `RunInfo`).
fn pseudo_summary(id: &str, a: &Analysis, inp: &Inputs) -> SessionSummary {
    use super::metrics::Summary;
    SessionSummary {
        v: 1,
        id: id.to_string(),
        seconds: inp.st.seconds,
        mode: inp.st.meta.get(id).map(|m| m.mode.clone()).unwrap_or_default(),
        game: inp.st.meta.get(id).map(|m| m.game.clone()).unwrap_or_default(),
        start_ts: inp.st.meta.get(id).map_or(0, |m| m.start_ts),
        ended: "running".into(),
        keys: a
            .keys
            .iter()
            .map(|k| (k.key.to_string(), Summary { n: k.stats.n as u64, min: k.stats.min, avg: k.stats.avg, p50: k.stats.p50, p95: k.stats.p95, max: k.stats.max }))
            .collect(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devtools::metrics_viewer::{RunFile, ViewEvent};

    fn fixture() -> (Metrics, ViewerState, Vec<SessionSummary>) {
        let mut m = Metrics::default();
        m.window = f32::MAX;
        m.window_cap = 100_000;
        for s in 0..120 {
            m.next_frame(s as f64);
            let hitch = if s % 40 == 0 { 30.0 } else { 0.0 };
            for (k, v) in [
                ("frame.ms", 9.0 + hitch),
                ("frame.fps", 100.0),
                ("frame.p95_ms", 12.0 + hitch),
                ("cpu.main_ms", 4.0),
                ("gpu.frame_ms", 6.0),
                ("mem.footprint_mb", 700.0 + s as f64),
                ("span.ai_ms", 1.0),
                ("ecs.entities", 500.0),
            ] {
                m.record(k, v);
            }
        }
        m.next_frame(120.0);
        let mut st = ViewerState::default();
        st.runs = vec![
            RunFile { path: "a".into(), id: "20260101T000000Z-1".into(), live: false, pid: Some(1) },
            RunFile { path: "b".into(), id: "20260102T000000Z-2".into(), live: true, pid: Some(2) },
        ];
        st.selected = Some(1);
        st.seconds = 120.0;
        st.events = vec![ViewEvent::new(41.0, "perf.hitch", "ms=70"), ViewEvent::new(60.0, "incident", "rule=stall value=900 count=1"), ViewEvent::new(5.0, "state", "from=Boot to=InGame")];
        let past = vec![SessionSummary { id: "20260101T000000Z-1".into(), game: "demo".into(), mode: "windowed".into(), seconds: 100.0, ended: "exit".into(), ..Default::default() }];
        (m, st, past)
    }

    /// Every tab draws, twice, without panicking; clicking through state does not break layout.
    #[test]
    fn every_tab_draws() {
        let (m, st, past) = fixture();
        let (compare, featured) = (MetricsCompare::default(), MetricsFeatured::default());
        let data = std::env::temp_dir().join(format!("metrics-view-test-{}", std::process::id()));
        let mut view = ViewerUi::new(&data);
        let ctx = egui::Context::default();
        for tab in 0..4 {
            view.tab = tab;
            for _ in 0..2 {
                let inp = Inputs { st: &st, m: &m, past: &past, info: None, compare: &compare, featured: &featured, data: &data };
                let raw = egui::RawInput { screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(1200.0, 800.0))), ..Default::default() };
                let mut out = ctx.run_ui(raw, |ui| {
                    view.show(ui.ctx(), &inp);
                });
                out.textures_delta.clear();
            }
        }
        let a = &view.cache.as_ref().expect("analysis cached").analysis;
        assert!(a.issues.iter().any(|i| i.title.starts_with("Stalls")), "{:?}", a.issues);
        view.expanded.push("frame.ms".into());
        view.jump(Target::Key("frame.ms"));
        assert_eq!(view.tab, 1);
        view.sort_worst = true;
        let inp = Inputs { st: &st, m: &m, past: &past, info: None, compare: &compare, featured: &featured, data: &data };
        let mut out = ctx.run_ui(egui::RawInput { screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(900.0, 700.0))), ..Default::default() }, |ui| {
            view.show(ui.ctx(), &inp);
        });
        out.textures_delta.clear();
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn previous_run_prefers_the_same_setup() {
        let mk = |id: &str, mode: &str| SessionSummary { id: id.into(), mode: mode.into(), profile: "debug".into(), ..Default::default() };
        let past = vec![mk("1", "windowed"), mk("2", "headless"), mk("3", "windowed")];
        let own = mk("4", "windowed");
        assert_eq!(previous(&past, "4", Some(&own)).map(|s| s.id.as_str()), Some("3"));
        let own = mk("4", "headless");
        assert_eq!(previous(&past, "4", Some(&own)).map(|s| s.id.as_str()), Some("2"));
        assert_eq!(previous(&past, "2", None).map(|s| s.id.as_str()), Some("1"));
    }
}
