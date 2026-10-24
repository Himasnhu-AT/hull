//! Clean exit with pipelined rendering.
//!
//! Bevy 0.19 + pipelined rendering can deadlock on exit (seen on macOS with hidden/offscreen
//! windows, and as "Skipped event Destroyed for unknown winit Window Id" on normal quit):
//!
//! 1. The frame that sees `AppExit` still extracts and hands the render world to the render
//!    thread, which starts rendering that frame.
//! 2. On macOS `create_surfaces` must run on the main thread (`NonSendMarker`), so the render
//!    thread queues it on the main-thread executor and waits.
//! 3. Meanwhile winit's `exiting` calls `World::clear_all`, whose `RenderAppChannels::drop`
//!    blocks waiting for the render world to come back, without running main-thread tasks.
//!    Each side waits for the other: the process hangs after the last screenshot is saved.
//!
//! Whether it hangs depends on whether the render thread reached a main-thread system before the
//! main thread blocked: 8 of 30 offscreen runs hung (ui_gallery menu/paused, metrics_demo
//! with `--metrics-window`); 0 of 30 with this plugin.
//!
//! [`CleanExitPlugin`] wraps the render extract step (outermost, in `cleanup`): in the frame
//! `AppExit` is pending it takes the render world back *while running main-thread tasks* (as
//! Bevy's own extract does), drops it on the main thread, and never sends another frame. The
//! later drop of `RenderAppChannels` then has nothing to wait for.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use bevy::ecs::message::Messages;
use bevy::ecs::schedule::MainThreadExecutor;
use bevy::prelude::*;
use bevy::render::pipelined_rendering::{RenderAppChannels, RenderExtractApp};
use bevy::tasks::ComputeTaskPool;

/// Added by `EnginePlugin` for windowed runs. Does nothing without pipelined rendering.
pub struct CleanExitPlugin;

impl Plugin for CleanExitPlugin {
    fn build(&self, _: &mut App) {}

    /// `cleanup` runs after every plugin's `finish` (where other wrappers, e.g. frame pacing,
    /// are installed), so this wrapper is the outermost and runs even on skipped frames.
    fn cleanup(&self, app: &mut App) {
        let Some(sub) = app.get_sub_app_mut(RenderExtractApp) else { return };
        let Some(mut inner) = sub.take_extract() else { return };
        let drained = Arc::new(AtomicBool::new(false));
        sub.set_extract(move |main: &mut World, render: &mut World| {
            if drained.load(Ordering::Relaxed) {
                return;
            }
            if exit_pending(main) {
                drained.store(true, Ordering::Relaxed);
                take_back_render_world(main);
                return;
            }
            inner(main, render);
        });
    }
}

fn exit_pending(world: &World) -> bool {
    world.get_resource::<Messages<AppExit>>().is_some_and(|m| !m.is_empty())
}

/// Waits for the render thread to finish its frame and hand the render world back, running any
/// main-thread render systems meanwhile, then drops it here on the main thread (where its
/// non-send data was created).
fn take_back_render_world(main: &mut World) {
    if !main.contains_resource::<MainThreadExecutor>() || !main.contains_resource::<RenderAppChannels>() {
        return;
    }
    main.resource_scope(|world, executor: Mut<MainThreadExecutor>| {
        world.resource_scope(|_, mut channels: Mut<RenderAppChannels>| {
            let render_app = ComputeTaskPool::get()
                .scope_with_executor(true, Some(&*executor.0), |s| {
                    s.spawn(async { channels.recv().await });
                })
                .pop()
                .flatten();
            drop(render_app);
        });
    });
}
