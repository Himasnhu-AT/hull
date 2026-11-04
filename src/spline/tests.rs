use std::time::Instant;

use bevy::world_serialization::WorldSerializationPlugin;

use super::*;
use crate::level::{LevelEntity, LevelPlugin, StableId, file::despawn_level, load_level, save_level};

fn p(x: f32, y: f32, z: f32) -> SplinePoint {
    SplinePoint::at(Vec3::new(x, y, z))
}

/// A long winding open spline: `n` points over roughly `len` metres.
fn winding(n: usize, len: f32) -> Spline {
    let step = len / n as f32;
    Spline::new(
        (0..n)
            .map(|i| {
                let x = i as f32 * step * 0.95;
                let z = (i as f32 * 0.37).sin() * step * 0.8 + (i as f32 * 0.05).sin() * 40.0;
                SplinePoint::at(Vec3::new(x, (i as f32 * 0.1).sin() * 5.0, z)).with_width(6.0 + (i % 5) as f32).with_bank((i % 7) as f32 * 0.01)
            })
            .collect(),
    )
}

struct Rng(u64);
impl Rng {
    fn f(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
}

#[test]
fn passes_through_control_points() {
    let s = Spline::from_positions([Vec3::ZERO, Vec3::new(10.0, 0.0, 5.0), Vec3::new(20.0, 3.0, -4.0), Vec3::new(35.0, 0.0, 0.0)]);
    for (i, pt) in s.points.iter().enumerate() {
        assert!(s.pos_at(i as f32).distance(pt.pos) < 1e-3, "point {i}");
    }
    let c = SplineCache::build(&s);
    assert!(c.length() > 35.0 && c.length() < 50.0, "{}", c.length());
}

#[test]
fn straight_line_length_and_samples() {
    let s = Spline::from_positions([Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0), Vec3::new(30.0, 0.0, 0.0)]);
    let c = SplineCache::build(&s);
    assert!((c.length() - 30.0).abs() < 0.05, "{}", c.length());
    let m = c.sample_at(&s, 15.0).unwrap();
    assert!((m.pos.x - 15.0).abs() < 0.1);
    assert!(m.dir.distance(Vec3::X) < 1e-3);
    assert!(m.right.distance(Vec3::Z) < 1e-3);
    assert!(m.up.distance(Vec3::Y) < 1e-3);
    // Clamps at the ends.
    assert!((c.sample_at(&s, -5.0).unwrap().pos.x).abs() < 1e-3);
    assert!((c.sample_at(&s, 99.0).unwrap().pos.x - 30.0).abs() < 1e-3);
    // Every 10 m: 0, 10, 20, 30.
    assert_eq!(c.samples(&s, 10.0).count(), 4);
    // 12 m: 0, 12, 24 and the end.
    assert_eq!(c.samples(&s, 12.0).count(), 4);
}

#[test]
fn attributes_interpolate_and_tags_come_from_segment_start() {
    let mut s = Spline::new(vec![p(0.0, 0.0, 0.0).with_width(4.0).with_bank(0.0).with_tags(1), p(10.0, 0.0, 0.0).with_width(8.0).with_bank(0.4).with_tags(2), p(20.0, 0.0, 0.0).with_tags(3)]).linear();
    let c = SplineCache::build(&s);
    let m = c.sample_at(&s, 5.0).unwrap();
    assert!((m.width - 6.0).abs() < 1e-3 && (m.bank - 0.2).abs() < 1e-3);
    assert_eq!(m.tags, 1);
    assert_eq!(c.sample_at(&s, 15.0).unwrap().tags, 2);
    // Positive bank lowers the right edge: right.y < 0, up leans toward +right (+Z).
    let b = c.sample_at(&s, 10.0).unwrap();
    assert!(b.right.y < -0.3 && b.up.z > 0.3, "{b:?}");
    s.mode = SplineMode::Catmull;
    assert!(SplineCache::build(&s).length() >= 19.9);
}

#[test]
fn closed_wraps() {
    let s = Spline::from_positions([Vec3::new(10.0, 0.0, 0.0), Vec3::new(0.0, 0.0, 10.0), Vec3::new(-10.0, 0.0, 0.0), Vec3::new(0.0, 0.0, -10.0)]).closed();
    let c = SplineCache::build(&s);
    let len = c.length();
    assert!(len > 55.0 && len < 70.0, "{len}");
    assert!(c.sample_at(&s, 0.0).unwrap().pos.distance(c.sample_at(&s, len).unwrap().pos) < 1e-2);
    assert!(c.sample_at(&s, 3.0).unwrap().pos.distance(c.sample_at(&s, 3.0 + len).unwrap().pos) < 1e-2);
    // The closing segment is smooth: direction is continuous across the seam.
    let a = c.sample_at(&s, len - 0.05).unwrap().dir;
    let b = c.sample_at(&s, 0.05).unwrap().dir;
    assert!(a.dot(b) > 0.99, "{a} {b}");
    // No duplicate of the start at the end of the iterator.
    let n = c.samples(&s, 5.0).count();
    assert_eq!(n, (len / 5.0).ceil() as usize);
}

#[test]
fn degenerate_splines_do_not_panic() {
    let empty = Spline::default();
    let c = SplineCache::build(&empty);
    assert!(c.sample_at(&empty, 1.0).is_none() && c.nearest(&empty, Vec3::ONE).is_none());
    assert_eq!(c.samples(&empty, 1.0).count(), 0);
    let one = Spline::from_positions([Vec3::new(1.0, 2.0, 3.0)]);
    let c = SplineCache::build(&one);
    assert_eq!(c.sample_at(&one, 5.0).unwrap().pos, Vec3::new(1.0, 2.0, 3.0));
    assert_eq!(c.nearest(&one, Vec3::ZERO).unwrap().0, 0.0);
    let same = Spline::from_positions([Vec3::ONE, Vec3::ONE, Vec3::ONE]).closed();
    let c = SplineCache::build(&same);
    let m = c.sample_at(&same, 1.0).unwrap();
    assert!(m.pos.is_finite() && m.dir.is_finite());
    assert!(c.nearest(&same, Vec3::ZERO).unwrap().1.pos.is_finite());
    let nan = Spline::from_positions([Vec3::ZERO, Vec3::X]);
    let c = SplineCache::build(&nan);
    assert!(c.sample_at(&nan, f32::NAN).unwrap().pos.is_finite());
    assert!(c.samples(&nan, f32::NAN).count() > 0 && c.samples(&nan, 0.0).count() > 0);
    // A stale cache with a shorter spline never panics.
    let long = winding(50, 500.0);
    let c = SplineCache::build(&long);
    let short = Spline::from_positions([Vec3::ZERO, Vec3::X]);
    assert!(c.sample_at(&short, 300.0).is_some() && c.nearest(&short, Vec3::ONE).is_some());
}

#[test]
fn nearest_matches_brute_force() {
    for s in [winding(200, 1000.0), winding(40, 400.0).closed()] {
        let c = SplineCache::build(&s);
        let mut rng = Rng(7);
        let (lo, hi) = (c.polyline().iter().fold(Vec3::MAX, |a, &b| a.min(b)), c.polyline().iter().fold(Vec3::MIN, |a, &b| a.max(b)));
        for _ in 0..300 {
            // Queries inside, around and far outside the bounds.
            let q = lo - Vec3::splat(300.0) + (hi - lo + Vec3::splat(600.0)) * Vec3::new(rng.f(), rng.f(), rng.f());
            let (_, sample, dist) = c.nearest(&s, q).unwrap();
            let brute = c.polyline().windows(2).map(|w| super::cache::tests_closest(w[0], w[1], q)).fold(f32::MAX, f32::min).sqrt();
            assert!((dist - brute).abs() < 0.05, "grid {dist} brute {brute} at {q}");
            assert!(sample.pos.distance(q) - dist < 1e-3);
        }
        // A point on the curve is found at its own distance.
        let along = c.length() * 0.37;
        let on = c.sample_at(&s, along).unwrap().pos;
        let (d, _, dist) = c.nearest(&s, on).unwrap();
        assert!(dist < 0.05 && (d - along).abs() < 0.5, "{d} vs {along}, dist {dist}");
    }
}

#[test]
fn edit_helpers() {
    let mut s = Spline::new(vec![p(0.0, 0.0, 0.0).with_width(4.0).with_tags(1), p(10.0, 0.0, 0.0).with_width(8.0).with_tags(2), p(20.0, 0.0, 0.0).with_width(6.0).with_tags(3)]);
    let i = s.insert_point(0, Vec3::new(5.0, 0.0, 1.0));
    assert_eq!(i, 1);
    assert_eq!((s.points[1].width, s.points[1].tags), (6.0, 1));
    assert_eq!(s.insert_point(99, Vec3::new(30.0, 0.0, 0.0)), 4);
    s.remove_point(4).unwrap();
    assert!(s.remove_point(9).is_none());

    // Reverse: positions flip, bank negates, segment tags follow their segments.
    let mut r = s.clone();
    r.points[0].bank = 0.3;
    r.reverse();
    assert_eq!(r.points[0].pos, s.points[3].pos);
    assert_eq!(r.points[3].bank, -0.3);
    // Old segment 2->3 (tags 2) is now the first segment.
    assert_eq!(r.points[0].tags, s.points[2].tags);
    r.reverse();
    assert_eq!(r.points[1].pos, s.points[1].pos);
    assert_eq!(r.points.iter().map(|p| p.tags).collect::<Vec<_>>()[..3], s.points.iter().map(|p| p.tags).collect::<Vec<_>>()[..3]);

    // Split.
    let mut head = s.clone();
    let tail = head.split(2).unwrap();
    assert_eq!((head.points.len(), tail.points.len()), (3, 2));
    assert_eq!(head.points[2].pos, tail.points[0].pos);
    assert!(head.clone().split(0).is_none() && head.clone().split(2).is_none());
    // Splitting a loop opens it at the point.
    let mut l = Spline::from_positions([Vec3::ZERO, Vec3::X, Vec3::Z, Vec3::Y]).closed();
    assert!(l.split(2).is_none());
    assert!(!l.closed && l.points.len() == 5 && l.points[0].pos == Vec3::Z && l.points[4].pos == Vec3::Z);
}

#[test]
fn ribbon_follows_width_and_bank() {
    let s = Spline::new(vec![p(0.0, 0.0, 0.0).with_width(4.0), p(40.0, 0.0, 0.0).with_width(10.0).with_bank(0.3)]);
    let m = ribbon_mesh(&s, 2.0, 8.0);
    let pos = m.attribute(Mesh::ATTRIBUTE_POSITION).unwrap().as_float3().unwrap();
    assert_eq!(pos.len(), (20 + 1) * 2);
    // Start width 4, end width 10.
    assert!(((Vec3::from(pos[0]) - Vec3::from(pos[1])).length() - 4.0).abs() < 0.01);
    let n = pos.len();
    assert!(((Vec3::from(pos[n - 2]) - Vec3::from(pos[n - 1])).length() - 10.0).abs() < 0.01);
    // Banked end: right edge lower than the left.
    assert!(pos[n - 1][1] < pos[n - 2][1]);
    let nrm = m.attribute(Mesh::ATTRIBUTE_NORMAL).unwrap().as_float3().unwrap();
    assert!(nrm.iter().all(|n| n[1] > 0.9));
    // Triangles face up.
    let idx: Vec<u32> = m.indices().unwrap().iter().map(|i| i as u32).collect();
    for t in idx.chunks(3) {
        let (a, b, c) = (Vec3::from(pos[t[0] as usize]), Vec3::from(pos[t[1] as usize]), Vec3::from(pos[t[2] as usize]));
        assert!((b - a).cross(c - a).y > 0.0);
    }
    assert_eq!(ribbon_mesh(&Spline::default(), 1.0, 1.0).count_vertices(), 0);
}

fn app() -> App {
    let mut app = App::new();
    app.add_plugins((MinimalPlugins, AssetPlugin::default(), WorldSerializationPlugin))
        .init_asset::<Mesh>()
        .init_asset::<StandardMaterial>()
        .register_type::<Name>()
        .register_type::<Transform>()
        .register_type::<Visibility>()
        .register_type::<ChildOf>()
        .add_plugins((LevelPlugin, SplinePlugin));
    app.finish();
    app.cleanup();
    app
}

#[test]
fn change_sends_message_and_rebuilds_cache() {
    let mut app = app();
    let e = app.world_mut().spawn(Spline::from_positions([Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0)])).id();
    let seen = |app: &mut App| app.world_mut().resource_mut::<Messages<SplineChanged>>().drain().filter(|m| m.entity == e).count();
    app.update();
    assert_eq!(seen(&mut app), 1);
    assert!((app.world().get::<SplineCache>(e).unwrap().length() - 10.0).abs() < 0.05);
    // Nothing changed: nothing sent.
    app.update();
    assert_eq!(seen(&mut app), 0);
    app.world_mut().get_mut::<Spline>(e).unwrap().points[1].pos.x = 30.0;
    app.update();
    assert_eq!(seen(&mut app), 1);
    assert!((app.world().get::<SplineCache>(e).unwrap().length() - 30.0).abs() < 0.05);
}

#[test]
fn road_child_is_built_and_updated() {
    let mut app = app();
    let e = app.world_mut().spawn((Spline::from_positions([Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0)]), SplineRoad::default())).id();
    app.update();
    app.update();
    let link = app.world().get::<SplineRoadMesh>(e).expect("road child").clone();
    let verts = |app: &App| app.world().resource::<Assets<Mesh>>().get(&link.mesh).unwrap().count_vertices();
    let before = verts(&app);
    app.world_mut().get_mut::<Spline>(e).unwrap().points[1].pos.x = 50.0;
    app.update();
    assert!(verts(&app) > before);
    app.world_mut().entity_mut(e).remove::<SplineRoad>();
    app.update();
    app.update();
    assert!(app.world().get_entity(link.child).is_err());
}

#[test]
fn level_round_trip_two_splines() {
    let dir = std::env::temp_dir().join(format!("engine-spline-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("roads.level.ron");
    let mut app = app();
    let a = Spline::new(vec![p(0.0, 0.0, 0.0).with_width(6.5).with_tags(0b101), p(40.0, 1.0, 10.0).with_bank(0.2).with_data("gravel; ford"), p(90.0, 2.0, -5.0).with_tags(7)]);
    let b = Spline { points: vec![p(0.0, 0.0, 0.0), p(20.0, 0.0, 0.0), p(20.0, 0.0, 20.0), p(0.0, 0.0, 20.0)], closed: true, mode: SplineMode::Linear };
    app.world_mut().spawn((LevelEntity { id: StableId(1) }, Name::new("a"), a.clone()));
    app.world_mut().spawn((LevelEntity { id: StableId(2) }, Name::new("b"), b.clone(), SplineRoad::default()));
    app.update();
    save_level(app.world_mut(), &path).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains("SplineCache"), "cache must not be saved");
    despawn_level(app.world_mut());
    app.update();
    assert_eq!(app.world_mut().query::<&Spline>().iter(app.world()).count(), 0);
    load_level(app.world_mut(), &path).unwrap();
    app.update();
    app.update();
    let mut got: Vec<(u64, Spline)> = app.world_mut().query::<(&LevelEntity, &Spline)>().iter(app.world()).map(|(l, s)| (l.id.0, s.clone())).collect();
    got.sort_by_key(|g| g.0);
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].1, a);
    assert_eq!(got[1].1, b);
    // Caches were rebuilt for the loaded splines.
    let n = app.world_mut().query::<&SplineCache>().iter(app.world()).filter(|c| c.length() > 1.0).count();
    assert_eq!(n, 2);
    let _ = std::fs::remove_dir_all(&dir);
}

/// `cargo test --lib spline::tests::perf -- --ignored --nocapture` (set CARGO_PROFILE_DEV_OPT_LEVEL=3
/// for release-like numbers).
#[test]
#[ignore]
fn perf() {
    let s = winding(1000, 5000.0);
    let t = Instant::now();
    let c = SplineCache::build(&s);
    let build_ms = t.elapsed().as_secs_f64() * 1e3;
    let mut rng = Rng(42);
    let (lo, hi) = (c.polyline().iter().fold(Vec3::MAX, |a, &b| a.min(b)), c.polyline().iter().fold(Vec3::MIN, |a, &b| a.max(b)));
    let qs: Vec<Vec3> = (0..20_000)
        .map(|_| {
            let on = c.sample_at(&s, rng.f() * c.length()).unwrap().pos;
            on + Vec3::new(rng.f() - 0.5, 0.0, rng.f() - 0.5) * 60.0
        })
        .collect();
    let _ = (lo, hi);
    let t = Instant::now();
    let mut acc = 0.0;
    for q in &qs {
        acc += c.nearest(&s, *q).unwrap().2;
    }
    let near_us = t.elapsed().as_secs_f64() * 1e6 / qs.len() as f64;
    let t = Instant::now();
    for q in &qs {
        acc += c.sample_at(&s, q.x.abs() % c.length()).unwrap().width;
    }
    let sample_us = t.elapsed().as_secs_f64() * 1e6 / qs.len() as f64;
    println!("1000 points, {:.0} m, {} polyline vertices: build {build_ms:.2} ms, nearest {near_us:.3} us, sample_at {sample_us:.3} us ({acc})", c.length(), c.polyline().len());
}
