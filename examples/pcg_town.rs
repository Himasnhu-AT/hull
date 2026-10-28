//! PCG: a town dressed by a graph from `assets/pcg/town.pcg.ron` (trees in groves, rocks,
//! street lamps), cell by cell. `cargo run --example pcg_town --features pcg`.

use std::sync::Arc;

use engine::pcg::pcg_core::{Area, Inputs, Polyline, Rect};
use engine::pcg::{PcgCatalog, PcgGraphRef, PcgLight, PcgVolume};
use engine::prelude::*;

fn main() {
    engine::app(GameInfo::new("engine-pcg-town", "PCG Town")).add_plugins(PcgTown).run();
}

struct PcgTown;

impl Plugin for PcgTown {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, setup);
    }
}

fn houses() -> Vec<(Vec2, Vec2)> {
    vec![(Vec2::new(-20.0, -10.0), Vec2::new(6.0, 5.0)), (Vec2::new(15.0, 12.0), Vec2::new(8.0, 6.0)), (Vec2::new(30.0, -25.0), Vec2::new(5.0, 7.0)), (Vec2::new(-35.0, 25.0), Vec2::new(7.0, 7.0))]
}

fn setup(
    mut commands: Commands,
    server: Res<AssetServer>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<StandardMaterial>>,
    mut catalog: ResMut<PcgCatalog>,
) {
    let mat = |m: &mut Assets<StandardMaterial>, c: Color| m.add(StandardMaterial { base_color: c, perceptual_roughness: 0.9, ..default() });
    // Catalog: item names in the graph → assets.
    let tree = mat(&mut mats, Color::srgb(0.18, 0.42, 0.2));
    catalog
        .mesh("tree", meshes.add(Cone { radius: 1.6, height: 5.0 }.mesh().build().translated_by(Vec3::Y * 2.5)), tree.clone())
        .mesh("bush", meshes.add(Sphere::new(0.9).mesh().ico(2).unwrap().translated_by(Vec3::Y * 0.6)), tree)
        .mesh("rock", meshes.add(Sphere::new(0.35).mesh().ico(1).unwrap()), mat(&mut mats, Color::srgb(0.45, 0.43, 0.4)))
        .mesh("lamp_post", meshes.add(Cylinder::new(0.08, 4.0).mesh().build().translated_by(Vec3::Y * 2.0)), mat(&mut mats, Color::srgb(0.15, 0.15, 0.17)));
    catalog.lights.insert("lamp_light".into(), PcgLight::Point(PointLight { intensity: 60_000.0, range: 12.0, color: Color::srgb(1.0, 0.85, 0.6), ..default() }, Vec3::Y * 4.1));

    // Inputs: lots to dress, houses to keep clear of, streets.
    let mut inputs = Inputs::default()
        .rects("lots", vec![Rect::new(Vec2::ZERO, Vec2::new(60.0, 45.0))])
        .lines("streets", vec![Polyline { points: vec![Vec3::new(-60.0, 0.0, 0.0), Vec3::new(60.0, 0.0, 0.0)], closed: false, tag: "street".into() }]);
    let block_mat = mat(&mut mats, Color::srgb(0.75, 0.68, 0.58));
    let mut blocks = Vec::new();
    for (c, h) in houses() {
        blocks.push(Rect::new(c, h));
        commands.spawn((Mesh3d(meshes.add(Cuboid::new(h.x * 2.0, 6.0, h.y * 2.0))), MeshMaterial3d(block_mat.clone()), Transform::from_xyz(c.x, 3.0, c.y), Scenery));
    }
    inputs = inputs.rects("blocks", blocks);
    // The street itself, so lamps line something.
    commands.spawn((Mesh3d(meshes.add(Cuboid::new(120.0, 0.05, 8.0))), MeshMaterial3d(mat(&mut mats, Color::srgb(0.2, 0.2, 0.22))), Transform::from_xyz(0.0, 0.03, -4.0), Scenery));
    commands.spawn((Mesh3d(meshes.add(Cuboid::new(130.0, 0.2, 100.0))), MeshMaterial3d(mat(&mut mats, Color::srgb(0.32, 0.4, 0.28))), Transform::from_xyz(0.0, -0.1, 0.0), Scenery));

    commands.spawn(PcgVolume {
        graph: PcgGraphRef::Asset(server.load("pcg/town.pcg.ron")),
        inputs: Arc::new(inputs),
        area: Area::new(Vec2::new(-64.0, -48.0), Vec2::new(64.0, 48.0)),
        cell: 32.0,
    });

    commands.spawn((
        DirectionalLight { illuminance: 8_000.0, shadow_maps_enabled: true, ..default() },
        Transform::from_xyz(30.0, 50.0, 20.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 45.0, 70.0).looking_at(Vec3::new(0.0, 0.0, -5.0), Vec3::Y)));
}
