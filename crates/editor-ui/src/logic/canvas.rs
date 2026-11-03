//! The node canvas: egui-snarl with typed, coloured pins, type-checked connections, inline
//! parameter and default-value editors, error badges, trace pulses, comments, minimap.

use std::collections::{HashMap, HashSet};

use egui::emath::TSTransform;
use egui::{Color32, Pos2, Rect, Stroke, Ui, Vec2, pos2, vec2};
use egui_snarl::ui::{AnyPins, BackgroundPattern, Grid, PinInfo, PinPlacement, PinShape, SnarlPin, SnarlStyle, SnarlViewer, SnarlWidget, get_selected_nodes};
use egui_snarl::{InPin, InPinId, NodeId, OutPin, OutPinId, Snarl};
use logic_core::{Comment, GraphError, Severity, Ty, Var};

use super::inspector::{kind_params, value_edit, zero};
use super::palette::{self, Entry, Filter, Picked, category_color};
use super::state::{GraphDoc, Keys, PinLayout, PinTy, SNode, Sel, TraceViz};

const ERR: Color32 = Color32::from_rgb(235, 70, 70);
const WARN: Color32 = Color32::from_rgb(235, 190, 60);
const PULSE: Color32 = Color32::from_rgb(255, 170, 50);

struct Env<'a> {
    vars: &'a [Var],
    entries: &'a [Entry],
    errors: &'a HashMap<u32, Vec<GraphError>>,
    trace: Option<&'a TraceViz>,
    now: f64,
    selected: Option<u32>,
    found: &'a HashSet<u32>,
    comments: &'a [Comment],
    ctx: egui::Context,
}

struct Viewer<'a> {
    env: Env<'a>,
    next_id: u32,
    refused: Option<String>,
    rects: HashMap<u32, Rect>,
    pin_y: HashMap<(u32, bool, usize), f32>,
    pending: Option<TSTransform>,
    transform: TSTransform,
    relayouts: Vec<(NodeId, PinLayout)>,
    new_comment: Option<Pos2>,
    /// The palette search text, kept across frames while a popup is open.
    search: String,
}

impl Viewer<'_> {
    fn layout(&self, n: &SNode) -> PinLayout {
        PinLayout::of(self.env.vars, &n.kind)
    }

    fn lit(&self, id: u32) -> f32 {
        self.env.trace.map_or(0.0, |t| t.glow(id, self.env.now))
    }

    fn pin_has_error(&self, node: u32, pin: &str) -> bool {
        self.env.errors.get(&node).is_some_and(|v| v.iter().any(|e| e.severity == Severity::Error && e.pin.as_deref() == Some(pin)))
    }

    fn add_entry(&mut self, snarl: &mut Snarl<SNode>, pos: Pos2, e: &Entry) -> NodeId {
        let id = self.next_id;
        self.next_id += 1;
        let mut defaults = Vec::new();
        for p in &e.layout.ins {
            if let PinTy::Data(t) = p.ty
                && matches!(t, Ty::Bool | Ty::Number | Ty::String | Ty::Vec3)
            {
                defaults.push((p.name.clone(), zero(t)));
            }
        }
        snarl.insert_node(pos, SNode { id, kind: e.kind.clone(), defaults })
    }

    /// The palette body for graph / dropped-wire menus.
    fn palette_ui(&mut self, ui: &mut Ui, snarl: &mut Snarl<SNode>, pos: Pos2, filter: Filter, from: Option<AnyPin>) {
        let picked = palette::menu(ui, self.env.entries, self.env.vars, filter, &mut self.search);
        match picked {
            Some(Picked::Node(e)) => {
                let id = self.add_entry(snarl, pos, &e);
                if let (Some(src), Some(idx)) = (from, filter.target_pin(&e)) {
                    match src {
                        AnyPin::Out(o) => {
                            snarl.connect(o, InPinId { node: id, input: idx });
                        }
                        AnyPin::In(i) => {
                            snarl.connect(OutPinId { node: id, output: idx }, i);
                        }
                    }
                }
                self.search.clear();
            }
            Some(Picked::Comment) => {
                self.new_comment = Some(pos);
                self.search.clear();
            }
            None => {}
        }
    }
}

#[derive(Clone, Copy)]
enum AnyPin {
    Out(OutPinId),
    In(InPinId),
}

fn pin_info(ty: PinTy, error: bool) -> PinInfo {
    let mut p = match ty {
        PinTy::Flow => PinInfo::triangle().with_fill(ty.color()).with_wire_color(ty.color()),
        PinTy::Data(_) => PinInfo::circle().with_fill(ty.color()).with_wire_color(ty.color()),
    };
    p.stroke = Some(if error { Stroke::new(2.5, ERR) } else { Stroke::new(1.0, Color32::from_black_alpha(160)) });
    p
}

impl SnarlViewer<SNode> for Viewer<'_> {
    fn title(&mut self, node: &SNode) -> String {
        logic_core::label(&node.kind)
    }

    fn inputs(&mut self, node: &SNode) -> usize {
        self.layout(node).ins.len()
    }

    fn outputs(&mut self, node: &SNode) -> usize {
        self.layout(node).outs.len()
    }

    fn node_frame(&mut self, default: egui::Frame, node: NodeId, _: &[InPin], _: &[OutPin], snarl: &Snarl<SNode>) -> egui::Frame {
        let id = snarl[node].id;
        let glow = self.lit(id);
        let errs = self.env.errors.get(&id);
        let mut f = default.corner_radius(6.0);
        if errs.is_some_and(|v| v.iter().any(|e| e.severity == Severity::Error)) {
            f = f.stroke(Stroke::new(2.5, ERR));
        } else if errs.is_some() {
            f = f.stroke(Stroke::new(2.0, WARN));
        } else if self.env.selected == Some(id) {
            f = f.stroke(Stroke::new(2.0, Color32::from_rgb(120, 170, 255)));
        } else if self.env.found.contains(&id) {
            f = f.stroke(Stroke::new(2.0, Color32::from_rgb(120, 230, 160)));
        }
        if glow > 0.0 {
            f = f.stroke(Stroke::new(3.5, PULSE.gamma_multiply(glow))).shadow(egui::epaint::Shadow { offset: [0, 0], blur: 24, spread: 3, color: PULSE.gamma_multiply(glow * 0.6) });
            self.env.ctx.request_repaint();
        }
        f
    }

    fn header_frame(&mut self, default: egui::Frame, node: NodeId, _: &[InPin], _: &[OutPin], snarl: &Snarl<SNode>) -> egui::Frame {
        let cat = logic_core::category(&snarl[node].kind);
        default.fill(category_color(cat).gamma_multiply(0.85)).corner_radius(egui::CornerRadius { nw: 6, ne: 6, sw: 0, se: 0 })
    }

    fn show_header(&mut self, node: NodeId, _: &[InPin], _: &[OutPin], ui: &mut Ui, snarl: &mut Snarl<SNode>) {
        let sn = &snarl[node];
        ui.label(egui::RichText::new(logic_core::label(&sn.kind)).strong().size(14.0).color(Color32::WHITE));
        if let Some(errs) = self.env.errors.get(&sn.id) {
            let bad = errs.iter().any(|e| e.severity == Severity::Error);
            let text = errs.iter().map(|e| e.message.as_str()).collect::<Vec<_>>().join("\n");
            ui.label(egui::RichText::new(if bad { "!" } else { "?" }).strong().color(if bad { ERR } else { WARN })).on_hover_text(text);
        }
    }

    fn show_input(&mut self, pin: &InPin, ui: &mut Ui, snarl: &mut Snarl<SNode>) -> impl SnarlPin + 'static {
        let node_id = pin.id.node;
        let sn = &snarl[node_id];
        let layout = self.layout(sn);
        let def = layout.ins[pin.id.input].clone();
        let id = sn.id;
        let error = self.pin_has_error(id, &def.name);
        let row = ui.horizontal(|ui| {
            let label = if def.ty == PinTy::Flow || self.transform.scaling < 0.5 { "".to_string() } else { def.name.clone() };
            ui.label(egui::RichText::new(label).color(def.ty.color().gamma_multiply(0.9))).on_hover_text(format!("{} ({})", def.name, def.ty.name()));
            if let PinTy::Data(t) = def.ty
                && pin.remotes.is_empty()
                && (matches!(t, Ty::Bool | Ty::Number | Ty::String) || (t == Ty::Any && snarl[node_id].defaults.iter().any(|(n, _)| *n == def.name)))
            {
                let sn = &mut snarl[node_id];
                let at = sn.defaults.iter().position(|(n, _)| *n == def.name);
                let mut v = at.map_or_else(|| zero(t), |i| sn.defaults[i].1.clone());
                if value_edit(ui, t, &mut v, true) {
                    match at {
                        Some(i) => sn.defaults[i].1 = v,
                        None => sn.defaults.push((def.name.clone(), v)),
                    }
                }
            }
        });
        self.pin_y.insert((id, false, pin.id.input), row.response.rect.center().y);
        pin_info(def.ty, error)
    }

    fn show_output(&mut self, pin: &OutPin, ui: &mut Ui, snarl: &mut Snarl<SNode>) -> impl SnarlPin + 'static {
        let sn = &snarl[pin.id.node];
        let layout = self.layout(sn);
        let def = layout.outs[pin.id.output].clone();
        let id = sn.id;
        let error = self.pin_has_error(id, &def.name);
        let name = if self.transform.scaling < 0.5 { "" } else { def.name.as_str() };
        let r = ui.label(egui::RichText::new(name).color(def.ty.color().gamma_multiply(0.9))).on_hover_text(format!("{} ({})", def.name, def.ty.name()));
        self.pin_y.insert((id, true, pin.id.output), r.rect.center().y);
        let mut info = pin_info(def.ty, error);
        // A wire between two nodes the trace ran lights up.
        if def.ty == PinTy::Flow && self.lit(id) > 0.0 && pin.remotes.iter().any(|r| self.lit(snarl[r.node].id) > 0.0) {
            info = info.with_wire_color(PULSE);
        }
        info
    }

    fn has_footer(&mut self, node: &SNode) -> bool {
        kind_params(&node.kind)
    }

    fn show_footer(&mut self, node: NodeId, _: &[InPin], _: &[OutPin], ui: &mut Ui, snarl: &mut Snarl<SNode>) {
        let before = self.layout(&snarl[node]);
        let sn = &mut snarl[node];
        if super::inspector::edit_kind(ui, &mut sn.kind, true) {
            self.relayouts.push((node, before));
        }
    }

    fn final_node_rect(&mut self, node: NodeId, rect: Rect, _: &mut Ui, snarl: &mut Snarl<SNode>) {
        if let Some(n) = snarl.get_node(node) {
            self.rects.insert(n.id, rect);
        }
    }

    fn connect(&mut self, from: &OutPin, to: &InPin, snarl: &mut Snarl<SNode>) {
        let (Some(a), Some(b)) = (snarl.get_node(from.id.node), snarl.get_node(to.id.node)) else { return };
        if from.id.node == to.id.node {
            self.refused = Some("A node can't connect to itself".into());
            return;
        }
        let (la, lb) = (self.layout(a), self.layout(b));
        let (Some(src), Some(dst)) = (la.outs.get(from.id.output), lb.ins.get(to.id.input)) else { return };
        if !src.ty.feeds(dst.ty) {
            self.refused = Some(format!("{} cannot feed {}", src.ty.name(), dst.ty.name()));
            return;
        }
        // A data input takes one wire; an exec output leads to one place.
        if dst.ty != PinTy::Flow {
            snarl.drop_inputs(to.id);
        }
        if src.ty == PinTy::Flow {
            snarl.drop_outputs(from.id);
        }
        snarl.connect(from.id, to.id);
    }

    fn has_graph_menu(&mut self, _: Pos2, _: &mut Snarl<SNode>) -> bool {
        true
    }

    fn show_graph_menu(&mut self, pos: Pos2, ui: &mut Ui, snarl: &mut Snarl<SNode>) {
        self.palette_ui(ui, snarl, pos, Filter::None, None);
    }

    fn has_dropped_wire_menu(&mut self, _: AnyPins, _: &mut Snarl<SNode>) -> bool {
        true
    }

    fn show_dropped_wire_menu(&mut self, pos: Pos2, ui: &mut Ui, src: AnyPins, snarl: &mut Snarl<SNode>) {
        let (filter, from) = match src {
            AnyPins::Out(outs) => {
                let Some(&o) = outs.first() else { return };
                let ty = snarl.get_node(o.node).and_then(|n| self.layout(n).outs.get(o.output).map(|p| p.ty));
                (ty.map_or(Filter::None, Filter::FromOut), Some(AnyPin::Out(o)))
            }
            AnyPins::In(ins) => {
                let Some(&i) = ins.first() else { return };
                let ty = snarl.get_node(i.node).and_then(|n| self.layout(n).ins.get(i.input).map(|p| p.ty));
                (ty.map_or(Filter::None, Filter::FromIn), Some(AnyPin::In(i)))
            }
        };
        self.palette_ui(ui, snarl, pos, filter, from);
    }

    fn has_node_menu(&mut self, _: &SNode) -> bool {
        true
    }

    fn show_node_menu(&mut self, node: NodeId, inputs: &[InPin], outputs: &[OutPin], ui: &mut Ui, snarl: &mut Snarl<SNode>) {
        if ui.button("Duplicate").clicked() {
            let (pos, sn) = snarl.get_node_info(node).map(|i| (i.pos, i.value.clone())).unzip();
            if let (Some(pos), Some(mut sn)) = (pos, sn) {
                sn.id = self.next_id;
                self.next_id += 1;
                snarl.insert_node(pos + vec2(30.0, 30.0), sn);
            }
            ui.close();
        }
        if ui.button("Break links").clicked() {
            for p in inputs {
                snarl.drop_inputs(p.id);
            }
            for p in outputs {
                snarl.drop_outputs(p.id);
            }
            ui.close();
        }
        ui.separator();
        if ui.button("Delete").clicked() {
            snarl.remove_node(node);
            ui.close();
        }
    }

    fn draw_background(&mut self, background: Option<&BackgroundPattern>, viewport: &Rect, snarl_style: &SnarlStyle, style: &egui::Style, painter: &egui::Painter, _: &Snarl<SNode>) {
        if let Some(b) = background {
            b.draw(viewport, snarl_style, style, painter);
        }
        for c in self.env.comments {
            let r = Rect::from_min_size(pos2(c.pos[0], c.pos[1]), vec2(c.size[0], c.size[1]));
            let col = Color32::from_rgb(c.color[0], c.color[1], c.color[2]);
            painter.rect_filled(r, 8.0, col.gamma_multiply(0.22));
            painter.rect_stroke(r, 8.0, Stroke::new(1.5, col.gamma_multiply(0.8)), egui::StrokeKind::Inside);
        }
    }

    fn current_transform(&mut self, to_global: &mut TSTransform, _: &mut Snarl<SNode>) {
        if let Some(t) = self.pending.take() {
            *to_global = t;
        }
        // Space + drag pans (the left button otherwise box-selects).
        let (space, down, delta) = self.env.ctx.input(|i| (i.key_down(egui::Key::Space), i.pointer.primary_down(), i.pointer.delta()));
        if space && down {
            to_global.translation += delta;
        }
        self.transform = *to_global;
    }
}

fn style() -> SnarlStyle {
    let mut s = SnarlStyle::new();
    s.bg_pattern = Some(BackgroundPattern::Grid(Grid::new(vec2(32.0, 32.0), 0.0)));
    s.bg_pattern_stroke = Some(Stroke::new(1.0, Color32::from_white_alpha(10)));
    s.wire_width = Some(2.5);
    s.pin_size = Some(12.0);
    s.pin_shape = Some(PinShape::Circle);
    s.pin_placement = Some(PinPlacement::Outside { margin: 2.0 });
    s.collapsible = Some(false);
    s.min_scale = Some(0.25);
    s.max_scale = Some(1.6);
    s
}

/// Bounds of all nodes (graph space), using known rectangles or a guess.
pub fn bounds(doc: &GraphDoc) -> Option<Rect> {
    let mut r: Option<Rect> = None;
    for (_, pos, sn) in doc.snarl.nodes_pos_ids() {
        let nr = doc.node_rects.get(&sn.id).copied().unwrap_or_else(|| Rect::from_min_size(pos, vec2(170.0, 90.0)));
        r = Some(r.map_or(nr, |a| a.union(nr)));
    }
    for c in &doc.comments {
        let cr = Rect::from_min_size(pos2(c.pos[0], c.pos[1]), vec2(c.size[0], c.size[1]));
        r = Some(r.map_or(cr, |a| a.union(cr)));
    }
    r
}

/// Transform that frames `target` (graph space) in `canvas` (screen space).
pub fn frame_rect(target: Rect, canvas: Rect, max_scale: f32) -> TSTransform {
    let target = target.expand(40.0);
    let scale = (canvas.width() / target.width().max(1.0)).min(canvas.height() / target.height().max(1.0)).clamp(0.7, max_scale);
    TSTransform::new(canvas.center().to_vec2() - target.center().to_vec2() * scale, scale)
}

/// What the canvas wants from the tab.
#[derive(Default)]
pub struct Out {
    pub delete: bool,
}

pub fn show(ui: &mut Ui, doc: &mut GraphDoc, entries: &[Entry], now: f64, keys: Keys) -> Out {
    let ctx = ui.ctx().clone();
    let canvas = ui.available_rect_before_wrap();
    doc.canvas = canvas;
    let errors = doc.error_map();
    let found: HashSet<u32> = if doc.search.is_empty() {
        HashSet::new()
    } else {
        let q = doc.search.to_lowercase();
        doc.snarl.nodes().filter(|n| logic_core::label(&n.kind).to_lowercase().contains(&q)).map(|n| n.id).collect()
    };
    let selected = match &doc.sel {
        Sel::Node(id) => Some(*id),
        _ => None,
    };
    let mut pending = None;
    if doc.fit_pending
        && let Some(b) = bounds(doc)
    {
        pending = Some(frame_rect(b, canvas, 1.0));
        doc.fit_pending = false;
    }
    if let Some(c) = doc.center_on.take() {
        let s = doc.to_global.scaling;
        pending = Some(TSTransform::new(canvas.center().to_vec2() - c.to_vec2() * s, s));
    }
    if let Some(id) = doc.goto.take()
        && let Some(r) = doc.node_rects.get(&id).copied().or_else(|| doc.node_ids().get(&id).and_then(|n| doc.snarl.get_node_info(*n)).map(|i| Rect::from_min_size(i.pos, vec2(170.0, 90.0))))
    {
        pending = Some(frame_rect(r.expand(300.0), canvas, 1.0));
    }
    let vars = doc.vars.clone();
    let comments = doc.comments.clone();
    let mut viewer = Viewer {
        env: Env { vars: &vars, entries, errors: &errors, trace: doc.trace.as_ref(), now, selected, found: &found, comments: &comments, ctx: ctx.clone() },
        next_id: doc.next_id(),
        refused: None,
        rects: HashMap::new(),
        pin_y: HashMap::new(),
        pending,
        transform: doc.to_global,
        relayouts: Vec::new(),
        new_comment: None,
        search: ctx.data(|d| d.get_temp::<String>(egui::Id::new("logic.palette.search"))).unwrap_or_default(),
    };
    ui.scope(|ui| {
        // Readable at zoom 1: titles 14, labels and fields 13.
        let st = ui.style_mut();
        for (ts, size) in [(egui::TextStyle::Body, 13.0), (egui::TextStyle::Button, 13.0), (egui::TextStyle::Small, 12.0), (egui::TextStyle::Monospace, 13.0)] {
            if let Some(f) = st.text_styles.get_mut(&ts) {
                f.size = size;
            }
        }
        SnarlWidget::new().id(doc.widget_id).style(style()).show(&mut doc.snarl, &mut viewer, ui);
    });
    ctx.data_mut(|d| d.insert_temp(egui::Id::new("logic.palette.search"), std::mem::take(&mut viewer.search)));

    doc.node_rects = std::mem::take(&mut viewer.rects);
    doc.pin_y = std::mem::take(&mut viewer.pin_y);
    doc.to_global = viewer.transform;
    let (refused, relayouts, new_comment) = (viewer.refused.take(), std::mem::take(&mut viewer.relayouts), viewer.new_comment.take());
    drop(viewer);
    for (n, old) in relayouts {
        doc.relayout(n, &old);
    }
    if let Some(m) = refused {
        doc.refuse(m, now);
    }
    if let Some(p) = new_comment {
        doc.comments.push(Comment::new("Comment", [p.x, p.y], [300.0, 180.0]));
        doc.sel = Sel::Comment(doc.comments.len() - 1);
    }

    // Selection follows snarl's, but a rebuild (empty selection) doesn't clear it.
    let ids = doc.node_ids();
    let rev: HashMap<NodeId, u32> = ids.iter().map(|(a, b)| (*b, *a)).collect();
    let mut sel_now: Vec<u32> = get_selected_nodes(doc.widget_id, &ctx).iter().filter_map(|n| rev.get(n).copied()).collect();
    sel_now.sort_unstable();
    if sel_now != doc.snarl_sel_prev {
        if let Some(first) = sel_now.first() {
            doc.sel = Sel::Node(*first);
        } else if matches!(doc.sel, Sel::Node(_)) {
            doc.sel = Sel::None;
        }
        doc.snarl_sel_prev = sel_now.clone();
    }

    if doc.snarl.nodes().next().is_none() && doc.comments.is_empty() {
        ui.painter().text(canvas.center(), egui::Align2::CENTER_CENTER, "Right-click to add a node", egui::FontId::proportional(18.0), Color32::from_white_alpha(70));
    }
    comment_handles(ui, doc, canvas);
    minimap(ui, doc, canvas);
    refusal_toast(ui, doc, canvas, now);

    // Keys (taken before the host could use them): Delete removes the selected nodes (or
    // comment), Cmd+D duplicates, F frames.
    let mut out = Out::default();
    if keys.delete {
        out.delete = true;
        let sel: Vec<NodeId> = get_selected_nodes(doc.widget_id, &ctx);
        if !sel.is_empty() {
            for n in sel {
                doc.snarl.remove_node(n);
            }
        } else if let Sel::Comment(i) = doc.sel
            && i < doc.comments.len()
        {
            doc.comments.remove(i);
            doc.sel = Sel::None;
        }
    }
    if keys.duplicate {
        let mut next = doc.next_id();
        for n in get_selected_nodes(doc.widget_id, &ctx) {
            if let Some((pos, mut sn)) = doc.snarl.get_node_info(n).map(|i| (i.pos, i.value.clone())) {
                sn.id = next;
                next += 1;
                doc.snarl.insert_node(pos + vec2(30.0, 30.0), sn);
            }
        }
    }
    if keys.frame {
        if let Sel::Node(id) = doc.sel {
            doc.goto = Some(id);
        } else {
            doc.fit_pending = true;
        }
    }
    out
}

/// A drag handle on each comment's title bar (and a resize corner), above the canvas.
fn comment_handles(ui: &mut Ui, doc: &mut GraphDoc, canvas: Rect) {
    let t = doc.to_global;
    let mut moved: Option<(usize, Vec2, bool)> = None;
    let mut clicked: Option<usize> = None;
    for (i, c) in doc.comments.iter().enumerate() {
        let min = t * pos2(c.pos[0], c.pos[1]);
        let size = vec2(c.size[0], c.size[1]) * t.scaling;
        let header = Rect::from_min_size(min, vec2(size.x, (24.0 * t.scaling).max(16.0)));
        let corner = Rect::from_min_size(min + size - vec2(14.0, 14.0), vec2(14.0, 14.0));
        if !canvas.intersects(Rect::from_min_size(min, size)) {
            continue;
        }
        let col = Color32::from_rgb(c.color[0], c.color[1], c.color[2]);
        egui::Area::new(egui::Id::new(("logic.comment", doc.widget_id, i))).order(egui::Order::Middle).fixed_pos(header.min).constrain(false).show(ui.ctx(), |ui| {
            ui.set_clip_rect(canvas);
            let (r, resp) = ui.allocate_exact_size(header.size(), egui::Sense::click_and_drag());
            ui.painter().rect_filled(r, 6.0, col.gamma_multiply(if matches!(doc.sel, Sel::Comment(s) if s == i) { 0.95 } else { 0.7 }));
            ui.painter().text(r.left_center() + vec2(8.0, 0.0), egui::Align2::LEFT_CENTER, &c.text, egui::FontId::proportional((14.0 * t.scaling).clamp(10.0, 20.0)), Color32::WHITE);
            if resp.dragged() {
                moved = Some((i, resp.drag_delta() / t.scaling, false));
            }
            if resp.clicked() || resp.drag_started() {
                clicked = Some(i);
            }
        });
        egui::Area::new(egui::Id::new(("logic.comment.resize", doc.widget_id, i))).order(egui::Order::Middle).fixed_pos(corner.min).constrain(false).show(ui.ctx(), |ui| {
            ui.set_clip_rect(canvas);
            let (r, resp) = ui.allocate_exact_size(corner.size(), egui::Sense::drag());
            ui.painter().rect_filled(r, 3.0, col.gamma_multiply(0.9));
            if resp.hovered() || resp.dragged() {
                ui.ctx().set_cursor_icon(egui::CursorIcon::ResizeNwSe);
            }
            if resp.dragged() {
                moved = Some((i, resp.drag_delta() / t.scaling, true));
            }
        });
    }
    if let Some(i) = clicked {
        doc.sel = Sel::Comment(i);
    }
    if let Some((i, d, resize)) = moved
        && let Some(c) = doc.comments.get_mut(i)
    {
        if resize {
            c.size = [(c.size[0] + d.x).max(80.0), (c.size[1] + d.y).max(50.0)];
        } else {
            c.pos = [c.pos[0] + d.x, c.pos[1] + d.y];
        }
    }
}

const MINI: Vec2 = vec2(180.0, 120.0);

/// Bottom-right overview: nodes as dots, the view as a frame; click or drag moves the view.
fn minimap(ui: &mut Ui, doc: &mut GraphDoc, canvas: Rect) {
    let Some(world) = bounds(doc) else { return };
    let world = world.expand(60.0);
    let pos = canvas.right_bottom() - MINI - vec2(12.0, 12.0);
    let mut jump: Option<Pos2> = None;
    let t = doc.to_global;
    egui::Area::new(egui::Id::new(("logic.minimap", doc.widget_id))).order(egui::Order::Middle).fixed_pos(pos).constrain(false).show(ui.ctx(), |ui| {
        let (r, resp) = ui.allocate_exact_size(MINI, egui::Sense::click_and_drag());
        let p = ui.painter();
        p.rect_filled(r, 6.0, Color32::from_black_alpha(150));
        p.rect_stroke(r, 6.0, Stroke::new(1.0, Color32::from_white_alpha(40)), egui::StrokeKind::Inside);
        let s = (r.width() / world.width()).min(r.height() / world.height());
        let to_mini = |q: Pos2| r.center() + (q - world.center()) * s;
        for (id, nr) in &doc.node_rects {
            let col = doc.snarl.nodes().find(|n| n.id == *id).map_or(Color32::GRAY, |n| category_color(logic_core::category(&n.kind)));
            p.rect_filled(Rect::from_two_pos(to_mini(nr.min), to_mini(nr.max)), 1.0, col);
        }
        let view = Rect::from_two_pos(t.inverse() * canvas.min, t.inverse() * canvas.max);
        let vr = Rect::from_two_pos(to_mini(view.min), to_mini(view.max)).intersect(r);
        p.rect_stroke(vr, 2.0, Stroke::new(1.5, Color32::WHITE), egui::StrokeKind::Inside);
        if (resp.clicked() || resp.dragged())
            && let Some(m) = resp.interact_pointer_pos()
        {
            jump = Some(world.center() + (m - r.center()) / s);
        }
    });
    if let Some(center) = jump {
        doc.center_on = Some(center);
    }
}

fn refusal_toast(ui: &mut Ui, doc: &mut GraphDoc, canvas: Rect, now: f64) {
    let Some((msg, t0, bad)) = doc.message.clone() else { return };
    if now - t0 > 3.0 {
        doc.message = None;
        return;
    }
    ui.ctx().request_repaint_after(std::time::Duration::from_millis(200));
    egui::Area::new(egui::Id::new(("logic.toast", doc.widget_id))).order(egui::Order::Tooltip).fixed_pos(canvas.left_bottom() + vec2(12.0, -40.0)).show(ui.ctx(), |ui| {
        egui::Frame::popup(ui.style()).show(ui, |ui| {
            ui.label(egui::RichText::new(msg).color(if bad { Color32::from_rgb(255, 130, 120) } else { Color32::from_gray(210) }));
        });
    });
}
