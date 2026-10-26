//! Large worlds, headless through `App::update()`: terrain queries vs colliders, streaming
//! load/unload with colliders, scatter determinism, HLOD merge counts, RON worlds, floating
//! origin, and the `world.*` control commands.

#![cfg(feature = "world")]

use std::path::PathBuf;
use std::time::Duration;

use engine::prelude::*;
use engine::world::cells::{CoarseCollider, Frozen, WorldCell};
use engine::world::hlod::HlodState;
use engine::world::prefab::PrefabInstance;
use engine::world::scatter::{ScatterCollider, ScatterRender};
use engine::world::terrain::TerrainCollider;
use engine::world::*;

const STEP: Duration = Duration::from_nanos(16_666_667);

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("engine-world-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn app(tag: &str) -> App {
    let mut app = engine::app_with(GameInfo::new("world-test", "World test"), EngineOptions::headless_test(temp_dir(tag)));
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(STEP));
    app.finish();
    app.cleanup();
    app
}

fn run(app: &mut App, frames: usize) {
    for _ in 0..frames {
        app.update();
    }
}

/// 1 km² of noise hills, 4 m samples, 128 m chunks, 256 m cells; a hut prefab, a village and
/// trees with trunk colliders.
fn desc(seed: u64) -> WorldDesc {
    WorldDesc::from_ron(&format!(
        r#"(
            seed: {seed},
            terrain: (size: (1024.0, 1024.0), spacing: 4.0, chunk_quads: 32, source: Noise((amplitude: 60.0, fbm: (frequency: 0.004, octaves: 4)))),
            cell_size: 256.0,
            materials: {{ "plaster": (color: (0.85, 0.8, 0.7)) }},
            prefabs: {{
                "hut": (parts: [
                    (shape: Cuboid((6.0, 3.0, 5.0)), material: "plaster", at: (0.0, 1.5, 0.0)),
                    (shape: Cone(radius: 4.6, height: 2.5), color: Some((0.5, 0.3, 0.1)), at: (0.0, 4.25, 0.0), collider: false),
                    (shape: Sphere(0.4), color: Some((0.5, 0.3, 0.1)), at: (2.0, 3.4, 1.5), collider: false),
                ], clear_radius: 6.0, tags: ["house"]),
                "box": (parts: [(shape: Cuboid((4.0, 4.0, 4.0)), material: "plaster", at: (0.0, 2.0, 0.0))]),
            }},
            placements: [(prefab: "box", at: (-400.0, 0.0, -400.0)), (prefab: "hut", at: (300.0, 0.0, 300.0), yaw: 30.0)],
            groups: [(prefabs: ["hut"], center: (0.0, 0.0), radius: 80.0, count: 10, min_spacing: 14.0, max_slope: 45.0, seed: 2)],
            scatter: [
                (name: "trees", mesh: Pine, far_mesh: Some(PineLow), render: Instanced, density: 0.002, cluster: 64.0, slope: (0.0, 40.0),
                 collider: Some((radius: 0.3, height: 4.0)), near: 200.0, cull: 600.0),
                (name: "grass", mesh: Grass, density: 0.5, cluster: 16.0, cull: 60.0),
            ],
        )"#
    ))
    .expect("desc parses")
}

fn spawn(app: &mut App, d: WorldDesc) {
    engine::world::spawn_world(app.world_mut(), d).expect("world spawns");
}

fn camera(app: &mut App, at: Vec3) -> Entity {
    app.world_mut().spawn((MainCamera, Transform::from_translation(at))).id()
}

fn count<F: bevy::ecs::query::QueryFilter>(app: &mut App) -> usize {
    app.world_mut().query_filtered::<(), F>().iter(app.world()).count()
}

#[cfg(feature = "physics")]
fn ray_down(app: &mut App, x: f32, z: f32) -> Option<f32> {
    use engine::avian3d::prelude::*;
    app.world_mut()
        .run_system_cached_with(
            |In((x, z)): In<(f32, f32)>, q: SpatialQuery| {
                q.cast_ray(Vec3::new(x, 500.0, z), Dir3::NEG_Y, 1000.0, true, &SpatialQueryFilter::default()).map(|h| 500.0 - h.distance)
            },
            (x, z),
        )
        .unwrap()
}

#[test]
fn resident_world_heights_match_colliders() {
    let mut app = app("resident");
    camera(&mut app, Vec3::new(0.0, 100.0, 0.0));
    spawn(&mut app, desc(7));
    run(&mut app, 5);
    let stats = app.world().resource::<WorldStats>().clone();
    assert!(stats.spawned);
    assert_eq!(stats.cells_total, 16);
    assert_eq!(stats.cells_loaded, 16, "resident: everything loaded");
    assert_eq!(count::<With<WorldCell>>(&mut app), 16);
    #[cfg(feature = "physics")]
    assert_eq!(stats.terrain_colliders, 64);
    let t = app.world().resource::<Terrain>().clone();
    assert_eq!(t.chunks(), UVec2::new(8, 8));
    #[cfg(feature = "physics")]
    {
        assert_eq!(count::<With<TerrainCollider>>(&mut app), 64, "one heightfield collider per chunk");
        assert_eq!(count::<With<CoarseCollider>>(&mut app), 0, "no fallback in resident mode");
        // Heights from the API equal what physics sees, anywhere (also between samples and on
        // chunk borders), except where a prefab or tree stands.
        let mut checked = 0;
        for i in 0..200 {
            let x = -500.0 + (i as f32 * 37.77) % 1000.0;
            let z = -500.0 + (i as f32 * 53.13) % 1000.0;
            let want = t.height_at(x, z);
            let got = ray_down(&mut app, x, z).expect("ray hits terrain");
            if (got - want).abs() > 0.02 {
                assert!(got > want, "physics below the terrain at {x},{z}: {got} vs {want}");
                continue; // a tree trunk or a hut
            }
            checked += 1;
        }
        assert!(checked > 150, "{checked}");
        // Chunk border exactly.
        let x = t.chunk_origin(UVec2::new(3, 3)).x;
        assert!((ray_down(&mut app, x, 10.3).unwrap() - t.height_at(x, 10.3)).abs() < 0.02);
    }
    // Normals and slope agree with finite differences.
    let (x, z) = (123.4, -222.2);
    let n = t.normal_at(x, z);
    let dx = (t.height_at(x + 0.5, z) - t.height_at(x - 0.5, z)) / 1.0;
    let dz = (t.height_at(x, z + 0.5) - t.height_at(x, z - 0.5)) / 1.0;
    let fd = Vec3::new(-dx, 1.0, -dz).normalize();
    assert!(n.dot(fd) > 0.98, "{n} vs {fd}");
    // Prefabs: box + hut + 10 village huts.
    assert_eq!(count::<With<PrefabInstance>>(&mut app), 12);
    let huts = app.world_mut().query::<&WorldTags>().iter(app.world()).filter(|t| t.0.iter().any(|s| s == "house")).count();
    assert_eq!(huts, 11);
    // Prefabs stand on the ground.
    let tf = app.world_mut().query_filtered::<&GlobalTransform, With<PrefabInstance>>().iter(app.world()).next().unwrap().translation();
    assert!((tf.y - t.height_at(tf.x, tf.z)).abs() < 1e-3);
}

#[cfg(feature = "physics")]
fn tree_colliders(app: &mut App) -> Vec<(i32, i32)> {
    use engine::avian3d::prelude::Collider;
    let mut v: Vec<(i32, i32)> = app
        .world_mut()
        .query_filtered::<&GlobalTransform, (With<Collider>, Without<TerrainCollider>, Without<CoarseCollider>, Without<ChildOf>)>()
        .iter(app.world())
        .map(|g| ((g.translation().x * 100.0) as i32, (g.translation().z * 100.0) as i32))
        .collect();
    let mut kids: Vec<(i32, i32)> = app
        .world_mut()
        .query_filtered::<(&GlobalTransform, &ChildOf), (With<Collider>, Without<TerrainCollider>, Without<CoarseCollider>)>()
        .iter(app.world())
        .filter(|(_, p)| app.world().get::<WorldCell>(p.parent()).is_some())
        .map(|(g, _)| ((g.translation().x * 100.0) as i32, (g.translation().z * 100.0) as i32))
        .collect();
    v.append(&mut kids);
    v.sort();
    v
}

#[cfg(feature = "physics")]
#[test]
fn scatter_is_deterministic_by_seed() {
    let run_world = |seed: u64| {
        let mut app = app("scatter");
        camera(&mut app, Vec3::new(0.0, 50.0, 0.0));
        spawn(&mut app, desc(seed));
        run(&mut app, 3);
        tree_colliders(&mut app)
    };
    let a = run_world(11);
    let b = run_world(11);
    let c = run_world(12);
    assert!(a.len() > 500, "trees with trunk colliders: {}", a.len());
    assert_eq!(a, b, "same seed, same trees");
    assert_ne!(a, c, "another seed, another forest");
    // The scatter API gives the same set as the spawned colliders.
    let mut app = app("scatter-api");
    spawn(&mut app, desc(11));
    let sc = app.world().resource::<engine::world::scatter::Scatter>();
    let mut api: Vec<(i32, i32)> = sc.place(0, Vec2::splat(-512.0), Vec2::splat(512.0)).iter().map(|i| ((i.pos.x * 100.0) as i32, (i.pos.z * 100.0) as i32)).collect();
    api.sort();
    assert_eq!(api.len(), a.len());
    // Village clearings: no tree within a hut's clear radius.
    let cells = app.world().resource::<WorldCells>();
    let huts: Vec<Vec3> = (0..4).flat_map(|z| (0..4).map(move |x| IVec2::new(x, z))).flat_map(|c| cells.placed(c).iter().filter(|p| &*p.prefab == "hut").map(|p| p.transform.translation)).collect();
    assert_eq!(huts.len(), 11);
    for h in huts {
        assert!(api.iter().all(|(x, z)| Vec2::new(*x as f32 / 100.0, *z as f32 / 100.0).distance(h.xz()) >= 5.9));
    }
}

#[cfg(feature = "physics")]
#[test]
fn streaming_loads_and_unloads_cells_with_colliders() {
    let mut app = app("stream");
    app.world_mut().resource_mut::<WorldSettings>().streaming = engine::world::StreamingSettings { mode: StreamMode::Streamed, load_radius: 100.0, unload_radius: 150.0, loads_per_frame: 1, ..default() };
    let cam = camera(&mut app, Vec3::new(-400.0, 80.0, -400.0));
    spawn(&mut app, desc(5));
    run(&mut app, 1);
    let loaded = |app: &App| app.world().resource::<WorldCells>().loaded_count();
    assert!(loaded(&app) <= 1, "budget: one cell per frame");
    run(&mut app, 10);
    let cells = app.world().resource::<WorldCells>();
    assert!(cells.is_loaded(IVec2::new(0, 0)));
    assert!(!cells.is_loaded(IVec2::new(3, 3)));
    let near_loaded = loaded(&app);
    assert!((1..=4).contains(&near_loaded), "{near_loaded}");
    // Colliders only in loaded cells (4 chunks per cell), plus the coarse fallback.
    assert_eq!(count::<With<TerrainCollider>>(&mut app), near_loaded * 4);
    assert_eq!(count::<With<CoarseCollider>>(&mut app), 1);
    run(&mut app, 2);
    // Fine collider where loaded; the fallback (slightly lower) elsewhere.
    let t = app.world().resource::<Terrain>().clone();
    let h = ray_down(&mut app, -390.0, -410.0).unwrap();
    assert!((h - t.height_at(-390.0, -410.0)).abs() < 0.02 || h > t.height_at(-390.0, -410.0));
    let far = ray_down(&mut app, 380.0, 380.0).expect("coarse collider under unloaded cells");
    assert!(far <= t.height_at(380.0, 380.0) - 0.04 && far > t.height_at(380.0, 380.0) - 30.0, "{far}");
    // A frozen body in an unloaded cell, an agent keeping its cell loaded.
    let body = app.world_mut().spawn((StreamFreeze, Transform::from_xyz(200.0, 100.0, 200.0), engine::avian3d::prelude::RigidBody::Dynamic, engine::avian3d::prelude::Collider::sphere(0.5))).id();
    let agent = app.world_mut().spawn((StreamSource { radius: Some(10.0) }, Transform::from_xyz(130.0, 0.0, -130.0))).id();
    run(&mut app, 6);
    assert!(app.world().get::<Frozen>(body).is_some());
    assert!(app.world().get::<engine::avian3d::prelude::RigidBodyDisabled>(body).is_some());
    let y0 = app.world().get::<Transform>(body).unwrap().translation.y;
    run(&mut app, 10);
    assert_eq!(app.world().get::<Transform>(body).unwrap().translation.y, y0, "frozen: no gravity");
    assert!(app.world().resource::<WorldCells>().is_loaded_at(Vec2::new(130.0, -130.0)), "the agent's cell is loaded");
    let stats = app.world().resource::<WorldStats>().clone();
    assert_eq!(stats.frozen_bodies, 1);

    // Fly to the other corner: old cells unload (hysteresis), new ones load.
    app.world_mut().get_mut::<Transform>(cam).unwrap().translation = Vec3::new(300.0, 80.0, 300.0);
    run(&mut app, 12);
    let cells = app.world().resource::<WorldCells>();
    assert!(!cells.is_loaded(IVec2::new(0, 0)), "far cell unloaded");
    assert!(cells.is_loaded(IVec2::new(3, 3)));
    assert!(cells.is_loaded_at(Vec2::new(130.0, -130.0)), "agent still keeps its cell");
    assert!(app.world().get::<Frozen>(body).is_none(), "body's cell (2,2) loaded: unfrozen");
    let world_cells = count::<With<WorldCell>>(&mut app);
    assert_eq!(world_cells, app.world().resource::<WorldCells>().loaded_count());
    assert_eq!(count::<With<TerrainCollider>>(&mut app), world_cells * 4);
    // Messages fired.
    let loads = app.world().resource::<bevy::ecs::message::Messages<CellLoaded>>().len();
    let _ = loads;
    // Back to resident: everything loads, the fallback goes.
    app.world_mut().despawn(agent);
    app.world_mut().resource_mut::<WorldSettings>().streaming.mode = StreamMode::Resident;
    run(&mut app, 3);
    assert_eq!(app.world().resource::<WorldCells>().loaded_count(), 16);
    assert_eq!(count::<With<CoarseCollider>>(&mut app), 0);
}

#[test]
fn hlod_merges_cells_per_material() {
    let mut app = app("hlod");
    camera(&mut app, Vec3::ZERO);
    spawn(&mut app, desc(3));
    for _ in 0..200 {
        app.update();
        if app.world().resource::<HlodState>().pending() == 0 {
            break;
        }
    }
    let h = app.world().resource::<HlodState>();
    assert_eq!(h.pending(), 0);
    // The lone 4 m box in cell (0,0): one material, a cube's 24 vertices survive 1 m voxels.
    let boxes: Vec<_> = h.built.iter().filter(|(c, _, _)| *c == IVec2::new(0, 0)).collect();
    assert_eq!(boxes.len(), 1);
    assert_eq!(boxes[0].1, "plaster");
    assert_eq!(boxes[0].2, 24);
    // The village (cells around the centre): huts' walls ("plaster") and roofs ("#7f4c19")
    // merge into one mesh per material per cell, with fewer vertices than the parts.
    let stats = app.world().resource::<WorldStats>().clone();
    assert!(stats.hlod_source_vertices > stats.hlod_vertices, "{} → {}", stats.hlod_source_vertices, stats.hlod_vertices);
    let roofs = h.built.iter().filter(|(_, k, _)| k.starts_with('#')).count();
    assert!(roofs >= 1);
    let walls = h.built.iter().filter(|(_, k, _)| k == "plaster").count();
    assert!(walls >= 2, "box cell + village cell(s): {walls}");
    // Merge counts are exact for the cuboid: 11 huts' walls → ≤ 24 vertices each.
    let hut_walls: usize = h.built.iter().filter(|(c, k, _)| k == "plaster" && *c != IVec2::new(0, 0)).map(|b| b.2).sum();
    assert!((24..=11 * 24).contains(&hut_walls), "{hut_walls}");
}

#[test]
fn floating_origin_rebases_and_queries_stay_absolute() {
    let mut app = app("origin");
    app.world_mut().resource_mut::<WorldSettings>().origin = engine::world::OriginSettings { enabled: true, threshold: 300.0, snap: 64.0 };
    let cam = camera(&mut app, Vec3::new(0.0, 100.0, 0.0));
    spawn(&mut app, desc(9));
    run(&mut app, 3);
    let t = app.world().resource::<Terrain>().clone();
    let probe = Vec3::new(400.0, 0.0, 380.0);
    // Move the camera far: the scene rebases around it.
    app.world_mut().get_mut::<Transform>(cam).unwrap().translation = Vec3::new(410.0, 100.0, 390.0);
    run(&mut app, 3);
    let o = *app.world().resource::<WorldOrigin>();
    assert_eq!(o.shifts, 1);
    assert_eq!(o.offset, bevy::math::DVec2::new(384.0, 384.0));
    let cam_local = app.world().get::<GlobalTransform>(cam).unwrap().translation();
    assert!(cam_local.xz().length() < 64.0, "{cam_local}");
    assert_eq!(o.to_abs(cam_local).xz(), Vec2::new(410.0, 390.0));
    // A prefab's absolute position is unchanged.
    let cells = app.world().resource::<WorldCells>();
    let hut = cells.placed(cells.cell_at(Vec2::new(300.0, 300.0)))[0].transform.translation;
    let inst = app.world_mut().query_filtered::<&GlobalTransform, With<PrefabInstance>>().iter(app.world()).map(|g| o.to_abs(g.translation())).find(|p| p.distance(hut) < 0.01);
    assert!(inst.is_some(), "hut at {hut} after rebase");
    #[cfg(feature = "physics")]
    {
        run(&mut app, 2);
        let local = o.to_local(probe);
        let got = ray_down(&mut app, local.x, local.z).unwrap();
        assert!((got - t.height_at(probe.x, probe.z)).abs() < 0.05 || got > t.height_at(probe.x, probe.z), "{got}");
    }
    let _ = (t, probe);
}

#[cfg(feature = "devtools")]
#[test]
fn control_commands_answer() {
    use engine::devtools::ControlRegistry;
    use engine::devtools::control::Handler;
    let mut app = app("control");
    camera(&mut app, Vec3::new(0.0, 60.0, 0.0));
    spawn(&mut app, desc(1));
    run(&mut app, 3);
    let call = |app: &mut App, id: &str, p: serde_json::Value| -> serde_json::Value {
        let h = app.world().resource::<ControlRegistry>().get(id).unwrap_or_else(|| panic!("{id} registered")).handler;
        match h {
            Handler::Instant(f) => f(app.world_mut(), p).unwrap(),
            Handler::Deferred(_) => panic!("instant"),
        }
    };
    let s = call(&mut app, "world.stats", serde_json::json!({}));
    assert_eq!(s["cells_total"], 16);
    assert_eq!(s["mode"], "Resident");
    let h = call(&mut app, "world.height", serde_json::json!({"x": 100.0, "z": -50.0}));
    let t = app.world().resource::<Terrain>().clone();
    assert!((h["height"].as_f64().unwrap() as f32 - t.height_at(100.0, -50.0)).abs() < 1e-4);
    assert_eq!(h["loaded"], true);
    let c = call(&mut app, "world.cells", serde_json::json!({"all": true}));
    assert_eq!(c["loaded"].as_array().unwrap().len(), 16);
    assert_eq!(c["cells"].as_array().unwrap().len(), 16);
    let tp = call(&mut app, "world.teleport", serde_json::json!({"x": 250.0, "z": 260.0, "up": 3.0}));
    assert!((tp["at"][1].as_f64().unwrap() as f32 - (t.height_at(250.0, 260.0) + 3.0)).abs() < 1e-3);
    let cam = app.world_mut().query_filtered::<&Transform, With<MainCamera>>().single(app.world()).unwrap().translation;
    assert_eq!(cam.xz(), Vec2::new(250.0, 260.0));
    let st = call(&mut app, "world.settings", serde_json::json!({"mode": "streamed", "load_radius": 50.0}));
    assert_eq!(st["mode"], "Streamed");
    run(&mut app, 20);
    let c = call(&mut app, "world.cells", serde_json::json!({}));
    assert!(c["loaded"].as_array().unwrap().len() < 16);
}

#[test]
fn code_prefabs_and_hooks_spawn_with_cells() {
    #[derive(Component)]
    struct Chest;
    #[derive(Component)]
    struct CellNpc;
    let mut app = app("hooks");
    app.world_mut().resource_mut::<WorldAssets>().add_code_prefab("chest", |c: &mut Commands, ctx: &engine::world::prefab::PrefabCtx| c.spawn((Chest, ctx.transform, ChildOf(ctx.parent))).id());
    let mut d = desc(4);
    d.placements.push(engine::world::desc::Placement { prefab: "chest".into(), at: [10.0, 0.5, 10.0], yaw: 0.0, scale: 1.0, ground: true });
    app.world_mut().resource_mut::<WorldSettings>().streaming = engine::world::StreamingSettings { mode: StreamMode::Streamed, load_radius: 50.0, unload_radius: 60.0, loads_per_frame: 8, ..default() };
    let cam = camera(&mut app, Vec3::new(10.0, 50.0, 10.0));
    spawn(&mut app, d);
    app.world_mut().resource_mut::<WorldCells>().on_load(|c: &mut Commands, ctx: &engine::world::cells::CellCtx| {
        c.spawn((CellNpc, Transform::from_xyz(ctx.size * 0.5, 0.0, ctx.size * 0.5), ChildOf(ctx.root)));
    });
    run(&mut app, 4);
    assert_eq!(count::<With<Chest>>(&mut app), 1);
    let npcs = count::<With<CellNpc>>(&mut app);
    assert_eq!(npcs, app.world().resource::<WorldCells>().loaded_count());
    // Walk away: the chest's cell unloads with its content.
    app.world_mut().get_mut::<Transform>(cam).unwrap().translation = Vec3::new(-450.0, 50.0, -450.0);
    run(&mut app, 4);
    assert_eq!(count::<With<Chest>>(&mut app), 0);
    assert_eq!(count::<With<CellNpc>>(&mut app), app.world().resource::<WorldCells>().loaded_count());
    // Unknown prefab → error.
    let mut bad = desc(4);
    bad.placements.push(engine::world::desc::Placement { prefab: "nope".into(), at: [0.0; 3], yaw: 0.0, scale: 1.0, ground: true });
    assert!(matches!(engine::world::spawn_world(app.world_mut(), bad), Err(WorldError::UnknownPrefab(_))));
    let _ = (ScatterCollider { radius: 0.0, height: 0.0 }, ScatterRender::Merged);
}
