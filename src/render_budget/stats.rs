//! Filling [`RenderStats`], GPU occlusion culling on the main camera, and (devtools) the
//! `render.*` metrics and control commands.
//!
//! Cheap totals every frame in every build (`meshes_total`, `meshes_visible`: two O(archetype)
//! lookups). With [`RenderBudget::detailed_stats`] (default on in `devtools` builds) one O(n)
//! pass over meshes (no allocation) splits the rest by reason: frustum, distance, actor/scenery,
//! near/far. GPU occlusion results stay on the GPU (no readback), so `culled_occlusion` is `None`.

use std::any::TypeId;

use bevy::camera::ShadowLodOrigin;
use bevy::camera::visibility::{VisibilityRange, VisibleEntities, VisibleEntityRanges};
use bevy::core_pipeline::prepass::{DeferredPrepass, DepthPrepass};
use bevy::prelude::*;
use bevy::render::occlusion_culling::OcclusionCulling;

use super::detail::{BudgetClass, DetailTier};
use super::{RenderBudget, RenderBudgetSystems, RenderStats};
use crate::flow::has_visuals;
use crate::gfx::{MainCamera, QualityPreset};
use crate::settings::CoreSettings;

/// `DepthPrepass` the render budget added for occlusion culling (removed with it).
#[derive(Component, Clone, Copy, Debug)]
pub struct BudgetDepthPrepass;

pub(super) struct StatsPlugin;

impl Plugin for StatsPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostUpdate, count_stats.in_set(RenderBudgetSystems::Stats))
            .add_systems(Update, apply_occlusion.run_if(has_visuals));
        #[cfg(feature = "devtools")]
        devtools::register(app);
    }
}

/// Copies the GPU's culling support from the render world (once).
pub(super) fn finish(app: &mut App) {
    use bevy::render::batching::gpu_preprocessing::GpuPreprocessingSupport;
    use bevy::render::{ExtractSchedule, MainWorld, RenderApp};

    fn report(support: Option<Res<GpuPreprocessingSupport>>, mut main: ResMut<MainWorld>, mut done: Local<bool>) {
        if *done {
            return;
        }
        let Some(support) = support else { return };
        *done = true;
        let ok = support.is_culling_supported();
        info!("render_budget: GPU occlusion culling {}", if ok { "supported" } else { "not supported on this GPU" });
        if let Some(mut stats) = main.get_resource_mut::<RenderStats>() {
            stats.occlusion_supported = Some(ok);
        }
    }

    if let Some(render_app) = app.get_sub_app_mut(RenderApp) {
        render_app.add_systems(ExtractSchedule, report);
    }
}

/// Occlusion culling (+ depth prepass) on `Camera3d` main cameras when the budget, the quality
/// preset and the GPU allow it; `ShadowLodOrigin` on them so shadow detail ranges are measured
/// from the player, not from a UI camera.
fn apply_occlusion(
    mut commands: Commands,
    budget: Res<RenderBudget>,
    preset: Res<QualityPreset>,
    settings: Res<CoreSettings>,
    mut stats: ResMut<RenderStats>,
    cams: Query<
        (Entity, Has<OcclusionCulling>, Has<DepthPrepass>, Has<BudgetDepthPrepass>, Has<DeferredPrepass>, Has<ShadowLodOrigin>, Has<bevy::anti_alias::taa::TemporalAntiAliasing>),
        (With<MainCamera>, With<Camera3d>),
    >,
) {
    let allowed = budget.occlusion_culling && preset.occlusion_culling[settings.quality.index()] && stats.occlusion_supported == Some(true);
    let mut active = false;
    for (e, occ, depth, ours, deferred, lod_origin, taa) in &cams {
        let mut ec = commands.entity(e);
        if !lod_origin {
            ec.insert(ShadowLodOrigin);
        }
        // Occlusion culling is unspecified with deferred shading: leave those cameras alone.
        let want = allowed && !deferred;
        if want && !occ {
            ec.insert(OcclusionCulling);
            if !depth {
                ec.insert((DepthPrepass, BudgetDepthPrepass));
            }
        } else if !want && occ {
            ec.remove::<OcclusionCulling>();
            if ours {
                ec.remove::<BudgetDepthPrepass>();
                if !taa {
                    ec.remove::<DepthPrepass>();
                }
            }
        }
        active |= want;
    }
    if stats.occlusion_culling != active {
        stats.occlusion_culling = active;
    }
}

fn count_stats(
    budget: Res<RenderBudget>,
    mut stats: ResMut<RenderStats>,
    cams: Query<(Entity, &VisibleEntities, &GlobalTransform), With<MainCamera>>,
    all: Query<(), With<Mesh3d>>,
    meshes: Query<(Entity, &InheritedVisibility, Option<&DetailTier>, Option<&VisibilityRange>, &GlobalTransform), With<Mesh3d>>,
    classes: Query<(Option<&BudgetClass>, Option<&DetailTier>)>,
    ranges: Option<Res<VisibleEntityRanges>>,
    cpu: Res<super::BudgetCpu>,
) {
    let _cpu = cpu.time();
    let s = &mut *stats;
    s.meshes_total = all.iter().len() as u32;
    let Some((cam, visible, eye)) = cams.iter().next() else {
        s.meshes_visible = 0;
        return;
    };
    let visible = visible.get(TypeId::of::<Mesh3d>());
    s.meshes_visible = visible.len() as u32;
    if !budget.detailed_stats {
        return;
    }
    let (mut actors, mut scenery, mut near, mut far) = (0, 0, 0, 0);
    for &e in visible {
        match classes.get(e) {
            Ok((Some(BudgetClass::Actor), _)) => actors += 1,
            Ok((Some(BudgetClass::Scenery), tier)) => {
                scenery += 1;
                if tier == Some(&DetailTier::Far) {
                    far += 1;
                } else {
                    near += 1;
                }
            }
            _ => {}
        }
    }
    let eye = eye.translation();
    let (mut in_range, mut culled_distance) = (0u32, 0u32);
    for (e, inherited, tier, range, gt) in &meshes {
        if !inherited.get() {
            continue;
        }
        let out = range.is_some() && ranges.as_ref().is_some_and(|r| !r.entity_is_in_range_of_view(e, cam));
        if !out {
            in_range += 1;
            continue;
        }
        // A near piece swapped for its far twin isn't "culled"; a far twin beyond view is.
        culled_distance += match tier {
            Some(DetailTier::Near) => 0,
            Some(DetailTier::Far) => range.is_some_and(|r| gt.translation().distance(eye) >= r.start_margin.end) as u32,
            _ => 1,
        };
    }
    s.actors_visible = actors;
    s.scenery_visible = scenery;
    s.lod_near = near;
    s.lod_far = far;
    s.culled_distance = culled_distance;
    s.culled_frustum = in_range.saturating_sub(s.meshes_visible);
}

#[cfg(feature = "devtools")]
mod devtools {
    use bevy::prelude::*;
    use serde_json::{Value, json};

    use super::super::pacing::PacingSystems;
    use super::super::{EffectiveRanges, RenderBudget, RenderStats};
    use super::super::RenderBudgetSystems;
    use crate::devtools::{AddControlCommand, Metrics, PerfAppExt, params};

    pub(super) fn register(app: &mut App) {
        // Wall time from the first to the last system of each set (an upper bound: other
        // systems may run in parallel in between).
        app.perf_span(PostUpdate, RenderBudgetSystems::Stream, "budget.stream")
            .perf_span(PostUpdate, RenderBudgetSystems::Detail, "budget.detail")
            .perf_span(PostUpdate, RenderBudgetSystems::Stats, "budget.stats");
        // Headless runs have no renderer: nothing to report (and a game may record its own).
        app.add_systems(Last, record_metrics.after(PacingSystems).run_if(crate::flow::has_visuals))
            .add_control_command("render.stats", "Render budget counters, switches and distances", params(&[]), render_stats)
            .add_control_command(
                "render.budget",
                "Turn render budget optimisations on/off (omitted = unchanged)",
                params(&[
                    ("occlusion", "boolean", "GPU occlusion culling"),
                    ("detail", "boolean", "scenery distance detail"),
                    ("shadow_trim", "boolean", "no shadows from far scenery"),
                    ("streaming", "boolean", "respawn-mode cell streaming"),
                    ("stream_spawned", "boolean", "hide-mode streaming of spawned scenery"),
                    ("idle_skip", "boolean", "skip rendering unchanged frames"),
                    ("detailed_stats", "boolean", "per-mesh stats"),
                ]),
                render_budget,
            );
    }

    /// Every [`RenderStats`] field as `render.<field>` (booleans as 0/1).
    fn record_metrics(stats: Res<RenderStats>, metrics: Option<ResMut<Metrics>>) {
        let Some(mut m) = metrics else { return };
        let s = &*stats;
        m.record("render.frames_rendered", s.frames_rendered as f64);
        m.record("render.frames_skipped", s.frames_skipped as f64);
        m.record("render.meshes_total", s.meshes_total as f64);
        m.record("render.meshes_visible", s.meshes_visible as f64);
        m.record("render.culled_frustum", s.culled_frustum as f64);
        m.record("render.culled_distance", s.culled_distance as f64);
        if let Some(n) = s.culled_occlusion {
            m.record("render.culled_occlusion", n as f64);
        }
        m.record("render.actors_visible", s.actors_visible as f64);
        m.record("render.scenery_visible", s.scenery_visible as f64);
        m.record("render.lod_near", s.lod_near as f64);
        m.record("render.lod_far", s.lod_far as f64);
        m.record("render.cells_loaded", s.cells_loaded as f64);
        m.record("render.cells_total", s.cells_total as f64);
        m.record("render.streamed_in", s.streamed_in as f64);
        m.record("render.streamed_out", s.streamed_out as f64);
        m.record("render.occlusion_culling", s.occlusion_culling as u8 as f64);
        if let Some(ok) = s.occlusion_supported {
            m.record("render.occlusion_supported", ok as u8 as f64);
        }
        m.record("render.shadows_trimmed", s.shadows_trimmed as f64);
        m.record("render.stream_hidden", s.stream_hidden as f64);
        m.record("render.stream_live", s.stream_live as f64);
        m.record("render.cpu_us", s.cpu_us as f64);
    }

    pub fn stats_json(world: &World) -> Value {
        let s = world.resource::<RenderStats>();
        let b = world.resource::<RenderBudget>();
        let r = &world.resource::<EffectiveRanges>().0;
        json!({
            "frames_rendered": s.frames_rendered, "frames_skipped": s.frames_skipped,
            "meshes_total": s.meshes_total, "meshes_visible": s.meshes_visible,
            "culled_frustum": s.culled_frustum, "culled_distance": s.culled_distance, "culled_occlusion": s.culled_occlusion,
            "actors_visible": s.actors_visible, "scenery_visible": s.scenery_visible,
            "lod_near": s.lod_near, "lod_far": s.lod_far,
            "cells_loaded": s.cells_loaded, "cells_total": s.cells_total,
            "streamed_in": s.streamed_in, "streamed_out": s.streamed_out,
            "occlusion_culling": s.occlusion_culling, "occlusion_supported": s.occlusion_supported,
            "shadows_trimmed": s.shadows_trimmed, "stream_hidden": s.stream_hidden, "stream_live": s.stream_live,
            "redraw_reason": s.redraw_reason, "cpu_us": s.cpu_us,
            "entities": world.entities().count_spawned(),
            "budget": {
                "occlusion": b.occlusion_culling, "detail": b.scenery_detail, "shadow_trim": b.shadow_trim,
                "streaming": b.streaming, "stream_spawned": b.stream_spawned_scenery, "idle_skip": b.idle_skip,
                "detailed_stats": b.detailed_stats,
            },
            "ranges": {"shadow": r.shadow, "small_props": r.small_props, "far": r.far, "view": r.view, "buffer": r.buffer, "fade": r.fade},
        })
    }

    fn render_stats(world: &mut World, _: Value) -> Result<Value, String> {
        Ok(stats_json(world))
    }

    fn render_budget(world: &mut World, p: Value) -> Result<Value, String> {
        {
            let mut b = world.resource_mut::<RenderBudget>();
            let set = |key: &str, field: &mut bool| {
                if let Some(v) = p.get(key).and_then(Value::as_bool) {
                    *field = v;
                }
            };
            let b = &mut *b;
            set("occlusion", &mut b.occlusion_culling);
            set("detail", &mut b.scenery_detail);
            set("shadow_trim", &mut b.shadow_trim);
            set("streaming", &mut b.streaming);
            set("stream_spawned", &mut b.stream_spawned_scenery);
            set("idle_skip", &mut b.idle_skip);
            set("detailed_stats", &mut b.detailed_stats);
        }
        Ok(stats_json(world)["budget"].clone())
    }
}
