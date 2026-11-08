use asset_pipe::desc::{AssetDesc, ColliderDesc, DESC_VERSION, ImpostorDesc, LodDesc};

use super::*;

fn desc() -> AssetDesc {
    let lod = |i: usize, d: f32, t: u32| LodDesc { mesh: format!("pine.lod{i}.glb"), distance: d, triangles: t };
    AssetDesc {
        version: DESC_VERSION,
        name: "pine".into(),
        bounds: ([-1.0, 0.0, -1.0], [1.0, 6.0, 1.0]),
        lods: vec![lod(0, 20.0, 1000), lod(1, 50.0, 400), lod(2, 90.0, 150)],
        collider: ColliderDesc::Capsule { center: [0.0, 3.0, 0.0], radius: 0.8, half_height: 2.0 },
        impostor: Some(ImpostorDesc { atlas: "pine.impostor.png".into(), grid: [8, 1], frames: 8, half_width: 1.6, y0: 0.0, y1: 6.0, cutoff: 0.5, max_distance: None }),
        tags: vec![],
        cooked_textures: None,
    }
}

fn app() -> App {
    let mut app = App::new();
    app.add_plugins((MinimalPlugins, AssetPlugin::default(), bevy::world_serialization::WorldSerializationPlugin));
    app.init_asset::<Mesh>().init_asset::<Image>().init_asset::<ImpostorMat>();
    app.insert_resource(SceneryRanges::default()).insert_resource(EffectiveRanges(SceneryRanges::default()));
    app.add_plugins(AssetsPlugin);
    app
}

fn spawn(app: &mut App, d: AssetDesc) -> Entity {
    let h = app.world_mut().resource_mut::<Assets<CookedAsset>>().add(CookedAsset { desc: d, dir: "cooked".into() });
    app.world_mut().spawn((CookedInstance { handle: h }, Transform::default())).id()
}

fn children_named(app: &App, root: Entity) -> Vec<(String, Entity)> {
    let w = app.world();
    w.get::<Children>(root).map(|c| c.iter().map(|e| (w.get::<Name>(e).map(|n| n.to_string()).unwrap_or_default(), e)).collect()).unwrap_or_default()
}

#[test]
fn an_instance_builds_lods_impostor_and_budget_class() {
    let mut app = app();
    let root = spawn(&mut app, desc());
    app.update();
    let w = app.world();
    assert!(w.get::<CookedBuilt>(root).is_some() && w.get::<Scenery>(root).is_some() && w.get::<Actor>(root).is_none());
    let kids = children_named(&app, root);
    assert_eq!(kids.iter().map(|k| k.0.as_str()).collect::<Vec<_>>(), ["lod0", "lod1", "lod2", "impostor"]);
    let w = app.world();
    let lod1 = w.get::<CookedLod>(kids[1].1).unwrap();
    assert_eq!((lod1.window.from, lod1.window.to), (Some(20.0), Some(50.0)));
    let lod0 = w.get::<CookedLod>(kids[0].1).unwrap();
    assert_eq!(lod0.window.from, None);
    // The impostor starts where the last LOD ends and runs to the view distance (170 m, fade 6).
    let imp = w.get::<VisibilityRange>(kids[3].1).unwrap();
    assert_eq!(imp.start_margin, 87.0..93.0);
    assert_eq!(imp.end_margin, 167.0..173.0);
    assert!(w.get::<KeepDetail>(kids[3].1).is_some());
}

#[test]
fn actor_tag_makes_an_actor_and_meshes_under_a_lod_get_its_range() {
    let mut app = app();
    let mut d = desc();
    d.tags = vec!["actor".into()];
    let root = spawn(&mut app, d);
    app.update();
    assert!(app.world().get::<Actor>(root).is_some() && app.world().get::<Scenery>(root).is_none());
    let lod1 = children_named(&app, root)[1].1;
    // A glTF scene spawns its meshes below the LOD root, a level or two down.
    let mid = app.world_mut().spawn(ChildOf(lod1)).id();
    let mesh = app.world_mut().spawn((Mesh3d(Handle::default()), ChildOf(mid))).id();
    let stray = app.world_mut().spawn(Mesh3d(Handle::default())).id();
    app.update();
    let w = app.world();
    let vr = w.get::<VisibilityRange>(mesh).expect("range inherited from the LOD");
    assert_eq!(vr.start_margin, 17.0..23.0);
    assert_eq!(vr.end_margin, 47.0..53.0);
    assert!(w.get::<VisibilityRange>(stray).is_none(), "meshes outside LODs are left alone");
}

#[test]
fn quality_scaling_moves_the_ranges_and_caps_at_the_view_distance() {
    let mut app = app();
    let root = spawn(&mut app, desc());
    app.update();
    let imp = children_named(&app, root)[3].1;
    // Low quality: everything at half distance (view 85 m).
    app.world_mut().resource_mut::<EffectiveRanges>().0 = SceneryRanges::default().scaled(0.5);
    app.update();
    let vr = app.world().get::<VisibilityRange>(imp).unwrap();
    // fade = 6 * 0.5 = 3: starts at 90 * 0.5 = 45, ends at the view distance 85.
    assert_eq!((vr.start_margin.clone(), vr.end_margin.clone()), (43.5..46.5, 83.5..86.5));
    let d = desc();
    let eff = app.world().resource::<EffectiveRanges>().clone();
    assert_eq!(active_part(&d, 5.0, &eff, 0.5), "lod0");
    assert_eq!(active_part(&d, 15.0, &eff, 0.5), "lod1");
    assert_eq!(active_part(&d, 30.0, &eff, 0.5), "lod2");
    assert_eq!(active_part(&d, 60.0, &eff, 0.5), "impostor");
    assert_eq!(active_part(&d, 90.0, &eff, 0.5), "none");
}

#[test]
fn without_an_impostor_the_last_lod_runs_to_the_view_distance() {
    let mut app = app();
    let mut d = desc();
    d.impostor = None;
    let root = spawn(&mut app, d.clone());
    app.update();
    let kids = children_named(&app, root);
    assert_eq!(kids.len(), 3);
    let last = app.world().get::<CookedLod>(kids[2].1).unwrap();
    assert_eq!(last.window.to, None);
    let eff = EffectiveRanges(SceneryRanges::default());
    assert_eq!(active_part(&d, 160.0, &eff, 1.0), "lod2");
    assert_eq!(active_part(&d, 171.0, &eff, 1.0), "none");
}

#[cfg(feature = "physics")]
#[test]
fn the_collider_is_built_from_the_sidecar() {
    use avian3d::prelude::*;
    let mut app = app();
    let capsule = spawn(&mut app, desc());
    let mut d = desc();
    d.collider = ColliderDesc::Convex { points: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] };
    d.tags = vec!["dynamic".into()];
    let convex = spawn(&mut app, d);
    let mut none = desc();
    none.collider = ColliderDesc::None;
    let plain = spawn(&mut app, none);
    app.update();
    let w = app.world();
    assert!(w.get::<Collider>(capsule).is_some() && *w.get::<RigidBody>(capsule).unwrap() == RigidBody::Static);
    assert!(w.get::<Collider>(convex).is_some() && *w.get::<RigidBody>(convex).unwrap() == RigidBody::Dynamic);
    assert!(w.get::<Collider>(plain).is_none());
}
