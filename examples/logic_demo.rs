//! Logic graph + ruspy script demo: a door leaf that slides up when the player box walks into its
//! trigger zone
//! (or when E is pressed) and closes after it leaves. The behaviour is data:
//! `assets/logic/door.logic.ron` (overlap, delay, set, script, tick) and
//! `assets/scripts/score.ruspy` (counts the openings).
//!
//! ```text
//! cargo run --example logic_demo -- --play
//! python3 -I scripts/play.py scripts/logic-demo.json --example logic_demo
//! ```
//! Control port: `logic.list`, `logic.fire`, `logic.diagnostics`, `logic.reload`.

use engine::avian3d::prelude::*;
use engine::logic::Logic;
use engine::prelude::*;

fn main() {
    let mut app = engine::app(GameInfo::new("logic_demo", "Logic demo").tagline("Doors as data."));
    app.register_type::<Door>()
        .add_action(ActionDef::button("open_door").label("Open door").group("Gameplay").bind(Binding::key(KeyCode::KeyE)))
        .add_systems(Startup, spawn)
        .add_systems(Update, walk)
        .run();
}

/// State the door graph reads and writes (`Door.open`, `Door.opens`).
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
struct Door {
    open: bool,
    opens: u32,
}

/// W / S walk the player box toward / away from the door.
fn walk(keys: Res<ButtonInput<KeyCode>>, mut q: Query<&mut LinearVelocity, With<Player>>) {
    let dir = keys.pressed(KeyCode::KeyS) as i8 - keys.pressed(KeyCode::KeyW) as i8;
    for mut v in &mut q {
        v.0 = Vec3::new(0.0, 0.0, dir as f32 * 3.0);
    }
}

#[derive(Component)]
struct Player;

fn spawn(
    mut commands: Commands,
    headless: Res<Headless>,
    mut meshes: Option<ResMut<Assets<Mesh>>>,
    mut mats: Option<ResMut<Assets<StandardMaterial>>>,
) {
    let mut look = |mesh: Mesh, color: Color| match (meshes.as_mut(), mats.as_mut()) {
        (Some(m), Some(s)) => Some((Mesh3d(m.add(mesh)), MeshMaterial3d(s.add(StandardMaterial { base_color: color, perceptual_roughness: 0.8, ..default() })))),
        _ => None,
    };
    let mut ground = commands.spawn((Name::new("Ground"), Transform::from_xyz(0.0, -0.1, 0.0)));
    if let Some(l) = look(Cuboid::new(24.0, 0.2, 24.0).into(), Color::srgb(0.3, 0.34, 0.3)) {
        ground.insert(l);
    }
    for (i, x) in [-3.0_f32, 3.0].into_iter().enumerate() {
        let mut wall = commands.spawn((Name::new(format!("Wall{i}")), Transform::from_xyz(x, 2.0, 0.0)));
        if let Some(l) = look(Cuboid::new(4.0, 4.0, 0.6).into(), Color::srgb(0.55, 0.55, 0.6)) {
            wall.insert(l);
        }
    }
    // The trigger zone carries the graph (`Door` state + `Logic`); the graph moves the leaf.
    commands.spawn((
        Name::new("Door"),
        Door::default(),
        Logic::new("logic/door.logic.ron"),
        Transform::from_xyz(0.0, 1.5, 0.0),
        RigidBody::Static,
        Collider::cuboid(2.4, 3.0, 3.0),
        Sensor,
        CollisionEventsEnabled,
    ));
    let mut leaf = commands.spawn((Name::new("DoorLeaf"), Transform::from_xyz(0.0, 1.5, 0.0)));
    if let Some(l) = look(Cuboid::new(2.0, 3.0, 0.4).into(), Color::srgb(0.6, 0.38, 0.2)) {
        leaf.insert(l);
    }
    // The player: a box. `ecs.set` its LinearVelocity to walk it.
    let mut player = commands.spawn((
        Name::new("Player"),
        Player,
        Transform::from_xyz(0.0, 0.5, 6.0),
        // Avian only reports overlaps for pairs with a dynamic body; no gravity, no tipping.
        RigidBody::Dynamic,
        GravityScale(0.0),
        // A resting body falls asleep, which ends its overlaps.
        SleepingDisabled,
        LockedAxes::ROTATION_LOCKED,
        Collider::cuboid(0.8, 1.0, 0.8),
        LinearVelocity::default(),
    ));
    if let Some(l) = look(Cuboid::new(0.8, 1.0, 0.8).into(), Color::srgb(0.85, 0.25, 0.2)) {
        player.insert(l);
    }
    if !headless.0 {
        commands.spawn((
            DirectionalLight { illuminance: 10_000.0, shadow_maps_enabled: true, ..default() },
            Transform::from_xyz(4.0, 8.0, 6.0).looking_at(Vec3::ZERO, Vec3::Y),
        ));
        commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(7.0, 4.0, 10.0).looking_at(Vec3::new(0.0, 2.0, 1.0), Vec3::Y)));
    }
}
