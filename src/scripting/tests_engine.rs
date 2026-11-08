//! Engine-subsystem host functions (`api_engine.rs`), headless.

use super::tests::{app, errors, logs};
use super::*;
use crate::logic::Severity;

fn run(app: &mut App, src: &str) -> Entity {
    let _ = src;
    let e = app.world_mut().spawn(Script::new("t.ruspy")).id();
    app.update();
    e
}

#[test]
fn push_error_warning_and_assert_report_to_diagnostics() {
    let src = "fn _ready() { push_warning(\"careful\"); push_error(\"bad\", 3); }\nfn boom() { assert(1 == 2, \"math\"); }\nfn fine() { assert(true); return 7; }\n";
    let mut app = app("diag", &[("t.ruspy", src)]);
    let e = run(&mut app, src);
    let d = &app.world().resource::<LogicDiagnostics>().items;
    assert!(d.iter().any(|x| x.severity == Severity::Warning && x.message == "careful" && x.file == "scripts/t.ruspy"), "{d:?}");
    assert!(d.iter().any(|x| x.severity == Severity::Error && x.message == "bad 3"), "{d:?}");
    assert_eq!(call(app.world_mut(), e, "fine", &[]).unwrap(), Value::Num(7.0));
    let err = call(app.world_mut(), e, "boom", &[]).unwrap_err();
    assert!(err.contains("assertion failed: math"), "{err}");
}

#[test]
fn time_scale_and_fps() {
    let src = "fn go() { set_time_scale(0.5); return get_time_scale(); }\nfn bad() { set_time_scale(20); }\nfn fps() { return get_fps(); }\n";
    let mut app = app("time", &[("t.ruspy", src)]);
    let e = run(&mut app, src);
    assert_eq!(call(app.world_mut(), e, "go", &[]).unwrap(), Value::Num(0.5));
    assert_eq!(app.world().resource::<Time<Virtual>>().relative_speed(), 0.5);
    assert!(call(app.world_mut(), e, "bad", &[]).is_err());
    assert!(matches!(call(app.world_mut(), e, "fps", &[]).unwrap(), Value::Num(_)));
}

#[test]
fn tr_falls_back_to_the_key() {
    let src = "fn t() { return tr(\"no.such.key\"); }\n";
    let mut app = app("tr", &[("t.ruspy", src)]);
    let e = run(&mut app, src);
    assert_eq!(call(app.world_mut(), e, "t", &[]).unwrap(), Value::text("no.such.key"));
}

#[test]
fn settings_round_trip() {
    use crate::settings::{FieldDef, FieldKind, RegisterSettings};
    #[derive(Resource, Default)]
    struct Vol(f32);
    let src = "fn get() { return get_setting(\"t.vol\"); }\nfn set(x) { return set_setting(\"t.vol\", x); }\nfn unk() { get_setting(\"nope\"); }\n";
    let mut app = app("settings", &[("t.ruspy", src)]);
    app.init_resource::<Vol>();
    app.register_setting(FieldDef {
        key: "t.vol",
        tab: "",
        label: "Vol",
        hint: "",
        kind: FieldKind::Toggle,
        get: |w| w.resource::<Vol>().0,
        set: |w, v| w.resource_mut::<Vol>().0 = v,
    });
    let e = run(&mut app, src);
    assert_eq!(call(app.world_mut(), e, "set", &[Value::Num(0.5)]).unwrap(), Value::Num(0.5));
    assert_eq!(app.world().resource::<Vol>().0, 0.5);
    assert_eq!(call(app.world_mut(), e, "get", &[]).unwrap(), Value::Num(0.5));
    assert!(call(app.world_mut(), e, "unk", &[]).unwrap_err().contains("unknown setting"));
}

#[test]
fn toast_is_queued() {
    let src = "fn go() { toast(\"Saved\", \"slot 1\"); }\n";
    let mut app = app("toast", &[("t.ruspy", src)]);
    app.add_message::<crate::ui::toast::Toast>();
    let e = run(&mut app, src);
    call(app.world_mut(), e, "go", &[]).unwrap();
    let msgs = app.world().resource::<Messages<crate::ui::toast::Toast>>();
    let got: Vec<_> = msgs.iter_current_update_messages().map(|t| (t.title.clone(), t.body.clone())).collect();
    assert_eq!(got, vec![("Saved".to_string(), "slot 1".to_string())]);
}

#[test]
fn missing_subsystems_are_clear_errors() {
    let src = "fn s() { play_sound(\"x\"); }\nfn m() { play_music(\"x\"); }\nfn v() { spawn_vfx(\"x\", [0,0,0]); }\nfn a() { anim_set(\"p\", 1); }\nfn n() { nav_goto([0,0,0]); }\n";
    let mut app = app("missing", &[("t.ruspy", src)]);
    let e = run(&mut app, src);
    for f in ["s", "m", "v"] {
        let err = call(app.world_mut(), e, f, &[]).unwrap_err();
        assert!(err.contains("not set up"), "{f}: {err}");
    }
    assert!(call(app.world_mut(), e, "a", &[]).unwrap_err().contains("no Animator"));
    assert!(call(app.world_mut(), e, "n", &[]).unwrap_err().contains("no NavAgent"));
    let _ = (errors(&app), logs(&app));
}

#[cfg(feature = "sound")]
#[test]
fn sound_requests_are_queued() {
    use crate::sound::{Mixer, SoundCtl};
    let src = "fn go() { return play_sound(\"boom\", [1, 2, 3]); }\nfn at() { return play_sound_at(\"hum\"); }\nfn vol() { set_bus_volume(\"sfx\", 0.25); return get_bus_volume(\"sfx\"); }\nfn db() { set_bus_volume_db(\"sfx\", 0); return get_bus_volume(\"sfx\"); }\nfn nobus() { set_bus_volume(\"zzz\", 1); }\nfn stop() { stop_sound(\"boom\"); }\n";
    let mut app = app("sound", &[("t.ruspy", src)]);
    app.init_resource::<SoundCtl>().init_resource::<Mixer>();
    let e = run(&mut app, src);
    let a = call(app.world_mut(), e, "go", &[]).unwrap();
    let b = call(app.world_mut(), e, "at", &[]).unwrap();
    assert!(matches!((a, b), (Value::Num(x), Value::Num(y)) if x != y));
    assert_eq!(app.world().resource::<SoundCtl>().queue.len(), 2);
    call(app.world_mut(), e, "stop", &[]).unwrap();
    assert_eq!(app.world().resource::<SoundCtl>().queue.len(), 3);
    assert_eq!(call(app.world_mut(), e, "vol", &[]).unwrap(), Value::Num(0.25));
    assert_eq!(call(app.world_mut(), e, "db", &[]).unwrap(), Value::Num(1.0));
    assert!(call(app.world_mut(), e, "nobus", &[]).unwrap_err().contains("unknown bus"));
}

#[cfg(feature = "anim")]
#[test]
fn animation_parameters() {
    use crate::anim::{AnimGraphDef, AnimLayer, AnimState, Animator, Clip, Motion};
    let src = "fn go() { anim_set(\"speed\", 2.5); anim_set(\"grounded\", false); anim_trigger(\"jump\"); return anim_get(\"speed\"); }\nfn g() { return anim_get(\"grounded\"); }\nfn j() { return anim_get(\"jump\"); }\nfn st() { return anim_state(); }\nfn bad() { anim_set(\"zzz\", 1); }\nfn pl() { anim_play(\"run\"); }\nfn nope() { anim_play(\"nope\"); }\n";
    let mut app = app("anim", &[("t.ruspy", src)]);
    let clip = |a: &mut App| Clip::new(a.world_mut().resource_mut::<Assets<AnimationClip>>().add(AnimationClip::default()));
    app.init_resource::<Assets<AnimationClip>>();
    let (c1, c2) = (clip(&mut app), clip(&mut app));
    let def = AnimGraphDef::builder("g")
        .float("speed", 0.0)
        .bool("grounded", true)
        .trigger("jump")
        .layer(AnimLayer::new("base").state(AnimState::new("idle", Motion::Clip(c1))).state(AnimState::new("run", Motion::Clip(c2))))
        .build()
        .unwrap();
    let e = app.world_mut().spawn((Script::new("t.ruspy"), Animator::new(def))).id();
    app.update();
    assert_eq!(call(app.world_mut(), e, "go", &[]).unwrap(), Value::Num(2.5));
    assert_eq!(call(app.world_mut(), e, "g", &[]).unwrap(), Value::Bool(false));
    assert_eq!(call(app.world_mut(), e, "j", &[]).unwrap(), Value::Bool(true));
    assert_eq!(call(app.world_mut(), e, "st", &[]).unwrap(), Value::text("idle"));
    assert!(call(app.world_mut(), e, "bad", &[]).unwrap_err().contains("unknown animation parameter"));
    call(app.world_mut(), e, "pl", &[]).unwrap();
    assert_eq!(call(app.world_mut(), e, "st", &[]).unwrap(), Value::text("run"));
    assert!(call(app.world_mut(), e, "nope", &[]).unwrap_err().contains("no animation state"));
}

#[cfg(feature = "ai")]
#[test]
fn nav_requests_and_arrival_signal() {
    use crate::ai::{NavAgent, NavAgentState, NavStatus};
    let agent = "arrived = 0;\nfn _on_done() { arrived = arrived + 1; }\nfn go() { nav_goto([4, 0, 2]); }\nfn halt() { nav_stop(); }\nfn done() { return nav_is_done(); }\nfn st() { return nav_status(); }\nfn tgt() { return nav_target(); }\n";
    let mut app = app("nav", &[("t.ruspy", agent)]);
    let w = app.world_mut();
    let e = w.spawn((Name::new("A"), Script::new("t.ruspy"), NavAgent::default(), Connections::default().to("navigation_finished", ".", "_on_done"))).id();
    app.update();
    assert_eq!(call(app.world_mut(), e, "done", &[]).unwrap(), Value::Bool(true));
    call(app.world_mut(), e, "go", &[]).unwrap();
    assert_eq!(app.world().get::<NavAgentState>(e).unwrap().target, Some(Vec3::new(4.0, 0.0, 2.0)));
    assert_eq!(call(app.world_mut(), e, "done", &[]).unwrap(), Value::Bool(false));
    assert!(!matches!(call(app.world_mut(), e, "tgt", &[]).unwrap(), Value::Null));
    // The agent system is not installed: fake the transitions.
    app.world_mut().get_mut::<NavAgentState>(e).unwrap().status = NavStatus::Moving;
    app.update();
    app.world_mut().get_mut::<NavAgentState>(e).unwrap().status = NavStatus::Arrived;
    app.world_mut().get_mut::<NavAgentState>(e).unwrap().needs_path = false;
    app.update();
    app.update();
    assert_eq!(get_member(app.world(), e, "arrived"), Some(Value::Num(1.0)));
    assert_eq!(call(app.world_mut(), e, "st", &[]).unwrap(), Value::text("arrived"));
    assert_eq!(call(app.world_mut(), e, "done", &[]).unwrap(), Value::Bool(true));
    call(app.world_mut(), e, "go", &[]).unwrap();
    call(app.world_mut(), e, "halt", &[]).unwrap();
    assert_eq!(app.world().get::<NavAgentState>(e).unwrap().target, None);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}
