//! VFX headless: effects played through the ECS, stepped with `App::update()` at a fixed 60 Hz.
//! No renderer: simulation, pooling, budgets, pause, LOD/culling, sub-emitters, control
//! commands and (feature `physics`) collider collision.

#![cfg(feature = "vfx")]

use std::path::PathBuf;
use std::time::Duration;

use engine::prelude::*;
use engine::vfx::{self, Burst, Collision, OnFinish, ParticleEffect, Shape, Velocity, VfxInstance, VfxPool};

const STEP: Duration = Duration::from_nanos(16_666_667);

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("engine-vfx-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn build(tag: &str) -> App {
    let mut app = engine::app_with(GameInfo::new("engine-vfx-test", "VFX test"), EngineOptions::headless_test(temp_dir(tag)));
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(STEP));
    app.finish();
    app.cleanup();
    // Camera at the origin looking down -Z (LOD and culling measure from it).
    app.world_mut().spawn((MainCamera, Transform::from_xyz(0.0, 1.6, 0.0)));
    run(&mut app, 2);
    app
}

fn run(app: &mut App, frames: usize) {
    for _ in 0..frames {
        app.update();
    }
}

fn stats(app: &App) -> VfxStats {
    app.world().resource::<VfxStats>().clone()
}

fn positions(app: &mut App) -> Vec<Vec3> {
    let mut q = app.world_mut().query::<&VfxInstance>();
    q.iter(app.world()).flat_map(|i| i.state.emitters.iter().flat_map(|e| e.p.pos.iter().map(|p| Vec3::from(*p)))).collect()
}

#[test]
fn one_shot_plays_finishes_and_is_pooled_then_reused() {
    let mut app = build("pool");
    let at = Vec3::new(3.0, 0.0, -10.0);
    let e = vfx::play_world(app.world_mut(), "explosion", Transform::from_translation(at), Some(5)).unwrap();
    run(&mut app, 1);
    let s = stats(&app);
    assert_eq!((s.effects, s.active), (1, 1));
    assert!(s.particles > 40, "explosion bursts: {}", s.particles);
    assert!(positions(&mut app).iter().all(|p| p.distance(at) < 3.0), "spawned at the effect");

    // Streak deaths fire the `pops` sub-emitter.
    run(&mut app, 90);
    let inst = app.world().get::<VfxInstance>(e).unwrap();
    let pops = inst.fx.def.emitters.iter().position(|d| d.name == "pops").unwrap();
    assert!(inst.state.emitters[pops].spawned > 0, "sub-emitter fired");

    // Finishes (smoke lives ≤ 4 s) and goes idle into the pool.
    run(&mut app, 260);
    let s = stats(&app);
    assert_eq!((s.active, s.pooled, s.particles), (0, 1, 0), "{s:?}");
    assert_eq!(app.world().resource::<VfxPool>().free["explosion"], vec![e]);

    // Replaying reuses the pooled entity (no spawn).
    let entities = app.world().entities().count_spawned();
    let again = vfx::play_world(app.world_mut(), "explosion", Transform::from_xyz(0.0, 0.0, -5.0), Some(6)).unwrap();
    assert_eq!(again, e);
    run(&mut app, 1);
    assert_eq!(app.world().entities().count_spawned(), entities);
    let s = stats(&app);
    assert_eq!((s.active, s.pooled), (1, 0));
    assert!(positions(&mut app).iter().all(|p| p.distance(Vec3::new(0.0, 0.0, -5.0)) < 3.0), "restarted at the new spot");
}

#[test]
fn same_seed_same_particles() {
    let sample = |seed| {
        let mut app = build("det");
        vfx::play_world(app.world_mut(), "fire", Transform::from_xyz(0.0, 0.0, -6.0), Some(seed)).unwrap();
        run(&mut app, 120);
        positions(&mut app)
    };
    let (a, b, c) = (sample(11), sample(11), sample(12));
    assert!(a.len() > 20);
    assert_eq!(a, b);
    assert_ne!(a, c);
}

#[test]
fn pause_freezes_particles() {
    let mut app = build("pause");
    app.world_mut().spawn((ParticleEffect::new("smoke").seeded(1), Transform::from_xyz(0.0, 0.0, -8.0)));
    run(&mut app, 60);
    let before = positions(&mut app);
    assert!(!before.is_empty());
    app.world_mut().run_system_cached(|mut p: PauseCtl| p.set(true)).unwrap();
    run(&mut app, 30);
    assert_eq!(positions(&mut app), before, "paused: nothing moves or spawns");
    app.world_mut().run_system_cached(|mut p: PauseCtl| p.set(false)).unwrap();
    run(&mut app, 5);
    assert_ne!(positions(&mut app), before);
}

#[test]
fn global_budget_caps_particles() {
    let mut app = build("budget");
    app.world_mut().resource_mut::<VfxBudget>().max_particles = 500;
    app.world_mut().spawn((ParticleEffect::new("stress").seeded(1), Transform::from_xyz(0.0, 4.0, -10.0)));
    run(&mut app, 30);
    let s = stats(&app);
    assert!(s.particles <= 500 && s.particles >= 450, "{s:?}");
    run(&mut app, 1);
    assert!(stats(&app).dropped > 0);
}

#[test]
fn distance_lod_and_culling() {
    let mut app = build("lod");
    let near = app.world_mut().spawn((ParticleEffect::new("smoke").seeded(1), Transform::from_xyz(0.0, 0.0, -10.0))).id();
    let mid = app.world_mut().spawn((ParticleEffect::new("smoke").seeded(1), Transform::from_xyz(0.0, 0.0, -150.0))).id();
    let far = app.world_mut().spawn((ParticleEffect::new("smoke").seeded(1), Transform::from_xyz(0.0, 0.0, -400.0))).id();
    run(&mut app, 120);
    let alive = |app: &App, e| app.world().get::<VfxInstance>(e).unwrap().state.alive();
    let (n, m, f) = (alive(&app, near), alive(&app, mid), alive(&app, far));
    assert!(n > 15, "near {n}");
    assert!(m > 0 && m * 3 < n, "mid gets ~min_scale: {m} vs {n}");
    assert_eq!(f, 0, "beyond cull distance nothing spawns");
    assert!(app.world().get::<VfxInstance>(far).unwrap().culled);
    assert_eq!(stats(&app).culled, 1);
}

#[test]
fn effects_follow_parents_and_stop_emitting() {
    let mut app = build("parent");
    let ship = app.world_mut().spawn(Transform::from_xyz(10.0, 2.0, -20.0)).id();
    let fx = app
        .world_mut()
        .spawn((ParticleEffect::new("smoke").seeded(3).on_finish(OnFinish::Despawn), Transform::from_xyz(0.0, 1.0, 0.0), ChildOf(ship)))
        .id();
    run(&mut app, 20);
    let p = positions(&mut app);
    assert!(!p.is_empty());
    assert!(p.iter().all(|p| p.distance(Vec3::new(10.0, 3.0, -20.0)) < 3.0), "spawns at parent ∘ child: {:?}", p[0]);

    // Stop emitting: particles live out their life, then the effect despawns itself.
    app.world_mut().get_mut::<ParticleEffect>(fx).unwrap().emitting = false;
    run(&mut app, 400);
    assert!(app.world().get_entity(fx).is_err(), "despawned when done");
    assert_eq!(stats(&app).effects, 0);
}

#[test]
fn custom_effect_from_rust_and_unknown_names() {
    let mut app = build("custom");
    let def = EffectDef::new("puff").once(0.05).with(EmitterDef {
        bursts: vec![Burst::at(0.0, 12)],
        lifetime: (1.0, 1.0),
        shape: Shape::Sphere { radius: 0.1, surface: false },
        velocity: Velocity::Radial { speed: (1.0, 1.0) },
        ..default()
    });
    app.world_mut().resource_mut::<VfxLibrary>().register(def).unwrap();
    vfx::play_world(app.world_mut(), "puff", Transform::from_xyz(0.0, 1.0, -5.0), Some(1)).unwrap();
    run(&mut app, 31);
    let p = positions(&mut app);
    assert_eq!(p.len(), 12);
    // Radial speed 1 m/s for 0.5 s (30 steps after the spawn frame).
    for q in &p {
        let d = q.distance(Vec3::new(0.0, 1.0, -5.0));
        assert!((0.45..0.65).contains(&d), "{d}");
    }
    assert!(vfx::play_world(app.world_mut(), "nope", Transform::default(), None).is_none());
    run(&mut app, 1);
    assert!(stats(&app).refused >= 1);
}

#[cfg(feature = "devtools")]
#[test]
fn control_commands_drive_vfx() {
    use engine::devtools::ControlRegistry;
    use engine::devtools::control::Handler;
    use serde_json::json;

    let mut app = build("control");
    let call = |app: &mut App, id: &str, p: serde_json::Value| {
        let h = app.world().resource::<ControlRegistry>().get(id).unwrap_or_else(|| panic!("{id} registered")).handler;
        match h {
            Handler::Instant(f) => f(app.world_mut(), p),
            Handler::Deferred(_) => panic!("{id} is deferred"),
        }
    };
    let list = call(&mut app, "vfx.list", json!({})).unwrap();
    let names: Vec<&str> = list["effects"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    for p in ["sparks", "smoke", "fire", "muzzle_flash", "explosion", "dust_puff", "magic", "rain", "snow"] {
        assert!(names.contains(&p), "{p} in {names:?}");
    }
    let r = call(&mut app, "vfx.spawn", json!({"preset": "sparks", "pos": [1, 2, -6], "seed": 4})).unwrap();
    assert_eq!(r["effect"], "sparks");
    assert!(call(&mut app, "vfx.spawn", json!({"preset": "nope"})).is_err());
    run(&mut app, 30);
    let s = call(&mut app, "vfx.stats", json!({})).unwrap();
    assert!(s["stats"]["particles"].as_u64().unwrap() > 10, "{s}");
    assert_eq!(s["effects"][0]["effect"], "sparks");

    // Read a preset, change it, define it back under a new name, play it.
    let mut def = call(&mut app, "vfx.get", json!({"preset": "dust_puff"})).unwrap();
    def["name"] = json!("big_puff");
    def["emitters"][0]["bursts"][0]["count"] = json!(30);
    let r = call(&mut app, "vfx.define", json!({"def": def})).unwrap();
    assert_eq!(r["registered"], "big_puff");
    assert!(call(&mut app, "vfx.define", json!({"def": {"name": "broken"}})).is_err(), "no emitters");
    call(&mut app, "vfx.spawn", json!({"preset": "big_puff", "pos": [0, 0, -4]})).unwrap();
    run(&mut app, 1);
    let s = call(&mut app, "vfx.stats", json!({})).unwrap();
    let big = s["effects"].as_array().unwrap().iter().find(|e| e["effect"] == "big_puff").unwrap().clone();
    assert_eq!(big["alive"], 30);

    let b = call(&mut app, "vfx.budget", json!({"max_particles": 1234})).unwrap();
    assert_eq!(b["max_particles"], 1234);
    let r = call(&mut app, "vfx.clear", json!({})).unwrap();
    assert_eq!(r["despawned"], 2);
    run(&mut app, 1);
    assert_eq!(stats(&app).effects, 0);
}

#[cfg(feature = "physics")]
#[test]
fn particles_collide_with_physics_colliders() {
    use engine::avian3d::prelude::{Collider, RigidBody};
    let mut app = build("physics");
    // A 4×4 m slab whose top is at y = 1.
    app.world_mut().spawn((RigidBody::Static, Collider::cuboid(4.0, 1.0, 4.0), Transform::from_xyz(0.0, 0.5, -6.0)));
    run(&mut app, 3);
    let def = EffectDef::new("hail").with(EmitterDef {
        capacity: 400,
        rate: 200.0,
        lifetime: (3.0, 3.0),
        shape: Shape::Disc { radius: 1.0 },
        offset: Vec3::new(0.0, 4.0, 0.0),
        gravity: Vec3::new(0.0, -9.81, 0.0),
        collision: Collision::Physics { restitution: 0.2, friction: 0.5, die: false },
        ..default()
    });
    app.world_mut().resource_mut::<VfxLibrary>().register(def).unwrap();
    app.world_mut().spawn((ParticleEffect::new("hail").seeded(2), Transform::from_xyz(0.0, 0.0, -6.0)));
    run(&mut app, 120);
    let p = positions(&mut app);
    assert!(p.len() > 100);
    let below = p.iter().filter(|p| p.y < 0.95).count();
    assert_eq!(below, 0, "no particle falls through the slab top");
    assert!(p.iter().filter(|p| p.y < 1.2).count() > 50, "they rest on it");
    assert!(stats(&app).collision_rays > 0);
}
