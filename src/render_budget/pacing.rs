//! Frame pacing: don't redraw what didn't change.
//!
//! - **Menus, pause, boot** (anything but unpaused `InGame`): the app updates reactively
//!   ([`FramePacing::menus`], winit `reactive_low_power`): on input/window events, else every
//!   `wait`. The GPU idles between. Gameplay uses [`FramePacing::gameplay`] (Bevy's
//!   `WinitSettings::game()`: continuous when focused). Runs driven by the control port or
//!   `--offscreen` (hidden, so always "unfocused") use the focused menu rate so tests stay quick.
//! - **Idle skip** (opt-in, [`RenderBudget::idle_skip`]): in a frame where no mesh, camera,
//!   light or UI node changed, no component was removed, no mesh/material/image asset changed,
//!   no window resized, no `RequestRedraw` was sent and no screenshot is pending, the frame is
//!   simulated (input, game logic, audio, control port all run) but not handed to the renderer;
//!   the window keeps showing the last image. At least every [`FramePacing::idle_skip_max`]
//!   frames one is drawn anyway (self-healing), and while skipping the loop sleeps to
//!   [`FramePacing::idle_skip_hz`] so the CPU doesn't spin without vsync.
//!
//!   Needs Bevy's pipelined rendering (the desktop default); otherwise it stays off
//!   ([`IdleSkipSupported`]). Things the detector can't see (custom material assets changing,
//!   time-animated shaders, gizmos) must send `RequestRedraw` every frame they animate. In an
//!   FPS the camera or an enemy moves almost every frame, so it rarely skips during play; it
//!   pays off when the player stands still in a static scene. Off by default.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use bevy::camera::RenderTarget;
use bevy::camera::visibility::VisibilityRange;
use bevy::ecs::lifecycle::RemovedComponentMessages;
use bevy::ecs::resource::IsResource;
use bevy::light::NotShadowCaster;
use bevy::prelude::*;
use bevy::render::view::screenshot::{Captured, Screenshot};
use bevy::text::TextLayoutInfo;
use bevy::ui::{ComputedNode, UiGlobalTransform};
use bevy::window::{RequestRedraw, WindowResized};
use bevy::winit::{UpdateMode, WinitSettings};

use super::{RenderBudget, RenderStats};
use crate::flow::AppState;
use crate::pause::Paused;

/// How often the app updates outside gameplay, and idle-skip pacing.
#[derive(Resource, Clone, Debug)]
pub struct FramePacing {
    /// Switch `WinitSettings` between `gameplay` and `menus`. Off = the engine never touches
    /// `WinitSettings`.
    pub enabled: bool,
    /// Unpaused `InGame`.
    pub gameplay: WinitSettings,
    /// Main menu, pause, boot.
    pub menus: WinitSettings,
    /// Update rate while idle-skipping (frames are simulated, not drawn).
    pub idle_skip_hz: f64,
    /// Draw at least one frame in this many even when nothing changed.
    pub idle_skip_max: u32,
}

impl Default for FramePacing {
    fn default() -> Self {
        let focused = UpdateMode::reactive_low_power(Duration::from_secs_f64(1.0 / 30.0));
        // Hidden test windows are never focused: keep them responsive.
        let unfocused = if crate::cli::test_driven() { focused } else { UpdateMode::reactive_low_power(Duration::from_secs_f64(1.0 / 8.0)) };
        let mut gameplay = WinitSettings::game();
        if crate::cli::uncapped() {
            gameplay.unfocused_mode = UpdateMode::Continuous;
        }
        FramePacing {
            enabled: true,
            gameplay,
            menus: WinitSettings { focused_mode: focused, unfocused_mode: unfocused },
            idle_skip_hz: 60.0,
            idle_skip_max: 30,
        }
    }
}

/// Whether idle skip can work here (pipelined rendering present). Set at startup.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct IdleSkipSupported(pub bool);

/// Shared with the render-extract hook: skip handing this frame to the renderer.
#[derive(Resource, Clone, Default)]
pub struct RenderGate(pub Arc<AtomicBool>);

/// The pacing systems (in `Last`).
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct PacingSystems;

pub(super) struct PacingPlugin;

impl Plugin for PacingPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<FramePacing>()
            .init_resource::<IdleSkipSupported>()
            .init_resource::<RenderGate>()
            .add_systems(Last, (apply_pacing, decide_frame.run_if(crate::flow::has_visuals)).chain().in_set(PacingSystems));
    }
}

/// Wraps the pipelined renderer's extract step: when [`RenderGate`] says skip, the frame is
/// never handed to the render thread (and the loop sleeps to `idle_skip_hz`).
pub(super) fn finish(app: &mut App) {
    use bevy::render::pipelined_rendering::RenderExtractApp;
    let gate = app.world().resource::<RenderGate>().0.clone();
    let Some(sub) = app.get_sub_app_mut(RenderExtractApp) else { return };
    let Some(mut inner) = sub.take_extract() else { return };
    sub.set_extract(move |main: &mut World, render: &mut World| {
        if gate.load(Ordering::Relaxed) {
            let hz = main.get_resource::<FramePacing>().map_or(60.0, |p| p.idle_skip_hz).max(1.0);
            let start = main.get_resource::<Time<Real>>().and_then(|t| t.last_update());
            if let Some(start) = start {
                let next = start + Duration::from_secs_f64(1.0 / hz);
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                }
            }
            return;
        }
        inner(main, render);
    });
    app.insert_resource(IdleSkipSupported(true));
}

fn apply_pacing(
    pacing: Res<FramePacing>,
    state: Option<Res<State<AppState>>>,
    paused: Res<Paused>,
    winit: Option<ResMut<WinitSettings>>,
) {
    let Some(mut winit) = winit else { return };
    if !pacing.enabled {
        return;
    }
    let playing = state.is_some_and(|s| *s.get() == AppState::InGame) && !paused.0;
    let want = if playing { &pacing.gameplay } else { &pacing.menus };
    if winit.focused_mode != want.focused_mode || winit.unfocused_mode != want.unfocused_mode {
        *winit = want.clone();
    }
}

/// Decides whether this frame is drawn, and counts drawn/skipped frames.
fn decide_frame(
    budget: Res<RenderBudget>,
    pacing: Res<FramePacing>,
    supported: Res<IdleSkipSupported>,
    gate: Res<RenderGate>,
    mut stats: ResMut<RenderStats>,
    changes: Changes,
    mut streak: Local<u32>,
    cpu: Res<super::BudgetCpu>,
) {
    let _cpu = cpu.time();
    let reason = if budget.idle_skip { changes.reason() } else { Some("idle skip off") };
    let skip = budget.idle_skip && supported.0 && *streak < pacing.idle_skip_max && reason.is_none();
    stats.redraw_reason = reason;
    gate.0.store(skip, Ordering::Relaxed);
    if skip {
        *streak += 1;
        stats.frames_skipped += 1;
    } else {
        *streak = 0;
        stats.frames_rendered += 1;
    }
}

/// Everything that would make this frame look different from the last drawn one.
#[derive(bevy::ecs::system::SystemParam)]
struct Changes<'w, 's> {
    meshes: Query<
        'w,
        's,
        (),
        (
            With<Mesh3d>,
            Or<(
                Changed<GlobalTransform>,
                Changed<Mesh3d>,
                Changed<MeshMaterial3d<StandardMaterial>>,
                Changed<InheritedVisibility>,
                Changed<VisibilityRange>,
                Added<NotShadowCaster>,
            )>,
        ),
    >,
    cams: Query<'w, 's, (), (With<Camera>, Or<(Changed<GlobalTransform>, Changed<Camera>, Changed<Projection>, Changed<RenderTarget>)>)>,
    lights: Query<
        'w,
        's,
        (),
        Or<(
            Changed<PointLight>,
            Changed<SpotLight>,
            Changed<DirectionalLight>,
            (Or<(With<PointLight>, With<SpotLight>, With<DirectionalLight>)>, Changed<GlobalTransform>),
        )>,
    >,
    ui: Query<
        'w,
        's,
        (),
        Or<(
            Changed<ComputedNode>,
            Changed<UiGlobalTransform>,
            Changed<BackgroundColor>,
            Changed<BorderColor>,
            Changed<TextColor>,
            Changed<TextLayoutInfo>,
            Changed<ImageNode>,
            (With<Node>, Changed<InheritedVisibility>),
        )>,
    >,
    shots: Query<'w, 's, (), (With<Screenshot>, Without<Captured>)>,
    removed: &'w RemovedComponentMessages,
    resources: Query<'w, 's, (), With<IsResource>>,
    redraw: MessageReader<'w, 's, RequestRedraw>,
    resized: MessageReader<'w, 's, WindowResized>,
    mesh_assets: MessageReader<'w, 's, AssetEvent<Mesh>>,
    material_assets: MessageReader<'w, 's, AssetEvent<StandardMaterial>>,
    image_assets: MessageReader<'w, 's, AssetEvent<Image>>,
    clear: Option<Res<'w, ClearColor>>,
    ambient: Option<Res<'w, GlobalAmbientLight>>,
}

impl Changes<'_, '_> {
    /// The first thing that changed this frame, if any.
    fn reason(mut self) -> Option<&'static str> {
        // Read every reader so their cursors advance even when an earlier check already decided.
        let messages = [
            ("redraw requested", self.redraw.read().count()),
            ("window resized", self.resized.read().count()),
            ("mesh asset", self.mesh_assets.read().count()),
            ("material asset", self.material_assets.read().count()),
            ("image asset", self.image_assets.read().count()),
        ];
        if let Some((why, _)) = messages.iter().find(|(_, n)| *n > 0) {
            return Some(why);
        }
        let checks = [
            ("mesh", !self.meshes.is_empty()),
            ("camera", !self.cams.is_empty()),
            ("light", !self.lights.is_empty()),
            ("ui", !self.ui.is_empty()),
            ("screenshot", !self.shots.is_empty()),
            ("clear colour", self.clear.as_ref().is_some_and(|c| c.is_changed())),
            ("ambient light", self.ambient.as_ref().is_some_and(|a| a.is_changed())),
            // Resources live on entities: `resource_scope` (e.g. the renderer's extract step)
            // removes and re-inserts one every frame. Those don't change the picture.
            (
                "component removed",
                self.removed.iter().any(|(_, m)| m.iter_current_update_messages().any(|r| !self.resources.contains(Entity::from(r.clone())))),
            ),
        ];
        checks.iter().find(|(_, hit)| *hit).map(|(why, _)| *why)
    }
}
