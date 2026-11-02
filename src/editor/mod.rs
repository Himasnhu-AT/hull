//! The level editor (feature `editor`): the game's own binary, started with `--editor`, becomes
//! an Unreal-style editor. The panels are `editor-ui` (egui, Bevy-free) hosted through
//! `bevy_egui`; this module is the Bevy side: the [`EditorBackend`](editor_proto::EditorBackend)
//! on the `World`, the viewport camera, picking, the transform gizmo, Play/Stop and the
//! `editor.*` control commands. Contract and user guide: `docs/EDITOR.md`.
//!
//! ```text
//! cargo run --features dev -- --editor --level levels/town.level.ron
//! ```
//!
//! # Editing mode
//!
//! The editor does not add an `AppState`: the game runs in `AppState::InGame` (so the code that
//! builds its world on entering the game still runs and its entities show up as *generated*),
//! with [`EditorMode`] present, virtual time paused (`Paused`, so gameplay sets gated with
//! `not_paused` are frozen), `PauseAllowed(false)` (no pause menu on focus loss) and the
//! engine's "gameplay" action context off (it follows `Paused`).
//!
//! # Layout
//!
//! | File | What |
//! |---|---|
//! | `schema.rs` | reflect type info to `TypeSchema`, reflect JSON to the UI form (handles as paths) |
//! | `backend.rs` | `WorldBackend`: tree, components, ops, assets, level, selection |
//! | `host.rs` | egui camera and context, the per-frame `show()`, viewport rect to `Camera::viewport` |
//! | `camera.rs` | fly / orbit / pan / focus |
//! | `picking.rs` | click select, ray casts, bounds |
//! | `gizmo.rs` | selection box and the move / rotate / scale gizmo |
//! | `play.rs` | Play (save, build, run) and Stop |
//! | `control.rs` | `editor.*` control commands |

use std::collections::VecDeque;

use bevy::prelude::*;
use bevy_egui::{EguiPlugin, EguiPrimaryContextPass};
use editor_proto::{Diagnostic, Level, Tool};

mod backend;
mod camera;
mod control;
mod gizmo;
mod host;
mod picking;
mod play;
mod fade;
pub mod tools;
pub mod schema;

pub use backend::WorldBackend;

/// Present while the app runs as the editor (`--editor`).
#[derive(Resource, Default, Debug)]
pub struct EditorMode;

/// Marks entities the editor made for itself (egui camera, helpers): hidden from the outliner and
/// never saved.
#[derive(Component, Reflect, Default, Clone, Copy, Debug)]
#[reflect(Component, Default)]
pub struct EditorOnly;

/// How Play builds and starts the game. Games may override it (insert before the app runs).
#[derive(Resource, Clone, Debug, Default)]
pub struct EditorConfig {
    /// `Cargo.toml` (or its folder) of the game. Default: found from `GameInfo`, the working
    /// folder and the executable's location (see [`play`]).
    pub manifest: Option<std::path::PathBuf>,
    /// `--features` for the Play build (default: none).
    pub play_features: Option<String>,
    /// Skip `cargo build` on Play and run the current executable as is.
    pub skip_build: bool,
}

/// Most diagnostics kept for the Output panel.
const MAX_DIAGNOSTICS: usize = 2000;

/// Editor state that is not part of the document.
#[derive(Resource)]
pub struct EditorState {
    pub selection: Vec<Entity>,
    pub tool: Tool,
    pub snap: bool,
    pub snap_step: f32,
    /// Gizmo in the entity's own axes (default world).
    pub local_space: bool,
    /// The faint ground grid (View menu).
    pub show_grid: bool,
    /// View > Show all scenery: no distance fade (stored in `editor_prefs.json`).
    pub show_all_scenery: bool,
    diag: VecDeque<Diagnostic>,
    diag_dropped: u64,
    pub(crate) play: play::PlayRuntime,
    /// What the UI reported last frame.
    pub ui: UiFrame,
    /// Camera drag / gizmo drag in progress: the egui pass must not take the pointer or keys.
    pub(crate) cam_busy: bool,
    pub(crate) gizmo_busy: bool,
    pub(crate) tool_busy: bool,
    /// A world tool (Spline, Sculpt, ...) is active: it owns the left button.
    pub(crate) tool_active: bool,
    /// Ops the engine applied on its own, waiting for the UI to put them on its undo stack.
    recorded: Vec<editor_proto::RecordedOp>,
}

impl Default for EditorState {
    fn default() -> Self {
        EditorState {
            selection: Vec::new(),
            tool: Tool::Move,
            snap: false,
            snap_step: 0.5,
            local_space: false,
            show_grid: true,
            show_all_scenery: false,
            diag: VecDeque::new(),
            diag_dropped: 0,
            play: play::PlayRuntime::default(),
            ui: UiFrame::default(),
            cam_busy: false,
            gizmo_busy: false,
            tool_busy: false,
            tool_active: false,
            recorded: Vec::new(),
        }
    }
}

/// The parts of `editor_ui::UiOutput` the Bevy systems need, in pixels.
#[derive(Clone, Debug, Default)]
pub struct UiFrame {
    /// Viewport rect in egui points.
    pub viewport: Option<[f32; 4]>,
    pub pixels_per_point: f32,
    pub wants_pointer: bool,
    pub wants_keyboard: bool,
    pub pointer_over_viewport: bool,
}

impl EditorState {
    pub fn busy(&self) -> bool {
        self.cam_busy || self.gizmo_busy || self.tool_busy
    }

    /// Queues an op the engine applied (a stroke, a drag) for the UI's undo stack.
    pub fn record(&mut self, label: &str, op: editor_proto::Op, key: Option<String>) {
        self.recorded.push(editor_proto::RecordedOp { label: label.into(), op, key });
    }

    #[cfg(test)]
    pub(crate) fn take_recorded_len(&self) -> usize {
        self.recorded.len()
    }

    pub fn take_recorded(&mut self) -> Vec<editor_proto::RecordedOp> {
        std::mem::take(&mut self.recorded)
    }

    /// Diagnostics after cursor `since` (a count of all diagnostics ever pushed).
    pub fn diagnostics_since(&self, since: u64) -> (u64, Vec<Diagnostic>) {
        let total = self.diag_dropped + self.diag.len() as u64;
        let from = since.max(self.diag_dropped);
        let skip = (from - self.diag_dropped) as usize;
        (total, self.diag.iter().skip(skip).cloned().collect())
    }

    pub fn push_diag(&mut self, d: Diagnostic) {
        if self.diag.len() >= MAX_DIAGNOSTICS {
            self.diag.pop_front();
            self.diag_dropped += 1;
        }
        self.diag.push_back(d);
    }
}

/// Adds a line to the Output panel (and the log).
pub fn log(world: &mut World, level: Level, source: &str, message: String) {
    match level {
        Level::Error => error!("[{source}] {message}"),
        Level::Warn => warn!("[{source}] {message}"),
        _ => info!("[{source}] {message}"),
    }
    if let Some(mut st) = world.get_resource_mut::<EditorState>() {
        st.push_diag(Diagnostic { level, source: source.to_string(), message, file: None, line: None, col: None });
    }
}

/// Added by `engine::app` for `--editor` (windowed runs, feature `editor`).
pub struct EditorPlugin;

impl Plugin for EditorPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(EguiPlugin::default())
            .insert_resource(EditorMode)
            // No menu: straight into the game's world, then the editor takes over.
            .insert_resource(crate::flow::SkipMenu(true))
            .insert_resource(crate::flow::PauseAllowed(false))
            .init_resource::<EditorState>()
            .init_resource::<EditorConfig>()
            .init_resource::<camera::EditorCamera>()
            .init_resource::<gizmo::GizmoState>()
            .init_resource::<tools::ToolState>()
            .register_type::<EditorOnly>()
            .add_systems(Startup, host::setup)
            .add_systems(EguiPrimaryContextPass, host::ui_pass)
            .add_systems(PreUpdate, host::gate_egui_keys.before(bevy_egui::EguiPreUpdateSet::ProcessInput))
            .add_systems(
                Update,
                (
                    keep_paused,
                    full_resolution,
                    camera::adopt_camera,
                    tools::update,
                    gizmo::interact,
                    camera::control,
                    picking::click_select,
                    gizmo::draw,
                    tools::draw,
                    play::poll,
                    host::persist_layout,
                )
                    .chain(),
            )
            .add_systems(
                PostUpdate,
                camera::apply
                    .before(TransformSystems::Propagate),
            )
            .init_resource::<host::ViewportImage>()
            .add_systems(
                PostUpdate,
                host::sync_viewport
                    .after(bevy_egui::EguiPostUpdateSet::EndPass)
                    .before(bevy::camera::CameraUpdateSystems),
            );
        app.add_systems(Startup, load_prefs).add_systems(Update, fade::exempt);
        gizmo::build(app);
        control::register(app);
    }
}

/// Game time stays frozen while editing (not while a Play process runs: that is another process).
fn keep_paused(mut pause: crate::pause::PauseCtl) {
    pause.set(true);
}

/// The viewport is a sub-rect of the window, so the engine's render scale (the 3D view drawn into
/// a smaller image and upscaled over the whole window) would draw the scene outside the hole:
/// the editor always renders at full resolution.
fn full_resolution(mut scale: ResMut<crate::render_budget::RenderScale>, preset: Option<ResMut<crate::gfx::QualityPreset>>) {
    if scale.scale != 1.0 {
        scale.scale = 1.0;
    }
    if let Some(mut p) = preset
        && p.hidpi_render_scale != [1.0; 4]
    {
        p.hidpi_render_scale = [1.0; 4];
    }
}

/// Editor preferences, kept in `<data dir>/editor_prefs.json`.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Prefs {
    #[serde(default)]
    show_all_scenery: bool,
}

fn prefs_path(world: &World) -> Option<std::path::PathBuf> {
    world.get_resource::<crate::paths::DataDir>().map(|d| d.0.join("editor_prefs.json"))
}

fn load_prefs(world: &mut World) {
    let prefs: Prefs = prefs_path(world).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    set_show_all_scenery(world, prefs.show_all_scenery);
}

/// Distance fade of scenery on / off; remembered between sessions.
pub fn set_show_all_scenery(world: &mut World, on: bool) {
    world.resource_mut::<EditorState>().show_all_scenery = on;
    if let Some(mut b) = world.get_resource_mut::<crate::render_budget::RenderBudget>() {
        b.scenery_detail = !on;
        b.shadow_trim = !on;
    }
    if let Some(p) = prefs_path(world)
        && let Ok(text) = serde_json::to_string(&Prefs { show_all_scenery: on })
        && let Err(e) = std::fs::write(p, text)
    {
        warn!("editor prefs not saved: {e}");
    }
}
