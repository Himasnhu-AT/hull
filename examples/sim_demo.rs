//! Weather, a physical camera and acoustic wildlife on one small meadow: a seeded weather cycle
//! (clear, overcast, rain, fog, storm) driving the look, rain particles and ground wetness; a
//! `PhotoCamera` (lens, aperture, shutter, autofocus, photos saved as PNG with metadata); deer
//! that hear horns and noises (dB model with wind and tree occlusion), smell the wind, and flee.
//!
//! `cargo run --example sim_demo -- --play [--seed N] [--weather-speed 30]`
//!
//! Keys: Space = take a photo, H = horn, T = next weather, Z/X = zoom, A/D = turn,
//! C = toggle autofocus, F/G = aperture. Control port: `weather.*`, `photo.*`, `ai.acoustic.*`.
//! Screenshots: `python3 -I scripts/play.py scripts/sim-demo.json --example sim_demo`.

use engine::ai::{AcousticEnv, Hearing, NoiseEvent, NoiseKind, ScentSource, Smell, Startle, StartleState};
use engine::avian3d::prelude::*;
use engine::cli::arg_value;
use engine::look::{Rgb, SkyLook, SkyMode};
use engine::photo::{PhotoCamera, PhotoRequest, PhotoTaken, Photographable};
use engine::prelude::*;
use engine::weather::{Weather, WeatherLibrary, Wetness, Wind};

fn main() {
    let mut app = engine::app(GameInfo::new("engine-sim-demo", "Sim demo").tagline("Weather, camera, wildlife."));
    let mut look = Look::clear_day();
    look.sky = SkyLook {
        mode: SkyMode::Gradient,
        zenith: Rgb::new(0.18, 0.38, 0.8),
        horizon: Rgb::new(0.62, 0.76, 0.92),
        ground: Rgb::new(0.3, 0.32, 0.28),
        brightness: 6000.0,
        ..SkyLook::default()
    };
    look.fog.visibility = 2500.0;
    app.insert_resource(look);
    let seed = arg_value("seed").and_then(|s| s.parse().ok()).unwrap_or(7);
    let mut weather = Weather::new(seed);
    weather.speed = arg_value("weather-speed").and_then(|s| s.parse().ok()).unwrap_or(1.0);
    app.insert_resource(weather)
        .add_systems(OnEnter(AppState::InGame), spawn_scene)
        .add_systems(Update, (controls, wander, hud, on_photo).run_if(in_game))
        .run();
}

#[derive(Component)]
struct Deer(u32);

#[derive(Component)]
struct Hud;

fn spawn_scene(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<StandardMaterial>>) {
    let mat = |mats: &mut Assets<StandardMaterial>, c: Color, r: f32| mats.add(StandardMaterial { base_color: c, perceptual_roughness: r, ..default() });
    commands.spawn((
        Name::new("Ground"),
        Scenery,
        RigidBody::Static,
        Collider::cuboid(300.0, 1.0, 300.0),
        Mesh3d(meshes.add(Cuboid::new(300.0, 1.0, 300.0))),
        MeshMaterial3d(mat(&mut mats, Color::srgb(0.27, 0.4, 0.2), 0.95)),
        Transform::from_xyz(0.0, -0.5, 0.0),
    ));
    // Trees: trunk + crown, shared meshes. They occlude sound and photos.
    let trunk = meshes.add(Cylinder::new(0.35, 5.0));
    let crown = meshes.add(Sphere::new(2.2));
    let (bark, leaf) = (mat(&mut mats, Color::srgb(0.32, 0.22, 0.14), 0.9), mat(&mut mats, Color::srgb(0.14, 0.34, 0.12), 0.85));
    let trees = [(-12.0, -16.0), (9.0, -23.0), (-6.0, -33.0), (14.0, -32.0), (-18.0, -30.0), (4.0, -44.0), (22.0, -14.0), (-24.0, -22.0)];
    for (x, z) in trees {
        commands.spawn((Scenery, RigidBody::Static, Collider::cylinder(0.35, 5.0), Mesh3d(trunk.clone()), MeshMaterial3d(bark.clone()), Transform::from_xyz(x, 2.5, z)));
        commands.spawn((Scenery, Mesh3d(crown.clone()), MeshMaterial3d(leaf.clone()), Transform::from_xyz(x, 6.0, z)));
    }
    // A boulder and a mud hollow.
    commands.spawn((Scenery, RigidBody::Static, Collider::sphere(1.6), Mesh3d(meshes.add(Sphere::new(1.6))), MeshMaterial3d(mat(&mut mats, Color::srgb(0.45, 0.45, 0.47), 0.8)), Transform::from_xyz(7.0, 0.5, -6.0)));
    commands.spawn((engine::weather::WeatherRegion { radius: 6.0, wet_mul: 2.0, floor: 0.4, ..default() }, Transform::from_xyz(-8.0, 0.0, -9.0)));

    // Deer: capsules with ears and a nose.
    let body = meshes.add(Capsule3d::new(0.32, 0.9));
    let head = meshes.add(Sphere::new(0.2));
    let leg = meshes.add(Cuboid::new(0.12, 0.7, 0.12));
    let coat = mat(&mut mats, Color::srgb(0.55, 0.38, 0.24), 0.9);
    for i in 0..7u32 {
        let a = i as f32 * 2.4;
        // Deer 0 stands dead centre so autofocus finds it.
        let p = if i == 0 { Vec3::new(0.0, 0.0, -20.0) } else { Vec3::new(a.sin() * 9.0, 0.0, -14.0 - (i % 4) as f32 * 5.0) };
        commands
            .spawn((
                Name::new(format!("Deer {i}")),
                Deer(i),
                Actor,
                Photographable { kind: "deer".into(), radius: 0.9, centre_offset: Vec3::Y * 1.0, weight: 1.0 + (i % 3) as f32 },
                Hearing { threshold_db: 22.0, ..default() },
                Smell::default(),
                Startle { flee_speed: 8.0, flee_distance: 60.0, ..default() },
                Transform::from_translation(p).with_rotation(Quat::from_rotation_y(a)),
                Visibility::default(),
            ))
            .with_children(|c| {
                // A collider so autofocus and occlusion see the deer.
                c.spawn((Collider::cuboid(0.7, 1.3, 1.9), Transform::from_xyz(0.0, 0.85, -0.1)));
                // Forward is -Z: a horizontal body, a head up front, four legs.
                c.spawn((Mesh3d(body.clone()), MeshMaterial3d(coat.clone()), Transform::from_xyz(0.0, 1.0, 0.0).with_rotation(Quat::from_rotation_x(std::f32::consts::FRAC_PI_2))));
                c.spawn((Mesh3d(head.clone()), MeshMaterial3d(coat.clone()), Transform::from_xyz(0.0, 1.35, -0.85)));
                for (x, z) in [(-0.18, -0.4), (0.18, -0.4), (-0.18, 0.4), (0.18, 0.4)] {
                    c.spawn((Mesh3d(leg.clone()), MeshMaterial3d(coat.clone()), Transform::from_xyz(x, 0.35, z)));
                }
            });
    }

    commands.spawn((
        Name::new("Camera"),
        MainCamera,
        Camera3d::default(),
        PhotoCamera { focal_mm: 85.0, aperture: 2.8, shutter_s: 1.0 / 1000.0, ..default() },
        // The photographer's scent drifts downwind toward the deer.
        ScentSource { strength: 35.0, kind: 1 },
        Transform::from_xyz(0.0, 1.2, 4.0).looking_at(Vec3::new(0.0, 0.95, -20.0), Vec3::Y),
    ));
    commands.spawn((Hud, Text::new(""), Node { position_type: PositionType::Absolute, left: Val::Px(12.0), top: Val::Px(10.0), ..default() }, TextColor(Color::WHITE)));
}

fn controls(
    keys: Res<ButtonInput<KeyCode>>,
    mut cam: Query<(&mut PhotoCamera, &mut Transform, &GlobalTransform)>,
    mut photos: MessageWriter<PhotoRequest>,
    mut noise: MessageWriter<NoiseEvent>,
    mut weather: ResMut<Weather>,
    lib: Res<WeatherLibrary>,
    time: Res<Time>,
) {
    let Ok((mut pc, mut tf, gt)) = cam.single_mut() else { return };
    if keys.just_pressed(KeyCode::Space) {
        photos.write(PhotoRequest::default());
        noise.write(NoiseEvent { pos: gt.translation(), loudness_db: 55.0, kind: NoiseKind::Shutter, source: None });
    }
    if keys.just_pressed(KeyCode::KeyH) {
        noise.write(NoiseEvent { pos: gt.translation(), loudness_db: 105.0, kind: NoiseKind::Horn, source: None });
    }
    if keys.just_pressed(KeyCode::KeyT) {
        let next = (weather.current + 1) % lib.defs.len();
        let name = lib.defs[next].name.clone();
        weather.force(&lib, &name, 8.0);
    }
    if keys.just_pressed(KeyCode::KeyC) {
        pc.autofocus = !pc.autofocus;
    }
    if keys.just_pressed(KeyCode::KeyZ) {
        pc.zoom(1.4);
    }
    if keys.just_pressed(KeyCode::KeyX) {
        pc.zoom(1.0 / 1.4);
    }
    if keys.just_pressed(KeyCode::KeyF) {
        pc.stop_aperture(-1.0);
    }
    if keys.just_pressed(KeyCode::KeyG) {
        pc.stop_aperture(1.0);
    }
    let turn = keys.pressed(KeyCode::KeyA) as i32 - keys.pressed(KeyCode::KeyD) as i32;
    if turn != 0 {
        tf.rotate_y(turn as f32 * 0.6 * time.delta_secs());
    }
}

/// Deer amble about; once startled the Startle behaviour moves them. Far from the meadow they
/// drift back.
fn wander(time: Res<Time>, mut q: Query<(&Deer, &Startle, &mut Transform)>) {
    let t = time.elapsed_secs();
    for (d, s, mut tf) in &mut q {
        // Deer 0 grazes in place (autofocus target); the others amble.
        if s.state != StartleState::Calm || d.0 == 0 {
            continue;
        }
        let home = Vec3::new(0.0, 0.0, -20.0);
        let mut dir = Quat::from_rotation_y((t * 0.15 + d.0 as f32 * 1.7).sin() * 3.0) * Vec3::NEG_Z;
        let mut speed = 0.4;
        if tf.translation.distance(home) > 18.0 {
            dir = (home - tf.translation).with_y(0.0).normalize_or_zero();
            speed = 2.5;
        }
        tf.translation += dir * speed * time.delta_secs();
        tf.translation.y = 0.0;
        tf.look_to(dir, Vec3::Y);
    }
}

fn hud(
    mut text: Query<&mut Text, With<Hud>>,
    weather: Res<Weather>,
    lib: Res<WeatherLibrary>,
    wet: Res<Wetness>,
    wind: Res<Wind>,
    env: Res<AcousticEnv>,
    cam: Query<&PhotoCamera>,
    lens: Query<&engine::photo::LensState>,
    deer: Query<&Startle, With<Deer>>,
    cap: Res<engine::photo::PhotoCapture>,
) {
    let (Ok(mut t), Ok(c), Ok(l)) = (text.single_mut(), cam.single(), lens.single()) else { return };
    let count = |s: StartleState| deer.iter().filter(|d| d.state == s).count();
    let far = if l.far_m.is_finite() { format!("{:.0} m", l.far_m) } else { "inf".into() };
    **t = format!(
        "{} ({:?})  wet {:.0}%  wind {:.1} m/s  ambient {:.0} dB\n{:.0} mm  f/{:.1}  1/{:.0}  ISO {:.0}  focus {:.1} m{}  sharp {:.0}..{}  EV {:.1}\ndeer: {} calm, {} alert, {} fleeing   photos: {}",
        weather.name(&lib),
        weather.kind(),
        wet.0 * 100.0,
        wind.speed,
        env.ambient_db,
        c.focal_mm,
        c.aperture,
        1.0 / c.shutter_s,
        c.iso,
        c.focus_m,
        if c.autofocus { " AF" } else { "" },
        l.near_m,
        far,
        l.ev100,
        count(StartleState::Calm),
        count(StartleState::Alert),
        count(StartleState::Fleeing),
        cap.taken,
    );
}

fn on_photo(mut taken: MessageReader<PhotoTaken>) {
    for p in taken.read() {
        let kinds: Vec<_> = p.metadata.subjects.iter().map(|s| format!("{} {:.0}m {:.0}%", s.kind, s.distance, s.screen_size * 100.0)).collect();
        info!("photo {} saved to {:?}: {}", p.metadata.id, p.path, kinds.join(", "));
    }
}
