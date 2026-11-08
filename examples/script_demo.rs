//! Lantern Keeper: a small game whose rules live in ruspy node scripts (`docs/SCRIPTING.md`).
//!
//! Walk the glowing cube (WASD / arrows) into lanterns before they gutter out. A quick touch
//! scores 2, a late one 1; a round lasts 30 seconds. Rust only sets the stage:
//! - `levels/script_demo.level.ron`: ground, sun, the Player, the HUD and the Spawner (each a
//!   `Script` node), loaded like any level; `levels/lantern.level.ron`: one lantern, cloned by
//!   `instantiate(...)` from `assets/scripts/spawner.ruspy`.
//! - `Game` is an autoload (`assets/scripts/game.ruspy`: state, score, round clock).
//! - `PhysicsBox` below turns a saved size into an Avian body, so lanterns get a sensor
//!   collider and the player a dynamic one; the scripts see `body_entered(other)`.
//!
//! ```text
//! cargo run --example script_demo -- --play
//! python3 -I scripts/play.py scripts/script-demo.json --example script_demo
//! cargo run --example script_demo -- --bake      # rewrites the two level files, then exits
//! ```

use engine::avian3d::prelude::*;
use engine::level::{LevelConfig, LevelEntity, LevelState, LookRef, Primitive, PrimitiveShape, StableId, file::despawn_level, save_level};
use engine::prelude::*;
use engine::scripting::{Autoloads, Connections, Script, ScriptTimer};

const LEVEL: &str = "levels/script_demo.level.ron";
const LANTERN: &str = "levels/lantern.level.ron";

fn main() {
    let bake = std::env::args().any(|a| a == "--bake");
    let key = |name: &'static str, label: &'static str, a: KeyCode, b: KeyCode| {
        ActionDef::button(name).label(label).group("Gameplay").bind(Binding::key(a)).bind(Binding::key(b))
    };
    let mut app = engine::app(GameInfo::new("script_demo", "Lantern Keeper").tagline("Light them all."));
    app.register_type::<PhysicsBox>()
        .insert_resource(Autoloads(vec![("Game".into(), "game.ruspy".into())]))
        .add_action(key("lk_left", "Left", KeyCode::KeyA, KeyCode::ArrowLeft))
        .add_action(key("lk_right", "Right", KeyCode::KeyD, KeyCode::ArrowRight))
        .add_action(key("lk_up", "Up", KeyCode::KeyW, KeyCode::ArrowUp))
        .add_action(key("lk_down", "Down", KeyCode::KeyS, KeyCode::ArrowDown))
        .add_systems(Startup, camera)
        .add_systems(Update, build_bodies);
    if bake {
        app.add_systems(Update, bake_levels);
    } else {
        app.world_mut().resource_mut::<LevelConfig>().startup = Some(LEVEL.into());
    }
    app.run();
}

fn camera(mut commands: Commands, headless: Res<Headless>) {
    if !headless.0 {
        commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 17.0, 11.0).looking_at(Vec3::new(0.0, 0.0, 0.5), Vec3::Y)));
    }
}

/// A body described as data so it survives in a level file. `sensor`: static trigger volume
/// (lanterns); otherwise a dynamic body that ignores gravity and never sleeps (the player,
/// moved by its script).
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component, Default)]
struct PhysicsBox {
    size: Vec3,
    sensor: bool,
}

fn build_bodies(mut commands: Commands, new: Query<(Entity, &PhysicsBox), Added<PhysicsBox>>) {
    for (e, b) in &new {
        let mut ent = commands.entity(e);
        ent.insert((Collider::cuboid(b.size.x, b.size.y, b.size.z), CollisionEventsEnabled));
        if b.sensor {
            ent.insert((RigidBody::Static, Sensor));
        } else {
            // Avian only reports overlaps for pairs with a dynamic body.
            ent.insert((RigidBody::Dynamic, GravityScale(0.0), SleepingDisabled, LockedAxes::ROTATION_LOCKED));
        }
    }
}

// ---------------------------------------------------------------- level baking (--bake)

fn prim(shape: PrimitiveShape, size: Vec3, color: Color) -> Primitive {
    Primitive { shape, size, color, ..default() }
}

fn spawn_at(world: &mut World, id: u64, name: &str, bundle: impl Bundle) -> Entity {
    world.spawn((LevelEntity { id: StableId(id) }, Name::new(name.to_string()), bundle)).id()
}

fn bake_levels(world: &mut World, mut frame: Local<u32>) {
    *frame += 1;
    if *frame != 3 {
        return;
    }
    spawn_at(world, 1, "Ground", (prim(PrimitiveShape::Plane, Vec3::new(30.0, 0.0, 30.0), Color::srgb(0.16, 0.2, 0.17)), Scenery, Transform::IDENTITY));
    spawn_at(
        world,
        2,
        "Sun",
        (
            DirectionalLight { illuminance: 2_500.0, color: Color::srgb(0.7, 0.75, 1.0), shadow_maps_enabled: true, ..default() },
            Transform::from_xyz(4.0, 9.0, 3.0).looking_at(Vec3::ZERO, Vec3::Y),
        ),
    );
    let player = spawn_at(
        world,
        3,
        "Player",
        (
            prim(PrimitiveShape::Cuboid, Vec3::splat(0.6), Color::srgb(1.0, 0.9, 0.6)),
            Actor,
            Script::new("player.ruspy"),
            PhysicsBox { size: Vec3::splat(0.6), sensor: false },
            Transform::from_xyz(0.0, 0.3, 0.0),
        ),
    );
    let glow = spawn_at(world, 4, "Glow", (PointLight { intensity: 300_000.0, range: 9.0, color: Color::srgb(1.0, 0.8, 0.5), ..default() }, Transform::from_xyz(0.0, 1.2, 0.0)));
    world.entity_mut(glow).insert(ChildOf(player));
    spawn_at(world, 5, "HUD", Script::new("hud.ruspy"));
    spawn_at(
        world,
        6,
        "Spawner",
        (Script::new("spawner.ruspy"), ScriptTimer { wait_time: 1.6, autostart: false, ..default() }, Connections::default().to("timeout", ".", "_on_timeout")),
    );
    world.resource_mut::<LevelState>().header.look = Some(LookRef::Preset("dusk".into()));
    report(save_level(world, LEVEL), LEVEL);
    despawn_level(world);

    // Lantern ids start high so a clone never collides with the ids of the open level.
    let post = spawn_at(
        world,
        1001,
        "Lantern",
        (
            prim(PrimitiveShape::Cuboid, Vec3::new(0.25, 0.9, 0.25), Color::srgb(0.2, 0.2, 0.24)),
            Actor,
            Script::new("lantern.ruspy"),
            PhysicsBox { size: Vec3::new(1.2, 1.4, 1.2), sensor: true },
            Connections::default().to("lit", "/Game", "add_score").to("body_entered", ".", "_on_body_entered"),
            Transform::from_xyz(0.0, 0.5, 0.0),
        ),
    );
    let flame = spawn_at(world, 1002, "Flame", (prim(PrimitiveShape::Sphere, Vec3::splat(0.45), Color::srgb(0.35, 0.3, 0.2)), Actor, Transform::from_xyz(0.0, 0.65, 0.0)));
    world.entity_mut(flame).insert(ChildOf(post));
    report(save_level(world, LANTERN), LANTERN);
    world.write_message(AppExit::Success);
}

fn report(r: Result<engine::level::SaveReport, engine::level::LevelError>, path: &str) {
    match r {
        Ok(r) => info!("baked {path}: {} entities", r.entities),
        Err(e) => error!("bake {path}: {e}"),
    }
}
