//! Breakable and bendable roadside props (feature `props`): posts and saplings that topple when
//! knocked, debris, and plants that bend when something pushes through them. Visuals only: the
//! game decides *whether* something breaks (in its own sim) and sends [`Knock`]. No physics
//! engine needed. Docs: `docs/PROPS.md`.
//!
//! ```ignore
//! use engine::prelude::*;
//! app.add_plugins(PropsPlugin)
//!     .insert_resource(PropGround::new(move |x, z| terrain.height(x, z)));
//! // A post (origin at its base), tagged Scenery until it is knocked:
//! commands.spawn((Breakable::new(1.0, 0.06), Scenery, Mesh3d(post), MeshMaterial3d(wood), tf));
//! // In the game's sim, when the car hits it:
//! knocks.write(Knock { entity: post, velocity: car_vel, point: contact });
//! // A shrub the car drives through, and the car that pushes it:
//! commands.spawn((Sway::new(0.6, 0.9), Scenery, Mesh3d(shrub), MeshMaterial3d(leaves), tf));
//! commands.entity(car).insert(SwayPusher { half_extents: Vec2::new(0.9, 2.1) });
//! ```
//!
//! Layout: [`topple`] (pure fall math: [`ToppleState`]), [`sway`] (spring step + push),
//! [`debris`] (chips flung from a break). Systems run in `PostUpdate` in [`PropsSet`], before
//! transform propagation, and skip while the game is paused.

pub mod debris;
pub mod sway;
pub mod topple;

use std::sync::Arc;

use bevy::prelude::*;
use bevy::transform::TransformSystems;

pub use debris::{Debris, DebrisSpec, spawn_debris};
pub use sway::{Brushed, Sway, SwayPusher, SwayRest};
pub use topple::{Breakable, Fallen, Knock, Landed, ToppleState, Toppled, Toppling};

use crate::pause::{Paused, not_paused};

/// All prop systems, in `PostUpdate` before transform propagation. Send [`Knock`] any time
/// before it (`Update`, `FixedUpdate`); move [`SwayPusher`]s before it too.
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PropsSet;

/// Ground height for falling props and debris. Without it, props land at their base's own
/// height (flat ground) and debris at its spawn height.
#[derive(Resource, Clone)]
pub struct PropGround(Arc<dyn Fn(f32, f32) -> f32 + Send + Sync>);

impl PropGround {
    pub fn new(f: impl Fn(f32, f32) -> f32 + Send + Sync + 'static) -> Self {
        PropGround(Arc::new(f))
    }
    pub fn height(&self, x: f32, z: f32) -> f32 {
        (self.0)(x, z)
    }
}

/// Longest simulated step (s): a hitch never explodes a fall or a spring.
pub(crate) const MAX_DT: f32 = 0.1;

pub struct PropsPlugin;

impl Plugin for PropsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Paused>()
            .add_message::<Knock>()
            .add_message::<Toppled>()
            .add_message::<Landed>()
            .add_message::<Brushed>()
            .configure_sets(PostUpdate, PropsSet.before(TransformSystems::Propagate).run_if(not_paused))
            .add_systems(
                PostUpdate,
                (topple::start_topples, topple::step_topples, debris::step_debris, sway::capture_rest, sway::step_sway).chain().in_set(PropsSet),
            );
    }
}

/// splitmix64: deterministic per-entity randomness without a dependency.
pub(crate) fn mix64(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Small stream of uniform floats from a seed.
pub(crate) struct Rand(u64);

impl Rand {
    pub(crate) fn new(seed: u64) -> Self {
        Rand(mix64(seed))
    }
    /// Uniform in `[0, 1)`.
    pub(crate) fn f(&mut self) -> f32 {
        self.0 = mix64(self.0);
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
    pub(crate) fn range(&mut self, (lo, hi): (f32, f32)) -> f32 {
        lo + (hi - lo) * self.f()
    }
    /// Uniform in `[-1, 1)`.
    pub(crate) fn signed(&mut self) -> f32 {
        self.f() * 2.0 - 1.0
    }
}

#[cfg(test)]
pub(crate) mod test_app {
    use std::time::Duration;

    use bevy::prelude::*;
    use bevy::time::TimeUpdateStrategy;

    /// Headless app with `PropsPlugin`, stepping 1/60 s per `update()`.
    pub(crate) fn app() -> App {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, TransformPlugin, super::PropsPlugin))
            .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f32(1.0 / 60.0)));
        app.update();
        app
    }
}
