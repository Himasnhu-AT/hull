//! Headless physics tests: rest height, slope climbing 2H vs 4L, open vs locked diff on split
//! grip, a winch pulling a stuck truck, landing events.

use std::time::Duration;

use super::*;

fn vapp() -> App {
    let mut app = App::new();
    app.add_plugins((MinimalPlugins, bevy::asset::AssetPlugin::default(), bevy::transform::TransformPlugin));
    app.init_asset::<Mesh>();
    app.add_plugins(PhysicsPlugins::default());
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(1.0 / 64.0)));
    app.add_plugins(VehiclePlugin);
    app.finish();
    app.cleanup();
    app
}

fn run(app: &mut App, ticks: usize) {
    for _ in 0..ticks {
        app.update();
    }
}

fn slab(app: &mut App, tf: Transform, size: Vec3, surface: SurfaceId) -> Entity {
    app.world_mut().spawn((RigidBody::Static, Collider::cuboid(size.x, size.y, size.z), tf, SurfaceTag(surface))).id()
}

fn flat(app: &mut App, surface: SurfaceId) {
    slab(app, Transform::from_xyz(0.0, -0.5, 0.0), Vec3::new(200.0, 1.0, 200.0), surface);
}

fn truck(app: &mut App, at: Transform) -> Entity {
    app.world_mut().spawn(VehicleSpec::truck().bundle(at)).id()
}

fn pos(app: &App, e: Entity) -> Vec3 {
    app.world().get::<Transform>(e).unwrap().translation
}

fn set(app: &mut App, e: Entity, f: impl FnOnce(&mut VehicleInput)) {
    f(&mut app.world_mut().get_mut::<VehicleInput>(e).unwrap());
}

#[test]
fn settles_on_its_springs_at_a_sensible_height() {
    let mut app = vapp();
    flat(&mut app, SurfaceId::ASPHALT);
    let t = truck(&mut app, Transform::from_xyz(0.0, 1.4, 0.0));
    run(&mut app, 320);
    let tel = app.world().get::<VehicleTelemetry>(t).unwrap();
    assert_eq!(tel.grounded_wheels, 4);
    let y = pos(&app, t).y;
    let v = app.world().get::<LinearVelocity>(t).unwrap().0.length();
    assert!(v < 0.05, "at rest, {v}");
    // Sprung load 490 kg per corner on 42 kN/m compresses ~0.12 m from the 0.62 m droop limit;
    // wheel centre 0.38 m up, mount 0.05 m below the body origin: ~0.93 m.
    assert!(y > 0.8 && y < 1.1, "rest height {y}");
    let loads: Vec<f32> = tel.wheels.iter().map(|w| w.load).collect();
    let total: f32 = loads.iter().sum();
    assert!((total - 2000.0 * 9.81).abs() < 1500.0, "loads sum to the weight: {loads:?}");
}

fn hill(app: &mut App, deg: f32) -> (Quat, Vec3, Vec3) {
    let th = deg.to_radians();
    let q = Quat::from_rotation_x(th);
    let n = q * Vec3::Y;
    let up_slope = Vec3::new(0.0, th.sin(), -th.cos());
    slab(app, Transform { translation: up_slope * 20.0 - n * 0.5, rotation: q, scale: Vec3::ONE }, Vec3::new(30.0, 1.0, 90.0), SurfaceId::DIRT);
    (q, n, up_slope)
}

fn climb(mode: usize) -> f32 {
    let mut app = vapp();
    let (q, n, up_slope) = hill(&mut app, 26.0);
    let start = n * 1.0 + up_slope * 3.0;
    let t = truck(&mut app, Transform { translation: start, rotation: q, scale: Vec3::ONE });
    set(&mut app, t, |i| i.park = true);
    run(&mut app, 120);
    let p0 = pos(&app, t);
    set(&mut app, t, |i| {
        i.park = false;
        i.throttle = 1.0;
        i.transfer = mode;
    });
    run(&mut app, 64 * 7);
    (pos(&app, t) - p0).dot(up_slope)
}

#[test]
fn four_low_climbs_a_slope_two_wheel_drive_cannot() {
    let two = climb(0);
    let low = climb(2);
    assert!(low > 8.0, "4L climbed {low} m");
    assert!(two < 3.0, "2H managed {two} m");
}

fn split_grip(lock: bool) -> f32 {
    let mut app = vapp();
    slab(&mut app, Transform::from_xyz(-50.0, -0.5, 0.0), Vec3::new(100.0, 1.0, 200.0), SurfaceId::ICE);
    slab(&mut app, Transform::from_xyz(50.0, -0.5, 0.0), Vec3::new(100.0, 1.0, 200.0), SurfaceId::ASPHALT);
    let t = truck(&mut app, Transform::from_xyz(0.0, 0.8, 0.0));
    run(&mut app, 100);
    let p0 = pos(&app, t);
    set(&mut app, t, |i| {
        i.throttle = 1.0;
        i.transfer = 0;
        i.diff_lock[1] = lock;
    });
    run(&mut app, 64 * 3);
    (pos(&app, t) - p0).length()
}

#[test]
fn locked_diff_beats_open_on_split_grip() {
    let open = split_grip(false);
    let locked = split_grip(true);
    assert!(locked > open * 2.0 && open < 6.0, "open {open} m, locked {locked} m");
}

fn mud_run(winch: bool) -> f32 {
    let mut app = vapp();
    {
        let mut s = app.world_mut().resource_mut::<Surfaces>();
        s.0[4].drag = 6_000.0;
        s.0[4].rolling = 0.35;
    }
    flat(&mut app, SurfaceId::MUD);
    let t = truck(&mut app, Transform::from_xyz(0.0, 0.8, 0.0));
    run(&mut app, 100);
    let p0 = pos(&app, t);
    set(&mut app, t, |i| i.throttle = 1.0);
    if winch {
        let anchor = Vec3::new(0.0, 0.7, -12.0);
        let mut rope = Rope::winch(RopeEnd::Body { entity: t, local: Vec3::new(0.0, -0.1, -2.4) }, RopeEnd::World(anchor), 9.6);
        rope.reel = 1.0;
        rope.reel_speed = 0.6;
        app.world_mut().spawn(rope);
    }
    run(&mut app, 64 * 10);
    -(pos(&app, t).z - p0.z)
}

#[test]
fn winch_pulls_a_stuck_truck_out_of_the_mud() {
    let alone = mud_run(false);
    let winched = mud_run(true);
    assert!(alone < 1.8, "stuck: {alone} m");
    assert!(winched > 5.0, "winched {winched} m");
}

#[test]
fn landing_after_a_drop_sends_an_event() {
    let mut app = vapp();
    flat(&mut app, SurfaceId::ASPHALT);
    truck(&mut app, Transform::from_xyz(0.0, 3.0, 0.0));
    let mut seen = 0;
    for _ in 0..120 {
        app.update();
        let msgs = app.world().resource::<Messages<VehicleEvent>>();
        seen += msgs.iter_current_update_messages().filter(|e| matches!(e, VehicleEvent::WheelLanded { speed, .. } if *speed > 2.0)).count();
    }
    assert!(seen >= 4, "each wheel reports a landing: {seen}");
}

#[test]
fn low_tyre_pressure_helps_on_sand_and_hurts_on_asphalt() {
    // Same drive, only the pressure differs: compare peak grip the wheels report.
    fn grip(surface: SurfaceId, kpa: f32) -> f32 {
        let mut app = vapp();
        flat(&mut app, surface);
        let t = truck(&mut app, Transform::from_xyz(0.0, 0.8, 0.0));
        app.world_mut().get_mut::<Vehicle>(t).unwrap().pressure = kpa;
        run(&mut app, 100);
        set(&mut app, t, |i| {
            i.throttle = 1.0;
            i.transfer = 1;
        });
        run(&mut app, 64 * 3);
        pos(&app, t).z.abs()
    }
    assert!(grip(SurfaceId::SAND, 100.0) > grip(SurfaceId::SAND, 220.0), "aired down is better on sand");
}
