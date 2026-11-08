//! Day sky, clouds, a follow camera, spray and impostor trees together.
//! `cargo run --example environment_demo -- --play`
//!
//! A pickup fishtails round a gravel / mud / grass ring road under a time-lapse sky, filmed by a
//! spring-arm chase rig; 5 000 trees stand around it as real models up close and impostors
//! beyond. Flags: `--day-length <secs per day>` (default 240; 0 freezes), `--hour <h>`,
//! `--day <of year>`, `--trees <n>`, `--overcast <0..1>`.
//! Control commands (with `--control`): the engine's `day.*`, `camera.rig`, `spray.*`, `foliage.*`
//! plus `env.look {eye, at}` (park the camera for a shot) and `env.truck {on}`.
//! Screenshots: `python3 -I scripts/play.py scripts/environment-demo.json --example environment_demo`.

use engine::camera_rigs::{CameraRig, Feel};
use engine::cli::{arg_value, has_flag};
use engine::daytime::{DayClock, DayWeather, NightLight};
use engine::foliage::{Foliage, FoliageConfig, FoliageSpecies, ImpostorAtlas};
use engine::prelude::*;
use engine::spray::{SprayInput, SprayPoint, SprayTracker};
use engine::surface::{SurfaceId, SurfaceMapRes};

const RING: f32 = 60.0;
const SPEED: f32 = 17.0;

fn info() -> GameInfo {
    GameInfo::new("environment-demo", "Environment demo").tagline("Sky, clouds, camera rigs, spray, impostor trees.")
}

#[derive(Component)]
struct Truck;

#[derive(Resource)]
struct Driving(bool);

fn main() {
    let mut app = engine::app(info());
    let f = |name: &str, d: f32| arg_value(name).and_then(|v| v.parse::<f32>().ok()).unwrap_or(d);
    let mut clock = DayClock { hours: f("hour", 7.5), day: f("day", 150.0), latitude: 47.0, ..default() };
    let len = f("day-length", 240.0);
    if len > 0.0 {
        clock = clock.with_day_length(len);
    } else {
        clock.running = false;
    }
    app.insert_resource(clock)
        .insert_resource(DayWeather { overcast: f("overcast", 0.0), ..default() })
        .insert_resource(Driving(true))
        .insert_resource(FoliageConfig { near: 80.0, fade: 30.0, far: 1800.0, ..default() })
        // What is under the wheels: a gravel ring, mud in one quarter, grass elsewhere.
        .insert_resource(SurfaceMapRes::from_fn(|p| {
            let r = Vec2::new(p.x, p.z).length();
            Some(if (RING - 9.0..RING + 9.0).contains(&r) {
                if p.x > 0.0 && p.z > 0.0 { SurfaceId::MUD } else { SurfaceId::GRAVEL }
            } else {
                SurfaceId::GRASS
            })
        }))
        .add_systems(OnEnter(AppState::InGame), spawn_scene)
        .add_systems(Update, drive_truck.run_if(in_game));
    #[cfg(feature = "devtools")]
    {
        use engine::devtools::{AddControlCommand, params};
        app.add_control_command("env.look", "Park the camera: eye [x,y,z], at [x,y,z] (rig off); no params: rig back on", params(&[("eye", "array", "position"), ("at", "array", "look target")]), |w, p| {
            let mut q = w.query::<(&mut CameraRig, &mut Transform)>();
            for (mut rig, mut tf) in q.iter_mut(w) {
                match (v3(&p, "eye"), v3(&p, "at")) {
                    (Some(e), Some(a)) => {
                        rig.active = false;
                        *tf = Transform::from_translation(e).looking_at(a, Vec3::Y);
                    }
                    _ => {
                        rig.active = true;
                        rig.cut();
                    }
                }
            }
            Ok(serde_json::json!({}))
        })
        .add_control_command("env.truck", "Drive or park the truck", params(&[("on", "boolean", "driving")]), |w, p| {
            w.resource_mut::<Driving>().0 = p.get("on").and_then(|v| v.as_bool()).unwrap_or(true);
            Ok(serde_json::json!({}))
        });
    }
    app.run();
}

#[cfg(feature = "devtools")]
fn v3(p: &serde_json::Value, k: &str) -> Option<Vec3> {
    let a = p.get(k)?.as_array()?;
    Some(Vec3::new(a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32))
}

fn drive_truck(time: Res<Time>, driving: Res<Driving>, mut q: Query<&mut Transform, With<Truck>>, mut t: Local<f32>) {
    if !driving.0 {
        return;
    }
    *t += time.delta_secs();
    let theta = *t * SPEED / RING;
    let tangent = Vec3::new(-theta.sin(), 0.0, theta.cos());
    // Fishtail: the nose swings either side of the direction of travel.
    let dir = Quat::from_rotation_y((*t * 1.3).sin() * 0.45) * tangent;
    for mut tf in &mut q {
        *tf = Transform::from_xyz(RING * theta.cos(), 0.55, RING * theta.sin()).looking_to(dir, Vec3::Y);
    }
}

fn spawn_scene(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<StandardMaterial>>,
    mut images: ResMut<Assets<Image>>,
) {
    let mat = |mats: &mut Assets<StandardMaterial>, c: Color, rough: f32| mats.add(StandardMaterial { base_color: c, perceptual_roughness: rough, ..default() });
    // Ground and ring road.
    let grass = mat(&mut mats, Color::srgb(0.26, 0.34, 0.16), 1.0);
    let dirt = mat(&mut mats, Color::srgb(0.45, 0.36, 0.26), 1.0);
    commands.spawn((Name::new("Ground"), Mesh3d(meshes.add(Plane3d::default().mesh().size(12_000.0, 12_000.0))), MeshMaterial3d(grass)));
    commands.spawn((
        Name::new("Road"),
        Mesh3d(meshes.add(Annulus::new(RING - 9.0, RING + 9.0))),
        MeshMaterial3d(dirt),
        Transform::from_xyz(0.0, 0.03, 0.0).with_rotation(Quat::from_rotation_x(-std::f32::consts::FRAC_PI_2)),
    ));

    // The truck: a body, a cab, four wheels, two headlights, a spray point at each rear wheel.
    let body = mat(&mut mats, Color::srgb(0.75, 0.12, 0.1), 0.5);
    let dark = mat(&mut mats, Color::srgb(0.08, 0.08, 0.09), 0.9);
    let wheel = meshes.add(Cylinder::new(0.45, 0.35));
    let truck = commands
        .spawn((Name::new("Truck"), Truck, Transform::from_xyz(RING, 0.55, 0.0), Visibility::default()))
        .with_children(|c| {
            c.spawn((Mesh3d(meshes.add(Cuboid::new(2.0, 0.8, 4.6))), MeshMaterial3d(body.clone()), Transform::from_xyz(0.0, 0.45, 0.0)));
            c.spawn((Mesh3d(meshes.add(Cuboid::new(1.8, 0.7, 1.8))), MeshMaterial3d(body.clone()), Transform::from_xyz(0.0, 1.1, -0.4)));
            for (x, z) in [(-1.05, -1.5), (1.05, -1.5), (-1.05, 1.5), (1.05, 1.5)] {
                c.spawn((Mesh3d(wheel.clone()), MeshMaterial3d(dark.clone()), Transform::from_xyz(x, 0.0, z).with_rotation(Quat::from_rotation_z(std::f32::consts::FRAC_PI_2))));
            }
            for x in [-0.7, 0.7] {
                c.spawn((
                    SpotLight { intensity: 0.0, range: 90.0, outer_angle: 0.5, inner_angle: 0.25, shadow_maps_enabled: false, color: Color::srgb(1.0, 0.94, 0.82), ..default() },
                    NightLight { intensity: 90_000.0, dusk_el: -1.0, dawn_el: 2.0, force: None },
                    Transform::from_xyz(x, 0.7, -2.3).looking_to(Vec3::new(0.0, -0.05, -1.0), Vec3::Y),
                ));
            }
            for x in [-1.05, 1.05] {
                c.spawn((SprayPoint { rear: true, ..default() }, SprayInput::default(), SprayTracker::default(), Transform::from_xyz(x, -0.45, 1.6)));
            }
        })
        .id();

    // Lamp posts along the ring: dark by day, lit at dusk.
    let post = meshes.add(Cylinder::new(0.08, 5.0));
    for i in 0..10 {
        let a = i as f32 / 10.0 * std::f32::consts::TAU;
        let p = Vec3::new((RING + 12.0) * a.cos(), 0.0, (RING + 12.0) * a.sin());
        commands.spawn((Mesh3d(post.clone()), MeshMaterial3d(dark.clone()), Transform::from_translation(p + Vec3::Y * 2.5)));
        commands.spawn((
            PointLight { intensity: 0.0, range: 30.0, radius: 0.2, color: Color::srgb(1.0, 0.85, 0.65), shadow_maps_enabled: false, ..default() },
            NightLight::lamp(40_000.0),
            Transform::from_translation(p + Vec3::Y * 5.2),
        ));
    }

    // Trees: real models near, impostors beyond.
    let (tree_h, tree_hw) = (8.0, 3.0);
    let trunk = meshes.add(Cylinder::new(0.28, 3.4));
    let crown = meshes.add(Sphere::new(2.3).mesh().uv(20, 12));
    let bark = mat(&mut mats, Color::srgb(0.33, 0.24, 0.17), 0.95);
    let leaf = mat(&mut mats, Color::srgb(0.18, 0.44, 0.15), 0.9);
    let atlas = ImpostorAtlas::procedural_tree(&mut images, 128, 8, tree_hw, tree_h);
    let mut foliage = Foliage::default();
    let oak = foliage.add_species(
        FoliageSpecies::new("oak", atlas)
            .near_at(trunk, bark, Transform::from_xyz(0.0, 1.7, 0.0))
            .near_at(crown, leaf, Transform::from_xyz(0.0, 5.4, 0.0).with_scale(Vec3::new(1.0, 1.2, 1.0))),
    );
    let n = arg_value("trees").and_then(|v| v.parse().ok()).unwrap_or(5000);
    foliage.scatter(oak, Vec2::ZERO, 1800.0, n, 11, |_, _| 0.0);
    // Keep the ring road and its surroundings clear.
    foliage.instances.retain(|i| Vec2::new(i.pos.x, i.pos.z).length() > RING + 30.0);
    foliage.touch();
    commands.insert_resource(foliage);

    // The camera: a spring-arm chase with speed feel (a far plane past the farthest impostor).
    let mut cam = commands.spawn((
        Name::new("Camera"),
        MainCamera,
        Camera3d::default(),
        Projection::Perspective(PerspectiveProjection { far: 6000.0, ..default() }),
        Transform::from_xyz(RING, 3.0, 8.0),
        CameraRig::chase(truck).with_feel(Feel::default()),
    ));
    if has_flag("free") {
        cam.insert(CameraRig::free());
    }
}
