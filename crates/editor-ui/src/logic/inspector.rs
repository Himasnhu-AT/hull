//! The node inspector (right of the canvas) and the value / parameter editors the canvas
//! shares: fields, documentation, defaults of unconnected pins, variables and comments.

use ashlar_ui::tokens;
use egui::{Color32, RichText, Ui};
use logic_core::{CmpOp, MathOp, NodeKind, Ty, Value, Var};

use super::palette::category_color;
use super::state::{GraphDoc, PinLayout, PinTy, Sel};

/// A fresh value of a type.
pub fn zero(t: Ty) -> Value {
    match t {
        Ty::Bool => Value::Bool(false),
        Ty::Number => Value::Num(0.0),
        Ty::String => Value::text(""),
        Ty::Vec3 => Value::Vec3([0.0; 3]),
        Ty::Entity | Ty::Json | Ty::Any => Value::Null,
    }
}

fn kind_label(v: &Value) -> &'static str {
    match v {
        Value::Null => "none",
        Value::Bool(_) => "bool",
        Value::Num(_) => "number",
        Value::Str(_) => "string",
        Value::Vec3(_) => "vec3",
        Value::Entity(_) => "entity",
        Value::Json(_) => "json",
    }
}

/// Edit `v` as a `t`. `Any` offers a type picker. Returns true when changed.
pub fn value_edit(ui: &mut Ui, t: Ty, v: &mut Value, compact: bool) -> bool {
    let mut changed = false;
    match t {
        Ty::Bool => {
            let mut b = matches!(v, Value::Bool(true));
            if ui.checkbox(&mut b, "").changed() {
                *v = Value::Bool(b);
                changed = true;
            }
        }
        Ty::Number => {
            let mut n = if let Value::Num(n) = v { *n } else { 0.0 };
            if ui.add(egui::DragValue::new(&mut n).speed(0.05)).changed() {
                *v = Value::Num(n);
                changed = true;
            }
        }
        Ty::String => {
            let mut s = if let Value::Str(s) = v { s.to_string() } else { String::new() };
            let w = if compact { 70.0 } else { 160.0 };
            if ui.add(egui::TextEdit::singleline(&mut s).desired_width(w)).changed() {
                *v = Value::text(&s);
                changed = true;
            }
        }
        Ty::Vec3 => {
            let mut a = if let Value::Vec3(a) = v { *a } else { [0.0; 3] };
            ui.horizontal(|ui| {
                for c in &mut a {
                    changed |= ui.add(egui::DragValue::new(c).speed(0.05)).changed();
                }
            });
            if changed {
                *v = Value::Vec3(a);
            }
        }
        Ty::Entity => {
            ui.weak(if matches!(v, Value::Entity(_)) { "entity" } else { "self" });
        }
        Ty::Json => {
            let mut s = v.to_json().to_string();
            if ui.add(egui::TextEdit::singleline(&mut s).desired_width(if compact { 70.0 } else { 160.0 })).changed() {
                if let Ok(j) = serde_json::from_str::<serde_json::Value>(&s) {
                    *v = Value::from_json(&j);
                }
                changed = true;
            }
        }
        Ty::Any => {
            let cur = kind_label(v);
            egui::ComboBox::from_id_salt(ui.next_auto_id()).selected_text(cur).width(70.0).show_ui(ui, |ui| {
                for (name, ty) in [("none", None), ("bool", Some(Ty::Bool)), ("number", Some(Ty::Number)), ("string", Some(Ty::String)), ("vec3", Some(Ty::Vec3))] {
                    if ui.selectable_label(cur == name, name).clicked() && cur != name {
                        *v = ty.map_or(Value::Null, zero);
                        changed = true;
                    }
                }
            });
            let inner = match v {
                Value::Bool(_) => Some(Ty::Bool),
                Value::Num(_) => Some(Ty::Number),
                Value::Str(_) => Some(Ty::String),
                Value::Vec3(_) => Some(Ty::Vec3),
                _ => None,
            };
            if let Some(it) = inner {
                changed |= value_edit(ui, it, v, compact);
            }
        }
    }
    changed
}

/// Kinds with parameters worth editing on the node itself.
pub fn kind_params(k: &NodeKind) -> bool {
    matches!(
        k,
        NodeKind::Delay { .. } | NodeKind::Timer { .. } | NodeKind::Action(_) | NodeKind::Message(_) | NodeKind::Emit(_) | NodeKind::Find { .. } | NodeKind::Get { .. } | NodeKind::Set { .. } | NodeKind::Const(_) | NodeKind::Math(_) | NodeKind::Compare(_) | NodeKind::Sequence { .. }
    )
}

fn text(ui: &mut Ui, label: &str, s: &mut String, compact: bool) -> bool {
    ui.horizontal(|ui| {
        if !compact {
            ui.label(label);
        }
        ui.add(egui::TextEdit::singleline(s).desired_width(if compact { 110.0 } else { 170.0 }).hint_text(label)).changed()
    })
    .inner
}

fn secs(ui: &mut Ui, label: &str, s: &mut f32) -> bool {
    ui.horizontal(|ui| {
        ui.label(label);
        ui.add(egui::DragValue::new(s).speed(0.05).range(0.0..=3600.0).suffix(" s")).changed()
    })
    .inner
}

/// Parameter editors of a kind. `compact` is the node-body form. Returns true on change.
pub fn edit_kind(ui: &mut Ui, kind: &mut NodeKind, compact: bool) -> bool {
    match kind {
        NodeKind::Delay { secs: s } => secs(ui, "wait", s),
        NodeKind::Timer { secs: s, repeat } => {
            let a = secs(ui, "every", s);
            a | ui.checkbox(repeat, "repeat").changed()
        }
        NodeKind::Action(n) => text(ui, "action", n, compact),
        NodeKind::Message(n) | NodeKind::Emit(n) => text(ui, "message", n, compact),
        NodeKind::Find { name } => text(ui, "entity name", name, compact),
        NodeKind::Get { path } | NodeKind::Set { path } => text(ui, "Component.field", path, compact),
        NodeKind::Const(v) => {
            let ty = v.ty();
            let ty = if matches!(v, Value::Null) { Ty::Number } else { ty };
            if matches!(v, Value::Null) {
                *v = Value::Num(0.0);
            }
            value_edit(ui, ty, v, compact)
        }
        NodeKind::Math(op) => {
            let mut changed = false;
            egui::ComboBox::from_id_salt(ui.next_auto_id()).selected_text(format!("{op:?}")).width(60.0).show_ui(ui, |ui| {
                for o in [MathOp::Add, MathOp::Sub, MathOp::Mul, MathOp::Div, MathOp::Min, MathOp::Max] {
                    changed |= ui.selectable_value(op, o, format!("{o:?}")).changed();
                }
            });
            changed
        }
        NodeKind::Compare(op) => {
            let mut changed = false;
            egui::ComboBox::from_id_salt(ui.next_auto_id()).selected_text(logic_core::cmp_symbol(*op)).width(50.0).show_ui(ui, |ui| {
                for o in [CmpOp::Eq, CmpOp::Ne, CmpOp::Lt, CmpOp::Le, CmpOp::Gt, CmpOp::Ge] {
                    changed |= ui.selectable_value(op, o, logic_core::cmp_symbol(o)).changed();
                }
            });
            changed
        }
        NodeKind::Sequence { n } => {
            let mut v = *n as u32;
            let c = ui.horizontal(|ui| {
                ui.label("outputs");
                ui.add(egui::DragValue::new(&mut v).range(1..=16)).changed()
            });
            if c.inner {
                *n = v as u8;
            }
            c.inner
        }
        _ => false,
    }
}

/// Extra editors the inspector adds for kinds with structure (commands, scripts, variables).
fn edit_kind_full(ui: &mut Ui, kind: &mut NodeKind, vars: &[Var]) -> bool {
    match kind {
        NodeKind::Command { id, params } => {
            let mut changed = text(ui, "command id", id, false);
            ui.label("params (JSON, \"$name\" makes an input pin)");
            let mut s = serde_json::to_string_pretty(params).unwrap_or_default();
            if ui.add(egui::TextEdit::multiline(&mut s).desired_width(f32::INFINITY).code_editor().desired_rows(4)).changed()
                && let Ok(j) = serde_json::from_str(&s)
            {
                *params = j;
                changed = true;
            }
            changed
        }
        NodeKind::Script { file, function, args } => {
            let mut changed = text(ui, "file", file, false);
            changed |= text(ui, "function", function, false);
            let mut a = args.join(", ");
            if text(ui, "arguments (pin names)", &mut a, false) {
                *args = a.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
                changed = true;
            }
            changed
        }
        NodeKind::GetVar(n) | NodeKind::SetVar(n) => {
            let mut changed = false;
            egui::ComboBox::from_id_salt("var-pick").selected_text(n.as_str()).show_ui(ui, |ui| {
                for v in vars {
                    changed |= ui.selectable_value(n, v.name.clone(), &v.name).changed();
                }
            });
            changed
        }
        k => edit_kind(ui, k, false),
    }
}

pub fn show(ui: &mut Ui, doc: &mut GraphDoc) {
    let t = tokens::current(ui.ctx());
    ui.add_space(4.0);
    match doc.sel.clone() {
        Sel::Node(id) => node(ui, doc, id),
        Sel::Var(name) => var(ui, doc, &name),
        Sel::Comment(i) => comment(ui, doc, i),
        Sel::None => {
            ui.label(RichText::new(format!("Graph {}", doc.name)).strong().color(t.text.primary));
            ui.weak(format!("{} nodes, {} variables", doc.snarl.nodes().count(), doc.vars.len()));
            ui.add_space(6.0);
            ui.weak("Right-click the canvas to add a node. Drag from a pin and release on empty space to add a connected node.");
            ui.add_space(6.0);
            ui.weak("Select a node to see its fields and documentation.");
        }
    }
}

fn node(ui: &mut Ui, doc: &mut GraphDoc, id: u32) {
    let t = tokens::current(ui.ctx());
    let Some(nid) = doc.node_ids().get(&id).copied() else {
        ui.weak("Node no longer exists.");
        return;
    };
    let Some(sn) = doc.snarl.get_node(nid).cloned() else { return };
    let cat = logic_core::category(&sn.kind);
    ui.horizontal(|ui| {
        ui.label(RichText::new(logic_core::label(&sn.kind)).strong().size(15.0).color(Color32::WHITE).background_color(category_color(cat).gamma_multiply(0.85)));
        ui.weak(format!("#{id}  {cat}"));
    });
    ui.add_space(2.0);
    ui.label(RichText::new(logic_core::docs(&sn.kind)).color(t.text.secondary));
    ui.separator();
    // Parameters.
    let before = PinLayout::of(&doc.vars, &sn.kind);
    let vars = doc.vars.clone();
    let mut kind = sn.kind.clone();
    if edit_kind_full(ui, &mut kind, &vars)
        && let Some(n) = doc.snarl.get_node_mut(nid)
    {
        n.kind = kind;
        doc.relayout(nid, &before);
    }
    // Defaults of data inputs.
    let layout = PinLayout::of(&doc.vars, &doc.snarl[nid].kind);
    let connected: Vec<usize> = doc.snarl.wires().filter(|(_, i)| i.node == nid).map(|(_, i)| i.input).collect();
    let data_ins: Vec<(usize, &super::state::PinDef)> = layout.ins.iter().enumerate().filter(|(_, p)| p.ty != PinTy::Flow).collect();
    if !data_ins.is_empty() {
        ui.separator();
        ui.label(RichText::new("Inputs").strong());
        for (idx, p) in data_ins {
            let PinTy::Data(ty) = p.ty else { continue };
            ui.horizontal(|ui| {
                ui.label(RichText::new(&p.name).color(p.ty.color()));
                ui.weak(p.ty.name());
                if connected.contains(&idx) {
                    ui.weak("connected");
                    return;
                }
                let n = &mut doc.snarl[nid];
                let at = n.defaults.iter().position(|(nm, _)| *nm == p.name);
                let mut v = at.map_or_else(|| zero(ty), |i| n.defaults[i].1.clone());
                if value_edit(ui, ty, &mut v, false) {
                    match at {
                        Some(i) => n.defaults[i].1 = v,
                        None => n.defaults.push((p.name.clone(), v)),
                    }
                }
                if at.is_some() && ui.small_button("x").on_hover_text("Remove the default").clicked() {
                    n.defaults.retain(|(nm, _)| *nm != p.name);
                }
            });
        }
    }
    let outs: Vec<&super::state::PinDef> = layout.outs.iter().filter(|p| p.ty != PinTy::Flow).collect();
    if !outs.is_empty() {
        ui.separator();
        ui.label(RichText::new("Outputs").strong());
        for p in outs {
            ui.horizontal(|ui| {
                ui.label(RichText::new(&p.name).color(p.ty.color()));
                ui.weak(p.ty.name());
            });
        }
    }
    // Errors.
    let errs: Vec<_> = doc.errors.iter().filter(|e| e.node == Some(id)).cloned().collect();
    if !errs.is_empty() {
        ui.separator();
        for e in errs {
            let col = if e.severity == logic_core::Severity::Error { t.status.danger } else { t.status.warning };
            ui.label(RichText::new(match &e.pin {
                Some(p) => format!("{}: {}", p, e.message),
                None => e.message.clone(),
            }).color(col));
        }
    }
    ui.add_space(8.0);
    if ui.button("Delete node").clicked() {
        doc.snarl.remove_node(nid);
        doc.sel = Sel::None;
    }
}

fn var(ui: &mut Ui, doc: &mut GraphDoc, name: &str) {
    let Some(i) = doc.vars.iter().position(|v| v.name == name) else {
        ui.weak("Variable no longer exists.");
        return;
    };
    ui.label(RichText::new("Variable").strong());
    ui.weak("Lives on the entity carrying the graph; starts at its default.");
    ui.separator();
    let mut new_name = doc.vars[i].name.clone();
    ui.horizontal(|ui| {
        ui.label("name");
        ui.add(egui::TextEdit::singleline(&mut new_name).desired_width(140.0));
    });
    let mut ty = doc.vars[i].ty;
    ui.horizontal(|ui| {
        ui.label("type");
        egui::ComboBox::from_id_salt("var-ty").selected_text(PinTy::Data(ty).name()).show_ui(ui, |ui| {
            for t in [Ty::Bool, Ty::Number, Ty::String, Ty::Vec3, Ty::Entity, Ty::Json] {
                ui.selectable_value(&mut ty, t, PinTy::Data(t).name());
            }
        });
    });
    let mut def = doc.vars[i].default.clone();
    ui.horizontal(|ui| {
        ui.label("default");
        value_edit(ui, ty, &mut def, false);
    });
    if ty != doc.vars[i].ty {
        def = zero(ty);
    }
    let sane = !new_name.is_empty() && !doc.vars.iter().enumerate().any(|(j, v)| j != i && v.name == new_name);
    if sane && new_name != doc.vars[i].name {
        let old = std::mem::replace(&mut doc.vars[i].name, new_name.clone());
        for n in doc.snarl.nodes_ids_data_mut() {
            if let NodeKind::GetVar(x) | NodeKind::SetVar(x) = &mut n.1.value.kind
                && *x == old
            {
                *x = new_name.clone();
            }
        }
        doc.sel = Sel::Var(new_name);
    }
    if let Some(v) = doc.vars.get_mut(i) {
        v.ty = ty;
        v.default = def;
    }
    ui.add_space(8.0);
    if ui.button("Delete variable").clicked() {
        doc.vars.remove(i);
        doc.sel = Sel::None;
    }
}

fn comment(ui: &mut Ui, doc: &mut GraphDoc, i: usize) {
    let Some(c) = doc.comments.get_mut(i) else {
        ui.weak("Comment no longer exists.");
        return;
    };
    ui.label(RichText::new("Comment").strong());
    ui.separator();
    ui.add(egui::TextEdit::multiline(&mut c.text).desired_width(f32::INFINITY).desired_rows(3));
    ui.horizontal(|ui| {
        ui.label("colour");
        ui.color_edit_button_srgb(&mut c.color);
    });
    ui.horizontal(|ui| {
        ui.label("size");
        ui.add(egui::DragValue::new(&mut c.size[0]).range(80.0..=4000.0));
        ui.add(egui::DragValue::new(&mut c.size[1]).range(50.0..=4000.0));
    });
    if ui.button("Delete comment").clicked() {
        doc.comments.remove(i);
        doc.sel = Sel::None;
    }
}
