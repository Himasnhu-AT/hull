//! The metrics viewer: its own process, independent of the game.
//!
//! - **Game side.** Every second the game appends `{"kind": "metrics", "v": {key: avg}}` (each
//!   [`Metrics`] key's average over that second) to its session log
//!   (`<data>/logs/session-<id>.jsonl`, see [`super::session_log`]). Plain dev runs on screen
//!   start the viewer at launch ([`super::metrics_window::wanted_at_start`]); F4 or
//!   `metrics.window` starts it again after it was closed. It is the game's own executable run
//!   with `--metrics-viewer`, in its own process group: closing either window leaves the other
//!   running. One viewer per data folder (`<data>/metrics/viewer.pid`).
//! - **Viewer.** `<game> --metrics-viewer` opens "<title> — metrics" and nothing of the game.
//!   It reads only files: the runs in `<data>/logs` (newest [`super::session_log::KEEP`]),
//!   the history in `<data>/metrics/sessions.jsonl`, and the live run's log as it grows. ←/→
//!   pick an older/newer run, L (or End) the latest; while on the latest it follows new runs.
//!   Per run: the tiles, every key charted over the whole run with avg/p95/max, the runs table
//!   (this run vs the previous comparable ones), and the event list (state changes, governor
//!   steps, hitches, pause...). Runs logged before the per-second metrics lines existed show
//!   the keys the perf samples carry (fps, frame times, CPU, GPU, entities).
//!
//! Charts and stats in the viewer come from the per-second averages, so frame-time p95/max
//! there are of 1 s averages; `frame.p95_ms` / `frame.max_ms` (per-second percentiles of
//! frames) keep the spikes.

use std::collections::HashMap;
use std::io::{BufRead, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use bevy::prelude::*;
use bevy::winit::{UpdateMode, WinitSettings};
use serde_json::{Map, Value};

use super::metrics::Metrics;
use super::metrics_history::{MetricsHistory, RunInfo, SessionSummary, load};
use super::session_log::SessionLog;
use crate::app::GameInfo;
use crate::paths::DataDir;

/// How often the viewer looks for new runs and reads the live log.
const SCAN: Duration = Duration::from_secs(1);
const TAIL: Duration = Duration::from_millis(250);
/// A run counts as live while its log changed this recently and its process exists.
const LIVE_STALE: Duration = Duration::from_secs(15);
/// Events kept per run.
const MAX_EVENTS: usize = 5000;
/// Runs of `sessions.jsonl` loaded for the runs table.
const HISTORY_RUNS: usize = 200;

// ---- game side ----

/// Writes one `metrics` line per second to the session log (dev runs with a session log).
pub(super) fn game_build(app: &mut App) {
    app.add_systems(
        Last,
        log_metrics
            .after(super::metrics::record_engine)
            .run_if(resource_exists::<SessionLog>),
    );
}

fn log_metrics(m: Res<Metrics>, log: Res<SessionLog>, mut last: Local<f64>) {
    let now = m.now();
    if now - *last < 1.0 {
        return;
    }
    let v = window_avgs(&m, *last as f32);
    *last = now;
    if !v.is_empty() {
        log.write("metrics", serde_json::json!({ "v": Value::Object(v) }));
    }
}

/// Average of each key's committed samples with `t >= from`. Values recorded this frame are
/// still pending (committed next frame with `t = now`), so they land in the next line: the
/// boundary is inclusive to keep them. With `t > from` the 1 Hz perf keys, recorded on the
/// same frame the line is written, fell between lines and never appeared after the first.
fn window_avgs(m: &Metrics, from: f32) -> Map<String, Value> {
    let mut v = Map::new();
    for k in m.keys() {
        let Some(samples) = m.recent_samples(k) else {
            continue;
        };
        let (mut sum, mut n) = (0.0f64, 0u32);
        for &(t, x) in samples.iter().rev() {
            if t < from {
                break;
            }
            sum += x as f64;
            n += 1;
        }
        if n > 0 {
            v.insert(
                k.to_string(),
                Value::from(super::metrics::sig4(sum / n as f64)),
            );
        }
    }
    v
}

/// The viewer process this game started (dev runs on screen).
#[derive(Resource, Default)]
pub struct ViewerLauncher {
    child: Option<std::process::Child>,
}

impl ViewerLauncher {
    /// For `metrics.dump`: whether a viewer started by this game is open.
    pub fn json(&self) -> Value {
        serde_json::json!({"target": "viewer", "open": self.child.is_some()})
    }

    /// Starts the viewer unless one is already open for this data folder. Returns its pid.
    pub fn launch(&mut self, data: &Path) -> Result<u32, String> {
        if let Some(c) = &mut self.child
            && matches!(c.try_wait(), Ok(None))
        {
            return Ok(c.id());
        }
        if let Some(pid) = running_viewer(data) {
            return Ok(pid);
        }
        let exe = std::env::current_exe().map_err(|e| format!("metrics viewer: {e}"))?;
        let mut cmd = std::process::Command::new(exe);
        cmd.arg("--metrics-viewer")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        // Own process group: Ctrl-C in the game's terminal doesn't take the viewer down.
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0000_0200); // CREATE_NEW_PROCESS_GROUP
        let child = cmd.spawn().map_err(|e| format!("metrics viewer: {e}"))?;
        let pid = child.id();
        info!("metrics viewer started (pid {pid})");
        self.child = Some(child);
        Ok(pid)
    }
}

fn pid_file(data: &Path) -> PathBuf {
    data.join("metrics").join("viewer.pid")
}

/// pid of an open viewer for this data folder.
fn running_viewer(data: &Path) -> Option<u32> {
    let pid: u32 = std::fs::read_to_string(pid_file(data))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    alive(pid).then_some(pid)
}

fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // Signal 0: existence check only.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

// ---- viewer ----

/// One run's session log.
#[derive(Clone, Debug)]
pub struct RunFile {
    pub path: PathBuf,
    /// `<UTC stamp>-<pid>`, as in `sessions.jsonl`.
    pub id: String,
    pub live: bool,
    pub pid: Option<u32>,
}

/// What a run's log says about itself in its first lines (runs without a `sessions.jsonl` entry).
#[derive(Clone, Debug, Default)]
pub struct RunMeta {
    pub game: String,
    pub mode: String,
    pub start_ts: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    /// An `incident` line (rule, value, count).
    Incident,
    Hitch,
    State,
    /// Quality governor / settings changes.
    Quality,
    Other,
}

impl EventKind {
    pub fn of(name: &str) -> EventKind {
        match name {
            "incident" => EventKind::Incident,
            "perf.hitch" => EventKind::Hitch,
            "state" => EventKind::State,
            n if n.contains("quality") || n.contains("governor") || n == "settings" => EventKind::Quality,
            _ => EventKind::Other,
        }
    }

    pub fn word(self) -> &'static str {
        match self {
            EventKind::Incident => "incident",
            EventKind::Hitch => "hitch",
            EventKind::State => "state",
            EventKind::Quality => "quality",
            EventKind::Other => "other",
        }
    }
}

/// One event line of a run.
#[derive(Clone, Debug)]
pub struct ViewEvent {
    /// Seconds into the run.
    pub t: f64,
    pub name: String,
    pub fields: Vec<(String, String)>,
    pub kind: EventKind,
}

impl ViewEvent {
    /// `fields` as `k=v` tokens separated by spaces.
    pub fn new(t: f64, name: &str, fields: &str) -> ViewEvent {
        let fields = fields.split_whitespace().filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect();
        ViewEvent { t, name: name.to_string(), fields, kind: EventKind::of(name) }
    }

    pub fn field(&self, key: &str) -> Option<&str> {
        self.fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// `"from=Boot  to=MainMenu"`.
    pub fn detail(&self) -> String {
        self.fields.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("  ")
    }

    /// `"1:23.4  state  from=Boot  to=MainMenu"`.
    pub fn line(&self) -> String {
        let mut s = format!("{}:{:04.1}  {}", (self.t / 60.0) as u64, self.t % 60.0, self.name);
        if !self.fields.is_empty() {
            s += "  ";
            s += &self.detail();
        }
        s
    }
}

/// What the viewer shows.
#[derive(Resource)]
pub struct ViewerState {
    /// Oldest first.
    pub runs: Vec<RunFile>,
    pub selected: Option<usize>,
    /// On the newest run: move to new runs as they start.
    pub follow: bool,
    /// Event lines of the selected run.
    pub events: Vec<ViewEvent>,
    /// The selected run's summary from `sessions.jsonl` (finished runs).
    pub summary: Option<SessionSummary>,
    pub quality: Option<String>,
    pub seconds: f64,
    /// Bumped whenever the selected run's data changed (new lines, another run).
    pub generation: u64,
    /// Bumped whenever the list of runs or the history changed.
    pub runs_gen: u64,
    pub meta: HashMap<String, RunMeta>,
    /// When data last arrived (new log lines).
    pub last_data: Option<Instant>,
    loaded: Option<PathBuf>,
    offset: u64,
    partial: String,
    has_metrics: bool,
    last_scan: Option<Instant>,
    last_tail: Option<Instant>,
    history_stamp: Option<(u64, std::time::SystemTime)>,
}

impl Default for ViewerState {
    fn default() -> Self {
        ViewerState {
            runs: Vec::new(),
            selected: None,
            follow: true,
            events: Vec::new(),
            summary: None,
            quality: None,
            seconds: 0.0,
            generation: 0,
            runs_gen: 0,
            meta: HashMap::new(),
            last_data: None,
            loaded: None,
            offset: 0,
            partial: String::new(),
            has_metrics: false,
            last_scan: None,
            last_tail: None,
            history_stamp: None,
        }
    }
}

impl ViewerState {
    pub fn current(&self) -> Option<&RunFile> {
        self.selected.and_then(|i| self.runs.get(i))
    }

    /// Selects run `i` (oldest first); selecting the newest follows new runs.
    pub fn select(&mut self, i: usize) {
        let n = self.runs.len();
        if n == 0 {
            return;
        }
        let i = i.min(n - 1);
        self.selected = Some(i);
        self.follow = i == n - 1;
    }

    /// The log file being read.
    pub fn file(&self) -> Option<&Path> {
        self.loaded.as_deref()
    }
}

/// Runs the viewer app for `info`'s data folder and exits the process when its window closes.
pub fn run(info: GameInfo) -> ! {
    let data = crate::paths::data_dir(&info);
    let _ = std::fs::create_dir_all(data.join("metrics"));
    let _ = std::fs::write(pid_file(&data), std::process::id().to_string());
    let (w, h) = crate::cli::dev_value("viewer-size")
        .and_then(|s| s.split_once('x').and_then(|(w, h)| Some((w.parse::<u32>().ok()?, h.parse::<u32>().ok()?))))
        .unwrap_or(super::metrics_window::SIZE);
    let mut app = App::new();
    app.add_plugins(DefaultPlugins.set(WindowPlugin {
        primary_window: Some(Window {
            title: format!("{} — metrics", info.title),
            resolution: (w, h).into(),
            present_mode: bevy::window::PresentMode::AutoNoVsync,
            ..default()
        }),
        ..default()
    }))
    // Redraws on input and every 250 ms while a run is live ([`pace`]), not every display frame.
    .insert_resource(WinitSettings {
        focused_mode: UpdateMode::reactive(TAIL),
        unfocused_mode: UpdateMode::reactive_low_power(TAIL * 2),
    })
    .insert_resource(info)
    .insert_resource(DataDir(data.clone()))
    .insert_resource(fresh_metrics())
    .insert_resource(MetricsHistory {
        dir: Some(data.join("metrics")),
        past: load(&data.join("metrics/sessions.jsonl"), HISTORY_RUNS),
    })
    .init_resource::<ViewerState>()
    .add_systems(Update, (scan, load_selected, pace).chain());
    super::metrics_view::build(&mut app, &data);
    if let Some(path) = crate::cli::dev_value("viewer-shot") {
        let run = crate::cli::dev_value("viewer-run").and_then(|r| r.parse::<usize>().ok());
        app.insert_resource(Shot { path: path.into(), run, at: None, taken: None })
            .add_systems(Update, shot.after(load_selected));
    }
    app.run();
    let _ = std::fs::remove_file(pid_file(&data));
    std::process::exit(0)
}

/// Waits for data while a run is live (250 ms), else once a second: the viewer idles.
fn pace(st: Res<ViewerState>, mut w: ResMut<WinitSettings>) {
    let live = st.current().is_some_and(|r| r.live);
    let period = if live { TAIL } else { SCAN };
    let want = WinitSettings {
        focused_mode: UpdateMode::reactive(period),
        unfocused_mode: UpdateMode::reactive_low_power(period * 2),
    };
    if w.focused_mode != want.focused_mode {
        *w = want;
    }
}

/// `--viewer-shot <png>` (with `--metrics-viewer`; `--viewer-run <n>`: 1 = oldest run): save
/// the view once it has drawn data and quit. Also `--viewer-size WxH`, `--viewer-tab`,
/// `--viewer-expand <key>`, `--viewer-search <text>`. For checking the viewer from scripts.
#[derive(Resource)]
struct Shot {
    path: PathBuf,
    run: Option<usize>,
    at: Option<Instant>,
    taken: Option<Instant>,
}

fn shot(mut commands: Commands, mut s: ResMut<Shot>, mut st: ResMut<ViewerState>, mut exit: MessageWriter<AppExit>) {
    use bevy::render::view::window::screenshot::{Screenshot, save_to_disk};
    let at = *s.at.get_or_insert_with(Instant::now);
    if let Some(n) = s.run
        && !st.runs.is_empty()
    {
        let i = n.clamp(1, st.runs.len()) - 1;
        if st.selected != Some(i) {
            st.selected = Some(i);
            st.follow = false;
        }
    }
    // Data read and a few frames drawn: capture the next frame.
    if s.taken.is_none() && at.elapsed() > Duration::from_millis(2500) {
        s.taken = Some(Instant::now());
        commands.spawn(Screenshot::primary_window()).observe(save_to_disk(s.path.clone()));
    }
    if s.taken.is_some_and(|t| t.elapsed() > Duration::from_millis(1500)) || at.elapsed() > Duration::from_secs(20) {
        exit.write(AppExit::Success);
    }
}

fn fresh_metrics() -> Metrics {
    let mut m = Metrics::default();
    m.window = f32::MAX;
    m.window_cap = 100_000;
    m
}

/// Lists the runs (every [`SCAN`]) and marks the live ones.
fn scan(mut st: ResMut<ViewerState>, data: Res<DataDir>, mut history: ResMut<MetricsHistory>) {
    if st.last_scan.is_some_and(|t| t.elapsed() < SCAN) {
        return;
    }
    st.last_scan = Some(Instant::now());
    let mut changed = false;
    // The history file is parsed again only when it changed.
    let sessions = data.0.join("metrics/sessions.jsonl");
    let stamp = std::fs::metadata(&sessions).ok().and_then(|m| Some((m.len(), m.modified().ok()?)));
    if st.history_stamp != stamp || st.history_stamp.is_none() {
        st.history_stamp = stamp;
        history.past = load(&sessions, HISTORY_RUNS);
        changed = true;
    }
    let mut runs: Vec<RunFile> = std::fs::read_dir(data.0.join("logs"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?;
            let id = name.strip_prefix("session-")?.strip_suffix(".jsonl")?.to_string();
            let pid = id.rsplit('-').next().and_then(|p| p.parse().ok());
            let fresh = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|d| d < LIVE_STALE);
            let ended = history.past.iter().any(|s| s.id == id);
            let live = !ended && fresh && pid.is_some_and(alive);
            Some(RunFile { path, id, live, pid })
        })
        .collect();
    runs.sort_by(|a, b| a.id.cmp(&b.id));
    // Names of runs not in the history yet: the first lines of their logs.
    let mut budget = 24;
    for r in &runs {
        if budget == 0 {
            break;
        }
        if !st.meta.contains_key(&r.id) && !history.past.iter().any(|s| s.id == r.id) {
            budget -= 1;
            let meta = read_meta(&r.path);
            st.meta.insert(r.id.clone(), meta);
            changed = true;
        }
    }
    changed |= runs.len() != st.runs.len() || runs.iter().zip(&st.runs).any(|(a, b)| a.id != b.id || a.live != b.live);
    let keep = st.current().map(|r| r.id.clone());
    let n = runs.len();
    st.runs = runs;
    st.selected = if n == 0 {
        None
    } else if st.follow {
        Some(n - 1)
    } else {
        keep.and_then(|id| st.runs.iter().position(|r| r.id == id)).or(Some(n - 1))
    };
    if changed {
        st.runs_gen += 1;
    }
}

/// `game`, `mode`, start time of a log's `session.start` line.
fn read_meta(path: &Path) -> RunMeta {
    let Ok(f) = std::fs::File::open(path) else { return RunMeta::default() };
    for line in std::io::BufReader::new(f).lines().take(20).map_while(Result::ok) {
        let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&line) else { continue };
        if o.get("event").and_then(Value::as_str) == Some("session.start") {
            let s = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let args: Vec<&str> = o.get("args").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            let mode = if o.get("headless").and_then(Value::as_bool) == Some(true) {
                "headless"
            } else if args.contains(&"--offscreen") {
                "offscreen"
            } else {
                "windowed"
            };
            return RunMeta { game: s("game"), mode: mode.into(), start_ts: o.get("ts").and_then(Value::as_u64).unwrap_or(0) };
        }
    }
    RunMeta::default()
}

/// Loads the selected run into a fresh [`Metrics`], then follows its log while it is live.
fn load_selected(mut commands: Commands, mut st: ResMut<ViewerState>, mut m: ResMut<Metrics>, history: Res<MetricsHistory>) {
    let Some(run) = st.current().cloned() else {
        return;
    };
    if st.loaded.as_ref() != Some(&run.path) {
        *m = fresh_metrics();
        st.loaded = Some(run.path.clone());
        st.offset = 0;
        st.partial.clear();
        st.events.clear();
        st.quality = None;
        st.seconds = 0.0;
        st.has_metrics = file_has_metrics(&run.path);
        st.last_tail = None;
        st.generation += 1;
        commands.remove_resource::<RunInfo>();
    }
    let summary = history.past.iter().find(|s| s.id == run.id).cloned();
    if st.summary.as_ref().map(|s| &s.id) != summary.as_ref().map(|s| &s.id) {
        st.summary = summary;
        st.generation += 1;
    }
    if st.summary.as_ref().is_some_and(|s| s.quality.is_some()) {
        st.quality = st.summary.as_ref().and_then(|s| s.quality.clone());
    }
    if st.last_tail.is_some_and(|t| t.elapsed() < TAIL) {
        return;
    }
    st.last_tail = Some(Instant::now());
    let Ok(mut f) = std::fs::File::open(&run.path) else {
        return;
    };
    if f.seek(SeekFrom::Start(st.offset)).is_err() {
        return;
    }
    let mut buf = String::new();
    let Ok(n) = f.read_to_string(&mut buf) else {
        return;
    };
    if n == 0 {
        return;
    }
    st.offset += n as u64;
    let text = std::mem::take(&mut st.partial) + &buf;
    let (lines, rest) = match text.rfind('\n') {
        Some(i) => (&text[..=i], &text[i + 1..]),
        None => ("", text.as_str()),
    };
    st.partial = rest.to_string();
    let st = &mut *st;
    let mut any = false;
    for line in lines.lines() {
        let Ok(Value::Object(o)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        any = true;
        let t = o.get("t").and_then(Value::as_f64).unwrap_or(st.seconds);
        st.seconds = st.seconds.max(t);
        match o.get("kind").and_then(Value::as_str) {
            Some("metrics") => {
                m.next_frame(t);
                if let Some(Value::Object(v)) = o.get("v") {
                    for (k, x) in v {
                        if let Some(x) = x.as_f64() {
                            m.record_dyn(k, x);
                        }
                    }
                }
            }
            Some("perf") if !st.has_metrics => {
                m.next_frame(t);
                record_perf(&mut m, &o);
            }
            Some("event") => {
                let ev = o.get("event").and_then(Value::as_str).unwrap_or("?");
                if ev == "session.start" {
                    let args: Vec<String> = o
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                        .unwrap_or_default();
                    let mode = if o.get("headless").and_then(Value::as_bool) == Some(true) {
                        "headless"
                    } else if args.iter().any(|a| a == "--offscreen") {
                        "offscreen"
                    } else {
                        "windowed"
                    };
                    let start_ts = o.get("ts").and_then(Value::as_u64).unwrap_or(0);
                    let s = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                    commands.insert_resource(RunInfo::from_log(run.id.clone(), s("game"), s("version"), start_ts, mode, args));
                }
                if (ev == "settings" || ev == "quality")
                    && let Some(q) = o.get("quality").and_then(Value::as_str)
                {
                    st.quality = Some(q.to_string());
                }
                st.events.push(view_event(t, ev, &o));
                if st.events.len() > MAX_EVENTS {
                    st.events.drain(..MAX_EVENTS / 10);
                }
            }
            _ => {}
        }
    }
    // Commit the last second's values.
    let now = st.seconds;
    m.next_frame(now);
    if any {
        st.generation += 1;
        st.last_data = Some(Instant::now());
    }
}

/// Whether the log has per-second `metrics` lines (else the perf samples stand in).
fn file_has_metrics(path: &Path) -> bool {
    let Ok(f) = std::fs::File::open(path) else {
        return false;
    };
    std::io::BufReader::new(f)
        .lines()
        .take(200)
        .map_while(Result::ok)
        .any(|l| l.contains("\"kind\":\"metrics\""))
}

/// Keys a perf sample carries (runs logged before the `metrics` lines).
fn record_perf(m: &mut Metrics, o: &Map<String, Value>) {
    let get = |path: &[&str]| {
        let mut v = o.get(path[0])?;
        for p in &path[1..] {
            v = v.get(p)?;
        }
        v.as_f64()
    };
    let map: [(&'static str, &[&str]); 12] = [
        ("frame.fps", &["fps", "now"]),
        ("frame.ms", &["frame_avg_ms", "now"]),
        ("frame.p50_ms", &["frame_ms", "p50"]),
        ("frame.p95_ms", &["frame_ms", "p95"]),
        ("frame.max_ms", &["frame_ms", "max"]),
        ("frame.hitches", &["hitches"]),
        ("cpu.process_pct", &["cpu", "process", "now"]),
        ("cpu.machine_pct", &["cpu", "machine_pct"]),
        ("gpu.frame_ms", &["gpu", "frame_ms", "now"]),
        ("gpu.pct", &["gpu", "device", "now"]),
        ("gpu.in_use_mb", &["gpu", "device_in_use_mb", "now"]),
        ("ecs.entities", &["game", "entities"]),
    ];
    for (k, path) in map {
        if let Some(v) = get(path) {
            m.record(k, v);
        }
    }
}

/// An event line as the view shows it.
fn view_event(t: f64, ev: &str, o: &Map<String, Value>) -> ViewEvent {
    let mut fields = Vec::new();
    for (k, v) in o {
        if matches!(k.as_str(), "t" | "ts" | "kind" | "event") {
            continue;
        }
        let v = match v {
            Value::String(x) => x.clone(),
            Value::Null => continue,
            Value::Number(n) if n.is_f64() => super::metrics::sig4(n.as_f64().unwrap_or(0.0)).to_string(),
            other => other.to_string(),
        };
        let v = if v.chars().count() > 120 { v.chars().take(117).chain("...".chars()).collect() } else { v };
        fields.push((k.clone(), v));
    }
    ViewEvent { t, name: ev.to_string(), fields, kind: EventKind::of(ev) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frame order in a game: `begin_frame` commits last frame's values, systems record, then
    /// the line is written in `Last` (after `record_engine`). A key recorded once a second on
    /// the very frame the line is written must still be in every line.
    #[test]
    fn once_a_second_keys_reach_every_line() {
        let mut m = Metrics::default();
        let (mut last, mut lines) = (0.0f64, Vec::new());
        let dt = 1.0 / 60.0;
        for f in 0..(60 * 30) {
            let now = f as f64 * dt;
            m.next_frame(now);
            m.record("render.fast", 1.0);
            let due = m.now() - last >= 1.0;
            if due {
                m.record("frame.fps", 60.0); // the perf snapshot lands on this frame
            }
            if due {
                lines.push(window_avgs(&m, last as f32));
                last = m.now();
            }
        }
        assert!(lines.len() >= 28, "{} lines", lines.len());
        let with = |k: &str| lines.iter().filter(|l| l.contains_key(k)).count();
        assert!(
            with("frame.fps") >= lines.len() - 1,
            "frame.fps in {} of {} lines",
            with("frame.fps"),
            lines.len()
        );
        assert_eq!(with("render.fast"), lines.len());
    }

    #[test]
    fn event_lines_read_well() {
        let o: Map<String, Value> = serde_json::from_str(
            r#"{"t":83.42,"ts":1,"kind":"event","event":"state","from":"Boot","to":"MainMenu"}"#,
        )
        .unwrap();
        assert_eq!(view_event(83.42, "state", &o).line(), "1:23.4  state  from=Boot  to=MainMenu");
    }

    #[test]
    fn perf_samples_stand_in_for_metrics() {
        let o: Map<String, Value> = serde_json::from_str(
            r#"{"kind":"perf","fps":{"now":60.0},"frame_ms":{"p95":18.0},"game":{"entities":12}}"#,
        )
        .unwrap();
        let mut m = Metrics::default();
        record_perf(&mut m, &o);
        assert_eq!(m.latest("frame.fps"), Some(60.0));
        assert_eq!(m.latest("frame.p95_ms"), Some(18.0));
        assert_eq!(m.latest("ecs.entities"), Some(12.0));
    }
}
