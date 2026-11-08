use super::tests::{app, errors};
use super::*;
use crate::ui2::{Ui2Plugin, UiData, UiEvent, UiEventKind};

#[test]
fn scripts_set_data_and_receive_component_events() {
    let src = "got = \"\";\narg = 0;\nread = 0;\nfn _ready() { ui_on(\"go\", \"h\"); ui_data_set(\"n\", 3); read = ui_data_get(\"n\"); }\nfn h(kind, a) { got = kind; arg = a; }\n";
    let mut app = app("ui2", &[("u.ruspy", src)]);
    app.add_plugins(Ui2Plugin);
    let e = app.world_mut().spawn(Script::new("u.ruspy")).id();
    app.update();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(app.world().resource::<UiData>().f64("n"), 3.0);
    assert_eq!(get_member(app.world(), e, "read"), Some(Value::Num(3.0)));
    app.world_mut().write_message(UiEvent { id: "go".into(), kind: UiEventKind::Tab(2), entity: Entity::PLACEHOLDER });
    app.world_mut().write_message(UiEvent { id: "other".into(), kind: UiEventKind::Activate, entity: Entity::PLACEHOLDER });
    app.update();
    assert_eq!(get_member(app.world(), e, "got"), Some(Value::text("tab")));
    assert_eq!(get_member(app.world(), e, "arg"), Some(Value::Num(2.0)));
}
