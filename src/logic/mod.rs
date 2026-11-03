//! Game logic as node graphs plus ruspy scripts (feature `logic`). See `docs/LOGIC.md`.
//!
//! - **Graphs**: `assets/logic/<name>.logic.ron` ([`logic_core::Graph`]), loaded as
//!   [`LogicGraphAsset`] (validated when loaded; hot-reloaded with the `hot_reload` feature or
//!   `logic.reload`). A broken edit keeps the last good graph running and reports why in
//!   [`LogicDiagnostics`].
//! - **Attach**: `Logic { graph: "logic/door.logic.ron" }` on an entity.
//! - **Events** reach the graph's event nodes: `Start` (once, when the graph is loaded),
//!   `Tick`, `Timer`, `OverlapEnter/Exit` (avian [`CollisionStart`/`CollisionEnd`] on
//!   entities with `CollisionEventsEnabled`, feature `physics`), `Action(name)` (feature
//!   `actions`), `Message(name)` ([`LogicMessage`], `Emit` nodes, script `emit`).
//! - **World access**: `Get`/`Set` nodes and script `get`/`set` read and write component
//!   fields by reflection path (`Transform.translation.y`). `Command` nodes run any control
//!   command in-process (feature `devtools`).
//! - **Scripts**: `assets/scripts/*.ruspy`, run by `Script` nodes; reloaded when the file
//!   changes. Errors never panic; they land in [`LogicDiagnostics`] with file, line and column.

mod access;
#[cfg(feature = "devtools")]
mod devtools;
mod script;

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Instant;

use bevy::asset::{AssetLoader, LoadContext, io::Reader};
use bevy::prelude::*;
pub use logic_core;
use logic_core::{Compiled, Entry, Host, Payload, Runner, Trigger, Value};

use crate::pause::not_paused;

pub use script::ScriptHost;
#[cfg(all(feature = "devtools", feature = "editor"))]
pub(crate) use devtools::fire as fire_event;
#[cfg(feature = "editor")]
pub(crate) use script::reload_script;

/// Reloads the graph asset at `path` if some entity uses it (a no-op otherwise). For the editor.
#[cfg(feature = "editor")]
pub(crate) fn reload_graph(world: &mut World, path: &str) {
    if world.resource::<LogicGraphs>().slots.contains_key(path) {
        let server = world.resource::<AssetServer>().clone();
        server.reload(path.to_string());
    }
}

/// Attaches the logic graph at `graph` (an asset path, e.g. `"logic/door.logic.ron"`).
#[derive(Component, Reflect, Default, Clone, Debug, PartialEq)]
#[reflect(Component, Default)]
pub struct Logic {
    pub graph: String,
}

impl Logic {
    pub fn new(graph: impl Into<String>) -> Logic {
        Logic { graph: graph.into() }
    }
}

/// A message for `Message(name)` event nodes of every graph. Send it from Rust, or from a graph
/// (`Emit` node) or a script (`emit(name, value)`).
#[derive(Message, Clone, Debug)]
pub struct LogicMessage {
    pub name: String,
    pub value: Value,
}

/// A graph file, validated when loaded.
#[derive(Asset, TypePath, Clone, Debug)]
pub struct LogicGraphAsset {
    pub compiled: Option<Arc<Compiled>>,
    pub errors: Vec<LogicDiag>,
}

#[derive(Default, TypePath)]
struct LogicGraphLoader;

impl AssetLoader for LogicGraphLoader {
    type Asset = LogicGraphAsset;
    type Settings = ();
    type Error = std::io::Error;

    async fn load(&self, reader: &mut dyn Reader, _: &(), _: &mut LoadContext<'_>) -> Result<LogicGraphAsset, Self::Error> {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await?;
        let src = std::str::from_utf8(&bytes).map_err(std::io::Error::other)?;
        // Problems are data (shown in the Output panel), not loader failures, so a bad edit
        // doesn't replace a good graph.
        Ok(match logic_core::Graph::from_ron(src) {
            Err(e) => LogicGraphAsset {
                compiled: None,
                errors: vec![LogicDiag { severity: Severity::Error, file: String::new(), line: e.line as u32, col: e.col as u32, node: None, message: e.message, count: 1 }],
            },
            Ok(g) => match g.compile() {
                Ok(c) => LogicGraphAsset {
                    errors: c.warnings.iter().map(LogicDiag::from_graph).collect(),
                    compiled: Some(Arc::new(c)),
                },
                Err(errs) => LogicGraphAsset { compiled: None, errors: errs.iter().map(LogicDiag::from_graph).collect() },
            },
        })
    }

    fn extensions(&self) -> &[&str] {
        &["logic.ron"]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

/// One problem, located. `line`/`col` are 0 for graph problems (they name a `node` id).
#[derive(Clone, Debug, PartialEq)]
pub struct LogicDiag {
    pub severity: Severity,
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub node: Option<u32>,
    pub message: String,
    /// How many times it happened (a per-tick error is one entry with a growing count).
    pub count: u32,
}

impl LogicDiag {
    fn from_graph(e: &logic_core::GraphError) -> LogicDiag {
        LogicDiag {
            severity: if e.severity == logic_core::Severity::Error { Severity::Error } else { Severity::Warning },
            file: String::new(),
            line: 0,
            col: 0,
            node: e.node,
            message: match &e.pin {
                Some(p) => format!("pin `{p}`: {}", e.message),
                None => e.message.clone(),
            },
            count: 1,
        }
    }
}

impl std::fmt::Display for LogicDiag {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.file)?;
        if self.line > 0 {
            write!(f, ":{}:{}", self.line, self.col)?;
        }
        if let Some(n) = self.node {
            write!(f, " node {n}")?;
        }
        write!(f, ": {}", self.message)
    }
}

/// Everything that went wrong in graphs and scripts, plus the scripts' `log()` output. The
/// editor's Output panel reads this.
#[derive(Resource, Default, Debug)]
pub struct LogicDiagnostics {
    pub items: Vec<LogicDiag>,
    pub log: VecDeque<String>,
}

const MAX_DIAGS: usize = 200;
const MAX_LOG: usize = 200;

impl LogicDiagnostics {
    pub fn report(&mut self, d: LogicDiag) {
        if let Some(x) = self.items.iter_mut().find(|x| x.file == d.file && x.line == d.line && x.col == d.col && x.node == d.node && x.message == d.message) {
            x.count += 1;
            return;
        }
        if self.items.len() < MAX_DIAGS {
            self.items.push(d);
        }
    }
    pub fn error(&mut self, file: &str, line: u32, col: u32, node: Option<u32>, message: impl Into<String>) {
        self.report(LogicDiag { severity: Severity::Error, file: file.into(), line, col, node, message: message.into(), count: 1 });
    }
    /// Forget everything reported for `file` (it reloaded cleanly).
    pub fn clear_file(&mut self, file: &str) {
        self.items.retain(|d| d.file != file);
    }
    pub fn log(&mut self, text: String) {
        if self.log.len() >= MAX_LOG {
            self.log.pop_front();
        }
        self.log.push_back(text);
    }
    pub fn errors(&self) -> impl Iterator<Item = &LogicDiag> {
        self.items.iter().filter(|d| d.severity == Severity::Error)
    }
}

/// Timing of graph runs.
#[derive(Resource, Default, Clone, Debug)]
pub struct LogicStats {
    pub events: u64,
    pub total_us: f64,
    pub last_us: f32,
    pub max_us: f32,
    pub script_calls: u64,
    pub script_us: f64,
}

/// Which entity is running (read by script host functions).
#[derive(Resource, Clone, Debug)]
pub(crate) struct LogicCtx {
    pub me: Entity,
}

#[derive(Default)]
struct GraphSlot {
    handle: Handle<LogicGraphAsset>,
    compiled: Option<Arc<Compiled>>,
    runner: Option<Runner>,
}

#[derive(Resource, Default)]
struct LogicGraphs {
    slots: HashMap<Arc<str>, GraphSlot>,
    /// Bumped whenever any slot gets a (new) compiled graph.
    generation: u32,
}

/// Per entity with [`Logic`]: the live graph and event bookkeeping.
#[derive(Component)]
pub(crate) struct LogicState {
    path: Arc<str>,
    graph: Option<Arc<Compiled>>,
    generation: u32,
    started: bool,
    has_tick: bool,
    actions: Vec<String>,
    messages: Vec<String>,
    /// (elapsed, finished) per timer node of the graph.
    timers: Vec<(f32, bool)>,
}

pub(crate) enum EventKind {
    Start,
    Tick(f32),
    OverlapEnter(Entity),
    OverlapExit(Entity),
    Action(String, f32),
    Message(String, Value),
    Timer(u32),
    Resume(u32, Payload),
}

pub(crate) struct Fire {
    entity: Entity,
    kind: EventKind,
}

#[derive(Resource, Default)]
struct LogicQueue(Vec<Fire>);

#[derive(Resource, Default)]
pub(crate) struct LogicOutbox(pub Vec<(String, Value)>);

struct DelayJob {
    entity: Entity,
    node: u32,
    remaining: f32,
    payload: Payload,
}

#[derive(Resource, Default)]
struct LogicDelays(Vec<DelayJob>);

/// Graph variables of one entity (`GetVar` / `SetVar`); a missing entry means "declared default".
#[derive(Component, Default)]
pub(crate) struct LogicVars(HashMap<String, Value>);

/// While `Some`, runs record the ids of the nodes they execute (the editor's "Fire").
#[derive(Resource, Default)]
pub(crate) struct LogicTraceCapture(pub Option<Vec<u32>>);

pub struct LogicPlugin;

impl Plugin for LogicPlugin {
    fn build(&self, app: &mut App) {
        app.init_asset::<LogicGraphAsset>()
            .register_asset_loader(LogicGraphLoader)
            .register_type::<Logic>()
            .add_message::<LogicMessage>()
            .init_resource::<LogicGraphs>()
            .init_resource::<LogicQueue>()
            .init_resource::<LogicOutbox>()
            .init_resource::<LogicDelays>()
            .init_resource::<LogicTraceCapture>()
            .init_resource::<LogicDiagnostics>()
            .init_resource::<LogicStats>()
            .insert_resource(LogicCtx { me: Entity::PLACEHOLDER });
        app.world_mut().insert_non_send(ScriptHost::new());
        app.add_systems(Update, script::poll_scripts)
            // Loading and swapping graphs also runs while paused (the editor edits and tests graphs in
            // a paused world); events only fire while the game runs.
            .add_systems(Update, (attach, sync_graphs).chain())
            .add_systems(Update, (gather, run_queue).chain().after(sync_graphs).run_if(not_paused));
        #[cfg(feature = "devtools")]
        devtools::register(app);
    }
}

/// New or changed [`Logic`] → a [`LogicState`] and a graph load.
fn attach(
    mut commands: Commands,
    server: Res<AssetServer>,
    mut graphs: ResMut<LogicGraphs>,
    changed: Query<(Entity, &Logic), Or<(Added<Logic>, Changed<Logic>)>>,
) {
    for (e, logic) in &changed {
        let path: Arc<str> = Arc::from(logic.graph.as_str());
        graphs.slots.entry(path.clone()).or_insert_with(|| GraphSlot { handle: server.load(logic.graph.clone()), ..default() });
        commands.entity(e).insert(LogicState {
            path,
            graph: None,
            generation: 0,
            started: false,
            has_tick: false,
            actions: vec![],
            messages: vec![],
            timers: vec![],
        });
    }
}

/// Graph assets → slots (keeping the last good graph on a bad edit) → entity states.
fn sync_graphs(
    mut events: MessageReader<AssetEvent<LogicGraphAsset>>,
    assets: Res<Assets<LogicGraphAsset>>,
    mut graphs: ResMut<LogicGraphs>,
    mut diags: ResMut<LogicDiagnostics>,
    mut states: Query<&mut LogicState>,
) {
    let mut touched: Vec<AssetId<LogicGraphAsset>> = Vec::new();
    for ev in events.read() {
        if let AssetEvent::LoadedWithDependencies { id } | AssetEvent::Modified { id } = ev {
            touched.push(*id);
        }
    }
    let mut changed = false;
    for id in touched {
        let Some(asset) = assets.get(id) else { continue };
        let Some((path, slot)) = graphs.slots.iter_mut().find(|(_, s)| s.handle.id() == id) else { continue };
        let file = path.to_string();
        diags.clear_file(&file);
        for d in &asset.errors {
            let mut d = d.clone();
            d.file = file.clone();
            diags.report(d);
        }
        if let Some(c) = &asset.compiled {
            slot.compiled = Some(c.clone());
            slot.runner = None;
            changed = true;
        }
    }
    if changed {
        graphs.generation = graphs.generation.wrapping_add(1).max(1);
    }
    let generation = graphs.generation;
    for mut st in &mut states {
        if st.generation == generation {
            continue;
        }
        let Some(c) = graphs.slots.get(&st.path).and_then(|s| s.compiled.clone()) else { continue };
        st.generation = generation;
        st.has_tick = c.has_tick();
        st.actions = c.actions().map(String::from).collect();
        st.messages = c.events.iter().filter_map(|(t, _)| if let Trigger::Message(m) = t { Some(m.clone()) } else { None }).collect();
        if st.timers.len() != c.timers.len() {
            st.timers = vec![(0.0, false); c.timers.len()];
        }
        st.graph = Some(c);
    }
}

/// Everything that happened this frame → [`LogicQueue`].
#[allow(clippy::too_many_arguments)]
fn gather(
    time: Res<Time>,
    mut queue: ResMut<LogicQueue>,
    mut delays: ResMut<LogicDelays>,
    mut states: Query<(Entity, &mut LogicState)>,
    mut messages: MessageReader<LogicMessage>,
    #[cfg(feature = "actions")] actions: Option<Res<crate::actions::ActionState>>,
    #[cfg(feature = "physics")] mut starts: MessageReader<avian3d::prelude::CollisionStart>,
    #[cfg(feature = "physics")] mut ends: MessageReader<avian3d::prelude::CollisionEnd>,
) {
    let dt = time.delta_secs();
    for (entity, mut st) in &mut states {
        if st.graph.is_none() {
            continue;
        }
        if !st.started {
            st.started = true;
            queue.0.push(Fire { entity, kind: EventKind::Start });
        }
        if st.has_tick {
            queue.0.push(Fire { entity, kind: EventKind::Tick(dt) });
        }
        let st = &mut *st;
        if let Some(g) = &st.graph {
            for (i, def) in g.timers.iter().enumerate() {
                let Some(t) = st.timers.get_mut(i) else { continue };
                if t.1 {
                    continue;
                }
                t.0 += dt;
                if t.0 >= def.secs {
                    queue.0.push(Fire { entity, kind: EventKind::Timer(def.node) });
                    if def.repeat && def.secs > 0.0 {
                        t.0 -= def.secs;
                    } else {
                        t.1 = true;
                    }
                }
            }
        }
        #[cfg(feature = "actions")]
        if let Some(a) = &actions {
            for name in &st.actions {
                if a.just_pressed(name) {
                    queue.0.push(Fire { entity, kind: EventKind::Action(name.clone(), a.value(name)) });
                }
            }
        }
    }
    delays.0.retain_mut(|d| {
        d.remaining -= dt;
        if d.remaining <= 0.0 {
            queue.0.push(Fire { entity: d.entity, kind: EventKind::Resume(d.node, std::mem::take(&mut d.payload)) });
            false
        } else {
            true
        }
    });
    for m in messages.read() {
        for (entity, st) in &states {
            if st.messages.contains(&m.name) {
                queue.0.push(Fire { entity, kind: EventKind::Message(m.name.clone(), m.value.clone()) });
            }
        }
    }
    #[cfg(feature = "physics")]
    {
        let target = |states: &Query<(Entity, &mut LogicState)>, collider: Entity, body: Option<Entity>| -> Option<Entity> {
            if states.contains(collider) {
                Some(collider)
            } else {
                body.filter(|b| states.contains(*b))
            }
        };
        // The message names the pair in no particular order: either side may carry a graph.
        for s in starts.read() {
            for (c, b, oc, ob) in [(s.collider1, s.body1, s.collider2, s.body2), (s.collider2, s.body2, s.collider1, s.body1)] {
                if let Some(e) = target(&states, c, b) {
                    queue.0.push(Fire { entity: e, kind: EventKind::OverlapEnter(ob.unwrap_or(oc)) });
                }
            }
        }
        for s in ends.read() {
            for (c, b, oc, ob) in [(s.collider1, s.body1, s.collider2, s.body2), (s.collider2, s.body2, s.collider1, s.body1)] {
                if let Some(e) = target(&states, c, b) {
                    queue.0.push(Fire { entity: e, kind: EventKind::OverlapExit(ob.unwrap_or(oc)) });
                }
            }
        }
    }
}

/// Runs the queued events. Messages emitted while running are delivered in the same frame
/// (up to a few rounds, so two graphs can't ping-pong forever).
fn run_queue(world: &mut World) {
    for _round in 0..4 {
        let mut fires = std::mem::take(&mut world.resource_mut::<LogicQueue>().0);
        for f in fires.drain(..) {
            run_fire(world, f);
        }
        world.resource_mut::<LogicQueue>().0 = fires;
        let out = std::mem::take(&mut world.resource_mut::<LogicOutbox>().0);
        if out.is_empty() {
            break;
        }
        let mut q = world.query::<(Entity, &LogicState)>();
        let mut extra = Vec::new();
        for (name, value) in &out {
            for (entity, st) in q.iter(world) {
                if st.messages.iter().any(|x| x == name) {
                    extra.push(Fire { entity, kind: EventKind::Message(name.clone(), value.clone()) });
                }
            }
        }
        if extra.is_empty() {
            break;
        }
        world.resource_mut::<LogicQueue>().0.extend(extra);
    }
    // Anything still queued (a 5th round of messages) waits for next frame.
}

/// Runs `kind` on `entity` and returns the ids of the nodes that ran. Delays are not waited
/// for: their continuation runs right away, so the trace shows the whole flow.
pub(crate) fn fire_traced(world: &mut World, entity: Entity, kind: EventKind) -> (usize, Vec<u32>) {
    world.init_resource::<LogicTraceCapture>();
    world.resource_mut::<LogicTraceCapture>().0 = Some(Vec::new());
    let ran = run_fire(world, Fire { entity, kind });
    for _ in 0..16 {
        let jobs: Vec<DelayJob> = {
            let mut d = world.resource_mut::<LogicDelays>();
            let (mine, rest) = std::mem::take(&mut d.0).into_iter().partition(|j| j.entity == entity);
            d.0 = rest;
            mine
        };
        if jobs.is_empty() {
            break;
        }
        for j in jobs {
            run_fire(world, Fire { entity, kind: EventKind::Resume(j.node, j.payload) });
        }
    }
    let trace = world.resource_mut::<LogicTraceCapture>().0.take().unwrap_or_default();
    (ran, trace)
}

fn entity_value(e: Entity) -> Value {
    Value::Entity(e.to_bits())
}

/// Runs one event on one entity's graph: every matching event node. Errors become diagnostics.
pub(crate) fn run_fire(world: &mut World, fire: Fire) -> usize {
    let Fire { entity, kind } = fire;
    let Some(st) = world.get::<LogicState>(entity) else { return 0 };
    let Some(graph) = st.graph.clone() else { return 0 };
    let path = st.path.clone();
    let mut payload = Payload { me: entity.to_bits(), ..default() };
    // Which event nodes this fires.
    enum Pick<'a> {
        Trigger(&'a Trigger),
        Node(u32),
    }
    let trig;
    let pick = match &kind {
        EventKind::Start => Pick::Trigger({
            trig = Trigger::Start;
            &trig
        }),
        EventKind::Tick(dt) => {
            payload.dt = *dt as f64;
            trig = Trigger::Tick;
            Pick::Trigger(&trig)
        }
        EventKind::OverlapEnter(o) => {
            payload.other = entity_value(*o);
            trig = Trigger::OverlapEnter;
            Pick::Trigger(&trig)
        }
        EventKind::OverlapExit(o) => {
            payload.other = entity_value(*o);
            trig = Trigger::OverlapExit;
            Pick::Trigger(&trig)
        }
        EventKind::Action(name, v) => {
            payload.value = Value::Num(*v as f64);
            trig = Trigger::Action(name.clone());
            Pick::Trigger(&trig)
        }
        EventKind::Message(name, v) => {
            payload.value = v.clone();
            trig = Trigger::Message(name.clone());
            Pick::Trigger(&trig)
        }
        EventKind::Timer(n) => Pick::Node(*n),
        EventKind::Resume(n, p) => {
            payload = p.clone();
            Pick::Node(*n)
        }
    };
    let resume = matches!(kind, EventKind::Resume(..));
    let mut runner = world.resource_mut::<LogicGraphs>().slots.get_mut(&path).and_then(|s| s.runner.take()).unwrap_or_default();
    let tracing = world.get_resource::<LogicTraceCapture>().is_some_and(|c| c.0.is_some());
    runner.tracing = tracing;
    let prev = world.resource::<LogicCtx>().clone();
    *world.resource_mut::<LogicCtx>() = LogicCtx { me: entity };
    let started = Instant::now();
    let mut ran = 0;
    let mut host = EngineHost { world, graph: graph.clone(), me: entity };
    let mut run_one = |host: &mut EngineHost, entry: Entry, node: u32| {
        if let Err(e) = runner.run(&graph, entry, &payload, host)
            && !e.message.starts_with(script::REPORTED)
        {
            host.world.resource_mut::<LogicDiagnostics>().error(&path, 0, 0, Some(e.node), e.message.clone());
        }
        if tracing && let Some(mut cap) = host.world.get_resource_mut::<LogicTraceCapture>() && let Some(c) = cap.0.as_mut() {
            c.extend(runner.trace.iter().copied());
        }
        let _ = node;
    };
    match pick {
        Pick::Node(n) => {
            let valid = (n as usize) < graph.nodes.len() && (!resume || matches!(graph.nodes[n as usize].kind, logic_core::NodeKind::Delay { .. }));
            if valid {
                run_one(&mut host, if resume { Entry::Resume(n) } else { Entry::Event(n) }, n);
                ran += 1;
            }
        }
        Pick::Trigger(t) => {
            for (tr, n) in &graph.events {
                if tr == t {
                    run_one(&mut host, Entry::Event(*n), *n);
                    ran += 1;
                }
            }
        }
    }
    let us = started.elapsed().as_secs_f32() * 1e6;
    if ran > 0 {
        let mut stats = world.resource_mut::<LogicStats>();
        stats.events += ran as u64;
        stats.total_us += us as f64;
        stats.last_us = us;
        stats.max_us = stats.max_us.max(us);
    }
    *world.resource_mut::<LogicCtx>() = prev;
    if let Some(slot) = world.resource_mut::<LogicGraphs>().slots.get_mut(&path)
        && slot.runner.is_none()
    {
        slot.runner = Some(runner);
    }
    ran
}

/// [`Host`] over the ECS.
struct EngineHost<'w> {
    world: &'w mut World,
    #[allow(dead_code)]
    graph: Arc<Compiled>,
    me: Entity,
}

fn entity_of(bits: u64) -> Result<Entity, String> {
    Entity::try_from_bits(bits).ok_or_else(|| format!("bad entity id {bits}"))
}

impl Host for EngineHost<'_> {
    fn get(&mut self, entity: u64, path: &str) -> Result<Value, String> {
        access::get_path(self.world, entity_of(entity)?, path)
    }
    fn set(&mut self, entity: u64, path: &str, value: &Value) -> Result<(), String> {
        access::set_path(self.world, entity_of(entity)?, path, value)
    }
    fn find(&mut self, name: &str) -> Option<u64> {
        script::find_named(self.world, name).map(|e| e.to_bits())
    }
    fn command(&mut self, id: &str, params: &serde_json::Value) -> Result<serde_json::Value, String> {
        run_command(self.world, id, params)
    }
    fn script(&mut self, file: &str, function: &str, args: &[Value]) -> Result<Value, String> {
        script::call(self.world, file, function, args)
    }
    fn emit(&mut self, name: &str, value: &Value) {
        self.world.resource_mut::<LogicOutbox>().0.push((name.to_string(), value.clone()));
    }
    fn log(&mut self, text: &str) {
        info!("[logic] {text}");
        self.world.resource_mut::<LogicDiagnostics>().log(text.to_string());
    }
    fn var_get(&mut self, me: u64, name: &str) -> Option<Value> {
        self.world.get::<LogicVars>(entity_of(me).ok()?)?.0.get(name).cloned()
    }
    fn var_set(&mut self, me: u64, name: &str, value: &Value) {
        let Ok(e) = entity_of(me) else { return };
        if let Some(mut v) = self.world.get_mut::<LogicVars>(e) {
            v.0.insert(name.to_string(), value.clone());
        } else if let Ok(mut ec) = self.world.get_entity_mut(e) {
            ec.insert(LogicVars(HashMap::from([(name.to_string(), value.clone())])));
        }
    }
    fn schedule(&mut self, node: u32, secs: f32, payload: &Payload) {
        self.world.resource_mut::<LogicDelays>().0.push(DelayJob { entity: self.me, node, remaining: secs.max(0.0), payload: payload.clone() });
    }
}

/// Runs a control command in-process (instant commands only).
pub fn run_command(world: &mut World, id: &str, params: &serde_json::Value) -> Result<serde_json::Value, String> {
    #[cfg(feature = "devtools")]
    {
        use crate::devtools::control::Handler;
        let handler = world
            .get_resource::<crate::devtools::ControlRegistry>()
            .and_then(|r| r.get(id).map(|c| c.handler))
            .ok_or_else(|| format!("unknown command `{id}`"))?;
        let params = if params.is_null() { serde_json::json!({}) } else { params.clone() };
        match handler {
            Handler::Instant(f) => f(world, params),
            Handler::Deferred(_) => Err(format!("`{id}` is a multi-frame command; graphs can only run instant commands")),
        }
    }
    #[cfg(not(feature = "devtools"))]
    {
        let _ = (world, params);
        Err(format!("command `{id}`: commands need the `devtools` feature"))
    }
}

#[cfg(test)]
mod tests;
