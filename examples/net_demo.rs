//! Multiplayer demo: orbiting balls (server-simulated, interpolated on clients) and one
//! predicted player cube per client (WASD / arrows), over UDP.
//!
//! ```text
//! cargo run --example net_demo --features net                      # listen server on :7777 (you play too)
//! cargo run --example net_demo --features net -- --server          # dedicated, headless
//! cargo run --example net_demo --features net -- --connect 127.0.0.1:7777
//! ```
//! Drive it from the control port: `net.status`, `net.clients`, `net.conditioner {latency_ms, loss}`,
//! `input.key {key: "d", action: "down"}`; `scripts/net_play.py` runs a server + clients and
//! screenshots them.

use engine::net::{self, NetLaunch, Predicted};
use engine::prelude::*;
use serde::{Deserialize, Serialize};

const ARENA: f32 = 12.0;

/// What an entity is (replicated; clients add the visuals).
#[derive(Component, Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
enum Kind {
    Ball(u8),
    Player(u8),
}

/// Predicted player state.
#[derive(Component, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Body {
    x: f32,
    z: f32,
    vx: f32,
    vz: f32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Move {
    x: i8,
    z: i8,
}

/// Pure step shared by server and client prediction.
fn step(b: &mut Body, i: &Move, dt: f32) {
    let (tx, tz) = (f32::from(i.x) * 6.0, f32::from(i.z) * 6.0);
    let k = (12.0 * dt).min(1.0);
    b.vx += (tx - b.vx) * k;
    b.vz += (tz - b.vz) * k;
    b.x = (b.x + b.vx * dt).clamp(-ARENA, ARENA);
    b.z = (b.z + b.vz * dt).clamp(-ARENA, ARENA);
}

/// Server-side orbit of a ball.
#[derive(Component)]
struct Orbit {
    radius: f32,
    speed: f32,
    phase: f32,
}

struct NetDemo;

impl Plugin for NetDemo {
    fn build(&self, app: &mut App) {
        app.replicate_transform()
            .replicate::<Kind>()
            .replicate::<Body>()
            .predict::<Body, Move>(step)
            .add_systems(Startup, scene.run_if(has_visuals))
            .add_systems(Update, (server_spawns.run_if(resource_exists::<NetServer>), read_keys.run_if(has_visuals), visuals.run_if(has_visuals)))
            .add_systems(FixedUpdate, (orbit.run_if(resource_exists::<NetServer>), body_to_transform.after(NetSet::Predict)));
    }
}

fn scene(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<StandardMaterial>>) {
    commands.spawn((
        Mesh3d(meshes.add(Cuboid::new(ARENA * 2.0 + 2.0, 0.2, ARENA * 2.0 + 2.0))),
        MeshMaterial3d(mats.add(StandardMaterial { base_color: Color::srgb(0.3, 0.34, 0.3), perceptual_roughness: 0.9, ..default() })),
        Transform::from_xyz(0.0, -0.1, 0.0),
    ));
    commands.spawn((
        DirectionalLight { illuminance: 9_000.0, shadow_maps_enabled: true, ..default() },
        Transform::from_xyz(5.0, 12.0, 4.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 15.0, 14.0).looking_at(Vec3::new(0.0, 0.0, 1.0), Vec3::Y)));
}

const COLORS: [Color; 8] = [
    Color::srgb(0.95, 0.35, 0.25),
    Color::srgb(0.25, 0.6, 0.95),
    Color::srgb(0.95, 0.8, 0.2),
    Color::srgb(0.4, 0.85, 0.4),
    Color::srgb(0.8, 0.4, 0.9),
    Color::srgb(0.95, 0.55, 0.15),
    Color::srgb(0.3, 0.9, 0.85),
    Color::srgb(0.9, 0.9, 0.9),
];

/// Meshes for anything that has a `Kind` (replicated entities on clients, own ones on a host).
fn visuals(mut commands: Commands, q: Query<(Entity, &Kind), Added<Kind>>, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<StandardMaterial>>) {
    for (e, k) in &q {
        let (mesh, c): (Mesh, u8) = match *k {
            Kind::Ball(c) => (Sphere::new(0.45).into(), c),
            Kind::Player(c) => (Cuboid::new(0.9, 0.9, 0.9).into(), c),
        };
        let mat = StandardMaterial { base_color: COLORS[c as usize % COLORS.len()], perceptual_roughness: 0.5, ..default() };
        commands.entity(e).insert((Mesh3d(meshes.add(mesh)), MeshMaterial3d(mats.add(mat)), Visibility::default()));
    }
}

#[derive(Default)]
struct Spawned {
    balls: bool,
    host: bool,
}

fn server_spawns(mut commands: Commands, mut done: Local<Spawned>, role: Res<NetRole>, mut events: MessageReader<NetEvent>, owned: Query<(Entity, &NetOwner)>) {
    if !done.balls {
        done.balls = true;
        for i in 0..24 {
            let f = i as f32;
            commands.spawn((
                Replicated,
                Kind::Ball((i % 8) as u8),
                Orbit { radius: 3.0 + (i % 4) as f32 * 2.5, speed: 0.4 + (i % 3) as f32 * 0.25, phase: f * 0.9 },
                Transform::from_xyz(0.0, 0.45, 0.0),
            ));
        }
    }
    let spawn_player = |commands: &mut Commands, id: ClientId| {
        let a = id.0 as f32 * 1.3;
        let body = Body { x: a.cos() * 4.0, z: a.sin() * 4.0, ..default() };
        commands.spawn((Replicated, NetOwner(id), NetViewer, Kind::Player((id.0 % 8) as u8), Transform::from_xyz(body.x, 0.45, body.z), body));
    };
    if *role == NetRole::ListenServer && !done.host {
        done.host = true;
        spawn_player(&mut commands, ClientId::HOST);
    }
    for ev in events.read() {
        match *ev {
            NetEvent::ClientConnected(id) => spawn_player(&mut commands, id),
            NetEvent::ClientDisconnected(id, _) => {
                for (e, o) in &owned {
                    if o.0 == id {
                        commands.entity(e).despawn();
                    }
                }
            }
            _ => {}
        }
    }
}

fn orbit(clock: Res<NetClock>, mut q: Query<(&Orbit, &mut Transform)>) {
    let t = clock.tick as f32 * clock.tick_dt;
    for (o, mut tf) in &mut q {
        let a = o.phase + t * o.speed;
        tf.translation = Vec3::new(a.cos() * o.radius, 0.45 + (a * 3.0).sin().abs() * 0.6, a.sin() * o.radius);
    }
}

/// Server: every player; client: our predicted one (others are interpolated).
fn body_to_transform(mut q: Query<(&Body, &mut Transform, Has<Predicted>)>, role: Res<NetRole>) {
    for (b, mut t, predicted) in &mut q {
        if role.is_server() || predicted {
            t.translation = Vec3::new(b.x, 0.45, b.z);
        }
    }
}

fn read_keys(keys: Res<ButtonInput<KeyCode>>, mut input: ResMut<LocalInput<Move>>) {
    let axis = |neg: [KeyCode; 2], pos: [KeyCode; 2]| i8::from(keys.any_pressed(pos)) - i8::from(keys.any_pressed(neg));
    input.0 = Move { x: axis([KeyCode::KeyA, KeyCode::ArrowLeft], [KeyCode::KeyD, KeyCode::ArrowRight]), z: axis([KeyCode::KeyW, KeyCode::ArrowUp], [KeyCode::KeyS, KeyCode::ArrowDown]) };
}

fn main() {
    let mut app = engine::app(GameInfo::new("engine-net-demo", "Net Demo").tagline("Balls and boxes over UDP."));
    app.add_plugins(NetDemo);
    if NetLaunch::from_args().is_none() {
        // No flag: be a listen server so one window is already playable.
        app.add_systems(Startup, |world: &mut World| {
            if let Err(e) = net::host_udp(world, net::DEFAULT_PORT, true) {
                error!("host failed: {e}");
            }
        });
    }
    app.run();
}
