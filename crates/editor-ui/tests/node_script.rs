//! Headless tests of the node script UI (Details Script section, members, Signals, Groups).

use editor_proto::*;
use editor_ui::mock::{CONNECTIONS, GROUPS, MockBackend, SCRIPT, SCRIPT_PROPS, TRANSFORM};
use editor_ui::{Command, EditorUi};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::{Value, json};

struct App {
    ui: EditorUi,
    backend: MockBackend,
}

const MENU_SCRIPT: &str = "// menu\nspeed = 5;\nlabel = \"hi\";\nsignal(\"started\");\nfn _ready() {\n}\nfn on_play(who) {\n}\n";

const HINTED: &str = "// @export_range(0, 10, 0.5)\n// @tooltip Metres per second\nspeed = 5;\n// @export_enum(\"easy\",\"hard\")\nmode = \"easy\";\n// @export_color\ntint = [1, 0, 0];\n_cache = 0;\nfn _ready() {\n}\n";

fn harness() -> Harness<'static, App> {
    let mut b = MockBackend::empty().with_scripting();
    let t = || (TRANSFORM, json!({"translation": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0, 1.0], "scale": [1.0, 1.0, 1.0]}));
    let menu = b.add("Menu", None, NodeKind::Mesh, false, vec![t(), (SCRIPT, json!({"path": "scripts/menu.ruspy", "priority": 0}))]);
    let start = b.add("Start", Some(menu), NodeKind::Mesh, false, vec![t()]);
    b.add("HUD", Some(menu), NodeKind::Mesh, false, vec![t(), (SCRIPT, json!({"path": "scripts/hud.ruspy", "priority": 0}))]);
    b.add("Plain", None, NodeKind::Mesh, false, vec![t()]);
    b.add("Hinted", None, NodeKind::Mesh, false, vec![t(), (SCRIPT, json!({"path": "scripts/hinted.ruspy", "priority": 0}))]);
    b.script_files.insert("scripts/hinted.ruspy".into(), HINTED.into());
    b.script_files.insert("scripts/menu.ruspy".into(), MENU_SCRIPT.into());
    b.script_files.insert("scripts/hud.ruspy".into(), "fn show_score(n) {\n}\n".into());
    b.script_files.insert("scripts/door.ruspy".into(), "fn _ready() {\n}\n".into());
    for n in ["menu", "hud", "door"] {
        b.logic_files.push(LogicFile { path: format!("scripts/{n}.ruspy"), name: n.into(), errors: vec![] });
    }
    b.signal_hints.insert(start, vec!["pressed".into()]);
    let mut h = Harness::builder().with_size(egui::vec2(1280.0, 2400.0)).with_max_steps(30).build_ui_state(
        |ui, app: &mut App| {
            let ctx = ui.ctx().clone();
            app.ui.show(&ctx, &mut app.backend);
        },
        App { ui: EditorUi::new(), backend: b },
    );
    h.run_steps(3);
    h
}

fn id(h: &Harness<'static, App>, name: &str) -> EntityId {
    h.state().backend.id_of(name).expect("entity exists")
}

fn select(h: &mut Harness<'static, App>, name: &str) {
    h.get_by_label(name).click();
    h.run_steps(4);
}

fn comp(h: &Harness<'static, App>, name: &str, ty: &str) -> Option<Value> {
    h.state().backend.component(id(h, name), ty).cloned()
}

fn undo(h: &mut Harness<'static, App>) {
    let App { ui, backend } = h.state_mut();
    ui.run(&egui::Context::default(), backend, Command::Undo);
    h.run_steps(3);
}

#[test]
fn attach_picks_an_existing_script_and_undo_detaches_it() {
    let mut h = harness();
    select(&mut h, "Plain");
    h.get_by_label("No script.");
    h.get_by_label("Attach script").click();
    h.run_steps(3);
    h.get_by_label("door").click();
    h.run_steps(4);
    assert_eq!(comp(&h, "Plain", SCRIPT), Some(json!({"path": "scripts/door.ruspy", "priority": 0})));
    undo(&mut h);
    assert!(comp(&h, "Plain", SCRIPT).is_none_or(|v| v.is_null()));
}

#[test]
fn attach_creates_a_new_script_from_the_template_and_opens_it() {
    let mut h = harness();
    select(&mut h, "Plain");
    h.get_by_label("Attach script").click();
    h.run_steps(3);
    h.get_by_label("Create and attach").click();
    h.run_steps(5);
    assert_eq!(comp(&h, "Plain", SCRIPT), Some(json!({"path": "scripts/plain.ruspy", "priority": 0})));
    assert!(h.state().backend.script_files["scripts/plain.ruspy"].contains("_process(delta)"));
    assert_eq!(h.state().ui.open_tabs(), vec!["scripts/plain.ruspy".to_owned()]);
}

#[test]
fn open_and_detach_work_on_an_attached_script() {
    let mut h = harness();
    select(&mut h, "Menu");
    h.get_by_label("menu");
    h.get_by_label("Open").click();
    h.run_steps(2);
    assert_eq!(h.state().ui.open_tabs(), vec!["scripts/menu.ruspy".to_owned()]);
    h.get_by_label("Detach").click();
    h.run_steps(4);
    assert!(comp(&h, "Menu", SCRIPT).is_none_or(|v| v.is_null()));
}

#[test]
fn members_list_the_script_variables_and_overrides_write_script_props() {
    let mut h = harness();
    select(&mut h, "Menu");
    h.get_by_label("speed");
    h.get_by_label("label");
    let field = h.get_by_role_and_label(egui::accesskit::Role::TextInput, "member speed");
    field.focus();
    h.run_steps(2);
    h.get_by_role_and_label(egui::accesskit::Role::TextInput, "member speed").type_text("7");
    h.run_steps(2);
    h.key_press(egui::Key::Enter);
    h.run_steps(4);
    assert_eq!(comp(&h, "Menu", SCRIPT_PROPS), Some(json!({"values": [{"name": "speed", "value": "7"}]})));
    // Reset removes the override.
    h.get_by_label("\u{21BA}").click();
    h.run_steps(4);
    assert_eq!(comp(&h, "Menu", SCRIPT_PROPS), Some(json!({"values": []})));
}

#[test]
fn invalid_member_json_is_flagged_and_not_saved() {
    let mut h = harness();
    select(&mut h, "Menu");
    h.get_by_role_and_label(egui::accesskit::Role::TextInput, "member speed").focus();
    h.run_steps(2);
    h.get_by_role_and_label(egui::accesskit::Role::TextInput, "member speed").type_text("{oops");
    h.run_steps(2);
    h.get_by_label("not valid JSON");
    h.key_press(egui::Key::Enter);
    h.run_steps(3);
    assert!(comp(&h, "Menu", SCRIPT_PROPS).is_none());
}

#[test]
fn connect_stores_a_relative_path_and_appends_a_stub_for_a_new_method() {
    let mut h = harness();
    select(&mut h, "Start");
    h.get_by_label("pressed");
    h.get_by_label("Connect\u{2026}").click();
    h.run_steps(3);
    h.get_all_by_label("HUD").last().expect("target row").click();
    h.run_steps(4);
    // The target resolves to `../HUD` and gets Godot's default handler name.
    h.get_by_label("../HUD");
    h.get_by_label("A stub `_on_Start_pressed` will be added to scripts/hud.ruspy");
    h.get_by_label("One-shot").click();
    h.run_steps(2);
    h.get_by_label("Connect").click();
    h.run_steps(5);
    assert_eq!(
        comp(&h, "Start", CONNECTIONS),
        Some(json!([{"signal": "pressed", "target": "../HUD", "method": "_on_Start_pressed", "binds": [], "deferred": false, "one_shot": true}]))
    );
    assert_eq!(h.state().backend.stubs, vec![(id(&h, "HUD"), "_on_Start_pressed".to_owned(), vec![])]);
    assert!(h.state().backend.script_files["scripts/hud.ruspy"].contains("fn _on_Start_pressed() {"));
    // The connection is listed and one undo removes it.
    h.get_by_label("pressed \u{2192} HUD._on_Start_pressed");
    undo(&mut h);
    assert!(comp(&h, "Start", CONNECTIONS).is_none_or(|v| v == json!([]) || v.is_null()));
}

#[test]
fn connecting_to_an_existing_method_adds_no_stub_and_disconnect_removes_it() {
    let mut h = harness();
    select(&mut h, "Start");
    h.get_by_label("Connect\u{2026}").click();
    h.run_steps(3);
    h.get_all_by_label("HUD").last().expect("target row").click();
    h.run_steps(4);
    // Pick the existing function from the method list.
    h.get_by_label("Existing \u{25BE}").click();
    h.run_steps(2);
    h.get_by_label("show_score(n)").click();
    h.run_steps(2);
    h.get_by_label("Connect").click();
    h.run_steps(5);
    assert!(h.state().backend.stubs.is_empty());
    let c = comp(&h, "Start", CONNECTIONS).expect("connections");
    assert_eq!(c[0]["method"], json!("show_score"));
    h.get_by_label("Disconnect").click();
    h.run_steps(4);
    assert_eq!(comp(&h, "Start", CONNECTIONS), Some(json!([])));
}

#[test]
fn script_declared_signals_are_listed() {
    let mut h = harness();
    select(&mut h, "Menu");
    h.get_by_label("started");
}

#[test]
fn groups_are_added_and_removed() {
    let mut h = harness();
    select(&mut h, "Menu");
    h.get_by_label("Not in any group");
    h.get_by_role_and_label(egui::accesskit::Role::TextInput, "group name").focus();
    h.run_steps(2);
    h.get_by_role_and_label(egui::accesskit::Role::TextInput, "group name").type_text("enemies");
    h.run_steps(2);
    h.get_by_label("Add group").click();
    h.run_steps(4);
    assert_eq!(comp(&h, "Menu", GROUPS), Some(json!(["enemies"])));
    h.get_by_label("\u{00D7}").click();
    h.run_steps(4);
    assert_eq!(comp(&h, "Menu", GROUPS), Some(json!([])));
}

#[test]
fn export_hints_pick_the_widget_and_private_vars_are_hidden() {
    let mut h = harness();
    select(&mut h, "Plain");
    let sliders = h.query_all_by_role(egui::accesskit::Role::Slider).count();
    select(&mut h, "Hinted");
    assert_eq!(h.query_all_by_role(egui::accesskit::Role::Slider).count(), sliders + 1);
    assert!(h.query_by_label("_cache").is_none());
    assert!(h.query_by_role_and_label(egui::accesskit::Role::TextInput, "member speed").is_none());
    // Enum: a combo box; picking an option stores the option text.
    h.get_by_value("easy").click();
    h.run_steps(3);
    h.get_by_label("hard").click();
    h.run_steps(4);
    assert_eq!(comp(&h, "Hinted", SCRIPT_PROPS), Some(json!({"values": [{"name": "mode", "value": "\"hard\""}]})));
}
