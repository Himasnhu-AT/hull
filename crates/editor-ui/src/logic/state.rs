//! Logic tab state: open documents, the snarl working copy of a graph and its conversion
//! to and from [`logic_core::Graph`], pin types and colours, the in-tab undo stack.
//!
//! The snarl graph is what the user edits; the `Graph` is derived from it every frame
//! ([`GraphDoc::to_graph`]). When the derived graph differs from the last one, the old one goes
//! on the undo stack (consecutive changes of one drag or one text field merge into one step),
//! the checks run again and `dirty` follows from `graph != saved`. Undo / redo rebuild the snarl
//! from a stored `Graph`. The stack is per document and lives in the tab (not the level's
//! `Op` journal): a graph is a file, saved on its own.

use std::collections::{HashMap, HashSet};

use editor_proto::LogicPalette;
use egui::Color32;
use egui_snarl::{InPinId, NodeId, OutPinId, Snarl};
use logic_core::{Catalog, Comment, Graph, GraphError, Link, Node, NodeKind, Pin, PinSpec, ScriptFn, Ty, Value, Var};

/// A node in the snarl working copy.
#[derive(Clone, Debug, PartialEq)]
pub struct SNode {
    pub id: u32,
    pub kind: NodeKind,
    pub defaults: Vec<(String, Value)>,
}

/// Pin type: execution flow or a data type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PinTy {
    Flow,
    Data(Ty),
}

impl PinTy {
    /// Can an output of this type feed an input of type `to`?
    pub fn feeds(self, to: PinTy) -> bool {
        match (self, to) {
            (PinTy::Flow, PinTy::Flow) => true,
            (PinTy::Data(a), PinTy::Data(b)) => a.feeds(b),
            _ => false,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            PinTy::Flow => "Exec",
            PinTy::Data(Ty::Bool) => "Bool",
            PinTy::Data(Ty::Number) => "Number",
            PinTy::Data(Ty::String) => "String",
            PinTy::Data(Ty::Vec3) => "Vec3",
            PinTy::Data(Ty::Entity) => "Entity",
            PinTy::Data(Ty::Json) => "Json",
            PinTy::Data(Ty::Any) => "Any",
        }
    }
    /// Unreal-style: exec white, bool red, number green, string magenta, vec3 yellow,
    /// entity cyan, json blue-grey, any grey.
    pub fn color(self) -> Color32 {
        match self {
            PinTy::Flow => Color32::from_rgb(240, 240, 240),
            PinTy::Data(Ty::Bool) => Color32::from_rgb(220, 60, 60),
            PinTy::Data(Ty::Number) => Color32::from_rgb(70, 200, 100),
            PinTy::Data(Ty::String) => Color32::from_rgb(230, 70, 210),
            PinTy::Data(Ty::Vec3) => Color32::from_rgb(245, 205, 60),
            PinTy::Data(Ty::Entity) => Color32::from_rgb(60, 205, 235),
            PinTy::Data(Ty::Json) => Color32::from_rgb(120, 145, 195),
            PinTy::Data(Ty::Any) => Color32::from_rgb(150, 150, 155),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PinDef {
    pub name: String,
    pub ty: PinTy,
}

/// The pins of a node in snarl order: inputs = exec `in` then data inputs; outputs = exec
/// outputs then data outputs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PinLayout {
    pub ins: Vec<PinDef>,
    pub outs: Vec<PinDef>,
    pub exec_outs: usize,
}

impl PinLayout {
    pub fn of(vars: &[Var], kind: &NodeKind) -> PinLayout {
        PinLayout::from_spec(&logic_core::pins_in(vars, kind))
    }
    pub fn from_spec(s: &PinSpec) -> PinLayout {
        let mut l = PinLayout { exec_outs: s.exec_out.len(), ..Default::default() };
        if s.exec_in {
            l.ins.push(PinDef { name: "in".into(), ty: PinTy::Flow });
        }
        l.ins.extend(s.data_in.iter().map(|d| PinDef { name: d.name.clone(), ty: PinTy::Data(d.ty) }));
        l.outs.extend(s.exec_out.iter().map(|n| PinDef { name: n.clone(), ty: PinTy::Flow }));
        l.outs.extend(s.data_out.iter().map(|(n, t)| PinDef { name: n.clone(), ty: PinTy::Data(*t) }));
        l
    }
    pub fn in_index(&self, name: &str, flow: bool) -> Option<usize> {
        self.ins.iter().position(|p| p.name == name && (p.ty == PinTy::Flow) == flow)
    }
    pub fn out_index(&self, name: &str, flow: bool) -> Option<usize> {
        self.outs.iter().position(|p| p.name == name && (p.ty == PinTy::Flow) == flow)
    }
}

/// What the inspector shows.
#[derive(Clone, Debug, PartialEq, Default)]
pub enum Sel {
    #[default]
    None,
    Node(u32),
    Var(String),
    Comment(usize),
}

/// A fire result being shown on the canvas.
pub struct TraceViz {
    pub nodes: Vec<u32>,
    pub log: Vec<String>,
    pub started: f64,
    pub error: Option<String>,
}

/// Seconds between lighting two nodes of a trace, and how long a lit node glows.
pub const PULSE_STEP: f64 = 0.18;
pub const PULSE_HOLD: f64 = 2.5;

impl TraceViz {
    /// 0..1 brightness of node `id` at time `now` (0 = not lit / not in the trace).
    pub fn glow(&self, id: u32, now: f64) -> f32 {
        let Some(i) = self.nodes.iter().position(|n| *n == id) else { return 0.0 };
        let t = now - self.started - i as f64 * PULSE_STEP;
        if t < 0.0 {
            0.0
        } else {
            (1.0 - (t / PULSE_HOLD).min(1.0)).max(0.25) as f32
        }
    }
    pub fn done(&self, now: f64) -> bool {
        now - self.started > self.nodes.len() as f64 * PULSE_STEP + PULSE_HOLD
    }
}

pub struct GraphDoc {
    pub path: String,
    pub snarl: Snarl<SNode>,
    pub name: String,
    pub vars: Vec<Var>,
    pub comments: Vec<Comment>,
    /// Links the pin tables don't know (kept so the checks can report them).
    pub orphans: Vec<(Link, bool)>,
    /// The last graph derived from the canvas.
    pub graph: Graph,
    /// The graph as saved / loaded.
    pub saved: Graph,
    pub undo: Vec<Graph>,
    pub redo: Vec<Graph>,
    last_key: Option<String>,
    last_edit: f64,
    pub errors: Vec<GraphError>,
    pub sel: Sel,
    /// Snarl's own selection last frame (to tell a user change from a rebuild).
    pub snarl_sel_prev: Vec<u32>,
    pub disk_text: String,
    pub last_poll: f64,
    pub changed_on_disk: bool,
    pub trace: Option<TraceViz>,
    pub fire_event: String,
    pub fit_pending: bool,
    pub goto: Option<u32>,
    pub center_on: Option<egui::Pos2>,
    pub search: String,
    pub results_open: bool,
    pub widget_id: egui::Id,
    pub canvas: egui::Rect,
    /// Node rectangles in graph space, from the last frame.
    pub node_rects: HashMap<u32, egui::Rect>,
    /// Row centre (graph space) of each pin: `(node id, is output, pin index)`.
    pub pin_y: HashMap<(u32, bool, usize), f32>,
    pub to_global: egui::emath::TSTransform,
    pub message: Option<(String, f64)>,
}

impl GraphDoc {
    pub fn new(path: &str, g: &Graph) -> GraphDoc {
        let name = path.rsplit('/').next().unwrap_or(path).trim_end_matches(".logic.ron").to_string();
        let mut d = GraphDoc {
            path: path.to_string(),
            snarl: Snarl::new(),
            name,
            vars: Vec::new(),
            comments: Vec::new(),
            orphans: Vec::new(),
            graph: Graph::default(),
            saved: Graph::default(),
            undo: Vec::new(),
            redo: Vec::new(),
            last_key: None,
            last_edit: f64::NEG_INFINITY,
            errors: Vec::new(),
            sel: Sel::None,
            snarl_sel_prev: Vec::new(),
            disk_text: String::new(),
            last_poll: f64::NEG_INFINITY,
            changed_on_disk: false,
            trace: None,
            fire_event: "start".into(),
            fit_pending: true,
            goto: None,
            center_on: None,
            search: String::new(),
            results_open: true,
            widget_id: egui::Id::new(("logic.canvas", path)),
            canvas: egui::Rect::NOTHING,
            node_rects: HashMap::new(),
            pin_y: HashMap::new(),
            to_global: egui::emath::TSTransform::IDENTITY,
            message: None,
        };
        d.load_graph(g);
        d.saved = d.graph.clone();
        d
    }

    pub fn dirty(&self) -> bool {
        self.graph != self.saved
    }

    /// Where a pin is on screen (for tests and automation): the node's edge at the pin's row.
    pub fn pin_screen_pos(&self, node: u32, output: bool, pin: &str) -> Option<egui::Pos2> {
        let n = self.snarl.get_node(*self.node_ids().get(&node)?)?;
        let l = PinLayout::of(&self.vars, &n.kind);
        let idx = if output { l.outs.iter().position(|p| p.name == pin)? } else { l.ins.iter().position(|p| p.name == pin)? };
        let r = self.node_rects.get(&node)?;
        let y = *self.pin_y.get(&(node, output, idx))?;
        let x = if output { r.right() + 8.0 } else { r.left() - 8.0 };
        Some(self.to_global * egui::pos2(x, y))
    }

    /// Replaces the canvas with `g` (selection is dropped).
    pub fn load_graph(&mut self, g: &Graph) {
        self.snarl = Snarl::new();
        self.vars = g.vars.clone();
        self.comments = g.comments.clone();
        self.orphans.clear();
        self.name = if g.name.is_empty() { self.name.clone() } else { g.name.clone() };
        let mut ids: HashMap<u32, NodeId> = HashMap::new();
        for n in &g.nodes {
            let sn = SNode { id: n.id, kind: n.kind.clone(), defaults: n.defaults.clone() };
            ids.insert(n.id, self.snarl.insert_node(egui::pos2(n.pos[0], n.pos[1]), sn));
        }
        let layout = |snarl: &Snarl<SNode>, vars: &[Var], id: NodeId| PinLayout::of(vars, &snarl[id].kind);
        for (links, flow) in [(&g.flow, true), (&g.data, false)] {
            for l in links {
                let wired = (|| {
                    let (&a, &b) = (ids.get(&l.from.0)?, ids.get(&l.to.0)?);
                    let o = layout(&self.snarl, &self.vars, a).out_index(&l.from.1, flow)?;
                    let i = layout(&self.snarl, &self.vars, b).in_index(&l.to.1, flow)?;
                    // A pin takes one wire from a source in the file; extras would be dropped.
                    Some((OutPinId { node: a, output: o }, InPinId { node: b, input: i }))
                })();
                match wired {
                    Some((o, i)) if self.snarl.connect(o, i) => {}
                    _ => self.orphans.push((l.clone(), flow)),
                }
            }
        }
        self.graph = self.to_graph();
        self.sel = Sel::None;
        self.snarl_sel_prev.clear();
    }

    /// The graph the canvas currently holds.
    pub fn to_graph(&self) -> Graph {
        let mut nodes: Vec<Node> = self.snarl.nodes_pos_ids().map(|(_, pos, sn)| Node { id: sn.id, kind: sn.kind.clone(), defaults: sn.defaults.clone(), pos: [pos.x, pos.y] }).collect();
        nodes.sort_by_key(|n| n.id);
        let mut flow: Vec<Link> = Vec::new();
        let mut data: Vec<Link> = Vec::new();
        for (o, i) in self.snarl.wires() {
            let (Some(a), Some(b)) = (self.snarl.get_node(o.node), self.snarl.get_node(i.node)) else { continue };
            let (la, lb) = (PinLayout::of(&self.vars, &a.kind), PinLayout::of(&self.vars, &b.kind));
            let (Some(po), Some(pi)) = (la.outs.get(o.output), lb.ins.get(i.input)) else { continue };
            let link = Link { from: Pin(a.id, po.name.clone()), to: Pin(b.id, pi.name.clone()) };
            if po.ty == PinTy::Flow { flow.push(link) } else { data.push(link) }
        }
        for (l, is_flow) in &self.orphans {
            if *is_flow { flow.push(l.clone()) } else { data.push(l.clone()) }
        }
        let key = |l: &Link| (l.from.0, l.from.1.clone(), l.to.0, l.to.1.clone());
        flow.sort_by_key(key);
        data.sort_by_key(key);
        Graph { name: self.name.clone(), nodes, flow, data, vars: self.vars.clone(), comments: self.comments.clone() }
    }

    pub fn node_ids(&self) -> HashMap<u32, NodeId> {
        self.snarl.nodes_ids_data().map(|(id, n)| (n.value.id, id)).collect()
    }

    pub fn next_id(&self) -> u32 {
        self.snarl.nodes().map(|n| n.id).max().map_or(1, |m| m + 1)
    }

    /// Called every frame after the canvas ran: notices edits, keeps undo, reruns the checks.
    /// `key` merges consecutive edits (a drag, one text field) into one undo step.
    pub fn commit(&mut self, now: f64, key: Option<String>, catalog: Option<&Catalog>) {
        let g = self.to_graph();
        if g == self.graph {
            return;
        }
        let merge = key.is_some() && key == self.last_key && now - self.last_edit < 1.5;
        if !merge {
            self.undo.push(std::mem::replace(&mut self.graph, g.clone()));
            if self.undo.len() > 200 {
                self.undo.remove(0);
            }
        }
        self.graph = g;
        self.redo.clear();
        self.last_key = key;
        self.last_edit = now;
        self.recheck(catalog);
    }

    pub fn recheck(&mut self, catalog: Option<&Catalog>) {
        self.errors = self.graph.check(catalog);
    }

    pub fn undo(&mut self, catalog: Option<&Catalog>) -> bool {
        let Some(prev) = self.undo.pop() else { return false };
        let cur = std::mem::replace(&mut self.graph, prev.clone());
        self.redo.push(cur);
        self.after_history(&prev, catalog);
        true
    }

    pub fn redo(&mut self, catalog: Option<&Catalog>) -> bool {
        let Some(next) = self.redo.pop() else { return false };
        let cur = std::mem::replace(&mut self.graph, next.clone());
        self.undo.push(cur);
        self.after_history(&next, catalog);
        true
    }

    fn after_history(&mut self, g: &Graph, catalog: Option<&Catalog>) {
        let keep = (std::mem::take(&mut self.undo), std::mem::take(&mut self.redo));
        self.load_graph(g);
        self.undo = keep.0;
        self.redo = keep.1;
        self.last_key = None;
        self.recheck(catalog);
    }

    /// After a node's kind changed, re-key its wires to the new pin table (by pin name).
    pub fn relayout(&mut self, id: NodeId, old: &PinLayout) {
        let Some(sn) = self.snarl.get_node(id) else { return };
        let new = PinLayout::of(&self.vars, &sn.kind);
        if *old == new {
            return;
        }
        let ins: Vec<(usize, OutPinId)> = self.snarl.wires().filter(|(_, i)| i.node == id).map(|(o, i)| (i.input, o)).collect();
        let outs: Vec<(usize, InPinId)> = self.snarl.wires().filter(|(o, _)| o.node == id).map(|(o, i)| (o.output, i)).collect();
        for (idx, _) in &ins {
            self.snarl.drop_inputs(InPinId { node: id, input: *idx });
        }
        for (idx, _) in &outs {
            self.snarl.drop_outputs(OutPinId { node: id, output: *idx });
        }
        for (idx, from) in ins {
            let Some(p) = old.ins.get(idx) else { continue };
            if let Some(ni) = new.in_index(&p.name, p.ty == PinTy::Flow) {
                let ok = self.snarl.get_node(from.node).map(|n| PinLayout::of(&self.vars, &n.kind)).and_then(|l| l.outs.get(from.output).cloned()).is_some_and(|src| src.ty.feeds(new.ins[ni].ty));
                if ok {
                    self.snarl.connect(from, InPinId { node: id, input: ni });
                }
            }
        }
        for (idx, to) in outs {
            let Some(p) = old.outs.get(idx) else { continue };
            if let Some(no) = new.out_index(&p.name, p.ty == PinTy::Flow) {
                let ok = self.snarl.get_node(to.node).map(|n| PinLayout::of(&self.vars, &n.kind)).and_then(|l| l.ins.get(to.input).cloned()).is_some_and(|dst| new.outs[no].ty.feeds(dst.ty));
                if ok {
                    self.snarl.connect(OutPinId { node: id, output: no }, to);
                }
            }
        }
    }

    /// Ids of nodes with an error, and the messages by node.
    pub fn error_map(&self) -> HashMap<u32, Vec<GraphError>> {
        let mut m: HashMap<u32, Vec<GraphError>> = HashMap::new();
        for e in &self.errors {
            if let Some(n) = e.node {
                m.entry(n).or_default().push(e.clone());
            }
        }
        m
    }

    pub fn say(&mut self, msg: impl Into<String>, now: f64) {
        self.message = Some((msg.into(), now));
    }
}

pub struct ScriptDoc {
    pub path: String,
    pub text: String,
    pub saved: String,
    pub disk_text: String,
    pub errors: Vec<editor_proto::GraphErrorDoc>,
    pub last_poll: f64,
    pub changed_on_disk: bool,
    pub jump_to: Option<usize>,
}

impl ScriptDoc {
    pub fn dirty(&self) -> bool {
        self.text != self.saved
    }
}

pub enum Doc {
    Graph(Box<GraphDoc>),
    Script(Box<ScriptDoc>),
}

impl Doc {
    pub fn path(&self) -> &str {
        match self {
            Doc::Graph(g) => &g.path,
            Doc::Script(s) => &s.path,
        }
    }
    pub fn dirty(&self) -> bool {
        match self {
            Doc::Graph(g) => g.dirty(),
            Doc::Script(s) => s.dirty(),
        }
    }
    pub fn title(&self) -> String {
        let p = self.path();
        let f = p.rsplit('/').next().unwrap_or(p);
        f.trim_end_matches(".ron").to_string()
    }
}

/// What the backend knows that the checks and the palette need.
#[derive(Default)]
pub struct Library {
    pub palette: LogicPalette,
    pub catalog: Option<Catalog>,
    pub files: Vec<editor_proto::LogicFile>,
}

impl Library {
    pub fn set_palette(&mut self, p: LogicPalette) {
        let mut scripts: Vec<ScriptFn> = Vec::new();
        for f in &p.functions {
            // `file::fn(a, b)`
            let Some((file, rest)) = f.split_once("::") else { continue };
            let (name, args) = rest.split_once('(').unwrap_or((rest, ""));
            let args = args.trim_end_matches(')');
            scripts.push(ScriptFn { file: file.into(), function: name.into(), args: args.split(',').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect() });
        }
        // Files without functions still exist.
        for f in &self.files {
            if let Some(name) = f.path.strip_prefix("scripts/")
                && !scripts.iter().any(|s| s.file == name)
            {
                scripts.push(ScriptFn { file: name.into(), function: String::new(), args: vec![] });
            }
        }
        let commands = p.commands.iter().map(|c| c.name.clone()).collect();
        self.catalog = Some(Catalog { scripts, commands });
        self.palette = p;
    }
}

/// Names of the messages a graph listens to or sends.
pub fn message_names(g: &Graph) -> Vec<String> {
    let mut seen = HashSet::new();
    g.nodes
        .iter()
        .filter_map(|n| match &n.kind {
            NodeKind::Message(m) | NodeKind::Emit(m) => Some(m.clone()),
            _ => None,
        })
        .filter(|m| seen.insert(m.clone()))
        .collect()
}

/// Events a graph can be fired with: `(label, event string)`.
pub fn fire_events(g: &Graph) -> Vec<(String, String)> {
    let mut v = vec![("Start".to_string(), "start".to_string()), ("Tick".to_string(), "tick".to_string())];
    for n in &g.nodes {
        match &n.kind {
            NodeKind::OverlapEnter => v.push(("OverlapEnter".into(), "overlap_enter".into())),
            NodeKind::OverlapExit => v.push(("OverlapExit".into(), "overlap_exit".into())),
            NodeKind::Action(a) => v.push((format!("Action {a}"), format!("action:{a}"))),
            NodeKind::Message(m) => v.push((format!("Message {m}"), format!("message:{m}"))),
            NodeKind::Timer { secs, .. } => v.push((format!("Timer {secs}s (node {})", n.id), format!("timer:{}", n.id))),
            _ => {}
        }
    }
    v.dedup();
    v
}


/// Shortcuts taken from the egui input while the pointer was over a graph canvas (so the
/// host's own Undo / Delete / Save did not run on them).
#[derive(Clone, Copy, Debug, Default)]
pub struct Keys {
    pub undo: bool,
    pub redo: bool,
    pub save: bool,
    pub delete: bool,
    pub duplicate: bool,
    pub frame: bool,
}
