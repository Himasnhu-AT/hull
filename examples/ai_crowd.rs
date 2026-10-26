//! Navigation & AI demo: an arena of walls and crates (avian colliders, baked into a navmesh in
//! the background), a crowd of wandering agents with ORCA avoidance, a ladder link onto a
//! platform, and two guards running a behaviour tree with sight + hearing.
//!
//! `cargo run --example ai_crowd -- --play [--agents 300] [--ai-debug]`
//! Control port: `ai.nav.debug {"on": true}`, `ai.agents`, `ai.bt {"entity": <id>}`,
//! `ai.noise {"pos": [0, 0, 0], "radius": 30}`, `ai.nav.path {"from": [..], "to": [..]}`.

use std::sync::Arc;

use engine::ai::bt::BtCtx;
use engine::ai::nav::query::random_point;
use engine::ai::perception::Sense;
use engine::avian3d::prelude::*;
use engine::cli::{arg_value, has_flag};
use engine::prelude::*;
use rand::SeedableRng;
use rand::rngs::StdRng;

fn main() {
    let mut app = engine::app(GameInfo::new("engine-ai-crowd", "AI Crowd").tagline("Navmesh, crowds, behaviour trees."));
    // `--uncapped`: vsync off, full speed unfocused (frame-time measurements offscreen).
    if has_flag("uncapped") {
        app.world_mut().resource_mut::<engine::render_budget::FramePacing>().gameplay.unfocused_mode = bevy::winit::UpdateMode::Continuous;
        app.world_mut().resource_mut::<engine::settings::CoreSettings>().vsync = false;
    }
    app.add_systems(Startup, spawn).add_systems(Update, (wander, color_guards)).run();
}

#[derive(Component)]
struct Wanderer;

#[derive(Component)]
struct Guard;

#[derive(Resource)]
struct Rng(StdRng);

#[derive(Resource)]
struct GuardMats(Handle<StandardMaterial>, Handle<StandardMaterial>);

fn spawn(
    mut commands: Commands,
    mut meshes: Option<ResMut<Assets<Mesh>>>,
    mut mats: Option<ResMut<Assets<StandardMaterial>>>,
    mut dbg: ResMut<engine::ai::AiDebug>,
) {
    if has_flag("ai-debug") {
        dbg.set_all(true);
    }
    commands.insert_resource(Rng(StdRng::seed_from_u64(7)));
    let mut solid = |c: &mut Commands, center: Vec3, size: Vec3, color: Color| {
        let mut e = c.spawn((RigidBody::Static, Collider::cuboid(size.x, size.y, size.z), Transform::from_translation(center)));
        if let (Some(m), Some(s)) = (meshes.as_mut(), mats.as_mut()) {
            e.insert((Mesh3d(m.add(Cuboid::new(size.x, size.y, size.z))), MeshMaterial3d(s.add(StandardMaterial { base_color: color, perceptual_roughness: 0.9, ..default() }))));
        }
    };
    let grey = Color::srgb(0.55, 0.56, 0.6);
    solid(&mut commands, Vec3::new(0.0, -0.5, 0.0), Vec3::new(60.0, 1.0, 60.0), Color::srgb(0.3, 0.34, 0.3));
    // Inner walls with gaps, crates, a platform reached by a ladder.
    solid(&mut commands, Vec3::new(0.0, 1.0, -8.0), Vec3::new(40.0, 2.0, 0.5), grey);
    solid(&mut commands, Vec3::new(-12.0, 1.0, 10.0), Vec3::new(0.5, 2.0, 24.0), grey);
    solid(&mut commands, Vec3::new(12.0, 1.0, 14.0), Vec3::new(0.5, 2.0, 16.0), grey);
    for (i, p) in [(-20.0, -18.0), (-4.0, 4.0), (5.0, -16.0), (20.0, 2.0), (-22.0, 20.0), (3.0, 20.0)].into_iter().enumerate() {
        let s = 1.5 + (i % 3) as f32;
        solid(&mut commands, Vec3::new(p.0, s * 0.5, p.1), Vec3::new(s, s, s), Color::srgb(0.65, 0.45, 0.25));
    }
    solid(&mut commands, Vec3::new(22.0, 1.0, 22.0), Vec3::new(8.0, 2.0, 8.0), Color::srgb(0.4, 0.45, 0.6));
    commands.spawn(NavLink(OffMeshLink { start: Vec3::new(16.6, 0.0, 22.0), end: Vec3::new(18.8, 2.0, 22.0), tag: 1, ..default() }));

    let n: usize = arg_value("agents").and_then(|v| v.parse().ok()).unwrap_or(200);
    let agent_mesh = meshes.as_mut().map(|m| m.add(Capsule3d::new(0.3, 1.1)));
    let agent_mat = mats.as_mut().map(|s| s.add(StandardMaterial { base_color: Color::srgb(0.2, 0.7, 0.9), ..default() }));
    for i in 0..n {
        let a = i as f32 * 2.39996;
        let r = 4.0 + (i as f32).sqrt() * 1.6;
        let p = Vec3::new(a.cos() * r, 0.0, a.sin() * r).clamp(Vec3::splat(-27.0), Vec3::splat(27.0));
        let mut e = commands.spawn((Wanderer, NavAgent { radius: 0.3, max_speed: 2.0 + (i % 5) as f32 * 0.3, ..default() }, Transform::from_translation(p)));
        if let (Some(m), Some(s)) = (&agent_mesh, &agent_mat) {
            e.with_child((Mesh3d(m.clone()), MeshMaterial3d(s.clone()), Transform::from_xyz(0.0, 0.85, 0.0)));
        }
    }
    // Guards: patrol, investigate noises, chase what they see.
    let tree = guard_tree();
    let (calm, alert) = match mats.as_mut() {
        Some(s) => (
            s.add(StandardMaterial { base_color: Color::srgb(0.9, 0.85, 0.2), ..default() }),
            s.add(StandardMaterial { base_color: Color::srgb(0.95, 0.15, 0.1), ..default() }),
        ),
        None => (Handle::default(), Handle::default()),
    };
    for (a, b) in [(Vec3::new(-25.0, 0.0, -20.0), Vec3::new(25.0, 0.0, -20.0)), (Vec3::new(-6.0, 0.0, 25.0), Vec3::new(8.0, 0.0, 0.0))] {
        let mut bb = Blackboard::default();
        bb.set("a", a);
        bb.set("b", b);
        let mut e = commands.spawn((
            Guard,
            Name::new("guard"),
            NavAgent { radius: 0.4, max_speed: 3.0, ..default() },
            BtAgent::new(tree.clone()).with_interval(0.1),
            bb,
            Perceiver { sight_range: 18.0, fov_deg: 100.0, ..default() },
            Transform::from_translation(a),
        ));
        if let Some(m) = meshes.as_mut() {
            e.with_child((Mesh3d(m.add(Capsule3d::new(0.4, 1.0))), MeshMaterial3d(calm.clone()), Transform::from_xyz(0.0, 0.9, 0.0)));
        }
    }
    commands.insert_resource(GuardMats(calm, alert));
    // Wanderers are perceivable (so the guards have something to see).
    commands.spawn((DirectionalLight { illuminance: 9000.0, shadow_maps_enabled: true, ..default() }, Transform::from_xyz(10.0, 30.0, 8.0).looking_at(Vec3::ZERO, Vec3::Y)));
    commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 36.0, 30.0).looking_at(Vec3::new(0.0, 0.0, 3.0), Vec3::Y)));
}

fn guard_tree() -> Arc<BehaviorTree> {
    fn goto(c: &mut BtCtx, p: Vec3) -> BtStatus {
        let Some(mut st) = c.world.get_mut::<NavAgentState>(c.entity) else { return BtStatus::Failure };
        if st.target.is_none_or(|t| t.distance(p) > 0.5) {
            st.set_target(p);
            return BtStatus::Running;
        }
        match st.status {
            NavStatus::Arrived => BtStatus::Success,
            NavStatus::Failed => BtStatus::Failure,
            _ => BtStatus::Running,
        }
    }
    fn seen(c: &BtCtx) -> Option<Vec3> {
        let p = c.world.get::<Perception>(c.entity)?;
        p.known.iter().find(|k| k.visible).map(|k| k.last_pos.with_y(0.0))
    }
    fn heard(c: &BtCtx) -> Option<Vec3> {
        let p = c.world.get::<Perception>(c.entity)?;
        p.known.iter().find(|k| k.sense == Sense::Hearing).map(|k| k.last_pos.with_y(0.0))
    }
    BehaviorTree::new(Bt::reactive_selector("guard", [
        Bt::sequence("chase", [Bt::condition("sees someone", |c| seen(c).is_some()), Bt::action("run at them", |c| match seen(c) {
            Some(p) => {
                c.bb.set("mode", "chase");
                goto(c, p)
            }
            None => BtStatus::Failure,
        })]),
        Bt::sequence("investigate", [Bt::condition("heard something", |c| heard(c).is_some()), Bt::action("go look", |c| match heard(c) {
            Some(p) => {
                c.bb.set("mode", "investigate");
                goto(c, p)
            }
            None => BtStatus::Failure,
        })]),
        Bt::sequence("patrol", [
            Bt::action("to a", |c| {
                c.bb.set("mode", "patrol");
                let p = c.bb.vec3("a").unwrap_or_default();
                goto(c, p)
            }),
            Bt::wait(1.0),
            Bt::action("to b", |c| {
                let p = c.bb.vec3("b").unwrap_or_default();
                goto(c, p)
            }),
            Bt::wait(1.0),
        ])
        .forever(),
    ]))
}

/// Wanderers pick a new random point on the mesh when they arrive (or fail).
fn wander(mut q: Query<&mut NavAgentState, With<Wanderer>>, navs: Res<NavMeshes>, mut rng: ResMut<Rng>, mut commands: Commands, new: Query<Entity, (With<Wanderer>, Without<Perceivable>)>) {
    for e in &new {
        commands.entity(e).insert(Perceivable::default());
    }
    if !navs.is_ready() {
        return;
    }
    let mesh = navs.primary();
    for mut st in &mut q {
        if matches!(st.status, NavStatus::Idle | NavStatus::Arrived | NavStatus::Failed)
            && let Some((_, p)) = random_point(mesh, &mut rng.0)
        {
            st.set_target(p);
        }
    }
}

fn color_guards(guards: Query<(&Blackboard, &Children), With<Guard>>, mut mats: Query<&mut MeshMaterial3d<StandardMaterial>>, gm: Option<Res<GuardMats>>) {
    let Some(gm) = gm else { return };
    for (bb, kids) in &guards {
        let m = if bb.text("mode") == Some("chase") { &gm.1 } else { &gm.0 };
        for k in kids.iter() {
            if let Ok(mut mm) = mats.get_mut(k)
                && mm.0 != *m
            {
                mm.0 = m.clone();
            }
        }
    }
}
