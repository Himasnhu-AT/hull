//! The Logic ("Blueprint") editor tab. See `docs/EDITOR.md`, section "Logic".
//!
//! [`show`] draws the whole tab for a [`LogicTab`]: document tabs (graphs and scripts), a
//! toolbar (Compile, Save, Revert, Find, Fit, Comment, Test), the "My Logic" list on the left,
//! the node canvas, the node inspector on the right and the Compiler Results strip. Files go
//! through the [`EditorBackend`] (`logic_read`, `logic_write`, ...); checks run here, in
//! `logic-core`, on every edit.

mod canvas;
mod complete;
mod compile_ui;
mod inspector;
pub mod mock;
mod palette;
mod script_tab;
mod state;

use ashlar_ui::tokens;
use editor_proto::{EditorBackend, EntityId, GraphErrorDoc, Op};
use egui::{Color32, RichText, Ui};
use logic_core::{Graph, NodeKind, Ty, Value, Var};

use state::{Doc, GraphDoc, Keys, Library, ScriptDoc, Sel, TraceViz, fire_events, message_names};

/// Seconds between looks at the file on disk and at the palette sources.
const POLL: f64 = 0.7;
const LIB_POLL: f64 = 3.0;

/// The Logic tab: open documents and everything cached from the backend.
#[derive(Default)]
pub struct LogicTab {
    docs: Vec<Doc>,
    active: usize,
    lib: Library,
    entries: Vec<palette::Entry>,
    lib_loaded: bool,
    lib_polled: f64,
    pending_open: Vec<String>,
    pending_jump: Vec<(String, usize)>,
    new_name: String,
    press_count: u64,
    users: Vec<EntityId>,
    users_for: String,
    users_polled: f64,
    /// Ops the backend applied for the tab (attach): the host records them for undo.
    applied: Vec<(String, Op)>,
    status: Option<(String, f64, bool)>,
    keys: Keys,
    pending_trace: Option<editor_proto::LogicTrace>,
}

impl LogicTab {
    /// Queue a `.logic.ron` / `.ruspy` file to open (and bring to the front) on the next frame.
    pub fn open(&mut self, path: &str) {
        self.pending_open.push(path.to_string());
    }

    /// Open `path` and scroll to a 0-based `line` (a diagnostic click).
    pub fn open_at(&mut self, path: &str, line: usize) {
        self.pending_open.push(path.to_string());
        self.pending_jump.push((path.to_string(), line));
    }

    /// Ops to put on the editor's undo stack (the tab applied them through the backend).
    pub fn take_applied(&mut self) -> Vec<(String, Op)> {
        std::mem::take(&mut self.applied)
    }

    /// Forget an open document (its host tab was closed).
    pub fn close_path(&mut self, path: &str) {
        if let Some(i) = self.docs.iter().position(|d| d.path() == path) {
            self.close(i);
        }
    }

    /// Paths of the open documents, in tab order.
    pub fn open_paths(&self) -> Vec<String> {
        self.docs.iter().map(|d| d.path().to_string()).collect()
    }

    /// The path of the front document.
    pub fn active_path(&self) -> Option<&str> {
        self.docs.get(self.active).map(Doc::path)
    }

    /// Text of the front document when it is a script (tests, host commands).
    pub fn active_text(&self) -> Option<String> {
        match self.docs.get(self.active) {
            Some(Doc::Script(s)) => Some(s.text.clone()),
            _ => None,
        }
    }

    /// The scroll target of the front script (0-based line), if a jump is pending.
    pub fn active_jump(&self) -> Option<usize> {
        match self.docs.get(self.active) {
            Some(Doc::Script(s)) => s.jump_to,
            _ => None,
        }
    }

    /// The graph on the canvas of the front document, if it is a graph.
    pub fn active_graph(&self) -> Option<&Graph> {
        match self.docs.get(self.active) {
            Some(Doc::Graph(g)) => Some(&g.graph),
            _ => None,
        }
    }

    /// Screen position of a pin of the front graph (for tests and scripted drags).
    pub fn pin_screen_pos(&self, node: u32, output: bool, pin: &str) -> Option<egui::Pos2> {
        match self.docs.get(self.active) {
            Some(Doc::Graph(g)) => g.pin_screen_pos(node, output, pin),
            _ => None,
        }
    }

    /// Screen rectangle of a node of the front graph.
    pub fn node_screen_rect(&self, node: u32) -> Option<egui::Rect> {
        match self.docs.get(self.active) {
            Some(Doc::Graph(g)) => {
                let r = g.node_rects.get(&node)?;
                Some(egui::Rect::from_two_pos(g.to_global * r.min, g.to_global * r.max))
            }
            _ => None,
        }
    }

    /// Screen rectangle of the front graph's canvas.
    pub fn canvas_rect(&self) -> egui::Rect {
        match self.docs.get(self.active) {
            Some(Doc::Graph(g)) => g.canvas,
            _ => egui::Rect::NOTHING,
        }
    }

    /// True when the front graph has unsaved edits.
    pub fn is_dirty(&self) -> bool {
        self.docs.get(self.active).is_some_and(Doc::dirty)
    }

    /// Errors of the front graph (compile results).
    pub fn active_errors(&self) -> Vec<(Option<u32>, String)> {
        match self.docs.get(self.active) {
            Some(Doc::Graph(g)) => g.errors.iter().map(|e| (e.node, e.message.clone())).collect(),
            _ => Vec::new(),
        }
    }

    /// True while the pointer is over a graph canvas (the host should not run its own
    /// Undo / Redo / Delete shortcuts then).
    pub fn captures_shortcuts(&self, ctx: &egui::Context) -> bool {
        match self.docs.get(self.active) {
            Some(Doc::Graph(g)) => ctx.input(|i| i.pointer.latest_pos()).is_some_and(|p| g.canvas.contains(p)),
            _ => false,
        }
    }

    /// Show a fire trace on the front graph (pulses the path) when the next frame is drawn.
    pub fn show_trace(&mut self, trace: editor_proto::LogicTrace) {
        self.pending_trace = Some(trace);
    }

    /// Take the editing shortcuts (Undo, Redo, Save, Delete, Duplicate, F) from the egui input
    /// while the pointer is over a graph canvas and no text field is being edited. Call before
    /// the host dispatches its own shortcuts; [`show`] calls it itself when nobody did.
    pub fn capture_keys(&mut self, ctx: &egui::Context) {
        if !self.captures_shortcuts(ctx) || ctx.egui_wants_keyboard_input() {
            return;
        }
        use egui::{Key, Modifiers as M};
        let k = ctx.input_mut(|i| Keys {
            redo: i.consume_key(M::COMMAND | M::SHIFT, Key::Z) | i.consume_key(M::COMMAND, Key::Y),
            undo: i.consume_key(M::COMMAND, Key::Z),
            save: i.consume_key(M::COMMAND, Key::S),
            duplicate: i.consume_key(M::COMMAND, Key::D),
            delete: i.consume_key(M::NONE, Key::Delete) | i.consume_key(M::NONE, Key::Backspace),
            frame: i.consume_key(M::NONE, Key::F),
        });
        self.keys.undo |= k.undo;
        self.keys.redo |= k.redo;
        self.keys.save |= k.save;
        self.keys.duplicate |= k.duplicate;
        self.keys.delete |= k.delete;
        self.keys.frame |= k.frame;
    }

    fn say(&mut self, msg: impl Into<String>, now: f64, error: bool) {
        self.status = Some((msg.into(), now, error));
    }

    fn refresh_lib(&mut self, backend: &mut dyn EditorBackend, now: f64) {
        self.lib.files = backend.logic_list();
        let p = backend.logic_palette();
        self.lib.set_palette(p);
        self.entries = palette::base_entries(&self.lib);
        self.lib_loaded = true;
        self.lib_polled = now;
        for d in &mut self.docs {
            if let Doc::Graph(g) = d {
                g.recheck(self.lib.catalog.as_ref());
            }
        }
    }

    fn open_now(&mut self, backend: &mut dyn EditorBackend, path: &str, now: f64) {
        if let Some(i) = self.docs.iter().position(|d| d.path() == path) {
            self.active = i;
            return;
        }
        let text = match backend.logic_read(path) {
            Ok(t) => t,
            Err(e) => {
                self.say(format!("Can't open {path}: {e}"), now, true);
                return;
            }
        };
        let doc = if path.ends_with(".logic.ron") {
            match Graph::from_ron(&text) {
                Ok(g) => {
                    let mut d = GraphDoc::new(path, &g);
                    d.disk_text = text;
                    d.last_poll = now;
                    d.recheck(self.lib.catalog.as_ref());
                    Doc::Graph(Box::new(d))
                }
                Err(e) => {
                    self.say(format!("{path} has a syntax error ({e}); opened as text"), now, true);
                    Doc::Script(Box::new(script_doc(path, text, vec![GraphErrorDoc { message: e.message.clone(), line: e.line as u32, col: e.col as u32, ..Default::default() }], now)))
                }
            }
        } else {
            let errors = self.lib.files.iter().find(|f| f.path == path).map(|f| f.errors.clone()).unwrap_or_default();
            Doc::Script(Box::new(script_doc(path, text, errors, now)))
        };
        self.docs.push(doc);
        self.active = self.docs.len() - 1;
    }

    fn close(&mut self, i: usize) {
        if i < self.docs.len() {
            self.docs.remove(i);
            self.active = self.active.min(self.docs.len().saturating_sub(1));
        }
    }
}

fn script_doc(path: &str, text: String, errors: Vec<GraphErrorDoc>, now: f64) -> ScriptDoc {
    ScriptDoc { path: path.into(), saved: text.clone(), disk_text: text.clone(), text, errors, last_poll: now, changed_on_disk: false, jump_to: None, api: vec![], api_loaded: false, outline: Default::default(), outline_of: String::new(), cursor: 0, set_cursor: None, popup: None }
}

/// Draw the Logic tab body with its own document strip (standalone hosts and tests).
pub fn show(ui: &mut Ui, tab: &mut LogicTab, backend: &mut dyn EditorBackend) {
    let ctx = ui.ctx().clone();
    let now = begin(ui, tab, backend);
    tab.capture_keys(&ctx);
    tab_strip(ui, tab, backend, now);
    ui.separator();
    if tab.docs.is_empty() {
        welcome(ui, tab, backend, now);
        status_line(ui, tab, now);
        return;
    }
    body(ui, tab, backend, now);
}

/// Draw one document (a graph or a script) as the body of a host's own tab: no strip of our own.
pub fn show_doc(ui: &mut Ui, tab: &mut LogicTab, backend: &mut dyn EditorBackend, path: &str) {
    let ctx = ui.ctx().clone();
    let now = begin(ui, tab, backend);
    if !tab.docs.iter().any(|d| d.path() == path) {
        tab.open_now(backend, path, now);
    }
    if let Some(i) = tab.docs.iter().position(|d| d.path() == path) {
        tab.active = i;
        tab.capture_keys(&ctx);
        body(ui, tab, backend, now);
    } else {
        status_line(ui, tab, now);
    }
}

fn begin(ui: &mut Ui, tab: &mut LogicTab, backend: &mut dyn EditorBackend) -> f64 {
    let ctx = ui.ctx().clone();
    let now = ctx.input(|i| i.time);
    if ctx.input(|i| i.pointer.any_pressed()) {
        tab.press_count += 1;
    }
    if !tab.lib_loaded || now - tab.lib_polled > LIB_POLL {
        tab.refresh_lib(backend, now);
    }
    for p in std::mem::take(&mut tab.pending_open) {
        tab.open_now(backend, &p, now);
    }
    for (p, line) in std::mem::take(&mut tab.pending_jump) {
        if let Some(Doc::Script(s)) = tab.docs.iter_mut().find(|d| d.path() == p) {
            s.jump_to = Some(line);
        }
    }
    now
}

fn body(ui: &mut Ui, tab: &mut LogicTab, backend: &mut dyn EditorBackend, now: f64) {
    let idx = tab.active.min(tab.docs.len() - 1);
    // Take the document out so the tab and the document can both be borrowed.
    let mut doc = tab.docs.remove(idx);
    match &mut doc {
        Doc::Graph(g) => graph_ui(ui, tab, g, backend, now),
        Doc::Script(s) => script_ui(ui, tab, s, backend, now),
    }
    tab.docs.insert(idx, doc);
    status_line(ui, tab, now);
}

fn status_line(ui: &mut Ui, tab: &LogicTab, now: f64) {
    if let Some((m, t0, err)) = &tab.status
        && now - t0 < 6.0
    {
        let t = tokens::current(ui.ctx());
        ui.label(RichText::new(m).color(if *err { t.status.danger } else { t.text.secondary }));
        ui.ctx().request_repaint_after(std::time::Duration::from_millis(500));
    }
}

fn tab_strip(ui: &mut Ui, tab: &mut LogicTab, backend: &mut dyn EditorBackend, now: f64) {
    let t = tokens::current(ui.ctx());
    let mut close = None;
    let mut open: Option<String> = None;
    let mut create: Option<String> = None;
    ui.horizontal(|ui| {
        for (i, d) in tab.docs.iter().enumerate() {
            let kind = if d.path().ends_with(".ruspy") { "Script" } else { "Logic" };
            let mut title = format!("{kind}: {}", d.title());
            if d.dirty() {
                title.push_str(" *");
            }
            let r = ui.selectable_label(tab.active == i, RichText::new(title).color(if d.dirty() { t.status.warning } else { t.text.primary }));
            if r.clicked() {
                tab.active = i;
            }
            if r.middle_clicked() || ui.small_button("x").on_hover_text("Close").clicked() {
                close = Some(i);
            }
            ui.add_space(4.0);
        }
        ui.menu_button("+", |ui| {
            ui.label(RichText::new("New graph").strong());
            ui.horizontal(|ui| {
                let r = ui.add(egui::TextEdit::singleline(&mut tab.new_name).hint_text("name").desired_width(120.0));
                let go = ui.button("Create").clicked() || (r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)));
                if go && !tab.new_name.trim().is_empty() {
                    create = Some(tab.new_name.trim().to_string());
                    ui.close();
                }
            });
            ui.separator();
            ui.label(RichText::new("Open").strong());
            egui::ScrollArea::vertical().max_height(260.0).show(ui, |ui| {
                for f in &tab.lib.files {
                    if ui.button(&f.path).clicked() {
                        open = Some(f.path.clone());
                        ui.close();
                    }
                }
            });
        });
    });
    if let Some(i) = close {
        tab.close(i);
    }
    if let Some(p) = open {
        tab.open_now(backend, &p, now);
    }
    if let Some(n) = create {
        match backend.logic_create(&n, "empty") {
            Ok(path) => {
                tab.new_name.clear();
                tab.refresh_lib(backend, now);
                tab.open_now(backend, &path, now);
                tab.say(format!("Created {path}"), now, false);
            }
            Err(e) => tab.say(e, now, true),
        }
    }
}

fn welcome(ui: &mut Ui, tab: &mut LogicTab, backend: &mut dyn EditorBackend, now: f64) {
    ui.add_space(12.0);
    ui.label(RichText::new("Logic").heading());
    ui.weak("Graphs wire events (overlap, key, timer) to flow (branch, delay) and effects (set a field, run a command, call a script).");
    ui.add_space(8.0);
    let mut open = None;
    if tab.lib.files.is_empty() {
        ui.weak("No graphs yet. Use + above to create one.");
    }
    for f in &tab.lib.files {
        let errs = f.errors.iter().filter(|e| !e.warning).count();
        ui.horizontal(|ui| {
            if ui.link(&f.path).clicked() {
                open = Some(f.path.clone());
            }
            if errs > 0 {
                ui.label(RichText::new(format!("{errs} errors")).color(Color32::from_rgb(235, 90, 90)));
            }
        });
    }
    if let Some(p) = open {
        tab.open_now(backend, &p, now);
    }
}

fn script_ui(ui: &mut Ui, tab: &mut LogicTab, s: &mut ScriptDoc, backend: &mut dyn EditorBackend, now: f64) {
    if now - s.last_poll > POLL {
        s.last_poll = now;
        if let Ok(disk) = backend.logic_read(&s.path)
            && disk != s.disk_text
        {
            if s.dirty() {
                s.changed_on_disk = true;
            } else {
                s.text = disk.clone();
                s.saved = disk.clone();
            }
            s.disk_text = disk;
        }
    }
    if !s.api_loaded {
        s.api = backend.script_api();
        s.api_loaded = true;
    }
    if s.outline_of != s.text {
        s.outline = backend.script_outline(&s.text);
        s.outline_of = s.text.clone();
    }
    let key_save = ui.ctx().input_mut(|i| i.consume_key(egui::Modifiers::COMMAND, egui::Key::S));
    let out = script_tab::show(ui, s);
    if out.save || (key_save && s.dirty()) {
        match backend.logic_write(&s.path, &s.text) {
            Ok(errs) => {
                s.saved = s.text.clone();
                s.disk_text = backend.logic_read(&s.path).unwrap_or_else(|_| s.text.clone());
                let bad = errs.iter().filter(|e| !e.warning).count();
                s.errors = errs;
                tab.say(if bad == 0 { format!("Saved {}", s.path) } else { format!("Saved {} with {bad} error(s)", s.path) }, now, bad > 0);
                tab.lib_polled = f64::NEG_INFINITY;
            }
            Err(e) => tab.say(e, now, true),
        }
    }
    if out.revert || out.reload {
        s.text = s.disk_text.clone();
        s.saved = s.disk_text.clone();
        s.changed_on_disk = false;
    }
}

fn graph_ui(ui: &mut Ui, tab: &mut LogicTab, doc: &mut GraphDoc, backend: &mut dyn EditorBackend, now: f64) {
    let ctx = ui.ctx().clone();
    // External edits.
    if now - doc.last_poll > POLL {
        doc.last_poll = now;
        if let Ok(disk) = backend.logic_read(&doc.path)
            && disk != doc.disk_text
        {
            if doc.dirty() {
                doc.changed_on_disk = true;
            } else if let Ok(g) = Graph::from_ron(&disk) {
                doc.load_graph(&g);
                doc.saved = doc.graph.clone();
                doc.undo.clear();
                doc.redo.clear();
                doc.recheck(tab.lib.catalog.as_ref());
                doc.say("Reloaded from disk", now);
            }
            doc.disk_text = disk;
        }
    }
    // Who runs this graph.
    if tab.users_for != doc.path || now - tab.users_polled > 1.0 {
        tab.users = backend.logic_users(&doc.path);
        tab.users_for = doc.path.clone();
        tab.users_polled = now;
    }

    if let Some(tr) = tab.pending_trace.take() {
        doc.trace = Some(TraceViz { nodes: tr.nodes, log: tr.log, started: now, error: None });
    }
    let mut act = ToolbarAct::default();
    let keys = std::mem::take(&mut tab.keys);
    act.undo |= keys.undo;
    act.redo |= keys.redo;
    act.save |= keys.save;
    toolbar(ui, tab, doc, now, &mut act);
    if doc.changed_on_disk {
        ui.horizontal(|ui| {
            ui.label(RichText::new("This graph changed on disk.").color(Color32::from_rgb(235, 190, 60)));
            if ui.button("Reload (drops your edits)").clicked() {
                act.revert = true;
            }
            if ui.button("Keep mine").clicked() {
                doc.changed_on_disk = false;
            }
        });
    }
    // Panels.
    let mut goto = None;
    let id = ui.id().with(&doc.path);
    egui::Panel::left(id.with("left")).resizable(true).default_size(190.0).show(ui, |ui| my_logic(ui, tab, doc, &mut goto));
    egui::Panel::right(id.with("right")).resizable(true).default_size(260.0).show(ui, |ui| {
        egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| inspector::show(ui, doc));
    });
    if doc.results_open {
        egui::Panel::bottom(id.with("results")).resizable(true).default_size(110.0).show(ui, |ui| {
            if let Some(n) = compile_ui::strip(ui, doc) {
                goto = Some(n);
            }
        });
    }
    let key = if ctx.input(|i| i.pointer.any_down()) {
        Some(format!("drag{}", tab.press_count))
    } else {
        ctx.memory(|m| m.focused()).map(|f| format!("focus{f:?}"))
    };
    egui::CentralPanel::default().frame(egui::Frame::NONE).show(ui, |ui| {
        canvas::show(ui, doc, &tab.entries, now, keys);
    });
    if let Some(n) = goto {
        doc.goto = Some(n);
        doc.sel = Sel::Node(n);
    }
    doc.commit(now, key, tab.lib.catalog.as_ref());
    apply_toolbar(tab, doc, backend, act, now);
    if let Some(t) = &doc.trace
        && t.done(now)
    {
        // Keep the last trace visible (dimmed) but stop repainting for it.
    }
}

#[derive(Default)]
struct ToolbarAct {
    compile: bool,
    save: bool,
    revert: bool,
    undo: bool,
    redo: bool,
    fit: bool,
    comment: bool,
    fire: bool,
    attach: bool,
}

fn toolbar(ui: &mut Ui, tab: &mut LogicTab, doc: &mut GraphDoc, now: f64, act: &mut ToolbarAct) {
    let t = tokens::current(ui.ctx());
    ui.horizontal_wrapped(|ui| {
        let (txt, bad, warn) = compile_ui::status(doc);
        let col = if bad { t.status.danger } else if warn { t.status.warning } else { t.status.success };
        if ui.button(RichText::new(format!("Compile: {txt}")).color(col)).on_hover_text("Check the graph and list the problems").clicked() {
            act.compile = true;
        }
        if ui.add_enabled(doc.dirty(), egui::Button::new("Save")).on_hover_text("Cmd+S").clicked() {
            act.save = true;
        }
        if ui.add_enabled(doc.dirty(), egui::Button::new("Revert")).on_hover_text("Reload the file").clicked() {
            act.revert = true;
        }
        ui.separator();
        if ui.add_enabled(!doc.undo.is_empty(), egui::Button::new("Undo")).on_hover_text("Cmd+Z over the canvas").clicked() {
            act.undo = true;
        }
        if ui.add_enabled(!doc.redo.is_empty(), egui::Button::new("Redo")).clicked() {
            act.redo = true;
        }
        ui.separator();
        ui.label("Find");
        ui.add(egui::TextEdit::singleline(&mut doc.search).desired_width(100.0).hint_text("node"));
        if ui.button("Fit").on_hover_text("Frame the whole graph (F)").clicked() {
            act.fit = true;
        }
        if ui.button("Comment").on_hover_text("Add a comment box").clicked() {
            act.comment = true;
        }
        ui.separator();
        ui.label("Test");
        let events = fire_events(&doc.graph);
        let cur = events.iter().find(|(_, e)| *e == doc.fire_event).map_or(doc.fire_event.clone(), |(l, _)| l.clone());
        egui::ComboBox::from_id_salt("fire-event").selected_text(cur).width(130.0).show_ui(ui, |ui| {
            for (label, ev) in &events {
                ui.selectable_value(&mut doc.fire_event, ev.clone(), label);
            }
        });
        let who = tab.users.first().copied();
        if ui.add_enabled(who.is_some(), egui::Button::new("Fire")).on_hover_text(match who {
            Some(e) => format!("Run the event on entity {e} and show the path"),
            None => "No entity in the level uses this graph".to_string(),
        }).clicked() {
            act.fire = true;
        }
        if who.is_none() && ui.button("Attach to selection").on_hover_text("Add a Logic component pointing at this graph to the selected entity").clicked() {
            act.attach = true;
        }
        ui.checkbox(&mut doc.results_open, "Results");
        let _ = now;
    });
}

fn apply_toolbar(tab: &mut LogicTab, doc: &mut GraphDoc, backend: &mut dyn EditorBackend, act: ToolbarAct, now: f64) {
    let cat = tab.lib.catalog.clone();
    if act.compile {
        doc.recheck(cat.as_ref());
        doc.results_open = true;
        let (s, ..) = compile_ui::status(doc);
        tab.say(format!("Compile: {s}"), now, false);
    }
    if act.undo && doc.undo(cat.as_ref()) {
        tab.say("Undo", now, false);
    }
    if act.redo && doc.redo(cat.as_ref()) {
        tab.say("Redo", now, false);
    }
    if act.fit {
        doc.fit_pending = true;
    }
    if act.comment {
        let c = doc.canvas;
        let t = doc.to_global.inverse();
        let p = t * c.center();
        // Around the selected node when there is one.
        let rect = match &doc.sel {
            Sel::Node(id) => doc.node_rects.get(id).map(|r| r.expand(40.0)),
            _ => None,
        };
        let r = rect.unwrap_or_else(|| egui::Rect::from_center_size(p, egui::vec2(300.0, 180.0)));
        doc.comments.push(logic_core::Comment::new("Comment", [r.min.x, r.min.y], [r.width(), r.height()]));
        doc.sel = Sel::Comment(doc.comments.len() - 1);
    }
    if act.save {
        let ron = doc.graph.to_ron();
        match backend.logic_write(&doc.path, &ron) {
            Ok(errs) => {
                doc.saved = doc.graph.clone();
                doc.disk_text = backend.logic_read(&doc.path).unwrap_or(ron);
                doc.changed_on_disk = false;
                let bad = errs.iter().filter(|e| !e.warning).count();
                tab.say(if bad == 0 { format!("Saved {}", doc.path) } else { format!("Saved {} with {bad} error(s)", doc.path) }, now, bad > 0);
                tab.lib_polled = f64::NEG_INFINITY;
            }
            Err(e) => tab.say(format!("Save failed: {e}"), now, true),
        }
    }
    if act.revert {
        match backend.logic_read(&doc.path).map_err(|e| e.to_string()).and_then(|t| Graph::from_ron(&t).map(|g| (t, g)).map_err(|e| e.to_string())) {
            Ok((text, g)) => {
                doc.load_graph(&g);
                doc.saved = doc.graph.clone();
                doc.disk_text = text;
                doc.changed_on_disk = false;
                doc.undo.clear();
                doc.redo.clear();
                doc.recheck(cat.as_ref());
                tab.say("Reverted", now, false);
            }
            Err(e) => tab.say(format!("Revert failed: {e}"), now, true),
        }
    }
    if act.attach {
        let sel = backend.selection();
        match sel.first() {
            None => tab.say("Select an entity in the Outliner first", now, true),
            Some(&e) => match backend.logic_attach(e, &doc.path) {
                Ok(op) => {
                    tab.applied.push(("Attach logic".into(), op));
                    tab.users_polled = f64::NEG_INFINITY;
                    tab.say("Attached to the selected entity", now, false);
                }
                Err(e) => tab.say(e, now, true),
            },
        }
    }
    if act.fire
        && let Some(&e) = tab.users.first()
    {
        // Run what is on the canvas, not only what was saved last.
        if doc.dirty() {
            tab.say("Fire runs the saved graph. Save first to test your edits.", now, false);
        }
        match backend.logic_fire(e, &doc.fire_event) {
            Ok(tr) => {
                let n = tr.nodes.len();
                doc.trace = Some(TraceViz { nodes: tr.nodes, log: tr.log, started: now, error: None });
                if n == 0 {
                    tab.say("The event ran no node (nothing listens to it in this graph)", now, false);
                }
            }
            Err(msg) => {
                doc.trace = Some(TraceViz { nodes: Vec::new(), log: Vec::new(), started: now, error: Some(msg.clone()) });
                tab.say(format!("Fire failed: {msg}"), now, true);
            }
        }
    }
}

fn my_logic(ui: &mut Ui, tab: &mut LogicTab, doc: &mut GraphDoc, goto: &mut Option<u32>) {
    let t = tokens::current(ui.ctx());
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        ui.label(RichText::new("MY LOGIC").strong().color(t.text.secondary).size(11.0));
        egui::CollapsingHeader::new("Events").default_open(true).show(ui, |ui| {
            let events: Vec<(u32, String)> = doc.graph.nodes.iter().filter(|n| logic_core::category(&n.kind) == "Events").map(|n| (n.id, logic_core::label(&n.kind))).collect();
            if events.is_empty() {
                ui.weak("none: right-click the canvas, Events");
            }
            for (id, label) in events {
                if ui.selectable_label(doc.sel == Sel::Node(id), label).clicked() {
                    *goto = Some(id);
                }
            }
        });
        egui::CollapsingHeader::new("Variables").default_open(true).show(ui, |ui| {
            let vars: Vec<Var> = doc.vars.clone();
            for v in &vars {
                let r = ui.selectable_label(doc.sel == Sel::Var(v.name.clone()), RichText::new(format!("{}  {}", v.name, state::PinTy::Data(v.ty).name())).color(state::PinTy::Data(v.ty).color()));
                if r.clicked() {
                    doc.sel = Sel::Var(v.name.clone());
                }
            }
            if ui.button("+ Variable").clicked() {
                let mut n = 1;
                while doc.vars.iter().any(|v| v.name == format!("var{n}")) {
                    n += 1;
                }
                let name = format!("var{n}");
                doc.vars.push(Var { name: name.clone(), ty: Ty::Number, default: Value::Num(0.0) });
                doc.sel = Sel::Var(name);
            }
        });
        egui::CollapsingHeader::new("Scripts").default_open(true).show(ui, |ui| {
            let mut open = None;
            let mut files: Vec<&str> = tab.lib.files.iter().filter(|f| f.path.ends_with(".ruspy")).map(|f| f.path.as_str()).collect();
            files.sort();
            for f in files {
                let name = f.trim_start_matches("scripts/");
                egui::CollapsingHeader::new(name).id_salt(f).default_open(false).show(ui, |ui| {
                    if ui.small_button("Open").clicked() {
                        open = Some(f.to_string());
                    }
                    if let Some(c) = &tab.lib.catalog {
                        for s in c.scripts.iter().filter(|s| s.file == name && !s.function.is_empty()) {
                            ui.weak(format!("{}({})", s.function, s.args.join(", ")));
                        }
                    }
                });
            }
            if let Some(p) = open {
                tab.open(&p);
            }
        });
        egui::CollapsingHeader::new("Messages").default_open(false).show(ui, |ui| {
            let names = message_names(&doc.graph);
            if names.is_empty() {
                ui.weak("none");
            }
            for n in names {
                ui.label(n);
            }
        });
        egui::CollapsingHeader::new("Graphs").default_open(false).show(ui, |ui| {
            let mut open = None;
            for f in tab.lib.files.iter().filter(|f| f.path.ends_with(".logic.ron")) {
                if ui.selectable_label(f.path == doc.path, &f.name).clicked() {
                    open = Some(f.path.clone());
                }
            }
            if let Some(p) = open {
                tab.open(&p);
            }
        });
    });
}

#[allow(dead_code)]
fn _kinds(_: &NodeKind) {}
