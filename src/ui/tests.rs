//! App-level tests: the whole UI kit on MinimalPlugins + StatesPlugin, no rendering.

use bevy::prelude::*;
use bevy::state::app::StatesPlugin;

use super::UiKitPlugin;
use super::menus::{MenuAction, MenuEvent};
use super::screens::{RegisterScreen, ScreenRequest, ScreenRoot, Screens};
use super::settings_screen::RegisterSettingsUi;
use super::toast::Toast;
use super::widgets::*;
use crate::flow::{AppState, PauseAllowed};
use crate::pause::Paused;
use crate::settings::{CoreSettings, FieldDef, FieldKind, RegisterSettings, SaveSettings};

#[derive(Resource, Default)]
struct Demo {
    vol: f32,
    on: bool,
    pick: usize,
}

/// Resource deliberately missing from the reset defaults.
#[derive(Resource)]
struct Other(f32);

#[derive(Resource, Default)]
struct Log {
    events: Vec<&'static str>,
    saves: usize,
}

fn record(mut ev: MessageReader<MenuEvent>, mut saves: MessageReader<SaveSettings>, mut log: ResMut<Log>) {
    log.events.extend(ev.read().map(|e| e.0));
    log.saves += saves.read().count();
}

fn pct(v: f32) -> String {
    format!("{:.0}%", v * 100.0)
}

fn build_results(world: &mut World, root: Entity) {
    world.commands().entity(root).with_children(|p| {
        p.spawn(Text::new("results"));
    });
}

fn app() -> App {
    let mut app = App::new();
    app.add_plugins((MinimalPlugins, StatesPlugin));
    app.insert_resource(CoreSettings::default())
        .insert_resource(Demo { vol: 0.5, on: false, pick: 0 })
        .insert_resource(Other(0.3))
        .init_resource::<Log>();
    app.register_setting(FieldDef {
        key: "vol",
        tab: "Audio",
        label: "Volume",
        hint: "",
        kind: FieldKind::Slider { min: 0.0, max: 1.0, step: 0.1, format: pct },
        get: |w| w.resource::<Demo>().vol,
        set: |w, v| w.resource_mut::<Demo>().vol = v,
    })
    .register_setting(FieldDef {
        key: "on",
        tab: "Audio",
        label: "Thing",
        hint: "Turns the thing on.",
        kind: FieldKind::Toggle,
        get: |w| if w.resource::<Demo>().on { 1.0 } else { 0.0 },
        set: |w, v| w.resource_mut::<Demo>().on = v > 0.5,
    })
    .register_setting(FieldDef {
        key: "other",
        tab: "Audio",
        label: "Other",
        hint: "",
        kind: FieldKind::Slider { min: 0.0, max: 1.0, step: 0.1, format: pct },
        get: |w| w.resource::<Other>().0,
        set: |w, v| w.resource_mut::<Other>().0 = v,
    })
    .register_setting(FieldDef {
        key: "pick",
        tab: "Video",
        label: "Pick",
        hint: "",
        kind: FieldKind::Choice { options: vec!["A", "B", "C"] },
        get: |w| w.resource::<Demo>().pick as f32,
        set: |w, v| w.resource_mut::<Demo>().pick = v as usize,
    });
    app.add_plugins(UiKitPlugin)
        .settings_defaults::<Demo>()
        .register_sticky_screen("results", build_results)
        .init_state::<AppState>()
        .add_systems(Last, record);
    app.update();
    app
}

fn goto(app: &mut App, s: AppState) {
    app.world_mut().resource_mut::<NextState<AppState>>().set(s);
    app.update();
}

fn nav(app: &mut App, inputs: &[NavInput]) {
    for i in inputs {
        app.world_mut().resource_mut::<NavQueue>().0.push(*i);
        app.update();
    }
}

fn act(app: &mut App, a: impl Into<UiAction>) {
    app.world_mut().write_message(UiActivated(a.into()));
    app.update();
}

fn stack(app: &App) -> Vec<&'static str> {
    app.world().resource::<Screens>().stack.clone()
}

fn count<C: Component>(app: &mut App) -> usize {
    app.world_mut().query::<&C>().iter(app.world()).count()
}

fn focused_order(app: &App) -> Option<u32> {
    let e = app.world().resource::<Focus>().0?;
    app.world().get::<Focusable>(e).map(|f| f.order)
}

fn state(app: &App) -> AppState {
    *app.world().resource::<State<AppState>>().get()
}

#[test]
fn main_menu_settings_round_trip() {
    let mut app = app();
    goto(&mut app, AppState::MainMenu);
    assert_eq!(stack(&app), ["main"]);
    assert_eq!(count::<ScreenRoot>(&mut app), 1);
    assert_eq!(count::<Focusable>(&mut app), 3, "Play, Settings, Quit");

    nav(&mut app, &[NavInput::Down]);
    assert_eq!(focused_order(&app), Some(2));
    nav(&mut app, &[NavInput::Accept]);
    assert_eq!(stack(&app), ["main", "settings"]);
    assert_eq!(count::<ScreenRoot>(&mut app), 1, "only the top screen is built");
    assert_eq!(count::<FieldRow>(&mut app), 3, "Audio tab rows from the registry");

    nav(&mut app, &[NavInput::NextTab]);
    assert_eq!(app.world().resource::<Screens>().tab, 1);
    assert_eq!(count::<FieldRow>(&mut app), 1, "Video tab");
    nav(&mut app, &[NavInput::NextTab]);
    assert_eq!(app.world().resource::<Screens>().tab, 0, "tabs wrap");

    let saves = app.world().resource::<Log>().saves;
    nav(&mut app, &[NavInput::Back]);
    assert_eq!(stack(&app), ["main"]);
    assert!(app.world().resource::<Log>().saves > saves, "leaving settings saves");
    assert_eq!(focused_order(&app), Some(2), "focus returns to Settings");
}

#[test]
fn rows_edit_fields_through_the_registry() {
    let mut app = app();
    goto(&mut app, AppState::MainMenu);
    act(&mut app, MenuAction::Settings);
    assert_eq!(focused_order(&app), Some(1));
    nav(&mut app, &[NavInput::Right]);
    assert!((app.world().resource::<Demo>().vol - 0.6).abs() < 1e-5);
    nav(&mut app, &[NavInput::Left, NavInput::Left]);
    assert!((app.world().resource::<Demo>().vol - 0.4).abs() < 1e-5);
    assert!(app.world().resource::<Log>().saves > 0, "edits ask for a save");

    nav(&mut app, &[NavInput::Down, NavInput::Accept]);
    assert!(app.world().resource::<Demo>().on, "Enter toggles");
    nav(&mut app, &[NavInput::Right]);
    assert!(app.world().resource::<Demo>().on, "Right keeps it on");
    nav(&mut app, &[NavInput::Left]);
    assert!(!app.world().resource::<Demo>().on);

    // Shown values follow the settings even when changed elsewhere.
    app.world_mut().resource_mut::<Demo>().vol = 0.9;
    app.update();
    let shown: Vec<String> = app.world_mut().query::<(&FieldValue, &Text)>().iter(app.world()).filter(|(f, _)| f.0 == "vol").map(|(_, t)| t.0.clone()).collect();
    assert_eq!(shown, ["90%"]);

    assert_eq!(set_field(app.world_mut(), "vol", 7.0), Ok(1.0));
    assert_eq!(app.world().resource::<Demo>().vol, 1.0);
    assert!(set_field(app.world_mut(), "nope", 1.0).is_err());
    assert_eq!(get_field(app.world(), "pick"), Some(0.0));
}

#[test]
fn reset_tab_uses_registered_defaults() {
    let mut app = app();
    goto(&mut app, AppState::MainMenu);
    act(&mut app, MenuAction::Settings);
    app.world_mut().resource_mut::<Demo>().vol = 0.8;
    app.world_mut().resource_mut::<Demo>().on = true;
    act(&mut app, UiAction::ResetTab);
    let d = app.world().resource::<Demo>();
    assert_eq!((d.vol, d.on), (0.0, false));
    assert_eq!(app.world().resource::<Other>().0, 0.3, "fields without a default are left alone");
}

#[test]
fn pause_flow_in_game() {
    let mut app = app();
    goto(&mut app, AppState::MainMenu);
    act(&mut app, MenuAction::Play);
    app.update();
    assert_eq!(state(&app), AppState::InGame);
    assert!(stack(&app).is_empty());
    assert_eq!(count::<ScreenRoot>(&mut app), 0, "no screen in play");

    nav(&mut app, &[NavInput::Back]);
    assert_eq!(stack(&app), ["pause"]);
    assert!(app.world().resource::<Paused>().0);
    assert!(app.world().resource::<Time<Virtual>>().is_paused());
    assert!(app.world().resource::<Log>().events.contains(&"pause"));

    act(&mut app, MenuAction::Settings);
    assert_eq!(stack(&app), ["pause", "settings"]);
    nav(&mut app, &[NavInput::Back]);
    assert_eq!(stack(&app), ["pause"]);
    assert!(app.world().resource::<Paused>().0, "still paused under settings");
    nav(&mut app, &[NavInput::Back]);
    assert!(stack(&app).is_empty());
    assert!(!app.world().resource::<Paused>().0);
    assert!(!app.world().resource::<Time<Virtual>>().is_paused());
    assert!(app.world().resource::<Log>().events.contains(&"resume"));

    app.world_mut().resource_mut::<PauseAllowed>().0 = false;
    nav(&mut app, &[NavInput::Back]);
    assert!(stack(&app).is_empty(), "PauseAllowed(false) blocks Esc");
    app.world_mut().resource_mut::<PauseAllowed>().0 = true;

    app.world_mut().write_message(ScreenRequest::Push("results"));
    app.update();
    nav(&mut app, &[NavInput::Back]);
    assert_eq!(stack(&app), ["results"], "sticky screen stays");
    app.world_mut().write_message(ScreenRequest::Replace(None));
    app.update();

    nav(&mut app, &[NavInput::Back]);
    act(&mut app, MenuAction::Custom("restart"));
    assert!(app.world().resource::<Log>().events.contains(&"restart"));
    act(&mut app, MenuAction::MainMenu);
    app.update();
    assert_eq!(state(&app), AppState::MainMenu);
    assert_eq!(stack(&app), ["main"]);
    assert!(!app.world().resource::<Paused>().0, "leaving the game unpauses");
    assert!(app.world().resource::<Log>().events.contains(&"main_menu"));
}

#[test]
fn toasts_show_up() {
    let mut app = app();
    app.world_mut().write_message(Toast::new("Saved").body("All good"));
    app.update();
    let texts: Vec<String> = app.world_mut().query::<&Text>().iter(app.world()).map(|t| t.0.clone()).collect();
    assert!(texts.iter().any(|t| t == "SAVED"));
    assert!(texts.iter().any(|t| t == "All good"));
}
