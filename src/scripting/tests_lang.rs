//! GDScript-style syntax: node handles (`node.position`, `node.hp -= 1`, `node.method()`),
//! `self.x`, and dictionaries.

use super::tests::{app, errors, logs};
use super::*;

fn num(app: &App, e: Entity, name: &str) -> f64 {
    match get_member(app.world(), e, name) {
        Some(Value::Num(n)) => n,
        other => panic!("{name}: {other:?}"),
    }
}

#[test]
fn node_properties_read_write_and_compound() {
    let src = "kid = null;\n\
        fn build() { kid = get_node(\"Kid\"); }\n\
        fn go() {\n\
            kid.position = [1, 2, 3];\n\
            kid.position = [kid.position[0] + 1, 2, 3];\n\
            kid.scale = [2, 2, 2];\n\
            kid.visible = false;\n\
            kid.name = \"Renamed\";\n\
            return [kid.position[0], kid.visible, kid.name, kid.parent == self];\n\
        }\n";
    let mut app = app("props", &[("p.ruspy", src)]);
    let w = app.world_mut();
    let root = w.spawn((Name::new("Root"), Script::new("p.ruspy"), Transform::default())).id();
    let kid = w.spawn((Name::new("Kid"), Transform::default(), Visibility::Visible, ChildOf(root))).id();
    app.update();
    call(app.world_mut(), root, "build", &[]).unwrap();
    let r = call(app.world_mut(), root, "go", &[]).unwrap();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(app.world().get::<Transform>(kid).unwrap().translation, Vec3::new(2.0, 2.0, 3.0));
    assert_eq!(app.world().get::<Transform>(kid).unwrap().scale, Vec3::splat(2.0));
    assert_eq!(*app.world().get::<Visibility>(kid).unwrap(), Visibility::Hidden);
    assert_eq!(app.world().get::<Name>(kid).unwrap().as_str(), "Renamed");
    assert_eq!(r.to_json().to_string(), "[2.0,false,\"Renamed\",true]");
}

#[test]
fn script_members_of_other_nodes_and_self() {
    let player = "hp = 10;\nfn damage(n) { self.hp -= n; return self.hp; }\nfn heal(n) { hp += n; }\n";
    let driver = "p = null;\n\
        fn find_p() { p = get_node(\"../Player\"); }\n\
        fn hit() { p.hp -= 1; p.hp = p.hp * 2; return p.hp; }\n\
        fn dmg() { return p.damage(3); }\n\
        fn heal() { p.heal(5); return p.hp; }\n\
        fn bad() { return p.nope; }\n\
        fn bad_method() { p.nothing_like_this(); }\n";
    let mut app = app("members2", &[("player.ruspy", player), ("driver.ruspy", driver)]);
    let w = app.world_mut();
    let root = w.spawn(Name::new("Root")).id();
    let pl = w.spawn((Name::new("Player"), Script::new("player.ruspy"), ChildOf(root))).id();
    let d = w.spawn((Name::new("Driver"), Script::new("driver.ruspy"), ChildOf(root))).id();
    app.update();
    call(app.world_mut(), d, "find_p", &[]).unwrap();
    assert_eq!(call(app.world_mut(), d, "hit", &[]).unwrap(), Value::Num(18.0));
    assert_eq!(num(&app, pl, "hp"), 18.0);
    // Own members through `self`, called from another script.
    assert_eq!(call(app.world_mut(), d, "dmg", &[]).unwrap(), Value::Num(15.0));
    assert_eq!(call(app.world_mut(), d, "heal", &[]).unwrap(), Value::Num(20.0));
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    let e = call(app.world_mut(), d, "bad", &[]).unwrap_err();
    assert!(e.contains("no member `nope`"), "{e}");
    let e = call(app.world_mut(), d, "bad_method", &[]).unwrap_err();
    assert!(e.contains("no method"), "{e}");
}

#[test]
fn methods_prepend_the_node_to_host_functions() {
    let kid = "fn _ready() { add_to_group(\"x\"); }\nfn ping(a) { return a + 1; }\n";
    let root = "k = null;\nseen = 0;\nfn on_sig(v) { seen = v; }\n\
        fn go() {\n\
            k = get_node(\"Kid\");\n\
            k.add_to_group(\"g\");\n\
            k.connect(\"s\", self, \"on_sig\");\n\
            k.emit_signal(\"s\", 7);\n\
            gc = self.get_node(\"Kid\") == k;\n\
            return [k.ping(4), k.is_in_group(\"g\"), gc, k.get_node(\"../Kid\") == k, k.get_path()];\n\
        }\n\
        fn kill() { k.queue_free(); }\n";
    let mut app = app("methods", &[("kid.ruspy", kid), ("root.ruspy", root)]);
    let w = app.world_mut();
    let r = w.spawn((Name::new("Root"), Script::new("root.ruspy"))).id();
    let k = w.spawn((Name::new("Kid"), Script::new("kid.ruspy"), ChildOf(r))).id();
    app.update();
    let out = call(app.world_mut(), r, "go", &[]).unwrap();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    // The target (Root) was running when the signal fired, so the handler is deferred.
    app.update();
    assert_eq!(num(&app, r, "seen"), 7.0);
    assert!(app.world().get::<Groups>(k).unwrap().0.contains(&"g".to_string()));
    assert!(out.to_json().to_string().starts_with("[5,true,true,true,"), "{out:?}");
    call(app.world_mut(), r, "kill", &[]).unwrap();
    app.update();
    assert!(app.world().get_entity(k).is_err());
}

#[test]
fn handles_print_compare_and_work_with_old_int_api() {
    let src = "fn go() { n = self; log(tostr(n)); log(is_null(n)); return [n == self(), is_valid(n)]; }\n\
               fn ints(i) { set_position(i, [4, 5, 6]); return get_position(i)[0]; }\n";
    let mut app = app("handles", &[("h.ruspy", src)]);
    let e = app.world_mut().spawn((Script::new("h.ruspy"), Transform::default())).id();
    app.update();
    let r = call(app.world_mut(), e, "go", &[]).unwrap();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(logs(&app), vec![format!("Node#{}", e.to_bits()), "false".to_string()]);
    assert_eq!(r.to_json().to_string(), "[true,true]");
    // A raw int entity id still works.
    let r = call(app.world_mut(), e, "ints", &[Value::Num(e.to_bits() as f64)]).unwrap();
    assert_eq!(r, Value::Num(4.0));
}

#[test]
fn dictionaries_round_trip_through_json() {
    let src = "cfg = {\"a\": 1, \"list\": [1, 2], \"sub\": {\"x\": 2.5}};\n\
               fn get_cfg() { return cfg; }\n\
               fn take(d) { cfg = d; return d.sub.x + len(d); }\n\
               fn keys() { return cfg.keys(); }\n";
    let mut app = app("dicts", &[("d.ruspy", src)]);
    let e = app.world_mut().spawn(Script::new("d.ruspy")).id();
    app.update();
    let r = call(app.world_mut(), e, "get_cfg", &[]).unwrap();
    assert_eq!(r.to_json(), serde_json::json!({"a": 1, "list": [1, 2], "sub": {"x": 2.5}}));
    let arg = Value::Json(std::sync::Arc::new(serde_json::json!({"sub": {"x": 3.5}, "b": true})));
    let r = call(app.world_mut(), e, "take", &[arg]).unwrap();
    assert_eq!(r, Value::Num(5.5), "{:?}", errors(&app));
    assert_eq!(call(app.world_mut(), e, "keys", &[]).unwrap().to_json(), serde_json::json!(["b", "sub"]));
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
fn vectors_work_with_the_host_api() {
    let src = "pos = vec3(0, 0, 0);\n\
        fn go() {\n\
            p = get_position();\n\
            p.x = 2; p += vec3(0, 1, 0);\n\
            set_position(p * 2);\n\
            set_scale([3, 3, 3]);\n\
            self.position = vec3(1, 1, 1) + self.position;\n\
            pos = self.position;\n\
            return [get_position().length() > 0, self.position.y, get_position()[0]];\n\
        }\n\
        fn ret() { return vec2(1.5, 2); }\n\
        fn takes(v, c) { return [v.x + v.z, c[1]]; }\n";
    let mut app = app("vecs", &[("v.ruspy", src)]);
    let e = app.world_mut().spawn((Script::new("v.ruspy"), Transform::default())).id();
    app.update();
    let r = call(app.world_mut(), e, "go", &[]).unwrap();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(app.world().get::<Transform>(e).unwrap().translation, Vec3::new(5.0, 3.0, 1.0));
    assert_eq!(r.to_json(), serde_json::json!([true, 3.0, 5.0]));
    assert_eq!(get_member(app.world(), e, "pos"), Some(Value::Vec3([5.0, 3.0, 1.0])));
    assert_eq!(call(app.world_mut(), e, "ret", &[]).unwrap().to_json(), serde_json::json!([1.5, 2.0]));
    // JSON arrays and Vec3 values coming in are usable as vectors / colors via indexing.
    let r = call(app.world_mut(), e, "takes", &[Value::Vec3([1.0, 2.0, 3.0]), Value::Json(std::sync::Arc::new(serde_json::json!([0.1, 0.5, 0.9])))]).unwrap();
    assert!(r.to_json().to_string().starts_with("[4"), "{r:?} {:?}", errors(&app));
}

#[test]
fn strings_const_enum_match_in_scripts() {
    let src = "const MAX = 3;\nenum Mode { A, B }\nmode = 0;\nlast = \"\";\n\
        fn go(x) {\n\
            match x { Mode.A => { mode = 1; } Mode.B | 5 => { mode = 2; } _ => { mode = 9; } }\n\
            last = fmt(\"{}:{}\", \"a b c\".split(\" \").len(), \"Hi\".upper());\n\
            return mode + MAX;\n\
        }\n";
    let mut app = app("lang2", &[("l.ruspy", src)]);
    let e = app.world_mut().spawn(Script::new("l.ruspy")).id();
    app.update();
    assert_eq!(call(app.world_mut(), e, "go", &[Value::Num(5.0)]).unwrap(), Value::Num(5.0), "{:?}", errors(&app));
    assert_eq!(get_member(app.world(), e, "last"), Some(Value::text("3:HI")));
    assert_eq!(call(app.world_mut(), e, "go", &[Value::Num(0.0)]).unwrap(), Value::Num(4.0));
}

#[test]
fn runtime_errors_carry_a_call_stack_across_scripts() {
    let a = "fn boom(x) {\n  return inner(x);\n}\nfn inner(x) {\n  return 1 / x;\n}\n";
    let b = "target = null;\nfn setup() { target = get_node(\"../A\"); }\nfn go() {\n  return relay();\n}\nfn relay() {\n  return target.boom(0);\n}\n";
    let mut app = app("trace", &[("a.ruspy", a), ("b.ruspy", b)]);
    let w = app.world_mut();
    let root = w.spawn(Name::new("Root")).id();
    w.spawn((Name::new("A"), Script::new("a.ruspy"), ChildOf(root)));
    let be = w.spawn((Name::new("B"), Script::new("b.ruspy"), ChildOf(root))).id();
    app.update();
    call(app.world_mut(), be, "setup", &[]).unwrap();
    let err = call(app.world_mut(), be, "go", &[]).unwrap_err();
    // B's frames, with A's frames inside the host error text.
    assert!(err.contains("at relay (scripts/b.ruspy:7:") && err.contains("at go (scripts/b.ruspy:4:"), "{err}");
    assert!(err.contains("at inner (scripts/a.ruspy:5:") && err.contains("at boom (scripts/a.ruspy:2:"), "{err}");
    let shown = errors(&app).join("\n");
    assert!(shown.contains("at inner") && shown.contains("at go"), "{shown}");
    let rt = app.world().non_send::<ScriptRuntime>();
    assert!(rt.last_errors.get(&be).is_some_and(|m| m.contains("at relay")));
}

#[test]
fn get_stack_and_print_stack() {
    let src = "fn outer() { return mid(); }\nfn mid() { print_stack(); return get_stack(); }\n";
    let mut app = app("stack", &[("s.ruspy", src)]);
    let e = app.world_mut().spawn(Script::new("s.ruspy")).id();
    app.update();
    let r = call(app.world_mut(), e, "outer", &[]).unwrap();
    let j = r.to_json();
    assert_eq!(j[0]["function"], "mid");
    assert_eq!(j[1]["function"], "outer");
    assert_eq!(j[1]["line"], 1);
    let l = logs(&app);
    assert!(l[0].starts_with("stack:\n  at mid (scripts/s.ruspy:2:") && l[0].contains("at outer"), "{l:?}");
}

#[test]
fn integer_division_warns_in_diagnostics_and_casts_work() {
    let src = "hp = 30;\nmax_hp = 100;\nfn pct() { return hp * 100 / max_hp; }\nfn bar() { return float(hp) / max_hp; }\nfn mix() { return [int(2.9), str(5) + \"x\", bool(0), idiv(7, 2)]; }\n";
    let mut app = app("idiv", &[("d.ruspy", src)]);
    let e = app.world_mut().spawn(Script::new("d.ruspy")).id();
    app.update();
    let w = super::tests::warnings(&app);
    assert_eq!(w.len(), 1, "{w:?}");
    assert!(w[0].contains("d.ruspy:3:") && w[0].contains("W0101") && w[0].contains("integer division"), "{w:?}");
    assert!(errors(&app).is_empty(), "warnings are not errors: {:?}", errors(&app));
    assert_eq!(call(app.world_mut(), e, "pct", &[]).unwrap(), Value::Num(30.0));
    assert_eq!(call(app.world_mut(), e, "bar", &[]).unwrap(), Value::Num(0.3));
    assert_eq!(call(app.world_mut(), e, "mix", &[]).unwrap().to_json(), serde_json::json!([2, "5x", false, 3]));
}
