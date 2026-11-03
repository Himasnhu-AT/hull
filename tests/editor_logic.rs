//! The Logic editor's backend on the real headless engine: create and save a graph file
//! through `WorldBackend`, attach it with an undoable op, and watch the running entity react;
//! save a new version and see the entity run that one (hot reload); fire with a trace.
#![cfg(all(feature = "editor", feature = "logic"))]

use editor_proto::*;
use engine::devkit::Scenario;
use engine::editor::WorldBackend;
use engine::level::{LevelEntity, StableId};
use engine::prelude::*;

#[derive(Component, Reflect, Default)]
#[reflect(Component)]
struct Door {
    open: bool,
    n: f32,
}

const V1: &str = r#"Graph(
    vars: [(name: "hits", ty: Number, default: Num(0.0))],
    nodes: [
        (id: 1, kind: Start),
        (id: 2, kind: Set(path: "Door.open"), defaults: [("value", Bool(true))]),
        (id: 3, kind: Message("ping")),
        (id: 4, kind: SetVar("hits")),
        (id: 5, kind: GetVar("hits")),
        (id: 6, kind: Math(Add), defaults: [("b", Num(1.0))]),
        (id: 7, kind: Set(path: "Door.n")),
        (id: 8, kind: Delay(secs: 5.0)),
    ],
    flow: [
        (from: (1, "then"), to: (2, "in")),
        (from: (3, "then"), to: (4, "in")),
        (from: (4, "then"), to: (8, "in")),
        (from: (8, "then"), to: (7, "in")),
    ],
    data: [(from: (5, "value"), to: (6, "a")), (from: (6, "result"), to: (4, "value")), (from: (5, "value"), to: (7, "value"))],
)"#;

/// V2 counts in steps of 5, so a reload is visible in the numbers.
fn v2() -> String {
    V1.replace("defaults: [(\"b\", Num(1.0))]", "defaults: [(\"b\", Num(5.0))]")
}

#[test]
fn saved_graph_reloads_and_the_running_entity_reacts() {
    let assets = std::env::temp_dir().join(format!("engine-editor-logic-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&assets);
    std::fs::create_dir_all(assets.join("scripts")).unwrap();
    std::fs::write(assets.join("scripts/score.ruspy"), "fn on_open(who) {\n    return who;\n}\n").unwrap();
    let dir = assets.clone();
    let mut s = Scenario::new(GameInfo::new("elogic", "Editor logic")).options(move |o| o.assets_dir = Some(dir)).setup(|app| {
        app.register_type::<Door>();
    }).build();
    let e = s.world_mut().spawn((Door::default(), Name::new("Door"), LevelEntity { id: StableId(7) })).id();

    // Create + save through the backend.
    let path = WorldBackend::new(s.world_mut()).logic_create("door", "empty").unwrap();
    assert_eq!(path, "logic/door.logic.ron");
    for tpl in ["basic", "trigger_zone", "door", "pickup", "timer", "action_key", "event_start"] {
        let p = WorldBackend::new(s.world_mut()).logic_create(&format!("t_{tpl}"), tpl).unwrap();
        let g = engine::logic::logic_core::Graph::from_ron(&WorldBackend::new(s.world_mut()).logic_read(&p).unwrap()).unwrap();
        assert!(!g.nodes.is_empty() && g.compile().is_ok(), "{tpl}: {:?}", g.compile().err());
    }
    assert!(WorldBackend::new(s.world_mut()).logic_create("t_bogus", "nope").is_err());
    assert!(WorldBackend::new(s.world_mut()).logic_create("door", "empty").is_err(), "no overwrite");
    let errs = WorldBackend::new(s.world_mut()).logic_write(&path, V1).unwrap();
    assert!(errs.iter().all(|e| e.warning), "{errs:?}");
    let listed = WorldBackend::new(s.world_mut()).logic_list();
    assert!(listed.iter().any(|f| f.path == path && f.name == "door"));
    assert!(listed.iter().any(|f| f.path == "scripts/score.ruspy"));

    // Attach: a SetComponent op that undoes.
    let op = WorldBackend::new(s.world_mut()).logic_attach(e.to_bits(), &path).unwrap();
    assert!(s.world().get::<engine::logic::Logic>(e).is_some());
    assert_eq!(WorldBackend::new(s.world_mut()).logic_users(&path), vec![e.to_bits()]);
    s.wait_until(600, |w| w.get::<Door>(e).is_some_and(|d| d.open)).expect("Start ran: the door opened");

    // Fire with a trace: Message(ping) -> SetVar -> Delay (followed at once) -> Set Door.n.
    let t = WorldBackend::new(s.world_mut()).logic_fire(e.to_bits(), "message:ping").unwrap();
    assert_eq!(t.nodes, vec![3, 4, 8, 7], "{t:?}");
    assert_eq!(s.world().get::<Door>(e).unwrap().n, 1.0);
    let t = WorldBackend::new(s.world_mut()).logic_fire(e.to_bits(), "message:ping").unwrap();
    assert_eq!(t.nodes, vec![3, 4, 8, 7]);
    assert_eq!(s.world().get::<Door>(e).unwrap().n, 2.0, "variable persisted between runs");

    // Save a new version: the same running entity picks it up (steps of 5 now).
    let errs = WorldBackend::new(s.world_mut()).logic_write(&path, &v2()).unwrap();
    assert!(errs.iter().all(|e| e.warning), "{errs:?}");
    let mut reacted = false;
    for _ in 0..300 {
        s.step(2);
        let before = s.world().get::<Door>(e).unwrap().n;
        WorldBackend::new(s.world_mut()).logic_fire(e.to_bits(), "message:ping").unwrap();
        if s.world().get::<Door>(e).unwrap().n - before == 5.0 {
            reacted = true;
            break;
        }
    }
    assert!(reacted, "the entity runs the saved version");

    // A broken edit is reported, a bad file is refused, the old graph keeps running.
    let bad = V1.replace("Message(\"ping\")", "Message(\"ping\"), defaults: [(\"nope\", Num(1.0))]");
    let errs = WorldBackend::new(s.world_mut()).logic_write(&path, &bad).unwrap();
    assert!(errs.iter().any(|e| !e.warning && e.node == Some(3)), "{errs:?}");
    assert!(WorldBackend::new(s.world_mut()).logic_write(&path, "Graph(nodes: [").is_err());
    assert!(WorldBackend::new(s.world_mut()).logic_write("../evil.logic.ron", V1).is_err());

    // Undo the attach.
    WorldBackend::new(s.world_mut()).apply(&op.inverse()).unwrap();
    assert!(s.world().get::<engine::logic::Logic>(e).is_none());

    // The palette lists kinds, commands and script functions.
    let p = WorldBackend::new(s.world_mut()).logic_palette();
    assert!(p.nodes.iter().any(|n| n.kind_label == "Branch" && n.category == "Flow"));
    assert!(p.commands.iter().any(|c| c.name == "logic.fire"), "commands: {}", p.commands.len());
    assert!(p.commands.iter().all(|c| !c.name.starts_with("editor.")), "editor commands are hidden");
    assert!(p.nodes.iter().any(|n| n.category == "Commands" && n.kind_label == "Command logic.fire"));
    assert!(p.functions.contains(&"score.ruspy::on_open(who)".to_string()), "{:?}", p.functions);
    let _ = std::fs::remove_dir_all(&assets);
}
