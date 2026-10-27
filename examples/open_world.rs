//! Open world: 4 × 4 km of noise terrain (2 m samples, 1024 LOD'd chunks, splat layers),
//! villages placed by rules, forests / rocks / grass scattered from a seed, cells streamed
//! around the camera, HLOD for far villages. The whole world is a `WorldDesc` built in code
//! (`--dump-ron <path>` writes it as RON).
//!
//! `cargo run --example open_world -- --play [flags]`
//!
//! - `--pose overview|valley|forest|fly` (default fly): camera pose; the control command
//!   `cam.pose {name}` switches at runtime. WASD + mouse (right button) fly the camera, Shift
//!   is fast.
//! - `--baseline`: nothing streamed — resident cells (every collider and prefab), every tree
//!   and rock spawned (scatter culling distances ×100), no HLOD. Compare with the default.
//! - `--size <m>` (default 4096), `--uncapped` (vsync off, full speed unfocused: for
//!   measurements in hidden `--offscreen` windows), `--origin` (floating origin on).
//!
//! Control: `world.stats`, `world.cells`, `world.height {x,z}`, `world.teleport {x,z}`,
//! `world.settings {...}`, `perf.stats`, `screenshot`.

use bevy::input::mouse::MouseMotion;
use bevy::pbr::{DistanceFog, FogFalloff};
use engine::cli::{arg_value, has_flag};
use engine::prelude::*;
use engine::world::desc::{Group, TerrainDesc};
use engine::world::scatter::{ScatterCollider, ScatterRender};
use engine::world::*;

const FOG: Color = Color::srgb(0.66, 0.74, 0.84);

fn info() -> GameInfo {
    GameInfo::new("open-world", "Open world").tagline("Four square kilometres, streamed.")
}

/// The world as data. Village centres are picked on the generated heightfield (flat, mid
/// height, far apart).
fn describe(size: f32, seed: u64, hf: &Heightfield) -> WorldDesc {
    let mut d = WorldDesc {
        seed,
        terrain: TerrainDesc { size: [size, size], spacing: 2.0, chunk_quads: 64, ..default() },
        cell_size: 256.0,
        ..default()
    };
    // Splat layers: grass, rock on slopes, dry earth low, snow on the peaks.
    let mut layers = engine::world::material::default_layers();
    layers[2] = SplatLayer { name: "earth".into(), color: [0.55, 0.47, 0.33], height: [-1e6, 8.0], blend: 6.0, weight: 2.0, ..default() };
    layers[3].height = [265.0, 1e6];
    d.terrain.layers = layers;
    d.materials.insert("plaster".into(), MaterialDesc { color: [0.86, 0.80, 0.68], roughness: 0.9, ..default() });
    d.materials.insert("timber".into(), MaterialDesc { color: [0.42, 0.28, 0.16], roughness: 0.8, ..default() });
    d.materials.insert("thatch".into(), MaterialDesc { color: [0.62, 0.48, 0.25], roughness: 0.95, ..default() });
    d.materials.insert("stone".into(), MaterialDesc { color: [0.55, 0.54, 0.52], roughness: 0.85, ..default() });
    let part = |s: ShapeDesc, m: &str, at: [f32; 3]| PartDesc { material: m.into(), at, ..PartDesc::new(s) };
    d.prefabs.insert(
        "hut".into(),
        PrefabDef {
            parts: vec![
                part(ShapeDesc::Cuboid([6.0, 3.0, 5.0]), "plaster", [0.0, 1.5, 0.0]),
                PartDesc { rot: [0.0, 45.0, 0.0], collider: false, ..part(ShapeDesc::Cone { radius: 4.8, height: 2.6 }, "thatch", [0.0, 4.3, 0.0]) },
                part(ShapeDesc::Cuboid([1.2, 2.0, 0.2]), "timber", [0.0, 1.0, 2.55]),
            ],
            clear_radius: 7.0,
            tags: vec!["house".into()],
            ..default()
        },
    );
    d.prefabs.insert(
        "longhouse".into(),
        PrefabDef {
            parts: vec![
                part(ShapeDesc::Cuboid([12.0, 3.2, 6.0]), "timber", [0.0, 1.6, 0.0]),
                // A box turned 45° about its long axis: a gable roof.
                PartDesc { rot: [45.0, 0.0, 0.0], collider: false, ..part(ShapeDesc::Cuboid([12.4, 4.4, 4.4]), "thatch", [0.0, 3.2, 0.0]) },
            ],
            clear_radius: 10.0,
            tags: vec!["house".into()],
            ..default()
        },
    );
    d.prefabs.insert(
        "tower".into(),
        PrefabDef {
            parts: vec![
                part(ShapeDesc::Cylinder { radius: 3.0, height: 14.0 }, "stone", [0.0, 7.0, 0.0]),
                PartDesc { collider: false, ..part(ShapeDesc::Cone { radius: 3.8, height: 4.0 }, "timber", [0.0, 16.0, 0.0]) },
            ],
            clear_radius: 6.0,
            tags: vec!["landmark".into()],
            ..default()
        },
    );
    // Villages on flat ground between 15 and 140 m, ≥ 700 m apart.
    let mut centers: Vec<Vec2> = Vec::new();
    let o = hf.origin();
    let step = 64.0;
    let n = (size / step) as i32;
    for iz in 2..n - 2 {
        for ix in 2..n - 2 {
            let p = o + Vec2::new(ix as f32, iz as f32) * step;
            let h = hf.height_at(p.x, p.y);
            if !(15.0..140.0).contains(&h) || hf.slope_deg(p.x, p.y) > 6.0 {
                continue;
            }
            if centers.iter().any(|c| c.distance(p) < 700.0) {
                continue;
            }
            centers.push(p);
        }
    }
    centers.truncate(12);
    for (i, c) in centers.iter().enumerate() {
        d.groups.push(Group { prefabs: vec!["hut".into(), "hut".into(), "longhouse".into()], center: c.to_array(), radius: 90.0, count: 18, min_spacing: 16.0, max_slope: 14.0, seed: i as u64, ..default() });
        d.placements.push(engine::world::desc::Placement { prefab: "tower".into(), at: [c.x + 20.0, 0.0, c.y - 15.0], yaw: 0.0, scale: 1.0, ground: true });
        // Keep trees out of the village.
        d.exclusions.push(engine::world::scatter::Exclusion::Circle { center: c.to_array(), radius: 110.0 });
    }
    let mask = |seed: u64, f: f32| Some(Fbm { seed, frequency: f, octaves: 3, ..default() });
    d.scatter = vec![
        ScatterRule { name: "grass".into(), mesh: ScatterMesh::Grass, density: 3.0, cluster: 16.0, cull: 90.0, fade: 12.0, height: [-1e6, 240.0], slope: [0.0, 26.0], mask: mask(11, 0.012), threshold: 0.3, scale: [0.7, 1.4], align: 0.7, seed: 1, ..default() },
        ScatterRule { name: "flowers".into(), mesh: ScatterMesh::Flowers, density: 0.25, cluster: 16.0, cull: 60.0, height: [-1e6, 180.0], slope: [0.0, 20.0], mask: mask(12, 0.02), threshold: 0.62, seed: 2, ..default() },
        ScatterRule {
            name: "pines".into(),
            mesh: ScatterMesh::Pine,
            far_mesh: Some(ScatterMesh::PineLow),
            render: ScatterRender::Instanced,
            density: 0.006,
            cluster: 64.0,
            near: 320.0,
            cull: 1900.0,
            fade: 30.0,
            height: [25.0, 255.0],
            slope: [0.0, 36.0],
            mask: mask(21, 0.0022),
            threshold: 0.42,
            scale: [0.7, 1.5],
            shadows: true,
            collider: Some(ScatterCollider { radius: 0.35, height: 6.0 }),
            seed: 3,
            ..default()
        },
        ScatterRule {
            name: "broadleaf".into(),
            mesh: ScatterMesh::Broadleaf,
            far_mesh: Some(ScatterMesh::BroadleafLow),
            render: ScatterRender::Instanced,
            density: 0.003,
            cluster: 64.0,
            near: 280.0,
            cull: 1600.0,
            fade: 30.0,
            height: [-1e6, 170.0],
            slope: [0.0, 25.0],
            mask: mask(22, 0.003),
            threshold: 0.5,
            scale: [0.8, 1.3],
            shadows: true,
            collider: Some(ScatterCollider { radius: 0.4, height: 4.0 }),
            seed: 4,
            ..default()
        },
        ScatterRule {
            name: "rocks".into(),
            mesh: ScatterMesh::Rock,
            render: ScatterRender::Instanced,
            density: 0.003,
            cluster: 64.0,
            cull: 500.0,
            fade: 20.0,
            slope: [12.0, 70.0],
            scale: [0.8, 3.5],
            align: 1.0,
            sink: 0.15,
            shadows: true,
            collider: Some(ScatterCollider { radius: 0.7, height: 1.2 }),
            seed: 5,
            ..default()
        },
        ScatterRule { name: "bushes".into(), mesh: ScatterMesh::Bush, density: 0.01, cluster: 32.0, cull: 220.0, fade: 20.0, height: [-1e6, 220.0], slope: [0.0, 30.0], mask: mask(23, 0.004), threshold: 0.45, scale: [0.6, 1.6], seed: 6, ..default() },
    ];
    d
}

fn noise() -> NoiseTerrain {
    NoiseTerrain { fbm: Fbm { frequency: 0.0006, octaves: 7, ridged: 0.45, warp: 140.0, ..default() }, amplitude: 720.0, base: -10.0, exponent: 2.4, border_falloff: 0.0 }
}

#[derive(Resource, Clone, Copy, PartialEq, Eq, Debug)]
enum Pose {
    Fly,
    Overview,
    Valley,
    Forest,
    Ground,
    Free,
}

impl Pose {
    fn parse(s: &str) -> Option<Pose> {
        Some(match s {
            "fly" => Pose::Fly,
            "overview" => Pose::Overview,
            "valley" => Pose::Valley,
            "forest" => Pose::Forest,
            "ground" => Pose::Ground,
            "free" => Pose::Free,
            _ => return None,
        })
    }
}

#[derive(Resource)]
struct Villages(Vec<Vec2>);

#[derive(Resource)]
struct Size(f32);

fn main() {
    let mut app = engine::app_with(info(), EngineOptions { ui: false, ..EngineOptions::from_args() });
    let size: f32 = arg_value("size").and_then(|s| s.parse().ok()).unwrap_or(4096.0);
    let baseline = has_flag("baseline");
    {
        let mut s = app.world_mut().resource_mut::<WorldSettings>();
        s.streaming.mode = if baseline { StreamMode::Resident } else { StreamMode::Streamed };
        s.streaming.load_radius = 384.0;
        s.streaming.unload_radius = 480.0;
        s.hlod.enabled = !baseline;
        s.hlod.distance = 360.0;
        s.origin.enabled = has_flag("origin");
    }
    // The render budget's scenery ranges only matter for untagged scenery here; keep its view
    // beyond the fog so nothing of ours is cut.
    app.insert_resource(SceneryRanges { view: 4000.0, ..default() });
    let pose = arg_value("pose").and_then(|p| Pose::parse(&p)).unwrap_or(Pose::Fly);
    #[cfg(feature = "devtools")]
    {
        use engine::devtools::{AddControlCommand, params};
        app.add_control_command("cam.pose", "Camera pose: fly|overview|valley|forest|free", params(&[("name", "string", "pose")]), |w, p| {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("fly").to_string();
            let pose = Pose::parse(&name).ok_or_else(|| format!("unknown pose {name}"))?;
            w.insert_resource(pose);
            w.insert_resource(PoseTime(0.0));
            Ok(serde_json::json!({"pose": name}))
        });
    }
    #[cfg(feature = "devtools")]
    {
        use engine::devtools::{AddControlCommand, params};
        app.add_control_command("debug.scatter", "Debug a scatter rule's cluster meshes", params(&[("name", "string", "rule")]), |w, p| {
            let name = format!("scatter {} ", p.get("name").and_then(|v| v.as_str()).unwrap_or("grass"));
            let cam = w.query_filtered::<&GlobalTransform, With<MainCamera>>().iter(w).next().map(|g| g.translation()).unwrap_or_default();
            let mut out = Vec::new();
            let mut q = w.query::<(&Mesh3d, &ChildOf, &GlobalTransform, Option<&bevy::camera::primitives::Aabb>, &ViewVisibility, &InheritedVisibility, Option<&bevy::camera::visibility::VisibilityRange>)>();
            for (m, parent, g, aabb, vv, iv, vr) in q.iter(w) {
                let Some(n) = w.get::<Name>(parent.parent()) else { continue };
                if !n.as_str().starts_with(&name) {
                    continue;
                }
                let d = aabb.map(|a| (Vec3::from(g.affine().transform_point3a(a.center)) - cam).length());
                if d.is_some_and(|d| d < 60.0) {
                    out.push(serde_json::json!({"cluster": n.as_str(), "mesh": format!("{:?}", m.0.id()), "dist": d, "view": vv.get(), "inherited": iv.get(), "aabb": aabb.map(|a| format!("{:?}", a)), "range": vr.map(|r| [r.start_margin.start, r.start_margin.end, r.end_margin.start, r.end_margin.end]), "at": g.translation().to_array()}));
                }
            }
            out.truncate(6);
            Ok(serde_json::json!({"cam": cam.to_array(), "near": out}))
        });
    }
    app.insert_resource(pose)
        .insert_resource(PoseTime(0.0))
        .insert_resource(Size(size))
        .insert_resource(ClearColor(FOG))
        .add_systems(OnEnter(AppState::InGame), setup)
        .add_systems(Update, (drive_camera, free_fly).chain().run_if(in_game))
        .run();
}

fn setup(world: &mut World) {
    let size = world.resource::<Size>().0;
    let seed = world.resource::<GameSeed>().0;
    let baseline = has_flag("baseline");
    let t0 = std::time::Instant::now();
    let n = (size / 2.0) as u32 + 1;
    let hf = Heightfield::from_noise(n, n, 2.0, Vec2::splat(-size * 0.5), &NoiseTerrain { fbm: Fbm { seed: noise().fbm.seed ^ seed, ..noise().fbm }, ..noise() });
    info!("open_world: heightfield {n}×{n} in {:.0} ms", t0.elapsed().as_secs_f64() * 1000.0);
    let mut desc = describe(size, seed, &hf);
    if baseline {
        for r in desc.scatter.iter_mut().filter(|r| r.render == ScatterRender::Instanced) {
            r.cull *= 100.0;
            r.near = r.near.max(1.0);
        }
    }
    if let Some(p) = arg_value("dump-ron") {
        let _ = std::fs::write(&p, desc.to_ron());
        info!("open_world: wrote {p}");
    }
    let centers: Vec<Vec2> = desc.groups.iter().map(|g| Vec2::from(g.center)).collect();
    world.insert_resource(Villages(centers));
    if let Err(e) = engine::world::desc::spawn_world_with(world, desc, Some(hf)) {
        error!("open_world: {e}");
        return;
    }
    let mut commands = world.commands();
    engine::gfx::sky_and_sun_with(
        &mut commands,
        engine::gfx::SunSetup {
            direction: Vec3::new(0.5, -0.55, 0.35),
            cascades: 4,
            first_cascade: 20.0,
            shadow_distance: 450.0,
            atmosphere: false,
            fallback_sky: FOG,
            ambient_brightness: 900.0,
            ..default()
        },
    );
    if !world.resource::<Headless>().0 {
        world.spawn((
            Name::new("camera"),
            MainCamera,
            Camera3d::default(),
            Projection::Perspective(PerspectiveProjection { far: 8000.0, ..default() }),
            bevy::camera::Exposure { ev100: 13.0 },
            DistanceFog { color: FOG, falloff: FogFalloff::from_visibility_colors(4200.0, Color::srgb(0.55, 0.62, 0.72), Color::srgb(1.0, 0.95, 0.85)), ..default() },
            Transform::from_xyz(0.0, 200.0, 0.0).looking_to(Vec3::new(1.0, -0.2, 0.3), Vec3::Y),
        ));
    }
    world.flush();
}

#[derive(Resource)]
struct PoseTime(f32);

/// Poses (absolute coordinates; converted through the floating origin).
fn drive_camera(
    time: Res<Time>,
    pose: Res<Pose>,
    mut pt: ResMut<PoseTime>,
    villages: Option<Res<Villages>>,
    terrain: Option<Res<Terrain>>,
    origin: Res<WorldOrigin>,
    mut q: Query<&mut Transform, With<MainCamera>>,
) {
    let (Some(t), Some(v)) = (terrain, villages) else { return };
    let Ok(mut tf) = q.single_mut() else { return };
    pt.0 += time.delta_secs();
    let village = v.0.first().copied().unwrap_or(Vec2::ZERO);
    let (lo, hi) = t.bounds();
    let ground = |p: Vec2| t.height_at(p.x, p.y);
    let (eye, look) = match *pose {
        Pose::Free => return,
        Pose::Overview => (Vec3::new(lo.x + 300.0, 900.0, lo.y + 300.0), Vec3::new(0.0, 0.0, 0.0)),
        Pose::Valley => {
            let p = village + Vec2::new(-160.0, -120.0);
            (Vec3::new(p.x, ground(p) + 6.0, p.y), Vec3::new(village.x, ground(village) + 4.0, village.y))
        }
        Pose::Forest => {
            // The densest pine spot near the centre: probe a few points.
            let p = Vec2::new(lo.x + (hi.x - lo.x) * 0.62, lo.y + (hi.y - lo.y) * 0.41);
            (Vec3::new(p.x, ground(p) + 2.0, p.y), Vec3::new(p.x + 100.0, ground(p) + 10.0, p.y + 40.0))
        }
        Pose::Ground => {
            // Standing in a meadow next to the first village, looking down the slope.
            let p = village + Vec2::new(130.0, 40.0);
            (Vec3::new(p.x, ground(p) + 1.7, p.y), Vec3::new(p.x + 12.0, ground(p + Vec2::new(12.0, 4.0)), p.y + 4.0))
        }
        Pose::Fly => {
            // A 1.4 km circle at 60 m/s, 90 m above the ground, looking ahead and down.
            let r = 1400.0_f32.min((hi.x - lo.x) * 0.35);
            let a = pt.0 * 60.0 / r;
            let p = Vec2::new(a.cos(), a.sin()) * r;
            let ahead = Vec2::new(-a.sin(), a.cos());
            let h = ground(p).max(ground(p + ahead * 120.0)) + 90.0;
            (Vec3::new(p.x, h, p.y), Vec3::new(p.x + ahead.x * 300.0, h - 70.0, p.y + ahead.y * 300.0))
        }
    };
    let eye_l = origin.to_local(eye);
    let look_l = origin.to_local(look);
    *tf = Transform::from_translation(eye_l).looking_at(look_l, Vec3::Y);
}

/// WASD + right-mouse look when the pose is `free` (any key switches to it).
fn free_fly(
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    buttons: Res<ButtonInput<MouseButton>>,
    mut motion: MessageReader<MouseMotion>,
    mut pose: ResMut<Pose>,
    mut q: Query<&mut Transform, With<MainCamera>>,
) {
    let dirs = [(KeyCode::KeyW, Vec3::NEG_Z), (KeyCode::KeyS, Vec3::Z), (KeyCode::KeyA, Vec3::NEG_X), (KeyCode::KeyD, Vec3::X), (KeyCode::KeyE, Vec3::Y), (KeyCode::KeyQ, Vec3::NEG_Y)];
    let mv: Vec3 = dirs.iter().filter(|(k, _)| keys.pressed(*k)).map(|(_, d)| *d).sum();
    let look: Vec2 = if buttons.pressed(MouseButton::Right) { motion.read().map(|m| m.delta).sum() } else { motion.read().map(|_| Vec2::ZERO).sum() };
    if mv == Vec3::ZERO && look == Vec2::ZERO {
        return;
    }
    *pose = Pose::Free;
    let Ok(mut tf) = q.single_mut() else { return };
    let speed = if keys.pressed(KeyCode::ShiftLeft) { 300.0 } else { 40.0 };
    let d = tf.rotation * mv;
    tf.translation += d * speed * time.delta_secs();
    let (yaw, pitch, _) = tf.rotation.to_euler(EulerRot::YXZ);
    tf.rotation = Quat::from_euler(EulerRot::YXZ, yaw - look.x * 0.003, (pitch - look.y * 0.003).clamp(-1.5, 1.5), 0.0);
}
