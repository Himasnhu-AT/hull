//! Render budget: draw only what the player can see, in as much detail as it deserves.
//! Owner: render stream. Contract (stable names, the metrics stream codes against them):
//!
//! - [`Actor`]: things that move or matter up close (player, enemies, pickups, props the
//!   player can push). Always full detail when visible, always cast shadows.
//! - [`Scenery`]: static world geometry and dressing. May be streamed out when far, drawn
//!   with a cheaper far version, lose shadows, or be culled behind walls.
//! - [`RenderStats`]: per-frame counts, updated by this module. Cheap to keep; filled in
//!   every build, charted by `devtools::metrics` in dev builds (keys `render.<field>`).
//!
//! **COLLIDERS ARE NEVER STREAMED: only visuals.** Physics, AI raycasts and navigation always
//! see the whole map. Hide-mode streaming only flips `Visibility`; respawn-mode streaming
//! (`SceneryStream::add`) only spawns what the game's factory returns, and the factory must
//! spawn visuals only (a collider on a streamed visual logs a warning).
//!
//! # What the engine does (see `docs/PORTING.md`, "Render budget")
//!
//! All of it is on for every game ([`RenderBudgetPlugin`] is part of `EnginePlugin`); a game
//! needs zero code. Tune or turn parts off through [`RenderBudget`], [`SceneryRanges`],
//! [`FramePacing`] and [`SceneryStream`].
//!
//! 0. **Classification**: explicit [`Actor`] / [`Scenery`] tags win. Untagged meshes are sorted
//!    automatically ([`RenderBudget::auto_classify`]): under a camera, skinned/morphed or under a
//!    non-static avian `RigidBody` → actor; otherwise scenery once it has stood still for
//!    [`RenderBudget::settle_frames`]; auto scenery that moves later turns back into an actor.
//! 1. **Culling**: Bevy's CPU frustum culling (always on) is counted in [`RenderStats`]. GPU
//!    occlusion culling (`OcclusionCulling` + `DepthPrepass`) goes on the [`MainCamera`] when
//!    [`RenderBudget::occlusion_culling`], [`QualityPreset::occlusion_culling`] for the current
//!    quality and the GPU all allow it ([`RenderStats::occlusion_culling`] says whether it is on).
//! 2. **Distance detail** for [`Scenery`] meshes (never [`Actor`]s), with Bevy's dithered
//!    `VisibilityRange` crossfades: small pieces vanish beyond [`SceneryRanges::small_props`];
//!    big pieces switch to a far version beyond [`SceneryRanges::far`] (the game's [`FarLook`],
//!    else the same mesh with a flat untextured material and no shadows) and vanish beyond
//!    [`SceneryRanges::view`]; small scenery stops casting shadows beyond
//!    [`SceneryRanges::shadow`] (big pieces keep theirs until they turn far).
//!    Distances scale with [`QualityPreset::detail_scale`]. [`KeepDetail`] opts a piece out.
//! 3. **Streaming** ([`stream`]): scenery is grouped in XZ cells; cells within view distance +
//!    buffer of the camera are resident (with hysteresis). Scenery registered as data with
//!    [`SceneryStream::add`] is spawned/despawned, a budgeted number per frame ("respawn"
//!    mode); spawned `Scenery` roots can instead be hidden when out of range ("hide" mode,
//!    [`RenderBudget::stream_spawned_scenery`]).
//! 4. **Frame pacing** ([`pacing`]): menus and pause update reactively (GPU idles); gameplay is
//!    continuous. Opt-in [`RenderBudget::idle_skip`] skips rendering frames where nothing
//!    visible changed.
//!
//! [`MainCamera`]: crate::gfx::MainCamera
//! [`QualityPreset::occlusion_culling`]: crate::gfx::QualityPreset::occlusion_culling
//! [`QualityPreset::detail_scale`]: crate::gfx::QualityPreset::detail_scale

use bevy::prelude::*;

pub mod detail;
pub mod governor;
pub mod pacing;
pub mod scale;
pub mod stats;
pub mod stream;
pub mod warmup;

pub use detail::{AutoActor, AutoScenery, BudgetClass, DetailTier, FarLook, KeepDetail};
pub use governor::{FrameCost, GovernorReason, GovernorState, GovernorStep, GpuLoad, GpuSample, QualityChanged, QualityGovernor};
pub use pacing::FramePacing;
pub use scale::RenderScale;
pub use warmup::{PipelineWarmup, WarmPipelines, WarmupStats};
pub use stream::{SceneryStream, StreamItem};

/// Moves or matters up close: rendered at full detail whenever visible.
#[derive(Component, Reflect, Clone, Copy, Debug, Default)]
#[reflect(Component)]
pub struct Actor;

/// Static world visuals: eligible for streaming, distance detail levels and shadow trimming.
/// Put it on the root of a piece (its mesh children are covered too). Scenery is assumed not to
/// move; after moving one, remove and re-insert `Scenery`.
#[derive(Component, Reflect, Clone, Copy, Debug, Default)]
#[reflect(Component)]
pub struct Scenery;

/// What the renderer did this frame (and running totals). Fields may be added; never renamed.
#[derive(Resource, Clone, Debug, Default)]
pub struct RenderStats {
    /// Frames the GPU drew / frames skipped because nothing changed (totals since start).
    pub frames_rendered: u64,
    pub frames_skipped: u64,
    /// Meshes in the world / meshes the camera drew this frame.
    pub meshes_total: u32,
    pub meshes_visible: u32,
    /// Hidden this frame by: view frustum, distance (detail ranges), occlusion (GPU, when known).
    pub culled_frustum: u32,
    pub culled_distance: u32,
    pub culled_occlusion: Option<u32>,
    /// Visible actors / visible scenery.
    pub actors_visible: u32,
    pub scenery_visible: u32,
    /// Scenery drawn at near (full) / far (cheap) detail.
    pub lod_near: u32,
    pub lod_far: u32,
    /// Scenery streaming cells resident / total.
    pub cells_loaded: u32,
    pub cells_total: u32,
    /// Scenery entities spawned / despawned this frame by streaming.
    pub streamed_in: u32,
    pub streamed_out: u32,
    /// GPU occlusion culling is on for the main camera this frame.
    pub occlusion_culling: bool,
    /// The GPU can do occlusion culling (`None` until the renderer has started).
    pub occlusion_supported: Option<bool>,
    /// Small scenery meshes not casting shadows because they are far.
    pub shadows_trimmed: u32,
    /// Scenery roots hidden by hide-mode streaming / respawn-mode items currently spawned.
    pub stream_hidden: u32,
    pub stream_live: u32,
    /// Why this frame was drawn when idle skip is on (`None` = nothing changed). For debugging
    /// "why doesn't it skip".
    pub redraw_reason: Option<&'static str>,
    /// CPU time the render budget's own systems took last frame (µs).
    pub cpu_us: f32,
    /// Cameras in the world, active or not (Bevy's `VisibilityRange`s see only the first 32).
    pub cameras: u32,
    /// The main camera: position, view direction, projection aspect ratio, logical viewport size
    /// (zero until known). For "everything vanished" bugs.
    pub eye: Vec3,
    pub eye_forward: Vec3,
    pub aspect: f32,
    pub viewport: Vec2,
    /// This frame the main camera's `Frustum` didn't match its projection and transform (Bevy
    /// only recomputes it when one of them is marked changed) and was rebuilt.
    pub frustum_stale: bool,
    /// Times the main camera's frustum or aspect ratio had to be repaired (total since start;
    /// 0 when healthy).
    pub view_fixes: u32,
}

/// Accumulates the render budget systems' CPU time for the frame ([`RenderStats::cpu_us`]).
/// Shared (`Res`), so timing doesn't serialise the systems.
#[derive(Resource, Default)]
pub struct BudgetCpu(std::sync::atomic::AtomicU64);

/// Adds the time until drop to [`BudgetCpu`].
pub(crate) struct CpuTimer<'a>(&'a BudgetCpu, std::time::Instant);

impl BudgetCpu {
    pub(crate) fn time(&self) -> CpuTimer<'_> {
        CpuTimer(self, std::time::Instant::now())
    }
    /// Takes the frame's total (ns).
    pub(crate) fn take(&self) -> u64 {
        self.0.swap(0, std::sync::atomic::Ordering::Relaxed)
    }
}

impl Drop for CpuTimer<'_> {
    fn drop(&mut self) {
        self.0.0.fetch_add(self.1.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Which optimisations run. Change fields at runtime to turn them off; every switch takes
/// effect within a frame (the `render.budget` control command does this in dev builds).
#[derive(Resource, Clone, Debug)]
pub struct RenderBudget {
    /// GPU occlusion culling on the main camera (also needs the quality preset and GPU support).
    /// Off by default: it cost more than it saved in every measured scene.
    pub occlusion_culling: bool,
    /// Distance detail tiers for scenery (small props fade out, big pieces go cheap when far).
    pub scenery_detail: bool,
    /// Small scenery beyond [`SceneryRanges::shadow`] casts no shadows.
    pub shadow_trim: bool,
    /// Cell streaming of scenery registered with [`SceneryStream::add`]. Off = every item stays
    /// spawned.
    pub streaming: bool,
    /// Hide mode: spawned `Scenery` roots are hidden when their cell is out of range. Off by
    /// default: [`RenderBudget::scenery_detail`] already stops drawing them there.
    pub stream_spawned_scenery: bool,
    /// Skip rendering frames where nothing visible changed (opt-in; see [`pacing`]).
    pub idle_skip: bool,
    /// Zero-config classification: untagged meshes become actors when they move, sit under a
    /// camera, are skinned/morphed or (with `physics`) under a non-static `RigidBody`; the rest
    /// become scenery after [`RenderBudget::settle_frames`] frames without moving (and turn back
    /// into actors if they ever move). Explicit [`Actor`]/[`Scenery`] tags always win.
    pub auto_classify: bool,
    /// Frames an untagged mesh must stay still before it is treated as scenery.
    pub settle_frames: u32,
    /// Count per-mesh stats (visible actors/scenery, culled by reason, LOD) every frame. On by
    /// default in `devtools` builds; ship builds only keep the cheap totals.
    pub detailed_stats: bool,
}

impl Default for RenderBudget {
    fn default() -> Self {
        RenderBudget {
            // Measured slower on every test scene (docs/PORTING.md): opt in for heavy overdraw.
            occlusion_culling: false,
            scenery_detail: true,
            shadow_trim: true,
            streaming: true,
            stream_spawned_scenery: false,
            idle_skip: false,
            auto_classify: true,
            settle_frames: 60,
            detailed_stats: cfg!(feature = "devtools"),
        }
    }
}

/// Distances (metres, at `High` quality) for scenery detail and streaming. The current
/// quality's [`QualityPreset::detail_scale`](crate::gfx::QualityPreset::detail_scale)
/// multiplies them. Set these to fit your map (e.g. `view` ≈ where your fog is opaque).
#[derive(Resource, Clone, Debug, PartialEq)]
pub struct SceneryRanges {
    /// Small scenery farther than this casts no shadows (big pieces cast until `far`).
    pub shadow: f32,
    /// Pieces whose largest bounding-box side is below [`SceneryRanges::small_size`] vanish
    /// beyond this.
    pub small_props: f32,
    /// "Small" means the largest world-space bounding-box side is below this (metres).
    pub small_size: f32,
    /// Big pieces switch to their far version beyond this.
    pub far: f32,
    /// No scenery is drawn beyond this; streaming keeps cells within `view + buffer` resident.
    pub view: f32,
    /// Extra streaming radius beyond `view` (spawn before it can be seen).
    pub buffer: f32,
    /// Crossfade width (dithered) at each detail boundary, so nothing pops.
    pub fade: f32,
    /// A resident cell unloads only this much beyond the load radius (no thrashing).
    pub hysteresis: f32,
}

impl Default for SceneryRanges {
    fn default() -> Self {
        SceneryRanges {
            shadow: 50.0,
            small_props: 60.0,
            small_size: 1.5,
            far: 80.0,
            view: 170.0,
            buffer: 20.0,
            fade: 6.0,
            hysteresis: 12.0,
        }
    }
}

impl SceneryRanges {
    /// Every distance (not sizes) multiplied by `s`.
    pub fn scaled(&self, s: f32) -> SceneryRanges {
        SceneryRanges {
            shadow: self.shadow * s,
            small_props: self.small_props * s,
            small_size: self.small_size,
            far: self.far * s,
            view: self.view * s,
            buffer: self.buffer * s,
            fade: self.fade * s.max(0.5),
            hysteresis: self.hysteresis,
        }
    }
}

/// [`SceneryRanges`] scaled for the current quality (what the systems use).
#[derive(Resource, Clone, Debug, Default, PartialEq)]
pub struct EffectiveRanges(pub SceneryRanges);

/// System sets, all in `PostUpdate`.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub enum RenderBudgetSystems {
    /// Respawn-mode streaming (before transform propagation, so spawns get a transform).
    Stream,
    /// Detail classification, ranges, shadow trim, hide-mode streaming.
    Detail,
    /// Filling [`RenderStats`] (after visibility checks).
    Stats,
}

/// Cameras Bevy's `check_visibility_ranges` tracks (a `u32` bitmask per mesh).
pub const MAX_RANGE_VIEWS: u32 = 32;

pub struct RenderBudgetPlugin;

impl Plugin for RenderBudgetPlugin {
    fn build(&self, app: &mut App) {
        use bevy::camera::visibility::VisibilitySystems;
        use bevy::transform::TransformSystems;

        app.init_resource::<RenderStats>()
            .init_resource::<RenderBudget>()
            .init_resource::<SceneryRanges>()
            .init_resource::<EffectiveRanges>()
            .init_resource::<BudgetCpu>()
            .configure_sets(
                PostUpdate,
                (
                    RenderBudgetSystems::Stream.before(TransformSystems::Propagate),
                    RenderBudgetSystems::Detail
                        .after(TransformSystems::Propagate)
                        .after(VisibilitySystems::CalculateBounds)
                        .before(VisibilitySystems::VisibilityPropagate)
                        .before(VisibilitySystems::CheckVisibility),
                    RenderBudgetSystems::Stats.after(VisibilitySystems::CheckVisibility),
                ),
            )
            .add_systems(PostUpdate, update_effective_ranges.before(RenderBudgetSystems::Stream))
            .add_plugins((detail::DetailPlugin, stream::StreamPlugin, stats::StatsPlugin, pacing::PacingPlugin, scale::ScalePlugin, governor::GovernorPlugin, warmup::WarmupPlugin));
    }

    fn finish(&self, app: &mut App) {
        stats::finish(app);
        pacing::finish(app);
        scale::finish(app);
    }
}

fn update_effective_ranges(
    ranges: Res<SceneryRanges>,
    preset: Option<Res<crate::gfx::QualityPreset>>,
    settings: Option<Res<crate::settings::CoreSettings>>,
    mut eff: ResMut<EffectiveRanges>,
    cpu: Res<BudgetCpu>,
    mut stats: ResMut<RenderStats>,
    cameras: Query<(), Or<(With<Camera>, With<bevy::camera::ShadowLodOrigin>)>>,
    ranged: Query<(), With<bevy::camera::visibility::VisibilityRange>>,
    mut warned: Local<bool>,
) {
    stats.cpu_us = cpu.take() as f32 / 1000.0;
    // Bevy 0.19 gives visibility ranges to the first 32 cameras (in query order, active or not):
    // past that, the main camera can lose its slot and every ranged mesh vanishes from it.
    stats.cameras = cameras.iter().count() as u32;
    if stats.cameras > MAX_RANGE_VIEWS && !*warned && !ranged.is_empty() {
        *warned = true;
        warn!(
            "{} cameras: Bevy tracks VisibilityRange for the first {MAX_RANGE_VIEWS} only, so range-culled meshes may disappear from some of them (despawn unused cameras)",
            stats.cameras
        );
    }
    let scale = match (&preset, &settings) {
        (Some(p), Some(s)) => p.detail_scale[s.quality.index()],
        _ => 1.0,
    };
    let next = ranges.scaled(scale);
    if eff.0 != next {
        eff.0 = next;
    }
}
