//! Rendering presets and texture helpers. Owner: core stream (port from Shroud `gfx.rs`:
//! `camera_components`/`apply_camera_quality`, `PendingMips` + `generate_mips`/`build_mips`,
//! `load_pbr`, `world_uv_cuboid`; leave sun/sky/fog choices to games but offer
//! [`sky_and_sun`] as an optional helper).
//!
//! - Tag the game's camera with [`MainCamera`]; the engine adds the quality bundle for
//!   `CoreSettings.quality`, keeps FOV in sync with `CoreSettings.fov_deg` (perspective only),
//!   attaches the spatial audio listener, and re-applies when settings change. The engine never
//!   touches `Exposure`, `DistanceFog` or atmosphere components (games own the look).

use bevy::prelude::*;

/// The camera the player sees through (one per app).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct MainCamera;

/// Per-quality camera features (Low: no SSAO/bloom, FXAA, small shadows … Ultra: best SSAO,
/// big shadows). Games may override with their own resource value.
#[derive(Resource, Clone, Debug)]
pub struct QualityPreset {
    pub ssao: [bool; 4],
    pub bloom: [bool; 4],
    pub taa: [bool; 4],
    pub shadow_map_size: [usize; 4],
}

impl Default for QualityPreset {
    fn default() -> Self {
        QualityPreset {
            ssao: [false, false, true, true],
            bloom: [false, true, true, true],
            taa: [false, true, true, true],
            shadow_map_size: [1024, 2048, 2048, 4096],
        }
    }
}

/// Images that still need a CPU-built mip chain (JPG/PNG ship without mips).
#[derive(Resource, Default)]
pub struct PendingMips(pub bevy::platform::collections::HashSet<AssetId<Image>>);

pub struct GfxPlugin;

impl Plugin for GfxPlugin {
    fn build(&self, app: &mut App) {
        let _ = app;
        todo!("core stream")
    }
}

/// Optional helper: atmosphere sky + shadowed sun + ambient, like Shroud's default look.
pub fn sky_and_sun(commands: &mut Commands) {
    let _ = commands;
    todo!("core stream")
}
