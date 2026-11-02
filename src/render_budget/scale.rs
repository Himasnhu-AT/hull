//! Render scale: draw the 3D view at fewer pixels than the window and upscale it.
//!
//! GPU cost follows pixel count, and a Retina window has 4x the pixels of its logical size.
//! [`RenderScale::scale`] < 1 makes the [`MainCamera`] render (with all its post effects) into
//! an image of `scale x` the window's physical size; a second camera draws that image over the
//! whole window with bilinear filtering, and UI renders through that second camera at full
//! resolution. Light contrast-adaptive sharpening runs on the scaled image.
//!
//! At scale 1 the main camera draws to the window directly and the image and the second camera
//! are removed: nothing is paid when the scale is unused. Image sizes are rounded to 8 px and
//! scales to 0.05, so a governor nudging the scale doesn't reallocate every frame.
//!
//! Bevy's `MainPassResolutionOverride` can't do this: post-processing ignores it (it only works
//! with DLSS). Under `--offscreen` the upscale camera is redirected into the offscreen image
//! like any window camera, so screenshots show the scaled result.
//!
//! Per-tier ceiling: on a high-DPI window `QualityPreset::hidpi_render_scale` caps the scale
//! for the current quality (default Low 0.7, Medium 0.85), whatever `scale` (the governor's or
//! the game's) asks for. It applies once the main camera has its quality settings
//! (`AppliedQuality`, which sets `Msaa::Off`): scaling a camera that still had MSAA during
//! warm-up failed GPU validation.
//!
//! Limits: `Camera::world_to_viewport` / `viewport_to_world` on the main camera work in the
//! scaled image's pixels while scaled (multiply by [`RenderScale::applied`] to get window
//! physical pixels). Game UI that targets the main camera explicitly (`UiTargetCamera`) renders
//! into the scaled image.

use bevy::anti_alias::contrast_adaptive_sharpening::ContrastAdaptiveSharpening;
use bevy::anti_alias::taa::TemporalAntiAliasing;
use bevy::camera::visibility::RenderLayers;
use bevy::camera::{CameraUpdateSystems, RenderTarget};
use bevy::core_pipeline::tonemapping::{DebandDither, Tonemapping};
use bevy::image::ImageSampler;
use bevy::prelude::*;
use bevy::render::render_resource::TextureFormat;
use bevy::ui::IsDefaultUiCamera;
use bevy::window::{PrimaryWindow, WindowRef};

use crate::gfx::MainCamera;

/// Render layer of the upscale camera and its sprite (nothing else uses it).
pub const SCALE_LAYER: usize = 30;

/// Smallest scale the engine will draw at.
pub const MIN_SCALE: f32 = 0.4;

/// How many pixels the main camera draws, as a fraction of the window's physical size per axis.
#[derive(Resource, Clone, Copy, Debug, PartialEq)]
pub struct RenderScale {
    /// Wanted scale, `MIN_SCALE..=1.0` (the governor writes it; games may too).
    pub scale: f32,
    /// Sharpening strength while scaled (`0` = none).
    pub sharpen: f32,
    /// Scale in use right now (after rounding; 1 when off or unsupported). Read-only.
    pub applied: f32,
    /// Size of the image the main camera draws into while scaled (physical px). Read-only.
    pub size: UVec2,
    /// The tier ceiling in force (`QualityPreset::hidpi_render_scale` on a high-DPI window,
    /// else 1). Read-only.
    pub ceiling: f32,
}

impl Default for RenderScale {
    fn default() -> Self {
        RenderScale { scale: 1.0, sharpen: 0.35, applied: 1.0, size: UVec2::ZERO, ceiling: 1.0 }
    }
}

impl RenderScale {
    /// `scale` rounded the way it is applied (0.05 steps; ≥ 0.975 counts as 1).
    pub fn quantize(scale: f32) -> f32 {
        let s = scale.clamp(MIN_SCALE, 1.0);
        if s >= 0.975 { 1.0 } else { (s * 20.0).round() / 20.0 }
    }
}

/// Upscale camera, its sprite and the image, while scaled.
#[derive(Resource)]
struct Scaled {
    image: Handle<Image>,
    camera: Entity,
    sprite: Entity,
    main: Entity,
    /// The main camera carried `IsDefaultUiCamera` / its own CAS before scaling.
    main_was_ui: bool,
    own_cas: bool,
}

pub(super) struct ScalePlugin;

impl Plugin for ScalePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<RenderScale>();
    }
}

/// Adds the scaling system once the renderer is known (from `RenderBudgetPlugin::finish`).
pub(super) fn finish(app: &mut App) {
    {
        let rendering = app.world().contains_resource::<Assets<Image>>() && app.is_plugin_added::<bevy::render::RenderPlugin>();
        if rendering {
            app.add_systems(PostUpdate, apply_render_scale.before(CameraUpdateSystems));
        }
    }
}

/// Image size for a window of `physical` px at `scale` (multiple of 8, at least 64).
pub fn scaled_size(physical: UVec2, scale: f32) -> UVec2 {
    let f = |v: u32| (((v as f32 * scale) / 8.0).round() as u32 * 8).max(64);
    UVec2::new(f(physical.x), f(physical.y))
}

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn apply_render_scale(
    mut commands: Commands,
    mut rs: ResMut<RenderScale>,
    scaled: Option<ResMut<Scaled>>,
    mut images: ResMut<Assets<Image>>,
    window: Query<&Window, With<PrimaryWindow>>,
    mut mains: Query<
        (Entity, &mut RenderTarget, &Camera, Has<IsDefaultUiCamera>, Option<&mut TemporalAntiAliasing>, Has<ContrastAdaptiveSharpening>),
        (With<MainCamera>, With<Camera3d>),
    >,
    mut sprites: Query<&mut Sprite>,
    outputs: Query<&Camera, Without<MainCamera>>,
    mut projections: Query<&mut Projection, (With<MainCamera>, With<Camera3d>)>,
    tier: (Option<Res<crate::gfx::QualityPreset>>, Option<Res<crate::settings::CoreSettings>>),
    configured: Query<(), (With<MainCamera>, With<crate::gfx::AppliedQuality>)>,
) {
    // Bevy 0.20 recomputes a camera's target size (`computed.target_info`) on window/image
    // events or a projection change, not when its `RenderTarget` changes. After a retarget the
    // camera kept the old target's size and scale factor, so UI laid out on it (results
    // screen after scale went back to 1) sat in the wrong place and ignored the mouse.
    let mut retarget = |e: Entity| {
        if let Ok(mut p) = projections.get_mut(e) {
            p.set_changed();
        }
    };
    let Ok(window) = window.single() else { return };
    // What the upscale camera draws to (the window, or the offscreen image), once known.
    let out = scaled.as_ref().and_then(|s| outputs.get(s.camera).ok()).and_then(|c| c.physical_target_size().zip(c.logical_target_size()));
    let (physical, logical) = out.unwrap_or((window.physical_size(), window.size()));
    let main = mains.iter().next().map(|(e, ..)| e);
    let ceiling = match tier {
        (Some(preset), Some(settings)) if window.scale_factor() >= preset.hidpi_scale_factor && main.is_some_and(|m| configured.contains(m)) => {
            preset.hidpi_render_scale[settings.quality.index()].clamp(MIN_SCALE, 1.0)
        }
        _ => 1.0,
    };
    if rs.ceiling != ceiling {
        rs.ceiling = ceiling;
    }
    let want = RenderScale::quantize(rs.scale.min(ceiling));

    // Turn off: no main camera any more, scale back to 1, or a degenerate window.
    let off = want >= 1.0 || main.is_none() || physical.x == 0 || physical.y == 0;
    if off {
        if let Some(s) = scaled {
            if let Ok((_, mut target, _, _, taa, _)) = mains.get_mut(s.main) {
                *target = RenderTarget::Window(WindowRef::Primary);
                retarget(s.main);
                if let Some(mut taa) = taa {
                    taa.reset = true;
                }
                let mut ec = commands.entity(s.main);
                if !s.own_cas {
                    ec.remove::<ContrastAdaptiveSharpening>();
                }
                if s.main_was_ui {
                    ec.insert(IsDefaultUiCamera);
                }
            }
            commands.entity(s.camera).try_despawn();
            commands.entity(s.sprite).try_despawn();
            images.remove(&s.image);
            commands.remove_resource::<Scaled>();
        }
        if rs.applied != 1.0 || rs.size != UVec2::ZERO {
            rs.applied = 1.0;
            rs.size = UVec2::ZERO;
        }
        return;
    }
    let main = main.unwrap();
    let size = scaled_size(physical, want);

    match scaled {
        // Same camera: a new image when the window or the scale changed. Resizing the image in
        // place (`Image::resize`) leaves Bevy 0.20 drawing into the old GPU texture: the 3D view
        // froze while UI kept updating.
        Some(mut s) if s.main == main => {
            if rs.size != size {
                let mut image = Image::new_target_texture(size.x, size.y, TextureFormat::Rgba8UnormSrgb, None);
                image.sampler = ImageSampler::linear();
                let old = std::mem::replace(&mut s.image, images.add(image));
                images.remove(&old);
                if let Ok((.., Some(mut taa), _)) = mains.get_mut(main) {
                    taa.reset = true;
                }
            }
            if let Ok(mut sprite) = sprites.get_mut(s.sprite) {
                if sprite.custom_size != Some(logical) {
                    sprite.custom_size = Some(logical);
                }
                if sprite.image != s.image {
                    sprite.image = s.image.clone();
                }
            }
            if let Ok((_, mut target, ..)) = mains.get_mut(main)
                && target.as_image() != Some(&s.image)
            {
                *target = RenderTarget::from(s.image.clone());
                retarget(main);
            }
            s.main = main;
        }
        // First time (or the game respawned its camera): build the image and the upscaler.
        stale => {
            if let Some(s) = stale {
                commands.entity(s.camera).try_despawn();
                commands.entity(s.sprite).try_despawn();
                images.remove(&s.image);
            }
            let mut image = Image::new_target_texture(size.x, size.y, TextureFormat::Rgba8UnormSrgb, None);
            image.sampler = ImageSampler::linear();
            let handle = images.add(image);
            let Ok((_, mut target, cam, was_ui, taa, own_cas)) = mains.get_mut(main) else { return };
            *target = RenderTarget::from(handle.clone());
            retarget(main);
            if let Some(mut taa) = taa {
                taa.reset = true;
            }
            let order = cam.order + 1;
            let mut ec = commands.entity(main);
            ec.remove::<IsDefaultUiCamera>();
            if !own_cas && rs.sharpen > 0.0 {
                ec.insert(ContrastAdaptiveSharpening { enabled: true, sharpening_strength: rs.sharpen, denoise: false });
            }
            let camera = commands
                .spawn((
                    Name::new("render scale upscale"),
                    Camera2d,
                    Camera { order, ..default() },
                    Tonemapping::None,
                    DebandDither::Disabled,
                    Msaa::Off,
                    RenderLayers::layer(SCALE_LAYER),
                    IsDefaultUiCamera,
                ))
                .id();
            let sprite = commands
                .spawn((
                    Name::new("render scale image"),
                    Sprite { image: handle.clone(), custom_size: Some(logical), ..default() },
                    RenderLayers::layer(SCALE_LAYER),
                ))
                .id();
            commands.insert_resource(Scaled { image: handle, camera, sprite, main, main_was_ui: was_ui, own_cas });
        }
    }
    if rs.applied != want || rs.size != size {
        rs.applied = want;
        rs.size = size;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidpi_ceiling_defaults() {
        let p = crate::gfx::QualityPreset::default();
        assert_eq!(p.hidpi_render_scale.map(RenderScale::quantize), [0.7, 0.85, 1.0, 1.0]);
        assert!(p.hidpi_scale_factor > 1.0 && p.hidpi_scale_factor <= 2.0);
    }

    #[test]
    fn scales_quantize_and_sizes_round() {
        assert_eq!(RenderScale::quantize(0.98), 1.0);
        assert_eq!(RenderScale::quantize(0.72), 0.7);
        assert_eq!(RenderScale::quantize(0.1), MIN_SCALE);
        assert_eq!(scaled_size(UVec2::new(3024, 1964), 0.7), UVec2::new(2120, 1376));
        assert_eq!(scaled_size(UVec2::new(10, 10), 0.5), UVec2::splat(64));
    }
}
