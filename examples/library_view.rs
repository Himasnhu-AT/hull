//! Shows asset-library models in a row: cars (Kenney Car Kit), road pieces (Kenney City Kit
//! Roads) and a Poly Haven asphalt ground, all loaded from `assets/library/` (docs/ASSETS.md).
//! Fetch first: `python3 -I scripts/assets.py fetch cars-and-roads`. Items that are not fetched
//! are skipped with a warning.
//!
//!   python3 -I scripts/play.py steps.json --example library_view

use engine::gfx::{PendingMips, load_pbr_at, world_uv_cuboid};
use engine::paths::AssetsDir;
use engine::prelude::*;

const CARS: [&str; 8] = ["sedan", "taxi", "police", "suv", "van", "firetruck", "garbage-truck", "truck"];
const ROADS: [&str; 6] = ["road-straight", "road-bend", "road-crossroad", "road-intersection", "road-end", "road-straight-barrier"];

fn main() {
    engine::app(GameInfo::new("engine-library-view", "Library View").assets_fallback(concat!(env!("CARGO_MANIFEST_DIR"), "/assets")))
        .add_plugins(LibraryView)
        .run();
}

struct LibraryView;

impl Plugin for LibraryView {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, setup);
    }
}

fn setup(
    mut commands: Commands,
    server: Res<AssetServer>,
    dir: Res<AssetsDir>,
    mut pending: ResMut<PendingMips>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<StandardMaterial>>,
) {
    let ground = load_pbr_at(&server, &dir, &mut pending, "library/textures/polyhaven-asphalt_01", Color::WHITE)
        .unwrap_or_else(|| StandardMaterial { base_color: Color::srgb(0.3, 0.3, 0.32), ..default() });
    commands.spawn((
        Name::new("Ground"),
        Mesh3d(meshes.add(world_uv_cuboid(Vec3::new(60.0, 0.2, 30.0), Vec3::new(0.0, -0.1, 0.0), 4.0))),
        MeshMaterial3d(mats.add(ground)),
        Transform::from_xyz(0.0, -0.1, 0.0),
        Scenery,
    ));

    let mut row = |names: &[&str], pack: &str, z: f32, spacing: f32, scale: f32| {
        let x0 = -(names.len() as f32 - 1.0) * spacing * 0.5;
        for (i, n) in names.iter().enumerate() {
            let rel = format!("library/{pack}/{n}.glb");
            if !dir.has(&rel) {
                warn!("{rel} missing: run scripts/assets.py fetch cars-and-roads");
                continue;
            }
            commands.spawn((
                Name::new(n.to_string()),
                WorldAssetRoot(server.load(GltfAssetLabel::Scene(0).from_asset(rel))),
                Transform::from_xyz(x0 + i as f32 * spacing, 0.0, z).with_scale(Vec3::splat(scale)).with_rotation(Quat::from_rotation_y(0.5)),
                Scenery,
            ));
        }
    };
    row(&CARS, "cars/kenney-car-kit", 3.0, 3.2, 1.0);
    row(&ROADS, "roads/kenney-city-kit-roads", -5.0, 5.5, 4.0);

    commands.spawn((
        DirectionalLight { illuminance: 12_000.0, shadow_maps_enabled: true, ..default() },
        Transform::from_xyz(6.0, 12.0, 8.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 6.0, 12.0).looking_at(Vec3::new(0.0, 0.0, -1.0), Vec3::Y)));
}
