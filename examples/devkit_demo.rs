//! The devkit in one small game: spinning cubes whose speed comes from a hot-reloaded
//! `<data>/tuning.json`, a `Progress` resource saved through `SavePlugin` (thumbnails in
//! windowed / `--offscreen` runs), a `profile_scope!` around the spin system, and reflected
//! components for the `ecs.*` inspector.
//!
//! ```text
//! cargo run --example devkit_demo -- --play                 # window
//! python3 -I scripts/play.py scripts/devkit-demo.json --example devkit_demo   # offscreen, driven
//! cargo run --example devkit_demo -- --cubes 2000 --play    # heavier scene
//! ```

use engine::cli::arg_value;
use engine::devkit::save::Playtime;
use engine::prelude::*;
use serde::{Deserialize, Serialize};

fn info() -> GameInfo {
    GameInfo::new("devkit_demo", "Devkit demo")
}

fn main() {
    let mut app = engine::app(info());
    if !app.is_plugin_added::<bevy::input::InputPlugin>() {
        app.add_plugins(bevy::input::InputPlugin);
    }
    app.add_plugins(DemoGame).run();
}

/// Spins its entity around Y (degrees per second × `Tuning.speed`).
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
struct Spinner {
    deg_per_sec: f32,
}

#[derive(Resource, Reflect, Serialize, Deserialize, Default, Clone, PartialEq, Debug)]
#[reflect(Resource)]
#[serde(default)]
struct Progress {
    spins: u32,
    best_speed: f32,
}

#[derive(Resource, Reflect, Deserialize, Clone, PartialEq, Debug)]
#[reflect(Resource)]
#[serde(default)]
struct Tuning {
    speed: f32,
    color: [f32; 3],
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning { speed: 1.0, color: [0.9, 0.45, 0.2] }
    }
}

struct DemoGame;

impl Plugin for DemoGame {
    fn build(&self, app: &mut App) {
        app.register_type::<Spinner>()
            .register_type::<Progress>()
            .register_type::<Tuning>()
            .init_resource::<Tuning>()
            .init_resource::<Progress>()
            .hot_reload_json::<Tuning>(WatchPath::data("tuning.json"), None)
            .add_plugins(SavePlugin::<Progress>::new(SaveConfig { version: 1, autosave_secs: Some(60.0), ..default() }))
            .add_systems(Startup, spawn_world)
            .add_systems(Update, (spin.run_if(in_game).run_if(not_paused), recolor));
    }
}

fn spawn_world(
    mut commands: Commands,
    headless: Res<Headless>,
    tuning: Res<Tuning>,
    mut meshes: Option<ResMut<Assets<Mesh>>>,
    mut mats: Option<ResMut<Assets<StandardMaterial>>>,
) {
    let n: usize = arg_value("cubes").and_then(|v| v.parse().ok()).unwrap_or(25);
    let side = (n as f32).sqrt().ceil() as usize;
    let mut look = |mesh: Mesh, color: Color| match (meshes.as_mut(), mats.as_mut()) {
        (Some(m), Some(s)) => Some((Mesh3d(m.add(mesh)), MeshMaterial3d(s.add(StandardMaterial { base_color: color, perceptual_roughness: 0.7, ..default() })))),
        _ => None,
    };
    let half = side as f32 * 0.75;
    let mut ground = commands.spawn((Name::new("Ground"), Transform::from_xyz(0.0, -0.1, 0.0)));
    if let Some(l) = look(Cuboid::new(half * 2.0 + 4.0, 0.2, half * 2.0 + 4.0).into(), Color::srgb(0.32, 0.36, 0.3)) {
        ground.insert(l);
    }
    // One shared mesh + material for every cube (recolor edits the material).
    let cube = look(Cuboid::new(0.8, 0.8, 0.8).into(), Color::srgb(tuning.color[0], tuning.color[1], tuning.color[2]));
    for i in 0..n {
        let (x, z) = ((i % side) as f32 * 1.5 - half, (i / side) as f32 * 1.5 - half);
        let mut e = commands.spawn((Name::new(format!("Cube{i}")), Spinner { deg_per_sec: 30.0 + (i % 7) as f32 * 15.0 }, Transform::from_xyz(x, 0.5, z)));
        if let Some(l) = &cube {
            e.insert(l.clone());
        }
    }
    if !headless.0 {
        commands.spawn((
            DirectionalLight { illuminance: 10_000.0, shadow_maps_enabled: true, ..default() },
            Transform::from_xyz(4.0, 8.0, 2.0).looking_at(Vec3::ZERO, Vec3::Y),
        ));
        commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, half + 4.0, half * 1.6 + 6.0).looking_at(Vec3::ZERO, Vec3::Y)));
    }
}

fn spin(time: Res<Time>, tuning: Res<Tuning>, mut q: Query<(&Spinner, &mut Transform)>, mut progress: ResMut<Progress>, play: Res<Playtime>) {
    engine::profile_scope!("demo.spin");
    let k = tuning.speed * time.delta_secs();
    for (s, mut tf) in &mut q {
        tf.rotate_y((s.deg_per_sec * k).to_radians());
    }
    let spins = (play.0 * f64::from(tuning.speed) / 6.0) as u32;
    if spins != progress.spins {
        progress.spins = spins;
    }
    if tuning.speed > progress.best_speed {
        progress.best_speed = tuning.speed;
    }
}

/// Hot reload in action: a new `Tuning.color` repaints the shared material.
fn recolor(tuning: Res<Tuning>, q: Query<&MeshMaterial3d<StandardMaterial>, With<Spinner>>, mats: Option<ResMut<Assets<StandardMaterial>>>) {
    if !tuning.is_changed() {
        return;
    }
    let (Some(mut mats), Some(h)) = (mats, q.iter().next()) else { return };
    if let Some(mut m) = mats.get_mut(&h.0) {
        m.base_color = Color::srgb(tuning.color[0], tuning.color[1], tuning.color[2]);
    }
}
