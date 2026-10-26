//! Behaviour trees as Rust values: composites, decorators and leaves whose conditions and
//! actions are closures over a [`BtCtx`] (world, entity, blackboard, time).
//!
//! ```ignore
//! let tree = BehaviorTree::new(Bt::selector("root", [
//!     Bt::sequence("attack", [
//!         Bt::condition("sees enemy", |c| c.bb.has("enemy")),
//!         Bt::action("shoot", |c| { /* ... */ BtStatus::Success }).cooldown(0.5),
//!     ]),
//!     Bt::action("patrol", patrol),
//! ]));
//! commands.spawn((BtAgent::new(tree), Blackboard::default()));
//! ```
//! Trees are immutable and shared (`Arc`); each [`BtAgent`] keeps its own small runtime array.
//! Ticking is deterministic: same world + blackboard → same result. [`BtAgent::to_json`] dumps
//! every node's last status for the `ai.bt` control command.

use std::borrow::Cow;
use std::sync::Arc;

use bevy::prelude::*;
use serde_json::{Value, json};

use super::blackboard::Blackboard;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum BtStatus {
    Success,
    Failure,
    Running,
}

/// What a leaf sees: the whole world (the ticking entity's [`BtAgent`] and [`Blackboard`] are
/// temporarily moved out, so use `bb` for the latter).
pub struct BtCtx<'a> {
    pub world: &'a mut World,
    pub entity: Entity,
    pub bb: &'a mut Blackboard,
    /// Seconds since this agent's previous tick.
    pub dt: f32,
    /// Game time (virtual seconds).
    pub now: f64,
}

pub type ActionFn = Arc<dyn Fn(&mut BtCtx) -> BtStatus + Send + Sync>;
pub type CondFn = Arc<dyn Fn(&BtCtx) -> bool + Send + Sync>;
pub type ScoreFn = Arc<dyn Fn(&BtCtx) -> f32 + Send + Sync>;

/// Tree builder.
pub enum Bt {
    Sequence { name: Cow<'static, str>, reactive: bool, children: Vec<Bt> },
    Selector { name: Cow<'static, str>, reactive: bool, children: Vec<Bt> },
    Parallel { name: Cow<'static, str>, success: usize, failure: usize, children: Vec<Bt> },
    Utility { name: Cow<'static, str>, hysteresis: f32, children: Vec<(ScoreFn, Bt)> },
    Decorator { name: Cow<'static, str>, kind: Deco, child: Box<Bt> },
    Condition { name: Cow<'static, str>, f: CondFn },
    Action { name: Cow<'static, str>, f: ActionFn },
    Wait { secs: f32 },
}

#[derive(Clone)]
pub enum Deco {
    Invert,
    Succeed,
    Fail,
    /// Repeat on success (`None` = forever); one iteration per tick.
    Repeat(Option<u32>),
    /// Retry on failure up to n times.
    Retry(u32),
    Timeout(f32),
    Cooldown(f32),
    /// Runs the child only while the condition holds (re-checked every tick; aborts the child).
    Guard(CondFn),
}

impl Bt {
    pub fn sequence(name: impl Into<Cow<'static, str>>, children: impl IntoIterator<Item = Bt>) -> Bt {
        Bt::Sequence { name: name.into(), reactive: false, children: children.into_iter().collect() }
    }
    /// Re-evaluates earlier children every tick (aborts a running later child when one fails).
    pub fn reactive_sequence(name: impl Into<Cow<'static, str>>, children: impl IntoIterator<Item = Bt>) -> Bt {
        Bt::Sequence { name: name.into(), reactive: true, children: children.into_iter().collect() }
    }
    pub fn selector(name: impl Into<Cow<'static, str>>, children: impl IntoIterator<Item = Bt>) -> Bt {
        Bt::Selector { name: name.into(), reactive: false, children: children.into_iter().collect() }
    }
    /// Re-tries higher-priority children every tick (preempts a running lower one).
    pub fn reactive_selector(name: impl Into<Cow<'static, str>>, children: impl IntoIterator<Item = Bt>) -> Bt {
        Bt::Selector { name: name.into(), reactive: true, children: children.into_iter().collect() }
    }
    /// Ticks all children; succeeds when `success` of them succeeded, fails when `failure` failed.
    pub fn parallel(name: impl Into<Cow<'static, str>>, success: usize, failure: usize, children: impl IntoIterator<Item = Bt>) -> Bt {
        Bt::Parallel { name: name.into(), success, failure, children: children.into_iter().collect() }
    }
    /// Runs the highest-scoring child (re-scored every tick; switches only when another child
    /// beats the running one by `hysteresis`).
    pub fn utility(name: impl Into<Cow<'static, str>>, hysteresis: f32, children: impl IntoIterator<Item = (ScoreFn, Bt)>) -> Bt {
        Bt::Utility { name: name.into(), hysteresis, children: children.into_iter().collect() }
    }
    pub fn condition(name: impl Into<Cow<'static, str>>, f: impl Fn(&BtCtx) -> bool + Send + Sync + 'static) -> Bt {
        Bt::Condition { name: name.into(), f: Arc::new(f) }
    }
    pub fn action(name: impl Into<Cow<'static, str>>, f: impl Fn(&mut BtCtx) -> BtStatus + Send + Sync + 'static) -> Bt {
        Bt::Action { name: name.into(), f: Arc::new(f) }
    }
    pub fn wait(secs: f32) -> Bt {
        Bt::Wait { secs }
    }
    pub fn guard(name: impl Into<Cow<'static, str>>, cond: impl Fn(&BtCtx) -> bool + Send + Sync + 'static, child: Bt) -> Bt {
        Bt::Decorator { name: name.into(), kind: Deco::Guard(Arc::new(cond)), child: Box::new(child) }
    }
    fn deco(self, name: &'static str, kind: Deco) -> Bt {
        Bt::Decorator { name: Cow::Borrowed(name), kind, child: Box::new(self) }
    }
    pub fn invert(self) -> Bt {
        self.deco("invert", Deco::Invert)
    }
    pub fn succeed(self) -> Bt {
        self.deco("succeed", Deco::Succeed)
    }
    pub fn fail(self) -> Bt {
        self.deco("fail", Deco::Fail)
    }
    pub fn repeat(self, n: u32) -> Bt {
        self.deco("repeat", Deco::Repeat(Some(n)))
    }
    pub fn forever(self) -> Bt {
        self.deco("forever", Deco::Repeat(None))
    }
    pub fn retry(self, n: u32) -> Bt {
        self.deco("retry", Deco::Retry(n))
    }
    pub fn timeout(self, secs: f32) -> Bt {
        self.deco("timeout", Deco::Timeout(secs))
    }
    pub fn cooldown(self, secs: f32) -> Bt {
        self.deco("cooldown", Deco::Cooldown(secs))
    }
}

enum Kind {
    Sequence { reactive: bool },
    Selector { reactive: bool },
    Parallel { success: usize, failure: usize },
    Utility { hysteresis: f32, scores: Vec<ScoreFn> },
    Deco(Deco),
    Condition(CondFn),
    Action(ActionFn),
    Wait(f32),
}

impl Kind {
    fn label(&self) -> &'static str {
        match self {
            Kind::Sequence { reactive: false } => "sequence",
            Kind::Sequence { reactive: true } => "reactive_sequence",
            Kind::Selector { reactive: false } => "selector",
            Kind::Selector { reactive: true } => "reactive_selector",
            Kind::Parallel { .. } => "parallel",
            Kind::Utility { .. } => "utility",
            Kind::Deco(d) => match d {
                Deco::Invert => "invert",
                Deco::Succeed => "succeed",
                Deco::Fail => "fail",
                Deco::Repeat(_) => "repeat",
                Deco::Retry(_) => "retry",
                Deco::Timeout(_) => "timeout",
                Deco::Cooldown(_) => "cooldown",
                Deco::Guard(_) => "guard",
            },
            Kind::Condition(_) => "condition",
            Kind::Action(_) => "action",
            Kind::Wait(_) => "wait",
        }
    }
}

struct Node {
    name: Cow<'static, str>,
    kind: Kind,
    children: std::ops::Range<u32>,
}

/// An immutable, flattened tree (share it between agents with `Arc`).
pub struct BehaviorTree {
    nodes: Vec<Node>,
    child_ids: Vec<u32>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NodeRt {
    pub status: Option<BtStatus>,
    pub running: bool,
    /// Parallel: this child already finished in the current run.
    done: bool,
    cursor: u32,
    count: u32,
    t0: f64,
    pub last_tick: u64,
    pub score: f32,
}

impl BehaviorTree {
    pub fn new(root: Bt) -> Arc<BehaviorTree> {
        let mut t = BehaviorTree { nodes: Vec::new(), child_ids: Vec::new() };
        t.add(root);
        Arc::new(t)
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    fn add(&mut self, b: Bt) -> u32 {
        let id = self.nodes.len() as u32;
        let (name, kind, kids): (Cow<'static, str>, Kind, Vec<Bt>) = match b {
            Bt::Sequence { name, reactive, children } => (name, Kind::Sequence { reactive }, children),
            Bt::Selector { name, reactive, children } => (name, Kind::Selector { reactive }, children),
            Bt::Parallel { name, success, failure, children } => {
                let n = children.len();
                (name, Kind::Parallel { success: success.clamp(1, n.max(1)), failure: failure.clamp(1, n.max(1)) }, children)
            }
            Bt::Utility { name, hysteresis, children } => {
                let (scores, kids): (Vec<ScoreFn>, Vec<Bt>) = children.into_iter().unzip();
                (name, Kind::Utility { hysteresis, scores }, kids)
            }
            Bt::Decorator { name, kind, child } => (name, Kind::Deco(kind), vec![*child]),
            Bt::Condition { name, f } => (name, Kind::Condition(f), vec![]),
            Bt::Action { name, f } => (name, Kind::Action(f), vec![]),
            Bt::Wait { secs } => (Cow::Borrowed("wait"), Kind::Wait(secs), vec![]),
        };
        self.nodes.push(Node { name, kind, children: 0..0 });
        let ids: Vec<u32> = kids.into_iter().map(|k| self.add(k)).collect();
        let start = self.child_ids.len() as u32;
        self.child_ids.extend(ids);
        self.nodes[id as usize].children = start..self.child_ids.len() as u32;
        id
    }

    #[inline]
    fn child(&self, i: usize, k: u32) -> usize {
        self.child_ids[(self.nodes[i].children.start + k) as usize] as usize
    }

    #[inline]
    fn child_count(&self, i: usize) -> u32 {
        self.nodes[i].children.len() as u32
    }

    /// Resets a subtree's runtime state (abort).
    fn halt(&self, rt: &mut [NodeRt], i: usize) {
        let r = &mut rt[i];
        let was = r.running || r.done || r.cursor != 0 || r.count != 0;
        r.running = false;
        r.done = false;
        r.cursor = 0;
        r.count = 0;
        if !was && self.child_count(i) == 0 {
            return;
        }
        for k in 0..self.child_count(i) {
            let c = self.child(i, k);
            self.halt(rt, c);
        }
    }

    pub(crate) fn tick(&self, rt: &mut [NodeRt], i: usize, ctx: &mut BtCtx, tick: u64) -> BtStatus {
        rt[i].last_tick = tick;
        let n = self.child_count(i);
        let st = match &self.nodes[i].kind {
            Kind::Sequence { reactive } | Kind::Selector { reactive } => {
                let seq = matches!(self.nodes[i].kind, Kind::Sequence { .. });
                let (cont, stop) = if seq { (BtStatus::Success, BtStatus::Failure) } else { (BtStatus::Failure, BtStatus::Success) };
                let start = if *reactive { 0 } else { rt[i].cursor };
                let mut result = cont;
                for k in start..n {
                    let c = self.child(i, k);
                    let s = self.tick(rt, c, ctx, tick);
                    if s == BtStatus::Running {
                        // A reactive composite may have moved on from a later running child.
                        let prev = rt[i].cursor;
                        if *reactive && prev != k && prev < n {
                            let pc = self.child(i, prev);
                            if rt[pc].running {
                                self.halt(rt, pc);
                            }
                        }
                        rt[i].cursor = k;
                        result = BtStatus::Running;
                        break;
                    }
                    if s == stop {
                        let prev = rt[i].cursor;
                        if *reactive && prev > k && prev < n {
                            let pc = self.child(i, prev);
                            self.halt(rt, pc);
                        }
                        result = stop;
                        break;
                    }
                }
                if result != BtStatus::Running {
                    rt[i].cursor = 0;
                }
                result
            }
            Kind::Parallel { success, failure } => {
                let (mut ok, mut bad) = (0usize, 0usize);
                for k in 0..n {
                    let c = self.child(i, k);
                    let s = if rt[c].done {
                        rt[c].status.unwrap_or(BtStatus::Failure)
                    } else {
                        let s = self.tick(rt, c, ctx, tick);
                        if s != BtStatus::Running {
                            rt[c].done = true;
                        }
                        s
                    };
                    match s {
                        BtStatus::Success => ok += 1,
                        BtStatus::Failure => bad += 1,
                        BtStatus::Running => {}
                    }
                }
                let r = if ok >= *success {
                    BtStatus::Success
                } else if bad >= *failure || bad > n as usize - *success {
                    BtStatus::Failure
                } else {
                    BtStatus::Running
                };
                if r != BtStatus::Running {
                    for k in 0..n {
                        let c = self.child(i, k);
                        self.halt(rt, c);
                    }
                }
                r
            }
            Kind::Utility { hysteresis, scores } => {
                let mut best = u32::MAX;
                let mut best_s = f32::MIN;
                for k in 0..n {
                    let s = (scores[k as usize])(ctx);
                    let c = self.child(i, k);
                    rt[c].score = s;
                    if s > best_s {
                        best_s = s;
                        best = k;
                    }
                }
                let cur = rt[i].cursor;
                let running_cur = rt[i].running && cur < n;
                let pick = if running_cur {
                    let cs = rt[self.child(i, cur)].score;
                    if best != cur && best_s > cs + hysteresis {
                        let pc = self.child(i, cur);
                        self.halt(rt, pc);
                        best
                    } else {
                        cur
                    }
                } else {
                    best
                };
                if pick >= n {
                    BtStatus::Failure
                } else {
                    rt[i].cursor = pick;
                    let c = self.child(i, pick);
                    self.tick(rt, c, ctx, tick)
                }
            }
            Kind::Deco(d) => {
                let c = self.child(i, 0);
                match d {
                    Deco::Invert => match self.tick(rt, c, ctx, tick) {
                        BtStatus::Success => BtStatus::Failure,
                        BtStatus::Failure => BtStatus::Success,
                        BtStatus::Running => BtStatus::Running,
                    },
                    Deco::Succeed => match self.tick(rt, c, ctx, tick) {
                        BtStatus::Running => BtStatus::Running,
                        _ => BtStatus::Success,
                    },
                    Deco::Fail => match self.tick(rt, c, ctx, tick) {
                        BtStatus::Running => BtStatus::Running,
                        _ => BtStatus::Failure,
                    },
                    Deco::Repeat(limit) => match self.tick(rt, c, ctx, tick) {
                        BtStatus::Running => BtStatus::Running,
                        BtStatus::Failure => {
                            rt[i].count = 0;
                            BtStatus::Failure
                        }
                        BtStatus::Success => {
                            rt[i].count += 1;
                            if limit.is_some_and(|l| rt[i].count >= l) {
                                rt[i].count = 0;
                                BtStatus::Success
                            } else {
                                self.halt(rt, c);
                                BtStatus::Running
                            }
                        }
                    },
                    Deco::Retry(limit) => match self.tick(rt, c, ctx, tick) {
                        BtStatus::Running => BtStatus::Running,
                        BtStatus::Success => {
                            rt[i].count = 0;
                            BtStatus::Success
                        }
                        BtStatus::Failure => {
                            rt[i].count += 1;
                            if rt[i].count >= *limit {
                                rt[i].count = 0;
                                BtStatus::Failure
                            } else {
                                self.halt(rt, c);
                                BtStatus::Running
                            }
                        }
                    },
                    Deco::Timeout(secs) => {
                        if !rt[i].running {
                            rt[i].t0 = ctx.now;
                        }
                        if ctx.now - rt[i].t0 > *secs as f64 {
                            self.halt(rt, c);
                            BtStatus::Failure
                        } else {
                            self.tick(rt, c, ctx, tick)
                        }
                    }
                    Deco::Cooldown(secs) => {
                        if !rt[i].running && ctx.now < rt[i].t0 {
                            BtStatus::Failure
                        } else {
                            let s = self.tick(rt, c, ctx, tick);
                            if s != BtStatus::Running {
                                rt[i].t0 = ctx.now + *secs as f64;
                            }
                            s
                        }
                    }
                    Deco::Guard(cond) => {
                        if cond(ctx) {
                            self.tick(rt, c, ctx, tick)
                        } else {
                            if rt[c].running {
                                self.halt(rt, c);
                            }
                            BtStatus::Failure
                        }
                    }
                }
            }
            Kind::Condition(f) => {
                if f(ctx) {
                    BtStatus::Success
                } else {
                    BtStatus::Failure
                }
            }
            Kind::Action(f) => f(ctx),
            Kind::Wait(secs) => {
                if !rt[i].running {
                    rt[i].t0 = ctx.now;
                }
                if ctx.now - rt[i].t0 >= *secs as f64 { BtStatus::Success } else { BtStatus::Running }
            }
        };
        rt[i].running = st == BtStatus::Running;
        rt[i].status = Some(st);
        st
    }

    fn node_json(&self, rt: &[NodeRt], i: usize, tick: u64) -> Value {
        let n = &self.nodes[i];
        let r = rt.get(i).copied().unwrap_or_default();
        let mut v = json!({
            "id": i,
            "name": n.name,
            "kind": n.kind.label(),
            "status": r.status,
            "running": r.running,
            "ticked": r.last_tick == tick && tick > 0,
        });
        if matches!(n.kind, Kind::Utility { .. }) || r.score != 0.0 {
            v["score"] = json!(r.score);
        }
        let kids: Vec<Value> = (0..self.child_count(i)).map(|k| self.node_json(rt, self.child(i, k), tick)).collect();
        if !kids.is_empty() {
            v["children"] = Value::Array(kids);
        }
        v
    }
}

/// Runs a [`BehaviorTree`] on its entity (with the entity's [`Blackboard`]).
#[derive(Component, Clone)]
#[require(Blackboard)]
pub struct BtAgent {
    pub tree: Arc<BehaviorTree>,
    pub rt: Vec<NodeRt>,
    /// Seconds between ticks (0 = every frame). Agents are staggered over the interval.
    pub tick_interval: f32,
    pub enabled: bool,
    pub ticks: u64,
    pub last_status: Option<BtStatus>,
    pub(crate) next_tick: f64,
    pub(crate) last_time: Option<f64>,
}

impl BtAgent {
    pub fn new(tree: Arc<BehaviorTree>) -> Self {
        let n = tree.len();
        BtAgent { tree, rt: vec![NodeRt::default(); n], tick_interval: 0.0, enabled: true, ticks: 0, last_status: None, next_tick: f64::MIN, last_time: None }
    }

    fn clone_shallow(&self) -> BtAgent {
        BtAgent {
            tree: self.tree.clone(),
            rt: Vec::new(),
            tick_interval: self.tick_interval,
            enabled: self.enabled,
            ticks: self.ticks,
            last_status: self.last_status,
            next_tick: self.next_tick,
            last_time: self.last_time,
        }
    }

    pub fn with_interval(mut self, secs: f32) -> Self {
        self.tick_interval = secs;
        self
    }

    /// Names of the running nodes from the root down (the "current state").
    pub fn active_path(&self) -> Vec<&str> {
        let mut out = Vec::new();
        let t = &self.tree;
        let mut i = 0usize;
        while i < t.nodes.len() && self.rt.get(i).is_some_and(|r| r.running) {
            out.push(t.nodes[i].name.as_ref());
            let mut next = None;
            for k in 0..t.child_count(i) {
                let c = t.child(i, k);
                if self.rt[c].running {
                    next = Some(c);
                    break;
                }
            }
            match next {
                Some(c) => i = c,
                None => break,
            }
        }
        out
    }

    /// The whole tree with each node's last status, `running`, `ticked` (this tick) and scores.
    pub fn to_json(&self) -> Value {
        json!({
            "ticks": self.ticks,
            "status": self.last_status,
            "active": self.active_path(),
            "tree": self.tree.node_json(&self.rt, 0, self.ticks),
        })
    }

    /// Ticks once against `world` (the plugin calls this; tests may too).
    pub fn tick(&mut self, world: &mut World, entity: Entity, bb: &mut Blackboard, dt: f32, now: f64) -> BtStatus {
        if self.rt.len() != self.tree.len() {
            self.rt = vec![NodeRt::default(); self.tree.len()];
        }
        self.ticks += 1;
        let mut ctx = BtCtx { world, entity, bb, dt, now };
        let s = self.tree.tick(&mut self.rt, 0, &mut ctx, self.ticks);
        self.last_status = Some(s);
        s
    }
}

/// Exclusive system: ticks every due [`BtAgent`] (and evaluates [`super::utility::UtilityAi`]).
pub(crate) fn tick_agents(world: &mut World, mut list: Local<Vec<Entity>>) {
    let t0 = std::time::Instant::now();
    let now = world.resource::<Time>().elapsed_secs_f64();
    if world.resource::<Time>().delta_secs() <= 0.0 {
        return;
    }
    super::utility::evaluate_all(world, now);
    list.clear();
    let mut q = world.query_filtered::<Entity, With<BtAgent>>();
    list.extend(q.iter(world));
    let mut ticked = 0u32;
    for &e in list.iter() {
        let Some(mut a) = world.get_mut::<BtAgent>(e) else { continue };
        if !a.enabled || now < a.next_tick {
            continue;
        }
        let stagger = if a.tick_interval > 0.0 && a.next_tick == f64::MIN {
            a.tick_interval as f64 * ((e.index_u32() % 16) as f64 / 16.0)
        } else {
            0.0
        };
        a.next_tick = now + a.tick_interval as f64 + stagger;
        let dt = a.last_time.map(|t| (now - t) as f32).unwrap_or(0.0);
        a.last_time = Some(now);
        // Move the agent out with a non-allocating placeholder while the tree runs.
        let mut agent = a.clone_shallow();
        std::mem::swap(&mut *a, &mut agent);
        let mut bb = world.get_mut::<Blackboard>(e).map(|mut b| std::mem::take(&mut *b)).unwrap_or_default();
        agent.tick(world, e, &mut bb, dt, now);
        ticked += 1;
        if let Ok(mut ent) = world.get_entity_mut(e) {
            if let Some(mut slot) = ent.get_mut::<BtAgent>() {
                *slot = agent;
            }
            if let Some(mut slot) = ent.get_mut::<Blackboard>() {
                *slot = bb;
            }
        }
    }
    let mut stats = world.resource_mut::<super::AiStats>();
    stats.bt_ticks = ticked;
    stats.think_us = t0.elapsed().as_micros() as u32;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(tree: &Arc<BehaviorTree>, world: &mut World, ticks: usize) -> (Vec<BtStatus>, Blackboard) {
        let e = world.spawn_empty().id();
        let mut a = BtAgent::new(tree.clone());
        let mut bb = Blackboard::default();
        let mut out = Vec::new();
        for i in 0..ticks {
            out.push(a.tick(world, e, &mut bb, 0.1, i as f64 * 0.1));
        }
        (out, bb)
    }

    fn counter(key: &'static str, result: BtStatus) -> Bt {
        Bt::action(key, move |c| {
            let n = c.bb.int(key).unwrap_or(0);
            c.bb.set(key, n + 1);
            result
        })
    }

    #[test]
    fn sequence_selector_and_memory() {
        let mut w = World::new();
        // Running action for 3 ticks, then success.
        let tree = BehaviorTree::new(Bt::sequence("s", [
            counter("a", BtStatus::Success),
            Bt::action("b", |c| {
                let n = c.bb.int("b").unwrap_or(0) + 1;
                c.bb.set("b", n);
                if n >= 3 { BtStatus::Success } else { BtStatus::Running }
            }),
            counter("c", BtStatus::Success),
        ]));
        let (st, bb) = run(&tree, &mut w, 3);
        assert_eq!(st, vec![BtStatus::Running, BtStatus::Running, BtStatus::Success]);
        // Memory sequence: "a" ran once, not every tick.
        assert_eq!((bb.int("a"), bb.int("b"), bb.int("c")), (Some(1), Some(3), Some(1)));

        let tree = BehaviorTree::new(Bt::selector("sel", [counter("x", BtStatus::Failure), counter("y", BtStatus::Success), counter("z", BtStatus::Success)]));
        let (st, bb) = run(&tree, &mut w, 2);
        assert_eq!(st, vec![BtStatus::Success; 2]);
        assert_eq!((bb.int("x"), bb.int("y"), bb.int("z")), (Some(2), Some(2), None));
    }

    #[test]
    fn reactive_selector_preempts() {
        let mut w = World::new();
        let tree = BehaviorTree::new(Bt::reactive_selector("root", [
            Bt::sequence("alert", [Bt::condition("threat", |c| c.bb.bool("threat")), counter("flee", BtStatus::Running)]),
            counter("patrol", BtStatus::Running),
        ]));
        let e = w.spawn_empty().id();
        let mut a = BtAgent::new(tree.clone());
        let mut bb = Blackboard::default();
        a.tick(&mut w, e, &mut bb, 0.1, 0.0);
        assert_eq!(a.active_path(), vec!["root", "patrol"]);
        bb.set("threat", true);
        a.tick(&mut w, e, &mut bb, 0.1, 0.1);
        assert_eq!(a.active_path(), vec!["root", "alert", "flee"]);
        assert!(!a.rt[a.tree.nodes.iter().position(|n| n.name == "patrol").unwrap()].running, "patrol halted");
        let j = a.to_json();
        assert_eq!(j["active"][2], "flee");
        assert_eq!(j["tree"]["children"][0]["status"], "Running");
    }

    #[test]
    fn decorators_and_parallel() {
        let mut w = World::new();
        let tree = BehaviorTree::new(Bt::sequence("s", [
            counter("r", BtStatus::Success).repeat(3),
            counter("f", BtStatus::Failure).retry(2).invert(),
            Bt::parallel("p", 2, 1, [Bt::wait(0.25), counter("q", BtStatus::Success)]),
        ]));
        // Ticks 1-3: repeat x3 (the 3rd tick moves on to retry: 1st failure). Tick 4: 2nd failure →
        // retry fails → invert succeeds → parallel starts (q done, wait running). Tick 7
        // (t = 0.6): the wait ends → parallel and sequence succeed.
        let (st, bb) = run(&tree, &mut w, 7);
        assert_eq!(bb.int("r"), Some(3));
        assert_eq!(bb.int("f"), Some(2));
        assert_eq!(bb.int("q"), Some(1), "parallel child that finished isn't re-ticked");
        assert_eq!(st[..6], [BtStatus::Running; 6]);
        assert_eq!(st[6], BtStatus::Success, "{st:?}");
        // Deterministic: a second run gives the same sequence.
        let (st2, bb2) = run(&tree, &mut w, 7);
        assert_eq!(st, st2);
        assert_eq!(bb, bb2);
    }

    #[test]
    fn cooldown_timeout_guard_utility() {
        let mut w = World::new();
        let tree = BehaviorTree::new(Bt::selector("root", [counter("shot", BtStatus::Success).cooldown(0.35), counter("idle", BtStatus::Success)]));
        let (_, bb) = run(&tree, &mut w, 10); // t = 0.0 .. 0.9
        assert_eq!(bb.int("shot"), Some(3), "t=0, 0.4, 0.8");
        let tree = BehaviorTree::new(Bt::selector("root", [Bt::wait(10.0).timeout(0.25), counter("after", BtStatus::Success)]));
        let (st, _) = run(&tree, &mut w, 4);
        assert_eq!(st, vec![BtStatus::Running, BtStatus::Running, BtStatus::Running, BtStatus::Success]);
        let tree = BehaviorTree::new(Bt::utility("u", 0.1, [
            (Arc::new(|c: &BtCtx| c.bb.float("hunger").unwrap_or(0.0)) as ScoreFn, counter("eat", BtStatus::Running)),
            (Arc::new(|_: &BtCtx| 0.5f32) as ScoreFn, counter("roam", BtStatus::Running)),
        ]));
        let e = w.spawn_empty().id();
        let mut a = BtAgent::new(tree);
        let mut bb = Blackboard::default();
        bb.set("hunger", 0.2f32);
        a.tick(&mut w, e, &mut bb, 0.1, 0.0);
        assert_eq!(a.active_path(), vec!["u", "roam"]);
        bb.set("hunger", 0.55f32); // within hysteresis: stay
        a.tick(&mut w, e, &mut bb, 0.1, 0.1);
        assert_eq!(a.active_path(), vec!["u", "roam"]);
        bb.set("hunger", 0.9f32);
        a.tick(&mut w, e, &mut bb, 0.1, 0.2);
        assert_eq!(a.active_path(), vec!["u", "eat"]);
    }
}
