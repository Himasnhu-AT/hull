//! Host functions as callbacks (Godot Callables), `attach_script` props, `save_scene`.

use super::tests::{app, errors};
use super::*;

fn frames(app: &mut App, n: usize) {
    for _ in 0..n {
        app.update();
    }
}

fn tapp(tag: &str, files: &[(&str, &str)]) -> App {
    let mut app = app(tag, files);
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(std::time::Duration::from_millis(100)));
    app
}

#[test]
fn host_functions_work_as_signal_targets_callbacks_timers_and_groups() {
    let src = "signal(\"ping\");\nfn go(a, b, c, d) { connect(\"ping\", a, \"queue_free\"); connect(\"ping\", b, \"hide\"); emit_signal(\"ping\"); t = tween(); tween_callback(t, \"show\"); tween_interval(t, 0.1); add_to_group(c, \"g\"); call_group(\"g\", \"queue_free\"); call_deferred(d, \"hide\"); }\nt = 0;\n";
    let mut app = tapp("callable", &[("s.ruspy", src)]);
    let host = app.world_mut().spawn((Script::new("s.ruspy"), Visibility::Hidden)).id();
    let a = app.world_mut().spawn(Transform::default()).id();
    let b = app.world_mut().spawn((Transform::default(), Visibility::Visible)).id();
    let c = app.world_mut().spawn(Transform::default()).id();
    let d = app.world_mut().spawn((Transform::default(), Visibility::Visible)).id();
    app.update();
    let ids: Vec<Value> = [a, b, c, d].iter().map(|e| Value::Entity(e.to_bits())).collect();
    call(app.world_mut(), host, "go", &ids).unwrap();
    frames(&mut app, 3);
    let w = app.world();
    assert!(w.get_entity(a).is_err(), "queue_free via signal");
    assert_eq!(*w.get::<Visibility>(b).unwrap(), Visibility::Hidden, "hide via signal");
    assert!(w.get_entity(c).is_err(), "call_group host fallback");
    assert_eq!(*w.get::<Visibility>(d).unwrap(), Visibility::Hidden, "call_deferred host fallback");
    // tween_callback "show" ran on the host script node.
    assert_ne!(*w.get::<Visibility>(host).unwrap(), Visibility::Hidden);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
fn timer_and_tween_can_free_by_host_name() {
    let src = "fn go() { start_timer(0.2, \"queue_free\"); }\n";
    let mut app = tapp("callable2", &[("s.ruspy", src)]);
    let e = app.world_mut().spawn(Script::new("s.ruspy")).id();
    app.update();
    call(app.world_mut(), e, "go", &[]).unwrap();
    frames(&mut app, 5);
    assert!(app.world().get_entity(e).is_err());
}

#[test]
fn attach_script_applies_props_before_ready() {
    let spawner = "fn go() { n = spawn_node(\"M\"); attach_script(n, \"m.ruspy\", {\"hp\": 7, \"label\": \"x\"}); return n; }\n";
    let m = "hp = 1;\nlabel = \"\";\nseen = 0;\nfn _ready() { seen = hp; }\n";
    let mut app = tapp("attach_props", &[("s.ruspy", spawner), ("m.ruspy", m)]);
    let s = app.world_mut().spawn(Script::new("s.ruspy")).id();
    app.update();
    let Value::Entity(bits) = call(app.world_mut(), s, "go", &[]).unwrap() else { panic!() };
    let n = Entity::from_bits(bits);
    frames(&mut app, 2);
    assert_eq!(get_member(app.world(), n, "seen"), Some(Value::Num(7.0)));
    assert_eq!(get_member(app.world(), n, "label"), Some(Value::text("x")));
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[cfg(feature = "level")]
#[test]
fn save_scene_writes_a_subtree_that_instantiate_reads_back() {
    use crate::level::LevelPlugin;
    use bevy::world_serialization::WorldSerializationPlugin;

    let src = "fn make() { r = spawn_node(\"Crate\"); set_position(r, [1, 2, 3]); l = spawn_node(\"Lid\", r); set_position(l, [0, 1, 0]); save_scene(r, \"made.level.ron\"); return r; }\nfn load() { return instantiate(\"made.level.ron\"); }\n";
    let mut app = tapp("save_scene", &[("s.ruspy", src)]);
    app.add_plugins((AssetPlugin::default(), WorldSerializationPlugin))
        .register_type::<Name>()
        .register_type::<Transform>()
        .register_type::<Visibility>()
        .register_type::<ChildOf>()
        .add_plugins(LevelPlugin);
    app.finish();
    app.cleanup();
    let host = app.world_mut().spawn(Script::new("s.ruspy")).id();
    app.update();
    let Value::Entity(orig) = call(app.world_mut(), host, "make", &[]).unwrap() else { panic!() };
    let Value::Entity(copy) = call(app.world_mut(), host, "load", &[]).unwrap() else { panic!() };
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    let w = app.world_mut();
    let (orig, copy) = (Entity::from_bits(orig), Entity::from_bits(copy));
    assert_ne!(orig, copy);
    assert_eq!(w.get::<Name>(copy).unwrap().as_str(), "Crate");
    assert_eq!(w.get::<Transform>(copy).unwrap().translation, Vec3::new(1.0, 2.0, 3.0));
    let lid = tree::child_named(w, copy, "Lid").expect("child kept");
    assert_eq!(w.get::<Transform>(lid).unwrap().translation, Vec3::Y);
}
