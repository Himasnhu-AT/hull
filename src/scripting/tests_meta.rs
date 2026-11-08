//! Export hints, `extends` / `class_name` / `super_call`, the API catalogue.

use super::meta::ExportHint;
use super::tests::{app, errors};
use super::*;

fn num(app: &App, e: Entity, name: &str) -> f64 {
    match get_member(app.world(), e, name) {
        Some(Value::Num(x)) => x,
        o => panic!("{name}: {o:?}"),
    }
}

#[test]
fn script_props_carry_hints_defaults_and_hide_private_vars() {
    let src = "// @export_range(0, 10, 0.5)\n// @tooltip Speed\nspeed = 5;\n// @export_enum(\"easy\",\"hard\")\nmode = \"easy\";\n_secret = 1;\nfn f() { return speed; }\n";
    let mut app = app("meta_props", &[("p.ruspy", src)]);
    let p = script_props(app.world_mut(), "p.ruspy").unwrap();
    assert_eq!(p.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["speed", "mode"]);
    assert_eq!(p[0].hint, ExportHint::Range { min: 0.0, max: 10.0, step: 0.5 });
    assert_eq!((p[0].tooltip.as_str(), p[0].default.as_str(), p[1].default.as_str()), ("Speed", "5", "\"easy\""));
    assert!(matches!(p[1].hint, ExportHint::Enum { .. }));
}

const BASE: &str = "// class_name Mob\nhp = 3;\nfn hit(n) { hp = hp - n; return hp; }\nfn name_of() { return \"mob\"; }\nfn who() { return name_of(); }\n";
const MID: &str = "// extends base.ruspy\n// class_name Orc\nhp = 10;\nfn name_of() { return \"orc\"; }\n";
const LEAF: &str = "// extends mid.ruspy\nfn hit(n) { return super_call(\"hit\", n * 2) + 100; }\n";

#[test]
fn extends_inherits_overrides_and_super_calls() {
    let mut app = app("meta_ext", &[("base.ruspy", BASE), ("mid.ruspy", MID), ("leaf.ruspy", LEAF)]);
    let m = app.world_mut().spawn(Script::new("mid.ruspy")).id();
    let l = app.world_mut().spawn(Script::new("leaf.ruspy")).id();
    app.update();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    // Derived top level runs after the base's: hp = 10 wins.
    assert_eq!(num(&app, m, "hp"), 10.0);
    // The base's `who` dispatches to the override.
    assert_eq!(call(app.world_mut(), m, "who", &[]).unwrap(), Value::text("orc"));
    // Leaf: hit(2) -> super hit(4) -> hp 6 -> + 100.
    assert_eq!(call(app.world_mut(), l, "hit", &[Value::Num(2.0)]).unwrap(), Value::Num(106.0));
    assert!(has_method(app.world(), l, "who"));
    assert!(is_class(app.world(), l, "Orc") && is_class(app.world(), l, "Mob") && !is_class(app.world(), l, "Cat"));
    assert!(is_class(app.world(), m, "base.ruspy"));
}

#[test]
fn class_name_resolves_in_attach_script() {
    let spawner = "fn go() { n = spawn_node(\"M\"); attach_script(n, \"Mob\"); return n; }\n";
    let mut app = app("meta_cls", &[("base.ruspy", BASE), ("s.ruspy", spawner)]);
    let s = app.world_mut().spawn(Script::new("s.ruspy")).id();
    app.update();
    let Value::Entity(bits) = call(app.world_mut(), s, "go", &[]).unwrap() else { panic!() };
    let n = Entity::from_bits(bits);
    app.update();
    assert_eq!(app.world().get::<Script>(n).unwrap().path, "scripts/base.ruspy");
    assert_eq!(num(&app, n, "hp"), 3.0);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
fn a_missing_base_is_a_load_error() {
    let mut app = app("meta_missing", &[("d.ruspy", "// extends nope.ruspy\nx = 1;\n")]);
    app.world_mut().spawn(Script::new("d.ruspy"));
    app.update();
    assert!(errors(&app).iter().any(|e| e.contains("nope.ruspy")), "{:?}", errors(&app));
}

#[test]
fn every_registered_host_function_is_in_the_catalogue_and_the_docs() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/scripting");
    let docs = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("docs/SCRIPTING.md")).unwrap();
    let cat = api_catalogue();
    let mut registered = vec!["log".to_string(), "print".to_string()];
    for f in std::fs::read_dir(&dir).unwrap().flatten() {
        let name = f.file_name().to_string_lossy().to_string();
        if name.starts_with("tests") || name == "bench.rs" || !name.ends_with(".rs") {
            continue;
        }
        let text = std::fs::read_to_string(f.path()).unwrap();
        for part in text.split(".register(\"").skip(1) {
            registered.push(part.split('"').next().unwrap().to_string());
        }
    }
    for r in &registered {
        assert!(cat.iter().any(|c| c.name == r), "host function `{r}` has no catalogue entry (src/scripting/catalogue.rs)");
    }
    let mut seen = std::collections::HashSet::new();
    for c in &cat {
        assert!(seen.insert(c.name), "duplicate catalogue entry {}", c.name);
        assert!(registered.iter().any(|r| r == c.name), "catalogue entry `{}` is not registered", c.name);
        assert!(!c.doc.is_empty() && c.sig.starts_with(c.name));
        let mentioned = docs.contains(&format!("{}(", c.name)) || docs.contains(&format!("`{}`", c.name)) || docs.contains(c.name);
        assert!(mentioned, "docs/SCRIPTING.md never mentions `{}`", c.name);
    }
}
