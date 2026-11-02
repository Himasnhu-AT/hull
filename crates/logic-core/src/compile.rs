//! Pin tables, validation and the compiled (index-based) form the interpreter runs.

use std::collections::HashMap;

use crate::graph::NodeKind;
use crate::value::{Ty, Value};

/// Longest chain of data nodes feeding each other (bounds interpreter recursion).
pub const MAX_DATA_DEPTH: usize = 64;
pub const NONE: u32 = u32::MAX;

#[derive(Clone, Debug, PartialEq)]
pub enum Dflt {
    Required,
    Value(Value),
    /// The entity the event happened to.
    SelfEntity,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DataIn {
    pub name: String,
    pub ty: Ty,
    pub default: Dflt,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PinSpec {
    pub exec_in: bool,
    pub exec_out: Vec<String>,
    pub data_in: Vec<DataIn>,
    pub data_out: Vec<(String, Ty)>,
}

fn din(name: &str, ty: Ty) -> DataIn {
    DataIn { name: name.into(), ty, default: Dflt::Required }
}
fn din_or(name: &str, ty: Ty, v: Value) -> DataIn {
    DataIn { name: name.into(), ty, default: Dflt::Value(v) }
}
fn out(name: &str, ty: Ty) -> (String, Ty) {
    (name.into(), ty)
}

/// `"$name"` placeholders in a command's params, in order of first appearance.
pub fn param_names(params: &serde_json::Value) -> Vec<String> {
    fn walk(v: &serde_json::Value, names: &mut Vec<String>) {
        match v {
            serde_json::Value::String(s) => {
                if let Some(n) = s.strip_prefix('$') {
                    if !n.is_empty() && !names.iter().any(|x| x == n) {
                        names.push(n.to_string());
                    }
                }
            }
            serde_json::Value::Array(a) => a.iter().for_each(|x| walk(x, names)),
            serde_json::Value::Object(o) => o.values().for_each(|x| walk(x, names)),
            _ => {}
        }
    }
    let mut names = Vec::new();
    walk(params, &mut names);
    names
}

/// The pins a node kind has.
pub fn pins(kind: &NodeKind) -> PinSpec {
    use NodeKind::*;
    let mut s = PinSpec { exec_in: false, exec_out: vec![], data_in: vec![], data_out: vec![] };
    let event = |s: &mut PinSpec, extra: &[(&str, Ty)]| {
        s.exec_out = vec!["then".into()];
        s.data_out = vec![out("self", Ty::Entity)];
        s.data_out.extend(extra.iter().map(|(n, t)| out(n, *t)));
    };
    let flow = |s: &mut PinSpec| {
        s.exec_in = true;
        s.exec_out = vec!["then".into()];
    };
    match kind {
        Start => event(&mut s, &[]),
        OverlapEnter | OverlapExit => event(&mut s, &[("other", Ty::Entity)]),
        Tick => event(&mut s, &[("dt", Ty::Number)]),
        Action(_) => event(&mut s, &[("value", Ty::Number)]),
        Timer { .. } => event(&mut s, &[]),
        Message(_) => event(&mut s, &[("value", Ty::Any)]),
        Branch => {
            s.exec_in = true;
            s.exec_out = vec!["true".into(), "false".into()];
            s.data_in = vec![din("cond", Ty::Bool)];
        }
        Sequence { n } => {
            s.exec_in = true;
            s.exec_out = (0..*n).map(|i| i.to_string()).collect();
        }
        Delay { .. } => flow(&mut s),
        ForEach => {
            s.exec_in = true;
            s.exec_out = vec!["body".into(), "done".into()];
            s.data_in = vec![din("list", Ty::Json)];
            s.data_out = vec![out("item", Ty::Any), out("index", Ty::Number)];
        }
        Get { .. } => {
            s.data_in = vec![DataIn { name: "entity".into(), ty: Ty::Entity, default: Dflt::SelfEntity }];
            s.data_out = vec![out("value", Ty::Any)];
        }
        Set { .. } => {
            flow(&mut s);
            s.data_in = vec![DataIn { name: "entity".into(), ty: Ty::Entity, default: Dflt::SelfEntity }, din("value", Ty::Any)];
        }
        Const(v) => s.data_out = vec![out("value", v.ty())],
        Math(_) => {
            s.data_in = vec![din("a", Ty::Number), din("b", Ty::Number)];
            s.data_out = vec![out("result", Ty::Number)];
        }
        Clamp => {
            s.data_in = vec![din("value", Ty::Number), din("min", Ty::Number), din("max", Ty::Number)];
            s.data_out = vec![out("result", Ty::Number)];
        }
        Compare(_) => {
            s.data_in = vec![din("a", Ty::Any), din("b", Ty::Any)];
            s.data_out = vec![out("result", Ty::Bool)];
        }
        And | Or => {
            s.data_in = vec![din("a", Ty::Bool), din("b", Ty::Bool)];
            s.data_out = vec![out("result", Ty::Bool)];
        }
        Not => {
            s.data_in = vec![din("a", Ty::Bool)];
            s.data_out = vec![out("result", Ty::Bool)];
        }
        Vec3Make => {
            s.data_in = vec![din_or("x", Ty::Number, Value::Num(0.0)), din_or("y", Ty::Number, Value::Num(0.0)), din_or("z", Ty::Number, Value::Num(0.0))];
            s.data_out = vec![out("v", Ty::Vec3)];
        }
        Vec3Split => {
            s.data_in = vec![din("v", Ty::Vec3)];
            s.data_out = vec![out("x", Ty::Number), out("y", Ty::Number), out("z", Ty::Number)];
        }
        Vec3Add => {
            s.data_in = vec![din("a", Ty::Vec3), din("b", Ty::Vec3)];
            s.data_out = vec![out("v", Ty::Vec3)];
        }
        Vec3Scale => {
            s.data_in = vec![din("v", Ty::Vec3), din("s", Ty::Number)];
            s.data_out = vec![out("v", Ty::Vec3)];
        }
        Command { params, .. } => {
            flow(&mut s);
            s.data_in = param_names(params).iter().map(|n| din(n, Ty::Any)).collect();
            s.data_out = vec![out("result", Ty::Any)];
        }
        Script { args, .. } => {
            flow(&mut s);
            s.data_in = args.iter().map(|n| din(n, Ty::Any)).collect();
            s.data_out = vec![out("result", Ty::Any)];
        }
        Emit(_) => {
            flow(&mut s);
            s.data_in = vec![din_or("value", Ty::Any, Value::Null)];
        }
        Log => {
            flow(&mut s);
            s.data_in = vec![din("text", Ty::Any)];
        }
    }
    s
}

/// Short name of a node kind for messages.
pub fn kind_name(kind: &NodeKind) -> String {
    let d = format!("{kind:?}");
    d.split(|c: char| c == '(' || c == ' ' || c == '{').next().unwrap_or("").to_string()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

/// A problem in a graph, located at a node (and pin) by the id used in the file.
#[derive(Clone, Debug, PartialEq)]
pub struct GraphError {
    pub severity: Severity,
    pub node: Option<u32>,
    pub pin: Option<String>,
    pub message: String,
}

impl std::fmt::Display for GraphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let sev = if self.severity == Severity::Error { "error" } else { "warning" };
        write!(f, "{sev}")?;
        if let Some(n) = self.node {
            write!(f, " at node {n}")?;
            if let Some(p) = &self.pin {
                write!(f, " pin `{p}`")?;
            }
        }
        write!(f, ": {}", self.message)
    }
}

/// Where a data input gets its value.
#[derive(Clone, Debug, PartialEq)]
pub enum Src {
    Const(Value),
    SelfEntity,
    /// Output `out` of node index `node`.
    Out { node: u32, out: u32 },
}

#[derive(Clone, Debug)]
pub struct CNode {
    pub id: u32,
    pub kind: NodeKind,
    pub exec: bool,
    pub in_names: Vec<String>,
    pub in_tys: Vec<Ty>,
    pub inputs: Vec<Src>,
    /// Per exec output: target node index or [`NONE`].
    pub flow_out: Vec<u32>,
    pub out_tys: Vec<Ty>,
    /// First slot of this node's outputs.
    pub out_base: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Trigger {
    Start,
    Tick,
    OverlapEnter,
    OverlapExit,
    Action(String),
    Message(String),
    Timer,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimerDef {
    pub node: u32,
    pub secs: f32,
    pub repeat: bool,
}

/// A validated graph in the form the interpreter runs.
#[derive(Clone, Debug, Default)]
pub struct Compiled {
    pub name: String,
    pub nodes: Vec<CNode>,
    /// Event nodes by trigger (node indices).
    pub events: Vec<(Trigger, u32)>,
    pub timers: Vec<TimerDef>,
    pub warnings: Vec<GraphError>,
    pub slots: usize,
}

impl Compiled {
    pub fn index_of(&self, id: u32) -> Option<u32> {
        self.nodes.iter().position(|n| n.id == id).map(|i| i as u32)
    }
    pub fn has_tick(&self) -> bool {
        self.events.iter().any(|(t, _)| *t == Trigger::Tick)
    }
    /// Names of the actions any `Action` event listens to.
    pub fn actions(&self) -> impl Iterator<Item = &str> {
        self.events.iter().filter_map(|(t, _)| if let Trigger::Action(a) = t { Some(a.as_str()) } else { None })
    }
}

fn err(node: Option<u32>, pin: Option<&str>, message: impl Into<String>) -> GraphError {
    GraphError { severity: Severity::Error, node, pin: pin.map(String::from), message: message.into() }
}

impl crate::Graph {
    /// Checks the graph and builds its runnable form. Returns every error found.
    pub fn compile(&self) -> Result<Compiled, Vec<GraphError>> {
        let mut errors: Vec<GraphError> = Vec::new();
        let mut warnings: Vec<GraphError> = Vec::new();

        // Ids and pin tables.
        let mut index: HashMap<u32, usize> = HashMap::new();
        for (i, n) in self.nodes.iter().enumerate() {
            if index.insert(n.id, i).is_some() {
                errors.push(err(Some(n.id), None, "duplicate node id"));
            }
            if let NodeKind::Sequence { n: count } = n.kind {
                if count == 0 || count > 16 {
                    errors.push(err(Some(n.id), None, "Sequence needs 1..=16 outputs"));
                }
            }
        }
        let specs: Vec<PinSpec> = self.nodes.iter().map(|n| pins(&n.kind)).collect();

        // Flow links.
        let mut flow_out: Vec<Vec<u32>> = specs.iter().map(|s| vec![NONE; s.exec_out.len()]).collect();
        let mut has_flow_in = vec![false; self.nodes.len()];
        for l in &self.flow {
            let (Some(&a), Some(&b)) = (index.get(&l.from.0), index.get(&l.to.0)) else {
                let missing = if index.contains_key(&l.from.0) { l.to.0 } else { l.from.0 };
                errors.push(err(Some(missing), None, "flow link names a node that doesn't exist"));
                continue;
            };
            let Some(oi) = specs[a].exec_out.iter().position(|p| *p == l.from.1) else {
                errors.push(err(Some(l.from.0), Some(&l.from.1), format!("{} has no exec output `{}`", kind_name(&self.nodes[a].kind), l.from.1)));
                continue;
            };
            if !specs[b].exec_in {
                errors.push(err(Some(l.to.0), Some(&l.to.1), format!("{} has no exec input (events start flows; data nodes don't run)", kind_name(&self.nodes[b].kind))));
                continue;
            }
            if flow_out[a][oi] != NONE {
                errors.push(err(Some(l.from.0), Some(&l.from.1), "exec output is linked twice (use a Sequence to run several things)"));
                continue;
            }
            flow_out[a][oi] = b as u32;
            has_flow_in[b] = true;
        }

        // Data links.
        let mut inputs: Vec<Vec<Option<Src>>> = specs.iter().map(|s| vec![None; s.data_in.len()]).collect();
        let mut out_base = Vec::with_capacity(self.nodes.len());
        let mut slots = 0usize;
        for s in &specs {
            out_base.push(slots);
            slots += s.data_out.len();
        }
        let mut deps: Vec<(usize, usize)> = Vec::new(); // (from node, to node)
        for l in &self.data {
            let (Some(&a), Some(&b)) = (index.get(&l.from.0), index.get(&l.to.0)) else {
                let missing = if index.contains_key(&l.from.0) { l.to.0 } else { l.from.0 };
                errors.push(err(Some(missing), None, "data link names a node that doesn't exist"));
                continue;
            };
            let Some(oi) = specs[a].data_out.iter().position(|p| p.0 == l.from.1) else {
                errors.push(err(Some(l.from.0), Some(&l.from.1), format!("{} has no data output `{}`", kind_name(&self.nodes[a].kind), l.from.1)));
                continue;
            };
            let Some(ii) = specs[b].data_in.iter().position(|p| p.name == l.to.1) else {
                errors.push(err(Some(l.to.0), Some(&l.to.1), format!("{} has no data input `{}`", kind_name(&self.nodes[b].kind), l.to.1)));
                continue;
            };
            let (from_ty, to_ty) = (specs[a].data_out[oi].1, specs[b].data_in[ii].ty);
            if !from_ty.feeds(to_ty) {
                errors.push(err(Some(l.to.0), Some(&l.to.1), format!("type mismatch: {:?} output of node {} can't feed a {:?} input", from_ty, l.from.0, to_ty)));
                continue;
            }
            if inputs[b][ii].is_some() {
                errors.push(err(Some(l.to.0), Some(&l.to.1), "data input is linked twice"));
                continue;
            }
            inputs[b][ii] = Some(Src::Out { node: a as u32, out: oi as u32 });
            deps.push((a, b));
        }

        // Defaults and required inputs.
        for (i, n) in self.nodes.iter().enumerate() {
            for (pin, v) in &n.defaults {
                match specs[i].data_in.iter().position(|p| p.name == *pin) {
                    None => errors.push(err(Some(n.id), Some(pin), "default for a pin that doesn't exist")),
                    Some(ii) => {
                        if let Err(e) = v.coerce(specs[i].data_in[ii].ty) {
                            errors.push(err(Some(n.id), Some(pin), format!("default value: {e}")));
                        } else if inputs[i][ii].is_none() {
                            inputs[i][ii] = Some(Src::Const(v.clone()));
                        }
                    }
                }
            }
            for (ii, d) in specs[i].data_in.iter().enumerate() {
                if inputs[i][ii].is_none() {
                    match &d.default {
                        Dflt::Required => errors.push(err(Some(n.id), Some(&d.name), "required data input has nothing connected and no default")),
                        Dflt::Value(v) => inputs[i][ii] = Some(Src::Const(v.clone())),
                        Dflt::SelfEntity => inputs[i][ii] = Some(Src::SelfEntity),
                    }
                }
            }
            if specs[i].exec_in && !has_flow_in[i] {
                warnings.push(GraphError { severity: Severity::Warning, node: Some(n.id), pin: None, message: format!("{} is never reached (no exec link into it)", kind_name(&n.kind)) });
            }
        }

        // Data cycles and depth (Kahn's algorithm, longest path).
        let n = self.nodes.len();
        let mut indeg = vec![0usize; n];
        let mut adj: Vec<Vec<usize>> = vec![vec![]; n];
        for &(a, b) in &deps {
            adj[a].push(b);
            indeg[b] += 1;
        }
        let mut depth = vec![0usize; n];
        let mut queue: Vec<usize> = (0..n).filter(|&i| indeg[i] == 0).collect();
        let mut seen = 0usize;
        while let Some(a) = queue.pop() {
            seen += 1;
            for &b in &adj[a] {
                depth[b] = depth[b].max(depth[a] + 1);
                indeg[b] -= 1;
                if indeg[b] == 0 {
                    queue.push(b);
                }
            }
        }
        if seen < n {
            let culprit = (0..n).find(|&i| indeg[i] > 0).map(|i| self.nodes[i].id);
            errors.push(err(culprit, None, "data links form a cycle"));
        } else if let Some((i, d)) = depth.iter().enumerate().max_by_key(|(_, d)| **d) {
            if *d > MAX_DATA_DEPTH {
                errors.push(err(Some(self.nodes[i].id), None, format!("data chain is {d} nodes deep (limit {MAX_DATA_DEPTH})")));
            }
        }

        if !errors.is_empty() {
            return Err(errors);
        }

        let mut c = Compiled { name: self.name.clone(), warnings, slots, ..Default::default() };
        for (i, node) in self.nodes.iter().enumerate() {
            let spec = &specs[i];
            c.nodes.push(CNode {
                id: node.id,
                kind: node.kind.clone(),
                exec: spec.exec_in,
                in_names: spec.data_in.iter().map(|d| d.name.clone()).collect(),
                in_tys: spec.data_in.iter().map(|d| d.ty).collect(),
                inputs: inputs[i].iter().map(|s| s.clone().unwrap_or(Src::Const(Value::Null))).collect(),
                flow_out: std::mem::take(&mut flow_out[i]),
                out_tys: spec.data_out.iter().map(|d| d.1).collect(),
                out_base: out_base[i],
            });
            let ev = match &node.kind {
                NodeKind::Start => Some(Trigger::Start),
                NodeKind::Tick => Some(Trigger::Tick),
                NodeKind::OverlapEnter => Some(Trigger::OverlapEnter),
                NodeKind::OverlapExit => Some(Trigger::OverlapExit),
                NodeKind::Action(a) => Some(Trigger::Action(a.clone())),
                NodeKind::Message(m) => Some(Trigger::Message(m.clone())),
                NodeKind::Timer { secs, repeat } => {
                    c.timers.push(TimerDef { node: i as u32, secs: *secs, repeat: *repeat });
                    Some(Trigger::Timer)
                }
                _ => None,
            };
            if let Some(t) = ev {
                c.events.push((t, i as u32));
            }
        }
        Ok(c)
    }
}
