//! `look` driven headless with `App::update()`: camera components per look / tier, blends,
//! timelines, feature toggles over the control commands, gfx quality fields.

use std::path::PathBuf;
use std::time::Duration;

use bevy::camera::Exposure;
use bevy::core_pipeline::prepass::DepthPrepass;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::light::{GlobalAmbientLight, ShadowFilteringMethod, VolumetricFog, VolumetricLight};
use bevy::pbr::{AtmosphereSettings, ContactShadows, DistanceFog, ScreenSpaceAmbientOcclusion, ScreenSpaceReflections};
use bevy::post_process::dof::DepthOfField;
use bevy::post_process::effect_stack::Vignette;
use engine::gfx::{GamePrepasses, Sun};
use engine::look::apply::LookFogVolume;
use engine::look::{LookState, LookSun};
use engine::prelude::*;
use serde_json::{Value, json};

const STEP: Duration = Duration::from_nanos(16_666_667);

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("engine-look-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn build(tag: &str) -> (App, Entity) {
    let mut app = engine::app_with(GameInfo::new("engine-look-test", "Look"), EngineOptions::headless_test(temp_dir(tag)));
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(STEP));
    app.finish();
    app.cleanup();
    let cam = app.world_mut().spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 2.0, 5.0))).id();
    run(&mut app, 2);
    (app, cam)
}

fn run(app: &mut App, frames: usize) {
    for _ in 0..frames {
        app.update();
    }
}

fn applies(app: &App) -> u64 {
    app.world().resource::<LookState>().applies
}

fn has<T: Component>(app: &App, e: Entity) -> bool {
    app.world().entity(e).contains::<T>()
}

fn set_quality(app: &mut App, q: engine::settings::GraphicsQuality) {
    app.world_mut().resource_mut::<engine::settings::CoreSettings>().quality = q;
}

/// Calls a registered control command directly (the port isn't running in tests).
fn cmd(app: &mut App, id: &str, params: Value) -> Result<Value, String> {
    let handler = app.world().resource::<engine::devtools::ControlRegistry>().get(id).unwrap_or_else(|| panic!("no command {id}")).handler;
    match handler {
        engine::devtools::control::Handler::Instant(f) => f(app.world_mut(), params),
        engine::devtools::control::Handler::Deferred(_) => panic!("{id} is deferred"),
    }
}

#[test]
fn no_look_means_no_work() {
    let (mut app, cam) = build("none");
    run(&mut app, 10);
    assert_eq!(applies(&app), 0);
    assert!(!has::<DistanceFog>(&app, cam) && !has::<Exposure>(&app, cam));
    let mut suns = app.world_mut().query_filtered::<(), With<Sun>>();
    assert_eq!(suns.iter(app.world()).count(), 0);
}

#[test]
fn preset_applies_to_camera_sun_and_ambient() {
    let (mut app, cam) = build("preset");
    app.insert_resource(Look::dusk());
    run(&mut app, 2);
    let w = app.world();
    assert_eq!(w.get::<Exposure>(cam).unwrap().ev100, 11.0);
    assert_eq!(*w.get::<Tonemapping>(cam).unwrap(), Tonemapping::AgX);
    assert!(w.get::<DistanceFog>(cam).is_some());
    assert!(w.get::<AtmosphereSettings>(cam).is_some(), "dusk uses the atmosphere sky");
    assert!(w.get::<Vignette>(cam).is_some(), "dusk has a vignette; High allows post fx");
    assert!(w.get::<VolumetricFog>(cam).is_none());
    let amb = w.resource::<GlobalAmbientLight>();
    assert_eq!(amb.brightness, 400.0);

    let mut q = app.world_mut().query_filtered::<(&DirectionalLight, &Transform), (With<Sun>, With<LookSun>)>();
    let (light, tf) = q.single(app.world()).expect("look spawned a sun");
    assert_eq!(light.illuminance, 25_000.0);
    assert!(light.shadow_maps_enabled);
    let fwd = tf.forward();
    assert!(fwd.y < -0.05 && fwd.y > -0.2, "low dusk sun: {fwd}");

    // Unchanged → no more applies.
    let n = applies(&app);
    run(&mut app, 20);
    assert_eq!(applies(&app), n, "apply runs only on change");

    // Swap at runtime: overcast uses a gradient sky (no atmosphere) and exponential fog.
    app.insert_resource(Look::overcast());
    run(&mut app, 1);
    assert!(!has::<Vignette>(&app, cam));
    assert_eq!(app.world().get::<Exposure>(cam).unwrap().ev100, 12.0);
}

#[test]
fn quality_tier_gates_costly_features() {
    let (mut app, cam) = build("tier");
    let mut look = Look::indoor();
    look.lens.dof.enabled = true;
    look.lens.film_grain = 0.05;
    look.exposure.auto = true;
    app.insert_resource(look);
    run(&mut app, 2);
    assert!(has::<VolumetricFog>(&app, cam), "High: volumetric on");
    assert!(has::<DepthOfField>(&app, cam), "High: camera fx on");
    assert!(has::<engine::look::FilmGrain>(&app, cam), "High: post fx on");
    let mut vol = app.world_mut().query_filtered::<(), With<LookFogVolume>>();
    assert_eq!(vol.iter(app.world()).count(), 1);
    let mut shafts = app.world_mut().query_filtered::<(), (With<Sun>, With<VolumetricLight>)>();
    assert_eq!(shafts.iter(app.world()).count(), 1);

    set_quality(&mut app, engine::settings::GraphicsQuality::Low);
    run(&mut app, 2);
    assert!(!has::<VolumetricFog>(&app, cam), "Low: no volumetric");
    assert!(!has::<DepthOfField>(&app, cam), "Low: no DOF");
    assert!(!has::<engine::look::FilmGrain>(&app, cam), "Low: no film grain");
    assert!(!has::<bevy::post_process::auto_exposure::AutoExposure>(&app, cam), "Low: manual exposure");
    let mut vol = app.world_mut().query_filtered::<(), With<LookFogVolume>>();
    assert_eq!(vol.iter(app.world()).count(), 0, "fog volume despawned");
    // Cheap things stay.
    assert!(has::<Exposure>(&app, cam) && has::<Tonemapping>(&app, cam));
}

#[test]
fn transition_blends_then_lands() {
    let (mut app, cam) = build("blend");
    app.insert_resource(Look::clear_day());
    run(&mut app, 1);
    let day = Look::clear_day().exposure.ev100;
    let night = Look::night().exposure.ev100;
    app.insert_resource(LookTransition::new(Look::clear_day(), Look::night(), 1.0));
    run(&mut app, 30);
    let mid = app.world().get::<Exposure>(cam).unwrap().ev100;
    assert!(mid < day && mid > night, "mid-blend exposure {mid}");
    run(&mut app, 40);
    assert!(!app.world().contains_resource::<LookTransition>());
    assert_eq!(app.world().resource::<Look>().name, "night");
    assert_eq!(app.world().get::<Exposure>(cam).unwrap().ev100, night);
}

#[test]
fn timeline_drives_the_look() {
    let (mut app, cam) = build("timeline");
    app.insert_resource(LookTimeline { time: 11.0, ..LookTimeline::day_cycle(60.0) });
    run(&mut app, 1);
    let a = app.world().get::<Exposure>(cam).unwrap().ev100;
    let t0 = app.world().resource::<LookTimeline>().time;
    run(&mut app, 30); // +0.5 s × 60 = +30 clock units, wrapping at 24
    let tl = app.world().resource::<LookTimeline>();
    assert!(((tl.time - t0).rem_euclid(24.0) - 6.0).abs() < 0.01, "clock {t0} → {}", tl.time);
    let b = app.world().get::<Exposure>(cam).unwrap().ev100;
    assert!(b < a, "afternoon darker than noon: {a} → {b}");
}

#[test]
fn control_commands_set_get_and_toggle() {
    let (mut app, cam) = build("control");
    let r = cmd(&mut app, "look.set", json!({"preset": "dusk", "fields": {"fog": {"visibility": 123.0}, "exposure": {"ev100": 9.5}}})).unwrap();
    assert_eq!(r["look"], "dusk");
    run(&mut app, 1);
    assert_eq!(app.world().resource::<Look>().fog.visibility, 123.0);
    assert_eq!(app.world().get::<Exposure>(cam).unwrap().ev100, 9.5);
    assert!(cmd(&mut app, "look.set", json!({"preset": "mars"})).is_err());
    assert!(cmd(&mut app, "look.set", json!({"fields": {"fog": {"visibilty": 1.0}}})).is_err(), "typos rejected");

    let g = cmd(&mut app, "look.get", json!({})).unwrap();
    assert_eq!(g["look"]["exposure"]["ev100"], 9.5);
    assert_eq!(g["features"]["volumetric"]["active"], false);
    assert!(g["camera"].as_array().unwrap().iter().any(|c| c == "DistanceFog"));

    cmd(&mut app, "look.feature", json!({"name": "volumetric", "on": true})).unwrap();
    run(&mut app, 1);
    assert!(has::<VolumetricFog>(&app, cam));
    cmd(&mut app, "look.feature", json!({"name": "fog", "on": false})).unwrap();
    run(&mut app, 1);
    assert!(!has::<DistanceFog>(&app, cam));
    assert!(cmd(&mut app, "look.feature", json!({"name": "raytracing", "on": true})).is_err());

    // Blend over the port.
    cmd(&mut app, "look.set", json!({"preset": "night", "blend": 0.5})).unwrap();
    assert!(app.world().contains_resource::<LookTransition>());
    run(&mut app, 40);
    assert_eq!(app.world().resource::<Look>().name, "night");

    // Day cycle over the port.
    let r = cmd(&mut app, "look.time", json!({"time": 12.0, "speed": 0.0})).unwrap();
    assert_eq!(r["time"], 12.0);
    run(&mut app, 1);
    assert_eq!(app.world().resource::<Look>().name, "clear_day");
}

#[test]
fn gfx_quality_adds_and_prunes_features() {
    let (mut app, cam) = build("gfx");
    set_quality(&mut app, engine::settings::GraphicsQuality::Ultra);
    app.world_mut().run_system_cached(engine::gfx::apply_camera_quality).unwrap();
    app.world_mut().run_system_cached(engine::gfx::prune_prepasses).unwrap();
    let w = app.world();
    assert!(w.get::<GamePrepasses>(cam).is_some_and(|g| !g.depth), "game had no prepass");
    assert!(w.get::<ContactShadows>(cam).is_some());
    assert!(w.get::<ScreenSpaceReflections>(cam).is_some());
    assert!(w.get::<ScreenSpaceAmbientOcclusion>(cam).is_some());
    assert_eq!(*w.get::<ShadowFilteringMethod>(cam).unwrap(), ShadowFilteringMethod::Temporal);
    assert!(w.get::<DepthPrepass>(cam).is_some());

    set_quality(&mut app, engine::settings::GraphicsQuality::Low);
    app.world_mut().run_system_cached(engine::gfx::apply_camera_quality).unwrap();
    app.world_mut().run_system_cached(engine::gfx::prune_prepasses).unwrap();
    let w = app.world();
    assert!(w.get::<ContactShadows>(cam).is_none() && w.get::<ScreenSpaceReflections>(cam).is_none());
    assert_eq!(*w.get::<ShadowFilteringMethod>(cam).unwrap(), ShadowFilteringMethod::Hardware2x2);
    assert!(w.get::<DepthPrepass>(cam).is_none(), "Low needs no prepass: pruned");

    // Look tuning survives a quality change: bloom keeps the look's intensity.
    set_quality(&mut app, engine::settings::GraphicsQuality::High);
    app.insert_resource(Look::night());
    app.world_mut().run_system_cached(engine::gfx::apply_camera_quality).unwrap();
    run(&mut app, 1);
    let b = app.world().get::<bevy::post_process::bloom::Bloom>(cam).expect("High has bloom");
    assert_eq!(b.intensity, Look::night().bloom.intensity);
}

/// Bevy gives `VisibilityRange`s to the first 32 cameras only: probes share six capture
/// cameras (9 probes used to add 54 and hide range-culled scenery from the main camera), every
/// probe still gets captured, and a despawned probe takes its filter worker with it.
#[test]
fn probes_share_six_cameras() {
    use engine::look::ReflectionProbe;
    use engine::look::probe::{ProbeRig, ProbeTargets, ProbeWorker};
    let (mut app, _cam) = build("probes");
    if !app.world().contains_resource::<Assets<Image>>() {
        app.init_resource::<Assets<Image>>();
    }
    let probes: Vec<Entity> = (0..9)
        .map(|i| {
            let mut p = ReflectionProbe::default();
            p.resolution = 16;
            p.refresh = Some(0);
            app.world_mut().spawn((p, Transform::from_xyz(i as f32 * 10.0, 2.0, 0.0))).id()
        })
        .collect();
    run(&mut app, 40);
    let w = app.world_mut();
    let cameras = w.query_filtered::<(), With<Camera>>().iter(w).count();
    assert_eq!(cameras, 1 + 6, "main camera + one shared rig");
    let rig = *w.resource::<ProbeRig>();
    for e in &probes {
        let p = w.get::<ReflectionProbe>(*e).unwrap();
        assert!(p.captures() >= 6, "probe {e} captured {} faces", p.captures());
    }
    assert_eq!(w.query::<&ProbeWorker>().iter(w).count(), 9);
    let worker = w.get::<ProbeTargets>(probes[0]).unwrap().worker;
    w.despawn(probes[0]);
    run(&mut app, 1);
    let w = app.world_mut();
    assert!(w.get_entity(worker).is_err(), "worker despawned with its probe");
    assert_eq!(w.query::<&ProbeWorker>().iter(w).count(), 8);
    assert!(rig.cameras.iter().all(|c| w.get_entity(*c).is_ok()), "the rig stays");
}
