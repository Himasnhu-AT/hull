//! Splines: a closed winding road with varying width and bank, built from a `Spline` plus
//! `SplineRoad`, gizmos on. Move a point with the control port and the road follows:
//! `spline.set_point {index, point: {pos: [x, y, z]}}`.
//! `cargo run --example spline_road`

use engine::prelude::*;
use engine::spline::{SplineGizmos, SplinePoint};

fn main() {
    engine::app(GameInfo::new("spline-road", "Spline road")).add_systems(Startup, setup).run();
}

fn setup(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<StandardMaterial>>, headless: Res<Headless>, mut gizmos: ResMut<SplineGizmos>) {
    gizmos.enabled = true;
    if !headless.0 {
        commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 95.0, 70.0).looking_at(Vec3::new(0.0, 0.0, 0.0), Vec3::Y)));
    }
    commands.spawn((
        Name::new("Sun"),
        DirectionalLight { illuminance: 10_000.0, shadow_maps_enabled: false, ..default() },
        Transform::from_xyz(30.0, 60.0, 20.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    commands.spawn((
        Name::new("Ground"),
        Mesh3d(meshes.add(Plane3d::default().mesh().size(240.0, 240.0))),
        MeshMaterial3d(mats.add(StandardMaterial { base_color: Color::srgb(0.3, 0.42, 0.28), perceptual_roughness: 1.0, ..default() })),
        Transform::from_xyz(0.0, -0.05, 0.0),
    ));

    // 12 points around a wobbly ellipse; width 6..13 m, bank follows the turn.
    let points: Vec<SplinePoint> = (0..12)
        .map(|i| {
            let a = i as f32 / 12.0 * std::f32::consts::TAU;
            let r = 1.0 + 0.28 * (a * 3.0).sin();
            let pos = Vec3::new(a.cos() * 65.0 * r, 0.15 + (a * 2.0).sin() * 0.0, a.sin() * 42.0 * r);
            SplinePoint::at(pos).with_width(9.5 + 3.5 * (a * 2.0).sin()).with_bank(0.25 * (a * 3.0).cos()).with_tags(i % 2)
        })
        .collect();
    commands.spawn((
        Name::new("Road"),
        Spline { points, closed: true, ..default() },
        SplineRoad { step: 1.5, uv_scale: 10.0, color: Color::srgb(0.24, 0.24, 0.27) },
        Transform::default(),
        Visibility::default(),
    ));
}
