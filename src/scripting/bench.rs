//! Headless benchmark (ignored by default):
//! `memgate -- cargo test -q --lib scripting::bench -- --ignored --nocapture`.

use std::time::Instant;

use super::tests::{app, errors};
use super::*;

const SRC: &str = "x = 0.0;\ny = 1;\nfn _process(dt) {\n    x = x + dt;\n    y = y + 1;\n    p = get_position();\n    set_position([p[0] + 0.001, p[1], p[2]]);\n}\n";

/// The same work in the GDScript-style syntax: handle members, vectors, a dict, string concat.
const SRC_NEW: &str = "x = 0.0;\ny = 1;\nstats = {\"n\": 0};\nfn _process(dt) {\n    x = x + dt;\n    y = y + 1;\n    stats[\"n\"] += 1;\n    self.position = self.position + vec3(0.001, 0, 0);\n    label = \"n=\" + y;\n}\n";

fn run(tag: &str, src: &str) {
    let mut app = app(tag, &[("bench.ruspy", src)]);
    for i in 0..1000 {
        app.world_mut().spawn((Name::new(format!("N{i}")), Script::new("bench.ruspy"), Transform::default()));
    }
    app.update(); // attach + _ready
    let (c0, u0) = {
        let s = app.world().resource::<ScriptStats>();
        (s.calls, s.call_us)
    };
    let t = Instant::now();
    for _ in 0..120 {
        app.update();
    }
    let total = t.elapsed().as_secs_f64() * 1e6;
    let s = app.world().resource::<ScriptStats>().clone();
    let calls = (s.calls - c0).max(1);
    println!(
        "BENCH {tag} 1000 scripts: {:.0} us/frame, {:.2} us/call (in-call {:.2} us), {} calls, instances {}",
        total / 120.0,
        total / calls as f64,
        (s.call_us - u0) / calls as f64,
        calls,
        s.instances
    );
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
#[ignore]
fn thousand_process_scripts() {
    run("flat", SRC);
}

/// The flat script forced onto the interpreter (an unused dict makes the VM decline it).
#[test]
#[ignore]
fn thousand_process_scripts_flat_interpreter() {
    run("flat-interp", &format!("unused = {{}};\n{SRC}"));
}

/// Cost of single constructs on top of an empty `_process`.
#[test]
#[ignore]
fn construct_costs() {
    let body = |b: &str| format!("x = 0.0;\nstats = {{\"n\": 0}};\nfn _process(dt) {{\n    {b}\n}}\n");
    for (tag, b) in [
        ("empty", "x = x + dt;"),
        ("dict-index", "stats[\"n\"] += 1;"),
        ("vec-math", "v = vec3(1, 2, 3) + vec3(0.001, 0, 0) * dt;"),
        ("str-concat", "l = \"n=\" + x;"),
        ("self.position get", "p = self.position;"),
        ("self.position set", "self.position = [1, 2, 3];"),
        ("get_position()", "p = get_position();"),
        ("self.x member", "self.x = self.x + dt;"),
    ] {
        run(tag, &body(b));
    }
}

#[test]
#[ignore]
fn thousand_process_scripts_new_syntax() {
    run("new", SRC_NEW);
}

/// `find(name)` over 10 000 named entities: the old full scan against the name index.
#[test]
#[ignore]
fn name_lookup_10k() {
    let mut app = app("bench_names", &[]);
    for i in 0..10_000 {
        app.world_mut().spawn(Name::new(format!("N{i}")));
    }
    let w = app.world();
    let scan = |name: &str| w.iter_entities().find(|e| e.get::<Name>().is_some_and(|n| n.as_str() == name)).map(|e| e.id());
    let t = Instant::now();
    for i in 0..200 {
        std::hint::black_box(scan(&format!("N{}", 9_000 + i)));
    }
    let scan_us = t.elapsed().as_secs_f64() * 1e6 / 200.0;
    let t = Instant::now();
    for i in 0..200 {
        std::hint::black_box(tree::find_named(w, &format!("N{}", 9_000 + i)));
    }
    let idx_us = t.elapsed().as_secs_f64() * 1e6 / 200.0;
    println!("BENCH find over 10000 names: scan {scan_us:.1} us/lookup, index {idx_us:.2} us/lookup");
}
