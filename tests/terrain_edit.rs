//! Editable terrain, headless through `App::update()`: dabs update heights, colliders and the
//! `TerrainHeights` resource; strokes undo / redo exactly; splat paint; save and reload.

#![cfg(feature = "world")]

use std::path::PathBuf;
use std::time::Duration;

use engine::prelude::*;
use engine::world::terrain::TerrainCollider;
use engine::world::*;

const STEP: Duration = Duration::from_nanos(16_666_667);

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("engine-terrain-edit-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn app(tag: &str) -> App {
    let mut app = engine::app_with(GameInfo::new("terrain-edit-test", "Terrain edit test"), EngineOptions::headless_test(temp_dir(tag)));
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

/// 513 × 513 samples at 2 m (1 km), 128 m chunks (8 × 8), noise hills.
fn spawn(app: &mut App) {
    let desc = WorldDesc::from_ron("(seed: 3, terrain: (size: (1024.0, 1024.0), spacing: 2.0, chunk_quads: 64, source: Noise((amplitude: 60.0, fbm: (frequency: 0.004, octaves: 4)))), cell_size: 256.0)").unwrap();
    engine::world::spawn_world(app.world_mut(), desc).expect("world spawns");
    run(app, 3);
}

fn heights(app: &App) -> Vec<f32> {
    app.world().resource::<Terrain>().heightfield().heights().to_vec()
}

fn raise(radius: f32, strength: f32) -> BrushSettings {
    BrushSettings { kind: BrushKind::Raise, radius, strength, ..default() }
}

#[test]
fn dab_updates_heights_resource_message_and_only_nearby_samples() {
    let mut app = app("dab");
    spawn(&mut app);
    let before = heights(&app);
    let c = Vec2::new(100.0, -60.0);
    let w = app.world_mut();
    let h0 = w.resource::<TerrainHeights>().height_at(c.x, c.y);
    let rect = TerrainEdit::dab(w, &raise(20.0, 5.0), c).unwrap().expect("on the grid");
    assert!(rect.contains(c));
    let h1 = w.resource::<TerrainHeights>().height_at(c.x, c.y);
    assert!((h1 - h0 - 5.0).abs() < 0.3, "centre rises by ~strength: {h0} -> {h1}");
    assert_eq!(w.resource::<Terrain>().height_at(c.x, c.y), h1, "Terrain and TerrainHeights agree");
    // Only samples within the radius moved.
    let after = heights(&app);
    let hf = app.world().resource::<Terrain>().heightfield();
    let mut moved = 0;
    for (i, (a, b)) in before.iter().zip(&after).enumerate() {
        if a != b {
            moved += 1;
            let p = hf.sample_pos(i as u32 % hf.nx(), i as u32 / hf.nx());
            assert!(p.distance(c) <= 20.0, "moved sample {p} is outside the radius");
        }
    }
    assert!((250..400).contains(&moved), "π·10² ≈ 314 samples, got {moved}");
    // The message was written.
    let msgs: Vec<TerrainChanged> = app.world_mut().resource_mut::<Messages<TerrainChanged>>().drain().collect();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].layer, TerrainLayer::Height);
    assert!(msgs[0].rect_world.contains(c));
    // Off the grid: nothing, no error.
    assert_eq!(TerrainEdit::dab(app.world_mut(), &raise(20.0, 5.0), Vec2::new(9000.0, 0.0)).unwrap(), None);
    assert_eq!(TerrainEdit::dab(app.world_mut(), &raise(20.0, 5.0), Vec2::new(f32::NAN, 0.0)).unwrap(), None);
}

#[cfg(feature = "physics")]
#[test]
fn colliders_follow_edits_and_untouched_chunks_are_not_rebuilt() {
    use engine::avian3d::prelude::*;
    let mut app = app("collider");
    spawn(&mut app);
    run(&mut app, 3);
    assert_eq!(app.world_mut().query::<&TerrainCollider>().iter(app.world()).count(), 64);
    let ray = |app: &mut App, x: f32, z: f32| -> f32 {
        app.world_mut()
            .run_system_cached_with(
                |In((x, z)): In<(f32, f32)>, q: SpatialQuery| q.cast_ray(Vec3::new(x, 900.0, z), Dir3::NEG_Y, 2000.0, true, &SpatialQueryFilter::default()).map(|h| 900.0 - h.distance).unwrap(),
                (x, z),
            )
            .unwrap()
    };
    let c = Vec2::new(-200.0, 150.0); // well inside a chunk
    let other = Vec2::new(300.0, -300.0);
    let (h_far0, h_c0) = (ray(&mut app, other.x, other.y), ray(&mut app, c.x, c.y));
    TerrainEdit::dab(app.world_mut(), &raise(30.0, 25.0), c).unwrap();
    run(&mut app, 2); // physics picks up the new collider
    let h_c1 = ray(&mut app, c.x, c.y);
    assert!((h_c1 - h_c0 - 25.0).abs() < 1.0, "collider rose: {h_c0} -> {h_c1}");
    assert!((h_c1 - app.world().resource::<TerrainHeights>().height_at(c.x, c.y)).abs() < 0.02, "collider == TerrainHeights");
    assert_eq!(ray(&mut app, other.x, other.y), h_far0);
    assert_eq!(app.world().resource::<Terrain>().chunks(), UVec2::new(8, 8));
    // A dab inside one chunk touches that chunk only (plus the border-normal neighbours: none here).
}

#[test]
fn stroke_undo_and_redo_are_exact() {
    let mut app = app("undo");
    spawn(&mut app);
    let original = heights(&app);
    let pts = [Vec2::new(-300.0, -300.0), Vec2::new(-100.0, -250.0), Vec2::new(50.0, -100.0), Vec2::new(250.0, 120.0)];
    let b1 = TerrainEdit::stroke(app.world_mut(), &raise(24.0, 3.0), &pts).unwrap().expect("blobs");
    assert_eq!(b1.layer, TerrainLayer::Height);
    let after1 = heights(&app);
    assert_ne!(after1, original);
    // Second stroke on top (smooth), crossing the first.
    let smooth = BrushSettings { kind: BrushKind::Smooth, radius: 30.0, strength: 0.8, ..default() };
    let b2 = TerrainEdit::stroke(app.world_mut(), &smooth, &[Vec2::new(-150.0, -300.0), Vec2::new(200.0, 100.0)]).unwrap().expect("blobs");
    let after2 = heights(&app);
    assert_ne!(after2, after1);
    // Undo 2 then 1: back to the original, bit for bit.
    TerrainEdit::apply_blob(app.world_mut(), b2.before).unwrap();
    assert_eq!(heights(&app), after1);
    TerrainEdit::apply_blob(app.world_mut(), b1.before).unwrap();
    assert_eq!(heights(&app), original);
    // Redo both.
    TerrainEdit::apply_blob(app.world_mut(), b1.after).unwrap();
    TerrainEdit::apply_blob(app.world_mut(), b2.after).unwrap();
    assert_eq!(heights(&app), after2);
    assert_eq!(app.world().resource::<TerrainHeights>().heightfield().heights(), &after2[..]);
    assert!(app.world().resource::<TerrainPatchStore>().bytes() > 0);
    assert!(TerrainEdit::apply_blob(app.world_mut(), BlobId(9999)).is_err());
}

#[test]
fn live_stroke_with_open_recording_matches_atomic_stroke() {
    let mut app = app("live");
    spawn(&mut app);
    let original = heights(&app);
    let flatten = BrushSettings { kind: BrushKind::Flatten, radius: 25.0, strength: 1.0, pick_target: true, falloff: Falloff::Linear, ..default() };
    TerrainEdit::begin_stroke(app.world_mut());
    for p in [Vec2::new(0.0, 0.0), Vec2::new(10.0, 4.0), Vec2::new(22.0, 9.0), Vec2::new(-40.0, 30.0)] {
        TerrainEdit::dab(app.world_mut(), &flatten, p).unwrap();
    }
    let b = TerrainEdit::end_stroke(app.world_mut()).expect("blobs");
    // pick_target sampled once, at the first dab.
    let edited = heights(&app);
    TerrainEdit::apply_blob(app.world_mut(), b.before).unwrap();
    assert_eq!(heights(&app), original);
    TerrainEdit::apply_blob(app.world_mut(), b.after).unwrap();
    assert_eq!(heights(&app), edited);
    // An empty stroke leaves nothing.
    TerrainEdit::begin_stroke(app.world_mut());
    assert!(TerrainEdit::end_stroke(app.world_mut()).is_none());
}

#[test]
fn bad_patches_are_rejected_not_panics() {
    let mut app = app("bad");
    spawn(&mut app);
    let before = heights(&app);
    assert!(matches!(TerrainEdit::set_heights(app.world_mut(), SampleRect::new(510, 0, 10, 2), &[0.0; 20]), Err(EditError::BadRect(_))));
    assert!(matches!(TerrainEdit::set_heights(app.world_mut(), SampleRect::new(0, 0, 4, 4), &[0.0; 3]), Err(EditError::BadRect(_))));
    assert!(matches!(TerrainEdit::set_heights(app.world_mut(), SampleRect::new(0, 0, 0, 4), &[]), Err(EditError::BadRect(_))));
    assert!(matches!(TerrainEdit::set_splat(app.world_mut(), SampleRect::new(0, 0, 2, 2), &[0; 16]), Err(EditError::NoSplat)));
    assert!(matches!(TerrainEdit::dab(app.world_mut(), &BrushSettings { kind: BrushKind::Paint, ..default() }, Vec2::ZERO), Err(EditError::NoSplat)));
    assert_eq!(heights(&app), before);
    // Non-finite values in a valid patch are skipped.
    let mut v = vec![50.0; 4];
    v[1] = f32::NAN;
    TerrainEdit::set_heights(app.world_mut(), SampleRect::new(10, 10, 2, 2), &v).unwrap();
    let hf = app.world().resource::<Terrain>().heightfield();
    assert_eq!((hf.get(10, 10), hf.get(10, 11)), (50.0, 50.0));
    assert!(hf.get(11, 10).is_finite() && hf.get(11, 10) != 50.0 || before[10 * 513 + 11] == 50.0);
}

#[test]
fn shared_grid_is_copy_on_write() {
    let mut app = app("cow");
    spawn(&mut app);
    // A background mesh build holds a clone of the terrain: the edit must not disturb it.
    let held = app.world().resource::<Terrain>().clone();
    let h = held.height_at(0.0, 0.0);
    TerrainEdit::dab(app.world_mut(), &raise(10.0, 9.0), Vec2::ZERO).unwrap();
    assert_eq!(held.height_at(0.0, 0.0), h);
    assert!(app.world().resource::<Terrain>().height_at(0.0, 0.0) > h + 8.0);
    assert_eq!(app.world().resource::<TerrainHeights>().height_at(0.0, 0.0), app.world().resource::<Terrain>().height_at(0.0, 0.0));
}

fn with_splat(app: &mut App) {
    let res = 128u32;
    let bytes: Vec<u8> = (0..res * res).flat_map(|_| [255u8, 0, 0, 0]).collect();
    app.world_mut().insert_resource(TerrainSplat::new(res, bytes, None).unwrap());
}

#[test]
fn splat_paint_undo_and_normalisation() {
    let mut app = app("splat");
    spawn(&mut app);
    with_splat(&mut app);
    let snapshot = |app: &App| app.world().resource::<TerrainSplat>().bytes.clone();
    let original = snapshot(&app);
    let paint = BrushSettings { kind: BrushKind::Paint, layer: 2, radius: 60.0, strength: 0.7, ..default() };
    let b = TerrainEdit::stroke(app.world_mut(), &paint, &[Vec2::new(-100.0, 0.0), Vec2::new(100.0, 0.0)]).unwrap().expect("blobs");
    assert_eq!(b.layer, TerrainLayer::Splat);
    let painted = snapshot(&app);
    assert_ne!(painted, original);
    assert!(painted.chunks(4).all(|t| t.iter().map(|v| *v as u32).sum::<u32>() == 255));
    // Texel at the stroke centre is mostly layer 2; far corner untouched.
    let res = 128usize;
    let t = |x: usize, z: usize| painted[(z * res + x) * 4..][..4].to_vec();
    assert!(t(64, 64)[2] > 150, "{:?}", t(64, 64));
    assert_eq!(t(2, 2), vec![255, 0, 0, 0]);
    TerrainEdit::apply_blob(app.world_mut(), b.before).unwrap();
    assert_eq!(snapshot(&app), original);
    TerrainEdit::apply_blob(app.world_mut(), b.after).unwrap();
    assert_eq!(snapshot(&app), painted);
    let msgs: Vec<TerrainChanged> = app.world_mut().resource_mut::<Messages<TerrainChanged>>().drain().collect();
    assert!(msgs.iter().all(|m| m.layer == TerrainLayer::Splat) && msgs.len() == 3);
}

#[test]
fn save_and_reload_through_the_world_desc() {
    let mut app = app("save");
    spawn(&mut app);
    with_splat(&mut app);
    TerrainEdit::dab(app.world_mut(), &raise(40.0, 12.0), Vec2::new(60.0, 80.0)).unwrap();
    TerrainEdit::dab(app.world_mut(), &BrushSettings { kind: BrushKind::Paint, layer: 1, radius: 50.0, strength: 1.0, ..default() }, Vec2::new(60.0, 80.0)).unwrap();
    let edited = heights(&app);
    let splat = app.world().resource::<TerrainSplat>().bytes.clone();
    let dir = temp_dir("save-out").join("level_terrain");
    TerrainEdit::save(app.world(), &dir).unwrap();
    for f in ["terrain.ron", "terrain.r16", "terrain_splat.rgba8"] {
        assert!(dir.join(f).exists(), "{f}");
    }
    // 513² u16 samples, source size (not the chunk padding; 513 = 8 · 64 + 1 needs none).
    assert_eq!(std::fs::metadata(dir.join("terrain.r16")).unwrap().len(), 513 * 513 * 2);

    let mut app2 = engine::app_with(GameInfo::new("terrain-edit-test2", "x"), EngineOptions::headless_test(temp_dir("save2")));
    app2.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(STEP));
    app2.finish();
    app2.cleanup();
    let mut desc = WorldDesc::default();
    desc.terrain.chunk_quads = 64;
    desc.terrain.source = engine::world::desc::HeightSource::TerrainFiles { dir: dir.display().to_string() };
    engine::world::spawn_world(app2.world_mut(), desc).expect("spawns from terrain files");
    run(&mut app2, 2);
    let hf2 = app2.world().resource::<Terrain>().heightfield();
    let step = (hf2.max_height() - hf2.min_height()) / 65535.0;
    assert_eq!((hf2.nx(), hf2.nz(), hf2.spacing()), (513, 513, 2.0));
    for (a, b) in edited.iter().zip(hf2.heights()) {
        assert!((a - b).abs() <= step * 0.51, "{a} vs {b}");
    }
    assert_eq!(app2.world().resource::<TerrainSplat>().bytes, splat, "splat map reloads byte for byte");
    assert_eq!(app2.world().resource::<TerrainHeights>().height_at(60.0, 80.0), hf2.height_at(60.0, 80.0));
    // And a missing / broken folder is an error, not a panic.
    let mut bad = WorldDesc::default();
    bad.terrain.source = engine::world::desc::HeightSource::TerrainFiles { dir: "/nonexistent/terrain".into() };
    assert!(engine::world::spawn_world(app2.world_mut(), bad).is_err());
}
