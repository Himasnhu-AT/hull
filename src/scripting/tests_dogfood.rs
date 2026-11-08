//! Fixes found while building examples/script_platformer.rs.

use super::tests::{app, errors};
use super::*;

#[test]
fn connection_to_a_freed_node_is_dropped_quietly() {
    let a = "signal(\"ping\");\nfn go() { emit_signal(\"ping\"); }\n";
    let b = "fn _ready() { connect(get_node(\"/A\"), \"ping\", self(), \"on_ping\"); }\nfn on_ping() { }\n";
    let mut app = app("stale", &[("a.ruspy", a), ("b.ruspy", b)]);
    let ea = app.world_mut().spawn((Name::new("A"), Script::new("a.ruspy"))).id();
    let eb = app.world_mut().spawn((Name::new("B"), Script::new("b.ruspy"))).id();
    app.update();
    assert_eq!(app.world().get::<Connections>(ea).map(|c| c.0.len()), Some(1));
    app.world_mut().entity_mut(eb).despawn();
    call(app.world_mut(), ea, "go", &[]).unwrap();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert!(app.world().get::<Connections>(ea).unwrap().0.is_empty());
}

#[test]
fn tween_callback_queue_free_and_ui_roots_follow_their_node() {
    let src = "fn go() { ui_label(null, \"hi\"); t = tween(); tween_interval(t, 0.01); tween_callback(t, \"queue_free\"); }\n";
    let mut app = app("uiowner", &[("u.ruspy", src)]);
    let e = app.world_mut().spawn(Script::new("u.ruspy")).id();
    app.update();
    call(app.world_mut(), e, "go", &[]).unwrap();
    assert_eq!(app.world_mut().query::<&ui::UiOwner>().iter(app.world()).count(), 1);
    for _ in 0..8 {
        std::thread::sleep(std::time::Duration::from_millis(5));
        app.update();
    }
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert!(app.world().get_entity(e).is_err(), "tween_callback(queue_free) freed the node");
    assert_eq!(app.world_mut().query::<&ui::UiOwner>().iter(app.world()).count(), 0, "its UI root went with it");
}
