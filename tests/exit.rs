//! Windowed runs exit promptly: launch examples with a hidden (`--offscreen`) window and the
//! control port, take a screenshot, `engine.quit`, and require the process to be gone within a
//! few seconds, several times over. Guards the pipelined-rendering exit deadlock fixed in
//! `src/exit.rs` (before the fix 8 of 30 such runs hung).
//!
//! Needs a GPU and a window server (macOS desktop); the window stays hidden and the run is muted.
#![cfg(feature = "devtools")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ashlar_control::Client;
use serde_json::{Value, json};

/// Longest allowed time from `engine.quit` to process exit.
const EXIT_WITHIN: Duration = Duration::from_secs(10);
const RUNS: usize = 5;
static LAUNCHES: AtomicUsize = AtomicUsize::new(0);

struct Game(Child);

impl Drop for Game {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn example(name: &str) -> PathBuf {
    let me = std::env::current_exe().expect("current exe");
    let profile = me.parent().and_then(|d| d.parent()).expect("target/<profile>");
    profile.join("examples").join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
}

fn launch(name: &str, args: &[&str], data: &PathBuf) -> (Game, Client) {
    let id = name.to_ascii_uppercase();
    std::fs::create_dir_all(data).expect("data dir");
    let log = std::fs::File::create(data.join("game.log")).expect("game.log");
    let mut child = Command::new(example(name))
        .args(["--offscreen", "--mute", "--control", "0"])
        .args(args)
        .env_remove(format!("{id}_TRACE_ENDPOINT"))
        .env_remove(format!("{id}_TRACE_KEY"))
        .env(format!("{id}_DATA_DIR"), data)
        .stdout(Stdio::piped())
        .stderr(log)
        .spawn()
        .unwrap_or_else(|e| panic!("spawn {name} (built by `cargo test`): {e}"));
    let stdout = child.stdout.take().expect("stdout");
    let game = Game(child);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.starts_with("control:") {
                let _ = tx.send(line);
            }
        }
    });
    let line = rx.recv_timeout(Duration::from_secs(120)).expect("no `control:` line within 120 s");
    let port: u16 = line["control: port=".len()..].split_whitespace().next().and_then(|p| p.parse().ok()).expect("port");
    let key = PathBuf::from(&line[line.find("key=").expect("key=") + 4..]);
    let mut c = Client::connect(port, key.parent().expect("key dir")).expect("connect");
    c.set_timeout(Duration::from_secs(60));
    (game, c)
}

fn exec(c: &mut Client, command: &str, params: Value) -> Value {
    c.call("engine.execute", json!({"command": command, "params": params}))
        .unwrap_or_else(|e| panic!("{command}: {e}"))
}

/// Polls `engine.state` until the app is in `state` and past its first frames (shaders compile).
fn wait_ready(c: &mut Client, state: &str) {
    let t0 = Instant::now();
    loop {
        let s = exec(c, "engine.state", json!({}));
        if s["state"] == state && s["frame"].as_u64().unwrap_or(0) > 30 {
            return;
        }
        assert!(t0.elapsed() < Duration::from_secs(120), "never reached {state}: {s}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Screenshot (a frame in flight on the render thread), then quit and time the exit.
fn shot_then_quit(name: &str, args: &[&str], state: &str, before: &[(&str, Value)]) {
    for run in 0..RUNS {
        // Unique per launch: tests run in parallel and two of them launch the same example.
        let n = LAUNCHES.fetch_add(1, Ordering::Relaxed);
        let data = std::env::temp_dir().join(format!("engine-exit-{name}-{}-{n}", std::process::id()));
        let (mut game, mut c) = launch(name, args, &data);
        wait_ready(&mut c, state);
        for (cmd, p) in before {
            exec(&mut c, cmd, p.clone());
        }
        std::thread::sleep(Duration::from_millis(300));
        let shot = data.join("shot.png");
        exec(&mut c, "screenshot", json!({"path": shot}));
        // The reply comes when the frame is captured; the PNG is written just after.
        let t0 = Instant::now();
        while !shot.is_file() && t0.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(shot.is_file(), "{name} run {run}: no screenshot; log: {}", data.join("game.log").display());
        exec(&mut c, "engine.quit", json!({}));
        let t0 = Instant::now();
        let status = loop {
            if let Some(st) = game.0.try_wait().expect("wait") {
                break st;
            }
            assert!(
                t0.elapsed() < EXIT_WITHIN,
                "{name} {args:?} run {run}: still running {EXIT_WITHIN:?} after engine.quit; log: {}",
                data.join("game.log").display()
            );
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(status.success(), "{name} run {run}: exit status {status}");
        let _ = std::fs::remove_dir_all(&data);
    }
}

#[test]
fn ui_gallery_menu_exits() {
    // Main menu: reactive frame pacing.
    shot_then_quit("ui_gallery", &[], "MainMenu", &[]);
}

#[test]
fn ui_gallery_paused_exits() {
    shot_then_quit("ui_gallery", &["--play"], "InGame", &[("engine.pause", json!({}))]);
}

#[test]
fn metrics_demo_with_metrics_window_exits() {
    // Two windows (game + metrics), gameplay pacing.
    shot_then_quit("metrics_demo", &["--play", "--metrics-window"], "InGame", &[]);
}
