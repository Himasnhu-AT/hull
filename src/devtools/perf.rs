//! Perf monitor: process RAM/CPU/GPU, per-thread CPU, machine top-N processes, frame-time
//! percentiles and per-system-set cost, sampled on a background thread, logged to the session
//! log and the tracer. How every number is computed: Shroud's `docs/PERF.md`.
//!
//! Frame side (cheap, every frame): push the real frame time, time the system sets games ask for
//! with [`PerfAppExt::perf_span`] (avian's `StepSimulation` is timed as `physics` with the
//! `physics` feature), detect hitches (> 50 ms once in game). Once a second it sends a
//! [`FrameAgg`] to the `perf-sampler` thread. The sampler polls the GPU driver's utilisation
//! counters 8×/s, and once a second probes the OS (`perf_sys`), smooths every metric (EMA + 60 s
//! min/max, `perf_stats`), builds a [`PerfSnapshot`] (read by the overlay and `perf.stats`),
//! writes a `perf` line to the session log, adds to the session report (`perf.report`) and sets
//! the tracer gauges.
//!
//! Games add their own overlay rows through [`DebugLines`].
//!
//! `<ID>_PERF=off` turns the monitor off (baseline for overhead measurements);
//! `<ID>_PERF_TOP=<n>` sets how many machine processes each table lists.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bevy::diagnostic::DiagnosticsStore;
use bevy::ecs::schedule::ScheduleLabel;
use bevy::prelude::*;
use serde::Serialize;
use serde_json::{Value, json};

pub use super::perf_stats::Stat;
use super::perf_stats::{Report, Track, pool_of, thread_label};
use super::perf_sys::{self, GpuProbe, GpuUtil, ThreadCpu};
use super::session_log::SessionLog;
use crate::app::GameInfo;
use crate::cli::has_flag;
use crate::flow::{AppState, Headless};
use crate::paths::DataDir;

/// A frame longer than this (once in game) is logged as a hitch.
const HITCH: Duration = Duration::from_millis(50);
/// Frame times kept for the percentiles (~5 s at 120 fps).
const RING: usize = 600;
/// Threads listed in a snapshot.
const TOP_THREADS: usize = 10;
/// Machine processes listed per table (CPU / RAM / GPU); `<ID>_PERF_TOP` overrides.
const TOP_PROCS: usize = 6;
/// GPU driver utilisation polls per second.
const GPU_POLL: Duration = Duration::from_millis(125);

/// Perf overlay visible ([`PerfOverlayKey`] toggles; `--perf` starts on; `perf.overlay` over the
/// control port).
#[derive(Resource, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PerfOverlay(pub bool);

/// Key that toggles the perf overlay. Default F3; games may replace the resource.
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PerfOverlayKey(pub KeyCode);

impl Default for PerfOverlayKey {
    fn default() -> Self {
        PerfOverlayKey(KeyCode::F3)
    }
}

/// Game-specific rows for the perf overlay (and `perf.stats`), by key, in insertion order.
///
/// ```ignore
/// fn ai_lines(mut lines: ResMut<DebugLines>, squad: Res<Squad>) {
///     lines.set("squad", format!("squad {} alive, goal {:?}", squad.alive, squad.goal));
/// }
/// ```
#[derive(Resource, Clone, Debug, Default)]
pub struct DebugLines {
    lines: Vec<(&'static str, String)>,
}

impl DebugLines {
    /// Sets (or adds) the row `key`. Cheap enough to call every frame; the overlay redraws at
    /// most 4×/s.
    pub fn set(&mut self, key: &'static str, line: impl Into<String>) {
        let line = line.into();
        match self.lines.iter_mut().find(|(k, _)| *k == key) {
            Some((_, old)) => {
                if *old != line {
                    *old = line;
                }
            }
            None => self.lines.push((key, line)),
        }
    }

    pub fn remove(&mut self, key: &str) {
        self.lines.retain(|(k, _)| *k != key);
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.lines.iter().find(|(k, _)| *k == key).map(|(_, l)| l.as_str())
    }

    pub fn iter(&self) -> impl Iterator<Item = (&'static str, &str)> {
        self.lines.iter().map(|(k, l)| (*k, l.as_str()))
    }
}

/// Latest snapshot from the sampler thread, and the session report.
#[derive(Resource, Clone, Default)]
pub struct PerfShared(pub Arc<Mutex<Option<Arc<PerfSnapshot>>>>, Arc<Mutex<Report>>);

impl PerfShared {
    pub fn latest(&self) -> Option<Arc<PerfSnapshot>> {
        self.0.lock().ok().and_then(|s| s.clone())
    }

    /// `{seconds, metrics: {name: {min, avg, p95, max, n}}}` over the session so far.
    pub fn report(&self) -> Value {
        self.1
            .lock()
            .map(|r| json!({"seconds": r.seconds, "metrics": r.summary()}))
            .unwrap_or(Value::Null)
    }
}

/// Main-thread time the monitor itself costs (frame systems + overlay), for the overhead gate.
#[derive(Resource, Default)]
pub struct PerfCost {
    pub frame_ns: u64,
    sum_ns: u64,
    frames: u32,
    /// Average per frame over the last second, µs.
    pub avg_us: f32,
    pub max_us: f32,
    max_ns: u64,
}

impl PerfCost {
    pub fn add(&mut self, d: Duration) {
        self.frame_ns += d.as_nanos() as u64;
    }
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Pct {
    pub p50: f32,
    pub p95: f32,
    pub p99: f32,
    pub max: f32,
}

#[derive(Serialize, Clone, Debug)]
pub struct ThreadRow {
    pub name: String,
    /// % of one core over the last second.
    pub cpu_pct: f32,
}

#[derive(Serialize, Clone, Debug)]
pub struct PassRow {
    pub name: String,
    pub ms: f32,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct CpuRow {
    /// This process, % of one core (100 = one core busy; Activity Monitor's convention).
    pub process: Stat,
    /// Same, as % of the whole machine (process / cores).
    pub machine_pct: f32,
    pub cores: usize,
    /// Busiest threads, labelled (main, render, compute N, audio, ...).
    pub threads: Vec<ThreadRow>,
    /// Thread pools summed (compute pool, io pool, ...), % of one core.
    pub pools: Vec<ThreadRow>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct RamRow {
    /// phys_footprint, MiB: Activity Monitor's "Memory" and `vmmap --summary`'s footprint.
    pub footprint_mb: Stat,
    /// Resident set, MiB (`ps -o rss`); counts shared pages, not compressed ones.
    pub rss_mb: Option<f32>,
}

/// One window's GPU time per frame. `clean`: no hitch and no stall in the window, so it
/// measures steady rendering. `seq` increases with every window.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GpuSample {
    pub ms_per_frame: f32,
    pub clean: bool,
    pub seq: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct GpuRow {
    /// Whole-device utilisation, % (all apps): mean of the driver's 8 Hz reads, smoothed.
    pub device: Stat,
    /// Renderer (fragment) and tiler (vertex/tiling) utilisation, %, same source.
    pub renderer: Stat,
    pub tiler: Stat,
    /// This process's GPU busy time / wall time, % (IOKit AppUsage).
    pub process: Stat,
    /// This process's GPU time per frame, ms: Δ`accumulatedGPUTime` / frames in the window.
    pub frame_ms: Stat,
    /// The last window's GPU ms per frame as a discrete sample (for controllers).
    #[serde(skip)]
    pub sample: Option<GpuSample>,
    /// This process's Metal allocations, MiB.
    pub process_alloc_mb: Option<f32>,
    /// Device-wide GPU memory in use, MiB (driver "In use system memory").
    pub device_in_use_mb: Stat,
    /// Device-wide GPU memory allocated, MiB (driver "Alloc system memory").
    pub device_alloc_mb: Option<f32>,
    /// Driver reads averaged into this sample.
    pub polls: u32,
    /// Sum of top-level render pass GPU times, ms (timestamp queries; `--gpu-passes`).
    pub passes_ms: Option<f32>,
    pub passes: Vec<PassRow>,
}

/// Cost of one timed system set ([`PerfAppExt::perf_span`]), ms per frame over the last second.
#[derive(Serialize, Clone, Debug, Default)]
pub struct SpanRow {
    pub name: &'static str,
    pub ms: f32,
    pub max_ms: f32,
}

/// What the app measures itself, over the last second.
#[derive(Serialize, Clone, Debug, Default)]
pub struct GameRow {
    /// `AppState` (Boot / MainMenu / InGame).
    pub state: String,
    pub entities: u32,
    pub spans: Vec<SpanRow>,
}

/// One process on the machine.
#[derive(Serialize, Clone, Debug, Default)]
pub struct ProcRow {
    pub pid: i32,
    pub name: String,
    /// % of one core.
    pub cpu_pct: Option<f32>,
    /// phys_footprint (macOS) or resident, MiB. None: not readable without root.
    pub mem_mb: Option<f32>,
    /// GPU busy time / wall time, % (None: no GPU client).
    pub gpu_pct: Option<f32>,
    /// This game.
    pub me: bool,
}

/// Machine-wide top-N processes, each list with this game added if it isn't in the top N.
#[derive(Serialize, Clone, Debug, Default)]
pub struct ProcTables {
    pub by_cpu: Vec<ProcRow>,
    pub by_mem: Vec<ProcRow>,
    pub by_gpu: Vec<ProcRow>,
    /// CPU of all readable processes (root-owned ones need root), % of one core.
    pub total_cpu_pct: f32,
    /// Readable processes.
    pub count: usize,
}

/// Last-60 s histories (oldest first) for the overlay's sparklines.
#[derive(Clone, Debug, Default)]
pub struct History {
    pub frame_ms: Vec<f32>,
    pub cpu: Vec<f32>,
    pub gpu: Vec<f32>,
    pub ram: Vec<f32>,
}

/// Everything the monitor knows, once a second.
#[derive(Serialize, Clone, Debug, Default)]
pub struct PerfSnapshot {
    /// Frames / real seconds over the last second.
    pub fps: Stat,
    /// Mean frame time, ms.
    pub frame_avg_ms: Stat,
    /// Percentiles over the last ~5 s of frames.
    pub frame_ms: Pct,
    pub cpu: CpuRow,
    pub ram: RamRow,
    pub gpu: GpuRow,
    pub procs: ProcTables,
    pub game: GameRow,
    pub hitches: u32,
    /// Monitor's own main-thread cost, µs per frame (average, worst) over the last second.
    pub overhead_us: f32,
    pub overhead_max_us: f32,
    /// Sampler thread's own time for this sample, ms (off the frame).
    pub sampler_ms: f32,
    /// The main thread sent nothing for > 1.5 s (frame data is stale).
    pub stalled: bool,
    #[serde(skip)]
    pub history: History,
}

/// What the main thread hands the sampler once a second.
#[derive(Clone, Debug, Default)]
struct FrameAgg {
    frames: u32,
    /// Real time the frames covered, s.
    secs: f32,
    frame_ms: Pct,
    gpu_passes_ms: Option<f32>,
    passes: Vec<PassRow>,
    game: GameRow,
    hitches: u32,
    overhead_us: f32,
    overhead_max_us: f32,
}

#[derive(Default)]
struct Span {
    start: Option<Instant>,
    frame_ns: u64,
    sum_ns: u64,
    max_ns: u64,
}

impl Span {
    fn begin(&mut self) {
        self.start = Some(Instant::now());
    }
    fn end(&mut self) {
        if let Some(s) = self.start.take() {
            self.frame_ns += s.elapsed().as_nanos() as u64;
        }
    }
    fn close_frame(&mut self) {
        self.sum_ns += self.frame_ns;
        self.max_ns = self.max_ns.max(self.frame_ns);
        self.frame_ns = 0;
    }
    /// `(avg ms per frame, max ms)`, then reset.
    fn take(&mut self, frames: u32) -> (f32, f32) {
        let r = (self.sum_ns as f32 / frames.max(1) as f32 / 1e6, self.max_ns as f32 / 1e6);
        self.sum_ns = 0;
        self.max_ns = 0;
        r
    }
}

/// Timed system sets, by label.
#[derive(Resource, Default)]
pub struct PerfSpans(Vec<(&'static str, Span)>);

/// `app.perf_span(Update, EnemySet, "ai")`: time a system set every frame; shows as a row in the
/// overlay, in `perf.stats` and in `perf.report` (ms per frame).
pub trait PerfAppExt {
    fn perf_span<S: SystemSet + Clone>(&mut self, schedule: impl ScheduleLabel + Clone, set: S, label: &'static str) -> &mut Self;
}

impl PerfAppExt for App {
    fn perf_span<S: SystemSet + Clone>(&mut self, schedule: impl ScheduleLabel + Clone, set: S, label: &'static str) -> &mut Self {
        let i = {
            let mut spans = self.world_mut().get_resource_or_init::<PerfSpans>();
            match spans.0.iter().position(|(l, _)| *l == label) {
                Some(i) => i,
                None => {
                    spans.0.push((label, Span::default()));
                    spans.0.len() - 1
                }
            }
        };
        self.add_systems(schedule.clone(), (move |mut c: ResMut<PerfSpans>| c.0[i].1.begin()).before(set.clone()))
            .add_systems(schedule, (move |mut c: ResMut<PerfSpans>| c.0[i].1.end()).after(set))
    }
}

#[derive(Resource)]
struct PerfFrame {
    tx: Sender<FrameAgg>,
    times: VecDeque<f32>,
    frames: u32,
    max_dt: f32,
    hitches: u32,
    armed: bool,
    next: Duration,
    /// Real time at the start of the current 1 s window.
    window_start: Duration,
}

/// Monitor settings resolved in `finish` (env names depend on the game id).
#[derive(Resource, Clone)]
struct PerfConfig {
    headless: bool,
    top_n: usize,
}

pub struct PerfPlugin;

impl Plugin for PerfPlugin {
    fn build(&self, app: &mut App) {
        let headless = has_flag("headless");
        app.init_resource::<PerfShared>()
            .insert_resource(PerfOverlay(has_flag("perf") && !headless))
            .init_resource::<PerfOverlayKey>()
            .init_resource::<PerfCost>()
            .init_resource::<PerfSpans>()
            .init_resource::<DebugLines>();
        #[cfg(feature = "physics")]
        app.perf_span(FixedPostUpdate, avian3d::prelude::PhysicsSystems::StepSimulation, "physics");
        let render = app.is_plugin_added::<bevy::render::RenderPlugin>();
        if render && !headless && (cfg!(not(target_os = "macos")) || has_flag("gpu-passes")) {
            app.add_plugins(bevy::render::diagnostic::RenderDiagnosticsPlugin);
        }
        register_commands(app);
    }

    fn finish(&self, app: &mut App) {
        let id = app.world().get_resource::<GameInfo>().map_or("game", |g| g.id);
        let env = |suffix: &str| std::env::var(format!("{}_{suffix}", env_prefix(id))).ok();
        // Baseline for overhead measurements: the whole monitor off.
        if env("PERF").is_some_and(|v| v == "off") {
            return;
        }
        let headless = app.world().get_resource::<Headless>().map_or(has_flag("headless"), |h| h.0);
        let top_n = env("PERF_TOP").and_then(|v| v.parse().ok()).unwrap_or(TOP_PROCS).max(1);
        let dir = app
            .world()
            .get_resource::<DataDir>()
            .map(|d| d.0.join("logs"))
            .unwrap_or_else(|| std::env::temp_dir().join(format!("{id}-logs")));
        match SessionLog::start(&dir) {
            Some(l) => {
                info!("perf: session log {}", l.path.display());
                let version = app.world().get_resource::<GameInfo>().map_or(env!("CARGO_PKG_VERSION"), |g| g.version);
                l.event(
                    "session.start",
                    json!({"game": id, "version": version, "pid": std::process::id(), "headless": headless,
                           "args": std::env::args().skip(1).collect::<Vec<_>>()}),
                );
                app.insert_resource(l);
            }
            None => warn!("perf: could not open the session log"),
        }
        if let Some(render_app) = app.get_sub_app_mut(bevy::render::RenderApp) {
            render_app.add_systems(bevy::render::Render, note_render_thread);
        }
        app.insert_resource(PerfConfig { headless, top_n })
            .add_systems(Startup, start_sampler)
            .add_systems(Last, (watch_events, frame_tick).chain());
    }
}

/// `shroud` → `SHROUD`, `my-game` → `MY_GAME`.
pub(crate) fn env_prefix(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
        .collect()
}

fn register_commands(app: &mut App) {
    use super::control::{AddControlCommand, params};
    app.add_control_command(
        "perf.overlay",
        "Show or hide the perf overlay",
        params(&[("on", "boolean", "default true")]),
        |world: &mut World, p: Value| {
            let on = p.get("on").and_then(Value::as_bool).unwrap_or(true);
            world.resource_mut::<PerfOverlay>().0 = on;
            Ok(json!({"on": on}))
        },
    )
    .add_control_command(
        "perf.report",
        "Session perf summary: min/avg/p95/max of every 1 Hz metric since start",
        params(&[]),
        |world: &mut World, _: Value| {
            let r = world.resource::<PerfShared>().report();
            if let Some(l) = world.get_resource::<SessionLog>() {
                l.write("perf.report", r.clone());
            }
            Ok(r)
        },
    );
}

/// Id of the render thread (Bevy's pipelined rendering thread is unnamed).
static RENDER_TID: AtomicU64 = AtomicU64::new(0);

/// Exclusive, so it runs on the thread driving the render schedule.
fn note_render_thread(_: &mut World) {
    if RENDER_TID.load(Ordering::Relaxed) == 0 {
        RENDER_TID.store(perf_sys::current_thread_id(), Ordering::Relaxed);
    }
}

/// Startup (after every plugin's `finish`, so the tracer is final): start the sampler thread.
fn start_sampler(world: &mut World) {
    let Some(cfg) = world.get_resource::<PerfConfig>().cloned() else { return };
    let shared = world.resource::<PerfShared>().clone();
    let log = world.get_resource::<SessionLog>().cloned();
    #[cfg(feature = "trace")]
    let gauges = world.get_resource::<crate::trace::GameTracer>().and_then(|t| Gauges::new(&t.0));
    #[cfg(not(feature = "trace"))]
    let gauges: Option<Gauges> = None;
    let (tx, rx) = channel();
    let main_tid = perf_sys::current_thread_id();
    let spawned = std::thread::Builder::new()
        .name("perf-sampler".into())
        .spawn(move || sampler(rx, shared, log, gauges, !cfg.headless, main_tid, cfg.top_n));
    if spawned.is_err() {
        warn!("perf: could not start the sampler thread");
        return;
    }
    world.insert_resource(PerfFrame {
        tx,
        times: VecDeque::with_capacity(RING),
        frames: 0,
        max_dt: 0.0,
        hitches: 0,
        armed: false,
        next: Duration::from_secs(1),
        window_start: Duration::ZERO,
    });
}

/// Snapshot as JSON for `perf.stats`.
pub fn stats_json(world: &World) -> Value {
    let snap = world.get_resource::<PerfShared>().and_then(|s| s.latest());
    let cost = world.get_resource::<PerfCost>();
    let lines: Option<serde_json::Map<String, Value>> = world
        .get_resource::<DebugLines>()
        .map(|d| d.iter().map(|(k, l)| (k.to_string(), Value::from(l))).collect());
    json!({
        "monitor": snap.map(|s| serde_json::to_value(&*s).unwrap_or(Value::Null)),
        "overhead_us": cost.map(|c| c.avg_us),
        "overhead_max_us": cost.map(|c| c.max_us),
        "overlay": world.get_resource::<PerfOverlay>().map(|o| o.0),
        "session_log": world.get_resource::<SessionLog>().map(|l| l.path.display().to_string()),
        "debug_lines": lines,
    })
}

fn frame_tick(
    real: Res<Time<Real>>,
    pf: Option<ResMut<PerfFrame>>,
    mut spans: ResMut<PerfSpans>,
    mut cost: ResMut<PerfCost>,
    state: Option<Res<State<AppState>>>,
    store: Option<Res<DiagnosticsStore>>,
    log: Option<Res<SessionLog>>,
    entities: &bevy::ecs::entity::Entities,
) {
    let Some(mut pf) = pf else { return };
    let t0 = Instant::now();
    let dt = real.delta_secs();
    let in_game = state.as_ref().is_some_and(|s| *s.get() == AppState::InGame);
    if dt > 0.0 {
        if pf.times.len() == RING {
            pf.times.pop_front();
        }
        pf.times.push_back(dt);
        pf.frames += 1;
        pf.max_dt = pf.max_dt.max(dt);
        if pf.armed && real.delta() > HITCH {
            pf.hitches += 1;
            if let Some(l) = &log {
                l.event("perf.hitch", json!({"ms": dt * 1000.0, "state": state.as_ref().map(|s| format!("{:?}", s.get()))}));
            }
        }
    }
    pf.armed |= in_game;
    for (_, s) in &mut spans.0 {
        s.close_frame();
    }

    let now = real.elapsed();
    if now >= pf.next {
        pf.next = now + Duration::from_secs(1);
        let secs = (now - pf.window_start).as_secs_f32();
        pf.window_start = now;
        let mut v: Vec<f32> = pf.times.iter().copied().collect();
        v.sort_unstable_by(f32::total_cmp);
        let pct = |p: f32| v.get(((v.len().max(1) - 1) as f32 * p).round() as usize).map_or(0.0, |x| x * 1000.0);
        let frames = pf.frames;
        let span_rows = spans
            .0
            .iter_mut()
            .map(|(name, s)| {
                let (ms, max_ms) = s.take(frames);
                SpanRow { name, ms, max_ms }
            })
            .collect();
        let (gpu_passes_ms, passes) = store.map(|s| gpu_passes(&s)).unwrap_or_default();
        let agg = FrameAgg {
            frames,
            secs,
            frame_ms: Pct { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: pf.max_dt * 1000.0 },
            gpu_passes_ms,
            passes,
            game: GameRow {
                state: state.map(|s| format!("{:?}", s.get())).unwrap_or_default(),
                entities: entities.count_spawned(),
                spans: span_rows,
            },
            hitches: pf.hitches,
            overhead_us: cost.avg_us,
            overhead_max_us: cost.max_us,
        };
        pf.frames = 0;
        pf.max_dt = 0.0;
        pf.hitches = 0;
        let _ = pf.tx.send(agg);
        cost.avg_us = cost.sum_ns as f32 / cost.frames.max(1) as f32 / 1000.0;
        cost.max_us = cost.max_ns as f32 / 1000.0;
        cost.sum_ns = 0;
        cost.max_ns = 0;
        cost.frames = 0;
    }
    // Close this frame's cost (the overlay adds its share earlier in the frame).
    let ns = cost.frame_ns + t0.elapsed().as_nanos() as u64;
    cost.sum_ns += ns;
    cost.max_ns = cost.max_ns.max(ns);
    cost.frames += 1;
    cost.frame_ns = 0;
}

/// `(sum of top-level pass GPU ms, top passes)` from `render/<pass>/elapsed_gpu`.
fn gpu_passes(store: &DiagnosticsStore) -> (Option<f32>, Vec<PassRow>) {
    let mut passes: Vec<PassRow> = store
        .iter()
        .filter_map(|d| {
            let p = d.path().as_str();
            let name = p.strip_prefix("render/")?.strip_suffix("/elapsed_gpu")?;
            if name.contains('/') {
                return None; // nested span; its parent already counts it
            }
            Some(PassRow { name: name.to_string(), ms: d.smoothed()? as f32 })
        })
        .filter(|p| p.ms > 0.0)
        .collect();
    if passes.is_empty() {
        return (None, passes);
    }
    let total = passes.iter().map(|p| p.ms).sum();
    passes.sort_by(|a, b| b.ms.total_cmp(&a.ms));
    passes.truncate(6);
    (Some(total), passes)
}

/// Engine-level events for the session log: `AppState` changes and pause/resume. Games log their
/// own with [`SessionLog::event`].
fn watch_events(
    log: Option<Res<SessionLog>>,
    mut cost: ResMut<PerfCost>,
    state: Option<Res<State<AppState>>>,
    paused: Option<Res<crate::pause::Paused>>,
    mut last: Local<(Option<AppState>, bool)>,
) {
    let Some(log) = log else { return };
    let t0 = Instant::now();
    if let Some(s) = state.filter(|s| last.0 != Some(*s.get())) {
        log.event("state", json!({"from": last.0.map(|s| format!("{s:?}")), "to": format!("{:?}", s.get())}));
        last.0 = Some(*s.get());
    }
    if let Some(p) = paused.filter(|p| p.0 != last.1) {
        log.event(if p.0 { "paused" } else { "resumed" }, json!({}));
        last.1 = p.0;
    }
    cost.add(t0.elapsed());
}

/// Tracer gauges (only when tracing is on).
#[cfg_attr(not(feature = "trace"), allow(dead_code))]
struct Gauges {
    #[cfg(feature = "trace")]
    g: [ashlar_trace::Gauge; 8],
}

#[cfg(feature = "trace")]
impl Gauges {
    fn new(t: &ashlar_trace::Tracer) -> Option<Self> {
        t.is_enabled().then(|| Gauges {
            g: [
                t.gauge("cpu_pct"),
                t.gauge("rss_mb"),
                t.gauge("footprint_mb"),
                t.gauge("gpu_util_pct"),
                t.gauge("gpu_device_pct"),
                t.gauge("gpu_mem_mb"),
                t.gauge("gpu_frame_ms"),
                t.gauge("frame_p99_ms"),
            ],
        })
    }
}

#[cfg_attr(not(feature = "trace"), allow(dead_code))]
impl Gauges {
    /// Values in the order of `new`.
    #[allow(unused_variables)]
    fn set(&self, values: [Option<f32>; 8]) {
        #[cfg(feature = "trace")]
        for (g, v) in self.g.iter().zip(values) {
            if let Some(v) = v {
                g.set(v as f64);
            }
        }
    }
}

/// Smoothing state for every 1 Hz metric.
#[derive(Default)]
struct Tracks {
    fps: Track,
    frame_avg: Track,
    cpu: Track,
    footprint: Track,
    gpu_device: Track,
    gpu_renderer: Track,
    gpu_tiler: Track,
    gpu_process: Track,
    gpu_frame: Track,
    gpu_mem: Track,
}

/// Mean of the driver's utilisation reads since the last sample.
#[derive(Default)]
struct UtilAcc {
    n: u32,
    sum: GpuUtil,
}

impl UtilAcc {
    fn add(&mut self, u: GpuUtil) {
        self.n += 1;
        self.sum.device += u.device;
        self.sum.renderer += u.renderer;
        self.sum.tiler += u.tiler;
        self.sum.in_use += u.in_use;
        self.sum.alloc = u.alloc;
    }
    fn take(&mut self) -> Option<(GpuUtil, u32)> {
        let n = std::mem::take(&mut self.n);
        let s = std::mem::take(&mut self.sum);
        (n > 0).then(|| {
            let k = n as f64;
            let u = GpuUtil {
                device: s.device / k,
                renderer: s.renderer / k,
                tiler: s.tiler / k,
                in_use: s.in_use / n as u64,
                alloc: s.alloc,
            };
            (u, n)
        })
    }
}

fn sampler(
    rx: Receiver<FrameAgg>,
    shared: PerfShared,
    log: Option<SessionLog>,
    gauges: Option<Gauges>,
    gpu: bool,
    main_tid: u64,
    top_n: usize,
) {
    let mut probe = gpu.then(GpuProbe::new);
    let mut procs = perf_sys::ProcProbe::new();
    let me = std::process::id() as i32;
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    let mut prev_t = Instant::now();
    let mut prev_cpu = perf_sys::process_cpu_ns();
    let mut prev_threads: HashMap<u64, u64> = HashMap::new();
    let mut prev_gpu: HashMap<i32, u64> = HashMap::new();
    let mut agg = FrameAgg::default();
    let mut tracks = Tracks::default();
    let mut util = UtilAcc::default();
    let mut next_poll = Instant::now();
    let mut last_agg = Instant::now();
    let mut sample_seq: u64 = 0;
    loop {
        // Poll the driver's utilisation at GPU_POLL until the main thread's 1 s aggregate
        // arrives (or 1.5 s pass without one: the frame is stalled).
        let wait = next_poll.saturating_duration_since(Instant::now());
        let got = match rx.recv_timeout(wait) {
            Ok(a) => {
                agg = rx.try_iter().last().unwrap_or(a);
                last_agg = Instant::now();
                true
            }
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if Instant::now() >= next_poll {
            next_poll += GPU_POLL;
            if next_poll < Instant::now() {
                next_poll = Instant::now() + GPU_POLL;
            }
            if let Some(u) = probe.as_mut().and_then(|p| p.poll_util()) {
                util.add(u);
            }
        }
        let stalled = !got && last_agg.elapsed() >= Duration::from_millis(1500);
        if !got && !stalled {
            continue;
        }
        if stalled {
            last_agg = Instant::now(); // one stalled sample per 1.5 s
        }
        let work = Instant::now();
        let wall_ns = work.duration_since(prev_t).as_nanos().max(1) as f64;
        prev_t = work;
        let pct_of_wall = |ns: u64| (ns as f64 / wall_ns * 100.0) as f32;

        // This process: CPU and threads.
        let cpu = perf_sys::process_cpu_ns();
        let cpu_pct = match (cpu, prev_cpu) {
            (Some(c), Some(p)) => Some(pct_of_wall(c.saturating_sub(p))),
            _ => None,
        };
        prev_cpu = cpu;
        let threads: Vec<ThreadCpu> = perf_sys::threads();
        let render_tid = RENDER_TID.load(Ordering::Relaxed);
        let mut rows: Vec<ThreadRow> = Vec::with_capacity(threads.len());
        let mut next_prev = HashMap::with_capacity(threads.len());
        for th in &threads {
            let d = prev_threads.get(&th.id).map_or(0, |p| th.cpu_ns.saturating_sub(*p));
            next_prev.insert(th.id, th.cpu_ns);
            let name = if th.id == main_tid {
                "main".to_string()
            } else if th.id == render_tid {
                "render".to_string()
            } else {
                thread_label(&th.name, th.gcd)
            };
            rows.push(ThreadRow { name, cpu_pct: pct_of_wall(d) });
        }
        prev_threads = next_prev;
        let mut pools: HashMap<String, f32> = HashMap::new();
        for r in &rows {
            *pools.entry(pool_of(&r.name)).or_default() += r.cpu_pct;
        }
        let mut pools: Vec<ThreadRow> = pools
            .into_iter()
            .filter(|(_, pct)| *pct >= 0.1)
            .map(|(name, cpu_pct)| ThreadRow { name, cpu_pct })
            .collect();
        pools.sort_by(|a, b| b.cpu_pct.total_cmp(&a.cpu_pct));
        rows.sort_by(|a, b| b.cpu_pct.total_cmp(&a.cpu_pct));
        rows.truncate(TOP_THREADS);
        let mem = perf_sys::process_mem();

        // GPU: per-process busy time (all processes) and the driver's averaged utilisation.
        let g = probe.as_mut().map(|p| p.sample()).unwrap_or_default();
        let mut gpu_pct: HashMap<i32, (f32, String)> = HashMap::new();
        let mut next_gpu = HashMap::with_capacity(g.clients.len());
        let mut my_gpu_ns = None;
        for c in &g.clients {
            if let Some(p) = prev_gpu.get(&c.pid) {
                let d = c.gpu_ns.saturating_sub(*p);
                gpu_pct.insert(c.pid, (pct_of_wall(d), c.name.clone()));
                if c.pid == me {
                    my_gpu_ns = Some(d);
                }
            }
            next_gpu.insert(c.pid, c.gpu_ns);
        }
        prev_gpu = next_gpu;
        let process_gpu = gpu_pct.get(&me).map(|(p, _)| p.min(100.0));
        let (u, polls) = match util.take() {
            Some((u, n)) => (Some(u), n),
            None => (None, 0),
        };

        // Machine processes.
        let all = procs.sample();
        let total_cpu_pct = all.iter().map(|p| p.cpu_pct).sum::<f32>().max(0.0);
        let mb = |b: u64| b as f32 / 1_048_576.0;
        let mut table: Vec<ProcRow> = all
            .iter()
            .map(|p| ProcRow {
                pid: p.pid,
                name: p.name.clone(),
                cpu_pct: Some(if p.pid == me { cpu_pct.unwrap_or(p.cpu_pct) } else { p.cpu_pct }),
                mem_mb: Some(mb(p.mem)),
                gpu_pct: gpu_pct.get(&p.pid).map(|g| g.0),
                me: p.pid == me,
            })
            .collect();
        for (pid, (pct, name)) in &gpu_pct {
            if !all.iter().any(|p| p.pid == *pid) {
                table.push(ProcRow { pid: *pid, name: name.clone(), gpu_pct: Some(*pct), me: *pid == me, ..default() });
            }
        }
        let top = |key: fn(&ProcRow) -> f32| {
            let mut t: Vec<&ProcRow> = table.iter().filter(|r| key(r) > 0.0 || r.me).collect();
            t.sort_by(|a, b| key(b).total_cmp(&key(a)));
            let mut out: Vec<ProcRow> = t.iter().take(top_n).map(|r| (*r).clone()).collect();
            if !out.iter().any(|r| r.me)
                && let Some(r) = t.iter().find(|r| r.me)
            {
                out.push((*r).clone());
            }
            out
        };
        let tables = ProcTables {
            by_cpu: top(|r| r.cpu_pct.unwrap_or(0.0)),
            by_mem: top(|r| r.mem_mb.unwrap_or(0.0)),
            by_gpu: top(|r| r.gpu_pct.unwrap_or(0.0)),
            total_cpu_pct,
            count: all.len(),
        };

        // Smooth and assemble.
        let fresh = !stalled && agg.secs > 0.0;
        let fps = fresh.then(|| agg.frames as f32 / agg.secs);
        let frame_avg = fps.filter(|f| *f > 0.0).map(|f| 1000.0 / f);
        // GPU time per frame: this process's GPU time in the window over its frames.
        let gpu_frame = my_gpu_ns.filter(|_| fresh && agg.frames > 0).map(|ns| ns as f32 / 1e6 / agg.frames as f32);
        sample_seq += 1;
        let gpu_sample = gpu_frame.map(|ms| GpuSample { ms_per_frame: ms, clean: agg.hitches == 0, seq: sample_seq });
        let t = &mut tracks;
        fn stat(t: &mut Track, v: Option<f32>) -> Stat {
            match v {
                Some(v) => t.push(v),
                None => t.stat(),
            }
        }
        let snap = PerfSnapshot {
            fps: stat(&mut t.fps, fps),
            frame_avg_ms: stat(&mut t.frame_avg, frame_avg),
            frame_ms: agg.frame_ms.clone(),
            cpu: CpuRow {
                process: stat(&mut t.cpu, cpu_pct),
                machine_pct: cpu_pct.unwrap_or(0.0) / cores as f32,
                cores,
                threads: rows,
                pools,
            },
            ram: RamRow { footprint_mb: stat(&mut t.footprint, mem.map(|m| mb(m.1))), rss_mb: mem.map(|m| mb(m.0)) },
            gpu: GpuRow {
                device: stat(&mut t.gpu_device, u.map(|u| u.device as f32)),
                renderer: stat(&mut t.gpu_renderer, u.map(|u| u.renderer as f32)),
                tiler: stat(&mut t.gpu_tiler, u.map(|u| u.tiler as f32)),
                process: stat(&mut t.gpu_process, process_gpu),
                frame_ms: stat(&mut t.gpu_frame, gpu_frame),
                sample: gpu_sample,
                process_alloc_mb: g.process_alloc.map(mb),
                device_in_use_mb: stat(&mut t.gpu_mem, u.map(|u| mb(u.in_use))),
                device_alloc_mb: u.map(|u| mb(u.alloc)),
                polls,
                passes_ms: agg.gpu_passes_ms,
                passes: agg.passes.clone(),
            },
            procs: tables,
            game: agg.game.clone(),
            hitches: if stalled { 0 } else { agg.hitches },
            overhead_us: agg.overhead_us,
            overhead_max_us: agg.overhead_max_us,
            sampler_ms: work.elapsed().as_secs_f32() * 1000.0,
            stalled,
            history: History {
                frame_ms: t.frame_avg.history(),
                cpu: t.cpu.history(),
                gpu: t.gpu_process.history(),
                ram: t.footprint.history(),
            },
        };
        if fresh && let Ok(mut r) = shared.1.lock() {
            r.seconds += 1;
            r.add("fps", fps);
            r.add("frame_avg_ms", frame_avg);
            r.add("frame_p50_ms", Some(snap.frame_ms.p50));
            r.add("frame_p95_ms", Some(snap.frame_ms.p95));
            r.add("frame_p99_ms", Some(snap.frame_ms.p99));
            r.add("frame_max_ms", Some(snap.frame_ms.max));
            r.add("cpu_pct", cpu_pct);
            r.add("footprint_mb", mem.map(|m| mb(m.1)));
            r.add("rss_mb", snap.ram.rss_mb);
            r.add("gpu_process_pct", process_gpu);
            r.add("gpu_device_pct", u.map(|u| u.device as f32));
            r.add("gpu_renderer_pct", u.map(|u| u.renderer as f32));
            r.add("gpu_tiler_pct", u.map(|u| u.tiler as f32));
            r.add("gpu_frame_ms", gpu_frame);
            r.add("gpu_process_alloc_mb", snap.gpu.process_alloc_mb);
            r.add("gpu_device_in_use_mb", u.map(|u| mb(u.in_use)));
            for s in &snap.game.spans {
                r.add(s.name, Some(s.ms));
            }
            r.add("monitor_overhead_us", Some(snap.overhead_us));
            r.add("sampler_ms", Some(snap.sampler_ms));
        }
        if let Some(gs) = &gauges {
            gs.set([
                cpu_pct,
                snap.ram.rss_mb,
                mem.map(|m| mb(m.1)),
                process_gpu,
                u.map(|u| u.device as f32),
                snap.gpu.process_alloc_mb,
                gpu_frame,
                Some(snap.frame_ms.p99),
            ]);
        }
        if let Some(l) = &log {
            l.write("perf", serde_json::to_value(&snap).unwrap_or(Value::Null));
        }
        if let Ok(mut s) = shared.0.lock() {
            *s = Some(Arc::new(snap));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_prefix_uppercases_and_replaces() {
        assert_eq!(env_prefix("shroud"), "SHROUD");
        assert_eq!(env_prefix("my-game2"), "MY_GAME2");
    }

    #[test]
    fn debug_lines_keep_order_and_replace() {
        let mut d = DebugLines::default();
        d.set("a", "one");
        d.set("b", "two");
        d.set("a", "uno");
        assert_eq!(d.iter().collect::<Vec<_>>(), vec![("a", "uno"), ("b", "two")]);
        d.remove("a");
        assert_eq!(d.get("b"), Some("two"));
        assert_eq!(d.get("a"), None);
    }
}
