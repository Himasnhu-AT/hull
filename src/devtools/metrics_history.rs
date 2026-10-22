//! Metrics history across runs: one summary per session in `<data>/metrics/sessions.jsonl`
//! (newest last), so a code change can be judged against the runs before it.
//!
//! - At startup (dev builds) a background thread runs `git rev-parse --short HEAD` and
//!   `git status --porcelain --untracked-files=no` in the working directory (commit + dirty).
//! - Every [`CHECKPOINT`] the current summary is written to `unfinished-<pid>.json`; on
//!   `AppExit` the final summary is appended to `sessions.jsonl` (and a `metrics.summary` line
//!   to the session log) and the checkpoint is removed. A run that was killed leaves its
//!   checkpoint behind; the next run appends it with `"ended": "killed"`.
//! - Control commands: `metrics.dump {prefix?}` (current values + recent/session summaries),
//!   `metrics.sessions {n?}` (current + past summaries), `metrics.label {key, value}`.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bevy::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::control::{AddControlCommand, params};
use super::metrics::{Better, Metrics, Summary, better};
use super::session_log::SessionLog;
use crate::app::GameInfo;
use crate::flow::Headless;
use crate::paths::DataDir;

/// Checkpoint period for the running session.
pub const CHECKPOINT: Duration = Duration::from_secs(30);
/// Lines kept in `sessions.jsonl` (trimmed at startup when it grows past twice this).
pub const KEEP: usize = 500;
/// Past sessions loaded at startup (for the window and `metrics.sessions`).
pub const LOAD: usize = 60;

/// One run, as stored in `sessions.jsonl`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct SessionSummary {
    /// Format version.
    pub v: u32,
    /// `20261022T101500Z-<pid>` (UTC start).
    pub id: String,
    pub game: String,
    pub version: String,
    /// Unix ms at start.
    pub start_ts: u64,
    pub seconds: f64,
    pub frames: u64,
    /// `git rev-parse --short HEAD` of the working dir, if it is a repo.
    pub commit: Option<String>,
    /// Uncommitted changes to tracked files.
    pub dirty: Option<bool>,
    /// `debug` / `release`.
    pub profile: String,
    /// `windowed` / `offscreen` / `headless`.
    pub mode: String,
    /// `CoreSettings.quality` at the end of the run.
    pub quality: Option<String>,
    /// Game labels (`Metrics::set_label`): map, scenario, ...
    pub labels: BTreeMap<String, String>,
    /// `exit` / `killed` / `running` (the live session).
    pub ended: String,
    pub warmup_s: f64,
    pub args: Vec<String>,
    /// Per key, over the session after warm-up.
    pub keys: BTreeMap<String, Summary>,
}

impl SessionSummary {
    /// Same setup (mode, profile, quality, labels): deltas between these mean something.
    pub fn comparable(&self, other: &SessionSummary) -> bool {
        self.mode == other.mode && self.profile == other.profile && self.quality == other.quality && self.labels == other.labels
    }

    /// `c02421c*` (dirty) or `no git`.
    pub fn commit_label(&self) -> String {
        match &self.commit {
            Some(c) => format!("{c}{}", if self.dirty == Some(true) { "*" } else { "" }),
            None => "no git".into(),
        }
    }
}

/// Relative change of `stat` of `key` from `prev` to `cur`, with how good it is:
/// `(fraction, +1 better / -1 worse / 0 neutral or within noise)`.
pub fn delta(key: &str, cur: f64, prev: f64) -> Option<(f64, i8)> {
    if !cur.is_finite() || !prev.is_finite() || prev.abs() < 1e-9 {
        return None;
    }
    let d = (cur - prev) / prev.abs();
    let sign = if d.abs() < NOISE {
        0
    } else {
        match better(key) {
            Better::Lower => if d < 0.0 { 1 } else { -1 },
            Better::Higher => if d > 0.0 { 1 } else { -1 },
            Better::Neutral => 0,
        }
    };
    Some((d, sign))
}

/// Changes smaller than this (3 %) are shown dim: run-to-run noise.
pub const NOISE: f64 = 0.03;

/// Who/what this run is (fixed at startup; git fills in from a thread).
#[derive(Resource, Clone)]
pub struct RunInfo {
    pub id: String,
    pub game: String,
    pub version: String,
    pub start_ts: u64,
    pub profile: &'static str,
    pub mode: &'static str,
    pub args: Vec<String>,
    git: Arc<Mutex<Option<(Option<String>, Option<bool>)>>>,
}

impl RunInfo {
    /// `(commit, dirty)` once the git probe finished.
    pub fn git(&self) -> (Option<String>, Option<bool>) {
        self.git.lock().ok().and_then(|g| g.clone()).unwrap_or((None, None))
    }
}

/// Where history lives and what was loaded at startup (oldest first).
#[derive(Resource, Clone, Default)]
pub struct MetricsHistory {
    pub dir: Option<PathBuf>,
    pub past: Vec<SessionSummary>,
}

impl MetricsHistory {
    pub fn file(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join("sessions.jsonl"))
    }
}

/// The live session's summary.
pub fn current(m: &Metrics, run: &RunInfo, quality: Option<String>, ended: &str) -> SessionSummary {
    let (commit, dirty) = run.git();
    SessionSummary {
        v: 1,
        id: run.id.clone(),
        game: run.game.clone(),
        version: run.version.clone(),
        start_ts: run.start_ts,
        seconds: (m.now() * 10.0).round() / 10.0,
        frames: m.frames(),
        commit,
        dirty,
        profile: run.profile.into(),
        mode: run.mode.into(),
        quality,
        labels: m.labels().clone(),
        ended: ended.into(),
        warmup_s: m.warmup,
        args: run.args.clone(),
        keys: m.keys().filter_map(|k| m.session(k).map(|s| (k.to_string(), s.rounded()))).collect(),
    }
}

fn quality(world: &World) -> Option<String> {
    world.get_resource::<crate::settings::CoreSettings>().map(|s| format!("{:?}", s.quality))
}

pub(super) fn build(app: &mut App) {
    app.add_control_command(
        "metrics.dump",
        "Metrics: every key's latest value, last-60 s and session min/avg/p50/p95/max",
        params(&[("prefix", "string", "only keys starting with this (e.g. `render.`)")]),
        dump,
    )
    .add_control_command(
        "metrics.sessions",
        "Metrics history: this run's summary and the last N runs' (newest first)",
        params(&[("n", "integer", "past runs to return (default 10)")]),
        sessions,
    )
    .add_control_command(
        "metrics.label",
        "Label this run for the history (map, scenario, ...)",
        params(&[("key", "string", "label name"), ("value", "string", "label value")]),
        label,
    );
}

pub(super) fn finish(app: &mut App) {
    let world = app.world();
    let info = world.get_resource::<GameInfo>().cloned();
    let headless = world.get_resource::<Headless>().is_some_and(|h| h.0);
    let start = SystemTime::now();
    let run = RunInfo {
        id: super::session_log::utc_stamp(start),
        game: info.as_ref().map_or("game", |i| i.id).into(),
        version: info.as_ref().map_or(env!("CARGO_PKG_VERSION"), |i| i.version).into(),
        start_ts: start.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
        profile: if cfg!(debug_assertions) { "debug" } else { "release" },
        mode: if headless {
            "headless"
        } else if super::offscreen::enabled() {
            "offscreen"
        } else {
            "windowed"
        },
        args: std::env::args().skip(1).collect(),
        git: Arc::default(),
    };
    let git = run.git.clone();
    let _ = std::thread::Builder::new().name("metrics-git".into()).spawn(move || {
        let found = probe_git(&std::env::current_dir().unwrap_or_default());
        if let Ok(mut g) = git.lock() {
            *g = Some(found);
        }
    });
    let dir = world.get_resource::<DataDir>().map(|d| d.0.join("metrics"));
    let mut history = MetricsHistory { dir: dir.clone(), past: Vec::new() };
    if let Some(dir) = &dir
        && std::fs::create_dir_all(dir).is_ok()
    {
        adopt_unfinished(dir);
        trim(&dir.join("sessions.jsonl"));
        history.past = load(&dir.join("sessions.jsonl"), LOAD);
    }
    app.insert_resource(run)
        .insert_resource(history)
        .add_systems(Last, save_history.after(super::metrics::record_engine));
}

/// `(short commit, dirty)` of the repo containing `dir`, or `(None, None)`.
pub fn probe_git(dir: &Path) -> (Option<String>, Option<bool>) {
    let run = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let Some(commit) = run(&["rev-parse", "--short", "HEAD"]).filter(|c| !c.is_empty()) else {
        return (None, None);
    };
    let dirty = run(&["status", "--porcelain", "--untracked-files=no"]).map(|s| !s.is_empty());
    (Some(commit), dirty)
}

/// Checkpoint every [`CHECKPOINT`]; final summary on `AppExit`.
fn save_history(
    mut exit: MessageReader<AppExit>,
    m: Res<Metrics>,
    run: Res<RunInfo>,
    mut history: ResMut<MetricsHistory>,
    settings: Option<Res<crate::settings::CoreSettings>>,
    log: Option<Res<SessionLog>>,
    time: Res<Time<Real>>,
    mut next: Local<Option<Duration>>,
    mut done: Local<bool>,
) {
    let Some(dir) = history.dir.clone() else { return };
    if *done {
        return;
    }
    let quality = settings.map(|s| format!("{:?}", s.quality));
    if exit.read().count() > 0 {
        *done = true;
        let s = current(&m, &run, quality, "exit");
        if let Some(l) = &log {
            l.write("metrics.summary", serde_json::to_value(&s).unwrap_or(Value::Null));
        }
        append(&dir.join("sessions.jsonl"), &s);
        let _ = std::fs::remove_file(checkpoint_path(&dir));
        history.past.push(s);
        return;
    }
    let now = time.elapsed();
    let due = next.get_or_insert(CHECKPOINT);
    if now >= *due {
        *due = now + CHECKPOINT;
        let s = current(&m, &run, quality, "killed");
        let path = checkpoint_path(&dir);
        // Off the frame: the file write never shows up as a hitch.
        let _ = std::thread::Builder::new().name("metrics-save".into()).spawn(move || {
            if let Ok(text) = serde_json::to_string(&s) {
                let tmp = path.with_extension("tmp");
                if std::fs::write(&tmp, text).is_ok() {
                    let _ = std::fs::rename(tmp, path);
                }
            }
        });
    }
}

fn checkpoint_path(dir: &Path) -> PathBuf {
    dir.join(format!("unfinished-{}.json", std::process::id()))
}

/// Appends one summary line.
pub fn append(file: &Path, s: &SessionSummary) {
    let Ok(line) = serde_json::to_string(s) else { return };
    match std::fs::OpenOptions::new().create(true).append(true).open(file) {
        Ok(mut f) => {
            let _ = writeln!(f, "{line}");
        }
        Err(e) => warn!("metrics: {}: {e}", file.display()),
    }
}

/// Last `n` parseable summaries, oldest first.
pub fn load(file: &Path, n: usize) -> Vec<SessionSummary> {
    let Ok(text) = std::fs::read_to_string(file) else { return Vec::new() };
    let mut v: Vec<SessionSummary> = text.lines().rev().filter_map(|l| serde_json::from_str(l).ok()).take(n).collect();
    v.reverse();
    v
}

/// Keeps the newest [`KEEP`] lines once the file has more than twice that.
fn trim(file: &Path) {
    let Ok(text) = std::fs::read_to_string(file) else { return };
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() > 2 * KEEP {
        let kept = lines[lines.len() - KEEP..].join("\n") + "\n";
        let _ = std::fs::write(file, kept);
    }
}

/// Appends checkpoints left by runs that never exited (killed, crashed) and removes them.
/// A checkpoint younger than three periods may belong to a run still going; it is left alone.
fn adopt_unfinished(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let me = format!("unfinished-{}.json", std::process::id());
    for e in rd.flatten() {
        let p = e.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        if !name.starts_with("unfinished-") || !name.ends_with(".json") || name == me {
            continue;
        }
        let stale = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > CHECKPOINT * 3);
        if !stale {
            continue;
        }
        if let Some(s) = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<SessionSummary>(&t).ok()) {
            append(&dir.join("sessions.jsonl"), &s);
        }
        let _ = std::fs::remove_file(&p);
    }
}

// ---- control commands ----

fn dump(world: &mut World, p: Value) -> Result<Value, String> {
    let m = world.get_resource::<Metrics>().ok_or("metrics registry missing")?;
    let prefix = p.get("prefix").and_then(Value::as_str).unwrap_or("");
    let mut keys = serde_json::Map::new();
    for k in m.keys().filter(|k| k.starts_with(prefix)) {
        keys.insert(
            k.to_string(),
            json!({"now": m.latest(k), "recent": m.recent(k).map(|s| s.rounded()), "session": m.session(k).map(|s| s.rounded())}),
        );
    }
    let run = world.get_resource::<RunInfo>().map(|r| {
        let (commit, dirty) = r.git();
        json!({"id": r.id, "game": r.game, "commit": commit, "dirty": dirty, "profile": r.profile, "mode": r.mode})
    });
    let view = world.get_resource::<super::metrics_window::MetricsView>().map(|v| v.json());
    Ok(json!({
        "t": (m.now() * 1000.0).round() / 1000.0,
        "frames": m.frames(),
        "warmup_s": m.warmup,
        "labels": m.labels(),
        "run": run,
        "window": view,
        "keys": keys,
    }))
}

fn sessions(world: &mut World, p: Value) -> Result<Value, String> {
    let n = p.get("n").and_then(Value::as_u64).unwrap_or(10) as usize;
    let cur = match (world.get_resource::<Metrics>(), world.get_resource::<RunInfo>()) {
        (Some(m), Some(r)) => Some(current(m, r, quality(world), "running")),
        _ => None,
    };
    let h = world.get_resource::<MetricsHistory>().cloned().unwrap_or_default();
    let past: Vec<&SessionSummary> = h.past.iter().rev().take(n).collect();
    Ok(json!({"file": h.file().map(|f| f.display().to_string()), "current": cur, "past": past}))
}

fn label(world: &mut World, p: Value) -> Result<Value, String> {
    let key = p.get("key").and_then(Value::as_str).ok_or("missing `key`")?.to_string();
    let value = match p.get("value") {
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => return Err("missing `value`".into()),
    };
    let mut m = world.get_resource_mut::<Metrics>().ok_or("metrics registry missing")?;
    m.set_label(key.clone(), value.clone());
    Ok(json!({"labels": m.labels()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_info() -> RunInfo {
        RunInfo {
            id: "20261022T000000Z-1".into(),
            game: "t".into(),
            version: "0".into(),
            start_ts: 1,
            profile: "debug",
            mode: "headless",
            args: vec![],
            git: Arc::new(Mutex::new(Some((Some("abc1234".into()), Some(true))))),
        }
    }

    #[test]
    fn summary_roundtrip_through_the_file() {
        let dir = std::env::temp_dir().join(format!("engine-metrics-hist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sessions.jsonl");
        let mut m = Metrics::default();
        m.warmup = 0.0;
        m.set_label("map", "yard");
        for i in 0..100 {
            m.next_frame(i as f64 * 0.016);
            m.record("frame.ms", 10.0 + (i % 10) as f64);
        }
        m.next_frame(1.6);
        let s = current(&m, &run_info(), Some("High".into()), "exit");
        assert_eq!(s.commit_label(), "abc1234*");
        assert_eq!(s.keys["frame.ms"].n, 100);
        assert_eq!(s.keys["frame.ms"].max, 19.0);
        for _ in 0..3 {
            append(&file, &s);
        }
        std::fs::write(&file, std::fs::read_to_string(&file).unwrap() + "not json\n").unwrap();
        let back = load(&file, 2);
        assert_eq!(back.len(), 2, "bad lines are skipped, n is honoured");
        assert_eq!(back[1], s);
        assert!(back[0].comparable(&back[1]));
        let mut other = s.clone();
        other.mode = "windowed".into();
        assert!(!s.comparable(&other));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stale_checkpoints_are_adopted() {
        let dir = std::env::temp_dir().join(format!("engine-metrics-adopt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = SessionSummary { id: "old".into(), ended: "killed".into(), ..default() };
        let p = dir.join("unfinished-999999.json");
        std::fs::write(&p, serde_json::to_string(&s).unwrap()).unwrap();
        adopt_unfinished(&dir);
        assert!(p.exists(), "a fresh checkpoint may belong to a live run");
        let old = SystemTime::now() - CHECKPOINT * 4;
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(old).unwrap();
        adopt_unfinished(&dir);
        assert!(!p.exists());
        let back = load(&dir.join("sessions.jsonl"), 10);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].ended, "killed");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn trim_keeps_newest() {
        let dir = std::env::temp_dir().join(format!("engine-metrics-trim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s.jsonl");
        let text: String = (0..(2 * KEEP + 5)).map(|i| format!("{i}\n")).collect();
        std::fs::write(&file, text).unwrap();
        trim(&file);
        let back = std::fs::read_to_string(&file).unwrap();
        assert_eq!(back.lines().count(), KEEP);
        assert_eq!(back.lines().last(), Some(&*format!("{}", 2 * KEEP + 4)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deltas_know_which_way_is_better() {
        assert_eq!(delta("frame.ms", 9.0, 10.0).unwrap().1, 1);
        assert_eq!(delta("frame.ms", 11.0, 10.0).unwrap().1, -1);
        assert_eq!(delta("frame.ms", 10.1, 10.0).unwrap().1, 0, "noise");
        assert_eq!(delta("frame.fps", 70.0, 60.0).unwrap().1, 1);
        assert_eq!(delta("render.meshes_visible", 70.0, 60.0).unwrap().1, 0);
        assert!(delta("x", 1.0, 0.0).is_none());
    }

    #[test]
    fn git_probe_outside_a_repo() {
        assert_eq!(probe_git(Path::new("/")), (None, None));
    }
}
