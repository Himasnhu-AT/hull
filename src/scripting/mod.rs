//! Godot-style node scripts in ruspy (feature `scripting`): `docs/SCRIPTING.md`.
//!
//! Put [`Script`] on an entity and it gets its own script *instance*: the file's top-level
//! variables become that entity's members, and the engine calls the lifecycle functions the
//! file defines (`_ready`, `_process(delta)`, `_physics_process(delta)`, `_input(action,
//! pressed)`, `_unhandled_input(action, pressed)`, `_exit_tree`). Entities talk through
//! **signals** ([`Connections`], `emit_signal`, `connect`), **groups** ([`Groups`],
//! `call_group`) and **node paths** (`get_node("../HUD/Score")`). UI buttons, physics overlaps and
//! [`ScriptTimer`]s emit built-in signals. Edits to a script hot reload and keep member values.
//!
//! The model follows Godot (see `docs/audits/godot/SCRIPTING.md`):
//! - one instance per entity (Godot `ScriptInstance`); members live in the instance;
//! - `_ready` runs children first, after the whole new subtree has its instances;
//! - `_process` runs by [`Script::priority`], then attach order; `_physics_process` in `FixedUpdate`;
//! - input goes to `_input` in reverse order until `set_input_as_handled()`, then `_unhandled_input`;
//! - signal calls are synchronous; `deferred` connections and `call_deferred` run at the end of
//!   the frame; `one_shot` connections are removed before the call;
//! - `queue_free` despawns at the end of the frame, after `_exit_tree`.

mod api;
mod api_engine;
mod api_input;
mod api_node;
mod api_pause;
#[cfg(feature = "devtools")]
mod devtools;
pub mod tree;
pub mod ui;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_ui;
#[cfg(test)]
mod tests_api;
#[cfg(test)]
mod bench;
#[cfg(test)]
mod tests_pause;
#[cfg(test)]
mod tests_engine;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Instant, SystemTime};

use bevy::prelude::*;
use logic_core::Value;
use ruspy::embed::{Backend, Engine, Module, Outline};
use ruspy::value::Value as RV;

use crate::logic::LogicDiagnostics;
use crate::logic::script::{rv_of, value_of_rv};
use crate::pause::Paused;
use crate::paths::AssetsDir;

pub use tree::{get_node, resolve_path};

/// A ruspy script attached to this entity (Godot `Node.set_script`). Saved in levels.
#[derive(Component, Reflect, Clone, Debug, Default, PartialEq)]
#[reflect(Component, Default)]
pub struct Script {
    /// `player.ruspy` (means `scripts/player.ruspy`) or a path under the assets folder.
    pub path: String,
    /// Lower runs first in `_process` / `_physics_process` (Godot `process_priority`).
    pub priority: i32,
    /// When this script runs relative to the game's pause (Godot `process_mode`).
    pub process_mode: ProcessMode,
}

impl Script {
    pub fn new(path: impl Into<String>) -> Self {
        Script { path: path.into(), priority: 0, process_mode: ProcessMode::Inherit }
    }
}

/// Godot `Node.process_mode`: whether a script's `_process`, input, timers, UI signals and
/// deferred calls run while the game is paused (`Paused`, `get_tree_paused()`).
#[derive(Reflect, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProcessMode {
    /// The parent's mode (`Pausable` for a root). The default.
    #[default]
    Inherit,
    /// Runs only while the game is not paused.
    Pausable,
    /// Runs only while the game is paused (a pause menu).
    WhenPaused,
    /// Runs paused or not.
    Always,
    /// Never runs.
    Disabled,
}

impl ProcessMode {
    /// Godot's constant order: `INHERIT 0, PAUSABLE 1, WHEN_PAUSED 2, ALWAYS 3, DISABLED 4`.
    pub fn from_name(s: &str) -> Option<Self> {
        Some(match s.to_ascii_lowercase().replace('-', "_").as_str() {
            "inherit" => Self::Inherit,
            "pausable" => Self::Pausable,
            "when_paused" | "whenpaused" => Self::WhenPaused,
            "always" => Self::Always,
            "disabled" => Self::Disabled,
            _ => return None,
        })
    }
    pub fn from_index(i: i64) -> Option<Self> {
        Some(match i {
            0 => Self::Inherit,
            1 => Self::Pausable,
            2 => Self::WhenPaused,
            3 => Self::Always,
            4 => Self::Disabled,
            _ => return None,
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Inherit => "inherit",
            Self::Pausable => "pausable",
            Self::WhenPaused => "when_paused",
            Self::Always => "always",
            Self::Disabled => "disabled",
        }
    }
    /// Does a script in this (resolved) mode run while the game is `paused`?
    pub fn runs(self, paused: bool) -> bool {
        match self {
            Self::Inherit | Self::Pausable => !paused,
            Self::WhenPaused => paused,
            Self::Always => true,
            Self::Disabled => false,
        }
    }
}

/// `set_process(false)` / `set_physics_process(false)` per instance (Godot). Absent = both on.
/// Runtime state, not saved.
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScriptProcessing {
    pub process: bool,
    pub physics: bool,
}

impl Default for ScriptProcessing {
    fn default() -> Self {
        ScriptProcessing { process: true, physics: true }
    }
}

/// `mode` resolved through the parents (a node without a `Script` passes `Inherit` up);
/// `Pausable` at the root.
pub fn effective_mode(world: &World, mut e: Entity) -> ProcessMode {
    for _ in 0..256 {
        if let Some(s) = world.get::<Script>(e)
            && s.process_mode != ProcessMode::Inherit
        {
            return s.process_mode;
        }
        match world.get::<ChildOf>(e) {
            Some(p) => e = p.parent(),
            None => break,
        }
    }
    ProcessMode::Pausable
}

/// Is the game paused (`Paused`)?
pub fn tree_paused(world: &World) -> bool {
    world.get_resource::<Paused>().is_some_and(|p| p.0)
}

/// Would `e`'s scripts run now, given the pause state and its process mode?
fn runs_now(world: &World, e: Entity, paused: bool) -> bool {
    effective_mode(world, e).runs(paused)
}

/// Member values set on this entity (Godot exported properties stored in the scene). Applied
/// after the script's top level runs, before `_ready`. `value` is JSON (`5`, `"hi"`, `[1,2,3]`).
#[derive(Component, Reflect, Clone, Debug, Default, PartialEq)]
#[reflect(Component, Default)]
pub struct ScriptProps {
    pub values: Vec<ScriptProp>,
}

#[derive(Reflect, Clone, Debug, Default, PartialEq)]
pub struct ScriptProp {
    pub name: String,
    pub value: String,
}

impl ScriptProps {
    pub fn with(mut self, name: &str, value: serde_json::Value) -> Self {
        self.set(name, value);
        self
    }
    pub fn set(&mut self, name: &str, value: serde_json::Value) {
        let value = value.to_string();
        match self.values.iter_mut().find(|p| p.name == name) {
            Some(p) => p.value = value,
            None => self.values.push(ScriptProp { name: name.into(), value }),
        }
    }
}

/// Groups this entity is in (Godot `add_to_group`). Saved in levels.
#[derive(Component, Reflect, Clone, Debug, Default, PartialEq)]
#[reflect(Component, Default)]
pub struct Groups(pub Vec<String>);

/// Outgoing signal connections of this entity (Godot `[connection]` entries). Saved in levels.
#[derive(Component, Reflect, Clone, Debug, Default, PartialEq)]
#[reflect(Component, Default)]
pub struct Connections(pub Vec<Connection>);

/// `signal` of this entity calls `method` on the entity at `target`.
#[derive(Reflect, Clone, Debug, Default, PartialEq)]
pub struct Connection {
    pub signal: String,
    /// Node path from this entity: `.`, `..`, `../HUD/Score`, `/Game`, `%Unique`, or `#<bits>`.
    pub target: String,
    pub method: String,
    /// Extra arguments appended after the signal's own (Godot `binds`), JSON each.
    pub binds: Vec<String>,
    /// Call at the end of the frame instead of during `emit_signal`.
    pub deferred: bool,
    /// Disconnect after the first emission.
    pub one_shot: bool,
}

impl Connections {
    pub fn to(mut self, signal: &str, target: &str, method: &str) -> Self {
        self.0.push(Connection { signal: signal.into(), target: target.into(), method: method.into(), ..default() });
        self
    }
}

/// `connect` flag bits (Godot `ConnectFlags`): call at the end of the frame.
pub const CONNECT_DEFERRED: i64 = 1;
/// `connect` flag bit: disconnect after the first emission.
pub const CONNECT_ONE_SHOT: i64 = 4;

/// A countdown that emits `timeout` (Godot `Timer` node). Saved in levels.
#[derive(Component, Reflect, Clone, Debug, PartialEq)]
#[reflect(Component, Default)]
pub struct ScriptTimer {
    pub wait_time: f32,
    pub one_shot: bool,
    pub autostart: bool,
    /// Seconds left while running; `None` when stopped. Runtime state.
    #[reflect(ignore)]
    pub left: Option<f32>,
    /// `autostart` was applied. Runtime state.
    #[reflect(ignore)]
    pub started: bool,
}

impl Default for ScriptTimer {
    fn default() -> Self {
        ScriptTimer { wait_time: 1.0, one_shot: false, autostart: true, left: None, started: false }
    }
}

/// Lifecycle functions a script defines (Godot turns processing on when a script defines them).
#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct Hooks {
    pub ready: bool,
    pub process: bool,
    pub physics: bool,
    pub input: bool,
    pub unhandled: bool,
    pub exit: bool,
}

/// One entity's script instance: its own engine + module, so its globals are its members.
pub(crate) struct Instance {
    pub engine: Engine,
    pub module: Module,
    pub key: String,
    pub hooks: Hooks,
    pub priority: i32,
    pub seq: u64,
    /// Names given to `signal("name")` at top level.
    pub signals: Vec<String>,
    pub ready: bool,
    /// Top-level function names of the file (from its outline): `has_fn` without a VM.
    pub fns: Rc<HashSet<String>>,
}

impl Instance {
    pub fn has(&self, f: &str) -> bool {
        self.fns.contains(f)
    }
}

struct Source {
    mtime: Option<SystemTime>,
    text: Option<Rc<str>>,
    outline: Outline,
    fns: Rc<HashSet<String>>,
    /// The VM rejected this file (arrays, methods, structs): use the interpreter.
    interp: bool,
}

/// Every script instance (non-send: ruspy values are `Rc`). Stays in the world during calls,
/// so a script can call into another entity's script (each instance is its own `RefCell`).
pub struct ScriptRuntime {
    base: Engine,
    pub(crate) instances: HashMap<Entity, Rc<RefCell<Instance>>>,
    sources: HashMap<String, Source>,
    /// Entities whose script failed to load, with the file key (retried when the file changes).
    failed: HashMap<Entity, String>,
    order: Vec<Entity>,
    order_dirty: bool,
    pending_ready: Vec<Entity>,
    next_seq: u64,
    last_poll: Option<Instant>,
    scratch: Vec<Entity>,
    /// `call_deferred`, deferred connections and busy signal targets (ruspy values kept).
    deferred: Vec<(Entity, String, Vec<RV>)>,
}

impl Default for ScriptRuntime {
    fn default() -> Self {
        let mut base = Engine::new(Backend::Vm);
        base.step_limit = 200_000;
        api::register(&mut base);
        ScriptRuntime {
            base,
            instances: HashMap::new(),
            sources: HashMap::new(),
            failed: HashMap::new(),
            order: vec![],
            order_dirty: false,
            pending_ready: vec![],
            next_seq: 0,
            last_poll: None,
            scratch: vec![],
            deferred: vec![],
        }
    }
}

/// Per-frame scripting state that host functions read (Send: plain data).
#[derive(Resource, Default)]
pub struct ScriptCtx {
    /// The entity whose script is running (top = `self()`).
    pub stack: Vec<Entity>,
    /// `set_input_as_handled()` was called for the event being delivered.
    pub handled: bool,
    pub delta: f32,
    pub physics_delta: f32,
    pub elapsed: f64,
    /// Seeded xorshift state for `randf`/`randi_range`.
    pub rng: u64,
}

/// Work queued for the end of the frame.
#[derive(Resource, Default)]
pub struct ScriptQueue {
    /// `call_deferred` and deferred connections: (entity, method, args).
    pub calls: Vec<(Entity, String, Vec<Value>)>,
    /// `queue_free`d entities.
    pub free: Vec<Entity>,
    /// `start_timer` timers.
    pub timers: Vec<CallTimer>,
    pub next_timer: u64,
    /// Entities whose `Script` was removed or that were despawned (from an observer).
    pub removed: Vec<Entity>,
    /// `change_scene(path)` request.
    pub change_scene: Option<String>,
}

pub struct CallTimer {
    pub id: u64,
    pub entity: Entity,
    pub method: String,
    pub left: f32,
    pub interval: f32,
    pub repeat: bool,
}

/// Counters for `script.stats` and the docs.
#[derive(Resource, Default, Clone, Debug)]
pub struct ScriptStats {
    pub calls: u64,
    pub call_us: f64,
    pub last_frame_us: f64,
    pub max_frame_us: f64,
    pub instances: usize,
    pub signals: u64,
    pub reloads: u64,
}

/// Singleton scripts created at startup (Godot autoloads): an entity named `name` with
/// `Script(path)`; reach it with `get_node("/<name>")` or `find("<name>")`.
#[derive(Resource, Clone, Default)]
pub struct Autoloads(pub Vec<(String, String)>);

pub struct ScriptingPlugin;

/// Order inside `Update`.
#[derive(SystemSet, Clone, Debug, PartialEq, Eq, Hash)]
pub enum ScriptSet {
    Attach,
    Events,
    Process,
    Flush,
}

impl Plugin for ScriptingPlugin {
    fn build(&self, app: &mut App) {
        app.register_type::<Script>()
            .register_type::<ScriptProps>()
            .register_type::<ScriptProp>()
            .register_type::<Groups>()
            .register_type::<Connections>()
            .register_type::<Connection>()
            .register_type::<ScriptTimer>()
            .register_type::<ProcessMode>()
            .init_resource::<ScriptCtx>()
            .init_resource::<ScriptQueue>()
            .init_resource::<ScriptStats>()
            .init_resource::<Autoloads>();
        if !app.world().contains_resource::<LogicDiagnostics>() {
            app.init_resource::<LogicDiagnostics>();
        }
        app.world_mut().insert_non_send(ScriptRuntime::default());
        app.world_mut().resource_mut::<ScriptCtx>().rng = 0x9E37_79B9_7F4A_7C15;
        app.add_observer(|ev: On<Remove<Script>>, mut q: ResMut<ScriptQueue>| q.removed.push(ev.entity));
        app.configure_sets(Update, (ScriptSet::Attach, ScriptSet::Events, ScriptSet::Process, ScriptSet::Flush).chain().run_if(scripts_active));
        app.add_systems(Startup, spawn_autoloads)
            .add_systems(Update, (poll_sources, attach, run_ready).chain().in_set(ScriptSet::Attach))
            .add_systems(Update, (timers, ui_signals, input).chain().in_set(ScriptSet::Events))
            .add_systems(Update, process.in_set(ScriptSet::Process))
            .add_systems(Update, flush.in_set(ScriptSet::Flush))
            .add_systems(FixedUpdate, physics_process.run_if(scripts_active));
        #[cfg(feature = "physics")]
        app.add_systems(Update, physics_signals.after(timers).before(ui_signals).in_set(ScriptSet::Events));
        #[cfg(feature = "ai")]
        app.add_systems(Update, api_engine::nav_signals.after(timers).before(ui_signals).in_set(ScriptSet::Events));
        tree::plugin(app);
        ui::plugin(app);
        #[cfg(feature = "devtools")]
        devtools::register(app);
    }
}

/// Scripts do not run in the editor's edit world (`EditorMode`: virtual time is paused there
/// and the game runs in another process on Play). Pause itself no longer stops the systems:
/// each instance follows its [`ProcessMode`].
#[cfg(feature = "editor")]
fn scripts_active(editor: Option<Res<crate::editor::EditorMode>>) -> bool {
    editor.is_none()
}

#[cfg(not(feature = "editor"))]
fn scripts_active() -> bool {
    true
}

fn spawn_autoloads(mut commands: Commands, autoloads: Res<Autoloads>) {
    for (name, path) in &autoloads.0 {
        commands.spawn((Name::new(name.clone()), Script::new(path.clone()), Transform::default()));
    }
}

/// `player.ruspy` → `scripts/player.ruspy`.
pub fn key_of(path: &str) -> String {
    if path.contains('/') { path.to_string() } else { format!("scripts/{path}") }
}

fn assets_root(world: &World) -> PathBuf {
    world.get_resource::<AssetsDir>().map(|a| a.0.clone()).unwrap_or_else(|| PathBuf::from("assets"))
}

fn diag(world: &mut World, key: &str, line: usize, col: usize, msg: String) {
    if let Some(mut d) = world.get_resource_mut::<LogicDiagnostics>() {
        d.error(key, line as u32, col as u32, None, msg);
    }
}

// ---------------------------------------------------------------- instances

fn read_source(rt: &mut ScriptRuntime, root: &std::path::Path, key: &str) -> Result<(), String> {
    let path = root.join(key);
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let outline = ruspy::embed::outline(&text);
            let fns = Rc::new(outline.fns.iter().map(|(n, _)| n.clone()).collect());
            rt.sources.insert(key.to_string(), Source { mtime, text: Some(Rc::from(text)), outline, fns, interp: false });
            Ok(())
        }
        Err(e) => {
            rt.sources.insert(key.to_string(), Source { mtime, text: None, outline: Outline::default(), fns: Rc::default(), interp: false });
            Err(format!("can't read {}: {e}", path.display()))
        }
    }
}

/// Creates (or re-creates, keeping members in `keep`) the instance for `e`. Errors are reported
/// to the diagnostics; returns whether an instance exists afterwards.
fn instantiate(world: &mut World, e: Entity, script: &Script, keep: Option<Vec<(String, RV)>>) -> bool {
    let key = key_of(&script.path);
    let root = assets_root(world);
    let mut rt = world.remove_non_send::<ScriptRuntime>().expect("ScriptRuntime");
    if !rt.sources.contains_key(&key)
        && let Err(msg) = read_source(&mut rt, &root, &key)
    {
        world.insert_non_send(rt);
        diag(world, &key, 0, 0, msg);
        fail(world, e, &key);
        return false;
    }
    let src = rt.sources.get(&key).and_then(|s| s.text.clone());
    let interp = rt.sources.get(&key).is_some_and(|s| s.interp);
    let mut engine = rt.base.fork();
    let seq = rt.next_seq;
    rt.next_seq += 1;
    // The top level may call host functions (on reload the old instance is still in the map).
    world.insert_non_send(rt);
    let Some(src) = src else {
        diag(world, &key, 0, 0, format!("can't read {key}"));
        fail(world, e, &key);
        return false;
    };
    if let Some(mut d) = world.get_resource_mut::<DeclaredSignals>() {
        d.0.remove(&e);
    }
    world.resource_mut::<ScriptCtx>().stack.push(e);
    let mut tried_interp = interp;
    engine.backend = if interp { Backend::Interpreter } else { Backend::Vm };
    let mut r = engine.load(&key, &src, world);
    if !tried_interp && matches!(&r, Err(errs) if errs.iter().any(|x| x.code == "E0900")) {
        tried_interp = true;
        engine.backend = Backend::Interpreter;
        r = engine.load(&key, &src, world);
    }
    world.resource_mut::<ScriptCtx>().stack.pop();
    if let Some(mut d) = world.get_resource_mut::<LogicDiagnostics>() {
        d.clear_file(&key);
    }
    let module = match r {
        Ok(m) => m,
        Err(errs) => {
            for x in errs {
                diag(world, &key, x.line, x.col, format!("[{}] {}", x.code, x.message));
            }
            fail(world, e, &key);
            return false;
        }
    };
    // Members: the old values first (hot reload), then the entity's saved props.
    if let Some(keep) = keep {
        for (name, v) in keep {
            if engine.global(module, &name).is_some() {
                engine.set_global(module, &name, v);
            }
        }
    } else if let Some(props) = world.get::<ScriptProps>(e).cloned() {
        for p in props.values {
            match serde_json::from_str::<serde_json::Value>(&p.value) {
                Ok(j) if engine.global(module, &p.name).is_some() => engine.set_global(module, &p.name, rv_of_json_exact(&j)),
                Ok(_) => diag(world, &key, 0, 0, format!("prop `{}` on {e}: the script has no member `{}`", p.name, p.name)),
                Err(err) => diag(world, &key, 0, 0, format!("prop `{}` on {e}: bad JSON: {err}", p.name)),
            }
        }
    }
    let fns = world.non_send::<ScriptRuntime>().sources.get(&key).map(|s| s.fns.clone()).unwrap_or_default();
    let hooks = Hooks {
        ready: fns.contains("_ready"),
        process: fns.contains("_process"),
        physics: fns.contains("_physics_process"),
        input: fns.contains("_input"),
        unhandled: fns.contains("_unhandled_input"),
        exit: fns.contains("_exit_tree"),
    };
    let signals = world.get_resource_mut::<DeclaredSignals>().and_then(|mut d| d.0.remove(&e)).unwrap_or_default();
    let mut rt = world.non_send_mut::<ScriptRuntime>();
    if tried_interp && let Some(s) = rt.sources.get_mut(&key) {
        s.interp = true;
    }
    rt.failed.remove(&e);
    let (was_ready, old_seq) = rt.instances.get(&e).and_then(|i| i.try_borrow().ok().map(|i| (i.ready, i.seq))).unwrap_or((false, seq));
    // A reloaded instance keeps its place in the process order.
    let inst = Instance { engine, module, key, hooks, priority: script.priority, seq: old_seq, signals, ready: was_ready, fns };
    rt.instances.insert(e, Rc::new(RefCell::new(inst)));
    rt.order_dirty = true;
    if !was_ready {
        rt.pending_ready.push(e);
    }
    true
}

/// `signal("name")` calls during a top-level run land here, then move to the instance.
#[derive(Resource, Default)]
pub(crate) struct DeclaredSignals(pub HashMap<Entity, Vec<String>>);

fn fail(world: &mut World, e: Entity, key: &str) {
    let mut rt = world.non_send_mut::<ScriptRuntime>();
    rt.failed.insert(e, key.to_string());
}

/// Calls `f` on `e`'s script. Errors in the script go to the diagnostics and come back as `Err`.
pub fn call(world: &mut World, e: Entity, f: &str, args: &[Value]) -> Result<Value, String> {
    let rv: Vec<RV> = args.iter().map(rv_of).collect();
    call_rv(world, e, f, rv).and_then(|v| value_of_rv(&v))
}

pub(crate) fn call_rv(world: &mut World, e: Entity, f: &str, args: Vec<RV>) -> Result<RV, String> {
    let inst = world
        .get_non_send::<ScriptRuntime>()
        .and_then(|rt| rt.instances.get(&e).cloned())
        .ok_or_else(|| format!("entity {e} has no script"))?;
    let Ok(mut i) = inst.try_borrow_mut() else {
        return Err(format!("entity {e}'s script is already running (re-entrant call to `{f}`); use call_deferred"));
    };
    if !i.has(f) {
        return Err(format!("{} has no function `{f}`", i.key));
    }
    if world.resource::<ScriptCtx>().stack.len() >= 32 {
        return Err("script calls nested deeper than 32".into());
    }
    world.resource_mut::<ScriptCtx>().stack.push(e);
    let t = Instant::now();
    let m = i.module;
    let r = i.engine.call(m, f, args, world);
    let us = t.elapsed().as_secs_f64() * 1e6;
    world.resource_mut::<ScriptCtx>().stack.pop();
    let mut st = world.resource_mut::<ScriptStats>();
    st.calls += 1;
    st.call_us += us;
    match r {
        Ok(v) => Ok(v),
        Err(x) => {
            let key = i.key.clone();
            drop(i);
            let msg = format!("[{}] {}", x.code, x.message);
            diag(world, &key, x.line, x.col, msg);
            Err(format!("{key}:{}:{}: {}", x.line, x.col, x.message))
        }
    }
}

/// Calls `f` if the script defines it (no error when it doesn't).
pub fn call_if(world: &mut World, e: Entity, f: &str, args: Vec<RV>) {
    let has = world
        .get_non_send::<ScriptRuntime>()
        .and_then(|rt| rt.instances.get(&e).cloned())
        .and_then(|i| i.try_borrow().ok().map(|i| i.has(f)))
        .unwrap_or(false);
    if has {
        let _ = call_rv(world, e, f, args);
    }
}

pub fn has_method(world: &World, e: Entity, f: &str) -> bool {
    world
        .get_non_send::<ScriptRuntime>()
        .and_then(|rt| rt.instances.get(&e).cloned())
        .and_then(|i| i.try_borrow().ok().map(|i| i.has(f)))
        .unwrap_or(false)
}

/// Reads a member of `e`'s script (`None`: no script, busy, or no such member).
pub fn get_member(world: &World, e: Entity, name: &str) -> Option<Value> {
    let inst = world.get_non_send::<ScriptRuntime>()?.instances.get(&e).cloned()?;
    let i = inst.try_borrow().ok()?;
    i.engine.global(i.module, name).and_then(|v| value_of_rv(&v).ok())
}

pub(crate) fn get_member_rv(world: &World, e: Entity, name: &str) -> Result<RV, String> {
    let inst = world.get_non_send::<ScriptRuntime>().and_then(|rt| rt.instances.get(&e).cloned()).ok_or_else(|| format!("entity {e} has no script"))?;
    let i = inst.try_borrow().map_err(|_| format!("entity {e}'s script is running (for your own members use the variable directly)"))?;
    i.engine.global(i.module, name).ok_or_else(|| format!("{} has no member `{name}`", i.key))
}

/// Sets a member of `e`'s script.
pub fn set_member(world: &mut World, e: Entity, name: &str, v: &Value) -> Result<(), String> {
    set_member_rv(world, e, name, rv_of(v))
}

pub(crate) fn set_member_rv(world: &mut World, e: Entity, name: &str, v: RV) -> Result<(), String> {
    let inst = world.get_non_send::<ScriptRuntime>().and_then(|rt| rt.instances.get(&e).cloned()).ok_or_else(|| format!("entity {e} has no script"))?;
    let mut i = inst.try_borrow_mut().map_err(|_| format!("entity {e}'s script is running; set its member with call_deferred"))?;
    let m = i.module;
    if i.engine.global(m, name).is_none() {
        return Err(format!("{} has no member `{name}`", i.key));
    }
    i.engine.set_global(m, name, v);
    Ok(())
}

/// Members of `e`'s script, sorted by declaration (outline) order.
pub fn members(world: &World, e: Entity) -> Vec<(String, Value)> {
    let Some(rt) = world.get_non_send::<ScriptRuntime>() else { return vec![] };
    let Some(inst) = rt.instances.get(&e) else { return vec![] };
    let Ok(i) = inst.try_borrow() else { return vec![] };
    let order = rt.sources.get(&i.key).map(|s| s.outline.vars.clone()).unwrap_or_default();
    let mut names = i.engine.global_names(i.module);
    names.sort_by_key(|n| order.iter().position(|o| o == n).unwrap_or(usize::MAX));
    names.into_iter().filter_map(|n| i.engine.global(i.module, &n).and_then(|v| value_of_rv(&v).ok()).map(|v| (n, v))).collect()
}

/// The outline (members, functions) of a script file, loading it if needed.
pub fn outline(world: &mut World, path: &str) -> Result<Outline, String> {
    let key = key_of(path);
    let root = assets_root(world);
    let mut rt = world.non_send_mut::<ScriptRuntime>();
    if !rt.sources.contains_key(&key) {
        read_source(&mut rt, &root, &key)?;
    }
    Ok(rt.sources[&key].outline.clone())
}

/// Signals `e`'s script declared with `signal("name")` (at top level or later).
pub fn declared_signals(world: &World, e: Entity) -> Vec<String> {
    let mut v = world
        .get_non_send::<ScriptRuntime>()
        .and_then(|rt| rt.instances.get(&e).cloned())
        .and_then(|i| i.try_borrow().ok().map(|i| i.signals.clone()))
        .unwrap_or_default();
    if let Some(more) = world.get_resource::<DeclaredSignals>().and_then(|d| d.0.get(&e)) {
        for s in more {
            if !v.contains(s) {
                v.push(s.clone());
            }
        }
    }
    v
}

// ---------------------------------------------------------------- signals

/// Emits `signal` from `src`: calls every connected method now (deferred ones at the end of
/// the frame). Returns how many connections fired. Errors in handlers go to the diagnostics.
pub fn emit_signal(world: &mut World, src: Entity, signal: &str, args: &[Value]) -> usize {
    emit_signal_rv(world, src, signal, args.iter().map(rv_of).collect())
}

/// [`emit_signal`] with ruspy values (script to script keeps ints and floats apart).
pub(crate) fn emit_signal_rv(world: &mut World, src: Entity, signal: &str, args: Vec<RV>) -> usize {
    let Some(conns) = world.get::<Connections>(src) else { return 0 };
    if !conns.0.iter().any(|c| c.signal == signal) {
        return 0;
    }
    let fire: Vec<Connection> = conns.0.iter().filter(|c| c.signal == signal).cloned().collect();
    if fire.iter().any(|c| c.one_shot)
        && let Some(mut c) = world.get_mut::<Connections>(src)
    {
        c.0.retain(|c| !(c.signal == signal && c.one_shot));
    }
    if let Some(mut st) = world.get_resource_mut::<ScriptStats>() {
        st.signals += 1;
    }
    let mut n = 0;
    for c in fire {
        let Some(target) = resolve_path(world, src, &c.target) else {
            let msg = format!("signal `{signal}` of {src}: target `{}` not found", c.target);
            diag(world, "signals", 0, 0, msg);
            continue;
        };
        let mut a = args.clone();
        for b in &c.binds {
            a.push(serde_json::from_str::<serde_json::Value>(b).map(|j| rv_of_json_exact(&j)).unwrap_or_else(|_| RV::Str(b.clone())));
        }
        n += 1;
        // A target that is running right now (it called into this chain) can't be entered
        // again synchronously: run its handler at the end of the frame instead.
        if c.deferred || is_busy(world, target) {
            defer(world, target, c.method.clone(), a);
        } else if let Err(e) = call_rv(world, target, &c.method, a)
            && !e.contains(".ruspy:")
        {
            diag(world, "signals", 0, 0, format!("signal `{signal}` of {src} → {target}.{}: {e}", c.method));
        }
    }
    n
}

/// Is `e`'s script on the call stack right now?
pub(crate) fn is_busy(world: &World, e: Entity) -> bool {
    world.get_non_send::<ScriptRuntime>().and_then(|rt| rt.instances.get(&e).cloned()).is_some_and(|i| i.try_borrow_mut().is_err())
}

/// Queues `method(args)` on `e` for the end of the frame.
pub(crate) fn defer(world: &mut World, e: Entity, method: String, args: Vec<RV>) {
    if let Some(mut rt) = world.get_non_send_mut::<ScriptRuntime>() {
        rt.deferred.push((e, method, args));
    }
}

/// JSON → ruspy, keeping `5.0` a float and `5` an int.
pub(crate) fn rv_of_json_exact(j: &serde_json::Value) -> RV {
    use serde_json::Value as J;
    match j {
        J::Number(n) if n.is_f64() => RV::Float(n.as_f64().unwrap_or(0.0)),
        J::Number(n) => n.as_i64().map_or_else(|| RV::Float(n.as_f64().unwrap_or(0.0)), RV::Int),
        J::Array(a) => RV::array(a.iter().map(rv_of_json_exact).collect()),
        other => rv_of(&Value::from_json(other)),
    }
}

/// Adds a connection (no duplicate of the same signal/target/method).
pub fn connect(world: &mut World, src: Entity, signal: &str, target: &str, method: &str, one_shot: bool, deferred: bool) {
    let c = Connection { signal: signal.into(), target: target.into(), method: method.into(), binds: vec![], deferred, one_shot };
    match world.get_mut::<Connections>(src) {
        Some(mut cs) => {
            if !cs.0.iter().any(|x| x.signal == c.signal && x.target == c.target && x.method == c.method) {
                cs.0.push(c);
            }
        }
        None => {
            if let Ok(mut em) = world.get_entity_mut(src) {
                em.insert(Connections(vec![c]));
            }
        }
    }
}

// ---------------------------------------------------------------- systems

/// Reloads changed script files (twice a second) and re-creates their instances, keeping
/// member values that still exist (Godot keeps state across a script reload).
fn poll_sources(world: &mut World) {
    let due = world.non_send::<ScriptRuntime>().last_poll.is_none_or(|t| t.elapsed().as_secs_f32() >= 0.5);
    if !due {
        return;
    }
    let root = assets_root(world);
    let mut changed: Vec<String> = vec![];
    {
        let mut rt = world.non_send_mut::<ScriptRuntime>();
        rt.last_poll = Some(Instant::now());
        let keys: Vec<String> = rt.sources.keys().cloned().collect();
        for k in keys {
            let mtime = std::fs::metadata(root.join(&k)).and_then(|m| m.modified()).ok();
            if rt.sources[&k].mtime != mtime {
                let _ = read_source(&mut rt, &root, &k);
                changed.push(k);
            }
        }
    }
    for k in changed {
        reload_key(world, &k);
    }
}

/// Re-creates every instance of `key` from the cached source (call after the source changed).
pub(crate) fn reload_key(world: &mut World, key: &str) -> usize {
    let (live, failed): (Vec<(Entity, Vec<(String, RV)>)>, Vec<Entity>) = {
        let rt = world.non_send::<ScriptRuntime>();
        let live = rt
            .instances
            .iter()
            .filter_map(|(e, i)| {
                let i = i.try_borrow().ok()?;
                (i.key == key).then(|| (*e, i.engine.global_names(i.module).into_iter().filter_map(|n| i.engine.global(i.module, &n).map(|v| (n, v))).collect()))
            })
            .collect();
        let failed = rt.failed.iter().filter(|(_, k)| *k == key).map(|(e, _)| *e).collect();
        (live, failed)
    };
    let mut n = 0;
    for (e, keep) in live {
        let Some(s) = world.get::<Script>(e).cloned() else { continue };
        // The old instance stays in the map until the new one replaces it: a failed reload
        // keeps it running, and a good one inherits its ready state (no second `_ready`).
        if instantiate(world, e, &s, Some(keep)) {
            n += 1;
        } else {
            world.non_send_mut::<ScriptRuntime>().failed.remove(&e);
        }
    }
    for e in failed {
        if let Some(s) = world.get::<Script>(e).cloned()
            && instantiate(world, e, &s, None)
        {
            n += 1;
        }
    }
    world.resource_mut::<ScriptStats>().reloads += 1;
    n
}

/// Reloads every script file from disk now.
pub fn reload_all(world: &mut World) -> usize {
    let root = assets_root(world);
    let keys: Vec<String> = {
        let mut rt = world.non_send_mut::<ScriptRuntime>();
        let keys: Vec<String> = rt.sources.keys().cloned().collect();
        for k in &keys {
            let _ = read_source(&mut rt, &root, k);
        }
        keys
    };
    keys.iter().map(|k| reload_key(world, k)).sum()
}

/// New or changed [`Script`]s → instances; removed ones → `_exit_tree`.
/// Instances of entities that lost their `Script` or were despawned outside `queue_free`:
/// `_exit_tree` (the entity may be gone already, so tree calls in it can fail) and drop.
fn drain_removed(world: &mut World) {
    let removed = std::mem::take(&mut world.resource_mut::<ScriptQueue>().removed);
    for e in removed {
        drop_instance(world, e, true);
    }
}

fn attach(world: &mut World, added: &mut QueryState<(Entity, &Script), Changed<Script>>) {
    // `Changed` below re-attaches if the Script came back (replaced) this frame.
    drain_removed(world);
    let new: Vec<(Entity, Script)> = added.iter(world).map(|(e, s)| (e, s.clone())).collect();
    for (e, s) in new {
        let existing = world.non_send::<ScriptRuntime>().instances.get(&e).cloned();
        if let Some(inst) = existing
            && let Ok(mut i) = inst.try_borrow_mut()
            && i.key == key_of(&s.path)
        {
            // Same file: only the priority can have changed; keep the instance and its state.
            if i.priority != s.priority {
                i.priority = s.priority;
                world.non_send_mut::<ScriptRuntime>().order_dirty = true;
            }
            continue;
        }
        drop_instance(world, e, true);
        instantiate(world, e, &s, None);
    }
}

fn drop_instance(world: &mut World, e: Entity, exit: bool) {
    let Some(inst) = world.non_send::<ScriptRuntime>().instances.get(&e).cloned() else {
        world.non_send_mut::<ScriptRuntime>().failed.remove(&e);
        return;
    };
    if exit && inst.try_borrow().is_ok_and(|i| i.hooks.exit && i.ready) {
        let _ = call_rv(world, e, "_exit_tree", vec![]);
    }
    let mut rt = world.non_send_mut::<ScriptRuntime>();
    rt.instances.remove(&e);
    rt.failed.remove(&e);
    rt.order_dirty = true;
}

fn depth(world: &World, mut e: Entity) -> usize {
    let mut d = 0;
    while let Some(p) = world.get::<ChildOf>(e) {
        e = p.parent();
        d += 1;
        if d > 256 {
            break;
        }
    }
    d
}

/// `_ready` for new instances, deepest first (children are ready before their parent).
fn run_ready(world: &mut World) {
    let paused = tree_paused(world);
    // Instances that would not process right now (paused game, `Disabled`) wait for their turn.
    let mut held: Vec<Entity> = vec![];
    loop {
        let mut pending = std::mem::take(&mut world.non_send_mut::<ScriptRuntime>().pending_ready);
        if pending.is_empty() {
            break;
        }
        pending.sort_by_key(|e| std::cmp::Reverse(depth(world, *e)));
        for e in pending {
            let Some(inst) = world.non_send::<ScriptRuntime>().instances.get(&e).cloned() else { continue };
            if !runs_now(world, e, paused) {
                held.push(e);
                continue;
            }
            let hooks = {
                let Ok(mut i) = inst.try_borrow_mut() else { continue };
                if i.ready {
                    continue;
                }
                i.ready = true;
                i.hooks
            };
            if hooks.ready {
                let _ = call_rv(world, e, "_ready", vec![]);
            }
        }
    }
    if !held.is_empty() {
        world.non_send_mut::<ScriptRuntime>().pending_ready.extend(held);
    }
}

fn sorted_order(world: &mut World) {
    let mut rt = world.non_send_mut::<ScriptRuntime>();
    if !rt.order_dirty {
        return;
    }
    rt.order_dirty = false;
    let mut v: Vec<(i32, u64, Entity)> = rt.instances.iter().filter_map(|(e, i)| i.try_borrow().ok().map(|i| (i.priority, i.seq, *e))).collect();
    v.sort_unstable();
    rt.order = v.into_iter().map(|(_, _, e)| e).collect();
}

/// Entities whose instance is ready, has `pick`, has not turned it off (`toggle`) and may run
/// now ([`ProcessMode`] against the pause state), in process order (reuses a buffer).
fn take_list(world: &mut World, pick: impl Fn(&Hooks) -> bool, toggle: impl Fn(&ScriptProcessing) -> bool) -> Vec<Entity> {
    sorted_order(world);
    let paused = tree_paused(world);
    let mut rt = world.non_send_mut::<ScriptRuntime>();
    let mut out = std::mem::take(&mut rt.scratch);
    out.clear();
    for e in &rt.order {
        if let Some(i) = rt.instances.get(e)
            && let Ok(i) = i.try_borrow()
            && i.ready
            && pick(&i.hooks)
        {
            out.push(*e);
        }
    }
    out.retain(|e| world.get_entity(*e).is_ok() && world.get::<ScriptProcessing>(*e).is_none_or(&toggle) && runs_now(world, *e, paused));
    out
}

/// The delta a script sees: game time, or real time while the game is paused (so `Always` and
/// `WhenPaused` scripts still animate).
fn frame_dt(world: &World, paused: bool) -> f32 {
    if paused { world.get_resource::<Time<Real>>().map_or(0.0, |t| t.delta_secs()) } else { world.resource::<Time>().delta_secs() }
}

fn give_back(world: &mut World, v: Vec<Entity>) {
    world.non_send_mut::<ScriptRuntime>().scratch = v;
}

fn process(world: &mut World) {
    let t = Instant::now();
    let paused = tree_paused(world);
    let dt = frame_dt(world, paused);
    let game_dt = world.resource::<Time>().delta_secs();
    {
        let mut c = world.resource_mut::<ScriptCtx>();
        c.delta = dt;
        c.elapsed += game_dt as f64;
    }
    let list = take_list(world, |h| h.process, |p| p.process);
    for &e in &list {
        let _ = call_rv(world, e, "_process", vec![RV::Float(dt as f64)]);
    }
    give_back(world, list);
    let us = t.elapsed().as_secs_f64() * 1e6;
    let n = world.non_send::<ScriptRuntime>().instances.len();
    let mut st = world.resource_mut::<ScriptStats>();
    st.last_frame_us = us;
    st.max_frame_us = st.max_frame_us.max(us);
    st.instances = n;
}

fn physics_process(world: &mut World) {
    drain_removed(world);
    let dt = world.resource::<Time>().delta_secs();
    world.resource_mut::<ScriptCtx>().physics_delta = dt;
    let list = take_list(world, |h| h.physics, |p| p.physics);
    for &e in &list {
        let _ = call_rv(world, e, "_physics_process", vec![RV::Float(dt as f64)]);
    }
    give_back(world, list);
}

/// Action edges → `_input(action, pressed)` (reverse order, until handled), then
/// `_unhandled_input(action, pressed)`.
fn input(world: &mut World) {
    #[cfg(feature = "actions")]
    {
        let Some(map) = world.get_resource::<crate::actions::ActionMap>() else { return };
        let Some(state) = world.get_resource::<crate::actions::ActionState>() else { return };
        let events: Vec<(String, bool)> = state
            .iter(map)
            .filter_map(|(n, d)| {
                if d.just_pressed {
                    Some((n.to_string(), true))
                } else if d.just_released {
                    Some((n.to_string(), false))
                } else {
                    None
                }
            })
            .collect();
        if events.is_empty() {
            return;
        }
        let inputs = take_list(world, |h| h.input, |_| true);
        let unhandled: Vec<Entity> = {
            let l = take_list(world, |h| h.unhandled, |_| true);
            let v = l.clone();
            give_back(world, l);
            v
        };
        for (name, pressed) in events {
            world.resource_mut::<ScriptCtx>().handled = false;
            for &e in inputs.iter().rev() {
                let _ = call_rv(world, e, "_input", vec![RV::Str(name.clone()), RV::Bool(pressed)]);
                if world.resource::<ScriptCtx>().handled {
                    break;
                }
            }
            if world.resource::<ScriptCtx>().handled {
                continue;
            }
            for &e in unhandled.iter().rev() {
                let _ = call_rv(world, e, "_unhandled_input", vec![RV::Str(name.clone()), RV::Bool(pressed)]);
                if world.resource::<ScriptCtx>().handled {
                    break;
                }
            }
        }
        give_back(world, inputs);
    }
    #[cfg(not(feature = "actions"))]
    let _ = world;
}

/// [`ScriptTimer`] → `timeout`; `start_timer` timers → their method.
fn timers(world: &mut World, q: &mut QueryState<(Entity, &mut ScriptTimer)>) {
    let paused = tree_paused(world);
    let dt = frame_dt(world, paused);
    let mut fired: Vec<Entity> = vec![];
    let ents: Vec<Entity> = q.iter(world).map(|(e, _)| e).filter(|e| runs_now(world, *e, paused)).collect();
    for e in ents {
        let Ok((_, mut t)) = q.get_mut(world, e) else { continue };
        if !t.started {
            t.started = true;
            if t.autostart {
                t.left = Some(t.wait_time);
            }
        }
        if let Some(left) = t.left.as_mut() {
            *left -= dt;
            if *left <= 0.0 {
                fired.push(e);
                if t.one_shot {
                    t.left = None;
                } else {
                    let w = t.wait_time.max(0.001);
                    let l = t.left.unwrap_or(0.0);
                    t.left = Some(l + w);
                }
            }
        }
    }
    for e in fired {
        emit_signal(world, e, "timeout", &[]);
    }
    let mut due: Vec<(Entity, String)> = vec![];
    let go: Vec<bool> = world.resource::<ScriptQueue>().timers.iter().map(|t| runs_now(world, t.entity, paused)).collect();
    {
        let mut q = world.resource_mut::<ScriptQueue>();
        for (t, go) in q.timers.iter_mut().zip(go) {
            if !go {
                continue;
            }
            t.left -= dt;
            if t.left <= 0.0 {
                due.push((t.entity, t.method.clone()));
                if t.repeat {
                    // One call per frame at most; a long frame doesn't stop the timer.
                    let i = t.interval.max(0.001);
                    t.left = (t.left + i).max(t.left.rem_euclid(i)).max(0.0001);
                }
            }
        }
        q.timers.retain(|t| t.left > 0.0);
        let mut alive = std::mem::take(&mut q.timers);
        alive.retain(|t| world.get_entity(t.entity).is_ok());
        world.resource_mut::<ScriptQueue>().timers = alive;
    }
    for (e, m) in due {
        let _ = call_rv(world, e, &m, vec![]);
    }
}

/// UI buttons: `pressed` when `Pressed` is added (pointer down), `mouse_entered` /
/// `mouse_exited` when `Hovered` changes.
fn ui_signals(
    world: &mut World,
    pressed: &mut QueryState<Entity, (Added<bevy::ui::Pressed>, Without<bevy::ui::InteractionDisabled>)>,
    hovered: &mut QueryState<
        (Entity, Ref<bevy::picking::hover::Hovered>),
        (Changed<bevy::picking::hover::Hovered>, Without<bevy::ui::InteractionDisabled>),
    >,
) {
    let mut out: Vec<(Entity, &'static str)> = vec![];
    for (e, h) in hovered.iter(world) {
        if h.is_added() && !h.0 {
            continue;
        }
        out.push((e, if h.0 { "mouse_entered" } else { "mouse_exited" }));
    }
    for e in pressed.iter(world) {
        out.push((e, "pressed"));
    }
    let paused = tree_paused(world);
    for (e, s) in out {
        if runs_now(world, e, paused) {
            emit_signal(world, e, s, &[]);
        }
    }
}

/// Physics overlaps: `body_entered(other)` / `body_exited(other)` on both bodies.
#[cfg(feature = "physics")]
fn physics_signals(world: &mut World, mut cursor: Local<PhysicsCursor>) {
    use avian3d::prelude::{CollisionEnd, CollisionStart};
    let mut out: Vec<(Entity, &'static str, Entity)> = vec![];
    {
        let (Some(starts), Some(ends)) = (world.get_resource::<Messages<CollisionStart>>(), world.get_resource::<Messages<CollisionEnd>>()) else {
            return;
        };
        for s in cursor.start.read(starts) {
            let (a, b) = (s.body1.unwrap_or(s.collider1), s.body2.unwrap_or(s.collider2));
            out.push((a, "body_entered", b));
            out.push((b, "body_entered", a));
        }
        for s in cursor.end.read(ends) {
            let (a, b) = (s.body1.unwrap_or(s.collider1), s.body2.unwrap_or(s.collider2));
            out.push((a, "body_exited", b));
            out.push((b, "body_exited", a));
        }
    }
    for (e, s, other) in out {
        if world.get_entity(e).is_ok() {
            emit_signal(world, e, s, &[Value::Entity(other.to_bits())]);
        }
    }
}

#[cfg(feature = "physics")]
#[derive(Default)]
struct PhysicsCursor {
    start: bevy::ecs::message::MessageCursor<avian3d::prelude::CollisionStart>,
    end: bevy::ecs::message::MessageCursor<avian3d::prelude::CollisionEnd>,
}

/// End of frame: deferred calls, then `queue_free` (`_exit_tree` on the subtree, then despawn),
/// then a requested scene change.
fn flush(world: &mut World) {
    let paused = tree_paused(world);
    // Calls whose target may not run now (paused game): kept for when it may.
    let mut held_rv: Vec<(Entity, String, Vec<RV>)> = vec![];
    let mut held: Vec<(Entity, String, Vec<Value>)> = vec![];
    for _ in 0..8 {
        let rv_calls = std::mem::take(&mut world.non_send_mut::<ScriptRuntime>().deferred);
        let calls = std::mem::take(&mut world.resource_mut::<ScriptQueue>().calls);
        if calls.is_empty() && rv_calls.is_empty() {
            break;
        }
        for (e, m, a) in rv_calls {
            if world.get_entity(e).is_err() {
                continue;
            }
            let mode = effective_mode(world, e);
            if !mode.runs(paused) {
                if mode != ProcessMode::Disabled {
                    held_rv.push((e, m, a));
                }
                continue;
            }
            if let Err(err) = call_rv(world, e, &m, a)
                && !err.contains(".ruspy:")
            {
                diag(world, "call_deferred", 0, 0, format!("{e}.{m}: {err}"));
            }
        }
        for (e, m, a) in calls {
            if world.get_entity(e).is_err() {
                continue;
            }
            let mode = effective_mode(world, e);
            if !mode.runs(paused) {
                if mode != ProcessMode::Disabled {
                    held.push((e, m, a));
                }
                continue;
            }
            if let Err(err) = call(world, e, &m, &a)
                && !err.contains(".ruspy:")
            {
                diag(world, "call_deferred", 0, 0, format!("{e}.{m}: {err}"));
            }
        }
    }
    if !held_rv.is_empty() {
        world.non_send_mut::<ScriptRuntime>().deferred.extend(held_rv);
    }
    if !held.is_empty() {
        world.resource_mut::<ScriptQueue>().calls.extend(held);
    }
    let free = std::mem::take(&mut world.resource_mut::<ScriptQueue>().free);
    for e in free {
        if world.get_entity(e).is_err() {
            continue;
        }
        let mut sub = vec![];
        tree::descendants(world, e, &mut sub);
        // Children exit before their parent (Godot: exit_tree runs bottom-up).
        for &x in sub.iter().rev() {
            drop_instance(world, x, true);
        }
        drop_instance(world, e, true);
        if let Ok(em) = world.get_entity_mut(e) {
            em.despawn();
        }
    }
    #[cfg(feature = "level")]
    if let Some(path) = world.resource_mut::<ScriptQueue>().change_scene.take()
        && let Err(e) = crate::level::load_level(world, &path)
    {
        diag(world, "change_scene", 0, 0, format!("change_scene({path}): {e}"));
    }
}
