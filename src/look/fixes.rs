//! Render-world workarounds for Bevy 0.19 behaviour the look relies on.
//!
//! **Atmosphere removal**: Bevy extracts the atmosphere onto a camera's render entity but only
//! clears it for cameras that still have `AtmosphereSettings`, and the per-view uniforms /
//! offsets the sky passes need are never removed. A camera that drops `AtmosphereSettings`
//! (switching to a gradient or cubemap sky) keeps drawing the old atmosphere with stale LUTs —
//! a white haze at night. This removes those components from render views whose camera has no
//! `AtmosphereSettings`, so `render_sky`, the LUT and env passes skip them.

use bevy::pbr::resources::{AtmosphereTextures, AtmosphereTransformsOffset, GpuAtmosphere};
use bevy::pbr::{AtmosphereSettings, ExtractedAtmosphere, GpuAtmosphereSettings};
use bevy::prelude::*;
use bevy::render::extract_component::DynamicUniformIndex;
use bevy::render::sync_world::RenderEntity;
use bevy::render::{Extract, ExtractSchedule, RenderApp};

pub(super) fn plugin(app: &mut App) {
    let Some(render_app) = app.get_sub_app_mut(RenderApp) else { return };
    render_app.add_systems(ExtractSchedule, clear_stale_atmosphere.after(bevy::pbr::extract_atmosphere));
}

type Stale = (
    ExtractedAtmosphere,
    GpuAtmosphereSettings,
    AtmosphereTransformsOffset,
    AtmosphereTextures,
    DynamicUniformIndex<GpuAtmosphere>,
    DynamicUniformIndex<GpuAtmosphereSettings>,
);

fn clear_stale_atmosphere(
    mut commands: Commands,
    cams: Extract<Query<&RenderEntity, (With<Camera3d>, Without<AtmosphereSettings>)>>,
    views: Query<(), Or<(With<ExtractedAtmosphere>, With<AtmosphereTransformsOffset>, With<DynamicUniformIndex<GpuAtmosphere>>)>>,
) {
    for re in &cams {
        if views.contains(re.id()) {
            commands.entity(re.id()).remove::<Stale>();
        }
    }
}
