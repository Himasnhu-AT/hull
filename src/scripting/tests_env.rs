//! Photo, weather, day-clock and camera-rig bindings, headless.

use super::tests::{app, errors};
use super::*;
use crate::camera_rigs::{CameraRig, RigMode};
use crate::daytime::DayClock;
use crate::photo::{PhotoCamera, PhotoCapture, PhotoFailed, PhotoMetadata, PhotoRequest, PhotoTaken};
use crate::weather::{Weather, WeatherLibrary, Wetness, Wind};

fn get_num(app: &App, e: Entity, name: &str) -> f64 {
    match get_member(app.world(), e, name) {
        Some(Value::Num(n)) => n,
        other => panic!("{name}: {other:?}"),
    }
}

#[test]
fn photo_lens_focus_take_and_signals() {
    let src = "got = -1.0; fl = 0.0; foc = 0.0; fail = 0.0;\n\
        fn _ready() { photo_set_lens(85, 2.8, 0.004, 400); photo_set_focus(12.5); fl = photo_get_lens().focal_mm; foc = photo_get_focus(); }\n\
        fn go() { return photo_take(); }\n\
        fn on_taken(id, path) { got = id; }\n\
        fn on_failed(r) { fail = 1.0; }\n";
    let mut app = app("photo", &[("p.ruspy", src)]);
    app.init_resource::<PhotoCapture>().add_message::<PhotoRequest>().add_message::<PhotoTaken>().add_message::<PhotoFailed>();
    let cam = app
        .world_mut()
        .spawn((
            PhotoCamera::default(),
            Script::new("p.ruspy"),
            Connections::default().to("photo_taken", ".", "on_taken").to("photo_failed", ".", "on_failed"),
        ))
        .id();
    app.update();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    let c = app.world().get::<PhotoCamera>(cam).unwrap();
    assert_eq!((c.focal_mm, c.aperture, c.shutter_s, c.iso, c.focus_m, c.autofocus), (85.0, 2.8, 0.004, 400.0, 12.5, false));
    assert_eq!(get_num(&app, cam, "fl"), 85.0);
    assert_eq!(get_num(&app, cam, "foc"), 12.5);
    assert_eq!(call(app.world_mut(), cam, "go", &[]).unwrap(), Value::Bool(true));
    assert_eq!(app.world().resource::<Messages<PhotoRequest>>().len(), 1);
    let meta = PhotoMetadata {
        id: 7,
        time_secs: 1.0,
        position: [1.0, 2.0, 3.0],
        rotation: [0.0, 0.0, 0.0, 1.0],
        lens: crate::photo::LensSnapshot { focal_mm: 85.0, aperture: 2.8, shutter_s: 0.004, iso: 400.0, focus_m: 12.5, fov_deg: 24.0, ev100: 10.0, dof_near_m: 12.0, dof_far_m: None },
        resolution: [64, 64],
        subjects: vec![],
        extra: Default::default(),
    };
    app.world_mut().resource_mut::<PhotoCapture>().last = Some((meta.clone(), None));
    app.world_mut().write_message(PhotoTaken { image: std::sync::Arc::new(Image::default()), metadata: meta, path: None, save_error: None });
    app.world_mut().write_message(PhotoFailed { reason: "x".into() });
    app.update();
    assert_eq!(get_num(&app, cam, "got"), 7.0);
    assert_eq!(get_num(&app, cam, "fail"), 1.0);
    let src2 = call(app.world_mut(), cam, "go", &[]);
    assert!(src2.is_ok());
}

#[test]
fn photo_last_is_a_dict() {
    let src = "fn last() { return photo_last(); }\nfn id() { return photo_last().id; }\nfn n() { return photo_last().lens.focal_mm; }\n";
    let mut app = app("photo2", &[("p.ruspy", src)]);
    app.init_resource::<PhotoCapture>().add_message::<PhotoRequest>();
    let e = app.world_mut().spawn((Script::new("p.ruspy"), PhotoCamera::default())).id();
    app.update();
    assert_eq!(call(app.world_mut(), e, "last", &[]).unwrap(), Value::Null);
    let meta = PhotoMetadata {
        id: 3,
        time_secs: 0.0,
        position: [0.0; 3],
        rotation: [0.0, 0.0, 0.0, 1.0],
        lens: crate::photo::LensSnapshot { focal_mm: 50.0, aperture: 4.0, shutter_s: 0.01, iso: 100.0, focus_m: 5.0, fov_deg: 40.0, ev100: 12.0, dof_near_m: 4.0, dof_far_m: Some(6.0) },
        resolution: [8, 8],
        subjects: vec![],
        extra: Default::default(),
    };
    app.world_mut().resource_mut::<PhotoCapture>().last = Some((meta, None));
    assert_eq!(call(app.world_mut(), e, "id", &[]).unwrap(), Value::Num(3.0));
    assert_eq!(call(app.world_mut(), e, "n", &[]).unwrap(), Value::Num(50.0));
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
fn weather_force_release_wetness_wind() {
    let src = "fn force(n) { return weather_force(n, 0.0); }\nfn rel() { weather_release(0.0); }\nfn name() { return weather_get().name; }\n\
        fn forced() { return weather_get().forced; }\nfn wet() { return weather_wetness(); }\nfn wetp() { return weather_wetness([1, 0, 1]); }\n\
        fn wind() { return weather_wind(); }\nfn t() { weather_set_time(50); }\n";
    let mut app = app("weather", &[("w.ruspy", src)]);
    app.init_resource::<Weather>().init_resource::<crate::weather::WeatherConfig>().init_resource::<Wetness>().init_resource::<Wind>().insert_resource(WeatherLibrary::presets());
    app.world_mut().resource_mut::<Wetness>().0 = 0.4;
    app.world_mut().insert_resource(Wind { dir: Vec3::X, speed: 3.0 });
    let e = app.world_mut().spawn(Script::new("w.ruspy")).id();
    app.update();
    let unknown = call(app.world_mut(), e, "force", &[Value::text("nope")]).unwrap();
    assert_eq!(unknown, Value::Bool(false));
    let first = app.world().resource::<WeatherLibrary>().defs.iter().find(|d| d.name != "clear").unwrap().name.clone();
    assert_eq!(call(app.world_mut(), e, "force", &[Value::text(&first)]).unwrap(), Value::Bool(true));
    assert_eq!(call(app.world_mut(), e, "forced", &[]).unwrap(), Value::Bool(true));
    assert_eq!(call(app.world_mut(), e, "name", &[]).unwrap(), Value::text(&first));
    call(app.world_mut(), e, "rel", &[]).unwrap();
    call(app.world_mut(), e, "t", &[]).unwrap();
    assert_eq!(app.world().resource::<Weather>().time, 50.0);
    assert!((call_num(&mut app, e, "wet") - 0.4).abs() < 1e-6);
    assert!((call_num(&mut app, e, "wetp") - 0.4).abs() < 1e-6);
    assert_eq!(call(app.world_mut(), e, "wind", &[]).unwrap(), Value::Vec3([3.0, 0.0, 0.0]));
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

fn call_num(app: &mut App, e: Entity, f: &str) -> f64 {
    match call(app.world_mut(), e, f, &[]).unwrap() {
        Value::Num(n) => n,
        o => panic!("{o:?}"),
    }
}

#[test]
fn daytime_clock_from_script() {
    let src = "fn set(h) { daytime_set_time(h); }\nfn el() { return daytime_sun_elevation(); }\nfn night() { return daytime_is_night(); }\n\
        fn spd(x) { daytime_set_speed(x); return daytime_get_speed(); }\nfn hr() { return daytime_get_time(); }\n";
    let mut app = app("day", &[("d.ruspy", src)]);
    app.insert_resource(DayClock::default());
    let e = app.world_mut().spawn(Script::new("d.ruspy")).id();
    app.update();
    call(app.world_mut(), e, "set", &[Value::Num(12.0)]).unwrap();
    assert!(call_num(&mut app, e, "el") > 30.0);
    assert_eq!(call(app.world_mut(), e, "night", &[]).unwrap(), Value::Bool(false));
    call(app.world_mut(), e, "set", &[Value::Num(1.0)]).unwrap();
    assert!(call_num(&mut app, e, "el") < 0.0);
    assert_eq!(call(app.world_mut(), e, "night", &[]).unwrap(), Value::Bool(true));
    assert_eq!(call(app.world_mut(), e, "spd", &[Value::Num(600.0)]).unwrap(), Value::Num(600.0));
    assert_eq!(call(app.world_mut(), e, "spd", &[Value::Num(0.0)]).unwrap(), Value::Num(0.0));
    assert!(!app.world().resource::<DayClock>().running);
    assert_eq!(call_num(&mut app, e, "hr"), 1.0);
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
}

#[test]
fn camera_rig_mode_target_and_chase() {
    let src = "fn mode(m) { camera_rig_set_mode(m); return camera_rig_get_mode(); }\nfn tgt(n) { camera_rig_set_target(n); }\nfn clear() { camera_rig_set_target(null); }\n\
        fn arm(l, h) { camera_rig_set_chase(l, h); }\n";
    let mut app = app("rig", &[("r.ruspy", src)]);
    let target = app.world_mut().spawn_empty().id();
    let e = app.world_mut().spawn((Script::new("r.ruspy"), CameraRig::orbit(target))).id();
    app.update();
    assert!(call(app.world_mut(), e, "arm", &[Value::Num(8.0), Value::Num(3.0)]).is_err(), "orbit mode has no chase arm");
    assert_eq!(call(app.world_mut(), e, "mode", &[Value::text("chase")]).unwrap(), Value::text("chase"));
    call(app.world_mut(), e, "arm", &[Value::Num(8.0), Value::Num(3.0)]).unwrap();
    match &app.world().get::<CameraRig>(e).unwrap().mode {
        RigMode::Chase(c) => assert_eq!((c.boom, c.height), (8.0, 3.0)),
        m => panic!("{m:?}"),
    }
    assert!(call(app.world_mut(), e, "mode", &[Value::text("sideways")]).is_err());
    call(app.world_mut(), e, "clear", &[]).unwrap();
    assert_eq!(app.world().get::<CameraRig>(e).unwrap().target, None);
    call(app.world_mut(), e, "tgt", &[Value::Entity(target.to_bits())]).unwrap();
    assert_eq!(app.world().get::<CameraRig>(e).unwrap().target, Some(target));
}
