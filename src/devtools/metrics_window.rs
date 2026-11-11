//! Opening the metrics viewer from a game, and the knobs games set for it.
//!
//! - On screen the viewer is its own process ([`super::metrics_viewer`], UI in
//!   [`super::metrics_view`]): it starts with plain dev runs (never with `--headless`,
//!   `--offscreen`, `--control` or `--mcp` ([`crate::cli::test_driven`]) or
//!   `--no-metrics-window`; `--metrics-window` forces it), and [`MetricsWindowKey`] (default F4)
//!   or `metrics.window` starts it again. Closing the game or the viewer leaves the other open.
//! - `metrics.screenshot` works everywhere with a GPU (also `--offscreen`): it starts a viewer
//!   process on the same data folder with `--viewer-shot`, which reads the run's log, draws one
//!   frame and saves it. The game only pays for spawning that process.
//! - [`MetricsFeatured`] and [`MetricsCompare`] name the viewer's Overview charts and Runs table
//!   columns. The viewer process exits `app()` before a game adds its plugins, so it always
//!   uses their defaults; the Runs table adds every `span.*` and game key the runs share.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use bevy::prelude::*;
use serde_json::{Value, json};

use super::control::{AddControlCommand, PendingReplies, ReplyId, params};
use super::metrics_viewer::ViewerLauncher;
use crate::cli::{dev_flag, test_driven};
use crate::flow::Headless;
use crate::paths::DataDir;

/// Default logical size of the viewer window.
pub const SIZE: (u32, u32) = (1440, 900);

/// A screenshot viewer that takes longer than this is killed.
const SHOT_TIMEOUT: Duration = Duration::from_secs(40);

/// Key that opens the metrics viewer (default F4).
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MetricsWindowKey(pub KeyCode);

impl Default for MetricsWindowKey {
    fn default() -> Self {
        MetricsWindowKey(KeyCode::F4)
    }
}

/// Extra keys drawn as big charts on the viewer's Overview tab (missing keys are skipped).
/// Empty by default: the Overview then charts frame time, FPS, CPU, GPU and memory.
#[derive(Resource, Clone, Debug, Default)]
pub struct MetricsFeatured(pub Vec<&'static str>);

/// Columns of the runs table: `(key, stat)` with stat one of min/avg/p50/p95/max. A key ending
/// in `.` is a prefix (`("span.", "avg")` = every span). Games add theirs:
/// `app.world_mut().resource_mut::<MetricsCompare>().add("ai.think_ms", "avg")`.
#[derive(Resource, Clone, Debug)]
pub struct MetricsCompare(pub Vec<(String, &'static str)>);

impl MetricsCompare {
    pub fn add(&mut self, key: &str, stat: &'static str) -> &mut Self {
        self.0.push((key.to_string(), stat));
        self
    }
}

impl Default for MetricsCompare {
    fn default() -> Self {
        let rows: [(&str, &'static str); 12] = [
            ("frame.ms", "avg"),
            ("frame.ms", "p95"),
            ("frame.ms", "max"),
            ("cpu.process_pct", "avg"),
            ("gpu.pct", "avg"),
            ("mem.footprint_mb", "max"),
            ("ecs.entities", "avg"),
            ("render.meshes_visible", "avg"),
            ("render.culled_frustum", "avg"),
            ("render.lod_far", "avg"),
            ("render.cells_loaded", "avg"),
            ("span.", "avg"),
        ];
        MetricsCompare(rows.iter().map(|(k, s)| (k.to_string(), *s)).collect())
    }
}

/// Whether the viewer opens at start (see the module docs).
pub fn wanted_at_start() -> bool {
    dev_flag("metrics-window") || (!dev_flag("no-metrics-window") && !test_driven())
}

/// Screenshot viewers in flight.
#[derive(Resource, Default)]
struct ShotJobs(Vec<ShotJob>);

struct ShotJob {
    child: Child,
    path: PathBuf,
    reply: ReplyId,
    started: Instant,
}

pub(super) fn build(app: &mut App) {
    app.init_resource::<MetricsWindowKey>()
        .init_resource::<MetricsFeatured>()
        .init_resource::<MetricsCompare>()
        .init_resource::<ShotJobs>()
        .add_control_command(
            "metrics.window",
            "Open the metrics viewer (its own window); on screen it starts the viewer process",
            params(&[("on", "boolean", "true: open (false is refused: close the viewer's window)")]),
            window_cmd,
        )
        .add_deferred_control_command(
            "metrics.screenshot",
            "Save a PNG of the metrics viewer showing this run (starts a viewer process on the same data folder, needs a GPU)",
            params(&[
                ("path", "string", "PNG path (default: <data dir>/screenshots/metrics-<n>.png)"),
                ("tab", "string", "overview | all | events | runs"),
                ("expand", "string", "metric key whose chart is opened on the All metrics tab"),
                ("search", "string", "filter text of the All metrics tab"),
                ("size", "string", "window size, e.g. 1440x900 or 900x700"),
            ]),
            screenshot_cmd,
        )
        .add_systems(Update, poll_shots);
}

pub(super) fn finish(app: &mut App) {
    let headless = app.world().get_resource::<Headless>().is_some_and(|h| h.0);
    if headless {
        return;
    }
    app.init_resource::<ViewerLauncher>();
    if !super::offscreen::enabled() {
        app.add_systems(Update, launch_viewer);
    }
}

/// On screen: start the viewer at launch (plain dev runs) and on [`MetricsWindowKey`].
fn launch_viewer(
    mut launcher: ResMut<ViewerLauncher>,
    keys: Option<Res<ButtonInput<KeyCode>>>,
    key: Res<MetricsWindowKey>,
    data: Option<Res<DataDir>>,
    mut started: Local<bool>,
) {
    let Some(data) = data else { return };
    let want = (!*started && wanted_at_start()) || keys.is_some_and(|k| k.just_pressed(key.0));
    *started = true;
    if want && let Err(e) = launcher.launch(&data.0) {
        warn!("{e}");
    }
}

fn window_cmd(world: &mut World, p: Value) -> Result<Value, String> {
    if !world.contains_resource::<ViewerLauncher>() {
        return Err("no metrics viewer in this run (headless)".into());
    }
    if p.get("on").and_then(Value::as_bool) == Some(false) {
        return Err("the metrics viewer is its own process: close its window".into());
    }
    if super::offscreen::enabled() {
        return Ok(json!({"open": false, "target": "viewer", "note": "offscreen run: use metrics.screenshot"}));
    }
    let data = world.get_resource::<DataDir>().map(|d| d.0.clone()).ok_or("no data folder")?;
    let pid = world.resource_mut::<ViewerLauncher>().launch(&data)?;
    Ok(json!({"open": true, "target": "viewer", "pid": pid}))
}

fn screenshot_cmd(world: &mut World, p: Value, reply: ReplyId) -> Result<(), String> {
    if !world.contains_resource::<ViewerLauncher>() {
        return Err("no metrics viewer in this run (headless)".into());
    }
    let dir = world.get_resource::<DataDir>().map(|d| d.0.clone()).unwrap_or_else(std::env::temp_dir);
    let n = world.resource::<ShotJobs>().0.len();
    let path = match p.get("path").and_then(Value::as_str) {
        Some(s) => PathBuf::from(s),
        None => dir.join("screenshots").join(format!("metrics-{}.png", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(n as u64, |d| d.as_secs()))),
    };
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::remove_file(&path);
    let exe = std::env::current_exe().map_err(|e| format!("metrics viewer: {e}"))?;
    let mut cmd = Command::new(exe);
    cmd.arg("--metrics-viewer").arg("--viewer-shot").arg(&path);
    for (param, flag) in [("tab", "--viewer-tab"), ("expand", "--viewer-expand"), ("search", "--viewer-search"), ("size", "--viewer-size")] {
        if let Some(v) = p.get(param).and_then(Value::as_str) {
            cmd.arg(flag).arg(v);
        }
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let child = cmd.spawn().map_err(|e| format!("metrics viewer: {e}"))?;
    world.resource_mut::<ShotJobs>().0.push(ShotJob { child, path, reply, started: Instant::now() });
    Ok(())
}

/// Answers `metrics.screenshot` when its viewer process ended.
fn poll_shots(mut jobs: ResMut<ShotJobs>, mut pending: ResMut<PendingReplies>) {
    jobs.0.retain_mut(|j| {
        let done = match j.child.try_wait() {
            Ok(Some(status)) => Some(if status.success() && j.path.exists() { Ok(json!({"path": j.path.display().to_string()})) } else { Err(format!("the metrics viewer exited with {status} and no screenshot")) }),
            Ok(None) if j.started.elapsed() > SHOT_TIMEOUT => {
                let _ = j.child.kill();
                let _ = j.child.wait();
                Some(Err("the metrics viewer took too long".to_string()))
            }
            Ok(None) => None,
            Err(e) => Some(Err(format!("metrics viewer: {e}"))),
        };
        match done {
            Some(r) => {
                pending.reply(j.reply, r);
                false
            }
            None => true,
        }
    });
}
