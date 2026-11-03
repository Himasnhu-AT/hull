//! Property grid: widgets built from a `TypeSchema`, editing a JSON value in place.
//!
//! The grid never talks to the backend. It edits a working copy and reports one [`Change`] (the
//! path of the field and the gesture phase); the Details panel turns that into an `Op`.

use ashlar_ui::edit::EditPhase;
use ashlar_ui::tokens;
use ashlar_ui::value_field::{Decimal, ValueField};
use editor_proto::{FieldMeta, TypeSchema};
use egui::{Align, Layout, RichText, Ui};
use serde_json::{Map, Number, Value, json};
use std::cell::Cell;

const LABEL_W: f32 = 110.0;
/// Room for the reset arrow in front of every label, so labels line up.
const RESET_W: f32 = 18.0;
const MAX_DEPTH: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    /// A gesture (scrub, typed entry) began: nothing changed yet.
    Begin,
    /// The value changed and the gesture goes on.
    Update,
    /// The gesture ended with its final value (or a one-shot edit such as a toggle).
    Commit,
    /// The gesture was cancelled; the value is back to where it started.
    Cancel,
}

#[derive(Clone, Debug)]
pub(crate) struct Change {
    /// Field path inside the component, `a.b.0`; part of the undo merge key.
    pub path: String,
    pub phase: Phase,
}

pub(crate) struct Cx {
    /// Unique prefix for widget ids (entity + component).
    pub id: String,
    pub change: Option<Change>,
    pub read_only: bool,
    /// `Default::default()` of the value being edited (same JSON form): fields that differ get a
    /// reset arrow.
    pub default: Option<Value>,
}

impl Cx {
    pub fn new(id: String, read_only: bool) -> Self {
        Cx { id, change: None, read_only, default: None }
    }
    pub fn with_default(mut self, default: Option<Value>) -> Self {
        self.default = default;
        self
    }
    fn set(&mut self, path: &str, phase: Phase) {
        self.change = Some(Change { path: path.to_owned(), phase });
    }
}

/// The value a new instance of `schema` starts with (Add component, list items, enum variants).
pub(crate) fn default_value(schema: &TypeSchema) -> Value {
    default_at(schema, 0)
}

fn default_at(schema: &TypeSchema, depth: usize) -> Value {
    if depth > MAX_DEPTH {
        return Value::Null;
    }
    match schema {
        TypeSchema::Field { inner, .. } => default_at(inner, depth),
        TypeSchema::Bool => json!(false),
        TypeSchema::Int { min, .. } => json!(min.unwrap_or(0).max(0)),
        TypeSchema::Float { min, .. } => json!(min.unwrap_or(0.0).max(0.0)),
        TypeSchema::String | TypeSchema::AssetPath { .. } => json!(""),
        TypeSchema::Color => json!([1.0, 1.0, 1.0, 1.0]),
        TypeSchema::Vec2 => json!([0.0, 0.0]),
        TypeSchema::Vec3 => json!([0.0, 0.0, 0.0]),
        TypeSchema::Vec4 => json!([0.0, 0.0, 0.0, 0.0]),
        TypeSchema::Quat => json!([0.0, 0.0, 0.0, 1.0]),
        TypeSchema::Enum { variants } => match variants.first() {
            Some((name, None)) => json!(name),
            Some((name, Some(s))) => {
                let mut m = Map::new();
                m.insert(name.clone(), default_at(s, depth + 1));
                Value::Object(m)
            }
            None => Value::Null,
        },
        TypeSchema::Struct { fields } => Value::Object(fields.iter().map(|(n, s)| (n.clone(), default_at(s, depth + 1))).collect()),
        TypeSchema::List(_) => json!([]),
        TypeSchema::Map(_) => json!({}),
        TypeSchema::Entity => Value::Null,
        TypeSchema::Opaque => Value::Null,
    }
}

/// Draw the editor for a component value. Fields of a struct are rows; nested structs and lists
/// collapse.
pub(crate) fn component_body(ui: &mut Ui, cx: &mut Cx, schema: &TypeSchema, value: &mut Value) {
    match (schema.inner(), &*value) {
        (TypeSchema::Struct { fields }, Value::Object(_)) => fields_ui(ui, cx, fields, value, "", 0),
        _ => edit(ui, cx, "value", schema, value, "", 0),
    }
}

/// The rows of a struct. A field that `choose`s from a sibling list shows that list as a table.
fn fields_ui(ui: &mut Ui, cx: &mut Cx, fields: &[(String, TypeSchema)], value: &mut Value, path: &str, depth: usize) {
    for (fname, s) in fields {
        let fpath = join(path, fname);
        if let Some(list) = s.meta().and_then(|m| m.choose.as_deref()) {
            let rows = value.get(list).and_then(Value::as_array).cloned().unwrap_or_default();
            if let Value::Object(m) = value
                && let Some(v) = m.get_mut(fname)
            {
                let d = Deco::new(cx, fname, s.meta(), v, &fpath);
                choose_ui(ui, cx, &d, &rows, v, &fpath);
            }
        } else if let Value::Object(m) = value
            && let Some(v) = m.get_mut(fname)
        {
            edit(ui, cx, fname, s, v, &fpath, depth);
        }
    }
}

/// `snap_to_ground` becomes `Snap To Ground`.
pub(crate) fn nice_name(raw: &str) -> String {
    raw.split('_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map_or(String::new(), |f| f.to_uppercase().chain(c).collect())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// How one row looks: label, hover text, unit, and whether it can be reset.
pub(crate) struct Deco {
    label: String,
    raw: String,
    tip: Option<String>,
    unit: Option<String>,
    /// The value differs from its default: show the arrow.
    resettable: bool,
    reset_clicked: Cell<bool>,
}

impl Deco {
    fn new(cx: &Cx, name: &str, meta: Option<&FieldMeta>, value: &Value, path: &str) -> Deco {
        let resettable = !cx.read_only && default_at_path(cx.default.as_ref(), path).is_some_and(|d| d != value);
        Deco {
            label: meta.and_then(|m| m.label.clone()).unwrap_or_else(|| nice_name(name)),
            raw: name.to_owned(),
            tip: meta.and_then(|m| m.tip.clone()),
            unit: meta.and_then(|m| m.unit.clone()),
            resettable,
            reset_clicked: Cell::new(false),
        }
    }
}

/// The part of `default` at a `a.b.0` path.
fn default_at_path<'a>(default: Option<&'a Value>, path: &str) -> Option<&'a Value> {
    let mut cur = default?;
    if path.is_empty() {
        return Some(cur);
    }
    for part in path.split('.') {
        cur = match cur {
            Value::Object(m) => m.get(part)?,
            Value::Array(a) => a.get(part.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

/// A small circular arrow, painted (no font dependence).
fn reset_button(ui: &mut Ui) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(RESET_W - 2.0, RESET_W - 2.0), egui::Sense::click());
    let t = tokens::current(ui.ctx());
    let color = if resp.hovered() { t.accent } else { t.text.secondary };
    let c = rect.center();
    let r = 4.5;
    let pts: Vec<egui::Pos2> = (0..=18)
        .map(|i| {
            let a = (40.0 + 290.0 * i as f32 / 18.0).to_radians();
            c + egui::vec2(a.cos(), -a.sin()) * r
        })
        .collect();
    let end = pts[pts.len() - 1];
    let p = ui.painter();
    p.add(egui::Shape::line(pts, egui::Stroke::new(1.4, color)));
    p.add(egui::Shape::convex_polygon(vec![end + egui::vec2(-3.0, -3.0), end + egui::vec2(3.0, -2.0), end + egui::vec2(-0.5, 3.0)], color, egui::Stroke::NONE));
    resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, "Reset to default"));
    resp.on_hover_text("Reset to default")
}

fn row(ui: &mut Ui, d: &Deco, content: impl FnOnce(&mut Ui)) {
    let t = tokens::current(ui.ctx());
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = t.space.sm;
        if d.resettable {
            if reset_button(ui).clicked() {
                d.reset_clicked.set(true);
            }
        } else {
            ui.add_space(RESET_W);
        }
        let label = ui.add_sized([LABEL_W, t.control_height], egui::Label::new(RichText::new(&d.label).color(t.text.secondary)).truncate().sense(egui::Sense::hover()));
        label.on_hover_ui(|ui| {
            if let Some(tip) = &d.tip {
                ui.label(tip);
            }
            if let Some(u) = &d.unit {
                ui.label(RichText::new(format!("Unit: {u}")).small().color(t.text.secondary));
            }
            ui.label(RichText::new(&d.raw).small().monospace().color(t.text.disabled));
        });
        match &d.unit {
            Some(u) => {
                let unit_w = 10.0 + 7.0 * u.chars().count() as f32;
                ui.scope(|ui| {
                    let w = (ui.available_width() - unit_w).max(40.0);
                    ui.set_max_width(w);
                    content(ui);
                });
                ui.label(RichText::new(u).small().color(t.text.disabled));
            }
            None => content(ui),
        }
    });
}

/// A list shown as a table whose rows pick an index (`value`, -1 = none).
fn choose_ui(ui: &mut Ui, cx: &mut Cx, d: &Deco, rows: &[Value], value: &mut Value, path: &str) {
    let t = tokens::current(ui.ctx());
    let current = value.as_i64().unwrap_or(-1);
    ui.horizontal(|ui| {
        ui.add_space(RESET_W);
        ui.label(RichText::new(format!("{} ({})", d.label, rows.len())).color(t.text.secondary)).on_hover_text(d.tip.clone().unwrap_or_default());
    });
    let cell = |v: &Value| -> String {
        match v {
            Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), |f| if f.fract() == 0.0 { format!("{f:.0}") } else { format!("{f:.2}") }),
            Value::Array(a) => a.iter().map(|x| x.as_f64().map_or_else(|| x.to_string(), |f| format!("{f:.1}"))).collect::<Vec<_>>().join(", "),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    };
    let mut picked = None;
    egui::ScrollArea::vertical().id_salt((&cx.id, path, "choose")).max_height(170.0).auto_shrink([false, true]).show(ui, |ui| {
        if rows.is_empty() {
            ui.label(RichText::new("Nothing to pick yet").color(t.text.disabled));
        }
        for (i, r) in rows.iter().enumerate() {
            let text = match r {
                Value::Object(m) => m.iter().map(|(k, v)| format!("{} {}", nice_name(k).to_lowercase(), cell(v))).collect::<Vec<_>>().join("   "),
                other => cell(other),
            };
            let sel = i as i64 == current;
            let resp = ui.add_enabled(!cx.read_only, egui::Button::selectable(sel, RichText::new(format!("{i:>2}   {text}")).monospace()).min_size(egui::vec2(ui.available_width(), 0.0)));
            if resp.clicked() {
                picked = Some(if sel { -1 } else { i as i64 });
            }
        }
    });
    if let Some(p) = picked {
        *value = json!(p);
        cx.set(path, Phase::Commit);
    }
}

fn join(path: &str, part: &str) -> String {
    if path.is_empty() { part.to_owned() } else { format!("{path}.{part}") }
}

fn edit(ui: &mut Ui, cx: &mut Cx, raw_name: &str, schema: &TypeSchema, value: &mut Value, path: &str, depth: usize) {
    let meta = schema.meta();
    if meta.is_some_and(|m| m.hidden) {
        return;
    }
    let schema = schema.inner();
    let mut d = Deco::new(cx, raw_name, meta, value, path);
    if matches!(schema, TypeSchema::Quat) && d.unit.is_none() {
        d.unit = Some("deg".into());
    }
    let name = &d;
    if depth > MAX_DEPTH {
        row(ui, name, |ui| {
            ui.weak("(too deep)");
        });
        return;
    }
    let ro = cx.read_only;
    match schema {
        TypeSchema::Bool => {
            let mut b = value.as_bool();
            match &mut b {
                Some(b) => row(ui, name, |ui| {
                    let before = *b;
                    ui.add_enabled(!ro, egui::Checkbox::without_text(b));
                    if *b != before {
                        *value = json!(*b);
                        cx.set(path, Phase::Commit);
                    }
                }),
                None => readonly(ui, name, value),
            }
        }
        TypeSchema::Int { min, max } => {
            let Some(mut v) = value.as_f64() else { return readonly(ui, name, value) };
            let range = (min.map_or(f64::MIN, |m| m as f64), max.map_or(f64::MAX, |m| m as f64));
            row(ui, name, |ui| {
                let w = ui.available_width();
                if number(ui, cx, &format!("{}.{path}", cx.id), &name.label, &mut v, 0, range, 0.2, w, path) {
                    *value = json!(v.round() as i64);
                }
            });
        }
        TypeSchema::Float { min, max, step } => {
            let Some(mut v) = value.as_f64() else { return readonly(ui, name, value) };
            let range = (min.unwrap_or(f64::MIN), max.unwrap_or(f64::MAX));
            let speed = step.unwrap_or(if let (Some(a), Some(b)) = (min, max) { (b - a) / 200.0 } else { 0.01 });
            row(ui, name, |ui| {
                let w = ui.available_width();
                if number(ui, cx, &format!("{}.{path}", cx.id), &name.label, &mut v, 3, range, speed, w, path)
                    && let Some(n) = Number::from_f64(v)
                {
                    *value = Value::Number(n);
                }
            });
        }
        TypeSchema::String => {
            let Some(orig) = value.as_str().map(str::to_owned) else {
                return readonly(ui, name, value);
            };
            let mut text = orig.clone();
            row(ui, name, |ui| {
                let r = ui.add_enabled(!ro, egui::TextEdit::singleline(&mut text).desired_width(f32::INFINITY));
                if r.lost_focus() && text != orig {
                    *value = json!(text);
                    cx.set(path, Phase::Commit);
                }
            });
        }
        TypeSchema::AssetPath { kind } => {
            let Some(orig) = value.as_str().map(str::to_owned) else {
                return readonly(ui, name, value);
            };
            let mut text = orig.clone();
            row(ui, name, |ui| {
                // Browse button: placeholder until the content browser can pick for a field.
                ui.add_enabled(false, egui::Button::new("..."))
                    .on_disabled_hover_text(format!("Browse {kind} assets (not available yet)"));
                let r = ui.add_enabled(!ro, egui::TextEdit::singleline(&mut text).desired_width(f32::INFINITY));
                if r.lost_focus() && text != orig {
                    *value = json!(text);
                    cx.set(path, Phase::Commit);
                }
            });
        }
        TypeSchema::Vec2 => vec_n(ui, cx, name, value, path, &["X", "Y"]),
        TypeSchema::Vec3 => vec_n(ui, cx, name, value, path, &["X", "Y", "Z"]),
        TypeSchema::Vec4 => vec_n(ui, cx, name, value, path, &["X", "Y", "Z", "W"]),
        TypeSchema::Quat => quat(ui, cx, name, value, path),
        TypeSchema::Color => color(ui, cx, name, value, path),
        TypeSchema::Enum { variants } => enum_edit(ui, cx, name, variants, value, path, depth),
        TypeSchema::Struct { fields } => {
            let Value::Object(_) = value else { return readonly(ui, name, value) };
            egui::CollapsingHeader::new(&name.label).id_salt((&cx.id, path)).default_open(true).show(ui, |ui| {
                fields_ui(ui, cx, fields, value, path, depth + 1);
            });
        }
        TypeSchema::List(item) => list_edit(ui, cx, name, item, value, path, depth),
        TypeSchema::Map(_) | TypeSchema::Entity | TypeSchema::Opaque => readonly(ui, name, value),
        TypeSchema::Field { .. } => {}
    }
    if d.reset_clicked.get()
        && let Some(def) = default_at_path(cx.default.as_ref(), path)
    {
        *value = def.clone();
        cx.set(path, Phase::Commit);
    }
}

fn readonly(ui: &mut Ui, name: &Deco, value: &Value) {
    let t = tokens::current(ui.ctx());
    let text = match value {
        Value::String(s) => s.clone(),
        Value::Null => "none".to_owned(),
        other => other.to_string(),
    };
    row(ui, name, |ui| {
        ui.add(egui::Label::new(RichText::new(text).color(t.text.disabled).monospace()).truncate());
    });
}

/// One numeric field. Returns true when `v` changed (and records the gesture phase).
#[allow(clippy::too_many_arguments)]
fn number(ui: &mut Ui, cx: &mut Cx, id: &str, label: &str, v: &mut f64, decimals: usize, range: (f64, f64), speed: f64, width: f32, path: &str) -> bool {
    let fmt = Decimal { decimals, suffix: "" };
    let mut field = ValueField::new(id, label, v, &fmt).speed(speed).width(width);
    if range.0 < range.1 && (range.0 > f64::MIN || range.1 < f64::MAX) {
        field = field.range(range.0..=range.1);
    }
    let r = ui.add_enabled_ui(!cx.read_only, |ui| field.show(ui)).inner;
    match r.edit {
        Some(e) => {
            let phase = match e.phase {
                EditPhase::Begin => Phase::Begin,
                EditPhase::Update => Phase::Update,
                EditPhase::Commit => Phase::Commit,
                EditPhase::Cancel => Phase::Cancel,
            };
            cx.set(path, phase);
            e.changed()
        }
        None => false,
    }
}

fn vec_n(ui: &mut Ui, cx: &mut Cx, name: &Deco, value: &mut Value, path: &str, axes: &[&str]) {
    let Some(arr) = value.as_array().filter(|a| a.len() == axes.len()) else {
        return readonly(ui, name, value);
    };
    let mut vals: Vec<f64> = arr.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect();
    let mut changed = None;
    row(ui, name, |ui| {
        let gap = ui.spacing().item_spacing.x;
        let w = ((ui.available_width() - gap * (axes.len() as f32 - 1.0)) / axes.len() as f32).max(24.0);
        for (i, axis) in axes.iter().enumerate() {
            let id = format!("{}.{path}.{axis}", cx.id);
            if number(ui, cx, &id, axis, &mut vals[i], 3, (f64::MIN, f64::MAX), 0.02, w, &join(path, axis)) {
                changed = Some(i);
            }
        }
    });
    if changed.is_some()
        && let Value::Array(a) = value
    {
        for (slot, v) in a.iter_mut().zip(&vals) {
            if let Some(n) = Number::from_f64(*v) {
                *slot = Value::Number(n);
            }
        }
    }
}

fn quat(ui: &mut Ui, cx: &mut Cx, name: &Deco, value: &mut Value, path: &str) {
    let Some(arr) = value.as_array().filter(|a| a.len() == 4) else {
        return readonly(ui, name, value);
    };
    let q: [f32; 4] = std::array::from_fn(|i| arr[i].as_f64().unwrap_or(0.0) as f32);
    // Keep the euler triple the user is editing; recomputing it from the quaternion each frame
    // makes angles jump between equivalent representations.
    let mem_id = egui::Id::new(("quat_euler", &cx.id, path));
    let cached: Option<([f32; 3], [f32; 4])> = ui.data(|d| d.get_temp(mem_id));
    let mut deg = match cached {
        Some((e, qq)) if quat_close(qq, q) => e,
        _ => quat_to_euler_deg(q),
    };
    let mut vals = deg.map(f64::from);
    let mut changed = false;
    row(ui, name, |ui| {
        let gap = ui.spacing().item_spacing.x;
        let w = ((ui.available_width() - gap * 2.0) / 3.0).max(24.0);
        for (i, axis) in ["X", "Y", "Z"].iter().enumerate() {
            let id = format!("{}.{path}.{axis}", cx.id);
            if number(ui, cx, &id, axis, &mut vals[i], 1, (f64::MIN, f64::MAX), 0.5, w, &join(path, axis)) {
                changed = true;
            }
        }
    });
    if changed {
        deg = vals.map(|v| v as f32);
        let nq = euler_deg_to_quat(deg);
        ui.data_mut(|d| d.insert_temp(mem_id, (deg, nq)));
        *value = json!([nq[0], nq[1], nq[2], nq[3]]);
    }
}

fn quat_close(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(&b).all(|(x, y)| (x - y).abs() < 1e-4)
}

/// Quaternion `[x, y, z, w]` to euler degrees `[x (pitch), y (yaw), z (roll)]`, Bevy's YXZ order.
pub(crate) fn quat_to_euler_deg(q: [f32; 4]) -> [f32; 3] {
    let [x, y, z, w] = q;
    let sinx = (2.0 * (w * x - y * z)).clamp(-1.0, 1.0);
    let pitch = sinx.asin();
    let yaw = (2.0 * (x * z + w * y)).atan2(1.0 - 2.0 * (x * x + y * y));
    let roll = (2.0 * (x * y + w * z)).atan2(1.0 - 2.0 * (x * x + z * z));
    [pitch.to_degrees(), yaw.to_degrees(), roll.to_degrees()]
}

pub(crate) fn euler_deg_to_quat(e: [f32; 3]) -> [f32; 4] {
    let half = |d: f32| (d.to_radians() * 0.5).sin_cos();
    let (sx, cx) = half(e[0]);
    let (sy, cy) = half(e[1]);
    let (sz, cz) = half(e[2]);
    let qx = [sx, 0.0, 0.0, cx];
    let qy = [0.0, sy, 0.0, cy];
    let qz = [0.0, 0.0, sz, cz];
    let q = qmul(qmul(qy, qx), qz);
    let n = q.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-12);
    q.map(|v| v / n)
}

fn qmul(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    let [ax, ay, az, aw] = a;
    let [bx, by, bz, bw] = b;
    [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]
}

fn color(ui: &mut Ui, cx: &mut Cx, name: &Deco, value: &mut Value, path: &str) {
    let Some(arr) = value.as_array().filter(|a| a.len() == 3 || a.len() == 4) else {
        return readonly(ui, name, value);
    };
    let n = arr.len();
    let mut c: [f32; 4] = std::array::from_fn(|i| arr.get(i).and_then(Value::as_f64).unwrap_or(1.0) as f32);
    let before = c;
    row(ui, name, |ui| {
        ui.add_enabled_ui(!cx.read_only, |ui| {
            let mut rgba = egui::Rgba::from_rgba_unmultiplied(c[0], c[1], c[2], c[3]);
            if egui::color_picker::color_edit_button_rgba(ui, &mut rgba, egui::color_picker::Alpha::OnlyBlend).changed() {
                c = rgba.to_rgba_unmultiplied();
            }
        });
        ui.weak(format!("{:.2} {:.2} {:.2}", c[0], c[1], c[2]));
    });
    if c != before {
        *value = Value::Array(c.iter().take(n).map(|v| json!(v)).collect());
        // A picker drag has no end event; the merge key folds it, and the time window ends it.
        cx.set(path, Phase::Update);
    }
}

fn enum_edit(ui: &mut Ui, cx: &mut Cx, name: &Deco, variants: &[(String, Option<TypeSchema>)], value: &mut Value, path: &str, depth: usize) {
    let current = match &*value {
        Value::String(s) => Some(s.clone()),
        Value::Object(m) if m.len() == 1 => m.keys().next().cloned(),
        _ => None,
    };
    let Some(current) = current.filter(|c| variants.iter().any(|(n, _)| n == c)) else {
        return readonly(ui, name, value);
    };
    let mut picked = None;
    row(ui, name, |ui| {
        ui.add_enabled_ui(!cx.read_only, |ui| {
            egui::ComboBox::from_id_salt((&cx.id, path, "enum")).selected_text(&current).show_ui(ui, |ui| {
                for (v, _) in variants {
                    if ui.selectable_label(*v == current, v).clicked() && *v != current {
                        picked = Some(v.clone());
                    }
                }
            });
        });
    });
    if let Some(v) = picked {
        *value = match variants.iter().find(|(n, _)| *n == v) {
            Some((n, Some(s))) => {
                let mut m = Map::new();
                m.insert(n.clone(), default_value(s));
                Value::Object(m)
            }
            _ => json!(v),
        };
        cx.set(path, Phase::Commit);
        return;
    }
    // Payload of the current variant.
    if let Some((_, Some(s))) = variants.iter().find(|(n, _)| *n == current)
        && let Value::Object(m) = value
        && let Some(inner) = m.get_mut(&current)
    {
        let salt = (cx.id.clone(), path.to_owned(), "payload");
        ui.indent(salt, |ui| edit(ui, cx, &current, s, inner, &join(path, &current), depth + 1));
    }
}

fn list_edit(ui: &mut Ui, cx: &mut Cx, name: &Deco, item: &TypeSchema, value: &mut Value, path: &str, depth: usize) {
    let Value::Array(items) = value else { return readonly(ui, name, value) };
    let len = items.len();
    let mut remove = None;
    let mut add = false;
    egui::CollapsingHeader::new(format!("{} ({len})", name.label))
        .id_salt((&cx.id, path))
        .default_open(len <= 8)
        .show(ui, |ui| {
            for (i, v) in items.iter_mut().enumerate() {
                ui.horizontal(|ui| {
                    if !cx.read_only && ui.small_button("x").on_hover_text("Remove item").clicked() {
                        remove = Some(i);
                    }
                    ui.vertical(|ui| edit(ui, cx, &i.to_string(), item, v, &join(path, &i.to_string()), depth + 1));
                });
            }
            if !cx.read_only && ui.small_button("+ Add item").clicked() {
                add = true;
            }
        });
    if let Some(i) = remove {
        items.remove(i);
        cx.set(path, Phase::Commit);
    } else if add {
        items.push(default_value(item));
        cx.set(path, Phase::Commit);
    }
}

/// Right-aligned reset arrow for a section header.
pub(crate) fn right_reset(ui: &mut Ui, hover: &str) -> bool {
    ui.with_layout(Layout::right_to_left(Align::Center), |ui| reset_button(ui).on_hover_text(hover).clicked()).inner
}

/// Right-aligned small button helper used by section headers.
pub(crate) fn right_button(ui: &mut Ui, text: &str, hover: &str) -> bool {
    ui.with_layout(Layout::right_to_left(Align::Center), |ui| ui.small_button(text).on_hover_text(hover).clicked())
        .inner
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn euler_round_trip() {
        for e in [[0.0, 0.0, 0.0], [30.0, 0.0, 0.0], [0.0, 90.0, 0.0], [10.0, 20.0, 30.0], [-45.0, 135.0, 10.0]] {
            let q = euler_deg_to_quat(e);
            let back = quat_to_euler_deg(q);
            let q2 = euler_deg_to_quat(back);
            // Same rotation (q and -q are the same).
            let dot: f32 = q.iter().zip(&q2).map(|(a, b)| a * b).sum();
            assert!(dot.abs() > 0.9999, "{e:?} -> {back:?}");
        }
        let q = euler_deg_to_quat([0.0, 90.0, 0.0]);
        assert!((q[1] - 0.70710677).abs() < 1e-5 && (q[3] - 0.70710677).abs() < 1e-5);
    }

    #[test]
    fn field_names_become_labels() {
        assert_eq!(nice_name("snap_to_ground"), "Snap To Ground");
        assert_eq!(nice_name("max"), "Max");
        assert_eq!(nice_name("0"), "0");
        assert_eq!(nice_name("__x__"), "X");
    }

    #[test]
    fn default_lookup_follows_the_path() {
        let d = json!({"a": {"b": [1, 2, 3]}, "c": 5});
        assert_eq!(default_at_path(Some(&d), "a.b.1"), Some(&json!(2)));
        assert_eq!(default_at_path(Some(&d), "c"), Some(&json!(5)));
        assert_eq!(default_at_path(Some(&d), "a.x"), None);
        assert_eq!(default_at_path(Some(&d), ""), Some(&d));
        assert_eq!(default_at_path(None, "c"), None);
    }

    #[test]
    fn field_wrapper_is_transparent_to_defaults() {
        let s = TypeSchema::Field { meta: FieldMeta::default(), inner: Box::new(TypeSchema::Vec3) };
        assert_eq!(default_value(&s), json!([0.0, 0.0, 0.0]));
    }

    #[test]
    fn defaults_follow_the_schema() {
        let s = TypeSchema::Struct {
            fields: vec![
                ("on".into(), TypeSchema::Bool),
                ("p".into(), TypeSchema::Vec3),
                (
                    "mode".into(),
                    TypeSchema::Enum {
                        variants: vec![("A".into(), None), ("B".into(), Some(TypeSchema::Float { min: None, max: None, step: None }))],
                    },
                ),
            ],
        };
        assert_eq!(default_value(&s), json!({"on": false, "p": [0.0, 0.0, 0.0], "mode": "A"}));
        assert_eq!(default_value(&TypeSchema::Quat), json!([0.0, 0.0, 0.0, 1.0]));
    }
}
