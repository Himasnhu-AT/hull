use std::collections::HashMap;
use std::sync::Arc;

use crate::*;

#[derive(Default)]
struct Mock {
    world: HashMap<(u64, String), Value>,
    commands: Vec<(String, serde_json::Value)>,
    scripts: Vec<(String, String, Vec<Value>)>,
    emitted: Vec<(String, Value)>,
    logs: Vec<String>,
    scheduled: Vec<(u32, f32)>,
}

impl Host for Mock {
    fn get(&mut self, e: u64, p: &str) -> Result<Value, String> {
        self.world.get(&(e, p.to_string())).cloned().ok_or_else(|| format!("no {p}"))
    }
    fn set(&mut self, e: u64, p: &str, v: &Value) -> Result<(), String> {
        self.world.insert((e, p.to_string()), v.clone());
        Ok(())
    }
    fn command(&mut self, id: &str, params: &serde_json::Value) -> Result<serde_json::Value, String> {
        self.commands.push((id.into(), params.clone()));
        Ok(serde_json::json!({"ok": true}))
    }
    fn script(&mut self, f: &str, func: &str, args: &[Value]) -> Result<Value, String> {
        self.scripts.push((f.into(), func.into(), args.to_vec()));
        Ok(Value::Num(args.len() as f64 + 100.0))
    }
    fn emit(&mut self, n: &str, v: &Value) {
        self.emitted.push((n.into(), v.clone()));
    }
    fn log(&mut self, t: &str) {
        self.logs.push(t.into());
    }
    fn schedule(&mut self, node: u32, secs: f32, _: &Payload) {
        self.scheduled.push((node, secs));
    }
}

const DOOR: &str = r#"
Graph(
    name: "door",
    nodes: [
        (id: 1, kind: OverlapEnter),
        (id: 2, kind: Delay(secs: 0.5)),
        (id: 3, kind: Get(path: "Transform.translation.y")),
        (id: 4, kind: Math(Add), defaults: [("b", Num(3.0))]),
        (id: 5, kind: Set(path: "Transform.translation.y")),
        (id: 6, kind: Script(file: "score.ruspy", function: "on_open", args: ["who"])),
        (id: 7, kind: Log),
    ],
    flow: [
        (from: (1, "then"), to: (2, "in")),
        (from: (2, "then"), to: (5, "in")),
        (from: (5, "then"), to: (6, "in")),
        (from: (6, "then"), to: (7, "in")),
    ],
    data: [
        (from: (3, "value"), to: (4, "a")),
        (from: (4, "result"), to: (5, "value")),
        (from: (1, "other"), to: (6, "who")),
        (from: (6, "result"), to: (7, "text")),
    ],
)
"#;

fn compile(src: &str) -> Compiled {
    Graph::from_ron(src).unwrap().compile().unwrap_or_else(|e| panic!("{e:?}"))
}

#[test]
fn door_graph_runs_with_delay_resume() {
    let g = compile(DOOR);
    assert_eq!(g.events.len(), 1);
    let mut host = Mock::default();
    host.world.insert((7, "Transform.translation.y".into()), Value::Num(1.0));
    let mut r = Runner::new();
    let p = Payload { me: 7, other: Value::Entity(42), ..Default::default() };
    r.run(&g, Entry::Event(g.events[0].1), &p, &mut host).unwrap();
    assert_eq!(host.scheduled, vec![(1, 0.5)]);
    assert!(host.logs.is_empty());
    r.run(&g, Entry::Resume(1), &p, &mut host).unwrap();
    assert_eq!(host.world[&(7, "Transform.translation.y".into())], Value::Num(4.0));
    assert_eq!(host.scripts[0].2, vec![Value::Entity(42)]);
    assert_eq!(host.logs, vec!["101"]);
}

#[test]
fn ron_round_trip() {
    let g = Graph::from_ron(DOOR).unwrap();
    assert_eq!(Graph::from_ron(&g.to_ron()).unwrap(), g);
}

#[test]
fn ron_error_has_location() {
    let e = Graph::from_ron("Graph(\n  nodes: [ (id: 1, kind: Nope) ],\n)").unwrap_err();
    assert_eq!(e.line, 2);
}

#[test]
fn validation_errors_are_located() {
    let bad = |src: &str| Graph::from_ron(src).unwrap().compile().unwrap_err();
    // dangling node
    let e = bad("Graph(nodes: [(id: 1, kind: Start)], flow: [(from: (1, \"then\"), to: (9, \"in\"))])");
    assert_eq!(e[0].node, Some(9));
    // type mismatch: Vec3 into Number
    let e = bad(r#"Graph(nodes: [(id: 1, kind: Const(Vec3((0.0,0.0,0.0)))), (id: 2, kind: Math(Add), defaults: [("b", Num(1.0))])],
        data: [(from: (1, "value"), to: (2, "a"))])"#);
    assert!(e.iter().any(|x| x.node == Some(2) && x.pin.as_deref() == Some("a") && x.message.contains("type mismatch")), "{e:?}");
    // missing required input
    let e = bad("Graph(nodes: [(id: 1, kind: Start), (id: 2, kind: Branch)], flow: [(from: (1, \"then\"), to: (2, \"in\"))])");
    assert!(e.iter().any(|x| x.node == Some(2) && x.pin.as_deref() == Some("cond")));
    // cycle
    let e = bad(r#"Graph(nodes: [(id: 1, kind: Math(Add), defaults: [("b", Num(1.0))]), (id: 2, kind: Math(Add), defaults: [("b", Num(1.0))])],
        data: [(from: (1, "result"), to: (2, "a")), (from: (2, "result"), to: (1, "a"))])"#);
    assert!(e.iter().any(|x| x.message.contains("cycle")));
    // duplicate id, wrong pin name
    let e = bad("Graph(nodes: [(id: 1, kind: Start), (id: 1, kind: Tick)])");
    assert!(e.iter().any(|x| x.message.contains("duplicate")));
    let e = bad("Graph(nodes: [(id: 1, kind: Start), (id: 2, kind: Log)], flow: [(from: (1, \"nope\"), to: (2, \"in\"))])");
    assert!(e.iter().any(|x| x.pin.as_deref() == Some("nope")));
    // events can't be flow targets
    let e = bad("Graph(nodes: [(id: 1, kind: Start), (id: 2, kind: Tick)], flow: [(from: (1, \"then\"), to: (2, \"in\"))])");
    assert!(e.iter().any(|x| x.node == Some(2)));
}

#[test]
fn unreached_node_is_a_warning() {
    let g = compile("Graph(nodes: [(id: 1, kind: Start), (id: 2, kind: Log, defaults: [(\"text\", Str(\"x\"))])])");
    assert_eq!(g.warnings.len(), 1);
    assert_eq!(g.warnings[0].node, Some(2));
}

#[test]
fn branch_sequence_foreach() {
    let g = compile(
        r#"Graph(
        nodes: [
            (id: 1, kind: Start),
            (id: 2, kind: Sequence(n: 2)),
            (id: 3, kind: Const(Json([10, 20, 30]))),
            (id: 4, kind: ForEach),
            (id: 5, kind: Log),
            (id: 6, kind: Log, defaults: [("text", Str("done"))]),
            (id: 7, kind: Compare(Gt), defaults: [("b", Num(15.0))]),
            (id: 8, kind: Branch),
            (id: 9, kind: Emit("big")),
        ],
        flow: [
            (from: (1, "then"), to: (2, "in")),
            (from: (2, "0"), to: (4, "in")),
            (from: (4, "body"), to: (8, "in")),
            (from: (8, "true"), to: (9, "in")),
            (from: (4, "done"), to: (6, "in")),
            (from: (2, "1"), to: (5, "in")),
        ],
        data: [
            (from: (3, "value"), to: (4, "list")),
            (from: (4, "item"), to: (7, "a")),
            (from: (7, "result"), to: (8, "cond")),
            (from: (4, "item"), to: (9, "value")),
            (from: (4, "index"), to: (5, "text")),
        ],
    )"#,
    );
    let mut host = Mock::default();
    let mut r = Runner::new();
    r.run(&g, Entry::Event(g.index_of(1).unwrap()), &Payload::default(), &mut host).unwrap();
    assert_eq!(host.emitted.len(), 2); // 20 and 30 passed the compare
    assert_eq!(host.emitted[0].1, Value::Num(20.0));
    assert_eq!(host.logs, vec!["done", "2"]); // `index` keeps its last value after the loop
}

#[test]
fn command_params_substitute_pins() {
    let g = compile(
        r#"Graph(
        nodes: [
            (id: 1, kind: Start),
            (id: 2, kind: Command(id: "ecs.set", params: {"id": "$target", "value": {"hp": "$hp"}, "keep": "literal"}),
                defaults: [("hp", Num(5.0))]),
        ],
        flow: [(from: (1, "then"), to: (2, "in"))],
        data: [(from: (1, "self"), to: (2, "target"))],
    )"#,
    );
    let mut host = Mock::default();
    Runner::new().run(&g, Entry::Event(0), &Payload { me: 9, ..Default::default() }, &mut host).unwrap();
    assert_eq!(host.commands[0].1, serde_json::json!({"id": 9, "value": {"hp": 5.0}, "keep": "literal"}));
}

#[test]
fn infinite_flow_loop_hits_budget() {
    let g = compile(
        r#"Graph(
        nodes: [(id: 1, kind: Start), (id: 2, kind: Sequence(n: 1)), (id: 3, kind: Log, defaults: [("text", Str("x"))])],
        flow: [(from: (1, "then"), to: (2, "in")), (from: (2, "0"), to: (3, "in")), (from: (3, "then"), to: (2, "in"))],
    )"#,
    );
    let mut host = Mock::default();
    let mut r = Runner::new();
    r.budget = 500;
    let e = r.run(&g, Entry::Event(0), &Payload::default(), &mut host).unwrap_err();
    assert!(e.message.contains("budget"));
}

#[test]
fn division_by_zero_and_bad_types_are_errors() {
    let g = compile(
        r#"Graph(nodes: [(id: 1, kind: Start), (id: 2, kind: Math(Div), defaults: [("a", Num(1.0)), ("b", Num(0.0))]), (id: 3, kind: Log)],
        flow: [(from: (1, "then"), to: (3, "in"))], data: [(from: (2, "result"), to: (3, "text"))])"#,
    );
    let e = Runner::new().run(&g, Entry::Event(0), &Payload::default(), &mut Mock::default()).unwrap_err();
    assert_eq!(e.node, 2);
}

#[test]
fn vec3_nodes() {
    let g = compile(
        r#"Graph(nodes: [(id: 1, kind: Start), (id: 2, kind: Vec3Make, defaults: [("x", Num(1.0)), ("y", Num(2.0))]),
            (id: 3, kind: Vec3Scale, defaults: [("s", Num(2.0))]), (id: 4, kind: Vec3Split), (id: 5, kind: Log)],
        flow: [(from: (1, "then"), to: (5, "in"))],
        data: [(from: (2, "v"), to: (3, "v")), (from: (3, "v"), to: (4, "v")), (from: (4, "y"), to: (5, "text"))])"#,
    );
    let mut host = Mock::default();
    Runner::new().run(&g, Entry::Event(0), &Payload::default(), &mut host).unwrap();
    assert_eq!(host.logs, vec!["4"]);
}

#[test]
fn ten_node_graph_timing() {
    // Tick -> Branch(dt > 0) -> Set(y = Get(y) + dt*2) ... about 10 nodes.
    let g = compile(
        r#"Graph(nodes: [
            (id: 1, kind: Tick), (id: 2, kind: Compare(Gt), defaults: [("b", Num(0.0))]), (id: 3, kind: Branch),
            (id: 4, kind: Get(path: "Transform.translation.y")), (id: 5, kind: Math(Mul), defaults: [("b", Num(2.0))]),
            (id: 6, kind: Math(Add)), (id: 7, kind: Clamp, defaults: [("min", Num(0.0)), ("max", Num(100.0))]),
            (id: 8, kind: Set(path: "Transform.translation.y")), (id: 9, kind: Not), (id: 10, kind: Compare(Lt), defaults: [("b", Num(0.0))]),
        ],
        flow: [(from: (1, "then"), to: (3, "in")), (from: (3, "true"), to: (8, "in"))],
        data: [(from: (1, "dt"), to: (2, "a")), (from: (2, "result"), to: (3, "cond")),
               (from: (1, "dt"), to: (5, "a")), (from: (4, "value"), to: (6, "a")), (from: (5, "result"), to: (6, "b")),
               (from: (6, "result"), to: (7, "value")), (from: (7, "result"), to: (8, "value")),
               (from: (1, "dt"), to: (10, "a")), (from: (10, "result"), to: (9, "a"))])"#,
    );
    assert_eq!(g.nodes.len(), 10);
    let mut host = Mock::default();
    host.world.insert((1, "Transform.translation.y".into()), Value::Num(0.0));
    let mut r = Runner::new();
    let p = Payload { me: 1, dt: 0.016, ..Default::default() };
    for _ in 0..100 {
        r.run(&g, Entry::Event(0), &p, &mut host).unwrap();
    }
    let n = 100_000;
    let t = std::time::Instant::now();
    for _ in 0..n {
        r.run(&g, Entry::Event(0), &p, &mut host).unwrap();
    }
    let us = t.elapsed().as_secs_f64() * 1e6 / n as f64;
    println!("BENCH 10-node graph (incl. mock host map get/set): {us:.3} us/event, {} steps", r.steps);
    let _ = Arc::new(0);
}
