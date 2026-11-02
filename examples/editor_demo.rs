//! The level editor on a small level: ground, a few shapes, lights, one library model.
//!
//! `cargo run --example editor_demo --features editor -- --editor`
//! `cargo run --example editor_demo --features editor -- --editor --level levels/editor_demo.level.ron`
//!
//! Without `--editor` it is the game: it builds the same level and shows it. Drive the editor
//! from scripts with the `editor.*` control commands (docs/EDITOR.md).
//!
//! The level's entities carry `LevelEntity` (saved, editable); the beacon is built by code only,
//! so the editor shows it as *generated* (greyed, read-only).

use bevy::world_serialization::WorldAssetRoot;
use engine::editor::EditorConfig;
use engine::paths::AssetsDir;
use engine::level::{LevelConfig, LevelEntity, LevelState, LookRef, Primitive, PrimitiveShape, new_stable_id};
use engine::prelude::*;

const CAR: &str = "library/cars/kenney-car-kit/sedan.glb#Scene0";

fn main() {
    let mut app = engine::app(GameInfo::new("editor-demo", "Editor demo").tagline("Edit the level."));
    // The Play build needs the example's feature.
    app.insert_resource(EditorConfig { play_features: Some("editor".into()), ..default() });
    app.add_systems(Startup, build_level).run();
}

fn build_level(world: &mut World) {
    if world.resource::<LevelConfig>().startup.is_some() {
        return; // `--level`: the file is the content
    }
    let spawn = |world: &mut World, name: &str, p: Primitive, at: Vec3| {
        let id = new_stable_id(world);
        world.spawn((LevelEntity { id }, Name::new(name.to_string()), p, Transform::from_translation(at))).id()
    };
    spawn(world, "Ground", Primitive::plane(40.0, 40.0, Color::srgb(0.36, 0.42, 0.34)), Vec3::ZERO);
    spawn(world, "Pillar", Primitive { shape: PrimitiveShape::Cylinder, size: Vec3::new(1.0, 3.0, 1.0), color: Color::srgb(0.75, 0.72, 0.65), ..default() }, Vec3::new(-3.0, 1.5, -1.0));
    let crate_ = spawn(world, "Crate", Primitive::cuboid(Vec3::splat(1.2), Color::srgb(0.85, 0.5, 0.2)), Vec3::new(0.0, 0.6, 0.0));
    let ball = spawn(world, "Ball", Primitive::sphere(1.0, Color::srgb(0.2, 0.5, 0.9)), Vec3::new(0.0, 1.5, 0.0));
    world.entity_mut(ball).insert(ChildOf(crate_));
    spawn(world, "Slab", Primitive::cuboid(Vec3::new(4.0, 0.3, 1.5), Color::srgb(0.6, 0.6, 0.65)), Vec3::new(3.0, 0.15, 2.0));

    let id = new_stable_id(world);
    world.spawn((
        LevelEntity { id },
        Name::new("Sun"),
        DirectionalLight { illuminance: 9_000.0, shadow_maps_enabled: true, ..default() },
        Transform::from_xyz(4.0, 8.0, 3.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    let id = new_stable_id(world);
    world.spawn((
        LevelEntity { id },
        Name::new("Lamp"),
        PointLight { intensity: 400_000.0, range: 14.0, color: Color::srgb(1.0, 0.8, 0.6), ..default() },
        Transform::from_xyz(-1.0, 3.0, 3.0),
    ));
    if world.resource::<AssetsDir>().has("library/cars/kenney-car-kit/sedan.glb") {
        let id = new_stable_id(world);
        let handle = world.resource::<AssetServer>().load(CAR);
        world.spawn((LevelEntity { id }, Name::new("Sedan"), WorldAssetRoot(handle), Transform::from_xyz(5.0, 0.0, -3.0).with_rotation(Quat::from_rotation_y(0.6))));
    }
    // Code-built, not part of the level: shows as generated in the outliner.
    let mesh = world.resource_mut::<Assets<Mesh>>().add(Sphere::new(0.4));
    let mat = world.resource_mut::<Assets<StandardMaterial>>().add(StandardMaterial { base_color: Color::srgb(0.9, 0.2, 0.5), emissive: LinearRgba::rgb(0.6, 0.0, 0.2), ..default() });
    world.spawn((Name::new("Code-built beacon"), Mesh3d(mesh), MeshMaterial3d(mat), Transform::from_xyz(-5.0, 0.4, 3.0)));
    world.resource_mut::<LevelState>().header.look = Some(LookRef::Preset("clear_day".into()));
}
