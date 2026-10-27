//! Every VFX preset on one dark ground, replaying one-shots, plus a stress mode for measurements.
//!
//! ```text
//! cargo run --example vfx_gallery                       # all presets, orbiting camera
//! cargo run --example vfx_gallery -- --preset fire      # one preset, close up
//! cargo run --example vfx_gallery -- --stress 100000    # 100k particles (+ --uncapped: vsync off)
//! cargo run --example vfx_gallery -- --many 200         # 200 looping effects on a grid
//! python3 -I scripts/play.py steps.json --example vfx_gallery -- --preset explosion
//! ```
//!
//! Control commands (besides the engine's `vfx.*`): `gallery.focus {preset}` frames one preset
//! (camera + replays it), `gallery.stress {count}` replaces the scene's effects with `count`
//! particles, `gallery.camera {pos, look}`.

use engine::prelude::*;
use engine::vfx::{ParticleEffect, presets};

pub fn info() -> GameInfo {
    GameInfo::new("engine-vfx-gallery", "VFX Gallery").tagline("Particles, code first.")
}

/// Preset slots on the ground (x, z) and whether they are one-shots that the gallery replays.
const SLOTS: &[(&str, f32, f32)] = &[
    ("sparks", -9.0, -4.0),
    ("smoke", -4.5, -6.0),
    ("fire", 0.0, -5.0),
    ("muzzle_flash", 4.5, -4.0),
    ("explosion", 9.0, -8.0),
    ("dust_puff", -6.0, 1.0),
    ("magic", 0.0, 1.0),
];

#[derive(Resource, Clone, Copy)]
struct CamPose {
    pos: Vec3,
    look: Vec3,
    orbit: bool,
}

#[derive(Resource)]
struct Replay(Timer);

/// A gallery effect (one-shots among them are replayed).
#[derive(Component)]
struct Slot;

/// Flies a small circle around its centre.
#[derive(Component)]
struct Mover(Vec3);

pub struct GalleryPlugin;

impl Plugin for GalleryPlugin {
    fn build(&self, app: &mut App) {
        let preset = arg_value("preset");
        let stress = arg_value("stress").and_then(|s| s.parse::<u32>().ok());
        let weather = arg_value("weather");
        let many = arg_value("many").and_then(|s| s.parse::<u32>().ok());
        let pose = match (&preset, stress.or(many)) {
            (_, Some(_)) => CamPose { pos: Vec3::new(0.0, 6.0, 16.0), look: Vec3::new(0.0, 4.0, 0.0), orbit: false },
            (Some(p), _) => focus_pose(p),
            _ => CamPose { pos: Vec3::new(0.0, 7.0, 15.0), look: Vec3::new(0.0, 1.0, -2.0), orbit: false },
        };
        app.insert_resource(pose)
            .insert_resource(Replay(Timer::from_seconds(2.5, TimerMode::Repeating)))
            .insert_resource(ClearColor(Color::srgb(0.05, 0.06, 0.08)))
            .add_systems(OnEnter(AppState::InGame), move |mut commands: Commands, mut vfx: Vfx, meshes: Option<ResMut<Assets<Mesh>>>, mats: Option<ResMut<Assets<StandardMaterial>>>| {
                world(&mut commands, meshes, mats);
                if let Some(n) = many {
                    spawn_many(&mut commands, n);
                } else if let Some(n) = stress {
                    spawn_stress(&mut commands, n);
                } else if let Some(p) = &preset {
                    spawn_one(&mut commands, &mut vfx, p);
                } else {
                    for (name, x, z) in SLOTS {
                        spawn_slot(&mut commands, name, Vec3::new(*x, 0.0, *z));
                    }
                }
                if let Some(w) = &weather {
                    commands.spawn((ParticleEffect::new(w.clone()), Transform::default()));
                }
            })
            .add_systems(Update, (replay, move_magic, camera).run_if(in_game));
        #[cfg(feature = "devtools")]
        {
            use engine::devtools::{AddControlCommand, params};
            app.add_control_command("gallery.focus", "Frame one preset and replay it", params(&[("preset", "string", "effect name")]), |w, p| {
                let name = p.get("preset").and_then(|v| v.as_str()).ok_or("missing preset")?.to_string();
                engine::vfx::clear_all(w);
                *w.resource_mut::<CamPose>() = focus_pose(&name);
                let at = Transform::from_translation(focus_point(&name));
                if is_one_shot(w, &name) {
                    engine::vfx::play_world(w, &name, at, Some(7));
                } else {
                    w.spawn((Slot, at, ParticleEffect::new(name.clone()).seeded(7)));
                }
                Ok(serde_json::json!({"preset": name}))
            });
            app.add_control_command("gallery.stress", "Replace the scene's effects with N particles", params(&[("count", "integer", "particles")]), |w, p| {
                let n = p.get("count").and_then(|v| v.as_u64()).unwrap_or(10_000) as u32;
                engine::vfx::clear_all(w);
                w.resource_mut::<engine::vfx::VfxBudget>().max_particles = n.max(200_000);
                *w.resource_mut::<CamPose>() = CamPose { pos: Vec3::new(0.0, 6.0, 16.0), look: Vec3::new(0.0, 4.0, 0.0), orbit: false };
                let def = EffectDef { name: format!("stress_{n}"), ..presets::stress(n) };
                let name = def.name.clone();
                w.resource_mut::<VfxLibrary>().register(def)?;
                w.spawn((Transform::from_xyz(0.0, 4.0, 0.0), ParticleEffect::new(name).seeded(1)));
                Ok(serde_json::json!({"count": n}))
            });
            app.add_control_command(
                "gallery.camera",
                "Place the camera",
                params(&[("pos", "array", "[x,y,z]"), ("look", "array", "[x,y,z] target"), ("orbit", "boolean", "slowly orbit the target")]),
                |w, p| {
                    let v = |k: &str| {
                        p.get(k).and_then(|a| a.as_array()).map(|a| {
                            let f = |i: usize| a.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
                            Vec3::new(f(0), f(1), f(2))
                        })
                    };
                    let mut c = w.resource_mut::<CamPose>();
                    if let Some(pos) = v("pos") {
                        c.pos = pos;
                    }
                    if let Some(look) = v("look") {
                        c.look = look;
                    }
                    c.orbit = p.get("orbit").and_then(|o| o.as_bool()).unwrap_or(false);
                    Ok(serde_json::json!({"ok": true}))
                },
            );
        }
    }
}

#[cfg(feature = "devtools")]
fn is_one_shot(w: &World, name: &str) -> bool {
    w.resource::<VfxLibrary>().get(name).is_some_and(|fx| fx.def.duration > 0.0 && !fx.def.looping)
}

fn focus_point(name: &str) -> Vec3 {
    match name {
        "muzzle_flash" => Vec3::new(0.0, 1.5, 0.0),
        "magic" => Vec3::new(0.0, 1.5, 0.0),
        "sparks" => Vec3::new(0.0, 1.0, 0.0),
        _ => Vec3::ZERO,
    }
}

fn focus_pose(name: &str) -> CamPose {
    let look = focus_point(name) + Vec3::Y * 0.8;
    let pos = match name {
        "explosion" => Vec3::new(0.0, 3.5, 9.0),
        "muzzle_flash" => Vec3::new(1.6, 1.9, 0.6),
        "rain" | "snow" => Vec3::new(0.0, 1.7, 6.0),
        "dust_puff" => Vec3::new(0.0, 1.2, 2.2),
        "smoke" => Vec3::new(0.0, 2.5, 6.0),
        _ => Vec3::new(0.0, 2.0, 3.5),
    };
    CamPose { pos, look: if matches!(name, "rain" | "snow") { Vec3::new(0.0, 1.5, 0.0) } else { look }, orbit: false }
}

fn world(commands: &mut Commands, meshes: Option<ResMut<Assets<Mesh>>>, mats: Option<ResMut<Assets<StandardMaterial>>>) {
    if let (Some(mut meshes), Some(mut mats)) = (meshes, mats) {
        commands.spawn((
            Mesh3d(meshes.add(Plane3d::default().mesh().size(80.0, 80.0))),
            MeshMaterial3d(mats.add(StandardMaterial { base_color: Color::srgb(0.16, 0.17, 0.16), perceptual_roughness: 0.95, ..default() })),
            Transform::default(),
        ));
        // A few blocks so soft particles / collisions have something to meet.
        for (x, z, h) in [(-11.0, -9.0, 3.0), (6.5, -10.0, 2.0), (12.0, -2.0, 1.0)] {
            commands.spawn((
                Mesh3d(meshes.add(Cuboid::new(2.0, h, 2.0))),
                MeshMaterial3d(mats.add(StandardMaterial { base_color: Color::srgb(0.3, 0.3, 0.32), ..default() })),
                Transform::from_xyz(x, h * 0.5, z),
            ));
        }
        commands.spawn((
            DirectionalLight { illuminance: 6_000.0, shadow_maps_enabled: true, ..default() },
            Transform::from_xyz(-4.0, 9.0, 5.0).looking_at(Vec3::ZERO, Vec3::Y),
        ));
        commands.insert_resource(GlobalAmbientLight { brightness: 300.0, ..default() });
        commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 7.0, 15.0).looking_at(Vec3::new(0.0, 1.0, -2.0), Vec3::Y)));
    } else {
        commands.spawn((MainCamera, Transform::from_xyz(0.0, 7.0, 15.0).looking_at(Vec3::new(0.0, 1.0, -2.0), Vec3::Y)));
    }
}

fn spawn_slot(commands: &mut Commands, name: &'static str, at: Vec3) {
    let tf = Transform::from_translation(at + focus_point(name));
    let mut e = commands.spawn((Slot, tf, ParticleEffect::new(name).on_finish(engine::vfx::OnFinish::Keep)));
    if name == "magic" {
        e.insert(Mover(tf.translation));
    }
}

fn spawn_one(commands: &mut Commands, _vfx: &mut Vfx, name: &str) {
    let tf = Transform::from_translation(focus_point(name));
    let mut e = commands.spawn((Slot, tf, ParticleEffect::new(name.to_string()).seeded(7).on_finish(engine::vfx::OnFinish::Keep)));
    if name == "magic" {
        e.insert(Mover(tf.translation));
    }
}

fn spawn_stress(commands: &mut Commands, n: u32) {
    commands.queue(move |w: &mut World| {
        w.resource_mut::<engine::vfx::VfxBudget>().max_particles = n.max(200_000);
        let def = EffectDef { name: format!("stress_{n}"), ..presets::stress(n) };
        let name = def.name.clone();
        w.resource_mut::<VfxLibrary>().register(def).expect("stress compiles");
        w.spawn((Transform::from_xyz(0.0, 4.0, 0.0), ParticleEffect::new(name).seeded(1)));
    });
}

/// `n` looping effects (fire, smoke, sparks, magic) on a grid: many small emitters, the
/// typical game load (measures per-effect overhead and the parallel simulation/build).
fn spawn_many(commands: &mut Commands, n: u32) {
    let kinds = ["fire", "smoke", "sparks", "magic"];
    let side = (n as f32).sqrt().ceil() as u32;
    for i in 0..n {
        let (x, z) = ((i % side) as f32 - side as f32 * 0.5, (i / side) as f32 - side as f32 * 0.5);
        let name = kinds[i as usize % kinds.len()];
        commands.spawn((Transform::from_xyz(x * 2.5, 0.0, z * 2.5 - 4.0), ParticleEffect::new(name).seeded(i as u64)));
    }
}

/// One-shots that finished (`OnFinish::Keep` → idle) are replayed every 2.5 s.
fn replay(mut commands: Commands, time: Res<Time>, mut timer: ResMut<Replay>, q: Query<(Entity, &engine::vfx::VfxInstance), With<Slot>>) {
    if !timer.0.tick(time.delta()).just_finished() {
        return;
    }
    for (e, inst) in &q {
        if inst.idle {
            commands.entity(e).insert(engine::vfx::VfxRestart);
        }
    }
}

/// The magic orb flies a small circle so its per-metre trail shows.
fn move_magic(time: Res<Time>, mut q: Query<(&mut Transform, &Mover)>) {
    let t = time.elapsed_secs() * 1.5;
    for (mut tf, m) in &mut q {
        tf.translation = m.0 + Vec3::new(t.cos() * 1.2, 0.3 * (t * 2.0).sin(), t.sin() * 1.2);
    }
}

fn camera(time: Res<Time<Real>>, pose: Res<CamPose>, mut q: Query<&mut Transform, With<MainCamera>>) {
    for mut tf in &mut q {
        let mut pos = pose.pos;
        if pose.orbit {
            let a = time.elapsed_secs() * 0.2;
            let d = pose.pos - pose.look;
            pos = pose.look + Quat::from_rotation_y(a) * d;
        }
        *tf = Transform::from_translation(pos).looking_at(pose.look, Vec3::Y);
    }
}

#[allow(dead_code)]
fn main() {
    let mut app = engine::app_with(info(), EngineOptions { ui: false, ..EngineOptions::from_args() });
    app.add_plugins(GalleryPlugin).run();
}
