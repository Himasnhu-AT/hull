//! The control port end to end: launch `examples/devtools_probe` headless with `--control 0`,
//! drive it with engine commands, quit it.
#![cfg(feature = "devtools")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
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

/// `target/<profile>/examples/devtools_probe` (cargo test builds examples next to `deps/`).
fn probe_exe() -> PathBuf {
    let me = std::env::current_exe().expect("current exe");
    let profile_dir = me.parent().and_then(|deps| deps.parent()).expect("target/<profile>");
    profile_dir.join("examples").join(format!("devtools_probe{}", std::env::consts::EXE_SUFFIX))
}

fn launch() -> (Game, u16, PathBuf) {
    let data = std::env::temp_dir().join(format!("engine-devtools-test-{}", std::process::id()));
    let mut child = Command::new(probe_exe())
        .args(["--headless", "--control", "0", "--seed", "7"])
        .env_remove("DEVTOOLS_PROBE_TRACE_ENDPOINT")
        .env_remove("DEVTOOLS_PROBE_TRACE_KEY")
        .env("DEVTOOLS_PROBE_DATA_DIR", &data)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn devtools_probe (built by `cargo test`)");
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
    let line = rx.recv_timeout(Duration::from_secs(60)).expect("no `control:` line on stdout within 60 s");
    let field = |name: &str| {
        let rest = &line[line.find(name).expect(name) + name.len()..];
        if name == "key=" { rest.to_string() } else { rest.split_whitespace().next().unwrap_or("").to_string() }
    };
    let port = field("port=").parse().expect("port");
    let key = PathBuf::from(field("key="));
    assert!(key.starts_with(&data), "key file {} not in the data dir {}", key.display(), data.display());
    (game, port, key)
}

fn exec(c: &mut Client, command: &str, params: Value) -> Value {
    c.call("engine.execute", json!({"command": command, "params": params}))
        .unwrap_or_else(|e| panic!("{command}: {e}"))
}

fn wait_for(c: &mut Client, command: &str, secs: f32, f: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs_f32(secs);
    loop {
        let s = exec(c, command, json!({}));
        if f(&s) || Instant::now() > deadline {
            return s;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn drive_the_probe() {
    let (mut game, port, key_file) = launch();
    let mut c = Client::connect(port, key_file.parent().expect("key dir")).expect("connect");
    c.set_timeout(Duration::from_secs(30));

    // Every engine command is listed.
    let cmds = c.call("engine.commands", json!({})).expect("engine.commands");
    let ids: Vec<&str> = cmds.as_array().expect("array").iter().filter_map(|c| c["id"].as_str()).collect();
    for id in ["engine.state", "engine.quit", "time.step", "ui.setting", "settings.get", "input.key", "screenshot", "probe.state"] {
        assert!(ids.contains(&id), "{id} missing from {ids:?}");
    }

    // Boot → MainMenu by itself; engine.start → InGame.
    let s = wait_for(&mut c, "engine.state", 10.0, |s| s["state"] == "MainMenu");
    assert_eq!(s["state"], "MainMenu", "{s}");
    assert_eq!(s["headless"], true);
    assert_eq!(s["seed"], 7);
    exec(&mut c, "engine.start", json!({}));
    let s = wait_for(&mut c, "engine.state", 10.0, |s| s["state"] == "InGame");
    assert_eq!(s["state"], "InGame", "{s}");
    let p = wait_for(&mut c, "probe.state", 5.0, |p| p["ticks"].as_u64() > Some(0));
    assert!(p["ticks"].as_u64() > Some(0), "game ticks while unpaused: {p}");

    // Paused: nothing advances, then time.step runs exactly N game frames.
    exec(&mut c, "engine.pause", json!({}));
    let before = exec(&mut c, "probe.state", json!({}))["ticks"].as_u64().expect("ticks");
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(exec(&mut c, "probe.state", json!({}))["ticks"].as_u64(), Some(before), "paused game must not tick");
    let step = exec(&mut c, "time.step", json!({"frames": 10}));
    assert!(step["frame"].as_u64().is_some(), "{step}");
    let after = exec(&mut c, "probe.state", json!({}))["ticks"].as_u64().expect("ticks");
    assert_eq!(after, before + 10, "time.step 10 → +10 ticks");
    assert_eq!(exec(&mut c, "engine.state", json!({}))["paused"], true, "paused again after the step");

    // time.step needs a paused game.
    exec(&mut c, "engine.resume", json!({}));
    let err = c.call("engine.execute", json!({"command": "time.step", "params": {"frames": 1}}));
    assert!(err.is_err(), "time.step while running must fail");

    // Settings: set through the registry, read back, SaveSettings sent.
    let r = exec(&mut c, "ui.setting", json!({"key": "probe.volume", "value": 0.25}));
    assert_eq!(r["value"], 0.25, "{r}");
    exec(&mut c, "ui.setting", json!({"key": "probe.fancy", "value": 1}));
    let all = exec(&mut c, "settings.get", json!({}));
    assert_eq!(all["probe.volume"], 0.25, "{all}");
    assert_eq!(all["probe.fancy"], 1.0, "{all}");
    let p = wait_for(&mut c, "probe.state", 5.0, |p| p["saves"].as_u64() >= Some(2));
    assert!(p["saves"].as_u64() >= Some(2), "SaveSettings after each ui.setting: {p}");
    assert!(c.call("engine.execute", json!({"command": "ui.setting", "params": {"key": "nope", "value": 1}})).is_err());

    // Input injection reaches ButtonInput<KeyCode>.
    exec(&mut c, "input.key", json!({"key": "w", "action": "down"}));
    let p = wait_for(&mut c, "probe.state", 5.0, |p| p["keys"].as_array().is_some_and(|k| k.contains(&json!("KeyW"))));
    assert!(p["keys"].as_array().is_some_and(|k| k.contains(&json!("KeyW"))), "{p}");
    exec(&mut c, "input.key", json!({"key": "w", "action": "up"}));
    let p = wait_for(&mut c, "probe.state", 5.0, |p| p["keys"].as_array().is_some_and(|k| k.is_empty()));
    assert_eq!(p["keys"], json!([]), "{p}");

    // perf.stats answers headless; screenshot refuses headless.
    let perf = exec(&mut c, "perf.stats", json!({}));
    assert!(perf["entities"].as_u64().is_some(), "{perf}");
    assert!(c.call("engine.execute", json!({"command": "screenshot", "params": {}})).is_err());

    // Quit: the process exits cleanly by itself.
    exec(&mut c, "engine.quit", json!({}));
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(st) = game.0.try_wait().expect("wait") {
            break st;
        }
        assert!(Instant::now() < deadline, "probe did not quit within 10 s");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(status.success(), "exit status {status}");
}
