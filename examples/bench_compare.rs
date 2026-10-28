//! Matched benchmark scenes (the same ones exist for Godot in `bench/godot/`), run by
//! `scripts/compare.py`. Each builds its scene in code, waits `--warmup` seconds, records
//! frame times for `--secs`, prints one JSON line (`BENCH {...}`) and exits.
//!
//!   cargo run --release --example bench_compare --no-default-features --features physics -- --scene cubes --fps 60
//!
//! Built like a shipped game (no devtools: no perf sampler, no control port), in a 1920×1080
//! window at scale factor 1, vsync off (the compositor still holds a window to the display
//! rate; `--fps` sets a common rate).
//!
//! Scenes (1920×1080, vsync off, no post effects, one shadowed directional light unless noted):
//! - `cubes`: 20 000 static cubes in 8 materials.
//! - `lights`: 4 000 cubes and 256 unshadowed point lights.
//! - `physics`: 4 000 dynamic boxes dropped onto a floor (rendered).

use std::time::Instant;

use engine::prelude::*;

fn main() {
    engine::app(GameInfo::new("engine-bench", "Bench")).add_plugins(Bench).run();
}

struct Bench;

#[derive(Resource)]
struct Run {
    scene: String,
    warmup: f32,
    secs: f32,
    start: Instant,
    t: f32,
    frames: Vec<f32>,
    first_frame: Option<f32>,
    /// `--fps N`: hold N frames per second (sleep out the rest of each frame), 0 = uncapped.
    fps: f32,
    frame_start: Instant,
}

impl Plugin for Bench {
    fn build(&self, app: &mut App) {
        let arg = |n: &str| engine::cli::arg_value(n);
        app.insert_resource(Run {
            scene: arg("scene").unwrap_or_else(|| "cubes".into()),
            warmup: arg("warmup").and_then(|v| v.parse().ok()).unwrap_or(3.0),
            secs: arg("secs").and_then(|v| v.parse().ok()).unwrap_or(10.0),
            start: Instant::now(),
            t: 0.0,
            frames: Vec::new(),
            first_frame: None,
            fps: arg("fps").and_then(|v| v.parse().ok()).unwrap_or(0.0),
            frame_start: Instant::now(),
        })
        // Same feature set as Godot's defaults: no SSAO / TAA / bloom / SSR / contact shadows,
        // plain hardware shadow filtering.
        .insert_resource(engine::gfx::QualityPreset {
            ssao: [false; 4],
            bloom: [false; 4],
            taa: [false; 4],
            contact_shadows: [false; 4],
            ssr: [false; 4],
            occlusion_culling: [false; 4],
            shadow_filter: [bevy::light::ShadowFilteringMethod::Hardware2x2; 4],
            ..default()
        })
        .insert_resource(engine::render_budget::QualityGovernor { enabled: false, ..default() })
        .add_systems(Startup, (setup, window))
        .add_systems(Update, (play, record))
        .add_systems(Last, hold_rate);
    }
}

/// Straight into gameplay (menus pace frames reactively, to save power).
fn play(state: Res<State<engine::flow::AppState>>, mut next: ResMut<NextState<engine::flow::AppState>>) {
    if *state.get() == engine::flow::AppState::MainMenu {
        next.set(engine::flow::AppState::InGame);
    }
}

/// 1920×1080 physical pixels, no vsync: the same as the Godot project.
fn window(mut windows: Query<&mut Window, With<bevy::window::PrimaryWindow>>) {
    for mut w in &mut windows {
        w.resolution = bevy::window::WindowResolution::new(1920, 1080).with_scale_factor_override(1.0);
        w.present_mode = bevy::window::PresentMode::AutoNoVsync;
    }
}

fn setup(mut commands: Commands, run: Res<Run>, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<StandardMaterial>>) {
    let palette: Vec<Handle<StandardMaterial>> = (0..8)
        .map(|i| mats.add(StandardMaterial { base_color: Color::hsl(i as f32 * 45.0, 0.6, 0.55), perceptual_roughness: 0.8, ..default() }))
        .collect();
    let cube = meshes.add(Cuboid::new(1.0, 1.0, 1.0));
    let ground_mat = mats.add(StandardMaterial { base_color: Color::srgb(0.35, 0.37, 0.4), perceptual_roughness: 0.9, ..default() });
    commands.spawn((Mesh3d(meshes.add(Cuboid::new(400.0, 0.2, 400.0))), MeshMaterial3d(ground_mat), Transform::from_xyz(0.0, -0.1, 0.0)));
    let sun = |commands: &mut Commands| {
        commands.spawn((
            DirectionalLight { illuminance: 8_000.0, shadow_maps_enabled: true, ..default() },
            Transform::from_xyz(30.0, 60.0, 20.0).looking_at(Vec3::ZERO, Vec3::Y),
        ));
    };
    let cam = |commands: &mut Commands, pos: Vec3, at: Vec3| {
        commands.spawn((MainCamera, Camera3d::default(), Transform::from_translation(pos).looking_at(at, Vec3::Y)));
    };
    match run.scene.as_str() {
        "lights" => {
            for i in 0..4000 {
                let (x, z) = ((i % 80) as f32 * 2.5 - 100.0, (i / 80) as f32 * 2.5 - 62.5);
                commands.spawn((Mesh3d(cube.clone()), MeshMaterial3d(palette[i % 8].clone()), Transform::from_xyz(x, 0.5, z)));
            }
            for i in 0..256 {
                let (x, z) = ((i % 16) as f32 * 12.5 - 95.0, (i / 16) as f32 * 7.8 - 60.0);
                commands.spawn((
                    PointLight { color: Color::hsl(i as f32 * 37.0, 0.8, 0.6), intensity: 40_000.0, range: 10.0, shadow_maps_enabled: false, ..default() },
                    Transform::from_xyz(x, 2.0, z),
                ));
            }
            commands.spawn((DirectionalLight { illuminance: 300.0, shadow_maps_enabled: false, ..default() }, Transform::default().looking_to(Vec3::new(-0.3, -1.0, -0.2), Vec3::Y)));
            cam(&mut commands, Vec3::new(0.0, 40.0, 70.0), Vec3::new(0.0, 0.0, -10.0));
        }
        "physics" => {
            #[cfg(feature = "physics")]
            {
                use engine::avian3d::prelude::{Collider, RigidBody};
                commands.spawn((RigidBody::Static, Collider::cuboid(400.0, 0.2, 400.0), Transform::from_xyz(0.0, -0.1, 0.0)));
                for i in 0..4000 {
                    let (x, y, z) = ((i % 20) as f32 * 1.5 - 15.0, 2.0 + (i / 400) as f32 * 1.5, ((i / 20) % 20) as f32 * 1.5 - 15.0);
                    commands.spawn((
                        RigidBody::Dynamic,
                        Collider::cuboid(1.0, 1.0, 1.0),
                        Mesh3d(cube.clone()),
                        MeshMaterial3d(palette[i % 8].clone()),
                        Transform::from_xyz(x, y, z),
                        engine::render_budget::Actor,
                    ));
                }
            }
            sun(&mut commands);
            cam(&mut commands, Vec3::new(0.0, 25.0, 45.0), Vec3::new(0.0, 4.0, 0.0));
        }
        _ => {
            for i in 0..20_000 {
                let (x, z) = ((i % 200) as f32 * 1.8 - 180.0, (i / 200) as f32 * 1.8 - 90.0);
                commands.spawn((Mesh3d(cube.clone()), MeshMaterial3d(palette[i % 8].clone()), Transform::from_xyz(x, 0.5, z)));
            }
            sun(&mut commands);
            cam(&mut commands, Vec3::new(0.0, 60.0, 120.0), Vec3::new(0.0, 0.0, -20.0));
        }
    }
}

/// Holds `--fps` (like Godot's `--max-fps`): sleeps until the next deadline on a fixed grid,
/// so frame times average exactly 1/fps whatever each frame's work.
fn hold_rate(mut run: ResMut<Run>) {
    if run.fps > 0.0 {
        let budget = std::time::Duration::from_secs_f32(1.0 / run.fps);
        let now = Instant::now();
        let mut next = run.frame_start + budget;
        if next < now {
            next = now;
        }
        std::thread::sleep(next - now);
        run.frame_start = next;
    } else {
        run.frame_start = Instant::now();
    }
}

fn record(mut run: ResMut<Run>, time: Res<Time<Real>>, mut exit: MessageWriter<AppExit>) {
    let dt = time.delta_secs();
    if run.first_frame.is_none() {
        run.first_frame = Some(run.start.elapsed().as_secs_f32());
        println!("READY");
    }
    run.t += dt;
    if run.t < run.warmup {
        return;
    }
    run.frames.push(dt * 1000.0);
    if run.t < run.warmup + run.secs {
        return;
    }
    let mut f = run.frames.clone();
    f.sort_by(f32::total_cmp);
    let n = f.len().max(1);
    let avg = f.iter().sum::<f32>() / n as f32;
    let pct = |p: f32| f[((n - 1) as f32 * p) as usize];
    println!(
        "BENCH {{\"engine\":\"ours\",\"scene\":\"{}\",\"frames\":{},\"avg_ms\":{:.3},\"p50_ms\":{:.3},\"p95_ms\":{:.3},\"p99_ms\":{:.3},\"first_frame_s\":{:.3}}}",
        run.scene,
        n,
        avg,
        pct(0.5),
        pct(0.95),
        pct(0.99),
        run.first_frame.unwrap_or(0.0)
    );
    exit.write(AppExit::Success);
}
