//! Render budget stress scene: a 300×300 m city (buildings and walls that occlude, thousands of
//! small props, ground tiles) with 20 moving actors and a camera walking a loop at eye height.
//!
//! `cargo run --example render_budget -- --play [flags]`
//!
//! - `--stream respawn|hide|none` (default respawn): scenery registered as data and streamed by
//!   cell / spawned then hidden by cell / spawned and left alone.
//! - `--budget off`: start with every optimisation off (toggle at runtime with the
//!   `render.budget` control command, read counters with `render.stats`).
//! - `--idle-skip`: turn idle skip on. `--pose street|overview|yard`: camera stands still there
//!   (control command `cam.pose {name}` switches at runtime; `walk` resumes the loop). `--no-actors`.
//! - `--untagged`: no `Actor`/`Scenery` tags at all (use with `--stream none`): the engine's
//!   zero-config classification must give the same savings.
//! - `--props <n>` (default 4000). `--uncapped`: vsync off and full speed while unfocused
//!   (for frame-time measurements in hidden `--offscreen` windows).
//!
//! Colliders (with `physics`) are spawned once for buildings and walls, outside streaming.

use std::f32::consts::TAU;

use bevy::image::{ImageAddressMode, ImageSampler, ImageSamplerDescriptor};
use bevy::pbr::{DistanceFog, FogFalloff};
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};
use bevy::asset::RenderAssetUsages;
use engine::cli::{arg_value, has_flag};
use engine::prelude::*;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

const HALF: f32 = 150.0;
const BLOCK: f32 = 30.0;
const FOG: Color = Color::srgb(0.62, 0.66, 0.72);

fn info() -> GameInfo {
    GameInfo::new("render-budget", "Render budget").tagline("A big city, drawn on a budget.")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum StreamMode {
    Respawn,
    Hide,
    None,
}

#[derive(Component)]
struct Walker {
    center: Vec3,
    radius: f32,
    speed: f32,
    phase: f32,
}

#[derive(Component)]
struct CamPath;

/// Fixed camera pose (`None` = walk the loop).
#[derive(Resource, Default)]
struct Pose(Option<Transform>);

fn pose(name: &str) -> Option<Option<Transform>> {
    Some(match name {
        "walk" => None,
        // Street level, looking 280 m down the street at x = 0.
        "street" => Some(Transform::from_xyz(0.5, 1.7, -140.0).looking_to(Vec3::new(0.08, 0.0, 1.0), Vec3::Y)),
        // Above a corner, looking over the whole city.
        "overview" => Some(Transform::from_xyz(-160.0, 35.0, -160.0).looking_at(Vec3::new(0.0, 0.0, 0.0), Vec3::Y)),
        // Inside a walled yard: the walls hide almost everything.
        "yard" => Some(Transform::from_xyz(-139.0, 1.7, -137.0).looking_to(Vec3::new(1.0, 0.0, 0.25), Vec3::Y)),
        _ => return None,
    })
}

fn main() {
    // The scene needs no menus (and the UI kit may not exist on every branch).
    let mut app = engine::app_with(info(), EngineOptions { ui: false, ..EngineOptions::from_args() });
    let mode = match arg_value("stream").as_deref() {
        Some("hide") => StreamMode::Hide,
        Some("none") => StreamMode::None,
        _ => StreamMode::Respawn,
    };
    {
        let mut b = app.world_mut().resource_mut::<RenderBudget>();
        b.stream_spawned_scenery = mode == StreamMode::Hide;
        if has_flag("idle-skip") {
            b.idle_skip = true;
        }
        if arg_value("budget").as_deref() == Some("off") {
            b.occlusion_culling = false;
            b.scenery_detail = false;
            b.shadow_trim = false;
            b.streaming = false;
            b.stream_spawned_scenery = false;
        }
    }
    // Scenery is gone where the fog is opaque, so the view edge is invisible.
    app.insert_resource(SceneryRanges { view: 200.0, ..default() });
    let start = arg_value("pose").and_then(|p| pose(&p)).unwrap_or_default();
    #[cfg(feature = "devtools")]
    {
        use engine::devtools::{AddControlCommand, params};
        app.add_control_command("cam.pose", "Camera pose: walk|street|overview|yard", params(&[("name", "string", "pose")]), |w, p| {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("walk").to_string();
            let tf = pose(&name).ok_or_else(|| format!("unknown pose {name}"))?;
            w.resource_mut::<Pose>().0 = tf;
            Ok(serde_json::json!({"pose": name}))
        });
    }
    app.insert_resource(Mode(mode))
        .insert_resource(Pose(start))
        .insert_resource(ClearColor(FOG))
        .add_systems(OnEnter(AppState::InGame), spawn_city)
        .add_systems(Update, (walk, move_camera).run_if(in_game).run_if(not_paused))
        .run();
}

#[derive(Resource)]
struct Mode(StreamMode);

/// A tiling RGBA8 texture: blocky noise around `base`.
fn texture(images: &mut Assets<Image>, rng: &mut StdRng, base: [u8; 3], cells: usize) -> Handle<Image> {
    let n = 64;
    let mut data = vec![0u8; n * n * 4];
    let shades: Vec<f32> = (0..cells * cells).map(|_| rng.random_range(0.7..1.15)).collect();
    for y in 0..n {
        for x in 0..n {
            let s = shades[(y * cells / n) * cells + x * cells / n] * if x % (n / cells) == 0 || y % (n / cells) == 0 { 0.6 } else { 1.0 };
            let i = (y * n + x) * 4;
            for c in 0..3 {
                data[i + c] = (base[c] as f32 * s).min(255.0) as u8;
            }
            data[i + 3] = 255;
        }
    }
    let mut img = Image::new(Extent3d { width: n as u32, height: n as u32, depth_or_array_layers: 1 }, TextureDimension::D2, data, TextureFormat::Rgba8UnormSrgb, RenderAssetUsages::all());
    img.sampler = ImageSampler::Descriptor(ImageSamplerDescriptor { address_mode_u: ImageAddressMode::Repeat, address_mode_v: ImageAddressMode::Repeat, ..ImageSamplerDescriptor::linear() });
    images.add(img)
}

/// What one scenery piece looks like (cloned into streaming closures).
#[derive(Clone)]
struct Piece {
    mesh: Handle<Mesh>,
    mat: Handle<StandardMaterial>,
    tf: Transform,
    name: &'static str,
}

static UNTAGGED: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| has_flag("untagged"));

impl Piece {
    fn spawn(&self, c: &mut Commands) -> Entity {
        let mut e = c.spawn((Name::new(self.name), Mesh3d(self.mesh.clone()), MeshMaterial3d(self.mat.clone()), self.tf));
        if !*UNTAGGED {
            e.insert(Scenery);
        }
        e.id()
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_city(
    mut commands: Commands,
    mode: Res<Mode>,
    seed: Res<GameSeed>,
    headless: Res<Headless>,
    mut stream: ResMut<SceneryStream>,
    mut meshes: Option<ResMut<Assets<Mesh>>>,
    mut mats: Option<ResMut<Assets<StandardMaterial>>>,
    mut images: Option<ResMut<Assets<Image>>>,
) {
    let mut rng = StdRng::seed_from_u64(seed.0);
    let props: usize = arg_value("props").and_then(|s| s.parse().ok()).unwrap_or(4000);
    let (Some(meshes), Some(mats), Some(images)) = (meshes.as_mut(), mats.as_mut(), images.as_mut()) else {
        // Headless: colliders only.
        return;
    };

    let mut tex_mat = |rng: &mut StdRng, base: [u8; 3], cells: usize, rough: f32| {
        let t = texture(images, rng, base, cells);
        mats.add(StandardMaterial { base_color_texture: Some(t), perceptual_roughness: rough, ..default() })
    };
    let ground_mat = tex_mat(&mut rng, [92, 98, 88], 8, 0.95);
    let concrete = tex_mat(&mut rng, [150, 146, 138], 4, 0.9);
    let brick = tex_mat(&mut rng, [150, 82, 64], 16, 0.85);
    let wood = tex_mat(&mut rng, [140, 104, 62], 4, 0.8);
    let metal = mats.add(StandardMaterial { base_color: Color::srgb(0.32, 0.38, 0.45), metallic: 0.6, perceptual_roughness: 0.4, ..default() });
    let rock = mats.add(StandardMaterial { base_color: Color::srgb(0.45, 0.43, 0.40), perceptual_roughness: 1.0, ..default() });
    let actor_mat = mats.add(StandardMaterial { base_color: Color::srgb(0.85, 0.25, 0.2), ..default() });

    let cube = meshes.add(Cuboid::new(1.0, 1.0, 1.0));
    let barrel = meshes.add(Cylinder::new(0.5, 1.0));
    let ball = meshes.add(Sphere::new(0.5).mesh().ico(2).unwrap());
    let ground_tile = meshes.add(Cuboid::new(BLOCK, 0.2, BLOCK));

    let mut pieces: Vec<Piece> = Vec::new();
    let mut colliders: Vec<(Vec3, Vec3)> = Vec::new();
    let tiles = (2.0 * HALF / BLOCK) as i32;
    for ix in 0..tiles {
        for iz in 0..tiles {
            let c = Vec3::new(-HALF + (ix as f32 + 0.5) * BLOCK, -0.1, -HALF + (iz as f32 + 0.5) * BLOCK);
            pieces.push(Piece { mesh: ground_tile.clone(), mat: ground_mat.clone(), tf: Transform::from_translation(c), name: "ground" });
            // City block: streets 8 m wide around a 22 m lot.
            let lot = BLOCK - 8.0;
            if (ix + iz) % 3 == 0 {
                // Walled yard: four walls with a gap, open inside.
                let h = rng.random_range(3.0..5.0);
                for (dx, dz, sx, sz) in [(0.0, -0.5, lot, 0.5), (0.0, 0.5, lot * 0.6, 0.5), (-0.5, 0.0, 0.5, lot), (0.5, 0.0, 0.5, lot)] {
                    let size = Vec3::new(sx, h, sz);
                    let at = c + Vec3::new(dx * lot, h * 0.5 + 0.1, dz * lot);
                    pieces.push(Piece { mesh: cube.clone(), mat: brick.clone(), tf: Transform::from_translation(at).with_scale(size), name: "wall" });
                    colliders.push((at, size));
                }
            } else {
                let size = Vec3::new(rng.random_range(12.0..lot), rng.random_range(6.0..24.0), rng.random_range(12.0..lot));
                let at = c + Vec3::new(0.0, size.y * 0.5 + 0.1, 0.0);
                pieces.push(Piece { mesh: cube.clone(), mat: concrete.clone(), tf: Transform::from_translation(at).with_scale(size), name: "building" });
                colliders.push((at, size));
            }
        }
    }
    for _ in 0..props {
        let at = Vec3::new(rng.random_range(-HALF..HALF), 0.0, rng.random_range(-HALF..HALF));
        let yaw = Quat::from_rotation_y(rng.random_range(0.0..TAU));
        let p = match rng.random_range(0..3) {
            0 => {
                let s = rng.random_range(0.5..1.2);
                Piece { mesh: cube.clone(), mat: wood.clone(), tf: Transform::from_translation(at + Vec3::Y * s * 0.5).with_rotation(yaw).with_scale(Vec3::splat(s)), name: "crate" }
            }
            1 => Piece { mesh: barrel.clone(), mat: metal.clone(), tf: Transform::from_translation(at + Vec3::Y * 0.5).with_scale(Vec3::new(0.6, 1.0, 0.6)), name: "barrel" },
            _ => {
                let s = rng.random_range(0.3..0.9);
                Piece { mesh: ball.clone(), mat: rock.clone(), tf: Transform::from_translation(at + Vec3::Y * s * 0.3).with_scale(Vec3::splat(s)), name: "rock" }
            }
        };
        pieces.push(p);
    }

    for p in pieces {
        match mode.0 {
            StreamMode::Respawn => {
                let at = p.tf.translation;
                stream.add(at, move |c: &mut Commands| p.spawn(c));
            }
            StreamMode::Hide | StreamMode::None => {
                p.spawn(&mut commands);
            }
        }
    }
    // Colliders: once, never streamed.
    #[cfg(feature = "physics")]
    for (at, size) in &colliders {
        use engine::avian3d::prelude::{Collider, RigidBody};
        commands.spawn((Name::new("collider"), RigidBody::Static, Collider::cuboid(size.x, size.y, size.z), Transform::from_translation(*at)));
    }
    let _ = &colliders;

    if !has_flag("no-actors") {
        let body = meshes.add(Capsule3d::new(0.35, 1.1));
        let head = meshes.add(Sphere::new(0.22));
        for i in 0..20 {
            let center = Vec3::new(rng.random_range(-60.0..60.0), 0.0, rng.random_range(-60.0..60.0));
            let mut actor = commands.spawn((
                    Name::new(format!("actor {i}")),
                    Walker { center, radius: rng.random_range(3.0..12.0), speed: rng.random_range(0.3..0.8), phase: rng.random_range(0.0..TAU) },
                    Mesh3d(body.clone()),
                    MeshMaterial3d(actor_mat.clone()),
                    Transform::from_translation(center + Vec3::Y * 0.9),
                ));
            actor.with_child((Mesh3d(head.clone()), MeshMaterial3d(actor_mat.clone()), Transform::from_xyz(0.0, 0.85, 0.0)));
            if !*UNTAGGED {
                actor.insert(Actor);
            }
        }
    }

    // Shroud-like sun (as `gfx::sky_and_sun`, without the atmosphere: the fog colour is the sky).
    commands.spawn((
        Name::new("Sun"),
        DirectionalLight { illuminance: bevy::light::light_consts::lux::RAW_SUNLIGHT, shadow_maps_enabled: true, color: Color::srgb(1.0, 0.93, 0.84), ..default() },
        bevy::light::CascadeShadowConfigBuilder { num_cascades: 3, first_cascade_far_bound: 10.0, maximum_distance: 90.0, ..default() }.build(),
        Transform::from_xyz(-30.0, 22.0, 26.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    commands.insert_resource(GlobalAmbientLight { color: Color::srgb(0.7, 0.78, 0.95), brightness: 800.0, ..default() });
    if !headless.0 {
        commands.spawn((
            Name::new("camera"),
            MainCamera,
            CamPath,
            Camera3d::default(),
            bevy::camera::Exposure { ev100: 13.0 },
            DistanceFog { color: FOG, falloff: FogFalloff::Linear { start: 90.0, end: 200.0 }, ..default() },
            Transform::from_xyz(-4.0, 1.7, 0.0).looking_to(Vec3::Z, Vec3::Y),
        ));
    }
}

fn walk(time: Res<Time>, mut q: Query<(&Walker, &mut Transform)>) {
    let t = time.elapsed_secs();
    for (w, mut tf) in &mut q {
        let a = w.phase + t * w.speed;
        tf.translation = w.center + Vec3::new(a.cos() * w.radius, 0.9, a.sin() * w.radius);
        tf.rotation = Quat::from_rotation_y(-a);
    }
}

/// Walks a 110 m-radius loop along the streets at 6 m/s, looking ahead with a slow sway.
fn move_camera(time: Res<Time>, pose: Res<Pose>, mut q: Query<&mut Transform, With<CamPath>>) {
    if let Some(p) = pose.0 {
        for mut tf in &mut q {
            if *tf != p {
                *tf = p;
            }
        }
        return;
    }
    let t = time.elapsed_secs();
    let r = 4.0 * BLOCK - 4.0; // along the streets
    let a = t * 6.0 / r;
    for mut tf in &mut q {
        let pos = Vec3::new(a.cos() * r, 1.7, a.sin() * r);
        let ahead = Vec3::new(-a.sin(), 0.0, a.cos());
        let sway = Quat::from_rotation_y((t * 0.4).sin() * 0.6);
        tf.translation = pos;
        tf.look_to(sway * ahead, Vec3::Y);
    }
}
