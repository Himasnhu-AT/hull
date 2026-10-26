//! Navigation & AI, headless via `App::update()`: a level built from avian colliders in code is
//! baked in the background, paths/agents/crowds/BT/perception are asserted, and the `ai.*`
//! control commands are called directly.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use engine::ai::nav::query::NavQuery;
use engine::ai::{AiConfig, AiStats, NavMeshChanged, NavPathQueue};
use engine::avian3d::prelude::*;
use engine::prelude::*;

const STEP: Duration = Duration::from_nanos(16_666_667);

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("engine-ai-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn build(tag: &str, cfg: AiConfig) -> App {
    let mut app = engine::app_with(GameInfo::new("aitest", "AI Test"), EngineOptions::headless_test(temp_dir(tag)));
    app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(STEP)).insert_resource(cfg);
    app.finish();
    app.cleanup();
    app
}

fn wall(c: &mut Commands, center: Vec3, half: Vec3) -> Entity {
    c.spawn((RigidBody::Static, Collider::cuboid(half.x * 2.0, half.y * 2.0, half.z * 2.0), Transform::from_translation(center))).id()
}

/// 40 x 40 m floor, a wall at x = 0 from z = -20 to z = 10, a 2 m crate, a 2 m high platform
/// at x ∈ [12, 18] reached only by a ladder link.
fn level(app: &mut App) {
    let mut c = app.world_mut().commands();
    wall(&mut c, Vec3::new(0.0, -0.5, 0.0), Vec3::new(20.0, 0.5, 20.0));
    wall(&mut c, Vec3::new(0.0, 1.0, -5.0), Vec3::new(0.25, 1.0, 15.0));
    wall(&mut c, Vec3::new(-8.0, 1.0, -8.0), Vec3::new(1.0, 1.0, 1.0));
    wall(&mut c, Vec3::new(15.0, 1.0, 15.0), Vec3::new(3.0, 1.0, 3.0));
    app.world_mut().flush();
}

fn run(app: &mut App, frames: usize) {
    for _ in 0..frames {
        app.update();
    }
}

/// Updates until the navmesh is baked and idle (async tasks finish on other threads).
fn wait_baked(app: &mut App) {
    let t0 = Instant::now();
    loop {
        app.update();
        let n = app.world().resource::<NavMeshes>();
        if n.is_ready() {
            return;
        }
        assert!(t0.elapsed() < Duration::from_secs(20), "bake timed out");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn path(app: &App, from: Vec3, to: Vec3) -> engine::ai::NavPath {
    let cfg = app.world().resource::<AiConfig>();
    let mesh = app.world().resource::<NavMeshes>().primary();
    NavQuery::new().find_path(mesh, from, to, cfg.query_extents, cfg.max_search_nodes).unwrap()
}

#[test]
fn bakes_from_colliders_and_finds_paths() {
    let mut app = build("bake", AiConfig::default());
    level(&mut app);
    wait_baked(&mut app);
    let navs = app.world().resource::<NavMeshes>();
    let mesh = navs.primary();
    assert!(mesh.tile_count() >= 16, "tiles {}", mesh.tile_count());
    assert!(navs.last_bake.polys > 0 && navs.last_bake.wall_us > 0, "{:?}", navs.last_bake);
    // Around the wall: two legs via its end at z ≈ 10.
    let a = Vec3::new(-5.0, 0.0, 0.0);
    let b = Vec3::new(5.0, 0.0, 0.0);
    let p = path(&app, a, b);
    assert!(p.complete);
    let corner = Vec3::new(0.0, 0.0, 10.65);
    let expect = a.distance(corner) + corner.distance(b);
    assert!((p.length() - expect).abs() < 1.0, "len {} expect {expect}", p.length());
    // Crate top is a separate island; platform unreachable without a link.
    let top = Vec3::new(15.0, 2.0, 15.0);
    let p = path(&app, a, top);
    assert!(!p.complete, "platform needs a link");
    // A ladder link (code-defined) makes it reachable.
    app.world_mut().spawn(NavLink(OffMeshLink { start: Vec3::new(11.0, 0.0, 15.0), end: Vec3::new(12.8, 2.0, 15.0), bidirectional: true, tag: 1, ..default() }));
    run(&mut app, 2);
    let p = path(&app, a, top);
    assert!(p.complete, "{:?}", p.points);
    assert!(p.points.iter().any(|pt| pt.offmesh.is_some()));
}

#[test]
fn moving_an_obstacle_rebakes_only_its_tiles() {
    let mut app = build("rebake", AiConfig { rebake_delay: 0.0, ..default() });
    level(&mut app);
    wait_baked(&mut app);
    let total = app.world().resource::<NavMeshes>().primary().tile_count();
    let gen0 = app.world().resource::<NavMeshes>().generation;
    let before = path(&app, Vec3::new(-5.0, 0.0, 15.0), Vec3::new(5.0, 0.0, 15.0)).length();
    assert!(before < 10.5, "open gap first: {before}");
    // Close the gap at the wall's end.
    let mut c = app.world_mut().commands();
    wall(&mut c, Vec3::new(0.0, 1.0, 15.0), Vec3::new(0.25, 1.0, 5.0));
    app.world_mut().flush();
    app.world_mut().resource_mut::<Messages<NavMeshChanged>>().clear();
    loop {
        app.update();
        let n = app.world().resource::<NavMeshes>();
        if n.generation > gen0 && !n.is_baking() {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let rebaked = app.world().resource::<NavMeshes>().last_bake.tiles as usize;
    assert!(rebaked < total, "incremental: {rebaked} of {total} tiles");
    let p = path(&app, Vec3::new(-5.0, 0.0, 15.0), Vec3::new(5.0, 0.0, 15.0));
    assert!(!p.complete, "gap closed: {:?}", p.points);
}

#[test]
fn agents_walk_paths_and_queue_is_budgeted() {
    let mut app = build("agents", AiConfig { path_queries_per_frame: 4, ..default() });
    level(&mut app);
    // A link spawned before the first bake is resolved once the tiles exist.
    app.world_mut().spawn(NavLink(OffMeshLink { start: Vec3::new(11.0, 0.0, 15.0), end: Vec3::new(12.8, 2.0, 15.0), ..default() }));
    wait_baked(&mut app);
    assert_eq!(app.world().resource::<NavMeshes>().primary().resolved_offmesh().len(), 2, "bidirectional link resolved");
    let goal = Vec3::new(5.0, 0.0, 0.0);
    let mut ids = Vec::new();
    for i in 0..10 {
        let mut st = NavAgentState::default();
        st.set_target(goal + Vec3::new(0.0, 0.0, i as f32 * 1.2 - 6.0));
        ids.push(app.world_mut().spawn((NavAgent::default(), st, Transform::from_xyz(-6.0, 0.0, i as f32 * 1.2 - 6.0))).id());
    }
    let ticket = app.world_mut().resource_mut::<NavPathQueue>().request(Vec3::new(-5.0, 0.0, 0.0), goal, 0);
    app.update();
    // Budget: at most 4 answered in the first frame (10 agents + 1 ticket queued).
    assert!(app.world().resource::<AiStats>().path_queries <= 4);
    run(&mut app, 3);
    let res = app.world_mut().resource_mut::<NavPathQueue>().take(ticket).expect("ticket answered").unwrap();
    assert!(res.complete);
    run(&mut app, 60 * 15);
    for e in &ids {
        let st = app.world().get::<NavAgentState>(*e).unwrap();
        let tf = app.world().get::<Transform>(*e).unwrap();
        assert_eq!(st.status, NavStatus::Arrived, "agent at {} target {:?}", tf.translation, st.target);
        assert!(tf.translation.distance(st.target.unwrap()) < 0.5);
        assert!(tf.translation.x > 0.0, "crossed the wall");
    }
}

#[test]
fn crowd_swaps_without_overlap() {
    let mut app = build("crowd", AiConfig::default());
    let mut c = app.world_mut().commands();
    wall(&mut c, Vec3::new(0.0, -0.5, 0.0), Vec3::new(30.0, 0.5, 30.0));
    app.world_mut().flush();
    wait_baked(&mut app);
    let n = 100;
    let r = 12.0;
    let mut ids = Vec::new();
    for i in 0..n {
        let a = i as f32 / n as f32 * std::f32::consts::TAU;
        let p = Vec3::new(a.cos() * r, 0.0, a.sin() * r);
        let mut st = NavAgentState::default();
        st.set_target(-p);
        ids.push(app.world_mut().spawn((NavAgent { radius: 0.3, max_speed: 2.5, ..default() }, st, Transform::from_translation(p))).id());
    }
    let mut min_ratio = f32::MAX;
    for f in 0..60 * 30 {
        app.update();
        if f % 5 == 0 {
            let pos: Vec<Vec3> = ids.iter().map(|e| app.world().get::<Transform>(*e).unwrap().translation).collect();
            for i in 0..n {
                for j in i + 1..n {
                    min_ratio = min_ratio.min(pos[i].xz().distance(pos[j].xz()) / 0.6);
                }
            }
        }
    }
    let arrived = ids.iter().filter(|e| app.world().get::<NavAgentState>(**e).unwrap().status == NavStatus::Arrived).count();
    assert!(min_ratio > 0.8, "closest pair at {:.2} of 2r", min_ratio);
    assert!(arrived >= n * 9 / 10, "{arrived}/{n} arrived");
}

fn patrol_tree() -> Arc<engine::ai::BehaviorTree> {
    use engine::ai::bt::BtCtx;
    fn goto(c: &mut BtCtx, key: &'static str) -> BtStatus {
        let Some(p) = c.bb.vec3(key) else { return BtStatus::Failure };
        let Some(mut st) = c.world.get_mut::<NavAgentState>(c.entity) else { return BtStatus::Failure };
        if st.target != Some(p) {
            st.set_target(p);
            return BtStatus::Running;
        }
        match st.status {
            NavStatus::Arrived => BtStatus::Success,
            NavStatus::Failed => BtStatus::Failure,
            _ => BtStatus::Running,
        }
    }
    BehaviorTree::new(Bt::reactive_selector("root", [
        Bt::sequence("investigate", [
            Bt::condition("heard noise", |c| c.world.get::<Perception>(c.entity).is_some_and(|p| p.known.iter().any(|k| k.sense == engine::ai::perception::Sense::Hearing))),
            Bt::action("go to noise", |c| {
                let pos = c.world.get::<Perception>(c.entity).and_then(|p| p.known.iter().find(|k| k.sense == engine::ai::perception::Sense::Hearing).map(|k| k.last_pos));
                if let Some(p) = pos {
                    c.bb.set("noise", Vec3::new(p.x, 0.0, p.z));
                }
                goto(c, "noise")
            }),
        ]),
        Bt::sequence("patrol", [
            Bt::action("to a", |c| goto(c, "a")),
            Bt::wait(0.5),
            Bt::action("to b", |c| goto(c, "b")),
        ])
        .forever(),
    ]))
}

fn spawn_guard(app: &mut App) -> Entity {
    let mut bb = Blackboard::default();
    bb.set("a", Vec3::new(-10.0, 0.0, 12.0));
    bb.set("b", Vec3::new(10.0, 0.0, 12.0));
    app.world_mut()
        .spawn((Name::new("guard"), NavAgent::default(), BtAgent::new(patrol_tree()), bb, Perceiver { hearing: 1.0, ..default() }, Transform::from_xyz(-10.0, 0.0, 14.0)))
        .id()
}

fn guard_trace(seed_frames: usize) -> Vec<Vec3> {
    let mut app = build("bt", AiConfig { async_bake: false, ..default() });
    level(&mut app);
    run(&mut app, 30);
    assert!(app.world().resource::<NavMeshes>().is_ready());
    let g = spawn_guard(&mut app);
    let mut trace = Vec::new();
    for _ in 0..seed_frames {
        app.update();
        trace.push(app.world().get::<Transform>(g).unwrap().translation);
    }
    trace
}

#[test]
fn behaviour_tree_patrols_deterministically_and_reacts_to_noise() {
    let mut app = build("bt2", AiConfig { async_bake: false, ..default() });
    level(&mut app);
    run(&mut app, 30);
    let g = spawn_guard(&mut app);
    run(&mut app, 60 * 12);
    let bt = app.world().get::<BtAgent>(g).unwrap();
    let active = bt.active_path().join("/");
    assert!(active.starts_with("root/forever/patrol"), "{active}");
    let tf = app.world().get::<Transform>(g).unwrap().translation;
    assert!(tf.z > 10.0, "patrols along z=12: {tf}");
    // A noise behind the wall: the reactive selector switches to investigating.
    app.world_mut().write_message(Noise { pos: Vec3::new(5.0, 0.0, -10.0), radius: 50.0, source: None });
    run(&mut app, 3);
    let active = app.world().get::<BtAgent>(g).unwrap().active_path().join("/");
    assert_eq!(active, "root/investigate/go to noise");
    // ~25 m around the wall at 3.5 m/s; the noise is remembered for 10 s.
    run(&mut app, 60 * 9);
    let tf = app.world().get::<Transform>(g).unwrap().translation;
    assert!(tf.distance(Vec3::new(5.0, 0.0, -10.0)) < 0.6, "investigated: {tf}");
    // Once forgotten, back to patrolling.
    run(&mut app, 60 * 3);
    let active = app.world().get::<BtAgent>(g).unwrap().active_path().join("/");
    assert!(active.starts_with("root/forever/patrol"), "{active}");
    // Determinism: two fresh runs give the same trajectory.
    assert_eq!(guard_trace(300), guard_trace(300));
}

#[test]
fn sight_is_blocked_by_walls_and_remembered() {
    let mut app = build("sight", AiConfig { async_bake: false, ..default() });
    level(&mut app);
    // Guard at x = -5 looking +x (towards the wall at x = 0, which ends at z = 10).
    let guard = app
        .world_mut()
        .spawn((Perceiver { memory_secs: 2.0, ..default() }, Transform::from_xyz(-5.0, 0.0, 8.0).looking_to(Vec3::X, Vec3::Y)))
        .id();
    let behind = app.world_mut().spawn((Perceivable::default(), Collider::capsule(0.3, 1.2), Transform::from_xyz(5.0, 0.9, 8.0))).id();
    let open = app.world_mut().spawn((Perceivable::default(), Collider::capsule(0.3, 1.2), Transform::from_xyz(5.0, 0.9, 16.0))).id();
    let back = app.world_mut().spawn((Perceivable::default(), Transform::from_xyz(-15.0, 0.9, 0.0))).id();
    run(&mut app, 20);
    let p = app.world().get::<Perception>(guard).unwrap();
    assert!(!p.sees(behind), "wall blocks");
    assert!(p.sees(open), "visible past the wall end");
    assert!(!p.sees(back), "outside the cone");
    // Target leaves: remembered at the last position, then forgotten after memory_secs.
    let last = app.world().get::<GlobalTransform>(open).unwrap().translation();
    app.world_mut().get_mut::<Transform>(open).unwrap().translation = Vec3::new(5.0, 0.9, -15.0);
    run(&mut app, 5);
    let p = app.world().get::<Perception>(guard).unwrap();
    assert!(!p.sees(open));
    assert!(p.last_known(open).unwrap().distance(last + Vec3::Y * 1.0) < 0.5, "{:?}", p.last_known(open));
    run(&mut app, 60 * 3);
    assert!(app.world().get::<Perception>(guard).unwrap().last_known(open).is_none(), "forgotten");
}

#[cfg(feature = "devtools")]
#[test]
fn control_commands() {
    use engine::devtools::control::Handler;
    use serde_json::json;
    let mut app = build("control", AiConfig { async_bake: false, ..default() });
    level(&mut app);
    run(&mut app, 30);
    let g = spawn_guard(&mut app);
    run(&mut app, 30);
    let call = |app: &mut App, id: &str, p: serde_json::Value| {
        let reg = app.world().resource::<engine::devtools::ControlRegistry>().clone();
        match reg.get(id).unwrap_or_else(|| panic!("{id} registered")).handler {
            Handler::Instant(f) => f(app.world_mut(), p).unwrap(),
            Handler::Deferred(_) => panic!("{id} is deferred"),
        }
    };
    let p = call(&mut app, "ai.nav.path", json!({"from": [-5, 0, 0], "to": [5, 0, 0]}));
    assert_eq!(p["complete"], true);
    assert!(p["length"].as_f64().unwrap() > 20.0);
    let a = call(&mut app, "ai.agents", json!({}));
    assert_eq!(a["count"], 1);
    let b = call(&mut app, "ai.bt", json!({"entity": g.to_bits()}));
    assert_eq!(b["bt"]["tree"]["name"], "root");
    assert!(b["blackboard"]["a"].is_array());
    let b2 = call(&mut app, "ai.bt", json!({"entity": g.index_u32()}));
    assert_eq!(b2["entity"], b["entity"]);
    let d = call(&mut app, "ai.nav.debug", json!({"on": true}));
    assert_eq!(d["navmesh"], true);
    let s = call(&mut app, "ai.nav.stats", json!({}));
    assert!(s["meshes"][0]["polys"].as_u64().unwrap() > 0);
    let r = call(&mut app, "ai.nav.raycast", json!({"from": [-5, 0, 0], "to": [5, 0, 0]}));
    assert_eq!(r["hit"], true);
    let goto = call(&mut app, "ai.agent.goto", json!({"to": [5, 0, 5]}));
    assert_eq!(goto["agents"], 1);
    assert!(app.world().resource::<engine::devtools::ControlRegistry>().get("ai.nav.bake").is_some());
}

/// Bake time and per-frame cost for 100 / 500 agents (numbers for docs/AI.md):
/// `cargo test --release --test ai -- --ignored --nocapture perf`
#[test]
#[ignore]
fn perf_report() {
    for (size, crates) in [(50.0f32, 60), (150.0, 600)] {
        let mut app = build("perf-bake", AiConfig::default());
        let mut c = app.world_mut().commands();
        wall(&mut c, Vec3::new(0.0, -0.5, 0.0), Vec3::new(size, 0.5, size));
        for i in 0..crates {
            let x = ((i * 7919) % 1000) as f32 / 1000.0 * size * 1.8 - size * 0.9;
            let z = ((i * 104729) % 1000) as f32 / 1000.0 * size * 1.8 - size * 0.9;
            wall(&mut c, Vec3::new(x, 1.0, z), Vec3::new(1.0, 1.0, 1.5));
        }
        app.world_mut().flush();
        wait_baked(&mut app);
        let n = app.world().resource::<NavMeshes>();
        let m = n.primary();
        println!(
            "bake {}x{} m, {crates} crates: tiles {} polys {} wall {:.1} ms cpu {:.1} ms gather {:.2} ms",
            size * 2.0,
            size * 2.0,
            m.tile_count(),
            m.poly_count(),
            n.last_bake.wall_us as f64 / 1000.0,
            n.last_bake.cpu_us as f64 / 1000.0,
            n.last_gather_us as f64 / 1000.0
        );
        // Path queries.
        let mut q = NavQuery::new();
        let t0 = Instant::now();
        let mut len = 0.0;
        for i in 0..200 {
            let a = Vec3::new(-size * 0.8, 0.0, (i as f32 / 200.0 - 0.5) * size * 1.6);
            let b = Vec3::new(size * 0.8, 0.0, -(i as f32 / 200.0 - 0.5) * size * 1.6);
            if let Ok(p) = q.find_path(m, a, b, Vec3::splat(2.0), 8192) {
                len += p.length();
            }
        }
        println!("  200 cross-map paths: {:.3} ms each (avg len {:.0} m)", t0.elapsed().as_secs_f64() * 1000.0 / 200.0, len / 200.0);
    }
    for n in [100usize, 500] {
        // Behaviour trees (every frame) + perception (everyone sees everyone, 64 rays/frame).
        let mut app = build("perf-think", AiConfig { async_bake: false, ..default() });
        level(&mut app);
        run(&mut app, 30);
        let tree = patrol_tree();
        for i in 0..n {
            let mut bb = Blackboard::default();
            let z = (i % 20) as f32 - 10.0;
            bb.set("a", Vec3::new(-15.0, 0.0, z));
            bb.set("b", Vec3::new(-3.0, 0.0, z));
            app.world_mut().spawn((
                NavAgent { radius: 0.3, ..default() },
                BtAgent::new(tree.clone()),
                bb,
                Perceiver::default(),
                Perceivable::default(),
                Transform::from_xyz(-10.0 + (i / 20) as f32 * 0.4, 0.0, z),
            ));
        }
        run(&mut app, 30);
        let (mut think, mut sense, mut rays) = (0u64, 0u64, 0u64);
        let frames = 300;
        for _ in 0..frames {
            app.update();
            let s = app.world().resource::<AiStats>();
            think += s.think_us as u64;
            sense += s.sense_us as u64;
            rays += s.sight_rays as u64;
        }
        let cands = app.world().resource::<AiStats>().sight_candidates;
        println!(
            "think {n}: BT tick {:.3} ms/frame; perception {:.3} ms/frame ({} rays/frame, {} in-cone pairs)",
            think as f64 / 1000.0 / frames as f64,
            sense as f64 / 1000.0 / frames as f64,
            rays / frames,
            cands
        );
    }
    for n in [100usize, 500] {
        let mut app = build("perf-crowd", AiConfig::default());
        let mut c = app.world_mut().commands();
        wall(&mut c, Vec3::new(0.0, -0.5, 0.0), Vec3::new(60.0, 0.5, 60.0));
        app.world_mut().flush();
        wait_baked(&mut app);
        let r = if n > 200 { 40.0 } else { 20.0 };
        for i in 0..n {
            let a = i as f32 / n as f32 * std::f32::consts::TAU;
            let p = Vec3::new(a.cos() * r, 0.0, a.sin() * r);
            let mut st = NavAgentState::default();
            st.set_target(-p);
            app.world_mut().spawn((NavAgent { radius: 0.3, ..default() }, st, Transform::from_translation(p)));
        }
        run(&mut app, 30);
        let mut steer = 0u64;
        let mut path = 0u64;
        let frames = 300;
        let t0 = Instant::now();
        for _ in 0..frames {
            app.update();
            let s = app.world().resource::<AiStats>();
            steer += s.steer_us as u64;
            path += s.path_us as u64;
        }
        let frame = t0.elapsed().as_secs_f64() * 1000.0 / frames as f64;
        let s = *app.world().resource::<AiStats>();
        println!(
            "crowd {n}: steer+avoid {:.3} ms/frame, paths {:.3} ms/frame, whole headless frame {:.3} ms, moving {} neighbours {}",
            steer as f64 / 1000.0 / frames as f64,
            path as f64 / 1000.0 / frames as f64,
            frame,
            s.agents_moving,
            s.neighbor_checks
        );
    }
}
