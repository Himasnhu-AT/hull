//! Terrain editing: noise terrain you sculpt and paint through the control port.
//!
//! `python3 -I scripts/play.py scripts/terrain-edit.json --example terrain_edit`
//!
//! Flags: `--size <m>` (default 1000, 2 m samples), `--chunk <quads>` (default 64).
//! Control (besides the `terrain.*` commands): `cam.set {pos: [x,y,z], target: [x,y,z]}`,
//! `terrain.bench {dabs?, radius?, kind?}` (times random dabs: brush math, rebuild, total).

use engine::cli::arg_value;
use engine::prelude::*;
use engine::world::*;

fn info() -> GameInfo {
    GameInfo::new("terrain-edit", "Terrain edit").tagline("Sculpt and paint a heightfield.")
}

fn main() {
    let mut app = engine::app_with(info(), EngineOptions { ui: false, ..EngineOptions::from_args() });
    {
        let mut s = app.world_mut().resource_mut::<WorldSettings>();
        s.streaming.mode = StreamMode::Resident;
        s.hlod.enabled = false;
    }
    #[cfg(feature = "devtools")]
    {
        use engine::devtools::{AddControlCommand, params};
        app.add_control_command("cam.set", "Place the camera: pos [x,y,z], target [x,y,z]", params(&[("pos", "array", "position"), ("target", "array", "look at")]), |w, p| {
            let v3 = |k: &str| -> Result<Vec3, String> {
                let a = p.get(k).and_then(|v| v.as_array()).ok_or(format!("`{k}` [x, y, z] required"))?;
                let f = |i: usize| a.get(i).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                Ok(Vec3::new(f(0), f(1), f(2)))
            };
            let (pos, target) = (v3("pos")?, v3("target")?);
            for mut tf in w.query_filtered::<&mut Transform, With<MainCamera>>().iter_mut(w) {
                *tf = Transform::from_translation(pos).looking_at(target, Vec3::Y);
            }
            Ok(serde_json::json!({"ok": true}))
        });
        app.add_control_command(
            "terrain.bench",
            "Time random brush dabs on the live terrain",
            params(&[("dabs", "number", "count (default 200)"), ("radius", "number", "metres (default 20)"), ("kind", "string", "raise|smooth|flatten|noise|paint (default raise)")]),
            bench,
        );
    }
    app.insert_resource(ClearColor(Color::srgb(0.62, 0.72, 0.84))).add_systems(OnEnter(AppState::InGame), setup).run();
}

#[cfg(feature = "devtools")]
fn bench(world: &mut World, p: serde_json::Value) -> Result<serde_json::Value, String> {
    let dabs = p.get("dabs").and_then(|v| v.as_u64()).unwrap_or(200) as usize;
    let radius = p.get("radius").and_then(|v| v.as_f64()).unwrap_or(20.0) as f32;
    let kind = match p.get("kind").and_then(|v| v.as_str()).unwrap_or("raise") {
        "smooth" => BrushKind::Smooth,
        "flatten" => BrushKind::Flatten,
        "noise" => BrushKind::Noise,
        "paint" => BrushKind::Paint,
        _ => BrushKind::Raise,
    };
    let (lo, hi) = world.get_resource::<Terrain>().ok_or("no terrain")?.bounds();
    let s = BrushSettings { kind, radius, strength: 0.05, pick_target: true, ..default() };
    let mut state = 12345u64;
    let mut rnd = || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (state >> 33) as f32 / (1u64 << 31) as f32
    };
    let (mut total, mut rebuild, mut chunks) = (Vec::new(), Vec::new(), 0u64);
    for _ in 0..dabs {
        // Keep dabs inside the map so edge chunks don't skew the numbers.
        let at = Vec2::new(lo.x + radius + rnd() * (hi.x - lo.x - 2.0 * radius), lo.y + radius + rnd() * (hi.y - lo.y - 2.0 * radius));
        let t0 = std::time::Instant::now();
        TerrainEdit::dab(world, &s, at).map_err(|e| e.to_string())?;
        total.push(t0.elapsed().as_secs_f32() * 1e6);
        let st = engine::world::edit::edit_stats(world);
        let height = kind != BrushKind::Paint;
        rebuild.push(if height { st.last_rebuild_us } else { 0.0 });
        chunks += if height { st.last_chunks as u64 } else { 0 };
    }
    let pct = |v: &mut Vec<f32>, q: f32| {
        v.sort_by(|a, b| a.total_cmp(b));
        v[((v.len() - 1) as f32 * q) as usize]
    };
    let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len().max(1) as f32;
    let (mt, mr) = (mean(&total), mean(&rebuild));
    Ok(serde_json::json!({
        "dabs": dabs, "radius": radius, "kind": format!("{kind:?}"),
        "total_us": {"mean": mt, "p50": pct(&mut total, 0.5), "p95": pct(&mut total, 0.95), "max": pct(&mut total, 1.0)},
        "rebuild_us": {"mean": mr, "p95": pct(&mut rebuild, 0.95)},
        "brush_and_write_us_mean": mt - mr,
        "chunks_per_dab": chunks as f32 / dabs as f32,
    }))
}

fn setup(world: &mut World) {
    let size: f32 = arg_value("size").and_then(|s| s.parse().ok()).unwrap_or(1000.0);
    let chunk: u32 = arg_value("chunk").and_then(|s| s.parse().ok()).unwrap_or(64);
    let n = (size / 2.0) as u32 + 1;
    let noise = NoiseTerrain { fbm: Fbm { seed: 11, frequency: 0.0016, octaves: 5, warp: 60.0, ..default() }, amplitude: 70.0, base: 0.0, exponent: 1.6, border_falloff: 0.0 };
    let hf = Heightfield::from_noise(n, n, 2.0, Vec2::splat(-size * 0.5), &noise);
    let mut desc = WorldDesc { seed: 5, terrain: engine::world::desc::TerrainDesc { size: [size, size], spacing: 2.0, chunk_quads: chunk, ..default() }, ..default() };
    // Four paintable layers: grass, dirt, gravel, snow (all rule-free after the first generation).
    let mut layers = engine::world::material::default_layers();
    layers[1] = SplatLayer { name: "dirt".into(), color: [0.45, 0.33, 0.2], slope: [30.0, 90.0], blend: 8.0, weight: 3.0, ..default() };
    layers[2] = SplatLayer { name: "gravel".into(), color: [0.6, 0.58, 0.54], height: [-1e6, -1e5], weight: 0.0, ..default() };
    layers[3] = SplatLayer { name: "paint".into(), color: [0.85, 0.2, 0.15], height: [1e5, 1e6], weight: 0.0, ..default() };
    desc.terrain.layers = layers;
    if let Err(e) = engine::world::desc::spawn_world_with(world, desc, Some(hf)) {
        error!("terrain_edit: {e}");
        return;
    }
    let mut commands = world.commands();
    engine::gfx::sky_and_sun_with(
        &mut commands,
        engine::gfx::SunSetup { direction: Vec3::new(0.5, -0.5, 0.35), cascades: 3, first_cascade: 20.0, shadow_distance: 500.0, atmosphere: false, fallback_sky: Color::srgb(0.62, 0.72, 0.84), ambient_brightness: 900.0, ..default() },
    );
    if !world.resource::<Headless>().0 {
        let h = world.resource::<Terrain>().height_at(0.0, 0.0);
        world.spawn((
            Name::new("camera"),
            MainCamera,
            Camera3d::default(),
            Projection::Perspective(PerspectiveProjection { far: 4000.0, ..default() }),
            bevy::camera::Exposure { ev100: 13.0 },
            Transform::from_xyz(-160.0, h + 110.0, -220.0).looking_at(Vec3::new(0.0, h, 0.0), Vec3::Y),
        ));
    }
    world.flush();
}
