//! Metrics window demo: a spinning field of cubes plus fake `render.*` and game keys, so every
//! part of the metrics window has data. `tests/control.rs` drives it headless; for a look:
//!
//! ```text
//! cargo run --example metrics_demo                       # game window + metrics window (F4)
//! cargo run --example metrics_demo -- --work 6           # burn 6 ms per frame (a "slower commit")
//! python3 -I scripts/play.py scripts/metrics-window.json --example metrics_demo \
//!     --out /tmp/metrics -- --metrics-window             # offscreen screenshot of the view
//! ```

use engine::devtools::Metrics;
use engine::prelude::*;

fn info() -> GameInfo {
    GameInfo::new("metrics_demo", "Metrics demo")
}

fn main() {
    // The engine's UI kit is optional here (the demo has no menus).
    let options = EngineOptions { ui: false, skip_menu: true, ..EngineOptions::from_args() };
    engine::app_with(info(), options).add_plugins(Demo).run();
}

struct Demo;

/// `--work <ms>`: busy CPU time added to every frame.
#[derive(Resource)]
struct Work(f32);

#[derive(Component)]
struct Spin(f32);

impl Plugin for Demo {
    fn build(&self, app: &mut App) {
        let work = engine::cli::dev_value("work").and_then(|v| v.parse().ok()).unwrap_or(0.0);
        app.insert_resource(Work(work))
            .add_systems(Startup, (spawn, label))
            .add_systems(Update, (spin, fake_metrics, burn));
    }
}

fn label(mut m: ResMut<Metrics>) {
    // `--work` stands in for a code change, so it is not a label: runs with and without it
    // compare against each other.
    m.set_label("scenario", "demo");
    // A game's own colour levels for its own key.
    m.set_threshold("ai.think_ms", 2.0, 4.0);
}

fn spawn(mut commands: Commands, headless: Res<Headless>, meshes: Option<ResMut<Assets<Mesh>>>, mats: Option<ResMut<Assets<StandardMaterial>>>) {
    if headless.0 {
        return;
    }
    let (Some(mut meshes), Some(mut mats)) = (meshes, mats) else { return };
    let cube = meshes.add(Cuboid::new(0.8, 0.8, 0.8));
    for i in 0..120 {
        let (x, z) = ((i % 12) as f32 * 1.6 - 9.0, (i / 12) as f32 * -1.6 - 2.0);
        let c = Color::hsl(i as f32 * 3.0, 0.6, 0.55);
        commands.spawn((
            Mesh3d(cube.clone()),
            MeshMaterial3d(mats.add(StandardMaterial { base_color: c, ..default() })),
            Transform::from_xyz(x, 0.4, z),
            Spin(0.5 + (i % 7) as f32 * 0.2),
            Actor,
        ));
    }
    commands.spawn((
        DirectionalLight { illuminance: 8_000.0, shadow_maps_enabled: true, ..default() },
        Transform::from_xyz(4.0, 8.0, 2.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 6.0, 6.0).looking_at(Vec3::new(0.0, 0.0, -8.0), Vec3::Y)));
}

fn spin(time: Res<Time>, mut q: Query<(&Spin, &mut Transform)>) {
    for (s, mut t) in &mut q {
        t.rotate_y(s.0 * time.delta_secs());
    }
}

/// What the render stream and a game would record; waves so the charts move.
fn fake_metrics(time: Res<Time<Real>>, mut m: ResMut<Metrics>, mut frames: Local<(u64, u64)>) {
    let t = time.elapsed_secs_f64();
    let wave = |period: f64| (t * std::f64::consts::TAU / period).sin();
    let visible = (420.0 + 180.0 * wave(17.0)).round();
    let culled = (900.0 - visible + 40.0 * wave(5.0)).round();
    frames.0 += 1;
    if ((t * 10.0) as u64).is_multiple_of(3) {
        frames.1 += 1;
    }
    m.record("render.meshes_total", 1400.0);
    m.record("render.meshes_visible", visible);
    m.record("render.culled_frustum", culled);
    m.record("render.culled_distance", (80.0 + 30.0 * wave(9.0)).round());
    m.record("render.actors_visible", (24.0 + 8.0 * wave(11.0)).round());
    m.record("render.scenery_visible", visible - 24.0);
    m.record("render.lod_near", (visible * 0.4).round());
    m.record("render.lod_far", (visible * 0.6).round());
    m.record("render.cells_loaded", (18.0 + 4.0 * wave(23.0)).round());
    m.record("render.cells_total", 64.0);
    m.record("render.frames_rendered", frames.0 as f64);
    m.record("render.frames_skipped", frames.1 as f64);
    // A game's own keys: one line each.
    m.record("ai.think_ms", 1.2 + 0.8 * wave(7.0).max(0.0) + if (t as u64).is_multiple_of(13) { 3.0 } else { 0.0 });
    m.record("enemies.alive", (12.0 + 6.0 * wave(29.0)).round());
}

fn burn(work: Res<Work>) {
    if work.0 <= 0.0 {
        return;
    }
    let until = std::time::Instant::now() + std::time::Duration::from_secs_f32(work.0 / 1000.0);
    while std::time::Instant::now() < until {
        std::hint::spin_loop();
    }
}
