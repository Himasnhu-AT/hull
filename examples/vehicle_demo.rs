//! Drivable 4x4 on bumpy ground (docs/VEHICLE.md): logs to cross, a ramp, a mud pit, a tree to
//! winch to. Keys: W/S throttle and brake/reverse, A/D steer, Space handbrake, 1/2/3 transfer
//! case (2H / 4H / 4L), L rear diff lock, G front diff lock, E attach the winch to the tree,
//! R reel in, F pay out, X release, M drop into the mud pit, Backspace put the truck back.
//!
//! ```text
//! cargo run --example vehicle_demo
//! python3 -I scripts/play.py scripts/vehicle-demo.json --example vehicle_demo
//! ```

use engine::avian3d::prelude::*;
use engine::level::{Primitive, PrimitiveShape};
use engine::prelude::*;
use engine::vehicle::{Rope, RopeEnd, SurfaceId, SurfaceMap, SurfaceMapRes, SurfaceQuery, Vehicle, VehicleInput, VehicleSpec, VehicleTelemetry, spawn_wheel_visuals};

const SIZE: f32 = 200.0;
const N: usize = 101;
const MUD: Vec2 = Vec2::new(14.0, -42.0);
const TREE: Vec3 = Vec3::new(10.0, 0.0, -78.0);

/// Ground height: rolling bumps that grow with distance from the start, a mud pit dip.
fn height(x: f32, z: f32) -> f32 {
    let far = ((x * x + z * z).sqrt() / 40.0).clamp(0.0, 1.0);
    let bumps = (x * 0.35).sin() * (z * 0.3).cos() * 0.25 + (x * 0.11 + z * 0.07).sin() * 0.8;
    let pit = -0.35 * (1.0 - (Vec2::new(x, z).distance(MUD) / 9.0).clamp(0.0, 1.0));
    bumps * far + pit
}

/// Mud inside the pit, dirt elsewhere: the engine only asks "what is under this wheel".
struct DemoMap;

impl SurfaceMap for DemoMap {
    fn surface(&self, q: &SurfaceQuery) -> SurfaceId {
        if Vec2::new(q.point.x, q.point.z).distance(MUD) < 8.0 { SurfaceId::MUD } else { SurfaceId::DIRT }
    }
}

#[derive(Component)]
struct Hud;

#[derive(Component)]
struct Truck;

fn main() {
    let mut app = engine::app(GameInfo::new("vehicle_demo", "Vehicle Demo"));
    app.insert_resource(SurfaceMapRes(Box::new(DemoMap))).add_systems(Startup, setup).add_systems(Update, (drive, hud));
    app.run();
}

fn terrain_mesh() -> Mesh {
    let mut pos = Vec::new();
    let mut nor = Vec::new();
    let mut uv = Vec::new();
    let step = SIZE / (N - 1) as f32;
    for i in 0..N {
        for j in 0..N {
            let (x, z) = (-SIZE / 2.0 + i as f32 * step, -SIZE / 2.0 + j as f32 * step);
            pos.push([x, height(x, z), z]);
            let e = 0.5;
            let n = Vec3::new(height(x - e, z) - height(x + e, z), 2.0 * e, height(x, z - e) - height(x, z + e)).normalize();
            nor.push(n.to_array());
            uv.push([x * 0.1, z * 0.1]);
        }
    }
    let mut idx = Vec::new();
    for i in 0..N as u32 - 1 {
        for j in 0..N as u32 - 1 {
            let a = i * N as u32 + j;
            idx.extend([a, a + 1, a + N as u32, a + 1, a + N as u32 + 1, a + N as u32]);
        }
    }
    Mesh::new(bevy::mesh::PrimitiveTopology::TriangleList, bevy::asset::RenderAssetUsages::default())
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, nor)
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, uv)
        .with_inserted_indices(bevy::mesh::Indices::U32(idx))
}

fn setup(mut commands: Commands, meshes: Option<ResMut<Assets<Mesh>>>, materials: Option<ResMut<Assets<StandardMaterial>>>, headless: Res<Headless>) {
    commands.insert_resource(engine::look::Look::preset("clear_day").expect("look preset"));
    // Ground: heightfield collider (rows along X, columns along Z, centred) + a matching mesh.
    let heights: Vec<Vec<f32>> = (0..N).map(|i| (0..N).map(|j| height(-SIZE / 2.0 + i as f32 * SIZE / (N - 1) as f32, -SIZE / 2.0 + j as f32 * SIZE / (N - 1) as f32)).collect()).collect();
    let mut ground = commands.spawn((Name::new("Ground"), RigidBody::Static, Collider::heightfield(heights, Vec3::new(SIZE, 1.0, SIZE)), Transform::default(), Visibility::default()));
    if let (Some(mut meshes), Some(mut materials)) = (meshes, materials) {
        ground.insert((Mesh3d(meshes.add(terrain_mesh())), MeshMaterial3d(materials.add(StandardMaterial { base_color: Color::srgb(0.36, 0.3, 0.2), perceptual_roughness: 1.0, ..default() })), Scenery));
    }

    // Obstacles: two logs, a ramp, the tree.
    let y_at = |x: f32, z: f32| height(x, z);
    for (i, (x, z, len)) in [(-1.0, -18.0, 7.0), (2.5, -26.0, 7.0)].into_iter().enumerate() {
        let rot = Quat::from_rotation_z(std::f32::consts::FRAC_PI_2) * Quat::from_rotation_y(0.0);
        commands.spawn((
            Name::new(format!("Log {i}")),
            Primitive { shape: PrimitiveShape::Cylinder, size: Vec3::new(0.45, len, 0.45), color: Color::srgb(0.32, 0.2, 0.1), ..default() },
            RigidBody::Static,
            Collider::cylinder(0.225, len),
            Transform { translation: Vec3::new(x, y_at(x, z) + 0.12, z), rotation: rot, scale: Vec3::ONE },
            Scenery,
        ));
    }
    let ramp = Quat::from_rotation_x(0.28);
    commands.spawn((
        Name::new("Ramp"),
        Primitive::cuboid(Vec3::new(5.0, 0.4, 9.0), Color::srgb(0.45, 0.4, 0.33)),
        RigidBody::Static,
        Collider::cuboid(5.0, 0.4, 9.0),
        Transform { translation: Vec3::new(-6.0, y_at(-6.0, -36.0) + 0.7, -36.0), rotation: ramp, scale: Vec3::ONE },
        Scenery,
    ));
    let ty = y_at(TREE.x, TREE.z);
    commands.spawn((
        Name::new("Tree"),
        Primitive { shape: PrimitiveShape::Cylinder, size: Vec3::new(1.0, 9.0, 1.0), color: Color::srgb(0.28, 0.18, 0.1), ..default() },
        RigidBody::Static,
        Collider::cylinder(0.5, 9.0),
        Transform::from_xyz(TREE.x, ty + 4.5, TREE.z),
        Scenery,
    ));
    commands.spawn((Name::new("Canopy"), Primitive::sphere(7.0, Color::srgb(0.14, 0.32, 0.14)), Transform::from_xyz(TREE.x, ty + 10.0, TREE.z), Scenery));

    // The mud pit, drawn as a dark disc (the physics side is the `DemoMap` above).
    commands.spawn((
        Name::new("Mud"),
        Primitive { shape: PrimitiveShape::Cylinder, size: Vec3::new(16.0, 0.06, 16.0), color: Color::srgb(0.16, 0.1, 0.06), roughness: 0.3, ..default() },
        Transform::from_xyz(MUD.x, height(MUD.x, MUD.y) + 0.02, MUD.y),
        Scenery,
    ));
    // The truck.
    let spec = VehicleSpec::truck();
    let truck = commands.spawn((Truck, spec.clone().bundle(Transform::from_xyz(0.0, y_at(0.0, 0.0) + 1.3, 0.0)))).id();
    spawn_wheel_visuals(&mut commands, truck, &spec, Color::srgb(0.08, 0.08, 0.08));
    commands.spawn((Name::new("Body"), Primitive::cuboid(Vec3::new(1.8, 0.6, 4.6), Color::srgb(0.7, 0.18, 0.12)), Transform::from_xyz(0.0, 0.0, 0.0), ChildOf(truck)));
    commands.spawn((Name::new("Cab"), Primitive::cuboid(Vec3::new(1.6, 0.6, 1.8), Color::srgb(0.6, 0.15, 0.1)), Transform::from_xyz(0.0, 0.55, 0.5), ChildOf(truck)));
    if !headless.0 {
        let mut cam = ChaseCamera::new(truck);
        cam.distance = 9.5;
        cam.height = 3.6;
        cam.look_height = 1.2;
        cam.look_ahead = 3.0;
        commands.spawn((MainCamera, Camera3d::default(), cam, Transform::from_xyz(0.0, 5.0, 10.0)));
    }
    commands.spawn((Name::new("Hud"), Hud, Text::new(""), Node { position_type: PositionType::Absolute, left: Val::Px(14.0), top: Val::Px(10.0), ..default() }));
}

fn drive(
    keys: Res<ButtonInput<KeyCode>>,
    mut commands: Commands,
    mut truck: Query<(Entity, &mut VehicleInput, &mut Transform, &mut LinearVelocity, &mut AngularVelocity), With<Truck>>,
    mut ropes: Query<(Entity, &mut Rope)>,
) {
    let Ok((e, mut inp, mut tf, mut lv, mut av)) = truck.single_mut() else { return };
    let axis = |neg: KeyCode, pos: KeyCode| keys.pressed(pos) as i32 as f32 - keys.pressed(neg) as i32 as f32;
    inp.throttle = axis(KeyCode::KeyS, KeyCode::KeyW);
    inp.steer = axis(KeyCode::KeyA, KeyCode::KeyD);
    inp.handbrake = keys.pressed(KeyCode::Space);
    for (k, m) in [(KeyCode::Digit1, 0), (KeyCode::Digit2, 1), (KeyCode::Digit3, 2)] {
        if keys.just_pressed(k) {
            inp.transfer = m;
        }
    }
    if keys.just_pressed(KeyCode::KeyL) {
        inp.diff_lock[1] = !inp.diff_lock[1];
    }
    if keys.just_pressed(KeyCode::KeyG) {
        inp.diff_lock[0] = !inp.diff_lock[0];
    }
    if keys.just_pressed(KeyCode::KeyM) {
        *tf = Transform::from_xyz(MUD.x, height(MUD.x, MUD.y) + 1.3, MUD.y);
        lv.0 = Vec3::ZERO;
        av.0 = Vec3::ZERO;
    }
    if keys.just_pressed(KeyCode::Backspace) {
        *tf = Transform::from_xyz(0.0, height(0.0, 0.0) + 1.3, 0.0);
        lv.0 = Vec3::ZERO;
        av.0 = Vec3::ZERO;
    }
    if keys.just_pressed(KeyCode::KeyE) && ropes.is_empty() {
        let anchor = Vec3::new(TREE.x, height(TREE.x, TREE.z) + 0.6, TREE.z + 0.5);
        let from = tf.transform_point(Vec3::new(0.0, -0.1, -2.4));
        commands.spawn((Name::new("Winch"), Rope::winch(RopeEnd::Body { entity: e, local: Vec3::new(0.0, -0.1, -2.4) }, RopeEnd::World(anchor), from.distance(anchor) + 0.5)));
    }
    if keys.just_pressed(KeyCode::KeyX) {
        for (r, _) in &ropes {
            commands.entity(r).despawn();
        }
    }
    for (_, mut r) in &mut ropes {
        r.reel = axis(KeyCode::KeyF, KeyCode::KeyR);
        r.reel_speed = 0.5;
    }
}

fn hud(truck: Query<(&VehicleTelemetry, &VehicleInput, &Vehicle), With<Truck>>, ropes: Query<&Rope>, mut text: Query<&mut Text, With<Hud>>) {
    let (Ok((t, i, v)), Ok(mut text)) = (truck.single(), text.single_mut()) else { return };
    let mode = v.spec.transfer.get(t.transfer).map_or("", |m| m.name.as_str());
    let gear = match t.gear {
        -1 => "R".to_string(),
        0 => "N".to_string(),
        g => g.to_string(),
    };
    let winch = ropes.iter().next().map_or("winch: E to attach".to_string(), |r| format!("winch {:.1} kN, {:.1} m", r.tension / 1000.0, r.length));
    text.0 = format!(
        "{:>4.1} km/h  {:>4.0} rpm  gear {gear}  {mode}  locks F{} R{}  slip {:.2}  wheels {}/4\n{winch}\nW/S A/D drive, 1 2 3 mode, L G locks, Space brake, E R F X winch, M mud, Backspace reset",
        t.speed * 3.6,
        t.rpm,
        i.diff_lock[0] as u8,
        i.diff_lock[1] as u8,
        t.max_slip.min(9.9),
        t.grounded_wheels
    );
}
