//! Node scripts in Details (Godot's Script slot, exported properties, Node dock and Groups):
//! attach / create / open / detach a script, edit member overrides (`ScriptProps`), list signals
//! with their `Connections` and a Connect flow, and edit `Groups`.
//!
//! The data are ordinary reflected components, so every edit is a `SetComponent` op through
//! `Req::Edit` (undoable, saved with the level). The backend only computes what the components
//! can't tell: members, functions, signals, resolved connections (`ScriptInfo`), the relative
//! node path of a target, and the method stub appended to the target's script file.

use ashlar_ui::tokens;
use editor_proto::{ComponentDoc, EntityId, LogicFile, MemberHint, Op, ScriptFn, ScriptInfo, StableOrId, TypeSchema};
use egui::{RichText, Ui};
use serde_json::{Value, json};

use crate::model::Req;

/// Script templates `script_create` is asked for: `(id, label)`.
pub(crate) const TEMPLATES: [(&str, &str); 2] = [("node", "Node (_ready, _process)"), ("empty", "Empty")];

/// The component of the scripting module with this short name (`Script`, `ScriptProps`,
/// `Groups`, `Connections`).
pub(crate) fn is_script_component(doc: &ComponentDoc) -> bool {
    matches!(doc.short_name.as_str(), "Script" | "ScriptProps" | "Groups" | "Connections") && doc.type_path.contains("scripting::")
}

fn find<'a>(comps: &'a [ComponentDoc], name: &str) -> Option<&'a ComponentDoc> {
    comps.iter().find(|d| d.short_name == name && d.type_path.contains("scripting::"))
}

fn type_path(comps: &[ComponentDoc], types: &[(String, TypeSchema)], name: &str) -> Option<String> {
    find(comps, name)
        .map(|d| d.type_path.clone())
        .or_else(|| types.iter().find(|(p, _)| p.contains("scripting::") && p.rsplit("::").next() == Some(name)).map(|(p, _)| p.clone()))
}

/// A chosen connection target, filled in by the engine side (`Req::ScriptPick`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TargetPick {
    pub id: EntityId,
    pub name: String,
    /// Node path from the source (`../HUD`).
    pub path: String,
    /// The target's script path (empty = no script) and its functions.
    pub script: String,
    pub fns: Vec<ScriptFn>,
}

#[derive(Default)]
struct Draft {
    signal: String,
    filter: String,
    target: Option<TargetPick>,
    method: String,
    params: String,
    one_shot: bool,
    deferred: bool,
    error: Option<String>,
}

#[derive(Default)]
pub(crate) struct ScriptState {
    /// Member being typed in: `(name, text)`.
    editing: Option<(String, String)>,
    attach_open: bool,
    attach_name: String,
    attach_for: Option<EntityId>,
    attach_template: usize,
    attach_filter: String,
    group_input: String,
    draft: Option<Draft>,
    last_id: Option<EntityId>,
}

impl ScriptState {
    pub(crate) fn connect_open(&self) -> bool {
        self.draft.is_some()
    }

    /// The engine side resolved a target for the open Connect panel.
    pub(crate) fn set_target(&mut self, target: Result<TargetPick, String>, source_name: &str) {
        let Some(d) = self.draft.as_mut() else { return };
        match target {
            Ok(t) => {
                d.method = default_method(source_name, &d.signal);
                d.params = default_params(&d.signal).join(", ");
                d.error = None;
                d.target = Some(t);
            }
            Err(e) => {
                d.target = None;
                d.error = Some(e);
            }
        }
    }
}

/// Godot's `_on_<Source>_<signal>`.
pub(crate) fn default_method(source: &str, signal: &str) -> String {
    let clean = |s: &str| s.chars().map(|c| if c.is_alphanumeric() { c } else { '_' }).collect::<String>();
    format!("_on_{}_{}", clean(source), clean(signal))
}

/// The argument names a handler of `signal` gets.
pub(crate) fn default_params(signal: &str) -> Vec<String> {
    match signal {
        "body_entered" | "body_exited" => vec!["other".into()],
        _ => vec![],
    }
}

fn params_of(text: &str) -> Vec<String> {
    text.split(',').map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()).collect()
}

pub(crate) struct View<'a> {
    pub id: EntityId,
    pub eref: StableOrId,
    pub name: &'a str,
    pub editable: bool,
    pub comps: &'a [ComponentDoc],
    pub types: &'a [(String, TypeSchema)],
    pub info: Option<&'a ScriptInfo>,
    pub files: &'a [LogicFile],
    /// Every entity, for the Connect target list.
    pub targets: &'a [(EntityId, String)],
}

fn edit(reqs: &mut Vec<Req>, v: &View<'_>, ty: &str, before: Option<Value>, after: Option<Value>, label: &str, key: Option<String>) {
    reqs.push(Req::Edit { op: Op::SetComponent { entity: v.eref, type_path: ty.to_owned(), before, after }, label: label.to_owned(), key, seal: true });
}

fn script_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).trim_end_matches(".ruspy").to_owned()
}

pub(crate) fn show(ui: &mut Ui, st: &mut ScriptState, v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    if st.last_id != Some(v.id) {
        st.last_id = Some(v.id);
        *st = ScriptState { last_id: Some(v.id), ..Default::default() };
    }
    let header = |ui: &mut Ui, text: &str| {
        ui.add_space(t.space.xs);
        ui.label(RichText::new(text).small().strong().color(t.text.secondary));
    };
    header(ui, "Script");
    script_slot(ui, st, v, reqs);
    if v.info.is_some_and(|i| !i.members.is_empty()) {
        header(ui, "Script members");
        members(ui, st, v, reqs);
    }
    let has_signals = v.info.is_some_and(|i| !i.signals.is_empty() || !i.connections.is_empty());
    if has_signals {
        header(ui, "Signals");
        signals(ui, st, v, reqs);
    }
    header(ui, "Groups");
    groups(ui, st, v, reqs);
}

fn script_slot(ui: &mut Ui, st: &mut ScriptState, v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    let script = find(v.comps, "Script");
    let path = script.and_then(|d| d.value.get("path").and_then(Value::as_str)).unwrap_or("").to_owned();
    let Some(sty) = type_path(v.comps, v.types, "Script") else {
        ui.label(RichText::new("This game has no scripting").color(t.text.disabled));
        return;
    };
    if !path.is_empty() {
        let found = v.info.is_none_or(|i| i.found);
        ui.horizontal(|ui| {
            let (r, _) = ui.allocate_exact_size(egui::vec2(10.0, 10.0), egui::Sense::hover());
            ui.painter().circle_filled(r.center(), 4.0, if found { t.status.success } else { t.status.danger });
            ui.label(RichText::new(script_name(&path)).color(t.text.primary)).on_hover_text(if found { path.clone() } else { format!("{path}: file not found") });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if v.editable && ui.small_button("Detach").on_hover_text("Remove the Script component (the file stays)").clicked() {
                    edit(reqs, v, &sty, script.map(|d| d.value.clone()), None, &format!("Detach {}", script_name(&path)), None);
                }
                if ui.small_button("Open").on_hover_text("Open the script in the editor tab").clicked() {
                    reqs.push(Req::OpenLogic(key(&path)));
                }
            });
        });
        return;
    }
    ui.label(RichText::new("No script.").color(t.text.disabled));
    if !v.editable {
        return;
    }
    if ui.button("Attach script").on_hover_text("Create a new script or pick an existing one").clicked() {
        st.attach_open = !st.attach_open;
    }
    if !st.attach_open {
        return;
    }
    if st.attach_for != Some(v.id) {
        st.attach_for = Some(v.id);
        st.attach_name = v.name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect::<String>().to_lowercase();
    }
    egui::Frame::group(ui.style()).show(ui, |ui| {
        ui.label(RichText::new("New script").small().strong());
        for (i, (_, label)) in TEMPLATES.iter().enumerate() {
            ui.radio_value(&mut st.attach_template, i, *label);
        }
        ui.horizontal(|ui| {
            ui.label("Name");
            ui.add(egui::TextEdit::singleline(&mut st.attach_name).desired_width(f32::INFINITY));
        });
        let name = st.attach_name.trim().to_owned();
        let exists = v.files.iter().any(|f| f.path == format!("scripts/{name}.ruspy"));
        let ok = !name.is_empty() && !exists;
        if ui.add_enabled(ok, egui::Button::new("Create and attach")).on_disabled_hover_text(if exists { "A script with this name exists" } else { "Give the script a name" }).clicked() {
            reqs.push(Req::ScriptNew {
                entity: v.id,
                eref: v.eref,
                name,
                template: TEMPLATES.get(st.attach_template).map_or("node", |t| t.0).to_owned(),
                script_type: sty.clone(),
                before: script.map(|d| d.value.clone()),
            });
            st.attach_open = false;
        }
        ui.separator();
        ui.label(RichText::new("Existing script").small().strong());
        ui.add(egui::TextEdit::singleline(&mut st.attach_filter).hint_text("Search scripts").desired_width(f32::INFINITY));
        let f = st.attach_filter.to_lowercase();
        let mut any = false;
        egui::ScrollArea::vertical().id_salt("details.script.existing").max_height(120.0).show(ui, |ui| {
            for file in v.files.iter().filter(|x| x.path.ends_with(".ruspy") && (f.is_empty() || x.name.to_lowercase().contains(&f))) {
                any = true;
                if ui.selectable_label(false, &file.name).on_hover_text(&file.path).clicked() {
                    edit(reqs, v, &sty, script.map(|d| d.value.clone()), Some(json!({"path": file.path, "priority": 0})), &format!("Attach {}", file.name), None);
                    st.attach_open = false;
                }
            }
            if !any {
                ui.weak("No scripts in this project yet");
            }
        });
    });
}

/// `scripts/x.ruspy` or `x.ruspy` as the tab path.
fn key(path: &str) -> String {
    if path.contains('/') { path.to_owned() } else { format!("scripts/{path}") }
}

fn overrides(props: Option<&ComponentDoc>) -> Vec<(String, String)> {
    props
        .and_then(|d| d.value.get("values").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|p| Some((p.get("name")?.as_str()?.to_owned(), p.get("value")?.as_str()?.to_owned())))
        .collect()
}

fn props_value(list: &[(String, String)]) -> Value {
    json!({ "values": list.iter().map(|(n, v)| json!({"name": n, "value": v})).collect::<Vec<_>>() })
}

fn members(ui: &mut Ui, st: &mut ScriptState, v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    let Some(info) = v.info else { return };
    let props = find(v.comps, "ScriptProps");
    let list = overrides(props);
    let pty = type_path(v.comps, v.types, "ScriptProps");
    for m in &info.members {
        if m.name.starts_with('_') {
            continue;
        }
        let current = list.iter().find(|(n, _)| *n == m.name).map(|(_, x)| x.clone());
        let editing = st.editing.as_ref().filter(|(n, _)| *n == m.name).map(|(_, x)| x.clone());
        let mut text = editing.clone().or_else(|| current.clone()).unwrap_or_default();
        let invalid = !text.trim().is_empty() && serde_json::from_str::<Value>(&text).is_err();
        ui.horizontal(|ui| {
            let label = ui.label(RichText::new(&m.name).color(if current.is_some() { t.text.primary } else { t.text.secondary }));
            let default_tip = if m.default.is_empty() { "No literal default".to_owned() } else { format!("Default: {}", m.default) };
            label.on_hover_text(if m.tooltip.is_empty() { default_tip } else { format!("{}\n{default_tip}", m.tooltip) });
            // The JSON text to store when a widget changes the value (empty clears the override).
            let mut commit: Option<String> = None;
            let can_edit = v.editable && pty.is_some();
            let shown = current.clone().unwrap_or_else(|| m.default.clone());
            let widget_id = format!("member {}", m.name);
            match &m.hint {
                MemberHint::Range { min, max, step } => {
                    let mut x = serde_json::from_str::<f64>(&shown).unwrap_or(*min);
                    let mut s = egui::Slider::new(&mut x, *min..=*max);
                    if *step > 0.0 {
                        s = s.step_by(*step);
                    }
                    let r = ui.add_enabled(can_edit, s);
                    r.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Slider, true, widget_id.clone()));
                    if r.changed() && !r.dragged() || r.drag_stopped() {
                        commit = Some(json!(x).to_string());
                    }
                }
                MemberHint::Enum { options } => {
                    // A string default stores the option text, an int default the index.
                    let by_name = !shown.trim().starts_with(|c: char| c.is_ascii_digit());
                    let selected = if by_name { serde_json::from_str::<String>(&shown).ok() } else { serde_json::from_str::<usize>(&shown).ok().and_then(|i| options.get(i).cloned()) };
                    ui.add_enabled_ui(can_edit, |ui| {
                        egui::ComboBox::from_id_salt(&widget_id).selected_text(selected.clone().unwrap_or_else(|| "(none)".into())).show_ui(ui, |ui| {
                            for (i, o) in options.iter().enumerate() {
                                if ui.selectable_label(selected.as_deref() == Some(o), o).clicked() {
                                    commit = Some(if by_name { json!(o).to_string() } else { json!(i).to_string() });
                                }
                            }
                        });
                    });
                }
                MemberHint::Color => {
                    let c: Vec<f32> = serde_json::from_str(&shown).unwrap_or_else(|_| vec![1.0, 1.0, 1.0, 1.0]);
                    let mut rgba = [c.first().copied().unwrap_or(1.0), c.get(1).copied().unwrap_or(1.0), c.get(2).copied().unwrap_or(1.0), c.get(3).copied().unwrap_or(1.0)];
                    let r = ui.add_enabled(can_edit, |ui: &mut Ui| ui.color_edit_button_rgba_unmultiplied(&mut rgba));
                    if r.changed() {
                        commit = Some(if c.len() == 3 { json!(rgba[..3]) } else { json!(rgba) }.to_string());
                    }
                }
                other => {
                    let hint = match other {
                        MemberHint::File { filter } if !filter.is_empty() => format!("file {filter}"),
                        _ if m.default.is_empty() => "JSON".to_owned(),
                        _ => m.default.clone(),
                    };
                    let mut edit_box = egui::TextEdit::singleline(&mut text).hint_text(hint).desired_width(140.0);
                    if invalid {
                        edit_box = edit_box.text_color(t.status.danger);
                    }
                    let r = ui.add_enabled(can_edit, edit_box);
                    r.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::TextEdit, true, widget_id.clone()));
                    if r.changed() {
                        st.editing = Some((m.name.clone(), text.clone()));
                    }
                    if r.lost_focus() {
                        st.editing = None;
                        let esc = ui.input(|i| i.key_pressed(egui::Key::Escape));
                        let committed = text.trim().to_owned();
                        if !esc && committed != current.clone().unwrap_or_default() && !invalid {
                            // Keep the JSON text as typed, normalised to compact form.
                            commit = Some(serde_json::from_str::<Value>(&committed).map_or(committed.clone(), |j| j.to_string()));
                        }
                    }
                    if invalid {
                        ui.label(RichText::new("not valid JSON").small().color(t.status.danger));
                    }
                }
            }
            if let Some(c) = commit
                && let Some(pty) = &pty
            {
                let mut next = list.clone();
                next.retain(|(n, _)| *n != m.name);
                if !c.is_empty() {
                    next.push((m.name.clone(), c));
                }
                edit(reqs, v, pty, props.map(|d| d.value.clone()), Some(props_value(&next)), &format!("Set {}", m.name), Some(format!("script.member.{}", m.name)));
            }
            if current.is_some() && v.editable && ui.small_button("\u{21BA}").on_hover_text("Reset to the script's default").clicked() {
                let mut next = list.clone();
                next.retain(|(n, _)| *n != m.name);
                if let Some(pty) = &pty {
                    edit(reqs, v, pty, props.map(|d| d.value.clone()), Some(props_value(&next)), &format!("Reset {}", m.name), None);
                }
                st.editing = None;
            }
        });
    }
}

fn signals(ui: &mut Ui, st: &mut ScriptState, v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    let Some(info) = v.info else { return };
    let conns = find(v.comps, "Connections");
    let cty = type_path(v.comps, v.types, "Connections");
    let list: Vec<Value> = conns.and_then(|d| d.value.as_array().cloned()).unwrap_or_default();
    for s in &info.signals {
        ui.horizontal(|ui| {
            ui.label(RichText::new(&s.name).color(t.text.primary)).on_hover_text(&s.doc);
            if !s.builtin {
                ui.label(RichText::new("script").small().color(t.text.disabled));
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.add_enabled(v.editable && cty.is_some(), egui::Button::new("Connect\u{2026}").small()).on_hover_text("Connect this signal to a method on another node").clicked() {
                    st.draft = Some(Draft { signal: s.name.clone(), ..Default::default() });
                }
            });
        });
    }
    // Existing connections.
    for (i, c) in list.iter().enumerate() {
        let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        let b = |k: &str| c.get(k).and_then(Value::as_bool).unwrap_or(false);
        let (signal, target, method) = (s("signal"), s("target"), s("method"));
        let res = info.connections.get(i);
        let (broken, tip) = match res {
            Some(r) if r.target_name.is_none() => (true, "The target node was not found".to_owned()),
            Some(r) if r.method_found == Some(false) => (true, format!("The target's script has no `{method}`")),
            _ => (false, String::new()),
        };
        ui.horizontal(|ui| {
            let color = if broken { t.status.warning } else { t.text.secondary };
            let shown = res.and_then(|r| r.target_name.clone()).unwrap_or_else(|| target.clone());
            let r = ui.label(RichText::new(format!("{signal} \u{2192} {shown}.{method}")).color(color));
            r.on_hover_text(if tip.is_empty() { format!("{target}.{method}") } else { format!("{target}.{method}\n{tip}") });
            if b("one_shot") {
                ui.label(RichText::new("one-shot").small().color(t.text.disabled));
            }
            if b("deferred") {
                ui.label(RichText::new("deferred").small().color(t.text.disabled));
            }
            if v.editable
                && let Some(cty) = &cty
            {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.small_button("Disconnect").clicked() {
                        let mut next = list.clone();
                        next.remove(i);
                        edit(reqs, v, cty, conns.map(|d| d.value.clone()), Some(Value::Array(next)), &format!("Disconnect {signal}"), None);
                    }
                });
            }
        });
    }
    connect_panel(ui, st, v, reqs, cty.as_deref(), conns, &list);
}

fn connect_panel(ui: &mut Ui, st: &mut ScriptState, v: &View<'_>, reqs: &mut Vec<Req>, cty: Option<&str>, conns: Option<&ComponentDoc>, list: &[Value]) {
    let t = tokens::current(ui.ctx());
    let Some(d) = st.draft.as_mut() else { return };
    let mut close = false;
    let mut pick = None;
    egui::Frame::group(ui.style()).show(ui, |ui| {
        ui.label(RichText::new(format!("Connect \"{}\"", d.signal)).strong());
        ui.label(RichText::new("Target node").small().color(t.text.secondary));
        let mut change = false;
        match &d.target {
            Some(tp) => {
                ui.horizontal(|ui| {
                    ui.label(RichText::new(&tp.name).color(t.text.primary)).on_hover_text(&tp.path);
                    ui.label(RichText::new(&tp.path).small().color(t.text.disabled));
                    change = ui.small_button("Change").clicked();
                });
            }
            None => {
                ui.add(egui::TextEdit::singleline(&mut d.filter).hint_text("Search nodes").desired_width(f32::INFINITY));
                let f = d.filter.to_lowercase();
                egui::ScrollArea::vertical().id_salt("details.script.targets").max_height(120.0).show(ui, |ui| {
                    for (id, name) in v.targets.iter().filter(|(_, n)| f.is_empty() || n.to_lowercase().contains(&f)).take(200) {
                        if ui.selectable_label(false, name).clicked() {
                            pick = Some(*id);
                        }
                    }
                });
            }
        }
        if change {
            d.target = None;
        }
        if let Some(e) = &d.error {
            ui.colored_label(t.status.danger, e);
        }
        if let Some(tp) = &d.target {
            ui.label(RichText::new("Method").small().color(t.text.secondary));
            ui.horizontal(|ui| {
                ui.add(egui::TextEdit::singleline(&mut d.method).desired_width(150.0));
                ui.menu_button("Existing \u{25BE}", |ui| {
                    for f in &tp.fns {
                        if ui.button(format!("{}({})", f.name, f.params.join(", "))).clicked() {
                            d.method = f.name.clone();
                            ui.close();
                        }
                    }
                    if tp.fns.is_empty() {
                        ui.weak("The target has no functions");
                    }
                });
            });
            let exists = tp.fns.iter().any(|f| f.name == d.method);
            let stub = !exists && !tp.script.is_empty() && !d.method.is_empty();
            if stub {
                ui.horizontal(|ui| {
                    ui.label("Params");
                    ui.add(egui::TextEdit::singleline(&mut d.params).desired_width(120.0));
                });
                ui.label(RichText::new(format!("A stub `{}` will be added to {}", d.method, tp.script)).small().color(t.status.info));
            } else if tp.script.is_empty() {
                ui.label(RichText::new("The target has no script: the method can't be checked").small().color(t.text.disabled));
            }
            ui.checkbox(&mut d.one_shot, "One-shot").on_hover_text("Disconnect after the first emission");
            ui.checkbox(&mut d.deferred, "Deferred").on_hover_text("Call at the end of the frame");
            let dup = list.iter().any(|c| {
                c.get("signal").and_then(Value::as_str) == Some(&d.signal) && c.get("target").and_then(Value::as_str) == Some(&tp.path) && c.get("method").and_then(Value::as_str) == Some(&d.method)
            });
            let ok = !d.method.is_empty() && !dup && cty.is_some();
            ui.horizontal(|ui| {
                if ui.add_enabled(ok, egui::Button::new("Connect")).on_disabled_hover_text(if dup { "Already connected" } else { "Give a method name" }).clicked()
                    && let Some(cty) = cty
                {
                    reqs.push(Req::ScriptConnect {
                        eref: v.eref,
                        conns_type: cty.to_owned(),
                        before: conns.map(|c| c.value.clone()),
                        conn: json!({"signal": d.signal, "target": tp.path, "method": d.method, "binds": [], "deferred": d.deferred, "one_shot": d.one_shot}),
                        stub: stub.then(|| (tp.id, params_of(&d.params))),
                    });
                    close = true;
                }
                if ui.button("Cancel").clicked() {
                    close = true;
                }
            });
        } else if ui.button("Cancel").clicked() {
            close = true;
        }
    });
    if let Some(to) = pick {
        reqs.push(Req::ScriptPick { from: v.id, to });
    }
    if close {
        st.draft = None;
    }
}

fn groups(ui: &mut Ui, st: &mut ScriptState, v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    let doc = find(v.comps, "Groups");
    let gty = type_path(v.comps, v.types, "Groups");
    let list: Vec<String> = doc.and_then(|d| d.value.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
    let Some(gty) = gty else {
        return;
    };
    if list.is_empty() {
        ui.label(RichText::new("Not in any group").color(t.text.disabled));
    }
    ui.horizontal_wrapped(|ui| {
        for g in &list {
            ui.label(RichText::new(g).color(t.text.primary));
            if v.editable && ui.small_button("\u{00D7}").on_hover_text(format!("Remove from group {g}")).clicked() {
                let next: Vec<&String> = list.iter().filter(|x| *x != g).collect();
                edit(reqs, v, &gty, doc.map(|d| d.value.clone()), Some(json!(next)), &format!("Leave group {g}"), None);
            }
        }
    });
    if v.editable {
        ui.horizontal(|ui| {
            let r = ui.add(egui::TextEdit::singleline(&mut st.group_input).hint_text("New group").desired_width(110.0));
            r.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::TextEdit, true, "group name"));
            let name = st.group_input.trim().to_owned();
            let go = (ui.add_enabled(!name.is_empty() && !list.contains(&name), egui::Button::new("Add group")).clicked()) || (r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) && !name.is_empty() && !list.contains(&name));
            if go {
                let mut next = list.clone();
                next.push(name.clone());
                edit(reqs, v, &gty, doc.map(|d| d.value.clone()), Some(json!(next)), &format!("Join group {name}"), None);
                st.group_input.clear();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handler_names_follow_godot() {
        assert_eq!(default_method("Start Button", "pressed"), "_on_Start_Button_pressed");
        assert_eq!(default_params("body_entered"), vec!["other".to_string()]);
        assert!(default_params("pressed").is_empty());
        assert_eq!(params_of(" a, b ,, c"), vec!["a", "b", "c"]);
    }

    #[test]
    fn member_overrides_round_trip_through_component_json() {
        let list = vec![("speed".to_string(), "5".to_string())];
        let doc = ComponentDoc {
            type_path: "engine::scripting::ScriptProps".into(),
            short_name: "ScriptProps".into(),
            value: props_value(&list),
            schema: TypeSchema::Opaque,
            editable: true,
            category: String::new(),
            doc: String::new(),
            default: None,
        };
        assert_eq!(overrides(Some(&doc)), list);
        assert!(is_script_component(&doc));
    }
}
