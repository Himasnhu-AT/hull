//! Metrics over the control port: launch `examples/metrics_demo` headless with `--control 0`,
//! read `metrics.dump` / `metrics.sessions`, quit, and check the run landed in
//! `<data>/metrics/sessions.jsonl` and shows up as a past run in the next launch.
#![cfg(feature = "devtools")]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ashlar_control::Client;
use serde_json::{Value, json};

struct Game(Child);

impl Drop for Game {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn demo_exe() -> PathBuf {
    let me = std::env::current_exe().expect("current exe");
    let profile_dir = me.parent().and_then(|deps| deps.parent()).expect("target/<profile>");
    profile_dir.join("examples").join(format!("metrics_demo{}", std::env::consts::EXE_SUFFIX))
}

fn launch(data: &Path) -> (Game, Client) {
    let mut child = Command::new(demo_exe())
        .args(["--headless", "--control", "0", "--seed", "3"])
        .env_remove("METRICS_DEMO_TRACE_ENDPOINT")
        .env("METRICS_DEMO_DATA_DIR", data)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn metrics_demo (built by `cargo test`)");
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
    let line = rx.recv_timeout(Duration::from_secs(60)).expect("no `control:` line within 60 s");
    let field = |name: &str| {
        let rest = &line[line.find(name).expect(name) + name.len()..];
        if name == "key=" { rest.to_string() } else { rest.split_whitespace().next().unwrap_or("").to_string() }
    };
    let port: u16 = field("port=").parse().expect("port");
    let key = PathBuf::from(field("key="));
    let mut c = Client::connect(port, key.parent().expect("key dir")).expect("connect");
    c.set_timeout(Duration::from_secs(30));
    (game, c)
}

fn exec(c: &mut Client, command: &str, params: Value) -> Value {
    c.call("engine.execute", json!({"command": command, "params": params}))
        .unwrap_or_else(|e| panic!("{command}: {e}"))
}

fn wait_for(c: &mut Client, command: &str, params: Value, secs: f32, f: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs_f32(secs);
    loop {
        let s = exec(c, command, params.clone());
        if f(&s) || Instant::now() > deadline {
            return s;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn quit(mut game: Game, c: &mut Client) {
    exec(c, "engine.quit", json!({}));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(st) = game.0.try_wait().expect("wait") {
            assert!(st.success(), "exit status {st}");
            return;
        }
        assert!(Instant::now() < deadline, "demo did not quit within 10 s");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn metrics_dump_and_session_history() {
    let data = std::env::temp_dir().join(format!("engine-metrics-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);

    let (game, mut c) = launch(&data);
    let cmds = c.call("engine.commands", json!({})).expect("engine.commands");
    let ids: Vec<&str> = cmds.as_array().expect("array").iter().filter_map(|c| c["id"].as_str()).collect();
    for id in ["metrics.dump", "metrics.sessions", "metrics.label", "metrics.window", "metrics.screenshot"] {
        assert!(ids.contains(&id), "{id} missing from {ids:?}");
    }

    // Engine keys (frame, ECS, perf monitor) and the demo's render/game keys.
    let has = |d: &Value, k: &str| d["keys"][k]["now"].is_number();
    let d = wait_for(&mut c, "metrics.dump", json!({}), 15.0, |d| {
        ["frame.ms", "ecs.entities", "render.meshes_visible", "ai.think_ms", "frame.p95_ms"].iter().all(|k| has(d, k))
    });
    for k in ["frame.ms", "ecs.entities", "render.meshes_visible", "render.lod_far", "ai.think_ms", "enemies.alive", "frame.p95_ms"] {
        assert!(has(&d, k), "{k} missing: {d}");
    }
    assert_eq!(d["run"]["mode"], "headless", "{d}");
    assert_eq!(d["labels"]["scenario"], "demo");
    assert!(d["window"].is_null(), "no metrics view headless: {d}");
    let r = &d["keys"]["render.meshes_visible"]["recent"];
    assert!(r["min"].as_f64() <= r["max"].as_f64() && r["n"].as_u64() > Some(0), "{r}");

    // Prefix filter.
    let only = exec(&mut c, "metrics.dump", json!({"prefix": "render."}));
    assert!(only["keys"].as_object().expect("keys").keys().all(|k| k.starts_with("render.")), "{only}");

    // Label the run, then wait past the warm-up for session stats.
    exec(&mut c, "metrics.label", json!({"key": "map", "value": "yard"}));
    let s = wait_for(&mut c, "metrics.sessions", json!({}), 15.0, |s| s["current"]["keys"]["frame.ms"]["n"].as_u64() > Some(30));
    let cur = &s["current"];
    assert_eq!(cur["labels"]["map"], "yard", "{s}");
    assert_eq!(cur["ended"], "running");
    assert!(cur["keys"]["frame.ms"]["p95"].as_f64() >= cur["keys"]["frame.ms"]["p50"].as_f64(), "{cur}");
    assert_eq!(s["past"], json!([]), "first run has no history");

    // No view headless.
    assert!(c.call("engine.execute", json!({"command": "metrics.window", "params": {"on": true}})).is_err());
    assert!(c.call("engine.execute", json!({"command": "metrics.screenshot", "params": {}})).is_err());
    quit(game, &mut c);

    let file = data.join("metrics").join("sessions.jsonl");
    let text = std::fs::read_to_string(&file).expect("sessions.jsonl written on exit");
    let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).expect("json line")).collect();
    assert_eq!(lines.len(), 1, "{text}");
    assert_eq!(lines[0]["ended"], "exit");
    assert_eq!(lines[0]["labels"]["map"], "yard");
    assert!(lines[0]["keys"]["render.meshes_visible"]["avg"].as_f64() > Some(0.0), "{text}");

    // The next run sees it as a past run.
    let (game, mut c) = launch(&data);
    let s = exec(&mut c, "metrics.sessions", json!({"n": 5}));
    assert_eq!(s["past"].as_array().map(Vec::len), Some(1), "{s}");
    assert_eq!(s["past"][0]["id"], lines[0]["id"]);
    quit(game, &mut c);
    let _ = std::fs::remove_dir_all(&data);
}
