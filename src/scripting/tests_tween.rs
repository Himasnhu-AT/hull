//! Tweens: steps, parallel, easing, callbacks, loops, kill, members, reflect paths, signals.

use super::tests::{app, errors, logs};
use super::tween::Tweens;
use super::*;

fn frames(app: &mut App, n: usize) {
    for _ in 0..n {
        app.update();
    }
}

fn tapp(tag: &str, src: &str) -> (App, Entity) {
    let mut app = app(tag, &[("t.ruspy", src)]);
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(std::time::Duration::from_millis(100)));
    app.register_type::<Transform>();
    let e = app.world_mut().spawn((Script::new("t.ruspy"), Transform::default())).id();
    (app, e)
}

fn pos(app: &App, e: Entity) -> Vec3 {
    app.world().get::<Transform>(e).unwrap().translation
}

fn num(app: &App, e: Entity, name: &str) -> f64 {
    match get_member(app.world(), e, name) {
        Some(Value::Num(x)) => x,
        o => panic!("{name}: {o:?}"),
    }
}

#[test]
fn easing_endpoints_are_exact() {
    use super::tween::{test_ease as ease, ALL_EASES, ALL_TRANS};
    for tr in ALL_TRANS {
        for m in ALL_EASES {
            assert_eq!(ease(tr, m, 0.0), 0.0, "{tr:?} {m:?}");
            assert_eq!(ease(tr, m, 1.0), 1.0, "{tr:?} {m:?}");
        }
    }
    assert!((ease(ALL_TRANS[2], ALL_EASES[1], 0.5) - 0.75).abs() < 1e-6); // quad out
}

#[test]
fn sequential_steps_run_in_order_and_end_exact() {
    let src = "fn _ready() { t = tween(); tween_property(t, \"position\", [10, 0, 0], 0.5); tween_property(t, \"position\", [10, 10, 0], 0.5); }\nt = 0;\n";
    let (mut app, e) = tapp("tw_seq", src);
    frames(&mut app, 4);
    let p = pos(&app, e);
    assert!(p.x > 0.0 && p.x < 10.0 && p.y == 0.0, "{p:?}");
    frames(&mut app, 3);
    let p = pos(&app, e);
    assert_eq!(p.x, 10.0, "{p:?}");
    assert!(p.y > 0.0 && p.y < 10.0, "{p:?}");
    frames(&mut app, 8);
    assert_eq!(pos(&app, e), Vec3::new(10.0, 10.0, 0.0));
    assert!(app.world().resource::<Tweens>().list.is_empty());
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
fn parallel_steps_share_time() {
    let src = "t = 0;\nfn _ready() { t = tween(); tween_property(t, \"position\", [4, 0, 0], 0.4); tween_parallel(t); tween_property(t, \"scale\", [3, 3, 3], 0.8); tween_set_trans(t, \"quad\"); tween_set_ease(t, \"out\"); tween_property(t, \"position\", [4, 4, 0], 0.2); }\n";
    let (mut app, e) = tapp("tw_par", src);
    frames(&mut app, 7);
    // After 0.6s: position x done, scale still going, last step not started (waits for group).
    let t = app.world().get::<Transform>(e).unwrap();
    assert_eq!(t.translation, Vec3::new(4.0, 0.0, 0.0));
    assert!(t.scale.x > 1.0 && t.scale.x < 3.0, "{:?}", t.scale);
    frames(&mut app, 8);
    let t = app.world().get::<Transform>(e).unwrap();
    assert_eq!((t.translation, t.scale), (Vec3::new(4.0, 4.0, 0.0), Vec3::splat(3.0)));
}

#[test]
fn callbacks_fire_in_order_with_args() {
    let src = "fn a(x) { log(\"a\" + tostr(x)); }\nfn b() { log(\"b\"); }\nfn _ready() { t = tween(); tween_callback(t, \"a\", 7); tween_interval(t, 0.3); tween_callback(t, \"b\"); }\nt = 0;\n";
    let (mut app, _) = tapp("tw_cb", src);
    frames(&mut app, 2);
    assert_eq!(logs(&app), vec!["a7".to_string()]);
    frames(&mut app, 5);
    assert_eq!(logs(&app), vec!["a7".to_string(), "b".to_string()]);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
fn loops_repeat_and_zero_is_forever() {
    let src = "n = 0;\nt = 0;\nfn hit() { n = n + 1; }\nfn go(k) { t = tween(); tween_set_loops(t, k); tween_property(t, \"position\", [1, 0, 0], 0.2); tween_callback(t, \"hit\"); }\n";
    let (mut app, e) = tapp("tw_loop", src);
    app.update();
    call(app.world_mut(), e, "go", &[Value::Num(3.0)]).unwrap();
    frames(&mut app, 15);
    assert_eq!(num(&app, e, "n"), 3.0);
    assert!(app.world().resource::<Tweens>().list.is_empty());
    call(app.world_mut(), e, "go", &[Value::Num(0.0)]).unwrap();
    frames(&mut app, 20);
    assert!(num(&app, e, "n") >= 8.0);
    assert_eq!(app.world().resource::<Tweens>().list.len(), 1);
}

#[test]
fn tween_dies_with_its_node_and_kill_stops_it() {
    let src = "n = 0;\nt = 0;\nfn hit() { n = n + 1; }\nfn go() { t = tween(); tween_set_loops(t, 0); tween_interval(t, 0.1); tween_callback(t, \"hit\"); }\nfn stop() { tween_kill(t); }\nfn running() { return tween_is_running(t); }\nfn die() { queue_free(); }\n";
    let (mut app, e) = tapp("tw_kill", src);
    app.update();
    call(app.world_mut(), e, "go", &[]).unwrap();
    assert_eq!(call(app.world_mut(), e, "running", &[]).unwrap(), Value::Bool(true));
    frames(&mut app, 5);
    let n = num(&app, e, "n");
    assert!(n >= 2.0);
    call(app.world_mut(), e, "stop", &[]).unwrap();
    assert_eq!(call(app.world_mut(), e, "running", &[]).unwrap(), Value::Bool(false));
    frames(&mut app, 4);
    assert_eq!(num(&app, e, "n"), n);
    // Freed node: its tween disappears and nothing errors.
    call(app.world_mut(), e, "go", &[]).unwrap();
    frames(&mut app, 2);
    call(app.world_mut(), e, "die", &[]).unwrap();
    frames(&mut app, 3);
    assert!(app.world().get_entity(e).is_err());
    assert!(app.world().resource::<Tweens>().list.is_empty());
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
fn member_and_reflect_path_tweens() {
    let src = "hp = 10;\nt = 0;\nfn _ready() { t = tween(); tween_property(t, \"member:hp\", 0, 0.5); tween_parallel(t); tween_property(t, \"Transform.translation.y\", 5, 0.5); tween_from(t, 1); }\n";
    let (mut app, e) = tapp("tw_member", src);
    frames(&mut app, 3);
    let hp = num(&app, e, "hp");
    assert!(hp > 0.0 && hp < 10.0, "{hp}");
    assert!(pos(&app, e).y > 1.0 && pos(&app, e).y < 5.0, "{:?}", pos(&app, e));
    frames(&mut app, 6);
    assert_eq!(num(&app, e, "hp"), 0.0);
    assert_eq!(pos(&app, e).y, 5.0);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
fn finished_signal_and_sugar_fire_once() {
    let src = "n = 0;\nm = 0;\nt = 0;\nfn done(id) { n = n + 1; }\nfn sugar(id) { m = m + id; }\nfn _ready() { connect(\"tween_finished\", self(), \"done\"); t = tween(); tween_property(t, \"scale\", [2, 2, 2], 0.3); tween_on_finished(t, \"sugar\"); }\n";
    let (mut app, e) = tapp("tw_fin", src);
    frames(&mut app, 8);
    assert_eq!(num(&app, e, "n"), 1.0);
    assert_eq!(num(&app, e, "m"), 1.0);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
fn paused_game_freezes_pausable_tweens_only() {
    let src = "fn _ready() { t = tween(); tween_property(t, \"position\", [10, 0, 0], 1.0); }\nt = 0;\n";
    let mut app = app("tw_pause", &[("t.ruspy", src)]);
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(std::time::Duration::from_millis(100)));
    let a = app.world_mut().spawn((Script::new("t.ruspy"), Transform::default())).id();
    let b = app.world_mut().spawn((Script { process_mode: ProcessMode::Always, ..Script::new("t.ruspy") }, Transform::default())).id();
    frames(&mut app, 3);
    app.world_mut().resource_mut::<crate::pause::Paused>().0 = true;
    let (xa, xb) = (pos(&app, a).x, pos(&app, b).x);
    frames(&mut app, 3);
    assert_eq!(pos(&app, a).x, xa);
    assert!(pos(&app, b).x > xb);
}

#[test]
fn color_tween_on_ui_background() {
    let src = "fn _ready() { t = tween(); tween_property(t, \"color\", [1, 0, 0], 0.2); }\nt = 0;\n";
    let (mut app, e) = tapp("tw_color", src);
    app.world_mut().entity_mut(e).insert(BackgroundColor(Color::srgba(0.0, 0.0, 0.0, 0.5)));
    frames(&mut app, 5);
    let c = app.world().get::<BackgroundColor>(e).unwrap().0.to_srgba();
    assert_eq!((c.red, c.green, c.alpha), (1.0, 0.0, 0.5));
}
