//! Colour-blind filter (feature `actions`, from [`crate::actions::Accessibility::colorblind`]):
//! one full-screen pass on every 3D camera, after the UI pass and before upscaling, so HUD and
//! menus are filtered too. The pass is a single 3×3 matrix on linear RGB:
//!
//! - correct (default, "daltonize"): `c + k·E·(c − S·c)` — the colour information a
//!   protan/deutan/tritan viewer loses (`c − S·c`) is shifted into channels they can see.
//! - simulate (`colorblind_simulate`): `mix(c, S·c, k)`, for checking a palette.
//!
//! `S` = Machado et al. 2009 simulation matrices (severity 1). The component is removed while
//! the mode is `Off`, so the pass costs nothing then. 2D-only cameras aren't filtered.

use bevy::asset::uuid_handle;
use bevy::core_pipeline::fullscreen_material::{FullscreenMaterial, FullscreenMaterialPlugin};
use bevy::prelude::*;
use bevy::render::extract_component::ExtractComponent;
use bevy::render::render_resource::ShaderType;
use bevy::shader::{Shader, ShaderRef};

use crate::actions::{Accessibility, ColorblindMode};

const SHADER: Handle<Shader> = uuid_handle!("8f0c51c2-3c4e-4b5e-9d7f-6a3b2c1d0e11");

const SHADER_SRC: &str = r#"
#import bevy_core_pipeline::fullscreen_vertex_shader::FullscreenVertexOutput

@group(0) @binding(0) var screen_texture: texture_2d<f32>;
@group(0) @binding(1) var screen_sampler: sampler;
struct ColorFilter { r0: vec4<f32>, r1: vec4<f32>, r2: vec4<f32> }
@group(0) @binding(2) var<uniform> cb: ColorFilter;

@fragment
fn fragment(in: FullscreenVertexOutput) -> @location(0) vec4<f32> {
    let c = textureSample(screen_texture, screen_sampler, in.uv);
    let rgb = vec3(dot(cb.r0.xyz, c.rgb), dot(cb.r1.xyz, c.rgb), dot(cb.r2.xyz, c.rgb));
    return vec4(max(rgb, vec3(0.0)), c.a);
}
"#;

/// The filter on a camera: rows of the 3×3 colour matrix.
#[derive(Component, ExtractComponent, Clone, Copy, ShaderType, Default, Debug, PartialEq)]
pub struct ColorFilter {
    pub r0: Vec4,
    pub r1: Vec4,
    pub r2: Vec4,
}

impl FullscreenMaterial for ColorFilter {
    fn fragment_shader() -> ShaderRef {
        ShaderRef::Handle(SHADER)
    }
    fn schedule_configs(
        system: bevy::ecs::schedule::ScheduleConfigs<bevy::ecs::system::BoxedSystem>,
    ) -> bevy::ecs::schedule::ScheduleConfigs<bevy::ecs::system::BoxedSystem> {
        system.after(bevy::ui_render::render_pass::ui_pass).before(bevy::core_pipeline::upscaling::upscaling)
    }
}

/// Machado 2009 simulation matrix (row-major, linear RGB), severity 1.
pub fn simulation_matrix(mode: ColorblindMode) -> Mat3 {
    let rows = match mode {
        ColorblindMode::Off => return Mat3::IDENTITY,
        ColorblindMode::Protanopia => [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
        ColorblindMode::Deuteranopia => [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
        ColorblindMode::Tritanopia => [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
    };
    // Mat3 is column-major: transpose the rows.
    Mat3::from_cols_array_2d(&rows).transpose()
}

/// The full filter matrix for a mode, strength `k` and simulate/correct.
pub fn filter_matrix(mode: ColorblindMode, k: f32, simulate: bool) -> Mat3 {
    let s = simulation_matrix(mode);
    let k = k.clamp(0.0, 1.0);
    if mode == ColorblindMode::Off {
        return Mat3::IDENTITY;
    }
    if simulate {
        return Mat3::IDENTITY * (1.0 - k) + s * k;
    }
    // Error-shift (Fidaner et al.): protan/deutan losses go to green/blue, tritan to red/green.
    let shift = match mode {
        ColorblindMode::Tritanopia => Mat3::from_cols_array_2d(&[[1.0, 0.0, 0.7], [0.0, 1.0, 0.7], [0.0, 0.0, 0.0]]).transpose(),
        _ => Mat3::from_cols_array_2d(&[[0.0, 0.0, 0.0], [0.7, 1.0, 0.0], [0.7, 0.0, 1.0]]).transpose(),
    };
    Mat3::IDENTITY + shift * (Mat3::IDENTITY - s) * k
}

impl ColorFilter {
    pub fn from_matrix(m: Mat3) -> Self {
        let r = |i: usize| m.row(i).extend(0.0);
        ColorFilter { r0: r(0), r1: r(1), r2: r(2) }
    }
}

pub struct ColorblindPlugin;

impl Plugin for ColorblindPlugin {
    fn build(&self, app: &mut App) {
        if let Some(mut shaders) = app.world_mut().get_resource_mut::<Assets<Shader>>() {
            let _ = shaders.insert(SHADER.id(), Shader::from_wgsl(SHADER_SRC, "engine://colorblind.wgsl"));
        }
        app.add_plugins(FullscreenMaterialPlugin::<ColorFilter>::default()).add_systems(PostUpdate, sync_filter);
    }
}

/// Insert/update/remove [`ColorFilter`] on 3D cameras when the setting (or the cameras) change.
fn sync_filter(
    mut commands: Commands,
    access: Res<Accessibility>,
    added: Query<(), Added<Camera3d>>,
    cams: Query<(Entity, Option<&ColorFilter>), With<Camera3d>>,
) {
    if !access.is_changed() && added.is_empty() {
        return;
    }
    let on = access.colorblind != ColorblindMode::Off && access.colorblind_strength > 0.0;
    let want = ColorFilter::from_matrix(filter_matrix(access.colorblind, access.colorblind_strength, access.colorblind_simulate));
    for (e, cur) in &cams {
        match (on, cur) {
            (true, Some(c)) if *c == want => {}
            (true, _) => {
                commands.entity(e).insert(want);
            }
            (false, Some(_)) => {
                commands.entity(e).remove::<ColorFilter>();
            }
            (false, None) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrices() {
        assert_eq!(filter_matrix(ColorblindMode::Off, 1.0, false), Mat3::IDENTITY);
        assert_eq!(filter_matrix(ColorblindMode::Deuteranopia, 0.0, false), Mat3::IDENTITY);
        // Grey stays grey: simulation rows sum to ~1, so the error of a grey is ~0.
        for m in [ColorblindMode::Protanopia, ColorblindMode::Deuteranopia, ColorblindMode::Tritanopia] {
            for sim in [false, true] {
                let g = filter_matrix(m, 1.0, sim) * Vec3::splat(0.5);
                assert!((g - Vec3::splat(0.5)).abs().max_element() < 0.01, "{m:?} sim={sim}: {g}");
            }
        }
        // Simulated deuteranopia: pure red and pure green get much closer.
        let s = simulation_matrix(ColorblindMode::Deuteranopia);
        let (r, g) = (s * Vec3::X, s * Vec3::Y);
        assert!((r - g).length() < (Vec3::X - Vec3::Y).length() * 0.7);
        // Correction pushes them apart again for the simulated viewer.
        let c = filter_matrix(ColorblindMode::Deuteranopia, 1.0, false);
        let (cr, cg) = (s * (c * Vec3::X), s * (c * Vec3::Y));
        assert!((cr - cg).length() > (r - g).length(), "{cr} {cg} vs {r} {g}");
        let f = ColorFilter::from_matrix(c);
        assert!((f.r0.truncate().dot(Vec3::X) - (c * Vec3::X).x).abs() < 1e-6);
    }
}
