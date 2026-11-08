//! Level files end to end: builds a small level in code (ground, cubes, a sphere, lights, a
//! parent with a child), saves it to `levels/demo.level.ron`, despawns it and loads it back, so
//! what you see is what the file says. The camera is built by code (not part of the level).
//!
//! `cargo run --example level_demo` (writes the file, then plays the loaded level)
//! `cargo run --example level_demo -- --level levels/demo.level.ron` (just plays the file;
//! edit it while the game runs and it reloads).

use engine::level::{
    LevelConfig, LevelEntity, LevelState, LookRef, Primitive, PrimitiveShape, file::despawn_level, load_level, new_stable_id, save_level,
};
use engine::prelude::*;

const PATH: &str = "levels/demo.level.ron";

fn main() {
    engine::app(GameInfo::new("level-demo", "Level demo").tagline("Levels are files."))
        .add_systems(Startup, (camera, build_level))
        .add_systems(Update, round_trip)
        .run();
}

fn camera(mut commands: Commands, headless: Res<Headless>) {
    if headless.0 {
        return;
    }
    commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(7.0, 5.0, 9.0).looking_at(Vec3::new(0.0, 0.8, 0.0), Vec3::Y)));
}

/// Level content, spawned like any entities plus a `LevelEntity` with a fresh id.
fn build_level(world: &mut World) {
    if world.resource::<LevelConfig>().startup.is_some() {
        return; // `--level`: the file is the content
    }
    let spawn = |world: &mut World, name: &str, p: Primitive, at: Vec3| {
        let id = new_stable_id(world);
        world.spawn((LevelEntity { id }, Name::new(name.to_string()), p, Transform::from_translation(at))).id()
    };
    spawn(world, "Ground", Primitive::plane(30.0, 30.0, Color::srgb(0.36, 0.42, 0.34)), Vec3::ZERO);
    spawn(world, "Pillar", Primitive { shape: PrimitiveShape::Cylinder, size: Vec3::new(1.0, 3.0, 1.0), color: Color::srgb(0.75, 0.72, 0.65), ..default() }, Vec3::new(-3.0, 1.5, -1.0));
    let crate_ = spawn(world, "Crate", Primitive::cuboid(Vec3::splat(1.2), Color::srgb(0.85, 0.5, 0.2)), Vec3::new(0.0, 0.6, 0.0));
    let ball = spawn(world, "Ball", Primitive::sphere(1.0, Color::srgb(0.2, 0.5, 0.9)), Vec3::new(0.0, 1.5, 0.0));
    world.entity_mut(ball).insert(ChildOf(crate_)); // rides on the crate
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
    world.resource_mut::<LevelState>().header.look = Some(LookRef::Preset("clear_day".into()));
}

/// A few frames in (meshes built): save, drop the level, load it from the file.
fn round_trip(world: &mut World, mut frame: Local<u32>) {
    *frame += 1;
    if *frame != 5 || world.resource::<LevelConfig>().startup.is_some() {
        return;
    }
    match save_level(world, PATH) {
        Ok(r) => info!("saved {PATH}: {} entities", r.entities),
        Err(e) => return error!("{e}"),
    }
    despawn_level(world);
    match load_level(world, PATH) {
        Ok(n) => info!("loaded {PATH}: {n} entities"),
        Err(e) => error!("{e}"),
    }
}
