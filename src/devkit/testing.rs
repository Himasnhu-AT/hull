//! Scenario tests: a headless engine app at a fixed timestep, driven frame by frame.
//!
//! ```ignore
//! use engine::devkit::testing::Scenario;
//! use engine::devkit::{InputLog, PerfBudget};
//!
//! #[test]
//! fn walks_forward() {
//!     let mut s = Scenario::new(GameInfo::new("orbs", "Orbs")).plugin(OrbsPlugin).build();
//!     s.step(10);
//!     s.press(KeyCode::KeyW);
//!     s.run_secs(1.0);
//!     s.release(KeyCode::KeyW);
//!     let z = s.wait_until(120, |w| player_z(w) < -3.0).expect("player moved");
//!     s.assert_json_snapshot("walk_end", s.resource_json::<Score>().unwrap());
//!     s.assert_budget(&PerfBudget { p95_frame_ms: Some(4.0), max_entities: Some(500), ..default() });
//! }
//! ```
//!
//! - Time: `TimeUpdateStrategy::ManualDuration(1/hz)`: every `update()` advances game time by
//!   exactly one step whatever the wall clock does, so runs are deterministic.
//! - Data dir: a fresh temp folder per scenario (removed on drop unless `keep_dir`).
//! - Input: `press` / `release` / `tap` / `mouse_move` / `click` write real Bevy input
//!   messages; `play(InputLog)` schedules a whole sequence (a recording from
//!   `devkit.record`, or one built in code) frame-exactly.
//! - Control commands (feature `devtools`): `call("ecs.query", json!({..}))` runs an instant
//!   command in-process, exactly as the TCP port would.
//! - Perf: every `update()` is timed (wall clock) and, with [`super::CountingAlloc`] installed,
//!   its allocations counted; see [`Scenario::assert_budget`] / [`Scenario::bench_report`].
//! - Snapshots: [`Scenario::assert_json_snapshot`] compares with `tests/snapshots/<name>.json`
//!   (`ENGINE_BLESS=1` rewrites it).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use bevy::ecs::query::{QueryData, QueryFilter};
use bevy::prelude::*;
use serde_json::Value;

use super::bench::BenchReport;
use super::perf_assert::{AllocCounts, FrameTimes, PerfBudget, PerfResult, counting_installed};
use super::replay::{InputEvent, InputLog, InputReplay, inject};
use crate::app::{EngineOptions, GameInfo};

type Setup = Box<dyn FnOnce(&mut App)>;

/// Builds a [`Scenario`] (see the module docs).
pub struct ScenarioBuilder {
    info: GameInfo,
    hz: f64,
    options: EngineOptions,
    setup: Vec<Setup>,
    keep_dir: bool,
    data_dir: Option<PathBuf>,
}

impl ScenarioBuilder {
    /// Game steps per second (default 60).
    pub fn hz(mut self, hz: f64) -> Self {
        self.hz = hz.max(1.0);
        self
    }
    /// Add a plugin (a game plugin, a test plugin).
    pub fn plugin(mut self, p: impl Plugin) -> Self {
        self.setup.push(Box::new(move |app: &mut App| {
            app.add_plugins(p);
        }));
        self
    }
    /// Anything else on the `App` before it is finished.
    pub fn setup(mut self, f: impl FnOnce(&mut App) + 'static) -> Self {
        self.setup.push(Box::new(f));
        self
    }
    /// Start in the main menu instead of `InGame`.
    pub fn menu(mut self) -> Self {
        self.options.skip_menu = false;
        self
    }
    /// Add `DevtoolsPlugin` too (engine commands such as `engine.state` become callable).
    /// The ecs/devkit commands work without it.
    pub fn devtools(mut self, on: bool) -> Self {
        self.options.devtools = on;
        self
    }
    /// Change the engine options directly.
    pub fn options(mut self, f: impl FnOnce(&mut EngineOptions)) -> Self {
        f(&mut self.options);
        self
    }
    /// Use this data folder (kept) instead of a fresh temp one.
    pub fn data_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.data_dir = Some(dir.into());
        self.keep_dir = true;
        self
    }
    /// Don't delete the temp data folder on drop (inspect saves / logs after a failure).
    pub fn keep_dir(mut self) -> Self {
        self.keep_dir = true;
        self
    }

    pub fn build(self) -> Scenario {
        let dir = self.data_dir.unwrap_or_else(|| {
            std::env::temp_dir().join(format!("engine-scenario-{}-{}-{:08x}", self.info.id, std::process::id(), rand::random::<u32>()))
        });
        let _ = std::fs::create_dir_all(&dir);
        let mut opts = self.options;
        opts.data_dir = Some(dir.clone());
        let step = Duration::from_secs_f64(1.0 / self.hz);
        let mut app = crate::app::app_with(self.info, opts);
        app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(step));
        for f in self.setup {
            f(&mut app);
        }
        app.finish();
        app.cleanup();
        Scenario { app, step, frames: 0, dir, keep_dir: self.keep_dir, times: FrameTimes::with_capacity(4096), count_allocs: counting_installed(), taps: Vec::new() }
    }
}

/// A running headless test app (see the module docs).
pub struct Scenario {
    pub app: App,
    step: Duration,
    frames: u64,
    dir: PathBuf,
    keep_dir: bool,
    times: FrameTimes,
    count_allocs: bool,
    /// Releases owed by `tap`.
    taps: Vec<InputEvent>,
}

/// `wait_until` gave up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Timeout {
    pub frames: u32,
}

impl std::fmt::Display for Timeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "condition not met within {} frames", self.frames)
    }
}

impl Scenario {
    /// Starts a builder: headless, straight into `InGame`, 60 Hz, temp data dir, no devtools
    /// plugin / trace.
    #[allow(clippy::new_ret_no_self)]
    pub fn new(info: GameInfo) -> ScenarioBuilder {
        ScenarioBuilder { info, hz: 60.0, options: EngineOptions::headless_test(PathBuf::new()), setup: Vec::new(), keep_dir: false, data_dir: None }
    }

    // ---- time ----

    /// One `App::update()` (= one fixed step), timed.
    pub fn update(&mut self) {
        let a0 = self.count_allocs.then(AllocCounts::now);
        let t0 = Instant::now();
        self.app.update();
        let dt = t0.elapsed();
        let allocs = a0.map(|a| AllocCounts::now().since(a).allocs);
        self.times.push(dt, allocs);
        self.frames += 1;
        if !self.taps.is_empty() {
            for ev in std::mem::take(&mut self.taps) {
                self.input(ev);
            }
        }
    }

    /// `n` updates.
    pub fn step(&mut self, n: u32) {
        for _ in 0..n {
            self.update();
        }
    }

    /// Steps for `secs` of game time (rounded up to whole steps).
    pub fn run_secs(&mut self, secs: f32) {
        let n = (f64::from(secs) / self.step.as_secs_f64()).ceil() as u32;
        self.step(n);
    }

    /// Steps until `pred` holds (checked before each step), at most `max_frames` steps.
    /// Returns the steps it took.
    pub fn wait_until(&mut self, max_frames: u32, mut pred: impl FnMut(&mut World) -> bool) -> Result<u32, Timeout> {
        for i in 0..=max_frames {
            if pred(self.app.world_mut()) {
                return Ok(i);
            }
            if i < max_frames {
                self.update();
            }
        }
        Err(Timeout { frames: max_frames })
    }

    /// [`Scenario::wait_until`] with a game-time limit.
    pub fn wait_secs(&mut self, secs: f32, pred: impl FnMut(&mut World) -> bool) -> Result<u32, Timeout> {
        let n = (f64::from(secs) / self.step.as_secs_f64()).ceil() as u32;
        self.wait_until(n, pred)
    }

    /// Updates run so far.
    pub fn frames(&self) -> u64 {
        self.frames
    }
    pub fn step_duration(&self) -> Duration {
        self.step
    }

    // ---- input ----

    /// Writes one input event now (seen by the next update).
    pub fn input(&mut self, ev: InputEvent) {
        if let Err(e) = inject(self.app.world_mut(), &ev) {
            panic!("scenario input {ev:?}: {e}");
        }
    }
    pub fn press(&mut self, key: KeyCode) {
        self.input(InputEvent::key(key, true));
    }
    pub fn release(&mut self, key: KeyCode) {
        self.input(InputEvent::key(key, false));
    }
    /// Press now, release after the next update.
    pub fn tap(&mut self, key: KeyCode) {
        self.press(key);
        self.taps.push(InputEvent::key(key, false));
    }
    pub fn mouse_move(&mut self, dx: f32, dy: f32) {
        self.input(InputEvent::Motion { dx, dy });
    }
    pub fn click(&mut self, b: MouseButton) {
        self.input(InputEvent::button(b, true));
        self.taps.push(InputEvent::button(b, false));
    }
    /// Plays `log` from the next update on (event frame 0 = next update).
    pub fn play(&mut self, log: InputLog) {
        let frame = self.app.world().get_resource::<bevy::diagnostic::FrameCount>().map_or(0, |f| f.0);
        self.app.world_mut().resource_mut::<InputReplay>().play(log, frame);
    }
    /// `play` + step until the log is done (+ `extra` frames).
    pub fn play_all(&mut self, log: InputLog, extra: u32) {
        let n = log.frames;
        self.play(log);
        self.step(n + 1 + extra);
    }

    // ---- world access ----

    pub fn world(&self) -> &World {
        self.app.world()
    }
    pub fn world_mut(&mut self) -> &mut World {
        self.app.world_mut()
    }
    pub fn res<R: Resource>(&self) -> &R {
        self.app.world().get_resource::<R>().unwrap_or_else(|| panic!("no resource {}", std::any::type_name::<R>()))
    }
    pub fn res_mut<R: Resource + Component<Mutability = bevy::ecs::component::Mutable>>(&mut self) -> Mut<'_, R> {
        self.app.world_mut().resource_mut::<R>()
    }
    /// Entities matching `F`, e.g. `s.count::<With<Enemy>>()`.
    pub fn count<F: QueryFilter>(&mut self) -> usize {
        let mut q = self.app.world_mut().query_filtered::<(), F>();
        q.iter(self.app.world()).count()
    }
    /// Clones of every `D` (e.g. `s.collect::<&Transform>()` → `Vec<Transform>` via `.cloned()`).
    pub fn collect<C: Component + Clone>(&mut self) -> Vec<C> {
        let mut q = self.app.world_mut().query::<&C>();
        q.iter(self.app.world()).cloned().collect()
    }
    /// The single `C` (panics on zero or several).
    pub fn single<C: Component + Clone>(&mut self) -> C {
        let mut q = self.app.world_mut().query::<&C>();
        q.single(self.app.world()).unwrap_or_else(|e| panic!("single {}: {e}", std::any::type_name::<C>())).clone()
    }
    /// Run a query closure: `s.query::<(&Transform, &Enemy)>(|q| ...)`.
    pub fn query<D: QueryData, T>(&mut self, f: impl FnOnce(bevy::ecs::query::QueryIter<'_, '_, D::ReadOnly, ()>) -> T) -> T {
        let mut q = self.app.world_mut().query::<D>();
        f(q.iter(self.app.world()))
    }
    pub fn data_dir(&self) -> &Path {
        &self.dir
    }

    // ---- snapshots ----

    /// A reflected resource as JSON.
    pub fn resource_json<R: Resource + Reflect>(&self) -> Result<Value, String> {
        super::reflect_json::resource_to_json::<R>(self.app.world())
    }

    /// Every `C` (reflected) as JSON, in entity order.
    pub fn components_json<C: Component + Reflect>(&mut self) -> Vec<Value> {
        let reg = self.app.world().resource::<AppTypeRegistry>().clone();
        let reg = reg.read();
        let mut q = self.app.world_mut().query::<(Entity, &C)>();
        let mut v: Vec<(Entity, Value)> = q
            .iter(self.app.world())
            .map(|(e, c)| (e, super::reflect_json::to_json(c.as_partial_reflect(), &reg).unwrap_or(Value::Null)))
            .collect();
        v.sort_by_key(|(e, _)| *e);
        v.into_iter().map(|(_, j)| j).collect()
    }

    /// Compares `value` with `tests/snapshots/<name>.json` (relative to the cwd, i.e. the
    /// package root under `cargo test`). Missing or `ENGINE_BLESS=1` → written. On mismatch
    /// writes `<name>.new.json` and panics with both.
    pub fn assert_json_snapshot(&self, name: &str, value: Value) {
        assert_json_snapshot_in(Path::new("tests/snapshots"), name, &value);
    }

    // ---- control commands ----

    /// Runs an instant control command in-process (`ecs.query`, `save.list`, a game's
    /// command…). Deferred commands (`time.step`, `screenshot`) need the real port.
    #[cfg(feature = "devtools")]
    pub fn call(&mut self, cmd: &str, params: Value) -> Result<Value, String> {
        use crate::devtools::control::Handler;
        let world = self.app.world_mut();
        let handler = world
            .get_resource::<crate::devtools::ControlRegistry>()
            .and_then(|r| r.get(cmd).map(|c| c.handler))
            .ok_or_else(|| format!("unknown command `{cmd}`"))?;
        let params = if params.is_null() { serde_json::json!({}) } else { params };
        match handler {
            Handler::Instant(f) => f(world, params),
            Handler::Deferred(_) => Err(format!("`{cmd}` is deferred (multi-frame); use the TCP port")),
        }
    }

    // ---- perf ----

    pub fn frame_times(&self) -> &FrameTimes {
        &self.times
    }
    /// Forget the samples so far (e.g. after warmup).
    pub fn reset_frame_times(&mut self) {
        self.times.clear();
    }
    pub fn entities(&self) -> u32 {
        self.app.world().entities().count_spawned()
    }
    pub fn check_budget(&self, b: &PerfBudget) -> PerfResult {
        b.check(&self.times, self.entities())
    }
    /// Panics listing every exceeded budget.
    pub fn assert_budget(&self, b: &PerfBudget) -> PerfResult {
        let r = self.check_budget(b);
        assert!(
            r.violations.is_empty(),
            "perf budget exceeded over {} frames:\n  {}\nframe ms {:?}\nallocs/frame {:?}",
            r.frames,
            r.violations.join("\n  "),
            r.frame_ms,
            r.allocs_per_frame
        );
        r
    }
    /// A bench report of the samples so far (`frame.ms`, `alloc.per_frame`, `ecs.entities`).
    pub fn bench_report(&self, name: &str) -> BenchReport {
        let mut r = BenchReport::new(name).metric("frame.ms", self.times.frame_ms()).value("ecs.entities", f64::from(self.entities()));
        r.frames = self.times.ms.len();
        if let Some(a) = self.times.allocs_per_frame() {
            r = r.metric("alloc.per_frame", a);
        }
        r
    }
}

impl Drop for Scenario {
    fn drop(&mut self) {
        if !self.keep_dir && !std::thread::panicking() {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

/// [`Scenario::assert_json_snapshot`] with an explicit folder.
pub fn assert_json_snapshot_in(dir: &Path, name: &str, value: &Value) {
    let path = dir.join(format!("{name}.json"));
    let text = serde_json::to_string_pretty(value).unwrap_or_default() + "\n";
    let bless = std::env::var_os("ENGINE_BLESS").is_some_and(|v| v != "0" && !v.is_empty());
    match std::fs::read_to_string(&path) {
        Ok(old) if !bless => {
            let old_v: Value = serde_json::from_str(&old).unwrap_or(Value::Null);
            if old_v != *value {
                let new = dir.join(format!("{name}.new.json"));
                let _ = crate::paths::write_atomic(&new, &text);
                panic!("snapshot `{name}` changed ({} vs {}); re-bless with ENGINE_BLESS=1\nold: {old}\nnew: {text}", path.display(), new.display());
            }
        }
        _ => {
            crate::paths::write_atomic(&path, &text).unwrap_or_else(|e| panic!("write snapshot {}: {e}", path.display()));
        }
    }
}
