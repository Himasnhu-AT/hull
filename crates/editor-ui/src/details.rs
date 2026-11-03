//! Details: the selected entity's components in categories (Transform, Rendering, Physics,
//! Gameplay, Logic, Other), a Logic section for attached graphs, and the `+ Add` / `+ Add Logic`
//! popups.

use ashlar_ui::tokens;
use editor_proto::{ComponentDoc, EntityId, LogicFile, Op, StableOrId, TypeSchema};
use egui::{RichText, Ui};
use serde_json::{Value, json};

use crate::model::{NodeInfo, Req};
use crate::props::{self, Cx, Phase};

/// Section order in the panel.
pub(crate) const CATEGORIES: [&str; 6] = ["Transform", "Rendering", "Physics", "Gameplay", "Logic", "Other"];

/// Logic graph templates `logic_create` is asked for: `(id, label, what it does)`.
pub(crate) const TEMPLATES: [(&str, &str, &str); 8] = [
    ("empty", "Empty", "A blank graph"),
    ("basic", "Start and Log", "Start -> Log, to build on"),
    ("trigger_zone", "Trigger zone", "Runs when something enters or leaves this object"),
    ("door", "Door", "Opens and closes on an action key"),
    ("pickup", "Pickup", "Collected when the player touches it"),
    ("timer", "Timer", "Does something every few seconds"),
    ("action_key", "On action key", "Reacts to an input action"),
    ("event_start", "Event start", "Starts an event when the level begins"),
];

#[derive(Default)]
pub(crate) struct DetailsState {
    add_filter: String,
    /// Hides components whose name does not match.
    filter: String,
    logic_name: String,
    logic_name_for: Option<EntityId>,
    logic_template: usize,
    logic_filter: String,
    /// A graph just created for this entity: the Logic section offers to open it.
    created: Option<(EntityId, String)>,
    /// Entity the panel showed last frame (resets popups and the banner on change).
    last_id: Option<EntityId>,
}

impl DetailsState {
    /// Remember a graph created for `entity` so the Logic section can offer to open it.
    pub(crate) fn note_created(&mut self, entity: EntityId, path: String) {
        self.created = Some((entity, path));
    }
}

pub(crate) struct View<'a> {
    pub id: Option<EntityId>,
    pub info: Option<&'a NodeInfo>,
    pub extra_selected: usize,
    pub components: &'a Result<Vec<ComponentDoc>, String>,
    pub types: &'a [(String, TypeSchema)],
    /// The `.logic.ron` files that exist.
    pub logic: &'a [LogicFile],
}

/// Which section a component belongs to: the backend's word, else a guess from its name.
pub(crate) fn category_of(doc: &ComponentDoc) -> &'static str {
    if let Some(c) = CATEGORIES.iter().find(|c| c.eq_ignore_ascii_case(&doc.category)) {
        return c;
    }
    let n = doc.short_name.as_str();
    let has = |words: &[&str]| words.iter().any(|w| n.contains(w));
    if n == "Transform" || n == "GlobalTransform" {
        "Transform"
    } else if n == "Logic" {
        "Logic"
    } else if has(&["Mesh", "Material", "Visibility", "Light", "Camera", "Scenery", "Actor", "Sprite", "Aabb", "Fog", "Sky", "Bloom", "Exposure"]) {
        "Rendering"
    } else if has(&["Body", "Collider", "Velocity", "Mass", "Friction", "Restitution", "Sensor", "Physics", "Gravity"]) {
        "Physics"
    } else {
        "Other"
    }
}

fn is_logic_component(doc: &ComponentDoc) -> bool {
    doc.short_name == "Logic"
}

/// The type path of the `Logic` component among the addable types.
fn logic_type(types: &[(String, TypeSchema)], have: &[ComponentDoc]) -> Option<String> {
    have.iter()
        .find(|d| is_logic_component(d))
        .map(|d| d.type_path.clone())
        .or_else(|| types.iter().find(|(p, _)| p.rsplit("::").next() == Some("Logic")).map(|(p, _)| p.clone()))
}

pub(crate) fn show(ui: &mut Ui, st: &mut DetailsState, v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    let (Some(id), Some(info)) = (v.id, v.info) else {
        ui.add_space(t.space.md);
        ui.label(RichText::new("Nothing selected").color(t.text.disabled));
        ui.label(RichText::new("Click an object in the viewport or the Outliner.").color(t.text.secondary).small());
        return;
    };
    if st.last_id != Some(id) {
        st.last_id = Some(id);
        st.add_filter.clear();
        st.logic_filter.clear();
        st.logic_name_for = None;
        if st.created.as_ref().is_some_and(|(e, _)| *e != id) {
            st.created = None;
        }
    }
    let eref = info.reference;
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        header(ui, id, info, v.extra_selected, reqs);
        ui.add_space(t.space.xs);
        match v.components {
            Err(e) => {
                ui.colored_label(t.status.danger, e);
            }
            Ok(comps) => {
                add_bar(ui, st, id, info, comps, v, reqs);
                ui.add_space(t.space.xs);
                ui.separator();
                let f = st.filter.to_lowercase();
                let mut shown = 0;
                for cat in CATEGORIES {
                    if cat == "Logic" {
                        logic_section(ui, st, id, info, comps, v, reqs);
                        shown += 1;
                        continue;
                    }
                    let docs: Vec<&ComponentDoc> = comps
                        .iter()
                        .filter(|d| !is_logic_component(d) && category_of(d) == cat)
                        .filter(|d| f.is_empty() || d.short_name.to_lowercase().contains(&f))
                        .collect();
                    if docs.is_empty() {
                        continue;
                    }
                    shown += docs.len();
                    if cat != "Transform" {
                        ui.add_space(t.space.xs);
                        ui.label(RichText::new(cat).small().strong().color(t.text.secondary));
                    }
                    for doc in docs {
                        section(ui, id, eref, info.generated, doc, reqs);
                        ui.add_space(t.space.xs);
                    }
                }
                if shown == 0 && !f.is_empty() {
                    ui.label(RichText::new("No component matches").color(t.text.disabled));
                }
            }
        }
    });
}

/// Search box plus the two add buttons.
fn add_bar(ui: &mut Ui, st: &mut DetailsState, id: EntityId, info: &NodeInfo, comps: &[ComponentDoc], v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    ui.horizontal(|ui| {
        let add = ui.add_enabled(!info.generated, egui::Button::new("+ Add")).on_hover_text("Add a component").on_disabled_hover_text("Generated by code: make it a level entity first");
        egui::Popup::from_toggle_button_response(&add)
            .close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside)
            .show(|ui| add_component_menu(ui, st, info.reference, comps, v.types, reqs));
        let logic = ui
            .add_enabled(!info.generated && logic_type(v.types, comps).is_some(), egui::Button::new("+ Add Logic"))
            .on_hover_text("Attach a logic graph: new from a template, or an existing one")
            .on_disabled_hover_text(if info.generated { "Generated by code: make it a level entity first" } else { "This game has no Logic component" });
        egui::Popup::from_toggle_button_response(&logic)
            .close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside)
            .show(|ui| add_logic_menu(ui, st, id, info, comps, v, reqs));
        ui.add(egui::TextEdit::singleline(&mut st.filter).hint_text("Search components").desired_width(f32::INFINITY));
    });
    let _ = t;
}

fn header(ui: &mut Ui, _id: EntityId, info: &NodeInfo, extra: usize, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    ui.horizontal(|ui| {
        let mut name = info.name.clone();
        let r = ui.add_enabled(
            !info.generated,
            egui::TextEdit::singleline(&mut name)
                .font(egui::TextStyle::Heading)
                .desired_width(ui.available_width() - 70.0),
        );
        if r.lost_focus() && name.trim() != info.name && !name.trim().is_empty() {
            reqs.push(Req::Edit {
                op: Op::Rename {
                    entity: info.reference,
                    before: info.name.clone(),
                    after: name.trim().to_owned(),
                },
                label: "Rename".into(),
                key: None,
                seal: true,
            });
        }
    });
    // What it is, and its id (the stable id when it has one: that is what the level file stores).
    let ident = match info.reference {
        StableOrId::Stable(s) => format!("id {}", s.0),
        StableOrId::Id(i) => format!("session id {i}"),
    };
    ui.horizontal(|ui| {
        ui.label(RichText::new(crate::outliner::kind_label(info.kind, info.generated)).color(t.accent).small());
        ui.label(RichText::new(ident).color(t.text.disabled).small());
    });
    if info.generated {
        ui.label(RichText::new("Generated by code: read-only").color(t.text.secondary).small());
    }
    if extra > 0 {
        ui.label(RichText::new(format!("+{extra} more selected (showing the first)")).color(t.text.secondary).small());
    }
}

fn section(ui: &mut Ui, id: EntityId, eref: StableOrId, generated: bool, doc: &ComponentDoc, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    let sid = ui.make_persistent_id(("details.section", &doc.type_path));
    let state = egui::collapsing_header::CollapsingState::load_with_default_open(ui.ctx(), sid, true);
    let editable = doc.editable && !generated;
    let mut remove = false;
    let mut reset = false;
    let can_reset = editable && doc.default.as_ref().is_some_and(|d| *d != doc.value);
    state
        .show_header(ui, |ui| {
            let title = ui.label(RichText::new(&doc.short_name).strong().color(t.text.primary));
            title.on_hover_ui(|ui| {
                if !doc.doc.is_empty() {
                    ui.label(&doc.doc);
                }
                ui.label(RichText::new(&doc.type_path).small().monospace().color(t.text.disabled));
            });
            if !doc.editable {
                ui.label(RichText::new("read-only").color(t.text.disabled).small());
            }
            if editable && props::right_button(ui, "x", "Remove component") {
                remove = true;
            }
            if can_reset && props::right_reset(ui, "Reset the whole component to its defaults") {
                reset = true;
            }
        })
        .body(|ui| {
            let mut working = doc.value.clone();
            let mut cx = Cx::new(format!("{id}.{}", doc.type_path), !editable).with_default(doc.default.clone());
            props::component_body(ui, &mut cx, &doc.schema, &mut working);
            if let Some(change) = cx.change
                && change.phase != Phase::Begin
                && working != doc.value
            {
                reqs.push(Req::Edit {
                    op: Op::SetComponent {
                        entity: eref,
                        type_path: doc.type_path.clone(),
                        before: Some(doc.value.clone()),
                        after: Some(working),
                    },
                    label: format!("Edit {}", doc.short_name),
                    key: Some(format!("{id}|{}|{}", doc.type_path, change.path)),
                    seal: matches!(change.phase, Phase::Commit | Phase::Cancel),
                });
            }
        });
    if reset && let Some(def) = &doc.default {
        reqs.push(Req::Edit {
            op: Op::SetComponent {
                entity: eref,
                type_path: doc.type_path.clone(),
                before: Some(doc.value.clone()),
                after: Some(def.clone()),
            },
            label: format!("Reset {}", doc.short_name),
            key: None,
            seal: true,
        });
    }
    if remove {
        reqs.push(Req::Edit {
            op: Op::SetComponent {
                entity: eref,
                type_path: doc.type_path.clone(),
                before: Some(doc.value.clone()),
                after: None,
            },
            label: format!("Remove {}", doc.short_name),
            key: None,
            seal: true,
        });
    }
}

/// The `+ Add` popup: searchable list of the component types that are not on the entity yet.
fn add_component_menu(ui: &mut Ui, st: &mut DetailsState, eref: StableOrId, have: &[ComponentDoc], types: &[(String, TypeSchema)], reqs: &mut Vec<Req>) {
    ui.set_min_width(240.0);
    let r = ui.add(egui::TextEdit::singleline(&mut st.add_filter).hint_text("Search components").desired_width(f32::INFINITY));
    if !r.has_focus() && st.add_filter.is_empty() {
        r.request_focus();
    }
    let f = st.add_filter.to_lowercase();
    ui.add_space(4.0);
    let mut shown = 0;
    egui::ScrollArea::vertical().max_height(280.0).show(ui, |ui| {
        for (path, schema) in types {
            if have.iter().any(|d| d.type_path == *path) {
                continue;
            }
            let short = path.rsplit("::").next().unwrap_or(path);
            if short == "Logic" || (!f.is_empty() && !short.to_lowercase().contains(&f)) {
                continue;
            }
            shown += 1;
            if ui.selectable_label(false, short).on_hover_text(path).clicked() {
                reqs.push(Req::Edit {
                    op: Op::SetComponent {
                        entity: eref,
                        type_path: path.clone(),
                        before: None,
                        after: Some(props::default_value(schema)),
                    },
                    label: format!("Add {short}"),
                    key: None,
                    seal: true,
                });
                st.add_filter.clear();
                ui.close();
            }
        }
        if shown == 0 {
            ui.weak("No component type matches");
        }
    });
}

/// A name that is safe as a file stem: `Big Crate` -> `Big_Crate_logic`.
fn default_graph_name(entity: &str) -> String {
    let stem: String = entity.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    let stem = stem.trim_matches('_');
    if stem.is_empty() { "new_logic".to_owned() } else { format!("{stem}_logic") }
}

fn attach_op(eref: StableOrId, logic_type: &str, comps: &[ComponentDoc], graph: &str) -> Op {
    Op::SetComponent {
        entity: eref,
        type_path: logic_type.to_owned(),
        before: comps.iter().find(|d| is_logic_component(d)).map(|d| d.value.clone()),
        after: Some(json!({ "graph": graph })),
    }
}

/// The `+ Add Logic` popup: a new graph from a template, or an existing one.
fn add_logic_menu(ui: &mut Ui, st: &mut DetailsState, id: EntityId, info: &NodeInfo, comps: &[ComponentDoc], v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    let Some(ltype) = logic_type(v.types, comps) else { return };
    ui.set_min_width(300.0);
    if st.logic_name_for != Some(id) {
        st.logic_name_for = Some(id);
        st.logic_name = default_graph_name(&info.name);
    }
    ui.label(RichText::new("New graph from template").strong());
    for (i, (_, label, what)) in TEMPLATES.iter().enumerate() {
        ui.radio_value(&mut st.logic_template, i, *label).on_hover_text(*what);
    }
    ui.horizontal(|ui| {
        ui.label("Name");
        ui.add(egui::TextEdit::singleline(&mut st.logic_name).desired_width(f32::INFINITY));
    });
    let name = st.logic_name.trim().to_owned();
    let template = TEMPLATES.get(st.logic_template).map_or("empty", |t| t.0);
    let exists = v.logic.iter().any(|f| f.name == name);
    let create = ui.add_enabled(!name.is_empty() && !exists, egui::Button::new("Create and attach"));
    if exists {
        ui.label(RichText::new(format!("A graph named {name} exists: pick it below, or change the name.")).small().color(t.status.warning));
    }
    if create.clicked() {
        reqs.push(Req::AddLogic {
            entity: id,
            eref: info.reference,
            name,
            template: template.to_owned(),
            logic_type: ltype.clone(),
            before: comps.iter().find(|d| is_logic_component(d)).map(|d| d.value.clone()),
        });
        ui.close();
    }
    ui.separator();
    ui.label(RichText::new("Existing graph").strong());
    ui.add(egui::TextEdit::singleline(&mut st.logic_filter).hint_text("Search graphs").desired_width(f32::INFINITY));
    let f = st.logic_filter.to_lowercase();
    let mut n = 0;
    egui::ScrollArea::vertical().id_salt("details.logic.existing").max_height(140.0).show(ui, |ui| {
        for file in v.logic.iter().filter(|x| f.is_empty() || x.name.to_lowercase().contains(&f)) {
            n += 1;
            if ui.selectable_label(false, &file.name).on_hover_text(&file.path).clicked() {
                reqs.push(Req::Edit { op: attach_op(info.reference, &ltype, comps, &file.path), label: format!("Attach {}", file.name), key: None, seal: true });
                ui.close();
            }
        }
        if n == 0 {
            ui.weak(if v.logic.is_empty() { "No logic graphs in this project yet" } else { "No graph matches" });
        }
    });
}

/// The attached graph(s) with Open / Detach, or the empty state.
fn logic_section(ui: &mut Ui, st: &mut DetailsState, id: EntityId, info: &NodeInfo, comps: &[ComponentDoc], v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    ui.add_space(t.space.xs);
    ui.label(RichText::new("Logic").small().strong().color(t.text.secondary));
    let attached: Vec<&ComponentDoc> = comps.iter().filter(|d| is_logic_component(d)).collect();
    let graphs: Vec<(&ComponentDoc, String)> = attached
        .iter()
        .filter_map(|d| d.value.get("graph").and_then(Value::as_str).map(|g| (*d, g.to_owned())))
        .filter(|(_, g)| !g.is_empty())
        .collect();
    if graphs.is_empty() {
        ui.label(RichText::new("No logic. Add a behaviour with graphs.").color(t.text.disabled));
    }
    for (doc, graph) in &graphs {
        let file = v.logic.iter().find(|f| f.path == *graph);
        let errors = file.map_or(0, |f| f.errors.len());
        let name = graph.rsplit('/').next().unwrap_or(graph).trim_end_matches(".logic.ron").to_owned();
        ui.horizontal(|ui| {
            let (dot, tip) = match file {
                None => (t.text.disabled, "File not found".to_owned()),
                Some(_) if errors > 0 => (t.status.danger, format!("{errors} problem(s): open the graph to see them")),
                Some(_) => (t.status.success, "Compiles".to_owned()),
            };
            let (r, _) = ui.allocate_exact_size(egui::vec2(10.0, 10.0), egui::Sense::hover());
            ui.painter().circle_filled(r.center(), 4.0, dot);
            ui.label(RichText::new(&name).color(t.text.primary)).on_hover_text(format!("{graph}\n{tip}"));
            if errors > 0 {
                ui.label(RichText::new(format!("{errors} error(s)")).small().color(t.status.danger));
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if !info.generated && ui.small_button("Detach").on_hover_text("Remove the Logic component (the file stays)").clicked() {
                    reqs.push(Req::Edit {
                        op: Op::SetComponent { entity: info.reference, type_path: doc.type_path.clone(), before: Some(doc.value.clone()), after: None },
                        label: format!("Detach {name}"),
                        key: None,
                        seal: true,
                    });
                }
                if ui.small_button("Open").on_hover_text("Open the graph in the Logic tab").clicked() {
                    reqs.push(Req::OpenLogic(graph.clone()));
                }
            });
        });
    }
    if let Some((e, path)) = st.created.clone()
        && e == id
    {
        egui::Frame::group(ui.style()).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new(format!("Created {path}")).small().color(t.status.success));
                if ui.small_button("Open graph").clicked() {
                    reqs.push(Req::OpenLogic(path.clone()));
                    st.created = None;
                }
                if ui.small_button("Dismiss").clicked() {
                    st.created = None;
                }
            });
        });
    }
}
