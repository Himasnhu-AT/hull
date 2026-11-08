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
        // `camera.ruspy` follows the player (gentle lerp); this is only the starting pose.
        commands.spawn((
            MainCamera,
            Camera3d::default(),
            Script::new("camera.ruspy"),
            Transform::from_xyz(0.0, 7.0, 10.0).looking_at(Vec3::new(0.0, 0.0, 0.0), Vec3::Y),
        ));
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
    let mut id = 100;
    let mut next = || {
        id += 1;
        id
    };
    spawn_at(world, 1, "Ground", (prim(PrimitiveShape::Plane, Vec3::new(160.0, 0.0, 160.0), Color::srgb(0.16, 0.25, 0.17)), Scenery, Transform::IDENTITY));
    // The moon: the look owns the real sun, this one only keeps old tooling happy and stays dim.
    spawn_at(
        world,
        2,
        "Sun",
        (
            DirectionalLight { illuminance: 1.0, color: Color::srgb(0.6, 0.7, 1.0), shadow_maps_enabled: false, ..default() },
            Transform::from_xyz(4.0, 9.0, 3.0).looking_at(Vec3::ZERO, Vec3::Y),
        ),
    );
    // The keeper: a cream capsule holding a small lamp.
    let player = spawn_at(
        world,
        3,
        "Player",
        (
            prim(PrimitiveShape::Capsule, Vec3::new(0.5, 1.0, 0.5), Color::srgb(0.7, 0.55, 0.38)),
            Actor,
            Script::new("player.ruspy"),
            PhysicsBox { size: Vec3::new(0.6, 1.0, 0.6), sensor: false },
            Transform::from_xyz(0.0, 0.5, 0.0),
        ),
    );
    let lamp = spawn_at(world, 7, "Lamp", (prim(PrimitiveShape::Sphere, Vec3::splat(0.22), Color::srgb(2.5, 1.5, 0.5)), Actor, Transform::from_xyz(0.34, 0.15, 0.2)));
    world.entity_mut(lamp).insert(ChildOf(player));
    let glow = spawn_at(world, 4, "Glow", (PointLight { intensity: 28_000.0, range: 7.0, color: Color::srgb(1.0, 0.78, 0.5), ..default() }, Transform::from_xyz(0.0, 1.8, 0.0)));
    world.entity_mut(glow).insert(ChildOf(player));
    spawn_at(world, 5, "HUD", Script::new("hud.ruspy"));
    spawn_at(
        world,
        6,
        "Spawner",
        (Transform::IDENTITY, Script::new("spawner.ruspy"), ScriptTimer { wait_time: 1.6, autostart: false, ..default() }, Connections::default().to("timeout", ".", "_on_timeout")),
    );
    scatter_scenery(world, &mut next);
    world.resource_mut::<LevelState>().header.look = Some(LookRef::Inline(Box::new(night_look())));
    report(save_level(world, LEVEL), LEVEL);
    despawn_level(world);

    // Lantern ids start high so a clone never collides with the ids of the open level.
    // Post (root, carries the script and sensor) + stone base + lamp housing + flame +
    // a weak always-on ember light and a strong "Light" that lantern.ruspy shows when lit.
    let post = spawn_at(
        world,
        1001,
        "Lantern",
        (
            prim(PrimitiveShape::Cuboid, Vec3::new(0.18, 1.0, 0.18), Color::srgb(0.3, 0.2, 0.13)),
            Actor,
            Script::new("lantern.ruspy"),
            PhysicsBox { size: Vec3::new(1.2, 1.4, 1.2), sensor: true },
            Connections::default().to("lit", "/Game", "add_score").to("body_entered", ".", "_on_body_entered"),
            Transform::from_xyz(0.0, 0.5, 0.0),
        ),
    );
    let child = |world: &mut World, id: u64, name: &str, p: Primitive, at: Vec3| {
        let e = spawn_at(world, id, name, (p, Actor, Transform::from_translation(at)));
        world.entity_mut(e).insert(ChildOf(post));
    };
    child(world, 1003, "Base", prim(PrimitiveShape::Cylinder, Vec3::new(0.95, 0.16, 0.0), Color::srgb(0.42, 0.42, 0.47)), Vec3::new(0.0, -0.42, 0.0));
    child(world, 1007, "Cradle", prim(PrimitiveShape::Cuboid, Vec3::new(0.5, 0.14, 0.5), Color::srgb(0.38, 0.25, 0.14)), Vec3::new(0.0, 0.5, 0.0));
    child(world, 1002, "Flame", prim(PrimitiveShape::Sphere, Vec3::splat(0.5), Color::srgb(0.8, 0.42, 0.15)), Vec3::new(0.0, 0.82, 0.0));
    let ember = spawn_at(world, 1005, "Ember", (PointLight { intensity: 14_000.0, range: 4.5, color: Color::srgb(1.0, 0.6, 0.3), ..default() }, Transform::from_xyz(0.0, 0.9, 0.0)));
    world.entity_mut(ember).insert(ChildOf(post));
    let light = spawn_at(
        world,
        1006,
        "Light",
        (PointLight { intensity: 170_000.0, range: 11.0, color: Color::srgb(1.0, 0.7, 0.35), ..default() }, Visibility::Hidden, Transform::from_xyz(0.0, 1.0, 0.0)),
    );
    world.entity_mut(light).insert(ChildOf(post));
    report(save_level(world, LANTERN), LANTERN);
    world.write_message(AppExit::Success);
}

/// Moonlit night: `Look::night()` with a readable gradient sky, a pale horizon glow and an
/// exposure that lets lantern light (lumens) beat the moon (lux) without blowing out.
fn night_look() -> engine::look::Look {
    use engine::look::{Look, Rgb};
    let n = Look::night();
    Look {
        name: "lantern_night".into(),
        sun: engine::look::SunLook { azimuth_deg: 215.0, elevation_deg: 42.0, illuminance: 90.0, color: Rgb([0.55, 0.68, 1.0]), shadows: false, ..n.sun },
        sky: engine::look::SkyLook {
            zenith: Rgb([0.02, 0.04, 0.16]),
            horizon: Rgb([0.22, 0.28, 0.5]),
            ground: Rgb([0.03, 0.04, 0.07]),
            brightness: 55.0,
            ..n.sky
        },
        ambient: engine::look::AmbientLook { color: Rgb([0.5, 0.6, 1.0]), brightness: 6.0, env_intensity: 1.0 },
        fog: engine::look::FogLook { color: Rgb([0.14, 0.19, 0.36]), visibility: 110.0, ..n.fog },
        exposure: engine::look::ExposureLook { ev100: 4.0, ..n.exposure },
        bloom: engine::look::BloomLook { intensity: 0.4, ..n.bloom },
        ..n
    }
}

/// Trees ring the field; rocks, flat moss patches and a few stones sit inside it. Shared
/// meshes and materials (identical primitives hit the primitive cache), all `Scenery`.
fn scatter_scenery(world: &mut World, next: &mut impl FnMut() -> u64) {
    let mut seed = 0x2545_F491_u32;
    let mut rnd = move || {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (seed >> 8) as f32 / 16_777_216.0
    };
    let trunk = Color::srgb(0.3, 0.2, 0.14);
    let leaves = [Color::srgb(0.1, 0.3, 0.2), Color::srgb(0.14, 0.36, 0.2)];
    let mut tree = |world: &mut World, x: f32, z: f32, k: usize, s: f32| {
        let t = spawn_at(world, next(), "Trunk", (prim(PrimitiveShape::Cylinder, Vec3::new(0.4, 2.2, 0.0), trunk), Scenery, Transform::from_xyz(x, 1.1 * s, z).with_scale(Vec3::splat(s))));
        let _ = t;
        spawn_at(world, next(), "Crown", (prim(PrimitiveShape::Sphere, Vec3::splat(1.9), leaves[k]), Scenery, Transform::from_xyz(x, 2.7 * s, z).with_scale(Vec3::new(s, s * 1.15, s))));
    };
    for i in 0..44 {
        let a = i as f32 / 44.0 * std::f32::consts::TAU + rnd() * 0.12;
        let r = 15.5 + rnd() * 9.0;
        tree(world, a.cos() * r, a.sin() * r, (rnd() * 2.0) as usize % 2, 0.8 + rnd() * 0.7);
    }
    let rock = Color::srgb(0.22, 0.23, 0.27);
    for _ in 0..16 {
        let (x, z) = (rnd() * 26.0 - 13.0, rnd() * 26.0 - 13.0);
        if x * x + z * z < 6.0 {
            continue;
        }
        let s = 0.4 + rnd() * 0.6;
        spawn_at(world, next(), "Rock", (prim(PrimitiveShape::Sphere, Vec3::splat(1.0), rock), Scenery, Transform::from_xyz(x, 0.12 * s, z).with_scale(Vec3::new(s * 1.3, s * 0.6, s))));
    }
    let moss = [Color::srgb(0.2, 0.33, 0.2), Color::srgb(0.27, 0.32, 0.17)];
    for i in 0..14 {
        let (x, z) = (rnd() * 28.0 - 14.0, rnd() * 28.0 - 14.0);
        let w = 3.0 + rnd() * 3.0;
        spawn_at(world, next(), "Moss", (prim(PrimitiveShape::Cylinder, Vec3::new(1.0, 0.02, 0.0), moss[i % 2]), Scenery, Transform::from_xyz(x, 0.012 + i as f32 * 0.001, z).with_scale(Vec3::new(w, 1.0, w * 0.7))));
    }
    // Stepping stones across the field.
    for i in 0..9 {
        let x = -12.0 + i as f32 * 3.0;
        let z = (i as f32 * 0.9).sin() * 1.5;
        spawn_at(world, next(), "Stone", (prim(PrimitiveShape::Cylinder, Vec3::new(0.9, 0.05, 0.0), Color::srgb(0.34, 0.3, 0.26)), Scenery, Transform::from_xyz(x, 0.025, z)));
    }
}

fn report(r: Result<engine::level::SaveReport, engine::level::LevelError>, path: &str) {
    match r {
        Ok(r) => info!("baked {path}: {} entities", r.entities),
        Err(e) => error!("bake {path}: {e}"),
    }
}
