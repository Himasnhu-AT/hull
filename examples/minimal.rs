//! The smallest game on the engine: a lit ground plane, a cube and a camera; walk around with
//! `--features fps`. `cargo run --example minimal --features fps` (add `--play` to skip the
//! menu, `--headless` for no window). `tests/headless.rs` runs it headless.

use engine::prelude::*;

pub fn info() -> GameInfo {
    GameInfo::new("engine-minimal", "Minimal").tagline("A ground, a cube, a camera.")
}

pub struct MinimalGame;

impl Plugin for MinimalGame {
    fn build(&self, app: &mut App) {
        #[cfg(feature = "fps")]
        app.add_plugins(FpsPlugin);
        app.add_systems(Startup, spawn_world);
    }
}

/// Marker for the cube (tests look it up).
#[derive(Component)]
pub struct Cube;

fn spawn_world(
    mut commands: Commands,
    headless: Res<Headless>,
    mut meshes: Option<ResMut<Assets<Mesh>>>,
    mut mats: Option<ResMut<Assets<StandardMaterial>>>,
) {
    // Meshes/materials only exist with a renderer; colliders work either way.
    let mut look = |mesh: Mesh, color: Color| match (meshes.as_mut(), mats.as_mut()) {
        (Some(m), Some(s)) => Some((Mesh3d(m.add(mesh)), MeshMaterial3d(s.add(StandardMaterial { base_color: color, perceptual_roughness: 0.8, ..default() })))),
        _ => None,
    };

    let mut ground = commands.spawn((Name::new("Ground"), Transform::from_xyz(0.0, -0.1, 0.0)));
    if let Some(l) = look(Cuboid::new(40.0, 0.2, 40.0).into(), Color::srgb(0.35, 0.4, 0.33)) {
        ground.insert(l);
    }
    #[cfg(feature = "physics")]
    ground.insert((engine::avian3d::prelude::RigidBody::Static, engine::avian3d::prelude::Collider::cuboid(40.0, 0.2, 40.0)));

    let mut cube = commands.spawn((Name::new("Cube"), Cube, Transform::from_xyz(0.0, 0.5, -4.0)));
    if let Some(l) = look(Cuboid::new(1.0, 1.0, 1.0).into(), Color::srgb(0.9, 0.45, 0.2)) {
        cube.insert(l);
    }
    #[cfg(feature = "physics")]
    cube.insert((engine::avian3d::prelude::RigidBody::Static, engine::avian3d::prelude::Collider::cuboid(1.0, 1.0, 1.0)));

    if !headless.0 {
        commands.spawn((
            DirectionalLight { illuminance: 10_000.0, shadow_maps_enabled: true, ..default() },
            Transform::from_xyz(4.0, 8.0, 2.0).looking_at(Vec3::ZERO, Vec3::Y),
        ));
    }

    // Camera: render components only with a renderer; headless keeps the transform (aim ray).
    let camera = if headless.0 {
        commands.spawn((MainCamera, Transform::default())).id()
    } else {
        commands.spawn((MainCamera, Camera3d::default(), Transform::default())).id()
    };

    #[cfg(feature = "fps")]
    {
        let ctl = FpsController::default();
        let center = Vec3::new(0.0, ctl.height * 0.5, 2.0);
        commands.spawn(ctl.bundle(center)).add_child(camera);
    }
    #[cfg(not(feature = "fps"))]
    commands.entity(camera).insert(Transform::from_xyz(0.0, 1.6, 3.0).looking_at(Vec3::new(0.0, 0.5, -4.0), Vec3::Y));
}

#[allow(dead_code)]
fn main() {
    engine::app(info()).add_plugins(MinimalGame).run();
}
