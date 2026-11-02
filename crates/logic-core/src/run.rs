//! The interpreter: runs one event through a [`Compiled`] graph.
//!
//! Flow executes with an explicit stack (no recursion over exec links). Data pins are
//! evaluated lazily when a node reads them, and cached until the next side effect. Depth of
//! data recursion is bounded by validation ([`crate::compile::MAX_DATA_DEPTH`]). A step budget
//! stops runaway loops. After the first run on a graph the runner allocates nothing for
//! numeric/boolean/vec3 graphs.

use std::sync::Arc;

use crate::compile::{CNode, Compiled, NONE, Src};
use crate::graph::{CmpOp, MathOp, NodeKind};
use crate::value::Value;

/// What happened, as events deliver it to data pins of event nodes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Payload {
    /// The entity carrying the graph.
    pub me: u64,
    /// `other` pin of overlap events.
    pub other: Value,
    /// `value` pin of `Action` / `Message` events.
    pub value: Value,
    /// `dt` pin of `Tick`.
    pub dt: f64,
}

/// Side effects and world access. The engine implements this over the ECS; tests over a map.
pub trait Host {
    fn get(&mut self, entity: u64, path: &str) -> Result<Value, String>;
    fn set(&mut self, entity: u64, path: &str, value: &Value) -> Result<(), String>;
    fn command(&mut self, id: &str, params: &serde_json::Value) -> Result<serde_json::Value, String>;
    fn script(&mut self, file: &str, function: &str, args: &[Value]) -> Result<Value, String>;
    fn emit(&mut self, name: &str, value: &Value);
    fn log(&mut self, text: &str);
    /// Run the flow after `Delay` node index `node` again in `secs`, with `payload`.
    fn schedule(&mut self, node: u32, secs: f32, payload: &Payload);
}

/// A runtime failure, located at a node id.
#[derive(Clone, Debug, PartialEq)]
pub struct RunError {
    pub node: u32,
    pub message: String,
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "node {}: {}", self.node, self.message)
    }
}

/// Where a run starts.
#[derive(Clone, Copy, Debug)]
pub enum Entry {
    /// An event node (index).
    Event(u32),
    /// After a `Delay` node (index) fired.
    Resume(u32),
}

enum Work {
    Exec(u32),
    Seq { node: u32, next: u8 },
    Each { node: u32, list: Arc<serde_json::Value>, i: usize },
}

/// Reusable interpreter state (scratch buffers). One per thread/graph user.
pub struct Runner {
    pub budget: u32,
    /// Nodes executed + data nodes evaluated in the last run.
    pub steps: u32,
    stack: Vec<Work>,
    cache: Vec<Value>,
    cache_epoch: Vec<u32>,
    persist: Vec<Value>,
    persist_run: Vec<u32>,
    epoch: u32,
    run_id: u32,
}

impl Default for Runner {
    fn default() -> Self {
        Runner { budget: 10_000, steps: 0, stack: Vec::new(), cache: Vec::new(), cache_epoch: Vec::new(), persist: Vec::new(), persist_run: Vec::new(), epoch: 1, run_id: 0 }
    }
}

struct Ctx<'a, H: Host> {
    g: &'a Compiled,
    host: &'a mut H,
    payload: &'a Payload,
}

fn fail<T>(g: &Compiled, node: u32, msg: impl Into<String>) -> Result<T, RunError> {
    Err(RunError { node: g.nodes[node as usize].id, message: msg.into() })
}

impl Runner {
    pub fn new() -> Runner {
        Runner::default()
    }

    fn prepare(&mut self, g: &Compiled) {
        if self.cache.len() != g.slots {
            self.cache = vec![Value::Null; g.slots];
            self.cache_epoch = vec![0; g.slots];
            self.persist = vec![Value::Null; g.slots];
            self.persist_run = vec![0; g.slots];
        }
    }

    /// Runs the flow that starts at `entry`. Stops at the first error.
    pub fn run<H: Host>(&mut self, g: &Compiled, entry: Entry, payload: &Payload, host: &mut H) -> Result<(), RunError> {
        self.prepare(g);
        self.run_id = self.run_id.wrapping_add(1).max(1);
        self.epoch = self.epoch.wrapping_add(1).max(1);
        self.steps = 0;
        self.stack.clear();
        let node = match entry {
            Entry::Event(n) | Entry::Resume(n) => n,
        };
        if node as usize >= g.nodes.len() {
            return Err(RunError { node: 0, message: "no such node".into() });
        }
        let mut cx = Ctx { g, host, payload };
        self.follow(g, node, 0);
        while let Some(w) = self.stack.pop() {
            match w {
                Work::Exec(n) => self.exec(&mut cx, n)?,
                Work::Seq { node, next } => {
                    let outs = g.nodes[node as usize].flow_out.len() as u8;
                    if next + 1 < outs {
                        self.stack.push(Work::Seq { node, next: next + 1 });
                    }
                    self.follow(g, node, next as usize);
                }
                Work::Each { node, list, i } => {
                    let items = list.as_array().map_or(&[][..], |a| a.as_slice());
                    if i < items.len() {
                        let base = g.nodes[node as usize].out_base;
                        self.persist[base] = Value::from_json(&items[i]);
                        self.persist[base + 1] = Value::Num(i as f64);
                        self.persist_run[base] = self.run_id;
                        self.persist_run[base + 1] = self.run_id;
                        self.effect();
                        self.stack.push(Work::Each { node, list: list.clone(), i: i + 1 });
                        self.follow(g, node, 0);
                    } else {
                        self.follow(g, node, 1);
                    }
                }
            }
        }
        Ok(())
    }

    fn follow(&mut self, g: &Compiled, node: u32, out: usize) {
        if let Some(&t) = g.nodes[node as usize].flow_out.get(out) {
            if t != NONE {
                self.stack.push(Work::Exec(t));
            }
        }
    }

    fn tick<H: Host>(&mut self, cx: &Ctx<H>, node: u32) -> Result<(), RunError> {
        self.steps += 1;
        if self.steps > self.budget {
            return fail(cx.g, node, format!("step budget of {} exceeded (infinite loop?)", self.budget));
        }
        Ok(())
    }

    fn effect(&mut self) {
        self.epoch = self.epoch.wrapping_add(1).max(1);
    }

    fn exec<H: Host>(&mut self, cx: &mut Ctx<H>, ni: u32) -> Result<(), RunError> {
        self.tick(cx, ni)?;
        let g = cx.g;
        let node = &g.nodes[ni as usize];
        match &node.kind {
            NodeKind::Branch => {
                let c = self.input(cx, ni, 0)?;
                self.follow(g, ni, if matches!(c, Value::Bool(true)) { 0 } else { 1 });
            }
            NodeKind::Sequence { .. } => self.stack.push(Work::Seq { node: ni, next: 0 }),
            NodeKind::Delay { secs } => {
                cx.host.schedule(ni, *secs, cx.payload);
            }
            NodeKind::ForEach => {
                let list = self.input(cx, ni, 0)?;
                let Value::Json(j) = list else { return fail(g, ni, "list must be a json array") };
                if !j.is_array() {
                    return fail(g, ni, "list must be a json array");
                }
                self.stack.push(Work::Each { node: ni, list: j, i: 0 });
            }
            NodeKind::Set { path } => {
                let e = self.entity_input(cx, ni, 0)?;
                let v = self.input(cx, ni, 1)?;
                cx.host.set(e, path, &v).map_err(|m| RunError { node: node.id, message: m })?;
                self.effect();
                self.follow(g, ni, 0);
            }
            NodeKind::Command { id, params } => {
                let mut p = params.clone();
                for (k, name) in node.in_names.iter().enumerate() {
                    let v = self.input(cx, ni, k)?;
                    substitute(&mut p, name, &v.to_json());
                }
                let r = cx.host.command(id, &p).map_err(|m| RunError { node: node.id, message: format!("command `{id}`: {m}") })?;
                self.store(g, ni, 0, Value::from_json(&r));
                self.effect();
                self.follow(g, ni, 0);
            }
            NodeKind::Script { file, function, args } => {
                let mut vals: Vec<Value> = Vec::with_capacity(args.len());
                for k in 0..args.len() {
                    vals.push(self.input(cx, ni, k)?);
                }
                let r = cx.host.script(file, function, &vals).map_err(|m| RunError { node: node.id, message: format!("script {file}:{function}: {m}") })?;
                self.store(g, ni, 0, r);
                self.effect();
                self.follow(g, ni, 0);
            }
            NodeKind::Emit(name) => {
                let v = self.input(cx, ni, 0)?;
                cx.host.emit(name, &v);
                self.effect();
                self.follow(g, ni, 0);
            }
            NodeKind::Log => {
                let v = self.input(cx, ni, 0)?;
                cx.host.log(&v.display());
                self.follow(g, ni, 0);
            }
            _ => self.follow(g, ni, 0), // Delay-like pass-through for anything exec without effect
        }
        Ok(())
    }

    fn store(&mut self, g: &Compiled, ni: u32, out: usize, v: Value) {
        let slot = g.nodes[ni as usize].out_base + out;
        self.persist[slot] = v;
        self.persist_run[slot] = self.run_id;
    }

    fn entity_input<H: Host>(&mut self, cx: &mut Ctx<H>, ni: u32, k: usize) -> Result<u64, RunError> {
        match self.input(cx, ni, k)? {
            Value::Entity(e) => Ok(e),
            _ => fail(cx.g, ni, format!("`{}` is not an entity (no entity?)", cx.g.nodes[ni as usize].in_names[k])),
        }
    }

    /// Input pin `k` of node `ni`, converted to the pin's type.
    fn input<H: Host>(&mut self, cx: &mut Ctx<H>, ni: u32, k: usize) -> Result<Value, RunError> {
        let node = &cx.g.nodes[ni as usize];
        let raw = match &node.inputs[k] {
            Src::Const(v) => v.clone(),
            Src::SelfEntity => Value::Entity(cx.payload.me),
            Src::Out { node: src, out } => self.output(cx, *src, *out as usize)?,
        };
        raw.coerce(node.in_tys[k]).map_err(|m| RunError { node: node.id, message: format!("input `{}`: {m}", node.in_names[k]) })
    }

    /// Output `out` of node `ni`: event payload, exec-node result, or pure computation (cached).
    fn output<H: Host>(&mut self, cx: &mut Ctx<H>, ni: u32, out: usize) -> Result<Value, RunError> {
        let g = cx.g;
        let node = &g.nodes[ni as usize];
        let slot = node.out_base + out;
        if node.exec {
            if self.persist_run[slot] == self.run_id {
                return Ok(self.persist[slot].clone());
            }
            return fail(g, ni, "its output is read before it ran in this event (data from exec nodes doesn't survive a Delay)");
        }
        match &node.kind {
            NodeKind::Start | NodeKind::OverlapEnter | NodeKind::OverlapExit | NodeKind::Tick | NodeKind::Action(_) | NodeKind::Timer { .. } | NodeKind::Message(_) => {
                return Ok(match (out, &node.kind) {
                    (0, _) => Value::Entity(cx.payload.me),
                    (_, NodeKind::Tick) => Value::Num(cx.payload.dt),
                    (_, NodeKind::OverlapEnter | NodeKind::OverlapExit) => cx.payload.other.clone(),
                    _ => cx.payload.value.clone(),
                });
            }
            _ => {}
        }
        if self.cache_epoch[slot] == self.epoch {
            return Ok(self.cache[slot].clone());
        }
        self.tick(cx, ni)?;
        self.compute(cx, ni, node)?;
        Ok(self.cache[slot].clone())
    }

    fn put(&mut self, node: &CNode, out: usize, v: Value) {
        let slot = node.out_base + out;
        self.cache[slot] = v;
        self.cache_epoch[slot] = self.epoch;
    }

    fn num<H: Host>(&mut self, cx: &mut Ctx<H>, ni: u32, k: usize) -> Result<f64, RunError> {
        match self.input(cx, ni, k)? {
            Value::Num(n) => Ok(n),
            _ => fail(cx.g, ni, "expected a number"),
        }
    }

    fn compute<H: Host>(&mut self, cx: &mut Ctx<H>, ni: u32, node: &CNode) -> Result<(), RunError> {
        match &node.kind {
            NodeKind::Const(v) => self.put(node, 0, v.clone()),
            NodeKind::Get { path } => {
                let e = self.entity_input(cx, ni, 0)?;
                let v = cx.host.get(e, path).map_err(|m| RunError { node: node.id, message: m })?;
                self.put(node, 0, v);
            }
            NodeKind::Math(op) => {
                let (a, b) = (self.num(cx, ni, 0)?, self.num(cx, ni, 1)?);
                let r = match op {
                    MathOp::Add => a + b,
                    MathOp::Sub => a - b,
                    MathOp::Mul => a * b,
                    MathOp::Div if b == 0.0 => return fail(cx.g, ni, "division by zero"),
                    MathOp::Div => a / b,
                    MathOp::Min => a.min(b),
                    MathOp::Max => a.max(b),
                };
                self.put(node, 0, Value::Num(r));
            }
            NodeKind::Clamp => {
                let (v, lo, hi) = (self.num(cx, ni, 0)?, self.num(cx, ni, 1)?, self.num(cx, ni, 2)?);
                self.put(node, 0, Value::Num(v.max(lo).min(hi.max(lo))));
            }
            NodeKind::Compare(op) => {
                let (a, b) = (self.input(cx, ni, 0)?, self.input(cx, ni, 1)?);
                let r = compare(*op, &a, &b).map_err(|m| RunError { node: node.id, message: m })?;
                self.put(node, 0, Value::Bool(r));
            }
            NodeKind::And | NodeKind::Or => {
                let (a, b) = (self.input(cx, ni, 0)?, self.input(cx, ni, 1)?);
                let (Value::Bool(a), Value::Bool(b)) = (a, b) else { return fail(cx.g, ni, "expected bools") };
                self.put(node, 0, Value::Bool(if matches!(node.kind, NodeKind::And) { a && b } else { a || b }));
            }
            NodeKind::Not => {
                let Value::Bool(a) = self.input(cx, ni, 0)? else { return fail(cx.g, ni, "expected a bool") };
                self.put(node, 0, Value::Bool(!a));
            }
            NodeKind::Vec3Make => {
                let (x, y, z) = (self.num(cx, ni, 0)?, self.num(cx, ni, 1)?, self.num(cx, ni, 2)?);
                self.put(node, 0, Value::Vec3([x as f32, y as f32, z as f32]));
            }
            NodeKind::Vec3Split => {
                let Value::Vec3(v) = self.input(cx, ni, 0)? else { return fail(cx.g, ni, "expected a vec3") };
                for (i, c) in v.iter().enumerate() {
                    self.put(node, i, Value::Num(*c as f64));
                }
            }
            NodeKind::Vec3Add => {
                let (Value::Vec3(a), Value::Vec3(b)) = (self.input(cx, ni, 0)?, self.input(cx, ni, 1)?) else { return fail(cx.g, ni, "expected vec3s") };
                self.put(node, 0, Value::Vec3([a[0] + b[0], a[1] + b[1], a[2] + b[2]]));
            }
            NodeKind::Vec3Scale => {
                let Value::Vec3(a) = self.input(cx, ni, 0)? else { return fail(cx.g, ni, "expected a vec3") };
                let s = self.num(cx, ni, 1)? as f32;
                self.put(node, 0, Value::Vec3([a[0] * s, a[1] * s, a[2] * s]));
            }
            other => return fail(cx.g, ni, format!("{other:?} has no data output")),
        }
        Ok(())
    }
}

fn compare(op: CmpOp, a: &Value, b: &Value) -> Result<bool, String> {
    use std::cmp::Ordering;
    let ord: Option<Ordering> = match (a, b) {
        (Value::Num(x), Value::Num(y)) => x.partial_cmp(y),
        (Value::Str(x), Value::Str(y)) => Some(x.cmp(y)),
        (Value::Bool(x), Value::Bool(y)) => Some(x.cmp(y)),
        _ => None,
    };
    match op {
        CmpOp::Eq => Ok(a == b),
        CmpOp::Ne => Ok(a != b),
        _ => {
            let o = ord.ok_or_else(|| format!("can't order {} and {}", a.kind_name(), b.kind_name()))?;
            Ok(match op {
                CmpOp::Lt => o == Ordering::Less,
                CmpOp::Le => o != Ordering::Greater,
                CmpOp::Gt => o == Ordering::Greater,
                _ => o != Ordering::Less,
            })
        }
    }
}

/// Replaces every string equal to `"$name"` in `v` with `with`.
fn substitute(v: &mut serde_json::Value, name: &str, with: &serde_json::Value) {
    match v {
        serde_json::Value::String(s) if s.strip_prefix('$') == Some(name) => *v = with.clone(),
        serde_json::Value::Array(a) => a.iter_mut().for_each(|x| substitute(x, name, with)),
        serde_json::Value::Object(o) => o.values_mut().for_each(|x| substitute(x, name, with)),
        _ => {}
    }
}
