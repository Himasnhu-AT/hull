//! Host function tests: transform, tree, groups, time, math, input, render, instantiate.

use super::tests::{app, errors, logs};
use super::*;

fn as_ent(v: Value) -> Entity {
    match v {
        Value::Num(n) => Entity::from_bits(n as u64),
        Value::Entity(b) => Entity::from_bits(b),
        o => panic!("not an entity: {o:?}"),
    }
}

fn num(app: &App, e: Entity, name: &str) -> f64 {
    match get_member(app.world(), e, name) {
        Some(Value::Num(n)) => n,
        other => panic!("{name}: {other:?}"),
    }
}

#[test]
fn transform_functions() {
    let src = "fn go() { set_position([1, 2, 3]); translate([1, 0, 0]); set_scale([2, 2, 2]); rotate_y(1.5); }\n\
               fn other(n) { set_position(n, [9, 9, 9]); }\n\
               fn look() { look_at([0, 0, -5]); }\n\
               r = 0;\nfn rot() { set_rotation([0.1, 0.2, 0.3]); v = get_rotation(); r = v[0] + v[1] + v[2]; }\n";
    let mut app = app("transform", &[("t.ruspy", src)]);
    let e = app.world_mut().spawn((Script::new("t.ruspy"), Transform::default())).id();
    let o = app.world_mut().spawn(Transform::default()).id();
    app.update();
    call(app.world_mut(), e, "go", &[]).unwrap();
    call(app.world_mut(), e, "other", &[Value::Entity(o.to_bits())]).unwrap();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    let t = app.world().get::<Transform>(e).unwrap();
    assert_eq!(t.translation, Vec3::new(2.0, 2.0, 3.0));
    assert_eq!(t.scale, Vec3::splat(2.0));
    assert!((t.rotation.to_euler(EulerRot::XYZ).1 - 1.5).abs() < 1e-4);
    assert_eq!(app.world().get::<Transform>(o).unwrap().translation, Vec3::splat(9.0));
    call(app.world_mut(), e, "rot", &[]).unwrap();
    assert!((num(&app, e, "r") - 0.6).abs() < 1e-4);
    app.world_mut().get_mut::<Transform>(e).unwrap().translation = Vec3::ZERO;
    call(app.world_mut(), e, "look", &[]).unwrap();
    let fwd = Vec3::from(app.world().get::<Transform>(e).unwrap().forward());
    assert!((fwd - Vec3::NEG_Z).length() < 1e-4, "{fwd:?}");
    // Errors are readable, not panics.
    let err = call(app.world_mut(), e, "other", &[Value::Num(1.0)]).unwrap_err();
    assert!(err.contains("entity"), "{err}");
}

#[test]
fn tree_functions() {
    let src = "kid = 0;\nfn build() { p = spawn_node(\"P\"); kid = spawn_node(\"K\", p); set_name(kid, \"Kid\"); return p; }\n\
               fn move(p, q) { reparent(p, q); }\n\
               fn cyc(p, k) { add_child(k, p); }\n\
               fn att(n) { attach_script(n, \"t.ruspy\"); }\n\
               fn vis() { set_visible(false); }\n";
    let mut app = app("tree", &[("t.ruspy", src)]);
    let e = app.world_mut().spawn((Script::new("t.ruspy"), Visibility::Visible)).id();
    app.update();
    let p = as_ent(call(app.world_mut(), e, "build", &[]).unwrap());
    let kid = as_ent(get_member(app.world(), e, "kid").unwrap());
    let w = app.world();
    assert_eq!(w.get::<Name>(kid).unwrap().as_str(), "Kid");
    assert_eq!(w.get::<ChildOf>(kid).unwrap().parent(), p);
    assert!(w.get::<Visibility>(p).is_some() && w.get::<Transform>(p).is_some());
    // reparent to null makes a root; add_child under a descendant is rejected.
    call(app.world_mut(), e, "move", &[Value::Entity(kid.to_bits()), Value::Null]).unwrap();
    assert!(app.world().get::<ChildOf>(kid).is_none());
    call(app.world_mut(), e, "move", &[Value::Entity(kid.to_bits()), Value::Entity(p.to_bits())]).unwrap();
    let err = call(app.world_mut(), e, "cyc", &[Value::Entity(p.to_bits()), Value::Entity(kid.to_bits())]).unwrap_err();
    assert!(err.contains("descendant"), "{err}");
    call(app.world_mut(), e, "att", &[Value::Entity(p.to_bits())]).unwrap();
    assert_eq!(app.world().get::<Script>(p).unwrap().path, "t.ruspy");
    call(app.world_mut(), e, "vis", &[]).unwrap();
    assert_eq!(*app.world().get::<Visibility>(e).unwrap(), Visibility::Hidden);
}

#[test]
fn groups_and_call_group() {
    let src = "hits = 0;\nfn _ready() { add_to_group(\"enemies\"); }\nfn hit(n) { hits = hits + n; }\n";
    let plain = "fn nothing() { }\n";
    let drv = "fn run() { add_to_group(\"enemies\"); return call_group(\"enemies\", \"hit\", 2); }\n\
               fn count() { return len(get_nodes_in_group(\"enemies\")); }\n\
               fn first() { return get_first_node_in_group(\"nobody\"); }\n\
               fn ing(n) { return is_in_group(n, \"enemies\"); }\n\
               fn rm(n) { remove_from_group(n, \"enemies\"); }\n";
    let mut app = app("groups", &[("e.ruspy", src), ("p.ruspy", plain), ("d.ruspy", drv)]);
    let a = app.world_mut().spawn(Script::new("e.ruspy")).id();
    let b = app.world_mut().spawn(Script::new("e.ruspy")).id();
    let c = app.world_mut().spawn(Script::new("p.ruspy")).id();
    c_in_group(&mut app, c);
    let d = app.world_mut().spawn(Script::new("d.ruspy")).id();
    app.update();
    // Driver is not a member yet: 2 members have `hit`, the plain one is skipped.
    assert_eq!(call(app.world_mut(), d, "count", &[]).unwrap(), Value::Num(3.0));
    assert_eq!(call(app.world_mut(), d, "run", &[]).unwrap(), Value::Num(2.0), "{:?}", errors(&app));
    assert_eq!(num(&app, a, "hits"), 2.0);
    assert_eq!(num(&app, b, "hits"), 2.0);
    assert_eq!(call(app.world_mut(), d, "first", &[]).unwrap(), Value::Null);
    assert_eq!(call(app.world_mut(), d, "ing", &[Value::Entity(a.to_bits())]).unwrap(), Value::Bool(true));
    call(app.world_mut(), d, "rm", &[Value::Entity(a.to_bits())]).unwrap();
    assert_eq!(call(app.world_mut(), d, "ing", &[Value::Entity(a.to_bits())]).unwrap(), Value::Bool(false));
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

fn c_in_group(app: &mut App, e: Entity) {
    app.world_mut().entity_mut(e).insert(Groups(vec!["enemies".into()]));
}

#[test]
fn timers_and_time() {
    let src = "n = 0;\nt = 0;\nd = 0;\nfn tick() { n = n + 1; }\n\
               fn go() { return start_timer(0.25, \"tick\", true); }\n\
               fn stop(id) { stop_timer(id); }\n\
               fn _process(dt) { t = time(); d = delta(); }\n\
               fn rs(s) { timer_start(s); }\nfn left() { return timer_left(); }\nfn halt() { timer_stop(); }\n";
    let mut app = app("timers2", &[("t.ruspy", src)]);
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(std::time::Duration::from_millis(100)));
    let e = app.world_mut().spawn((Script::new("t.ruspy"), ScriptTimer { autostart: false, ..default() })).id();
    app.update();
    let Value::Num(id) = call(app.world_mut(), e, "go", &[]).unwrap() else { panic!() };
    for _ in 0..8 {
        app.update();
    }
    let n = num(&app, e, "n");
    assert!((2.0..=4.0).contains(&n), "{n}");
    assert!(num(&app, e, "t") > 0.3 && (num(&app, e, "d") - 0.1).abs() < 0.02);
    call(app.world_mut(), e, "stop", &[Value::Num(id)]).unwrap();
    for _ in 0..5 {
        app.update();
    }
    assert_eq!(num(&app, e, "n"), n, "stopped timer must not fire");
    // ScriptTimer component control.
    assert_eq!(call(app.world_mut(), e, "left", &[]).unwrap(), Value::Num(0.0));
    call(app.world_mut(), e, "rs", &[Value::Num(5.0)]).unwrap();
    assert_eq!(app.world().get::<ScriptTimer>(e).unwrap().left, Some(5.0));
    call(app.world_mut(), e, "halt", &[]).unwrap();
    assert_eq!(app.world().get::<ScriptTimer>(e).unwrap().left, None);
    call(app.world_mut(), e, "rs", &[Value::Entity(e.to_bits())]).unwrap();
    assert_eq!(app.world().get::<ScriptTimer>(e).unwrap().left, Some(1.0), "node only: wait_time");
}

#[test]
fn math_functions() {
    let src = "a = 0;\nb = 0;\nc = 0;\nd = 0;\ne = 0;\nf = 0;\ng = 0;\nh = 0;\nz = 0;\n\
        fn m() {\n\
          a = vlen(vadd([1, 2, 2], [0, 0, 0]));\n\
          b = vdot([1, 2, 3], [4, 5, 6]);\n\
          v = vcross([1, 0, 0], [0, 1, 0]);\n\
          c = v[2];\n\
          d = distance([0, 0, 0], [3, 4, 0]);\n\
          w = lerp([0, 0, 0], [10, 20, 0], 0.5);\n\
          e = w[1];\n\
          f = lerp(2, 4, 0.25) + clampf(7, 0, 5) + clampf(-1, 0, 5);\n\
          n = vnorm([0, 0, 0]);\n\
          g = vlen(n);\n\
          s = vscale(vsub([2, 2, 2], [1, 1, 1]), 3);\n\
          h = s[0] + vec3(1, 2, 3)[2];\n\
        }\n\
        fn rnd() { z = 0; i = 0; while i < 200 { r = randf(); k = randi_range(3, 5); if r < 0 { z = z + 1; } if r >= 1 { z = z + 1; } if k < 3 { z = z + 1; } if k > 5 { z = z + 1; } i = i + 1; } }\n";
    let mut app = app("math", &[("m.ruspy", src)]);
    let e = app.world_mut().spawn(Script::new("m.ruspy")).id();
    app.update();
    call(app.world_mut(), e, "m", &[]).unwrap();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    let ex = [("a", 3.0), ("b", 32.0), ("c", 1.0), ("d", 5.0), ("e", 10.0), ("f", 7.5), ("g", 0.0), ("h", 6.0)];
    for (k, v) in ex {
        assert!((num(&app, e, k) - v).abs() < 1e-5, "{k}: {} != {v}", num(&app, e, k));
    }
    call(app.world_mut(), e, "rnd", &[]).unwrap();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(num(&app, e, "z"), 0.0, "randf in [0,1), randi_range inclusive");
}

#[test]
fn input_functions() {
    let src = "fn keys() { return is_key_pressed(\"KeyW\"); }\nfn bad() { return is_key_pressed(\"Nope\"); }\n\
               fn act() { return is_action_pressed(\"jump\") || is_action_just_pressed(\"jump\") || is_action_just_released(\"jump\"); }\n\
               fn strength() { return get_action_strength(\"jump\") + get_axis(\"l\", \"r\"); }\n\
               fn vecf() { v = get_vector(\"l\", \"r\", \"u\", \"d\"); return v[0] + v[1]; }\n\
               fn mouse() { return get_mouse_position(); }\n\
               fn handled() { set_input_as_handled(); }\n";
    let mut app = app("input", &[("i.ruspy", src)]);
    app.init_resource::<ButtonInput<KeyCode>>();
    let e = app.world_mut().spawn(Script::new("i.ruspy")).id();
    app.update();
    assert_eq!(call(app.world_mut(), e, "keys", &[]).unwrap(), Value::Bool(false));
    app.world_mut().resource_mut::<ButtonInput<KeyCode>>().press(KeyCode::KeyW);
    #[cfg(feature = "actions")]
    {
        assert_eq!(call(app.world_mut(), e, "keys", &[]).unwrap(), Value::Bool(true));
        assert!(call(app.world_mut(), e, "bad", &[]).unwrap_err().contains("unknown key"));
    }
    // Unknown actions / no ActionState: false and zero, no error.
    assert_eq!(call(app.world_mut(), e, "act", &[]).unwrap(), Value::Bool(false));
    assert_eq!(call(app.world_mut(), e, "strength", &[]).unwrap(), Value::Num(0.0));
    assert_eq!(call(app.world_mut(), e, "vecf", &[]).unwrap(), Value::Num(0.0));
    assert_eq!(call(app.world_mut(), e, "mouse", &[]).unwrap(), Value::Null);
    call(app.world_mut(), e, "handled", &[]).unwrap();
    assert!(app.world().resource::<ScriptCtx>().handled);
}

#[test]
fn render_set_color_variants() {
    let src = "fn red(n) { set_color(n, [1, 0, 0]); }\nfn half() { set_color([0, 1, 0, 0.5]); }\n";
    let mut app = app("color", &[("c.ruspy", src)]);
    app.add_plugins(AssetPlugin::default()).init_asset::<StandardMaterial>();
    let shared = app.world_mut().resource_mut::<Assets<StandardMaterial>>().add(StandardMaterial::default());
    let e = app.world_mut().spawn((Script::new("c.ruspy"), BackgroundColor(Color::WHITE))).id();
    let m1 = app.world_mut().spawn(MeshMaterial3d(shared.clone())).id();
    let m2 = app.world_mut().spawn(MeshMaterial3d(shared.clone())).id();
    app.update();
    call(app.world_mut(), e, "red", &[Value::Entity(m1.to_bits())]).unwrap();
    call(app.world_mut(), e, "red", &[Value::Entity(m1.to_bits())]).unwrap();
    let w = app.world();
    let h1 = w.get::<MeshMaterial3d<StandardMaterial>>(m1).unwrap().0.clone();
    assert_ne!(h1, shared, "cloned for this entity");
    assert_eq!(w.get::<MeshMaterial3d<StandardMaterial>>(m2).unwrap().0, shared, "others untouched");
    let assets = w.resource::<Assets<StandardMaterial>>();
    assert_eq!(assets.get(&h1).unwrap().base_color, Color::srgb(1.0, 0.0, 0.0));
    assert_eq!(assets.get(&shared).unwrap().base_color, StandardMaterial::default().base_color);
    // UI.
    call(app.world_mut(), e, "half", &[]).unwrap();
    assert_eq!(app.world().get::<BackgroundColor>(e).unwrap().0, Color::srgba(0.0, 1.0, 0.0, 0.5));
    // Nothing to color: an error that says what is missing.
    let bare = app.world_mut().spawn_empty().id();
    let err = call(app.world_mut(), e, "red", &[Value::Entity(bare.to_bits())]).unwrap_err();
    assert!(err.contains("no Primitive"), "{err}");
}

#[test]
fn messages_and_commands() {
    let src = "fn msg() { send_message(\"hello\", 3); }\nfn cmd() { return command(\"no.such.command\", \"{}\"); }\nfn badjson() { return command(\"x\", \"{\"); }\n\
               fn scene() { change_scene(\"x.level.ron\"); }\n";
    let mut app = app("misc", &[("m.ruspy", src)]);
    app.add_message::<crate::logic::LogicMessage>();
    let e = app.world_mut().spawn(Script::new("m.ruspy")).id();
    app.update();
    call(app.world_mut(), e, "msg", &[]).unwrap();
    let msgs = app.world().resource::<Messages<crate::logic::LogicMessage>>();
    let got: Vec<_> = msgs.iter_current_update_messages().map(|m| (m.name.clone(), m.value.clone())).collect();
    assert_eq!(got, vec![("hello".to_string(), Value::Num(3.0))]);
    assert!(call(app.world_mut(), e, "cmd", &[]).unwrap_err().contains("no.such.command"));
    assert!(call(app.world_mut(), e, "badjson", &[]).unwrap_err().contains("bad JSON"));
    call(app.world_mut(), e, "scene", &[]).unwrap();
    assert_eq!(app.world().resource::<ScriptQueue>().change_scene.as_deref(), Some("x.level.ron"));
}

#[cfg(feature = "level")]
#[test]
fn instantiate_spawns_generated_entities() {
    use crate::level::{LevelEntity, LevelPlugin, StableId};
    use bevy::world_serialization::WorldSerializationPlugin;

    let src = "fn make(parent) { return instantiate(\"mini.level.ron\", parent); }\nfn nope() { return instantiate(\"missing.level.ron\"); }\n";
    let mut app = app("inst", &[("i.ruspy", src)]);
    app.add_plugins((AssetPlugin::default(), WorldSerializationPlugin))
        .register_type::<Name>()
        .register_type::<Transform>()
        .register_type::<Visibility>()
        .register_type::<ChildOf>()
        .add_plugins(LevelPlugin);
    app.finish();
    app.cleanup();
    // Author a small level through the real save path.
    let w = app.world_mut();
    let root = w.spawn((LevelEntity { id: StableId(1) }, Name::new("Crate"), Transform::from_xyz(1.0, 0.0, 0.0))).id();
    w.spawn((LevelEntity { id: StableId(2) }, Name::new("Lid"), Transform::from_xyz(0.0, 1.0, 0.0), ChildOf(root)));
    let dir = app.world().resource::<AssetsDir>().0.clone();
    crate::level::save_level(app.world_mut(), dir.join("mini.level.ron")).unwrap();
    crate::level::file::despawn_level(app.world_mut());
    let host = app.world_mut().spawn((Name::new("Host"), Script::new("i.ruspy"))).id();
    app.update();

    let first = as_ent(call(app.world_mut(), host, "make", &[Value::Entity(host.to_bits())]).unwrap());
    let second = as_ent(call(app.world_mut(), host, "make", &[Value::Null]).unwrap());
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    let w = app.world_mut();
    assert_ne!(first, second);
    assert_eq!(w.get::<Name>(first).unwrap().as_str(), "Crate");
    assert_eq!(w.get::<ChildOf>(first).unwrap().parent(), host);
    assert!(w.get::<ChildOf>(second).is_none());
    let lid = tree::child_named(w, first, "Lid").expect("hierarchy kept");
    assert_eq!(w.get::<Transform>(lid).unwrap().translation, Vec3::Y);
    assert!(w.get::<LevelEntity>(first).is_none() && w.get::<LevelEntity>(lid).is_none(), "generated, not level");
    assert_eq!(w.query::<&LevelEntity>().iter(w).count(), 0);
    let err = call(w, host, "nope", &[]).unwrap_err();
    assert!(err.contains("missing.level.ron"), "{err}");
    let _ = logs(&app);
}
