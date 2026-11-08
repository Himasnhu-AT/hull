//! Friends co-op sessions on top of the server-authoritative net layer: one player hosts, the
//! others join with a short invite code.
//!
//! ```text
//! host: Session::host(world, cfg)  -> relay says "code ABC234"  (SessionEvent::Hosting)
//! join: Session::join(world, cfg, "ABC234") -> relay introduces both, they punch a hole through
//!       their NATs; if that fails the relay forwards the packets  (SessionEvent::Joined{route})
//! ```
//!
//! Layers (all in this module, all usable on their own):
//! - [`proto`] / [`relay`]: the tiny UDP rendezvous + relay server (the `relay` binary).
//! - [`route`]: [`SessionTransport`], a net `Transport` that hides direct / relayed paths, and
//!   [`SimNat`] to test them.
//! - this file: [`Session`] (state machine), the hello handshake (shared world seed + game
//!   version), peer list, join-in-progress, graceful leave, host migration, and the
//!   [`SessionHooks`] the game implements.

pub mod proto;
pub mod relay;
pub mod route;

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;

use bevy::ecs::system::RunSystemOnce;
use bevy::prelude::*;
use serde::{Deserialize, Serialize};

use self::proto::{Msg, Refusal};
use self::route::{NatKind, Role, Route, Shared, SharedRef, SimNat, SessionTransport, VIRT_HOST};
use super::registry::NetId;
use super::transport::{Transport, UdpTransport};
use super::{Channel, ClientId, DisconnectReason, NetClient, NetEvent, NetSender, NetServer, now};
use super::{FromClient, FromServer, NetAppExt};

pub use self::route::PathStats;

/// Default UDP port of the relay binary.
pub const DEFAULT_RELAY_PORT: u16 = 7788;

/// Makes the socket a session uses (default: UDP on an ephemeral port). Tests pass loopback
/// sockets; a migrating peer asks for a fresh one.
pub type SocketFactory = Arc<dyn Fn() -> io::Result<Box<dyn Transport>> + Send + Sync>;

#[derive(Clone)]
pub struct SessionConfig {
    /// Rendezvous / relay server.
    pub relay: SocketAddr,
    /// Peers with different versions cannot join each other (mixed into the net protocol id).
    pub game_version: u32,
    /// Carried to every guest in the hello so all peers can build the same world locally.
    pub world_seed: u64,
    /// Shown in the peer list.
    pub name: String,
    pub socket: SocketFactory,
    /// Wrap the socket in a simulated NAT (tests, tooling).
    pub simulate_nat: Option<NatKind>,
    /// Hole punching is given up (and the relay used) after this long.
    pub punch_timeout_s: f64,
    /// Skip punching entirely.
    pub force_relay: bool,
    /// A join that has no answer after this long fails.
    pub join_timeout_s: f64,
    /// Host re-registers with the relay this often (keeps the room alive).
    pub keepalive_s: f64,
    /// The host takes part in the game (listen server) rather than being dedicated.
    pub host_plays: bool,
    /// Elect a new host when the host disappears.
    pub migrate: bool,
    /// Guests wait this long before trying to rejoin after the host is lost (the successor
    /// needs a moment to take the room over).
    pub migration_delay_s: f64,
    /// One election round; after it the next candidate is tried.
    pub migration_timeout_s: f64,
    /// How long a leaving host keeps the link up so guests receive `HostLeaving`.
    pub leave_grace_s: f64,
}

impl SessionConfig {
    pub fn new(relay: SocketAddr) -> Self {
        SessionConfig {
            relay,
            game_version: 1,
            world_seed: 0,
            name: "player".into(),
            socket: Arc::new(|| UdpTransport::bind(SocketAddr::from(([0, 0, 0, 0], 0))).map(|t| Box::new(t) as Box<dyn Transport>)),
            simulate_nat: None,
            punch_timeout_s: 1.5,
            force_relay: false,
            join_timeout_s: 8.0,
            keepalive_s: 5.0,
            host_plays: true,
            migrate: true,
            migration_delay_s: 1.0,
            migration_timeout_s: 8.0,
            leave_grace_s: 0.3,
        }
    }
}

/// Shared by every peer of a session: lets all of them build the same world.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub game_version: u32,
    pub world_seed: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerInfo {
    pub id: u32,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionRole {
    Host,
    Guest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteKind {
    Pending,
    Direct,
    Relayed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionPhase {
    /// Host: waiting for the relay to hand out the invite code.
    Registering,
    Hosting,
    /// Guest: asking the relay for the host.
    Joining,
    Punching,
    /// Path chosen; net handshake and hello in flight.
    Connecting,
    InSession,
    /// The host is gone; electing / rejoining.
    Migrating,
    /// Host leaving gracefully (link kept up for a moment).
    Leaving,
    Failed,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionError {
    Timeout,
    NoSuchRoom,
    BadToken,
    VersionMismatch,
    HostFull,
    Net(DisconnectReason),
}

/// Lifecycle notifications (`MessageReader<SessionEvent>`).
#[derive(Message, Clone, Debug, PartialEq)]
pub enum SessionEvent {
    /// Host: the invite code is ready.
    Hosting { code: String },
    /// Guest: in. Build the world from `info.world_seed`.
    Joined { info: SessionInfo, my_id: ClientId, route: RouteKind },
    PeerJoined(PeerInfo),
    PeerLeft { id: u32, graceful: bool },
    /// The host announced it is leaving.
    HostLeaving,
    /// The host is gone; `i_am_successor` says whether this peer takes over.
    Migrating { i_am_successor: bool },
    /// A new host serves the session (this peer, or another one we rejoined).
    HostMigrated { i_am_host: bool },
    Left,
    Failed(SessionError),
}

/// What the game contributes to a session. Every method has a default.
pub trait SessionHooks: Send + Sync + 'static {
    /// Host: extra state for a peer that just joined (things that are not replicated), sent
    /// reliably; arrives in [`SessionHooks::apply_welcome`]. Replicated entities need nothing:
    /// a late joiner always receives a full snapshot.
    fn welcome(&mut self, _world: &mut World, _peer: ClientId) -> Option<Vec<u8>> {
        None
    }
    /// Guest: the welcome blob of the host.
    fn apply_welcome(&mut self, _world: &mut World, _bytes: &[u8]) {}
    /// Elected successor, before it starts hosting: turn the mirrors this peer was showing into
    /// authoritative entities. The default [`promote_mirrors`] strips the client-side markers
    /// and re-marks them `Replicated`. Ownership (`NetOwner`) and game-side resources (scores,
    /// inventories) are the game's business: peers get new `ClientId`s from the new host.
    fn promote(&mut self, world: &mut World, mirrors: &[(NetId, Entity)]) {
        promote_mirrors(world, mirrors);
    }
}

struct DefaultHooks;
impl SessionHooks for DefaultHooks {}

#[derive(Resource)]
pub struct SessionHooksRes(pub Box<dyn SessionHooks>);

impl Default for SessionHooksRes {
    fn default() -> Self {
        SessionHooksRes(Box::new(DefaultHooks))
    }
}

/// Default migration promotion: mirrors become authoritative `Replicated` entities.
pub fn promote_mirrors(world: &mut World, mirrors: &[(NetId, Entity)]) {
    for (_, e) in mirrors {
        if let Ok(mut em) = world.get_entity_mut(*e) {
            em.remove::<(super::Remote, super::Interpolated, super::Predicted, NetId)>();
            em.insert(super::Replicated);
        }
    }
}

/// Reliable session messages (registered by the plugin on both sides).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum SessionMsg {
    /// Host -> guest right after the handshake.
    Hello { info: SessionInfo, your_id: u32, code: String, token: u64 },
    /// Host -> guest: game-defined join-in-progress state.
    Welcome(Vec<u8>),
    /// Guest -> host.
    Name(String),
    /// Host -> everyone: the current peers (host first).
    Peers(Vec<PeerInfo>),
    HostLeaving,
}

#[derive(Resource)]
pub struct Session {
    pub role: SessionRole,
    pub phase: SessionPhase,
    pub cfg: SessionConfig,
    /// The invite code (host: once registered; guest: what it joined).
    pub code: Option<String>,
    pub info: SessionInfo,
    pub route: RouteKind,
    pub my_id: Option<ClientId>,
    /// Everyone in the session, host first, as last announced by the host.
    pub peers: Vec<PeerInfo>,
    pub error: Option<SessionError>,
    /// Number of host elections this session went through.
    pub migrations: u32,
    token: u64,
    shared: SharedRef,
    started: f64,
    last_tx: f64,
    last_keepalive: f64,
    punch_targets: Vec<(SocketAddr, f64)>,
    host_real: Option<SocketAddr>,
    leave_at: Option<f64>,
    attempt: u32,
    promote: Option<Vec<(NetId, Entity)>>,
    resumed: bool,
    host_leaving: bool,
}

impl Session {
    fn new(role: SessionRole, cfg: SessionConfig, phase: SessionPhase, shared: SharedRef, t: f64) -> Session {
        Session {
            role,
            phase,
            info: SessionInfo { game_version: cfg.game_version, world_seed: cfg.world_seed },
            cfg,
            code: None,
            route: RouteKind::Pending,
            my_id: None,
            peers: vec![],
            error: None,
            migrations: 0,
            token: 0,
            shared,
            started: t,
            last_tx: f64::NEG_INFINITY,
            last_keepalive: t,
            punch_targets: vec![],
            host_real: None,
            leave_at: None,
            attempt: 0,
            promote: None,
            resumed: false,
            host_leaving: false,
        }
    }

    /// Path statistics (direct vs relayed packets).
    pub fn path_stats(&self) -> PathStats {
        self.shared.lock().unwrap().stats
    }

    /// Start hosting. The invite code arrives as `SessionEvent::Hosting` / `Session::code`.
    pub fn host(world: &mut World, cfg: SessionConfig) -> io::Result<()> {
        let t = now(world);
        let shared = Shared::new(Role::Host);
        let transport = make_transport(&cfg, &shared)?;
        world.resource_mut::<super::NetConfig>().protocol_version = cfg.game_version;
        super::host(world, transport, cfg.host_plays);
        let name = cfg.name.clone();
        let mut s = Session::new(SessionRole::Host, cfg, SessionPhase::Registering, shared, t);
        s.my_id = Some(ClientId::HOST);
        s.peers = vec![PeerInfo { id: 0, name }];
        world.insert_resource(s);
        Ok(())
    }

    /// Join the session with this invite code.
    pub fn join(world: &mut World, cfg: SessionConfig, code: &str) -> io::Result<()> {
        let t = now(world);
        let mut s = Session::new(SessionRole::Guest, cfg, SessionPhase::Joining, Shared::new(Role::Guest), t);
        s.code = Some(code.trim().to_uppercase());
        start_join(world, &mut s)?;
        world.insert_resource(s);
        Ok(())
    }

    /// Leave. A guest disconnects at once; a host tells the guests first (they elect a
    /// successor when `migrate` is on) and shuts down after `leave_grace_s`.
    pub fn leave(world: &mut World) {
        let Some(mut s) = world.remove_resource::<Session>() else { return };
        let t = now(world);
        if s.role == SessionRole::Host && s.phase != SessionPhase::Closed && world.contains_resource::<NetServer>() {
            let _ = world.run_system_once(|mut tx: NetSender| tx.broadcast(&SessionMsg::HostLeaving));
            s.phase = SessionPhase::Leaving;
            s.leave_at = Some(t + s.cfg.leave_grace_s);
        } else {
            super::disconnect(world);
            s.phase = SessionPhase::Closed;
            world.write_message(SessionEvent::Left);
        }
        world.insert_resource(s);
    }
}

fn make_transport(cfg: &SessionConfig, shared: &SharedRef) -> io::Result<SessionTransport> {
    let raw = (cfg.socket)()?;
    let inner: Box<dyn Transport> = match cfg.simulate_nat {
        Some(kind) => Box::new(SimNat::new(raw, kind).allow(cfg.relay)),
        None => raw,
    };
    Ok(SessionTransport::new(inner, cfg.relay, shared.clone()))
}

fn start_join(world: &mut World, s: &mut Session) -> io::Result<()> {
    let t = now(world);
    s.shared = Shared::new(Role::Guest);
    let transport = make_transport(&s.cfg, &s.shared)?;
    s.shared.lock().unwrap().code = s.code.clone().unwrap_or_default();
    world.resource_mut::<super::NetConfig>().protocol_version = s.cfg.game_version;
    super::connect(world, transport, VIRT_HOST);
    s.role = SessionRole::Guest;
    s.phase = if s.migrations > 0 && s.phase == SessionPhase::Migrating { SessionPhase::Migrating } else { SessionPhase::Joining };
    s.route = RouteKind::Pending;
    s.host_real = None;
    s.started = t;
    s.last_tx = f64::NEG_INFINITY;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Plugin

pub struct SessionPlugin;

impl Plugin for SessionPlugin {
    fn build(&self, app: &mut App) {
        app.add_net_message::<SessionMsg>(Channel::Reliable)
            .add_message::<SessionEvent>()
            .init_resource::<SessionHooksRes>()
            .add_systems(PreUpdate, collect.after(super::NetSet::Receive).run_if(resource_exists::<Session>))
            .add_systems(Update, drive.run_if(resource_exists::<Session>));
    }
}

enum Incoming {
    Net(NetEvent),
    FromServer(SessionMsg),
    FromClient(ClientId, SessionMsg),
}

/// Gathers this frame's net events and session messages, then handles them with world access.
fn collect(
    mut commands: Commands,
    mut events: MessageReader<NetEvent>,
    mut from_server: MessageReader<FromServer<SessionMsg>>,
    mut from_client: MessageReader<FromClient<SessionMsg>>,
) {
    let mut v: Vec<Incoming> = events.read().copied().map(Incoming::Net).collect();
    v.extend(from_server.read().map(|m| Incoming::FromServer(m.0.clone())));
    v.extend(from_client.read().map(|m| Incoming::FromClient(m.client, m.message.clone())));
    if !v.is_empty() {
        commands.queue(move |world: &mut World| handle(world, v));
    }
}

fn with_hooks<R>(world: &mut World, f: impl FnOnce(&mut dyn SessionHooks, &mut World) -> R) -> R {
    let mut h = world.remove_resource::<SessionHooksRes>().unwrap_or_default();
    let r = f(h.0.as_mut(), world);
    world.insert_resource(h);
    r
}

fn send_to(world: &mut World, id: ClientId, msg: SessionMsg) {
    let _ = world.run_system_once(move |mut tx: NetSender| tx.to_client(id, &msg));
}

fn broadcast(world: &mut World, msg: SessionMsg) {
    let _ = world.run_system_once(move |mut tx: NetSender| tx.broadcast(&msg));
}

fn handle(world: &mut World, incoming: Vec<Incoming>) {
    let Some(mut s) = world.remove_resource::<Session>() else { return };
    for i in incoming {
        match i {
            Incoming::Net(NetEvent::ClientConnected(id)) if s.role == SessionRole::Host => {
                let peer = PeerInfo { id: id.0, name: String::new() };
                s.peers.push(peer.clone());
                let hello = SessionMsg::Hello { info: s.info, your_id: id.0, code: s.code.clone().unwrap_or_default(), token: s.token };
                send_to(world, id, hello);
                if let Some(blob) = with_hooks(world, |h, w| h.welcome(w, id)) {
                    send_to(world, id, SessionMsg::Welcome(blob));
                }
                broadcast(world, SessionMsg::Peers(s.peers.clone()));
                world.write_message(SessionEvent::PeerJoined(peer));
            }
            Incoming::Net(NetEvent::ClientDisconnected(id, reason)) if s.role == SessionRole::Host => {
                s.peers.retain(|p| p.id != id.0);
                broadcast(world, SessionMsg::Peers(s.peers.clone()));
                let graceful = matches!(reason, DisconnectReason::Requested | DisconnectReason::RemoteClosed);
                world.write_message(SessionEvent::PeerLeft { id: id.0, graceful });
            }
            Incoming::FromClient(id, SessionMsg::Name(name)) => {
                if let Some(p) = s.peers.iter_mut().find(|p| p.id == id.0) {
                    p.name = name;
                }
                broadcast(world, SessionMsg::Peers(s.peers.clone()));
            }
            Incoming::Net(NetEvent::Connected(id)) if s.role == SessionRole::Guest => {
                s.my_id = Some(id);
                let name = SessionMsg::Name(s.cfg.name.clone());
                let _ = world.run_system_once(move |mut tx: NetSender| tx.to_server(&name));
            }
            Incoming::Net(NetEvent::Disconnected(reason)) if s.role == SessionRole::Guest => {
                // Losing an established host is handled by `host_lost`; this is a failed attempt.
                if matches!(s.phase, SessionPhase::Connecting | SessionPhase::Joining | SessionPhase::Punching) {
                    let e = match reason {
                        DisconnectReason::ProtocolMismatch => SessionError::VersionMismatch,
                        DisconnectReason::ServerFull => SessionError::HostFull,
                        DisconnectReason::ConnectTimeout => SessionError::Timeout,
                        r => SessionError::Net(r),
                    };
                    fail(world, &mut s, e);
                }
            }
            Incoming::FromServer(SessionMsg::Hello { info, your_id, code, token }) => {
                s.info = info;
                s.token = token;
                s.code = Some(code);
                s.my_id = Some(ClientId(your_id));
                let migrated = s.phase == SessionPhase::Migrating;
                s.phase = SessionPhase::InSession;
                s.error = None;
                if migrated {
                    world.write_message(SessionEvent::HostMigrated { i_am_host: false });
                } else {
                    world.write_message(SessionEvent::Joined { info, my_id: ClientId(your_id), route: s.route });
                }
            }
            Incoming::FromServer(SessionMsg::Welcome(bytes)) => with_hooks(world, |h, w| h.apply_welcome(w, &bytes)),
            Incoming::FromServer(SessionMsg::Peers(p)) => s.peers = p,
            Incoming::FromServer(SessionMsg::HostLeaving) => {
                s.host_leaving = true;
                world.write_message(SessionEvent::HostLeaving);
            }
            _ => {}
        }
    }
    world.insert_resource(s);
}

fn fail(world: &mut World, s: &mut Session, e: SessionError) {
    s.phase = SessionPhase::Failed;
    s.error = Some(e);
    world.write_message(SessionEvent::Failed(e));
}

/// Called by the net client when its connection to the server ended (before the mirrored
/// entities are despawned): decides between closing and host migration, and hands the successor
/// its mirrors.
pub(crate) fn host_lost(world: &mut World, repl: &mut super::client::ClientRepl, reason: DisconnectReason) {
    let t = now(world);
    let Some(mut s) = world.remove_resource::<Session>() else { return };
    if s.role == SessionRole::Guest && s.phase == SessionPhase::InSession {
        if !s.cfg.migrate || reason == DisconnectReason::Kicked {
            s.phase = SessionPhase::Closed;
            world.write_message(SessionEvent::Left);
        } else {
            s.phase = SessionPhase::Migrating;
            s.started = t;
            s.migrations += 1;
            s.attempt = 0;
            let me = elect(&s);
            if me {
                s.promote = Some(repl.take_mirrors());
            }
            world.write_message(SessionEvent::Migrating { i_am_successor: me });
        }
    }
    world.insert_resource(s);
}

/// Candidates are the peers other than the lost host, lowest id first; attempt `n` picks the
/// `n`-th (so a dead successor is skipped in the next round). Everyone computes the same answer
/// from the same peer list.
fn successor(s: &Session) -> Option<u32> {
    let mut c: Vec<u32> = s.peers.iter().map(|p| p.id).filter(|id| *id != 0).collect();
    c.sort_unstable();
    (!c.is_empty()).then(|| c[s.attempt as usize % c.len()])
}

fn elect(s: &Session) -> bool {
    successor(s).is_some() && successor(s) == s.my_id.map(|i| i.0)
}

// ---------------------------------------------------------------------------------------------
// Driver

fn drive(world: &mut World) {
    let Some(mut s) = world.remove_resource::<Session>() else { return };
    let t = now(world);
    let msgs: Vec<(SocketAddr, Msg)> = s.shared.lock().unwrap().inbox.drain(..).collect();
    for (from, m) in msgs {
        control(world, &mut s, from, m);
    }
    match (s.role, s.phase) {
        (SessionRole::Host, SessionPhase::Registering | SessionPhase::Hosting) => host_timers(&mut s, t),
        (SessionRole::Host, SessionPhase::Leaving) => {
            if s.leave_at.is_some_and(|at| t >= at) {
                super::disconnect(world);
                s.phase = SessionPhase::Closed;
                world.write_message(SessionEvent::Left);
            }
        }
        (SessionRole::Guest, SessionPhase::Joining | SessionPhase::Punching | SessionPhase::Connecting) => guest_timers(world, &mut s, t),
        (SessionRole::Guest, SessionPhase::Migrating) => migrate(world, &mut s, t),
        _ => {}
    }
    world.insert_resource(s);
}

fn control(world: &mut World, s: &mut Session, from: SocketAddr, m: Msg) {
    let t = now(world);
    match (s.role, m) {
        (SessionRole::Host, Msg::Registered { code, token }) => {
            s.code = Some(code.clone());
            s.token = token;
            s.shared.lock().unwrap().code = code.clone();
            if s.phase == SessionPhase::Registering {
                s.phase = SessionPhase::Hosting;
                if s.resumed {
                    world.write_message(SessionEvent::HostMigrated { i_am_host: true });
                } else {
                    world.write_message(SessionEvent::Hosting { code });
                }
            }
        }
        (SessionRole::Host, Msg::Refused { why, .. }) if s.phase == SessionPhase::Registering => {
            let e = if why == Refusal::BadToken { SessionError::BadToken } else { SessionError::NoSuchRoom };
            fail(world, s, e);
        }
        (SessionRole::Host, Msg::Introduce { peer, .. }) => s.punch_targets.push((peer, t + s.cfg.punch_timeout_s + 1.0)),
        (SessionRole::Guest, Msg::Introduce { peer, .. }) if matches!(s.phase, SessionPhase::Joining | SessionPhase::Migrating) => {
            s.host_real = Some(peer);
            s.started = t;
            if s.phase == SessionPhase::Joining {
                s.phase = SessionPhase::Punching;
            }
            if s.cfg.force_relay {
                use_relay(s);
            }
        }
        (SessionRole::Guest, Msg::Punch { .. }) if s.host_real == Some(from) => {
            let mut sh = s.shared.lock().unwrap();
            if sh.route == Route::Pending {
                sh.route = Route::Direct(from);
                drop(sh);
                s.route = RouteKind::Direct;
                if s.phase == SessionPhase::Punching {
                    s.phase = SessionPhase::Connecting;
                }
            }
        }
        (SessionRole::Guest, Msg::Refused { why: Refusal::NoSuchRoom, .. }) if s.phase == SessionPhase::Joining => fail(world, s, SessionError::NoSuchRoom),
        _ => {}
    }
}

fn use_relay(s: &mut Session) {
    s.shared.lock().unwrap().route = Route::Relayed;
    s.route = RouteKind::Relayed;
    if matches!(s.phase, SessionPhase::Punching) {
        s.phase = SessionPhase::Connecting;
    }
}

fn host_timers(s: &mut Session, t: f64) {
    let relay = s.cfg.relay;
    let mut sh = s.shared.lock().unwrap();
    match s.phase {
        SessionPhase::Registering if t - s.last_tx >= 0.5 => {
            s.last_tx = t;
            let m = Msg::Register { code: s.code.clone().filter(|_| s.resumed), token: s.resumed.then_some(s.token) };
            sh.push(relay, &m);
        }
        SessionPhase::Hosting if t - s.last_keepalive >= s.cfg.keepalive_s => {
            s.last_keepalive = t;
            sh.push(relay, &Msg::Register { code: s.code.clone(), token: Some(s.token) });
        }
        _ => {}
    }
    s.punch_targets.retain(|(_, deadline)| *deadline > t);
    if !s.punch_targets.is_empty() && t - s.last_tx >= 0.1 {
        s.last_tx = t;
        for (a, _) in &s.punch_targets {
            sh.push(*a, &Msg::Punch { nonce: 1, ack: false });
        }
    }
}

fn guest_timers(world: &mut World, s: &mut Session, t: f64) {
    let relay = s.cfg.relay;
    match s.phase {
        SessionPhase::Joining => {
            if t - s.started > s.cfg.join_timeout_s {
                return fail(world, s, SessionError::Timeout);
            }
            if t - s.last_tx >= 0.25 {
                s.last_tx = t;
                let code = s.code.clone().unwrap_or_default();
                s.shared.lock().unwrap().push(relay, &Msg::Join { code });
            }
        }
        SessionPhase::Punching => {
            if t - s.started > s.cfg.punch_timeout_s {
                info!("session: hole punching failed, using the relay");
                use_relay(s);
            } else if t - s.last_tx >= 0.1
                && let Some(host) = s.host_real
            {
                s.last_tx = t;
                s.shared.lock().unwrap().push(host, &Msg::Punch { nonce: 1, ack: false });
            }
        }
        SessionPhase::Connecting => {
            // The net handshake times out by itself (NetEvent::Disconnected -> Failed).
        }
        _ => {}
    }
}

/// Guest side of a host election: the successor re-hosts, the others rejoin through the relay.
fn migrate(world: &mut World, s: &mut Session, t: f64) {
    if let Some(mirrors) = s.promote.take() {
        // I am the successor: promote, then host under the same invite code and token.
        with_hooks(world, |h, w| h.promote(w, &mirrors));
        let shared = Shared::new(Role::Host);
        match make_transport(&s.cfg, &shared) {
            Ok(tr) => {
                shared.lock().unwrap().code = s.code.clone().unwrap_or_default();
                world.resource_mut::<super::NetConfig>().protocol_version = s.cfg.game_version;
                super::host(world, tr, s.cfg.host_plays);
                s.shared = shared;
                s.role = SessionRole::Host;
                s.phase = SessionPhase::Registering;
                s.resumed = true;
                s.my_id = Some(ClientId::HOST);
                s.peers = vec![PeerInfo { id: 0, name: s.cfg.name.clone() }];
                s.last_tx = f64::NEG_INFINITY;
                s.started = t;
            }
            Err(_) => fail(world, s, SessionError::Net(DisconnectReason::ProtocolError)),
        }
        return;
    }
    let waiting = t - s.started;
    if waiting > s.cfg.migration_timeout_s {
        // This round's successor never showed up: try the next candidate.
        s.attempt += 1;
        s.started = t;
        if elect(s) {
            // Everything this peer showed is gone with the disconnect; promote what is left.
            s.promote = Some(vec![]);
            world.write_message(SessionEvent::Migrating { i_am_successor: true });
        } else if s.attempt > 8 {
            fail(world, s, SessionError::Timeout);
        }
        return;
    }
    if waiting < s.cfg.migration_delay_s {
        return;
    }
    let busy = world.get_resource::<NetClient>().is_some();
    if busy {
        // A rejoin attempt is in flight; drive its punch / join timers.
        guest_timers_migrating(world, s, t);
    } else if t - s.last_tx >= 0.5 {
        s.last_tx = t;
        let (started, last_tx, attempt) = (s.started, s.last_tx, s.attempt);
        if start_join(world, s).is_ok() {
            s.phase = SessionPhase::Migrating;
            s.started = started;
            s.last_tx = last_tx;
            s.attempt = attempt;
        }
    }
}

fn guest_timers_migrating(world: &mut World, s: &mut Session, t: f64) {
    let relay = s.cfg.relay;
    let _ = world;
    let sh_route = s.shared.lock().unwrap().route;
    match (s.host_real, sh_route) {
        (None, _) => {
            if t - s.last_tx >= 0.25 {
                s.last_tx = t;
                let code = s.code.clone().unwrap_or_default();
                s.shared.lock().unwrap().push(relay, &Msg::Join { code });
            }
        }
        (Some(host), Route::Pending) => {
            if t - s.started > s.cfg.punch_timeout_s + s.cfg.migration_delay_s {
                use_relay(s);
            } else if t - s.last_tx >= 0.1 {
                s.last_tx = t;
                s.shared.lock().unwrap().push(host, &Msg::Punch { nonce: 1, ack: false });
            }
        }
        _ => {}
    }
}

#[cfg(feature = "devtools")]
pub(crate) fn status_json(world: &World) -> serde_json::Value {
    use serde_json::json;
    let Some(s) = world.get_resource::<Session>() else { return json!({"active": false}) };
    let p = s.path_stats();
    json!({
        "active": true, "role": format!("{:?}", s.role), "phase": format!("{:?}", s.phase), "code": s.code,
        "route": format!("{:?}", s.route), "my_id": s.my_id.map(|i| i.0), "seed": s.info.world_seed, "version": s.info.game_version,
        "peers": s.peers.iter().map(|p| json!({"id": p.id, "name": p.name})).collect::<Vec<_>>(),
        "migrations": s.migrations, "error": s.error.map(|e| format!("{e:?}")),
        "path": {"direct_tx": p.direct_tx, "direct_rx": p.direct_rx, "relayed_tx": p.relayed_tx, "relayed_rx": p.relayed_rx},
    })
}

#[cfg(test)]
mod tests;
