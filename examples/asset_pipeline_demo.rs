//! 3D asset pipeline demo (docs/ASSETS.md, "3D pipeline"): cooks a procedural pine with
//! `asset-pipe` (LODs, collider, impostor atlas), then spawns it with `engine::assets::spawn` in a
//! row going away from the camera so each LOD and the impostor show, plus a far forest.
//!
//!   python3 -I scripts/play.py scripts/asset-pipeline-demo.json --example asset_pipeline_demo
//!
//! Control commands: `assets.list` (which part each tree draws), `demo.cam` (near | far | side).

use asset_pipe::fixtures;
use asset_pipe::impostor::BakeConfig;
use asset_pipe::pipeline::{Config, Pipeline};
use engine::assets::SpawnCooked;
use engine::prelude::*;

const OUT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/cooked_demo");

fn main() {
    cook();
    let mut app = engine::app(GameInfo::new("engine-asset-pipeline-demo", "Asset Pipeline Demo").assets_fallback(concat!(env!("CARGO_MANIFEST_DIR"), "/assets")));
    app.add_plugins(Demo);
    app.run();
}

/// The offline half: model in, cooked asset + sidecar out (what `asset-pipe model.glb --out DIR` does).
fn cook() {
    let cfg = Config {
        name: "pine".into(),
        lod_ratios: vec![0.35, 0.12],
        lod_distances: vec![15.0, 40.0, 80.0],
        impostor: Some(BakeConfig { views: 8, cell: 128, supersample: 2 }),
        tags: vec!["tree".into()],
        ..Default::default()
    };
    match Pipeline::standard().run(fixtures::tree(), &cfg, std::path::Path::new(OUT)) {
        Ok(a) => info!("cooked pine: {:?} triangles per LOD", a.desc.as_ref().map(|d| d.lods.iter().map(|l| l.triangles).collect::<Vec<_>>())),
        Err((_, e)) => panic!("cook failed: {e}"),
    }
}

struct Demo;

impl Plugin for Demo {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, setup);
        #[cfg(feature = "devtools")]
        {
            use engine::devtools::{AddControlCommand, params};
            app.add_control_command("demo.cam", "Camera pose: near | far | side", params(&[("name", "string", "pose")]), |w, p| {
                let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("near").to_string();
                let (pos, look) = match name.as_str() {
                    "near" => (Vec3::new(0.0, 2.2, 8.0), Vec3::new(0.0, 3.0, -60.0)),
                    "far" => (Vec3::new(0.0, 6.0, 62.0), Vec3::new(0.0, 5.0, -60.0)),
                    "side" => (Vec3::new(40.0, 10.0, -50.0), Vec3::new(0.0, 3.0, -50.0)),
                    _ => return Err(format!("unknown pose {name}")),
                };
                let mut q = w.query_filtered::<&mut Transform, With<MainCamera>>();
                for mut t in q.iter_mut(w) {
                    *t = Transform::from_translation(pos).looking_at(look, Vec3::Y);
                }
                Ok(serde_json::json!({"cam": name}))
            });
        }
    }
}

fn setup(mut commands: Commands, server: Res<AssetServer>, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<StandardMaterial>>) {
    commands.spawn((
        Name::new("Ground"),
        Mesh3d(meshes.add(Plane3d::default().mesh().size(600.0, 600.0))),
        MeshMaterial3d(mats.add(StandardMaterial { base_color: Color::srgb(0.30, 0.38, 0.22), perceptual_roughness: 1.0, ..default() })),
        Transform::from_xyz(0.0, 0.0, -80.0),
        Scenery,
    ));
    commands.spawn((DirectionalLight { illuminance: 14_000.0, shadow_maps_enabled: true, ..default() }, Transform::from_xyz(-30.0, 40.0, 30.0).looking_at(Vec3::ZERO, Vec3::Y)));
    commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 2.2, 8.0).looking_at(Vec3::new(0.0, 3.0, -60.0), Vec3::Y)));

    // The row: one tree per LOD tier (0-15, 15-40, 40-80 m, impostor beyond).
    for (i, z) in [-6.0f32, -25.0, -55.0, -100.0, -140.0].into_iter().enumerate() {
        let x = if i % 2 == 0 { -3.0 } else { 3.0 };
        commands.spawn_cooked(&server, "cooked_demo/pine", Transform::from_xyz(x, 0.0, z).with_rotation(Quat::from_rotation_y(i as f32 * 0.9)));
    }
    // A far forest (deterministic scatter): mostly impostors from the near camera.
    let mut s = 0x9E37_79B9u32;
    let mut rnd = move || {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        s as f32 / u32::MAX as f32
    };
    for _ in 0..120 {
        let (x, z) = (-70.0 + rnd() * 140.0, -170.0 + rnd() * 100.0);
        if x.abs() < 8.0 {
            continue;
        }
        commands.spawn_cooked(&server, "cooked_demo/pine", Transform::from_xyz(x, 0.0, z).with_rotation(Quat::from_rotation_y(rnd() * std::f32::consts::TAU)).with_scale(Vec3::splat(0.8 + rnd() * 0.5)));
    }
}
