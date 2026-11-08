//! Friends co-op demo: one player hosts through a relay, friends join with the invite code.
//! The world is built locally on every peer from the session's shared seed (pillars); the
//! players are server-replicated cubes (WASD / arrows).
//!
//! ```text
//! cargo run --features net --bin relay                                  # rendezvous + relay (once)
//! cargo run --example coop_demo --features net -- --host-session        # prints / shows the invite code
//! cargo run --example coop_demo --features net -- --join ABC234         # on the other machine
//!     [--relay 127.0.0.1:7788] [--name Anna] [--seed 42] [--force-relay]
//! ```
//! `scripts/coop_play.py` runs a relay, a host and a guest and screenshots both. The game logic
//! is the [`CoopDemo`] plugin so `tests/coop.rs` can run two peers headless.

use engine::net::session::{DEFAULT_RELAY_PORT, Session, SessionConfig, SessionEvent, SessionPhase};
use engine::net::wire::Rng;
use engine::prelude::*;
use serde::{Deserialize, Serialize};

const ARENA: f32 = 14.0;

/// A player cube (replicated); the number is the owner's `ClientId`.
#[derive(Component, Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Player(pub u32);

/// Scenery that every peer builds from the shared seed (never replicated).
#[derive(Component)]
pub struct Pillar;

/// Guest -> host: where I want to go (unit-ish vector).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Wish {
    pub x: f32,
    pub z: f32,
}

/// Server side: a player's current wish.
#[derive(Component, Default)]
pub struct Steer(pub Vec2);

#[derive(Resource, Default)]
pub struct SceneryOf(pub Option<u64>);

#[derive(Component)]
struct Hud;

pub struct CoopDemo;

impl Plugin for CoopDemo {
    fn build(&self, app: &mut App) {
        app.replicate_transform()
            .replicate::<Player>()
            .add_net_message::<Wish>(engine::net::Channel::Unreliable)
            .init_resource::<SceneryOf>()
            .add_systems(Startup, (launch, scene.run_if(has_visuals)))
            .add_systems(
                Update,
                (
                    scenery,
                    server_players.run_if(resource_exists::<NetServer>),
                    send_wish.run_if(resource_exists::<NetClient>),
                    steer.run_if(resource_exists::<NetServer>),
                    (visuals, hud).run_if(has_visuals),
                ),
            );
    }
}

/// Pillar positions from the seed: identical on every peer.
pub fn pillar_layout(seed: u64) -> Vec<Vec3> {
    let mut r = Rng::new(seed);
    (0..24)
        .map(|_| {
            let a = (r.next_u64() % 10_000) as f32 / 10_000.0 * std::f32::consts::TAU;
            let d = 4.0 + (r.next_u64() % 1000) as f32 / 1000.0 * (ARENA - 5.0);
            let h = 1.0 + (r.next_u64() % 100) as f32 / 40.0;
            Vec3::new(a.cos() * d, h * 0.5, a.sin() * d)
        })
        .collect()
}

fn launch(world: &mut World) {
    use engine::cli::{arg_value, has_flag};
    let relay = arg_value("relay").unwrap_or_else(|| format!("127.0.0.1:{DEFAULT_RELAY_PORT}"));
    let Some(relay) = engine::net::parse_addr(&relay) else {
        error!("bad --relay {relay}");
        return;
    };
    let mut cfg = SessionConfig::new(relay);
    cfg.name = arg_value("name").unwrap_or_else(|| "player".into());
    cfg.world_seed = arg_value("seed").and_then(|s| s.parse().ok()).unwrap_or(1234);
    cfg.force_relay = has_flag("force-relay");
    // The demo has no menu: leaving ends the app instead of migrating.
    let r = match (has_flag("host-session"), arg_value("join")) {
        (true, _) => Session::host(world, cfg),
        (false, Some(code)) => Session::join(world, cfg, &code),
        _ => return,
    };
    if let Err(e) = r {
        error!("session: {e}");
    }
}

#[allow(clippy::type_complexity)]
fn scenery(mut commands: Commands, session: Option<Res<Session>>, mut built: ResMut<SceneryOf>, old: Query<Entity, With<Pillar>>, assets: Option<(ResMut<Assets<Mesh>>, ResMut<Assets<StandardMaterial>>)>) {
    let Some(s) = session else { return };
    if !matches!(s.phase, SessionPhase::Hosting | SessionPhase::InSession) || built.0 == Some(s.info.world_seed) {
        return;
    }
    built.0 = Some(s.info.world_seed);
    for e in &old {
        commands.entity(e).despawn();
    }
    let visuals = assets.map(|(mut m, mut mats)| (m.add(Cuboid::new(0.8, 1.0, 0.8)), mats.add(StandardMaterial { base_color: Color::srgb(0.55, 0.5, 0.45), perceptual_roughness: 0.9, ..default() })));
    for p in pillar_layout(s.info.world_seed) {
        let mut e = commands.spawn((Pillar, Transform::from_translation(p).with_scale(Vec3::new(1.0, p.y * 2.0, 1.0))));
        if let Some((mesh, mat)) = &visuals {
            e.insert((Mesh3d(mesh.clone()), MeshMaterial3d(mat.clone()), Visibility::default()));
        }
    }
}

fn server_players(mut commands: Commands, role: Res<NetRole>, mut started: Local<bool>, mut events: MessageReader<NetEvent>, players: Query<(Entity, &Player)>) {
    let spawn = |commands: &mut Commands, id: u32| {
        let a = id as f32 * 1.3;
        commands.spawn((Replicated, Player(id), Steer::default(), Transform::from_xyz(a.cos() * 2.0, 0.45, a.sin() * 2.0)));
    };
    if *role == NetRole::ListenServer && !*started {
        *started = true;
        spawn(&mut commands, 0);
    }
    for ev in events.read() {
        match *ev {
            NetEvent::ClientConnected(id) => spawn(&mut commands, id.0),
            NetEvent::ClientDisconnected(id, _) => {
                for (e, p) in &players {
                    if p.0 == id.0 {
                        commands.entity(e).despawn();
                    }
                }
            }
            _ => {}
        }
    }
}

fn keys_wish(keys: &ButtonInput<KeyCode>) -> Vec2 {
    let axis = |neg: [KeyCode; 2], pos: [KeyCode; 2]| f32::from(i8::from(keys.any_pressed(pos)) - i8::from(keys.any_pressed(neg)));
    Vec2::new(axis([KeyCode::KeyA, KeyCode::ArrowLeft], [KeyCode::KeyD, KeyCode::ArrowRight]), axis([KeyCode::KeyW, KeyCode::ArrowUp], [KeyCode::KeyS, KeyCode::ArrowDown]))
}

fn send_wish(keys: Option<Res<ButtonInput<KeyCode>>>, mut tx: NetSender) {
    let w = keys.map_or(Vec2::ZERO, |k| keys_wish(&k));
    if w != Vec2::ZERO {
        tx.to_server(&Wish { x: w.x, z: w.y });
    }
}

/// Server: guests' wishes (and the host's keys) move the cubes.
fn steer(
    time: Res<Time>,
    keys: Option<Res<ButtonInput<KeyCode>>>,
    mut wishes: MessageReader<FromClient<Wish>>,
    mut q: Query<(&Player, &mut Steer, &mut Transform)>,
) {
    let own = keys.map_or(Vec2::ZERO, |k| keys_wish(&k));
    for m in wishes.read() {
        for (p, mut s, _) in &mut q {
            if p.0 == m.client.0 {
                s.0 = Vec2::new(m.message.x, m.message.z);
            }
        }
    }
    for (p, mut s, mut t) in &mut q {
        let w = if p.0 == 0 { own } else { s.0 };
        t.translation += Vec3::new(w.x, 0.0, w.y).normalize_or_zero() * 6.0 * time.delta_secs();
        t.translation.x = t.translation.x.clamp(-ARENA, ARENA);
        t.translation.z = t.translation.z.clamp(-ARENA, ARENA);
        s.0 = Vec2::ZERO; // wishes are re-sent every frame while a key is held
    }
}

fn scene(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<StandardMaterial>>) {
    commands.spawn((
        Mesh3d(meshes.add(Cuboid::new(ARENA * 2.0 + 2.0, 0.2, ARENA * 2.0 + 2.0))),
        MeshMaterial3d(mats.add(StandardMaterial { base_color: Color::srgb(0.3, 0.38, 0.3), perceptual_roughness: 0.9, ..default() })),
        Transform::from_xyz(0.0, -0.1, 0.0),
    ));
    commands.spawn((DirectionalLight { illuminance: 9_000.0, shadow_maps_enabled: true, ..default() }, Transform::from_xyz(6.0, 14.0, 5.0).looking_at(Vec3::ZERO, Vec3::Y)));
    commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 22.0, 16.0).looking_at(Vec3::ZERO, Vec3::Y)));
    commands.spawn((Hud, Text::new("not in a session"), TextFont { font_size: FontSize::Px(22.0), ..default() }, Node { position_type: PositionType::Absolute, left: Val::Px(16.0), top: Val::Px(12.0), ..default() }));
}

const COLORS: [Color; 4] = [Color::srgb(0.95, 0.35, 0.25), Color::srgb(0.25, 0.6, 0.95), Color::srgb(0.95, 0.8, 0.2), Color::srgb(0.4, 0.85, 0.4)];

fn visuals(mut commands: Commands, q: Query<(Entity, &Player), Added<Player>>, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<StandardMaterial>>) {
    for (e, p) in &q {
        let mat = StandardMaterial { base_color: COLORS[p.0 as usize % COLORS.len()], perceptual_roughness: 0.5, ..default() };
        commands.entity(e).insert((Mesh3d(meshes.add(Cuboid::new(0.9, 0.9, 0.9))), MeshMaterial3d(mats.add(mat)), Visibility::default()));
    }
}

fn hud(session: Option<Res<Session>>, mut q: Query<&mut Text, With<Hud>>, mut events: MessageReader<SessionEvent>) {
    let _ = events.read().count();
    let Some(s) = session else { return };
    let line = match (&s.code, s.phase) {
        (Some(c), SessionPhase::Hosting | SessionPhase::InSession) => {
            let peers: Vec<_> = s.peers.iter().map(|p| if p.name.is_empty() { format!("#{}", p.id) } else { p.name.clone() }).collect();
            let via = if s.role == engine::net::session::SessionRole::Guest { format!(" via {:?}", s.route) } else { String::new() };
            format!("invite code {c}  |  {:?}{via}  |  seed {}  |  {}", s.role, s.info.world_seed, peers.join(", "))
        }
        _ => format!("{:?} ...", s.phase),
    };
    for mut t in &mut q {
        if t.0 != line {
            t.0 = line.clone();
        }
    }
}

#[allow(dead_code)]
fn main() {
    let mut app = engine::app(GameInfo::new("engine-coop-demo", "Coop Demo").tagline("Friends co-op over a relay."));
    app.insert_resource(NetConfig { drive_app_state: false, ..default() }).add_plugins(CoopDemo);
    app.run();
}
