use bevy::picking::hover::Hovered;
use bevy::ui::{InteractionDisabled, Pressed};

use super::tests::{app, errors};
use super::ui::UiProgress;
use super::*;

const HUD: &str = r#"
panel = 0;
lbl = 0;
btn = 0;
clicks = 0;
fn _ready() {
    panel = ui_panel(self());
    lbl = ui_label(panel, "idle");
    btn = ui_button(panel, "Go");
    connect(btn, "pressed", self(), "on_click");
}
fn on_click() {
    clicks = clicks + 1;
    set_text(lbl, "clicked " + tostr(clicks));
}
fn label_text() { return get_text(lbl); }
fn button_text() { return get_text(btn); }
fn set(prop, v) { ui_set(panel, prop, v); }
fn bg_red() { ui_set(panel, "bg", [1, 0, 0]); }
fn bg_none() { ui_set(panel, "bg", null); }
fn disable(on) { set_disabled(btn, on); }
"#;

fn hud(tag: &str) -> (App, Entity) {
    let mut app = app(tag, &[("hud.ruspy", HUD)]);
    let e = app.world_mut().spawn((Name::new("HUD"), Node::default(), Script::new("hud.ruspy"))).id();
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

fn text(app: &App, e: Entity) -> String {
    app.world().get::<Text>(e).unwrap().0.clone()
}

#[test]
fn button_pressed_runs_method_and_set_text_changes_label() {
    let (mut app, e) = hud("press");
    let (lbl, btn) = (member(&app, e, "lbl"), member(&app, e, "btn"));
    assert_eq!(text(&app, lbl), "idle");
    assert!(app.world().get::<bevy::ui_widgets::Button>(btn).is_some() && app.world().get::<Hovered>(btn).is_some());
    app.world_mut().entity_mut(btn).insert(Pressed);
    app.update();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(get_member(app.world(), e, "clicks"), Some(Value::Num(1.0)));
    assert_eq!(text(&app, lbl), "clicked 1");
    // Paths work on script-built UI.
    assert_eq!(resolve_path(app.world(), e, "Panel/Button/Label").map(|l| text(&app, l)), Some("Go".to_string()));
    assert_eq!(call(app.world_mut(), e, "button_text", &[]).unwrap(), Value::text("Go"));
    assert_eq!(call(app.world_mut(), e, "label_text", &[]).unwrap(), Value::text("clicked 1"));
}

#[test]
fn disabled_buttons_do_not_emit() {
    let (mut app, e) = hud("disabled");
    let btn = member(&app, e, "btn");
    call(app.world_mut(), e, "disable", &[Value::Bool(true)]).unwrap();
    assert!(app.world().get::<InteractionDisabled>(btn).is_some());
    app.world_mut().entity_mut(btn).insert(Pressed);
    app.update();
    assert_eq!(get_member(app.world(), e, "clicks"), Some(Value::Num(0.0)));
    // Dimmed look.
    let look = app.world().get::<ui::UiButton>(btn).unwrap().clone();
    assert!(app.world().get::<BackgroundColor>(btn).unwrap().0.alpha() < look.idle.alpha());
    // Re-enabled: a fresh press emits.
    call(app.world_mut(), e, "disable", &[Value::Bool(false)]).unwrap();
    app.world_mut().entity_mut(btn).remove::<Pressed>();
    app.update();
    app.world_mut().entity_mut(btn).insert(Pressed);
    app.update();
    assert_eq!(get_member(app.world(), e, "clicks"), Some(Value::Num(1.0)));
}

#[test]
fn hover_look_follows_state() {
    let (mut app, e) = hud("hover");
    let btn = member(&app, e, "btn");
    let look = app.world().get::<ui::UiButton>(btn).unwrap().clone();
    app.world_mut().entity_mut(btn).insert(Hovered(true));
    app.update();
    assert_eq!(app.world().get::<BackgroundColor>(btn).unwrap().0, look.hot);
    app.world_mut().entity_mut(btn).insert(Pressed);
    app.update();
    assert_eq!(app.world().get::<BackgroundColor>(btn).unwrap().0, look.down);
}

fn set(app: &mut App, e: Entity, prop: &str, v: Value) {
    call(app.world_mut(), e, "set", &[Value::text(prop), v]).unwrap();
}

#[test]
fn ui_set_maps_to_node_fields() {
    let (mut app, e) = hud("props");
    let panel = member(&app, e, "panel");
    set(&mut app, e, "width", Value::Num(120.0));
    set(&mut app, e, "height", Value::text("50%"));
    set(&mut app, e, "margin", Value::Num(4.0));
    set(&mut app, e, "padding", Value::text("auto"));
    set(&mut app, e, "gap", Value::Num(7.0));
    set(&mut app, e, "left", Value::Num(3.0));
    {
        let n = app.world().get::<Node>(panel).unwrap();
        assert_eq!((n.width, n.height), (Val::Px(120.0), Val::Percent(50.0)));
        assert_eq!(n.margin, UiRect::all(Val::Px(4.0)));
        assert_eq!(n.padding, UiRect::all(Val::Auto));
        assert_eq!((n.row_gap, n.column_gap, n.left), (Val::Px(7.0), Val::Px(7.0), Val::Px(3.0)));
    }
    set(&mut app, e, "align", Value::text("center"));
    let n = app.world().get::<Node>(panel).unwrap();
    assert_eq!((n.align_items, n.justify_content), (AlignItems::Center, JustifyContent::Center));
    set(&mut app, e, "visible", Value::Bool(false));
    assert_eq!(app.world().get::<Node>(panel).unwrap().display, Display::None);
    set(&mut app, e, "visible", Value::Bool(true));
    assert_eq!(app.world().get::<Node>(panel).unwrap().display, Display::Flex);
    call(app.world_mut(), e, "bg_red", &[]).unwrap();
    assert_eq!(app.world().get::<BackgroundColor>(panel).unwrap().0, Color::srgba(1.0, 0.0, 0.0, 1.0));
    call(app.world_mut(), e, "bg_none", &[]).unwrap();
    assert!(app.world().get::<BackgroundColor>(panel).is_none());
    // Bad input is an error, not a panic.
    let err = call(app.world_mut(), e, "set", &[Value::text("nope"), Value::Num(1.0)]).unwrap_err();
    assert!(err.contains("unknown ui property"), "{err}");
}

#[test]
fn anchors_position_absolutely() {
    let (mut app, e) = hud("anchor");
    let panel = member(&app, e, "panel");
    set(&mut app, e, "anchor", Value::text("center"));
    let n = app.world().get::<Node>(panel).unwrap();
    assert_eq!(n.position_type, PositionType::Absolute);
    assert_eq!((n.left, n.top, n.right, n.bottom), (Val::Percent(50.0), Val::Percent(50.0), Val::Auto, Val::Auto));
    assert_eq!(app.world().get::<bevy::ui::UiTransform>(panel).unwrap().translation, bevy::ui::Val2::percent(-50.0, -50.0));
    set(&mut app, e, "anchor", Value::text("bottom_right"));
    let n = app.world().get::<Node>(panel).unwrap();
    assert_eq!((n.left, n.top, n.right, n.bottom), (Val::Auto, Val::Auto, Val::Px(0.0), Val::Px(0.0)));
    assert_eq!(app.world().get::<bevy::ui::UiTransform>(panel).unwrap().translation, bevy::ui::Val2::ZERO);
    set(&mut app, e, "anchor", Value::text("full"));
    let n = app.world().get::<Node>(panel).unwrap();
    assert_eq!((n.left, n.top, n.right, n.bottom), (Val::Px(0.0), Val::Px(0.0), Val::Px(0.0), Val::Px(0.0)));
}

#[test]
fn progress_font_color_and_roots() {
    let src = r#"
bar = 0;
root = 0;
lab = 0;
fn _ready() {
    root = ui_vbox(null);
    bar = ui_progress(root, 0.25);
    lab = ui_label(root, "x");
    set_text_color(lab, [1, 0, 0]);
}
fn go() { set_progress(bar, 2); set_font_size(lab, 30); }
"#;
    let mut app = app("misc", &[("m.ruspy", src)]);
    let e = app.world_mut().spawn((Name::new("M"), Script::new("m.ruspy"))).id();
    app.update();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    let (bar, root) = (member(&app, e, "bar"), member(&app, e, "root"));
    let n = app.world().get::<Node>(root).unwrap();
    assert_eq!((n.position_type, n.left, n.top), (PositionType::Absolute, Val::Px(0.0), Val::Px(0.0)));
    assert!(app.world().get::<ChildOf>(root).is_none());
    let fill = app.world().get::<Children>(bar).unwrap()[0];
    assert_eq!(app.world().get::<Node>(fill).unwrap().width, Val::Percent(25.0));
    let lab = member(&app, e, "lab");
    assert_eq!(app.world().get::<TextColor>(lab).unwrap().0, Color::srgba(1.0, 0.0, 0.0, 1.0));
    call(app.world_mut(), e, "go", &[]).unwrap();
    assert_eq!(app.world().get::<Node>(fill).unwrap().width, Val::Percent(100.0));
    assert_eq!(app.world().get::<UiProgress>(bar).unwrap().value, 1.0);
    assert_eq!(app.world().get::<TextFont>(lab).unwrap().font_size, bevy::text::FontSize::Rem(30.0 / crate::ui::theme::REM_PX));
}

/// UI in level files: every component the script UI API touches must be a reflected component
/// (the level format saves all registered reflect components of a `LevelEntity`).
#[test]
fn ui_components_are_reflect_components() {
    use bevy::reflect::GetTypeRegistration;
    fn comp<T: GetTypeRegistration>() -> bool {
        T::get_type_registration().data::<ReflectComponent>().is_some()
    }
    let results = [
        ("Node", comp::<Node>()),
        ("Text", comp::<Text>()),
        ("TextFont", comp::<TextFont>()),
        ("TextColor", comp::<TextColor>()),
        ("BackgroundColor", comp::<BackgroundColor>()),
        ("BorderColor", comp::<BorderColor>()),
        ("UiTransform", comp::<bevy::ui::UiTransform>()),
        ("Button", comp::<bevy::ui_widgets::Button>()),
        ("InteractionDisabled", comp::<InteractionDisabled>()),
        ("UiButton", comp::<ui::UiButton>()),
        ("UiProgress", comp::<ui::UiProgress>()),
        ("UiProgressFill", comp::<ui::UiProgressFill>()),
    ];
    let missing: Vec<_> = results.iter().filter(|(_, ok)| !ok).map(|(n, _)| *n).collect();
    assert!(missing.is_empty(), "not reflect components: {missing:?}");
}
