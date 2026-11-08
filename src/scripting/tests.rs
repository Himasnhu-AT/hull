use std::path::PathBuf;

use super::*;
use crate::pause::Paused;

pub(crate) fn temp_assets(tag: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("scripting-test-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("scripts")).unwrap();
    for (name, src) in files {
        std::fs::write(dir.join("scripts").join(name), src).unwrap();
    }
    dir
}

/// A headless app with the scripting plugin and `files` under `scripts/`.
pub(crate) fn app(tag: &str, files: &[(&str, &str)]) -> App {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins);
    app.init_resource::<Paused>();
    app.insert_resource(AssetsDir(temp_assets(tag, files)));
    app.add_plugins(ScriptingPlugin);
    app
}

pub(crate) fn errors(app: &App) -> Vec<String> {
    app.world().resource::<LogicDiagnostics>().items.iter().map(|d| format!("{}:{}:{} {}", d.file, d.line, d.col, d.message)).collect()
}

pub(crate) fn logs(app: &App) -> Vec<String> {
    app.world().resource::<LogicDiagnostics>().log.iter().cloned().collect()
}

#[test]
fn members_are_per_instance_and_process_runs() {
    let mut app = app(
        "members",
        &[("counter.ruspy", "count = 0;\nstep = 1;\nfn _ready() { count = 100; }\nfn _process(dt) { count = count + step; }\n")],
    );
    let a = app.world_mut().spawn(Script::new("counter.ruspy")).id();
    let b = app.world_mut().spawn((Script::new("counter.ruspy"), ScriptProps::default().with("step", serde_json::json!(5)))).id();
    for _ in 0..3 {
        app.update();
    }
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    // Ready runs once, then _process on every update including the first.
    assert_eq!(get_member(app.world(), a, "count"), Some(Value::Num(103.0)));
    assert_eq!(get_member(app.world(), b, "count"), Some(Value::Num(115.0)));
}

#[test]
fn ready_runs_children_first_and_paths_resolve() {
    let src = "fn _ready() { log(get_name() + \" ready\"); }\nfn who() { return get_name(get_node(\"../Sib\")); }\n";
    let mut app = app("ready", &[("r.ruspy", src)]);
    let w = app.world_mut();
    let root = w.spawn((Name::new("Root"), Script::new("r.ruspy"))).id();
    let kid = w.spawn((Name::new("Kid"), Script::new("r.ruspy"), ChildOf(root))).id();
    w.spawn((Name::new("Sib"), ChildOf(root)));
    app.update();
    assert_eq!(logs(&app), vec!["Kid ready".to_string(), "Root ready".to_string()]);
    let r = call(app.world_mut(), kid, "who", &[]).unwrap();
    assert_eq!(r, Value::text("Sib"));
    assert_eq!(resolve_path(app.world(), kid, "/Root/Sib"), resolve_path(app.world(), root, "Sib"));
    assert_eq!(resolve_path(app.world(), kid, "%Sib"), resolve_path(app.world(), root, "Sib"));
}

#[test]
fn signals_connect_emit_and_one_shot() {
    let player = "signal(\"hit\");\nhp = 3;\nfn damage(n) { hp = hp - n; emit_signal(\"hit\", hp); }\n";
    let hud = "shown = -1;\nfn _on_hit(hp) { shown = hp; }\nfn once(hp) { log(\"once \" + tostr(hp)); }\n";
    let mut app = app("signals", &[("player.ruspy", player), ("hud.ruspy", hud)]);
    let w = app.world_mut();
    let root = w.spawn(Name::new("Game")).id();
    let hud_e = w.spawn((Name::new("HUD"), Script::new("hud.ruspy"), ChildOf(root))).id();
    let mut conns = Connections::default().to("hit", "../HUD", "_on_hit");
    conns.0.push(Connection { signal: "hit".into(), target: "../HUD".into(), method: "once".into(), one_shot: true, ..default() });
    let p = w.spawn((Name::new("Player"), Script::new("player.ruspy"), conns, ChildOf(root))).id();
    app.update();
    assert_eq!(declared_signals(app.world(), p), vec!["hit".to_string()]);
    call(app.world_mut(), p, "damage", &[Value::Num(1.0)]).unwrap();
    call(app.world_mut(), p, "damage", &[Value::Num(1.0)]).unwrap();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(get_member(app.world(), hud_e, "shown"), Some(Value::Num(1.0)));
    assert_eq!(logs(&app), vec!["once 2".to_string()]);
}

#[test]
fn queue_free_runs_exit_tree_at_frame_end() {
    let src = "fn _exit_tree() { log(\"bye \" + get_name()); }\nfn die() { queue_free(); log(\"still here\"); }\n";
    let mut app = app("free", &[("f.ruspy", src)]);
    let e = app.world_mut().spawn((Name::new("A"), Script::new("f.ruspy"))).id();
    let kid = app.world_mut().spawn((Name::new("B"), Script::new("f.ruspy"), ChildOf(e))).id();
    app.update();
    call(app.world_mut(), e, "die", &[]).unwrap();
    assert!(app.world().get_entity(e).is_ok());
    app.update();
    assert!(app.world().get_entity(e).is_err() && app.world().get_entity(kid).is_err());
    assert_eq!(logs(&app), vec!["still here".to_string(), "bye B".to_string(), "bye A".to_string()]);
}

#[test]
fn errors_are_located_and_hot_reload_keeps_members() {
    let mut app = app("reload", &[("h.ruspy", "n = 1;\nfn _process(dt) { n = n + 1; }\n")]);
    let e = app.world_mut().spawn(Script::new("h.ruspy")).id();
    app.update();
    app.update();
    assert_eq!(get_member(app.world(), e, "n"), Some(Value::Num(3.0)));
    let dir = app.world().resource::<AssetsDir>().0.clone();
    // A broken edit: reported with a line, the old instance keeps running.
    std::fs::write(dir.join("scripts/h.ruspy"), "n = 1;\nfn _process(dt) { n = ; }\n").unwrap();
    reload_all(app.world_mut());
    assert!(errors(&app).iter().any(|e| e.starts_with("scripts/h.ruspy:2:")), "{:?}", errors(&app));
    app.update();
    assert_eq!(get_member(app.world(), e, "n"), Some(Value::Num(4.0)));
    // A good edit: new code, member kept, new member initialised.
    std::fs::write(dir.join("scripts/h.ruspy"), "n = 1;\nk = 7;\nfn _process(dt) { n = n + 10; }\n").unwrap();
    reload_all(app.world_mut());
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    app.update();
    assert_eq!(get_member(app.world(), e, "n"), Some(Value::Num(14.0)));
    assert_eq!(get_member(app.world(), e, "k"), Some(Value::Num(7.0)));
}

#[test]
fn reentrant_and_cross_script_calls() {
    let a = "fn ping(other) { return call(other, \"pong\", 2) + 1; }\nfn loop_back(other) { return call(other, \"back\", self()); }\n";
    let b = "fn pong(x) { return x * 10; }\nfn back(caller) { return call(caller, \"ping\", self()); }\n";
    let mut app = app("calls", &[("a.ruspy", a), ("b.ruspy", b)]);
    let ea = app.world_mut().spawn(Script::new("a.ruspy")).id();
    let eb = app.world_mut().spawn(Script::new("b.ruspy")).id();
    app.update();
    let r = call(app.world_mut(), ea, "ping", &[Value::Entity(eb.to_bits())]).unwrap();
    assert_eq!(r, Value::Num(21.0));
    // a → b → a again: a is busy, so this is a clean error, not a panic.
    let err = call(app.world_mut(), ea, "loop_back", &[Value::Entity(eb.to_bits())]).unwrap_err();
    assert!(err.contains("already running"), "{err}");
}

#[test]
fn timers_emit_timeout() {
    let mut app = app("timer", &[("t.ruspy", "ticks = 0;\nfn _on_timeout() { ticks = ticks + 1; }\n")]);
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(std::time::Duration::from_millis(100)));
    let e = app.world_mut().spawn((Script::new("t.ruspy"), ScriptTimer { wait_time: 0.25, ..default() })).id();
    app.world_mut().entity_mut(e).insert(Connections::default().to("timeout", ".", "_on_timeout"));
    for _ in 0..7 {
        app.update();
    }
    let n = match get_member(app.world(), e, "ticks") {
        Some(Value::Num(n)) => n,
        other => panic!("{other:?}"),
    };
    assert!(n >= 2.0, "{n}");
}
