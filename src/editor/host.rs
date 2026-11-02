//! Hosting `editor-ui` in the Bevy window through `bevy_egui`.
//!
//! The egui context lives on its own `Camera2d` (order 1, no render layers, transparent clear),
//! so the 3D camera keeps its own viewport: egui draws the panels around a transparent hole and
//! each frame the hole's rect becomes [`Camera::viewport`] of the scene camera.
//!
//! bevy_egui 0.43 runs the primary context's schedule inside `egui::Context::run_ui`, which loops
//! when a widget calls `request_discard` (egui-snarl does, while placing nodes), so a discarded
//! first pass is never shown.

use bevy::camera::{CameraOutputMode, ImageRenderTarget, RenderTarget, visibility::RenderLayers};
use bevy::prelude::*;
use bevy::render::render_resource::{BlendState, TextureFormat, TextureUsages};
use bevy_egui::{EguiContext, EguiGlobalSettings, EguiTextureHandle, EguiUserTextures, PrimaryEguiContext, egui};
use editor_ui::EditorUi;

use super::backend::WorldBackend;
use super::camera::EditorCamera;
use super::{EditorOnly, EditorState, UiFrame};
use crate::paths::DataDir;

/// The panels (not `Send`-sensitive: stored as a normal resource).
#[derive(Resource)]
pub struct EditorUiRes(pub EditorUi);

fn layout_path(data: &DataDir) -> std::path::PathBuf {
    data.0.join("editor_ui.json")
}

pub fn setup(mut commands: Commands, mut egui: ResMut<EguiGlobalSettings>, data: Option<Res<DataDir>>) {
    egui.auto_create_primary_context = false;
    commands.spawn((
        EditorOnly,
        Name::new("Editor UI camera"),
        PrimaryEguiContext,
        Camera2d,
        RenderLayers::none(),
        Camera {
            order: 1000,
            output_mode: CameraOutputMode::Write { blend_state: Some(BlendState::ALPHA_BLENDING), clear_color: ClearColorConfig::None },
            clear_color: ClearColorConfig::Custom(Color::NONE),
            ..default()
        },
    ));
    let mut ui = EditorUi::new();
    if let Some(d) = data
        && let Ok(text) = std::fs::read_to_string(layout_path(&d))
        && let Err(e) = ui.load_state(&text)
    {
        warn!("editor layout ignored: {e}");
    }
    commands.insert_resource(EditorUiRes(ui));
}

/// Runs inside the egui pass: draws the editor and records what the 3D side needs.
pub fn ui_pass(world: &mut World) -> Result {
    let ctx = {
        let mut q = world.query_filtered::<&mut EguiContext, With<PrimaryEguiContext>>();
        let Ok(mut c) = q.single_mut(world) else { return Ok(()) };
        c.get_mut().clone()
    };
    let Some(mut ui) = world.remove_resource::<EditorUiRes>() else { return Ok(()) };
    let out = ui.0.show(&ctx, &mut WorldBackend::new(world));
    // The 3D view fills the transparent hole.
    if let (Some(r), Some(tex)) = (out.viewport, world.resource::<ViewportImage>().texture)
        && !world.resource::<EditorState>().play.is_running()
    {
        ctx.layer_painter(egui::LayerId::background()).image(tex, r, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), egui::Color32::WHITE);
    }
    // Keep the pointer from the UI while a gizmo or camera drag is running.
    let busy = world.resource::<EditorState>().busy();
    world.insert_resource(ui);
    let mut st = world.resource_mut::<EditorState>();
    st.tool = out.tool;
    st.snap = out.snap;
    st.snap_step = out.snap_step;
    st.ui = UiFrame {
        viewport: out.viewport.map(|r| [r.min.x, r.min.y, r.max.x, r.max.y]),
        pixels_per_point: ctx.pixels_per_point(),
        wants_pointer: out.wants_pointer && !busy,
        wants_keyboard: out.wants_keyboard,
        pointer_over_viewport: out.pointer_over_viewport,
    };
    Ok(())
}

/// Plain W/A/S/D/Q/E must fly the camera while the right button is down, not trigger the UI's
/// tool shortcuts: stop feeding keys to egui for that time.
pub fn gate_egui_keys(mut settings: ResMut<EguiGlobalSettings>, st: Res<EditorState>) {
    let on = !st.cam_busy;
    if settings.input_system_settings.run_write_keyboard_input_messages_system != on {
        settings.input_system_settings.run_write_keyboard_input_messages_system = on;
    }
}

/// The 3D view as an image: the scene camera renders into it and egui draws it in the viewport
/// hole. (A `Camera::viewport` sub-rect would be simpler, but Bevy's atmosphere reads its depth
/// texture with window coordinates, so a look with a sky draws wrongly in an offset viewport.)
#[derive(Resource, Default)]
pub struct ViewportImage {
    handle: Option<Handle<Image>>,
    texture: Option<egui::TextureId>,
    /// Size of `handle` in physical pixels.
    size: UVec2,
    /// A size that differs from `size`, and for how many frames it has been wanted.
    pending: UVec2,
    stable: u32,
}

impl ViewportImage {
    pub fn size(&self) -> UVec2 {
        self.size
    }
}

/// Keeps the image the size of the viewport hole (reallocated once the size has held for a few
/// frames, so dragging a divider does not allocate every frame) and points the scene camera at it.
#[allow(clippy::too_many_arguments)]
pub fn sync_viewport(
    mut commands: Commands,
    st: Res<EditorState>,
    cam: Res<EditorCamera>,
    mut vp: ResMut<ViewportImage>,
    mut images: ResMut<Assets<Image>>,
    mut textures: ResMut<EguiUserTextures>,
    mut cams: Query<&mut Camera>,
    mut projections: Query<&mut Projection>,
) {
    let Some(e) = cam.entity else { return };
    let Ok(mut camera) = cams.get_mut(e) else { return };
    let Some(r) = st.ui.viewport.filter(|_| !st.play.is_running()) else {
        if camera.is_active {
            camera.is_active = false;
        }
        return;
    };
    if !camera.is_active {
        camera.is_active = true;
    }
    let s = st.ui.pixels_per_point.max(0.1);
    let want = UVec2::new((((r[2] - r[0]) * s).round() as u32).clamp(16, 8192), (((r[3] - r[1]) * s).round() as u32).clamp(16, 8192));
    if vp.handle.is_some() && want == vp.size {
        vp.stable = 0;
        return;
    }
    if vp.handle.is_some() {
        if want != vp.pending {
            vp.pending = want;
            vp.stable = 0;
        }
        vp.stable += 1;
        if vp.stable < 4 {
            return;
        }
    }
    let mut image = Image::new_target_texture(want.x, want.y, TextureFormat::Rgba8UnormSrgb, None);
    image.texture_descriptor.usage |= TextureUsages::TEXTURE_BINDING;
    let handle = images.add(image);
    let tex = textures.add_image(EguiTextureHandle::Strong(handle.clone()));
    commands.entity(e).insert(RenderTarget::Image(ImageRenderTarget { handle: handle.clone(), scale_factor: s }));
    // Bevy 0.20 recomputes a camera's target size on a projection change, not a target change.
    if let Ok(mut p) = projections.get_mut(e) {
        p.set_changed();
    }
    if let Some(old) = vp.handle.replace(handle) {
        textures.remove_image(old.id());
        images.remove(old.id());
    }
    vp.texture = Some(tex);
    vp.size = want;
    vp.stable = 0;
}

/// Saves the dock layout a moment after it changes.
pub fn persist_layout(ui: Option<Res<EditorUiRes>>, data: Option<Res<DataDir>>, time: Res<Time<Real>>, mut last: Local<String>, mut since: Local<f32>) {
    *since += time.delta_secs();
    if *since < 3.0 {
        return;
    }
    *since = 0.0;
    let (Some(ui), Some(data)) = (ui, data) else { return };
    let now = ui.0.save_state();
    if now != *last {
        if let Err(e) = std::fs::write(layout_path(&data), &now) {
            warn!("editor layout not saved: {e}");
        }
        *last = now;
    }
}

/// Runs a UI command (what a toolbar button does) from outside the egui pass.
pub fn run_command(world: &mut World, cmd: editor_ui::Command) {
    let Some(mut ui) = world.remove_resource::<EditorUiRes>() else { return };
    let ctx = {
        let mut q = world.query_filtered::<&mut EguiContext, With<PrimaryEguiContext>>();
        q.single_mut(world).ok().map(|mut c| c.get_mut().clone())
    };
    if let Some(ctx) = ctx {
        ui.0.run(&ctx, &mut WorldBackend::new(world), cmd);
    }
    world.insert_resource(ui);
}

