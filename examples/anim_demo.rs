//! Animation demo: procedural skinned mannequins (mesh, skeleton and clips all made in code)
//! driven by the engine's animation graph.
//!
//! - A hero walks/runs a figure eight with root motion through a 2D locomotion blend space
//!   (speed × direction), waves (masked upper-body layer), leans into turns (additive layer),
//!   flinches on a timer (trigger + exit time), watches a floating orb (look-at) and has a
//!   spring antenna.
//! - A lineup shows each clip on its own; one mannequin stands on a step with foot placement.
//! - `--crowd <n>`: n more mannequins walking circles (LOD by distance / visibility).
//!
//! `cargo run --example anim_demo -- --play`. Control: `anim.list`, `anim.state`,
//! `anim.param {entity, name, value}`, `anim.play`, `anim.bones`, `anim.config`, `demo.cam
//! {name: hero|lineup|crowd}`. Screenshots: `python3 -I scripts/play.py <steps.json>
//! --example anim_demo`.

use std::f32::consts::TAU;

use bevy::winit::UpdateMode;
use engine::anim::mannequin::{MannequinVisual, RUN_SPEED, WALK_SPEED};
use engine::anim::*;
use engine::cli::{arg_value, has_flag};
use engine::prelude::*;
use engine::render_budget::FramePacing;

fn info() -> GameInfo {
    GameInfo::new("engine-anim-demo", "Anim demo").tagline("Code-first animation.")
}

#[derive(Component)]
struct Hero;

#[derive(Component)]
struct Orb;

#[derive(Component)]
struct Walker {
    speed: f32,
    turn: f32,
}

#[derive(Resource, Clone, Copy)]
struct CamPose(Vec3, Vec3);

/// The hero's area (the lineup stands at z = -6).
const HOME: Vec3 = Vec3::new(0.0, 0.0, 6.0);
/// `CamPose` value meaning "follow the hero".
const FOLLOW: CamPose = CamPose(Vec3::new(3.5, 2.0, -3.5), Vec3::NAN);

fn main() {
    let mut app = engine::app_with(info(), EngineOptions { ui: false, ..EngineOptions::from_args() });
    if has_flag("uncapped") {
        app.world_mut().resource_mut::<FramePacing>().gameplay.unfocused_mode = UpdateMode::Continuous;
        app.world_mut().resource_mut::<engine::settings::CoreSettings>().vsync = false;
    }
    app.insert_resource(FOLLOW)
        .add_systems(Startup, setup)
        .add_systems(Update, (drive_hero, drive_walkers, move_orb, follow_cam).run_if(in_game));
    #[cfg(feature = "devtools")]
    {
        use engine::devtools::{AddControlCommand, params};
        app.add_control_command("demo.cam", "Camera: hero|lineup|crowd|feet", params(&[("name", "string", "pose")]), |w, p| {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("hero").to_string();
            let pose = match name.as_str() {
                "hero" => FOLLOW,
                "lineup" => CamPose(Vec3::new(0.0, 1.5, -12.5), Vec3::new(0.0, 0.9, -6.0)),
                "feet" => CamPose(Vec3::new(-7.0, 0.9, -8.0), Vec3::new(-8.05, 0.35, -6.0)),
                "crowd" => CamPose(Vec3::new(0.0, 22.0, 30.0), Vec3::new(0.0, 0.0, -10.0)),
                _ => return Err(format!("unknown pose {name}")),
            };
            w.insert_resource(pose);
            Ok(serde_json::json!({"cam": name}))
        });
    }
    app.run();
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<StandardMaterial>>,
    mut clips: ResMut<Assets<AnimationClip>>,
    mut bindposes: ResMut<Assets<bevy::mesh::skinning::SkinnedMeshInverseBindposes>>,
) {
    engine::gfx::sky_and_sun_with(&mut commands, engine::gfx::SunSetup { atmosphere: false, direction: Vec3::new(-18.0, -26.0, 22.0), shadow_distance: 60.0, ..default() });
    commands.spawn((MainCamera, Camera3d::default(), bevy::camera::Exposure { ev100: 13.0 }, Transform::from_xyz(5.5, 3.2, 7.5).looking_at(Vec3::Y, Vec3::Y)));

    let ground_mat = mats.add(StandardMaterial { base_color: Color::srgb(0.42, 0.45, 0.4), perceptual_roughness: 0.9, ..default() });
    let step_mat = mats.add(StandardMaterial { base_color: Color::srgb(0.6, 0.5, 0.4), perceptual_roughness: 0.8, ..default() });
    let mut solid = |c: &mut Commands, size: Vec3, at: Vec3, m: &Handle<StandardMaterial>| {
        let mut e = c.spawn((Mesh3d(meshes.add(Cuboid::from_size(size))), MeshMaterial3d(m.clone()), Transform::from_translation(at), Scenery));
        #[cfg(feature = "physics")]
        e.insert((engine::avian3d::prelude::RigidBody::Static, engine::avian3d::prelude::Collider::cuboid(size.x, size.y, size.z)));
        let _ = &mut e;
    };
    solid(&mut commands, Vec3::new(120.0, 0.2, 120.0), Vec3::new(0.0, -0.1, 0.0), &ground_mat);
    // A step under one foot of the foot-placement mannequin (its left foot, at -X).
    solid(&mut commands, Vec3::new(0.3, 0.22, 0.7), Vec3::new(-8.12, 0.11, -6.0), &step_mat);

    let c = Mannequin::clips(&mut clips);
    let def = Mannequin::graph(&c);
    let visual = Mannequin::visual(&mut meshes, &mut bindposes, &mut mats);

    // Hero.
    let hero = Mannequin::spawn(&mut commands, def.clone(), Transform::from_xyz(0.0, 0.0, 6.0), Some(&visual));
    commands.entity(hero.root).insert((Hero, Name::new("Hero"), RootMotion::default()));
    commands.entity(hero.bone("Head")).insert(LookAt::new(Vec3::new(0.0, 2.0, -3.0)).max_angle(1.1).weight(0.9));
    commands.entity(hero.bone("Antenna1")).insert(SpringBone::new(90.0, 5.0));
    commands.entity(hero.bone("Antenna2")).insert(SpringBone::new(70.0, 4.0));
    commands.spawn((
        Orb,
        Mesh3d(meshes.add(Sphere::new(0.15))),
        MeshMaterial3d(mats.add(StandardMaterial { base_color: Color::srgb(1.0, 0.8, 0.3), emissive: LinearRgba::rgb(4.0, 3.0, 0.8), ..default() })),
        Transform::from_xyz(0.0, 2.0, -3.0),
    ));

    // Lineup: each clip alone (no root motion: walking in place), 1.6 m apart at z = -6.
    let lineup: [(&str, &[(&str, f32)]); 7] = [
        ("idle", &[]),
        ("walk", &[("vel_z", WALK_SPEED)]),
        ("run", &[("vel_z", RUN_SPEED)]),
        ("strafe", &[("vel_x", 1.2)]),
        ("back", &[("vel_z", -1.1)]),
        ("wave", &[("wave", 1.0)]),
        ("lean", &[("lean", 1.0)]),
    ];
    for (i, (name, params)) in lineup.iter().enumerate() {
        let x = (i as f32 - 3.0) * 1.6;
        let m = Mannequin::spawn(&mut commands, def.clone(), Transform::from_xyz(x, 0.0, -6.0), Some(&visual));
        commands.entity(m.root).insert((Name::new(format!("lineup_{name}")), Params(params.iter().map(|(k, v)| (k.to_string(), *v)).collect())));
    }

    // Foot placement on the step.
    let fp = Mannequin::spawn(&mut commands, def.clone(), Transform::from_xyz(-8.0, 0.0, -6.0), Some(&visual));
    commands.entity(fp.root).insert(Name::new("feet"));
    #[cfg(feature = "physics")]
    {
        let (l, r) = (fp.bone("LeftFoot"), fp.bone("RightFoot"));
        for f in [l, r] {
            commands.entity(f).insert(TwoBoneIk::new(Vec3::ZERO).weight(0.0).pole(Vec3::new(-8.0, 0.5, -9.5)));
        }
        commands.entity(fp.root).insert(FootPlacement::new(vec![l, r], Some(fp.bone("Hips"))));
    }

    // Crowd.
    let n: usize = arg_value("crowd").and_then(|v| v.parse().ok()).unwrap_or(0);
    let side = (n as f32).sqrt().ceil() as usize;
    for i in 0..n {
        let (gx, gz) = ((i % side) as f32, (i / side) as f32);
        let at = Vec3::new((gx - side as f32 * 0.5) * 3.0, 0.0, -12.0 - gz * 3.0);
        let m = Mannequin::spawn(&mut commands, def.clone(), Transform::from_translation(at).with_rotation(Quat::from_rotation_y(i as f32)), Some(&visual));
        let speed = 1.0 + (i % 5) as f32 * 0.6;
        commands.entity(m.root).insert((Name::new(format!("crowd_{i}")), RootMotion::default(), Walker { speed, turn: 0.4 + (i % 3) as f32 * 0.2 }));
    }
    commands.insert_resource(Visual(visual));
}

#[derive(Resource)]
#[allow(dead_code)]
struct Visual(MannequinVisual);

#[derive(Component)]
struct Params(Vec<(String, f32)>);

fn drive_hero(time: Res<Time>, mut q: Query<(&mut Animator, &mut Transform), With<Hero>>, mut lineup: Query<(&mut Animator, &Params), Without<Hero>>) {
    let t = time.elapsed_secs();
    for (mut a, p) in &mut lineup {
        for (k, v) in &p.0 {
            a.set_float(k, *v);
        }
    }
    let Ok((mut a, mut tf)) = q.single_mut() else { return };
    // Speed cycles idle → walk → run → walk; steering makes a figure eight.
    let phase = (t / 12.0).fract();
    let speed = match phase {
        p if p < 0.1 => 0.0,
        p if p < 0.45 => WALK_SPEED,
        p if p < 0.75 => RUN_SPEED * 0.9,
        _ => WALK_SPEED,
    };
    let cur = a.float("vel_z");
    let v = cur + (speed - cur) * (1.0 - (-3.0 * time.delta_secs()).exp());
    a.set_float("vel_z", v);
    let turn = (t * TAU / 12.0).sin() * 0.9 * (v / RUN_SPEED).min(1.0);
    tf.rotate_y(turn * time.delta_secs());
    a.set_float("lean", (turn.abs() * 0.9).min(1.0));
    let wave = ((t * 0.5).sin() * 2.0).clamp(0.0, 1.0);
    a.set_float("wave", wave);
    if (t % 7.0) < time.delta_secs() && t > 1.0 {
        a.trigger("hit");
    }
    // Keep the hero near the centre.
    if tf.translation.distance(HOME) > 9.0 {
        tf.translation = HOME;
    }
}

fn drive_walkers(time: Res<Time>, mut q: Query<(&mut Animator, &mut Transform, &Walker)>) {
    for (mut a, mut tf, w) in &mut q {
        a.set_float("vel_z", w.speed);
        tf.rotate_y(w.turn * time.delta_secs());
    }
}

fn move_orb(time: Res<Time>, mut orb: Query<&mut Transform, With<Orb>>, hero: Query<&Transform, (With<Hero>, Without<Orb>)>, mut heads: Query<&mut LookAt>) {
    let t = time.elapsed_secs();
    let Ok(mut o) = orb.single_mut() else { return };
    let centre = hero.single().map(|h| h.translation).unwrap_or_default();
    o.translation = centre + Vec3::new((t * 0.7).cos() * 2.5, 1.9 + (t * 1.3).sin() * 0.4, (t * 0.7).sin() * 2.5);
    for mut la in &mut heads {
        la.target = o.translation;
    }
}

fn follow_cam(pose: Res<CamPose>, hero: Query<&Transform, With<Hero>>, mut cam: Query<&mut Transform, (With<MainCamera>, Without<Hero>)>) {
    let Ok(mut c) = cam.single_mut() else { return };
    let (eye, at) = match (pose.1.is_nan(), hero.single()) {
        (true, Ok(h)) => (h.translation + pose.0, h.translation + Vec3::Y),
        _ => (pose.0, pose.1),
    };
    *c = Transform::from_translation(eye).looking_at(at, Vec3::Y);
}
