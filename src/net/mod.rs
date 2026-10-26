//! Multiplayer networking (feature `net`): server-authoritative replication with delta
//! snapshots, interest management and bandwidth budgets, client-side prediction with
//! rollback/replay, snapshot interpolation, typed messages, over UDP or an in-memory loopback.
//! Everything is code: register what replicates with [`NetAppExt`], start with [`host`] /
//! [`connect`] (or `--server`, `--host`, `--connect <addr>`), inspect with `net.*` control
//! commands. See docs/NET.md.
//!
//! Layers (each usable alone):
//! ```text
//! wire        varints, quantisation, seq numbers
//! transport   Transport trait: LoopbackNet (tests) | UdpTransport;  Conditioner (lag/loss sim)
//! connection  acks, RTT, reliable-ordered / unreliable / sequenced channels, fragments, budget
//! endpoint    handshake (challenge, protocol check), keepalive, timeouts → ServerEndpoint / ClientEndpoint
//! server      Replicated → NetId, per-client delta snapshots vs last acked state, relevancy, priority
//! client      entity mapping, snapshot apply, interpolation, tick sync
//! predict     input buffers, prediction step, reconciliation (rollback + replay)
//! ```
//!
//! Schedules: `PreUpdate` receive → reconcile → deliver messages; `FixedPreUpdate` tick + inputs;
//! `FixedUpdate` prediction steps (with the game's own simulation); `FixedLast` server
//! snapshots; `PostUpdate` interpolation (before transform propagation); `Last` send.
//! With no server/client running every system is skipped by a resource check.

use std::net::SocketAddr;

use bevy::prelude::*;

pub mod client;
pub mod connection;
pub mod endpoint;
pub mod lagcomp;
pub(crate) mod messages;
pub mod predict;
pub mod registry;
pub mod server;
pub mod transport;
pub mod wire;

#[cfg(feature = "devtools")]
mod commands;

pub use connection::{Channel, ConnStats, ConnectionConfig, DisconnectReason};
pub use endpoint::{ClientEndpoint, ClientId, ClientStatus, ServerEndpoint};
pub use lagcomp::{LagCompensated, LagCompensation};
pub use messages::NetSender;
pub use predict::{LocalInput, NetInput, PredictionHistory, PredictionStats};
pub use registry::{Codec, Confirmed, FromClient, FromServer, NetAppExt, NetHistory, NetId, NetOwner, NetRegistry, Postcard, TransformCodec};
pub use transport::{LinkConditioner, LoopbackNet, LoopbackTransport, Transport, UdpTransport};

/// Default UDP port for `--server` / `--host` / `--connect host` without a port.
pub const DEFAULT_PORT: u16 = 7777;

/// Networking settings. Build with `..default()`.
#[derive(Resource, Clone, Debug)]
pub struct NetConfig {
    /// Simulation / network tick rate. With `set_fixed_timestep` it drives `Time<Fixed>`.
    pub tick_hz: f64,
    pub set_fixed_timestep: bool,
    /// Snapshot every N ticks (1 = every tick).
    pub send_interval: u32,
    pub connection: ConnectionConfig,
    pub max_clients: usize,
    /// Bump when the game's wire format changes without the registration list changing.
    pub protocol_version: u32,
    /// Entities farther than this from a client's viewpoint are not sent (and despawned on that
    /// client). `None` = everything is relevant to everyone.
    pub relevancy_radius: Option<f32>,
    /// Priority = `NetPriority × 1 / (1 + distance / priority_falloff)`, accumulated per tick
    /// until sent, so far entities update less often but never starve.
    pub priority_falloff: f32,
    /// Max snapshot bytes per client per tick (also capped by the link's bandwidth budget).
    pub snapshot_bytes_per_tick: usize,
    /// Server: ticks of `LagCompensated` transform history kept for rewound hit tests
    /// (0 = off). 30–60 covers typical pings + interpolation delay.
    pub lag_compensation_ticks: u32,
    /// Send changed components as byte deltas against the client's last acked value.
    pub delta_compression: bool,
    /// Remote entities are shown this far in the past, between two received snapshots.
    pub interpolation_delay_s: f32,
    /// Inputs should reach the server this many ticks before it simulates them.
    pub input_lead_ticks: f32,
    /// Each input packet repeats the last N inputs (survives N-1 consecutive losses).
    pub input_redundancy: u8,
    /// Client: connected → `AppState::InGame`, disconnected → `AppState::MainMenu`.
    pub drive_app_state: bool,
    /// Applied to endpoints when they start (change live with `net.conditioner`).
    pub conditioner: LinkConditioner,
    /// Seeds handshake salts (fixed in tests for determinism).
    pub seed: u64,
}

impl Default for NetConfig {
    fn default() -> Self {
        NetConfig {
            tick_hz: 60.0,
            set_fixed_timestep: true,
            send_interval: 1,
            connection: ConnectionConfig::default(),
            max_clients: 64,
            protocol_version: 1,
            relevancy_radius: None,
            priority_falloff: 25.0,
            snapshot_bytes_per_tick: 16 * 1024,
            delta_compression: true,
            lag_compensation_ticks: 0,
            interpolation_delay_s: 0.1,
            input_lead_ticks: 2.0,
            input_redundancy: 4,
            drive_app_state: true,
            conditioner: LinkConditioner::default(),
            seed: 0x5eed,
        }
    }
}

/// Which side of the network this app is.
#[derive(Resource, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NetRole {
    #[default]
    Offline,
    /// Dedicated server (no local player).
    Server,
    /// Server with a local player ([`ClientId::HOST`]).
    ListenServer,
    Client,
}

impl NetRole {
    pub fn is_server(self) -> bool {
        matches!(self, NetRole::Server | NetRole::ListenServer)
    }
}

/// Connection lifecycle, as a Bevy state (gate systems with `in_state(NetState::InGame)`).
#[derive(States, Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum NetState {
    #[default]
    Offline,
    Connecting,
    /// Connected client, or a running server.
    InGame,
    Disconnected,
}

/// Lifecycle messages (`MessageReader<NetEvent>`).
#[derive(Message, Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetEvent {
    /// Server: a client finished the handshake.
    ClientConnected(ClientId),
    ClientDisconnected(ClientId, DisconnectReason),
    /// Client: we are in, with this id.
    Connected(ClientId),
    Disconnected(DisconnectReason),
}

/// Tick bookkeeping, valid on both sides.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct NetClock {
    /// Server: the authoritative tick. Client: the predicted tick (ahead of the server by
    /// about RTT + `input_lead_ticks`).
    pub tick: u32,
    /// Client: estimate of the server's current tick (fractional).
    pub server_tick: f64,
    /// Client: the (fractional) server tick remote entities are drawn at.
    pub render_tick: f64,
    pub tick_dt: f32,
    /// Client: newest snapshot tick received.
    pub latest_snapshot: u32,
    /// Client: ticks the prediction clock was resynced (jumps).
    pub resyncs: u32,
}

// ---- markers ----

/// Server: replicate this entity (assigns a [`NetId`]). Add the components to send with
/// [`NetAppExt::replicate`].
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Replicated;

/// Sent to every client regardless of `relevancy_radius`.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct AlwaysRelevant;

/// Replication priority weight (default 1).
#[derive(Component, Clone, Copy, Debug)]
pub struct NetPriority(pub f32);

/// Server: this owned entity is its client's viewpoint for relevancy (else the first entity
/// the client owns is used).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct NetViewer;

/// Client: an entity mirrored from the server.
#[derive(Component, Clone, Copy, Debug)]
pub struct Remote;

/// Client: remote entity drawn from interpolated snapshots.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Interpolated;

/// Client: our own entity, predicted locally and reconciled with the server.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Predicted;

/// System sets, in schedule order (see the module docs).
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NetSet {
    Receive,
    Reconcile,
    Deliver,
    Tick,
    Input,
    Predict,
    Snapshot,
    Interpolate,
    Send,
}

/// The running server (`host`).
#[derive(Resource)]
pub struct NetServer {
    pub endpoint: ServerEndpoint,
    pub(crate) repl: server::ServerRepl,
}

impl NetServer {
    pub fn stats(&self) -> server::ServerStats {
        self.repl.stats
    }
    /// Override (or with `None`, clear) a client's relevancy viewpoint.
    pub fn set_viewpoint(&mut self, client: ClientId, at: Option<Vec3>) {
        self.repl.set_viewpoint(client, at);
    }
    /// Entities currently known to `client` (sent and not despawned).
    pub fn entities_known_by(&self, client: ClientId) -> usize {
        self.repl.known_by(client)
    }
}

/// The running client (`connect`).
#[derive(Resource)]
pub struct NetClient {
    pub endpoint: ClientEndpoint,
    pub(crate) repl: client::ClientRepl,
}

impl NetClient {
    /// Local entity of a server [`NetId`].
    pub fn entity(&self, id: NetId) -> Option<Entity> {
        self.repl.entity(id)
    }
    pub fn stats(&self) -> client::ClientStats {
        self.repl.stats
    }
    pub fn id(&self) -> Option<ClientId> {
        self.endpoint.id
    }
}

pub(crate) fn now(world: &World) -> f64 {
    world.get_resource::<Time<Real>>().map_or(0.0, |t| t.elapsed_secs_f64())
}

/// Protocol id this app would use (registered set + `NetConfig` wire options); peers must match.
pub fn protocol_id(world: &World) -> u64 {
    let cfg = world.resource::<NetConfig>();
    let v = cfg.protocol_version ^ (u32::from(cfg.delta_compression) << 31);
    world.get_resource::<NetRegistry>().map_or(v as u64, |r| r.protocol_id(v))
}

pub(crate) fn apply_timestep(world: &mut World) {
    let cfg = world.resource::<NetConfig>().clone();
    if cfg.set_fixed_timestep {
        world.resource_mut::<Time<Fixed>>().set_timestep_hz(cfg.tick_hz);
    }
    world.resource_mut::<NetClock>().tick_dt = (1.0 / cfg.tick_hz) as f32;
}

/// Start a server on `transport`. `listen`: this app also has a local player
/// ([`ClientId::HOST`]), fed from [`LocalInput`]. Replaces a running server or client.
pub fn host(world: &mut World, transport: impl Transport, listen: bool) {
    stop(world, DisconnectReason::Requested);
    apply_timestep(world);
    let cfg = world.resource::<NetConfig>().clone();
    let mut endpoint = ServerEndpoint::new(Box::new(transport), cfg.connection, protocol_id(world), cfg.max_clients, cfg.seed);
    endpoint.conditioner.set(cfg.conditioner);
    endpoint.tick_hz = cfg.tick_hz.round() as u16;
    let n = world.get_resource::<NetRegistry>().map_or(0, |r| r.components.len());
    info!("net: hosting on {} ({})", endpoint.local_addr(), if listen { "listen server" } else { "dedicated" });
    world.insert_resource(NetServer { endpoint, repl: server::ServerRepl::new(n) });
    *world.resource_mut::<NetRole>() = if listen { NetRole::ListenServer } else { NetRole::Server };
    *world.resource_mut::<NetClock>() = NetClock { tick_dt: (1.0 / cfg.tick_hz) as f32, ..default() };
    world.resource_mut::<NextState<NetState>>().set(NetState::InGame);
}

/// Connect to `server` over `transport`. Replaces a running server or client.
pub fn connect(world: &mut World, transport: impl Transport, server: SocketAddr) {
    stop(world, DisconnectReason::Requested);
    apply_timestep(world);
    let cfg = world.resource::<NetConfig>().clone();
    let t = now(world);
    let mut endpoint = ClientEndpoint::new(Box::new(transport), server, cfg.connection, protocol_id(world), cfg.seed ^ rand::random::<u64>(), t);
    endpoint.conditioner.set(cfg.conditioner);
    info!("net: connecting to {server} from {}", endpoint.local_addr());
    let mut repl = client::ClientRepl::default();
    repl.keep_baselines = cfg.delta_compression;
    world.insert_resource(NetClient { endpoint, repl });
    *world.resource_mut::<NetRole>() = NetRole::Client;
    *world.resource_mut::<NetClock>() = NetClock { tick_dt: (1.0 / cfg.tick_hz) as f32, ..default() };
    world.resource_mut::<NextState<NetState>>().set(NetState::Connecting);
}

/// [`host`] on UDP `0.0.0.0:<port>`; returns the bound address.
pub fn host_udp(world: &mut World, port: u16, listen: bool) -> std::io::Result<SocketAddr> {
    let t = UdpTransport::bind(SocketAddr::from(([0, 0, 0, 0], port)))?;
    let a = t.local_addr();
    host(world, t, listen);
    Ok(a)
}

/// [`connect`] over UDP from an ephemeral port.
pub fn connect_udp(world: &mut World, server: SocketAddr) -> std::io::Result<()> {
    let bind: SocketAddr = if server.is_ipv4() { ([0, 0, 0, 0], 0).into() } else { "[::]:0".parse().unwrap() };
    let t = UdpTransport::bind(bind)?;
    connect(world, t, server);
    Ok(())
}

/// Leave / shut down. Clients see `DisconnectReason::ServerShutdown`.
pub fn disconnect(world: &mut World) {
    stop(world, DisconnectReason::Requested);
}

fn stop(world: &mut World, reason: DisconnectReason) {
    let t = now(world);
    let mut changed = false;
    if let Some(mut s) = world.remove_resource::<NetServer>() {
        s.endpoint.shutdown(t);
        changed = true;
        server::despawn_all_tracking(world);
    }
    if let Some(mut c) = world.remove_resource::<NetClient>() {
        c.endpoint.close(t, reason);
        client::despawn_remotes(world, &mut c.repl);
        world.write_message(NetEvent::Disconnected(reason));
        changed = true;
    }
    if changed {
        *world.resource_mut::<NetRole>() = NetRole::Offline;
        apply_timestep(world); // undo the client clock steering
        world.resource_mut::<NextState<NetState>>().set(NetState::Offline);
    }
}

/// Set the link conditioner (simulated latency/loss on outgoing packets) on the running
/// endpoint and for endpoints started later.
pub fn set_conditioner(world: &mut World, c: LinkConditioner) {
    world.resource_mut::<NetConfig>().conditioner = c;
    if let Some(mut s) = world.get_resource_mut::<NetServer>() {
        s.endpoint.conditioner.set(c);
    }
    if let Some(mut cl) = world.get_resource_mut::<NetClient>() {
        cl.endpoint.conditioner.set(c);
    }
}

/// Parse `--connect` style addresses: `host:port`, `host` (default port), `:port`.
pub fn parse_addr(s: &str) -> Option<SocketAddr> {
    use std::net::ToSocketAddrs;
    let s = s.trim();
    if let Ok(a) = s.parse::<SocketAddr>() {
        return Some(a);
    }
    if let Some(p) = s.strip_prefix(':') {
        return p.parse::<u16>().ok().map(|p| SocketAddr::from(([127, 0, 0, 1], p)));
    }
    let with_port = if s.contains(':') { s.to_string() } else { format!("{s}:{DEFAULT_PORT}") };
    with_port.to_socket_addrs().ok()?.next()
}

/// What the command line asked for (`--server [port]`, `--host [port]`, `--connect <addr>`).
/// These are player-facing flags (they work in ship builds: dedicated servers ship).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetLaunch {
    Server(u16),
    Host(u16),
    Connect(SocketAddr),
}

impl NetLaunch {
    pub fn from_args() -> Option<Self> {
        let port = |name: &str| {
            crate::cli::arg_value(name).and_then(|v| v.trim_start_matches(':').parse::<u16>().ok()).unwrap_or(DEFAULT_PORT)
        };
        if crate::cli::has_flag("server") {
            Some(NetLaunch::Server(port("server")))
        } else if crate::cli::has_flag("host") {
            Some(NetLaunch::Host(port("host")))
        } else {
            crate::cli::arg_value("connect").and_then(|a| parse_addr(&a)).map(NetLaunch::Connect)
        }
    }
}

/// `--server` on the command line (the engine boots headless for it).
pub fn dedicated_server_flag() -> bool {
    crate::cli::has_flag("server")
}

/// Adds the networking runtime (idle until [`host`]/[`connect`]). `EnginePlugin` adds it when
/// the `net` feature is on; `launch` defaults to the command line.
pub struct NetPlugin {
    pub launch: Option<NetLaunch>,
}

impl Default for NetPlugin {
    fn default() -> Self {
        NetPlugin { launch: NetLaunch::from_args() }
    }
}

#[derive(Resource)]
struct PendingLaunch(Option<NetLaunch>);

impl Plugin for NetPlugin {
    fn build(&self, app: &mut App) {
        registry::registry(app);
        app.init_resource::<NetConfig>()
            .init_resource::<NetRole>()
            .init_resource::<NetClock>()
            .init_resource::<PredictionStats>()
            .init_resource::<LagCompensation>()
            .init_resource::<messages::NetOutbox>()
            .init_resource::<messages::MessageDecoders>()
            .init_resource::<predict::InputDecoders>()
            .init_state::<NetState>()
            .add_message::<NetEvent>()
            .insert_resource(PendingLaunch(self.launch))
            .configure_sets(PreUpdate, (NetSet::Receive, NetSet::Reconcile, NetSet::Deliver).chain())
            .configure_sets(FixedPreUpdate, (NetSet::Tick, NetSet::Input).chain())
            .configure_sets(FixedUpdate, NetSet::Predict)
            .configure_sets(FixedLast, NetSet::Snapshot)
            .configure_sets(PostUpdate, NetSet::Interpolate.before(bevy::transform::TransformSystems::Propagate))
            .configure_sets(Last, NetSet::Send)
            .add_systems(Startup, launch_from_args)
            .add_systems(
                PreUpdate,
                (
                    server::receive.run_if(resource_exists::<NetServer>),
                    client::receive.run_if(resource_exists::<NetClient>),
                )
                    .chain()
                    .in_set(NetSet::Receive),
            )
            .add_systems(
                FixedPreUpdate,
                (server::advance_tick.run_if(resource_exists::<NetServer>), client::advance_tick.run_if(resource_exists::<NetClient>))
                    .in_set(NetSet::Tick),
            )
            .add_systems(
                FixedLast,
                (server::snapshot, lagcomp::record.run_if(|c: Res<NetConfig>| c.lag_compensation_ticks > 0))
                    .run_if(resource_exists::<NetServer>)
                    .in_set(NetSet::Snapshot),
            )
            .add_systems(PostUpdate, client::update_render_clock.run_if(resource_exists::<NetClient>).before(NetSet::Interpolate))
            .add_systems(Last, messages::send.in_set(NetSet::Send))
            .add_systems(Update, server::assign_ids.run_if(resource_exists::<NetServer>))
            .add_systems(FixedLast, server::assign_ids.run_if(resource_exists::<NetServer>).before(NetSet::Snapshot));
        #[cfg(feature = "devtools")]
        commands::register(app);
    }
}

fn launch_from_args(world: &mut World) {
    let Some(launch) = world.resource_mut::<PendingLaunch>().0.take() else { return };
    let r = match launch {
        NetLaunch::Server(p) => host_udp(world, p, false).map(|_| ()),
        NetLaunch::Host(p) => host_udp(world, p, true).map(|_| ()),
        NetLaunch::Connect(a) => connect_udp(world, a),
    };
    if let Err(e) = r {
        error!("net: {launch:?} failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_addresses() {
        assert_eq!(parse_addr("127.0.0.1:9000"), Some("127.0.0.1:9000".parse().unwrap()));
        assert_eq!(parse_addr(":9001"), Some("127.0.0.1:9001".parse().unwrap()));
        assert_eq!(parse_addr("127.0.0.1"), Some("127.0.0.1:7777".parse().unwrap()));
        assert!(NetLaunch::from_args().is_none(), "test binary has no net flags");
    }
}
