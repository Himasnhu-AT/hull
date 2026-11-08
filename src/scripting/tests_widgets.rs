use bevy::input::ButtonState;
use bevy::input::keyboard::{Key, KeyboardInput};
use bevy::input::mouse::{MouseButtonInput, MouseMotion, MouseWheel};
use bevy::picking::hover::Hovered;
use bevy::ui::{InteractionDisabled, Pressed, RelativeCursorPosition};

use super::tests::{app, errors};
use super::ui_widgets::*;
use super::*;
use ruspy::value::Value as RV;

const FORM: &str = r#"
box = 0; slider = 0; edit = 0; opt = 0; tabs = 0; btn = 0; page0 = 0; page1 = 0;
log_ = "";
fn _ready() {
    p = ui_vbox(self());
    box = ui_checkbox(p, "Fullscreen");
    slider = ui_slider(p, 0, 10, 5, 1);
    edit = ui_line_edit(p, "name");
    opt = ui_option_button(p, ["Low", "Medium", "High"]);
    btn = ui_button(p, "OK");
    tabs = ui_tabs(p, ["A", "B"]);
    page0 = ui_panel(tabs);
    page1 = ui_panel(tabs);
    connect(box, "toggled", self(), "on_toggled");
    connect(slider, "value_changed", self(), "on_value");
    connect(edit, "text_changed", self(), "on_text");
    connect(edit, "text_submitted", self(), "on_submit");
    connect(opt, "item_selected", self(), "on_item");
    connect(tabs, "tab_changed", self(), "on_tab");
    connect(btn, "pressed", self(), "on_btn");
}
fn on_toggled(v) { log_ = log_ + "toggled:" + tostr(v) + ";"; }
fn on_value(v) { log_ = log_ + "value:" + tostr(v) + ";"; }
fn on_text(t) { log_ = log_ + "text:" + t + ";"; }
fn on_submit(t) { log_ = log_ + "submit:" + t + ";"; }
fn on_item(i) { log_ = log_ + "item:" + tostr(i) + ";"; }
fn on_tab(i) { log_ = log_ + "tab:" + tostr(i) + ";"; }
fn on_btn() { log_ = log_ + "btn" + ";"; }
fn checked() { return is_checked(box); }
fn value() { return get_value(slider); }
fn txt() { return get_text(edit); }
fn selected() { return get_selected(opt); }
fn tab() { return get_current_tab(tabs); }
fn set_box(b) { set_checked(box, b); }
fn set_val(v) { set_value(slider, v); }
fn set_txt(t) { set_text(edit, t); }
fn pick(i) { select(opt, i); }
fn focus_edit() { grab_focus(edit); }
fn edit_focused() { return has_focus(edit); }
"#;

fn form(tag: &str) -> (App, Entity) {
    let mut app = app(tag, &[("form.ruspy", FORM)]);
    app.init_resource::<ButtonInput<MouseButton>>().init_resource::<ButtonInput<KeyCode>>();
    let e = app.world_mut().spawn((Name::new("Form"), Node::default(), Script::new("form.ruspy"))).id();
    app.update();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    (app, e)
}

fn member(app: &App, e: Entity, name: &str) -> Entity {
    match get_member(app.world(), e, name) {
        Some(Value::Entity(b)) => Entity::from_bits(b),
        Some(Value::Num(n)) => Entity::from_bits(n as u64),
        other => panic!("{name}: {other:?}"),
    }
}

fn logs_of(app: &mut App, e: Entity) -> Vec<String> {
    list(app, e, "log_")
}

fn press(app: &mut App, e: Entity) {
    app.world_mut().entity_mut(e).insert(Pressed);
    app.update();
    if let Ok(mut em) = app.world_mut().get_entity_mut(e) {
        em.remove::<Pressed>();
    }
    app.update();
}

fn type_key(app: &mut App, key: Key, text: Option<&str>) {
    app.world_mut().write_message(KeyboardInput {
        key_code: KeyCode::KeyA,
        logical_key: key,
        state: ButtonState::Pressed,
        text: text.map(Into::into),
        repeat: false,
        window: Entity::PLACEHOLDER,
    });
    app.update();
}

#[test]
fn checkbox_toggles_and_emits() {
    let (mut app, e) = form("checkbox");
    let b = member(&app, e, "box");
    assert_eq!(call(app.world_mut(), e, "checked", &[]).unwrap(), Value::Bool(false));
    press(&mut app, b);
    assert_eq!(call(app.world_mut(), e, "checked", &[]).unwrap(), Value::Bool(true));
    call(app.world_mut(), e, "set_box", &[Value::Bool(false)]).unwrap();
    app.update(); // the handler runs at the end of the frame (the caller is the handler)
    call(app.world_mut(), e, "set_box", &[Value::Bool(false)]).unwrap(); // no change, no signal
    app.update();
    assert_eq!(logs_of(&mut app, e), vec!["toggled:true", "toggled:false"]);
    // The mark follows the state, a disabled box ignores presses.
    app.world_mut().entity_mut(b).insert(InteractionDisabled);
    press(&mut app, b);
    assert!(!app.world().get::<UiCheckbox>(b).unwrap().checked);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
fn slider_snaps_clamps_and_drags() {
    let (mut app, e) = form("slider");
    let s = member(&app, e, "slider");
    assert_eq!(call(app.world_mut(), e, "value", &[]).unwrap(), Value::Num(5.0));
    call(app.world_mut(), e, "set_val", &[Value::Num(7.4)]).unwrap();
    app.update();
    assert_eq!(call(app.world_mut(), e, "value", &[]).unwrap(), Value::Num(7.0));
    call(app.world_mut(), e, "set_val", &[Value::Num(99.0)]).unwrap();
    app.update();
    assert_eq!(call(app.world_mut(), e, "value", &[]).unwrap(), Value::Num(10.0));
    // Mouse drag: cursor at 30% of the track (normalized is centred: -0.5..0.5).
    app.world_mut().get_mut::<RelativeCursorPosition>(s).unwrap().normalized = Some(Vec2::new(-0.2, 0.0));
    app.world_mut().resource_mut::<ButtonInput<MouseButton>>().press(MouseButton::Left);
    app.world_mut().entity_mut(s).insert(Pressed);
    app.update();
    assert_eq!(app.world().get::<UiSlider>(s).unwrap().value, 3.0);
    // Releasing the button stops the drag.
    app.world_mut().resource_mut::<ButtonInput<MouseButton>>().release(MouseButton::Left);
    app.world_mut().get_mut::<RelativeCursorPosition>(s).unwrap().normalized = Some(Vec2::new(0.4, 0.0));
    app.update();
    assert_eq!(app.world().get::<UiSlider>(s).unwrap().value, 3.0);
    assert_eq!(logs_of(&mut app, e), vec!["value:7", "value:10", "value:3"]);
    // The fill follows.
    let fill = app.world().get::<Children>(s).unwrap().iter().find(|c| app.world().get::<UiSliderFill>(*c).is_some()).unwrap();
    assert!(matches!(app.world().get::<Node>(fill).unwrap().width, Val::Percent(p) if (p - 30.0).abs() < 0.01));
}

#[test]
fn line_edit_takes_the_keyboard_when_focused() {
    let (mut app, e) = form("lineedit");
    let ed = member(&app, e, "edit");
    // Not focused: keys go nowhere.
    type_key(&mut app, Key::Character("x".into()), Some("x"));
    assert_eq!(call(app.world_mut(), e, "txt", &[]).unwrap(), Value::text(""));
    press(&mut app, ed);
    assert_eq!(call(app.world_mut(), e, "edit_focused", &[]).unwrap(), Value::Bool(true));
    assert!(app.world().resource::<UiCapture>().keyboard);
    type_key(&mut app, Key::Character("h".into()), Some("h"));
    type_key(&mut app, Key::Character("i".into()), Some("i"));
    type_key(&mut app, Key::Space, Some(" "));
    type_key(&mut app, Key::Backspace, None);
    type_key(&mut app, Key::Enter, None);
    assert_eq!(call(app.world_mut(), e, "txt", &[]).unwrap(), Value::text("hi"));
    assert_eq!(logs_of(&mut app, e), vec!["text:h", "text:hi", "text:hi ", "text:hi", "submit:hi"]);
    // The child shows a caret while focused, set_text does not emit.
    call(app.world_mut(), e, "set_txt", &[Value::text("abc")]).unwrap();
    app.update();
    let shown = app.world().get::<Children>(ed).unwrap().iter().find_map(|c| app.world().get::<Text>(c)).unwrap().0.clone();
    assert_eq!(shown, "abc|");
    assert_eq!(logs_of(&mut app, e).len(), 5);
    // Focus elsewhere: placeholder / value shown, no caret.
    let b = member(&app, e, "btn");
    press(&mut app, b);
    assert!(!app.world().resource::<UiCapture>().keyboard);
    let shown = app.world().get::<Children>(ed).unwrap().iter().find_map(|c| app.world().get::<Text>(c)).unwrap().0.clone();
    assert_eq!(shown, "abc");
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
fn option_button_opens_selects_and_closes() {
    let (mut app, e) = form("option");
    let o = member(&app, e, "opt");
    press(&mut app, o);
    assert!(app.world().get::<UiOption>(o).unwrap().open);
    app.update();
    let items: Vec<Entity> = {
        let w = app.world_mut();
        w.query::<(Entity, &UiOptionItem)>().iter(w).map(|(e, _)| e).collect()
    };
    assert_eq!(items.len(), 3);
    let high = items.iter().copied().find(|i| app.world().get::<UiOptionItem>(*i).unwrap().index == 2).unwrap();
    press(&mut app, high);
    app.update();
    assert!(!app.world().get::<UiOption>(o).unwrap().open);
    assert_eq!(call(app.world_mut(), e, "selected", &[]).unwrap(), Value::Num(2.0));
    assert_eq!(get_text_of(&app, o), "High");
    let arrow = app.world().get::<Children>(o).unwrap().iter().filter_map(|c| app.world().get::<Text>(c)).nth(1).unwrap().0.clone();
    assert_eq!(arrow, "v", "the arrow keeps its glyph");
    assert_eq!(app.world_mut().query::<&UiOptionItem>().iter(app.world()).count(), 0, "list closed");
    call(app.world_mut(), e, "pick", &[Value::Num(1.0)]).unwrap(); // select() is silent
    app.update();
    assert_eq!(get_text_of(&app, o), "Medium");
    assert_eq!(logs_of(&mut app, e), vec!["item:2"]);
    assert!(call(app.world_mut(), e, "pick", &[Value::Num(9.0)]).is_err());
}

fn get_text_of(app: &App, e: Entity) -> String {
    app.world().get::<Children>(e).unwrap().iter().find_map(|c| app.world().get::<Text>(c)).unwrap().0.clone()
}

#[test]
fn tabs_show_the_selected_page() {
    let (mut app, e) = form("tabs");
    let (t, p0, p1) = (member(&app, e, "tabs"), member(&app, e, "page0"), member(&app, e, "page1"));
    app.update();
    let display = |app: &App, p: Entity| app.world().get::<Node>(p).unwrap().display;
    assert_eq!((display(&app, p0), display(&app, p1)), (Display::Flex, Display::None));
    let bar = app.world().get::<Children>(t).unwrap()[0];
    let tab_b = app.world().get::<Children>(bar).unwrap()[1];
    press(&mut app, tab_b);
    assert_eq!((display(&app, p0), display(&app, p1)), (Display::None, Display::Flex));
    assert_eq!(call(app.world_mut(), e, "tab", &[]).unwrap(), Value::Num(1.0));
    assert_eq!(logs_of(&mut app, e), vec!["tab:1"]);
}

#[test]
fn tab_and_arrow_keys_move_focus_and_adjust_widgets() {
    let (mut app, e) = form("nav");
    let (b, s, ed) = (member(&app, e, "box"), member(&app, e, "slider"), member(&app, e, "edit"));
    let key = |app: &mut App, k: KeyCode| {
        let mut input = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
        let shift = input.pressed(KeyCode::ShiftLeft);
        input.reset_all();
        if shift {
            input.press(KeyCode::ShiftLeft);
        }
        input.press(k);
        app.update();
    };
    // Arrows without focus belong to the game.
    key(&mut app, KeyCode::ArrowDown);
    assert_eq!(app.world().resource::<UiFocus>().0, None);
    key(&mut app, KeyCode::Tab);
    assert_eq!(app.world().resource::<UiFocus>().0, Some(b));
    key(&mut app, KeyCode::Enter);
    assert!(app.world().get::<UiCheckbox>(b).unwrap().checked);
    key(&mut app, KeyCode::ArrowDown);
    assert_eq!(app.world().resource::<UiFocus>().0, Some(s));
    key(&mut app, KeyCode::ArrowRight);
    key(&mut app, KeyCode::ArrowRight);
    key(&mut app, KeyCode::ArrowLeft);
    assert_eq!(app.world().get::<UiSlider>(s).unwrap().value, 6.0);
    key(&mut app, KeyCode::Tab);
    assert_eq!(app.world().resource::<UiFocus>().0, Some(ed));
    // Shift+Tab goes back.
    app.world_mut().resource_mut::<ButtonInput<KeyCode>>().press(KeyCode::ShiftLeft);
    key(&mut app, KeyCode::Tab);
    assert_eq!(app.world().resource::<UiFocus>().0, Some(s));
    // The focused widget is outlined.
    assert!(app.world().get::<bevy::ui::Outline>(s).is_some() && app.world().get::<bevy::ui::Outline>(b).is_none());
    // A button activates with Enter.
    let btn = member(&app, e, "btn");
    call(app.world_mut(), e, "focus_edit", &[]).unwrap();
    app.world_mut().resource_mut::<UiFocus>().0 = Some(btn);
    app.world_mut().resource_mut::<ButtonInput<KeyCode>>().release(KeyCode::ShiftLeft);
    key(&mut app, KeyCode::Enter);
    assert!(logs_of(&mut app, e).contains(&"btn".to_string()));
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

const EVENTS: &str = r#"
seen = "";
un = "";
handle = false;
fn _input_event(ev) {
    seen = seen + ev[0] + ";";
    if handle { set_input_as_handled(); }
}
fn _unhandled_input_event(ev) { un = un + ev[0] + ";"; }
fn set_handle(b) { handle = b; }
"#;

fn events_app(tag: &str) -> (App, Entity) {
    let mut app = app(tag, &[("ev.ruspy", EVENTS), ("form.ruspy", FORM)]);
    app.init_resource::<ButtonInput<MouseButton>>().init_resource::<ButtonInput<KeyCode>>();
    let e = app.world_mut().spawn((Name::new("Ev"), Script::new("ev.ruspy"))).id();
    app.update();
    (app, e)
}

fn list(app: &App, e: Entity, name: &str) -> Vec<String> {
    match get_member_rv(app.world(), e, name) {
        Ok(RV::Str(t)) => t.split(';').filter(|x| !x.is_empty()).map(String::from).collect(),
        other => panic!("{other:?}"),
    }
}

#[test]
fn raw_events_arrive_as_arrays_and_gui_gets_first_refusal() {
    let (mut app, e) = events_app("events");
    app.world_mut().write_message(KeyboardInput {
        key_code: KeyCode::KeyW,
        logical_key: Key::Character("w".into()),
        state: ButtonState::Pressed,
        text: None,
        repeat: false,
        window: Entity::PLACEHOLDER,
    });
    app.world_mut().write_message(MouseButtonInput { button: MouseButton::Left, state: ButtonState::Pressed, window: Entity::PLACEHOLDER });
    app.world_mut().write_message(MouseMotion { delta: Vec2::new(3.0, -2.0) });
    app.world_mut().write_message(MouseWheel { unit: bevy::input::mouse::MouseScrollUnit::Line, x: 0.0, y: 1.0, window: Entity::PLACEHOLDER, phase: bevy::input::touch::TouchPhase::Moved });
    app.update();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(list(&app, e, "seen"), vec!["key", "mouse_button", "mouse_motion", "mouse_wheel"]);
    assert_eq!(list(&app, e, "un"), list(&app, e, "seen"));
    assert_eq!(app.world().resource::<input_events::ScriptMouse>().delta, Vec2::new(3.0, -2.0));
    // A hovered button consumes pointer events; unhandled input does not see them.
    let ui = app.world_mut().spawn((Node::default(), bevy::ui_widgets::Button, Hovered(true))).id();
    app.world_mut().write_message(MouseButtonInput { button: MouseButton::Left, state: ButtonState::Released, window: Entity::PLACEHOLDER });
    app.world_mut().write_message(KeyboardInput {
        key_code: KeyCode::KeyW,
        logical_key: Key::Character("w".into()),
        state: ButtonState::Released,
        text: None,
        repeat: false,
        window: Entity::PLACEHOLDER,
    });
    app.update();
    assert_eq!(list(&app, e, "seen").len(), 6);
    assert_eq!(list(&app, e, "un").len(), 5, "only the key reached _unhandled_input_event");
    app.world_mut().despawn(ui);
    // set_input_as_handled stops delivery to _unhandled.
    call(app.world_mut(), e, "set_handle", &[Value::Bool(true)]).unwrap();
    app.world_mut().write_message(MouseWheel { unit: bevy::input::mouse::MouseScrollUnit::Line, x: 0.0, y: -1.0, window: Entity::PLACEHOLDER, phase: bevy::input::touch::TouchPhase::Moved });
    app.update();
    assert_eq!(list(&app, e, "seen").len(), 7);
    assert_eq!(list(&app, e, "un").len(), 5);
    // The delta resets when nothing moved.
    app.update();
    assert_eq!(app.world().resource::<input_events::ScriptMouse>().delta, Vec2::ZERO);
}

#[test]
fn a_focused_line_edit_hides_keys_from_unhandled_input() {
    let (mut app, e) = events_app("capture");
    let edit = app.world_mut().spawn((Node::default(), UiFocusable, UiLineEdit::default())).id();
    app.world_mut().resource_mut::<UiFocus>().0 = Some(edit);
    app.world_mut().write_message(KeyboardInput {
        key_code: KeyCode::KeyA,
        logical_key: Key::Character("a".into()),
        state: ButtonState::Pressed,
        text: Some("a".into()),
        repeat: false,
        window: Entity::PLACEHOLDER,
    });
    app.update();
    assert_eq!(list(&app, e, "seen"), vec!["key"], "_input_event still sees it");
    assert!(list(&app, e, "un").is_empty());
    assert_eq!(app.world().get::<UiLineEdit>(edit).unwrap().text, "a");
}

#[test]
fn layout_containers_build() {
    let src = r#"
g = 0; sc = 0; m = 0;
fn _ready() {
    g = ui_grid(self(), 3);
    sc = ui_scroll(self());
    m = ui_margin(self(), 12);
}
"#;
    let mut app = app("containers", &[("c.ruspy", src)]);
    let e = app.world_mut().spawn((Name::new("C"), Node::default(), Script::new("c.ruspy"))).id();
    app.update();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    let (g, sc, m) = (member(&app, e, "g"), member(&app, e, "sc"), member(&app, e, "m"));
    assert_eq!(app.world().get::<Node>(g).unwrap().display, Display::Grid);
    assert!(app.world().get::<UiScroll>(sc).is_some() && app.world().get::<Node>(sc).unwrap().overflow.y == OverflowAxis::Scroll);
    assert_eq!(app.world().get::<Node>(m).unwrap().padding, UiRect::all(Val::Px(12.0)));
}

#[test]
fn set_value_drives_progress_bars() {
    let src = "p = 0;\nfn _ready() { p = ui_progress(self(), 0.25); }\nfn bump() { set_value(p, 0.75); return get_value(p); }\n";
    let mut app = app("progress", &[("p.ruspy", src)]);
    let e = app.world_mut().spawn((Name::new("P"), Node::default(), Script::new("p.ruspy"))).id();
    app.update();
    assert_eq!(call(app.world_mut(), e, "bump", &[]).unwrap(), Value::Num(0.75));
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}
