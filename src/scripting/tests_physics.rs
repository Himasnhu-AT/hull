//! Physics host functions: raycasts, overlaps, bodies, character mover, sensor signals.

use avian3d::prelude::*;

use super::tests::{app, errors};
use super::*;

fn physics_app(tag: &str, files: &[(&str, &str)]) -> App {
    let mut app = app(tag, files);
    app.add_plugins((bevy::asset::AssetPlugin::default(), bevy::transform::TransformPlugin));
    app.init_asset::<Mesh>();
    app.add_plugins(PhysicsPlugins::default());
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(std::time::Duration::from_secs_f64(1.0 / 64.0)));
    app.finish();
    app.cleanup();
    app
}

fn num(app: &App, e: Entity, name: &str) -> f64 {
    match get_member(app.world(), e, name) {
        Some(Value::Num(n)) => n,
        Some(Value::Entity(bits)) => bits as f64,
        other => panic!("{name}: {other:?}"),
    }
}

fn ground(app: &mut App) {
    app.world_mut().spawn((RigidBody::Static, Collider::cuboid(40.0, 1.0, 40.0), Transform::from_xyz(0.0, -0.5, 0.0)));
}

fn steps(app: &mut App, n: usize) {
    for _ in 0..n {
        app.update();
    }
}

#[test]
fn raycast_and_overlap_queries() {
    let src = "d = -1; miss = 0; n = 0; ny = 0; cnt = -1; ent = 0;\n\
        fn go() { h = raycast([0, 5, 0], [0, -5, 0]); d = h[3]; ny = h[2][1]; ent = h[0]; if raycast([0, 5, 0], [0, 5, 3]) == null { miss = 1; } \
        h2 = raycast_dir([0, 5, 0], [0, -1, 0], 2.0); if h2 == null { n = 1; } }\n\
        fn count() { cnt = len(overlap_sphere([0, 0, 0], 1.0)); }\n";
    let mut app = physics_app("pq", &[("q.ruspy", src)]);
    ground(&mut app);
    let crate_e = app.world_mut().spawn((RigidBody::Static, Collider::cuboid(1.0, 1.0, 1.0), Transform::from_xyz(0.0, 0.5, 8.0))).id();
    let e = app.world_mut().spawn((Script::new("q.ruspy"), Transform::from_xyz(20.0, 5.0, 20.0))).id();
    steps(&mut app, 3);
    call(app.world_mut(), e, "go", &[]).unwrap();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert!((num(&app, e, "d") - 5.0).abs() < 1e-3);
    assert!((num(&app, e, "ny") - 1.0).abs() < 1e-3);
    assert_eq!(num(&app, e, "miss"), 1.0);
    assert_eq!(num(&app, e, "n"), 1.0, "max_dist too short");
    assert_ne!(num(&app, e, "ent"), 0.0);
    call(app.world_mut(), e, "count", &[]).unwrap();
    assert_eq!(num(&app, e, "cnt"), 1.0, "only the ground is within 1 m");
    let _ = crate_e;
}

#[test]
fn body_helpers() {
    let src = "x = 0;\nfn go() { set_velocity([1, 2, 3]); set_gravity_scale(0.0); set_collision_layer(4); set_collision_mask(6); apply_impulse([0, 0, 0]); v = get_velocity(); x = v[1]; }\n\
               fn lay() { return get_collision_layer() * 100 + get_collision_mask(); }\n";
    let mut app = physics_app("bodies", &[("b.ruspy", src)]);
    let e = app.world_mut().spawn((Script::new("b.ruspy"), RigidBody::Dynamic, Collider::sphere(0.5), Transform::default())).id();
    steps(&mut app, 2);
    call(app.world_mut(), e, "go", &[]).unwrap();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(num(&app, e, "x"), 2.0);
    assert_eq!(app.world().get::<GravityScale>(e).unwrap().0, 0.0);
    let l = app.world().get::<CollisionLayers>(e).unwrap();
    assert_eq!((l.memberships.0, l.filters.0), (4, 6));
    assert_eq!(call(app.world_mut(), e, "lay", &[]).unwrap(), Value::Num(406.0));
}

#[test]
fn move_and_slide_stops_at_wall_and_lands_on_floor() {
    let src = "vx = 6.0; vy = 0.0;\n\
        fn _physics_process(dt) { v = move_and_slide([vx, vy, 0]); vy = v[1] - 20.0 * dt; }\n\
        fn flags() { return is_on_floor(); }\nfn wallf() { return is_on_wall(); }\nfn nrm() { return get_floor_normal()[1]; }\n";
    let mut app = physics_app("slide", &[("c.ruspy", src)]);
    ground(&mut app);
    // Wall at x = 3.
    app.world_mut().spawn((RigidBody::Static, Collider::cuboid(1.0, 4.0, 10.0), Transform::from_xyz(3.5, 2.0, 0.0)));
    let e = app.world_mut().spawn((Script::new("c.ruspy"), Collider::capsule(0.4, 1.0), Transform::from_xyz(0.0, 2.0, 0.0))).id();
    steps(&mut app, 120);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    let p = app.world().get::<Transform>(e).unwrap().translation;
    assert!(p.x > 1.5 && p.x < 2.7, "stopped at the wall: {p:?}");
    assert!((p.y - 0.9).abs() < 0.08, "standing on the ground: {p:?}");
    assert_eq!(call(app.world_mut(), e, "flags", &[]).unwrap(), Value::Bool(true));
    assert_eq!(call(app.world_mut(), e, "wallf", &[]).unwrap(), Value::Bool(true));
    assert!((match call(app.world_mut(), e, "nrm", &[]).unwrap() { Value::Num(n) => n, o => panic!("{o:?}") } - 1.0).abs() < 1e-3);
}

#[test]
fn sensor_signals_fire_for_scripted_sensor() {
    let src = "hits = 0; left = 0;\nfn body_entered(o) { hits = hits + 1; }\nfn body_exited(o) { left = left + 1; }\n";
    let mut app = physics_app("sensor", &[("s.ruspy", src)]);
    // Static sensor zone at the origin; a kinematic body passes through it.
    let zone = app.world_mut().spawn((Script::new("s.ruspy"), Connections::default().to("body_entered", ".", "body_entered").to("body_exited", ".", "body_exited"), RigidBody::Static, Sensor, Collider::cuboid(2.0, 2.0, 2.0), Transform::default())).id();
    let mover = app.world_mut().spawn((RigidBody::Kinematic, Collider::sphere(0.3), Transform::from_xyz(-5.0, 0.0, 0.0), LinearVelocity(Vec3::new(5.0, 0.0, 0.0)))).id();
    steps(&mut app, 200);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(num(&app, zone, "hits"), 1.0);
    assert_eq!(num(&app, zone, "left"), 1.0);
    let _ = mover;
}
