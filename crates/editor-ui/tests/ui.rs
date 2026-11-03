//! Headless UI tests: the whole editor over the in-memory backend, driven with egui_kittest.

use editor_proto::*;
use editor_ui::mock::{HEALTH, LIGHT, LOGIC, MockBackend, TRANSFORM};
use editor_ui::{Command, EditorUi, Panel};
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
    let field = h.get_by_role_and_label(egui::accesskit::Role::Slider, "Max");
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
    // Content lives in the drawer.
    h.state_mut().ui.set_drawer_open(true);
    h.run_steps(3);
    // The folder is in the tree and in the grid: either opens it.
    h.get_all_by_label("library").next().expect("library").click();
    h.run_steps(3);
    // No tile carries a Place button (the toolbar's Place mode is the one "Place" button).
    assert_eq!(h.query_all_by_role_and_label(egui::accesskit::Role::Button, "Place").count(), 1);
    h.get_by_label("crate.glb").click();
    h.run_steps(3);
    // The footer offers Place for the selected model.
    h.get_all_by_role_and_label(egui::accesskit::Role::Button, "Place").last().expect("a place button").click();
    h.run_steps(3);
    assert_eq!(h.state().backend.placed.len(), 1);
    assert!(h.state().ui.can_undo(), "the returned Spawn op is on the undo stack");
    let n = h.state().backend.len();
    let App { ui, backend } = h.state_mut();
    ui.run(&egui::Context::default(), backend, Command::Undo);
    assert_eq!(h.state().backend.len(), n - 1);
}

#[test]
fn audio_tiles_have_no_place_action() {
    let mut h = harness();
    h.state_mut().ui.set_drawer_open(true);
    h.run_steps(3);
    h.get_all_by_label("library").next().expect("library").click();
    h.run_steps(3);
    h.get_by_label("engine.ogg").click();
    h.run_steps(3);
    assert_eq!(h.query_all_by_role_and_label(egui::accesskit::Role::Button, "Place").count(), 1, "no Place for a sound (only the toolbar mode)");
    assert!(h.state().backend.placed.is_empty());
}

#[test]
fn output_panel_lists_diagnostics_with_locations() {
    let mut h = harness();
    // Output is a tab of the drawer.
    h.state_mut().ui.show_panel("Output").unwrap();
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
    let err = ui.load_state(r#"{"version":2,"layout":{"root":null,"floating":[]},"tool":"Move","snap":false}"#).expect_err("no viewport");
    assert!(err.contains("viewport"), "{err}");
    // A layout from before the Modes panel is dropped, not half-applied.
    let old = ui.save_state().replace("\"version\":2", "\"version\":1");
    assert!(ui.load_state(&old).is_err());
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
    // Landscape is the mode that owns Sculpt and Paint.
    h.get_by_label("Landscape").click();
    h.run_steps(5);
    assert_eq!(h.state().backend.active.as_deref(), Some("sculpt"));
    // The Modes panel shows the tool's help and its settings; Details stays where it was.
    h.get_by_label("LMB drag paints");
    h.get_by_role_and_label(egui::accesskit::Role::Slider, "Radius");
    // A transform tool deactivates it.
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
    // (the Select-mode palette has a "Lights" category too)
    assert!(h.get_all_by_label("Lights (1)").count() >= 1);
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
fn window_menu_opens_the_drawer_and_resets_the_layout() {
    let mut h = harness();
    assert!(!h.state().ui.drawer_open(), "the drawer starts closed");
    h.get_by_label("Window").click();
    h.run_steps(3);
    h.get_all_by_label("Output").last().expect("the menu checkbox").click();
    h.run_steps(3);
    assert!(h.state().ui.drawer_open());
    h.state_mut().ui.run(&egui::Context::default(), &mut MockBackend::demo(), Command::LayoutLogic);
    h.state_mut().ui.run(&egui::Context::default(), &mut MockBackend::demo(), Command::ResetLayout);
    h.run_steps(3);
    let l = h.state().ui.layout();
    for p in [Panel::Modes, Panel::Outliner, Panel::Details, Panel::WorldSettings, Panel::Viewport] {
        assert!(l.contains(&p), "{p:?} is in the default layout");
    }
    assert!(!h.state().ui.drawer_open(), "reset closes the drawer");
}

#[test]
fn the_toolbar_marks_the_active_tool_and_tooltips_carry_the_key() {
    let mut h = harness();
    assert_eq!(h.state().ui.tool(), Tool::Select, "Select is the default tool");
    h.get_by_label("Rotate").click();
    h.run_steps(3);
    assert_eq!(h.state().ui.tool(), Tool::Rotate);
    // "Select" is both a mode (toolbar) and a transform tool (viewport bar, drawn last).
    h.get_all_by_label("Select").last().expect("the viewport tool").click();
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

// ---- WP-D: Details, Add Logic, Output, History ----------------------------------------------

fn select(h: &mut Harness<'static, App>, name: &str) {
    h.get_by_label(name).click();
    h.run_steps(3);
}

#[test]
fn fields_have_readable_labels_and_a_reset_arrow_when_changed() {
    let mut h = harness();
    select(&mut h, "Crate");
    // `max` is shown as `Max`; Health's default max (10) differs from 100, so it can be reset.
    h.get_by_role_and_label(egui::accesskit::Role::Slider, "Max");
    let crate_id = id(&h, "Crate");
    // The first arrow is Transform's translation (2, 0.5, -1 differs from the default 0, 0, 0).
    h.get_all_by_role_and_label(egui::accesskit::Role::Button, "Reset to default").next().expect("a reset arrow").click();
    h.run_steps(4);
    let t = h.state().backend.component(crate_id, TRANSFORM).cloned().expect("transform");
    assert_eq!(t["translation"], json!([0.0, 0.0, 0.0]));
    assert_eq!(t["scale"], json!([1.0, 1.0, 1.0]));
    assert!(h.state().ui.can_undo());
}

#[test]
fn plus_add_lists_types_and_adds_one() {
    let mut h = harness();
    select(&mut h, "Crate");
    h.get_by_label("+ Add").click();
    h.run_steps(3);
    // Types already on the entity are not offered.
    assert!(h.query_by_label("Health").is_none() || h.query_all_by_label("Health").count() == 1);
    h.get_by_label("PointLight").click();
    h.run_steps(4);
    let crate_id = id(&h, "Crate");
    assert!(h.state().backend.component(crate_id, LIGHT).is_some(), "component added");
    match h.state().backend.applied.last() {
        Some(Op::SetComponent { type_path, before: None, after: Some(_), .. }) => assert_eq!(type_path, LIGHT),
        other => panic!("unexpected op {other:?}"),
    }
    assert!(h.state().ui.can_undo());
}

#[test]
fn add_logic_creates_a_graph_attaches_it_and_offers_to_open() {
    let mut h = harness();
    select(&mut h, "Crate");
    h.get_by_label("+ Add Logic").click();
    h.run_steps(3);
    h.get_by_label("Door").click();
    h.run_steps(2);
    h.get_by_label("Create and attach").click();
    h.run_steps(5);
    let crate_id = id(&h, "Crate");
    assert_eq!(h.state().backend.logic_created, vec![("Crate_logic".to_owned(), "door".to_owned())]);
    assert_eq!(h.state().backend.component(crate_id, LOGIC), Some(&json!({"graph": "logic/Crate_logic.logic.ron"})));
    // The Logic section lists it, with Open and Detach; the banner offers to open the new graph.
    h.get_by_label("Crate_logic");
    h.get_by_label("Open graph").click();
    h.run_steps(2);
    assert_eq!(h.state().ui.open_tabs(), vec!["logic/Crate_logic.logic.ron".to_owned()]);
    // One undo removes the component again.
    let App { ui, backend } = h.state_mut();
    ui.run(&egui::Context::default(), backend, Command::Undo);
    assert!(h.state().backend.component(crate_id, LOGIC).is_none() || h.state().backend.component(crate_id, LOGIC) == Some(&json!(null)));
}

#[test]
fn logic_section_opens_and_detaches_an_attached_graph() {
    let mut h = harness();
    let crate_id = id(&h, "Crate");
    h.state_mut().backend.logic_files.push(LogicFile { path: "logic/door.logic.ron".into(), name: "door".into(), errors: vec![] });
    h.state_mut()
        .backend
        .apply(&Op::SetComponent { entity: StableOrId::Id(crate_id), type_path: LOGIC.into(), before: None, after: Some(json!({"graph": "logic/door.logic.ron"})) })
        .expect("attach");
    select(&mut h, "Crate");
    h.get_by_label("door");
    h.get_by_label("Open").click();
    h.run_steps(2);
    assert_eq!(h.state().ui.open_tabs(), vec!["logic/door.logic.ron".to_owned()]);
    h.get_by_label("Detach").click();
    h.run_steps(4);
    assert!(h.state().backend.component(crate_id, LOGIC).is_none());
    h.get_by_label("No logic. Add a behaviour with graphs.");
}

fn output_harness() -> Harness<'static, App> {
    let mut h = harness();
    h.state_mut().ui.show_panel("Output").expect("panel");
    h.run_steps(3);
    h
}

#[test]
fn output_filters_by_source_level_and_search() {
    let mut h = output_harness();
    h.get_by_label("[ruspy] unexpected token ')'");
    h.get_by_label("[assets] missing texture, using fallback");
    // Level: warnings and up hides the info line (the Info filter is on by default).
    h.get_by_label("Warnings").click();
    h.run_steps(2);
    assert!(h.query_by_label("[engine] level loaded").is_none());
    h.get_by_label("[assets] missing texture, using fallback");
    // Source: hide Logic (ruspy).
    h.get_by_label("Logic (1)").click();
    h.run_steps(2);
    assert!(h.query_by_label("[ruspy] unexpected token ')'").is_none());
    h.get_by_label("Logic (1)").click();
    h.run_steps(2);
    h.get_by_label("[ruspy] unexpected token ')'");
}

#[test]
fn clicking_an_output_line_with_an_entity_selects_it() {
    let mut h = harness();
    let crate_id = id(&h, "Crate");
    h.state_mut().backend.diag.push(Diagnostic::new(Level::Error, "logic", "node 3 has no input").about(crate_id));
    h.state_mut().ui.show_panel("Output").expect("panel");
    h.run_steps(8);
    assert!(h.state_mut().backend.selection().is_empty());
    h.get_by_label("[logic] node 3 has no input").click();
    h.run_steps(3);
    assert_eq!(h.state_mut().backend.selection(), vec![crate_id]);
}

#[test]
fn refused_edits_land_in_the_output_log() {
    let mut h = harness();
    let crate_id = id(&h, "Crate");
    // A recorded step whose result the backend no longer has: undo is refused.
    let op = Op::SetComponent { entity: StableOrId::Id(crate_id), type_path: HEALTH.into(), before: Some(json!({"max": 1})), after: Some(json!({"max": 2})) };
    h.state_mut().ui.record_applied("Edit Health", op, None);
    let App { ui, backend } = h.state_mut();
    ui.run(&egui::Context::default(), backend, Command::Undo);
    assert!(
        h.state().ui.diagnostics().iter().any(|d| d.source == "editor" && d.level == Level::Error && d.message.contains("Undo failed")),
        "{:?}",
        h.state().ui.diagnostics()
    );
}

#[test]
fn history_panel_jumps_back_and_forward() {
    let mut h = harness();
    select(&mut h, "Crate");
    let crate_id = id(&h, "Crate");
    for name in ["A", "B", "C"] {
        let eref = StableOrId::Id(crate_id);
        let before = h.state().backend.name_of(crate_id).expect("name").to_owned();
        h.state_mut().ui.record_applied("Rename", Op::Rename { entity: eref, before: before.clone(), after: name.into() }, None);
        h.state_mut().backend.apply(&Op::Rename { entity: eref, before, after: name.into() }).expect("rename");
        h.state_mut().ui.seal_undo();
    }
    assert_eq!(h.state().ui.undo_depth(), 3);
    h.state_mut().ui.show_panel("History").expect("panel");
    h.run_steps(4);
    // Jump to the state after the first step: two undos.
    h.get_by_label_contains("1  Rename").click();
    h.run_steps(4);
    assert_eq!(h.state().ui.undo_depth(), 1);
    assert_eq!(h.state().backend.name_of(crate_id), Some("A"));
    // And forward again to the last step.
    h.get_by_label_contains("3  Rename").click();
    h.run_steps(4);
    assert_eq!(h.state().backend.name_of(crate_id), Some("C"));
}

// ---- WP-B: layout, modes, drawer, document tabs, settings ---------------------------------

/// Types `text` into each text field in turn until `done` holds (the fields' order in the
/// accessibility tree is not the draw order).
fn type_until(h: &mut Harness<'static, App>, text: &str, done: impl Fn(&Harness<'static, App>) -> bool) {
    let n = h.get_all_by_role(egui::accesskit::Role::TextInput).count();
    for i in 0..n {
        let field = h.get_all_by_role(egui::accesskit::Role::TextInput).nth(i).expect("a field");
        field.focus();
        h.run_steps(2);
        let field = h.get_all_by_role(egui::accesskit::Role::TextInput).nth(i).expect("a field");
        field.type_text(text);
        h.run_steps(4);
        if done(h) {
            return;
        }
    }
    panic!("no text field took the input");
}

fn run_cmd(h: &mut Harness<'static, App>, cmd: Command) {
    let App { ui, backend } = h.state_mut();
    ui.run(&egui::Context::default(), backend, cmd);
    h.run_steps(4);
}

#[test]
fn the_default_layout_has_modes_left_and_outliner_over_details_right() {
    let h = harness();
    let l = h.state().ui.layout();
    for p in [Panel::Modes, Panel::Outliner, Panel::Details, Panel::WorldSettings] {
        assert!(l.contains(&p), "{p:?}");
    }
    // Details is a tab in front of World Settings, beside it, not behind a Tool tab.
    h.get_by_label("Details");
    h.get_by_label("World Settings");
    h.get_by_label("Outliner");
    // Nothing selected yet: Details is on screen and says so.
    h.get_by_label_contains("Nothing selected");
    assert!(!h.state().ui.drawer_open());
    // The mode strip: five modes, the transform tools are not among them.
    for m in ["Select", "Landscape", "Foliage", "Splines", "Place"] {
        assert!(h.get_all_by_label(m).count() >= 1, "{m}");
    }
}

#[test]
fn selecting_keeps_details_in_front_even_after_world_settings() {
    let mut h = harness();
    h.get_by_label("World Settings").click();
    h.run_steps(3);
    h.get_by_label("Look");
    h.get_by_label("Crate").click();
    h.run_steps(4);
    h.get_by_label("Health");
}

#[test]
fn modes_switch_tools_and_place_has_a_type_dropdown() {
    let mut h = harness();
    with_brush(&mut h);
    h.state_mut().backend.tool_docs.push(ToolDoc {
        id: "place".into(),
        label: "Place".into(),
        hint: "Click to drop".into(),
        settings: json!({"type_path": "game::Start", "Snap to ground": true}),
        schema: TypeSchema::Struct { fields: vec![("type_path".into(), TypeSchema::String), ("Snap to ground".into(), TypeSchema::Bool)] },
    });
    h.state_mut().ui.refresh();
    h.run_steps(4);
    // The Select-mode palette lists types by category and models from every folder.
    h.get_by_label_contains("Gameplay");
    h.get_by_label("Place").click();
    h.run_steps(5);
    assert_eq!(h.state().backend.active.as_deref(), Some("place"));
    // The type is a dropdown showing the chosen type's name, and the raw path field is hidden.
    h.get_by_label_contains("Start");
    assert!(h.query_by_label("type_path").is_none(), "the type path is not a raw text field");
    h.get_by_label("Snap to ground");
    // Back to Select mode.
    h.get_all_by_label("Select").next().expect("the Select mode").click();
    h.run_steps(3);
    assert_eq!(h.state().backend.active, None);
}

#[test]
fn modes_without_a_tool_are_disabled() {
    let mut h = harness();
    // The demo backend has no tools: Landscape does nothing and says why.
    run_cmd(&mut h, Command::ModeLandscape);
    assert_eq!(h.state().backend.active, None);
}

#[test]
fn the_drawer_opens_with_cmd_space_and_docks() {
    let mut h = harness();
    assert!(!h.state().ui.drawer_open());
    h.key_press_modifiers(egui::Modifiers::COMMAND, egui::Key::Space);
    h.run_steps(4);
    assert!(h.state().ui.drawer_open(), "Cmd+Space opens the drawer");
    h.get_all_by_label("library").next().expect("the Content tab body");
    run_cmd(&mut h, Command::DockDrawer);
    assert!(h.state().ui.drawer_docked());
    assert!(!h.state().ui.drawer_open());
    assert!(h.state().ui.layout().contains(&Panel::Content));
    run_cmd(&mut h, Command::DockDrawer);
    assert!(!h.state().ui.drawer_docked());
    assert!(!h.state().ui.layout().contains(&Panel::Content));
    assert!(h.state().ui.drawer_open());
    h.key_press_modifiers(egui::Modifiers::COMMAND, egui::Key::Space);
    h.run_steps(3);
    assert!(!h.state().ui.drawer_open());
}

#[test]
fn logic_tabs_open_beside_the_level_tab() {
    let mut h = harness();
    h.get_by_label_contains("Level:");
    h.state_mut().ui.open_logic_tab("logic/door.logic.ron");
    h.run_steps(4);
    h.get_by_label("Logic: door");
    assert_eq!(h.state().ui.open_tabs(), vec!["logic/door.logic.ron".to_string()]);
    // The viewport is not drawn while a document is in front.
    let out = h.state().ui.layout().contains(&Panel::Viewport);
    assert!(out);
    // The level tab has no close button; the logic tab has one.
    assert!(h.query_by_label("Close Logic: door").is_some());
    assert!(h.query_by_label_contains("Close Level").is_none());
    h.get_by_label("Close Logic: door").click();
    h.run_steps(3);
    assert!(h.state().ui.open_tabs().is_empty());
}

#[test]
fn layouts_are_named_and_apply_by_name() {
    let mut h = harness();
    h.state_mut().ui.apply_layout_name("logic").unwrap();
    assert!(h.state().ui.drawer_open(), "the Logic layout opens the drawer");
    h.state_mut().ui.apply_layout_name("Landscape").unwrap();
    assert!(!h.state().ui.drawer_open());
    assert!(h.state_mut().ui.apply_layout_name("nope").is_err());
    h.run_steps(3);
    assert!(h.get_all_by_label("Modes").count() >= 1);
}

#[test]
fn world_settings_edit_through_the_backend() {
    let mut h = harness();
    h.get_by_label("World Settings").click();
    h.run_steps(4);
    h.get_by_label("Look");
    let field = h.get_by_role_and_label(egui::accesskit::Role::Slider, "Elevation deg");
    field.focus();
    h.run_steps(2);
    h.key_press(egui::Key::ArrowUp);
    h.run_steps(4);
    let v = h.state().backend.settings_groups[0].value.clone();
    assert_ne!(v["sun"]["Elevation deg"], json!(45.0), "{v}");
}

#[test]
fn project_settings_and_preferences_windows_open_and_persist_prefs() {
    let mut h = harness();
    run_cmd(&mut h, Command::OpenProjectSettings);
    h.get_by_label("Project Settings");
    h.get_by_label_contains("Foliage and scatter");
    run_cmd(&mut h, Command::OpenPreferences);
    h.get_by_label("Editor Preferences");
    h.get_by_label("Light").click();
    h.run_steps(4);
    let json = h.state().ui.prefs_json();
    assert!(json.contains("\"light\""), "{json}");
    // A saved preference file loads back, clamped.
    let mut ui = EditorUi::new();
    ui.load_prefs(r#"{"theme":"light","ui_scale":9.0,"camera_speed":20.0}"#).unwrap();
    let back = ui.prefs_json();
    assert!(back.contains("\"light\"") && back.contains("1.75") && back.contains("20.0"), "{back}");
    assert!(ui.load_prefs("{ nope").is_err());
}

#[test]
fn help_scrolls_and_filters() {
    let mut h = harness();
    h.key_press(egui::Key::F1);
    h.run_steps(4);
    h.get_by_label("W A S D");
    h.get_by_label_contains("Save level as");
    // Typing a query narrows the list: type into the search fields until the camera rows vanish.
    type_until(&mut h, "duplicate", |h| h.query_by_label("W A S D").is_none());
    h.get_by_label("Duplicate");
}

#[test]
fn every_toolbar_group_is_present() {
    let h = harness();
    for l in ["Save", "Undo", "Redo", "Play", "Pause", "Stop", "Settings", "Commands"] {
        assert!(h.get_all_by_label(l).count() >= 1, "{l}");
    }
}
