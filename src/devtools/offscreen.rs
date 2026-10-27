//! `--offscreen` (test tooling): the window stays hidden (core sets it up hidden) and every camera
//! that would draw to the primary window renders into one image instead, so screenshots work
//! even when the window can't be seen (another app fullscreen, other Space, display asleep).
//!
//! Cameras are retargeted whenever they appear (menus, a game camera spawned on entering a
//! round, …). UI goes to the camera already marked `IsDefaultUiCamera`, else the [`MainCamera`],
//! else the first retargeted camera.

use bevy::camera::RenderTarget;
use bevy::prelude::*;
use bevy::render::render_resource::{TextureFormat, TextureUsages};
use bevy::ui::IsDefaultUiCamera;
use bevy::window::WindowRef;

use crate::gfx::MainCamera;

pub const SIZE: (u32, u32) = (1920, 1080);

pub fn enabled() -> bool {
    crate::cli::has_flag("offscreen")
}

/// The image the cameras render into (what `screenshot` captures).
#[derive(Resource, Clone)]
pub struct OffscreenTarget(pub Handle<Image>);

pub struct OffscreenPlugin;

impl Plugin for OffscreenPlugin {
    fn build(&self, _: &mut App) {}

    fn finish(&self, app: &mut App) {
        // Needs the renderer (images + cameras): skipped for --headless and MinimalPlugins apps.
        let rendering = app.world().contains_resource::<Assets<Image>>() && app.is_plugin_added::<bevy::render::RenderPlugin>();
        if enabled() && rendering {
            app.add_systems(PostUpdate, retarget_cameras.before(bevy::camera::CameraUpdateSystems));
            if let Some(render_app) = app.get_sub_app_mut(bevy::render::RenderApp) {
                render_app.init_resource::<InFlight>().add_systems(
                    bevy::render::Render,
                    limit_frames_in_flight.in_set(bevy::render::RenderSystems::Cleanup),
                );
            }
        }
    }
}

/// Frames the CPU may run ahead of the GPU (a window's swapchain allows about the same).
pub const FRAMES_IN_FLIGHT: u64 = 2;

/// Frames submitted / finished on the GPU.
#[derive(Resource, Default)]
struct InFlight {
    submitted: u64,
    done: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

/// With no swapchain nothing makes the CPU wait for the GPU: in a GPU-bound scene frames queue
/// up without limit, the Metal driver holds gigabytes of command buffers in flight, and frame
/// times measure how fast the CPU submits, not how fast the GPU renders. Wait like a swapchain.
fn limit_frames_in_flight(
    mut f: ResMut<InFlight>,
    device: Res<bevy::render::renderer::RenderDevice>,
    queue: Res<bevy::render::renderer::RenderQueue>,
) {
    use std::sync::atomic::Ordering;
    let done = f.done.clone();
    queue.on_submitted_work_done(move || {
        done.fetch_add(1, Ordering::Relaxed);
    });
    f.submitted += 1;
    let t0 = std::time::Instant::now();
    while f.submitted - f.done.load(Ordering::Relaxed) > FRAMES_IN_FLIGHT && t0.elapsed().as_secs() < 2 {
        let _ = device.poll(bevy::render::render_resource::PollType::Poll);
        std::thread::sleep(std::time::Duration::from_micros(100));
    }
}

fn retarget_cameras(
    mut commands: Commands,
    mut images: ResMut<Assets<Image>>,
    target: Option<Res<OffscreenTarget>>,
    cams: Query<(Entity, &RenderTarget, Has<MainCamera>, Has<IsDefaultUiCamera>), With<Camera>>,
) {
    let to_window = |t: &RenderTarget| matches!(t, RenderTarget::Window(WindowRef::Primary));
    if !cams.iter().any(|(_, t, ..)| to_window(t)) {
        return;
    }
    let handle = match target {
        Some(t) => t.0.clone(),
        None => {
            let mut image = Image::new_target_texture(SIZE.0, SIZE.1, TextureFormat::Rgba8UnormSrgb, None);
            image.texture_descriptor.usage |= TextureUsages::COPY_SRC;
            let h = images.add(image);
            commands.insert_resource(OffscreenTarget(h.clone()));
            info!("offscreen: rendering cameras to a {}x{} image", SIZE.0, SIZE.1);
            h
        }
    };
    // Keep the game's choice of UI camera; else the main camera; else the first retargeted one.
    let mut ui_cam = cams
        .iter()
        .find(|(.., is_ui)| *is_ui)
        .or_else(|| cams.iter().find(|(_, _, main, _)| *main))
        .map(|(e, ..)| e);
    for (e, t, ..) in &cams {
        if to_window(t) {
            commands.entity(e).insert(RenderTarget::from(handle.clone()));
            ui_cam.get_or_insert(e);
        }
    }
    // Exactly one default UI camera: without a window target, UI only renders through it.
    for (e, _, _, is_ui) in &cams {
        if is_ui && Some(e) != ui_cam {
            commands.entity(e).remove::<IsDefaultUiCamera>();
        }
    }
    if let Some(e) = ui_cam {
        commands.entity(e).insert(IsDefaultUiCamera);
    }
}
