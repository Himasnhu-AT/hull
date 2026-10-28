//! Pipeline warm-up: compile every material's shaders during a load, not mid-play.
//!
//! Bevy compiles a render pipeline the first time a (mesh layout, material, view) combination is
//! drawn, and on macOS it compiles synchronously: the first muzzle flash, impact decal or enemy
//! material in a round stalls the frame for tens to hundreds of ms, and meshes waiting for their
//! pipelines skip frames (flicker). After loading a level, send [`WarmPipelines`]: for
//! [`PipelineWarmup::frames`] frames the engine draws every loaded `StandardMaterial` on a tiny
//! quad just in front of the [`MainCamera`] (casting shadows, so shadow pipelines compile too),
//! plus each [`PipelineWarmup::extra`] mesh/material pair (skinned or morphed meshes, custom
//! vertex layouts), then removes them. Do it behind a loading screen: the stall happens there.
//!
//! Each run logs how many pipelines it created (`render.warmup` in `render.stats` with devtools).

use bevy::prelude::*;

use crate::gfx::MainCamera;

/// Ask for a warm-up (e.g. right after a map finished loading).
#[derive(Message, Clone, Copy, Debug, Default)]
pub struct WarmPipelines;

/// Warm-up settings and extra things to draw.
#[derive(Resource, Clone, Debug)]
pub struct PipelineWarmup {
    /// Frames the warm-up quads stay (pipelines may need a frame to queue and one to compile).
    pub frames: u32,
    /// Meshes with layouts a quad doesn't cover (skinned, morphed, extra attributes) and the
    /// material to draw each with. They're drawn tiny in front of the camera.
    pub extra: Vec<(Handle<Mesh>, Handle<StandardMaterial>)>,
}

impl Default for PipelineWarmup {
    fn default() -> Self {
        PipelineWarmup { frames: 3, extra: Vec::new() }
    }
}

/// Last run, for stats.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct WarmupStats {
    pub runs: u32,
    pub materials: u32,
    pub extra: u32,
}

/// A warm-up quad (removed after the warm-up).
#[derive(Component)]
struct WarmupQuad;

/// Frames left in the current warm-up.
#[derive(Resource, Default)]
struct Running(Option<u32>);

pub(super) struct WarmupPlugin;

impl Plugin for WarmupPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PipelineWarmup>()
            .init_resource::<WarmupStats>()
            .init_resource::<Running>()
            .add_message::<WarmPipelines>()
            .add_systems(Update, (start, tick).chain().run_if(crate::flow::has_visuals));
    }
}

#[allow(clippy::too_many_arguments)]
fn start(
    mut commands: Commands,
    mut asked: MessageReader<WarmPipelines>,
    cfg: Res<PipelineWarmup>,
    mut running: ResMut<Running>,
    mut stats: ResMut<WarmupStats>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    cam: Query<Entity, With<MainCamera>>,
) {
    if asked.read().count() == 0 {
        return;
    }
    let Some(cam) = cam.iter().next() else {
        warn!("pipeline warm-up: no MainCamera, skipped");
        return;
    };
    // Clear a run still in progress first.
    running.0 = Some(cfg.frames.max(1));
    let quad = meshes.add(Rectangle::new(1.0, 1.0));
    let ids: Vec<AssetId<StandardMaterial>> = materials.ids().collect();
    let mut n = 0u32;
    // Laid out in a tiny grid 0.5 m ahead: inside the frustum (so it's queued and drawn), but
    // a fraction of a pixel each.
    let place = |i: u32| {
        let (x, y) = ((i % 64) as f32, (i / 64) as f32);
        Transform::from_xyz((x - 32.0) * 1e-4, (y - 8.0) * 1e-4, -0.5).with_scale(Vec3::splat(5e-5))
    };
    for id in ids {
        let Some(handle) = materials.get_strong_handle(id) else { continue };
        let q = commands.spawn((WarmupQuad, Mesh3d(quad.clone()), MeshMaterial3d(handle), place(n), super::Actor)).id();
        commands.entity(cam).add_child(q);
        n += 1;
    }
    for (mesh, mat) in &cfg.extra {
        let q = commands.spawn((WarmupQuad, Mesh3d(mesh.clone()), MeshMaterial3d(mat.clone()), place(n), super::Actor)).id();
        commands.entity(cam).add_child(q);
        n += 1;
    }
    stats.runs += 1;
    stats.materials = n - cfg.extra.len() as u32;
    stats.extra = cfg.extra.len() as u32;
    info!("pipeline warm-up: drawing {} materials + {} extra meshes for {} frames", stats.materials, stats.extra, cfg.frames);
}

fn tick(mut commands: Commands, mut running: ResMut<Running>, quads: Query<Entity, With<WarmupQuad>>) {
    let Some(left) = running.0 else { return };
    if left > 0 {
        running.0 = Some(left - 1);
        return;
    }
    running.0 = None;
    for e in &quads {
        commands.entity(e).despawn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warmup_draws_every_material_then_cleans_up() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_plugins(bevy::asset::AssetPlugin::default())
            .init_asset::<Mesh>()
            .init_asset::<StandardMaterial>()
            .insert_resource(crate::flow::Headless(false))
            .add_plugins(WarmupPlugin);
        let cam = app.world_mut().spawn((MainCamera, Transform::default())).id();
        // Held, like a game's materials (dropped handles free the asset).
        let _held = {
            let mut mats = app.world_mut().resource_mut::<Assets<StandardMaterial>>();
            [mats.add(StandardMaterial::default()), mats.add(StandardMaterial { unlit: true, ..default() })]
        };
        app.world_mut().write_message(WarmPipelines);
        app.update();
        let quads = |app: &mut App| app.world_mut().query_filtered::<(), With<WarmupQuad>>().iter(app.world()).count();
        assert_eq!(quads(&mut app), 2);
        assert!(app.world().get::<Children>(cam).is_some_and(|c| c.len() == 2));
        for _ in 0..4 {
            app.update();
        }
        assert_eq!(quads(&mut app), 0);
        assert_eq!(app.world().resource::<WarmupStats>().materials, 2);
    }
}
