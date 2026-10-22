//! Render budget: draw only what the player can see, in as much detail as it deserves.
//! Owner: render stream. Contract (stable names, the metrics stream codes against them):
//!
//! - [`Actor`]: things that move or matter up close (player, enemies, pickups, props the
//!   player can push). Always full detail when visible.
//! - [`Scenery`]: static world geometry and dressing. May be streamed out when far, drawn
//!   with a cheaper far version, lose shadows, or be culled behind walls.
//! - [`RenderStats`]: per-frame counts, updated by this module. Cheap to keep; filled in
//!   every build, charted by `devtools::metrics` in dev builds.
//!
//! Colliders are never streamed: only visuals. Physics, AI raycasts and navigation always
//! see the whole map.

use bevy::prelude::*;

/// Moves or matters up close: rendered at full detail whenever visible.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Actor;

/// Static world visuals: eligible for streaming, distance detail levels and shadow trimming.
#[derive(Component, Clone, Copy, Debug, Default)]
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
}

pub struct RenderBudgetPlugin;

impl Plugin for RenderBudgetPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<RenderStats>();
    }
}
