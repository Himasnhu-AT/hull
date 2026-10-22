//! Session log: `data_dir()/logs/session-<UTC timestamp>.jsonl`, one JSON object per line.
//!
//! - `{"t": 12.0, "ts": <unix ms>, "kind": "perf", ...}`: one per second from the perf sampler
//!   (frame, CPU + threads, RAM, GPU device/renderer/tiler/process/memory, machine top-N
//!   processes by CPU/RAM/GPU; see docs/PERF.md);
//! - `{"kind": "perf.report", "seconds", "metrics": {name: {min, avg, p95, max, n}}}`: on `perf.report`;
//! - `{"t": .., "ts": .., "kind": "event", "event": "match.start", ...}`: game events.
//!
//! Lines go over a channel to a background writer thread (the frame never touches the file).
//! Only the newest [`KEEP`] session files are kept.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use bevy::prelude::*;
use serde_json::{Map, Value};

/// Session files kept, including the current one.
pub const KEEP: usize = 20;

/// Handle to the session log. Cheap to clone; every method is non-blocking.
#[derive(Resource, Clone)]
pub struct SessionLog {
    tx: Sender<String>,
    start: Instant,
    pub path: PathBuf,
}

impl SessionLog {
    /// Opens a new session file under `dir` (rotating old ones) and starts the writer thread.
    pub fn start(dir: &Path) -> Option<Self> {
        std::fs::create_dir_all(dir).ok()?;
        rotate(dir, KEEP - 1);
        let path = dir.join(format!("session-{}.jsonl", utc_stamp(SystemTime::now())));
        let file = std::fs::File::create(&path).ok()?;
        let (tx, rx) = channel::<String>();
        std::thread::Builder::new().name("perf-log".into()).spawn(move || writer(file, rx)).ok()?;
        Some(Self { tx, start: Instant::now(), path })
    }

    /// Seconds since the session started.
    pub fn t(&self) -> f64 {
        self.start.elapsed().as_secs_f64()
    }

    /// Writes `{"t", "ts", "kind", ..fields}`. `fields` should be a JSON object.
    pub fn write(&self, kind: &str, fields: Value) {
        let mut m = Map::new();
        m.insert("t".into(), Value::from((self.t() * 1000.0).round() / 1000.0));
        let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        m.insert("ts".into(), Value::from(ts));
        m.insert("kind".into(), Value::from(kind));
        if let Value::Object(f) = fields {
            m.extend(f);
        }
        let _ = self.tx.send(Value::Object(m).to_string());
    }

    /// A game event line: `{"kind": "event", "event": name, ..fields}`.
    pub fn event(&self, name: &str, fields: Value) {
        let mut f = match fields {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        f.insert("event".into(), Value::from(name));
        self.write("event", Value::Object(f));
    }
}

fn writer(file: std::fs::File, rx: Receiver<String>) {
    let mut w = std::io::BufWriter::new(file);
    while let Ok(line) = rx.recv() {
        let _ = writeln!(w, "{line}");
        while let Ok(line) = rx.try_recv() {
            let _ = writeln!(w, "{line}");
        }
        let _ = w.flush();
    }
}

/// Deletes the oldest `session-*.jsonl` files so at most `keep` remain.
fn rotate(dir: &Path, keep: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("session-") && n.ends_with(".jsonl"))
        })
        .collect();
    files.sort(); // the UTC stamp sorts chronologically
    let excess = files.len().saturating_sub(keep);
    for p in &files[..excess] {
        let _ = std::fs::remove_file(p);
    }
}

/// `20261019T143005Z-<pid>` (UTC; pid keeps two runs in the same second apart).
fn utc_stamp(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z-{}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        std::process::id()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn stamp_is_utc_civil_date() {
        let t = UNIX_EPOCH + Duration::from_secs(1_792_401_351); // 2026-10-19 09:15:51 UTC
        assert!(utc_stamp(t).starts_with("20261019T091551Z-"));
    }

    #[test]
    fn rotate_keeps_newest() {
        let dir = std::env::temp_dir().join(format!("engine-rot-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..25 {
            std::fs::write(dir.join(format!("session-2026010{}T0000{i:02}Z-1.jsonl", i % 3)), "").unwrap();
        }
        std::fs::write(dir.join("other.txt"), "").unwrap();
        rotate(&dir, 19);
        let n = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(n, 20); // 19 sessions + other.txt
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
