//! The editor's world tools on a small open world: 1 km of noise terrain (2 m samples, four splat
//! layers), a closed road (`Spline` + `SplineRoad`), a PCG volume dressing the hills with trees and
//! rocks (hand edits go to its `PcgOverrides`) and a registered placeable.
//!
//! `cargo run --example world_editor_demo --features editor -- --editor`
//!
//! Tools (toolbar): Spline, Sculpt, Paint, Foliage, Place. Script them with `editor.tool` and
//! `editor.tool_action` (docs/EDITOR.md, "World tools").

use std::sync::Arc;

use engine::editor::EditorConfig;
use engine::level::{LevelEntity, RegisterPlaceable, new_stable_id};
use engine::pcg::pcg_core::{Area, Graph, Inputs, Rect, Surface, Tier};
use engine::pcg::{PcgCatalog, PcgFollowTerrain, PcgGraphRef, PcgVolume};
use engine::prelude::*;
use engine::spline::{Spline, SplinePoint, SplineRoad};
use engine::world::*;

const SIZE: f32 = 1000.0;

/// A gameplay marker the Place tool can drop (shows in Details like any component).
#[derive(Component, Reflect, Default, Clone, Debug)]
#[reflect(Component, Default)]
struct EventMarker {
    label: String,
    radius: f32,
}

fn main() {
    let mut app = engine::app_with(GameInfo::new("world-editor-demo", "World editor demo"), EngineOptions { ui: false, ..EngineOptions::from_args() });
    {
        let mut s = app.world_mut().resource_mut::<WorldSettings>();
        s.streaming.mode = StreamMode::Resident;
        s.hlod.enabled = false;
    }
    app.insert_resource(EditorConfig { play_features: Some("editor".into()), ..default() })
        .insert_resource(ClearColor(Color::srgb(0.62, 0.72, 0.84)))
        .register_type::<EventMarker>()
        .register_placeable::<EventMarker>("Event marker", "flag", "Gameplay")
        .add_systems(OnEnter(AppState::InGame), setup)
        .run();
}

fn setup(world: &mut World) {
    let n = (SIZE / 2.0) as u32 + 1;
    let noise = NoiseTerrain { fbm: Fbm { seed: 11, frequency: 0.0016, octaves: 5, warp: 60.0, ..default() }, amplitude: 70.0, base: 0.0, exponent: 1.6, border_falloff: 0.0 };
    let hf = Heightfield::from_noise(n, n, 2.0, Vec2::splat(-SIZE * 0.5), &noise);
    let mut desc = WorldDesc { seed: 5, terrain: engine::world::desc::TerrainDesc { size: [SIZE, SIZE], spacing: 2.0, chunk_quads: 64, ..default() }, ..default() };
    // Four paintable layers: grass, dirt, gravel, red paint (the last two only by hand).
    let mut layers = engine::world::material::default_layers();
    layers[1] = SplatLayer { name: "dirt".into(), color: [0.45, 0.33, 0.2], slope: [30.0, 90.0], blend: 8.0, weight: 3.0, ..default() };
    layers[2] = SplatLayer { name: "gravel".into(), color: [0.6, 0.58, 0.54], height: [-1e6, -1e5], weight: 0.0, ..default() };
    layers[3] = SplatLayer { name: "paint".into(), color: [0.85, 0.2, 0.15], height: [1e5, 1e6], weight: 0.0, ..default() };
    desc.terrain.layers = layers;
    // The PCG surface: the same heights, sampled once.
    let (w, a0) = (301usize, -300.0f32);
    let heights: Vec<f32> = (0..w * w).map(|i| hf.height_at(a0 + (i % w) as f32 * 2.0, a0 + (i / w) as f32 * 2.0)).collect();
    if let Err(e) = engine::world::desc::spawn_world_with(world, desc, Some(hf)) {
        error!("world_editor_demo: {e}");
        return;
    }
    let ground = |world: &World, x: f32, z: f32| world.resource::<TerrainHeights>().height_at(x, z);

    let mut commands = world.commands();
    engine::gfx::sky_and_sun_with(
        &mut commands,
        engine::gfx::SunSetup { direction: Vec3::new(0.5, -0.5, 0.35), cascades: 3, first_cascade: 20.0, shadow_distance: 500.0, atmosphere: false, fallback_sky: Color::srgb(0.62, 0.72, 0.84), ambient_brightness: 900.0, ..default() },
    );

    // A closed road on the terrain.
    let points: Vec<SplinePoint> = (0..10)
        .map(|i| {
            let a = i as f32 / 10.0 * std::f32::consts::TAU;
            let r = 1.0 + 0.2 * (a * 3.0).sin();
            let (x, z) = (a.cos() * 150.0 * r, a.sin() * 110.0 * r);
            SplinePoint::at(Vec3::new(x, ground(world, x, z) + 0.4, z)).with_width(9.0 + 2.0 * (a * 2.0).sin())
        })
        .collect();
    let id = new_stable_id(world);
    world.spawn((LevelEntity { id }, Name::new("Road"), Spline { points, closed: true, ..default() }, SplineRoad { step: 2.0, uv_scale: 8.0, color: Color::srgb(0.22, 0.22, 0.24) }, Transform::default(), Visibility::default()));

    // PCG dressing: trees and rocks over the middle of the map.
    {
        let mut meshes = world.resource_mut::<Assets<Mesh>>();
        let tree_mesh = meshes.add(Cone { radius: 3.0, height: 10.0 }.mesh().build().translated_by(Vec3::Y * 5.0));
        let rock_mesh = meshes.add(Sphere::new(0.9).mesh().ico(1).unwrap());
        let mut mats = world.resource_mut::<Assets<StandardMaterial>>();
        let tree_mat = mats.add(StandardMaterial { base_color: Color::srgb(0.16, 0.38, 0.18), perceptual_roughness: 0.9, ..default() });
        let rock_mat = mats.add(StandardMaterial { base_color: Color::srgb(0.45, 0.43, 0.4), perceptual_roughness: 0.9, ..default() });
        world.resource_mut::<PcgCatalog>().mesh("tree", tree_mesh, tree_mat).mesh("rock", rock_mesh, rock_mat);
    }
    let graph = Graph::build(7)
        .input("lots")
        .poisson(12.0)
        .project(0.0, false)
        .spawn(&[("tree", 1.0)], Tier::Normal)
        .id("trees")
        .from("lots")
        .poisson(25.0)
        .project(0.0, false)
        .spawn(&[("rock", 1.0)], Tier::Fine)
        .id("rocks")
        .finish()
        .expect("graph");
    let inputs = Inputs::default().rects("lots", vec![Rect::new(Vec2::ZERO, Vec2::splat(280.0))]).surface(Surface::Heightfield { origin: Vec2::splat(a0), cell: 2.0, width: w, heights });
    let id = new_stable_id(world);
    world.spawn((LevelEntity { id }, Name::new("Dressing"), PcgVolume { graph: PcgGraphRef::Inline(Arc::new(graph)), inputs: Arc::new(inputs), area: Area::new(Vec2::splat(-280.0), Vec2::splat(280.0)), cell: 64.0 }, PcgFollowTerrain));

    if !world.resource::<Headless>().0 {
        let h = ground(world, 0.0, 0.0);
        world.spawn((Name::new("camera"), MainCamera, Camera3d::default(), Projection::Perspective(PerspectiveProjection { far: 4000.0, ..default() }), bevy::camera::Exposure { ev100: 13.0 }, Transform::from_xyz(-170.0, h + 120.0, -230.0).looking_at(Vec3::new(0.0, h, 0.0), Vec3::Y)));
    }
    world.flush();
}
