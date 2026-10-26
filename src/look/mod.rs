//! Code-first scene look (feature `look`): a [`Look`] resource describes sun, sky, ambient and
//! environment light, distance + volumetric fog, exposure (manual / auto), tonemapping, colour
//! grading, bloom tuning and lens effects as plain data; [`LookPlugin`] applies it to the
//! [`crate::gfx::MainCamera`], the sun, the sky and the world. Docs: `docs/LOOK.md`.
//!
//! ```ignore
//! app.insert_resource(Look::dusk());                                   // a preset
//! app.insert_resource(Look { fog: FogLook { visibility: 300.0, ..Look::dusk().fog }, ..Look::dusk() });
//! commands.insert_resource(LookTransition::new(current, Look::night(), 5.0)); // blend
//! app.insert_resource(LookTimeline::day_cycle(24.0 / 600.0));          // 10-minute days
//! commands.spawn((ReflectionProbe::default(), Transform::from_xyz(0., 2., 0.).with_scale(Vec3::new(8., 4., 8.))));
//! ```
//!
//! - Quality: [`crate::gfx::QualityPreset`] holds per-tier flags; costly pieces (volumetric fog,
//!   env lighting, auto exposure, DOF / motion blur, vignette / chromatic aberration, realtime
//!   probes, SSR, contact shadows) only run where the tier allows them. Nothing expensive at Low.
//! - Zero cost unused: without a `Look` resource and probes no look system does any work.
//!   With one, the apply system runs only on change (or while a transition/timeline animates).
//! - Headless: the look still writes its camera components (tests inspect them); sky images and
//!   the atmosphere need the renderer and are skipped.
//! - Control commands (feature `devtools`): `look.get`, `look.set {preset, fields, blend}`,
//!   `look.feature {name, on}`, `look.time {time, speed, stop}`, `look.probe {bake}`.

pub mod apply;
pub mod decal;
pub mod desc;
pub mod features;
mod fixes;
pub mod grain;
mod presets;
pub mod probe;
pub mod sky;
pub mod timeline;

#[cfg(feature = "devtools")]
mod control;

use bevy::prelude::*;

pub use apply::{LookCapture, LookConfig, LookState, LookSun, Tier};
pub use decal::{decal_image, decal_material, spawn_decal};
pub use desc::{
    AmbientLook, BloomLook, DofLook, ExposureLook, FogLook, FogMode, GradeSection, GradingLook, LensLook, Lerp, Look, MotionBlurLook, Rgb, SkyLook,
    SkyMode, SunLook, ToneMap, VignetteLook, VolumetricLook,
};
pub use features::FEATURES;
pub use grain::FilmGrain;
pub use probe::{ReflectionProbe, irradiance_volume_image, sky_ambient_cube};
pub use timeline::{LookTimeline, LookTransition};

use crate::gfx::QualitySet;

pub struct LookPlugin;

impl Plugin for LookPlugin {
    fn build(&self, app: &mut App) {
        // Histogram auto exposure isn't in Bevy's default plugins.
        if app.get_sub_app(bevy::render::RenderApp).is_some() && !app.is_plugin_added::<bevy::post_process::auto_exposure::AutoExposurePlugin>() {
            app.add_plugins(bevy::post_process::auto_exposure::AutoExposurePlugin);
        }
        app.init_resource::<LookConfig>()
            .init_resource::<apply::EnvFilterCounter>()
            .init_resource::<LookState>()
            // gfx's QualityPreset / CoreSettings may not exist in bare test apps.
            .init_resource::<crate::gfx::QualityPreset>()
            .add_systems(
                Update,
                (
                    (
                        timeline::advance_timeline.run_if(resource_exists::<LookTimeline>),
                        timeline::advance_transition.run_if(resource_exists::<LookTransition>),
                    )
                        .before(apply::apply_look),
                    apply::apply_look.run_if(apply::look_dirty),
                    apply::pump_sky.run_if(apply::sky_busy).after(apply::apply_look),
                    apply::drive_sky_env.run_if(apply::sky_env_busy).after(apply::pump_sky),
                    grain::animate_grain.run_if(any_with_component::<grain::FilmGrain>),
                    apply::follow_fog_volume.run_if(any_with_component::<apply::LookFogVolume>).after(apply::apply_look),
                    decal::keep_depth_for_decals
                        .run_if(any_with_component::<bevy::pbr::decal::ForwardDecal>.or_else(any_with_component::<crate::gfx::KeepDepthPrepass>)),
                )
                    .in_set(QualitySet::Look),
            )
            .configure_sets(Update, (QualitySet::Apply, QualitySet::Look, QualitySet::Prune).chain());
        probe::plugin(app);
        fixes::plugin(app);
        grain::plugin(app);
        #[cfg(feature = "devtools")]
        control::register(app);
    }
}
