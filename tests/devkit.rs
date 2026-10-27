//! Devkit end to end, headless and in-process: the scenario kit, inspector commands, input
//! record/replay, JSON hot reload, the save plugin, perf budgets (with the counting
//! allocator installed) and asset checks.
#![cfg(feature = "devkit")]

use std::path::Path;

use engine::devkit::content::{AssetCheckConfig, check_assets};
use engine::devkit::replay::{InputEvent, InputLog, InputRecorder};
use engine::devkit::save::{Playtime, SaveSlots};
use engine::devkit::testing::assert_json_snapshot_in;
use engine::devkit::{CountingAlloc, HotReloadConfig, Reloaded};
use engine::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

#[derive(Component, Reflect, Default, Clone, Debug)]
#[reflect(Component)]
struct Mover {
    speed: f32,
}

#[derive(Resource, Reflect, Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[reflect(Resource)]
#[serde(default)]
struct Progress {
    level: u32,
    coins: u32,
}

#[derive(Resource, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(default)]
struct Tuning {
    speed: f32,
    label: String,
}

/// W moves every `Mover` forward (−z) at its speed.
struct ToyGame;

impl Plugin for ToyGame {
    fn build(&self, app: &mut App) {
        app.register_type::<Mover>()
            .register_type::<Progress>()
            .init_resource::<Progress>()
            .add_systems(Startup, |mut c: Commands| {
                c.spawn((Name::new("player"), Mover { speed: 2.0 }, Transform::default()));
                c.spawn((Name::new("crate"), Transform::from_xyz(3.0, 0.0, 0.0)));
            })
            .add_systems(Update, movement.run_if(in_game));
    }
}

fn movement(keys: Res<ButtonInput<KeyCode>>, time: Res<Time>, mut q: Query<(&Mover, &mut Transform)>) {
    if keys.pressed(KeyCode::KeyW) {
        for (m, mut tf) in &mut q {
            tf.translation.z -= m.speed * time.delta_secs();
        }
    }
}

fn info() -> GameInfo {
    GameInfo::new("devkit-test", "Devkit Test")
}

fn scenario() -> Scenario {
    Scenario::new(info()).plugin(ToyGame).build()
}

fn player_z(w: &mut World) -> f32 {
    let mut q = w.query_filtered::<&Transform, With<Mover>>();
    q.single(w).map(|t| t.translation.z).unwrap_or(f32::NAN)
}

#[test]
fn fixed_timestep_input_and_wait() {
    let mut s = scenario();
    s.step(2);
    assert_eq!(*s.res::<State<AppState>>().get(), AppState::InGame);
    assert_eq!(player_z(s.world_mut()), 0.0);

    // 60 Hz fixed steps: 1 s of W at speed 2 → z = -2 exactly-ish, whatever the wall clock.
    s.press(KeyCode::KeyW);
    s.run_secs(1.0);
    s.release(KeyCode::KeyW);
    s.step(1);
    let z = player_z(s.world_mut());
    assert!((z + 2.0).abs() < 0.05, "z after 1 s = {z}");

    // wait_until: met → frames taken; never → Timeout.
    s.press(KeyCode::KeyW);
    let took = s.wait_until(120, |w| player_z(w) < -3.0).expect("moves on");
    assert!((25..=35).contains(&took), "took {took} frames for 1 m at 2 m/s");
    s.release(KeyCode::KeyW);
    assert!(s.wait_until(10, |_| false).is_err());
    assert_eq!(s.count::<With<Name>>(), 2);
    assert_eq!(s.single::<Mover>().speed, 2.0);
}

#[test]
fn record_then_replay_is_deterministic() {
    // Scripted run, recorded through the live recorder.
    let script = InputLog::new().hold(KeyCode::KeyW, 5, 30).hold(KeyCode::KeyW, 60, 12).at(70, InputEvent::Motion { dx: 4.0, dy: 0.0 });
    let mut a = scenario();
    a.step(1);
    let f = a.frames() as u32;
    a.world_mut().resource_mut::<InputRecorder>().start(f, None);
    a.play_all(script.clone(), 5);
    let f = a.frames() as u32;
    let recorded = a.world_mut().resource_mut::<InputRecorder>().stop(f);
    let za = player_z(a.world_mut());
    assert!(za < -0.5, "the script moved the player: {za}");
    let keys: Vec<_> = recorded.events.iter().filter(|e| matches!(e.event, InputEvent::Key { .. })).collect();
    assert_eq!(keys.len(), 4, "{recorded:?}");
    assert_eq!(recorded.events.iter().filter(|e| matches!(e.event, InputEvent::Motion { .. })).count(), 1);

    // JSON round trip, replay in a fresh app → same end state.
    let log = InputLog::from_json(&recorded.to_json()).unwrap();
    let mut b = scenario();
    b.step(1);
    b.play_all(log, 5);
    let zb = player_z(b.world_mut());
    assert_eq!(za, zb, "replay reproduces the run");
}

#[cfg(feature = "devtools")]
#[test]
fn inspector_commands_in_process() {
    let mut s = scenario();
    s.step(2);
    let all = s.call("ecs.query", json!({"components": ["Transform"], "with": ["Name"]})).unwrap();
    assert_eq!(all["count"], 2, "{all}");
    let player = s.call("ecs.query", json!({"components": ["Mover", "Transform"], "name": "play"})).unwrap();
    assert_eq!(player["count"], 1, "{player}");
    let p = &player["entities"][0];
    assert_eq!(p["name"], "player");
    assert_eq!(p["components"]["Mover"]["speed"], 2.0);
    assert_eq!(p["components"]["Transform"]["translation"], json!([0.0, 0.0, 0.0]));
    let id = p["id"].clone();

    // Merge patch: only translation changes.
    let v = s.call("ecs.set", json!({"id": id, "component": "Transform", "value": {"translation": [1.0, 2.0, 3.0]}})).unwrap();
    assert_eq!(v["value"]["scale"], json!([1.0, 1.0, 1.0]));
    let tf = s.query::<(&Mover, &Transform), _>(|mut it| it.next().map(|(_, t)| *t)).unwrap();
    assert_eq!(tf.translation, Vec3::new(1.0, 2.0, 3.0));
    s.call("ecs.set", json!({"id": p["entity"], "component": "Mover", "value": {"speed": 7.5}})).unwrap();
    assert_eq!(s.single::<Mover>().speed, 7.5, "string ids (12v0) work too");

    let got = s.call("ecs.get", json!({"id": id})).unwrap();
    assert!(got["components"]["Name"].is_string(), "{got}");
    assert!(got["components"]["Transform"].is_object());

    // Spawn / despawn.
    let new = s.call("ecs.spawn", json!({"components": {"Name": "spawned", "Mover": {"speed": 1.0}, "Transform": {"translation": [0.0, 5.0, 0.0], "rotation": [0.0, 0.0, 0.0, 1.0], "scale": [1.0, 1.0, 1.0]}}})).unwrap();
    assert_eq!(s.count::<With<Mover>>(), 2);
    assert!(s.call("ecs.spawn", json!({"components": {"NoSuchType": {}}})).is_err());
    assert_eq!(s.count::<With<Mover>>(), 2, "failed spawn leaves nothing behind");
    s.call("ecs.despawn", json!({"id": new["id"]})).unwrap();
    assert_eq!(s.count::<With<Mover>>(), 1);
    assert!(s.call("ecs.despawn", json!({"id": new["id"]})).is_err());
    s.call("ecs.remove", json!({"id": id, "component": "Mover"})).unwrap();
    assert_eq!(s.count::<With<Mover>>(), 0);

    // Resources.
    let r = s.call("ecs.res.set", json!({"name": "Progress", "value": {"coins": 42}})).unwrap();
    assert_eq!(r["value"], json!({"level": 0, "coins": 42}));
    assert_eq!(s.res::<Progress>().coins, 42);
    assert_eq!(s.call("ecs.res.get", json!({"name": "Progress"})).unwrap()["value"]["coins"], 42);
    let list = s.call("ecs.res.list", json!({})).unwrap();
    assert!(list["resources"].as_array().unwrap().iter().any(|n| n.as_str().unwrap().ends_with("Progress")), "{list}");

    // Types and systems.
    let types = s.call("ecs.types", json!({"filter": "mover"})).unwrap();
    assert_eq!(types["count"], 1, "{types}");
    let sys = s.call("ecs.systems", json!({"schedule": "Update"})).unwrap();
    let count = sys["schedules"][0]["count"].as_u64().unwrap();
    assert!(count >= 1, "{sys}");
    if sys["names"] == true {
        let named = s.call("ecs.systems", json!({"schedule": "Update", "filter": "movement"})).unwrap();
        assert_eq!(named["schedules"][0]["systems"].as_array().unwrap().len(), 1, "{named}");
    } else {
        assert!(sys["note"].is_string());
    }
    assert!(s.call("ecs.get", json!({"id": "nope"})).is_err());
    assert!(s.call("ecs.query", json!({"components": ["Nope"]})).is_err());

    // Snapshot of reflected state (kit helper), written to a temp folder.
    let snap_dir = s.data_dir().join("snapshots");
    let v = s.resource_json::<Progress>().unwrap();
    assert_json_snapshot_in(&snap_dir, "progress", &v);
    assert_json_snapshot_in(&snap_dir, "progress", &v); // equal → passes
    let changed = std::panic::catch_unwind(|| assert_json_snapshot_in(&snap_dir, "progress", &json!({"coins": 1})));
    assert!(changed.is_err(), "changed snapshot fails");
    assert!(snap_dir.join("progress.new.json").is_file());
}

#[test]
fn hot_reload_json_resource() {
    let mut s = Scenario::new(info())
        .plugin(ToyGame)
        .setup(|app| {
            app.insert_resource(HotReloadConfig { enabled: true, interval_secs: 0.0 })
                .init_resource::<Tuning>()
                .hot_reload_json::<Tuning>(WatchPath::data("tuning.json"), Some("/game"));
        })
        .build();
    let file = s.data_dir().join("tuning.json");
    s.step(2);
    assert_eq!(*s.res::<Tuning>(), Tuning::default(), "no file: untouched");

    std::fs::write(&file, r#"{"game": {"speed": 3.5, "label": "a"}}"#).unwrap();
    s.step(2);
    assert_eq!(s.res::<Tuning>().speed, 3.5);

    // Bad JSON keeps the old value and reports the error.
    std::fs::write(&file, r#"{"game": {"speed": "#).unwrap();
    s.step(1);
    assert_eq!(s.res::<Tuning>().speed, 3.5);
    let errs = s.world_mut().resource_mut::<Messages<Reloaded>>().drain().filter(|r| r.result.is_err()).count();
    assert!(errs >= 1, "a Reloaded error was sent");

    std::fs::write(&file, r#"{"game": {"speed": 9.0, "label": "longer label"}}"#).unwrap();
    s.step(2);
    assert_eq!(*s.res::<Tuning>(), Tuning { speed: 9.0, label: "longer label".into() });
    #[cfg(feature = "devtools")]
    {
        let r = s.call("devkit.reload", json!({"force": true})).unwrap();
        assert_eq!(r["watches"][0]["last"]["ok"], true, "{r}");
        assert_eq!(r["changed"], 0, "same value → not re-applied");
    }
}

#[test]
fn save_plugin_slots_autosave_and_migration() {
    let dir = std::env::temp_dir().join(format!("engine-devkit-save-{}-{}", std::process::id(), rand::random::<u32>()));
    // A v1 save written by an "older build": {lvl, gold}.
    engine::devkit::SaveStore::new(dir.join("saves"), 1)
        .write("old", &json!({"lvl": 3, "gold": 11}), default())
        .unwrap();

    let mut s = Scenario::new(info())
        .plugin(ToyGame)
        .data_dir(&dir)
        .plugin(
            SavePlugin::<Progress>::new(SaveConfig { version: 2, autosave_secs: Some(1.0), ..default() }).migration(1, |v| {
                Ok(json!({"level": v["lvl"], "coins": v["gold"]}))
            }),
        )
        .build();
    s.step(2);
    s.res_mut::<Progress>().coins = 5;
    s.world_mut().write_message(SaveRequest::save("slot1"));
    s.step(1);
    let store = &s.res::<SaveSlots>().0;
    let l = store.read::<Progress>("slot1").expect("saved");
    assert_eq!(l.data.coins, 5);
    assert!(l.meta.playtime_secs > 0.0);
    assert_eq!(l.meta.game_version, env!("CARGO_PKG_VERSION"));
    assert!(l.meta.thumbnail.is_none(), "headless: no thumbnail");

    // Change, then load slot1 back.
    s.res_mut::<Progress>().coins = 99;
    s.world_mut().write_message(SaveRequest::load("slot1"));
    s.step(1);
    assert_eq!(s.res::<Progress>().coins, 5);

    // The v1 file migrates on load.
    s.world_mut().write_message(SaveRequest::load("old"));
    s.step(1);
    assert_eq!(*s.res::<Progress>(), Progress { level: 3, coins: 11 });

    // Autosave after 1 s of play time.
    s.run_secs(1.2);
    assert!(s.res::<SaveSlots>().0.exists("autosave"), "autosaved");
    assert!(s.res::<Playtime>().0 > 1.0);

    #[cfg(feature = "devtools")]
    {
        let list = s.call("save.list", json!({})).unwrap();
        let slots: Vec<&str> = list["slots"].as_array().unwrap().iter().map(|x| x["slot"].as_str().unwrap()).collect();
        for want in ["slot1", "old", "autosave"] {
            assert!(slots.contains(&want), "{want} in {slots:?}");
        }
        s.call("save.write", json!({"slot": "cmd", "label": "from the port"})).unwrap();
        s.step(1);
        assert_eq!(s.res::<SaveSlots>().0.read::<Progress>("cmd").unwrap().meta.label, "from the port");
        assert!(s.call("save.write", json!({"slot": "../evil"})).is_err());
        assert!(s.call("save.load", json!({"slot": "missing"})).is_err());
        s.call("save.delete", json!({"slot": "cmd"})).unwrap();
        assert!(!s.res::<SaveSlots>().0.exists("cmd"));
    }
    drop(s);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn perf_budget_with_counting_allocator() {
    let mut s = scenario();
    s.step(30); // warmup
    s.reset_frame_times();
    s.press(KeyCode::KeyW);
    s.step(300);
    let r = s.assert_budget(&PerfBudget { p95_frame_ms: Some(50.0), max_entities: Some(500), p95_allocs_per_frame: Some(5_000.0), ..default() });
    let a = r.allocs_per_frame.expect("CountingAlloc is installed in this test binary");
    println!(
        "headless engine frame: p50 {:.3} ms p95 {:.3} ms max {:.3} ms; allocs/frame p50 {} p95 {}; entities {}",
        r.frame_ms.p50, r.frame_ms.p95, r.frame_ms.max, a.p50, a.p95, r.entities
    );
    // A failing budget lists what broke.
    let bad = s.check_budget(&PerfBudget { p95_frame_ms: Some(0.0), max_entities: Some(0), ..default() });
    assert_eq!(bad.violations.len(), 2, "{:?}", bad.violations);

    // Bench JSON.
    let dir = s.data_dir().join("bench");
    let p = s.bench_report("toy").write_to(&dir).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    assert_eq!(v["frames"], 300);
    assert!(v["metrics"]["frame.ms"]["p95"].as_f64().is_some());
    assert!(v["metrics"]["alloc.per_frame"]["p50"].as_f64().is_some());
}

/// `python3 -I scripts/bench.py run` runs this (ignored by default).
#[test]
#[ignore]
fn bench_headless_toy() {
    let mut s = scenario();
    s.step(60);
    s.reset_frame_times();
    s.press(KeyCode::KeyW);
    s.step(1200);
    s.bench_report("headless_toy").write().unwrap();
}

fn png_header(w: u32, h: u32) -> Vec<u8> {
    let mut v = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    v.extend_from_slice(&w.to_be_bytes());
    v.extend_from_slice(&h.to_be_bytes());
    v.extend_from_slice(&[8, 6, 0, 0, 0]);
    v
}

#[test]
fn asset_check_finds_problems() {
    let root = std::env::temp_dir().join(format!("engine-devkit-assets-{}-{}", std::process::id(), rand::random::<u32>()));
    let assets = root.join("assets");
    let src = root.join("src");
    std::fs::create_dir_all(assets.join("textures")).unwrap();
    std::fs::create_dir_all(&src).unwrap();
    let w = |p: &Path, b: &[u8]| std::fs::write(p, b).unwrap();
    w(&assets.join("textures/ok.png"), &png_header(512, 512));
    w(&assets.join("textures/npot.png"), &png_header(300, 200));
    w(&assets.join("textures/huge.png"), &png_header(8192, 8192));
    w(&assets.join("textures/broken.png"), b"not a png");
    w(&assets.join("unused.ogg"), b"OggS");
    w(
        &assets.join("scene.gltf"),
        br#"{"images":[{"uri":"textures/ok.png"},{"uri":"textures/gone.png"}],"buffers":[{"uri":"data:application/octet-stream;base64,AA=="}]}"#,
    );
    w(&src.join("game.rs"), b"fn x() { load(\"textures/ok.png\"); load(\"textures/npot.png\"); load(\"textures/huge.png\");\n load(\"scene.gltf#Scene0\"); load(\"sounds/missing.ogg\"); }");

    let r = check_assets(&assets, &AssetCheckConfig { sources: vec![src.clone()], ..default() });
    let kinds = |k: &str| r.issues.iter().filter(|i| i.kind == k).map(|i| i.path.as_str()).collect::<Vec<_>>();
    assert_eq!(kinds("oversized"), vec!["textures/huge.png"]);
    assert_eq!(kinds("npot"), vec!["textures/npot.png"]);
    assert_eq!(kinds("unreadable"), vec!["textures/broken.png"]);
    let mut missing = kinds("missing_ref");
    missing.sort();
    assert_eq!(missing, vec!["sounds/missing.ogg", "textures/gone.png"]);
    assert!(kinds("unreferenced").contains(&"unused.ogg"));
    assert!(kinds("no_mips").contains(&"textures/ok.png"));
    assert!(!r.ok());
    assert_eq!(r.errors, 4, "{:#?}", r.issues);
    let at = r.issues.iter().find(|i| i.path == "sounds/missing.ogg").and_then(|i| i.at.clone()).unwrap();
    assert!(at.ends_with("game.rs:2"), "{at}");
    let _ = std::fs::remove_dir_all(root);
}

/// Cost numbers for docs/DEVKIT.md: `cargo test --test devkit bench_devkit -- --ignored --nocapture`.
/// Also writes the `devkit_costs` bench report.
#[cfg(feature = "devtools")]
#[test]
#[ignore]
fn bench_devkit_costs() {
    use std::time::Instant;
    // profile_scope! enter + exit.
    let n = 1_000_000;
    let t = Instant::now();
    for _ in 0..n {
        engine::profile_scope!("measure.scope");
        std::hint::black_box(());
    }
    let scope_ns = t.elapsed().as_nanos() as f64 / f64::from(n);
    println!("profile_scope!: {scope_ns:.1} ns per scope");
    let mut rep = engine::devkit::BenchReport::new("devkit_costs").value("profile_scope.ns", scope_ns);

    let mut s = Scenario::new(info())
        .plugin(ToyGame)
        .setup(|app| {
            app.add_systems(Startup, |mut c: Commands| {
                c.spawn_batch((0..10_000).map(|i| (Mover { speed: 1.0 }, Transform::from_xyz(i as f32, 0.0, 0.0))));
            });
        })
        .build();
    s.step(10);
    let t = Instant::now();
    let r = s.call("ecs.query", json!({"components": ["Transform", "Mover"], "limit": 10000})).unwrap();
    let ms = t.elapsed().as_secs_f64() * 1e3;
    println!("ecs.query 10k entities x 2 components -> JSON: {ms:.2} ms (count {})", r["count"]);
    rep = rep.value("ecs_query.10k_full.ms", ms);
    let t = Instant::now();
    let r = s.call("ecs.query", json!({"components": ["Mover"], "limit": 10})).unwrap();
    let ms = t.elapsed().as_secs_f64() * 1e3;
    println!("ecs.query 10k matched, 10 returned: {ms:.3} ms ({})", r["returned"]);
    rep = rep.value("ecs_query.10k_limit10.ms", ms);

    // Save write + read of a big resource.
    let dir = s.data_dir().join("measure-saves");
    let store = engine::devkit::SaveStore::new(&dir, 1);
    let big: Vec<Progress> = (0..10_000).map(|i| Progress { level: i, coins: i * 3 }).collect();
    let t = Instant::now();
    let saved = store.write("big", &big, default()).unwrap();
    let w = t.elapsed();
    let t = Instant::now();
    let back = store.read::<Vec<Progress>>("big").unwrap();
    let read = t.elapsed();
    println!(
        "save 10k records ({} KB): write {:.2} ms, read+verify {:.2} ms ({} back)",
        saved.bytes / 1024,
        w.as_secs_f64() * 1e3,
        read.as_secs_f64() * 1e3,
        back.data.len()
    );
    rep = rep.value("save.10k.write_ms", w.as_secs_f64() * 1e3).value("save.10k.read_ms", read.as_secs_f64() * 1e3);

    // Hot reload poll: one stat per watched file.
    let f = s.data_dir().join("poll.json");
    std::fs::write(&f, "{}").unwrap();
    let t = Instant::now();
    for _ in 0..10_000 {
        std::hint::black_box(std::fs::metadata(&f).ok());
    }
    let poll_us = t.elapsed().as_secs_f64() * 1e6 / 10_000.0;
    println!("hot reload poll: {poll_us:.2} µs per watched file");
    rep.value("hot_reload_poll.us", poll_us).write().unwrap();
}
