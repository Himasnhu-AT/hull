//! Glimmer Run: a small side-scrolling platformer whose rules are all ruspy (dogfood for the
//! scripting layer, `docs/SCRIPTING.md`). Rust only sets the stage: the input actions, a camera,
//! the ground and the level load. Everything else lives in `assets/scripts/platformer/*.ruspy`
//! and `levels/platformer.level.ron`.
//!
//! Run along the ground (A/D or arrows), jump (Space), collect the gold shards, stomp or dodge
//! the two kinds of patrolling enemies, ride the moving platforms to the post at the far end.
//! P pauses.
//!
//! ```text
//! cargo run --example script_platformer
//! python3 -I scripts/play.py scripts/script-platformer.json --example script_platformer
//! ```

use engine::avian3d::prelude::*;
use engine::level::{LevelConfig, Primitive};
use engine::prelude::*;
use engine::scripting::{Autoloads, Script};

fn main() {
    let key = |name: &'static str, label: &'static str, keys: &[KeyCode]| {
        let mut d = ActionDef::button(name).label(label).group("Gameplay");
        for k in keys {
            d = d.bind(Binding::key(*k));
        }
        d
    };
    let mut app = engine::app(GameInfo::new("script_platformer", "Glimmer Run").tagline("Everything here is a script."));
    app.insert_resource(Autoloads(vec![("Game".into(), "scripts/platformer/game.ruspy".into())]))
        .add_action(key("pf_left", "Left", &[KeyCode::KeyA, KeyCode::ArrowLeft]))
        .add_action(key("pf_right", "Right", &[KeyCode::KeyD, KeyCode::ArrowRight]))
        .add_action(key("pf_jump", "Jump", &[KeyCode::Space, KeyCode::KeyW, KeyCode::ArrowUp]))
        .add_action(key("pf_pause", "Pause", &[KeyCode::KeyP]).context("pf_ui"))
        .add_systems(Startup, stage);
    // The pause key must keep working while paused, so it lives in its own always-on context.
    app.world_mut().resource_mut::<engine::actions::InputContexts>().push("pf_ui");
    app.world_mut().resource_mut::<LevelConfig>().startup = Some("levels/platformer.level.ron".into());
    app.run();
}

fn stage(mut commands: Commands, headless: Res<Headless>) {
    // Ground: a long slab, top face at y = 0.
    commands.spawn((
        Name::new("Ground"),
        Primitive::cuboid(Vec3::new(120.0, 1.0, 6.0), Color::srgb(0.28, 0.42, 0.26)),
        RigidBody::Static,
        Collider::cuboid(120.0, 1.0, 6.0),
        Transform::from_xyz(30.0, -0.5, 0.0),
        Scenery,
    ));
    if !headless.0 {
        commands.spawn((
            MainCamera,
            Camera3d::default(),
            Script::new("scripts/platformer/camera.ruspy"),
            Transform::from_xyz(0.0, 3.5, 13.0).looking_at(Vec3::new(0.0, 2.0, 0.0), Vec3::Y),
        ));
    }
}
