//! Multiplayer, headless, in-process: a server `App` and client `App`s on a `LoopbackNet`,
//! stepped with fixed 60 Hz frames and seeded link conditioners (deterministic).
//! Run: `cargo test --features net --test net` (bench: `-- --ignored --nocapture bench`).
#![cfg(feature = "net")]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use bevy::time::TimeUpdateStrategy;
use engine::net::{
    self, Channel, ClientEndpoint, ClientStatus, DisconnectReason, LagCompensated, LagCompensation, LinkConditioner, LoopbackNet, Predicted,
    PredictionStats, Remote,
};
use engine::prelude::*;
use serde::{Deserialize, Serialize};

const STEP: Duration = Duration::from_nanos(16_666_667);

#[derive(Component, Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Health(u32);

#[derive(Component, Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Tag(String);

/// Owner-only state.
#[derive(Component, Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Ammo(u32);

/// Predicted player state.
#[derive(Component, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Body {
    x: f32,
    z: f32,
    vx: f32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct MoveInput {
    dx: i8,
    jump: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Chat(u32, String);

/// Server-only: moves along x at `0` m/s.
#[derive(Component)]
struct Mover(f32);

fn step_body(b: &mut Body, i: &MoveInput, dt: f32) {
    let target = f32::from(i.dx) * 5.0;
    b.vx += (target - b.vx) * 0.5;
    b.x += b.vx * dt;
    if i.jump {
        b.z += 1.0;
    }
}

fn mover(mut q: Query<(&mut Transform, &Mover)>) {
    for (mut t, m) in &mut q {
        t.translation.x += m.0 / 60.0;
    }
}

struct TestGame;

impl Plugin for TestGame {
    fn build(&self, app: &mut App) {
        app.replicate_transform()
            .replicate::<Health>()
            .replicate::<Tag>()
            .replicate_owner_only::<Ammo>()
            .replicate::<Body>()
            .add_net_message::<Chat>(Channel::Reliable)
            .predict::<Body, MoveInput>(step_body)
            .add_systems(FixedUpdate, mover);
    }
}

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("engine-net-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn build(tag: &str, cfg: NetConfig, extra: impl FnOnce(&mut App)) -> App {
    let mut app = engine::app_with(GameInfo::new("nettest", "Net Test"), EngineOptions::headless_test(temp_dir(tag)));
    app.insert_resource(cfg).add_plugins(TestGame).insert_resource(TimeUpdateStrategy::ManualDuration(STEP));
    extra(&mut app);
    app.finish();
    app.cleanup();
    app
}

fn lossy(seed: u64) -> LinkConditioner {
    LinkConditioner { latency_ms: 40.0, jitter_ms: 20.0, loss: 0.2, duplicate: 0.05, reorder: 0.02, seed }
}

struct Net {
    lo: LoopbackNet,
    server: App,
    clients: Vec<App>,
}

impl Net {
    fn new(cfg: NetConfig, n_clients: usize) -> Self {
        Self::with(cfg, n_clients, |_| {})
    }

    fn with(cfg: NetConfig, n_clients: usize, extra: fn(&mut App)) -> Self {
        let lo = LoopbackNet::new();
        let mut server = build("server", cfg.clone(), extra);
        net::host(server.world_mut(), lo.bind(7777), false);
        let mut clients = Vec::new();
        for i in 0..n_clients {
            let mut c = build("client", NetConfig { conditioner: LinkConditioner { seed: cfg.conditioner.seed + 1 + i as u64, ..cfg.conditioner }, ..cfg.clone() }, extra);
            let t = lo.bind(0);
            net::connect(c.world_mut(), t, "127.0.0.1:7777".parse().unwrap());
            clients.push(c);
        }
        Net { lo, server, clients }
    }

    fn run(&mut self, frames: usize) {
        for _ in 0..frames {
            self.server.update();
            for c in &mut self.clients {
                c.update();
            }
        }
    }

    /// Until every client finished the handshake (≤ 5 s).
    fn wait_connected(&mut self) {
        for _ in 0..300 {
            if self.clients.iter().all(|c| c.world().get_resource::<NetClient>().is_some_and(|n| n.id().is_some())) {
                return;
            }
            self.run(1);
        }
        panic!("clients did not connect");
    }

    fn client_id(&self, i: usize) -> ClientId {
        self.clients[i].world().resource::<NetClient>().id().expect("connected")
    }
}

fn net_state(app: &App) -> NetState {
    *app.world().resource::<State<NetState>>().get()
}

fn events(app: &mut App) -> Vec<NetEvent> {
    let msgs = app.world().resource::<bevy::ecs::message::Messages<NetEvent>>();
    msgs.iter_current_update_messages().copied().collect()
}

/// Every replicated entity on a client: NetId → (Transform, Health).
fn client_view(app: &mut App) -> Vec<(NetId, Transform, Option<Health>)> {
    let mut q = app.world_mut().query_filtered::<(&NetId, &Transform, Option<&Health>), With<Remote>>();
    let mut v: Vec<_> = q.iter(app.world()).map(|(i, t, h)| (*i, *t, h.cloned())).collect();
    v.sort_by_key(|x| x.0);
    v
}

fn server_view(app: &mut App) -> Vec<(NetId, Transform, Option<Health>)> {
    let mut q = app.world_mut().query_filtered::<(&NetId, &Transform, Option<&Health>), With<Replicated>>();
    let mut v: Vec<_> = q.iter(app.world()).map(|(i, t, h)| (*i, *t, h.cloned())).collect();
    v.sort_by_key(|x| x.0);
    v
}

fn assert_converged(server: &[(NetId, Transform, Option<Health>)], client: &[(NetId, Transform, Option<Health>)]) {
    assert_eq!(server.len(), client.len(), "entity counts");
    for (s, c) in server.iter().zip(client) {
        assert_eq!(s.0, c.0);
        assert!((s.1.translation - c.1.translation).abs().max_element() < 0.002, "{:?}: {:?} vs {:?}", s.0, s.1.translation, c.1.translation);
        assert_eq!(s.2, c.2, "health of {:?}", s.0);
    }
}

#[test]
fn connect_message_disconnect_and_shutdown() {
    let mut n = Net::new(NetConfig::default(), 2);
    n.run(1);
    assert_eq!(net_state(&n.clients[0]), NetState::Connecting);
    let mut connected = Vec::new();
    for _ in 0..19 {
        n.run(1);
        connected.extend(events(&mut n.server));
    }
    assert_eq!(connected.len(), 2, "{connected:?}");
    assert!(connected.iter().all(|e| matches!(e, NetEvent::ClientConnected(_))));
    for c in &n.clients {
        assert_eq!(net_state(c), NetState::InGame);
    }
    assert_eq!(net_state(&n.server), NetState::InGame);

    // Client 0 leaves.
    net::disconnect(n.clients[0].world_mut());
    let id0 = ClientId(1);
    let mut evs = Vec::new();
    for _ in 0..5 {
        n.run(1);
        evs.extend(events(&mut n.server));
    }
    assert!(evs.contains(&NetEvent::ClientDisconnected(id0, DisconnectReason::RemoteClosed)), "{evs:?}");
    assert_eq!(n.server.world().resource::<NetServer>().endpoint.len(), 1);

    // Server shuts down: client 1 learns why.
    net::disconnect(n.server.world_mut());
    let mut cev = Vec::new();
    for _ in 0..5 {
        n.run(1);
        cev.extend(events(&mut n.clients[1]));
    }
    assert!(cev.contains(&NetEvent::Disconnected(DisconnectReason::ServerShutdown)), "{cev:?}");
    assert_eq!(net_state(&n.clients[1]), NetState::Disconnected);
    assert!(!n.clients[1].world().contains_resource::<NetClient>());
    let _ = n.lo.in_flight();
}

#[test]
fn protocol_mismatch_is_refused() {
    let lo = LoopbackNet::new();
    let mut server = build("pm-server", NetConfig::default(), |_| {});
    net::host(server.world_mut(), lo.bind(7777), false);
    // A client build that replicates one more component.
    let mut client = build("pm-client", NetConfig::default(), |app| {
        #[derive(Component, Clone, Serialize, Deserialize)]
        struct Extra;
        app.replicate::<Extra>();
    });
    net::connect(client.world_mut(), lo.bind(0), "127.0.0.1:7777".parse().unwrap());
    let mut ev = Vec::new();
    for _ in 0..20 {
        server.update();
        client.update();
        ev.extend(events(&mut client));
    }
    assert!(ev.contains(&NetEvent::Disconnected(DisconnectReason::ProtocolMismatch)), "{ev:?}");
}

#[test]
fn replication_converges_under_20pct_loss() {
    let cfg = NetConfig { conditioner: lossy(11), ..default() };
    let mut n = Net::new(cfg, 2);
    n.wait_connected();
    let w = n.server.world_mut();
    let mut ids = Vec::new();
    for i in 0..60 {
        ids.push(w.spawn((Replicated, Transform::from_xyz(i as f32, 0.0, 0.0), Health(100), Mover(1.0 + i as f32 * 0.1))).id());
    }
    w.spawn((Replicated, Transform::from_xyz(0.0, 5.0, 0.0).with_rotation(Quat::from_rotation_y(0.7)), Tag("flag".into())));
    n.run(180);
    // Change state: damage, despawn some, remove a component, stop movement.
    let w = n.server.world_mut();
    for (k, e) in ids.iter().enumerate() {
        if k % 6 == 0 {
            w.entity_mut(*e).despawn();
        } else if k % 6 == 1 {
            w.entity_mut(*e).remove::<Health>();
        } else {
            w.entity_mut(*e).insert(Health(100 - k as u32));
        }
    }
    let mut q = w.query::<&mut Mover>();
    for mut m in q.iter_mut(w) {
        m.0 = 0.0;
    }
    n.run(150);
    let sv = server_view(&mut n.server);
    for c in 0..2 {
        let cv = client_view(&mut n.clients[c]);
        assert_converged(&sv, &cv);
        let st = n.clients[c].world().resource::<NetClient>().stats();
        assert!(st.stale_skipped > 0 || st.parts_received > 100, "{st:?}");
    }
    assert_eq!(sv.len(), 51);
    // Non-transform component replicated too.
    let mut q = n.clients[0].world_mut().query::<&Tag>();
    assert_eq!(q.iter(n.clients[0].world()).next(), Some(&Tag("flag".into())));
    let link = n.clients[0].world().resource::<NetClient>().endpoint.stats().unwrap();
    assert!(link.packets_lost > 0, "the conditioner really dropped packets: {link:?}");
}

#[test]
fn reliable_messages_survive_20pct_loss_both_ways() {
    let cfg = NetConfig { conditioner: lossy(5), ..default() };
    let mut n = Net::new(cfg, 1);
    n.wait_connected();
    let mut got_server = Vec::new();
    let mut got_client = Vec::new();
    for frame in 0..400u32 {
        if frame < 200 {
            n.clients[0].world_mut().run_system_cached_with(|In(i): In<u32>, mut s: NetSender| s.to_server(&Chat(i, "x".repeat((i % 7) as usize * 300))), frame).unwrap();
            n.server.world_mut().run_system_cached_with(|In(i): In<u32>, mut s: NetSender| s.broadcast(&Chat(i, String::new())), frame).unwrap();
        }
        n.run(1);
        let m = n.server.world().resource::<bevy::ecs::message::Messages<FromClient<Chat>>>();
        got_server.extend(m.iter_current_update_messages().map(|m| m.message.0));
        let m = n.clients[0].world().resource::<bevy::ecs::message::Messages<FromServer<Chat>>>();
        got_client.extend(m.iter_current_update_messages().map(|m| m.0.0));
    }
    assert_eq!(got_server, (0..200).collect::<Vec<_>>(), "all client→server messages, in order");
    assert_eq!(got_client, (0..200).collect::<Vec<_>>(), "all server→client messages, in order");
}

fn set_input(app: &mut App, dx: i8, jump: bool) {
    app.world_mut().resource_mut::<LocalInput<MoveInput>>().0 = MoveInput { dx, jump };
}

fn client_body(app: &mut App) -> Body {
    let mut q = app.world_mut().query_filtered::<&Body, With<Predicted>>();
    q.single(app.world()).expect("one predicted entity").clone()
}

fn server_body(app: &mut App) -> Body {
    let mut q = app.world_mut().query_filtered::<&Body, With<NetOwner>>();
    q.single(app.world()).unwrap().clone()
}

#[test]
fn prediction_matches_server_and_reconciles_corrections() {
    let cfg = NetConfig { conditioner: LinkConditioner { latency_ms: 50.0, jitter_ms: 4.0, loss: 0.1, seed: 3, ..default() }, ..default() };
    let mut n = Net::new(cfg, 1);
    n.wait_connected();
    let id = n.client_id(0);
    n.server.world_mut().spawn((Replicated, NetOwner(id), NetViewer, Body::default(), Transform::default()));
    n.run(60);
    assert!(n.clients[0].world_mut().query_filtered::<(), With<Predicted>>().iter(n.clients[0].world()).count() == 1, "own entity is Predicted");

    // Steady input: prediction runs ahead of the server and agrees with it.
    set_input(&mut n.clients[0], 1, false);
    n.run(120);
    let c_tick = n.clients[0].world().resource::<NetClock>().tick;
    let s_tick = n.server.world().resource::<NetClock>().tick;
    assert!(c_tick > s_tick, "client predicts ahead: client {c_tick} vs server {s_tick}");
    let lead = c_tick - s_tick;
    assert!((3..=15).contains(&lead), "lead ≈ RTT + input lead: {lead} ticks");
    let b = client_body(&mut n.clients[0]);
    assert!(b.x > 5.0, "moved immediately (no round-trip wait): {b:?}");

    // Release, settle: client and server agree exactly (same pure step, same inputs).
    set_input(&mut n.clients[0], 0, false);
    n.run(60);
    let before = *n.clients[0].world().resource::<PredictionStats>();
    let (c, s) = (client_body(&mut n.clients[0]), server_body(&mut n.server));
    assert!((c.x - s.x).abs() < 1e-3, "client {c:?} server {s:?}");
    // Quiet period: no mispredictions.
    n.run(60);
    let quiet = *n.clients[0].world().resource::<PredictionStats>();
    assert_eq!(quiet.rollbacks, before.rollbacks, "no rollbacks while nothing disagrees: {quiet:?}");
    assert!(quiet.checks > before.checks);

    // Server-side correction (e.g. a hit knocks the player back): the client rolls back,
    // replays its inputs, and ends up exactly at the server's state.
    let mut q = n.server.world_mut().query::<&mut Body>();
    for mut b in q.iter_mut(n.server.world_mut()) {
        b.x -= 3.0;
    }
    set_input(&mut n.clients[0], -1, false);
    n.run(20);
    set_input(&mut n.clients[0], 0, true);
    n.run(1);
    set_input(&mut n.clients[0], 0, false);
    n.run(60);
    let after = *n.clients[0].world().resource::<PredictionStats>();
    assert!(after.rollbacks > quiet.rollbacks && after.replayed_ticks > quiet.replayed_ticks, "{after:?}");
    let (c, s) = (client_body(&mut n.clients[0]), server_body(&mut n.server));
    assert!((c.x - s.x).abs() < 1e-3 && c.z == s.z, "converged after correction: client {c:?} server {s:?}");
    assert_eq!(s.z, 1.0, "the one-tick jump input reached the server despite 10% loss (redundant inputs)");
}

#[test]
fn interest_management_by_distance() {
    let cfg = NetConfig { relevancy_radius: Some(50.0), ..default() };
    let mut n = Net::new(cfg, 1);
    n.run(20);
    let id = n.client_id(0);
    let w = n.server.world_mut();
    w.spawn((Replicated, NetOwner(id), NetViewer, Transform::default()));
    let near = w.spawn((Replicated, Transform::from_xyz(10.0, 0.0, 0.0), Health(1))).id();
    let far = w.spawn((Replicated, Transform::from_xyz(200.0, 0.0, 0.0), Health(2))).id();
    w.spawn((Replicated, AlwaysRelevant, Transform::from_xyz(5000.0, 0.0, 0.0), Health(3)));
    n.run(30);
    let hp: Vec<_> = client_view(&mut n.clients[0]).into_iter().filter_map(|x| x.2).collect();
    assert_eq!(hp, vec![Health(1), Health(3)], "far entity not sent, always-relevant one is");
    // Far comes near: spawns on the client. Near goes far: despawns there.
    n.server.world_mut().entity_mut(far).insert(Transform::from_xyz(20.0, 0.0, 0.0));
    n.server.world_mut().entity_mut(near).insert(Transform::from_xyz(300.0, 0.0, 0.0));
    n.run(30);
    let hp: Vec<_> = client_view(&mut n.clients[0]).into_iter().filter_map(|x| x.2).collect();
    assert_eq!(hp, vec![Health(2), Health(3)]);
    // Hysteresis: 52 m (inside 55 m leave radius) stays.
    n.server.world_mut().entity_mut(far).insert(Transform::from_xyz(52.0, 0.0, 0.0));
    n.run(10);
    assert_eq!(client_view(&mut n.clients[0]).len(), 3, "owned + far(52 m, hysteresis) + always");
    assert_eq!(n.server.world().resource::<NetServer>().entities_known_by(id), 3);
}

#[test]
fn bandwidth_budget_is_respected_and_nothing_starves() {
    let mut cfg = NetConfig::default();
    cfg.connection.bytes_per_sec = 24_000;
    let mut n = Net::new(cfg, 1);
    n.run(20);
    let w = n.server.world_mut();
    for i in 0..500 {
        w.spawn((Replicated, Transform::from_xyz((i % 25) as f32 * 4.0, 0.0, (i / 25) as f32 * 4.0), Mover(2.0)));
    }
    n.run(300);
    let s = n.server.world().resource::<NetServer>();
    let link = s.endpoint.clients().next().unwrap().conn.stats();
    assert!(link.send_bytes_per_sec <= 24_000.0 * 1.05, "server→client {link:?}");
    assert!(link.send_bytes_per_sec >= 24_000.0 * 0.7, "uses the budget {link:?}");
    // Every entity was spawned on the client and keeps getting updates.
    let cv = client_view(&mut n.clients[0]);
    assert_eq!(cv.len(), 500);
    let sv = server_view(&mut n.server);
    let max_lag = sv.iter().zip(&cv).map(|(s, c)| (s.1.translation.x - c.1.translation.x).abs()).fold(0.0, f32::max);
    // 500 movers × ~10 B at 60 Hz = 300 KB/s wanted vs 24 KB/s: each entity updates ~every
    // 12 ticks; priority accumulation keeps the oldest update ≲ 0.5 s old (≤ 1 m at 2 m/s).
    assert!(max_lag < 1.5, "stalest entity lags {max_lag} m");
}

#[test]
fn delta_compression_saves_bandwidth() {
    let mut sent = Vec::new();
    for delta in [true, false] {
        let mut cfg = NetConfig { delta_compression: delta, conditioner: LinkConditioner { latency_ms: 30.0, loss: 0.1, seed: 8, ..default() }, ..default() };
        cfg.connection.bytes_per_sec = 4 << 20;
        let mut n = Net::new(cfg, 1);
        n.wait_connected();
        let w = n.server.world_mut();
        for i in 0..200 {
            w.spawn((Replicated, Transform::from_xyz(i as f32 * 3.0, 1.0, 50.0), Health(5), Mover(1.5)));
        }
        n.run(60);
        let b0 = n.server.world().resource::<NetServer>().endpoint.clients().next().unwrap().conn.stats().bytes_sent;
        n.run(120);
        let b1 = n.server.world().resource::<NetServer>().endpoint.clients().next().unwrap().conn.stats().bytes_sent;
        sent.push(b1 - b0);
        // Stop and converge.
        let w = n.server.world_mut();
        for mut m in w.query::<&mut Mover>().iter_mut(w) {
            m.0 = 0.0;
        }
        n.run(60);
        let (sv, cv) = (server_view(&mut n.server), client_view(&mut n.clients[0]));
        assert_converged(&sv, &cv);
        assert_eq!(n.clients[0].world().resource::<NetClient>().stats().decode_errors, 0);
    }
    assert!((sent[0] as f64) < sent[1] as f64 * 0.8, "delta {} B vs full {} B", sent[0], sent[1]);
}

#[test]
fn owner_only_components_reach_only_the_owner() {
    let mut n = Net::new(NetConfig::default(), 2);
    n.wait_connected();
    let owner = n.client_id(0);
    let e = n.server.world_mut().spawn((Replicated, NetOwner(owner), Transform::default(), Health(9), Ammo(30))).id();
    n.run(20);
    let ammo = |app: &mut App| app.world_mut().query::<&Ammo>().iter(app.world()).next().cloned();
    assert_eq!(ammo(&mut n.clients[0]), Some(Ammo(30)));
    assert_eq!(ammo(&mut n.clients[1]), None, "non-owner never gets it");
    assert_eq!(client_view(&mut n.clients[1])[0].2, Some(Health(9)), "but sees the rest");
    n.server.world_mut().entity_mut(e).insert(Ammo(29));
    n.run(20);
    assert_eq!(ammo(&mut n.clients[0]), Some(Ammo(29)));
    assert_eq!(ammo(&mut n.clients[1]), None);
    // Settled: the hidden component does not keep the entity dirty for the other client.
    assert_eq!(n.server.world().resource::<NetServer>().stats().entity_updates, 0);
}

#[test]
fn lag_compensation_rewinds_to_what_the_client_saw() {
    let cfg = NetConfig { lag_compensation_ticks: 60, conditioner: LinkConditioner { latency_ms: 50.0, seed: 4, ..default() }, ..default() };
    let mut n = Net::new(cfg, 1);
    n.wait_connected();
    let target = n.server.world_mut().spawn((Replicated, LagCompensated, Transform::from_xyz(0.0, 1.0, 10.0), Mover(6.0))).id();
    n.run(90);
    // What the client shows now, and at which server tick.
    let shown = client_view(&mut n.clients[0])[0].1.translation;
    let rt = n.clients[0].world().resource::<NetClock>().render_tick;
    n.run(8); // inputs carrying that view reach the server (50 ms)
    let id = n.client_id(0);
    let server_tick = n.server.world().resource::<NetClock>().tick as f64;
    let now_x = server_view(&mut n.server)[0].1.translation.x;
    let lag = n.server.world().resource::<LagCompensation>();
    let rewound = lag.transform_at(target, rt).unwrap().translation;
    assert!((rewound - shown).length() < 0.02, "rewound {rewound} vs shown {shown}");
    assert!(now_x - rewound.x > 0.5, "the target moved on since: now {now_x}, rewound {}", rewound.x);
    let view = lag.view_tick(id).expect("inputs carry the view tick");
    assert!(view > rt && view < server_tick - 6.0, "view {view}, rt {rt}, server {server_tick}");
    // A shot aimed where the client saw the target hits when rewound, misses at present time.
    let origin = Vec3::new(rewound.x, 1.0, 0.0);
    assert_eq!(lag.ray_cast(origin, Dir3::Z, 50.0, rt, |_| Some(0.3)).map(|h| h.0), Some(target));
    assert_eq!(lag.ray_cast(origin, Dir3::Z, 50.0, server_tick, |_| Some(0.3)), None);
    assert_eq!(lag.tracked(), 1);
}

#[test]
fn remote_entities_interpolate_smoothly() {
    let cfg = NetConfig { send_interval: 3, ..default() }; // 20 Hz snapshots
    let mut n = Net::new(cfg, 1);
    n.run(20);
    n.server.world_mut().spawn((Replicated, Transform::default(), Mover(6.0)));
    n.run(60);
    let mut xs = Vec::new();
    for _ in 0..60 {
        n.run(1);
        xs.push(client_view(&mut n.clients[0])[0].1.translation.x);
    }
    let steps: Vec<f32> = xs.windows(2).map(|w| w[1] - w[0]).collect();
    // 6 m/s at 60 fps = 0.1 m per frame, every frame, despite 20 Hz snapshots.
    assert!(steps.iter().all(|d| (0.05..0.15).contains(d)), "per-frame steps: {steps:?}");
    let server_x = server_view(&mut n.server)[0].1.translation.x;
    let lag = server_x - xs[xs.len() - 1];
    // Behind by interpolation delay (0.1 s) + transit: ~0.6–1.2 m.
    assert!((0.4..1.5).contains(&lag), "lag {lag} m");
}

#[test]
fn udp_transport_end_to_end() {
    let mut server = build("udp-server", NetConfig::default(), |_| {});
    let Ok(addr) = net::host_udp(server.world_mut(), 0, true) else { return };
    let mut client = build("udp-client", NetConfig::default(), |_| {});
    net::connect_udp(client.world_mut(), format!("127.0.0.1:{}", addr.port()).parse().unwrap()).unwrap();
    server.world_mut().spawn((Replicated, Transform::from_xyz(1.0, 2.0, 3.0), Health(7)));
    let t0 = Instant::now();
    loop {
        server.update();
        client.update();
        if client_view(&mut client).len() == 1 {
            break;
        }
        assert!(t0.elapsed() < Duration::from_secs(5), "udp replication never arrived");
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(client_view(&mut client)[0].2, Some(Health(7)));
    assert_eq!(*server.world().resource::<NetRole>(), NetRole::ListenServer);
    // Both directions flow (client acks/inputs every tick, RTT measured from real acks).
    for _ in 0..60 {
        server.update();
        client.update();
        std::thread::sleep(Duration::from_millis(1));
    }
    let c = client.world().resource::<NetClient>().endpoint.stats().unwrap();
    assert!(c.packets_sent >= 50, "client sends every tick: {c:?}");
    assert!(c.rtt_ms < 99.0, "rtt measured: {c:?}");
    let s = server.world().resource::<NetServer>().endpoint.clients().next().unwrap().conn.stats();
    assert!(s.packets_lost == 0 && s.rtt_ms < 99.0, "{s:?}");
}

/// Client-side cost: one client `App` receiving 500 moving entities at 60 Hz (apply +
/// interpolation), and a predicted player replaying under 100 ms RTT. Writes the
/// `net_client_apply` bench report.
/// `cargo test --features net --test net -- --ignored --nocapture bench`
#[test]
#[ignore]
fn bench_client_apply_500_entities() {
    let mut cfg = NetConfig { conditioner: LinkConditioner { latency_ms: 50.0, seed: 2, ..default() }, ..default() };
    cfg.connection.bytes_per_sec = 4 << 20;
    let mut n = Net::new(cfg, 1);
    n.wait_connected();
    let id = n.client_id(0);
    let w = n.server.world_mut();
    for i in 0..500 {
        w.spawn((Replicated, Transform::from_xyz((i % 25) as f32 * 4.0, 0.0, (i / 25) as f32 * 4.0), Health(100), Mover(3.0)));
    }
    w.spawn((Replicated, NetOwner(id), Body::default(), Transform::default()));
    set_input(&mut n.clients[0], 1, false);
    n.run(120);
    let frames = 300;
    let (mut server_t, mut client_t, mut worst) = (0.0, 0.0, 0.0f64);
    for _ in 0..frames {
        let t0 = Instant::now();
        n.server.update();
        let t1 = Instant::now();
        n.clients[0].update();
        let dc = t1.elapsed().as_secs_f64();
        server_t += (t1 - t0).as_secs_f64();
        client_t += dc;
        worst = worst.max(dc);
    }
    let st = n.clients[0].world().resource::<NetClient>().endpoint.stats().unwrap();
    let p = *n.clients[0].world().resource::<PredictionStats>();
    println!(
        "[client 500 entities] client frame avg {:.3} ms (worst {:.3}), server frame avg {:.3} ms, down {:.1} KB/s, up {:.2} KB/s, rollbacks {} / checks {}",
        client_t / frames as f64 * 1000.0,
        worst * 1000.0,
        server_t / frames as f64 * 1000.0,
        st.recv_bytes_per_sec / 1024.0,
        st.send_bytes_per_sec / 1024.0,
        p.rollbacks,
        p.checks,
    );
    engine::devkit::BenchReport::new("net_client_apply")
        .value("client.frame_ms", client_t / frames as f64 * 1000.0)
        .value("client.worst_ms", worst * 1000.0)
        .value("server.frame_ms", server_t / frames as f64 * 1000.0)
        .value("down_kbps", f64::from(st.recv_bytes_per_sec) / 1024.0)
        .value("up_kbps", f64::from(st.send_bytes_per_sec) / 1024.0)
        .write()
        .unwrap();
    assert_eq!(client_view(&mut n.clients[0]).len(), 501);
}

/// 64 clients × 500 moving entities on loopback; prints CPU and bandwidth and writes the
/// `net_64_clients` bench report.
/// `cargo test --features net --test net -- --ignored --nocapture bench`
#[test]
#[ignore]
fn bench_64_clients_500_entities() {
    let rows = [
        ("capped", "moving, 128 KB/s cap", None, true, 128 * 1024, true),
        ("capped_nodelta", "moving, 128 KB/s cap, no delta", None, true, 128 * 1024, false),
        ("uncapped", "moving, uncapped (full 60 Hz)", None, true, 4 << 20, true),
        ("uncapped_nodelta", "moving, uncapped, no delta", None, true, 4 << 20, false),
        ("relevancy60", "moving, 60 m relevancy, 128 KB/s", Some(60.0), true, 128 * 1024, true),
        ("static", "static", None, false, 128 * 1024, true),
    ];
    let mut rep = engine::devkit::BenchReport::new("net_64_clients");
    for (key, label, radius, moving, bps, delta) in rows {
        let lo = LoopbackNet::new();
        let mut cfg = NetConfig { relevancy_radius: radius, delta_compression: delta, snapshot_bytes_per_tick: 64 * 1024, ..default() };
        cfg.connection.bytes_per_sec = bps;
        let mut server = build("bench", cfg.clone(), |_| {});
        net::host(server.world_mut(), lo.bind(7777), false);
        let proto = net::protocol_id(server.world());
        let addr = "127.0.0.1:7777".parse().unwrap();
        let mut clients: Vec<ClientEndpoint> =
            (0..64).map(|i| ClientEndpoint::new(Box::new(lo.bind(0)), addr, cfg.connection, proto, i, 0.0)).collect();
        let w = server.world_mut();
        for i in 0..500 {
            let p = Vec3::new((i % 25) as f32 * 8.0, 0.0, (i / 25) as f32 * 8.0);
            w.spawn((Replicated, Transform::from_translation(p).with_rotation(Quat::from_rotation_y(i as f32)), Health(100), Mover(if moving { 3.0 } else { 0.0 })));
        }
        let mut ids = Vec::new();
        let frame = |server: &mut App, clients: &mut [ClientEndpoint]| -> f64 {
            let t0 = Instant::now();
            server.update();
            let dt = t0.elapsed().as_secs_f64();
            let now = server.world().resource::<Time<Real>>().elapsed_secs_f64();
            for c in clients.iter_mut() {
                c.update(now);
                if let Some(conn) = c.conn.as_mut() {
                    conn.drain_received(|_, _| {});
                }
                c.flush(now);
            }
            dt
        };
        for _ in 0..30 {
            frame(&mut server, &mut clients);
        }
        assert!(clients.iter().all(|c| c.status() == ClientStatus::Connected));
        // Give each client a viewpoint entity spread over the field.
        for (k, c) in clients.iter().enumerate() {
            let id = c.id.unwrap();
            ids.push(id);
            let p = Vec3::new((k % 8) as f32 * 25.0, 0.0, (k / 8) as f32 * 25.0);
            server.world_mut().spawn((Replicated, NetOwner(id), NetViewer, Transform::from_translation(p)));
        }
        for _ in 0..120 {
            frame(&mut server, &mut clients);
        }
        let b0: u64 = clients.iter().map(|c| c.stats().unwrap().bytes_recv).sum();
        let frames = 300;
        let mut total = 0.0;
        let mut snap_us = 0.0;
        let mut worst: f64 = 0.0;
        for _ in 0..frames {
            let dt = frame(&mut server, &mut clients);
            total += dt;
            worst = worst.max(dt);
            snap_us += f64::from(server.world().resource::<NetServer>().stats().snapshot_us);
        }
        let b1: u64 = clients.iter().map(|c| c.stats().unwrap().bytes_recv).sum();
        let secs = frames as f64 / 60.0;
        let per_client = (b1 - b0) as f64 / secs / 64.0;
        let st = server.world().resource::<NetServer>().stats();
        println!(
            "[{label}] server frame avg {:.2} ms (worst {:.2}), snapshot pass avg {:.2} ms, per-client down {:.1} KB/s, total {:.2} MB/s, last pass {} updates / {} parts",
            total / frames as f64 * 1000.0,
            worst * 1000.0,
            snap_us / frames as f64 / 1000.0,
            per_client / 1024.0,
            per_client * 64.0 / (1024.0 * 1024.0),
            st.entity_updates,
            st.parts,
        );
        rep = rep
            .value(&format!("{key}.server_frame_ms"), total / frames as f64 * 1000.0)
            .value(&format!("{key}.server_worst_ms"), worst * 1000.0)
            .value(&format!("{key}.snapshot_ms"), snap_us / frames as f64 / 1000.0)
            .value(&format!("{key}.client_down_kbps"), per_client / 1024.0);
    }
    rep.write().unwrap();
}

/// The `net.*` control commands, called in-process the way the control port calls them.
#[cfg(feature = "devtools")]
#[test]
fn control_commands_report_and_drive() {
    use engine::devtools::ControlRegistry;
    use engine::devtools::control::Handler;
    use serde_json::json;
    fn call(app: &mut App, id: &str, p: serde_json::Value) -> Result<serde_json::Value, String> {
        let h = app.world().resource::<ControlRegistry>().get(id).unwrap_or_else(|| panic!("{id} registered")).handler;
        match h {
            Handler::Instant(f) => f(app.world_mut(), p),
            Handler::Deferred(_) => unreachable!(),
        }
    }
    let mut n = Net::new(NetConfig::default(), 1);
    n.wait_connected();
    n.server.world_mut().spawn((Replicated, Transform::default(), Health(1)));
    n.run(10);
    let s = call(&mut n.server, "net.status", json!({})).unwrap();
    assert_eq!(s["role"], "Server");
    assert_eq!(s["state"], "InGame");
    assert_eq!(s["server"]["clients"], 1);
    let c = call(&mut n.clients[0], "net.status", json!({})).unwrap();
    assert_eq!(c["role"], "Client");
    assert_eq!(c["client_id"], 1);
    assert_eq!(c["client"]["entities"], 1);
    let cl = call(&mut n.server, "net.clients", json!({})).unwrap();
    assert_eq!(cl["clients"][0]["id"], 1);
    assert_eq!(cl["clients"][0]["known_entities"], 1);
    assert!(call(&mut n.clients[0], "net.clients", json!({})).is_err(), "not a server");
    let set = call(&mut n.clients[0], "net.conditioner", json!({"latency_ms": 100, "loss": 0.5})).unwrap();
    assert_eq!(set["latency_ms"], 100.0);
    assert_eq!(set["loss"], 0.5);
    assert_eq!(n.clients[0].world().resource::<NetClient>().endpoint.conditioner.settings.latency_ms, 100.0);
    let set = call(&mut n.clients[0], "net.conditioner", json!({"loss": 0})).unwrap();
    assert_eq!(set["latency_ms"], 100.0, "omitted fields unchanged");
    call(&mut n.clients[0], "net.disconnect", json!({})).unwrap();
    n.run(3);
    assert_eq!(n.server.world().resource::<NetServer>().endpoint.len(), 0);
    assert!(call(&mut n.clients[0], "net.connect", json!({})).is_err(), "addr required");
}
