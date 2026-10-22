//! Render budget with Bevy's real visibility systems, no GPU: an engine app (headless options)
//! plus Bevy's camera/visibility plugin and a camera that renders to nothing. Checks
//! `RenderStats` counting, distance tiers and zero-config actor/scenery classification.

use std::time::Duration;

use bevy::camera::visibility::VisibilityRange;
use bevy::camera::{CameraPlugin, RenderTarget};
use engine::prelude::*;
use engine::render_budget::{AutoActor, AutoScenery, BudgetClass, DetailTier};

const STEP: Duration = Duration::from_nanos(16_666_667);

#[derive(Component)]
struct Spin;

fn spin(mut q: Query<&mut Transform, With<Spin>>) {
    for mut t in &mut q {
        t.translation.x += 0.05;
    }
}

struct Ids {
    near_wall: Entity,
    far_wall: Entity,
    far_crate: Entity,
    behind: Entity,
    untagged_still: Entity,
    untagged_moving: Entity,
    untagged_wall: Entity,
}

fn build() -> (App, Ids) {
    let dir = std::env::temp_dir().join(format!("engine-render-budget-{}-{}", std::process::id(), rand::random::<u32>()));
    let mut app = engine::app_with(GameInfo::new("render-budget-test", "Render budget test"), EngineOptions::headless_test(&dir));
    app.add_plugins((CameraPlugin, bevy::image::ImagePlugin::default()))
        .init_asset::<StandardMaterial>()
        .insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(STEP))
        .add_systems(Update, spin);
    app.world_mut().resource_mut::<RenderBudget>().detailed_stats = true;
    app.world_mut().resource_mut::<RenderBudget>().settle_frames = 20;
    app.finish();
    app.cleanup();

    let w = app.world_mut();
    let cube = w.resource_mut::<Assets<Mesh>>().add(Cuboid::new(1.0, 1.0, 1.0));
    let mat = w.resource_mut::<Assets<StandardMaterial>>().add(StandardMaterial::default());
    let look = (Mesh3d(cube), MeshMaterial3d(mat));
    // Camera at the origin looking down -Z.
    w.spawn((MainCamera, Camera3d::default(), RenderTarget::None { size: UVec2::new(800, 600) }, Transform::default()));
    let piece = |w: &mut World, tag: Option<bool>, at: Vec3, scale: Vec3| {
        let mut e = w.spawn((look.clone(), Transform::from_translation(at).with_scale(scale)));
        match tag {
            Some(true) => e.insert(Scenery),
            Some(false) => e.insert(Actor),
            None => &mut e,
        };
        e.id()
    };
    let ids = Ids {
        near_wall: piece(w, Some(true), Vec3::new(0.0, 0.0, -10.0), Vec3::new(8.0, 3.0, 0.5)),
        far_wall: piece(w, Some(true), Vec3::new(0.0, 0.0, -120.0), Vec3::new(8.0, 3.0, 0.5)),
        far_crate: piece(w, Some(true), Vec3::new(2.0, 0.0, -100.0), Vec3::splat(0.8)),
        behind: piece(w, Some(true), Vec3::new(0.0, 0.0, 20.0), Vec3::splat(2.0)),
        untagged_still: piece(w, None, Vec3::new(-3.0, 0.0, -15.0), Vec3::splat(0.5)),
        untagged_moving: piece(w, None, Vec3::new(3.0, 0.0, -15.0), Vec3::splat(0.5)),
        untagged_wall: piece(w, None, Vec3::new(20.0, 0.0, -130.0), Vec3::new(10.0, 4.0, 0.5)),
    };
    piece(w, Some(false), Vec3::new(0.0, 0.0, -5.0), Vec3::splat(0.5));
    w.entity_mut(ids.untagged_moving).insert(Spin);
    (app, ids)
}

#[test]
fn stats_tiers_and_auto_classification() {
    let (mut app, ids) = build();
    for _ in 0..40 {
        app.update();
    }
    let w = app.world();
    // Tiers: big walls are Near (+ a far twin child), the crate is Small.
    assert_eq!(w.get::<DetailTier>(ids.near_wall), Some(&DetailTier::Near));
    assert_eq!(w.get::<DetailTier>(ids.far_crate), Some(&DetailTier::Small));
    assert!(w.get::<VisibilityRange>(ids.far_wall).is_some());
    // Zero config: still → scenery, moving → actor.
    assert!(w.get::<AutoScenery>(ids.untagged_still).is_some(), "still mesh settles into scenery");
    assert_eq!(w.get::<BudgetClass>(ids.untagged_still), Some(&BudgetClass::Scenery));
    assert!(w.get::<AutoActor>(ids.untagged_moving).is_some(), "moving mesh is an actor");
    assert!(w.get::<DetailTier>(ids.untagged_moving).is_none(), "actors keep full detail");
    assert_eq!(w.get::<BudgetClass>(ids.behind), Some(&BudgetClass::Scenery));
    // Untagged big piece: settles into scenery and keeps it (gaining its far-twin child
    // rewrites its transform without moving it).
    assert_eq!(w.get::<DetailTier>(ids.untagged_wall), Some(&DetailTier::Near));
    assert!(w.get::<AutoScenery>(ids.untagged_wall).is_some());

    let s = w.resource::<RenderStats>().clone();
    // 8 pieces + 4 far twins (near wall, far wall, behind block, untagged wall).
    assert_eq!(s.meshes_total, 12, "{s:?}");
    // Visible: near wall, the two far walls' twins, tagged actor, both small untagged.
    assert_eq!(s.meshes_visible, 6, "{s:?}");
    assert_eq!(s.actors_visible, 2, "{s:?}");
    assert_eq!(s.lod_far, 2, "{s:?}");
    assert_eq!(s.culled_distance, 1, "only the far crate is gone by distance: {s:?}");
    assert_eq!(s.culled_frustum, 1, "the block behind the camera: {s:?}");

    // Auto scenery that starts moving goes back to full detail.
    app.world_mut().entity_mut(ids.untagged_still).insert(Spin);
    for _ in 0..3 {
        app.update();
    }
    let w = app.world();
    assert!(w.get::<AutoActor>(ids.untagged_still).is_some());
    assert!(w.get::<DetailTier>(ids.untagged_still).is_none());

    // Detail off: everything near-tier, no far twins drawn, nothing culled by distance.
    app.world_mut().resource_mut::<RenderBudget>().scenery_detail = false;
    for _ in 0..2 {
        app.update();
    }
    let s = app.world().resource::<RenderStats>().clone();
    assert_eq!(s.culled_distance, 0, "{s:?}");
    assert_eq!(s.lod_far, 0, "{s:?}");
}
