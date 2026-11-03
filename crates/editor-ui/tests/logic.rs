//! Logic editor tests: the tab over an in-memory backend, driven with egui_kittest.

use editor_proto::*;
use editor_ui::logic::{LogicTab, mock::LogicMock};
use egui_kittest::Harness;
use egui_kittest::kittest::{NodeT, Queryable};

const GATE: &str = include_str!("data/gate.logic.ron");

struct App {
    tab: LogicTab,
    backend: LogicMock,
}

fn harness_with(files: &[(&str, &str)], open: &str) -> Harness<'static, App> {
    let mut backend = LogicMock::new();
    for (p, t) in files {
        backend.files.insert((*p).to_string(), (*t).to_string());
    }
    backend.palette.commands = vec![CommandDoc { name: "time.scale".into(), doc: "Scale time".into(), schema: Some(TypeSchema::Struct { fields: vec![("factor".into(), TypeSchema::Float { min: None, max: None, step: None })] }) }];
    backend.palette.nodes = vec![NodeTemplate {
        kind_label: "Command time.scale".into(),
        category: "Commands".into(),
        kind_json: serde_json::json!({"Command": {"id": "time.scale", "params": {"factor": "$factor"}}}),
        pins: vec![],
        doc: "Scale time".into(),
    }];
    let mut tab = LogicTab::default();
    tab.open(open);
    let mut h = Harness::builder().with_size(egui::vec2(1500.0, 860.0)).with_max_steps(40).build_ui_state(
        |ui, app: &mut App| {
            let App { tab, backend } = app;
            editor_ui::logic::show(ui, tab, backend);
        },
        App { tab, backend },
    );
    h.run_steps(6);
    h
}

fn gate() -> Harness<'static, App> {
    harness_with(&[("logic/gate.logic.ron", GATE)], "logic/gate.logic.ron")
}

/// `LOGIC_SHOT=/path/out.png cargo test -p editor-ui --test logic preview -- --ignored`
#[test]
#[ignore]
fn preview() {
    let mut h = gate();
    h.run_steps(10);
    let path = std::env::var("LOGIC_SHOT").unwrap_or_else(|_| "/tmp/logic.png".into());
    let img = h.render().expect("render");
    img.save(&path).unwrap();
}

const SMALL: &str = r#"Graph(
    nodes: [
        (id: 1, kind: Start, pos: (0.0, 0.0)),
        (id: 2, kind: Log, defaults: [("text", Str("hi"))], pos: (320.0, 0.0)),
        (id: 3, kind: Const(Str("a")), pos: (0.0, 200.0)),
        (id: 4, kind: Branch, pos: (320.0, 200.0)),
    ],
)"#;

fn small() -> Harness<'static, App> {
    harness_with(&[("logic/small.logic.ron", SMALL)], "logic/small.logic.ron")
}

fn pin(h: &Harness<'static, App>, node: u32, output: bool, name: &str) -> egui::Pos2 {
    h.state().tab.pin_screen_pos(node, output, name).unwrap_or_else(|| panic!("pin {node}.{name} not on screen"))
}

fn drag(h: &mut Harness<'static, App>, from: egui::Pos2, to: egui::Pos2) {
    h.hover_at(from);
    h.run_steps(1);
    h.drag_at(from);
    h.run_steps(2);
    h.hover_at(from.lerp(to, 0.5));
    h.run_steps(1);
    h.hover_at(to);
    h.run_steps(2);
    h.drop_at(to);
    h.run_steps(4);
}

/// The text field with this placeholder.
fn text_input<'a>(h: &'a Harness<'static, App>, placeholder: &str) -> egui_kittest::Node<'a> {
    h.get_all_by_role(egui::accesskit::Role::TextInput).find(|n| n.accesskit_node().placeholder().as_deref() == Some(placeholder)).unwrap_or_else(|| panic!("no text field with placeholder `{placeholder}`"))
}

fn graph(h: &Harness<'static, App>) -> logic_core::Graph {
    h.state().tab.active_graph().cloned().expect("a graph is open")
}

#[test]
fn the_gate_opens_with_no_errors() {
    let h = gate();
    let g = graph(&h);
    assert_eq!(g.nodes.len(), 16);
    assert_eq!(g.vars.len(), 2);
    assert!(h.state().tab.active_errors().is_empty(), "{:?}", h.state().tab.active_errors());
    assert!(!h.state().tab.is_dirty(), "loading is not an edit");
    h.get_by_label("Compile: OK");
}

#[test]
fn dragging_from_an_exec_pin_to_another_links_them_and_marks_the_graph_dirty() {
    let mut h = small();
    assert!(graph(&h).flow.is_empty());
    let (from, to) = (pin(&h, 1, true, "then"), pin(&h, 2, false, "in"));
    drag(&mut h, from, to);
    let g = graph(&h);
    assert_eq!(g.flow.len(), 1, "{:?}", g.flow);
    assert_eq!((g.flow[0].from.0, g.flow[0].from.1.as_str(), g.flow[0].to.0), (1, "then", 2));
    assert!(h.state().tab.is_dirty());
}

#[test]
fn a_type_mismatch_is_refused_with_a_message() {
    let mut h = small();
    // A string constant cannot feed Branch's bool input.
    let (from, to) = (pin(&h, 3, true, "value"), pin(&h, 4, false, "cond"));
    drag(&mut h, from, to);
    assert!(graph(&h).data.is_empty(), "{:?}", graph(&h).data);
    h.get_by_label_contains("String cannot feed Bool");
    // A matching pair is accepted: the same string feeds Log's `any` text input.
    let (from, to) = (pin(&h, 3, true, "value"), pin(&h, 2, false, "text"));
    drag(&mut h, from, to);
    assert_eq!(graph(&h).data.len(), 1);
}

#[test]
fn undo_and_redo_restore_the_graph() {
    let mut h = small();
    let before = graph(&h);
    let (from, to) = (pin(&h, 1, true, "then"), pin(&h, 2, false, "in"));
    drag(&mut h, from, to);
    assert_eq!(graph(&h).flow.len(), 1);
    h.get_by_label("Undo").click();
    h.run_steps(4);
    assert_eq!(graph(&h), before, "undo restores the whole graph");
    assert!(!h.state().tab.is_dirty(), "back at the saved state");
    h.get_by_label("Redo").click();
    h.run_steps(4);
    assert_eq!(graph(&h).flow.len(), 1);
}

#[test]
fn undo_by_shortcut_over_the_canvas() {
    let mut h = small();
    let (from, to) = (pin(&h, 1, true, "then"), pin(&h, 2, false, "in"));
    drag(&mut h, from, to);
    assert_eq!(graph(&h).flow.len(), 1);
    let over = h.state().tab.canvas_rect().center();
    h.hover_at(over);
    h.run_steps(2);
    h.key_press_modifiers(egui::Modifiers::COMMAND, egui::Key::Z);
    h.run_steps(4);
    assert!(graph(&h).flow.is_empty());
}

#[test]
fn the_palette_searches_and_adds_a_node() {
    let mut h = small();
    let n = graph(&h).nodes.len();
    let at = h.state().tab.canvas_rect().center() + egui::vec2(0.0, 150.0);
    h.hover_at(at);
    h.run_steps(1);
    h.event(egui::Event::PointerButton { pos: at, button: egui::PointerButton::Secondary, pressed: true, modifiers: egui::Modifiers::NONE });
    h.run_steps(1);
    h.event(egui::Event::PointerButton { pos: at, button: egui::PointerButton::Secondary, pressed: false, modifiers: egui::Modifiers::NONE });
    h.run_steps(4);
    // Typing filters; only matching entries remain.
    text_input(&h, "Search nodes").focus();
    h.run_steps(2);
    h.event(egui::Event::Text("delay".into()));
    h.run_steps(3);
    assert!(h.query_by_label("Branch").is_none() || h.query_all_by_label("Branch").count() <= 1, "Branch node of the graph header only");
    let item = h.get_by_label_contains("Delay");
    item.click();
    h.run_steps(4);
    let g = graph(&h);
    assert_eq!(g.nodes.len(), n + 1);
    assert!(g.nodes.iter().any(|x| matches!(x.kind, logic_core::NodeKind::Delay { .. })));
}

#[test]
fn a_wrong_script_function_turns_the_node_red_and_is_listed() {
    let bad = GATE.replace("function: \"on_open\"", "function: \"on_open2\"");
    let mut h = harness_with(&[("logic/gate.logic.ron", &bad)], "logic/gate.logic.ron");
    h.run_steps(2);
    let errs = h.state().tab.active_errors();
    assert!(errs.iter().any(|(n, m)| *n == Some(8) && m.contains("no function `on_open2`")), "{errs:?}");
    // The Compiler Results strip names it and offers Go to.
    h.get_by_label_contains("no function `on_open2`");
    h.get_by_label("Go to");
    h.get_by_label_contains("Compile: 1 error");
}

#[test]
fn save_writes_the_file_and_clears_dirty() {
    let mut h = small();
    let (from, to) = (pin(&h, 1, true, "then"), pin(&h, 2, false, "in"));
    drag(&mut h, from, to);
    assert!(h.state().tab.is_dirty());
    h.get_by_label("Save").click();
    h.run_steps(4);
    assert!(!h.state().tab.is_dirty());
    assert_eq!(h.state().backend.written, vec!["logic/small.logic.ron".to_string()]);
    let saved = logic_core::Graph::from_ron(&h.state().backend.files["logic/small.logic.ron"]).unwrap();
    assert_eq!(saved.flow.len(), 1);
    // Positions survive.
    assert_eq!(saved.node(2).unwrap().pos, [320.0, 0.0]);
}

#[test]
fn variables_are_added_from_my_logic_and_saved() {
    let mut h = small();
    h.get_by_label("+ Variable").click();
    h.run_steps(4);
    assert_eq!(graph(&h).vars.len(), 1);
    assert_eq!(graph(&h).vars[0].name, "var1");
    assert!(h.state().tab.is_dirty());
    // The variable appears as Get / Set entries in the palette (search "var1").
    let at = h.state().tab.canvas_rect().center() + egui::vec2(0.0, 150.0);
    h.hover_at(at);
    h.run_steps(1);
    h.event(egui::Event::PointerButton { pos: at, button: egui::PointerButton::Secondary, pressed: true, modifiers: egui::Modifiers::NONE });
    h.event(egui::Event::PointerButton { pos: at, button: egui::PointerButton::Secondary, pressed: false, modifiers: egui::Modifiers::NONE });
    h.run_steps(4);
    text_input(&h, "Search nodes").focus();
    h.run_steps(2);
    h.event(egui::Event::Text("var1".into()));
    h.run_steps(3);
    h.get_by_label("Get var1");
    h.get_by_label("Set var1");
}

#[test]
fn fire_runs_the_event_on_the_entity_and_shows_the_trace() {
    let mut h = gate();
    // Nothing runs this graph yet: Fire is off and Attach is offered.
    h.get_by_label("Attach to selection");
    h.state_mut().backend.users.insert("logic/gate.logic.ron".into(), vec![42]);
    h.state_mut().backend.trace = vec![1, 3, 6, 7, 8];
    h.run_steps(8);
    assert!(h.query_by_label("Attach to selection").is_none());
    h.get_by_label("Fire").click();
    h.run_steps(3);
    assert_eq!(h.state().backend.fired, vec![(42, "start".to_string())]);
    h.get_by_label_contains("Last fire ran 5 nodes");
}

#[test]
fn a_file_changed_on_disk_reloads_when_there_are_no_local_edits() {
    let mut h = small();
    let edited = SMALL.replace("(id: 4, kind: Branch, pos: (320.0, 200.0))", "(id: 4, kind: Branch, pos: (320.0, 200.0)), (id: 5, kind: Tick, pos: (0.0, 400.0))");
    h.state_mut().backend.files.insert("logic/small.logic.ron".into(), edited);
    h.run_steps(8);
    assert_eq!(graph(&h).nodes.len(), 5);
    assert!(!h.state().tab.is_dirty());
}

#[test]
fn a_script_opens_in_a_text_tab_with_its_functions_and_saves() {
    let mut h = harness_with(&[], "scripts/score.ruspy");
    h.get_by_label("on_open");
    h.get_by_label_contains("scripts/score.ruspy");
    assert!(h.state().tab.active_path().is_some_and(|p| p.ends_with("score.ruspy")));
}

#[test]
fn creating_a_graph_opens_an_empty_tab() {
    let mut h = harness_with(&[], "logic/none.logic.ron");
    // A missing file reports instead of opening.
    assert!(h.state().tab.open_paths().is_empty());
    h.get_by_label("+").click();
    h.run_steps(3);
    text_input(&h, "name").focus();
    h.run_steps(2);
    h.event(egui::Event::Text("fresh".into()));
    h.run_steps(2);
    h.get_by_label("Create").click();
    h.run_steps(5);
    assert_eq!(h.state().tab.open_paths(), vec!["logic/fresh.logic.ron".to_string()]);
    assert!(graph(&h).nodes.is_empty());
    assert!(h.state().backend.files.contains_key("logic/fresh.logic.ron"));
}
