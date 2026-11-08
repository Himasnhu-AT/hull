//! `await`: wait, next_frame, signal_of, pause, free.

use super::tests::{app, errors, logs};
use super::*;
use crate::pause::Paused;

fn timed(tag: &str, files: &[(&str, &str)]) -> App {
    let mut a = app(tag, files);
    a.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(std::time::Duration::from_millis(100)));
    a
}

fn count(app: &App) -> usize {
    app.world().non_send::<ScriptRuntime>().coroutines.len()
}

#[test]
fn wait_and_next_frame_resume_in_order() {
    let src = "done = 0;\n\
        fn _ready() {\n\
            log(\"a\");\n\
            await wait(0.5);\n\
            log(\"b\");\n\
            await next_frame();\n\
            log(\"c\");\n\
            for i in 0..2 { await next_frame(); log(\"loop \" + i); }\n\
            done = 1;\n\
        }\n";
    let mut app = timed("co1", &[("c.ruspy", src)]);
    let e = app.world_mut().spawn(Script::new("c.ruspy")).id();
    app.update();
    app.update();
    assert_eq!(logs(&app), vec!["a".to_string()], "ready ran to its first await and returned");
    assert_eq!(count(&app), 1);
    for _ in 0..16 {
        app.update();
    }
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(logs(&app), ["a", "b", "c", "loop 0", "loop 1"].map(String::from).to_vec());
    assert_eq!(get_member(app.world(), e, "done"), Some(Value::Num(1.0)));
    assert_eq!(count(&app), 0);
}

#[test]
fn signal_of_returns_the_arguments() {
    let boss = "signal(\"died\");\nsignal(\"two\");\nfn die() { emit_signal(\"died\", 42); }\nfn both() { emit_signal(\"two\", 1, 2); }\nfn nothing() { emit_signal(\"died\"); }\n";
    let hud = "got = 0;\nlast = null;\n\
        fn watch(boss) {\n\
            got = await signal_of(boss, \"died\");\n\
            pair = await signal_of(boss, \"two\");\n\
            last = pair;\n\
            await signal_of(boss, \"died\");\n\
            log(\"third\");\n\
        }\n";
    let mut app = timed("co2", &[("boss.ruspy", boss), ("hud.ruspy", hud)]);
    let b = app.world_mut().spawn(Script::new("boss.ruspy")).id();
    let h = app.world_mut().spawn(Script::new("hud.ruspy")).id();
    app.update();
    call(app.world_mut(), h, "watch", &[Value::Entity(b.to_bits())]).unwrap();
    assert_eq!(count(&app), 1);
    call(app.world_mut(), b, "die", &[]).unwrap();
    assert_eq!(get_member(app.world(), h, "got"), Some(Value::Num(42.0)));
    call(app.world_mut(), b, "die", &[]).unwrap(); // not waiting for "died" now: ignored
    call(app.world_mut(), b, "both", &[]).unwrap();
    assert_eq!(get_member(app.world(), h, "last").map(|v| v.to_json()), Some(serde_json::json!([1, 2])));
    call(app.world_mut(), b, "nothing", &[]).unwrap();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(logs(&app), vec!["third".to_string()]);
    assert_eq!(count(&app), 0);
}

#[test]
fn pause_and_free_stop_waits() {
    let src = "n = 0;\nfn go() { await wait(0.3); n = 1; }\n";
    let mut app = timed("co3", &[("c.ruspy", src)]);
    let a = app.world_mut().spawn(Script::new("c.ruspy")).id();
    let always = app.world_mut().spawn(Script { process_mode: ProcessMode::Always, ..Script::new("c.ruspy") }).id();
    let doomed = app.world_mut().spawn(Script::new("c.ruspy")).id();
    app.update();
    for e in [a, always, doomed] {
        call(app.world_mut(), e, "go", &[]).unwrap();
    }
    assert_eq!(count(&app), 3);
    app.world_mut().resource_mut::<Paused>().0 = true;
    app.world_mut().despawn(doomed);
    for _ in 0..6 {
        app.update();
    }
    let n = |app: &App, e| get_member(app.world(), e, "n");
    assert_eq!(n(&app, a), Some(Value::Num(0.0)), "a pausable wait does not advance while paused");
    assert_eq!(n(&app, always), Some(Value::Num(1.0)), "Always keeps going");
    assert_eq!(count(&app), 1, "the despawned node's coroutine is gone");
    app.world_mut().resource_mut::<Paused>().0 = false;
    for _ in 0..6 {
        app.update();
    }
    assert_eq!(n(&app, a), Some(Value::Num(1.0)));
    assert_eq!(count(&app), 0);
}

#[test]
fn errors_after_resume_are_located_and_reload_drops_waits() {
    let src = "fn go() {\n  await next_frame();\n  x = 1 / 0;\n}\nfn two() {\n  await wait(100);\n}\n";
    let mut app = timed("co4", &[("c.ruspy", src)]);
    let e = app.world_mut().spawn(Script::new("c.ruspy")).id();
    app.update();
    call(app.world_mut(), e, "go", &[]).unwrap();
    call(app.world_mut(), e, "two", &[]).unwrap();
    for _ in 0..3 {
        app.update();
    }
    let errs = errors(&app);
    assert!(errs.iter().any(|m| m.contains("c.ruspy:3") && m.contains("division by zero")), "{errs:?}");
    assert_eq!(count(&app), 1);
    // A script with `await` in a plain expression is rejected with a located error.
    let bad = app_with_bad();
    assert!(bad.iter().any(|m| m.contains("E0360")), "{bad:?}");
}

fn app_with_bad() -> Vec<String> {
    let mut app = timed("co5", &[("b.ruspy", "fn f() { x = 1 + await wait(1); }\n")]);
    app.world_mut().spawn(Script::new("b.ruspy"));
    app.update();
    errors(&app)
}
