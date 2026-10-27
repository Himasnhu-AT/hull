//! The `look` module on a small scene: an outdoor yard (metal and plastic spheres, pillars,
//! neon strips, a floor decal) next to a room with a window, a lamp, a chrome ball and a
//! reflection probe. `cargo run --example look_showcase -- --play`.
//!
//! Flags: `--look <clear_day|overcast|dusk|night|indoor>`, `--pose <outdoor|metals|indoor|overview>`,
//! `--quality <low|medium|high|ultra>`, `--uncapped` (vsync off, full speed unfocused),
//! `--day-cycle <seconds per day>`, `--no-probe`.
//! Control commands (with `--control`): `showcase.pose {name}`, `showcase.quality {name}`, plus
//! the engine's `look.*`. Screenshots: `python3 -I scripts/play.py scripts/look-shots.json
//! --example look_showcase`.

use bevy::light::ClusteredDecal;
use bevy::pbr::decal::ForwardDecalMaterial;
use engine::cli::{arg_value, has_flag};
use engine::look::{ReflectionProbe, decal_image, decal_material, spawn_decal};
use engine::prelude::*;
use engine::settings::{CoreSettings, GraphicsQuality};

fn info() -> GameInfo {
    GameInfo::new("look-showcase", "Look showcase").tagline("Sun, sky, fog, probes, decals.")
}

/// Named camera poses: (eye, target).
fn pose(name: &str) -> Option<(Vec3, Vec3)> {
    Some(match name {
        "outdoor" => (Vec3::new(-1.0, 1.7, 7.0), Vec3::new(1.0, 1.0, -6.0)),
        "metals" => (Vec3::new(0.0, 1.3, -1.2), Vec3::new(0.0, 0.8, -6.0)),
        "indoor" => (Vec3::new(15.0, 1.6, 3.2), Vec3::new(22.5, 1.2, -1.8)),
        "poster" => (Vec3::new(18.0, 1.7, 3.0), Vec3::new(19.0, 1.6, -4.0)),
        "overview" => (Vec3::new(-16.0, 10.0, 18.0), Vec3::new(6.0, 0.0, -3.0)),
        _ => return None,
    })
}

fn quality(name: &str) -> Option<GraphicsQuality> {
    Some(match name {
        "low" => GraphicsQuality::Low,
        "medium" => GraphicsQuality::Medium,
        "high" => GraphicsQuality::High,
        "ultra" => GraphicsQuality::Ultra,
        _ => return None,
    })
}

#[derive(Resource)]
struct Pose(Vec3, Vec3);

fn main() {
    let mut app = engine::app(info());
    let look = arg_value("look").and_then(|n| Look::preset(&n)).unwrap_or_else(Look::clear_day);
    app.insert_resource(look);
    if let Some(secs) = arg_value("day-cycle").and_then(|s| s.parse::<f32>().ok()) {
        app.insert_resource(LookTimeline::day_cycle(24.0 / secs.max(1.0)));
    }
    if let Some(q) = arg_value("quality").and_then(|q| quality(&q)) {
        app.world_mut().resource_mut::<CoreSettings>().quality = q;
    }
    let (eye, at) = arg_value("pose").and_then(|p| pose(&p)).unwrap_or_else(|| pose("outdoor").unwrap());
    app.insert_resource(Pose(eye, at));
    #[cfg(feature = "devtools")]
    {
        use engine::devtools::{AddControlCommand, params};
        app.add_control_command("showcase.pose", "Camera pose: outdoor|metals|indoor|overview", params(&[("name", "string", "pose")]), |w, p| {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("outdoor").to_string();
            let (eye, at) = pose(&name).ok_or_else(|| format!("unknown pose {name}"))?;
            *w.resource_mut::<Pose>() = Pose(eye, at);
            Ok(serde_json::json!({"pose": name}))
        })
        .add_control_command("showcase.quality", "Quality tier: low|medium|high|ultra", params(&[("name", "string", "tier")]), |w, p| {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("high").to_string();
            let q = quality(&name).ok_or_else(|| format!("unknown quality {name}"))?;
            w.resource_mut::<CoreSettings>().quality = q;
            Ok(serde_json::json!({"quality": name}))
        });
    }
    app.add_systems(OnEnter(AppState::InGame), spawn_scene).add_systems(Update, (place_camera.run_if(in_game), probe_debug_wall)).run();
}

/// `--probe-debug`: shows the six faces a reflection probe captured on panels outside the room.
fn probe_debug_wall(
    mut commands: Commands,
    probes: Query<&engine::look::probe::ProbeTargets, Added<engine::look::probe::ProbeTargets>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<StandardMaterial>>,
) {
    if !has_flag("probe-debug") {
        return;
    }
    for t in &probes {
        let quad = meshes.add(Rectangle::new(2.0, 2.0));
        for (i, face) in t.faces.iter().enumerate() {
            let m = mats.add(StandardMaterial { base_color_texture: Some(face.clone()), unlit: true, ..default() });
            commands.spawn((Mesh3d(quad.clone()), MeshMaterial3d(m), Transform::from_xyz(-6.0 + i as f32 * 2.2, 2.5, 1.0)));
        }
    }
}

fn place_camera(pose: Res<Pose>, mut cam: Query<&mut Transform, With<MainCamera>>) {
    if !pose.is_changed() {
        return;
    }
    for mut tf in &mut cam {
        *tf = Transform::from_translation(pose.0).looking_at(pose.1, Vec3::Y);
    }
}

fn spawn_scene(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<StandardMaterial>>,
    mut decal_mats: ResMut<Assets<ForwardDecalMaterial<StandardMaterial>>>,
    mut images: ResMut<Assets<Image>>,
) {
    let mat = |mats: &mut Assets<StandardMaterial>, c: Color, metallic: f32, rough: f32| mats.add(StandardMaterial { base_color: c, metallic, perceptual_roughness: rough, ..default() });
    let ground_m = mat(&mut mats, Color::srgb(0.42, 0.42, 0.4), 0.0, 0.85);
    let wall_m = mat(&mut mats, Color::srgb(0.78, 0.76, 0.72), 0.0, 0.9);
    let floor_m = mat(&mut mats, Color::srgb(0.45, 0.3, 0.2), 0.0, 0.55);
    let pillar_m = mat(&mut mats, Color::srgb(0.6, 0.58, 0.55), 0.0, 0.7);
    let spheres = [
        ("gold", Color::srgb(1.0, 0.78, 0.34), 1.0, 0.15),
        ("chrome", Color::srgb(0.95, 0.95, 0.95), 1.0, 0.04),
        ("copper", Color::srgb(0.95, 0.64, 0.54), 1.0, 0.35),
        ("steel", Color::srgb(0.75, 0.75, 0.77), 1.0, 0.55),
        ("plastic", Color::srgb(0.8, 0.08, 0.06), 0.0, 0.35),
    ];
    let sphere = meshes.add(Sphere::new(0.8).mesh().uv(48, 24));
    let cube = meshes.add(Cuboid::new(1.0, 1.0, 1.0));

    commands.spawn((Name::new("Ground"), Mesh3d(meshes.add(Plane3d::default().mesh().size(140.0, 140.0))), MeshMaterial3d(ground_m)));
    for (i, (name, c, m, r)) in spheres.into_iter().enumerate() {
        let x = -6.0 + i as f32 * 3.0;
        commands.spawn((Name::new(name), Mesh3d(sphere.clone()), MeshMaterial3d(mat(&mut mats, c, m, r)), Transform::from_xyz(x, 0.8, -6.0)));
    }
    for x in [-11.0, -4.5, 4.5, 11.0] {
        commands.spawn((Name::new("Pillar"), Mesh3d(cube.clone()), MeshMaterial3d(pillar_m.clone()), Transform::from_xyz(x, 2.5, -10.0).with_scale(Vec3::new(1.0, 5.0, 1.0))));
    }
    // Neon strips (emissive, nits): invisible against the day sun, glowing at night.
    for (i, c) in [LinearRgba::rgb(60.0, 4.0, 40.0), LinearRgba::rgb(4.0, 30.0, 60.0), LinearRgba::rgb(60.0, 30.0, 4.0)].into_iter().enumerate() {
        let m = mats.add(StandardMaterial { base_color: Color::BLACK, emissive: c, ..default() });
        commands.spawn((Name::new("Neon"), Mesh3d(cube.clone()), MeshMaterial3d(m), Transform::from_xyz(-7.75 + i as f32 * 7.75, 4.2, -9.4).with_scale(Vec3::new(4.0, 0.12, 0.12))));
    }

    // A floor decal from code: a painted ring with soft edges.
    let ring = images.add(decal_image(256, |uv| {
        let d = (uv - Vec2::splat(0.5)).length() * 2.0;
        let a = (1.0 - ((d - 0.75).abs() / 0.12)).clamp(0.0, 1.0) * if d < 0.98 { 1.0 } else { 0.0 };
        [0.95, 0.75, 0.1, a * 0.9]
    }));
    let decal = decal_mats.add(decal_material(StandardMaterial { base_color_texture: Some(ring.clone()), perceptual_roughness: 0.6, ..default() }, 0.5));
    spawn_decal(&mut commands, decal, Transform::from_xyz(0.0, 0.0, -1.5).with_scale(Vec3::new(4.0, 1.0, 4.0)));

    // The room: x 14..24, z -4..4, 3.5 m high; window in the +X wall, door in the -X wall.
    let (x0, x1, z0, z1, h, t) = (14.0f32, 24.0f32, -4.0f32, 4.0f32, 3.5f32, 0.2f32);
    let wall = |c: &mut Commands, center: Vec3, size: Vec3| {
        c.spawn((Name::new("Wall"), Mesh3d(cube.clone()), MeshMaterial3d(wall_m.clone()), Transform::from_translation(center).with_scale(size)));
    };
    let (cx, cz) = ((x0 + x1) * 0.5, (z0 + z1) * 0.5);
    wall(&mut commands, Vec3::new(cx, h * 0.5, z0), Vec3::new(x1 - x0, h, t));
    wall(&mut commands, Vec3::new(cx, h * 0.5, z1), Vec3::new(x1 - x0, h, t));
    wall(&mut commands, Vec3::new(cx, h + t * 0.5, cz), Vec3::new(x1 - x0 + t, t, z1 - z0 + t));
    // +X wall with a 3 × 1.6 m window from 1 m up.
    let (wz0, wz1, wy0, wy1) = (-1.5f32, 1.5f32, 1.0f32, 2.6f32);
    wall(&mut commands, Vec3::new(x1, h * 0.5, (z0 + wz0) * 0.5), Vec3::new(t, h, wz0 - z0));
    wall(&mut commands, Vec3::new(x1, h * 0.5, (wz1 + z1) * 0.5), Vec3::new(t, h, z1 - wz1));
    wall(&mut commands, Vec3::new(x1, wy0 * 0.5, 0.0), Vec3::new(t, wy0, wz1 - wz0));
    wall(&mut commands, Vec3::new(x1, (wy1 + h) * 0.5, 0.0), Vec3::new(t, h - wy1, wz1 - wz0));
    // -X wall with a 1.4 m door.
    wall(&mut commands, Vec3::new(x0, h * 0.5, (z0 + 1.6) * 0.5), Vec3::new(t, h, 1.6 - z0 - 3.0 + 3.0));
    wall(&mut commands, Vec3::new(x0, h * 0.5, (3.0 + z1) * 0.5), Vec3::new(t, h, z1 - 3.0));
    commands.spawn((Name::new("Floor"), Mesh3d(cube.clone()), MeshMaterial3d(floor_m), Transform::from_xyz(cx, 0.01, cz).with_scale(Vec3::new(x1 - x0, 0.02, z1 - z0))));
    commands.spawn((Name::new("Chrome ball"), Mesh3d(sphere.clone()), MeshMaterial3d(mat(&mut mats, Color::srgb(0.95, 0.95, 0.95), 1.0, 0.05)), Transform::from_xyz(19.5, 0.8, -1.8)));
    commands.spawn((Name::new("Table"), Mesh3d(cube.clone()), MeshMaterial3d(mat(&mut mats, Color::srgb(0.2, 0.35, 0.5), 0.0, 0.4)), Transform::from_xyz(17.5, 0.4, 1.5).with_scale(Vec3::new(1.6, 0.8, 1.0))));
    // Lamp: a warm point light inside an emissive bulb.
    let bulb = mats.add(StandardMaterial { base_color: Color::WHITE, emissive: LinearRgba::rgb(400.0, 280.0, 160.0), ..default() });
    commands.spawn((
        Name::new("Lamp"),
        Mesh3d(meshes.add(Sphere::new(0.12))),
        MeshMaterial3d(bulb),
        Transform::from_xyz(17.0, 2.9, 1.0),
        children![(PointLight { intensity: 120_000.0, range: 12.0, color: Color::srgb(1.0, 0.8, 0.6), shadow_maps_enabled: true, ..default() }, bevy::light::NotShadowCaster)],
    ));
    // A poster as a clustered decal (projects along local +Z onto the back wall). Only drawn
    // with `--features look_clustered_decals`.
    let poster = images.add(decal_image(128, |uv| {
        let stripe = ((uv.x + uv.y) * 8.0).fract() < 0.5;
        if stripe { [0.1, 0.5, 0.9, 1.0] } else { [0.95, 0.95, 0.9, 1.0] }
    }));
    commands.spawn((
        Name::new("Poster"),
        ClusteredDecal { base_color_texture: Some(poster), ..default() },
        Transform::from_xyz(19.0, 1.8, z0 + 0.3).looking_to(Vec3::NEG_Z, Vec3::Y).with_scale(Vec3::new(1.6, 1.0, 0.6)),
    ));
    if !has_flag("no-probe") {
        commands.spawn((Name::new("RoomProbe"), ReflectionProbe::default(), Transform::from_xyz(cx, h * 0.5, cz).with_scale(Vec3::new(x1 - x0, h, z1 - z0))));
    }

    commands.spawn((Name::new("Camera"), MainCamera, Camera3d::default(), Transform::default()));
}
