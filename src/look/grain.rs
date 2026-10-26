//! Film grain (Bevy 0.19 has no built-in one): a [`FullscreenMaterial`] before tonemapping.
//! Driven by `LensLook::film_grain` (0 = off, the component is removed) on tier `post_fx`.

use bevy::core_pipeline::fullscreen_material::{FullscreenMaterial, FullscreenMaterialPlugin};
use bevy::prelude::*;
use bevy::render::extract_component::ExtractComponent;
use bevy::render::render_resource::ShaderType;
use bevy::shader::ShaderRef;

/// Per-camera film grain settings (inserted by the look; usable by hand too).
#[derive(Component, ExtractComponent, Clone, Copy, ShaderType, Debug)]
pub struct FilmGrain {
    /// 0..1, ≈ 0.05 is subtle.
    pub intensity: f32,
    /// Seconds; animates the pattern (updated by the look every frame while grain is on).
    pub time: f32,
    /// Grain size in pixels.
    pub size: f32,
    pub _pad: f32,
}

impl Default for FilmGrain {
    fn default() -> Self {
        FilmGrain { intensity: 0.05, time: 0.0, size: 1.5, _pad: 0.0 }
    }
}

impl FullscreenMaterial for FilmGrain {
    fn fragment_shader() -> ShaderRef {
        "embedded://engine/look/film_grain.wgsl".into()
    }
}

pub(super) fn plugin(app: &mut App) {
    if app.get_sub_app(bevy::render::RenderApp).is_none() {
        return;
    }
    bevy::asset::embedded_asset!(app, "film_grain.wgsl");
    app.add_plugins(FullscreenMaterialPlugin::<FilmGrain>::default());
}

/// Advances the grain pattern (only runs while some camera has grain).
pub fn animate_grain(time: Res<Time<Real>>, mut q: Query<&mut FilmGrain>) {
    let t = time.elapsed_secs() % 1000.0;
    for mut g in &mut q {
        g.time = t;
    }
}
