//! Test-only control port: TCP JSON lines (`--control <port>`, 0 picks a free port) and MCP over
//! stdio (`--mcp`), both speaking ashlar's protocol (`app.ping`, `engine.commands`,
//! `engine.execute`, `engine.batch`, …).
//!
//! ```text
//! ashlar_control::Server ──Request──▶ ControlInbox ──▶ PreUpdate `drain_control(&mut World)`
//!                                                       ├─ instant command → reply now
//!                                                       └─ deferred command → PendingReplies, answered later
//! ```
//!
//! On start the port prints `control: port=<n> key=<key file>` on stdout (tests and
//! `scripts/play.py` parse that line). The key file lives in [`DataDir`].
//!
//! Games add commands with [`AddControlCommand`]:
//!
//! ```ignore
//! #[cfg(feature = "devtools")]
//! app.add_control_command("enemy.kill", "Kill enemies", params(&[("id", "integer", "enemy id; all if omitted")]), kill);
//! ```

use std::io::Write as _;
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use ashlar_command::{CommandError, CommandInfo, Dispatch};
use ashlar_control::{AppInfo, Config, NoUi, Reply, Request, Server};
use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use serde_json::{Map, Value, json};

use crate::app::GameInfo;
use crate::cli::{arg_value, has_flag};
use crate::paths::DataDir;

/// An instant command: runs on the main thread with the whole world, answers immediately.
pub type CommandFn = fn(&mut World, Value) -> Result<Value, String>;

/// A multi-frame command: starts work and later answers with
/// [`PendingReplies::reply`]`(id, …)`. Returning `Err` answers at once with that error.
pub type DeferredFn = fn(&mut World, Value, ReplyId) -> Result<(), String>;

#[derive(Clone, Copy, Debug)]
pub enum Handler {
    Instant(CommandFn),
    Deferred(DeferredFn),
}

#[derive(Clone, Debug)]
pub struct ControlCommand {
    pub id: &'static str,
    pub label: &'static str,
    /// JSON Schema of the params object (see [`params`]).
    pub params_schema: Value,
    pub handler: Handler,
}

/// Every control command, by id. Extend it with [`AddControlCommand`].
#[derive(Resource, Clone, Debug, Default)]
pub struct ControlRegistry {
    commands: Vec<ControlCommand>,
}

impl ControlRegistry {
    /// Adds a command, replacing one with the same id.
    pub fn add(&mut self, cmd: ControlCommand) {
        match self.commands.binary_search_by(|c| c.id.cmp(cmd.id)) {
            Ok(i) => self.commands[i] = cmd,
            Err(i) => self.commands.insert(i, cmd),
        }
    }

    pub fn get(&self, id: &str) -> Option<&ControlCommand> {
        self.commands.binary_search_by(|c| c.id.cmp(id)).ok().map(|i| &self.commands[i])
    }

    pub fn iter(&self) -> impl Iterator<Item = &ControlCommand> {
        self.commands.iter()
    }
}

/// `app.add_control_command(id, label, schema, handler)`, its deferred (async-reply) variant, and
/// aliases (keep old command names working after a rename).
pub trait AddControlCommand {
    fn add_control_command(&mut self, id: &'static str, label: &'static str, params_schema: Value, handler: CommandFn) -> &mut Self;

    fn add_deferred_control_command(
        &mut self,
        id: &'static str,
        label: &'static str,
        params_schema: Value,
        handler: DeferredFn,
    ) -> &mut Self;

    /// Registers `alias` as another name for the already registered command `target`
    /// (e.g. `alias_control_command("game.quit", "engine.quit")`). No-op if `target` is unknown.
    fn alias_control_command(&mut self, alias: &'static str, target: &str) -> &mut Self;
}

/// Shroud's name for [`AddControlCommand`].
pub use AddControlCommand as ControlAppExt;

impl AddControlCommand for App {
    fn add_control_command(&mut self, id: &'static str, label: &'static str, params_schema: Value, handler: CommandFn) -> &mut Self {
        add(self, id, label, params_schema, Handler::Instant(handler))
    }

    fn add_deferred_control_command(
        &mut self,
        id: &'static str,
        label: &'static str,
        params_schema: Value,
        handler: DeferredFn,
    ) -> &mut Self {
        add(self, id, label, params_schema, Handler::Deferred(handler))
    }

    fn alias_control_command(&mut self, alias: &'static str, target: &str) -> &mut Self {
        let mut reg = self.world_mut().get_resource_or_init::<ControlRegistry>();
        if let Some(cmd) = reg.get(target).cloned() {
            reg.add(ControlCommand { id: alias, ..cmd });
        }
        self
    }
}

fn add<'a>(app: &'a mut App, id: &'static str, label: &'static str, params_schema: Value, handler: Handler) -> &'a mut App {
    app.world_mut()
        .get_resource_or_init::<ControlRegistry>()
        .add(ControlCommand { id, label, params_schema, handler });
    app
}

/// A params schema from `(name, json type, description)` triples. No param is required.
pub fn params(props: &[(&str, &str, &str)]) -> Value {
    let mut map = Map::new();
    for (name, ty, about) in props {
        map.insert((*name).into(), json!({"type": ty, "description": about}));
    }
    json!({"type": "object", "properties": map})
}

/// Handle to a request a deferred command answers later.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ReplyId(u64);

/// Requests held by deferred commands. A request dropped unanswered (e.g. at exit) replies with
/// an error by itself.
#[derive(Resource, Default)]
pub struct PendingReplies {
    next: u64,
    waiting: HashMap<u64, (&'static str, Request)>,
}

impl PendingReplies {
    fn hold(&mut self, command: &'static str, req: Request) -> ReplyId {
        self.next += 1;
        self.waiting.insert(self.next, (command, req));
        ReplyId(self.next)
    }

    /// Answers a held request. Returns `false` if it was already answered.
    pub fn reply(&mut self, id: ReplyId, result: Result<Value, String>) -> bool {
        match self.waiting.remove(&id.0) {
            Some((command, req)) => {
                req.reply(Reply::from_command(result.map_err(|m| CommandError::failed(command, m))));
                true
            }
            None => false,
        }
    }

    pub fn is_waiting(&self, id: ReplyId) -> bool {
        self.waiting.contains_key(&id.0)
    }
}

/// Where requests arrive from (the TCP server, the MCP thread).
#[derive(Resource, Default)]
struct ControlInbox(Mutex<Vec<Receiver<Request>>>);

/// Keeps the TCP server (and its key file) alive.
#[derive(Resource)]
struct ControlServer(#[allow(dead_code)] Server);

/// Name + version the port reports (`app.version`), from [`GameInfo`].
#[derive(Resource, Clone)]
struct ControlAppInfo {
    id: String,
    version: String,
}

/// Ordering: requests are drained in `PreUpdate` before Bevy's input systems, so injected input
/// (`input.key`, `input.mouse`) lands in the same frame.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct ControlDrain;

/// The port itself. Added by [`super::DevtoolsPlugin`]; the server starts in `finish` so
/// [`GameInfo`] and [`DataDir`] are available whatever the plugin order.
pub struct ControlPlugin;

impl Plugin for ControlPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ControlRegistry>()
            .init_resource::<PendingReplies>()
            .init_resource::<ControlInbox>()
            .configure_sets(PreUpdate, ControlDrain.before(bevy::input::InputSystems))
            .add_systems(PreUpdate, drain_control.in_set(ControlDrain));
    }

    fn finish(&self, app: &mut App) {
        let info = app.world().get_resource::<GameInfo>().cloned();
        let (id, title, version) = match &info {
            Some(i) => (i.id.to_string(), i.title.to_string(), i.version.to_string()),
            None => ("game".to_string(), "Game".to_string(), env!("CARGO_PKG_VERSION").to_string()),
        };
        app.insert_resource(ControlAppInfo { id: id.clone(), version: version.clone() });

        if let Some(port) = arg_value("control") {
            let Ok(port) = port.parse::<u16>() else {
                eprintln!("--control needs a port number (0 picks a free one), got `{port}`");
                std::process::exit(2);
            };
            let dir = key_dir(app);
            // `wake` is a no-op: the app updates every frame anyway.
            match Server::start(Config::new(port, dir), || {}) {
                Ok((server, rx)) => {
                    println!("control: port={} key={}", server.port(), server.key_file().display());
                    let _ = std::io::stdout().flush();
                    push_inbox(app, rx);
                    app.insert_resource(ControlServer(server));
                }
                Err(e) => {
                    eprintln!("control server: {e}");
                    std::process::exit(2);
                }
            }
        }

        if has_flag("mcp") {
            let (tx, rx) = channel();
            push_inbox(app, rx);
            start_mcp(tx, id, title, version);
        }
    }
}

/// [`DataDir`] if the engine set one up, else a temp folder (never the cwd).
fn key_dir(app: &App) -> std::path::PathBuf {
    let dir = app
        .world()
        .get_resource::<DataDir>()
        .map(|d| d.0.clone())
        .unwrap_or_else(|| std::env::temp_dir().join("engine-control"));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn push_inbox(app: &mut App, rx: Receiver<Request>) {
    if let Ok(mut v) = app.world().resource::<ControlInbox>().0.lock() {
        v.push(rx);
    }
}

/// PreUpdate: answer every queued request.
fn drain_control(world: &mut World) {
    let reqs: Vec<Request> = match world.resource::<ControlInbox>().0.lock() {
        Ok(rxs) => rxs.iter().flat_map(|rx| rx.try_iter()).collect(),
        Err(_) => return,
    };
    if reqs.is_empty() {
        return;
    }
    let registry = world.resource::<ControlRegistry>().clone();
    let app = world.get_resource::<ControlAppInfo>().cloned();
    let info = match &app {
        Some(a) => AppInfo::new(&a.id, &a.version),
        None => AppInfo::new("game", env!("CARGO_PKG_VERSION")),
    };
    for req in reqs {
        if let Some((cmd, f)) = deferred_target(&req, &registry) {
            let p = command_params(req.params());
            let id = world.resource_mut::<PendingReplies>().hold(cmd, req);
            if let Err(e) = f(world, p, id) {
                world.resource_mut::<PendingReplies>().reply(id, Err(e));
            }
            continue;
        }
        let mut dispatch = WorldDispatch { world, registry: &registry };
        ashlar_control::handle(req, &mut dispatch, &mut NoUi, &info);
    }
}

/// `engine.execute` of a deferred command.
fn deferred_target(req: &Request, registry: &ControlRegistry) -> Option<(&'static str, DeferredFn)> {
    if req.method() != "engine.execute" {
        return None;
    }
    let cmd = registry.get(req.params().get("command")?.as_str()?)?;
    match cmd.handler {
        Handler::Deferred(f) => Some((cmd.id, f)),
        Handler::Instant(_) => None,
    }
}

fn command_params(p: &Value) -> Value {
    match p.get("params") {
        None | Some(Value::Null) => json!({}),
        Some(v) => v.clone(),
    }
}

/// [`Dispatch`] over the world for the standard methods. Deferred commands are answered by
/// `drain_control` itself (they cannot be part of `engine.batch`).
struct WorldDispatch<'a> {
    world: &'a mut World,
    registry: &'a ControlRegistry,
}

impl Dispatch for WorldDispatch<'_> {
    fn commands(&self) -> Vec<CommandInfo> {
        self.registry
            .iter()
            .map(|c| CommandInfo {
                id: c.id.into(),
                label: c.label.into(),
                menu: Vec::new(),
                shortcut: None,
                params_schema: c.params_schema.clone(),
                params_text: None,
                enabled: true,
                disabled_reason: None,
                mutates: false,
            })
            .collect()
    }

    fn execute(&mut self, id: &str, params: Value) -> Result<Value, CommandError> {
        let Some(cmd) = self.registry.get(id) else {
            return Err(CommandError::Unknown { id: id.into() });
        };
        let params = if params.is_null() { json!({}) } else { params };
        if !params.is_object() {
            return Err(CommandError::bad_params(id, "params must be an object"));
        }
        match cmd.handler {
            Handler::Instant(f) => f(self.world, params).map_err(|m| CommandError::failed(id, m)),
            Handler::Deferred(_) => Err(CommandError::failed(
                id,
                format!("`{id}` takes several frames; call it with engine.execute, not in a batch"),
            )),
        }
    }
}

/// MCP on stdio, on its own thread. Every tool call is forwarded to the game thread as a control
/// request, so deferred commands work too. When stdin closes the game quits.
fn start_mcp(tx: Sender<Request>, id: String, title: String, version: String) {
    let spawn = std::thread::Builder::new().name("mcp".into()).spawn(move || {
        let opts = ashlar_mcp::ServerOptions::new(&id, &version).instructions(format!(
            "{title}, a game built on Bevy. Drive a test session with engine.commands to list \
             commands, then e.g. engine.state, engine.start, time.step, input.key, screenshot, \
             perf.stats, plus the game's own commands."
        ));
        let dispatch = ChannelDispatch { tx: tx.clone() };
        let mut server = ashlar_mcp::McpServer::new(ashlar_mcp::Backend::Headless(Box::new(dispatch)), opts);
        if let Err(e) = server.serve(std::io::BufReader::new(std::io::stdin()), std::io::stdout()) {
            eprintln!("mcp: {e}");
        }
        let (quit, _) = Request::new("engine.execute", json!({"command": "engine.quit"}));
        let _ = tx.send(quit);
    });
    if let Err(e) = spawn {
        eprintln!("mcp: cannot start: {e}");
    }
}

/// A [`Dispatch`] that hands calls to the game thread and waits for the answer.
struct ChannelDispatch {
    tx: Sender<Request>,
}

impl ChannelDispatch {
    fn call(&self, method: &str, params: Value) -> Result<Value, (String, Option<Value>)> {
        let (req, rx) = Request::new(method, params);
        self.tx.send(req).map_err(|_| ("the game has quit".to_string(), None))?;
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(reply) => reply.into_result(),
            Err(_) => Err(("timeout waiting for the game".to_string(), None)),
        }
    }
}

impl Dispatch for ChannelDispatch {
    fn commands(&self) -> Vec<CommandInfo> {
        self.call("engine.commands", json!({}))
            .ok()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    fn execute(&mut self, id: &str, params: Value) -> Result<Value, CommandError> {
        self.call("engine.execute", json!({"command": id, "params": params}))
            .map_err(|(msg, detail)| {
                detail
                    .and_then(|d| serde_json::from_value::<CommandError>(d).ok())
                    .unwrap_or_else(|| CommandError::failed(id, msg))
            })
    }
}
