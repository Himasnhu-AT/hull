use std::path::PathBuf;

use super::*;
use crate::paths::AssetsDir;

#[derive(Component, Reflect, Default)]
#[reflect(Component)]
struct Stats {
    hp: u32,
    name: String,
    on: bool,
}

fn temp_assets(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("logic-test-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(dir.join("scripts")).unwrap();
    dir
}

fn world(tag: &str) -> World {
    let mut w = World::new();
    w.init_resource::<AppTypeRegistry>();
    {
        let reg = w.resource::<AppTypeRegistry>();
        let mut reg = reg.write();
        reg.register::<Transform>();
        reg.register::<Stats>();
    }
    w.init_resource::<LogicGraphs>();
    w.init_resource::<LogicQueue>();
    w.init_resource::<LogicOutbox>();
    w.init_resource::<LogicDelays>();
    w.init_resource::<LogicDiagnostics>();
    w.init_resource::<LogicStats>();
    w.insert_resource(LogicCtx { me: Entity::PLACEHOLDER });
    w.insert_resource(AssetsDir(temp_assets(tag)));
    w.insert_non_send(ScriptHost::new());
    w
}

fn attach(w: &mut World, e: Entity, ron: &str) {
    let c = logic_core::Graph::from_ron(ron).unwrap().compile().unwrap();
    w.entity_mut(e).insert(LogicState {
        path: Arc::from("test.logic.ron"),
        graph: Some(Arc::new(c)),
        generation: 1,
        started: true,
        has_tick: false,
        actions: vec![],
        messages: vec![],
        timers: vec![],
    });
}

#[test]
fn reflect_paths_read_and_write() {
    let mut w = world("paths");
    let e = w.spawn((Transform::from_xyz(1.0, 2.0, 3.0), Stats { hp: 5, name: "a".into(), on: false })).id();
    assert_eq!(access::get_path(&w, e, "Transform.translation.y").unwrap(), Value::Num(2.0));
    assert_eq!(access::get_path(&w, e, "Transform.translation").unwrap(), Value::Vec3([1.0, 2.0, 3.0]));
    access::set_path(&mut w, e, "Transform.translation.y", &Value::Num(9.5)).unwrap();
    access::set_path(&mut w, e, "transform.translation", &Value::Vec3([0.0, 1.0, 2.0])).unwrap();
    assert_eq!(w.get::<Transform>(e).unwrap().translation, Vec3::new(0.0, 1.0, 2.0));
    // Whole numbers into integer fields, strings, bools.
    access::set_path(&mut w, e, "Stats.hp", &Value::Num(7.0)).unwrap();
    access::set_path(&mut w, e, "Stats.name", &Value::text("bob")).unwrap();
    access::set_path(&mut w, e, "Stats.on", &Value::Bool(true)).unwrap();
    let s = w.get::<Stats>(e).unwrap();
    assert_eq!((s.hp, s.name.as_str(), s.on), (7, "bob", true));
    // Errors are messages, not panics.
    assert!(access::get_path(&w, e, "Nope.x").unwrap_err().contains("no registered"));
    assert!(access::get_path(&w, e, "Transform.nothing").is_err());
    assert!(access::set_path(&mut w, e, "Stats.hp", &Value::text("x")).is_err());
    let other = w.spawn_empty().id();
    assert!(access::get_path(&w, other, "Transform.translation").unwrap_err().contains("has no"));
}

const SET_GRAPH: &str = r#"Graph(
    nodes: [
        (id: 1, kind: Start),
        (id: 2, kind: Set(path: "Transform.translation.y"), defaults: [("value", Num(4.0))]),
        (id: 3, kind: Get(path: "Stats.hp")),
        (id: 4, kind: Math(Add), defaults: [("b", Num(1.0))]),
        (id: 5, kind: Set(path: "Stats.hp")),
        (id: 6, kind: Set(path: "Missing.field"), defaults: [("value", Num(1.0))]),
    ],
    flow: [(from: (1, "then"), to: (2, "in")), (from: (2, "then"), to: (5, "in")), (from: (5, "then"), to: (6, "in"))],
    data: [(from: (3, "value"), to: (4, "a")), (from: (4, "result"), to: (5, "value"))],
)"#;

#[test]
fn start_event_edits_the_world_and_reports_errors() {
    let mut w = world("start");
    let e = w.spawn((Transform::default(), Stats { hp: 1, ..default() })).id();
    attach(&mut w, e, SET_GRAPH);
    let ran = run_fire(&mut w, Fire { entity: e, kind: EventKind::Start });
    assert_eq!(ran, 1);
    assert_eq!(w.get::<Transform>(e).unwrap().translation.y, 4.0);
    assert_eq!(w.get::<Stats>(e).unwrap().hp, 2);
    // Node 6 failed: a located diagnostic, no panic.
    let d = w.resource::<LogicDiagnostics>();
    assert_eq!(d.items.len(), 1);
    assert_eq!(d.items[0].node, Some(6));
    assert!(d.items[0].message.contains("Missing"), "{}", d.items[0]);
    // The same failure again bumps the count instead of listing it twice.
    run_fire(&mut w, Fire { entity: e, kind: EventKind::Start });
    assert_eq!(w.resource::<LogicDiagnostics>().items[0].count, 2);
}

#[test]
fn scripts_run_and_errors_are_located() {
    let mut w = world("script");
    let dir = w.resource::<AssetsDir>().0.clone();
    std::fs::write(
        dir.join("scripts/ok.ruspy"),
        "fn bump(n) {\n    v = get(\"Stats.hp\") + n;\n    set(\"Stats.hp\", v);\n    return v;\n}\nfn boom() {\n    x = 1;\n    return x / 0;\n}\nfn who() { return self(); }\n",
    )
    .unwrap();
    std::fs::write(dir.join("scripts/bad.ruspy"), "fn f() {\n    x = ;\n}\n").unwrap();
    let e = w.spawn(Stats { hp: 10, ..default() }).id();
    w.resource_mut::<LogicCtx>().me = e;

    assert_eq!(script::call(&mut w, "ok.ruspy", "bump", &[Value::Num(5.0)]).unwrap(), Value::Num(15.0));
    assert_eq!(w.get::<Stats>(e).unwrap().hp, 15);
    assert_eq!(script::call(&mut w, "ok.ruspy", "who", &[]).unwrap(), Value::Num(e.to_bits() as f64));

    // Runtime error: located in the script, Err for the caller, no panic.
    let err = script::call(&mut w, "ok.ruspy", "boom", &[]).unwrap_err();
    assert!(err.contains("ok.ruspy") || err.contains("scripts/ok.ruspy"), "{err}");
    let d = &w.resource::<LogicDiagnostics>().items;
    let rt = d.iter().find(|x| x.file == "scripts/ok.ruspy").expect("runtime diagnostic");
    assert_eq!(rt.line, 8, "{rt}");

    // Syntax error: line and column.
    assert!(script::call(&mut w, "bad.ruspy", "f", &[]).is_err());
    let syn = w.resource::<LogicDiagnostics>().items.iter().find(|x| x.file == "scripts/bad.ruspy").cloned().expect("syntax diagnostic");
    assert_eq!((syn.line, syn.severity), (2, Severity::Error), "{syn}");
    assert!(syn.col > 0);

    // Unknown function / file.
    assert!(script::call(&mut w, "ok.ruspy", "nope", &[]).unwrap_err().contains("no function"));
    assert!(script::call(&mut w, "missing.ruspy", "f", &[]).is_err());

    // Fixing the file on disk and polling clears its diagnostics.
    std::fs::write(dir.join("scripts/bad.ruspy"), "fn f() {\n    return 1;\n}\n").unwrap();
    script::reload_all(&mut w);
    assert!(w.resource::<LogicDiagnostics>().items.iter().all(|x| x.file != "scripts/bad.ruspy"));
    assert_eq!(script::call(&mut w, "bad.ruspy", "f", &[]).unwrap(), Value::Num(1.0));
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn script_loops_hit_the_step_limit() {
    let mut w = world("limit");
    let dir = w.resource::<AssetsDir>().0.clone();
    std::fs::write(dir.join("scripts/spin.ruspy"), "fn spin() { while true { } }\n").unwrap();
    let err = script::call(&mut w, "spin.ruspy", "spin", &[]).unwrap_err();
    assert!(err.contains("budget"), "{err}");
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn graph_script_command_and_message_nodes() {
    let mut w = world("nodes");
    let dir = w.resource::<AssetsDir>().0.clone();
    std::fs::write(dir.join("scripts/s.ruspy"), "fn twice(x) { emit(\"seen\", x); return x * 2; }\n").unwrap();
    let e = w.spawn(Stats::default()).id();
    attach(
        &mut w,
        e,
        r#"Graph(
        nodes: [
            (id: 1, kind: Start),
            (id: 2, kind: Script(file: "s.ruspy", function: "twice", args: ["x"]), defaults: [("x", Num(21.0))]),
            (id: 3, kind: Set(path: "Stats.hp")),
            (id: 4, kind: Command(id: "no.such.command", params: {})),
        ],
        flow: [(from: (1, "then"), to: (2, "in")), (from: (2, "then"), to: (3, "in")), (from: (3, "then"), to: (4, "in"))],
        data: [(from: (2, "result"), to: (3, "value"))],
    )"#,
    );
    run_fire(&mut w, Fire { entity: e, kind: EventKind::Start });
    assert_eq!(w.get::<Stats>(e).unwrap().hp, 42);
    assert_eq!(w.resource::<LogicOutbox>().0.len(), 1);
    assert_eq!(w.resource::<LogicOutbox>().0[0], ("seen".to_string(), Value::Num(21.0)));
    let d = w.resource::<LogicDiagnostics>();
    assert!(d.items.iter().any(|x| x.node == Some(4) && x.message.contains("no.such.command")), "{:?}", d.items);
    std::fs::remove_dir_all(dir).ok();
}
