//! Navigation & AI (feature `ai`): code-first equivalents of Unreal's Navmesh + Behavior Trees
//! + perception and Unity's NavMesh/NavMeshAgent. See docs/AI.md.
//!
//! - [`nav`]: Recast-style tiled navmesh baked from avian colliders (and tagged meshes) in the
//!   background, rebaked per tile when sources move; A* + funnel paths, raycasts, nearest and
//!   random points, off-mesh links; a budgeted path queue.
//! - [`agent`]: crowds — path following, arrive, separation, ORCA avoidance, wall sliding.
//! - [`bt`] + [`blackboard`] + [`utility`]: behaviour trees with closures, utility scoring.
//! - [`perception`]: sight cones with budgeted line-of-sight rays, hearing, memory.
//! - [`debug`]: gizmos; `ai.*` control commands (devtools).
//!
//! ```ignore
//! app.add_plugins(engine::ai::AiPlugin); // EnginePlugin adds it with the `ai` feature
//! commands.spawn((NavAgent::default(), Transform::from_xyz(0.0, 0.0, 0.0)));
//! ```
//! Systems run in `Update` in [`AiSet`] order (`Sense → Think → Path → Steer`), gated by
//! `not_paused`; baking runs in `PostUpdate` after transform propagation.

pub mod agent;
pub mod blackboard;
pub mod bt;
#[cfg(feature = "devtools")]
mod control;
pub mod debug;
pub mod nav;
pub mod perception;
pub mod rvo;
pub mod utility;

use bevy::prelude::*;
use bevy::transform::TransformSystems;

pub use agent::{NavAgent, NavAgentState, NavMotion, NavStatus};
pub use blackboard::{BbValue, Blackboard};
pub use bt::{BehaviorTree, Bt, BtAgent, BtCtx, BtStatus};
pub use debug::AiDebug;
pub use nav::paths::{NavPathQueue, PathReady, PathTicket};
pub use nav::sources::{NavIgnore, NavLink, NavMeshChanged, NavMeshes, NavSource};
pub use nav::{NavGeometry, NavMesh, NavMeshSettings, NavPath, NavQuery, OffMeshLink, PathPoint};
pub use perception::{Noise, Perceivable, Perceiver, Perception};
pub use utility::{Consideration, Curve, UtilityAi, UtilityOption};

use crate::pause::not_paused;

/// AI configuration. Build with `..default()`.
#[derive(Resource, Clone, Debug)]
pub struct AiConfig {
    /// One navmesh per agent type (radius/height/climb differ); agents pick with
    /// [`NavAgent::agent_type`].
    pub agent_types: Vec<NavMeshSettings>,
    /// Bake automatically when sources appear or change.
    pub auto_bake: bool,
    /// Wait this long after the last source change before rebaking (debounce, seconds).
    pub rebake_delay: f32,
    /// Bake on `AsyncComputeTaskPool` (results applied when ready); `false` = in-frame.
    pub async_bake: bool,
    /// Tasks per bake job (0 = the pool's thread count).
    pub bake_threads: usize,
    pub path_queries_per_frame: u32,
    /// Stop answering queued paths after this much time in a frame (one query always runs).
    pub path_budget_ms: f32,
    /// A* node budget per query.
    pub max_search_nodes: usize,
    /// Half-extents used to snap points onto the mesh.
    pub query_extents: Vec3,
    pub avoidance_time_horizon: f32,
    pub avoidance_neighbor_dist: f32,
    pub avoidance_max_neighbors: usize,
    pub sight_rays_per_frame: u32,
}

impl Default for AiConfig {
    fn default() -> Self {
        AiConfig {
            agent_types: vec![NavMeshSettings::default()],
            auto_bake: true,
            rebake_delay: 0.2,
            async_bake: true,
            bake_threads: 0,
            path_queries_per_frame: 32,
            path_budget_ms: 1.0,
            max_search_nodes: 4096,
            query_extents: Vec3::new(1.5, 2.0, 1.5),
            avoidance_time_horizon: 1.5,
            avoidance_neighbor_dist: 4.0,
            avoidance_max_neighbors: 10,
            sight_rays_per_frame: 64,
        }
    }
}

/// Per-frame AI counters (µs timings), also recorded as `ai.*` metrics in dev builds.
#[derive(Resource, Clone, Copy, Debug, Default, serde::Serialize)]
pub struct AiStats {
    pub agents: u32,
    pub agents_moving: u32,
    pub neighbor_checks: u32,
    pub steer_us: u32,
    pub path_queries: u32,
    pub path_queue: u32,
    pub path_us: u32,
    pub bt_ticks: u32,
    pub think_us: u32,
    pub sight_rays: u32,
    pub sight_candidates: u32,
    pub sense_us: u32,
}

#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AiSet {
    Sense,
    Think,
    Path,
    Steer,
}

/// Bake bookkeeping (PostUpdate).
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NavBakeSet;

pub struct AiPlugin;

impl Plugin for AiPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<AiConfig>()
            .init_resource::<AiStats>()
            .init_resource::<AiDebug>()
            .init_resource::<NavMeshes>()
            .init_resource::<NavPathQueue>()
            .init_resource::<nav::sources::SourceCache>()
            .init_resource::<nav::sources::BakeJobs>()
            .add_message::<NavMeshChanged>()
            .add_message::<PathReady>()
            .add_message::<Noise>()
            .configure_sets(Update, (AiSet::Sense, AiSet::Think, AiSet::Path, AiSet::Steer).chain().run_if(not_paused))
            .add_systems(
                Update,
                (
                    perception::update_perception.in_set(AiSet::Sense),
                    bt::tick_agents.in_set(AiSet::Think),
                    (agent::repath_on_mesh_change, nav::paths::process_paths).chain().in_set(AiSet::Path),
                    agent::steer_agents.in_set(AiSet::Steer),
                ),
            )
            .add_systems(
                PostUpdate,
                (nav::sources::track_sources, nav::sources::sync_links, nav::sources::schedule_bakes, nav::sources::poll_bakes)
                    .chain()
                    .in_set(NavBakeSet)
                    .after(TransformSystems::Propagate),
            )
            .add_systems(PostUpdate, debug::draw_debug.run_if(debug::debug_enabled).after(NavBakeSet));
        #[cfg(feature = "devtools")]
        {
            control::register(app);
            app.add_systems(Last, record_metrics);
        }
    }
}

#[cfg(feature = "devtools")]
fn record_metrics(stats: Res<AiStats>, navs: Res<NavMeshes>, metrics: Option<ResMut<crate::devtools::Metrics>>) {
    let Some(mut m) = metrics else { return };
    if stats.agents == 0 && stats.bt_ticks == 0 && stats.sight_candidates == 0 && navs.generation == 0 {
        return;
    }
    m.record("ai.agents", stats.agents as f64);
    m.record("ai.steer_ms", stats.steer_us as f64 / 1000.0);
    m.record("ai.path_ms", stats.path_us as f64 / 1000.0);
    m.record("ai.path_queries", stats.path_queries as f64);
    m.record("ai.think_ms", stats.think_us as f64 / 1000.0);
    m.record("ai.sense_ms", stats.sense_us as f64 / 1000.0);
    m.record("ai.sight_rays", stats.sight_rays as f64);
    m.record("ai.nav_bake_ms", navs.last_bake.wall_us as f64 / 1000.0);
}
