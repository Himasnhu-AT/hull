//! Headless tests: screens build from RON, data binds, events and commands flow, files reload.

use bevy::prelude::*;

use super::components::*;
use super::*;
use crate::paths::AssetsDir;

fn app_with(tag: &str, files: &[(&str, &str)]) -> App {
    let dir = std::env::temp_dir().join(format!("ui2-test-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("ui")).unwrap();
    for (n, t) in files {
        std::fs::write(dir.join("ui").join(n), t).unwrap();
    }
    let mut app = App::new();
    app.add_plugins(MinimalPlugins);
    app.insert_resource(AssetsDir(dir));
    app.add_plugins(Ui2Plugin);
    app
}

const HUB: &str = r#"Screen(
    root: Column(gap: 12, children: [
        Header(name: "Rider One", subtitle: "Level {player.level}", stats: [Stat(label: "credits", value: "{player.credits}")]),
        TabBar(id: "main", tabs: [TabSpec(label: "Drive", badge: "n.drive"), TabSpec(label: "Garage")]),
        Grid(columns: 3, children: [
            Tile(id: "race", title: "Quick Race", subtitle: "Pick a track", badge: "n.race", action: Open("settings")),
            Tile(id: "garage", title: "Garage", accent: Tile(2), span: (2, 1)),
        ]),
        Text(text: "Tab two", show: Cond(key: "ui.tab.main", eq: 1)),
        KeyHints(hints: [Hint(action: "confirm", label: "Select"), Hint(action: "back", label: "Back")]),
    ]),
)"#;
const SETTINGS: &str = r#"Screen(root: Column(children: [Toggle(id: "vsync", label: "VSync", key: "opt.vsync"), Slider(id: "vol", label: "Volume", key: "opt.vol", min: 0, max: 10, step: 1, initial: 5)]))"#;

fn count<C: Component>(app: &mut App) -> usize {
    app.world_mut().query::<&C>().iter(app.world()).count()
}

fn open(app: &mut App, name: &str) {
    app.world_mut().resource_mut::<Ui2Cmds>().open(name);
    app.update();
}

#[test]
fn a_screen_file_builds_the_component_tree() {
    let mut app = app_with("build", &[("hub.ui.ron", HUB)]);
    app.world_mut().resource_mut::<UiData>().set("player.credits", 1200);
    open(&mut app, "hub");
    assert_eq!(app.world().resource::<Ui2Screens>().names(), ["hub"]);
    assert_eq!(count::<focus::Focusable2>(&mut app), 4, "2 tiles + 2 tabs");
    assert_eq!(count::<TabBar>(&mut app), 1);
    assert!(app.world().resource::<Ui2Diagnostics>().0.is_empty(), "{:?}", app.world().resource::<Ui2Diagnostics>().0);
    // Text templates resolve from the store.
    let texts: Vec<String> = app.world_mut().query::<&Text>().iter(app.world()).map(|t| t.0.clone()).collect();
    assert!(texts.iter().any(|t| t == "1200"), "{texts:?}");
    assert!(texts.iter().any(|t| t == "QUICK RACE"));
}

#[test]
fn bindings_follow_the_data_store() {
    let mut app = app_with("bind", &[("hub.ui.ron", HUB)]);
    open(&mut app, "hub");
    let credits = |app: &mut App| app.world_mut().query::<&Text>().iter(app.world()).any(|t| t.0 == "300");
    assert!(!credits(&mut app));
    app.world_mut().resource_mut::<UiData>().set("player.credits", 300);
    app.update();
    assert!(credits(&mut app));
    // A badge is hidden at 0 and shows its count otherwise.
    let badge_display = |app: &mut App| {
        let w = app.world_mut();
        let mut q = w.query::<(&Bind, &Node)>();
        q.iter(w).find(|(b, _)| b.template == "{n.race}").map(|(_, n)| n.display)
    };
    app.update();
    assert_eq!(badge_display(&mut app), Some(Display::None));
    app.world_mut().resource_mut::<UiData>().set("n.race", 3);
    app.update();
    assert_eq!(badge_display(&mut app), Some(Display::Flex));
}

#[test]
fn tabs_publish_their_index_and_gate_content() {
    let mut app = app_with("tabs", &[("hub.ui.ron", HUB)]);
    open(&mut app, "hub");
    app.update();
    let page = |app: &mut App| {
        let w = app.world_mut();
        let mut q = w.query::<(&Text, &Node)>();
        q.iter(w).find(|(t, _)| t.0 == "Tab two").map(|(_, n)| n.display)
    };
    assert_eq!(page(&mut app), Some(Display::None));
    app.world_mut().write_message(Nav2::NextTab);
    app.update();
    app.update();
    assert_eq!(app.world().resource::<UiData>().f64("ui.tab.main"), 1.0);
    assert_eq!(page(&mut app), Some(Display::Flex));
    app.world_mut().write_message(Nav2::NextTab);
    app.update();
    assert_eq!(app.world().resource::<UiData>().f64("ui.tab.main"), 0.0, "wraps");
}

#[test]
fn activating_a_tile_emits_an_event_and_opens_its_screen() {
    let mut app = app_with("open", &[("hub.ui.ron", HUB), ("settings.ui.ron", SETTINGS)]);
    open(&mut app, "hub");
    app.update();
    let id = |app: &mut App, want: &str| {
        let w = app.world_mut();
        let mut q = w.query::<(Entity, &focus::Focusable2)>();
        q.iter(w).find(|(_, f)| f.id == want).map(|(e, _)| e).unwrap()
    };
    let race = id(&mut app, "race");
    app.world_mut().resource_mut::<Ui2Focus>().0 = Some(race);
    app.world_mut().write_message(Nav2::Accept);
    app.update();
    app.update();
    assert_eq!(app.world().resource::<Ui2Screens>().names(), ["hub", "settings"]);
    assert_eq!(app.world().resource::<Ui2Screens>().top(), Some("settings"));
    // Back pops to the hub again (rebuilt) and the first page never pops.
    app.world_mut().write_message(Nav2::Back);
    app.update();
    app.update();
    assert_eq!(app.world().resource::<Ui2Screens>().names(), ["hub"]);
    app.world_mut().write_message(Nav2::Back);
    app.update();
    assert_eq!(app.world().resource::<Ui2Screens>().names(), ["hub"]);
}

#[test]
fn toggles_and_sliders_write_their_data_keys() {
    let mut app = app_with("controls", &[("settings.ui.ron", SETTINGS)]);
    open(&mut app, "settings");
    app.update();
    let find = |app: &mut App, id: &str| {
        let w = app.world_mut();
        let mut q = w.query::<(Entity, &focus::Focusable2)>();
        q.iter(w).find(|(_, f)| f.id == id).map(|(e, _)| e).unwrap()
    };
    let (vsync, vol) = (find(&mut app, "vsync"), find(&mut app, "vol"));
    app.world_mut().resource_mut::<Ui2Focus>().0 = Some(vsync);
    app.world_mut().write_message(Nav2::Accept);
    app.update();
    app.update();
    assert!(app.world().resource::<UiData>().truthy("opt.vsync"));
    // Left / Right on a focused slider adjusts it by a step instead of moving focus.
    app.world_mut().resource_mut::<Ui2Focus>().0 = Some(vol);
    app.world_mut().write_message(Nav2::Right);
    app.world_mut().write_message(Nav2::Right);
    app.world_mut().write_message(Nav2::Left);
    app.update();
    assert_eq!(app.world().resource::<UiData>().f64("opt.vol"), 6.0);
    assert_eq!(app.world().resource::<Ui2Focus>().0, Some(vol));
}

#[test]
fn errors_are_located() {
    let bad = "Screen(\n  root: Column(children: [\n    Tile(id: \"x\", titel: \"oops\"),\n  ]),\n)";
    let colour = r#"Screen(root: Column(children: [Tile(id: "t", accent: Token("nope"))]))"#;
    let mut app = app_with("errors", &[("bad.ui.ron", bad), ("colour.ui.ron", colour)]);
    open(&mut app, "bad");
    let d = app.world().resource::<Ui2Diagnostics>().0.clone();
    assert_eq!(d.len(), 1, "{d:?}");
    assert_eq!((d[0].file.as_str(), d[0].line), ("ui/bad.ui.ron", 3), "{d:?}");
    assert!(app.world().resource::<Ui2Screens>().stack.is_empty(), "a broken file opens nothing");
    open(&mut app, "colour");
    let d = app.world().resource::<Ui2Diagnostics>().0.clone();
    assert!(d.iter().any(|x| x.message.contains("unknown colour token") && x.message.contains("Tile(t)")), "{d:?}");
    assert_eq!(app.world().resource::<Ui2Screens>().names(), ["colour"], "opens with a fallback colour");
    open(&mut app, "missing");
    assert!(app.world().resource::<Ui2Diagnostics>().0.iter().any(|x| x.message.contains("can't read screen")));
}

#[test]
fn a_modal_scopes_focus_and_closes_with_back() {
    let modal = r#"Screen(root: Modal(id: "quit", title: "Quit?", buttons: [ModalButton(id: "yes", label: "Yes", action: Back), ModalButton(id: "no", label: "No", primary: true, action: Back)]))"#;
    let mut app = app_with("modal", &[("hub.ui.ron", HUB), ("quit.ui.ron", modal)]);
    open(&mut app, "hub");
    open(&mut app, "quit");
    app.update();
    app.update();
    assert_eq!(app.world().resource::<Ui2Screens>().names(), ["hub", "quit"]);
    let scope = app.world().resource::<focus::FocusScope>().0;
    assert!(scope.is_some(), "focus is trapped in the modal");
    let f = app.world().resource::<Ui2Focus>().0.unwrap();
    assert!(app.world().get::<focus::Focusable2>(f).is_some_and(|f| f.id == "yes" || f.id == "no"));
    app.world_mut().write_message(Nav2::Back);
    app.update();
    app.update();
    assert_eq!(app.world().resource::<Ui2Screens>().names(), ["hub"]);
    assert!(app.world().resource::<focus::FocusScope>().0.is_none());
    assert_eq!(count::<ModalRoot>(&mut app), 0);
}

#[test]
fn files_and_tokens_hot_reload() {
    let mut app = app_with("reload", &[("hub.ui.ron", HUB)]);
    open(&mut app, "hub");
    assert_eq!(count::<focus::Focusable2>(&mut app), 4);
    let dir = app.world().resource::<AssetsDir>().0.join("ui");
    let one = r#"Screen(root: Column(children: [Tile(id: "only", title: "Only")]))"#;
    // Rewrite with a different size so the mtime check cannot miss it; step real time past the poll.
    std::thread::sleep(std::time::Duration::from_millis(30));
    std::fs::write(dir.join("hub.ui.ron"), one).unwrap();
    std::fs::write(dir.join("tokens.ron"), "(colors: (accent: (1.0, 0.0, 0.0, 1.0)))").unwrap();
    for _ in 0..4 {
        app.world_mut().resource_mut::<Ui2Screens>().stack.iter_mut().for_each(|_| {});
        std::thread::sleep(std::time::Duration::from_millis(600));
        app.update();
    }
    assert_eq!(count::<focus::Focusable2>(&mut app), 1, "screen rebuilt from the new file");
    assert_eq!(app.world().resource::<Tokens>().colors.accent, tokens::Rgba(1.0, 0.0, 0.0, 1.0));
    // A broken edit keeps the old screen and reports where.
    std::fs::write(dir.join("hub.ui.ron"), "Screen(root: Column(children: [oops]))").unwrap();
    for _ in 0..3 {
        std::thread::sleep(std::time::Duration::from_millis(600));
        app.update();
    }
    assert_eq!(count::<focus::Focusable2>(&mut app), 1);
    assert!(app.world().resource::<Ui2Diagnostics>().0.iter().any(|d| d.file == "ui/hub.ui.ron" && d.line == 1));
}

#[test]
fn rust_built_screens_need_no_file() {
    let mut app = app_with("rust", &[]);
    let screen = Screen {
        root: El::Column(Container {
            children: vec![El::Tile(Tile { id: "a".into(), title: "A".into(), ..default() }), El::Button(ButtonEl { id: "b".into(), label: "B".into(), ..default() })],
            ..default()
        }),
        ..default()
    };
    app.world_mut().resource_mut::<Ui2Cmds>().show("code", screen);
    app.update();
    assert_eq!(count::<focus::Focusable2>(&mut app), 2);
    assert!(app.world().resource::<Ui2Diagnostics>().0.is_empty());
}
