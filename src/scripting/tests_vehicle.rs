//! Vehicle bindings: a script drives a truck and reads telemetry; winch from script.

use avian3d::prelude::*;

use super::tests::errors;
use super::tests_physics::{num, physics_app, steps};
use super::*;
use crate::vehicle::VehicleSpec;

#[test]
fn script_drives_a_truck_and_reads_telemetry() {
    let src = "spd = 0.0; rpm = 0.0; mode = -1;\nfn _ready() { vehicle_set_mode(\"4H\"); }\n\
        fn _physics_process(dt) { vehicle_drive(1.0, 0.0, 0.0); spd = vehicle_get(\"speed\"); rpm = vehicle_get(\"rpm\"); mode = vehicle_get(\"mode\"); }\n\
        fn pull() { r = winch_attach([0, 0, -2.4], [0, 0, 6]); rope_reel(r, 1.0); return r; }\n\
        fn tension(r) { return rope_tension(r); }\n";
    let mut app = physics_app("veh", &[("v.ruspy", src)]);
    app.world_mut().spawn((RigidBody::Static, Collider::cuboid(200.0, 1.0, 200.0), Transform::from_xyz(0.0, -0.5, 0.0)));
    let t = app.world_mut().spawn((Script::new("v.ruspy"), VehicleSpec::truck().bundle(Transform::from_xyz(0.0, 0.8, 0.0)))).id();
    steps(&mut app, 200);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert!(num(&app, t, "spd") > 2.0, "drove forward: {}", num(&app, t, "spd"));
    assert!(num(&app, t, "rpm") > 800.0);
    assert_eq!(num(&app, t, "mode"), 1.0);
    let z0 = app.world().get::<Transform>(t).unwrap().translation.z;
    let r = call(app.world_mut(), t, "pull", &[]).unwrap();
    let rope = match r {
        Value::Entity(b) => Entity::from_bits(b),
        o => panic!("{o:?}"),
    };
    steps(&mut app, 120);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    // At 13 m/s the truck would cover 25 m in that time; the winch holds it near the cable's length.
    let z = app.world().get::<Transform>(t).unwrap().translation.z;
    assert!(z0 - z < 10.0, "the winch held the truck back: {} m", z0 - z);
    let _ = rope;
}
