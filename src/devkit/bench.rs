//! Bench reports: one JSON file per bench run, comparable across commits with
//! `scripts/bench.py compare`. Stats use the metrics history's shape (`{n, min, avg, p50, p95,
//! p99, max}` per key), so the same tooling reads both.
//!
//! ```ignore
//! #[test] #[ignore] // run with: python3 -I scripts/bench.py run
//! fn bench_city() {
//!     let mut s = Scenario::new(info()).plugin(CityPlugin).build();
//!     s.step(60);                       // warmup
//!     s.reset_frame_times();
//!     s.step(600);
//!     s.bench_report("city").write().unwrap();
//! }
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::perf_assert::Summary;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BenchReport {
    pub name: String,
    /// `git rev-parse --short HEAD` of the working dir (if any) and whether it was dirty.
    pub commit: Option<String>,
    pub dirty: Option<bool>,
    /// `debug` / `release` (from `debug_assertions`).
    pub profile: String,
    pub unix_time: u64,
    pub frames: usize,
    /// Per-key stats, e.g. `frame.ms`, `alloc.per_frame`.
    pub metrics: BTreeMap<String, Summary>,
    /// Single values, e.g. `ecs.entities`.
    pub values: BTreeMap<String, f64>,
}

impl BenchReport {
    pub fn new(name: impl Into<String>) -> Self {
        let (commit, dirty) = git_state(Path::new("."));
        BenchReport {
            name: name.into(),
            commit,
            dirty,
            profile: if cfg!(debug_assertions) { "debug" } else { "release" }.into(),
            unix_time: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()),
            ..Default::default()
        }
    }
    pub fn metric(mut self, key: &str, s: Summary) -> Self {
        self.metrics.insert(key.into(), s);
        self
    }
    pub fn value(mut self, key: &str, v: f64) -> Self {
        self.values.insert(key.into(), v);
        self
    }
    /// `$ENGINE_BENCH_DIR`, else `<tmp>/engine-bench`.
    pub fn default_dir() -> PathBuf {
        std::env::var_os("ENGINE_BENCH_DIR").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("engine-bench"))
    }
    /// Writes `<dir>/<name>.json` (atomically) and prints `bench: <path>`.
    pub fn write(&self) -> std::io::Result<PathBuf> {
        self.write_to(&Self::default_dir())
    }
    pub fn write_to(&self, dir: &Path) -> std::io::Result<PathBuf> {
        let path = dir.join(format!("{}.json", sanitize(&self.name)));
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        crate::paths::write_atomic(&path, &text)?;
        println!("bench: {}", path.display());
        Ok(path)
    }
}

fn sanitize(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

fn git_state(dir: &Path) -> (Option<String>, Option<bool>) {
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
    let commit = run(&["rev-parse", "--short", "HEAD"]);
    let dirty = commit.as_ref().and_then(|_| run(&["status", "--porcelain", "--untracked-files=no"])).map(|s| !s.is_empty());
    (commit, dirty)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_round_trip() {
        let dir = std::env::temp_dir().join(format!("engine-bench-unit-{}", std::process::id()));
        let r = BenchReport::new("unit/x").metric("frame.ms", Summary::of(&[1.0, 2.0, 3.0])).value("ecs.entities", 7.0);
        let p = r.write_to(&dir).unwrap();
        assert!(p.ends_with("unit_x.json"));
        let back: BenchReport = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(back.metrics["frame.ms"].p50, 2.0);
        assert_eq!(back.values["ecs.entities"], 7.0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
