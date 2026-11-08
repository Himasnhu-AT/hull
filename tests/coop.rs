//! Co-op sessions, headless and deterministic: apps on a `LoopbackNet` with a manually pumped
//! relay, simulated NATs, and fixed 60 Hz steps (all timers use the apps' simulated clock).
//! Run: `cargo test --features net --test coop`.
#![cfg(feature = "net")]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use bevy::ecs::system::RunSystemOnce;
use bevy::time::TimeUpdateStrategy;
use engine::net::session::relay::Relay;
use engine::net::session::route::{NatKind, SimNat};
use engine::net::session::{RouteKind, Session, SessionConfig, SessionError, SessionEvent, SessionHooks, SessionPhase, SocketFactory};
use engine::net::{LoopbackNet, NetClient, NetId, Remote, Replicated, Transport};
use engine::prelude::*;
use serde::{Deserialize, Serialize};

const STEP: Duration = Duration::from_nanos(16_666_667);
const RELAY_PORT: u16 = 7788;

#[derive(Component, Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Health(u32);

#[derive(Resource, Default)]
struct Events(Vec<SessionEvent>);

fn log_events(mut r: MessageReader<SessionEvent>, mut l: ResMut<Events>) {
    l.0.extend(r.read().cloned());
}

struct Game;
impl Plugin for Game {
    fn build(&self, app: &mut App) {
        app.replicate_transform().replicate::<Health>().init_resource::<Events>().add_systems(Update, log_events);
    }
}

fn build(tag: &str) -> App {
    let dir: PathBuf = std::env::temp_dir().join(format!("coop-test-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut app = engine::app_with(GameInfo::new("cooptest", "Coop Test"), EngineOptions::headless_test(dir));
    app.insert_resource(NetConfig { drive_app_state: false, ..default() }).add_plugins(Game).insert_resource(TimeUpdateStrategy::ManualDuration(STEP));
    app.finish();
    app.cleanup();
    app
}

struct World3 {
    lo: LoopbackNet,
    relay: Relay,
    t: f64,
}

impl World3 {
    fn new() -> Self {
        let lo = LoopbackNet::new();
        let relay = Relay::new(lo.bind(RELAY_PORT), 1);
        World3 { lo, relay, t: 0.0 }
    }

    fn cfg(&self, name: &str, nat: Option<NatKind>) -> SessionConfig {
        let lo = self.lo.clone();
        let factory: SocketFactory = Arc::new(move || Ok(Box::new(lo.bind(0)) as Box<dyn Transport>));
        let mut c = SessionConfig::new(self.relay.local_addr());
        c.socket = factory;
        c.name = name.into();
        c.world_seed = 0xC0FFEE;
        c.simulate_nat = nat;
        c
    }

    /// One 60 Hz frame for everyone (relay first, so its answers arrive next frame).
    fn step(&mut self, apps: &mut [&mut App]) {
        self.t += STEP.as_secs_f64();
        self.relay.poll(self.t);
        for a in apps.iter_mut() {
            a.update();
        }
    }

    fn run_until(&mut self, apps: &mut [&mut App], what: &str, max_secs: f64, mut done: impl FnMut(&mut [&mut App]) -> bool) {
        let frames = (max_secs / STEP.as_secs_f64()) as usize;
        for _ in 0..frames {
            self.step(apps);
            if done(apps) {
                return;
            }
        }
        panic!("timed out waiting for: {what}");
    }
}

fn phase(a: &App) -> Option<SessionPhase> {
    a.world().get_resource::<Session>().map(|s| s.phase)
}

fn mirrors(a: &mut App) -> usize {
    a.world_mut().query_filtered::<&NetId, With<Remote>>().iter(a.world()).count()
}

fn events(a: &App) -> Vec<SessionEvent> {
    a.world().resource::<Events>().0.clone()
}

fn spawn_world(host: &mut App, n: u32) {
    for i in 0..n {
        host.world_mut().spawn((Replicated, Transform::from_xyz(i as f32, 0.0, 0.0), Health(10 + i)));
    }
}

fn code_of(a: &App) -> String {
    a.world().resource::<Session>().code.clone().unwrap()
}

#[test]
fn host_join_direct_punch_late_joiner_and_graceful_leave() {
    let mut w = World3::new();
    let (mut h, mut a, mut b) = (build("h1"), build("a1"), build("b1"));
    let nat_h = w.cfg("host", Some(NatKind::PortRestricted));
    Session::host(h.world_mut(), nat_h).unwrap();
    spawn_world(&mut h, 5);
    w.run_until(&mut [&mut h], "invite code", 2.0, |x| phase(x[0]) == Some(SessionPhase::Hosting));
    let code = code_of(&h);
    assert_eq!(code.len(), 6);
    assert!(matches!(events(&h)[0], SessionEvent::Hosting { .. }));

    let nat_a = w.cfg("anna", Some(NatKind::PortRestricted));
    Session::join(a.world_mut(), nat_a, &code.to_lowercase()).unwrap();
    w.run_until(&mut [&mut h, &mut a], "anna in session", 6.0, |x| phase(x[1]) == Some(SessionPhase::InSession) && mirrors(x[1]) == 5);
    let s = a.world().resource::<Session>();
    assert_eq!(s.route, RouteKind::Direct, "port-restricted NATs can punch");
    assert_eq!((s.info.world_seed, s.info.game_version), (0xC0FFEE, 1), "the seed handshake reached the guest");
    assert!(matches!(events(&a)[0], SessionEvent::Joined { route: RouteKind::Direct, .. }));
    let p = s.path_stats();
    assert!(p.direct_tx > 0 && p.relayed_tx == 0, "{p:?}");
    assert_eq!(w.relay.stats().relayed_packets, 0);

    // A late joiner receives the whole current world (join-in-progress); changes made before
    // it joined are included.
    let mut hh = h.world_mut().query::<&mut Health>();
    hh.iter_mut(h.world_mut()).next().unwrap().0 = 99;
    let nat_b = w.cfg("ben", Some(NatKind::PortRestricted));
    Session::join(b.world_mut(), nat_b, &code).unwrap();
    w.run_until(&mut [&mut h, &mut a, &mut b], "ben in session with the world", 6.0, |x| phase(x[2]) == Some(SessionPhase::InSession) && mirrors(x[2]) == 5);
    let names: Vec<_> = h.world().resource::<Session>().peers.iter().map(|p| p.name.clone()).collect();
    w.run_until(&mut [&mut h, &mut a, &mut b], "names", 2.0, |x| x[0].world().resource::<Session>().peers.iter().all(|p| !p.name.is_empty()));
    assert_eq!(names.len(), 3);
    assert_eq!(b.world().resource::<Session>().peers.len(), 3);

    // Graceful leave: the host learns it was on purpose, everyone's peer list shrinks.
    Session::leave(a.world_mut());
    w.run_until(&mut [&mut h, &mut a, &mut b], "anna gone", 2.0, |x| x[0].world().resource::<Session>().peers.len() == 2 && x[2].world().resource::<Session>().peers.len() == 2);
    assert!(events(&h).iter().any(|e| matches!(e, SessionEvent::PeerLeft { graceful: true, .. })));
    assert_eq!(phase(&a), Some(SessionPhase::Closed));
    assert!(events(&a).contains(&SessionEvent::Left));
}

#[test]
fn relay_fallback_when_nats_block_punching() {
    let mut w = World3::new();
    let (mut h, mut a) = (build("h2"), build("a2"));
    let nat_h = w.cfg("host", Some(NatKind::Strict));
    Session::host(h.world_mut(), nat_h).unwrap();
    spawn_world(&mut h, 3);
    w.run_until(&mut [&mut h], "invite code", 2.0, |x| phase(x[0]) == Some(SessionPhase::Hosting));
    let code = code_of(&h);
    let nat_a = w.cfg("anna", Some(NatKind::Strict));
    Session::join(a.world_mut(), nat_a, &code).unwrap();
    w.run_until(&mut [&mut h, &mut a], "anna via the relay", 8.0, |x| phase(x[1]) == Some(SessionPhase::InSession) && mirrors(x[1]) == 3);
    let s = a.world().resource::<Session>();
    assert_eq!(s.route, RouteKind::Relayed);
    assert!(s.path_stats().relayed_tx > 0 && s.path_stats().direct_tx == 0);
    let before = w.relay.stats().relayed_packets;
    assert!(before > 0, "{:?}", w.relay.stats());
    // Live changes keep flowing through the relay.
    let mut q = h.world_mut().query::<&mut Health>();
    q.iter_mut(h.world_mut()).next().unwrap().0 = 1234;
    w.run_until(&mut [&mut h, &mut a], "update over the relay", 2.0, |x| {
        let mut q = x[1].world_mut().query_filtered::<&Health, With<Remote>>();
        q.iter(x[1].world()).any(|h| h.0 == 1234)
    });
    assert!(w.relay.stats().relayed_packets > before, "the update travelled through the relay");
}

#[test]
fn a_simulated_nat_drops_unsolicited_packets() {
    // The strict NAT really drops what it did not ask for (sanity check of the test tool).
    let lo = LoopbackNet::new();
    let relay = lo.bind(1);
    let nat = SimNat::new(lo.bind(2), NatKind::Strict).allow(relay.local_addr());
    let dropped = nat.dropped();
    let mut stranger = lo.bind(3);
    let mut nat = nat;
    stranger.send(nat.local_addr(), b"hello").unwrap();
    let mut buf = Vec::new();
    assert!(nat.recv(&mut buf).is_none());
    assert_eq!(dropped.load(Ordering::Relaxed), 1);
}

#[test]
fn version_mismatch_unknown_code_and_timeout_fail_cleanly() {
    let mut w = World3::new();
    let (mut h, mut a, mut c, mut d) = (build("h3"), build("a3"), build("c3"), build("d3"));
    Session::host(h.world_mut(), w.cfg("host", None)).unwrap();
    w.run_until(&mut [&mut h], "invite code", 2.0, |x| phase(x[0]) == Some(SessionPhase::Hosting));
    let code = code_of(&h);
    let mut old = w.cfg("old", None);
    old.game_version = 2;
    Session::join(a.world_mut(), old, &code).unwrap();
    w.run_until(&mut [&mut h, &mut a], "mismatch", 8.0, |x| phase(x[1]) == Some(SessionPhase::Failed));
    assert_eq!(a.world().resource::<Session>().error, Some(SessionError::VersionMismatch));
    Session::join(c.world_mut(), w.cfg("lost", None), "ZZZZZZ").unwrap();
    w.run_until(&mut [&mut c], "no such room", 3.0, |x| phase(x[0]) == Some(SessionPhase::Failed));
    assert_eq!(c.world().resource::<Session>().error, Some(SessionError::NoSuchRoom));
    // No relay at all: the join times out.
    let mut cfg = w.cfg("nobody", None);
    cfg.relay = "127.0.0.1:1".parse().unwrap();
    cfg.join_timeout_s = 1.0;
    Session::join(d.world_mut(), cfg, "ABCDEF").unwrap();
    w.run_until(&mut [&mut d], "timeout", 3.0, |x| phase(x[0]) == Some(SessionPhase::Failed));
    assert_eq!(d.world().resource::<Session>().error, Some(SessionError::Timeout));
}

struct Blob;
impl SessionHooks for Blob {
    fn welcome(&mut self, world: &mut World, _peer: engine::net::ClientId) -> Option<Vec<u8>> {
        Some(world.resource::<Score>().0.to_le_bytes().to_vec())
    }
    fn apply_welcome(&mut self, world: &mut World, bytes: &[u8]) {
        world.insert_resource(Score(u32::from_le_bytes(bytes.try_into().unwrap())));
    }
}

#[derive(Resource, Default)]
struct Score(u32);

#[test]
fn welcome_hook_carries_game_state_to_a_late_joiner() {
    let mut w = World3::new();
    let (mut h, mut a) = (build("h4"), build("a4"));
    for app in [&mut h, &mut a] {
        app.init_resource::<Score>();
        app.insert_resource(engine::net::session::SessionHooksRes(Box::new(Blob)));
    }
    h.world_mut().resource_mut::<Score>().0 = 4242;
    Session::host(h.world_mut(), w.cfg("host", None)).unwrap();
    w.run_until(&mut [&mut h], "code", 2.0, |x| phase(x[0]) == Some(SessionPhase::Hosting));
    let code = code_of(&h);
    Session::join(a.world_mut(), w.cfg("a", None), &code).unwrap();
    w.run_until(&mut [&mut h, &mut a], "welcome", 6.0, |x| x[1].world().resource::<Score>().0 == 4242);
}

fn three_peers(w: &mut World3, tag: &str) -> (App, App, App) {
    let (mut h, mut a, mut b) = (build(&format!("h-{tag}")), build(&format!("a-{tag}")), build(&format!("b-{tag}")));
    Session::host(h.world_mut(), w.cfg("host", None)).unwrap();
    spawn_world(&mut h, 4);
    w.run_until(&mut [&mut h], "code", 2.0, |x| phase(x[0]) == Some(SessionPhase::Hosting));
    let code = code_of(&h);
    Session::join(a.world_mut(), w.cfg("anna", None), &code).unwrap();
    w.run_until(&mut [&mut h, &mut a], "anna", 6.0, |x| phase(x[1]) == Some(SessionPhase::InSession) && mirrors(x[1]) == 4);
    Session::join(b.world_mut(), w.cfg("ben", None), &code).unwrap();
    w.run_until(&mut [&mut h, &mut a, &mut b], "ben + peers", 6.0, |x| {
        phase(x[2]) == Some(SessionPhase::InSession) && mirrors(x[2]) == 4 && x[1].world().resource::<Session>().peers.len() == 3
    });
    (h, a, b)
}

/// After the host is gone: anna (lowest id) hosts under the same code with the world she was
/// showing, ben rejoins her and sees it again.
fn assert_migrated(w: &mut World3, a: &mut App, b: &mut App, code: &str) {
    w.run_until(&mut [a, b], "migration", 40.0, |x| {
        phase(x[0]) == Some(SessionPhase::Hosting) && phase(x[1]) == Some(SessionPhase::InSession) && mirrors(x[1]) == 4
    });
    let sa = a.world().resource::<Session>();
    assert_eq!((sa.migrations, sa.code.as_deref()), (1, Some(code)), "same invite code");
    assert!(events(a).contains(&SessionEvent::Migrating { i_am_successor: true }));
    assert!(events(a).contains(&SessionEvent::HostMigrated { i_am_host: true }));
    assert!(events(b).contains(&SessionEvent::Migrating { i_am_successor: false }));
    assert!(events(b).contains(&SessionEvent::HostMigrated { i_am_host: false }));
    // The successor's entities are authoritative now, and keep replicating.
    let replicated = a.world_mut().query_filtered::<&Health, With<Replicated>>().iter(a.world()).count();
    assert_eq!(replicated, 4);
    let mut q = a.world_mut().query_filtered::<&mut Health, With<Replicated>>();
    q.iter_mut(a.world_mut()).next().unwrap().0 = 777;
    w.run_until(&mut [a, b], "post-migration replication", 3.0, |x| {
        let mut q = x[1].world_mut().query_filtered::<&Health, With<Remote>>();
        q.iter(x[1].world()).any(|h| h.0 == 777)
    });
    assert_eq!(b.world().resource::<Session>().peers.len(), 2);
    assert!(b.world().get_resource::<NetClient>().is_some());
}

#[test]
fn host_migration_after_a_graceful_leave() {
    let mut w = World3::new();
    let (mut h, mut a, mut b) = three_peers(&mut w, "m1");
    let code = code_of(&h);
    Session::leave(h.world_mut());
    w.run_until(&mut [&mut h, &mut a, &mut b], "host leaving announced", 3.0, |x| events(x[2]).contains(&SessionEvent::HostLeaving));
    assert_migrated(&mut w, &mut a, &mut b, &code);
}

#[test]
fn host_migration_after_a_crash() {
    let mut w = World3::new();
    let (h, mut a, mut b) = three_peers(&mut w, "m2");
    let code = code_of(&h);
    drop(h); // no goodbye: the guests notice by timeout
    assert_migrated(&mut w, &mut a, &mut b, &code);
}

#[cfg(feature = "voice")]
mod voice {
    use super::*;
    use engine::sound::SoundListener;
    use engine::voice::{VoicePlugin, VoiceProximity, VoiceState, VoiceTalker};

    fn voice_app(tag: &str) -> App {
        let dir: PathBuf = std::env::temp_dir().join(format!("coop-voice-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut app = engine::app_with(GameInfo::new("cooptest", "Coop Test"), EngineOptions::headless_test(dir));
        app.insert_resource(NetConfig { drive_app_state: false, ..default() }).add_plugins((Game, VoicePlugin)).insert_resource(TimeUpdateStrategy::ManualDuration(STEP));
        app.finish();
        app.cleanup();
        app
    }

    fn rms(v: &[f32]) -> f32 {
        (v.iter().map(|x| x * x).sum::<f32>() / v.len().max(1) as f32).sqrt()
    }

    #[test]
    fn voice_travels_over_the_session_and_proximity_attenuates_it() {
        let mut w = World3::new();
        let (mut h, mut g) = (voice_app("h"), voice_app("g"));
        Session::host(h.world_mut(), w.cfg("host", None)).unwrap();
        w.run_until(&mut [&mut h], "code", 2.0, |x| phase(x[0]) == Some(SessionPhase::Hosting));
        let code = code_of(&h);
        Session::join(g.world_mut(), w.cfg("guest", None), &code).unwrap();
        w.run_until(&mut [&mut h, &mut g], "joined", 6.0, |x| phase(x[1]) == Some(SessionPhase::InSession));
        // Voice is on once there is company; the guest talks with a generated tone.
        h.world_mut().resource_mut::<VoiceState>().keep_output = true;
        {
            let mut st = g.world_mut().resource_mut::<VoiceState>();
            st.set_test_source(Some("tone:440")).unwrap();
            st.force_talk = Some(true);
        }
        w.run_until(&mut [&mut h, &mut g], "voice active", 2.0, |x| x[0].world().resource::<VoiceState>().active && x[1].world().resource::<VoiceState>().active);
        for _ in 0..120 {
            w.step(&mut [&mut h, &mut g]);
        }
        let hs = h.world().resource::<VoiceState>();
        assert!(g.world().resource::<VoiceState>().sent_frames() > 50, "guest sent frames");
        assert!(hs.talkers.iter().any(|t| t.talker == 1 && t.stats.played > 20), "host plays guest 1: {:?}", hs.talkers);
        let loud = rms(&hs.output[hs.output.len().saturating_sub(8000)..]);
        assert!(loud > 0.05, "the tone is audible: rms {loud}");
        assert!(!h.world().resource::<VoiceState>().transmitting, "the host is silent (no mic)");

        // Proximity: the guest's avatar moves away from the host's listener.
        h.world_mut().insert_resource(VoiceProximity { enabled: true, ..default() });
        h.world_mut().spawn((SoundListener, Transform::default(), GlobalTransform::default()));
        let avatar = h.world_mut().spawn((VoiceTalker(1), Transform::from_xyz(60.0, 0.0, 0.0), GlobalTransform::default())).id();
        h.world_mut().resource_mut::<VoiceState>().output.clear();
        for _ in 0..150 {
            w.step(&mut [&mut h, &mut g]);
        }
        let hs = h.world().resource::<VoiceState>();
        let far = rms(&hs.output[hs.output.len().saturating_sub(4000)..]);
        assert!(far < loud * 0.05, "beyond max distance is silent: {far} vs {loud}");
        *h.world_mut().get_mut::<Transform>(avatar).unwrap() = Transform::from_xyz(2.0, 0.0, 0.0);
        h.world_mut().entity_mut(avatar).insert(GlobalTransform::from(Transform::from_xyz(2.0, 0.0, 0.0)));
        h.world_mut().resource_mut::<VoiceState>().output.clear();
        for _ in 0..150 {
            w.step(&mut [&mut h, &mut g]);
        }
        let hs = h.world().resource::<VoiceState>();
        let near = rms(&hs.output[hs.output.len().saturating_sub(4000)..]);
        assert!(near > loud * 0.8, "inside min distance is full volume: {near} vs {loud}");
    }
}

/// `examples/coop_demo.rs` run headless: two peers, world from the shared seed, a guest driving
/// its cube through the host.
#[path = "../examples/coop_demo.rs"]
#[allow(dead_code)]
mod demo;

fn demo_app(tag: &str) -> App {
    let dir: PathBuf = std::env::temp_dir().join(format!("coop-demo-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut app = engine::app_with(GameInfo::new("cooptest", "Coop Demo"), EngineOptions::headless_test(dir));
    app.insert_resource(NetConfig { drive_app_state: false, ..default() }).add_plugins(demo::CoopDemo).insert_resource(TimeUpdateStrategy::ManualDuration(STEP));
    app.finish();
    app.cleanup();
    app
}

fn pillars(a: &mut App) -> Vec<Vec3> {
    let mut v: Vec<Vec3> = a.world_mut().query_filtered::<&Transform, With<demo::Pillar>>().iter(a.world()).map(|t| t.translation).collect();
    v.sort_by(|x, y| x.to_array().partial_cmp(&y.to_array()).unwrap());
    v
}

#[test]
fn coop_demo_peers_build_the_same_world_and_move_through_the_host() {
    let mut w = World3::new();
    let (mut h, mut g) = (demo_app("h"), demo_app("g"));
    let mut cfg = w.cfg("host", None);
    cfg.world_seed = 99;
    Session::host(h.world_mut(), cfg).unwrap();
    w.run_until(&mut [&mut h], "code", 2.0, |x| phase(x[0]) == Some(SessionPhase::Hosting));
    let code = code_of(&h);
    Session::join(g.world_mut(), w.cfg("guest", None), &code).unwrap();
    w.run_until(&mut [&mut h, &mut g], "both players visible", 6.0, |x| {
        phase(x[1]) == Some(SessionPhase::InSession) && x[1].world_mut().query::<&demo::Player>().iter(x[1].world()).count() == 2
    });
    // The guest's own seed was ignored: it builds from the host's.
    let expected = {
        let mut v = demo::pillar_layout(99);
        v.sort_by(|x, y| x.to_array().partial_cmp(&y.to_array()).unwrap());
        v
    };
    assert_eq!(pillars(&mut h).len(), 24);
    assert_eq!(pillars(&mut h), pillars(&mut g));
    assert_eq!(pillars(&mut g).iter().map(|p| p.x).collect::<Vec<_>>(), expected.iter().map(|p| p.x).collect::<Vec<_>>());
    // The guest steers its cube.
    let x_of = |a: &mut App, id: u32| {
        a.world_mut().query::<(&demo::Player, &Transform)>().iter(a.world()).find(|(p, _)| p.0 == id).map(|(_, t)| t.translation.x).unwrap()
    };
    let start = x_of(&mut h, 1);
    for _ in 0..60 {
        let _ = g.world_mut().run_system_once(|mut tx: NetSender| tx.to_server(&demo::Wish { x: 1.0, z: 0.0 }));
        w.step(&mut [&mut h, &mut g]);
    }
    assert!(x_of(&mut h, 1) > start + 3.0, "the host moved the guest's cube");
    w.run_until(&mut [&mut h, &mut g], "mirror follows", 2.0, |x| x_of(x[1], 1) > start + 2.0);
}
