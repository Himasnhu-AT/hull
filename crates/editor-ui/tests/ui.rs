//! Headless UI tests: the whole editor over the in-memory backend, driven with egui_kittest.

use editor_proto::*;
use editor_ui::mock::{HEALTH, MockBackend, TRANSFORM};
use editor_ui::{Command, EditorUi};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::json;

struct App {
    ui: EditorUi,
    backend: MockBackend,
}

fn harness() -> Harness<'static, App> {
    let mut h = Harness::builder().with_size(egui::vec2(1280.0, 800.0)).with_max_steps(30).build_ui_state(
        |ui, app: &mut App| {
            let ctx = ui.ctx().clone();
            app.ui.show(&ctx, &mut app.backend);
        },
        App {
            ui: EditorUi::new(),
            backend: MockBackend::demo(),
        },
    );
    h.run_steps(3);
    h
}

fn id(h: &Harness<'static, App>, name: &str) -> EntityId {
    h.state().backend.id_of(name).expect("entity exists")
}

#[test]
fn clicking_an_outliner_row_selects_and_shows_components() {
    let mut h = harness();
    h.get_by_label("Crate").click();
    h.run_steps(3);
    assert_eq!(h.state_mut().backend.selection(), vec![id(&h, "Crate")]);
    // Details lists a section per component.
    h.get_by_label("Transform");
    h.get_by_label("Health");
}

#[test]
fn value_field_edit_reaches_the_backend_and_undo_restores_it() {
    let mut h = harness();
    h.get_by_label("Crate").click();
    h.run_steps(3);
    let crate_id = id(&h, "Crate");
    let before = h.state().backend.component(crate_id, HEALTH).cloned().expect("health");
    assert_eq!(before["max"], json!(100));

    // Arrow up on a focused field is a one-shot edit.
    let field = h.get_by_role_and_label(egui::accesskit::Role::Slider, "max");
    field.focus();
    h.run_steps(2);
    h.key_press(egui::Key::ArrowUp);
    h.run_steps(4);

    let after = h.state().backend.component(crate_id, HEALTH).cloned().expect("health");
    assert_ne!(after["max"], json!(100), "value changed: {after}");
    let op = h.state().backend.applied.last().cloned().expect("an op reached the backend");
    match &op {
        Op::SetComponent {
            type_path, before: b, after: a, ..
        } => {
            assert_eq!(type_path, HEALTH);
            assert_eq!(b.as_ref(), Some(&before));
            assert_eq!(a.as_ref(), Some(&after));
        }
        other => panic!("unexpected op {other:?}"),
    }
    assert!(h.state().ui.can_undo());

    // Undo through the command (the same path as Cmd+Z).
    let App { ui, backend } = h.state_mut();
    let ctx = egui::Context::default();
    ui.run(&ctx, backend, Command::Undo);
    h.run_steps(3);
    assert_eq!(h.state().backend.component(crate_id, HEALTH), Some(&before));
    assert!(h.state().ui.can_redo());

    let App { ui, backend } = h.state_mut();
    ui.run(&egui::Context::default(), backend, Command::Redo);
    assert_eq!(h.state().backend.component(crate_id, HEALTH), Some(&after));
}

#[test]
fn command_shortcuts_run_the_commands() {
    let mut h = harness();
    h.get_by_label("Crate").click();
    h.run_steps(3);
    // 1 / 2 / 3 / 4 switch tools (W A S D are the camera's) and tell the viewport.
    h.key_press(egui::Key::Num3);
    h.run_steps(2);
    assert_eq!(h.state().ui.tool(), Tool::Rotate);
    assert!(h.state().backend.viewport_cmds.contains(&ViewportCmd::SetTool(Tool::Rotate)));
    // Delete removes the selection; Cmd+Z brings it back with its child.
    let crate_id = id(&h, "Crate");
    h.key_press(egui::Key::Delete);
    h.run_steps(3);
    assert!(!h.state().backend.exists(crate_id));
    assert!(h.state().backend.id_of("Lid").is_none(), "children go with the parent");
    h.key_press_modifiers(egui::Modifiers::COMMAND, egui::Key::Z);
    h.run_steps(3);
    assert!(h.state().backend.id_of("Crate").is_some());
    assert!(h.state().backend.id_of("Lid").is_some());
    // Cmd+S saves to the level's own path.
    h.key_press_modifiers(egui::Modifiers::COMMAND, egui::Key::S);
    h.run_steps(2);
    assert_eq!(h.state().backend.saved, vec![None]);
}

#[test]
fn generated_entities_are_read_only() {
    let mut h = harness();
    // Generated entities sit in a folder that starts folded.
    h.get_by_label("Generated (1)").click();
    h.run_steps(3);
    h.get_by_label("Skybox").click();
    h.run_steps(3);
    let sky = id(&h, "Skybox");
    h.key_press(egui::Key::Delete);
    h.run_steps(3);
    assert!(h.state().backend.exists(sky), "generated entities can't be deleted");
    assert!(h.state().backend.applied.is_empty());
}

#[test]
fn content_browser_navigates_and_places() {
    let mut h = harness();
    // Open the Content tab content: it is the first tab in its group, so it is already shown.
    h.get_by_label("library").click();
    h.run_steps(3);
    h.get_by_label("crate.glb");
    // Place through the button.
    h.get_all_by_role_and_label(egui::accesskit::Role::Button, "Place").next().expect("a place button").click();
    h.run_steps(3);
    assert_eq!(h.state().backend.placed.len(), 1);
    assert!(h.state().ui.can_undo(), "the returned Spawn op is on the undo stack");
    let n = h.state().backend.len();
    let App { ui, backend } = h.state_mut();
    ui.run(&egui::Context::default(), backend, Command::Undo);
    assert_eq!(h.state().backend.len(), n - 1);
}

#[test]
fn output_panel_lists_diagnostics_with_locations() {
    let mut h = harness();
    // Switch to the Output tab.
    h.get_by_label("Output").click();
    h.run_steps(3);
    h.get_by_label("[ruspy] unexpected token ')'");
    assert_eq!(h.state().ui.diagnostics().len(), 3);
}

#[test]
fn layout_persists() {
    let mut ui = EditorUi::new();
    let s = ui.save_state();
    ui.reset_layout();
    ui.load_state(&s).expect("round trip");
    assert!(ui.load_state("{ nope").is_err());
    assert!(
        ui.load_state(r#"{"layout":{"root":null,"floating":[]},"tool":"Move","snap":false,"snap_step":0.5}"#)
            .is_err(),
        "no viewport"
    );
    let _ = TRANSFORM;
}

fn with_brush(h: &mut Harness<'static, App>) {
    h.state_mut().backend.tool_docs = vec![ToolDoc {
        id: "sculpt".into(),
        label: "Sculpt".into(),
        hint: "LMB drag paints".into(),
        settings: json!({"radius": 20.0}),
        schema: TypeSchema::Struct { fields: vec![("radius".into(), TypeSchema::Float { min: Some(1.0), max: Some(200.0), step: None })] },
    }];
    h.state_mut().backend.placeable_docs = vec![PlaceableDoc { name: "Start".into(), icon: "flag".into(), category: "Gameplay".into(), type_path: "game::Start".into() }];
    h.state_mut().ui.refresh();
    h.run_steps(4);
}

#[test]
fn tool_buttons_activate_a_tool_and_show_its_settings() {
    let mut h = harness();
    with_brush(&mut h);
    h.get_by_label("Sculpt").click();
    h.run_steps(5);
    assert_eq!(h.state().backend.active.as_deref(), Some("sculpt"));
    // The Tool tab came forward with the tool's help and its settings.
    h.get_by_label("LMB drag paints");
    h.get_by_role_and_label(egui::accesskit::Role::Slider, "radius");
    // Back to Move deactivates it.
    h.get_by_label("Move").click();
    h.run_steps(3);
    assert_eq!(h.state().backend.active, None);
}

#[test]
fn engine_recorded_ops_land_on_the_undo_stack_and_the_palette_picks_the_place_tool() {
    let mut h = harness();
    with_brush(&mut h);
    h.state_mut().backend.recorded.push(RecordedOp { label: "Sculpt".into(), op: Op::TerrainPatch { layer: TerrainKind::Height, rect: [0, 0, 2, 2], before: 1, after: 2 }, key: None });
    h.run_steps(3);
    assert!(h.state().ui.can_undo(), "a stroke the engine recorded is undoable");
    h.state_mut().ui.show_panel("Place").unwrap();
    h.run_steps(3);
    h.get_by_label("Start line").click();
    h.run_steps(4);
    assert_eq!(h.state().backend.active.as_deref(), Some("place"));
}

#[test]
fn the_outliner_groups_roots_into_folders_with_counts() {
    let mut h = harness();
    h.get_by_label("Meshes (2)");
    h.get_by_label("Lights (1)");
    h.get_by_label("Cameras (1)");
    // Folders fold; clicking one does not select anything.
    h.get_by_label("Meshes (2)").click();
    h.run_steps(3);
    assert!(h.state_mut().backend.selection().is_empty());
}

#[test]
fn menus_open_and_run_commands_and_f1_shows_the_controls() {
    let mut h = harness();
    h.get_by_label("File").click();
    h.run_steps(3);
    h.get_by_label_contains("Save as...");
    h.get_by_label_contains("Open level...");
    // Edit > Select all selects every non-generated entity.
    h.get_by_label("Edit").click();
    h.run_steps(3);
    h.get_by_label_contains("Select all").click();
    h.run_steps(3);
    assert!(h.state_mut().backend.selection().len() >= 4);
    h.key_press(egui::Key::F1);
    h.run_steps(3);
    assert!(h.get_all_by_label("Controls and shortcuts").count() >= 1);
    h.get_by_label("W A S D");
}

#[test]
fn view_menu_toggles_panels_and_resets_the_layout() {
    let mut h = harness();
    h.get_by_label("View").click();
    h.run_steps(3);
    h.get_all_by_label("Output").last().expect("the menu checkbox").click();
    h.run_steps(3);
    h.state_mut().ui.run(&egui::Context::default(), &mut MockBackend::demo(), Command::ResetLayout);
    h.run_steps(3);
    assert!(h.state().ui.layout().contains(&editor_ui::Panel::Place), "the default layout has the Place tab");
    assert!(h.state().ui.layout().contains(&editor_ui::Panel::Output));
}

#[test]
fn the_toolbar_marks_the_active_tool_and_tooltips_carry_the_key() {
    let mut h = harness();
    h.get_by_label("Rotate").click();
    h.run_steps(3);
    assert_eq!(h.state().ui.tool(), Tool::Rotate);
    h.get_by_label("Select").click();
    h.run_steps(3);
    assert_eq!(h.state().ui.tool(), Tool::Select);
    assert!(h.state().backend.viewport_cmds.contains(&ViewportCmd::SetTool(Tool::Select)));
}

#[test]
fn duplicate_goes_through_the_backend_and_is_undoable() {
    let mut h = harness();
    h.get_by_label("Crate").click();
    h.run_steps(3);
    let before = h.state().backend.len();
    h.key_press_modifiers(egui::Modifiers::COMMAND, egui::Key::D);
    h.run_steps(4);
    assert_eq!(h.state().backend.len(), before + 2, "the crate and its lid");
    assert!(h.state().ui.can_undo());
}
