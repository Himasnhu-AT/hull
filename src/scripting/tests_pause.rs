//! Process modes, pause, per-instance processing, connect flags, name index.

use bevy::ui::Pressed;

use super::tests::{app, errors, logs};
use super::*;

const COUNTER: &str = "n = 0;\nfn _process(dt) { n = n + 1; }\nfn bump() { n = n + 100; }\n";

fn n(app: &App, e: Entity) -> f64 {
    match get_member(app.world(), e, "n") {
        Some(Value::Num(x)) => x,
        other => panic!("{other:?}"),
    }
}

fn spawn_mode(app: &mut App, mode: ProcessMode) -> Entity {
    app.world_mut().spawn(Script { process_mode: mode, ..Script::new("c.ruspy") }).id()
}

fn pause(app: &mut App, on: bool) {
    app.world_mut().resource_mut::<Paused>().0 = on;
}

#[test]
fn process_modes_follow_the_pause() {
    let mut app = app("modes", &[("c.ruspy", COUNTER)]);
    let inherit = spawn_mode(&mut app, ProcessMode::Inherit);
    let pausable = spawn_mode(&mut app, ProcessMode::Pausable);
    let when_paused = spawn_mode(&mut app, ProcessMode::WhenPaused);
    let always = spawn_mode(&mut app, ProcessMode::Always);
    let disabled = spawn_mode(&mut app, ProcessMode::Disabled);
    // Inherit follows its parent: under an `Always` node it runs while paused.
    let parent = app.world_mut().spawn(Script { process_mode: ProcessMode::Always, ..Script::new("c.ruspy") }).id();
    let child = app.world_mut().spawn((Script::new("c.ruspy"), ChildOf(parent))).id();
    // A node without a Script in between passes the mode up.
    let mid = app.world_mut().spawn(ChildOf(parent)).id();
    let grandchild = app.world_mut().spawn((Script::new("c.ruspy"), ChildOf(mid))).id();
    app.update();
    app.update();
    let all = [inherit, pausable, when_paused, always, disabled, child, grandchild];
    let running: Vec<f64> = all.iter().map(|e| n(&app, *e)).collect();
    assert_eq!(running, vec![2.0, 2.0, 0.0, 2.0, 0.0, 2.0, 2.0]);
    pause(&mut app, true);
    app.update();
    app.update();
    let paused: Vec<f64> = all.iter().map(|e| n(&app, *e)).collect();
    assert_eq!(paused, vec![2.0, 2.0, 2.0, 4.0, 0.0, 4.0, 4.0]);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(effective_mode(app.world(), grandchild), ProcessMode::Always);
    assert_eq!(effective_mode(app.world(), inherit), ProcessMode::Pausable);
}

#[test]
fn ready_waits_until_the_instance_would_process() {
    let src = "fn _ready() { log(get_name() + \" ready\"); }\n";
    let mut app = app("ready_pause", &[("r.ruspy", src)]);
    pause(&mut app, true);
    let w = app.world_mut();
    let script = |m| Script { process_mode: m, ..Script::new("r.ruspy") };
    w.spawn((Name::new("P"), script(ProcessMode::Pausable)));
    w.spawn((Name::new("A"), script(ProcessMode::Always)));
    app.update();
    // The instances exist, but only the one that processes while paused got its `_ready`.
    assert_eq!(logs(&app), vec!["A ready".to_string()]);
    assert_eq!(app.world().non_send::<ScriptRuntime>().instances.len(), 2);
    pause(&mut app, false);
    app.update();
    assert_eq!(logs(&app), vec!["A ready".to_string(), "P ready".to_string()]);
}

#[test]
fn ui_signals_reach_a_paused_games_menu() {
    let menu = "n = 0;\nfn on_press() { n = n + 1; }\n";
    let mut app = app("menu_pause", &[("m.ruspy", menu)]);
    let w = app.world_mut();
    let root = w.spawn(Script { process_mode: ProcessMode::Always, ..Script::new("m.ruspy") }).id();
    // A button under the Always root, and one that stays pausable.
    let target = format!("#{}", root.to_bits());
    let yes = w.spawn((ChildOf(root), Connections::default().to("pressed", &target, "on_press"))).id();
    let no_root = w.spawn(Script::new("m.ruspy")).id();
    let target2 = format!("#{}", no_root.to_bits());
    let no = w.spawn((ChildOf(no_root), Connections::default().to("pressed", &target2, "on_press"))).id();
    app.update();
    pause(&mut app, true);
    app.world_mut().entity_mut(yes).insert(Pressed);
    app.world_mut().entity_mut(no).insert(Pressed);
    app.update();
    assert_eq!(n(&app, root), 1.0);
    assert_eq!(n(&app, no_root), 0.0);
}

#[test]
fn deferred_calls_and_timers_follow_the_mode() {
    let mut app = app("deferred_pause", &[("c.ruspy", COUNTER)]);
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(std::time::Duration::from_millis(100)));
    let pausable = spawn_mode(&mut app, ProcessMode::Pausable);
    let always = spawn_mode(&mut app, ProcessMode::Always);
    let disabled = spawn_mode(&mut app, ProcessMode::Disabled);
    app.update();
    pause(&mut app, true);
    for e in [pausable, always, disabled] {
        defer(app.world_mut(), e, "bump".into(), vec![]);
    }
    let base = (n(&app, pausable), n(&app, always));
    app.update();
    // Paused: the Always call ran, the Pausable one waits, the Disabled one is dropped.
    assert_eq!(n(&app, always) - base.1, 101.0);
    assert_eq!(n(&app, pausable), base.0);
    pause(&mut app, false);
    app.update();
    assert!(n(&app, pausable) >= base.0 + 100.0, "{}", n(&app, pausable));
    pause(&mut app, true);
    app.update();
    assert_eq!(n(&app, disabled), 0.0);
    // Timers: a ScriptTimer under an Always node ticks (in real time) while paused.
    let t = app.world_mut().spawn((Script { process_mode: ProcessMode::Always, ..Script::new("c.ruspy") }, ScriptTimer { wait_time: 0.25, ..default() })).id();
    app.world_mut().entity_mut(t).insert(Connections::default().to("timeout", ".", "bump"));
    let slow = app.world_mut().spawn((Script::new("c.ruspy"), ScriptTimer { wait_time: 0.25, ..default() })).id();
    app.world_mut().entity_mut(slow).insert(Connections::default().to("timeout", ".", "bump"));
    for _ in 0..8 {
        app.update();
    }
    assert!(n(&app, t) >= 200.0, "{}", n(&app, t));
    assert_eq!(n(&app, slow), 0.0);
}

#[test]
fn set_process_toggles_and_host_pause_functions() {
    let src = "n = 0;\nfn _process(dt) { n = n + 1; if n == 3 { set_process(false); } }\nfn on() { set_process(true); }\nfn state() { return is_processing(); }\n\
               fn pause_it() { set_tree_paused(true); return get_tree_paused(); }\nfn mode(m) { set_process_mode(m); return get_process_mode(); }\n";
    let mut app = app("toggle", &[("t.ruspy", src)]);
    let e = app.world_mut().spawn(Script::new("t.ruspy")).id();
    for _ in 0..6 {
        app.update();
    }
    assert_eq!(n(&app, e), 3.0);
    assert_eq!(call(app.world_mut(), e, "state", &[]).unwrap(), Value::Bool(false));
    call(app.world_mut(), e, "on", &[]).unwrap();
    app.update();
    assert_eq!(n(&app, e), 4.0);
    assert_eq!(call(app.world_mut(), e, "state", &[]).unwrap(), Value::Bool(true));
    assert_eq!(call(app.world_mut(), e, "mode", &[Value::text("always")]).unwrap(), Value::text("always"));
    assert_eq!(app.world().get::<Script>(e).unwrap().process_mode, ProcessMode::Always);
    assert_eq!(call(app.world_mut(), e, "mode", &[Value::Num(2.0)]).unwrap(), Value::text("when_paused"));
    assert!(call(app.world_mut(), e, "mode", &[Value::text("bogus")]).is_err());
    call(app.world_mut(), e, "mode", &[Value::text("always")]).unwrap();
    assert_eq!(call(app.world_mut(), e, "pause_it", &[]).unwrap(), Value::Bool(true));
    assert!(app.world().resource::<Paused>().0);
    assert!(app.world().resource::<Time<Virtual>>().is_paused());
    // An Always script keeps going in the paused game.
    app.update();
    assert_eq!(n(&app, e), 5.0);
}

#[test]
fn connect_flags_source_form_and_is_connected() {
    let src = "fn setup(other) { connect(\"s1\", other, \"m\", 5); connect(self(), \"s2\", other, \"m\", connect_flags.DEFERRED); connect(\"s3\", \"..\", \"m\", CONNECT_ONE_SHOT()); connect(\"s4\", other, \"m\"); }\n\
               fn has(sig, other) { return is_connected(sig, other, \"m\"); }\nfn has_src(src, sig, other) { return is_connected(src, sig, other, \"m\"); }\n\
               fn cut(sig, other) { disconnect(sig, other, \"m\"); }\nfn bad() { connect(\"s\", \"x\", \"m\", \"nope\"); }\n";
    let mut app = app("connect", &[("c.ruspy", src)]);
    let e = app.world_mut().spawn(Script::new("c.ruspy")).id();
    let other = app.world_mut().spawn(Name::new("O")).id();
    app.update();
    let o = Value::Entity(other.to_bits());
    call(app.world_mut(), e, "setup", std::slice::from_ref(&o)).unwrap();
    let flags = |sig: &str| {
        let cs = app.world().get::<Connections>(e).unwrap();
        let c = cs.0.iter().find(|c| c.signal == sig).unwrap();
        (c.deferred, c.one_shot)
    };
    assert_eq!(flags("s1"), (true, true));
    assert_eq!(flags("s2"), (true, false));
    assert_eq!(flags("s3"), (false, true));
    assert_eq!(flags("s4"), (false, false));
    assert_eq!(call(app.world_mut(), e, "has", &[Value::text("s1"), o.clone()]).unwrap(), Value::Bool(true));
    assert_eq!(call(app.world_mut(), e, "has", &[Value::text("nope"), o.clone()]).unwrap(), Value::Bool(false));
    assert_eq!(call(app.world_mut(), e, "has_src", &[Value::Entity(e.to_bits()), Value::text("s2"), o.clone()]).unwrap(), Value::Bool(true));
    call(app.world_mut(), e, "cut", &[Value::text("s1"), o.clone()]).unwrap();
    assert_eq!(call(app.world_mut(), e, "has", &[Value::text("s1"), o]).unwrap(), Value::Bool(false));
    assert!(call(app.world_mut(), e, "bad", &[]).unwrap_err().contains("flags must be an int"));
}

#[test]
fn get_vector_takes_one_action_or_four() {
    let src = "fn one() { return get_vector(\"move\"); }\nfn four() { return get_vector(\"l\", \"r\", \"u\", \"d\"); }\nfn two() { return get_vector(\"a\", \"b\"); }\n";
    let mut app = app("vector", &[("v.ruspy", src)]);
    let e = app.world_mut().spawn(Script::new("v.ruspy")).id();
    app.update();
    let zero = call(app.world_mut(), e, "one", &[]).unwrap();
    assert_eq!(zero, call(app.world_mut(), e, "four", &[]).unwrap());
    assert!(call(app.world_mut(), e, "two", &[]).unwrap_err().contains("usage: get_vector"));
}

#[test]
fn name_index_follows_insert_rename_and_despawn() {
    let mut app = app("names", &[]);
    let w = app.world_mut();
    let root = w.spawn(Name::new("Root")).id();
    let a = w.spawn((Name::new("Twin"), ChildOf(root))).id();
    let b = w.spawn(Name::new("Twin")).id();
    assert_eq!(tree::find_named(app.world(), "Twin"), Some(a));
    assert_eq!(resolve_path(app.world(), a, "/Twin"), Some(b), "a root is preferred");
    assert_eq!(resolve_path(app.world(), a, "%Twin"), Some(a));
    // Rename: the old name is forgotten, the new one found.
    app.world_mut().entity_mut(a).insert(Name::new("Solo"));
    assert_eq!(tree::find_named(app.world(), "Solo"), Some(a));
    assert_eq!(tree::find_named(app.world(), "Twin"), Some(b));
    app.world_mut().entity_mut(b).remove::<Name>();
    assert_eq!(tree::find_named(app.world(), "Twin"), None);
    app.world_mut().entity_mut(a).despawn();
    assert_eq!(tree::find_named(app.world(), "Solo"), None);
    assert!(app.world().resource::<tree::NameIndex>().get("Solo").is_empty());
}
