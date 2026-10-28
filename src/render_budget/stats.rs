//! Filling [`RenderStats`], GPU occlusion culling on the main camera, and (devtools) the
//! `render.*` metrics and control commands.
//!
//! Cheap totals every frame in every build (`meshes_total`, `meshes_visible`: two O(archetype)
//! lookups). With [`RenderBudget::detailed_stats`] (default on in `devtools` builds) one O(n)
//! pass over meshes (no allocation) splits the rest by reason: frustum, distance, actor/scenery,
//! near/far. GPU occlusion results stay on the GPU (no readback), so `culled_occlusion` is `None`.

use std::any::TypeId;

use bevy::camera::ShadowLodOrigin;
use bevy::camera::primitives::Frustum;
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
        use bevy::camera::visibility::VisibilitySystems;
        app.add_systems(PostUpdate, count_stats.in_set(RenderBudgetSystems::Stats))
            .add_systems(
                PostUpdate,
                guard_main_view
                    .after(VisibilitySystems::UpdateFrusta)
                    .after(bevy::camera::CameraUpdateSystems)
                    .before(VisibilitySystems::CheckVisibility),
            )
            .add_systems(Update, apply_occlusion.run_if(has_visuals));
        #[cfg(feature = "devtools")]
        devtools::register(app);
    }
}

/// Keeps the main camera's culling volume true to what it draws. Bevy recomputes a `Frustum`
/// only when the camera's transform or projection is marked changed, and the aspect ratio
/// only on window events. A window opened occluded (behind a fullscreen app in another macOS
/// Space) once left Shroud's camera culling nearly all scenery for a whole round. Here, every
/// frame: an aspect ratio that disagrees with the viewport is reset, and a frustum that
/// disagrees with projection × transform is rebuilt. Each repair counts in
/// [`RenderStats::view_fixes`] (with a one-time warning), so the cause stays visible.
fn guard_main_view(
    mut cams: Query<(&GlobalTransform, &mut Projection, &mut Frustum, &mut Camera), With<MainCamera>>,
    mut stats: ResMut<RenderStats>,
    mut warned: Local<bool>,
) {
    stats.frustum_stale = false;
    for (gt, mut proj, mut frustum, mut camera) in &mut cams {
        if !camera.is_active {
            continue;
        }
        let mut what = None;
        if let (Projection::Perspective(p), Some(size), None) = (proj.as_ref(), camera.logical_viewport_size(), camera.sub_camera_view)
            && size.x > 0.0
            && size.y > 0.0
            && (p.aspect_ratio - size.x / size.y).abs() > 1e-3 * p.aspect_ratio.max(1e-3)
        {
            proj.update(size.x, size.y);
            camera.computed.clip_from_view = proj.get_clip_from_view();
            what = Some("aspect ratio");
        }
        let want = proj.compute_frustum(gt);
        if frustum.half_spaces.iter().zip(&want.half_spaces).any(|(a, b)| !a.normal_d().abs_diff_eq(b.normal_d(), 1e-3)) {
            *frustum = want;
            stats.frustum_stale = true;
            what.get_or_insert("frustum");
        }
        if let Some(what) = what {
            stats.view_fixes += 1;
            if !*warned {
                *warned = true;
                warn!("render_budget: main camera {what} was out of date (viewport {:?}); repaired", camera.logical_viewport_size());
            }
        }
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
    views: Query<(&GlobalTransform, Option<&Projection>, Option<&Camera>), With<MainCamera>>,
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
    if let Some((gt, proj, camera)) = views.iter().next() {
        s.eye = gt.translation();
        s.eye_forward = gt.forward().as_vec3();
        s.aspect = match proj {
            Some(Projection::Perspective(p)) => p.aspect_ratio,
            _ => 0.0,
        };
        s.viewport = camera.and_then(Camera::logical_viewport_size).unwrap_or_default();
    }
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
    use crate::devtools::{AddControlCommand, Metrics, params};

    pub(super) fn register(app: &mut App) {
        // No `perf_span`s here: their wall-time window takes in Bevy's visibility systems
        // running alongside (they read 1-3 ms for ~0.3 ms of work). The budget's own CPU time
        // is `render.cpu_us` (`BudgetCpu`).
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
            )
            .add_control_command(
                "render.governor",
                "Quality governor state; set enabled, target_fps, max_scale, or scale (with enabled=false)",
                params(&[
                    ("enabled", "boolean", "governor on/off"),
                    ("target_fps", "number", "frame rate to hold"),
                    ("max_scale", "number", "highest render scale it uses (0.4..1)"),
                    ("scale", "number", "render scale to force (only while the governor is off)"),
                ]),
                render_governor,
            )
            .add_systems(PreUpdate, feed_gpu_load);
    }

    /// The perf monitor's GPU busy share → the governor's GPU-bound test.
    /// Also the main-thread and GPU ms per frame for the FPS counter.
    fn feed_gpu_load(
        shared: Option<Res<crate::devtools::perf::PerfShared>>,
        mut load: ResMut<super::super::GpuLoad>,
        mut cost: ResMut<super::super::FrameCost>,
    ) {
        let snap = shared.and_then(|s| s.latest());
        let busy = snap.as_ref().map(|s| s.gpu.process.now).filter(|p| *p > 0.0).map(|p| p / 100.0);
        if load.0 != busy {
            load.0 = busy;
        }
        let frame = snap.as_ref().map(|s| s.frame_avg_ms.now).filter(|f| *f > 0.0);
        let cpu = snap.as_ref().and_then(|s| s.cpu.threads.iter().find(|t| t.name == "main")).zip(frame).map(|(t, f)| (t.cpu_pct / 100.0 * f).min(f));
        let gpu = snap.as_ref().map(|s| s.gpu.frame_ms.now).filter(|v| *v > 0.0);
        let next = super::super::FrameCost { cpu_ms: cpu, gpu_ms: gpu };
        if cost.cpu_ms != next.cpu_ms || cost.gpu_ms != next.gpu_ms {
            *cost = next;
        }
    }

    fn governor_json(world: &World) -> Value {
        use super::super::{GovernorState, QualityGovernor, RenderScale};
        let g = world.resource::<QualityGovernor>();
        let st = world.resource::<GovernorState>();
        let rs = world.resource::<RenderScale>();
        let steps: Vec<String> = g.steps.iter().map(|s| s.label()).collect();
        json!({
            "enabled": g.enabled, "target_fps": g.target_fps, "max_scale": g.max_scale,
            "level": st.level, "levels": g.steps.len(), "memory_level": st.memory_level,
            "applied": steps.iter().take(st.level).collect::<Vec<_>>(),
            "load_ms": st.load_ms, "frame_ms": st.frame_ms, "gpu_bound": st.gpu_bound,
            "gpu_busy": world.resource::<super::super::GpuLoad>().0,
            "hold_until": st.hold_until, "changes": st.changes, "last_reason": st.last_reason.map(|r| format!("{r:?}")),
            "footprint_mb": st.footprint_mb, "memory_budget_mb": st.memory_budget_mb,
            "scale": {"wanted": rs.scale, "applied": rs.applied, "size": [rs.size.x, rs.size.y]},
        })
    }

    fn render_governor(world: &mut World, p: Value) -> Result<Value, String> {
        use super::super::{QualityGovernor, RenderScale};
        {
            let mut g = world.resource_mut::<QualityGovernor>();
            if let Some(v) = p.get("enabled").and_then(Value::as_bool) {
                g.enabled = v;
            }
            if let Some(v) = p.get("target_fps").and_then(Value::as_f64) {
                g.target_fps = (v as f32).clamp(10.0, 500.0);
            }
            if let Some(v) = p.get("max_scale").and_then(Value::as_f64) {
                g.max_scale = (v as f32).clamp(super::super::scale::MIN_SCALE, 1.0);
            }
        }
        if let Some(v) = p.get("scale").and_then(Value::as_f64) {
            if world.resource::<QualityGovernor>().enabled {
                return Err("`scale` needs the governor off (enabled=false), else it owns the scale".into());
            }
            world.resource_mut::<RenderScale>().scale = (v as f32).clamp(super::super::scale::MIN_SCALE, 1.0);
        }
        Ok(governor_json(world))
    }

    /// Every [`RenderStats`] field as `render.<field>` (booleans as 0/1).
    fn record_metrics(
        stats: Res<RenderStats>,
        scale: Res<super::super::RenderScale>,
        gov: Res<super::super::GovernorState>,
        metrics: Option<ResMut<Metrics>>,
    ) {
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
        m.record("render.aspect", s.aspect as f64);
        m.record("render.frustum_stale", s.frustum_stale as u8 as f64);
        m.record("render.view_fixes", s.view_fixes as f64);
        m.record("render.scale", scale.applied as f64);
        m.record("render.governor_level", gov.level as f64);
        m.record("render.governor_load_ms", gov.load_ms as f64);
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
            "redraw_reason": s.redraw_reason, "cpu_us": s.cpu_us, "cameras": s.cameras,
            "eye": [s.eye.x, s.eye.y, s.eye.z], "eye_forward": [s.eye_forward.x, s.eye_forward.y, s.eye_forward.z],
            "aspect": s.aspect, "viewport": [s.viewport.x, s.viewport.y], "frustum_stale": s.frustum_stale, "view_fixes": s.view_fixes,
            "governor": governor_json(world),
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

#[cfg(test)]
mod tests {
    use bevy::camera::RenderTargetInfo;

    use super::*;

    fn app() -> App {
        let mut app = App::new();
        app.init_resource::<RenderStats>().add_systems(Update, guard_main_view);
        app
    }

    #[test]
    fn stale_frustum_and_aspect_are_repaired() {
        let mut app = app();
        let mut camera = Camera::default();
        camera.computed.target_info = Some(RenderTargetInfo { physical_size: UVec2::new(1600, 900), scale_factor: 1.0 });
        let gt = GlobalTransform::from(Transform::from_xyz(0.0, 1.7, 27.0).looking_to(Vec3::NEG_Z, Vec3::Y));
        // Aspect from a sliver-shaped window, frustum from another pose.
        let proj = Projection::Perspective(PerspectiveProjection { aspect_ratio: 0.05, ..default() });
        let old = proj.compute_frustum(&GlobalTransform::from(Transform::from_xyz(0.0, 50.0, -300.0)));
        let cam = app.world_mut().spawn((MainCamera, camera, proj, old, gt)).id();
        app.update();
        let w = app.world();
        let Projection::Perspective(p) = w.get::<Projection>(cam).unwrap() else { panic!() };
        assert!((p.aspect_ratio - 16.0 / 9.0).abs() < 1e-4, "aspect {}", p.aspect_ratio);
        let want = w.get::<Projection>(cam).unwrap().compute_frustum(&gt);
        let got = w.get::<Frustum>(cam).unwrap();
        assert!(got.half_spaces.iter().zip(&want.half_spaces).all(|(a, b)| a.normal_d().abs_diff_eq(b.normal_d(), 1e-5)));
        assert_eq!(w.resource::<RenderStats>().view_fixes, 1);
        // Healthy from here on: no more repairs.
        app.update();
        assert_eq!(app.world().resource::<RenderStats>().view_fixes, 1);
        assert!(!app.world().resource::<RenderStats>().frustum_stale);
    }
}
